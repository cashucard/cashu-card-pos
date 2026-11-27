/* The sale as one pure function: the keypad, the opening, the taps, the sheet, the PIN pad, and the way out. Every answer
 * is a new state and at most one effect, described as data; nothing here logs, shows or holds a PIN. */

import type { CardConfirmation, CardErrorKind, Payment, Stage, StageWords } from 'cashucard';
import { CARD_ERROR_TITLES, errorOutcome, SALES_STOPPED_TITLE, SALES_STOPPED_WHY, type ErrorOutcome } from './card-errors';
import { isPaid } from './payment-words';

/** The most one sale can be, in sats. */
export const SALE_MOST = 1000000;
/** The keypad takes at most this many digits. */
export const AMOUNT_DIGITS = 7;
/** The card protocol accepts four to eight PIN digits on every payment path. */
export const PIN_LEAST = 4;
export const PIN_MOST = 8;
export const PRE_TAP_FEE_LIMIT = 1;
/** How long the till waits: for a card while none is in the field, at the sheet, at the PIN pad (from the last key). */
export const CARD_WAIT_MS = 30000;
export const CONFIRM_WAIT_MS = 120000;
export const PIN_WAIT_MS = 60000;

/** How the till itself ended a take: Cancel or the 30 s wait on the tap ('cancel', 'timeout'), Do not pay or the 120 s
 * wait at the sheet ('sheet-no', 'sheet-timeout'), Cancel or the 60 s wait at the PIN pad ('pin-cancel', 'pin-timeout'). */
export type Ending = 'cancel' | 'timeout' | 'sheet-no' | 'sheet-timeout' | 'pin-cancel' | 'pin-timeout' | null;
export const ENDING_TITLES: Readonly<Record<'cancel' | 'timeout', string>> = { cancel: 'Cancelled', timeout: 'Time ran out' };
/** What the till says when it ended a take itself, in place of the library's words, for the error kinds that ending
 * makes the library answer (`kinds`). Any other kind is a fact the library reports, and keeps its own words. */
export const ENDING_WORDS: Readonly<Record<Exclude<Ending, null>, { title: string; message: string; kinds: readonly CardErrorKind[] }>> = {
  cancel: {
    title: 'Cancelled',
    message: 'Cancel was pressed before a card was held to the phone. Nothing was taken.',
    kinds: ['stopped'],
  },
  timeout: {
    title: 'Time ran out',
    message: 'No card was held to the phone for 30 seconds. Nothing was taken.',
    kinds: ['stopped'],
  },
  'sheet-no': { title: 'Declined', message: 'Do not pay was pressed. Nothing was taken.', kinds: ['declined'] },
  'sheet-timeout': {
    title: 'Time ran out',
    message: 'Nobody pressed Pay or Do not pay for 2 minutes. Nothing was taken.',
    kinds: ['declined'],
  },
  'pin-cancel': {
    title: 'Cancelled',
    message: 'Cancel was pressed on the PIN pad. Nothing was taken.',
    kinds: ['declined', 'wrong-pin', 'pin-needed', 'no-pin'],
  },
  'pin-timeout': {
    title: 'Time ran out',
    message: 'No key of the PIN pad was pressed for a minute. Nothing was taken.',
    kinds: ['declined', 'wrong-pin', 'pin-needed', 'no-pin'],
  },
};
export type PinWhy = 'allowance' | 'leftover' | 'recover';

/** The results from which the merchant may say the customer paid another way. */
export type WithdrawFrom =
  | { kind: 'tap-again'; message: string }
  | { kind: 'checking'; paymentId: string | null; message: string }
  | { kind: 'not-paid-yet'; message: string };
export type SaleOutcome =
  | WithdrawFrom
  | { kind: 'paid'; payment: Payment }
  | { kind: 'wallet-paid'; rail: 'Lightning' | 'Cashu' }
  | { kind: 'lightning-extra' }
  | { kind: 'lightning-processing' }
  | { kind: 'saved-offline'; paymentId: string }
  | { kind: 'offline-loss' }
  | { kind: 'already-paid'; extra: 'paid-twice' | 'late'; message: string }
  | { kind: 'unfinished'; message: string }
  /** `ended`: the sale is over (archived, or its record does not read): Try again is not offered */
  | { kind: 'not-paid'; errorKind: CardErrorKind; title: string; message: string; ended?: true }
  | { kind: 'stop'; message: string }
  | { kind: 'withdraw-asked'; back: WithdrawFrom }
  | { kind: 'withdrawing'; back: WithdrawFrom }
  | { kind: 'withdrawn'; paidBefore: Payment[] };

