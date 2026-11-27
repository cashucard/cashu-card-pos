import { loadSettings, parseSettings, type MintEntry, type SettingsNames, type TillSettings } from '../settings';
import { backupDigest, createBackupCipher, unsealBackup } from './backup-crypto';
import { emptyRestoreTarget, parseBackupRecord, readBackupRecord, replaceInitialRows } from './backup-record';
import type { Serial } from './db';
import { SQL } from './sql';
import type { TwoSlotGenerationStore } from './secret';
import type { SqlDriver, SqlValue, StoreDeps } from './types';

export interface BackupPreview {
  id: string;
  createdAt: number;
  generation: number;
  mints: string[];
}

export interface BackupStatus {
  verifiedExport: boolean;
  lastExportAt: number | null;
  changeEnabled: boolean;
  canRestore: boolean;
  recovery: { id: string; phase: 'quarantined' | 'active'; createdAt: number; mints: MintEntry[] } | null;
}

function snapshotSettings(raw: SqlValue): MintEntry[] {
  const value = JSON.parse(String(raw));
  return value?.v === 1 && value.seq === 0 && Array.isArray(value.mints) && value.mints.length === 0
    ? [] : parseSettings(String(raw)).mints;
}

export class TillBackupStore {
  constructor(private readonly db: SqlDriver, private readonly serial: Serial, private readonly deps: StoreDeps,
    private readonly generation: TwoSlotGenerationStore, private readonly settingsNames: SettingsNames,
    private readonly lightningRevisionName: string) {}

  private async transaction<T>(work: () => Promise<T>): Promise<T> {
    await this.db.run(SQL.begin);
    try {
      const value = await work();
      await this.db.run(SQL.commit);
      return value;
    } catch (e) {
      await this.db.run(SQL.rollback).catch(() => undefined);
      throw e;
    }
  }

  private async control() {
    const row = (await this.db.run('SELECT * FROM backup_control WHERE id=1')).rows[0];
    if (!row) throw new Error('The backup record is unavailable.');
    return row;
  }

  private async fresh(row: Record<string, SqlValue>): Promise<boolean> {
    if (row.recovery_id !== null || row.verified_digest !== null || row.pending_digest !== null) return false;
    if (!await emptyRestoreTarget(this.db)) return false;
    if (await this.deps.secure.get(this.lightningRevisionName) !== null) return false;
    const saved = await loadSettings(this.deps.secure, this.settingsNames);
    return !saved.damaged && saved.settings.seq === 0;
  }

  private async readStatus(): Promise<BackupStatus> {
    const row = await this.control();
    const phase = row.recovery_phase;
    if ((row.recovery_id === null) !== (phase === null) || (phase !== null && phase !== 'quarantined' && phase !== 'active')) {
      throw new Error('The recovery record could not be verified.');
    }
    const recovery = phase !== null ? {
      phase, id: String(row.recovery_id), createdAt: Number(row.recovery_at), mints: snapshotSettings(row.recovery_settings),
    } : null;
    return {
      verifiedExport: row.verified_digest !== null, lastExportAt: row.verified_at === null ? null : Number(row.verified_at),
      changeEnabled: row.change_enabled === 1 && row.verified_digest !== null && phase !== 'quarantined',
      recovery: recovery as BackupStatus['recovery'], canRestore: await this.fresh(row),
    };
  }

  status(): Promise<BackupStatus> { return this.serial(() => this.readStatus()); }

  /** The SDK detected rollback or a replacement record. A previously acknowledged document no longer
   * establishes that this timeline is saving PIN-change obligations. Keep imported quarantine evidence. */
  disarmRestoredSettings(): Promise<void> {
    return this.serial(async () => {
      await this.db.run('UPDATE backup_control SET change_enabled=0, pending_digest=NULL, pending_at=NULL, pending_verifier=NULL,' +
        ' verified_digest=NULL, verified_at=NULL, verified_verifier=NULL WHERE id=1');
    });
  }

  /** Captured once during import. New payments on the recovered phone never enter this list. */
  restoredPaymentIds(): Promise<string[]> {
    return this.serial(async () => (await this.db.run('SELECT id FROM backup_imported_payments ORDER BY id')).rows.map(r => String(r.id)));
  }

  private async snapshot(settings: TillSettings) {
    if ((await this.control()).recovery_phase === 'quarantined') throw new Error('Finish checking this restored till first.');
    const record = await readBackupRecord(this.db, this.deps.now(), settings);
    // SDK writes SQL before its secure high-water mark. A checkpoint inside that interval is valid.
    if (record.generation < (await this.generation.get() ?? 0)) throw new Error('The payment record generation could not be verified.');
    return record;
  }

