/* Every SQL statement of the till's store (slice 0.3), in one place. The journal keeps each row whole, as JSON, by its
 * id; `kind` and `gen` are copies for inspection. `kept` is the payout's keep-store; `till_events` the app's own notes. */

import { BACKUP_SCHEMA } from './backup-schema';
import { TOPUP_SCHEMA } from './topups';
import { OFFLINE_ARCHIVE_SCHEMA, OFFLINE_SCHEMA } from './offline-schema';
import { EXTRA_HANDOFFS_TABLE } from './extra-handoffs-schema';
import { LIGHTNING_FEE_UPGRADE, LIGHTNING_UPGRADE } from './lightning-schema';

/** The store's layout version (PRAGMA user_version). 0 is a file with nothing in it yet. 1: slice 0.3. 2: slice 2.3,
 * the archive table. 3: merchant withdrawals and owed-card handoffs. 4: Lightning payouts and sweep settings.
 * 5: actual Lightning settlement fees. 6: resumable card top-ups and offline payments. 7: archive index for offline sales. 8: portable backup and recovery state. 9: recoverable merchant Lightning receipts. */
export const SCHEMA_VERSION = 9;
const LIGHTNING_SALES_UPGRADE = [
  'CREATE TABLE lightning_sales (sale TEXT PRIMARY KEY NOT NULL, mint TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, checked_at INTEGER NOT NULL, body TEXT NOT NULL)',
  'CREATE INDEX lightning_sales_check ON lightning_sales(state,checked_at)',
  'PRAGMA user_version = ' + SCHEMA_VERSION,
];
const BACKUP_UPGRADE = [...BACKUP_SCHEMA, ...LIGHTNING_SALES_UPGRADE];
const OFFLINE_ARCHIVE_UPGRADE = [...OFFLINE_ARCHIVE_SCHEMA, ...BACKUP_UPGRADE];
const CARD_SERVICES = [...TOPUP_SCHEMA, ...OFFLINE_SCHEMA, ...OFFLINE_ARCHIVE_UPGRADE];

/** The archive (layout 2): every row the library's archive() takes out of the journal, moved here whole in the same
 * transaction as its removal (journal.ts remove), with the fields the totals and the payment list read from its body
 * (null where the body does not give one). The body is the last column, so that no read of the other columns walks a
 * body's overflow pages. The UNIQUE constraint (id is unique by itself) gives SQLite an index holding every column the
 * takings read, so SQL.archiveTakings reads that index alone, never the rows. */
export const ARCHIVE_TABLE =
  'CREATE TABLE archive (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, gen INTEGER NOT NULL, written_at INTEGER NOT NULL, archived_at INTEGER NOT NULL, sale TEXT, state TEXT, extra TEXT, at INTEGER, amount INTEGER, fee INTEGER, mint TEXT, unit TEXT, body TEXT NOT NULL, UNIQUE (kind, state, extra, at, amount, id))';

const WALLET_UPGRADE = [
  'ALTER TABLE kept ADD COLUMN withdrawal TEXT',
  'CREATE INDEX kept_withdrawal ON kept (mint_norm, unit, withdrawal)',
  'CREATE TABLE withdrawals (id TEXT PRIMARY KEY NOT NULL, mint TEXT NOT NULL, unit TEXT NOT NULL, token TEXT NOT NULL, amount INTEGER NOT NULL, deliveries INTEGER NOT NULL, pending INTEGER NOT NULL)',
  'CREATE UNIQUE INDEX open_withdrawal ON withdrawals (mint, unit) WHERE amount > 0',
  EXTRA_HANDOFFS_TABLE,
];

/** The schema, made in one transaction with its version (db.ts createSchema). */
export const SCHEMA: readonly string[] = [
  'CREATE TABLE journal (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, gen INTEGER NOT NULL, body TEXT NOT NULL, written_at INTEGER NOT NULL)',
  'CREATE TABLE kept (id TEXT PRIMARY KEY NOT NULL, mint TEXT NOT NULL, mint_norm TEXT NOT NULL, unit TEXT NOT NULL, amount INTEGER NOT NULL, token TEXT NOT NULL, body TEXT NOT NULL, kept_at INTEGER NOT NULL)',
  'CREATE TABLE till_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)',
  ARCHIVE_TABLE,
  ...WALLET_UPGRADE,
  ...LIGHTNING_UPGRADE,
  ...CARD_SERVICES,
];

