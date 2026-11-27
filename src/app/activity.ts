/* What the Activity screen shows of the record, as plain functions (slice 1.4): which payments are not finished, which
 * money is the merchant's takings, and one line per payment, claim and row. Nothing here reads a token, a key or an id
 * into what it shows. */

import type { Claim, Payment, SkippedRow } from 'cashucard';
import type { LightningSaleReceipt } from '../till/lightning-sale';
import { dateTime, groupDigits, plural, sats } from '../format';
import { paymentWords, SALE_UNREADABLE, waitingForCard } from '../till/payment-words';

/** How many finished payments one page of the list shows. */
export const ACTIVITY_PAGE = 50;

export const ACTIVITY_WORDS = {
  title: 'Activity',
  reading: 'Reading the record.',
  failed: 'The record could not be read now.',
  stale: 'The record could not be read again now. This may not be the latest.',
  again: 'Try again',
  todayLead: 'Paid today: ',
  allLead: 'Paid in this record: ',
  archivedLead: 'Of these, archived: ',
  totalsNote:
    "Only PAID and TAKEN OUT payments count, at their price. A payment being checked, and money that is the customer's, do not.",
  open: 'Not finished',
  claims: 'Open claims',
  claimsHelp: 'A card began each of these and has not finished. Its next tap at this till finishes it.',
  losses: 'Losses',
  payments: 'Payments',
  paymentsNote: 'Sales that took nothing are not listed.',
  rows: 'Rows kept as they are',
  none: 'None.',
  twice: ' · SALE LEFT UNFINISHED: MAY BE PAID TWICE',
  owedLead: 'Change owed to the card, not written yet: ',
  waiting: ' · WAITING FOR THE CARD',
  customers: " · THE CUSTOMER'S MONEY",
} as const;

export const PAYMENT_WORDS = {
  title: 'Payment',
  reading: 'Reading the record.',
  missing: 'This payment is not in the record.',
  archived: 'This payment was archived. It still counts in the totals, and it is in the payment list in Records.',
  failed: 'The record could not be read now. Go back and try again.',
  stale: 'The record could not be read again now. This may not be the latest.',
  customers: "This money is the customer's. It is not counted as takings.",
  feeLead: "The mint's fee: ",
  mintLead: 'Mint: ',
  atLead: 'Card payment of ',
} as const;

/** Takings: the sum of the prices, and how many payments. */
export interface Takings {
  sats: number;
  count: number;
}

/** A loss to the merchant: listed under Losses, never paged, never counted. What the library's losses() lists (the
 * mint's word leaves it unpaid after the card signed: `lost`, `spent-not-restored`, asked of the mint again at every
 * settle), and also a payment whose pieces were spent elsewhere (`gone`, LOST): final, so losses() leaves it out, but
 * money the merchant lost all the same. */
export function isLoss(p: Payment): boolean {
  return p.state === 'lost' || p.state === 'spent-not-restored' || p.state === 'gone';
}

/** Nothing more waits on the till, the mint or the card for it. */
export function isDone(p: Payment): boolean {
  if (p.owedToCard > 0) {
    return false;
  }
  switch (p.state) {
    case 'held':
      // held while its sale's record does not read (slice 2.3b): not finished, it waits for the record
      return p.extra === undefined && p.why !== SALE_UNREADABLE;
    case 'delivered':
    case 'exported':
    case 'gone':
    case 'returned':
      return true;
    default:
      return false;
  }
}

/** Not finished and not a loss: listed in "Not finished", above every page, never paged. */
export function isUnfinished(p: Payment): boolean {
  return !isLoss(p) && !isDone(p);
}

/** The money is the customer's: a payment paid twice or late, one made back for the card, or one taken out for them. */
export function isCustomers(p: Payment): boolean {
  return p.extra !== undefined || p.state === 'returning' || p.state === 'returned';
}

/** The merchant's takings: held, delivered or taken out, and not the customer's. Never a payment being taken. */
export function isTakings(p: Payment): boolean {
  return (p.state === 'held' || p.state === 'delivered' || p.state === 'exported') && !isCustomers(p);
}

/** Each paymentId once (the first met), in the order given. */
export function uniquePayments(pays: readonly Payment[]): Payment[] {
  const seen = new Set<string>();
  const out: Payment[] = [];
  for (const p of pays) {
    if (!seen.has(p.paymentId)) {
      seen.add(p.paymentId);
      out.push(p);
    }
  }
  return out;
}

