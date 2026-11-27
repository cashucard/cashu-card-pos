import { TillBackupStore } from './backup';
import { TILL_SETTINGS, type SettingsNames } from '../settings';
import { JournalRolledBackError } from 'cashucard';
import type { TwoSlotGenerationStore } from './secret';
import {
  createGate,
  createSchema,
  DbOpenError,
  LayoutError,
  NewerFormatError,
  openDatabase,
  upgradeSchema,
  WrongKeyError,
  type Durability,
  type OpenDb,
} from './db';
import { SqliteJournal } from './journal';
import { SCHEMA_VERSION, SQL } from './sql';
import {
  createKey,
  generationStore,
  KeyNotKeptError,
  markFirstRun,
  readKey,
  SecretUnreadableError,
} from './secret';
import { TillEvents, type TillEventKind } from './events';
import { KeepStore } from './keep-store';
import { WalletStore } from './wallet';
import { OfflineSettingsStore } from './offline';
import { LightningSaleStore } from './lightning-sales';
import { TopupStore } from './topups';
import { LightningStore } from './lightning';
import { checkpointItem, lightningCheckpoint } from './lightning-checkpoint';
import { ArchiveReader } from './archive';
import { SIDECARS, type SqlDriver, type StoreDeps, type StoreNames } from './types';

/** The merchant's choice for one open: it acts only on the state it is for. */
export type StoreChoice = 'start-new' | 'use-older' | 'set-aside';

export interface OpenStore {
  names: StoreNames;
  /** the directory's absolute path, and the database file's */
  dir: string;
  path: string;
  driver: SqlDriver;
  cipherVersion: string;
  journal: SqliteJournal;
  generation: TwoSlotGenerationStore;
  keep: KeepStore;
  backups: TillBackupStore;
  wallet: WalletStore;
  lightning: LightningStore;
  topups: TopupStore;
  lightningSales: LightningSaleStore;
  offline: OfflineSettingsStore;
  events: TillEvents;
  /** the archive's reads (slice 2.3) */
  archive: ArchiveReader;
  close(): Promise<void>;
}

export type StoreOutcome<T> =
  | { kind: 'ready'; value: T; store: OpenStore; firstRun: boolean }
  | { kind: 'journal-missing'; storedGeneration: number }
  | { kind: 'rolled-back'; journalGeneration: number; storedGeneration: number }
  | { kind: 'unreadable'; why: string }
  | { kind: 'key-missing' }
  | { kind: 'secure-store-unavailable'; why: string }
  | { kind: 'files-unavailable'; why: string }
  | { kind: 'newer-format'; version: number }
  | { kind: 'store-refused'; why: string }
  | { kind: 'open-failed'; why: string };

export interface OpenStoreOptions<T> {
  /** the merchant's choice for this one open; it acts only on the state it is for, and does nothing in any other */
  choice?: StoreChoice;
  /** Existing accepted mints, when upgrading from a version before offline sales. */
  acceptedMints?: readonly string[];
  settingsNames?: SettingsNames;
  /** default 'wal' */
  durability?: Durability;
  /** opens the library over the store; acceptRollback is true only where a choice or a carried-on generation needs it */
  start: (store: OpenStore, acceptRollback: boolean) => Promise<T>;
}

/** `msg(e)`: what an error says, in one line. */
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** An answer that ends the open with a named state. Thrown from the moment the database is open, so the catch closes it. */
class Stop {
  constructor(readonly outcome: StoreOutcome<never>) {}
}

/** A secure-store step: a failure of the device becomes an outcome. */
async function secureStep<R>(f: () => Promise<R>): Promise<R> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof SecretUnreadableError || e instanceof KeyNotKeptError) {
      throw new Stop({ kind: 'store-refused', why: msg(e) });
    }
    throw new Stop({ kind: 'secure-store-unavailable', why: msg(e) });
  }
}

/** A file step: a failure of the device becomes files-unavailable. */
async function fileStep<R>(f: () => Promise<R>): Promise<R> {
  try {
    return await f();
  } catch (e) {
    throw new Stop({ kind: 'files-unavailable', why: msg(e) });
  }
}

