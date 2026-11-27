/** Only public mint keys and the merchant's decision to enable a mint live here.
 * Signed sales use the same durable journal and reconciliation as online payments. */
// A row enables this mint. JSON null means its first validated keys are still pending.
// Absence has always meant off, including after restoring an older wallet.
export const ENABLE_OFFLINE_MINT = "INSERT OR IGNORE INTO offline_kits(mint,body) VALUES(?, 'null')";
export const OFFLINE_SCHEMA = [
  'CREATE TABLE offline_kits (mint TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL)',
];

/** Layout 7. Capturing the highest archived rowid reads SQLite's rowid index without loading the
 * archive. Existing payments are indexed in bounded batches when the merchant uses offline sales. */
export const OFFLINE_ARCHIVE_SCHEMA = [
  'CREATE TABLE offline_spent_inputs (mint TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(mint,digest)) WITHOUT ROWID',
  'CREATE TABLE offline_archive_cursor (id INTEGER PRIMARY KEY CHECK(id=1), remaining INTEGER NOT NULL)',
  'INSERT INTO offline_archive_cursor(id,remaining) SELECT 1,coalesce(max(rowid),0) FROM archive',
];
