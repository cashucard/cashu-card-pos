/* Keeping the live record short (slice 2.3): when the till archives, how far back one archive job reaches, and what the
 * merchant is told. Plain functions; the till service runs them. The card library's archive() decides what may go (only
 * final payments, cashucard dist/pay.js archive); these only choose how far back it is asked to reach. */

import type { Payment } from 'cashucard';
import type { PaymentFacts, SaleFacts, UnreadRow } from './store/journal';
import { dateTime, groupDigits, plural, sats } from '../format';

/** The owner's line: the live record should never hold more payments than this. */
export const RECORD_LINE = 1000;
/** After a settle, the till archives by itself once its record holds this many payment rows. */
export const ARCHIVE_AT = 500;
/** At most this many payment rows (payments, and attempts that took nothing; a sale with none counts as one) go in one
 * archive job (jobReach), so that a sale waits behind one short job only. */
export const ARCHIVE_BITE = 100;
/** How many times one archive job asks again after the library answered busy. */
export const ARCHIVE_BUSY_MOST = 30;
/** A sale counts as open, and holds the archive back, until it is paid or withdrawn, or this long (ms) after the last
 * thing asked of it (slice 2.3 review): a sale left on its screen stops holding the archive back. */
export const SALE_OPEN_MOST = 120000;
/** While a sale is open, an archive run looks again this often (ms) whether it may go on. */
export const ARCHIVE_PAUSE_MS = 1000;

/** One day, ms. */
export const DAY_MS = 86400000;

/** Why an archive runs: by itself after a settle, or asked in Records. */
export type ArchiveWhy = 'auto' | 'asked';

/** One archive run of one or more jobs: counts and times only, never an id, a row or a token. */
export interface ArchiveNote {
  why: ArchiveWhy;
  /** when it ended (ms) and how long it took */
  at: number;
  ms: number;
  /** archive jobs run */
  bites: number;
  /** payments taken out of the record: those that took something (paid, taken out, lost), as "Paid and archived" and
   * the payment list count them; a card attempt that took nothing is in `rows` only */
  payments: number;
  /** rows taken out: the payments, their deliveries and the sales' own rows (cashucard 0.3.0) */
  rows: number;
  /** payment rows the record holds after it */
  left: number;
  ok: boolean;
  /** the library's error kind when it stopped on one ('internal' for any other error), else null */
  error: string | null;
}
export const ARCHIVE_NOTE_KEYS: readonly string[] = ['why', 'at', 'ms', 'bites', 'payments', 'rows', 'left', 'ok', 'error'];

/** From the payment alone, it looks final: delivered or taken out, the merchant's (no extra), nothing owed to the card
 * and nothing written to it unconfirmed. The library decides; this only chooses how far back to ask. */
export function looksFinal(p: Payment): boolean {
  return (
    (p.state === 'delivered' || p.state === 'exported') &&
    p.extra === undefined &&
    p.owedToCard === 0 &&
    p.unconfirmed === 0
  );
}

/** Not used by the till since the review of slice 2.3 (jobReach is, since slice 2.3b): it placed payments by when
 * their rows were last written, so a payment held before its reach and delivered after it went with the job too, and
 * one job could take hundreds. Kept for its tests.
 * The `days` to hand archive() so that it reaches back to the `bite`-th oldest payment that looks final and whose sale
 * has no payment that does not, placed by when its row was last written (`written`, by paymentId: the store's clock,
 * ms). archive() then takes every final sale whose payments began and were held no later than that time and a
 * millisecond. Null when no payment qualifies, or `bite` is below 1. Never below 0: a clock put back asks up to now. */
export function archiveDays(
  pays: readonly Payment[],
  written: ReadonlyMap<string, number>,
  now: number,
  bite: number,
): number | null {
  const open = new Set<string>();
  for (const p of pays) {
    if (!looksFinal(p)) {
      open.add(p.id);
    }
  }
  const times: number[] = [];
  for (const p of pays) {
    const t = written.get(p.paymentId);
    if (looksFinal(p) && !open.has(p.id) && t !== undefined) {
      times.push(t);
    }
  }
  if (times.length === 0 || bite < 1) {
    return null;
  }
  times.sort((a, b) => a - b);
  const cut = times[Math.min(bite, times.length) - 1];
  return Math.max(0, (now - cut - 1) / DAY_MS);
}

