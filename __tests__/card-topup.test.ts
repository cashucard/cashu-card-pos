import type { HttpFetch, TopupPiece, TopupKeys } from 'cashucard';
import { TopupCard } from 'cashucard';
import { hashToCurve } from '@cashu/cashu-ts';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { TopupStore, TOPUP_SCHEMA, type TopupRecord } from '../src/till/store/topups';
import { TopupService } from '../src/till/topup';
import { createSerial } from '../src/till/store/db';
import type { CardReader } from '../src/till/reader';
import { fakeDriver, memoryDb } from './helpers/fake-sql';

const keys: TopupKeys = { id: '0088997766554400', unit: 'sat', keys: {}, fee: 0 };
const piece: TopupPiece = {
  id: keys.id,
  keyset: keys.id,
  nonce: '11'.repeat(32),
  amount: 4,
  C: '02' + 'aa'.repeat(32),
  date: 0,
  written: false,
  dleq: { e: 'a', r: 'b', s: 'c' },
};
const source = 'https://mint.test';
function row(): TopupRecord {
  return {
    id: 'private-id',
    state: 'ready',
    quote: 'original',
    mint: source,
    cardKey: 'original-card',
    group: 'group',
    keys,
    lock: 'quote key',
    pubkey: 'pub',
    outputs: [{ id: keys.id, amount: 4, B_: 'blinded', r: 'r', nonce: piece.nonce, secret: 'secret', date: 0 }],
    pieces: [piece],
    attempts: {},
    delivered: [],
    revision: 0,
    amount: 4,
    total: 4,
    invoice: 'saved invoice',
    createdAt: 1000,
    expiresAt: 2000,
  };
}
async function testFixture() {
  const driver = fakeDriver(memoryDb());
  for (const sql of TOPUP_SCHEMA) await driver.run(sql);
  const store = new TopupStore(driver, createSerial());
  let current = 'UNSPENT';
  const http: HttpFetch = async (url) => {
    if (url !== source + '/v1/checkstate') throw new Error('Unexpected request');
    return {
      status: 200,
      text: async () =>
        JSON.stringify({ states: [{ Y: hashToCurve(utf8ToBytes('secret')).toHex(true), state: current }] }),
    };
  };
  const seen = new Set<string>();
  let left = 250,
    lose = false,
    writes = 0;
  const card = {
    teach: jest.fn(),
    hasPiece: async (p: TopupPiece) => seen.has(p.nonce),
    checkpoint: async () => ({ clock: 100, remaining: left }),
    write: async (p: TopupPiece) => {
      seen.add(p.nonce);
      left--;
      writes++;
      if (lose) throw new Error('Card removed before receipt');
    },
  };
  const open = jest.spyOn(TopupCard, 'open').mockResolvedValue(card as unknown as TopupCard);
  const end = jest.fn(async () => {});
  const reader: CardReader = {
    kind: 'nfc',
    available: async () => true,
    transport: () => ({ transceive: async () => new Uint8Array(), end }),
  };
  const service = () => new TopupService(store, reader, http, () => true);
  const r = row();
  await store.insert(r);
  return {
    store,
    service,
    r,
    open,
    end,
    card,
    reader,
    http,
    writes: () => writes,
    lost: () => {
      lose = true;
    },
    changeState: (s: string) => {
      current = s;
    },
    advance: () => {
      left--;
    },
  };
}
afterEach(() => jest.restoreAllMocks());

it('saves write intent, recovers a lost acknowledgment on the next card tap and never loads twice', async () => {
  const f = await testFixture();
  f.lost();
  await expect(f.service().load(f.r.id, '1234')).rejects.toThrow(/removed/);
  const saved = await f.store.get(f.r.id);
  expect(saved.state).toBe('ready');
  expect(saved.attempts[piece.nonce]).toEqual({ clock: 100, remaining: 250 });
  await expect(f.service().load(f.r.id, '1234')).resolves.toMatchObject({ state: 'loaded', amount: 4 });
  await expect(f.service().load(f.r.id, '1234')).resolves.toMatchObject({ state: 'loaded' });
  expect(f.writes()).toBe(1);
  expect(await f.store.get(f.r.id)).toMatchObject({
    state: 'loaded',
    outputs: [],
    lock: '',
    attempts: {},
    delivered: [],
  });
  expect(await f.store.list()).toEqual([expect.objectContaining({ state: 'loaded' })]);
  expect(await f.store.hasOpen(source + '/')).toBe(false);
});

it('keeps an ambiguous absent write pending when the daily card counter changed', async () => {
  const f = await testFixture();
  const saved = await f.store.get(f.r.id);
  saved.attempts[piece.nonce] = { clock: 100, remaining: 250 };
  await f.store.save(saved);
  f.advance();
  await expect(f.service().load(f.r.id, '1234')).rejects.toThrow(/unresolved/);
  expect(f.writes()).toBe(0);
  expect(await f.store.hasOpen(source + '/')).toBe(true);
});

