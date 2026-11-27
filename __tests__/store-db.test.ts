// The store's database rules (slice 0.3): what the opener asks for, in what order, what it refuses, and the serial queue.
import {
  createGate,
  createSchema,
  createSerial,
  DbOpenError,
  DurabilityError,
  LayoutError,
  NewerFormatError,
  NotEncryptedError,
  isNotADatabase,
  openDatabase,
  StoreClosedError,
  WrongKeyError,
} from '../src/till/store/db';
import { SCHEMA, SCHEMA_VERSION, SQL } from '../src/till/store/sql';
import { dump, fakeDisk, fakeDriver, memoryDb } from './helpers/fake-sql';

const KEY = 'ab'.repeat(32);
const KEY2 = 'cd'.repeat(32);
const OPENING = [
  SQL.cipherVersion,
  SQL.keyCheck,
  SQL.journalModeWal,
  SQL.synchronousFull,
  SQL.fullfsyncOn,
  SQL.checkpointFullfsyncOn,
  SQL.synchronous,
  SQL.fullfsync,
  SQL.userVersion,
];

/** Run `f` and answer what it rejected with, or fail when it resolved. */
async function caught(f: () => Promise<unknown>): Promise<unknown> {
  try {
    await f();
  } catch (e) {
    return e;
  }
  throw new Error('it resolved; expected a rejection');
}