export interface TapState {
  kind: 'tap'; sats: number; saleId: string; tap: 1 | 2; card: boolean; words: StageWords | null; ending: Ending;
  /** set when the card may already have signed for this sale in an earlier tap; never false (the key is left out) */
  signedBefore?: true;
  /** the card job waits behind the till's other work (a settle): the card is not asked for yet, and no wait runs */
  queued?: boolean;
}
export interface PinState {
  kind: 'pin'; sats: number; saleId: string; count: number; why: PinWhy; wrong: boolean; tries: number | null;
  from: 'confirm' | 'ask';
  /** the tap to go back to, for a PIN the library asked for (from 'ask'); null from the sheet */
  back: TapState | null;
  signedBefore?: true;
}
export type SaleState =
  | { kind: 'keypad'; digits: string }
  | { kind: 'preflight'; sats: number; count: number; mode?: 'detecting' | 'offline'; resumeSaleId?: string; shared?: true; saleId?: string; verifyInvoice?: true }
  | { kind: 'opening'; sats: number; queued?: boolean }
  | TapState
  | { kind: 'confirm'; sats: number; saleId: string; c: CardConfirmation; signedBefore?: true }
  | PinState
  | { kind: 'stopping'; sats: number; saleId: string; ending: Ending; signedBefore?: true }
  | { kind: 'result'; sats: number; saleId: string | null; outcome: SaleOutcome; note: string | null };

export type SaleEvent =
  | { type: 'digit'; d: string } | { type: 'key-back' } | { type: 'key-clear' } | { type: 'charge' }
  | { type: 'prepare-tap'; detect?: boolean; shared?: boolean } | { type: 'network-ready'; offline: boolean } | { type: 'review-first' }
  | { type: 'check-original-invoice'; saleId: string } | { type: 'invoice-unpaid'; saleId: string }
  | { type: 'invoice-received'; saleId: string; state: 'paid' | 'extra' | 'processing' }
  | { type: 'checkout-ready'; saleId: string } | { type: 'clear-pin' }
  | { type: 'checkout-paid'; saleId: string; rail: 'Lightning' | 'Cashu' } | { type: 'lightning-extra'; saleId: string }
  | { type: 'opened'; saleId: string } | { type: 'open-failed'; error: unknown }
  | { type: 'card-wait' } | { type: 'card-here' }
  | { type: 'stage'; stage: Stage; words: StageWords }
  | { type: 'confirm-asked'; c: CardConfirmation } | { type: 'pay' } | { type: 'decline' }
  | { type: 'pin-asked'; why: PinWhy; wrong: boolean; tries: number | null }
  | { type: 'pin-key' } | { type: 'pin-back' } | { type: 'pin-ok' } | { type: 'pin-cancel' }
  | { type: 'cancel' } | { type: 'timeout' }
  | { type: 'done'; payment: Payment } | { type: 'failed'; error: unknown }
  /** `stopped`: new sales are stopped now (slice 2.4): Try again after NOT PAID is refused, Hold the card again goes on */
  | { type: 'retry'; stopped?: boolean; detect?: boolean; offline?: boolean; shared?: boolean } | { type: 'other-way' } | { type: 'withdraw-yes' } | { type: 'withdraw-no' }
  | { type: 'withdrawn'; others: Payment[] } | { type: 'withdraw-failed'; error: unknown }
  | { type: 'new' } | { type: 'settled'; payment: Payment } | { type: 'queued' };

export type SaleEffect =
  | { kind: 'open-sale'; sats: number; offline?: true }
  | { kind: 'take'; saleId: string }
  /** answer the library's confirm; `pin` true: with the digits the controller holds */
  | { kind: 'answer-confirm'; pay: boolean; pin: boolean }
  /** answer the library's askPin: the digits the controller holds, or null */
  | { kind: 'answer-pin'; give: boolean }
  /** abort the take's signal (the controller does so only while no card is in the field) */
  | { kind: 'stop' }
  | { kind: 'withdraw'; saleId: string };
export interface SaleStep { state: SaleState; effect: SaleEffect | null }

export const SALE_START: SaleState = { kind: 'keypad', digits: '' };
/** Stages whose words never show while a card pays: the result says PAID or why not, and the PIN pad asks the PIN. */
export const HIDDEN_STAGES: readonly Stage[] = ['paid', 'failed', 'pin'];
/** This till's own words for two stages whose library words do not fit a till. */
export const STAGE_WORDS_HERE: Readonly<Partial<Record<Stage, StageWords>>> = {
  confirming: { title: 'CHECKING CARD PAYMENT', sheet: '', short: 'READING' },
  remove: { title: 'REMOVE THE CARD', sheet: '', short: 'TRANSFERRING' },
};
/** Under TAP THE SAME CARD AGAIN, after a later tap of a sale the card may already have signed for ended unfinished. */
export const MAY_HAVE_SIGNED = 'The card may already have signed this payment in an earlier tap.';
/** Under TAP THE SAME CARD AGAIN, for the library's refusal (`same-sale`, no `extra`) of a second payment of the sale. */
export const SALE_WAITS = 'This sale waits for a payment a card may already have signed, so no second payment was begun.';
/** The title of a later tap the customer said no to, under TAP THE SAME CARD AGAIN (never "Not paid" there). */
export const DECLINED_AGAIN = 'Declined';
/** Under NOT PAID, for a sale the merchant cancelled while it was being opened. */
export const OPEN_CANCELLED = 'The sale was not opened. Nothing was taken.';

