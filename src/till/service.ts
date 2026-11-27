import { CardError, open as openCashuCard, OFFLINE_LIMITS, offlineExposure, prepareOfflineKit, type CardListener, type CardTransport, type CashuCard, type Config,
  type Delivery, type HttpFetch, type Journal, type Payment, type PaymentState, type Sale } from 'cashucard';
import { createLightningInvoice, checkMintQuote, claimLightningInvoice, LightningPaymentReceived, LightningStatusUnknown, type LightningSaleReceipt } from './lightning-sale';
import { publicLightningReceipt, type LightningSaleRecord } from './store/lightning-sales';
import { normalizeUrl, sameUrl } from './http';
import { PhonePaymentError, phoneRequest, receivePhonePayment, writeExactPhonePayment, type PhonePaymentResult } from './phone-payment';
import { RecoveryActionError, type TillRecoveryActions } from './recovery-actions';
import { protectedChangeJournal, reconciledPayout, reconcileSnapshot } from './recovery-reconcile';
import { checkRestoredWithdrawals } from './recovery-lightning';
import type { TillBackupStore } from './store/backup';
import { toHex } from './hex';
import type { CardReader } from './reader';
import { readOfflineStatus, usableKit } from './store/offline';
import { TopupService } from './topup';
import { createLightningWallet } from './lightning';
import type { CustomerHandoff } from './store/extra-handoffs';
import { activeSatKeysets, checkMint, MintAskError, type MintCheckReport } from './mint-check';
import { tillConfig } from './open';
import { createTillQueue, type JobKind, type TillQueue } from './queue';
import { SALE_MOST } from './sale-machine';
import { acceptedMints, emptySettings, findMint, keepable, loadSettings, MAX_MINTS, MAX_WHY, saveSettings, withMint,
  withoutMint, type MintEntry, type SettingsNames, type TillSettings } from './settings';
import { storeMessage, type StoreMessage } from './store/messages';
import { openStore, type OpenStore, type StoreChoice } from './store/open-store';
import { SalesStoppedError } from './card-errors';
import { heldGeneration, watchedGeneration, type HeldGeneration, type WatchedGeneration } from './store/secret';
import type { StoreDeps, StoreNames } from './store/types';
import { createSettler, eventBook, type SettleNote, type SettleWhy, type ShownNotice, type TillNotice } from './settle';
import type { ArchivedRow, Claim, GenerationStore, SkippedRow } from 'cashucard';
import type { KeptTotal } from './store/keep-store';
import type { WalletReader } from './wallet';
import {
  ARCHIVE_AT,
  ARCHIVE_BITE,
  ARCHIVE_BUSY_MOST,
  ARCHIVE_PAUSE_MS,
  jobReach,
  NO_UNREAD,
  readyCount,
  readySales,
  SALE_OPEN_MOST,
  unreadSales,
  type ArchiveNote,
  type ArchiveProgress,
  type ArchiveWhy,
  type UnreadSales,
} from './archive';
import type { ArchivedPayment, ArchivedTakings, ArchiveReader } from './store/archive';

export const SETTINGS_LOST = "The till's list of mints could not be read. Add your mints again in Settings.";
/** An extra payment in one of these states is still to be made back to its card. */
export const RETURN_STATES: readonly PaymentState[] = ['held', 'returning'];

/** How long the service waits before it asks again after the library answered busy. */
export const BUSY_RETRY_MS = 1000;
/** At most this many sales an earlier run left open are withdrawn at a launch (slice 2.3b); the rest at the next. */
export const LEFT_SALES_MOST = 10;
/** How many new ids a sale's opening draws before it gives up on one the archive does not hold (slice 2.3b). */
export const SALE_ID_TRIES = 5;

/** The handle of a sale this till opened (cashucard 0.3.0). `empty` from sale(id) means its records were archived and
 * taken out (the till asks only for ids it opened): told as `sale-archived`, never as the card's "Nothing to pay
 * with". */
export async function saleOf(c: CashuCard, saleId: string): Promise<Sale> {
  try {
    return await c.sale(saleId);
  } catch (e) {
    if (e instanceof CardError && e.kind === 'empty') {
      throw new CardError('sale-archived', 'This sale is over and its records were archived. Nothing was taken.');
    }
    throw e;
  }
}

/** A sale's id: 's-', the clock in base 36, '-', six base-36 characters of `random()`. Within the library's SALE_ID. */
export function newSaleId(now: number, random: () => number): string {
  return 's-' + now.toString(36) + '-' + Math.floor(random() * 2176782336).toString(36).padStart(6, '0');
}

export type TillPhase =
  | { kind: 'opening' }
  | { kind: 'problem'; message: StoreMessage }
  | { kind: 'closed'; message: StoreMessage }
  | { kind: 'ready'; firstRun: boolean; mints: MintEntry[]; note: string | null; restoring?: true }
  | { kind: 'failed'; why: string };

export interface TillServiceDeps {
  inForeground?: () => boolean;
  writeRecoveryCopy?: (file: string) => Promise<void>;
  store: StoreDeps;
  names: StoreNames;
  settingsNames: SettingsNames;
  /** the mint fetch (Config.http and the mint checks) */
  http: HttpFetch;
  /** the phone's clock, ms */
  now: () => number;
  log: (line: string) => void;
  /** a number in [0, 1) for sale ids; Math.random when not given */
  random?: () => number;
  /** waits ms; a setTimeout promise when not given (tests pass their own) */
  wait?: (ms: number) => Promise<void>;
  /** opens the library; cashucard's open when not given (tests wrap it) */
  openLibrary?: (c: Config) => Promise<CashuCard>;
  /** development only (the bench plan's record faults and fills): wraps the journal handed to the library, and is
   * told whether the archive holds a row of an id (slice 2.3b: the fill never writes an id archived since). A release
   * build never gives it. */
  devJournal?: (j: Journal, archived: (id: string) => Promise<boolean>) => Journal;
  /** development only: wraps the payout's keep. A release build never gives it. */
  devKeep?: (keep: (d: Delivery) => Promise<void>) => (d: Delivery) => Promise<void>;
  /** development only (slice 2.4): wraps the generation store handed to the library, under the till's own watch of
   * it, so a refusal made here stops new sales as a refusal of the phone's secure store does. A release build never
   * gives it. */
  devGeneration?: (g: GenerationStore) => GenerationStore;
  /** archive by itself after a settle (slice 2.3); true when not given. Only the development bench plan turns it off. */
  autoArchive?: boolean;
  /** development only: told each archive job's note ('job') and each run's ('run'): counts and times, never an id or a
   * row. A release build never gives it. */
  onArchive?: (n: ArchiveNote, scope: 'job' | 'run') => void;
}

export class TillNotOpenError extends Error {
  constructor() {
    super('the till is not open');
    this.name = 'TillNotOpenError';
    Object.setPrototypeOf(this, TillNotOpenError.prototype);
  }
}

export class MintInUseError extends Error {
  readonly url: string;
  readonly why: MintRefusal;

  constructor(url: string, why: MintRefusal = 'owed') {
    super('the mint ' + url + ' cannot be removed now: ' + why);
    this.name = 'MintInUseError';
    this.url = url;
    this.why = why;
    Object.setPrototypeOf(this, MintInUseError.prototype);
  }
}

export class MintNotCheckedError extends Error {
  constructor() {
    super('the mint did not pass its check');
    this.name = 'MintNotCheckedError';
    Object.setPrototypeOf(this, MintNotCheckedError.prototype);
  }
}

export class MintListFullError extends Error {
  constructor() {
    super('this till takes at most ' + MAX_MINTS + ' mints');
    this.name = 'MintListFullError';
    Object.setPrototypeOf(this, MintListFullError.prototype);
  }
}

/** The last check-again pass: when it ended, and the mints (their addresses) that did not answer in it. */
export interface RecheckNote {
  at: number;
  unreached: string[];
}

/** Why a mint cannot be removed now. 'owed': money still due to a card, returned on a give-back tap or during a sale.
 * 'unfinished': a card payment that settle or the card's
 * next tap finishes, and that may then owe the card its change (dist/pay.js:1908-1945 writes it when the swap lands). */
export type MintRefusal = 'owed' | 'unfinished' | 'topup';

/** What removing a mint would leave. */
export interface MintRemoval {
  /** why the removal is refused, or null */
  refused: MintRefusal | null;
  /** a payment of the mint the library may never finish: the removal is allowed, with a warning */
  late: boolean;
  /** change owed to a card that the mint never proved: this library never writes it, so it refuses no removal */
  unproved: boolean;
}

/** What removing that mint (sameUrl) would leave, from its payments in the record. Refused while a card is owed money a
 * tap can give it (owedToCard less what is unproved, or an extra not made back yet, RETURN_STATES, except one kept for
 * its customer, why 'date-too-near'), and while a payment is still being taken (`taking`, unless its why is
 * 'bad-signature') or has an open claim (`unrecovered`). Allowed, with a warning, for one the library may never finish
 * (`spent-not-restored`, `lost`, `taking` with why 'bad-signature') and for unproved change. Settle finishes each
 * payment at its own mint, whatever the list (dist/pay.js:299-342). */