/** What brings a file of an earlier layout up to SCHEMA_VERSION, by the layout it has, run in one transaction
 * (db.ts upgradeSchema). */
export const UPGRADES: Readonly<Record<number, readonly string[]>> = {
  1: [ARCHIVE_TABLE, ...WALLET_UPGRADE, ...LIGHTNING_UPGRADE, ...CARD_SERVICES],
  2: [...WALLET_UPGRADE, ...LIGHTNING_UPGRADE, ...CARD_SERVICES],
  3: [...LIGHTNING_UPGRADE, ...CARD_SERVICES],
  4: [...LIGHTNING_FEE_UPGRADE, ...CARD_SERVICES],
  5: CARD_SERVICES,
  6: OFFLINE_ARCHIVE_UPGRADE,
  7: BACKUP_UPGRADE,
  8: LIGHTNING_SALES_UPGRADE,
};

export const SQL = {
  cipherVersion: 'PRAGMA cipher_version',
  keyCheck: 'SELECT count(*) AS n FROM sqlite_master',
  journalModeWal: 'PRAGMA journal_mode = WAL',
  journalModeDelete: 'PRAGMA journal_mode = DELETE',
  synchronousFull: 'PRAGMA synchronous = FULL',
  fullfsyncOn: 'PRAGMA fullfsync = ON',
  checkpointFullfsyncOn: 'PRAGMA checkpoint_fullfsync = ON',
  synchronous: 'PRAGMA synchronous',
  fullfsync: 'PRAGMA fullfsync',
  userVersion: 'PRAGMA user_version',
  begin: 'BEGIN IMMEDIATE',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
  journalUpsert:
    'INSERT INTO journal (id, kind, gen, body, written_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, gen = excluded.gen, body = excluded.body, written_at = excluded.written_at',
  journalInsert: 'INSERT INTO journal (id, kind, gen, body, written_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
  journalRead: 'SELECT body FROM journal WHERE id = ?',
  journalList: 'SELECT id, body FROM journal ORDER BY rowid',
  journalRemove: 'DELETE FROM journal WHERE id = ?',
  journalStats: 'SELECT count(*) AS n, coalesce(max(gen), 0) AS gen FROM journal',
  journalAny: 'SELECT id FROM journal LIMIT 1',
  journalRow: 'SELECT id, kind, gen, body, written_at FROM journal WHERE id = ?',
  journalCount: 'SELECT count(*) AS n FROM journal WHERE kind = ?',
  journalWritten: "SELECT id, written_at FROM journal WHERE kind = 'payment'",
  journalPayments: "SELECT id, body FROM journal WHERE kind = 'payment'",
  journalSaleRows: "SELECT id, body FROM journal WHERE kind = 'sale'",
  archiveInsert:
    'INSERT OR REPLACE INTO archive (id, kind, gen, body, written_at, archived_at, sale, state, extra, at, amount, fee, mint, unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  archiveTakings:
    "SELECT count(*) AS n, coalesce(sum(amount), 0) AS sats FROM archive WHERE kind = 'payment' AND state IN ('delivered', 'exported') AND extra IS NULL AND at >= ? AND at <= ?",
  archiveHas: 'SELECT id FROM archive WHERE id = ?',
  archivePayments:
    "SELECT state, at, amount, fee, mint, unit FROM archive WHERE kind = 'payment' AND state IS NOT NULL AND state <> 'none' AND at IS NOT NULL AND amount IS NOT NULL ORDER BY at, id",
  keepInsert:
    'INSERT INTO kept (id, mint, mint_norm, unit, amount, token, body, kept_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
  keepRead: 'SELECT body FROM kept WHERE id = ?',
  keepList: 'SELECT body FROM kept ORDER BY rowid',
  keepTotals:
    `SELECT mint, unit, sum(amount) AS amount, sum(n) AS n FROM (
       SELECT mint_norm AS mint, unit, amount, 1 AS n FROM kept WHERE withdrawal IS NULL
       UNION ALL SELECT mint, unit, amount, deliveries AS n FROM withdrawals WHERE amount > 0
       UNION ALL SELECT mint, 'sat', input_amount, input_count FROM lightning_payouts WHERE state IN ('quoted','submitted')
     ) GROUP BY mint, unit ORDER BY mint, unit`,
  eventAdd: 'INSERT INTO till_events (at, kind, detail) VALUES (?, ?, ?)',
  eventList: 'SELECT seq, at, kind, detail FROM till_events ORDER BY seq',
} as const;
