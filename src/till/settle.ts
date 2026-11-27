import { CardError, type CashuCard, type Payment, type PaymentState } from 'cashucard';
import { dateTime, sats } from '../format';
import { isPaid, paymentWords } from './payment-words';
import type { TillEvents } from './store/events';
import type { KeptTotal } from './store/keep-store';

/** Why a settle was asked. */
export type SettleWhy = 'launch' | 'after-card' | 'front' | 'timer' | 'asked';
/** How often the schedule settles while the app is in front, ms. */
export const SETTLE_EVERY_MS = 180000;
/** How often, at most, the schedule asks the mints again, ms. */
export const RECHECK_EVERY_MS = 3600000;
/** A settle the library answers busy is asked again after this long, at most SETTLE_BUSY_MOST times in all. */
export const SETTLE_BUSY_MS = 1000;
export const SETTLE_BUSY_MOST = 30;
/** The most notices Home shows at once: the oldest not seen. The others wait behind them; none is dropped. */
export const NOTICES_MOST = 10;
/** The record's own error kinds: a settle that failed with one of these could not keep the record. */
export const RECORD_ERRORS: readonly string[] = ['journal', 'journal-in-use', 'journal-rolled-back'];
/** States of a payment not finished yet: one of these that a settle made paid is told. */
export const UNFINISHED_STATES: readonly PaymentState[] = ['taking', 'unrecovered', 'lost', 'spent-not-restored'];

export const SETTLE_WORDS = {
  record:
    'The till could not finish its earlier payments: it could not keep its record. Do not take more payments. Close the app and open it again.',
  later: 'The till could not finish its earlier payments now. It tries again in a few minutes.',
  keptLead: 'Kept in this phone: ',
} as const;

/** One settle that ended. */
export interface SettleNote {
  why: SettleWhy;
  /** when it ended, ms */
  at: number;
  /** how long it ran from its start, ms */
  ms: number;
  ok: boolean;
  /** how many payments it changed (0 when it failed) */
  changed: number;
  /** the CardError kind it failed with ('internal' for anything else); null when ok */
  error: string | null;
  /** settles ended in this run, this one included */
  n: number;
}

/** What the merchant is told once about a payment a settle changed. */
export interface TillNotice {
  paymentId: string;
  words: string;
}

/** How a notice reads on Home: bad where there is a risk or a loss, good where money arrived and nothing is asked. */
export type NoticeTone = 'normal' | 'good' | 'bad';

/** A notice as Home shows it. */
export interface ShownNotice {
  words: string;
  tone: NoticeTone;
}

/** A notice as it is kept: its told-once key (noticeKey), its payment's id and its words. Never a token. Also its tone;
 * its kind, so that its words can be made again from the record ('state': the payment's own words; 'now-paid': those
 * and nowPaidWords; 'written': money written to the card at a tap); what it said was still owed to the card (when above
 * 0; 0 for a 'written' notice that owes nothing more); and, for a 'written' notice, how much it says was written. A row
 * kept before these fields has none of them: it reads in the normal tone and is never made again. */
export interface NoticeRow {
  key: string;
  paymentId: string;
  words: string;
  tone?: NoticeTone;
  kind?: 'state' | 'now-paid' | 'written';
  owed?: number;
  written?: number;
}

/** Where told notices are kept across launches. */
export interface NoticeBook {
  /** the notices told and not seen, oldest first; the key of every notice ever told; and, for each payment a notice
   * said was owed money, what the last such notice said it owed (absent: none) */
  load(): Promise<{ unseen: NoticeRow[]; told: string[]; owed?: Array<{ paymentId: string; owed: number }> }>;
  /** a notice was told: kept before it is shown */
  told(n: NoticeRow): Promise<void>;
  /** the notices of these keys were seen */
  seen(keys: readonly string[]): Promise<void>;
}