describe('the till store database', () => {
  it('a new file opens, with every setting read back', async () => {
    const disk = fakeDisk();
    const r = await openDatabase(disk.opener, '/d', 'a.db', KEY);
    expect(r.version).toBe(0);
    expect(r.cipherVersion).toBe('4.6.1 community');
    expect(disk.drivers[0].log).toEqual(OPENING);
    expect(disk.files.has('/d/a.db')).toBe(true);
  });

  it('delete mode asks for DELETE', async () => {
    const disk = fakeDisk();
    await openDatabase(disk.opener, '/d', 'a.db', KEY, 'delete');
    expect(disk.drivers[0].log[2]).toBe(SQL.journalModeDelete);
  });

  it('a build without SQLCipher is refused', async () => {
    const disk = fakeDisk({ cipherVersion: '' });
    await expect(openDatabase(disk.opener, '/d', 'a.db', KEY)).rejects.toBeInstanceOf(NotEncryptedError);
    expect(disk.drivers[0].closed).toBe(true);
    expect(disk.drivers[0].log).toEqual([SQL.cipherVersion]);
  });

  it('another key is refused as a wrong key', async () => {
    const disk = fakeDisk();
    await openDatabase(disk.opener, '/d', 'a.db', KEY);
    const err = await caught(() => openDatabase(disk.opener, '/d', 'a.db', KEY2));
    expect(err).toBeInstanceOf(WrongKeyError);
    expect((err as Error).message).toMatch(/file is not a database/);
    expect(disk.drivers[1].closed).toBe(true);
    expect(disk.drivers[1].log).toEqual([SQL.cipherVersion, SQL.keyCheck]);
  });

  it('a journal mode that does not take is refused', async () => {
    const disk = fakeDisk({ journalMode: 'memory' });
    const err = await caught(() => openDatabase(disk.opener, '/d', 'a.db', KEY));
    expect(err).toBeInstanceOf(DurabilityError);
    expect((err as Error).message).toMatch(/journal_mode is memory, not wal/);
    expect(disk.drivers[0].closed).toBe(true);
  });

  it('synchronous other than FULL is refused', async () => {
    const disk = fakeDisk({ synchronous: 1 });
    const err = await caught(() => openDatabase(disk.opener, '/d', 'a.db', KEY));
    expect(err).toBeInstanceOf(DurabilityError);
    expect((err as Error).message).toMatch(/synchronous is 1/);
  });

  it('fullfsync off is refused', async () => {
    const disk = fakeDisk({ fullfsync: 0 });
    const err = await caught(() => openDatabase(disk.opener, '/d', 'a.db', KEY));
    expect(err).toBeInstanceOf(DurabilityError);
    expect((err as Error).message).toMatch(/fullfsync is 0/);
  });

  it('an opener that throws is a DbOpenError', async () => {
    const disk = fakeDisk();
    disk.openFails = 'disk full';
    const err = await caught(() => openDatabase(disk.opener, '/d', 'a.db', KEY));
    expect(err).toBeInstanceOf(DbOpenError);
    expect((err as Error).message).toMatch(/disk full/);
  });

  it('createSchema makes the tables in one transaction and sets the version', async () => {
    const disk = fakeDisk();
    const r = await openDatabase(disk.opener, '/d', 'a.db', KEY);
    await createSchema(r.driver);
    expect(disk.drivers[0].log.slice(OPENING.length)).toEqual([SQL.begin, ...SCHEMA, SQL.commit]);
    const again = await openDatabase(disk.opener, '/d', 'a.db', KEY);
    expect(again.version).toBe(SCHEMA_VERSION);
    expect(dump(disk.files.get('/d/a.db')!.db, 'journal')).toEqual([]);
  });

  it('a schema that fails half way is rolled back', async () => {
    const disk = fakeDisk();
    const r = await openDatabase(disk.opener, '/d', 'a.db', KEY);
    const driver = disk.drivers[0];
    driver.failOn('CREATE TABLE kept', 'boom');
    const err = await caught(() => createSchema(r.driver));
    expect(err).toBeInstanceOf(LayoutError);
    expect((err as Error).message).toMatch(/boom/);
    expect(driver.log[driver.log.length - 1]).toBe(SQL.rollback);
    expect(
      disk.files
        .get('/d/a.db')!
        .db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all(),
    ).toEqual([]);
    const again = await openDatabase(disk.opener, '/d', 'a.db', KEY);
    expect(again.version).toBe(0);
  });

  it('a newer layout is refused', async () => {
    const disk = fakeDisk();
    await openDatabase(disk.opener, '/d', 'a.db', KEY);
    disk.files.get('/d/a.db')!.db.exec('PRAGMA user_version = ' + (SCHEMA_VERSION + 1));
    const err = await caught(() => openDatabase(disk.opener, '/d', 'a.db', KEY));
    expect(err).toBeInstanceOf(NewerFormatError);
    expect((err as NewerFormatError).version).toBe(SCHEMA_VERSION + 1);
    expect(disk.drivers[1].closed).toBe(true);
  });

  it('tables without a layout version are refused', async () => {
    const disk = fakeDisk();
    await openDatabase(disk.opener, '/d', 'a.db', KEY);
    disk.files.get('/d/a.db')!.db.exec('CREATE TABLE x (a TEXT)');
    const err = await caught(() => openDatabase(disk.opener, '/d', 'a.db', KEY));
    expect(err).toBeInstanceOf(LayoutError);
    expect((err as Error).message).toMatch(/no layout version/);
  });

  it('the fake holds a statement until it is released', async () => {
    const d = fakeDriver(memoryDb());
    const release = d.hold('SELECT 1');
    let settled = false;
    const p = d.run('SELECT 1 AS x');
    void p.then(() => {
      settled = true;
    });
    await new Promise<void>((r) => setTimeout(() => r(), 10));
    expect(settled).toBe(false);
    expect(d.running).toBe(1);
    release();
    const r = await p;
    expect(r.rows).toEqual([{ x: 1 }]);
    expect(d.running).toBe(0);
  });

  it('the serial queue runs one at a time, in order', async () => {
    const serial = createSerial();
    const seen: string[] = [];
    const runs = [1, 2, 3].map((i) =>
      serial(async () => {
        seen.push('s' + i);
        await new Promise<void>((r) => setTimeout(r, 5));
        seen.push('e' + i);
        return i;
      }),
    );
    expect(await Promise.all(runs)).toEqual([1, 2, 3]);
    expect(seen).toEqual(['s1', 'e1', 's2', 'e2', 's3', 'e3']);
  });

  it('a call that rejects does not stop the queue', async () => {
    const serial = createSerial();
    const first = serial(async () => {
      throw new Error('x');
    });
    const second = serial(async () => 2);
    await expect(first).rejects.toThrow(/x/);
    await expect(second).resolves.toBe(2);
  });

  it('a first read that fails for another reason is not a wrong key', async () => {
    const d = fakeDriver(memoryDb());
    d.failOn('sqlite_master', 'database is locked');
    const e = await caught(() => openDatabase({ open: async () => d }, '/d', 'a.db', KEY));
    expect(e).toBeInstanceOf(DbOpenError);
    expect(e).not.toBeInstanceOf(WrongKeyError);
    expect((e as Error).message).toBe('the file could not be read: database is locked');
    expect(d.closed).toBe(true);
    expect(d.log).toEqual([SQL.cipherVersion, SQL.keyCheck]);
  });

  it("only SQLite's words for code 26 tell a wrong key", () => {
    expect(isNotADatabase(new Error('[op-sqlite] sqlite query error: file is not a database'))).toBe(true);
    expect(isNotADatabase(new Error('file is not a database'))).toBe(true);
    expect(isNotADatabase('file is not a database')).toBe(true);
    expect(isNotADatabase(new Error('database is locked'))).toBe(false);
    expect(isNotADatabase(new Error('disk I/O error'))).toBe(false);
    expect(isNotADatabase(new Error('database or disk is full'))).toBe(false);
  });

  it('the gate closes after the calls queued before it, once, and refuses the calls after it', async () => {
    const d = fakeDriver(memoryDb());
    const closeSpy = jest.spyOn(d, 'close');
    const gate = createGate(d);
    const release = d.hold('SELECT 1');
    const before = gate.serial(() => d.run('SELECT 1 AS x'));
    const closing = gate.close();
    await new Promise<void>((r) => setTimeout(() => r(), 10));
    expect(d.closed).toBe(false);
    release();
    expect((await before).rows).toEqual([{ x: 1 }]);
    await closing;
    expect(d.closed).toBe(true);
    await expect(gate.serial(() => d.run('SELECT 1 AS x'))).rejects.toBeInstanceOf(StoreClosedError);
    await gate.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