/** The keypad's digits as sats: '' is 0. */
export function amountOf(digits: string): number {
  if (digits === '') return 0;
  return Number(digits);
}

/** Whether Charge may be pressed: 1 to SALE_MOST sats. */
export function chargeEnabled(digits: string): boolean {
  const n = amountOf(digits);
  return n >= 1 && n <= SALE_MOST;
}

/** What a thrown error means for the sale. */
export function outcomeOfError(e: unknown, ending: Ending): SaleOutcome {
  const o = errorOutcome(e);
  if (o.kind === 'already-paid') return { kind: 'already-paid', extra: o.extra, message: o.message };
  if (o.kind === 'checking') return { kind: 'checking', paymentId: o.paymentId, message: o.message };
  if (o.kind === 'not-paid-yet') return { kind: 'not-paid-yet', message: o.message };
  if (o.kind === 'stop') return { kind: 'stop', message: o.message };
  if (o.kind === 'tap-again') return { kind: 'tap-again', message: o.message };
  if (o.kind === 'unfinished') return { kind: 'unfinished', message: o.message };
  if (o.kind === 'busy') return { kind: 'not-paid', errorKind: 'busy', title: CARD_ERROR_TITLES.busy, message: o.message };
  if (ending !== null && ENDING_WORDS[ending].kinds.includes(o.errorKind)) {
    return { kind: 'not-paid', errorKind: o.errorKind, title: ENDING_WORDS[ending].title, message: ENDING_WORDS[ending].message };
  }
  return { kind: 'not-paid', errorKind: o.errorKind, title: o.title, message: o.message };
}

/** The kinds of a sale's records (cashucard 0.3.0) that end the sale: it was archived, or its record does not read. */
export const SALE_OVER_KINDS: readonly CardErrorKind[] = ['sale-archived', 'sale-unreadable'];

/** What a failed take of a sale means. The kinds of a sale's records come first and are never TAP THE SAME CARD
 * AGAIN: SALE_OVER_KINDS end the sale (NOT PAID, no Try again), and `sale-busy` (an archive holds the sale for a
 * moment) is NOT PAID with Try again. `same-sale` with no `extra` is the library saying the sale waits for a payment
 * that may have been signed: TAP THE SAME CARD AGAIN. Once the card may have signed for this sale (`signedBefore`), a
 * later tap that ends without finishing it is never NOT PAID and never TAP AGAIN: it stays TAP THE SAME CARD AGAIN. */
export function outcomeOfTake(e: unknown, ending: Ending, signedBefore: boolean): SaleOutcome {
  const o = outcomeOfError(e, ending);
  if (o.kind === 'not-paid' && SALE_OVER_KINDS.includes(o.errorKind)) return { ...o, ended: true };
  if (o.kind === 'not-paid' && o.errorKind === 'sale-busy') return o;
  if (o.kind === 'not-paid' && o.errorKind === 'same-sale') return { kind: 'tap-again', message: SALE_WAITS };
  if (!signedBefore) return o;
  if (o.kind === 'not-paid') {
    const title = o.errorKind === 'declined' && ending === null ? DECLINED_AGAIN : o.title;
    return { kind: 'tap-again', message: title + '. ' + MAY_HAVE_SIGNED };
  }
  if (o.kind === 'unfinished') return { kind: 'tap-again', message: CARD_ERROR_TITLES.unfinished + '. ' + MAY_HAVE_SIGNED };
  return o;
}

/** What an answered payment means: PAID only when isPaid. */
export function outcomeOfPayment(p: Payment): SaleOutcome {
  if (isPaid(p)) return { kind: 'paid', payment: p };
  if (p.extra !== undefined) return { kind: 'already-paid', extra: p.extra, message: '' };
  if (p.offline && p.state === 'gone') return { kind: 'offline-loss' };
  if (p.offline && p.state === 'taking') return { kind: 'saved-offline', paymentId: p.paymentId };
  return { kind: 'checking', paymentId: p.paymentId, message: '' };
}

