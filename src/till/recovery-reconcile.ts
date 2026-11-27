import type { Delivery, HttpFetch, Journal, Payout, Row } from 'cashucard';
import { deliveryProofs, remainingWithdrawal, type TokenAmount } from './wallet';
import { RecoveryActionError } from './recovery-actions';
import { normalizeUrl } from './http';
import type { SqlDriver, SqlValue } from './store/types';

type Apply = (db: SqlDriver) => Promise<void>;

/** A snapshot may precede redemption, including a partially redeemed handoff. Ask
 * the mint for each original proof before allowing the replacement to spend. */
export async function reconcileSnapshot(db: SqlDriver, http: HttpFetch): Promise<Apply> {
  const updates: Array<{ sql: string; args: SqlValue[] }> = [];
  const seenNotes = new Set<string>();
  const entries = (await db.run('SELECT id,mint_norm AS mint,unit,amount,token,body FROM kept WHERE withdrawal IS NULL')).rows;
  const withdrawals = (await db.run('SELECT id,mint,unit,amount,token FROM withdrawals WHERE amount > 0')).rows;
  const handoffs = (await db.run('SELECT payment_id AS id,mint,unit,amount,token FROM extra_handoffs WHERE amount > 0')).rows;

  async function remaining(row: Record<string, SqlValue>): Promise<TokenAmount> {
    const left = await remainingWithdrawal(http, String(row.mint), String(row.unit), {
      token: String(row.token), amount: Number(row.amount),
    });
    if (left.pending) throw new RecoveryActionError('The mint still has a payment pending. Check the backup again after it settles.');
    if (left.amount > 0) {
      for (const proof of deliveryProofs(left, String(row.mint), String(row.unit))) {
        const key = JSON.stringify([normalizeUrl(String(row.mint)), proof.secret]);
        if (seenNotes.has(key)) throw new RecoveryActionError('This backup lists the same available note twice. Keep it and check your latest copy.');
        seenNotes.add(key);
      }
    }
    return left;
  }
  for (const entry of entries) {
    const left = await remaining(entry);
    if (left.amount === entry.amount) continue;
    // Retain the delivery ID even when every note was spent. The SDK may deliver
    // that same ID after a crash; keeping its row makes the retry idempotent.
    if (left.amount === 0) {
      updates.push({ sql: "UPDATE kept SET withdrawal='recovered-spent' WHERE id=? AND token=? AND withdrawal IS NULL",
        args: [entry.id, entry.token] });
    } else {
      const delivery = JSON.parse(String(entry.body)) as Delivery;
      const body = JSON.stringify({ ...delivery, amount: left.amount, token: left.token });
      updates.push({ sql: 'UPDATE kept SET amount=?,token=?,body=? WHERE id=? AND token=? AND withdrawal IS NULL',
        args: [left.amount, left.token, body, entry.id, entry.token] });
    }
  }
  for (const entry of withdrawals) {
    const left = await remaining(entry);
    updates.push({ sql: 'UPDATE withdrawals SET amount=?,token=?,pending=0 WHERE id=? AND token=?',
      args: [left.amount, left.token, entry.id, entry.token] });
  }
  for (const entry of handoffs) {
    const left = await remaining(entry);
    updates.push({ sql: 'UPDATE extra_handoffs SET amount=?,token=? WHERE payment_id=? AND token=?',
      args: [left.amount, left.token, entry.id, entry.token] });
  }
  const payments = (await db.run("SELECT id,body FROM journal WHERE kind='payment'")).rows;
  for (const row of payments) {
    const before = String(row.body);
    const payment: Row = JSON.parse(before);
    if (payment.kind !== 'payment') throw new Error('Invalid payment in backup.');
    if (requireMintCheckForReturn(payment)) {
      updates.push({ sql: 'UPDATE journal SET body=? WHERE id=? AND body=?', args: [JSON.stringify(payment), row.id, before] });
    }
  }
  return async driver => {
    for (const { sql, args } of updates) {
      if ((await driver.run(sql, args)).rowsAffected !== 1) throw new Error('Recovery record changed.');
    }
  };
}

/** On imported cards, an earlier snapshot may predate a successful card write.
 * The SDK requires mint confirmation for each previously attempted LOAD_PROOF. */
function requireMintCheckForReturn(row: Row): boolean {
  if (row.kind !== 'payment') return false;
  let changed = false;
  for (const lot of row.owed ?? []) {
    for (const piece of lot.pieces) {
      if (!piece.written && !piece.tried) {
        piece.tried = true;
        changed = true;
      }
    }
  }
  return changed;
}

/** Restoring an unresolved sale can produce a delivery after the initial mint
 * check. Its original inputs and outputs must not recredit spent merchant notes. */
export function reconciledPayout(payout: Payout, http: HttpFetch,
  requiresMintCheck: (deliveryId: string) => Promise<boolean> = async () => true): Payout {
  return { ...payout, async deliver(delivery) {
    try {
      if (!await requiresMintCheck(delivery.id)) return payout.deliver(delivery);
      const left = await remainingWithdrawal(http, delivery.mint, delivery.unit, delivery);
      if (left.pending) return { kind: 'later', why: 'Mint confirmation pending.' };
      if (!left.amount) return { kind: 'refused', gone: true, why: 'The mint confirmed the notes were already spent.' };
      return payout.deliver({ ...delivery, token: left.token, amount: left.amount });
    } catch {
      return { kind: 'later', why: 'Waiting for the mint to verify the restored notes.' };
    }
  } };
}

export interface RecoveryCopy {
  save(): Promise<void>;
  unavailable(): void;
}

/** SDK journal writes are durable before this hook runs. The SDK awaits the
 * sign-asked write before sending SIGN. A read-back failure there stops the tap.
 * A later failure must preserve the original signed result and recovery intent. */
export function protectedChangeJournal(journal: Journal, recovery: RecoveryCopy, restoredPayments: Set<string>): Journal {
  const milestones = new Map<string, string>();
  return {
    read: id => journal.read(id),
    list: () => journal.list(),
    insert: journal.insert?.bind(journal),
    remove: journal.remove?.bind(journal),
    async write(row) {
      if (restoredPayments.has(row.id)) requireMintCheckForReturn(row);
      await journal.write(row);
      if (row.kind !== 'payment' || !row.plan || row.plan.own.length <= row.plan.ownCount) return;
      const step = row.step;
      if (step !== 'sign-asked' && step !== 'signed' && step !== 'swapped') return;
      const previous = milestones.get(row.id);
      if (step === previous) return;
      // A restarted till still serves existing obligations. Only a newly
      // intercepted signing intent needs durable external proof before it proceeds.
      if (step !== 'sign-asked' && previous === undefined) return;
      try {
        await recovery.save();
        if (step === 'swapped') milestones.delete(row.id);
        else milestones.set(row.id, step);
      } catch {
        recovery.unavailable();
        if (step === 'sign-asked') throw new Error('The recovery copy could not be saved. Review the sale before trying again.');
      }
    },
  };
}
