import type { Delivery } from 'cashucard';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { LightningPlan } from '../lightning-transport';
import { normalizeUrl } from '../http';
import { combineDeliveries, type TokenAmount } from '../wallet';
import type { Serial } from './db';
import type { LightningCheckpoint } from './lightning-checkpoint';
import { SQL } from './sql';
import type { SqlDriver, SqlValue } from './types';

export interface SweepPolicy {
  mint: string;
  address: string;
  /** Balance kept at this mint after the maximum fee. */
  threshold: number;
  maxFee: number;
}

export type LightningState = 'quoted' | 'submitted' | 'paid' | 'failed' | 'cancelled';

export interface LightningSummary {
  id: string;
  mint: string;
  address: string;
  amount: number;
  maxFee: number;
  /** Total fee quoted by the mint, including any ecash input fees. */
  quotedFee: number;
  inputAmount: number;
  automatic: boolean;
  state: LightningState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  fee: number | null;
}

/** The additional field holds bearer secrets. It never belongs in UI state, errors or logs. */
export interface LightningRecord extends LightningSummary {
  plan: string;
}

export interface LightningReservation {
  id: string;
  paymentHash: string;
  mint: string;
  address: string;
  amount: number;
  maxFee: number;
  quotedFee?: number;
  automatic: boolean;
  expiresAt: number;
  inputIds: string[];
  plan: string;
}

/** Produced by the transport after checking the original payment and recovering its signed change. */
export interface VerifiedLightningOverage {
  paymentHash: string;
  actualFee: number;
}

type StoreRow = Record<string, SqlValue>;

const SUMMARY = 'id,mint,address,amount,max_fee,quoted_fee,input_amount,automatic,state,created_at,updated_at,expires_at,fee';
const ACTIVE = "state IN ('quoted','submitted')";

function summary(r: StoreRow): LightningSummary {
  return {
    id: String(r.id), mint: String(r.mint), address: String(r.address),
    amount: Number(r.amount), maxFee: Number(r.max_fee), quotedFee: Number(r.quoted_fee), inputAmount: Number(r.input_amount),
    automatic: r.automatic === 1, state: r.state as LightningState, createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at), expiresAt: Number(r.expires_at), fee: r.fee === null ? null : Number(r.fee),
  };
}

function policyOf(r: StoreRow): SweepPolicy {
  return { mint: String(r.mint), address: String(r.address), threshold: Number(r.threshold), maxFee: Number(r.max_fee) };
}

function mintKey(mint: string): string {
  const key = normalizeUrl(mint);
  if (!key?.startsWith('https://')) throw new Error('Invalid payout mint.');
  return key;
}