/* ---- cashucard 0.3.0's archive rule, as the till must know it to size a job (slice 2.3b) ----
 * archive() takes a sale whole (its payments, its finished deliveries, its own row) when (cashucard 0.3.0 src/pay.ts
 * archiveNow): the sale is marked archived (an archive stopped part way; it goes at any cut), or it is closed, or a
 * payment counts for it; no row the library does not read may belong to it; and every payment of it is final, at or
 * before the cut. A closed sale with nothing counted goes by the later of its opening and its close. These copy that
 * rule from the record's rows. The copy must never be stricter than the library's: a sale the library takes and the
 * till did not count would make the job larger than the till asked for. */

/** What the rows the library does not read say of sales (cashucard 0.3.0 src/journal.ts salesNamed): the sales they
 * name, and whether one that may hold a sale's money names none. A sale's own row, a delivery and a card's count hold
 * no money of a sale by themselves. */
export interface UnreadSales {
  sales: ReadonlySet<string>;
  unnamed: boolean;
}

export function unreadSales(rows: readonly UnreadRow[]): UnreadSales {
  const sales = new Set<string>();
  let unnamed = false;
  for (const r of rows) {
    if (r.kind === 'sale' || r.kind === 'delivery' || r.kind === 'card') {
      continue;
    }
    if (r.sale !== null && r.sale !== '') {
      sales.add(r.sale);
    } else {
      unnamed = true;
    }
  }
  return { sales, unnamed };
}

/** No row the library does not read. */
export const NO_UNREAD: UnreadSales = { sales: new Set<string>(), unnamed: false };

/** A payment that counts for its sale (cashucard 0.3.0 countsForSale): taking, held, delivered, exported or gone. */
export function countsForSale(state: string): boolean {
  return state === 'taking' || state === 'held' || state === 'delivered' || state === 'exported' || state === 'gone';
}

/** An open claim (cashucard isClaim): its SIGN went out and its signature is not had. */
function isClaimStep(step: string | null): boolean {
  return step === 'sign-asked' || step === 'released' || step === 'unrecovered';
}

/** The payments archive() keeps while their pieces may close a claim or a loss (cashucard 0.3.0 keptAsEvidence): a
 * payment whose plan spends a piece that a claim, a signed swap not taken yet (step `signed`) or a loss (step or state
 * `spent-not-restored`, state `lost`) of this record also spends. */
export function evidenceOf(facts: readonly PaymentFacts[]): (f: PaymentFacts) => boolean {
  const secrets = new Set<string>();
  for (const e of facts) {
    const open =
      isClaimStep(e.step) ||
      e.step === 'signed' ||
      e.step === 'spent-not-restored' ||
      e.state === 'spent-not-restored' ||
      e.state === 'lost';
    if (open) {
      for (const s of e.inputs) {
        secrets.add(s);
      }
    }
  }
  return (f) => f.inputs.some((s) => secrets.has(s));
}

/** Whether archive() takes this payment row as final, the cut aside (cashucard 0.3.0 archiveNow `final`): never an
 * extra, an open claim, a payment kept as evidence or one spent-not-restored; delivered, taken out, a phone's payment
 * gone, or one that took nothing (refused, abandoned); nothing owed to its card and nothing on it unconfirmed. What
 * archive() holds in memory alone (a card flow running) is not seen here; archive() still refuses those, and the job
 * is then only smaller. */
export function paymentFinal(f: PaymentFacts, evidence: (f: PaymentFacts) => boolean): boolean {
  if (f.extra || isClaimStep(f.step) || f.step === 'spent-not-restored' || evidence(f)) {
    return false;
  }
  const took =
    f.state === 'delivered' ||
    f.state === 'exported' ||
    (f.state === 'gone' && f.how === 'ecash') ||
    (f.state === 'none' && (f.step === 'refused' || f.step === 'abandoned'));
  return took && f.owed === 0 && f.unconfirmed === 0;
}

