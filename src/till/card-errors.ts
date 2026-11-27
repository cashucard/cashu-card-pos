/* What a card payment's failure means for the sale: the title over the library's message, and the outcome. The rule that
 * matters most: a signed error is never "NOT PAID", because the card may have spent its money and the payment can still
 * finish. */

import { CardError, type CardErrorKind } from 'cashucard';

/** The title over the library's message on a NOT PAID screen, one per kind. The compiler refuses a missing kind. */
export const CARD_ERROR_TITLES: Readonly<Record<CardErrorKind, string>> = {
  gone: 'The card was moved away',
  stopped: 'Stopped',
  'not-a-card': 'This is not a Cashu Card',
  'old-card': 'This card needs new software',
  'not-set-up': 'This card is not set up',
  'other-card': 'A different card was held',
  busy: 'The till is busy',
  'no-reader': 'No card reader',
  'wrong-pin': 'Wrong PIN',
  blocked: "This card's PIN is blocked",
  'pin-needed': 'The card needs its PIN',
  'no-pin': 'The PIN was not given',
  'pin-first': 'This card has no PIN yet',
  'bad-pin': 'That PIN cannot be used',
  limit: "The card's limit for today is reached",
  locked: 'This card is locked',
  'no-record': 'The card has no record of this payment',
  'too-many': 'Too many pieces for one payment',
  full: 'The card is full',
  'no-rate': "There is no price in this card's money",
  'two-units': 'This card holds two kinds of money',
  'keep-holding': 'Keep holding the card',
  'keys-not-taught': 'The card cannot make change at this mint',
  'card-fault': 'The card did not answer as it should',
  'begun-again': 'The card started over',
  refused: 'The card refused',
  'bad-signature': "The card's answer did not check",
  interrupted: 'The card was moved away',
  'bad-sale': 'This sale cannot be paid',
  empty: 'Nothing to pay with',
  'same-sale': 'This sale is already paid or being paid',
  unfinished: 'An earlier payment was finished first',
  'not-enough': 'Not enough on the card',
  'needs-exact': 'The card cannot pay this amount exactly',
  'fee-changed': "The mint's fee changed",
  'plan-changed': 'The payment changed between the taps',
  declined: 'Not paid',
  unit: 'The card holds another kind of money',
  onion: 'This till does not take .onion mints',
  'unit-not-priced': "There is no price in this card's money",
  'over-most': 'Too much is waiting at this mint',
  'keyset-changed': 'The mint changed its keys',
  'too-many-claims': 'This card has too many unfinished payments',
  ambiguous: 'More than one payment',
  'sale-busy': 'The till is archiving this sale',
  'sale-archived': 'This sale is over',
  'sale-unreadable': "This sale's record cannot be read",
  mint: 'The mint did not answer',
  'mint-not-accepted': "This till does not take this card's mint",
  'mint-fee': "This mint's fee is too high",
  'swap-lost': 'The mint did not answer',
  'payment-lost': 'The mint has not paid this',
  'payout-silent': 'The payout did not answer',
  'delivery-unanswered': 'The payout has not answered',
  journal: 'The till could not write its record',
  'journal-rolled-back': 'The payment record is older',
  'journal-in-use': 'Another copy of the till holds the record',
  'mint-lacks-unit': 'This mint does not take sats',
  'payout-cannot-place': 'The till cannot take this payment now',
  'card-changed': 'The card changed between the taps',
  'nothing-to-offer': 'The mint did not answer',
  internal: 'Something went wrong',
};

/** What a failed card payment means for the sale. */
export type ErrorOutcome =
  | { kind: 'already-paid'; extra: 'paid-twice' | 'late'; paymentId: string | null; message: string }
  | { kind: 'checking'; paymentId: string | null; message: string }
  | { kind: 'not-paid-yet'; message: string }
  | { kind: 'stop'; message: string }
  | { kind: 'tap-again'; message: string }
  | { kind: 'unfinished'; message: string }
  | { kind: 'busy'; message: string }
  | { kind: 'not-paid'; errorKind: CardErrorKind; title: string; message: string };

/** The till's own words for the three kinds of a sale's records (cashucard 0.3.0), shown in place of the library's
 * message (which names its own calls). */
export const SALE_RECORD_WORDS: Readonly<Record<'sale-busy' | 'sale-archived' | 'sale-unreadable', string>> = {
  'sale-busy': "The till is putting this sale's records away. Nothing was taken. Try again in a moment.",
  'sale-archived': 'This sale is over and its records were archived. Nothing was taken.',
  'sale-unreadable': "This sale's record cannot be read on this phone. Nothing was taken. Records says more.",
};

