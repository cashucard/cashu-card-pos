// Schema upgrades preserve the journal and existing merchant deliveries in one transaction.
import { open, walletPayout, type CashuCard, type HttpFetch } from 'cashucard';
import { createSchema, LayoutError, openDatabase, upgradeSchema } from '../src/till/store/db';
import { ARCHIVE_TABLE, SCHEMA_VERSION, SQL, UPGRADES } from '../src/till/store/sql';
import { labNames } from '../src/till/store/types';
import { openStore, type OpenStore } from '../src/till/store/open-store';
import { fakeStoreDeps, type FakeStore } from './helpers/fake-store';
import { dump, fakeDisk, type NodeDb } from './helpers/fake-sql';

const KEY = 'ab'.repeat(32);
const names = labNames('u');
const PATH = '/app/lab/lab-u.db';
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
const openIt = (f: FakeStore) => openStore(f.deps, names, { start });

/** Layout 1, as slice 0.3 made it. */
const LAYOUT_1 = [
  'CREATE TABLE journal (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, gen INTEGER NOT NULL, body TEXT NOT NULL, written_at INTEGER NOT NULL)',
  'CREATE TABLE kept (id TEXT PRIMARY KEY NOT NULL, mint TEXT NOT NULL, mint_norm TEXT NOT NULL, unit TEXT NOT NULL, amount INTEGER NOT NULL, token TEXT NOT NULL, body TEXT NOT NULL, kept_at INTEGER NOT NULL)',
  'CREATE TABLE till_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)',
  'PRAGMA user_version = 1',
];

function tables(db: NodeDb): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => String(r.name));
}

function version(db: NodeDb): number {
  return Number(db.prepare('PRAGMA user_version').all()[0].user_version);
}

/** A file of layout 1 holding one journal row, reopened: its driver and its database. */
async function layout1() {
  const disk = fakeDisk();
  const first = await openDatabase(disk.opener, '/d', 'a.db', KEY);
  for (const s of LAYOUT_1) {
    await first.driver.run(s);
  }
  await first.driver.run(
    "INSERT INTO journal (id, kind, gen, body, written_at) VALUES ('sale:a', 'sale', 3, '{}', 5)",
  );
  const again = await openDatabase(disk.opener, '/d', 'a.db', KEY);
  return { disk, again, db: disk.files.get('/d/a.db')!.db };
}

