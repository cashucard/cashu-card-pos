import type { Serial } from './db';
import { SQL } from './sql';
import type { SqlDriver } from './types';

/** Archived takings: the sum of the prices and how many payments. */
export interface ArchivedTakings {
  sats: number;
  count: number;
}

/** An archived payment as the payment list shows it: never its id, its sale's id, its row or anything else in it. */
export interface ArchivedPayment {
  state: string;
  at: number;
  amount: number;
  fee: number;
  mint: string;
  unit: string;
}

/** The archive's reads (slice 2.3), in the store's one serial lane. Each is SQL over the archive's own columns; no
 * row's body is ever read here. */
export class ArchiveReader {
  private readonly driver: SqlDriver;
  private readonly serial: Serial;

  constructor(driver: SqlDriver, serial: Serial) {
    this.driver = driver;
    this.serial = serial;
  }

  /** The archived takings whose card payment began from `from` to `to` (ms; null: no bound): payments delivered or
   * taken out, never an extra, each once. */
  async takings(from: number | null, to: number | null): Promise<ArchivedTakings> {
    const r = await this.serial(() =>
      this.driver.run(SQL.archiveTakings, [from === null ? 0 : from, to === null ? Number.MAX_SAFE_INTEGER : to]),
    );
    return { sats: Number(r.rows[0]?.sats ?? 0), count: Number(r.rows[0]?.n ?? 0) };
  }

  /** Whether the row of that id was archived. */
  async has(id: string): Promise<boolean> {
    const r = await this.serial(() => this.driver.run(SQL.archiveHas, [id]));
    return r.rows.length > 0;
  }

  /** Every archived payment that took something, oldest first. */
  async payments(): Promise<ArchivedPayment[]> {
    const r = await this.serial(() => this.driver.run(SQL.archivePayments));
    return r.rows.map((x) => ({
      state: String(x.state),
      at: Number(x.at),
      amount: Number(x.amount),
      fee: Number(x.fee ?? 0),
      mint: String(x.mint ?? ''),
      unit: String(x.unit ?? ''),
    }));
  }
}
