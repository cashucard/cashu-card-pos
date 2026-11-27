import { MemoryJournal, type Delivery, type HttpFetch } from 'cashucard';
import { memoryKeep } from '../src/till/keep';
import { tillConfig } from '../src/till/open';
import { openStoredTill } from '../src/till/stored-till';
import { labNames, TILL_NAMES } from '../src/till/store/types';
import { DevOnlyError, wipeLabStore } from '../src/till/store/wipe';
import { fakeStoreDeps } from './helpers/fake-store';

const names = labNames('t');
const PATH = '/app/lab/lab-t.db';
const http: HttpFetch = async () => {
  throw new Error('no fetch expected');
};
const INVOICE_14 = 'lnbc140n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfs7lvu5';
const D: Delivery = {
  id: 'fx-aaaaaaaaaaaaaaaaaaaaaaaaaa',
  mint: 'https://mint.test',
  unit: 'sat',
  amount: 14,
  token: 'cashuB' + 'q'.repeat(60),
};

describe('the till over the real store', () => {
  it('tillConfig with a store passes the generation store and the merchant\'s acceptRollback, and never exclusive', () => {
    const g = { get: async () => null, set: async () => undefined };
    const c = tillConfig({ http, mints: [] }, new MemoryJournal(), memoryKeep(), {
      generationStore: g,
      acceptRollback: true,
    });
    expect(c.generationStore).toBe(g);
    expect(c.acceptRollback).toBe(true);
    expect(c.exclusive).toBeUndefined();
    expect(c.leftoverByPin).toBe(false);
  });

  it('tillConfig without a store sets neither, as in slice 0.2', () => {
    const c = tillConfig({ http, mints: [] }, new MemoryJournal(), memoryKeep());
    expect(c.generationStore).toBeUndefined();
    expect(c.acceptRollback).toBeUndefined();
    expect(c.exclusive).toBeUndefined();
  });

  it('openStoredTill opens a till over the real store that takes a sale and keeps a delivery once', async () => {
    const f = fakeStoreDeps();
    const out = await openStoredTill(f.deps, { names, http, mints: [] });
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    await expect(out.value.cashuCard.receive({ id: 'a', sats: 14, invoice: INVOICE_14 })).resolves.toBeDefined();
    await out.value.keep.keep(D);
    await out.value.keep.keep(D);
    expect((await out.store.keep.list()).length).toBe(1);
    expect(out.value.keep.calls.length).toBe(2);
    expect(out.value.journal).toBe(out.store.journal);
    await out.store.close();
  });

  it('openStoredTill answers what the store answers', async () => {
    const f = fakeStoreDeps();
    const first = await openStoredTill(f.deps, { names, http, mints: [] });
    if (first.kind !== 'ready') {
      throw new Error(first.kind);
    }
    await first.value.cashuCard.receive({ id: 'a', sats: 14, invoice: INVOICE_14 });
    await first.store.close();
    f.disk.files.delete(PATH);
    const missing = await openStoredTill(f.deps, { names, http, mints: [] });
    expect(missing.kind).toBe('journal-missing');
    const again = await openStoredTill(f.deps, { names, http, mints: [], choice: 'start-new' });
    expect(again.kind).toBe('ready');
    if (again.kind === 'ready') {
      await again.store.close();
    }
  });

  it('wipeLabStore removes a lab store\'s files and items', async () => {
    const f = fakeStoreDeps();
    const out = await openStoredTill(f.deps, { names, http, mints: [] });
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    await out.store.close();
    f.files.extra.add(PATH + '-wal');
    await wipeLabStore(f.deps, names, true);
    expect(f.disk.files.has(PATH)).toBe(false);
    expect(f.files.extra.has(PATH + '-wal')).toBe(false);
    expect(f.secure.items.has(names.key)).toBe(false);
    expect(f.secure.items.has(names.genA)).toBe(false);
    expect(f.secure.items.has(names.genB)).toBe(false);
    const reopened = await openStoredTill(f.deps, { names, http, mints: [] });
    expect(reopened.kind).toBe('ready');
    if (reopened.kind === 'ready') {
      expect(reopened.firstRun).toBe(true);
      await reopened.store.close();
    }
  });

  it('wipeLabStore refuses outside development and for the till\'s own names', async () => {
    const f = fakeStoreDeps();
    const out = await openStoredTill(f.deps, { names, http, mints: [] });
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    await out.store.close();
    await expect(wipeLabStore(f.deps, names, false)).rejects.toBeInstanceOf(DevOnlyError);
    await expect(wipeLabStore(f.deps, TILL_NAMES, true)).rejects.toThrow(/only a lab store/);
    expect(f.disk.files.has(PATH)).toBe(true);
    expect(f.secure.items.has(names.key)).toBe(true);
  });

  it('tillConfig passes the log when given', () => {
    const log = jest.fn();
    expect(tillConfig({ http, mints: [], log }, new MemoryJournal(), memoryKeep()).log).toBe(log);
    expect(tillConfig({ http, mints: [] }, new MemoryJournal(), memoryKeep()).log).toBeUndefined();
  });

  it("a generation that cannot be stored is logged through the store's log", async () => {
    const f = fakeStoreDeps();
    const out = await openStoredTill(f.deps, { names, http, mints: [] });
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    f.secure.failSet.add('*');
    await out.value.cashuCard.receive({ id: 'x', sats: 14, invoice: INVOICE_14 });
    expect(f.logs.filter((l) => l.includes('could not be stored outside it')).length).toBeGreaterThanOrEqual(1);
    expect(f.logs.join('\n')).not.toMatch(/[0-9a-f]{64}/);
    await out.store.close();
  });

  it("wipeLabStore refuses names whose secure items are not a lab store's", async () => {
    const f = fakeStoreDeps();
    const out = await openStoredTill(f.deps, { names, http, mints: [] });
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    await out.store.close();
    f.secure.items.set(TILL_NAMES.key, 'ab'.repeat(32));
    await expect(wipeLabStore(f.deps, { ...names, key: TILL_NAMES.key }, true)).rejects.toThrow(/only a lab store/);
    await expect(wipeLabStore(f.deps, { ...names, genA: TILL_NAMES.genA }, true)).rejects.toThrow(/only a lab store/);
    await expect(wipeLabStore(f.deps, { ...names, genB: TILL_NAMES.genB }, true)).rejects.toThrow(/only a lab store/);
    expect(f.secure.items.get(TILL_NAMES.key)).toBe('ab'.repeat(32));
    expect(f.disk.files.has(PATH)).toBe(true);
    expect(f.secure.items.has(names.key)).toBe(true);
  });
});