function resultOf(sats: number, saleId: string | null, outcome: SaleOutcome): SaleState {
  return { kind: 'result', sats, saleId, outcome, note: null };
}

function newTap(sats: number, saleId: string, tap: 1 | 2, signedBefore: boolean = false): TapState {
  const t: TapState = { kind: 'tap', sats, saleId, tap, card: false, words: null, ending: null };
  return signedBefore ? { ...t, signedBefore: true } : t;
}

/** What a taking state carries of its sale's past: `{ signedBefore: true }`, or nothing (the key left out). */
function memoryOf(s: { signedBefore?: true }): { signedBefore?: true } {
  return s.signedBefore === true ? { signedBefore: true } : {};
}

function keypadStep(s: Extract<SaleState, { kind: 'keypad' }>, e: SaleEvent): SaleStep {
  switch (e.type) {
    case 'digit': {
      const d = e.d;
      if (d.length !== 1 || d < '0' || d > '9') return { state: s, effect: null };
      if (s.digits.length >= AMOUNT_DIGITS) return { state: s, effect: null };
      if (s.digits === '' && d === '0') return { state: s, effect: null };
      return { state: { kind: 'keypad', digits: s.digits + d }, effect: null };
    }
    case 'key-back':
      if (s.digits === '') return { state: s, effect: null };
      return { state: { kind: 'keypad', digits: s.digits.slice(0, -1) }, effect: null };
    case 'key-clear':
      if (s.digits === '') return { state: s, effect: null };
      return { state: { kind: 'keypad', digits: '' }, effect: null };
    case 'prepare-tap':
      return chargeEnabled(s.digits)
        ? { state: { kind: 'preflight', sats: amountOf(s.digits), count: 0, ...(e.shared ? {shared: true as const} : {}), ...(e.detect ? { mode: 'detecting' as const } : {}) }, effect: null }
        : { state: s, effect: null };
    case 'charge': {
      if (!chargeEnabled(s.digits)) return { state: s, effect: null };
      const sats = amountOf(s.digits);
      return { state: { kind: 'opening', sats }, effect: { kind: 'open-sale', sats } };
    }
    default:
      return { state: s, effect: null };
  }
}

function preflightStep(s: Extract<SaleState, { kind: 'preflight' }>, e: SaleEvent): SaleStep {
  switch (e.type) {
    case 'invoice-unpaid': {
      if (!s.verifyInvoice || s.saleId !== e.saleId) return { state: s, effect: null };
      const { verifyInvoice: _, ...ready } = s;
      return { state: ready, effect: null };
    }
    case 'checkout-ready':
      if (!s.shared || s.saleId || s.mode || s.resumeSaleId) return { state: s, effect: null };
      return { state: { ...s, saleId: e.saleId }, effect: null };
    case 'checkout-paid':
    case 'lightning-extra':
      if (!s.saleId || s.saleId !== e.saleId) return { state: s, effect: null };
      return { state: resultOf(s.sats, s.saleId, e.type === 'checkout-paid'
        ? { kind: 'wallet-paid', rail: e.rail } : { kind: 'lightning-extra' }), effect: null };
    case 'clear-pin':
      return { state: s.count ? { ...s, count: 0 } : s, effect: null };
    case 'network-ready':
      if (s.mode !== 'detecting') return { state: s, effect: null };
      return { state: { ...s, mode: e.offline ? 'offline' : undefined }, effect: null };
    case 'open-failed':
      if (s.mode !== 'detecting' && !s.shared) return { state: s, effect: null };
      return { state: resultOf(s.sats, null, outcomeOfError(e.error, null)), effect: null };
    case 'pin-key':
      return s.count < PIN_MOST ? { state: { ...s, count: s.count + 1 }, effect: null } : { state: s, effect: null };
    case 'pin-back':
      return s.count > 0 ? { state: { ...s, count: s.count - 1 }, effect: null } : { state: s, effect: null };
    case 'pin-ok':
      if (s.mode === 'detecting' || (s.count < PIN_LEAST && (s.count > 0 || s.mode === 'offline'))) return { state: s, effect: null };
      if (s.shared && (s.count < PIN_LEAST || (!s.mode && !s.saleId))) return { state: s, effect: null };
      if (s.saleId) return { state: newTap(s.sats, s.saleId, 1), effect: { kind: 'take', saleId: s.saleId } };
      if (s.resumeSaleId) return { state: newTap(s.sats, s.resumeSaleId, 1), effect: { kind: 'take', saleId: s.resumeSaleId } };
      return { state: { kind: 'opening', sats: s.sats }, effect: { kind: 'open-sale', sats: s.sats, ...(s.mode === 'offline' ? { offline: true as const } : {}) } };
    case 'review-first':
      if (s.mode || s.shared) return { state: s, effect: null };
      return { state: { kind: 'opening', sats: s.sats }, effect: { kind: 'open-sale', sats: s.sats } };
    case 'timeout':
      if (s.shared && !s.mode) return { state: { ...s, count: 0 }, effect: null };
      return { state: { kind: 'keypad', digits: String(s.sats) }, effect: null };
    case 'pin-cancel':
      return { state: { kind: 'keypad', digits: String(s.sats) }, effect: null };
    default:
      return { state: s, effect: null };
  }
}

