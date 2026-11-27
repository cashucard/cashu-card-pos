/* A sale the card may already have signed for stays on TAP THE SAME CARD AGAIN until it ends: PAID, ALREADY PAID or
 * withdrawn. A later tap of it that ends without finishing it is never NOT PAID, never says "Nothing was taken", and
 * never offers a new sale or Android's back. */

import { CardError } from 'cashucard';
import { CONFIRMATION, heldPayment } from './helpers/fake-till';
import {
  DECLINED_AGAIN,
  MAY_HAVE_SIGNED,
  OPEN_CANCELLED,
  saleBackAllowed,
  saleStep,
  saleSummary,
  SALE_START,
  SALE_WAITS,
  type SaleEvent,
  type SaleOutcome,
  type SaleState,
  type SaleStep,
  type TapState,
} from '../src/till/sale-machine';
import { cancelledError } from '../src/till/tap-session';

/** One step, checking that the state it was given is left as it was. */
function run(s: SaleState, e: SaleEvent): SaleStep {
  const before = JSON.stringify(s);
  const step = saleStep(s, e);
  expect(JSON.stringify(s)).toBe(before);
  return step;
}

function outcomeOf(s: SaleState): SaleOutcome {
  if (s.kind !== 'result') throw new Error('expected a result, got ' + s.kind);
  return s.outcome;
}

/** A sale's result holds the TAP THE SAME CARD AGAIN rules: no new sale, no back, withdraw offered. */
function holdsTheCard(s: SaleState): void {
  expect(outcomeOf(s).kind).toBe('tap-again');
  expect(run(s, { type: 'new' }).state).toBe(s);
  expect(saleBackAllowed(s)).toBe(false);
  expect(outcomeOf(run(s, { type: 'other-way' }).state).kind).toBe('withdraw-asked');
  const words = JSON.stringify(s);
  expect(/not paid/i.test(words)).toBe(false);
  expect(words.includes('Nothing was taken')).toBe(false);
  expect(saleSummary(s).outcome).toBe('tap-again');
}

const SIGNED_DROP = new CardError('interrupted', 'The card was taken away as it was signing.', { signed: true });
const WAITS = new CardError(
  'same-sale',
  'This sale has been paid already, or waits for a payment that may have been signed. Nothing was taken.',
);
const tap2Card: TapState = { kind: 'tap', sats: 2100, saleId: 's1', tap: 2, card: true, words: null, ending: null };

/** TAP THE SAME CARD AGAIN after tap 2 dropped as the card signed, then Hold the card again: tap 1 of the retry. */
function retried(): { result: SaleState; tap: SaleState } {
  const result = run(tap2Card, { type: 'failed', error: SIGNED_DROP }).state;
  const again = run(result, { type: 'retry' });
  expect(again.effect).toEqual({ kind: 'take', saleId: 's1' });
  return { result, tap: again.state };
}