export function mintRemoval(payments: readonly Payment[], url: string): MintRemoval {
  let owed = false;
  let unfinished = false;
  let late = false;
  let unproved = false;
  for (const p of payments) {
    if (!sameUrl(p.mint, url)) {
      continue;
    }
    if (p.owedToCard - p.unproved > 0) {
      owed = true;
    }
    if (p.extra !== undefined && RETURN_STATES.includes(p.state) && p.why !== 'date-too-near') {
      owed = true;
    }
    if (p.state === 'unrecovered' || (p.state === 'taking' && p.why !== 'bad-signature')) {
      unfinished = true;
    }
    if (p.state === 'spent-not-restored' || p.state === 'lost' || (p.state === 'taking' && p.why === 'bad-signature')) {
      late = true;
    }
    if (p.unproved > 0) {
      unproved = true;
    }
  }
  return { refused: owed ? 'owed' : unfinished ? 'unfinished' : null, late, unproved };
}

/** Whether removing that mint is refused now (mintRemoval). */
export function mintInUse(payments: readonly Payment[], url: string): boolean {
  return mintRemoval(payments, url).refused !== null;
}

/** The payments a settle paid after their sale had ended unfinished: those the till told "It is paid now. If the
 * customer paid that sale another way too, it is paid twice." (src/till/settle.ts noticeOf, nowPaidWords). Read from
 * the keys of the notices kept (noticeKey: paymentId, state and extra, joined by '|'): only that notice is told for a
 * payment held with no extra, or delivered. Each paymentId once, in the order told. */