function openingStep(s: Extract<SaleState, { kind: 'opening' }>, e: SaleEvent): SaleStep {
  switch (e.type) {
    case 'opened':
      return { state: newTap(s.sats, e.saleId, 1), effect: { kind: 'take', saleId: e.saleId } };
    case 'open-failed':
      return { state: resultOf(s.sats, null, outcomeOfError(e.error, null)), effect: null };
    case 'cancel':
      return {
        state: resultOf(s.sats, null, { kind: 'not-paid', errorKind: 'stopped', title: ENDING_TITLES.cancel, message: OPEN_CANCELLED }),
        effect: null,
      };
    case 'queued':
      if (s.queued === true) return { state: s, effect: null };
      return { state: { ...s, queued: true }, effect: null };
    default:
      return { state: s, effect: null };
  }
}

function tapStep(s: TapState, e: SaleEvent): SaleStep {
  switch (e.type) {
    case 'card-wait':
      if (s.queued === true) {
        return {
          state: { kind: 'tap', sats: s.sats, saleId: s.saleId, tap: s.tap, card: false, words: s.words, ending: s.ending, ...memoryOf(s) },
          effect: null,
        };
      }
      if (!s.card) return { state: s, effect: null };
      return { state: { ...s, card: false }, effect: null };
    case 'queued':
      if (s.card || s.queued === true) return { state: s, effect: null };
      return { state: { ...s, queued: true }, effect: null };
    case 'card-here':
      if (s.card) return { state: s, effect: null };
      return { state: { ...s, card: true }, effect: null };
    case 'stage':
      if (HIDDEN_STAGES.includes(e.stage)) return { state: s, effect: null };
      return { state: { ...s, words: STAGE_WORDS_HERE[e.stage] ?? e.words }, effect: null };
    case 'confirm-asked':
      return { state: { kind: 'confirm', sats: s.sats, saleId: s.saleId, c: e.c, ...memoryOf(s) }, effect: null };
    case 'pin-asked':
      return {
        state: { kind: 'pin', sats: s.sats, saleId: s.saleId, count: 0, why: e.why, wrong: e.wrong, tries: e.tries, from: 'ask', back: s, ...memoryOf(s) },
        effect: null,
      };
    case 'cancel':
      if (s.card) return { state: s, effect: null };
      return { state: { kind: 'stopping', sats: s.sats, saleId: s.saleId, ending: 'cancel', ...memoryOf(s) }, effect: { kind: 'stop' } };
    case 'timeout':
      if (s.card) return { state: s, effect: null };
      return { state: { kind: 'stopping', sats: s.sats, saleId: s.saleId, ending: 'timeout', ...memoryOf(s) }, effect: { kind: 'stop' } };
    case 'done':
      return { state: resultOf(s.sats, s.saleId, outcomeOfPayment(e.payment)), effect: null };
    case 'failed':
      return { state: resultOf(s.sats, s.saleId, outcomeOfTake(e.error, s.ending, s.signedBefore === true)), effect: null };
    default:
      return { state: s, effect: null };
  }
}

function confirmStep(s: Extract<SaleState, { kind: 'confirm' }>, e: SaleEvent): SaleStep {
  switch (e.type) {
    case 'pay':
      if (s.c.pinNeeded) {
        return {
          state: { kind: 'pin', sats: s.sats, saleId: s.saleId, count: 0, why: s.c.pinFor ?? 'allowance', wrong: false, tries: null, from: 'confirm', back: null, ...memoryOf(s) },
          effect: null,
        };
      }
      return { state: newTap(s.sats, s.saleId, 2, s.signedBefore === true), effect: { kind: 'answer-confirm', pay: true, pin: false } };
    case 'decline':
      return {
        state: { kind: 'stopping', sats: s.sats, saleId: s.saleId, ending: 'sheet-no', ...memoryOf(s) },
        effect: { kind: 'answer-confirm', pay: false, pin: false },
      };
    case 'timeout':
      return {
        state: { kind: 'stopping', sats: s.sats, saleId: s.saleId, ending: 'sheet-timeout', ...memoryOf(s) },
        effect: { kind: 'answer-confirm', pay: false, pin: false },
      };
    case 'done':
      return { state: resultOf(s.sats, s.saleId, outcomeOfPayment(e.payment)), effect: null };
    case 'failed':
      return { state: resultOf(s.sats, s.saleId, outcomeOfTake(e.error, null, s.signedBefore === true)), effect: null };
    default:
      return { state: s, effect: null };
  }
}

