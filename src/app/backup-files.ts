import { NativeModules } from 'react-native';

/** The OS picker sees only the authenticated, encrypted document. Cancellation resolves to null. */
export interface BackupFiles {
  chooseRecoveryFolder(): Promise<boolean>;
  open(): Promise<string | null>;
  save(encrypted: string): Promise<true | 'verify' | null>;
}

export const backupFiles: BackupFiles = {
  chooseRecoveryFolder: () => chooseRecoveryFolder(),
  open: () => NativeModules.CCPOSBackupFiles.open(),
  save: encrypted => NativeModules.CCPOSBackupFiles.save(encrypted),
};

export async function chooseRecoveryFolder(): Promise<boolean> {
  return (await NativeModules.CCPOSBackupFiles.chooseFolder()) === true;
}

export async function writeRecoveryCopy(encrypted: string): Promise<void> {
  if (await NativeModules.CCPOSBackupFiles.writeCopy(encrypted) !== true) {
    throw new Error('The recovery copy could not be confirmed.');
  }
}
