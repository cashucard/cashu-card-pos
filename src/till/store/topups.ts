import type { TopupKeys, TopupOutput, TopupPiece, LoadCheckpoint } from 'cashucard';
import { normalizeUrl } from '../http';
import type { Serial } from './db';
import type { SqlDriver } from './types';

export type TopupState = 'invoice' | 'issuing' | 'ready' | 'loaded' | 'expired';
export const TOPUP_HISTORY_PAGE = 8;
export function topupIsOpen(r: TopupReceipt): boolean {
  return r.state !== 'expired' && r.state !== 'loaded';
}
export interface TopupReceipt {
  id: string;
  cardKey: string;
  mint: string;
  amount: number;
  total: number;
  invoice: string;
  expiresAt: number;
  state: TopupState;
  createdAt: number;
}
export interface TopupRecord extends TopupReceipt {
  group: string;
  lock: string;
  pubkey: string;
  keys: TopupKeys;
  /** Earlier keysets for the very same blinded messages if this paid quote crossed a mint rotation. */
  earlierKeys?: TopupKeys[];
  quote: string;
  outputs: TopupOutput[];
  pieces?: TopupPiece[];
  attempts: Record<string, LoadCheckpoint>;
  delivered: string[];
  revision: number;
}
export const TOPUP_SCHEMA = [
  'CREATE TABLE card_topups (id TEXT PRIMARY KEY NOT NULL, card TEXT NOT NULL, mint TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL)',
  "CREATE INDEX card_topup_open ON card_topups(card) WHERE state IN ('invoice','issuing','ready')",
];

export function topupReceipt(r: TopupRecord): TopupReceipt {
  return {
    id: r.id,
    cardKey: r.cardKey,
    mint: r.mint,
    amount: r.amount,
    total: r.total,
    invoice: r.invoice,
    expiresAt: r.expiresAt,
    state: r.state,
    createdAt: r.createdAt,
  };
}

export class TopupStore {
  constructor(
    private db: SqlDriver,
    private serial: Serial,
  ) {}
  async insert(r: TopupRecord): Promise<void> {
    const result = await this.serial(() =>
      this.db.run(
        "INSERT INTO card_topups(id,card,mint,state,revision,created_at,body) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM card_topups WHERE card=? AND state NOT IN ('expired','loaded'))",
        [r.id, r.cardKey, normalizeUrl(r.mint), r.state, r.revision, r.createdAt, JSON.stringify(r), r.cardKey],
      ),
    );
    if (result.rowsAffected !== 1) throw new Error('Open the existing top-up for this card.');
  }
  async get(id: string): Promise<TopupRecord> {
    const { rows } = await this.serial(() => this.db.run('SELECT body FROM card_topups WHERE id=?', [id]));
    if (!rows.length) throw new Error('The saved top-up was not found.');
    return JSON.parse(String(rows[0].body));
  }
  async save(r: TopupRecord): Promise<void> {
    const next = { ...r, revision: r.revision + 1 };
    const result = await this.serial(() =>
      this.db.run('UPDATE card_topups SET body=?,state=?,revision=? WHERE id=? AND revision=?', [
        JSON.stringify(next),
        next.state,
        next.revision,
        r.id,
        r.revision,
      ]),
    );
    if (result.rowsAffected !== 1) throw new Error('The top-up changed. Open its saved receipt again.');
    r.revision = next.revision;
  }
  async list(card?: string): Promise<TopupReceipt[]> {
    // Retain every open obligation. One extra historical receipt supplies the
    // next-page indicator without reading a lifetime of expired invoices.
    const filter = card ? ' AND card=?' : '';
    const params = card ? [card, card] : [];
    const { rows } = await this.serial(() =>
      this.db.run(
        "SELECT body FROM (SELECT body,created_at,id FROM card_topups WHERE state NOT IN ('expired','loaded')" +
          filter +
          " UNION ALL SELECT * FROM (SELECT body,created_at,id FROM card_topups WHERE state IN ('expired','loaded')" +
          filter +
          ' ORDER BY created_at DESC,id DESC LIMIT ?)) ORDER BY created_at DESC,id DESC',
        [...params, TOPUP_HISTORY_PAGE + 1],
      ),
    );
    return rows.map((row) => topupReceipt(JSON.parse(String(row.body))));
  }
  async older(card: string | undefined, before: Pick<TopupReceipt, 'createdAt' | 'id'>): Promise<TopupReceipt[]> {
    const params = card ? [before.createdAt, before.id, card] : [before.createdAt, before.id];
    const { rows } = await this.serial(() =>
      this.db.run(
        "SELECT body FROM card_topups WHERE state IN ('expired','loaded') AND (created_at,id)<(?,?)" +
          (card ? ' AND card=?' : '') + ' ORDER BY created_at DESC,id DESC LIMIT ?',
        [...params, TOPUP_HISTORY_PAGE + 1],
      ),
    );
    return rows.map((row) => topupReceipt(JSON.parse(String(row.body))));
  }
  async hasOpen(mint?: string): Promise<boolean> {
    const { rows } = await this.serial(() =>
      this.db.run(
        "SELECT 1 FROM card_topups WHERE state NOT IN ('loaded','expired')" +
          (mint ? ' AND mint=?' : '') +
          ' LIMIT 1',
        mint ? [normalizeUrl(mint)] : [],
      ),
    );
    return rows.length > 0;
  }
}
