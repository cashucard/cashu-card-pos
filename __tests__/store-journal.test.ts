import { open, walletPayout, type HttpFetch, type Row } from 'cashucard';
import { createSchema, createSerial, openDatabase } from '../src/till/store/db';
import { SqliteJournal } from '../src/till/store/journal';
import { dump, fakeDisk } from './helpers/fake-sql';

const KEY = 'ab'.repeat(32);

const sale = (id: string, amount: number): Row =>
  ({
    kind: 'sale',
    id: 'sale:' + id,
    sale: { id, sats: amount },
    request: '00',
    unit: 'sat',
    amount,
    mints: [],
    at: 1,
  }) as Row;

const amountOf = (r: Row | null): number => (r as unknown as { amount: number }).amount;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

const http: HttpFetch = async () => {
  throw new Error('no fetch expected');
};

const INVOICE_14 = 'lnbc140n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfs7lvu5';

const libraryOver = (journal: SqliteJournal) =>
  open({ journal, payout: walletPayout({ mints: [], keep: async () => undefined }), http, leftoverByPin: false, clock: null });

async function setup() {
  const disk = fakeDisk();
  const { driver } = await openDatabase(disk.opener, '/d', 'j.db', KEY);
  await createSchema(driver);
  const fd = disk.drivers[0];
  const db = disk.files.get('/d/j.db')!.db;
  const j = new SqliteJournal(driver, createSerial(), () => 1000);
  return { disk, driver, fd, db, j };
}