function pinStep(s: PinState, e: SaleEvent): SaleStep {
  switch (e.type) {
    case 'pin-key':
      if (s.count >= PIN_MOST) return { state: s, effect: null };
      return { state: { ...s, count: s.count + 1 }, effect: null };
    case 'pin-back':
      if (s.count === 0) return { state: s, effect: null };
      return { state: { ...s, count: s.count - 1 }, effect: null };
    case 'pin-ok':
      if (s.count < PIN_LEAST) return { state: s, effect: null };
      if (s.from === 'confirm') {
        return { state: newTap(s.sats, s.saleId, 2, s.signedBefore === true), effect: { kind: 'answer-confirm', pay: true, pin: true } };
      }
      if (s.back === null) return { state: s, effect: null };
      return { state: s.back, effect: { kind: 'answer-pin', give: true } };
    case 'pin-cancel':
      if (s.from === 'confirm') {
        return {
          state: { kind: 'stopping', sats: s.sats, saleId: s.saleId, ending: 'pin-cancel', ...memoryOf(s) },
          effect: { kind: 'answer-confirm', pay: false, pin: false },
        };
      }
      if (s.back === null) return { state: s, effect: null };
      // a PIN to finish an earlier payment, not given: the library goes on with this tap, and what it says next is its own
      if (s.why === 'recover') return { state: s.back, effect: { kind: 'answer-pin', give: false } };
      return { state: { ...s.back, ending: 'pin-cancel' }, effect: { kind: 'answer-pin', give: false } };
    case 'timeout':
      if (s.from === 'confirm') {
        return {
          state: { kind: 'stopping', sats: s.sats, saleId: s.saleId, ending: 'pin-timeout', ...memoryOf(s) },
          effect: { kind: 'answer-confirm', pay: false, pin: false },
        };
      }
      if (s.back === null) return { state: s, effect: null };
      if (s.why === 'recover') return { state: s.back, effect: { kind: 'answer-pin', give: false } };
      return { state: { ...s.back, ending: 'pin-timeout' }, effect: { kind: 'answer-pin', give: false } };
    case 'done':
      return { state: resultOf(s.sats, s.saleId, outcomeOfPayment(e.payment)), effect: null };
    case 'failed':
      return { state: resultOf(s.sats, s.saleId, outcomeOfTake(e.error, s.back?.ending ?? null, s.signedBefore === true)), effect: null };
    default:
      return { state: s, effect: null };
  }
}

function stoppingStep(s: Extract<SaleState, { kind: 'stopping' }>, e: SaleEvent): SaleStep {
  switch (e.type) {
    case 'done':
      return { state: resultOf(s.sats, s.saleId, outcomeOfPayment(e.payment)), effect: null };
    case 'failed':
      return { state: resultOf(s.sats, s.saleId, outcomeOfTake(e.error, s.ending, s.signedBefore === true)), effect: null };
    default:
      return { state: s, effect: null };
  }
}

/** Whether a payment was already taken: held, delivered or exported, and not an extra payment. */
function paidBefore(p: Payment): boolean {
  return (p.state === 'held' || p.state === 'delivered' || p.state === 'exported') && p.extra === undefined;
}

/** The words an error outcome carries: every one of them has a message. */
function messageOf(o: ErrorOutcome): string {
  return o.message;
}

