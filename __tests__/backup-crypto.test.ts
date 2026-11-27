import { createBackupCipher, MAX_BACKUP_FILE_BYTES, unsealBackup } from '../src/till/store/backup-crypto';

jest.setTimeout(30_000);

// Generated independently with libsodium's crypto_pwhash_scryptsalsa208sha256_ll and
// crypto_aead_xchacha20poly1305_ietf_encrypt, with the fixed public fixture bytes below.
const file = ['CASHU-POS-BACKUP-1','000102030405060708090a0b0c0d0e0f',
  '000102030405060708090a0b0c0d0e0f1011121314151617','Y4Bv1P+Mwb0avLtmgr7r0xews/3bR9qytNBsg1AKLg37ndN2X2hVpA=='].join('\n');
const pass = 'four long words (fixture only)';
const message = 'Fixture pays 12 sats ☕';
const rng = (size: number) => Uint8Array.from({length:size}, (_, i) => i);

test('the portable format interoperates byte-for-byte with libsodium', async () => {
  const cipher = await createBackupCipher(pass, rng);
  try {
    expect(cipher.seal(message)).toBe(file);
    await expect(unsealBackup(file,pass)).resolves.toBe(message);
  } finally { cipher.close(); }
});

test('the portable reader limits file size, format, work parameters, randomness and passphrase length',async()=>{
  await expect(unsealBackup('a'.repeat(MAX_BACKUP_FILE_BYTES + 1),pass)).rejects.toThrow(/size limit/);
  await expect(unsealBackup(file.replace('BACKUP-1','BACKUP-2'),pass)).rejects.toThrow(/valid/);
  await expect(unsealBackup(file.replace('\n00','\nx0'),pass)).rejects.toThrow(/valid/);
  await expect(createBackupCipher('only two', rng)).rejects.toThrow('12 characters');
  await expect(createBackupCipher('☕'.repeat(90), rng)).rejects.toThrow('256 bytes');
  await expect(createBackupCipher(pass, size=>new Uint8Array(size))).rejects.toThrow('entropy');
});
