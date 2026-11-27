import { ENABLE_OFFLINE_MINT } from './offline-schema';
import { SCHEMA, SCHEMA_VERSION, SQL, UPGRADES } from './sql';
import type { SqlDriver, SqlOpener, SqlValue } from './types';

/** WAL for the till; DELETE only to measure against it. */
export type Durability = 'wal' | 'delete';

/** `msg(e)`: what an error says, in one line. */
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class DbOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbOpenError';
    Object.setPrototypeOf(this, DbOpenError.prototype);
  }
}

/** SQLite's own words for code 26 (SQLITE_NOTADB): what SQLCipher answers at the first read of a file made with another
 * key, or of a file whose header is damaged. op-sqlite passes the words on in its error's message. */
export function isNotADatabase(e: unknown): boolean {
  return /file is not a database/i.test(msg(e));
}

/** A call on a store after its close. */
export class StoreClosedError extends Error {
  constructor() {
    super('the store is closed');
    this.name = 'StoreClosedError';
    Object.setPrototypeOf(this, StoreClosedError.prototype);
  }
}

export class NotEncryptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotEncryptedError';
    Object.setPrototypeOf(this, NotEncryptedError.prototype);
  }
}

export class WrongKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WrongKeyError';
    Object.setPrototypeOf(this, WrongKeyError.prototype);
  }
}

export class DurabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurabilityError';
    Object.setPrototypeOf(this, DurabilityError.prototype);
  }
}

export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutError';
    Object.setPrototypeOf(this, LayoutError.prototype);
  }
}

export class NewerFormatError extends Error {
  readonly version: number;
  constructor(version: number) {
    super('the file has layout version ' + version + '; this app reads ' + SCHEMA_VERSION);
    this.name = 'NewerFormatError';
    this.version = version;
    Object.setPrototypeOf(this, NewerFormatError.prototype);
  }
}

export interface OpenDb {
  driver: SqlDriver;
  /** SQLCipher's version, as it answered */
  cipherVersion: string;
  /** PRAGMA user_version as found: 0 for a file with nothing in it yet */
  version: number;
}

/** The first row's value in `column`, or undefined when there is no row. */
export function firstValue(
  rows: ReadonlyArray<Record<string, SqlValue>>,
  column: string,
): SqlValue | undefined {
  return rows.length > 0 ? rows[0][column] : undefined;
}

export async function openDatabase(
  opener: SqlOpener,
  dir: string,
  file: string,
  keyHex: string,
  durability: Durability = 'wal',
): Promise<OpenDb> {
  let driver: SqlDriver;
  try {
    driver = await opener.open(dir, file, keyHex);
  } catch (e) {
    throw new DbOpenError('the database could not be opened: ' + msg(e));
  }
  try {
    const cv = firstValue((await driver.run(SQL.cipherVersion)).rows, 'cipher_version');
    if (typeof cv !== 'string' || cv === '') {
      throw new NotEncryptedError('SQLCipher is not in this build: PRAGMA cipher_version answered nothing');
    }
    let n: number;
    try {
      n = Number(firstValue((await driver.run(SQL.keyCheck)).rows, 'n'));
    } catch (e) {
      if (isNotADatabase(e)) {
        throw new WrongKeyError('the file does not open with this key: ' + msg(e));
      }
      throw new DbOpenError('the file could not be read: ' + msg(e));
    }
    const mode = firstValue(
      (await driver.run(durability === 'wal' ? SQL.journalModeWal : SQL.journalModeDelete)).rows,
      'journal_mode',
    );
    if (String(mode).toLowerCase() !== durability) {
      throw new DurabilityError('journal_mode is ' + String(mode) + ', not ' + durability);
    }
    await driver.run(SQL.synchronousFull);
    await driver.run(SQL.fullfsyncOn);
    await driver.run(SQL.checkpointFullfsyncOn);
    const sync = Number(firstValue((await driver.run(SQL.synchronous)).rows, 'synchronous'));
    if (sync !== 2) {
      throw new DurabilityError('synchronous is ' + sync + ', not 2 (FULL)');
    }
    const ff = Number(firstValue((await driver.run(SQL.fullfsync)).rows, 'fullfsync'));
    if (ff !== 1) {
      throw new DurabilityError('fullfsync is ' + ff + ', not 1');
    }
    const v = Number(firstValue((await driver.run(SQL.userVersion)).rows, 'user_version'));
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new LayoutError('the layout version cannot be read');
    }
    if (v > SCHEMA_VERSION) {
      throw new NewerFormatError(v);
    }
    if (v === 0 && n > 0) {
      throw new LayoutError('the file has tables but no layout version');
    }
    return { driver, cipherVersion: cv, version: v };
  } catch (e) {
    await driver.close().catch(() => undefined);
    throw e;
  }
}

export async function createSchema(driver: SqlDriver): Promise<void> {
  await driver.run(SQL.begin);
  try {
    for (const s of SCHEMA) {
      await driver.run(s);
    }
    await driver.run(SQL.commit);
  } catch (e) {
    await driver.run(SQL.rollback).catch(() => undefined);
    throw new LayoutError('the schema could not be made: ' + msg(e));
  }
}

/** Brings a file of layout `from` up to SCHEMA_VERSION (UPGRADES), in one transaction: on any failure the transaction is
 * rolled back, nothing is changed, and LayoutError is thrown. A layout with no upgrade is a LayoutError too. */
export async function upgradeSchema(driver: SqlDriver, from: number, acceptedMints: readonly string[] = []): Promise<void> {
  const steps = UPGRADES[from];
  if (steps === undefined) {
    throw new LayoutError('there is no upgrade from layout version ' + from);
  }
  try {
    await driver.run(SQL.begin);
    for (const s of steps) {
      await driver.run(s);
    }
    // Earlier than layout 6, no merchant could opt out. Seed only that upgrade and
    // let the existing restore path disarm these rows if the wallet was rolled back.
    if (from < 6) {
      for (const mint of acceptedMints) await driver.run(ENABLE_OFFLINE_MINT, [mint]);
    }
    await driver.run(SQL.commit);
  } catch (e) {
    await driver.run(SQL.rollback).catch(() => undefined);
    throw new LayoutError('the layout could not be brought up to date: ' + msg(e));
  }
}

/** Runs each function given after the one before it has settled, one at a time, in the order given. */
export type Serial = <T>(f: () => Promise<T>) => Promise<T>;

export function createSerial(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(f: () => Promise<T>): Promise<T> => {
    const next = tail.then(() => f());
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

/** One open database's queue and its close: the close runs after every call queued before it, closes the database once,
 * and every call queued after it rejects with StoreClosedError without reaching the database. */
export interface Gate {
  serial: Serial;
  close(): Promise<void>;
}

export function createGate(driver: SqlDriver): Gate {
  const base = createSerial();
  let closed = false;
  return {
    serial: <T>(f: () => Promise<T>): Promise<T> =>
      base(() => (closed ? Promise.reject(new StoreClosedError()) : f())),
    close: () =>
      base(async () => {
        if (closed) {
          return;
        }
        closed = true;
        await driver.close();
      }),
  };
}
