// The archive's layout (slice 2.3 review): the body is the archive's last column, and the takings are read from an
// index alone, never from the rows, in a new record and in a record brought up from layout 1. No read of the archive,
// nor the journal's count and written-at reads, names the body.
import { createSchema, openDatabase, upgradeSchema } from '../src/till/store/db';
import { SQL } from '../src/till/store/sql';
import { fakeDisk, type NodeDb } from './helpers/fake-sql';

const KEY = 'ab'.repeat(32);

/** Layout 1, as slice 0.3 made it. */
const LAYOUT_1 = [
  'CREATE TABLE journal (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, gen INTEGER NOT NULL, body TEXT NOT NULL, written_at INTEGER NOT NULL)',
  'CREATE TABLE kept (id TEXT PRIMARY KEY NOT NULL, mint TEXT NOT NULL, mint_norm TEXT NOT NULL, unit TEXT NOT NULL, amount INTEGER NOT NULL, token TEXT NOT NULL, body TEXT NOT NULL, kept_at INTEGER NOT NULL)',
  'CREATE TABLE till_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)',
  'PRAGMA user_version = 1',
];

const COLUMNS = [
  'id',
  'kind',
  'gen',
  'written_at',
  'archived_at',
  'sale',
  'state',
  'extra',
  'at',
  'amount',
  'fee',
  'mint',
  'unit',
  'body',
];

function columns(db: NodeDb): string[] {
  return db
    .prepare('PRAGMA table_info(archive)')
    .all()
    .map((r) => String(r.name));
}

/** SQLite's plan for the takings: one line per step. */
function takingsPlan(db: NodeDb): string[] {
  return db
    .prepare('EXPLAIN QUERY PLAN ' + SQL.archiveTakings)
    .all(0, 1)
    .map((r) => String(r.detail));
}

async function fresh(): Promise<NodeDb> {
  const disk = fakeDisk();
  const { driver } = await openDatabase(disk.opener, '/d', 'a.db', KEY);
  await createSchema(driver);
  return disk.files.get('/d/a.db')!.db;
}

async function upgraded(): Promise<NodeDb> {
  const disk = fakeDisk();
  const first = await openDatabase(disk.opener, '/d', 'a.db', KEY);
  for (const s of LAYOUT_1) {
    await first.driver.run(s);
  }
  const again = await openDatabase(disk.opener, '/d', 'a.db', KEY);
  await upgradeSchema(again.driver, 1);
  return disk.files.get('/d/a.db')!.db;
}

describe('the archive layout', () => {
  it('a new record keeps the body last and reads the takings from an index alone', async () => {
    const db = await fresh();
    expect(columns(db)).toEqual(COLUMNS);
    const plan = takingsPlan(db);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatch(/^SEARCH archive USING COVERING INDEX /);
  });

  it('a record brought up from layout 1 has the same archive', async () => {
    const db = await upgraded();
    expect(columns(db)).toEqual(COLUMNS);
    const plan = takingsPlan(db);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatch(/^SEARCH archive USING COVERING INDEX /);
  });

  it('the takings read through the index count each payment once', async () => {
    const db = await fresh();
    const ins = db.prepare(SQL.archiveInsert);
    for (let i = 0; i < 30; i += 1) {
      const state = i % 3 === 0 ? 'delivered' : i % 3 === 1 ? 'exported' : 'gone';
      ins.run('pay:' + i, 'payment', i, '{}', i, i, 's' + i, state, i === 4 ? 'paid-twice' : null, 1000 + i, 14, 1, 'https://mint.test', 'sat');
    }
    ins.run('fx-1', 'delivery', 99, '{}', 99, 99, null, 'delivered', null, 1001, null, null, null, null);
    const r = db.prepare(SQL.archiveTakings).all(0, 5000)[0];
    expect({ n: Number(r.n), sats: Number(r.sats) }).toEqual({ n: 19, sats: 19 * 14 });
  });

  it('no read of the archive, nor the journal count or written-at read, names the body', () => {
    for (const s of [SQL.archiveTakings, SQL.archiveHas, SQL.archivePayments, SQL.journalCount, SQL.journalWritten]) {
      expect(s).not.toMatch(/\bbody\b/);
    }
  });
});