/** A sale archive() would take at a cut at or after `place` (ms; 0 for a sale marked archived, which goes at any
 * cut): `weight` is what it counts toward a job (its payment rows, and at least 1, so that sales with no payment count
 * too); `payments` its payments that took something. */
export interface ReadySale {
  sale: string;
  place: number;
  weight: number;
  payments: number;
}

/** Every sale archive() would take at some cut, by the library's rule (above). `unread`: what the rows the library
 * does not read say of sales; the rows themselves must already be left out of `facts` and `sales`. */
export function readySales(
  facts: readonly PaymentFacts[],
  sales: readonly SaleFacts[],
  unread: UnreadSales,
): ReadySale[] {
  const evidence = evidenceOf(facts);
  const bySale = new Map<string, PaymentFacts[]>();
  for (const f of facts) {
    const mine = bySale.get(f.sale);
    if (mine === undefined) {
      bySale.set(f.sale, [f]);
    } else {
      mine.push(f);
    }
  }
  const out: ReadySale[] = [];
  for (const s of sales) {
    const mine = bySale.get(s.id) ?? [];
    const counted = mine.some((f) => countsForSale(f.state));
    if (!s.archived && !s.closed && !counted) {
      continue;
    }
    if (unread.sales.has(s.id) || (unread.unnamed && !counted)) {
      continue;
    }
    if (!mine.every((f) => paymentFinal(f, evidence))) {
      continue;
    }
    let place = 0;
    if (!s.archived) {
      for (const f of mine) {
        place = Math.max(place, f.held);
      }
      if (!counted) {
        place = Math.max(place, s.at, s.closedAt);
      }
    }
    out.push({
      sale: s.id,
      place,
      weight: Math.max(1, mine.length),
      payments: mine.filter((f) => f.state !== 'none').length,
    });
  }
  return out;
}

/** The `days` to hand archive() so that one job takes at most `bite` (by weight) of the ready sales, oldest place
 * first, the cut set halfway between the last that fits and the next. Sales of the same place go together, and the
 * oldest place always goes, even when it alone is over `bite` (so a job always makes progress). Null when none is
 * ready, or `bite` is below 1. Never below 0: a clock put back asks up to now. With the library's clock standing at
 * `now` while it archives (the till service), the job is exactly the sales placed at or before the cut. */
export function jobReach(ready: readonly ReadySale[], now: number, bite: number): number | null {
  if (bite < 1 || ready.length === 0) {
    return null;
  }
  const sorted = ready.slice().sort((a, b) => a.place - b.place);
  let weight = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    let n = 0;
    while (j < sorted.length && sorted[j].place === sorted[i].place) {
      n += sorted[j].weight;
      j += 1;
    }
    if (i > 0 && weight + n > bite) {
      break;
    }
    weight += n;
    i = j;
  }
  const cut = sorted[i - 1].place;
  const target = i < sorted.length ? cut + (sorted[i].place - cut) / 2 : now;
  return Math.max(0, (now - target) / DAY_MS);
}

/** How many payments that took something the ready sales hold. */
export function readyCount(ready: readonly ReadySale[]): number {
  let n = 0;
  for (const r of ready) {
    n += r.payments;
  }
  return n;
}

/** How far an archive run has come (slice 2.3 review): payments archived so far in it, and finished payments still in
 * the record as its last job found them. Counts only, never an id. */
export interface ArchiveProgress {
  archived: number;
  left: number;
  /** the run waits for the sale on the sale screen to end (slice 2.3b); absent otherwise */
  waiting?: true;
}

