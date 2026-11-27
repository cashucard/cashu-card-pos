import { NativeModules } from 'react-native';
import type * as OpSqlite from '@op-engineering/op-sqlite';
import type * as Keychain from 'react-native-keychain';
import type { SecureStore, SqlDriver, SqlOpener, SqlValue, StoreFiles } from './types';
import { GATE_WORDS, type DeviceGate, type GateResult } from '../gate';

/* The only file that names the native packages (slice 0.3). Each package is required when first used, not when this
 * file is imported, so jest and the self-test's tests can import the wiring without the native modules. Checked against
 * the installed types at set-up: correct it here, and only here, when a package's API differs. */

/** op-sqlite, built with SQLCipher (package.json "op-sqlite": { "sqlcipher": true }). */
export function opSqliteOpener(): SqlOpener {
  const op = require('@op-engineering/op-sqlite') as typeof OpSqlite;
  return {
    async open(dir: string, file: string, keyHex: string): Promise<SqlDriver> {
      if (!/^[0-9a-f]{64}$/.test(keyHex)) {
        throw new Error('the key is not 32 bytes of hex');
      }
      // x'…' is SQLCipher's raw key: the bytes are the key, with no passphrase derivation. op-sqlite 14.1.4 runs
      // "PRAGMA key = '<encryptionKey>'" (cpp/bridge.cpp), inside a single-quoted literal, so the quotes are doubled
      // here and SQLite reads the value x'<hex>' (checked at set-up against its SQLCipher 4.10.0 amalgamation).
      const db = op.open({ name: file, location: dir, encryptionKey: "x''" + keyHex + "''" });
      // op-sqlite frees the connection at close: a statement after it, or a second close, must never reach it
      let closed = false;
      return {
        async run(sql: string, params?: readonly SqlValue[]) {
          if (closed) {
            throw new Error('the database is closed');
          }
          const r = await db.execute(sql, params ? [...params] : []);
          return {
            rows: (r.rows ?? []) as unknown as Array<Record<string, SqlValue>>,
            // op-sqlite answers sqlite3_changes() after every statement, which a SELECT or a PRAGMA leaves at the last
            // write's count; the seam promises 0 for anything but a write
            rowsAffected: /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql) ? r.rowsAffected ?? 0 : 0,
          };
        },
        async close() {
          if (closed) {
            return;
          }
          closed = true;
          db.close();
        },
      };
    },
  };
}

/** react-native-keychain 10.0.0. Never pass cloudSync: its iOS code reads any value, false included, as true. */
export function keychainStore(): SecureStore {
  const K = require('react-native-keychain') as typeof Keychain;
  return {
    async get(name: string): Promise<string | null> {
      const r = await K.getGenericPassword({ service: name });
      return r === false ? null : r.password;
    },
    async set(name: string, value: string): Promise<void> {
      const r = await K.setGenericPassword('ccpos', value, {
        service: name,
        accessible: K.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        storage: K.STORAGE_TYPE.AES_GCM_NO_AUTH,
        securityLevel: K.SECURITY_LEVEL.SECURE_SOFTWARE,
      });
      if (r === false) {
        throw new Error('the secure store did not keep ' + name);
      }
    },
    async remove(name: string): Promise<void> {
      await K.resetGenericPassword({ service: name });
    },
  };
}

interface CCPOSStoreModule {
  journalDir(name: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  excludeFromBackup(path: string): Promise<boolean>;
  isExcludedFromBackup(path: string): Promise<boolean>;
  move(from: string, to: string): Promise<void>;
  removeLabFile(path: string): Promise<void>;
}

/** Our own native module (native/ccpos-store on iOS, CCPOSStoreModule.kt on Android). */
export function nativeFiles(): StoreFiles {
  const m = NativeModules.CCPOSStore as CCPOSStoreModule | undefined;
  if (!m) {
    throw new Error('the CCPOSStore native module is not linked');
  }
  return {
    dir: (name) => m.journalDir(name),
    exists: (path) => m.exists(path),
    exclude: (path) => m.excludeFromBackup(path),
    excluded: (path) => m.isExcludedFromBackup(path),
    move: (from, to) => m.move(from, to),
    removeLab: (path) => m.removeLabFile(path),
  };
}

/** The phone's owner check (slice 1.1): an item only the phone's passcode, Face ID or fingerprint can read. Every read
 * of it makes the system ask the person at the phone; whether it exists is asked without a prompt. Correct the options
 * here, and only here, if the simulator or a phone refuses them. Never pass cloudSync. */
export const GATE_ITEM = 'org.cashucard.pos.gate';

/** Android's BiometricPrompt codes for a sheet closed with no answer: ERROR_CANCELED (5, the system closed it),
 * ERROR_USER_CANCELED (10, the person closed it) and ERROR_NEGATIVE_BUTTON (13, its Cancel button). */
export const ANDROID_CANCEL_CODES: readonly number[] = [5, 10, 13];

/** Whether a rejection of the keychain is a cancel, told by its code and never by its words (ENG-911): the words are
 * the system's, in the phone's language. iOS rejects with errSecUserCanceled as the code '-128'. Android
 * (react-native-keychain 10.0.0) rejects with the code 'E_CRYPTO_FAILED' and a message that begins
 * 'code: <BiometricPrompt code>, msg: ', the system's words after it. */
export function gateCancelled(code: string, message: string): boolean {
  if (code === '-128') {
    return true;
  }
  if (code !== 'E_CRYPTO_FAILED') {
    return false;
  }
  const m = /^code: (-?[0-9]+), msg: /.exec(message);
  return m !== null && ANDROID_CANCEL_CODES.includes(Number(m[1]));
}

export function keychainGate(): DeviceGate {
  const K = require('react-native-keychain') as typeof Keychain;
  const failed = (e: unknown): GateResult => {
    const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '';
    const m = e instanceof Error ? e.message : String(e);
    if (gateCancelled(code, m)) {
      return { ok: false, why: 'cancelled', words: GATE_WORDS.cancelled };
    }
    return { ok: false, why: 'failed', words: GATE_WORDS.failed + (code === '' ? '' : ' (' + code + ')') };
  };
  return {
    async available(): Promise<boolean> {
      try {
        return await K.isPasscodeAuthAvailable();
      } catch {
        return false;
      }
    },
    async check(reason: string): Promise<GateResult> {
      try {
        if (!(await K.isPasscodeAuthAvailable())) {
          return { ok: false, why: 'unavailable', words: GATE_WORDS.unavailable };
        }
        if (!(await K.hasGenericPassword({ service: GATE_ITEM }))) {
          const made = await K.setGenericPassword('ccpos', 'gate', {
            service: GATE_ITEM,
            accessControl: K.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
            accessible: K.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            storage: K.STORAGE_TYPE.AES_GCM,
            // on Android making the item asks the person at the phone, in a sheet titled by this (ENG-911): without
            // it the first sheet after an install carried the keychain library's own title, not the till's reason
            authenticationPrompt: { title: reason, cancel: 'Cancel' },
          });
          if (made === false) {
            return { ok: false, why: 'failed', words: GATE_WORDS.failed };
          }
        }
        const got = await K.getGenericPassword({
          service: GATE_ITEM,
          accessControl: K.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
          authenticationPrompt: { title: reason, cancel: 'Cancel' },
        });
        return got === false ? { ok: false, why: 'failed', words: GATE_WORDS.failed } : { ok: true };
      } catch (e) {
        return failed(e);
      }
    },
  };
}
