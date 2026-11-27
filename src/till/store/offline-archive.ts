import { offlineInputFingerprint } from 'cashucard';
import { normalizeMintInput } from '../mint-check';
import type { SqlDriver, SqlValue } from './types';

const BATCH = 64;

/** Insert inside the caller's archive or backfill transaction. Only a mint-confirmed card swap
 * establishes local evidence. Other payment methods and attempts that took nothing are ignored. */
export async function indexArchivedInputs(driver: SqlDriver, body: SqlValue): Promise<void> {
  if (typeof body !== 'string') throw new Error('Cannot verify the archived card payment.');
  const row = JSON.parse(body);
  if (row?.how !== 'card' || row.step !== 'swapped') return;
  const mint = typeof row.mint === 'string' && normalizeMintInput(row.mint);
  // Historical summary-only records have no input identities to index. Keep the receipt whole.
  if (!mint || !mint.ok || !Array.isArray(row.plan?.inputs) || !row.plan.inputs.length) return;
  const digests: string[] = [];
  for (const input of row.plan.inputs) {
    if (typeof input?.secret !== 'string' || !input.secret.length) throw new Error('Cannot verify the archived card input.');
    digests.push(offlineInputFingerprint(input.secret));
  }
  // A card's signed plan has at most 32 inputs, well below the SQLite bind limit.
  await driver.run(
    'INSERT OR IGNORE INTO offline_spent_inputs(mint,digest) VALUES ' + digests.map(() => '(?,?)').join(','),
    digests.flatMap(digest => [mint.url, digest]),
  );
}

/** Bound memory and commit progress after each batch, so a restart can resume before an offline sale.
 * New payments enter the index atomically as they move from the journal to the archive. */
export async function backfillArchiveBatch(driver: SqlDriver): Promise<boolean> {
  const cursor = (await driver.run('SELECT remaining FROM offline_archive_cursor WHERE id=1')).rows[0];
  if (!cursor || !Number.isSafeInteger(cursor.remaining) || Number(cursor.remaining) < 0) {
    throw new Error('The offline archive could not be checked.');
  }
  if (cursor.remaining === 0) return true;
  await driver.run('BEGIN IMMEDIATE');
  try {
    const { rows } = await driver.run(
      "SELECT rowid, CASE WHEN kind='payment' AND state IN ('delivered','exported') THEN body END AS payment FROM archive WHERE rowid <= ? ORDER BY rowid DESC LIMIT ?",
      [cursor.remaining, BATCH],
    );
    for (const row of rows) if (row.payment !== null) await indexArchivedInputs(driver, row.payment);
    const remaining = rows.length === BATCH ? Number(rows[rows.length - 1].rowid) - 1 : 0;
    await driver.run('UPDATE offline_archive_cursor SET remaining=? WHERE id=1', [remaining]);
    await driver.run('COMMIT');
    return remaining === 0;
  } catch (error) {
    await driver.run('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
