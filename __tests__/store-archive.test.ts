// The archive's move and its reads (slice 2.3): a journal row leaves the journal only by moving, whole, into the archive
// in the same transaction; a failure at any step leaves it where it was; the takings count each payment once, never an
// extra, a refusal or a delivery; no body is read for a count.
import type { Row } from 'cashucard';
import { createSchema, createSerial, openDatabase } from '../src/till/store/db';
import { SqliteJournal } from '../src/till/store/journal';
import { ArchiveReader } from '../src/till/store/archive';
import { openStore } from '../src/till/store/open-store';
import { SQL } from '../src/till/store/sql';
import { labNames } from '../src/till/store/types';
import { fakeStoreDeps } from './helpers/fake-store';
import { dump, fakeDisk } from './helpers/fake-sql';

const KEY = 'ab'.repeat(32);

const payRow = (id: string, o: Record<string, unknown>): Row =>
  ({
    kind: 'payment',
    id,
    sale: 's-1',
    how: 'card',
    step: 'swapped',
    mint: 'https://mint.test',
    unit: 'sat',
    fee: 1,
    ...o,
  }) as unknown as Row;

async function setup() {
  const disk = fakeDisk();
  const { driver } = await openDatabase(disk.opener, '/d', 'j.db', KEY);
  await createSchema(driver);
  const fd = disk.drivers[0];
  const db = disk.files.get('/d/j.db')!.db;
  const serial = createSerial();
  const j = new SqliteJournal(driver, serial, () => 1000);
  const archive = new ArchiveReader(driver, serial);
  return { fd, db, j, archive };
}