export function nowPaidIds(told: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of told) {
    const b = k.lastIndexOf('|');
    const a = b > 0 ? k.lastIndexOf('|', b - 1) : -1;
    if (a <= 0) {
      continue;
    }
    const id = k.slice(0, a);
    const state = k.slice(a + 1, b);
    const extra = k.slice(b + 1);
    if ((state === 'delivered' || (state === 'held' && extra === '')) && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

export interface TillService extends WalletReader {
  readonly recovery: TillRecoveryActions;
  phase(): TillPhase;
  /** l is called with every new phase (not at once); answers the unsubscribe. */
  subscribe(l: (p: TillPhase) => void): () => void;
  open(choice?: StoreChoice): Promise<TillPhase>;
  notNow(): void;
  /** copies of the till's mints ([] before the settings were read) */
  mints(): MintEntry[];
  hasReadyOfflineMint(): Promise<boolean>;
  offlineStatus(mint: string): ReturnType<typeof readOfflineStatus>;
  prepareOffline(mint: string): Promise<void>;
  disableOffline(mint: string): Promise<void>;
  takeOfflineCard(saleId: string, transport: CardTransport, listener: CardListener): Promise<Payment>;
  cardTopups(reader: CardReader): TopupService;
  checkMint(text: string): Promise<MintCheckReport>;
  addMint(report: MintCheckReport): Promise<void>;
  removeMint(url: string): Promise<void>;
  /** what removing that mint would leave (mintRemoval over the record's payments); a read, outside the queue */
  removalOf(url: string): Promise<MintRemoval>;
  recheckMints(): Promise<MintEntry[]>;
  /** the last check-again pass of this run, or null before the first one ends */
  lastRecheck(): RecheckNote | null;
  /** Whether new sales are stopped (slice 2.4, ENG-909 b): the phone's secure store refused the record's generation
   * and has not kept one since. While it holds, openSale rejects with SalesStoppedError; a sale already opened, its
   * card, a withdrawal, settle, the archive and every reading go on. */
  salesStopped(): boolean;
  /** l at every change of salesStopped(), with the new value; answers the unsubscribe */
  onSalesStopped(l: (stopped: boolean) => void): () => void;
  /** a 'sale' job: receive({ id: newSaleId(now(), random), sats }); answers the id. While new sales are stopped it
   * rejects with SalesStoppedError before the queue: nothing is asked of the library, nothing is written. */
  openSale(sats: number, offline?: boolean): Promise<string>;
  /** a 'card' job: the sale's handle asked afresh, then sale.card(transport, listener); busy tried again */
  takeCard(saleId: string, transport: CardTransport, listener: CardListener): Promise<Payment>;
  phoneOffer(saleId: string): Promise<string>;
  takePhonePayment(saleId: string, text: string): Promise<PhonePaymentResult>;
  lightningOffer(saleId: string): Promise<LightningSaleReceipt>;
  checkLightningSale(saleId: string): Promise<LightningSaleReceipt>;
  /** Received invoices for merchant records, including pending issuance and customer returns. */
  listLightningSales(): Promise<LightningSaleReceipt[]>;
  /** a 'close-sale' job: the sale's handle asked afresh, then close(false); answers close's answer */
  withdrawSale(saleId: string): Promise<Payment[]>;
  /** The sale screen let this sale go (New sale pressed, or the screen left) (slice 2.3b): if it is the sale the screen
   * has open, it stops holding the archive back at once, and is withdrawn in a 'close-sale' job when nothing counts for
   * it. Never rejects. */
  leaveSale(saleId: string): Promise<void>;
  /** the payment with that paymentId, or null; a read, outside the queue */
  payment(paymentId: string): Promise<Payment | null>;
  /** a 'settle' job (one waiting at most: a request while one waits joins it); TillNotOpenError before the till is open */
  settleNow(why: SettleWhy): Promise<Payment[]>;
  /** l after every settle that ended, with what it changed ([] when it failed), outside the queue; answers the unsubscribe */
  onPayments(l: (changed: Payment[]) => void): () => void;
  /** what the keep-store holds, by mint and unit: the money delivered into this phone's wallet */
  kept(): Promise<KeptTotal[]>;
  customerHandoffs(checkRedemption?: boolean): Promise<CustomerHandoff[]>;
  customerToken(paymentId: string): Promise<string>;
  /** every payment in the record; a read, outside the queue */
  payments(): Promise<Payment[]>;
  /** the last settle that ended in this run, or null */
  lastSettle(): SettleNote | null;
  /** what settle told the merchant that the merchant has not seen yet */
  notices(): TillNotice[];
  /** the same notices, as Home shows them: their words and tones */
  shownNotices(): ShownNotice[];
  /** the oldest `count` notices were seen (every one when absent): none of them is told again, in any launch */
  noticesSeen(count?: number): void;
  /** every open claim (a card payment whose SIGN went out and whose signature is not had), oldest first; a read, outside
   * the queue */
  openClaims(): Promise<Claim[]>;
  /** the rows of an earlier version, left as they are; a read, outside the queue */
  olderRows(): Promise<SkippedRow[]>;
  /** the rows this version cannot read, left as they are; a read, outside the queue */
  damagedRows(): Promise<SkippedRow[]>;
  /** the paymentIds of the payments the till told the merchant may be paid twice (nowPaidIds over the notices kept in
   * the till's own events); a read, outside the queue */
  maybePaidTwice(): Promise<string[]>;
  /** Archives in 'archive' jobs of the queue, each reaching back to at most ARCHIVE_BITE payments that look final,
   * oldest first, until a job takes nothing or stops; 'auto' starts only once the record holds ARCHIVE_AT payment rows,
   * and stops once it holds fewer. One run at a time: asked while one runs, 'auto' joins it, 'asked' joins an asked one
   * and waits for an auto one, then runs. Rejects only with TillNotOpenError, before the till is open. */
  archiveNow(why: ArchiveWhy): Promise<ArchiveNote>;
  /** the last archive run of this launch that ran at least one job, or null */
  lastArchive(): ArchiveNote | null;
  /** the archived takings whose card payment began from `from` to `to` (ms; null: no bound); a read, outside the queue */
  archivedTakings(from: number | null, to: number | null): Promise<ArchivedTakings>;
  /** whether the payment of that paymentId was archived; a read, outside the queue */
  isArchived(paymentId: string): Promise<boolean>;
  /** every archived payment that took something, oldest first (the payment list); a read, outside the queue */
  archivedPayments(): Promise<ArchivedPayment[]>;
  /** how far the archive run going now has come, or null when none runs (slice 2.3 review) */
  archiveProgress(): ArchiveProgress | null;
  /** l after each job of an archive run that took rows, and null when the run ends; answers the unsubscribe */
  onArchiveProgress(l: (p: ArchiveProgress | null) => void): () => void;
  /** Runs `f`, a reading of the record and the archive, so that no payment is in both or in neither (slice 2.3 review):
   * once outside the queue; when a row moved into the archive meanwhile (the journal's moves()), once more as a 'read'
   * job of the queue, where no archive job runs beside it, and that answer is the one given. Asked while an archive job
   * runs, it is made only as that 'read' job (slice 2.3b). Rejects with TillNotOpenError before the till is open. */
  steady<T>(f: () => Promise<T>): Promise<T>;
  readonly queue: TillQueue;
  withCard<T>(kind: JobKind, f: (c: CashuCard) => Promise<T>): Promise<T>;
  read<T>(f: (c: CashuCard) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** The same entry as far as a check-again cares: when it was checked, its standing and its keysets. */
function sameEntry(a: MintEntry, b: MintEntry): boolean {
  return a.checkedAt === b.checkedAt && a.status === b.status && sameIds(a.keysets, b.keysets);
}

export function createTillService(d: TillServiceDeps): TillService {
  let phase: TillPhase = { kind: 'opening' };
  const listeners: Array<(p: TillPhase) => void> = [];
  let store: OpenStore | null = null;
  const topupReaders = new Map<CardReader, TopupService>();
  let lightning: ReturnType<typeof createLightningWallet> | undefined;
  let card: CashuCard | null = null;
  let writer: Awaited<ReturnType<TillBackupStore['unlockWriter']>> | null = null;
  let restoredIds = new Set<string>();
  let restored = false;
  let quarantined = false;
  function lockWriter() {
    writer?.close();
    writer = null;
  }
  async function checkpoint() {
    if (!writer || !d.writeRecoveryCopy) throw new RecoveryActionError('Unlock the recovery folder in Settings before taking PIN-protected change.');
    await d.writeRecoveryCopy(await writer.write(settings));
  }
  let settings: TillSettings = emptySettings();
  let opening: Promise<TillPhase> | null = null;
  const removingMints = new Set<string>();
  const queue = createTillQueue();
  const lib = d.openLibrary ?? openCashuCard;
  const random = d.random ?? Math.random;
  const wait = d.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** settle in the queue, one waiting at most, busy asked again (src/till/settle.ts) */
  const settler = createSettler({
    job: <T>(f: (c: CashuCard) => Promise<T>): Promise<T> =>
      withCard('settle', async (c) => {
        // a generation the secure store refused is handed to it again at every settle (slice 2.4): a till with nothing
        // more to write still gets its generation stored once the store takes it, and new sales are taken again
        await watch?.again();
        const out = await f(c);
        // once per launch, in its first settle's job, after the settle (which has written every take a kill cut short
        // as given up): the sales an earlier run left open (slice 2.3b)
        if (!leftLooked) {
          leftLooked = true;
          await withdrawLeft(c);
        }
        return out;
      }),
    wait,
    now: d.now,
    book: () => (store === null ? null : eventBook(store.events)),
  });

  /** After every card job, whatever it answered: one settle, queued behind anything asked meanwhile, never awaited. */
  function afterCard(): void {
    if (isOpen()) {
      settler.settle('after-card').then(
        () => undefined,
        () => undefined,
      );
    }
  }

  function settleNow(why: SettleWhy): Promise<Payment[]> {
    if (!isOpen()) {
      return Promise.reject(new TillNotOpenError());
    }
    // A launch check may have run in airplane mode. Retry it at the next regular
    // foreground settlement instead of waiting the full mint-check interval.
    if ((why === 'front' || why === 'timer') && lastPass && pass === null &&
        (lastPass.unreached.length || retryOffline) && d.now() - lastPass.at >= 60_000) {
      void recheckMints().catch(() => undefined);
    }
    return settler.settle(why);
  }

  function kept(): Promise<KeptTotal[]> {
    if (store === null || quarantined || closing) {
      return Promise.reject(new TillNotOpenError());
    }
    return store.keep.totals();
  }
  /** set while close() runs: nothing new is taken */
  let closing = false;
  /** the check-again pass running now, and the one pass waiting behind it */
  let pass: Promise<MintEntry[]> | null = null;
  let nextPass: Promise<MintEntry[]> | null = null;
  let lastPass: RecheckNote | null = null;
  let retryOffline = false;

  /** The till is open and not closing. */
  function isOpen(): boolean {
    return phase.kind === 'ready' && !quarantined && !closing;
  }

  function copyMints(): MintEntry[] {
    return settings.mints.map((m) => ({
      url: m.url,
      addedAt: m.addedAt,
      checkedAt: m.checkedAt,
      keysets: m.keysets.slice(),
      status: m.status,
      why: m.why,
    }));
  }

  function mints(): MintEntry[] {
    return copyMints();
  }

  function set(p: TillPhase): void {
    phase = p;
    if (p.kind === 'problem' || p.kind === 'closed') {
      d.log('till: ' + p.kind + ' ' + p.message.state);
    } else {
      d.log('till: ' + p.kind);
    }
    for (const l of listeners.slice()) {
      l(p);
    }
  }

  /** the generation store handed to the library opened last; an archive job holds it (slice 2.3 review) */
  let generation: HeldGeneration | null = null;
  /** the same store, watched (slice 2.4): what the secure store refused and has not kept since */
  let watch: WatchedGeneration | null = null;
  /** whether new sales are stopped: the secure store refused the record's generation and has not kept one since */
  let stopped = false;
  const stopListeners: Array<(stopped: boolean) => void> = [];
  /** Told by the watched store after every generation handed to the secure store: kept, or refused. */
  function generationKept(kept: boolean): void {
    if (stopped === !kept) {
      return;
    }
    stopped = !kept;
    d.log(stopped ? 'till: new sales stopped' : 'till: new sales taken again');
    for (const l of stopListeners.slice()) {
      try {
        l(stopped);
      } catch {
        // a listener that throws never changes the till
      }
    }
  }

  /** While an archive job asks archive(), the time the job placed its cut by (slice 2.3b); else null */
  let pinned: number | null = null;
  /** The library's clock: the till's, except while an archive job asks archive(), when it stands at the time the job
   * placed its cut by. archive() reads its clock after its own fence, which on a busy phone is seconds after the till
   * read its own; standing still, the library's cut is exactly the one the till chose, and the job takes exactly the
   * sales the till counted (slice 2.3b). */
  const libraryClock = (): number => (pinned !== null ? pinned : d.now());

  function config(acceptRollback: boolean, s: OpenStore): Config {
    const w = watchedGeneration(d.devGeneration ? d.devGeneration(s.generation) : s.generation, generationKept);
    watch = w;
    const g = heldGeneration(w, (e) =>
      d.store.log("the journal's generation could not be stored outside it after an archive job: " + msg(e)),
    );
    generation = g;
    const journal = d.devJournal ? d.devJournal(s.journal, (id) => s.archive.has(id)) : s.journal;
    const protectedJournal = protectedChangeJournal(journal, { save: checkpoint, unavailable: lockWriter }, restoredIds);
    const config = tillConfig(
      { http: d.http, mints: acceptedMints(settings.mints), now: libraryClock, log: d.store.log, protectedChange: writer !== null },
      { ...protectedJournal, write: row => writeExactPhonePayment(protectedJournal, row) },
      d.devKeep ? { keep: d.devKeep(s.keep.keep), calls: s.keep.calls } : s.keep,
      { generationStore: g, acceptRollback },
    );
    if (restored) {
      config.payout = reconciledPayout(config.payout, d.http, async id => {
        const row = await journal.read(id);
        return row?.kind !== 'delivery' || row.payments.some(paymentId => restoredIds.has(paymentId));
      });
    }
    return config;
  }

  function setupLightning(s: OpenStore) {
    lightning = createLightningWallet({
      ledger: s.lightning, http: d.http, now: d.now,
      newId: () => toHex(d.store.randomBytes(16)),
      acceptsMint: mint => !stopped && !removingMints.has(mint) && settings.mints.some(m => m.status === 'ok' && sameUrl(m.url, mint)),
      inForeground: () => isOpen() && (d.inForeground?.() ?? true),
    });
  }

  async function startStore(choice: StoreChoice | undefined, damaged: boolean): Promise<TillPhase> {
    try {
      const out = await openStore<CashuCard | null>(d.store, d.names, {
        settingsNames: d.settingsNames,
        choice,
        acceptedMints: acceptedMints(settings.mints),
        start: async (s, acceptRollback) => {
          const status = await s.backups.status();
          restored = !!status.recovery;
          quarantined = status.recovery?.phase === 'quarantined';
          if (quarantined) return null;
          restoredIds = restored ? new Set(await s.backups.restoredPaymentIds()) : new Set();
          return lib(config(acceptRollback, s));
        },
      });
      if (out.kind === 'ready') {
        store = out.store;
        if (quarantined) return { kind: 'ready', restoring: true, firstRun: false, mints: [], note: null };
        setupLightning(out.store);
        card = out.value;
        openedHere.clear();
        leftLooked = false;
        return {
          kind: 'ready',
          firstRun: out.firstRun,
          mints: copyMints(),
          note: damaged ? SETTINGS_LOST : null,
        };
      }
      return { kind: 'problem', message: storeMessage(out)! };
    } catch (e) {
      return { kind: 'failed', why: msg(e) };
    }
  }

  async function openOnce(choice?: StoreChoice): Promise<TillPhase> {
    set({ kind: 'opening' });
    let loaded: { settings: TillSettings; damaged: boolean };
    try {
      loaded = await loadSettings(d.store.secure, d.settingsNames);
    } catch (e) {
      const p: TillPhase = {
        kind: 'problem',
        message: storeMessage({ kind: 'secure-store-unavailable', why: msg(e) })!,
      };
      set(p);
      return p;
    }
    settings = loaded.settings;
    const p = await startStore(choice, loaded.damaged);
    set(p);
    return p;
  }

  async function open(choice?: StoreChoice): Promise<TillPhase> {
    if (opening !== null) {
      return opening;
    }
    if (phase.kind === 'ready') {
      return phase;
    }
    const run = openOnce(choice);
    opening = run;
    try {
      return await run;
    } finally {
      opening = null;
    }
  }

  function notNow(): void {
    if (phase.kind === 'problem') {
      set({ kind: 'closed', message: phase.message });
    }
  }

  /** The library opened again over the same store: it holds the journal, the earlier instance is dropped. */
  async function reopen(): Promise<void> {
    if (store === null) {
      throw new TillNotOpenError();
    }
    card = await lib(config(false, store));
  }

  /** The till is open, or TillNotOpenError; after f changed the mints, the phase carries them. Its note stays: the
   * lost-list note is told for the whole run. */
  async function ready(f: () => Promise<void>): Promise<void> {
    if (!isOpen()) {
      throw new TillNotOpenError();
    }
    await f();
    const p = phase;
    if (p.kind === 'ready') {
      set({ ...p, mints: copyMints() });
    }
  }

  /** Network I/O and archive preparation stay outside the NFC job queue. Only
   * the short commit rechecks the currently accepted mint and enrollment. */
  async function refreshOffline(entry: MintEntry): Promise<boolean> {
    const s = store;
    if (!s || !isOpen() || stopped || entry.status !== 'ok') return true;
    try {
      const previous = await s.offline.cached(entry.url);
      if (previous === undefined) return true;
      const kit = usableKit(previous, entry, d.now());
      if (kit && d.now() - kit.prepared < OFFLINE_LIMITS.maxAgeMs / 2) return true;
      const next = await prepareOfflineKit(entry.url, d.http, d.now);
      if (!usableKit(next, entry, d.now())) return false;
      await s.offline.prepareArchive();
      await withCard('reopen', async () => {
        const current = findMint(settings.mints, entry.url);
        if (s === store && !stopped && current && sameEntry(entry, current)) {
          await s.offline.refresh(next, previous);
        }
      });
      return true;
    } catch {
      // Online charging still works if offline keys cannot be prepared.
      return false;
    }
  }

  async function addMint(report: MintCheckReport): Promise<void> {
    if (!isOpen()) {
      throw new TillNotOpenError();
    }
    if (!report.ok) {
      throw new MintNotCheckedError();
    }
    await ready(async () => {
      await queue.run('reopen', async () => {
        const old = findMint(settings.mints, report.url);
        if (old === null && settings.mints.length >= MAX_MINTS) {
          throw new MintListFullError();
        }
        const e: MintEntry = {
          url: report.url,
          addedAt: old ? old.addedAt : d.now(),
          checkedAt: d.now(),
          keysets: [...report.keysets],
          status: 'ok',
          why: null,
        };
        if (!keepable(e)) {
          throw new MintNotCheckedError();
        }
        if (!old) await store!.offline.enable(e.url);
        settings = await saveSettings(d.store.secure, d.settingsNames, settings, withMint(settings.mints, e));
        await reopen();
      });
    });
    const entry = findMint(settings.mints, report.url);
    if (entry && !await refreshOffline(entry)) retryOffline = true;
  }

  async function removalOf(url: string): Promise<MintRemoval> {
    return read(async c => {
      const risk = mintRemoval(await c.payments(), url);
      if (!risk.refused && await store!.lightningSales.hasOpen(url)) return { ...risk, refused: 'unfinished' };
      if (!risk.refused && await store!.topups.hasOpen(normalizeUrl(url)!)) {
        return { ...risk, refused: 'topup' };
      }
      return risk;
    });
  }

  async function removeMint(url: string): Promise<void> {
    if (!isOpen()) {
      throw new TillNotOpenError();
    }
    await ready(async () => {
      await queue.run('reopen', async () => {
        const canonical = normalizeUrl(url)!;
        removingMints.add(canonical);
        try {
          const r = await removalOf(canonical);
          if (r.refused !== null) throw new MintInUseError(url, r.refused);
          await store!.offline.disable(canonical);
          await store!.lightning.disablePolicy(canonical);
          settings = await saveSettings(d.store.secure, d.settingsNames, settings, withoutMint(settings.mints, url));
          await reopen();
        } finally {
          removingMints.delete(canonical);
        }
      });
    });
  }

  /** One pass over the mints: the network only, outside the queue; then one 'reopen' job that saves what the pass found
   * for each mint still on the list as the pass saw it, and opens the library again. */
  async function recheckPass(): Promise<MintEntry[]> {
    if (!isOpen()) {
      throw new TillNotOpenError();
    }
    const found: Array<{ was: MintEntry; next: MintEntry }> = [];
    const unreached: string[] = [];
    for (const m of copyMints()) {
      let listed: string[] | null = null;
      let askFailed = false;
      if (m.status === 'ok') {
        try {
          const answer = await activeSatKeysets(d.http, m.url);
          listed = answer.map((k) => k.id);
          listed.sort();
        } catch (e) {
          if (e instanceof MintAskError && !e.reached) {
            askFailed = true;
          }
        }
      }
      if (askFailed) {
        unreached.push(m.url);
        continue;
      }
      if (m.status === 'ok' && listed !== null && sameIds(listed, m.keysets)) {
        continue;
      }
      const r = await checkMint(d.http, m.url);
      if (!r.reached) {
        unreached.push(m.url);
        continue;
      }
      if (r.ok) {
        found.push({ was: m, next: { ...m, keysets: r.keysets.slice(), checkedAt: d.now(), status: 'ok', why: null } });
      } else {
        const first = r.lines.find((l) => !l.ok);
        found.push({
          was: m,
          next: {
            ...m,
            checkedAt: d.now(),
            status: 'refused',
            why: first === undefined ? '' : first.words.slice(0, MAX_WHY),
          },
        });
      }
    }
    if (found.length > 0) {
      await ready(async () => {
        await queue.run('reopen', async () => {
          let list = settings.mints;
          let kept = 0;
          for (const f of found) {
            const now = findMint(list, f.was.url);
            // removed, added again or checked again since this pass began: left as it now is
            if (now === null || !sameEntry(now, f.was)) {
              continue;
            }
            // an entry the store cannot keep never stops the others
            if (!keepable(f.next)) {
              continue;
            }
            list = withMint(list, f.next);
            kept += 1;
          }
          if (kept === 0) {
            return;
          }
          settings = await saveSettings(d.store.secure, d.settingsNames, settings, list);
          await reopen();
        });
      });
    }
    // Only refresh mints that answered this pass. Re-reading a current kit needs no network.
    const checked = mints().filter(m => m.status === 'ok' && !unreached.includes(m.url));
    retryOffline = false;
    for (const m of checked) if (!await refreshOffline(m)) retryOffline = true;
    lastPass = { at: d.now(), unreached };
    return mints();
  }

  /** Starts a pass now and keeps it as the one running. */
  function startPass(): Promise<MintEntry[]> {
    const run = recheckPass();
    pass = run;
    const done = (): void => {
      if (pass === run) {
        pass = null;
      }
    };
    run.then(done, done);
    return run;
  }

  /** One pass at a time. None running: one starts now. One running: one more runs after it, so the answer is never
   * older than the request. One already waiting: this request joins it. */
  async function recheckMints(): Promise<MintEntry[]> {
    if (!isOpen()) {
      throw new TillNotOpenError();
    }
    if (nextPass !== null) {
      return nextPass;
    }
    if (pass === null) {
      return startPass();
    }
    const behind = pass;
    const waiting = behind
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        nextPass = null;
        return startPass();
      });
    nextPass = waiting;
    return waiting;
  }

  function lastRecheck(): RecheckNote | null {
    return lastPass === null ? null : { at: lastPass.at, unreached: lastPass.unreached.slice() };
  }

  function withCard<T>(kind: JobKind, f: (c: CashuCard) => Promise<T>): Promise<T> {
    if (closing) {
      return Promise.reject(new TillNotOpenError());
    }
    return queue.run(kind, async () => {
      if (card === null || quarantined) {
        throw new TillNotOpenError();
      }
      return f(card);
    });
  }

  async function read<T>(f: (c: CashuCard) => Promise<T>): Promise<T> {
    if (card === null || quarantined || closing) {
      throw new TillNotOpenError();
    }
    return f(card);
  }

  /** Until when a sale counts as open (d.now(), ms; slice 2.3 review): set when a sale, its card or its withdrawal is
   * asked, and again when a card job ends without paying it; cleared when it is paid or withdrawn, or its opening
   * fails. While a sale is open no archive job starts, so its opening waits at most for the job running when it was
   * asked, and its tap for none. A sale left SALE_OPEN_MOST with nothing asked of it stops holding the archive back. */
  let saleOpenUntil = 0;
  function saleAsked(): void {
    saleOpenUntil = d.now() + SALE_OPEN_MOST;
  }
  function saleOver(): void {
    saleOpenUntil = 0;
    currentSale = null;
  }
  /** The sale on the sale screen, which a tap may still pay (slice 2.3 review): set when its opening answers and when
   * its card is asked; cleared when it is paid or withdrawn, or a later opening fails. It does not lapse with time,
   * unlike saleOpenUntil: a merchant may stay on NOT PAID, Try again, for as long as they like. cashucard 0.3.0 never
   * archives it while it is open with nothing counted; when the next sale opens it is withdrawn if nothing counts for
   * it (slice 2.3b). */
  let currentSale: string | null = null;
  // A cancel can arrive while a previously queued invoice poll awaits the mint. Mark that
  // sale before the await returns, then persist abandonment in the FIFO before leave resolves.
  const leavingSales = new Set<string>();
  function saleOpen(): boolean {
    return d.now() < saleOpenUntil;
  }

  /** Withdraws (close(false)) a sale the till has let go of, when nothing counts for it: no payment of it is listed,
   * so each payment row it has took nothing (slice 2.3b). cashucard 0.3.0 never archives an open sale that took
   * nothing, so one left open would stay in the record for good. A sale with a payment the library lists (held,
   * delivered, being taken, a claim its card may have signed, ...) is left as it is: a claim is never lost. So is a sale
   * with an open claim (openClaims()): payments() leaves out a claim the card let go (released), which took nothing yet
   * but may still be signed for. Answers whether it withdrew; never throws (a sale that is over already, or does not
   * read, is left as it is). */
  async function withdrawIfIdle(c: CashuCard, saleId: string): Promise<boolean> {
    try {
      const ln = await store!.lightningSales.abandon(saleId, d.now());
      if (ln?.destination === 'sale') return false;
      if ((await c.payments()).some((p) => p.id === saleId)) {
        return false;
      }
      if ((await c.openClaims()).some((x) => x.sale === saleId)) {
        return false;
      }
      await (await c.sale(saleId)).close(false);
      return true;
    } catch {
      return false;
    }
  }

  function openSale(sats: number, offline = false): Promise<string> {
    if (!Number.isSafeInteger(sats) || sats < 1 || sats > SALE_MOST) {
      return Promise.reject(new CardError('bad-sale', 'A sale is 1 to 1,000,000 sats. Nothing was opened.'));
    }
    // new sales are stopped (slice 2.4): refused here, before the queue, so nothing is asked of the library
    if (stopped) {
      return Promise.reject(new SalesStoppedError());
    }
    saleAsked();
    // the sale the sale screen had open before this one, unless it was paid or withdrawn
    const left = currentSale;
    const job = withCard('sale', async (c) => {
      // new sales may have stopped while this job waited in the queue (slice 2.4 review). Looked at again here, before
      // anything is written and before the library is asked for the sale: no sale row is written and no card is asked.
      if (stopped) {
        throw new SalesStoppedError();
      }
      if (offline) {
        if (sats > OFFLINE_LIMITS.sale) throw new CardError('refused', 'An offline sale can be up to ' + OFFLINE_LIMITS.sale + ' sats.');
        if (!await store!.offline.readyForAny(settings.mints, d.now())) {
          throw new CardError('refused', 'Offline payments need current mint keys. Connect to refresh them or enable your mint in Offline payments.');
        }
        const exposure = offlineExposure(await store!.journal.list());
        if (exposure.payments >= OFFLINE_LIMITS.payments || exposure.sats + sats > OFFLINE_LIMITS.sats) {
          throw new CardError('refused', 'Reconnect to settle pending sales before taking another offline payment.');
        }
        await store!.offline.prepareArchive();
      }
      if (left !== null) {
        await withdrawIfIdle(c, left);
      }
      // never an id the archive holds: cashucard 0.3.0 opens an id again once its sale's row was archived
      let id = newSaleId(d.now(), random);
      for (let k = 1; await archiveReads().has('sale:' + id); k += 1) {
        if (k >= SALE_ID_TRIES) {
          throw new CardError('same-sale', 'A new sale id could not be made. Nothing was opened.');
        }
        id = newSaleId(d.now(), random);
      }
      // a sale of this run, whatever the clock says: never withdrawn by a launch's look at earlier runs' sales
      openedHere.add(id);
      if (offline) {
        await c.receive({ id, sats }, { offline: true });
      } else await c.receive({ id, sats });
      return id;
    });
    job.then(
      (id) => {
        currentSale = id;
      },
      () => saleOver(),
    );
    return job;
  }

  function takeCard(saleId: string, transport: CardTransport, listener: CardListener): Promise<Payment> {
    if (currentSale === saleId) saleAsked();
    const job = withCard('card', async (c) => {
      for (;;) {
        try {
          if (currentSale !== saleId) {
            const paid = await store!.lightningSales.get(saleId);
            if (paid?.destination === 'sale') throw new LightningPaymentReceived(publicLightningReceipt(paid));
          }
          const sale = await saleOf(c, saleId);
          if (currentSale !== saleId) {
            const row = await store!.journal.read('sale:' + saleId);
            if (row?.kind === 'sale' && row.archived) throw new CardError('sale-archived', 'This sale was archived.');
            // A persisted card-only sale can be resumed on launch. A stale UI callback from
            // this run may never revive an abandoned sale or replace another checkout.
            if (currentSale === null && !openedHere.has(saleId) && row?.kind === 'sale' && !row.closed &&
                !await store!.lightningSales.get(saleId) && !(await c.payments()).some(p => p.id === saleId)) {
              currentSale = saleId;
              openedHere.add(saleId);
              saleAsked();
            } else throw new CardError('same-sale', 'This sale has ended. Nothing was taken.');
          }
          await allowCashuTender(c, saleId);
          return await sale.card(transport, {
            ...listener,
            confirm: quote => {
              if (quote.leftover > 0 && !writer) {
                throw new RecoveryActionError('Unlock the recovery folder in Settings before holding change for this card.');
              }
              return listener.confirm(quote);
            },
          });
        } catch (e) {
          if (e instanceof LightningStatusUnknown || !(e instanceof CardError) || e.kind !== 'busy') {
            throw e;
          }
          if (listener.signal?.aborted) {
            throw new CardError('stopped', 'Stopped by the caller before the card was asked anything more.', {
              aborted: true,
            });
          }
          await wait(BUSY_RETRY_MS);
        }
      }
    });
    job.then(
      (p) => {
        // paid: the sale is over; anything else (not paid, tap again) leaves it open for its next step
        if (currentSale !== saleId) return;
        if (p.state === 'held' || p.state === 'delivered' || p.state === 'exported') {
          saleOver();
        } else {
          saleAsked();
        }
      },
      () => { if (currentSale === saleId) saleAsked(); },
    );
    job.then(afterCard, afterCard);
    return job;
  }

  function phoneOffer(saleId: string): Promise<string> {
    return withCard('read', async c => {
      if (currentSale !== saleId) throw new PhonePaymentError('This sale is closed. Start a new sale.');
      return phoneRequest(await saleOf(c, saleId), id => store!.journal.read(id));
    });
  }

  function takePhonePayment(saleId: string, text: string): Promise<PhonePaymentResult> {
    const job = withCard('sale', async (c): Promise<PhonePaymentResult> => {
      if (currentSale !== saleId) return { kind: 'refused', message: 'This sale is closed. Start a new sale.' };
      saleAsked();
      const sale = await saleOf(c, saleId);
      try { await allowCashuTender(c, saleId); } catch {
        return {kind:'refused', message:'Check the Lightning invoice before taking another payment.'};
      }
      const accepted = acceptedMints(settings.mints).filter(mint => !removingMints.has(mint));
      const result = await receivePhonePayment(c, sale, text, accepted, d.http, id => store!.journal.read(id));
      if (result.kind === 'paid' && currentSale === saleId) saleOver();
      return result;
    });
    job.then(result => { if (result.kind !== 'refused') afterCard(); }, afterCard);
    return job;
  }

  function lightningOffer(saleId: string): Promise<LightningSaleReceipt> {
    return withCard('sale', async () => {
      if (currentSale !== saleId || stopped) throw new Error('Start an online sale to show a Lightning invoice.');
      const row = await store!.journal.read('sale:' + saleId);
      if (row?.kind !== 'sale' || row.offline || row.closed || row.archived) throw new Error('Start an online sale to show a Lightning invoice.');
      const saved = await store!.lightningSales.get(saleId);
      if (saved) return publicLightningReceipt(saved);
      const eligible = acceptedMints(settings.mints).filter(m => row.mints.includes(m) && !removingMints.has(m));
      for (const mint of eligible) {
        let r: LightningSaleRecord;
        try { r = await createLightningInvoice(d.http, mint, saleId, row.amount, d.now); }
        catch { continue; }
        if (currentSale !== saleId || closing) throw new Error('The sale has closed.');
        await store!.lightningSales.insert(r);
        return publicLightningReceipt(r);
      }
      throw new Error('Lightning is unavailable for this sale. You can still pay with Cashu.');
    });
  }

  // Every tender decision happens in the same FIFO as NFC and scanned ecash. An invoice can
  // still be paid after its QR is hidden. Record which party owns it before sending an issue.
  async function reconcileInvoice(c: CashuCard, r: LightningSaleRecord): Promise<LightningSaleReceipt> {
    if (r.state === 'paid' || r.state === 'extra') return publicLightningReceipt(r);
    const ledger = store!.lightningSales;
    await ledger.checked(r.saleId, d.now());
    if (r.state !== 'processing') {
      const status = await checkMintQuote(d.http, r);
      if (status === 'UNPAID') {
        if (r.state !== 'expired' && d.now() >= r.expiresAt) {
          r.state = 'expired';
          await ledger.save(r, d.now());
        }
        return publicLightningReceipt(r);
      }
      const row = await store!.journal.read('sale:' + r.saleId);
      const active = row?.kind === 'sale' && !row.closed && !row.archived;
      const occupied = r.abandoned || !active || (await c.payments()).some(p => p.id === r.saleId && !p.extra) ||
        (await c.openClaims()).some(claim => claim.sale === r.saleId);
      r.destination = occupied || leavingSales.has(r.saleId) ? 'return' : 'sale';
      r.state = 'processing';
      r.paidAt = d.now();
      await ledger.save(r, d.now());
      afterCard();
    }
    try {
      if (r.destination === 'sale') {
        const row = await store!.journal.read('sale:' + r.saleId);
        if (row?.kind === 'sale' && !row.closed && !row.archived) await (await c.sale(r.saleId)).close(true);
        if (currentSale === r.saleId) saleOver();
      }
      await claimLightningInvoice(d.http, ledger, r, d.now);
      afterCard();
    } catch {
      // PAID at the mint is conclusive. A missing network reply or locked database never
      // tells the checkout to charge again. The signed quote and original outputs stay durable.
    }
    return publicLightningReceipt(r);
  }

  function checkLightningSale(id: string): Promise<LightningSaleReceipt> {
    return withCard('sale', async c => {
      const r = await store!.lightningSales.get(id);
      if (!r) throw new Error('The saved Lightning invoice was not found.');
      return reconcileInvoice(c, r);
    });
  }

  async function allowCashuTender(c: CashuCard, saleId: string): Promise<void> {
    const r = await store!.lightningSales.get(saleId);
    if (!r) return;
    let checked: LightningSaleReceipt;
    try { checked = await reconcileInvoice(c, r); }
    catch { throw new LightningStatusUnknown(saleId); }
    if (checked.state !== 'unpaid' && checked.state !== 'expired') {
      throw new LightningPaymentReceived(checked);
    }
  }

  let checkingInvoices = false;
  async function recoverInvoices(): Promise<void> {
    if (checkingInvoices || !isOpen()) return;
    checkingInvoices = true;
    try {
      const ids = await store!.lightningSales.due(d.now());
      for (const id of ids) {
        if (!isOpen()) break;
        await checkLightningSale(id).catch(() => undefined);
      }
    } finally { checkingInvoices = false; }
  }

  function withdrawSale(saleId: string): Promise<Payment[]> {
    saleAsked();
    const job = withCard('close-sale', async (c) => {
      try {
        if ((await store!.lightningSales.abandon(saleId, d.now()))?.destination === 'sale') return [];
        return await (await saleOf(c, saleId)).close(false);
      } catch (e) {
        // a sale archived is over already: nothing more is taken for it, as after a withdrawal
        if (e instanceof CardError && e.kind === 'sale-archived') {
          return [];
        }
        throw e;
      }
    });
    job.then(
      () => { if (currentSale === saleId) saleOver(); },
      () => { if (currentSale === saleId) saleAsked(); },
    );
    return job;
  }

  function leaveSale(saleId: string): Promise<void> {
    if (currentSale !== saleId || !isOpen()) {
      return Promise.resolve();
    }
    leavingSales.add(saleId);
    saleOver();
    return withCard('close-sale', async (c) => {
      await withdrawIfIdle(c, saleId);
    }).catch(() => undefined).finally(() => leavingSales.delete(saleId));
  }

  function payment(paymentId: string): Promise<Payment | null> {
    return read(async (c) => (await c.payments()).find((p) => p.paymentId === paymentId) ?? null);
  }

  /** the archive run going now, and why */
  let archiving: { why: ArchiveWhy; run: Promise<ArchiveNote> } | null = null;
  /** how far the archive run going now has come (slice 2.3 review), or null; told to its listeners after each job */
  let progress: ArchiveProgress | null = null;
  const progressListeners: Array<(p: ArchiveProgress | null) => void> = [];
  /** finished payments in the record as the last job found them before it took any (readyCount) */
  let lastReady = 0;
  function tellProgress(p: ArchiveProgress | null): void {
    progress = p === null ? null : { ...p };
    for (const l of progressListeners.slice()) {
      try {
        l(p === null ? null : { ...p });
      } catch {
        // a screen that throws never stops the archive
      }
    }
  }
  let lastArchiveNote: ArchiveNote | null = null;

  function archiveNote(
    why: ArchiveWhy,
    started: number,
    bites: number,
    payments: number,
    rows: number,
    left: number,
    error: string | null,
  ): ArchiveNote {
    const at = d.now();
    return { why, at, ms: Math.max(0, at - started), bites, payments, rows, left, ok: error === null, error };
  }

  function tellArchive(n: ArchiveNote, scope: 'job' | 'run'): void {
    if (d.onArchive === undefined) {
      return;
    }
    try {
      d.onArchive(n, scope);
    } catch {
      // the bench's report is not the till's business
    }
  }

  /** The archive's reads, or TillNotOpenError. */
  function archiveReads(): ArchiveReader {
    if (store === null || quarantined || closing) {
      throw new TillNotOpenError();
    }
    return store.archive;
  }

  /** What the rows the library does not read say of sales, read once per archive run in its first job (slice 2.3b);
   * null before. Such rows appear only from outside (damage, or an earlier version's file); one that appeared during a
   * run would only make its jobs smaller. */
  let runUnread: { ids: Set<string>; sales: UnreadSales } | null = null;

  async function unreadNow(c: CashuCard, s: OpenStore): Promise<{ ids: Set<string>; sales: UnreadSales }> {
    if (runUnread === null) {
      const ids = [...(await c.damagedRows()), ...(await c.olderRows())].map((r) => r.id);
      runUnread = { ids: new Set(ids), sales: ids.length === 0 ? NO_UNREAD : unreadSales(await s.journal.rowsOf(ids)) };
    }
    return runUnread;
  }

  /** One 'archive' job: the sales the library would take, by its own rule (readySales), the oldest up to ARCHIVE_BITE
   * (jobReach), then the library's archive() with its clock standing at the time the cut was placed by, busy asked
   * again. Answers the job's own note; a failure is in the note; null when a sale was open as the job began (it then
   * does nothing: the sale goes first). Rejects only with TillNotOpenError. */
  function archiveBite(why: ArchiveWhy): Promise<ArchiveNote | null> {
    return withCard('archive', async (c) => {
      if (saleOpen()) {
        return null;
      }
      d.log('till: archive');
      const started = d.now();
      const s = store;
      if (s === null) {
        throw new TillNotOpenError();
      }
      // the library's generation sets in this job are kept, and the highest is stored once, at the job's end (secret.ts
      // heldGeneration): the job's only journal writes are archived marks and the lease written again before the first
      // move and after the last (cashucard 0.3.0), each still committed in full before it answers
      const held = generation;
      held?.hold();
      try {
        let got: ArchivedRow[] = [];
        try {
          for (let tries = 1; ; tries += 1) {
            // which sales the library would take, from the record as it is now, read again after a busy answer; the
            // rows the library does not read are left out, and hold back what they may belong to
            const unread = await unreadNow(c, s);
            const facts = (await s.journal.paymentFacts()).filter((f) => !unread.ids.has(f.id));
            const sales = (await s.journal.saleFacts()).filter((x) => !unread.ids.has('sale:' + x.id));
            const ready = readySales(facts, sales, unread.sales);
            lastReady = readyCount(ready);
            const at = d.now();
            const days = jobReach(ready, at, ARCHIVE_BITE);
            if (days === null) {
              break;
            }
            try {
              // the library's clock stands at `at` while it archives: its cut is the one placed here
              pinned = at;
              got = await c.archive(days);
              break;
            } catch (e) {
              if (e instanceof CardError && e.kind === 'busy' && tries < ARCHIVE_BUSY_MOST) {
                await wait(BUSY_RETRY_MS);
                continue;
              }
              throw e;
            } finally {
              pinned = null;
            }
          }
        } catch (e) {
          const left = await s.journal.count('payment').catch(() => 0);
          return archiveNote(why, started, 1, 0, 0, left, e instanceof CardError ? e.kind : 'internal');
        }
        // payment rows only: the library hands back the sales' own rows and the deliveries too, each with its kind
        // (cashucard 0.3.0); a payment row that took nothing (refused, abandoned) is not what the merchant calls a payment
        const payments = got.filter((r) => r.kind === 'payment' && r.state !== 'refused' && r.state !== 'abandoned').length;
        return archiveNote(why, started, 1, payments, got.length, await s.journal.count('payment'), null);
      } finally {
        await held?.release();
      }
    });
  }

  /** The queue is empty and no sale is open. */
  function quietNow(): boolean {
    return queue.running() === null && queue.waiting() === 0 && !saleOpen();
  }

  /** Resolves true once the queue is empty and no sale is open, so that the archive job asked next runs at once and
   * only a sale asked while it runs waits for it; false once the till is closing. While a sale is open it looks again
   * every ARCHIVE_PAUSE_MS. */
  async function quiet(): Promise<boolean> {
    for (;;) {
      if (!isOpen()) {
        return false;
      }
      if (quietNow()) {
        return true;
      }
      await queue.idle();
      if (saleOpen()) {
        await wait(Math.min(ARCHIVE_PAUSE_MS, Math.max(1, saleOpenUntil - d.now())));
      }
    }
  }

  /** Archive jobs one after the other, each its own job (a sale asked meanwhile runs between two of them), until one
   * takes nothing or stops, or ('auto') the record holds fewer than ARCHIVE_AT payment rows. Never rejects. */
  async function archiveRun(why: ArchiveWhy): Promise<ArchiveNote> {
    const started = d.now();
    runUnread = null;
    let bites = 0;
    let payments = 0;
    let rows = 0;
    let left = 0;
    let error: string | null = null;
    for (;;) {
      const s = store;
      if (s === null || !isOpen()) {
        break;
      }
      if (why === 'auto') {
        try {
          left = await s.journal.count('payment');
        } catch {
          break;
        }
        if (left < ARCHIVE_AT) {
          break;
        }
      }
      // the next job waits until the queue is empty and no sale is open: a sale goes first; while it waits for a sale,
      // Records is told so (slice 2.3b)
      const waits = saleOpen();
      if (waits) {
        tellProgress({ archived: payments, left: progress === null ? 0 : progress.left, waiting: true });
      }
      if (!(await quiet())) {
        break;
      }
      if (waits) {
        tellProgress(payments > 0 ? { archived: payments, left: progress === null ? 0 : progress.left } : null);
      }
      // looked at again in the same turn as the job is asked, so no sale can come in between
      if (!quietNow()) {
        continue;
      }
      let n: ArchiveNote | null;
      try {
        n = await archiveBite(why);
      } catch (e) {
        error = e instanceof TillNotOpenError ? 'not-open' : 'internal';
        break;
      }
      if (n === null) {
        // a sale was asked before the job began: the job did nothing; wait for the sale, then go on
        continue;
      }
      tellArchive(n, 'job');
      bites += 1;
      payments += n.payments;
      rows += n.rows;
      left = n.left;
      if (n.rows > 0) {
        // how far the run has come, from its own counts: archived so far, finished payments still in the record
        tellProgress({ archived: payments, left: Math.max(0, lastReady - n.payments) });
      }
      if (!n.ok) {
        error = n.error;
        break;
      }
      // a job that took no row made no progress; one that took only attempts that took nothing did
      if (n.rows === 0 || (why === 'auto' && n.left < ARCHIVE_AT)) {
        break;
      }
    }
    tellProgress(null);
    const note = archiveNote(why, started, bites, payments, rows, left, error);
    if (bites > 0) {
      lastArchiveNote = note;
      tellArchive(note, 'run');
    }
    return note;
  }

  function archiveNow(why: ArchiveWhy): Promise<ArchiveNote> {
    if (!isOpen()) {
      return Promise.reject(new TillNotOpenError());
    }
    const going = archiving;
    if (going !== null) {
      if (going.why === why || why === 'auto') {
        return going.run;
      }
      const after = (): Promise<ArchiveNote> => archiveNow('asked');
      return going.run.then(after, after);
    }
    const run = archiveRun(why);
    archiving = { why, run };
    const done = (): void => {
      if (archiving !== null && archiving.run === run) {
        archiving = null;
      }
    };
    run.then(done, done);
    return run;
  }

  async function steady<T>(f: () => Promise<T>): Promise<T> {
    const s = store;
    if (s === null || quarantined || closing) {
      throw new TillNotOpenError();
    }
    // an archive job runs now: the library answers a reading from the rows it read at the job's start, kept as it moves
    // them (cashucard 0.3.0), so a row whose move has committed may still be among them and be counted twice; such a
    // reading is made in the queue, after the job
    if (queue.running() === 'archive') {
      return withCard('read', () => f());
    }
    const before = s.journal.moves();
    const once = await f();
    if (s.journal.moves() === before) {
      return once;
    }
    // rows moved while it read: again, as a job of the queue (archive jobs are jobs of the queue, so none runs beside it)
    return withCard('read', () => f());
  }

  /** Waits for every job asked before it, refusing any asked after; drops the card, then closes the store. */
  async function close(): Promise<void> {
    closing = true;
    try {
      await Promise.all([...topupReaders.values()].map(topups => topups.close()));
      topupReaders.clear();
      await lightning?.close();
      lightning = undefined;
      await queue.idle();
      lockWriter();
      const s = store;
      store = null;
      card = null;
      phase = { kind: 'opening' };
      await s?.close();
    } finally {
      closing = false;
    }
  }

  // Recovery jobs join the same queue as sales, settings changes, returns and archiving.
  // The database also serializes independent Lightning and top-up writes during a snapshot.
  function recoveryJob<T>(f: (s: OpenStore) => Promise<T>): Promise<T> {
    const target = store;
    if (!target || closing) return Promise.reject(new TillNotOpenError());
    return queue.run('reopen', async () => {
      if (store !== target || closing) throw new TillNotOpenError();
      return f(target);
    });
  }

  const recovery: TillRecoveryActions = {
    status: () => recoveryJob(async s => {
      const info = await s.backups.status();
      return { canRestore: info.canRestore, lastBackupAt: info.lastExportAt, changeEnabled: info.changeEnabled,
        changeUnlocked: writer !== null, restoring: info.recovery?.phase === 'quarantined' };
    }),
    exportFile: passphrase => recoveryJob(s => s.backups.exportFile(passphrase, settings)),
    confirmSaved: file => recoveryJob(async s => {
      await s.backups.confirmExport(file);
      // Changing the manual backup passphrase also requires unlocking checkpoint copies again.
      lockWriter();
      if (!quarantined) await reopen();
    }),
    setChangeEnabled: (enabled, passphrase) => recoveryJob(async s => {
      if (quarantined) throw new RecoveryActionError('Finish restoring this till first.');
      if (!enabled) {
        lockWriter();
        await s.backups.setChangeEnabled(false);
        await reopen();
        return;
      }
      if (!d.writeRecoveryCopy || !passphrase) throw new RecoveryActionError('Choose a recovery folder and enter the backup passphrase.');
      const next = await s.backups.unlockWriter(passphrase);
      try {
        // Verify the chosen destination before allowing this option to affect a quote.
        await d.writeRecoveryCopy(await next.write(settings));
        await s.backups.setChangeEnabled(true);
        lockWriter();
        writer = next;
        await reopen();
      } catch (error) {
        next.close();
        lockWriter();
        throw error;
      }
    }),
    importFile: (file, passphrase) => recoveryJob(async s => {
      // Only a pristine destination can enter restore; do not interrupt an active merchant.
      if (!(await s.backups.status()).canRestore) throw new RecoveryActionError('Choose a fresh till with no mint or payment history.');
      const imported = await s.backups.restoreFile(file, passphrase);
      if (imported.recovery?.phase !== 'quarantined') throw new Error('Import did not enter recovery.');
      quarantined = true;
      restored = true;
      card = null;
      lockWriter();
      set({ kind: 'ready', firstRun: false, mints: [], note: null, restoring: true });
      await lightning?.close();
      lightning = undefined;
    }),
    finishRestore: () => recoveryJob(async s => {
      const info = await s.backups.status();
      if (info.recovery?.phase !== 'quarantined') throw new RecoveryActionError('This till has no recovery check pending.');
      const imported = info.recovery;
      let apply;
      try {
        await checkRestoredWithdrawals(s, d.http, d.now);
        apply = await reconcileSnapshot(s.driver, d.http);
      } catch (error) {
        if (error instanceof RecoveryActionError) throw error;
        throw new RecoveryActionError('The mint could not verify the saved notes. Keep the backup and retry when the mint is reachable.');
      }
      // Idempotent if the app stopped after writing secure settings but before activation.
      if (settings.seq === 0 && imported.mints.length) {
        settings = await saveSettings(d.store.secure, d.settingsNames, settings, imported.mints);
      }
      restoredIds = new Set(await s.backups.restoredPaymentIds());
      await s.backups.activate(imported.id, apply);
      try {
        await reopen();
        setupLightning(s);
        quarantined = false;
        openedHere.clear();
        leftLooked = false;
        set({ kind: 'ready', firstRun: false, mints: copyMints(), note: null });
      } catch {
        set({ kind: 'failed', why: 'The recovery checks passed. Reopen the till to load the verified record.' });
        await s.close();
        store = null;
        throw new RecoveryActionError('The recovery checks passed. Reopen the till to load the verified record.');
      }
    }),
  };

  // after every settle that ended, the till archives by itself once its record is long (slice 2.3)
  /** the sales opened in this run (added inside the opening job, so before any job queued behind it runs), and whether
   * the sales an earlier run left open were looked at */
  const openedHere = new Set<string>();
  let leftLooked = false;

  /** The sales an earlier run of the app left open (killed during a sale, or a version that did not withdraw them),
   * withdrawn when nothing counts for them (withdrawIfIdle's rule), at most LEFT_SALES_MOST, inside the launch's first
   * settle job (slice 2.3b). A sale opened in this run is never touched, and none that a row the library does not read
   * may belong to (such a row may hold its payment); while one such row names no sale, none is withdrawn. Never
   * throws. */
  async function withdrawLeft(c: CashuCard): Promise<void> {
    const s = store;
    if (s === null) {
      return;
    }
    try {
      const ids = [...(await c.damagedRows()), ...(await c.olderRows())].map((r) => r.id);
      const rows = ids.length === 0 ? [] : await s.journal.rowsOf(ids);
      const unread = ids.length === 0 ? NO_UNREAD : unreadSales(rows);
      // a row with no id of its own (the library names it '') or no longer found by it may name any sale: as one
      // that names no sale
      if (unread.unnamed || ids.includes('') || rows.length !== ids.length) {
        return;
      }
      const counted = new Set((await c.payments()).map((p) => p.id));
      // and every sale with an open claim: payments() leaves out a claim the card let go (released)
      for (const x of await c.openClaims()) {
        counted.add(x.sale);
      }
      let n = 0;
      for (const f of await s.journal.saleFacts()) {
        if (n >= LEFT_SALES_MOST) {
          break;
        }
        if (f.closed || f.archived || openedHere.has(f.id) || f.id === currentSale || counted.has(f.id)) {
          continue;
        }
        if (unread.sales.has(f.id) || ids.includes('sale:' + f.id)) {
          continue;
        }
        try {
          const ln = await s.lightningSales.get(f.id);
          if (ln && ln.state !== 'expired') continue;
          await (await c.sale(f.id)).close(false);
          n += 1;
        } catch {
          // left as it is: over already, or its row does not read
        }
      }
    } catch {
      // the record could not be read now: looked at again at the next launch
    }
  }

  settler.onPayments(() => {
    if (isOpen()) void recoverInvoices().catch(() => undefined);
    // Lightning uses durable reservations off the NFC job queue so a slow address cannot hold up a tap.
    if (isOpen() && settler.last()?.ok) void lightning?.tick().catch(() => undefined);
    if (d.autoArchive !== false && isOpen()) {
      archiveNow('auto').then(
        () => undefined,
        () => undefined,
      );
    }
  });

  return {
    recovery,
    phase: () => phase,
    subscribe(l: (p: TillPhase) => void): () => void {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) {
          listeners.splice(i, 1);
        }
      };
    },
    open,
    notNow,
    mints,
    checkMint: (text: string) => checkMint(d.http, text),
    addMint,
    removeMint,
    removalOf,
    recheckMints,
    lastRecheck,
    openSale,
    takeCard,
    phoneOffer,
    takePhonePayment,
    lightningOffer,
    checkLightningSale,
    listLightningSales: () => read(() => store!.lightningSales.list()),
    withdrawSale,
    leaveSale,
    salesStopped: () => stopped,
    onSalesStopped(l: (s: boolean) => void): () => void {
      stopListeners.push(l);
      return () => {
        const i = stopListeners.indexOf(l);
        if (i >= 0) {
          stopListeners.splice(i, 1);
        }
      };
    },
    payment,
    settleNow,
    onPayments: (l: (changed: Payment[]) => void) => settler.onPayments(l),
    kept,
    customerHandoffs: (checkRedemption = false) => read(async () => {
      if (!store) throw new TillNotOpenError();
      const receipts = await store.journal.customerHandoffs();
      if (!checkRedemption || !restored) return receipts;
      for (const receipt of receipts) {
        if (restoredIds.has(receipt.id)) {
          const remaining = await store.journal.checkCustomerHandoff(receipt.id, d.http);
          if (remaining.pending) throw new RecoveryActionError('The mint is still checking this customer return.');
        }
      }
      return store.journal.customerHandoffs();
    }),
    customerToken: (id: string) => withCard('export', async c => {
      if (!store) throw new TillNotOpenError();
      const recipientToken = await store.journal.customerExport(id, async () => {
        const p = (await c.payments()).find(payment => payment.paymentId === id);
        if (!p?.extra || !['held', 'returning', 'returned'].includes(p.state)) {
          throw new Error('This payment has no customer token available.');
        }
        return c.export(id);
      });
      if (!restoredIds.has(id)) return recipientToken;
      const left = await store.journal.checkCustomerHandoff(id, d.http);
      if (left.pending) throw new RecoveryActionError('The mint is still checking this customer return.');
      if (!left.amount) throw new RecoveryActionError('The mint confirmed this customer return has been redeemed.');
      return left.token;
    }),
    hasReadyOfflineMint: () => read(() =>
      store!.offline.readyForAny(settings.mints, d.now())),
    offlineStatus: mint => read(() => readOfflineStatus(store!.offline, store!.journal, mint, findMint(settings.mints, mint), d.now())),
    prepareOffline: mint => withCard('reopen', async () => {
      const accepted = settings.mints.find(m => m.status === 'ok' && sameUrl(m.url, mint));
      if (!accepted || stopped) throw new Error('Add and check this mint before enabling offline payments.');
      const kit = await prepareOfflineKit(accepted.url, d.http, d.now);
      if (!usableKit(kit, accepted, d.now())) throw new Error('This mint changed its keys. Check it again in Mints.');
      await store!.offline.prepareArchive();
      await store!.offline.save(kit);
    }),
    disableOffline: mint => withCard('reopen', () => store!.offline.disable(mint)),
    takeOfflineCard: (id, transport, listener) => takeCard(id, transport, {
      ...listener, archivedOfflineInputs: async (mint, candidates) => {
        if (!store) throw new TillNotOpenError();
        return store.offline.spentInputs(mint, candidates);
      }, offline: async mint => {
        const accepted = settings.mints.find(m => m.status === 'ok' && sameUrl(m.url, mint));
        if (!store || !accepted || stopped) return null;
        return usableKit(await store.offline.cached(accepted.url), accepted, d.now());
      },
    }),
    cardTopups(reader) {
      if (!store || !isOpen()) throw new TillNotOpenError();
      let service = topupReaders.get(reader);
      if (!service) {
        service = new TopupService(store.topups, reader, d.http, mint => isOpen() && !stopped &&
          !removingMints.has(normalizeUrl(mint)!) && settings.mints.some(m => m.status === 'ok' && sameUrl(m.url, mint)),
          action => withCard('card', action));
        topupReaders.set(reader, service);
      }
      return service;
    },
    get lightning() { return lightning; },
    walletBalances: () => read(async () => {
      if (!store) throw new TillNotOpenError();
      const [balances, used] = await Promise.all([store.wallet.balances(), store.lightning.mints()]);
      // A merchant can configure a sweep before the first sale and find a receipt after the last sat leaves.
      const seen = new Set(balances.filter(b => b.unit === 'sat').map(b => b.mint));
      for (const mint of new Set([...used, ...settings.mints.map(m => normalizeUrl(m.url)!)])) {
        if (!seen.has(mint)) balances.push({ mint, unit: 'sat', available: 0, withdrawal: null });
      }
      return balances.sort((a, b) => a.mint.localeCompare(b.mint) || a.unit.localeCompare(b.unit));
    }),
    prepareWithdrawal: (mint, unit) => withCard('export', async () => {
      if (!store) throw new TillNotOpenError();
      await store.wallet.prepare(mint, unit);
    }),
    withdrawalToken: (id) => withCard('export', async () => {
      if (!store) throw new TillNotOpenError();
      return store.wallet.token(id);
    }),
    checkWithdrawal: (id) => withCard('export', async () => {
      if (!store) throw new TillNotOpenError();
      return store.wallet.check(id, d.http);
    }),
    payments: () => read((c) => c.payments()),
    lastSettle: () => settler.last(),
    notices: () => settler.notices(),
    shownNotices: () => settler.shown(),
    noticesSeen: (count?: number) => settler.seen(count),
    openClaims: () => read((c) => c.openClaims()),
    olderRows: () => read((c) => c.olderRows()),
    damagedRows: () => read((c) => c.damagedRows()),
    maybePaidTwice: () =>
      read(async () => {
        const s = store;
        return s === null ? [] : nowPaidIds((await eventBook(s.events).load()).told);
      }),
    archiveNow,
    lastArchive: () => (lastArchiveNote === null ? null : { ...lastArchiveNote }),
    archivedTakings: async (from: number | null, to: number | null) => archiveReads().takings(from, to),
    isArchived: async (paymentId: string) => archiveReads().has(paymentId),
    archivedPayments: async () => archiveReads().payments(),
    steady,
    archiveProgress: () => (progress === null ? null : { ...progress }),
    onArchiveProgress(l: (p: ArchiveProgress | null) => void): () => void {
      progressListeners.push(l);
      return () => {
        const i = progressListeners.indexOf(l);
        if (i >= 0) {
          progressListeners.splice(i, 1);
        }
      };
    },
    queue,
    withCard,
    read,
    close,
  };
}
