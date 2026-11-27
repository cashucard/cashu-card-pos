import {
  blindMessage,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  pointFromHex,
} from '@cashu/cashu-ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { HttpFetch, TopupKeys } from 'cashucard';
import { TopupService } from '../src/till/topup';
import { TopupStore, TOPUP_SCHEMA, type TopupRecord } from '../src/till/store/topups';
import { createSerial } from '../src/till/store/db';
import { fakeDriver, memoryDb } from './helpers/fake-sql';

const mint = 'https://mint.test';
const secret = 'fixed test secret';
const B_ = blindMessage(utf8ToBytes(secret), 5n).B_.toHex(true);
function keyset(byte: string) {
  const sk = hexToBytes(byte.repeat(32));
  const keys = { '4': bytesToHex(secp256k1.getPublicKey(sk)) };
  const id = deriveKeysetId(keys, { versionByte: 1, unit: 'sat' });
  return { sk, keys: { id, keys, unit: 'sat', fee: 0 } satisfies TopupKeys };
}
const original = keyset('01');
const active = keyset('02');
type Wire = { B_: string; amount: number; id: string };
function mintSignature(set: typeof original) {
  const B = pointFromHex(B_);
  const dleq = createDLEQProof(B, set.sk);
  return {
    id: set.keys.id,
    amount: 4,
    C_: createBlindSignature(B, set.sk, set.keys.id).C_.toHex(true),
    dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
  };
}

async function fixture() {
  const driver = fakeDriver(memoryDb());
  const store = new TopupStore(driver, createSerial());
  for (const sql of TOPUP_SCHEMA) await driver.run(sql);
  const r: TopupRecord = {
    id: 'receipt',
    cardKey: 'card',
    mint,
    amount: 4,
    total: 4,
    invoice: 'same invoice',
    expiresAt: 2000,
    createdAt: 1000,
    state: 'issuing',
    revision: 0,
    group: 'group',
    lock: '03'.repeat(32),
    pubkey: 'pub',
    keys: original.keys,
    quote: 'quote',
    outputs: [{ id: original.keys.id, amount: 4, B_, nonce: '06'.repeat(32), secret, r: '05', date: 0 }],
    attempts: {},
    delivered: [],
  };
  await store.insert(r);
  const issued: Wire[][] = [];
  let available: typeof original | null = null;
  let paid = true,
    loseReply = false,
    rotateDuringRestore = false;
  const http: HttpFetch = async (url, init) => {
    const answer = (body: unknown) => ({ status: 200, text: async () => JSON.stringify(body) });
    const path = url.slice(mint.length);
    if (path === '/v1/mint/quote/bolt11/quote')
      return answer({
        quote: r.quote,
        request: r.invoice,
        state: paid ? 'PAID' : 'ISSUED',
        pubkey: r.pubkey,
      });
    if (path === '/v1/keysets')
      return answer({
        keysets: [original, active].map((set) => ({
          id: set.keys.id,
          unit: 'sat',
          active: set === active,
          input_fee_ppk: 0,
        })),
      });
    if (path === '/v1/keys/' + active.keys.id) return answer({ keysets: [active.keys] });
    const body = JSON.parse(String(init?.body));
    const outputs = body.outputs as Wire[];
    if (path === '/v1/restore') {
      if (rotateDuringRestore) paid = false;
      return available
        ? answer({ outputs, signatures: [mintSignature(available)] })
        : answer({ outputs: [], signatures: [] });
    }
    if (path === '/v1/mint/bolt11') {
      expect(body.quote).toBe(r.quote);
      expect(outputs).toEqual([{ id: active.keys.id, amount: 4, B_ }]);
      issued.push(outputs);
      if (loseReply) throw new Error('Connection dropped');
      return answer({ signatures: [mintSignature(active)] });
    }
    throw new Error('Unexpected mint request.');
  };
  const service = () =>
    new TopupService(
      new TopupStore(driver, createSerial()),
      {
        kind: 'none',
        available: async () => false,
        transport: () => {
          throw new Error('unexpected NFC');
        },
      },
      http,
      () => true,
    );
  return {
    r,
    store,
    service,
    issued,
    restored: (which: typeof original) => {
      available = which;
      paid = false;
    },
    issuedWithoutRestore: () => {
      paid = false;
    },
    flipDuringRestore: () => {
      rotateDuringRestore = true;
    },
    disconnect: () => {
      loseReply = true;
    },
  };
}

it('uses the same blinded card outputs and the original paid quote after mint key rotation', async () => {
  const f = await fixture();
  expect(await f.service().refresh(f.r.id)).toMatchObject({ state: 'ready', amount: 4 });
  expect(f.issued).toHaveLength(1);
  const saved = await f.store.get(f.r.id);
  expect(saved.keys.id).toBe(active.keys.id);
  expect(saved.outputs).toEqual(f.r.outputs.map((o) => ({ ...o, id: active.keys.id })));
  expect(saved.pieces?.[0]).toMatchObject({ id: active.keys.id, amount: 4, nonce: f.r.outputs[0].nonce });
});

it.each([original, active])(
  'restores the signed keyset after restart when a rotation overlaps a lost response',
  async (which) => {
    const f = await fixture();
    f.disconnect();
    await expect(f.service().refresh(f.r.id)).rejects.toThrow();
    const pending = await f.store.get(f.r.id);
    expect(pending.earlierKeys?.map((k) => k.id)).toEqual([original.keys.id]);
    f.restored(which);
    await expect(f.service().refresh(f.r.id)).resolves.toMatchObject({ state: 'ready' });
    expect(f.issued).toHaveLength(1);
    expect((await f.store.get(f.r.id)).pieces?.[0].id).toBe(which.keys.id);
  },
);

it('restores previously issued original notes before looking up or submitting to the rotated keyset', async () => {
  const f = await fixture();
  f.restored(original);
  await expect(f.service().refresh(f.r.id)).resolves.toMatchObject({ state: 'ready' });
  expect(f.issued).toHaveLength(0);
  expect((await f.store.get(f.r.id)).keys.id).toBe(original.keys.id);
});

it.each(['issued', 'raced'])('never reissues when the paid quote is ambiguous (%s)', async (mode) => {
  const f = await fixture();
  if (mode === 'issued') f.issuedWithoutRestore();
  else f.flipDuringRestore();
  await expect(f.service().refresh(f.r.id)).rejects.toThrow(/recover/);
  expect(f.issued).toHaveLength(0);
  expect((await f.store.get(f.r.id)).state).toBe('issuing');
});