function nonnegative(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

/** ':' cannot occur in a delivery ID (the existing eCash withdrawal identifier). */
function reservationTag(id: string): string {
  return 'lightning:' + id;
}

export async function disarmRestoredLightning(db: SqlDriver, now: number): Promise<boolean> {
  // The restored quote could have been sent, and the merchant could have revoked the old destination.
  // Keep the inputs and change keys; the mint can establish the outcome without a second POST.
  // Even a still-quoted backup may predate a completed swap and melt. Recover the exact
  // signed outputs first and then check the original payment; the backup cannot send a melt.
  const snapshots = (await db.run(`SELECT id,plan FROM lightning_payouts WHERE ${ACTIVE}`)).rows;
  for (const row of snapshots) {
    const p = JSON.parse(String(row.plan)) as LightningPlan;
    if (p.split) await db.run('UPDATE lightning_payouts SET plan=? WHERE id=?',
      [JSON.stringify({ ...p, reconcileOnly: true }), String(row.id)]);
  }
  const quotes = await db.run("UPDATE lightning_payouts SET state='submitted',updated_at=? WHERE state='quoted'", [now]);
  const policies = await db.run('DELETE FROM lightning_sweeps');
  return quotes.rowsAffected > 0 || policies.rowsAffected > 0;
}

export class LightningStore {
  private revisionChecked = false;

  constructor(private readonly driver: SqlDriver, private readonly serial: Serial, private readonly now: () => number,
    private readonly checkpoint: LightningCheckpoint) {}

  private transaction<T>(body: () => Promise<T>, restored = false): Promise<T> {
    return this.serial(() => this.atomic(body, restored));
  }

  private read<T>(body: () => Promise<T>): Promise<T> {
    return this.serial(() => this.revisionChecked ? body() : this.atomic(body, false));
  }

  private async atomic<T>(body: () => Promise<T>, restored: boolean): Promise<T> {
    await this.driver.run(SQL.begin);
    try {
      if (!this.revisionChecked || restored) await this.checkRevision(restored);
      const result = await body();
      await this.driver.run(SQL.commit);
      this.revisionChecked = true;
      return result;
    } catch (error) {
      this.revisionChecked = false;
      await this.driver.run(SQL.rollback).catch(() => undefined);
      throw error;
    }
  }

  /** Write the device revision before committing a new authorization or dispatch. An interruption then
   * has the same safe outcome as an older database restored on this phone. */
  private async advanceRevision(): Promise<void> {
    const mark = await this.checkpoint.advance();
    await this.driver.run('INSERT OR REPLACE INTO lightning_checkpoint (id,revision) VALUES (1,?)', [mark]);
  }

  private async checkRevision(restored: boolean): Promise<void> {
    const { rows } = await this.driver.run('SELECT revision FROM lightning_checkpoint WHERE id=1');
    const stored = await this.checkpoint.read();
    if (!restored && stored === (rows[0]?.revision ?? null)) return;
    const changed = await disarmRestoredLightning(this.driver, this.now());
    if (rows.length || stored !== null || changed) await this.advanceRevision();
  }

  /** Called when the merchant explicitly opens a restored card journal. */
  disarmRestored(): Promise<void> {
    return this.transaction(async () => {}, true);
  }

  available(mint: string): Promise<Array<TokenAmount & { id: string }>> {
    return this.read(async () => {
      const { rows } = await this.driver.run(
        "SELECT id,amount,token FROM kept WHERE mint_norm=? AND unit='sat' AND withdrawal IS NULL ORDER BY rowid",
        [mintKey(mint)],
      );
      return rows.map(r => ({ id: String(r.id), token: String(r.token), amount: Number(r.amount) }));
    });
  }

  mints(): Promise<string[]> {
    return this.read(async () => (await this.driver.run(
      'SELECT mint FROM lightning_payouts UNION SELECT mint FROM lightning_sweeps ORDER BY mint',
    )).rows.map(r => String(r.mint)));
  }

  policies(): Promise<SweepPolicy[]> {
    return this.read(async () => (await this.driver.run('SELECT * FROM lightning_sweeps ORDER BY mint')).rows.map(policyOf));
  }

  /** Internal only: called under a transaction with all of this payout's deliveries already reserved. */
  private async allowedSweep(mint: string, address: string, amount: number, fee: number, inputs: number): Promise<boolean> {
    const r = (await this.driver.run('SELECT * FROM lightning_sweeps WHERE mint=?', [mint])).rows[0];
    if (!r || r.address !== address || Number(r.max_fee) < fee) return false;
    const { rows } = await this.driver.run(
      "SELECT coalesce(sum(amount),0) AS balance FROM kept WHERE mint_norm=? AND unit='sat' AND withdrawal IS NULL", [mint],
    );
    const after = Number(rows[0].balance) + inputs - amount - fee;
    return nonnegative(after) && after >= Number(r.threshold);
  }

  setPolicy(mint: string, address: string, threshold: number, maxFee: number): Promise<void> {
    return this.transaction(async () => {
      const key = mintKey(mint);
      if (!nonnegative(threshold) || !nonnegative(maxFee) || !address) throw new Error('Invalid sweep settings.');
      await this.cancelAutomaticQuote(key);
      await this.driver.run(
        `INSERT INTO lightning_sweeps (mint,address,threshold,max_fee) VALUES (?,?,?,?)
         ON CONFLICT(mint) DO UPDATE SET address=excluded.address,threshold=excluded.threshold,max_fee=excluded.max_fee`,
        [key, address, threshold, maxFee],
      );
      await this.advanceRevision();
    });
  }

  disablePolicy(mint: string): Promise<void> {
    return this.transaction(async () => {
      const key = mintKey(mint);
      await this.cancelAutomaticQuote(key);
      const result = await this.driver.run('DELETE FROM lightning_sweeps WHERE mint=?', [key]);
      if (result.rowsAffected) await this.advanceRevision();
    });
  }

  private async cancelAutomaticQuote(mint: string): Promise<void> {
    const { rows } = await this.driver.run("SELECT id FROM lightning_payouts WHERE mint=? AND state='quoted' AND automatic=1", [mint]);
    if (rows.length) await this.release(String(rows[0].id), 'quoted', 'cancelled');
  }

  reserve(r: LightningReservation): Promise<void> {
    return this.transaction(async () => {
      const mint = mintKey(r.mint);
      const now = this.now();
      const debit = r.amount + r.maxFee;
      const quotedFee = r.quotedFee ?? r.maxFee;
      if (!r.id || !/^[a-zA-Z0-9_-]{1,64}$/.test(r.id) || !/^[a-f0-9]{64}$/i.test(r.paymentHash)
        || !r.address || !r.plan || !nonnegative(r.amount) || r.amount === 0 || !nonnegative(r.maxFee)
        || !nonnegative(quotedFee) || quotedFee > r.maxFee
        || !Number.isSafeInteger(debit) || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= now
        || !r.inputIds.length || new Set(r.inputIds).size !== r.inputIds.length) {
        throw new Error('Invalid or expired Lightning quote.');
      }
      const tag = reservationTag(r.id);
      for (const id of r.inputIds) {
        const result = await this.driver.run(
          "UPDATE kept SET withdrawal=? WHERE id=? AND mint_norm=? AND unit='sat' AND withdrawal IS NULL", [tag, id, mint],
        );
        if (result.rowsAffected !== 1) throw new Error('Wallet funds changed. Request a new quote.');
      }
      const { rows } = await this.driver.run('SELECT sum(amount) AS total FROM kept WHERE mint_norm=? AND withdrawal=?', [mint, tag]);
      const inputs = Number(rows[0].total);
      if (!nonnegative(inputs) || inputs < debit) throw new Error('This mint balance cannot cover the payment and fees.');
      if (r.automatic && !await this.allowedSweep(mint, r.address, r.amount, r.maxFee, inputs)) {
        throw new Error('The current sweep settings do not allow this payment.');
      }
      // A payment hash remains unique across all mints, even after its bearer plan is erased.
      await this.driver.run(
        `INSERT INTO lightning_payouts
         (id,payment_hash,mint,address,amount,max_fee,quoted_fee,input_amount,input_count,automatic,state,created_at,updated_at,expires_at,plan)
         VALUES (?,?,?,?,?,?,?,?,?,?,'quoted',?,?,?,?)`,
        [r.id, r.paymentHash.toLowerCase(), mint, r.address, r.amount, r.maxFee, quotedFee, inputs, r.inputIds.length,
          r.automatic ? 1 : 0, now, now, r.expiresAt, r.plan],
      );
    });
  }

  private async readRecord(id: string): Promise<LightningRecord | null> {
    const r = (await this.driver.run(`SELECT ${SUMMARY},plan FROM lightning_payouts WHERE id=?`, [id])).rows[0];
    return r ? { ...summary(r), plan: String(r.plan) } : null;
  }

  get(id: string): Promise<LightningRecord | null> {
    return this.read(() => this.readRecord(id));
  }

  active(): Promise<LightningRecord[]> {
    return this.read(async () => (await this.driver.run(
      `SELECT ${SUMMARY},plan FROM lightning_payouts WHERE ${ACTIVE} ORDER BY created_at,rowid`,
    )).rows.map(r => ({ ...summary(r), plan: String(r.plan) })));
  }

  recent(mint: string): Promise<LightningSummary[]> {
    return this.read(async () => (await this.driver.run(
      `SELECT ${SUMMARY} FROM lightning_payouts WHERE mint=? ORDER BY rowid DESC LIMIT 20`, [mintKey(mint)],
    )).rows.map(summary));
  }

  /** Only the caller receiving true may POST a melt. All other callers must query the saved quote. */
  start(id: string, expectedPlan?: string): Promise<boolean> {
    return this.transaction(async () => {
      const r = await this.readRecord(id);
      if (!r || r.state !== 'quoted' || (expectedPlan !== undefined && r.plan !== expectedPlan)) return false;
      if (r.expiresAt <= this.now() || (r.automatic && !await this.allowedSweep(r.mint, r.address, r.amount, r.maxFee, r.inputAmount))) {
        await this.release(id, 'quoted', 'cancelled');
        return false;
      }
      const changed = await this.driver.run(
        "UPDATE lightning_payouts SET state='submitted',updated_at=? WHERE id=? AND state='quoted'", [this.now(), id],
      );
      if (changed.rowsAffected === 1) await this.advanceRevision();
      return changed.rowsAffected === 1;
    });
  }

  /** Commit a recovered zero-fee swap exactly once. Original deliveries stay as spent tombstones
   * so a sale replay cannot restore them. Cancellation releases only the new proofs. */
  finishSplit(id: string, previousPlan: string, next: LightningPlan, replacement: TokenAmount): Promise<boolean> {
    return this.transaction(async () => {
      const row = await this.readRecord(id);
      if (!row || row.state !== 'submitted' || row.plan !== previousPlan) return false;
      const old = JSON.parse(row.plan) as LightningPlan;
      if (!old.split || next.split || old.paymentHash !== next.paymentHash || old.quoteId !== next.quoteId ||
          old.invoice !== next.invoice || old.amount !== next.amount || old.maxFee !== next.maxFee ||
          old.inputAmount !== next.inputAmount || old.reconcileOnly && !next.reconcileOnly) throw new Error('Invalid withdrawal change.');
      const checked = combineDeliveries(row.mint, 'sat', [replacement]);
      if (checked.amount !== row.inputAmount) throw new Error('The internal swap did not conserve the reserved balance.');
      const tag = reservationTag(id);
      const tombstones = await this.driver.run('UPDATE kept SET withdrawal=? WHERE withdrawal=?', ['spent:' + tag, tag]);
      if (tombstones.rowsAffected !== old.inputIds.length) throw new Error('Reserved deliveries changed.');
      const delivery: Delivery = { id: bytesToHex(sha256(utf8ToBytes('lightning/split/' + id))),
        mint: row.mint, unit: 'sat', amount: checked.amount, token: checked.token };
      const inserted = await this.driver.run(SQL.keepInsert, [
        delivery.id, row.mint, row.mint, 'sat', delivery.amount, delivery.token, JSON.stringify(delivery), this.now(),
      ]);
      if (inserted.rowsAffected !== 1) throw new Error('The internal swap already exists.');
      await this.driver.run('UPDATE kept SET withdrawal=? WHERE id=?', [tag, delivery.id]);
      await this.driver.run('UPDATE lightning_payouts SET state=?,input_count=1,plan=?,updated_at=? WHERE id=?',
        [next.reconcileOnly ? 'submitted' : 'quoted', JSON.stringify({ ...next, inputIds: [delivery.id] }), this.now(), id]);
      await this.advanceRevision();
      return true;
    });
  }

  private async release(id: string, from: 'quoted' | 'submitted', to: 'cancelled' | 'failed'): Promise<void> {
    const changed = await this.driver.run(
      "UPDATE lightning_payouts SET state=?,updated_at=?,plan='' WHERE id=? AND state=?", [to, this.now(), id, from],
    );
    if (changed.rowsAffected !== 1) {
      const r = await this.readRecord(id);
      if (r?.state === to) return;
      throw new Error('This withdrawal has already changed.');
    }
    await this.driver.run('UPDATE kept SET withdrawal=NULL WHERE withdrawal=?', [reservationTag(id)]);
  }

  cancel(id: string): Promise<void> {
    return this.transaction(() => this.release(id, 'quoted', 'cancelled'));
  }

  /** Only the caller whose start() succeeded, while it still knows it has never called the transport. */
  abandonBeforePost(id: string): Promise<void> {
    return this.transaction(() => this.release(id, 'submitted', 'cancelled'));
  }

  expireQuotes(): Promise<void> {
    return this.transaction(async () => {
      const { rows } = await this.driver.run("SELECT id FROM lightning_payouts WHERE state='quoted' AND expires_at<=?", [this.now()]);
      for (const r of rows) await this.release(String(r.id), 'quoted', 'cancelled');
    });
  }

  /** Only after the mint confirms an unpaid, expired quote with every selected proof unspent. */
  failed(id: string): Promise<void> {
    return this.transaction(() => this.release(id, 'submitted', 'failed'));
  }

  paid(id: string, change: TokenAmount | null, verifiedOverage?: VerifiedLightningOverage): Promise<void> {
    return this.transaction(async () => {
      const r = await this.readRecord(id);
      if (r?.state === 'paid') return;
      if (r?.state !== 'submitted') throw new Error('This payment was not submitted.');
      const fee = r.inputAmount - r.amount - (change?.amount ?? 0);
      if (!nonnegative(fee)) throw new Error('The mint has not returned the expected change.');
      if (fee > r.quotedFee) {
        // The original cap stays on the receipt. Only the confirmed, irreversible debit can exceed it.
        const { rows } = await this.driver.run('SELECT payment_hash FROM lightning_payouts WHERE id=?', [id]);
        if (verifiedOverage?.actualFee !== fee || verifiedOverage.paymentHash !== rows[0]?.payment_hash) {
          throw new Error('The mint has not returned the expected change.');
        }
      }
      if (change) {
        // Validate currency, mint, nominal value and proof uniqueness on the storage boundary.
        const checked = combineDeliveries(r.mint, 'sat', [change]);
        const delivery: Delivery = {
          id: bytesToHex(sha256(utf8ToBytes('lightning/change/' + id))),
          mint: r.mint, unit: 'sat', amount: checked.amount, token: checked.token,
        };
        const insert = await this.driver.run(SQL.keepInsert, [
          delivery.id, r.mint, r.mint, 'sat', delivery.amount, delivery.token, JSON.stringify(delivery), this.now(),
        ]);
        if (insert.rowsAffected !== 1) throw new Error('This withdrawal change already exists.');
      }
      // Keep the original rows marked spent: the merchant payout adapter may redeliver the same ID.
      await this.driver.run(
        "UPDATE lightning_payouts SET state='paid',fee=?,updated_at=?,plan='' WHERE id=? AND state='submitted'",
        [fee, this.now(), id],
      );
    });
  }
}
