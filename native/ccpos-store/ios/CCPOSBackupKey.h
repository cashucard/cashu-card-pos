// Portable CASHU-POS-BACKUP-1 parameters. Keep in sync with backup-crypto.ts.
#pragma once
#include <openssl/evp.h>
#include <openssl/crypto.h>
#include <stddef.h>
#include <stdint.h>

static inline int ccpos_backup_key(const unsigned char *password, size_t length,
                                   const unsigned char salt[16], unsigned char key[32]) {
  return EVP_PBE_scrypt((const char *)password, length, salt, 16, 65536, 8, 2,
                        70ULL * 1024 * 1024, key, 32);
}
