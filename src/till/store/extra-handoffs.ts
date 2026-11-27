import { MemoryJournal, open, walletPayout, type Row } from 'cashucard';
import { SQL } from './sql';
import { cardReference } from '../../app/receipt-reference';
import type { SqlDriver, SqlValue } from './types';

type PaymentRow = Extract<Row, { kind: 'payment' }>;

export interface CustomerHandoff {
  id: string;
  cardRef: string | null;
  mint: string;
  unit: string;
  amount: number;
  at: number;
}

/** The SDK writes 'exported' (and may drop the last card-locked lot) before it returns the token.
 * Run its own local encoding on that one row while its last state is still available. The real
 * export has already checked the mint if necessary. Nothing here can send a request or touch a card. */
async function handoffFor(before: PaymentRow, after: PaymentRow): Promise<{ token: string; amount: number }> {
  const journal = new MemoryJournal();
  let amount: number;
  if (after.proofs?.length) {
    // A held extra, or a return whose inputs the live SDK just verified unspent.
    await journal.write({ ...before, state: 'held', proofs: after.proofs });
    amount = after.proofs.reduce((n, p) => n + p.amount, 0);
  } else {
    // The SDK has just accepted an untouched, card-locked return lot for export.
    const lot = before.owed?.find(l => l.reason === 'extra' && l.state !== 'kept');
    if (before.state !== 'returned' || !lot) throw new Error('The customer return could not be saved.');
    await journal.write(before);
    amount = lot.pieces.reduce((n, p) => n + p.amount, 0);
  }
  const offline = async (): Promise<never> => { throw new Error('This handoff must be encoded locally.'); };
  const encoder = await open({ journal, http: offline, payout: walletPayout({ mints: [], keep: offline }), clock: null });
  return { amount, token: await encoder.export(before.id) };
}

/** Called inside the journal's serial lane. The money can leave the card-return flow only
 * once a redisplayable copy is committed in the same encrypted transaction. */
export async function writeCustomerExport(driver: SqlDriver, row: PaymentRow, params: SqlValue[], now: number): Promise<void> {
  await driver.run(SQL.begin);
  try {
    const prior = (await driver.run(SQL.journalRead, [row.id])).rows[0];
    if (!prior || typeof prior.body !== 'string') throw new Error('Customer payment record unavailable.');
    const before: Row = JSON.parse(prior.body);
    if (before.kind !== 'payment' || !before.extra || before.id !== row.id) throw new Error('Customer payment record unavailable.');
    if (before.state !== 'exported') {
      const handoff = await handoffFor(before, row);
      await driver.run(
        'INSERT INTO extra_handoffs (payment_id, mint, unit, amount, created_at, card_ref, token) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [row.id, row.mint, row.unit, handoff.amount, now, before.card?.key ? cardReference(before.card.key) : null, handoff.token],
      );
    }
    await driver.run(SQL.journalUpsert, params);
    await driver.run(SQL.commit);
  } catch (error) {
    await driver.run(SQL.rollback).catch(() => undefined);
    throw error;
  }
}

export async function handoffIndex(driver: SqlDriver): Promise<CustomerHandoff[]> {
  const r = await driver.run('SELECT payment_id, mint, unit, amount, created_at, card_ref FROM extra_handoffs WHERE amount > 0 ORDER BY created_at DESC, payment_id');
  return r.rows.map(x => ({ id: String(x.payment_id), cardRef: typeof x.card_ref === 'string' ? x.card_ref : null, mint: String(x.mint), unit: String(x.unit), amount: Number(x.amount), at: Number(x.created_at) }));
}

export async function handoffToken(driver: SqlDriver, id: string): Promise<string | null> {
  const r = await driver.run('SELECT token FROM extra_handoffs WHERE payment_id = ?', [id]);
  return typeof r.rows[0]?.token === 'string' ? r.rows[0].token : null;
}