/** The takings whose card payment began at or after `from` and, when `to` is given, at or before `to` (ms; null: no
 * bound), each payment once. */
export function takings(pays: readonly Payment[], from: number | null, to: number | null = null): Takings {
  let total = 0;
  let count = 0;
  for (const p of uniquePayments(pays)) {
    if (isTakings(p) && (from === null || p.at >= from) && (to === null || p.at <= to)) {
      total += p.amount;
      count += 1;
    }
  }
  return { sats: total, count };
}

/** Local midnight of the day of `now` (the phone's own time zone, as dateTime reads it). */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 'Paid today: 42 sats in 3 payments' */
export function takingsWords(lead: string, t: Takings): string {
  return lead + sats(t.sats) + ' in ' + plural(t.count, 'payment', 'payments');
}

/** '2,100 sats · PAID · 22 Nov 2026, 04:10': the price, the payment's own headline, when its card payment began; then,
 * for the customer's money whose headline does not name the customer already (PAID TWICE, PAID LATE, GOING BACK TO THE
 * CARD, OWED TO THE CARD, WRITTEN TO THE CARD), ACTIVITY_WORDS.customers; and, when `twice` (the till told the merchant
 * this payment's sale was left unfinished and it was paid later, so the sale may be paid twice), ACTIVITY_WORDS.twice. */
export function paymentLine(p: Payment, twice: boolean = false): string {
  const headline = paymentWords(p).headline;
  const customers = isCustomers(p) && !headline.includes('CUSTOMER') ? ACTIVITY_WORDS.customers : '';
  return sats(p.amount) + ' · ' + headline + ' · ' + dateTime(p.at) + customers + (twice ? ACTIVITY_WORDS.twice : '');
}

/** 'Change owed to the card, not written yet: 3 sats': for the merchant's own money (PAID or TAKEN OUT) listed as not
 * finished only because change is still owed to its card, what is unfinished and how much (`owedToCard`, never added
 * to any other figure); null for every other payment. */
export function owedLine(p: Payment): string | null {
  return isTakings(p) && p.owedToCard > 0 ? ACTIVITY_WORDS.owedLead + sats(p.owedToCard) : null;
}

/** '2,100 sats from a card · asked 3 times · started 22 Nov 2026, 04:10': the sale's price, never the card's key; and,
 * when `waiting` (a card payment the record lists as taking that is waiting for this card: waitingForCard),
 * ACTIVITY_WORDS.waiting after it. */
export function claimLine(c: Claim, waiting: boolean = false): string {
  return (
    sats(c.price) +
    ' from a card · asked ' +
    plural(c.asks, 'time', 'times') +
    ' · started ' +
    dateTime(c.at) +
    (waiting ? ACTIVITY_WORDS.waiting : '')
  );
}

export function olderLine(r: SkippedRow): string {
  return 'A row of an earlier version: ' + r.why + '. It is kept as it is.';
}

export function damagedLine(r: SkippedRow): string {
  return 'A row this version cannot read: ' + r.why + '. It is kept as it is.';
}

/** 'Show 50 more' */
export function moreWords(n: number): string {
  return 'Show ' + groupDigits(String(n)) + ' more';
}

/** 'Showing 50 of 1,234 payments.' */
export function shownWords(shown: number, total: number): string {
  return 'Showing ' + groupDigits(String(shown)) + ' of ' + plural(total, 'payment', 'payments') + '.';
}

/** What one reading of the record found, and how long the reading took (ms). */
export type LightningActivity = Pick<LightningSaleReceipt, 'paymentId' | 'amount' | 'state' | 'mint'> & { at: number };

export interface ActivityData {
  lightning?: LightningActivity[];
  payments: Payment[];
  claims: Claim[];
  older: SkippedRow[];
  damaged: SkippedRow[];
  /** the payments the till told the merchant may be paid twice (their sale was left unfinished, they were paid later) */
  twice: string[];
  /** the archive's takings (slice 2.3): today's, up to the reading's own now, and all of them; absent when the reader
   * has no archive */
  archived?: { today: Takings; all: Takings };
  /** the reading's own time (slice 2.3 review): what "today" was counted to, in the record and in the archive alike.
   * The view of this reading uses it, never the time of a later drawing. Absent when the reader has no archive. */
  at?: number;
  ms: number;
}

