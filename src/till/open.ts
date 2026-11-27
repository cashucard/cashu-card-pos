import {
  MemoryJournal,
  open,
  walletPayout,
  type CashuCard,
  type Config,
  type Delivery,
  type GenerationStore,
  type HttpFetch,
  type Journal,
} from 'cashucard';
import { memoryKeep } from './keep';

/** All ephemeral and unconfigured tills require exact payment or card-made change. */
export const LEFTOVER_BY_PIN = false;

export interface TillOptions {
  /** the fetch for mints (Config.http) */
  http: HttpFetch;
  /** the mints this till takes, by their https names */
  mints: string[];
  /** Enabled only when a merchant has unlocked a verified recovery destination. */
  protectedChange?: boolean;
  /** the till's clock, ms (tests) */
  now?: () => number;
  /** where the library's own lines go (a generation that could not be stored, a payout that refused) */
  log?: (line: string) => void;
}

/** What a till's keep gives: walletPayout's keep, and every call it had in this process. */
export interface TillKeep {
  readonly keep: (d: Delivery) => Promise<void>;
  readonly calls: Delivery[];
}

/** The store's generation store and the merchant's acceptRollback, for a till over the real store. */
export interface StoreConfig {
  generationStore: GenerationStore;
  acceptRollback: boolean;
}

export interface OpenTill {
  cashuCard: CashuCard;
  journal: Journal;
  keep: TillKeep;
}

/** The library's config for this till: the journal, the wallet payout over the keep, the http and no clock. */
export function tillConfig(o: TillOptions, journal: Journal, keep: TillKeep, store?: StoreConfig): Config {
  const c: Config = {
    journal,
    payout: walletPayout({ mints: o.mints, keep: keep.keep }),
    http: o.http,
    leftoverByPin: o.protectedChange ?? LEFTOVER_BY_PIN,
    clock: null,
  };
  if (o.now !== undefined) {
    c.now = o.now;
  }
  if (o.log !== undefined) {
    c.log = o.log;
  }
  if (store !== undefined) {
    c.generationStore = store.generationStore;
    c.acceptRollback = store.acceptRollback;
  }
  return c;
}

/** Open the till over a fresh in-memory journal and keep. */
export async function openTill(o: TillOptions): Promise<OpenTill> {
  const journal = new MemoryJournal();
  const keep = memoryKeep();
  const cashuCard = await open(tillConfig(o, journal, keep));
  return { cashuCard, journal, keep };
}
