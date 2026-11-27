import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hmac } from '@noble/hashes/hmac.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64, utf8 } from '@scure/base';

const FORMAT = 'CASHU-POS-BACKUP-1';
const AAD = utf8ToBytes(FORMAT);
export const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
export const MAX_BACKUP_FILE_BYTES = 24 * 1024 * 1024;
const MAX_ENCODED = Math.ceil((MAX_BACKUP_BYTES + 16) / 3) * 4;
const BLOCK = 48 * 1024;
const SCRYPT = { N: 65536, r: 8, p: 2, dkLen: 32, maxmem: 70 * 1024 * 1024, asyncTick: 8 };

type DeriveKey = (password: Uint8Array, salt: Uint8Array) => Promise<Uint8Array>;
const derivePortable: DeriveKey = (password, salt) => scryptAsync(password, salt, SCRYPT);

function passwordBytes(passphrase: string): Uint8Array {
  const problem = 'Use a backup passphrase of at least 12 characters and at most 256 bytes.';
  if (typeof passphrase !== 'string' || passphrase.length > 256 || Array.from(passphrase.trim()).length < 12) throw new Error(problem);
  const bytes = utf8ToBytes(passphrase);
  if (bytes.length > 256) {
    bytes.fill(0);
    throw new Error(problem);
  }
  return bytes;
}

export function backupDigest(file: string): string {
  if (file.length > MAX_BACKUP_FILE_BYTES) throw new Error('This backup exceeds the file size limit.');
  const hash = sha256.create();
  for (let i = 0; i < file.length; i += BLOCK) hash.update(utf8ToBytes(file.slice(i, i + BLOCK)));
  return bytesToHex(hash.digest());
}

function entropy(random: (size: number) => Uint8Array, size: number): Uint8Array {
  const bytes = random(size);
  if (bytes.length !== size || !bytes.some(b => b !== 0)) throw new Error('Secure backup entropy is unavailable.');
  return bytes;
}

/** An unlocked writer lives only in memory. The domain-specific HMAC lets this device verify the
 * typed passphrase before accepting a sale. It cannot be used as an encryption key. */
export interface BackupCipher {
  salt: string;
  verifier: string;
  seal(json: string): string;
  close(): void;
}

export async function createBackupCipher(passphrase: string, random: (size: number) => Uint8Array,
  savedSalt?: string, derive: DeriveKey = derivePortable): Promise<BackupCipher> {
  if (savedSalt !== undefined && !/^[0-9a-f]{32}$/.test(savedSalt)) throw new Error('Invalid backup key settings.');
  const salt = savedSalt === undefined ? entropy(random, 16) : hexToBytes(savedSalt);
  const password = passwordBytes(passphrase);
  let key: Uint8Array | undefined;
  try {
    key = await derive(password, salt);
  } finally {
    password.fill(0);
  }
  return {
    salt: bytesToHex(salt),
    verifier: bytesToHex(hmac(sha256, key, utf8ToBytes('Cashu Card POS backup writer verification v1'))),
    seal(json) {
      if (!key) throw new Error('Unlock the backup writer again.');
      if (json.length > MAX_BACKUP_BYTES) throw new Error('The payment record exceeds the 16 MiB backup limit.');
      const plain = utf8ToBytes(json);
      try {
        if (plain.length > MAX_BACKUP_BYTES) throw new Error('The payment record exceeds the 16 MiB backup limit.');
        const nonce = entropy(random, 24);
        const sealed = xchacha20poly1305(key, nonce, AAD).encrypt(plain);
        const parts = [FORMAT, bytesToHex(salt), bytesToHex(nonce)];
        const encoded: string[] = [];
        for (let i = 0; i < sealed.length; i += BLOCK) encoded.push(base64.encode(sealed.subarray(i, i + BLOCK)));
        parts.push(encoded.join(''));
        return parts.join('\n');
      } finally {
        plain.fill(0);
      }
    },
    close() { key?.fill(0); key = undefined; },
  };
}

export async function unsealBackup(file: string, passphrase: string, derive: DeriveKey = derivePortable): Promise<string> {
  if (file.length > MAX_BACKUP_FILE_BYTES) throw new Error('This backup exceeds the file size limit.');
  // Fixed header and parameters. Reject malformed inputs before running the expensive password derivation.
  const prefix = FORMAT + '\n';
  const headerEnd = prefix.length + 32 + 1 + 48 + 1;
  const salt = file.slice(prefix.length, prefix.length + 32);
  const nonce = file.slice(prefix.length + 33, headerEnd - 1);
  const encoded = file.slice(headerEnd);
  if (!file.startsWith(prefix) || file[prefix.length + 32] !== '\n' || file[headerEnd - 1] !== '\n' ||
      !/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{48}$/.test(nonce) ||
      encoded.length < 24 || encoded.length % 4 !== 0 || encoded.length > MAX_ENCODED ||
      /[^0-9A-Za-z+/=]/.test(encoded) || /=.{2,}/.test(encoded)) throw new Error('Choose a valid Cashu POS backup file.');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const sealed = new Uint8Array(encoded.length / 4 * 3 - padding);
  if (sealed.length > MAX_BACKUP_BYTES + 16) throw new Error('This backup exceeds the file size limit.');
  const encodedBlock = BLOCK / 3 * 4;
  for (let i = 0; i < encoded.length; i += encodedBlock) {
    sealed.set(base64.decode(encoded.slice(i, i + encodedBlock)), i / 4 * 3);
  }
  const password = passwordBytes(passphrase);
  let key: Uint8Array | undefined;
  let plain: Uint8Array | undefined;
  try {
    key = await derive(password, hexToBytes(salt));
    plain = xchacha20poly1305(key, hexToBytes(nonce), AAD).decrypt(sealed);
    return utf8.encode(plain);
  } catch {
    throw new Error('The passphrase or the backup file could not be verified.');
  } finally {
    password.fill(0);
    key?.fill(0);
    plain?.fill(0);
  }
}
