import { open, walletPayout, type CashuCard, type HttpFetch } from 'cashucard';
import { labNames } from '../src/till/store/types';
import { openStore, type OpenStore, type StoreChoice } from '../src/till/store/open-store';
import { fakeStoreDeps, type FakeStore } from './helpers/fake-store';
import { dump, restore } from './helpers/fake-sql';

const names = labNames('t');
const PATH = '/app/lab/lab-t.db';
const http: HttpFetch = async () => {
  throw new Error('no fetch expected');
};
const INVOICE_14 = 'lnbc140n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfs7lvu5';
const start = (s: OpenStore, acceptRollback: boolean): Promise<CashuCard> =>
  open({
    journal: s.journal,
    generationStore: s.generation,
    acceptRollback,
    payout: walletPayout({ mints: [], keep: s.keep.keep }),
    http,
    leftoverByPin: false,
    clock: null,
  });
const openIt = (f: FakeStore, choice?: StoreChoice) => openStore(f.deps, names, { choice, start });

/** An outcome without its store and its till, for assertions: jest cannot print a node:sqlite database, and a failing
 * assertion that has to print one crashes the test worker instead of naming the test. */
function plain(o: unknown): Record<string, unknown> {
  const r = { ...(o as Record<string, unknown>) };
  delete r.store;
  delete r.value;
  return r;
}

function spying(): { flags: boolean[]; start: (s: OpenStore, a: boolean) => Promise<CashuCard> } {
  const flags: boolean[] = [];
  return {
    flags,
    start: (s, a) => {
      flags.push(a);
      return start(s, a);
    },
  };
}

/** A store that took sales, then closed. */
async function used(f: FakeStore, sales: string[]): Promise<void> {
  const out = await openIt(f);
  if (out.kind !== 'ready') {
    throw new Error(out.kind);
  }
  for (const id of sales) {
    await out.value.receive({ id, sats: 14, invoice: INVOICE_14 });
  }
  await out.store.close();
}