describe('the archive', () => {
  it('remove moves the row into the archive whole, with its fields, in one transaction', async () => {
    const { fd, db, j } = await setup();
    const row = payRow('pay:a', { state: 'delivered', amount: 14, at: 500 });
    await j.write(row);
    fd.log.length = 0;
    await j.remove('pay:a');
    expect(fd.log).toEqual([SQL.journalRow, SQL.begin, SQL.archiveInsert, SQL.journalRemove, SQL.commit]);
    expect(await j.read('pay:a')).toBeNull();
    expect(dump(db, 'journal')).toEqual([]);
    expect(dump(db, 'archive')).toEqual([
      {
        id: 'pay:a',
        kind: 'payment',
        gen: 0,
        body: JSON.stringify(row),
        written_at: 1000,
        archived_at: 1000,
        sale: 's-1',
        state: 'delivered',
        extra: null,
        at: 500,
        amount: 14,
        fee: 1,
        mint: 'https://mint.test',
        unit: 'sat',
      },
    ]);
  });

  it('a failure inside the move leaves the row in the journal and nothing in the archive', async () => {
    const { fd, db, j } = await setup();
    const row = payRow('pay:a', { state: 'delivered', amount: 14, at: 500 });
    await j.write(row);
    fd.failOn('DELETE FROM journal', 'disk I/O error');
    await expect(j.remove('pay:a')).rejects.toThrow('disk I/O error');
    expect(fd.log[fd.log.length - 1]).toBe(SQL.rollback);
    expect(dump(db, 'archive')).toEqual([]);
    expect(await j.read('pay:a')).toEqual(row);
    fd.clearFailures();
    fd.failOn('INTO archive', 'disk full');
    await expect(j.remove('pay:a')).rejects.toThrow('disk full');
    expect(dump(db, 'archive')).toEqual([]);
    expect(dump(db, 'journal').map((x) => x.id)).toEqual(['pay:a']);
    fd.clearFailures();
    fd.failOn('COMMIT', 'disk full');
    await expect(j.remove('pay:a')).rejects.toThrow('disk full');
    expect(dump(db, 'archive')).toEqual([]);
    expect(dump(db, 'journal').map((x) => x.id)).toEqual(['pay:a']);
    fd.clearFailures();
    await j.remove('pay:a');
    expect(dump(db, 'journal')).toEqual([]);
    expect(dump(db, 'archive').map((x) => x.id)).toEqual(['pay:a']);
  });

  it('removing an id not kept changes nothing', async () => {
    const { fd, db, j } = await setup();
    await j.write(payRow('pay:a', { state: 'delivered', amount: 14, at: 500 }));
    fd.log.length = 0;
    await expect(j.remove('pay:zz')).resolves.toBeUndefined();
    expect(fd.log).toEqual([SQL.journalRow]);
    expect(dump(db, 'archive')).toEqual([]);
    expect(dump(db, 'journal').map((x) => x.id)).toEqual(['pay:a']);
  });

  it('a body that does not read is moved whole, with its fields empty', async () => {
    const { db, j } = await setup();
    db.prepare(
      "INSERT INTO journal (id, kind, gen, body, written_at) VALUES ('pay:x', 'payment', 2, '{not json', 7)",
    ).run();
    await j.remove('pay:x');
    expect(dump(db, 'journal')).toEqual([]);
    expect(dump(db, 'archive')).toEqual([
      {
        id: 'pay:x',
        kind: 'payment',
        gen: 2,
        body: '{not json',
        written_at: 7,
        archived_at: 1000,
        sale: null,
        state: null,
        extra: null,
        at: null,
        amount: null,
        fee: null,
        mint: null,
        unit: null,
      },
    ]);
  });

  it('the takings count delivered and taken out payments once, never an extra, a refusal, a loss or a delivery', async () => {
    const { j, archive } = await setup();
    const rows: Row[] = [
      payRow('pay:a', { state: 'delivered', amount: 14, at: 100 }),
      payRow('pay:b', { state: 'exported', amount: 20, at: 200 }),
      payRow('pay:c', { state: 'none', step: 'refused', amount: 30, at: 300 }),
      payRow('pay:d', { state: 'delivered', extra: 'paid-twice', amount: 40, at: 400 }),
      payRow('pay:e', { state: 'gone', how: 'ecash', amount: 50, at: 450 }),
      {
        kind: 'delivery',
        id: 'fx-1',
        payments: ['pay:a'],
        state: 'delivered',
        sent: true,
        at: 500,
        delivery: { id: 'fx-1', mint: 'https://mint.test', unit: 'sat', amount: 14, token: 'cashuB' + 'x'.repeat(40) },
      } as unknown as Row,
    ];
    for (const r of rows) {
      await j.write(r);
    }
    for (const r of rows) {
      await j.remove(r.id);
    }
    expect(await archive.takings(null, null)).toEqual({ sats: 34, count: 2 });
    expect(await archive.takings(150, 250)).toEqual({ sats: 20, count: 1 });
    expect(await archive.takings(0, 150)).toEqual({ sats: 14, count: 1 });
    expect(await archive.takings(201, null)).toEqual({ sats: 0, count: 0 });
    expect(await archive.has('pay:a')).toBe(true);
    expect(await archive.has('fx-1')).toBe(true);
    expect(await archive.has('pay:zz')).toBe(false);
    expect(await archive.payments()).toEqual([
      { state: 'delivered', at: 100, amount: 14, fee: 1, mint: 'https://mint.test', unit: 'sat' },
      { state: 'exported', at: 200, amount: 20, fee: 1, mint: 'https://mint.test', unit: 'sat' },
      { state: 'delivered', at: 400, amount: 40, fee: 1, mint: 'https://mint.test', unit: 'sat' },
      { state: 'gone', at: 450, amount: 50, fee: 1, mint: 'https://mint.test', unit: 'sat' },
    ]);
    expect(JSON.stringify(await archive.payments())).not.toContain('cashu');
    expect(JSON.stringify(await archive.payments())).not.toContain('pay:');
  });

  it('the journal counts its rows of one kind and says when each payment row was written, reading no body', async () => {
    const { fd, j } = await setup();
    await j.write({
      kind: 'sale',
      id: 'sale:s-1',
      sale: { id: 's-1', sats: 14 },
      request: '00',
      unit: 'sat',
      amount: 14,
      mints: [],
      at: 1,
    } as unknown as Row);
    await j.write(payRow('pay:a', { state: 'delivered', amount: 14, at: 500 }));
    await j.write(payRow('pay:b', { state: 'held', amount: 14, at: 600 }));
    fd.log.length = 0;
    expect(await j.count('payment')).toBe(2);
    expect(await j.count('sale')).toBe(1);
    expect(await j.count('delivery')).toBe(0);
    expect(Array.from((await j.writtenAt()).entries())).toEqual([
      ['pay:a', 1000],
      ['pay:b', 1000],
    ]);
    expect(fd.log).toEqual([SQL.journalCount, SQL.journalCount, SQL.journalCount, SQL.journalWritten]);
    for (const s of fd.log) {
      expect(s).not.toContain('body');
    }
  });

  it('an opened store gives the archive over the same file', async () => {
    const f = fakeStoreDeps();
    const out = await openStore(f.deps, labNames('v'), { start: async () => 1 });
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    expect(await out.store.archive.takings(null, null)).toEqual({ sats: 0, count: 0 });
    await out.store.journal.write(payRow('pay:a', { state: 'delivered', amount: 14, at: 500 }));
    await out.store.journal.remove('pay:a');
    expect(await out.store.archive.takings(null, null)).toEqual({ sats: 14, count: 1 });
    expect(await out.store.archive.has('pay:a')).toBe(true);
    await out.store.close();
  });
});