export const ARCHIVE_WORDS = {
  title: 'Records and reset',
  reading: 'Reading the record.',
  readFailed: 'The record could not be read now.',
  liveLead: 'In the record now: ',
  archivedLead: 'Paid and archived: ',
  lastLead: 'Last archived: ',
  help:
    'The till archives its oldest finished payments by itself, so its record stays short and quick. Archived payments stay on this phone and still count in the Activity. A payment that is not finished is never archived.',
  archive: 'Archive finished payments now',
  archiving:
    'Archiving, a part at a time. A sale goes first: it waits only for the part being archived when it is asked.',
  waiting:
    'The archive is waiting for the sale on the sale screen. It goes on once that sale is paid, withdrawn or left.',
  progressLead: 'Archived so far: ',
  progressLeft: 'Finished payments still in the record: ',
  none: 'Nothing to archive now. A payment that is not finished stays in the record.',
  empty: 'Every payment is archived. The record holds none now.',
  heldBack: 'Nothing more can be archived now. Rows this version cannot read keep some sales in the record.',
  unreadLead: 'Rows this version cannot read: ',
  unreadRest: 'The Activity lists them. Until they are put right, any sale they may belong to stays in the record.',
  stopped: 'Nothing was lost. Try again later.',
  notOpen: 'The till is not open. Nothing was archived.',
  share: 'Share the payment list',
  shareNote: 'The list holds dates, amounts and what each payment was. It holds no eCash and no keys.',
  shareFailed: 'The list could not be shared now.',
  reset: 'Resetting the record comes in a later version.',
} as const;

/** 'In the record now: 312 payments.' */
export function liveWords(n: number): string {
  return ARCHIVE_WORDS.liveLead + plural(n, 'payment', 'payments') + '.';
}

/** 'Paid and archived: 140,000 sats in 10,000 payments.' */
export function archivedWords(t: { sats: number; count: number }): string {
  return ARCHIVE_WORDS.archivedLead + sats(t.sats) + ' in ' + plural(t.count, 'payment', 'payments') + '.';
}

/** 'Last archived: 22 Nov 2026, 04:10, 100 payments.' */
export function lastArchiveWords(n: ArchiveNote): string {
  return ARCHIVE_WORDS.lastLead + dateTime(n.at) + ', ' + plural(n.payments, 'payment', 'payments') + '.';
}

/** 'Archived so far: 300 payments. Finished payments still in the record: 700.' */
export function progressWords(p: ArchiveProgress): string {
  return (
    ARCHIVE_WORDS.progressLead +
    plural(p.archived, 'payment', 'payments') +
    '. ' +
    ARCHIVE_WORDS.progressLeft +
    groupDigits(String(p.left)) +
    '.'
  );
}

/** 'Rows this version cannot read: 2 damaged, 1 of an earlier version. The Activity lists them. …' (slice 2.3b): what
 * such rows hold back from the archive (cashucard 0.3.0). */
export function unreadWords(damaged: number, older: number): string {
  const parts: string[] = [];
  if (damaged > 0) {
    parts.push(groupDigits(String(damaged)) + ' damaged');
  }
  if (older > 0) {
    parts.push(groupDigits(String(older)) + ' of an earlier version');
  }
  return ARCHIVE_WORDS.unreadLead + parts.join(', ') + '. ' + ARCHIVE_WORDS.unreadRest;
}

/** What an archive asked in Records did, in one sentence or three. `heldBack`: rows the library does not read are in
 * the record (slice 2.3b), so "every payment is archived" is never said. */
export function archiveResultWords(n: ArchiveNote, heldBack: boolean = false): string {
  if (!n.ok) {
    return n.payments > 0
      ? 'Archived ' + plural(n.payments, 'payment', 'payments') + ', then the archive stopped. ' + ARCHIVE_WORDS.stopped
      : 'The archive could not run now. ' + ARCHIVE_WORDS.stopped;
  }
  if (n.payments === 0) {
    if (heldBack) {
      return ARCHIVE_WORDS.heldBack;
    }
    // a record with no payment row left is told so, never "a payment that is not finished stays"
    return n.left === 0 ? ARCHIVE_WORDS.empty : ARCHIVE_WORDS.none;
  }
  return 'Archived ' + plural(n.payments, 'payment', 'payments') + '.';
}