describe('a sale the card may have signed for', () => {
  it('Hold the card again remembers that the card may have signed', () => {
    const { result, tap } = retried();
    holdsTheCard(result);
    expect(tap).toEqual({
      kind: 'tap', sats: 2100, saleId: 's1', tap: 1, card: false, words: null, ending: null, signedBefore: true,
    });
  });

  it('a cancelled retry stays TAP THE SAME CARD AGAIN', () => {
    const { tap } = retried();
    const stopping = run(tap, { type: 'cancel' });
    expect(stopping.state).toEqual({ kind: 'stopping', sats: 2100, saleId: 's1', ending: 'cancel', signedBefore: true });
    expect(stopping.effect).toEqual({ kind: 'stop' });
    const end = run(stopping.state, { type: 'failed', error: cancelledError() }).state;
    expect(outcomeOf(end)).toEqual({ kind: 'tap-again', message: 'Cancelled. ' + MAY_HAVE_SIGNED });
    holdsTheCard(end);
  });

  it('a retry whose wait ran out stays TAP THE SAME CARD AGAIN', () => {
    const { tap } = retried();
    const stopping = run(tap, { type: 'timeout' }).state;
    const end = run(stopping, { type: 'failed', error: cancelledError() }).state;
    expect(outcomeOf(end)).toEqual({ kind: 'tap-again', message: 'Time ran out. ' + MAY_HAVE_SIGNED });
    holdsTheCard(end);
  });

  it("the library's refusal of a second payment is never NOT PAID", () => {
    const { tap } = retried();
    const end = run(tap, { type: 'failed', error: WAITS }).state;
    expect(outcomeOf(end)).toEqual({ kind: 'tap-again', message: SALE_WAITS });
    holdsTheCard(end);
    const fresh: TapState = { kind: 'tap', sats: 2100, saleId: 's1', tap: 1, card: true, words: null, ending: null };
    const first = run(fresh, { type: 'failed', error: WAITS }).state;
    expect(outcomeOf(first)).toEqual({ kind: 'tap-again', message: SALE_WAITS });
    holdsTheCard(first);
    expect(run(first, { type: 'retry' }).state).toMatchObject({ kind: 'tap', signedBefore: true });
    const sheet: SaleState = { kind: 'confirm', sats: 2100, saleId: 's1', c: CONFIRMATION };
    holdsTheCard(run(sheet, { type: 'failed', error: WAITS }).state);
    const stopping: SaleState = { kind: 'stopping', sats: 2100, saleId: 's1', ending: 'cancel' };
    holdsTheCard(run(stopping, { type: 'failed', error: WAITS }).state);
  });

  it('every later failure of the sale keeps it, with its own title first', () => {
    const { tap } = retried();
    const cases: Array<[unknown, string]> = [
      [new CardError('not-enough', 'The card holds 12 sats. Nothing was taken.'), 'Not enough on the card'],
      [new CardError('other-card', 'That is not the card read before. Nothing was taken from it.'), 'A different card was held'],
      [new CardError('gone', 'The card was taken away. Nothing was taken.'), 'The card was moved away'],
      [new CardError('stopped', 'Stopped. Nothing was taken.'), 'Stopped'],
      [new Error('boom'), 'Something went wrong'],
      [new CardError('unfinished', 'An earlier payment of this card was finished first.'), 'An earlier payment was finished first'],
    ];
    for (const [error, title] of cases) {
      const end = run(tap, { type: 'failed', error }).state;
      expect(outcomeOf(end)).toEqual({ kind: 'tap-again', message: title + '. ' + MAY_HAVE_SIGNED });
      holdsTheCard(end);
    }
  });

  it('the memory goes through the sheet, the PIN pad and tap 2', () => {
    const { tap } = retried();
    const card = run(tap, { type: 'card-here' }).state;
    expect(card).toMatchObject({ kind: 'tap', card: true, signedBefore: true });
    const sheet = run(card, { type: 'confirm-asked', c: CONFIRMATION }).state;
    expect(sheet).toEqual({ kind: 'confirm', sats: 2100, saleId: 's1', c: CONFIRMATION, signedBefore: true });
    const pin = run(sheet, { type: 'pay' }).state;
    expect(pin).toMatchObject({ kind: 'pin', from: 'confirm', signedBefore: true });
    let s = pin;
    for (let i = 0; i < 4; i += 1) s = run(s, { type: 'pin-key' }).state;
    const tap2 = run(s, { type: 'pin-ok' }).state;
    expect(tap2).toEqual({
      kind: 'tap', sats: 2100, saleId: 's1', tap: 2, card: false, words: null, ending: null, signedBefore: true,
    });
    holdsTheCard(run(tap2, { type: 'failed', error: new CardError('not-enough', 'n.') }).state);

    const declining = run(sheet, { type: 'decline' }).state;
    expect(declining).toEqual({ kind: 'stopping', sats: 2100, saleId: 's1', ending: 'sheet-no', signedBefore: true });
    const declined = run(declining, {
      type: 'failed',
      error: new CardError('declined', 'The payer did not accept. Nothing was taken.'),
    }).state;
    expect(outcomeOf(declined)).toEqual({ kind: 'tap-again', message: DECLINED_AGAIN + '. ' + MAY_HAVE_SIGNED });
    holdsTheCard(declined);

    const cancelledPin = run(pin, { type: 'pin-cancel' }).state;
    expect(cancelledPin).toEqual({ kind: 'stopping', sats: 2100, saleId: 's1', ending: 'pin-cancel', signedBefore: true });
    const pinEnd = run(cancelledPin, { type: 'failed', error: new CardError('declined', 'd.') }).state;
    expect(outcomeOf(pinEnd)).toEqual({ kind: 'tap-again', message: 'Cancelled. ' + MAY_HAVE_SIGNED });

    const asked = run(card, { type: 'pin-asked', why: 'recover', wrong: false, tries: 3 }).state;
    expect(asked).toMatchObject({ kind: 'pin', from: 'ask', signedBefore: true });
    const back = run(asked, { type: 'pin-cancel' });
    expect(back.state).toBe(card);
    expect(back.effect).toEqual({ kind: 'answer-pin', give: false });
    const noPin = run(back.state, { type: 'failed', error: new CardError('no-pin', 'The PIN was not given. Nothing was taken.') }).state;
    expect(outcomeOf(noPin)).toEqual({ kind: 'tap-again', message: 'The PIN was not given. ' + MAY_HAVE_SIGNED });
    const pinFailed = run(asked, { type: 'failed', error: new CardError('gone', 'g.') }).state;
    expect(outcomeOf(pinFailed)).toEqual({ kind: 'tap-again', message: 'The card was moved away. ' + MAY_HAVE_SIGNED });
  });

  it('the memory ends only with the sale', () => {
    const { result, tap } = retried();
    const paid = run(tap, { type: 'done', payment: heldPayment('s1') }).state;
    expect(outcomeOf(paid).kind).toBe('paid');
    expect(run(paid, { type: 'new' }).state).toBe(SALE_START);
    const already = run(tap, {
      type: 'failed',
      error: new CardError('same-sale', 'This sale was already paid.', { paymentId: 'pay:9', extra: 'paid-twice', signed: true }),
    }).state;
    expect(outcomeOf(already).kind).toBe('already-paid');
    expect(run(already, { type: 'new' }).state).toBe(SALE_START);
    const asked = run(result, { type: 'other-way' }).state;
    const withdrawing = run(asked, { type: 'withdraw-yes' }).state;
    const withdrawn = run(withdrawing, { type: 'withdrawn', others: [] }).state;
    expect(outcomeOf(withdrawn).kind).toBe('withdrawn');
    expect(run(withdrawn, { type: 'new' }).state).toBe(SALE_START);
    const kept = run(asked, { type: 'withdraw-no' }).state;
    expect(outcomeOf(kept)).toBe(outcomeOf(result));
    expect(run(kept, { type: 'retry' }).state).toMatchObject({ kind: 'tap', signedBefore: true });
    const swap = new CardError('swap-lost', 'The mint has not taken it yet.', { signed: true, entry: 'pay:1' });
    expect(outcomeOf(run(tap, { type: 'failed', error: swap }).state).kind).toBe('checking');
    const lost = new CardError('payment-lost', 'NOT PAID: the mint says spent.', { signed: true, paymentId: 'pay:1' });
    expect(outcomeOf(run(tap, { type: 'failed', error: lost }).state).kind).toBe('not-paid-yet');
    expect(outcomeOf(run(tap, { type: 'failed', error: new CardError('journal', 'j.') }).state).kind).toBe('stop');
  });

  it('a sale the card has not signed for is told as before', () => {
    const fresh: TapState = { kind: 'tap', sats: 2100, saleId: 's1', tap: 1, card: false, words: null, ending: null };
    const stopping = run(fresh, { type: 'cancel' }).state;
    expect('signedBefore' in stopping).toBe(false);
    const end = run(stopping, { type: 'failed', error: cancelledError() }).state;
    expect(outcomeOf(end)).toMatchObject({ kind: 'not-paid', errorKind: 'stopped', title: 'Cancelled' });
    expect(run(end, { type: 'new' }).state).toBe(SALE_START);
    const poor = run(fresh, { type: 'failed', error: new CardError('not-enough', 'n.') }).state;
    expect(outcomeOf(poor)).toMatchObject({ kind: 'not-paid', errorKind: 'not-enough' });
    const again = run(poor, { type: 'retry' }).state;
    expect('signedBefore' in again).toBe(false);
    const unfinished = run(fresh, { type: 'failed', error: new CardError('unfinished', 'u.') }).state;
    expect(outcomeOf(unfinished)).toEqual({ kind: 'unfinished', message: 'u.' });
    expect('signedBefore' in run(unfinished, { type: 'retry' }).state).toBe(false);
  });

  it('a sale is cancelled while it is being opened', () => {
    const opening: SaleState = { kind: 'opening', sats: 2100 };
    const step = run(opening, { type: 'cancel' });
    expect(step.state).toEqual({
      kind: 'result',
      sats: 2100,
      saleId: null,
      outcome: { kind: 'not-paid', errorKind: 'stopped', title: 'Cancelled', message: OPEN_CANCELLED },
      note: null,
    });
    expect(step.effect).toBeNull();
    expect(run(step.state, { type: 'opened', saleId: 's1' }).state).toBe(step.state);
    expect(saleBackAllowed(step.state)).toBe(true);
    const again = run(step.state, { type: 'retry' });
    expect(again.state).toEqual({ kind: 'opening', sats: 2100 });
    expect(again.effect).toEqual({ kind: 'open-sale', sats: 2100 });
  });
});