it('accepts an already-spent card-bound note only when the saved record shows the original write intent', async () => {
  const f = await testFixture();
  f.changeState('SPENT');
  await expect(f.service().load(f.r.id, '1234')).rejects.toThrow(/unavailable/);
  const saved = await f.store.get(f.r.id);
  saved.attempts[piece.nonce] = { clock: 100, remaining: 250 };
  await f.store.save(saved);
  await expect(f.service().load(f.r.id, '1234')).resolves.toMatchObject({ state: 'loaded' });
  expect(f.writes()).toBe(0);
});

it('keeps a note with pending mint state recoverable', async () => {
  const f = await testFixture();
  f.changeState('PENDING');
  await expect(f.service().load(f.r.id, '1234')).rejects.toThrow(/pending/);
  expect(await f.store.hasOpen()).toBe(true);
  expect(f.writes()).toBe(0);
});

it('checks the original identity on every load and never passes a PIN on a cancelled waiting tap', async () => {
  const f = await testFixture();
  const s = f.service();
  let release!: () => void, opened!: () => void;
  const waiting = new Promise<void>((resolve) => {
    opened = resolve;
  });
  f.reader.transport = () => ({
    transceive: async () => new Uint8Array(),
    begin: async () => {
      opened();
      await new Promise<void>((r) => {
        release = r;
      });
    },
    end: async () => {
      release();
    },
  });
  const loading = s.load(f.r.id, '1234');
  await waiting;
  s.cancelTap();
  await expect(loading).rejects.toThrow(/cancelled/);
  expect(f.open).not.toHaveBeenCalled();
  expect(f.writes()).toBe(0);
  expect(await f.store.hasOpen()).toBe(true);
});

it('preserves expired invoices while allowing the same card to start another payment', async () => {
  const f = await testFixture();
  await expect(f.store.insert({ ...f.r, id: 'second' })).rejects.toThrow(/existing/);
  const expired = await f.store.get(f.r.id);
  expired.state = 'expired';
  await f.store.save(expired);
  await f.store.insert({ ...f.r, id: 'second' });
  expect((await f.store.list(f.r.cardKey)).map((x) => x.id).sort()).toEqual(['private-id', 'second']);
  // A late PAID confirmation for the old invoice remains recoverable independently.
  expired.state = 'issuing';
  await f.store.save(expired);
  expect((await f.store.get(expired.id)).state).toBe('issuing');
});

it('keeps all open top-ups and pages older history by card even when timestamps tie', async () => {
  const f = await testFixture();
  for (let i = 0; i < 20; i++) {
    const id = 'expired-' + String(i).padStart(2, '0');
    const old = { ...f.r, id, state: 'expired' as const, cardKey: 'another-card' };
    await f.store.insert(old);
  }
  expect((await f.store.list()).filter((r) => r.state === 'ready')).toHaveLength(1);
  const first = await f.store.list('another-card');
  expect(first).toHaveLength(9);
  expect(first[0].id).toBe('expired-19');
  const second = await f.store.older('another-card', first[7]);
  expect(second[0].id).toBe(first[8].id);
  expect(second).toHaveLength(9);
  const last = await f.store.older('another-card', second[7]);
  expect(last.map((r) => r.id)).toEqual(['expired-03', 'expired-02', 'expired-01', 'expired-00']);
  expect(await f.store.older(f.r.cardKey, first[7])).toEqual([]);
});

it('finishes a previously paid top-up only against the original card and mint after new loads are disabled', async () => {
  const f = await testFixture();
  const service = new TopupService(f.store, f.reader, f.http, () => false);
  await expect(service.load(f.r.id, '1234')).resolves.toMatchObject({ state: 'loaded' });
  const [, pin, accepts, expected] = f.open.mock.calls[0];
  expect(pin).toBe('1234');
  expect(accepts(source + '/')).toBe(true);
  expect(accepts('https://another-mint.test')).toBe(false);
  expect(expected).toEqual({ key: 'original-card', mint: source, group: 'group' });
});

it('drains active work before closing and rejects future calls', async () => {
  const f = await testFixture();
  let started!: () => void, finish!: () => void;
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held: HttpFetch = async (url, init) => {
    started();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return f.http(url, init);
  };
  const s = new TopupService(f.store, f.reader, held, () => true);
  const load = s.load(f.r.id, '1234');
  await loading;
  let closed = false;
  const closing = s.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  finish();
  await expect(load).rejects.toThrow('closed');
  await closing;
  await expect(s.refresh(f.r.id)).rejects.toThrow('closed');
  expect(f.open).not.toHaveBeenCalled();
});
