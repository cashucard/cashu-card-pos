import type { Serial } from './db';
import { SQL } from './sql';
import type { SqlDriver } from './types';

export type TillEventKind =
  | 'created'
  | 'started-new-after-missing'
  | 'used-older-record'
  | 'set-aside'
  | 'stray-files-set-aside'
  | 'generation-empty'
  | 'keep-mismatch'
  /** the record's layout was brought up to date at open (slice 2.3) */
  | 'layout-upgraded'
  /** a notice settle told the merchant (slice 1.3): its key, its payment's id and its words, as JSON */
  | 'notice'
  /** notices the merchant saw: their keys, as a JSON array */
  | 'notice-seen';

export interface TillEvent {
  seq: number;
  at: number;
  kind: TillEventKind;
  detail: string;
}

/** The till's own notes about its store, in the same encrypted file. A detail never holds a token, a key or a PIN. */
export class TillEvents {
  private readonly driver: SqlDriver;
  private readonly serial: Serial;
  private readonly now: () => number;

  constructor(driver: SqlDriver, serial: Serial, now: () => number) {
    this.driver = driver;
    this.serial = serial;
    this.now = now;
  }

  async add(kind: TillEventKind, detail: string): Promise<void> {
    await this.serial(() => this.driver.run(SQL.eventAdd, [this.now(), kind, detail]));
  }

  async list(): Promise<TillEvent[]> {
    const r = await this.serial(() => this.driver.run(SQL.eventList));
    return r.rows.map((x) => ({
      seq: Number(x.seq),
      at: Number(x.at),
      kind: String(x.kind) as TillEventKind,
      detail: String(x.detail),
    }));
  }
}