function resultStep(s: Extract<SaleState, { kind: 'result' }>, e: SaleEvent): SaleStep {
  const o = s.outcome;
  switch (e.type) {
    case 'retry': {
      // a sale that is over (archived, or its record does not read) is never taken again
      if (o.kind === 'not-paid' && o.ended === true) return { state: s, effect: null };
      // While new sales are stopped (slice 2.4, ENG-909 b), Try again after NOT PAID is a new sale. It is refused with
      // the till's words. Hold the card again goes on below, by the owner's rule: a sale past Charge goes on.
      // After TAP THE SAME CARD AGAIN it finishes a payment already begun.
      // After TAP AGAIN it is the first payment of this sale, not a payment already begun. The tap before it finished
      // an older payment of the card. While saves are refused, that payment is recorded at a counter the phone has not
      // stored. That is the same exposure as the first tap of a sale already open.
      // A tap that ended because the till was putting the sale's records away (`sale-busy`) reads NOT PAID even when
      // the card may have signed in an earlier tap (slice 2.4 review). Its Try again may finish a payment already
      // begun, so it goes on below.
      const mayBeBegun = o.kind === 'not-paid' && o.errorKind === 'sale-busy' && s.saleId !== null;
      if (e.stopped === true && o.kind === 'not-paid' && !mayBeBegun) {
        return {
          state: resultOf(s.sats, s.saleId, { kind: 'not-paid', errorKind: 'busy', title: SALES_STOPPED_TITLE, message: SALES_STOPPED_WHY }),
          effect: null,
        };
      }
      if (o.kind === 'tap-again' || o.kind === 'unfinished' || o.kind === 'not-paid') {
        if (s.saleId === null) {
          if (o.kind !== 'not-paid') return { state: s, effect: null };
          if (e.detect || e.shared) return { state: { kind: 'preflight', sats: s.sats, count: 0,
            ...(e.detect ? {mode: 'detecting' as const} : {}), ...(e.shared ? {shared: true as const} : {}) }, effect: null };
          return { state: { kind: 'opening', sats: s.sats }, effect: { kind: 'open-sale', sats: s.sats } };
        }
        if (e.shared && !e.offline && o.kind === 'not-paid' && !mayBeBegun) {
          return { state: { kind: 'preflight', sats: s.sats, count: 0, shared: true, saleId: s.saleId }, effect: null };
        }
        if (e.offline && o.kind === 'not-paid' && !mayBeBegun) {
          return { state: { kind: 'preflight', sats: s.sats, count: 0, mode: 'offline', resumeSaleId: s.saleId }, effect: null };
        }
        return { state: newTap(s.sats, s.saleId, 1, o.kind === 'tap-again'), effect: { kind: 'take', saleId: s.saleId } };
      }
      return { state: s, effect: null };
    }
    case 'other-way':
      if (s.saleId === null) return { state: s, effect: null };
      if (o.kind !== 'tap-again' && o.kind !== 'checking' && o.kind !== 'not-paid-yet') return { state: s, effect: null };
      return { state: resultOf(s.sats, s.saleId, { kind: 'withdraw-asked', back: o }), effect: null };
    case 'withdraw-yes':
      if (o.kind !== 'withdraw-asked') return { state: s, effect: null };
      if (s.saleId === null) return { state: s, effect: null };
      return { state: resultOf(s.sats, s.saleId, { kind: 'withdrawing', back: o.back }), effect: { kind: 'withdraw', saleId: s.saleId } };
    case 'withdraw-no':
      if (o.kind !== 'withdraw-asked') return { state: s, effect: null };
      return { state: resultOf(s.sats, s.saleId, o.back), effect: null };
    case 'withdrawn':
      if (o.kind !== 'withdrawing') return { state: s, effect: null };
      return { state: resultOf(s.sats, s.saleId, { kind: 'withdrawn', paidBefore: e.others.filter(paidBefore) }), effect: null };
    case 'withdraw-failed': {
      if (o.kind !== 'withdrawing') return { state: s, effect: null };
      const failed = errorOutcome(e.error);
      if (failed.kind === 'stop') return { state: resultOf(s.sats, s.saleId, { kind: 'stop', message: failed.message }), effect: null };
      return {
        state: { kind: 'result', sats: s.sats, saleId: s.saleId, outcome: o.back, note: 'The sale was not withdrawn: ' + messageOf(failed) },
        effect: null,
      };
    }
    case 'new':
      if (
        o.kind === 'paid' || o.kind === 'wallet-paid' || o.kind === 'lightning-extra' || o.kind === 'lightning-processing' || o.kind === 'offline-loss' || o.kind === 'saved-offline' || o.kind === 'checking' || o.kind === 'already-paid' || o.kind === 'unfinished' ||
        o.kind === 'not-paid' || o.kind === 'not-paid-yet' || o.kind === 'withdrawn'
      ) {
        return { state: SALE_START, effect: null };
      }
      return { state: s, effect: null };
    case 'settled': {
      if (o.kind !== 'checking' && o.kind !== 'saved-offline') return { state: s, effect: null };
      // a CHECKING whose error named no payment is matched on its sale (a payment's id is its sale's id)
      const mine = o.paymentId !== null ? e.payment.paymentId === o.paymentId : e.payment.id === s.saleId;
      if (!mine) return { state: s, effect: null };
      if (o.kind === 'saved-offline' && e.payment.offline && e.payment.state === 'gone') {
        return { state: resultOf(s.sats, s.saleId, { kind: 'offline-loss' }), effect: null };
      }
      if (!isPaid(e.payment)) return { state: s, effect: null };
      return { state: resultOf(s.sats, s.saleId, { kind: 'paid', payment: e.payment }), effect: null };
    }
    default:
      return { state: s, effect: null };
  }
}

