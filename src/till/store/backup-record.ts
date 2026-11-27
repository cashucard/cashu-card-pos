import { utf8ToBytes } from '@noble/hashes/utils.js';
import { emptySettings, parseSettings, type TillSettings } from '../settings';
import { disarmRestoredLightning } from './lightning';
import { badRecord, validateBackupRow, type BackupColumn } from './backup-validation';
import { MAX_BACKUP_BYTES } from './backup-crypto';
import { SCHEMA_VERSION } from './sql';
import type { SqlDriver, SqlValue } from './types';

// Only these application tables travel. The SQL comes from the installed app, never from an import.
// rowid is significant for archive backfill and for payout and journal order.
const TABLES = [
  'journal', 'archive', 'kept', 'withdrawals', 'extra_handoffs', 'till_events', 'lightning_checkpoint',
  'lightning_payouts', 'lightning_sweeps', 'lightning_sales', 'card_topups', 'offline_kits', 'offline_spent_inputs', 'offline_archive_cursor',
] as const;
type TableName = typeof TABLES[number];
interface Table {
  columns: string[];
  rows: SqlValue[][];
}
export interface BackupRecord {
  layout: number;
  createdAt: number;
  generation: number;
  settings: TillSettings;
  tables: Record<TableName, Table>;
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function checkedSettings(value: TillSettings): TillSettings {
  if (value?.v === 1 && value.seq === 0 && Array.isArray(value.mints) && value.mints.length === 0) return emptySettings();
  return parseSettings(JSON.stringify(value));
}

export function parseBackupRecord(json: string): BackupRecord {
  try {
    const s = JSON.parse(json) as BackupRecord;
    if (s.layout === 8 && s.tables && !('lightning_sales' in s.tables)) {
      (s as BackupRecord).tables.lightning_sales = {
        columns: ['_rowid_', 'sale', 'mint', 'state', 'created_at', 'checked_at', 'body'], rows: [],
      };
      s.layout = SCHEMA_VERSION;
    }
    if (s.layout !== SCHEMA_VERSION || !validTime(s.createdAt) || !validTime(s.generation) ||
        !s.tables || Object.keys(s.tables).length !== TABLES.length) throw badRecord();
    for (const name of TABLES) {
      const t = s.tables[name];
      if (!t || !Array.isArray(t.rows) || !Array.isArray(t.columns) || t.columns.length < 1 ||
          t.columns.length > 32 || !t.columns.every(c => typeof c === 'string')) throw badRecord();
      for (const row of t.rows) {
        if (!Array.isArray(row) || row.length !== t.columns.length ||
            !row.every(v => typeof v === 'string' || v === null || Number.isSafeInteger(v))) throw badRecord();
      }
    }
    const j = s.tables.journal;
    const g = j.columns.indexOf('gen');
    const max = j.rows.reduce((n, r) => validTime(r[g]) ? Math.max(n, Number(r[g])) : NaN, 0);
    if (g < 0 || max !== s.generation) throw badRecord();
    s.settings = checkedSettings(s.settings);
    return s;
  } catch {
    throw badRecord();
  }
}

async function columnsFor(db: SqlDriver, name: TableName): Promise<BackupColumn[]> {
  const metadata = (await db.run('PRAGMA table_info(' + name + ')')).rows;
  const columns = metadata.map(row => ({name:String(row.name),integer:row.type === 'INTEGER',required:row.notnull === 1 || Number(row.pk) > 0}));
  if (!columns.length || columns.some(c => !/^[a-z][a-z0-9_]*$/.test(c.name))) throw badRecord();
  // Only this table is WITHOUT ROWID. Explicitly name integer primary keys once.
  if (name !== 'offline_spent_inputs' && !metadata.some(c => c.pk === 1 && c.type === 'INTEGER')) columns.unshift({name:'_rowid_',integer:true,required:true});
  return columns;
}

export async function readBackupRecord(db: SqlDriver, createdAt: number, settings: TillSettings): Promise<BackupRecord> {
  const tables = {} as Record<TableName, Table>;
  let bytes = 0;
  const installed = (await db.run("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows;
  const excluded = new Set<string>(['backup_control', 'backup_imported_payments', ...TABLES]);
  if (installed.some(t => !excluded.has(String(t.name)))) throw badRecord();
  for (const name of TABLES) {
    const structure = await columnsFor(db, name);
    const columns = structure.map(c => c.name);
    // Check the unescaped payload size inside SQLite before the bridge materializes any row. This
    // bounds one oversized text field or batch too; the serialized count below also covers JSON escaping.
    const lengths = columns.map(c => 'coalesce(length(CAST(' + c + ' AS BLOB)),0)').join('+');
    const minimum = (await db.run('SELECT coalesce(sum(' + lengths + '),0) AS bytes FROM ' + name)).rows[0].bytes;
    if (Number(minimum) > MAX_BACKUP_BYTES - bytes) throw new Error('The payment record exceeds the 16 MiB backup limit.');
    const rows: SqlValue[][] = [];
    // Index-seek each batch so the iOS/Android bridge returns bounded pages and a large archive
    // is scanned once. Reading under a single transaction gives every table the same snapshot.
    const keyed = name === 'offline_spent_inputs';
    const order = keyed ? 'mint,digest' : '_rowid_';
    const select = keyed ? columns.join(',') : '_rowid_ AS backup_cursor,' +
      columns.map(c => c === '_rowid_' ? '_rowid_ AS _rowid_' : c).join(',');
    let cursor: SqlValue[] = [];
    for (;;) {
      const seek = cursor.length ? (keyed ? ' WHERE (mint,digest)>(?,?)' : ' WHERE _rowid_>?') : '';
      const batch = (await db.run('SELECT ' + select + ' FROM ' + name + seek + ' ORDER BY ' + order + ' LIMIT 64', cursor)).rows;
      for (const r of batch) {
        const values = columns.map(c => r[c]);
        try { validateBackupRow(name, structure, values); } catch { throw badRecord(); }
        bytes += utf8ToBytes(JSON.stringify(values)).length + 1;
        if (bytes > MAX_BACKUP_BYTES) throw new Error('The payment record exceeds the 16 MiB backup limit.');
        rows.push(values);
      }
      if (batch.length < 64) break;
      const last = batch[batch.length - 1];
      cursor = keyed ? [last.mint, last.digest] : [last.backup_cursor];
    }
    tables[name] = { columns, rows };
  }
  const j = tables.journal;
  const gen = j.columns.indexOf('gen');
  const generation = j.rows.reduce((max, row) => Math.max(max, Number(row[gen])), 0);
  return { layout: SCHEMA_VERSION, createdAt, generation, settings: checkedSettings(settings), tables };
}

/** A fresh unopened till may have a lease created by the SDK, its first-run event, and a zero archive cursor.
 * Even one previous money/settings row, archive index entry or recovery event makes the destination ineligible. */
export async function emptyRestoreTarget(db: SqlDriver): Promise<boolean> {
  const initial: Partial<Record<TableName, string>> = {
    journal: "WHERE id!='lease' OR kind!='lease'",
    till_events: "WHERE kind!='created' OR detail!='first run'",
    offline_archive_cursor: 'WHERE id!=1 OR remaining!=0',
  };
  const check = TABLES.map(name => 'SELECT 1 AS used FROM ' + name + ' ' + (initial[name] ?? '')).join(' UNION ALL ');
  return (await db.run(check + ' LIMIT 1')).rows.length === 0;
}

export async function replaceInitialRows(db: SqlDriver, snapshot: BackupRecord, now: number): Promise<void> {
  for (const name of TABLES) {
    const t = snapshot.tables[name];
    const structure = await columnsFor(db, name);
    const cols = structure.map(c => c.name);
    if (t.columns.length !== cols.length || t.columns.some((x, i) => x !== cols[i])) throw badRecord();
    await db.run('DELETE FROM ' + name);
    const insert = 'INSERT INTO ' + name + ' (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')';
    for (const row of t.rows) {
      try { validateBackupRow(name, structure, row); } catch { throw badRecord(); }
      await db.run(insert, row);
    }
  }
  if ((await db.run('SELECT remaining FROM offline_archive_cursor WHERE id=1')).rows.length !== 1) throw badRecord();
  // The device checkpoint is not portable. Do not revive offline signing or a sweep authorization.
  await db.run('DELETE FROM offline_kits');
  await disarmRestoredLightning(db, now);
}