export async function openStore<T>(
  deps: StoreDeps,
  names: StoreNames,
  o: OpenStoreOptions<T>,
): Promise<StoreOutcome<T>> {
  let driver: SqlDriver | null = null;
  const notes: Array<[TillEventKind, string]> = [];
  try {
    // 1. the directory and the generation
    const dir = await fileStep(() => deps.files.dir(names.dir));
    const path = dir + '/' + names.file;
    const generation = generationStore(deps.secure, names);

    // 2. the key and the stored generation
    let key = await secureStep(() => readKey(deps.secure, names));
    const stored = await secureStep(() => generation.get());
    const had = stored !== null && stored >= 1;

    // 3. the file
    let present = await fileStep(() => deps.files.exists(path));
    let firstRun = false;
    let carry = false;
    let asideDone = false;

    // 4. keep the file (and its sidecars) under a new name: the sidecars first, so a stop part way leaves the file where
    // it was and the next open names the same state
    const setAside = async (suffix: string): Promise<string> => {
      for (const s of [...SIDECARS, '']) {
        const p = path + s;
        if (await fileStep(() => deps.files.exists(p))) {
          await fileStep(() => deps.files.move(p, p + suffix));
        }
      }
      return names.file + suffix;
    };

    // 5. a file with no key
    if (present && key === null) {
      if (o.choice !== 'set-aside') {
        return { kind: 'key-missing' };
      }
      const aside = await setAside('.set-aside-' + deps.now());
      notes.push(['set-aside', 'the file without its key was kept as ' + aside]);
      present = false;
      asideDone = true;
    }

    // 6. the file that is there
    let opened: OpenDb | null = null;
    if (present) {
      const k = key;
      if (k !== null) {
        try {
          opened = await openDatabase(deps.opener, dir, names.file, k, o.durability ?? 'wal');
        } catch (e) {
          if (e instanceof WrongKeyError) {
            if (o.choice !== 'set-aside') {
              return { kind: 'unreadable', why: msg(e) };
            }
            const aside = await setAside('.set-aside-' + deps.now());
            notes.push(['set-aside', 'the unreadable file was kept as ' + aside]);
            present = false;
            asideDone = true;
          } else if (e instanceof NewerFormatError) {
            return { kind: 'newer-format', version: e.version };
          } else if (e instanceof DbOpenError) {
            return { kind: 'open-failed', why: msg(e) };
          } else {
            return { kind: 'store-refused', why: msg(e) };
          }
        }
        if (opened !== null) {
          driver = opened.driver;
          // a record of an earlier layout: brought up to date before anything reads it, in one transaction
          if (opened.version !== 0 && opened.version < SCHEMA_VERSION) {
            try {
              await upgradeSchema(driver, opened.version, o.acceptedMints);
            } catch (e) {
              if (e instanceof LayoutError) {
                throw new Stop({ kind: 'store-refused', why: msg(e) });
              }
              throw e;
            }
            notes.push([
              'layout-upgraded',
              'the record was brought from layout ' + opened.version + ' to ' + SCHEMA_VERSION,
            ]);
          }
          if (opened.version === 0) {
            if (had && o.choice !== 'start-new') {
              throw new Stop({ kind: 'journal-missing', storedGeneration: stored as number });
            }
            try {
              await createSchema(driver);
            } catch (e) {
              if (e instanceof LayoutError) {
                throw new Stop({ kind: 'store-refused', why: msg(e) });
              }
              throw e;
            }
            firstRun = true;
            carry = had;
            if (had) {
              notes.push([
                'started-new-after-missing',
                'an empty file stood where a record was; generation ' + String(stored) + ' carried on',
              ]);
            }
          } else if (had) {
            // a file with its tables and not one row, the lease included: a new record the library never opened
            let empty: boolean;
            try {
              empty = (await driver.run(SQL.journalAny)).rows.length === 0;
            } catch (e) {
              throw new Stop({ kind: 'open-failed', why: msg(e) });
            }
            if (empty) {
              if (o.choice !== 'start-new') {
                throw new Stop({ kind: 'journal-missing', storedGeneration: stored as number });
              }
              firstRun = true;
              carry = true;
              notes.push([
                'started-new-after-missing',
                'an empty record stood where a record was; generation ' + String(stored) + ' carried on',
              ]);
            }
          }
        }
      }
    }

    // 7. no file at all
    if (!present) {
      if (had && o.choice !== 'start-new' && !asideDone) {
        return { kind: 'journal-missing', storedGeneration: stored as number };
      }
      const strays: string[] = [];
      for (const s of SIDECARS) {
        const p = path + s;
        if (await fileStep(() => deps.files.exists(p))) {
          strays.push(p);
        }
      }
      if (strays.length > 0) {
        for (const p of strays) {
          await fileStep(() => deps.files.move(p, p + '.stray-' + deps.now()));
        }
        notes.push(['stray-files-set-aside', strays.length + ' stray file(s) set aside']);
      }
      if (key === null) {
        key = await secureStep(() => createKey(deps.secure, names, deps.randomBytes));
      }
      if (stored === null) {
        await secureStep(() => markFirstRun(deps.secure, names));
      }
      try {
        opened = await openDatabase(deps.opener, dir, names.file, key, o.durability ?? 'wal');
      } catch (e) {
        if (e instanceof WrongKeyError) {
          return { kind: 'store-refused', why: msg(e) };
        } else if (e instanceof NewerFormatError) {
          return { kind: 'newer-format', version: e.version };
        } else if (e instanceof DbOpenError) {
          return { kind: 'open-failed', why: msg(e) };
        }
        return { kind: 'store-refused', why: msg(e) };
      }
      driver = opened.driver;
      if (opened.version !== 0) {
        throw new Stop({ kind: 'store-refused', why: 'a new file was not empty' });
      }
      try {
        await createSchema(driver);
      } catch (e) {
        if (e instanceof LayoutError) {
          throw new Stop({ kind: 'store-refused', why: msg(e) });
        }
        throw e;
      }
      firstRun = true;
      carry = had;
      if (had && o.choice === 'start-new') {
        notes.push(['started-new-after-missing', 'generation ' + String(stored) + ' carried on']);
      }
    }

    // 8. the backup exclusion
    await fileStep(() => deps.files.exclude(path));
    for (const s of SIDECARS) {
      await fileStep(() => deps.files.exclude(path + s));
    }
    const exDir = await fileStep(() => deps.files.excluded(dir));
    const exFile = await fileStep(() => deps.files.excluded(path));
    if (!exDir || !exFile) {
      throw new Stop({ kind: 'store-refused', why: 'the journal is not excluded from backup' });
    }

    // 9. the store
    if (driver === null || opened === null) {
      throw new Stop({ kind: 'open-failed', why: 'the database was not opened' });
    }
    const gate = createGate(driver);
    const serial = gate.serial;
    const events = new TillEvents(driver, serial, deps.now);
    const journal = new SqliteJournal(driver, serial, deps.now);
    const keep = new KeepStore(driver, serial, events, deps.now);
    const archive = new ArchiveReader(driver, serial);
    const d = driver;
    const store: OpenStore = {
      names,
      dir,
      path,
      driver: d,
      cipherVersion: opened.cipherVersion,
      journal,
      generation,
      keep,
      backups: new TillBackupStore(d, serial, deps, generation, o.settingsNames ?? TILL_SETTINGS, checkpointItem(names)),
      wallet: new WalletStore(d, serial),
      offline: new OfflineSettingsStore(d, serial),
      topups: new TopupStore(d, serial),
      lightningSales: new LightningSaleStore(d, serial),
      lightning: new LightningStore(d, serial, deps.now, lightningCheckpoint(deps, names)),
      events,
      archive,
      close: () => gate.close(),
    };
    if (!firstRun && stored === null) {
      notes.push(['generation-empty', 'no generation was stored; nothing to check this open against']);
    }

    // 10. the library
    let value: T;
    try {
      if (carry) {
        await store.offline.disableAll();
        await store.backups.disarmRestoredSettings();
        await store.lightning.disarmRestored();
      }
      value = await o.start(store, carry);
    } catch (e) {
      if (e instanceof JournalRolledBackError && o.choice === 'use-older') {
        try {
          await store.offline.disableAll();
          await store.backups.disarmRestoredSettings();
          await store.lightning.disarmRestored();
          value = await o.start(store, true);
        } catch (e2) {
          throw new Stop({ kind: 'open-failed', why: msg(e2) });
        }
        notes.push([
          'used-older-record',
          'generation ' + e.journalGeneration + ' taken where ' + e.storedGeneration + ' was stored',
        ]);
      } else if (e instanceof JournalRolledBackError) {
        throw new Stop({
          kind: 'rolled-back',
          journalGeneration: e.journalGeneration,
          storedGeneration: e.storedGeneration,
        });
      } else {
        throw new Stop({ kind: 'open-failed', why: msg(e) });
      }
    }
    if (firstRun) {
      await events.add('created', had ? 'a new record after a used one' : 'first run');
    }
    for (const [kind, detail] of notes) {
      await events.add(kind, detail);
    }
    return { kind: 'ready', value, store, firstRun };
  } catch (e) {
    if (driver) {
      await driver.close().catch(() => undefined);
    }
    if (e instanceof Stop) {
      return e.outcome;
    }
    throw e;
  }
}
