import {
  open,
  walletPayout,
  JournalRolledBackError,
  type CashuCard,
  type GenerationStore,
  type HttpFetch,
} from 'cashucard';
import { createSchema, createSerial, openDatabase } from '../src/till/store/db';
import { SqliteJournal } from '../src/till/store/journal';
import { labNames, type SecureStore } from '../src/till/store/types';
import {
  KeyNotKeptError,
  SecretUnreadableError,
  createKey,
  generationStore,
  markFirstRun,
  readKey,
} from '../src/till/store/secret';
import { fakeSecure } from './helpers/fake-secure';
import { dump, fakeDisk, restore } from './helpers/fake-sql';

const names = labNames('t');
const counting = (n: number) => Uint8Array.from({ length: n }, (_, i) => i + 1);

const KEY = 'ab'.repeat(32);

const http: HttpFetch = async () => {
  throw new Error('no fetch expected');
};

const INVOICE_14 = 'lnbc140n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfs7lvu5';

const libraryOver = (journal: SqliteJournal, store: GenerationStore, acceptRollback = false) =>
  open({
    journal,
    generationStore: store,
    acceptRollback,
    payout: walletPayout({ mints: [], keep: async () => undefined }),
    http,
    leftoverByPin: false,
    clock: null,
  });

const sell = (c: CashuCard, id: string) => c.receive({ id, sats: 14, invoice: INVOICE_14 });

async function setup() {
  const disk = fakeDisk();
  const { driver } = await openDatabase(disk.opener, '/d', 'j.db', KEY);
  await createSchema(driver);
  const db = disk.files.get('/d/j.db')!.db;
  const j = new SqliteJournal(driver, createSerial(), () => 1000);
  return { disk, driver, db, j };
}