describe('the current record layout', () => {
  it('a new record is made with the archive, withdrawals, and customer handoffs', async () => {
    const disk = fakeDisk();
    const { driver } = await openDatabase(disk.opener, '/d', 'a.db', KEY);
    await createSchema(driver);
    const db = disk.files.get('/d/a.db')!.db;
    expect(SCHEMA_VERSION).toBe(9);
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(tables(db)).toEqual(['archive', 'backup_control', 'backup_imported_payments', 'card_topups', 'extra_handoffs', 'journal', 'kept', 'lightning_checkpoint', 'lightning_payouts', 'lightning_sales', 'lightning_sweeps', 'offline_archive_cursor', 'offline_kits', 'offline_spent_inputs', 'till_events', 'withdrawals']);
    expect(dump(db, 'archive')).toEqual([]);
  });

  it('a layout 1 record is brought to the current layout in one transaction, its rows untouched', async () => {
    const { disk, again, db } = await layout1();
    expect(again.version).toBe(1);
    await upgradeSchema(again.driver, 1);
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(tables(db)).toEqual(['archive', 'backup_control', 'backup_imported_payments', 'card_topups', 'extra_handoffs', 'journal', 'kept', 'lightning_checkpoint', 'lightning_payouts', 'lightning_sales', 'lightning_sweeps', 'offline_archive_cursor', 'offline_kits', 'offline_spent_inputs', 'till_events', 'withdrawals']);
    expect(dump(db, 'journal')).toEqual([{ id: 'sale:a', kind: 'sale', gen: 3, body: '{}', written_at: 5 }]);
    expect(disk.drivers[1].log.slice(-UPGRADES[1].length - 2)).toEqual([SQL.begin, ...UPGRADES[1], SQL.commit]);
  });

  it('upgrades layout 8 without changing receipts, funds or recovery settings', async () => {
    const disk = fakeDisk();
    const { driver } = await openDatabase(disk.opener, '/d', 'a.db', KEY);
    await createSchema(driver);
    const db = disk.files.get('/d/a.db')!.db;
    db.exec("DROP TABLE lightning_sales; PRAGMA user_version = 8; UPDATE backup_control SET verified_at = 123 WHERE id=1");
    await driver.run(SQL.keepInsert, ['original','https://mint.test','https://mint.test/','sat',12,'cashu-test','{}',1]);
    const rowsOf = (name: string) => db.prepare('SELECT * FROM ' + name).all();
    const before = tables(db).map(name => [name, rowsOf(name)] as const);
    await upgradeSchema(driver, 8);
    for (const [name, rows] of before) expect(rowsOf(name)).toEqual(rows);
    expect(version(db)).toBe(9);
    expect(dump(db, 'lightning_sales')).toEqual([]);
  });

  it('upgrades layout 2 with an existing kept delivery still available', async () => {
    const { again, db } = await layout1();
    await again.driver.run(ARCHIVE_TABLE);
    await again.driver.run('PRAGMA user_version = 2');
    await again.driver.run(
      "INSERT INTO kept VALUES ('old','https://mint.test','https://mint.test/','sat',7,'cashuBexample','{}',42)",
    );
    await upgradeSchema(again.driver, 2);
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect((await again.driver.run(SQL.keepTotals)).rows).toEqual([
      { mint: 'https://mint.test/', unit: 'sat', amount: 7, n: 1 },
    ]);
  });


  it('upgrades the installed build 11 without changing the original sweep settings or available balance', async () => {
    const { again, db } = await layout1();
    await upgradeSchema(again.driver, 1);
    db.exec('DROP TABLE lightning_sales; DROP TABLE backup_imported_payments; DROP TABLE backup_control; DROP TABLE card_topups; DROP TABLE offline_archive_cursor; DROP TABLE offline_spent_inputs; DROP TABLE offline_kits; PRAGMA user_version = 5');
    await again.driver.run("INSERT INTO lightning_sweeps (mint,address,threshold,max_fee) VALUES (?,?,?,?)",
      ['https://mint.test', 'merchant@example.test', 100, 4]);
    await again.driver.run("INSERT INTO kept VALUES (?,?,?,?,?,?,?,?,?)",
      ['old', 'https://mint.test', 'https://mint.test/', 'sat', 12, 'test-only', '{}', 42, null]);
    const fields = ['kept','journal','lightning_sweeps','lightning_payouts'] as const;
    const before = fields.map(t => dump(db, t));
    await upgradeSchema(again.driver, 5, ['https://mint.test']);
    expect(fields.map(t => dump(db, t))).toEqual(before);
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(dump(db, 'offline_kits')).toEqual([{ mint: 'https://mint.test', body: 'null' }]);
    expect(dump(db, 'card_topups')).toEqual([]);
  });

  it('an upgrade that fails part way changes nothing', async () => {
    const { disk, again, db } = await layout1();
    disk.drivers[1].failOn('PRAGMA user_version = ' + SCHEMA_VERSION, 'disk full');
    await expect(upgradeSchema(again.driver, 1)).rejects.toBeInstanceOf(LayoutError);
    expect(version(db)).toBe(1);
    expect(tables(db)).toEqual(['journal', 'kept', 'till_events']);
    expect(dump(db, 'journal')).toHaveLength(1);
    expect(disk.drivers[1].log[disk.drivers[1].log.length - 1]).toBe(SQL.rollback);
  });

  it('there is no upgrade from layout 0 or from the current layout', async () => {
    const disk = fakeDisk();
    const { driver } = await openDatabase(disk.opener, '/d', 'a.db', KEY);
    await expect(upgradeSchema(driver, 0)).rejects.toBeInstanceOf(LayoutError);
    await expect(upgradeSchema(driver, SCHEMA_VERSION)).rejects.toBeInstanceOf(LayoutError);
    expect(tables(disk.files.get('/d/a.db')!.db)).toEqual([]);
  });

  it('a till of layout 1 opens on the current layout, its record kept, and the upgrade is noted', async () => {
    const f = fakeStoreDeps();
    const first = await openIt(f);
    if (first.kind !== 'ready') {
      throw new Error(first.kind);
    }
    await first.value.receive({ id: 'a', sats: 14, invoice: INVOICE_14 });
    const rows = dump(f.disk.files.get(PATH)!.db, 'journal').map((r) => r.id);
    await first.store.close();
    const db = f.disk.files.get(PATH)!.db;
    db.exec('DROP TABLE lightning_sales; DROP TABLE backup_imported_payments; DROP TABLE backup_control; DROP TABLE card_topups; DROP TABLE offline_archive_cursor; DROP TABLE offline_spent_inputs; DROP TABLE offline_kits; DROP TABLE lightning_checkpoint; DROP TABLE lightning_sweeps; DROP TABLE lightning_payouts; DROP TABLE archive; DROP TABLE withdrawals; DROP TABLE extra_handoffs; DROP INDEX kept_withdrawal; ALTER TABLE kept DROP COLUMN withdrawal');
    db.exec('PRAGMA user_version = 1');
    const out = await openIt(f);
    expect(out.kind).toBe('ready');
    if (out.kind !== 'ready') {
      throw new Error(out.kind);
    }
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(tables(db)).toEqual(['archive', 'backup_control', 'backup_imported_payments', 'card_topups', 'extra_handoffs', 'journal', 'kept', 'lightning_checkpoint', 'lightning_payouts', 'lightning_sales', 'lightning_sweeps', 'offline_archive_cursor', 'offline_kits', 'offline_spent_inputs', 'till_events', 'withdrawals']);
    for (const id of rows) {
      expect(dump(db, 'journal').map((r) => r.id)).toContain(id);
    }
    expect((await out.store.events.list()).map((e) => e.kind)).toEqual(['created', 'layout-upgraded']);
    await out.store.close();
  });

  it('a till whose layout cannot be brought up to date is refused, its file left at layout 1', async () => {
    const f = fakeStoreDeps();
    const first = await openIt(f);
    if (first.kind !== 'ready') {
      throw new Error(first.kind);
    }
    await first.value.receive({ id: 'a', sats: 14, invoice: INVOICE_14 });
    await first.store.close();
    const db = f.disk.files.get(PATH)!.db;
    const rows = dump(db, 'journal');
    // layout 1 by its version, with an archive table in the way: the upgrade's CREATE TABLE fails
    db.exec('PRAGMA user_version = 1');
    const out = await openIt(f);
    expect(out.kind).toBe('store-refused');
    expect(version(db)).toBe(1);
    expect(dump(db, 'journal')).toEqual(rows);
  });
});