/** A kept notice read back, or null for a detail that is not one. */
function noticeRowOf(detail: string): NoticeRow | null {
  try {
    const v: unknown = JSON.parse(detail);
    if (typeof v !== 'object' || v === null) {
      return null;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.key !== 'string' || typeof o.paymentId !== 'string' || typeof o.words !== 'string') {
      return null;
    }
    const n: NoticeRow = { key: o.key, paymentId: o.paymentId, words: o.words };
    if (o.tone === 'normal' || o.tone === 'good' || o.tone === 'bad') {
      n.tone = o.tone;
    }
    if (o.kind === 'state' || o.kind === 'now-paid' || o.kind === 'written') {
      n.kind = o.kind;
    }
    if (typeof o.owed === 'number' && Number.isSafeInteger(o.owed) && o.owed >= 0) {
      n.owed = o.owed;
    }
    if (typeof o.written === 'number' && Number.isSafeInteger(o.written) && o.written >= 0) {
      n.written = o.written;
    }
    return n;
  } catch {
    return null;
  }
}

/** The keys a notice-seen detail names ([] for a detail that is not a list of them). */
function seenKeysOf(detail: string): string[] {
  try {
    const v: unknown = JSON.parse(detail);
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** The notices kept in the till's own events (its encrypted store): one `notice` event for each notice told, one
 * `notice-seen` event for each press of Seen. */
export function eventBook(events: Pick<TillEvents, 'add' | 'list'>): NoticeBook {
  return {
    async load(): Promise<{ unseen: NoticeRow[]; told: string[]; owed: Array<{ paymentId: string; owed: number }> }> {
      const rows = new Map<string, NoticeRow>();
      const seen = new Set<string>();
      const owed = new Map<string, number>();
      for (const e of await events.list()) {
        if (e.kind === 'notice') {
          const n = noticeRowOf(e.detail);
          if (n !== null) {
            // a notice made again from the record keeps its key and its first place: its words are the last written
            rows.set(n.key, n);
            if (n.owed !== undefined) {
              owed.set(n.paymentId, n.owed);
            }
          }
        } else if (e.kind === 'notice-seen') {
          for (const k of seenKeysOf(e.detail)) {
            seen.add(k);
          }
        }
      }
      const all = Array.from(rows.values());
      return {
        unseen: all.filter((n) => !seen.has(n.key)),
        told: all.map((n) => n.key),
        owed: Array.from(owed.entries()).map(([paymentId, o]) => ({ paymentId, owed: o })),
      };
    },
    told: (n: NoticeRow) =>
      events.add(
        'notice',
        JSON.stringify({
          key: n.key,
          paymentId: n.paymentId,
          words: n.words,
          tone: n.tone,
          kind: n.kind,
          owed: n.owed,
          written: n.written,
        }),
      ),
    seen: (keys: readonly string[]) => events.add('notice-seen', JSON.stringify(keys.slice())),
  };
}

/** What the keep-store holds in sats: the sum, and how many deliveries. */
export interface KeptSum {
  sats: number;
  deliveries: number;
}

/** What the bench is told of the till (development only): counts and words, never a token, an id or a key. */
export interface TillReport {
  at: number;
  kept: KeptSum;
  /** payments by state, only the states that have one or more */
  payments: Partial<Record<PaymentState, number>>;
  /** payments that are extra (paid twice or late), counted again here */
  extra: number;
  settle: { why: SettleWhy; ok: boolean; changed: number; error: string | null; ms: number } | null;
  settles: number;
  /** the words of the notices not seen yet */
  notices: string[];
}
export const TILL_REPORT_KEYS: readonly string[] = ['at', 'kept', 'payments', 'extra', 'settle', 'settles', 'notices'];

/** The sum a notice leads with: for money made back for a card (`returned`), what is still owed to the card, or, once
 * nothing is, what was written to it; for any other payment, its price. */
export function noticeLead(p: Payment): number {
  if (p.state === 'returned') {
    if (p.owedToCard > 0) {
      return p.owedToCard;
    }
    if (p.givenBack > 0) {
      return p.givenBack;
    }
  }
  return p.amount;
}

/** '14 sats · PAID. Paid and kept in this phone's wallet.', then each figure as a sentence. */
export function noticeWords(p: Payment): string {
  const w = paymentWords(p);
  const parts = [sats(noticeLead(p)) + ' · ' + w.headline + '.', w.sentence];
  for (const f of w.figures) {
    parts.push(f.words.endsWith('.') ? f.words : f.words + '.');
  }
  return parts.join(' ');
}

/** What follows a payment's own words when a settle paid a payment the till had not finished: when its card paid (`at`,
 * the payment's own time), and that a sale also paid another way is paid twice. */
export function nowPaidWords(at: number): string {
  return (
    'The payment of ' +
    dateTime(at) +
    ' was not finished when its sale ended. It is paid now. If the customer paid that sale another way too, it is paid twice.'
  );
}

/** The notice for a payment a settle changed, or null when nothing is told. `before` is its state before the settle. */
export function noticeOf(before: PaymentState | undefined, p: Payment): string | null {
  if (p.state === 'gone' || p.state === 'lost' || p.state === 'spent-not-restored' || p.state === 'returned') {
    return noticeWords(p);
  }
  if (p.state === 'held' && p.extra !== undefined) {
    return noticeWords(p);
  }
  if (isPaid(p) && before !== undefined && UNFINISHED_STATES.includes(before)) {
    return p.offline ? noticeWords(p) : noticeWords(p) + ' ' + nowPaidWords(p.at);
  }
  return null;
}

/** The tone of the notice noticeOf tells: bad for a loss, a payment paid twice or late (the customer paid more than the
 * sale), and a payment the till had not finished that is paid now (it may be paid twice); normal otherwise (money owed
 * to a card, money kept for its customer). No notice is told in the good tone: none is money that arrived with nothing
 * asked of the merchant. */
export function noticeToneOf(before: PaymentState | undefined, p: Payment): NoticeTone {
  if (p.state === 'gone' || p.state === 'lost' || p.state === 'spent-not-restored') {
    return 'bad';
  }
  if (p.state === 'held' && p.extra !== undefined) {
    return p.why === 'date-too-near' ? 'normal' : 'bad';
  }
  if (isPaid(p) && before !== undefined && UNFINISHED_STATES.includes(before)) {
    return p.offline ? 'good' : 'bad';
  }
  return 'normal';
}

/** The notice that money owed to a card was written to it at a tap, `n` sats of it. Money made back for the card, once
 * nothing more is owed: the payment's own words (WRITTEN TO THE CARD). */
export function writtenWords(n: number, p: Payment): string {
  if (p.state === 'returned' && p.owedToCard === 0) {
    return noticeWords(p);
  }
  const what =
    p.state === 'returned'
      ? "Part of the customer's money was written to the card."
      : 'The change owed to the card was written to it.';
  const rest = p.owedToCard > 0 ? ' Still owed to the card, not written yet: ' + sats(p.owedToCard) + '.' : '';
  return sats(n) + ' · WRITTEN TO THE CARD. ' + what + rest;
}

/** A notice is told once per payment, state and extra. */
export function noticeKey(p: Payment): string {
  // Expected offline settlement has its own key. Historical delayed online payments retain their duplicate-payment notice.
  const state = p.offline && isPaid(p) ? 'offline-' + p.state : p.state;
  return p.paymentId + '|' + state + '|' + (p.extra ?? '');
}

/** The keep-store's totals in sats (other units are not counted). */
export function keptOf(totals: readonly KeptTotal[]): KeptSum {
  let sum = 0;
  let deliveries = 0;
  for (const t of totals) {
    if (t.unit === 'sat') {
      sum += t.amount;
      deliveries += t.count;
    }
  }
  return { sats: sum, deliveries };
}

/** 'Kept in this phone: 2,100 sats' */
export function keptWords(n: number): string {
  return SETTLE_WORDS.keptLead + sats(n);
}

/** The words for a settle that failed, or null when the last settle went well or there was none. */
export function settleProblem(note: SettleNote | null): string | null {
  if (note === null || note.ok) {
    return null;
  }
  if (note.error !== null && RECORD_ERRORS.includes(note.error)) {
    return SETTLE_WORDS.record;
  }
  return SETTLE_WORDS.later;
}

export function tillReport(
  at: number,
  kept: KeptSum,
  payments: readonly Payment[],
  note: SettleNote | null,
  notices: readonly TillNotice[],
): TillReport {
  const byState: Partial<Record<PaymentState, number>> = {};
  let extra = 0;
  for (const p of payments) {
    byState[p.state] = (byState[p.state] ?? 0) + 1;
    if (p.extra !== undefined) {
      extra += 1;
    }
  }
  return {
    at,
    kept: { sats: kept.sats, deliveries: kept.deliveries },
    payments: byState,
    extra,
    settle:
      note === null
        ? null
        : { why: note.why, ok: note.ok, changed: note.changed, error: note.error, ms: note.ms },
    settles: note === null ? 0 : note.n,
    notices: notices.map((n) => n.words),
  };
}

export interface SettlerDeps {
  /** runs f as one 'settle' job of the till's queue, with the library (the service's withCard('settle', f)) */
  job: <T>(f: (c: CashuCard) => Promise<T>) => Promise<T>;
  /** waits ms */
  wait: (ms: number) => Promise<void>;
  now: () => number;
  /** where notices are kept across launches, or null while the store is not open; absent: in memory only (tests) */
  book?: () => NoticeBook | null;
}

export interface Settler {
  /** One settle in the queue. Asked while one waits (asked, not started), it joins that one and answers its promise.
   * Asked while one runs, one more is made to wait behind it. Answers the payments the library said it changed; rejects
   * with what the library threw, or with what the job runner refused with. */
  settle(why: SettleWhy): Promise<Payment[]>;
  /** l is called after every settle that ended (not one refused before it started), with the payments it changed, []
   * when it failed; answers the unsubscribe */
  onPayments(l: (changed: Payment[]) => void): () => void;
  /** the last settle that ended in this run, or null */
  last(): SettleNote | null;
  /** whether a settle was asked and has not started */
  waiting(): boolean;
  /** the notices not seen yet, oldest first (copies): this launch's and an earlier one's kept in the book */
  notices(): TillNotice[];
  /** the same notices, as Home shows them: their words and tones */
  shown(): ShownNotice[];
  /** the oldest `count` notices were seen (every one when absent): they are dropped, written as seen in the book, and
   * none of them is told again, in this launch or a later one */
  seen(count?: number): void;
}

export function createSettler(d: SettlerDeps): Settler {
  let pending: Promise<Payment[]> | null = null;
  let note: SettleNote | null = null;
  let count = 0;
  const listeners: Array<(changed: Payment[]) => void> = [];
  const told = new Set<string>();
  let unseen: NoticeRow[] = [];
  /** whether the book was read in this launch */
  let loaded = false;
  /** for each payment a notice said was owed money, what the last such notice said it owed */
  const owedTold = new Map<string, number>();

  /** The notices an earlier launch kept, read once, before this launch's first settle tells anything: theirs first. */
  const load = async (): Promise<void> => {
    const b = d.book?.() ?? null;
    if (loaded || b === null) {
      return;
    }
    const got = await b.load();
    for (const k of got.told) {
      told.add(k);
    }
    for (const o of got.owed ?? []) {
      if (!owedTold.has(o.paymentId)) {
        owedTold.set(o.paymentId, o.owed);
      }
    }
    const now = new Set(unseen.map((n) => n.key));
    unseen = got.unseen.filter((n) => !now.has(n.key)).concat(unseen);
    loaded = true;
  };

  const emit = (changed: Payment[]): void => {
    for (const l of listeners.slice()) {
      try {
        l(changed);
      } catch {
        // a listener that throws never stops the others
      }
    }
  };

  const settleOnce = async (c: CashuCard): Promise<Payment[]> => {
    for (let tries = 1; ; tries += 1) {
      try {
        return await c.settle();
      } catch (e) {
        if (e instanceof CardError && e.kind === 'busy' && tries < SETTLE_BUSY_MOST) {
          await d.wait(SETTLE_BUSY_MS);
          continue;
        }
        throw e;
      }
    }
  };

  const tell = async (before: Map<string, PaymentState>, changed: Payment[]): Promise<void> => {
    const b = d.book?.() ?? null;
    for (const p of changed) {
      const w = noticeOf(before.get(p.paymentId), p);
      if (w === null) {
        continue;
      }
      const k = noticeKey(p);
      if (told.has(k)) {
        continue;
      }
      told.add(k);
      const n: NoticeRow = {
        key: k,
        paymentId: p.paymentId,
        words: w,
        tone: noticeToneOf(before.get(p.paymentId), p),
        kind: w === noticeWords(p) ? 'state' : 'now-paid',
      };
      if (p.owedToCard > 0) {
        n.owed = p.owedToCard;
        owedTold.set(p.paymentId, p.owedToCard);
      }
      unseen.push(n);
      if (b !== null) {
        await b.told(n);
      }
    }
  };

  /** What a card job wrote to a card since a notice said the money was owed: the record now owes that card less (a
   * paying tap of the card wrote it, cashucard dist/pay.js giveBackOthers; no settle reports the payment as changed,
   * and a `returned` payment stays `returned`). Every such notice not seen yet is made again from the record, in its
   * place and under its key, and written again to the book; when every such notice was seen already, one 'written'
   * notice is told. Run at the start of every settle job: so after every card job (each is followed by a settle) and
   * at launch. */
  const reconcile = async (pays: readonly Payment[]): Promise<void> => {
    const b = d.book?.() ?? null;
    for (const p of pays) {
      const was = owedTold.get(p.paymentId);
      if (was === undefined || p.owedToCard >= was) {
        continue;
      }
      owedTold.set(p.paymentId, p.owedToCard);
      const stale = unseen.filter((n) => n.paymentId === p.paymentId && n.owed !== undefined && n.owed > p.owedToCard);
      for (const n of stale) {
        const more = (n.owed ?? 0) - p.owedToCard;
        if (n.kind === 'written') {
          n.written = (n.written ?? 0) + more;
          n.words = writtenWords(n.written, p);
        } else if (n.kind === 'now-paid') {
          n.words = noticeWords(p) + ' ' + nowPaidWords(p.at);
        } else {
          n.words = noticeWords(p);
        }
        n.owed = p.owedToCard;
        if (b !== null) {
          await b.told(n);
        }
      }
      if (stale.length > 0) {
        continue;
      }
      const k = p.paymentId + '|written|' + p.owedToCard;
      if (told.has(k)) {
        continue;
      }
      told.add(k);
      const n: NoticeRow = {
        key: k,
        paymentId: p.paymentId,
        words: writtenWords(was - p.owedToCard, p),
        tone: 'normal',
        kind: 'written',
        owed: p.owedToCard,
        written: was - p.owedToCard,
      };
      unseen.push(n);
      if (b !== null) {
        await b.told(n);
      }
    }
  };

  const end = (
    why: SettleWhy,
    started: number,
    ok: boolean,
    changed: number,
    error: string | null,
  ): void => {
    count += 1;
    const at = d.now();
    note = { why, at, ms: at - started, ok, changed, error, n: count };
  };

  const settle = (why: SettleWhy): Promise<Payment[]> => {
    if (pending !== null) {
      return pending;
    }
    let ran = false;
    const run = d.job(async (c) => {
      pending = null;
      ran = true;
      const started = d.now();
      try {
        await load();
        const before = new Map<string, PaymentState>();
        const record = await c.payments();
        for (const p of record) {
          before.set(p.paymentId, p.state);
        }
        await reconcile(record);
        const changed = await settleOnce(c);
        await tell(before, changed);
        end(why, started, true, changed.length, null);
        return changed;
      } catch (e) {
        end(why, started, false, 0, e instanceof CardError ? e.kind : 'internal');
        throw e;
      }
    });
    pending = run;
    run.then(
      (changed) => emit(changed),
      () => {
        if (pending === run) {
          pending = null;
        }
        if (ran) {
          emit([]);
        }
      },
    );
    return run;
  };

  return {
    settle,
    onPayments(l: (changed: Payment[]) => void): () => void {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i !== -1) {
          listeners.splice(i, 1);
        }
      };
    },
    last: () => (note === null ? null : { ...note }),
    waiting: () => pending !== null,
    notices: () => unseen.map((n) => ({ paymentId: n.paymentId, words: n.words })),
    shown: () => unseen.map((n) => ({ words: n.words, tone: n.tone ?? 'normal' })),
    seen: (count?: number) => {
      const n = count === undefined ? unseen.length : Math.max(0, Math.min(count, unseen.length));
      const gone = unseen.slice(0, n);
      unseen = unseen.slice(n);
      const b = d.book?.() ?? null;
      if (b !== null && gone.length > 0) {
        // a Seen that could not be written is told again at the next launch: never lost, at worst told twice
        b.seen(gone.map((x) => x.key)).then(
          () => undefined,
          () => undefined,
        );
      }
    },
  };
}