describe('the database key and the generations in the secure store', () => {
  it('a new key is 32 random bytes as hex, stored and read back', async () => {
    const s = fakeSecure();
    const k = await createKey(s, names, counting);
    expect(k).toBe('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
    expect(s.items.get(names.key)).toBe(k);
    expect(await readKey(s, names)).toBe(k);
  });

  it('an all-zero draw is refused', async () => {
    const s = fakeSecure();
    await expect(createKey(s, names, (n) => new Uint8Array(n))).rejects.toThrow(/zeros/);
    expect(s.sets).toEqual([]);
  });

  it('a short draw is refused', async () => {
    const s = fakeSecure();
    await expect(createKey(s, names, () => new Uint8Array(16).fill(1))).rejects.toThrow(/16 bytes/);
    expect(s.sets).toEqual([]);
  });

  it('a key that reads back differently is refused', async () => {
    const kept = new Map<string, string>();
    const secure: SecureStore = {
      async get(name: string): Promise<string | null> {
        return kept.get(name) ?? null;
      },
      async set(name: string, value: string): Promise<void> {
        kept.set(name, value.slice(0, -1) + (value.endsWith('0') ? '1' : '0'));
      },
      async remove(name: string): Promise<void> {
        kept.delete(name);
      },
    };
    await expect(createKey(secure, names, counting)).rejects.toBeInstanceOf(KeyNotKeptError);
  });

  it('readKey: null when absent, the key when present, refused when the item holds anything else', async () => {
    const s = fakeSecure();
    expect(await readKey(s, names)).toBeNull();
    s.items.set(names.key, 'ab'.repeat(32));
    expect(await readKey(s, names)).toBe('ab'.repeat(32));
    for (const v of ['xyz', 'AB'.repeat(32), 'ab'.repeat(31)]) {
      s.items.set(names.key, v);
      await expect(readKey(s, names)).rejects.toBeInstanceOf(SecretUnreadableError);
    }
  });

  it('readKey rejects when the store cannot be read, it never answers null', async () => {
    const s = fakeSecure();
    s.failGet.add(names.key);
    await expect(readKey(s, names)).rejects.toThrow(/cannot be read/);
  });

  it('the generation is null with no slots, and the higher slot otherwise', async () => {
    const s = fakeSecure();
    const g = generationStore(s, names);
    expect(await g.get()).toBeNull();
    s.items.set(names.genA, '4');
    expect(await g.get()).toBe(4);
    s.items.set(names.genB, '7');
    expect(await g.get()).toBe(7);
    s.items.set(names.genA, '10');
    expect(await g.get()).toBe(10);
  });

  it('set writes one slot: even numbers to a, odd to b', async () => {
    const s = fakeSecure();
    const g = generationStore(s, names);
    await g.set(4);
    expect(s.sets).toEqual([names.genA]);
    await g.set(5);
    expect(s.sets).toEqual([names.genA, names.genB]);
    expect(await g.slots()).toEqual({ a: 4, b: 5 });
    expect(await g.get()).toBe(5);
  });

  it('a set cut off inside the secure store leaves the other slot', async () => {
    const s = fakeSecure();
    const g = generationStore(s, names);
    await g.set(4);
    await g.set(5);
    s.dieInSet.add(names.genA);
    await expect(g.set(6)).rejects.toThrow(/killed inside set/);
    expect(await g.slots()).toEqual({ a: null, b: 5 });
    expect(await g.get()).toBe(5);
  });

  it('a slot that is not a number makes get reject', async () => {
    for (const v of ['x', '-1', '1.5', '01', '', '99999999999999999']) {
      const s = fakeSecure();
      s.items.set(names.genB, v);
      const g = generationStore(s, names);
      await expect(g.get()).rejects.toBeInstanceOf(SecretUnreadableError);
    }
  });

  it('a secure store that cannot be read makes get reject', async () => {
    const s = fakeSecure();
    s.failGet.add('*');
    const g = generationStore(s, names);
    await expect(g.get()).rejects.toThrow(/cannot be read/);
  });

  it('set refuses what is not a whole number', async () => {
    for (const v of [-1, 1.5, NaN]) {
      const s = fakeSecure();
      const g = generationStore(s, names);
      await expect(g.set(v)).rejects.toThrow(/whole number/);
      expect(s.sets).toEqual([]);
    }
  });

  it('markFirstRun writes 0 to slot a', async () => {
    const s = fakeSecure();
    await markFirstRun(s, names);
    const g = generationStore(s, names);
    expect(await g.get()).toBe(0);
    expect(s.items.get(names.genA)).toBe('0');
  });

  it("the library stores the journal's generation after every write", async () => {
    const { j } = await setup();
    const s = fakeSecure();
    const g = generationStore(s, names);
    const c = await libraryOver(j, g);
    const before = (await g.get()) ?? -1;
    expect(before).toBeGreaterThanOrEqual(1);
    await sell(c, 't1');
    const after = (await g.get()) ?? -1;
    expect(after).toBeGreaterThan(before);
    expect(after).toBe((await j.stats()).gen);
  });

  it('the library refuses a journal put back to an earlier generation', async () => {
    const { j, db } = await setup();
    const s = fakeSecure();
    const g = generationStore(s, names);
    const c = await libraryOver(j, g);
    await sell(c, 't1');
    const snap = dump(db, 'journal');
    await sell(c, 't2');
    await sell(c, 't3');
    restore(db, 'journal', snap);
    let caught: unknown = null;
    try {
      await libraryOver(j, g);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JournalRolledBackError);
    expect(caught).toMatchObject({ kind: 'journal-rolled-back' });
    const err = caught as JournalRolledBackError;
    expect(err.storedGeneration).toBeGreaterThan(err.journalGeneration);
    const highest = snap.reduce((n, r) => Math.max(n, Number(r.gen)), 0);
    expect(err.journalGeneration).toBe(highest);
  });

  it('a journal ahead of the stored generation opens', async () => {
    const { j } = await setup();
    const s = fakeSecure();
    const g = generationStore(s, names);
    const c = await libraryOver(j, g);
    await sell(c, 't1');
    await sell(c, 't2');
    s.items.set(names.genA, '0');
    s.items.delete(names.genB);
    await expect(libraryOver(j, g)).resolves.toBeDefined();
  });

  it('with acceptRollback the older journal opens and the generation carries on', async () => {
    const { j, db } = await setup();
    const s = fakeSecure();
    const g = generationStore(s, names);
    const c = await libraryOver(j, g);
    await sell(c, 't1');
    const snap = dump(db, 'journal');
    await sell(c, 't2');
    await sell(c, 't3');
    restore(db, 'journal', snap);
    const stored = (await g.get()) ?? -1;
    const c2 = await libraryOver(j, g, true);
    await sell(c2, 't9');
    expect((await g.get()) ?? -1).toBeGreaterThan(stored);
  });

  it('each set writes the slot that does not hold the higher number', async () => {
    const s = fakeSecure();
    s.items.set(names.genA, '9');
    s.items.set(names.genB, '4');
    const g = generationStore(s, names);
    expect(await g.get()).toBe(9);
    await g.set(10);
    expect(s.sets).toEqual([names.genB]);
    expect(await g.slots()).toEqual({ a: 9, b: 10 });
    await g.set(11);
    expect(s.sets).toEqual([names.genB, names.genA]);
    expect(await g.slots()).toEqual({ a: 11, b: 10 });
  });

  it('after a set cut off inside the secure store, the next set leaves the one slot left alone', async () => {
    const s = fakeSecure();
    const g = generationStore(s, names);
    await g.set(4);
    s.dieInSet.add(names.genB);
    await expect(g.set(5)).rejects.toThrow(/killed inside set/);
    s.dieInSet.clear();
    expect(await g.slots()).toEqual({ a: 4, b: null });
    const g2 = generationStore(s, names);
    expect(await g2.get()).toBe(4);
    s.dieInSet.add(names.genA);
    s.dieInSet.add(names.genB);
    await expect(g2.set(6)).rejects.toThrow(/killed inside set/);
    expect(await g2.get()).toBe(4);
    s.dieInSet.clear();
    await g2.set(7);
    expect(await g2.slots()).toEqual({ a: 4, b: 7 });
  });
});
