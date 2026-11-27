// Device-specific backup and restore authority. This row never travels inside a portable backup.
export const BACKUP_SCHEMA = [
  `CREATE TABLE backup_control (
    id INTEGER PRIMARY KEY CHECK(id=1),
    pending_digest TEXT, pending_at INTEGER, pending_verifier TEXT,
    verified_digest TEXT, verified_at INTEGER, verified_verifier TEXT,
    change_enabled INTEGER NOT NULL DEFAULT 0 CHECK(change_enabled IN (0,1)),
    recovery_id TEXT, recovery_at INTEGER, recovery_settings TEXT,
    recovery_phase TEXT CHECK(recovery_phase IN ('quarantined','active'))
  )`,
  'INSERT INTO backup_control(id) VALUES(1)',
  'CREATE TABLE backup_imported_payments (id TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID',
];