export interface ScheduleTimers {
  set(f: () => void, ms: number): unknown;
  clear(h: unknown): void;
}
/** Where the schedule hears that the app came to the front or went to the back, and its timer. */
export interface ScheduleSource {
  /** whether the app is in front now (any state but the back) */
  active(): boolean;
  /** l(true) when the app comes to the front, l(false) when it goes to the back; answers the unsubscribe */
  onActive(l: (active: boolean) => void): () => void;
  timers: ScheduleTimers;
}
export interface ScheduleDeps {
  settle: (why: SettleWhy) => Promise<unknown>;
  /** the mints asked again (the service's recheckMints) */
  recheck: () => Promise<unknown>;
  now: () => number;
  /** null: only the launch's check and settle run (tests that do not give one) */
  source: ScheduleSource | null;
}
export interface SettleSchedule {
  /** the launch's check of the mints and settle; then the front and the timer. A second start does nothing. */
  start(): void;
  /** nothing more is asked: the timer cleared, the source left */
  stop(): void;
}

export function settleSchedule(d: ScheduleDeps): SettleSchedule {
  let started = false;
  let stopped = false;
  let inFront = false;
  let timer: unknown = null;
  let off: (() => void) | null = null;
  let recheckedAt = 0;

  const quiet = (p: Promise<unknown>): void => {
    p.then(
      () => undefined,
      () => undefined,
    );
  };

  const ask = (why: SettleWhy): void => {
    quiet(
      Promise.resolve().then(() => d.settle(why)),
    );
  };

  const check = (): void => {
    recheckedAt = d.now();
    quiet(
      Promise.resolve().then(() => d.recheck()),
    );
  };

  const checkIfDue = (): void => {
    const now = d.now();
    if (now - recheckedAt >= RECHECK_EVERY_MS || now < recheckedAt) {
      check();
    }
  };

  const disarm = (): void => {
    if (timer !== null && d.source !== null) {
      d.source.timers.clear(timer);
    }
    timer = null;
  };

  const arm = (): void => {
    disarm();
    if (d.source !== null) {
      timer = d.source.timers.set(tick, SETTLE_EVERY_MS);
    }
  };

  const tick = (): void => {
    timer = null;
    if (stopped) {
      return;
    }
    ask('timer');
    checkIfDue();
    if (inFront) {
      arm();
    }
  };

  const heard = (now: boolean): void => {
    if (stopped || now === inFront) {
      return;
    }
    inFront = now;
    if (now) {
      ask('front');
      checkIfDue();
      arm();
    } else {
      disarm();
    }
  };

  const start = (): void => {
    if (started || stopped) {
      return;
    }
    started = true;
    check();
    ask('launch');
    if (d.source !== null) {
      off = d.source.onActive(heard);
      inFront = d.source.active();
      if (inFront) {
        arm();
      }
    }
  };

  const stop = (): void => {
    stopped = true;
    disarm();
    if (off !== null) {
      off();
      off = null;
    }
  };

  return { start, stop };
}
