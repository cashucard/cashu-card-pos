export interface TillRecoveryStatus {
  canRestore: boolean;
  lastBackupAt: number | null;
  changeEnabled: boolean;
  changeUnlocked: boolean;
  restoring: boolean;
}

export interface TillRecoveryActions {
  status(): Promise<TillRecoveryStatus>;
  exportFile(passphrase: string): Promise<string>;
  confirmSaved(encryptedFile: string): Promise<void>;
  importFile(encryptedFile: string, passphrase: string): Promise<void>;
  finishRestore(): Promise<void>;
  setChangeEnabled(enabled: boolean, passphrase?: string): Promise<void>;
}

/** Only fixed, merchant-safe explanations or validated mint hostnames belong in this error. */
export class RecoveryActionError extends Error {}