  async exportFile(passphrase: string, settings: TillSettings): Promise<string> {
    const cipher = await createBackupCipher(passphrase, this.deps.randomBytes, undefined, this.deps.deriveBackupKey);
    try {
      return await this.serial(async () => {
        const snapshot = await this.transaction(() => this.snapshot(settings));
        const file = cipher.seal(JSON.stringify(snapshot));
        await this.db.run('UPDATE backup_control SET pending_digest=?, pending_at=?, pending_verifier=? WHERE id=1',
          [backupDigest(file), snapshot.createdAt, cipher.salt + ':' + cipher.verifier]);
        return file;
      });
    } finally {
      cipher.close();
    }
  }

  async unlockWriter(passphrase: string): Promise<{ write(settings: TillSettings): Promise<string>; close(): void }> {
    const saved = await this.serial(async () => (await this.control()).verified_verifier);
    if (typeof saved !== 'string') throw new Error('Save and verify an encrypted backup first.');
    const cipher = await createBackupCipher(passphrase, this.deps.randomBytes, saved.split(':')[0], this.deps.deriveBackupKey);
    if (cipher.salt + ':' + cipher.verifier !== saved) {
      cipher.close();
      throw new Error('The backup passphrase could not be verified.');
    }
    return {
      write: settings => this.serial(async () => {
        const record = await this.transaction(async () => {
          if ((await this.control()).verified_verifier !== saved) throw new Error('Unlock the latest backup again.');
          return this.snapshot(settings);
        });
        return cipher.seal(JSON.stringify(record));
      }),
      close: () => cipher.close(),
    };
  }

  /** The file picker must return the saved bytes (or confirm their byte-for-byte readback) before calling. */
  async confirmExport(file: string): Promise<void> {
    const digest = backupDigest(file);
    await this.serial(async () => {
      const updated = await this.db.run(
        'UPDATE backup_control SET verified_digest=pending_digest, verified_at=pending_at, verified_verifier=pending_verifier, pending_digest=NULL, pending_at=NULL, pending_verifier=NULL WHERE id=1 AND pending_digest=?',
        [digest]);
      if (updated.rowsAffected !== 1 && (await this.control()).verified_digest !== digest) {
        throw new Error('The saved file does not match this backup.');
      }
    });
  }

  async setChangeEnabled(enabled: boolean): Promise<void> {
    await this.serial(async () => {
      const updated = await this.db.run('UPDATE backup_control SET change_enabled=? WHERE id=1 ' +
        "AND (?=0 OR (verified_digest IS NOT NULL AND coalesce(recovery_phase,'')!='quarantined'))", [enabled ? 1 : 0, enabled ? 1 : 0]);
      if (updated.rowsAffected !== 1) throw new Error('Save and verify an encrypted backup before enabling PIN-protected change.');
    });
  }

  async inspectFile(file: string, passphrase: string): Promise<BackupPreview> {
    const snapshot = parseBackupRecord(await unsealBackup(file, passphrase, this.deps.deriveBackupKey));
    return { id: backupDigest(file), createdAt: snapshot.createdAt, generation: snapshot.generation,
      mints: snapshot.settings.mints.map(m => m.url) };
  }

  async restoreFile(file: string, passphrase: string): Promise<BackupStatus> {
    const snapshot = parseBackupRecord(await unsealBackup(file, passphrase, this.deps.deriveBackupKey));
    const id = backupDigest(file);
    return this.serial(() => this.transaction(async () => {
      const row = await this.control();
      if (row.recovery_id === id && row.recovery_phase === 'quarantined') return this.readStatus();
      if (!await this.fresh(row)) throw new Error('Restore requires a fresh till with no previous activity or mint settings.');
      if ((await this.generation.get() ?? 0) > snapshot.generation) throw new Error('This backup predates the generation already recorded on this phone.');
      await replaceInitialRows(this.db, snapshot, this.deps.now());
      await this.db.run("INSERT INTO backup_imported_payments(id) SELECT id FROM journal WHERE kind='payment' UNION SELECT id FROM archive WHERE kind='payment' UNION SELECT payment_id FROM extra_handoffs");
      await this.db.run("UPDATE backup_control SET recovery_id=?, recovery_at=?, recovery_settings=?, recovery_phase='quarantined', change_enabled=0 WHERE id=1",
        [id, snapshot.createdAt, JSON.stringify(snapshot.settings)]);
      return this.readStatus();
    }));
  }

  /** Caller verifies retirement of the original till and obtains authoritative mint evidence first.
   * Commit that evidence and the activation together. A failed check leaves the recovery quarantine intact. */
  async activate(expectedId: string, reconcile: (driver: SqlDriver) => Promise<void>): Promise<void> {
    await this.serial(() => this.transaction(async () => {
      const row = await this.control();
      if (row.recovery_phase !== 'quarantined' || row.recovery_id !== expectedId) throw new Error('This backup is not awaiting verification.');
      await reconcile(this.db);
      const unresolved = await this.db.run("SELECT 1 FROM lightning_payouts WHERE state IN ('quoted','submitted') LIMIT 1");
      if (unresolved.rows.length) throw new Error('A withdrawal is still waiting for mint confirmation.');
      await this.db.run("UPDATE backup_control SET recovery_phase='active' WHERE id=1");
    }));
  }
}
