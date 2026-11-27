import type { SerializedOutputData } from '@cashu/cashu-ts';
import type { LightningSaleReceipt } from '../lightning-sale';
import type { Serial } from './db';
import { normalizeUrl } from '../http';
import { SQL } from './sql';
import type { SqlDriver } from './types';

/** Private recovery intent. The invoice is displayed only after the signing key has reached disk. */
export interface LightningSaleRecord extends LightningSaleReceipt {
  quote: string;
  pubkey: string;
  signingKey?: string;
  outputs?: SerializedOutputData[];
  previousKeysets?: string[];
  destination?: 'sale' | 'return';
  abandoned?: true;
}

export function publicLightningReceipt(r: LightningSaleRecord): LightningSaleReceipt {
  return {
    saleId: r.saleId,
    paymentId: r.paymentId,
    mint: r.mint,
    amount: r.amount,
    invoice: r.invoice,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    state: r.state,
    ...(r.paidAt !== undefined ? { paidAt: r.paidAt } : {}),
  };
}

export class LightningSaleStore {
  constructor(
    private db: SqlDriver,
    private serial: Serial,
  ) {}

  async get(id: string): Promise<LightningSaleRecord | undefined> {
    const data = await this.serial(() => this.db.run('SELECT body FROM lightning_sales WHERE sale=?', [id]));
    if (data.rows.length) return JSON.parse(String(data.rows[0].body));
  }

  async insert(r: LightningSaleRecord): Promise<void> {
    await this.serial(() =>
      this.db.run(
        'INSERT INTO lightning_sales(sale,mint,state,created_at,checked_at,body) VALUES(?,?,?,?,?,?)',
        [r.saleId, r.mint, r.state, r.createdAt, r.createdAt, JSON.stringify(r)],
      ),
    );
  }

  async save(r: LightningSaleRecord, checkedAt: number): Promise<void> {
    await this.serial(() =>
      this.db.run('UPDATE lightning_sales SET state=?,checked_at=?,body=? WHERE sale=?', [
        r.state,
        checkedAt,
        JSON.stringify(r),
        r.saleId,
      ]),
    );
  }

  async abandon(id: string, now: number): Promise<LightningSaleRecord | undefined> {
    const record = await this.get(id);
    if (record && !record.destination && !record.abandoned) {
      record.abandoned = true;
      await this.save(record, now);
    }
    return record;
  }

  async checked(id: string, now: number): Promise<void> {
    await this.serial(() => this.db.run('UPDATE lightning_sales SET checked_at=? WHERE sale=?', [now, id]));
  }

  async due(now: number): Promise<string[]> {
    // Give every open invoice a turn, even if a particular mint keeps timing out.
    // Expired invoices are still checked occasionally for delayed mint reconciliation.
    const r = await this.serial(() =>
      this.db.run(
        "SELECT sale FROM lightning_sales WHERE (state IN ('unpaid','processing') AND checked_at<=?) OR (state='expired' AND checked_at<=?) ORDER BY checked_at,sale LIMIT 3",
        [now - 15_000, now - 24 * 60 * 60 * 1000],
      ),
    );
    return r.rows.map((x) => String(x.sale));
  }

  async list(): Promise<LightningSaleReceipt[]> {
    const r = await this.serial(() =>
      this.db.run("SELECT body FROM lightning_sales WHERE state IN ('processing','paid','extra') ORDER BY created_at DESC,sale"),
    );
    return r.rows.map((x) => publicLightningReceipt(JSON.parse(String(x.body))));
  }

  async hasOpen(mint: string): Promise<boolean> {
    const r = await this.serial(() =>
      this.db.run(
        "SELECT 1 AS present FROM lightning_sales WHERE mint=? AND state IN ('unpaid','processing') LIMIT 1",
        [mint.replace(/\/+$/, '')],
      ),
    );
    return r.rows.length > 0;
  }

  /** Posting proofs and erasing their issue secrets are one transaction even when the app is killed. */
  async post(r: LightningSaleRecord, token: string, now: number): Promise<void> {
    const sale = r.destination === 'sale';
    const end: LightningSaleRecord = { ...r, state: sale ? 'paid' : 'extra' };
    delete end.signingKey;
    delete end.outputs;
    delete end.previousKeysets;
    await this.serial(async () => {
      await this.db.run(SQL.begin);
      try {
        if (sale) {
          const payment = { id: r.paymentId, mint: r.mint, unit: 'sat', amount: r.amount, token };
          const result = await this.db.run(SQL.keepInsert, [
            r.paymentId,
            r.mint,
            normalizeUrl(r.mint) ?? r.mint,
            'sat',
            r.amount,
            token,
            JSON.stringify(payment),
            now,
          ]);
          if (result.rowsAffected !== 1) throw new Error('The previous Lightning receipt needs review.');
        } else {
          await this.db.run(
            "INSERT INTO extra_handoffs(payment_id,mint,unit,amount,created_at,card_ref,token) VALUES(?,?,'sat',?,?,NULL,?)",
            [r.paymentId, r.mint, r.amount, now, token],
          );
        }
        const changed = await this.db.run(
          "UPDATE lightning_sales SET state=?,checked_at=?,body=? WHERE sale=? AND state='processing'",
          [end.state, now, JSON.stringify(end), r.saleId],
        );
        if (changed.rowsAffected !== 1) throw new Error('The Lightning receipt changed.');
        await this.db.run(SQL.commit);
      } catch (e) {
        await this.db.run(SQL.rollback).catch(() => undefined);
        throw e;
      }
    });
    Object.assign(r, end);
  }
}
