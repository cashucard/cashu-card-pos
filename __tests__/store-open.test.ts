import { open, walletPayout, type CashuCard, type HttpFetch, type Row } from 'cashucard';
import { StoreClosedError } from '../src/till/store/db';
import { SCHEMA_VERSION, SQL } from '../src/till/store/sql';
import { labNames, type SqlDriver, type SqlValue } from '../src/till/store/types';
import { openStore, type OpenStore, type StoreChoice } from '../src/till/store/open-store';
import { fakeStoreDeps, type FakeStore } from './helpers/fake-store';
import { dump, memoryDb, type FakeDriver } from './helpers/fake-sql';

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

describe('the till store opening', () => {
  it('first run: a key is made, slot a marked, the file made with its tables, excluded from backup, the library opened', async () => {
    const f = fakeStoreDeps();
    const out = await openIt(f);
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    expect(out.firstRun).toBe(true);
    expect(f.secure.items.get(names.key)).toMatch(/^[0-9a-f]{64}$/);
    expect(f.secure.items.get(names.genA)).toBe('0');
    expect(f.disk.files.has(PATH)).toBe(true);
    expect(f.files.excludedPaths.has('/app/lab')).toBe(true);
    expect(f.files.excludedPaths.has(PATH)).toBe(true);
    expect((await out.store.events.list()).map((e) => e.kind)).toEqual(['created']);
    expect(await out.store.generation.get()).toBeGreaterThanOrEqual(1);
    await out.store.close();
  });

  it('a second open is a normal open that keeps its rows', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    const key = f.secure.items.get(names.key);
    const out = await openIt(f);
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    expect(out.firstRun).toBe(false);
    expect(f.secure.items.get(names.key)).toBe(key);
    expect(await out.store.journal.read('sale:a')).not.toBeNull();
    expect((await out.store.events.list()).map((e) => e.kind)).toEqual(['created']);
    await out.store.close();
  });

  it('a missing file after a journal was used is journal-missing, and no file is made', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    const n = f.disk.drivers.length;
    const sets = f.secure.sets.length;
    f.disk.files.delete(PATH);
    const out = await openIt(f);
    expect(out.kind).toBe('journal-missing');
    if (out.kind !== 'journal-missing') {
      throw new Error(out.kind);
    }
    expect(out.storedGeneration).toBeGreaterThanOrEqual(2);
    expect(f.disk.files.has(PATH)).toBe(false);
    expect(f.disk.drivers.length).toBe(n);
    expect(f.secure.sets.length).toBe(sets);
  });

  it('start-new after a missing file makes a new record, carries the generation on, and notes it', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    f.disk.files.delete(PATH);
    const out = await openIt(f);
    expect(out.kind).toBe('journal-missing');
    if (out.kind !== 'journal-missing') {
      throw new Error(out.kind);
    }
    const before = out.storedGeneration;
    const out2 = await openIt(f, 'start-new');
    expect(out2.kind).toBe('ready');
    if (out2.kind !== 'ready') {
      throw new Error(out2.kind);
    }
    expect(out2.firstRun).toBe(true);
    expect((await out2.store.events.list()).map((e) => e.kind)).toEqual([
      'created',
      'started-new-after-missing',
    ]);
    expect(await out2.store.generation.get()).toBeGreaterThan(before);
    await expect(out2.value.receive({ id: 'b', sats: 14, invoice: INVOICE_14 })).resolves.toBeDefined();
    await out2.store.close();
  });

  it('a choice for another state does nothing', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    f.disk.files.delete(PATH);
    expect((await openIt(f, 'use-older')).kind).toBe('journal-missing');
    expect((await openIt(f, 'set-aside')).kind).toBe('journal-missing');
    expect(f.disk.files.has(PATH)).toBe(false);
  });

  it('a key that is gone with the file kept is key-missing, and no key is made', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    f.secure.items.delete(names.key);
    const out = await openIt(f);
    expect(plain(out)).toEqual({ kind: 'key-missing' });
    expect(f.secure.items.has(names.key)).toBe(false);
    expect(f.disk.files.has(PATH)).toBe(true);
  });

  it('set-aside with the key gone keeps the old file under a new name and starts a new record', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    f.secure.items.delete(names.key);
    const out = await openIt(f, 'set-aside');
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    expect(out.firstRun).toBe(true);
    expect(f.disk.files.has(PATH + '.set-aside-1000')).toBe(true);
    expect(f.disk.files.has(PATH)).toBe(true);
    expect(f.secure.items.get(names.key)).toMatch(/^[0-9a-f]{64}$/);
    expect((await out.store.events.list()).map((e) => e.kind)).toEqual(['created', 'set-aside']);
    await out.store.close();
  });

  it('a file made with another key is unreadable, and is left as it is', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    const db = f.disk.files.get(PATH)!.db;
    f.secure.items.set(names.key, 'ee'.repeat(32));
    const out = await openIt(f);
    expect(out.kind).toBe('unreadable');
    if (out.kind !== 'unreadable') {
      throw new Error(out.kind);
    }
    expect(out.why).toMatch(/does not open with this key/);
    expect(f.disk.files.get(PATH)!.db === db).toBe(true);
    expect(dump(db, 'journal').map((r) => r.id)).toContain('sale:a');
  });

  it('set-aside on an unreadable file keeps it and starts a new record with the key there', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    const db = f.disk.files.get(PATH)!.db;
    f.secure.items.set(names.key, 'ee'.repeat(32));
    const out = await openIt(f, 'set-aside');
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    expect(f.disk.files.get(PATH + '.set-aside-1000')!.db === db).toBe(true);
    expect(f.secure.items.get(names.key)).toBe('ee'.repeat(32));
    await out.store.close();
  });

  it('a store that cannot be read is never a first run', async () => {
    const f = fakeStoreDeps();
    f.secure.failGet.add('*');
    expect((await openIt(f)).kind).toBe('secure-store-unavailable');
    expect(f.secure.sets).toEqual([]);
    expect(f.disk.files.size).toBe(0);
  });

  it('a generation slot that is not a number refuses the store', async () => {
    const f = fakeStoreDeps();
    f.secure.items.set(names.genA, 'x');
    expect((await openIt(f)).kind).toBe('store-refused');
    expect(f.disk.files.size).toBe(0);
  });

  it('a key that reads back differently refuses the store', async () => {
    const f = fakeStoreDeps();
    const inner = f.secure;
    f.deps.secure = {
      async get(name: string): Promise<string | null> {
        return inner.get(name);
      },
      async set(name: string, value: string): Promise<void> {
        await inner.set(name, name === names.key ? 'cd'.repeat(32) : value);
      },
      async remove(name: string): Promise<void> {
        await inner.remove(name);
      },
    };
    expect((await openIt(f)).kind).toBe('store-refused');
    expect(f.disk.files.size).toBe(0);
  });

  it('stray write-ahead files with no database are set aside before a new file is made', async () => {
    const f = fakeStoreDeps();
    f.files.extra.add(PATH + '-wal');
    const out = await openIt(f);
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    expect(out.firstRun).toBe(true);
    expect(f.files.extra.has(PATH + '-wal.stray-1000')).toBe(true);
    expect(f.files.extra.has(PATH + '-wal')).toBe(false);
    expect((await out.store.events.list()).map((e) => e.kind)).toEqual([
      'created',
      'stray-files-set-aside',
    ]);
    await out.store.close();
  });

  it('a key with no file and no journal used is a first run that keeps the key', async () => {
    const f = fakeStoreDeps();
    f.secure.items.set(names.key, 'ab'.repeat(32));
    f.secure.items.set(names.genA, '0');
    const out = await openIt(f);
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    expect(out.firstRun).toBe(true);
    expect(f.secure.items.get(names.key)).toBe('ab'.repeat(32));
    await out.store.close();
  });

  it('an empty file where a record was is journal-missing', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    f.disk.files.set(PATH, { db: memoryDb(), key: f.secure.items.get(names.key)! });
    const out = await openIt(f);
    expect(out.kind).toBe('journal-missing');
    expect(f.disk.drivers[f.disk.drivers.length - 1].closed).toBe(true);
  });

  it('a newer layout is newer-format', async () => {
    const f = fakeStoreDeps();
    await used(f, []);
    f.disk.files.get(PATH)!.db.exec('PRAGMA user_version = ' + (SCHEMA_VERSION + 1));
    expect(plain(await openIt(f))).toEqual({ kind: 'newer-format', version: SCHEMA_VERSION + 1 });
  });

  it('files that cannot be read', async () => {
    const f = fakeStoreDeps();
    f.files.failExists = true;
    expect((await openIt(f)).kind).toBe('files-unavailable');
    expect(f.secure.sets).toEqual([]);
    expect(f.disk.files.size).toBe(0);
  });

  it('a first read that fails for another reason is open-failed, and set-aside does nothing to it', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    const db = f.disk.files.get(PATH)!.db;
    const real = f.deps.opener;
    let locked = true;
    f.deps.opener = {
      async open(dir: string, file: string, key: string) {
        const d = (await real.open(dir, file, key)) as FakeDriver;
        if (locked) {
          d.failOn('sqlite_master', 'database is locked');
        }
        return d;
      },
    };
    expect(plain(await openIt(f))).toEqual({
      kind: 'open-failed',
      why: 'the file could not be read: database is locked',
    });
    expect((await openIt(f, 'set-aside')).kind).toBe('open-failed');
    expect(f.disk.files.get(PATH)!.db === db).toBe(true);
    expect(f.disk.files.has(PATH + '.set-aside-1000')).toBe(false);
    locked = false;
    const again = await openIt(f);
    expect(again.kind).toBe('ready');
    if (again.kind !== 'ready') {
      throw new Error(again.kind);
    }
    expect(await again.store.journal.read('sale:a')).not.toBeNull();
    await again.store.close();
  });

  it('an opener that fails on a kept file is open-failed, never unreadable', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    f.disk.openFails = 'the file cannot be opened now';
    expect(plain(await openIt(f))).toEqual({
      kind: 'open-failed',
      why: 'the database could not be opened: the file cannot be opened now',
    });
    expect((await openIt(f, 'set-aside')).kind).toBe('open-failed');
    expect(f.disk.files.has(PATH)).toBe(true);
    expect(f.disk.files.has(PATH + '.set-aside-1000')).toBe(false);
  });

  it('a set-aside cut off after its sidecars leaves the file in place, and the next open names the same state', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    f.files.extra.add(PATH + '-wal');
    f.secure.items.delete(names.key);
    const move = f.files.move;
    f.files.move = async (from: string, to: string): Promise<void> => {
      if (from === PATH) {
        throw new Error('killed');
      }
      return move(from, to);
    };
    expect((await openIt(f, 'set-aside')).kind).toBe('files-unavailable');
    f.files.move = move;
    expect(f.disk.files.has(PATH)).toBe(true);
    expect(f.files.extra.has(PATH + '-wal')).toBe(false);
    expect(f.files.extra.has(PATH + '-wal.set-aside-1000')).toBe(true);
    expect(plain(await openIt(f))).toEqual({ kind: 'key-missing' });
    const out = await openIt(f, 'set-aside');
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    expect(f.disk.files.has(PATH + '.set-aside-1000')).toBe(true);
    expect(f.files.extra.has(PATH + '-wal.set-aside-1000')).toBe(true);
    expect([...f.files.extra].filter((p) => p.includes('.stray-'))).toEqual([]);
    await out.store.close();
  });

  it('a new record cut off before the library opened it is still journal-missing, never rolled-back', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    f.disk.files.delete(PATH);
    const cut = await openStore(f.deps, names, {
      choice: 'start-new',
      start: async () => {
        throw new Error('killed');
      },
    });
    expect(cut.kind).toBe('open-failed');
    const db = f.disk.files.get(PATH)!.db;
    expect(dump(db, 'journal')).toEqual([]);
    expect(plain(await openIt(f))).toEqual({ kind: 'journal-missing', storedGeneration: 2 });
    expect(dump(db, 'journal')).toEqual([]);
    expect(dump(db, 'till_events')).toEqual([]);
    const out = await openIt(f, 'start-new');
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    expect((await out.store.events.list()).map((e) => e.kind)).toEqual(['created', 'started-new-after-missing']);
    expect((await out.store.journal.stats()).gen).toBe(3);
    await out.store.close();
  });

  it('opening a record that holds rows never counts them', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    const seen: Array<{ phase: 'open' | 'library'; sql: string }> = [];
    let phase: 'open' | 'library' = 'open';
    const real = f.deps.opener;
    f.deps.opener = {
      async open(dir: string, file: string, key: string): Promise<SqlDriver> {
        const inner = await real.open(dir, file, key);
        return {
          async run(sql: string, params?: readonly SqlValue[]) {
            seen.push({ phase, sql });
            return inner.run(sql, params);
          },
          close: () => inner.close(),
        };
      },
    };
    const out = await openStore(f.deps, names, {
      start: (s: OpenStore, acceptRollback: boolean): Promise<CashuCard> => {
        phase = 'library';
        return start(s, acceptRollback);
      },
    });
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    const duringOpen = seen.filter((r) => r.phase === 'open').map((r) => r.sql);
    expect(duringOpen).toContain('SELECT id FROM journal LIMIT 1');
    expect(duringOpen).not.toContain(SQL.journalStats);
    expect(await out.store.journal.read('sale:a')).not.toBeNull();
    await out.store.close();
  });

  it('a journal opened with no generation stored is noted', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a']);
    f.secure.items.delete(names.genA);
    f.secure.items.delete(names.genB);
    const out = await openIt(f);
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    expect(out.firstRun).toBe(false);
    expect((await out.store.events.list()).map((e) => e.kind)).toEqual(['created', 'generation-empty']);
    expect(await out.store.generation.get()).toBe(3);
    await out.store.close();
  });

  it('close waits for the calls before it, closes once, and the store refuses calls after it', async () => {
    const f = fakeStoreDeps();
    const out = await openIt(f);
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    const d = f.disk.drivers[f.disk.drivers.length - 1];
    const closeSpy = jest.spyOn(d, 'close');
    const release = d.hold('DO UPDATE');
    const written = out.store.journal.write({ kind: 'sale', id: 'sale:held' } as unknown as Row);
    const closing = out.store.close();
    await new Promise<void>((r) => setTimeout(() => r(), 10));
    expect(d.closed).toBe(false);
    release();
    await written;
    await closing;
    expect(d.closed).toBe(true);
    expect(dump(d.db, 'journal').map((r) => r.id)).toContain('sale:held');
    await expect(out.store.journal.read('sale:held')).rejects.toBeInstanceOf(StoreClosedError);
    await expect(out.store.events.add('created', 'after close')).rejects.toBeInstanceOf(StoreClosedError);
    await out.store.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('two sets cut off in successive launches never make a missing file a first run', async () => {
    const f = fakeStoreDeps();
    await used(f, ['a', 'b']);
    const first = await openIt(f);
    if (first.kind !== 'ready') {
      throw new Error(first.kind);
    }
    f.secure.dieInSet.add(names.genA);
    f.secure.dieInSet.add(names.genB);
    await first.value.receive({ id: 'c', sats: 14, invoice: INVOICE_14 });
    f.secure.dieInSet.clear();
    await first.store.close();
    f.secure.dieInSet.add(names.genA);
    f.secure.dieInSet.add(names.genB);
    const second = await openIt(f);
    f.secure.dieInSet.clear();
    if (second.kind !== 'ready') {
      throw new Error(second.kind);
    }
    await second.store.close();
    f.disk.files.delete(PATH);
    expect(plain(await openIt(f))).toEqual({ kind: 'journal-missing', storedGeneration: 4 });
    expect(f.disk.files.has(PATH)).toBe(false);
  });
});