/** The reads the list needs, and nothing else: the till service has them (none writes, none is a job in its queue). */
export interface ActivityReader {
  listLightningSales?(): Promise<LightningSaleReceipt[]>;
  payments(): Promise<Payment[]>;
  openClaims(): Promise<Claim[]>;
  olderRows(): Promise<SkippedRow[]>;
  damagedRows(): Promise<SkippedRow[]>;
  /** the paymentIds of the notices that said a payment may be paid twice, read from the till's own kept notices */
  maybePaidTwice(): Promise<string[]>;
  /** the archive's takings whose card payment began from `from` to `to` (ms; null: no bound); absent: no archive */
  archivedTakings?(from: number | null, to: number | null): Promise<Takings>;
  /** runs a whole reading so that no payment is read in both the record and the archive, or in neither (the till
   * service's steady); absent: the reading is made as it is */
  steady?<T>(f: () => Promise<T>): Promise<T>;
}

/** What the screen shows, by section. */
export interface ActivityView {
  lightningOpen: LightningActivity[];
  lightningPaid: LightningActivity[];
  lightningMore: number;
  /** payments in the record, each paymentId once */
  count: number;
  /** the record's takings and the archive's, together, each payment once */
  today: Takings;
  all: Takings;
  /** of `all`, what is archived */
  archived: Takings;
  /** every payment not finished, newest first: never paged */
  unfinished: Payment[];
  /** every open claim not listed as a payment, in the library's order (oldest first): never paged */
  claims: Claim[];
  /** every loss, newest first: never paged */
  losses: Payment[];
  /** the finished payments on the pages shown, newest first */
  done: Payment[];
  /** how many finished payments in all */
  doneTotal: number;
  /** how many the next page adds (0: none left) */
  more: number;
  older: SkippedRow[];
  damaged: SkippedRow[];
  /** the paymentIds in the record that the till told may be paid twice: their rows say so */
  twice: string[];
  /** the open claims shown that are card payments waiting for their card (waitingForCard): each opens its payment */
  waiting: string[];
}

/** Newest first by when the card payment began; the same time by paymentId, a to z. A new array. */
export function newestFirst(pays: readonly Payment[]): Payment[] {
  return pays.slice().sort((a, b) => {
    if (a.at !== b.at) {
      return b.at - a.at;
    }
    return a.paymentId < b.paymentId ? -1 : a.paymentId > b.paymentId ? 1 : 0;
  });
}

/** The list's rule. `pages` below 1 or not a whole number is 1. `now` sets what "today" is. */
export function activityView(d: ActivityData, pages: number, now: number): ActivityView {
  // a card payment waiting for its card is shown once, as its open claim, never as a payment being checked
  const waiting = new Set(d.payments.filter((p) => waitingForCard(p, d.claims)).map((p) => p.paymentId));
  const all = uniquePayments(d.payments).filter((p) => !waiting.has(p.paymentId));
  const page = Number.isSafeInteger(pages) && pages >= 1 ? pages : 1;
  const listed = new Set(all.map((p) => p.paymentId));
  const doneAll = newestFirst(all.filter(isDone).filter((p) => !isLoss(p)));
  const shown = Math.min(doneAll.length, page * ACTIVITY_PAGE);
  // an archived payment is in the archive only, never also in the record: the two are added, never merged
  const none: Takings = { sats: 0, count: 0 };
  const archivedToday = d.archived === undefined ? none : d.archived.today;
  const archivedAll = d.archived === undefined ? none : d.archived.all;
  const liveToday = takings(all, startOfDay(now), now);
  const liveAll = takings(all, null);
  const lightning = (d.lightning ?? []).slice().sort((a, b) => b.at - a.at);
  const paid = lightning.filter(row => row.state === 'paid');
  const dayStarts = startOfDay(now);
  for (const row of paid) {
    liveAll.sats += row.amount;
    liveAll.count++;
    if (row.at >= dayStarts && row.at <= now) {
      liveToday.sats += row.amount;
      liveToday.count++;
    }
  }
  return {
    lightningOpen: lightning.filter(row => row.state === 'processing' || row.state === 'extra'),
    lightningPaid: paid.slice(0, page * ACTIVITY_PAGE),
    lightningMore: Math.min(ACTIVITY_PAGE, Math.max(0, paid.length - page * ACTIVITY_PAGE)),
    count: all.length + lightning.length,
    today: { sats: liveToday.sats + archivedToday.sats, count: liveToday.count + archivedToday.count },
    all: { sats: liveAll.sats + archivedAll.sats, count: liveAll.count + archivedAll.count },
    archived: { sats: archivedAll.sats, count: archivedAll.count },
    unfinished: newestFirst(all.filter(isUnfinished)),
    claims: d.claims.filter((c) => !listed.has(c.id)),
    losses: newestFirst(all.filter(isLoss)),
    done: doneAll.slice(0, shown),
    doneTotal: doneAll.length,
    more: Math.min(ACTIVITY_PAGE, doneAll.length - shown),
    older: d.older.slice(),
    damaged: d.damaged.slice(),
    twice: d.twice.filter((id, i) => listed.has(id) && d.twice.indexOf(id) === i),
    waiting: d.claims.filter((c) => waiting.has(c.id)).map((c) => c.id),
  };
}

