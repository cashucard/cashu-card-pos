import type { Delivery } from 'cashucard';
import { normalizeUrl } from '../http';
import type { Serial } from './db';
import type { TillEvents } from './events';
import { SQL } from './sql';
import type { SqlDriver } from './types';

export interface KeptTotal {
  /** the mint as normalizeUrl writes it */
  mint: string;
  unit: string;
  amount: number;
  count: number;
}

/** Throws new Error('the delivery cannot be kept: ' + what) for a delivery of the wrong shape. */
export function checkDelivery(d: Delivery): void {
  if (typeof d.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(d.id)) {
    throw new Error('the delivery cannot be kept: ' + 'its id');
  }
  if (typeof d.mint !== 'string' || d.mint === '') {
    throw new Error('the delivery cannot be kept: ' + 'its mint');
  }
  if (d.unit !== 'sat' && d.unit !== 'usd') {
    throw new Error('the delivery cannot be kept: ' + 'its unit');
  }
  if (!Number.isSafeInteger(d.amount) || d.amount <= 0) {
    throw new Error('the delivery cannot be kept: ' + 'its amount');
  }
  if (typeof d.token !== 'string' || !d.token.startsWith('cashu')) {
    throw new Error('the delivery cannot be kept: ' + 'its token');
  }
}

/** walletPayout's keep, in the till's database: each delivery id stored once, committed before keep resolves; the first
 * delivery of an id wins. */
export class KeepStore {
  /** every call of keep in this process, in order, duplicates included (copies) */
  readonly calls: Delivery[];

  private readonly driver: SqlDriver;
  private readonly serial: Serial;
  private readonly events: TillEvents;
  private readonly now: () => number;

  constructor(driver: SqlDriver, serial: Serial, events: TillEvents, now: () => number) {
    this.calls = [];
    this.driver = driver;
    this.serial = serial;
    this.events = events;
    this.now = now;
  }

  readonly keep: (d: Delivery) => Promise<void> = async (d: Delivery): Promise<void> => {
    checkDelivery(d);
    const copy = JSON.parse(JSON.stringify(d)) as Delivery;
    this.calls.push(copy);
    const r = await this.serial(() =>
      this.driver.run(SQL.keepInsert, [
        copy.id,
        copy.mint,
        normalizeUrl(copy.mint) ?? copy.mint.toLowerCase(),
        copy.unit,
        copy.amount,
        copy.token,
        JSON.stringify(copy),
        this.now(),
      ]),
    );
    if (r.rowsAffected === 1) {
      return;
    }
    const old = await this.serial(() => this.driver.run(SQL.keepRead, [copy.id]));
    if (old.rows.length === 0) {
      return;
    }
    const kept = JSON.parse(String(old.rows[0].body)) as Delivery;
    if (kept.token !== copy.token || kept.amount !== copy.amount) {
      await this.events.add(
        'keep-mismatch',
        'delivery ' + copy.id + ' came again with a different token or amount; the first is kept',
      );
    }
  };

  async list(): Promise<Delivery[]> {
    const r = await this.serial(() => this.driver.run(SQL.keepList));
    return r.rows.map((x) => JSON.parse(String(x.body)) as Delivery);
  }

  async totals(): Promise<KeptTotal[]> {
    const r = await this.serial(() => this.driver.run(SQL.keepTotals));
    return r.rows.map((x) => ({
      mint: String(x.mint),
      unit: String(x.unit),
      amount: Number(x.amount),
      count: Number(x.n),
    }));
  }
}
