#include <jni.h>
#include "CCPOSBackupKey.h"

extern "C" JNIEXPORT jbyteArray JNICALL
Java_org_cashucard_pos_CCPOSBackupFilesModule_deriveNative(JNIEnv *env, jobject, jbyteArray password, jbyteArray salt) {
  const jsize length = env->GetArrayLength(password);
  if (length < 1 || length > 256 || env->GetArrayLength(salt) != 16) return nullptr;
  unsigned char pass[256], saltBytes[16], key[32];
  env->GetByteArrayRegion(password, 0, length, reinterpret_cast<jbyte *>(pass));
  env->GetByteArrayRegion(salt, 0, 16, reinterpret_cast<jbyte *>(saltBytes));
  jbyteArray result = nullptr;
  if (!env->ExceptionCheck() && ccpos_backup_key(pass, length, saltBytes, key) == 1) {
    result = env->NewByteArray(32);
    if (result != nullptr) env->SetByteArrayRegion(result, 0, 32, reinterpret_cast<jbyte *>(key));
  }
  OPENSSL_cleanse(pass, sizeof(pass));
  OPENSSL_cleanse(key, sizeof(key));
  return result;
}