/** Reads the record, in this order, one read after the other: payments, open claims, older rows, damaged rows (the
 * journal, four times), then the kept notices that said a payment may be paid twice (the till's own events), then the
 * archive's takings today and in all when the reader has an archive. The whole reading is one steady reading when the
 * reader gives one (slice 2.3 review). A read that fails is passed on. */
export async function readActivity(r: ActivityReader, clock: () => number): Promise<ActivityData> {
  const once = (): Promise<ActivityData> => readActivityOnce(r, clock);
  return r.steady === undefined ? once() : r.steady(once);
}

async function readActivityOnce(r: ActivityReader, clock: () => number): Promise<ActivityData> {
  const t0 = clock();
  const payments = await r.payments();
  const claims = await r.openClaims();
  const older = await r.olderRows();
  const damaged = await r.damagedRows();
  const twice = await r.maybePaidTwice();
  // Ordinary unscanned invoice offers are not transactions. Keep invoice strings out of the screen's state.
  const lightning = r.listLightningSales ? (await r.listLightningSales())
    .filter(row => row.state === 'paid' || row.state === 'extra' || row.state === 'processing')
    .map(row => ({ paymentId: row.paymentId, state: row.state, amount: row.amount, mint: row.mint, at: row.paidAt ?? row.createdAt })) : undefined;
  const records = { payments, claims, older, damaged, twice, ...(lightning ? { lightning } : {}) };
  if (r.archivedTakings === undefined) {
    return { ...records, ms: Math.max(0, clock() - t0) };
  }
  // then the archive (slice 2.3): today's takings up to now, and all of them
  const now = clock();
  const archived = { today: await r.archivedTakings(startOfDay(now), now), all: await r.archivedTakings(null, null) };
  return { ...records, archived, at: now, ms: Math.max(0, clock() - t0) };
}

/** What the bench is told after each reading (development only): counts, totals and the reading's time. Never a token,
 * a key, an id or a row. */
export interface ActivityReport {
  at: number;
  ms: number;
  payments: number;
  unfinished: number;
  claims: number;
  losses: number;
  done: number;
  shown: number;
  older: number;
  damaged: number;
  today: Takings;
  all: Takings;
}
export const ACTIVITY_REPORT_KEYS: readonly string[] = ['at', 'ms', 'payments', 'unfinished', 'claims', 'losses', 'done',
  'shown', 'older', 'damaged', 'today', 'all'];

export function activityReport(at: number, d: ActivityData, v: ActivityView): ActivityReport {
  return {
    at,
    ms: d.ms,
    payments: v.count,
    unfinished: v.unfinished.length,
    claims: v.claims.length,
    losses: v.losses.length,
    done: v.doneTotal,
    shown: v.done.length,
    older: v.older.length,
    damaged: v.damaged.length,
    today: { sats: v.today.sats, count: v.today.count },
    all: { sats: v.all.sats, count: v.all.count },
  };
}

/** The screen's own state: reading the first time; shown (stale once a later reading failed); failed with nothing to show. */
export type ActivityState =
  | { kind: 'reading' }
  | { kind: 'shown'; data: ActivityData; stale: boolean }
  | { kind: 'failed' };
export type ActivityEvent = { type: 'read'; data: ActivityData } | { type: 'fail' } | { type: 'again' };
export const ACTIVITY_START: ActivityState = { kind: 'reading' };

export function activityStep(s: ActivityState, e: ActivityEvent): ActivityState {
  switch (e.type) {
    case 'read':
      return { kind: 'shown', data: e.data, stale: false };
    case 'fail':
      return s.kind === 'shown' ? { kind: 'shown', data: s.data, stale: true } : { kind: 'failed' };
    case 'again':
      return s.kind === 'failed' ? { kind: 'reading' } : s;
  }
}