describe('the journal over SQLite', () => {
  it('write then read gives the row back', async () => {
    const { j } = await setup();
    const row = sale('a', 1);
    await j.write(row);
    expect(await j.read('sale:a')).toEqual(row);
  });

  it('a second write of an id replaces it and keeps its place in the list', async () => {
    const { j } = await setup();
    await j.write(sale('a', 1));
    await j.write(sale('b', 1));
    await j.write(sale('a', 2));
    expect((await j.list()).map((r) => r.id)).toEqual(['sale:a', 'sale:b']);
    expect(amountOf(await j.read('sale:a'))).toBe(2);
  });

  it('insert writes a new row and answers true', async () => {
    const { j } = await setup();
    const row = sale('a', 1);
    expect(await j.insert(row)).toBe(true);
    expect(await j.read('sale:a')).toEqual(row);
  });

  it('insert of an id already kept answers false and leaves the first row', async () => {
    const { j } = await setup();
    expect(await j.insert(sale('a', 1))).toBe(true);
    expect(await j.insert(sale('a', 9))).toBe(false);
    expect(amountOf(await j.read('sale:a'))).toBe(1);
    await j.write(sale('a', 5));
    expect(await j.insert(sale('a', 9))).toBe(false);
    expect(amountOf(await j.read('sale:a'))).toBe(5);
  });

  it('insert that fails for another reason rejects, it never answers false', async () => {
    const { j, fd } = await setup();
    fd.failOn('ON CONFLICT(id) DO NOTHING', 'NOT NULL constraint failed: journal.kind');
    await expect(j.insert(sale('a', 1))).rejects.toThrow(/NOT NULL/);
  });

  it('write resolves only after the statement has finished', async () => {
    const { j, fd } = await setup();
    const release = fd.hold('ON CONFLICT(id) DO UPDATE');
    let done = false;
    const p = j.write(sale('a', 1)).then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    release();
    await p;
    expect(done).toBe(true);
    expect(await j.read('sale:a')).not.toBeNull();
  });

  it('a failed write rejects and keeps nothing', async () => {
    const { j, fd } = await setup();
    fd.failOn('DO UPDATE', 'disk I/O error');
    await expect(j.write(sale('a', 1))).rejects.toThrow(/disk I\/O error/);
    fd.clearFailures();
    expect(await j.read('sale:a')).toBeNull();
  });

  it('a row without an id is refused before anything runs', async () => {
    const { j, fd } = await setup();
    const n = fd.log.length;
    await expect(j.write({ kind: 'sale' } as unknown as Row)).rejects.toThrow(/needs an id/);
    expect(fd.log.length).toBe(n);
  });

  it('two writes never run at once, and commit in the order called', async () => {
    const { j, fd } = await setup();
    const release = fd.hold('DO UPDATE');
    const pa = j.write(sale('a', 1));
    const pb = j.write(sale('b', 1));
    await tick();
    expect(fd.running).toBe(1);
    release();
    await Promise.all([pa, pb]);
    expect(fd.most).toBe(1);
    const upserts = fd.log
      .map((sql, index) => ({ sql, index }))
      .filter((x) => x.sql.includes('ON CONFLICT(id) DO UPDATE'));
    expect(upserts).toHaveLength(2);
    expect(upserts[0].index).toBeLessThan(upserts[1].index);
    expect((await j.list()).map((r) => r.id)).toEqual(['sale:a', 'sale:b']);
  });

  it('read of an id not kept is null', async () => {
    const { j } = await setup();
    expect(await j.read('sale:zz')).toBeNull();
  });

  it('remove takes the row out, and removing an id not kept resolves', async () => {
    const { j } = await setup();
    await j.write(sale('a', 1));
    await j.remove('sale:a');
    expect(await j.read('sale:a')).toBeNull();
    await expect(j.remove('sale:zz')).resolves.toBeUndefined();
  });

  it("the row's kind and generation go into their columns", async () => {
    const { j, db } = await setup();
    await j.write({ ...sale('a', 1), gen: 7 } as unknown as Row);
    const row = dump(db, 'journal')[0];
    expect(row.kind).toBe('sale');
    expect(row.gen).toBe(7);
    expect(row.written_at).toBe(1000);
    expect(row.id).toBe('sale:a');
    expect(await j.stats()).toEqual({ rows: 1, gen: 7 });
    await j.write({ ...sale('b', 1), gen: -1 } as unknown as Row);
    expect(dump(db, 'journal').find((x) => x.id === 'sale:b')!.gen).toBe(0);
    await j.write({ ...sale('c', 1), gen: 1.5 } as unknown as Row);
    expect(dump(db, 'journal').find((x) => x.id === 'sale:c')!.gen).toBe(0);
  });

  it('a body that is not JSON is handed back as an unreadable row, not thrown', async () => {
    const { j, db } = await setup();
    for (const body of ['{not json', '[1]', '7']) {
      db.prepare(
        "INSERT INTO journal (id, kind, gen, body, written_at) VALUES ('sale:x', 'sale', 0, ?, 0)",
      ).run(body);
      expect(await j.list()).toEqual([{ id: 'sale:x', unreadable: true }]);
      expect(await j.read('sale:x')).toEqual({ id: 'sale:x', unreadable: true });
      await j.remove('sale:x');
    }
  });

  it('the library opens over it, takes a sale once, and stamps every row with a generation', async () => {
    const { j, db } = await setup();
    const c = await libraryOver(j);
    await expect(c.receive({ id: 't1', sats: 14, invoice: INVOICE_14 })).resolves.toBeDefined();
    await expect(c.receive({ id: 't1', sats: 14, invoice: INVOICE_14 })).rejects.toMatchObject({ kind: 'same-sale' });
    const rows = dump(db, 'journal');
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('lease');
    expect(ids).toContain('sale:t1');
    for (const r of rows) {
      expect(Number(r.gen)).toBeGreaterThanOrEqual(1);
    }
  });

  it('the library leaves a row it cannot read alone', async () => {
    const { j, db } = await setup();
    db.prepare(
      "INSERT INTO journal (id, kind, gen, body, written_at) VALUES ('sale:x', 'sale', 0, '{not json', 0)",
    ).run();
    const c = await libraryOver(j);
    expect((await c.olderRows()).map((r) => r.id)).toContain('sale:x');
    await expect(c.receive({ id: 'x', sats: 14, invoice: INVOICE_14 })).rejects.toMatchObject({ kind: 'same-sale' });
    const row = dump(db, 'journal').find((r) => r.id === 'sale:x')!;
    expect(row.body).toBe('{not json');
  });

  it('list gives the rows in the order they were first written, not by id', async () => {
    const { j } = await setup();
    await j.write(sale('z', 1));
    await j.write(sale('a', 1));
    await j.write(sale('m', 1));
    await j.write(sale('z', 2));
    expect((await j.list()).map((r) => r.id)).toEqual(['sale:z', 'sale:a', 'sale:m']);
  });
});
