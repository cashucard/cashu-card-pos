/* A SQLite for tests: Node's node:sqlite in memory, behind the store's SqlDriver, with what SQLCipher and the phone add
 * scripted: the cipher version, the sync settings, one key per file, statements held until released, and failures. */
import type { SqlDriver, SqlOpener, SqlResult, SqlValue } from '../../src/till/store/types';

export interface NodeStatement {
  all(...params: SqlValue[]): Array<Record<string, SqlValue>>;
  run(...params: SqlValue[]): { changes: number | bigint };
}
export interface NodeDb {
  prepare(sql: string): NodeStatement;
  exec(sql: string): void;
}
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => NodeDb };

/** A new empty database in memory. */
export function memoryDb(): NodeDb {
  return new DatabaseSync(':memory:');
}

export interface FakeDriverOptions {
  /** what PRAGMA cipher_version answers; '' answers no row; default '4.6.1 community' */
  cipherVersion?: string;
  /** what PRAGMA journal_mode = X answers; default X in lower case */
  journalMode?: string;
  /** what PRAGMA synchronous answers; default 2 */
  synchronous?: number;
  /** what PRAGMA fullfsync answers; default 1 */
  fullfsync?: number;
  /** the file was made with another key: every statement but PRAGMA cipher_version throws 'file is not a database' */
  wrongKey?: boolean;
}

export interface FakeDriver extends SqlDriver {
  readonly db: NodeDb;
  /** every statement run, in order, as given */
  readonly log: string[];
  /** statements running now, and the most that ever ran at once */
  running: number;
  most: number;
  closed: boolean;
  /** the next statement whose text includes `part` waits, after it is logged, until the returned function is called */
  hold(part: string): () => void;
  /** every statement whose text includes `part` throws new Error(message), until clearFailures() */
  failOn(part: string, message: string): void;
  clearFailures(): void;
}

interface Hold {
  part: string;
  gate: Promise<void>;
  release: () => void;
  claimed: boolean;
}

interface Failure {
  part: string;
  message: string;
}

export function fakeDriver(db: NodeDb, o: FakeDriverOptions = {}): FakeDriver {
  const log: string[] = [];
  const holds: Hold[] = [];
  const failures: Failure[] = [];
  const d: FakeDriver = {
    db,
    log,
    running: 0,
    most: 0,
    closed: false,
    async run(sql: string, params: readonly SqlValue[] = []): Promise<SqlResult> {
      if (d.closed) {
        throw new Error('the database is closed');
      }
      log.push(sql);
      d.running += 1;
      d.most = Math.max(d.most, d.running);
      try {
        const hold = holds.find((h) => !h.claimed && sql.includes(h.part));
        if (hold) {
          hold.claimed = true;
          await hold.gate;
        }
        const failure = failures.find((f) => sql.includes(f.part));
        if (failure) {
          throw new Error(failure.message);
        }
        if (o.wrongKey && sql !== 'PRAGMA cipher_version') {
          throw new Error('file is not a database');
        }
        const cipher = /^PRAGMA cipher_version$/i.exec(sql);
        if (cipher) {
          const version = o.cipherVersion ?? '4.6.1 community';
          return version === ''
            ? { rows: [], rowsAffected: 0 }
            : { rows: [{ cipher_version: version }], rowsAffected: 0 };
        }
        const mode = /^PRAGMA journal_mode = (\w+)$/i.exec(sql);
        if (mode) {
          return { rows: [{ journal_mode: o.journalMode ?? mode[1].toLowerCase() }], rowsAffected: 0 };
        }
        if (/^PRAGMA (synchronous|fullfsync|checkpoint_fullfsync) = \w+$/i.test(sql)) {
          return { rows: [], rowsAffected: 0 };
        }
        if (/^PRAGMA synchronous$/i.test(sql)) {
          return { rows: [{ synchronous: o.synchronous ?? 2 }], rowsAffected: 0 };
        }
        if (/^PRAGMA fullfsync$/i.test(sql)) {
          return { rows: [{ fullfsync: o.fullfsync ?? 1 }], rowsAffected: 0 };
        }
        const st = db.prepare(sql);
        if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
          return { rows: st.all(...params).map((r) => ({ ...r })), rowsAffected: 0 };
        }
        const r = st.run(...params);
        return { rows: [], rowsAffected: Number(r.changes) };
      } finally {
        d.running -= 1;
      }
    },
    async close(): Promise<void> {
      d.closed = true;
    },
    hold(part: string): () => void {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.push({ part, gate, release, claimed: false });
      return release;
    },
    failOn(part: string, message: string): void {
      failures.push({ part, message });
    },
    clearFailures(): void {
      failures.length = 0;
    },
  };
  return d;
}

export interface DiskFile {
  db: NodeDb;
  /** the key the file was made with */
  key: string;
}
export interface FakeDisk {
  readonly opener: SqlOpener;
  /** the files by absolute path, dir + '/' + file */
  readonly files: Map<string, DiskFile>;
  /** every driver the opener made, in order */
  readonly drivers: FakeDriver[];
  /** the options every driver made from now on gets */
  options: FakeDriverOptions;
  /** when not null, open throws new Error(openFails) */
  openFails: string | null;
}

export function fakeDisk(o: FakeDriverOptions = {}): FakeDisk {
  const files = new Map<string, DiskFile>();
  const drivers: FakeDriver[] = [];
  const disk: FakeDisk = {
    opener: {
      async open(dir: string, file: string, key: string): Promise<SqlDriver> {
        if (disk.openFails !== null) {
          throw new Error(disk.openFails);
        }
        const path = dir + '/' + file;
        let entry = files.get(path);
        if (!entry) {
          entry = { db: memoryDb(), key };
          files.set(path, entry);
        }
        const driver = fakeDriver(entry.db, { ...disk.options, wrongKey: entry.key !== key });
        drivers.push(driver);
        return driver;
      },
    },
    files,
    drivers,
    options: o,
    openFails: null,
  };
  return disk;
}

/** Every row of `table`, in rowid order, as plain objects. */
export function dump(db: NodeDb, table: string): Array<Record<string, SqlValue>> {
  if (!/^[a-z_]+$/.test(table)) {
    throw new Error('not a table name: ' + table);
  }
  return db
    .prepare('SELECT * FROM ' + table + ' ORDER BY rowid')
    .all()
    .map((r) => ({ ...r }));
}

/** Replace every row of `table` with `rows`, inserted in order. */
export function restore(
  db: NodeDb,
  table: string,
  rows: ReadonlyArray<Record<string, SqlValue>>,
): void {
  if (!/^[a-z_]+$/.test(table)) {
    throw new Error('not a table name: ' + table);
  }
  db.exec('DELETE FROM ' + table);
  for (const row of rows) {
    const cols = Object.keys(row);
    db.prepare(
      'INSERT INTO ' +
        table +
        ' (' +
        cols.join(', ') +
        ') VALUES (' +
        cols.map(() => '?').join(', ') +
        ')',
    ).run(...cols.map((c) => row[c]));
  }
}