describe('the store opening refusals', () => {
  it('a journal put back to an earlier generation is rolled-back, and nothing is written', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    const db = f.disk.files.get(PATH)!.db;
    const snap = dump(db, 'journal');
    const ev = dump(db, 'till_events');
    await used(f, ['b', 'c']);
    restore(db, 'journal', snap);
    restore(db, 'till_events', ev);
    const out = await openIt(f);
    expect(out.kind).toBe('rolled-back');
    if (out.kind !== 'rolled-back') {
      throw new Error(out.kind);
    }
    expect(out.journalGeneration).toBeLessThan(out.storedGeneration);
    const highest = snap.reduce((n, r) => Math.max(n, Number(r.gen)), 0);
    expect(out.journalGeneration).toBe(highest);
    expect(dump(db, 'journal')).toEqual(snap);
    expect(dump(db, 'till_events')).toEqual(ev);
    expect(f.disk.drivers[f.disk.drivers.length - 1].closed).toBe(true);
  });

  it('use-older takes the older record once the merchant chose it', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    const configured = await openIt(f);
    if (configured.kind !== 'ready') throw new Error(configured.kind);
    await configured.store.lightning.setPolicy('https://merchant.test', 'merchant@wallet.test', 10, 1);
    await configured.store.close();
    const db = f.disk.files.get(PATH)!.db;
    const snap = dump(db, 'journal');
    const ev = dump(db, 'till_events');
    await used(f, ['b', 'c']);
    restore(db, 'journal', snap);
    restore(db, 'till_events', ev);
    const sp = spying();
    const out = await openStore(f.deps, names, { choice: 'use-older', start: sp.start });
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    expect(sp.flags).toEqual([false, true]);
    expect(await out.store.lightning.policies()).toEqual([]);
    const events = await out.store.events.list();
    expect(events[events.length - 1].kind).toBe('used-older-record');
    expect(await out.store.journal.read('sale:a')).not.toBeNull();
    expect(await out.store.journal.read('sale:b')).toBeNull();
    await expect(out.value.receive({ id: 'd', sats: 14, invoice: INVOICE_14 })).resolves.toBeDefined();
    await out.store.close();
  });

  it('use-older on a journal that is not rolled back changes nothing', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    const sp = spying();
    const out = await openStore(f.deps, names, { choice: 'use-older', start: sp.start });
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    expect(sp.flags).toEqual([false]);
    expect((await out.store.events.list()).map((e) => e.kind)).toEqual(['created']);
    await out.store.close();
  });

  it('the library is given acceptRollback only for a new record after a used one', async () => {
    const f = fakeStoreDeps();
    const sp = spying();
    const first = await openStore(f.deps, names, { start: sp.start });
    expect(first.kind).toBe('ready');
    if (first.kind !== 'ready') {
      throw new Error(first.kind);
    }
    expect(sp.flags).toEqual([false]);
    await first.store.close();
    f.disk.files.delete(PATH);
    const second = await openStore(f.deps, names, { choice: 'start-new', start: sp.start });
    expect(second.kind).toBe('ready');
    if (second.kind !== 'ready') {
      throw new Error(second.kind);
    }
    expect(sp.flags).toEqual([false, true]);
    await second.store.close();
    const third = await openStore(f.deps, names, { start: sp.start });
    expect(third.kind).toBe('ready');
    if (third.kind !== 'ready') {
      throw new Error(third.kind);
    }
    expect(sp.flags).toEqual([false, true, false]);
    await third.store.close();
  });

  it('a build without SQLCipher refuses the store', async () => {
    const f = fakeStoreDeps({ cipherVersion: '' });
    const out = await openIt(f);
    expect(out.kind).toBe('store-refused');
    if (out.kind !== 'store-refused') {
      throw new Error(out.kind);
    }
    expect(out.why).toMatch(/SQLCipher/);
  });

  it('durable settings that do not take refuse the store', async () => {
    const a = await openIt(fakeStoreDeps({ synchronous: 1 }));
    expect(a.kind).toBe('store-refused');
    if (a.kind !== 'store-refused') {
      throw new Error(a.kind);
    }
    expect(a.why).toMatch(/synchronous is 1/);
    const b = await openIt(fakeStoreDeps({ journalMode: 'delete' }));
    expect(b.kind).toBe('store-refused');
    if (b.kind !== 'store-refused') {
      throw new Error(b.kind);
    }
    expect(b.why).toMatch(/journal_mode is delete/);
  });

  it('a file not excluded from backup refuses the store, and the database is closed', async () => {
    const f = fakeStoreDeps();
    f.files.noExclude = true;
    const out = await openIt(f);
    expect(out.kind).toBe('store-refused');
    if (out.kind !== 'store-refused') {
      throw new Error(out.kind);
    }
    expect(out.why).toMatch(/not excluded from backup/);
    expect(f.disk.drivers[f.disk.drivers.length - 1].closed).toBe(true);
    expect(dump(f.disk.files.get(PATH)!.db, 'till_events')).toEqual([]);
  });

  it("the library's other failures are open-failed, and the database is closed", async () => {
    const f = fakeStoreDeps();
    const out = await openStore(f.deps, names, {
      start: async () => {
        throw new Error('boom');
      },
    });
    expect(plain(out)).toEqual({ kind: 'open-failed', why: 'boom' });
    expect(f.disk.drivers[f.disk.drivers.length - 1].closed).toBe(true);
  });

  it('start-new or set-aside given on a rolled-back record does nothing', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    const db = f.disk.files.get(PATH)!.db;
    const snap = dump(db, 'journal');
    const ev = dump(db, 'till_events');
    await used(f, ['b', 'c']);
    restore(db, 'journal', snap);
    restore(db, 'till_events', ev);
    expect((await openIt(f, 'start-new')).kind).toBe('rolled-back');
    expect((await openIt(f, 'set-aside')).kind).toBe('rolled-back');
    expect(dump(db, 'journal')).toEqual(snap);
    expect(dump(db, 'till_events')).toEqual(ev);
    expect(f.disk.files.get(PATH)!.db === db).toBe(true);
    expect(f.disk.files.has(PATH + '.set-aside-1000')).toBe(false);
  });
});