/** The wait that runs in a state, or null. A change of `key` starts the wait again. */
export function timerFor(s: SaleState): { key: string; ms: number } | null {
  switch (s.kind) {
    case 'tap':
      if (s.card || s.queued === true) return null;
      return { key: 'card-' + s.tap, ms: CARD_WAIT_MS };
    case 'confirm':
      return { key: 'confirm', ms: CONFIRM_WAIT_MS };
    case 'preflight':
      return s.shared && !s.mode && !s.count ? null : { key: 'preflight-' + s.count, ms: PIN_WAIT_MS };
    case 'pin':
      return { key: 'pin-' + s.count, ms: PIN_WAIT_MS };
    default:
      return null;
  }
}

/** Whether Android's back may leave the sale screen now. */
export function saleBackAllowed(s: SaleState): boolean {
  if (s.kind === 'keypad') return true;
  if (s.kind !== 'result') return false;
  const o = s.outcome.kind;
  return o === 'paid' || o === 'wallet-paid' || o === 'lightning-extra' || o === 'lightning-processing' || o === 'offline-loss' || o === 'saved-offline' || o === 'checking' || o === 'already-paid' || o === 'unfinished' ||
    o === 'not-paid' || o === 'not-paid-yet' || o === 'withdrawn';
}

/** What a development build reports of the sale (AppReport.sale). Never the PIN, a digit of it, or how many were typed. */
export interface SaleReport {
  step: SaleState['kind'];
  sats: number | null;
  tap: 1 | 2 | null;
  card: boolean | null;
  pinWhy: PinWhy | null;
  pinWrong: boolean | null;
  outcome: SaleOutcome['kind'] | null;
  errorKind: string | null;
  title: string | null;
  paid: { state: string; amount: number; fee: number } | null;
}

export function saleSummary(s: SaleState): SaleReport {
  const report: SaleReport = {
    step: s.kind,
    sats: null,
    tap: null,
    card: null,
    pinWhy: null,
    pinWrong: null,
    outcome: null,
    errorKind: null,
    title: null,
    paid: null,
  };
  switch (s.kind) {
    case 'keypad':
      report.sats = amountOf(s.digits);
      break;
    case 'preflight':
    case 'opening':
    case 'stopping':
      report.sats = s.sats;
      break;
    case 'tap':
      report.sats = s.sats;
      report.tap = s.tap;
      report.card = s.card;
      break;
    case 'confirm':
      report.sats = s.sats;
      break;
    case 'pin':
      report.sats = s.sats;
      report.pinWhy = s.why;
      report.pinWrong = s.wrong;
      break;
    case 'result': {
      report.sats = s.sats;
      const o = s.outcome;
      report.outcome = o.kind;
      if (o.kind === 'not-paid') {
        report.errorKind = o.errorKind;
        report.title = o.title;
      }
      if (o.kind === 'paid') {
        report.paid = { state: o.payment.state, amount: o.payment.amount, fee: o.payment.fee };
      }
      break;
    }
  }
  return report;
}

export function saleStep(s: SaleState, e: SaleEvent): SaleStep {
  if (e.type === 'check-original-invoice' && (s.kind === 'tap' || s.kind === 'stopping') && s.saleId === e.saleId) {
    return {state: {kind:'preflight', shared:true, saleId:s.saleId, verifyInvoice:true, sats:s.sats, count:0}, effect:null};
  }
  if (e.type === 'invoice-received' && (s.kind === 'tap' || s.kind === 'stopping') && s.saleId === e.saleId) {
    let outcome: SaleOutcome;
    switch (e.state) {
      case 'paid': outcome = {kind: 'wallet-paid', rail: 'Lightning'}; break;
      case 'extra': outcome = {kind: 'lightning-extra'}; break;
      case 'processing': outcome = {kind: 'lightning-processing'}; break;
    }
    return {state: resultOf(s.sats, s.saleId, outcome), effect: null};
  }
  if (e.type === 'confirm-asked' && s.kind !== 'tap') {
    return { state: s, effect: { kind: 'answer-confirm', pay: false, pin: false } };
  }
  if (e.type === 'pin-asked' && s.kind !== 'tap') {
    return { state: s, effect: { kind: 'answer-pin', give: false } };
  }
  switch (s.kind) {
    case 'keypad':
      return keypadStep(s, e);
    case 'preflight':
      return preflightStep(s, e);
    case 'opening':
      return openingStep(s, e);
    case 'tap':
      return tapStep(s, e);
    case 'confirm':
      return confirmStep(s, e);
    case 'pin':
      return pinStep(s, e);
    case 'stopping':
      return stoppingStep(s, e);
    case 'result':
      return resultStep(s, e);
  }
}
