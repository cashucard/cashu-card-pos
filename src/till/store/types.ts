/* The journal store's seams (slice 0.3). Everything native sits behind four interfaces: the SQLCipher database
 * (SqlOpener, SqlDriver), the platform's secure store (SecureStore) and the files (StoreFiles). The real ones are in
 * native.ts; the tests use fakes over node:sqlite and memory. */

/** A value SQLite takes or gives back. No blobs: rows are JSON text. */
export type SqlValue = string | number | null;

export interface SqlResult {
  /** the rows a SELECT or a PRAGMA answers, by column name; [] for other statements */
  rows: Array<Record<string, SqlValue>>;
  /** rows changed by an INSERT, UPDATE or DELETE (sqlite3_changes); 0 otherwise */
  rowsAffected: number;
}

/** One open database connection. */
export interface SqlDriver {
  /** Run one statement with its parameters. Resolves after SQLite has finished it: for a write in autocommit mode, after
   * its commit, with the connection's sync settings. Rejects with SQLite's error. */
  run(sql: string, params?: readonly SqlValue[]): Promise<SqlResult>;
  close(): Promise<void>;
}

export interface SqlOpener {
  /** Open the SQLCipher database `file` in the directory `dir` (an absolute path), creating it when absent, keyed with
   * the raw 32-byte key given as 64 hex characters. A wrong key is not seen here: SQLCipher refuses at the first read. */
  open(dir: string, file: string, keyHex: string): Promise<SqlDriver>;
}

/** The Keychain (iOS) or the Keystore-backed store (Android). Every item is this device only and readable after the
 * first unlock. */
export interface SecureStore {
  /** the item's value; null only when no item of that name exists; rejects when the store cannot be read */
  get(name: string): Promise<string | null>;
  /** write (or replace) the item; rejects when it was not stored */
  set(name: string, value: string): Promise<void>;
  /** remove the item; resolves when it is absent (development tools only) */
  remove(name: string): Promise<void>;
}

export interface StoreFiles {
  /** the directory `name` for a store's files: made when absent, excluded from OS backup; its absolute path */
  dir(name: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** exclude an existing file from OS backup; false when the file does not exist */
  exclude(path: string): Promise<boolean>;
  /** whether the file or directory is excluded from OS backup; false when it does not exist */
  excluded(path: string): Promise<boolean>;
  /** rename a file; rejects when `to` exists or `from` does not */
  move(from: string, to: string): Promise<void>;
  /** remove a file whose name starts with `lab-` (development tools only; refused for any other name); resolves when
   * absent */
  removeLab(path: string): Promise<void>;
}

/** What a store needs from the device. */
export interface StoreDeps {
  files: StoreFiles;
  secure: SecureStore;
  opener: SqlOpener;
  /** n random bytes from the platform's secure generator */
  randomBytes: (n: number) => Uint8Array;
  /** Device implementation of the fixed Cashu POS backup scrypt parameters. */
  deriveBackupKey?: (password: Uint8Array, salt: Uint8Array) => Promise<Uint8Array>;
  /** the wall clock, ms */
  now: () => number;
  log: (line: string) => void;
}

/** Where one store lives: its directory, its database file, and its three secure-store items. */
export interface StoreNames {
  dir: string;
  file: string;
  key: string;
  genA: string;
  genB: string;
}

/** The till's own store. */
export const TILL_NAMES: StoreNames = {
  dir: 'till',
  file: 'till.db',
  key: 'org.cashucard.pos.till.key',
  genA: 'org.cashucard.pos.till.gen.a',
  genB: 'org.cashucard.pos.till.gen.b',
};

/** A development store (the lab, the self-test over the real journal): its own directory, a file named lab-*, its own
 * three items. Never the till's own. */
export function labNames(name: string): StoreNames {
  if (!/^[a-z0-9]{1,16}$/.test(name)) {
    throw new Error('a lab store name is 1 to 16 of a-z 0-9');
  }
  const item = 'org.cashucard.pos.lab.' + name;
  return { dir: 'lab', file: 'lab-' + name + '.db', key: item + '.key', genA: item + '.gen.a', genB: item + '.gen.b' };
}

/** SQLite's files beside a database: the write-ahead log, its index, and a rollback journal. */
export const SIDECARS: readonly string[] = ['-wal', '-shm', '-journal'];