/** Shown for anything thrown that is not a CardError: the library never throws one from a take, so it came from the
 * till before the card was asked. */
export const UNKNOWN_ERROR_MESSAGE = 'Something went wrong before the card was asked. Nothing was taken.';
/** Shown for a signed error whose message is empty. */
export const SIGNED_EMPTY_MESSAGE = 'The card had signed. The till keeps this payment.';

/** A details value as a string, or null when it is not one. */
function text(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Whether the card had signed: `e.signed`, or `e.details.signed === true`. */
export function wasSigned(e: CardError): boolean {
  return e.signed === true || e.details.signed === true;
}

/** The words shown under the title: the library's own message, trimmed. For a signed error, a leading 'NOT PAID: ' is
 * taken off and the next letter made a capital; an empty message becomes SIGNED_EMPTY_MESSAGE (signed) or
 * 'Nothing was taken.' (not signed). */
export function errorMessage(e: CardError): string {
  const signed = wasSigned(e);
  let m = e.message.trim();
  if (signed && m.startsWith('NOT PAID: ')) {
    m = m.slice('NOT PAID: '.length);
    if (m.length > 0) m = m.charAt(0).toUpperCase() + m.slice(1);
  }
  if (m.length === 0) return signed ? SIGNED_EMPTY_MESSAGE : 'Nothing was taken.';
  return m;
}

/** While the phone's secure store refuses to save the record's generation, the till takes no new sale (slice 2.4,
 * ENG-909 b). Home shows SALES_STOPPED; a sale refused on the sale screen shows its two parts under NOT PAID. */
export const SALES_STOPPED_TITLE = 'New sales are stopped';
export const SALES_STOPPED_WHY =
  "This phone did not save the record's safety counter. Payments already taken are kept and settled. Close the app and open it again; if this stays, restart the phone.";
export const SALES_STOPPED = SALES_STOPPED_TITLE + '. ' + SALES_STOPPED_WHY;

/** A new sale asked while new sales are stopped: nothing was opened, nothing was written. */
export class SalesStoppedError extends Error {
  constructor() {
    super(SALES_STOPPED);
    this.name = 'SalesStoppedError';
    Object.setPrototypeOf(this, SalesStoppedError.prototype);
  }
}

/** The outcome of anything a take or a sale's opening threw. */
export function errorOutcome(e: unknown): ErrorOutcome {
  if (e instanceof SalesStoppedError) {
    return { kind: 'not-paid', errorKind: 'busy', title: SALES_STOPPED_TITLE, message: SALES_STOPPED_WHY };
  }
  if (!(e instanceof CardError)) {
    return {
      kind: 'not-paid',
      errorKind: 'internal',
      title: CARD_ERROR_TITLES.internal,
      message: UNKNOWN_ERROR_MESSAGE,
    };
  }
  const message = errorMessage(e);
  if (e.kind === 'same-sale') {
    const extra = e.details.extra;
    if (extra === 'paid-twice' || extra === 'late') {
      return { kind: 'already-paid', extra, paymentId: text(e.details.paymentId), message };
    }
  }
  if (e.kind === 'journal' || e.kind === 'journal-in-use' || e.kind === 'journal-rolled-back') {
    return { kind: 'stop', message };
  }
  if (e.kind === 'busy') {
    return { kind: 'busy', message };
  }
  if (wasSigned(e)) {
    if (e.kind === 'swap-lost' || e.kind === 'mint' || (e.kind === 'bad-signature' && e.details.by === 'mint')) {
      return { kind: 'checking', paymentId: text(e.details.paymentId) ?? text(e.details.entry), message };
    }
    if (e.kind === 'payment-lost') {
      return { kind: 'not-paid-yet', message };
    }
    return { kind: 'tap-again', message };
  }
  if (e.kind === 'unfinished') {
    return { kind: 'unfinished', message };
  }
  if (e.kind === 'sale-busy' || e.kind === 'sale-archived' || e.kind === 'sale-unreadable') {
    return { kind: 'not-paid', errorKind: e.kind, title: CARD_ERROR_TITLES[e.kind], message: SALE_RECORD_WORDS[e.kind] };
  }
  return { kind: 'not-paid', errorKind: e.kind, title: CARD_ERROR_TITLES[e.kind], message };
}
