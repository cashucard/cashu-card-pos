import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { NativeModules } from 'react-native';
import { keychainStore, nativeFiles, opSqliteOpener } from './native';
import type { StoreDeps } from './types';

/** The store's real device pieces: op-sqlite with SQLCipher, the Keychain or Keystore, our files module, the native
 * random source that react-native-get-random-values installs. */
export function deviceStoreDeps(): StoreDeps {
  const g = globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  return {
    files: nativeFiles(),
    secure: keychainStore(),
    opener: opSqliteOpener(),
    async deriveBackupKey(password, salt) {
      const hex = await NativeModules.CCPOSBackupFiles.deriveKey(bytesToHex(password), bytesToHex(salt));
      if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) throw new Error('The backup key could not be derived.');
      return hexToBytes(hex);
    },
    randomBytes: (n: number): Uint8Array => {
      const c = g.crypto;
      if (!c || typeof c.getRandomValues !== 'function') {
        throw new Error('no secure random source');
      }
      return c.getRandomValues(new Uint8Array(n));
    },
    now: () => Date.now(),
    log: (line: string) => console.log(line),
  };
}
