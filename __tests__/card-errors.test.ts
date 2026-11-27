/* The one table that turns each card error into what the merchant is told: a title per kind, and an outcome. */
import { CardError, type CardErrorKind } from 'cashucard';
import {
  CARD_ERROR_TITLES,
  SIGNED_EMPTY_MESSAGE,
  UNKNOWN_ERROR_MESSAGE,
  errorMessage,
  errorOutcome,
  wasSigned,
} from '../src/till/card-errors';

const ALL_KINDS: CardErrorKind[] = [
  'gone',
  'stopped',
  'not-a-card',
  'old-card',
  'not-set-up',
  'other-card',
  'busy',
  'no-reader',
  'wrong-pin',
  'blocked',
  'pin-needed',
  'no-pin',
  'pin-first',
  'bad-pin',
  'limit',
  'locked',
  'no-record',
  'too-many',
  'full',
  'no-rate',
  'two-units',
  'keep-holding',
  'keys-not-taught',
  'card-fault',
  'begun-again',
  'refused',
  'bad-signature',
  'interrupted',
  'bad-sale',
  'same-sale',
  'unfinished',
  'empty',
  'not-enough',
  'needs-exact',
  'fee-changed',
  'plan-changed',
  'declined',
  'unit',
  'onion',
  'unit-not-priced',
  'over-most',
  'keyset-changed',
  'too-many-claims',
  'ambiguous',
  'mint',
  'mint-not-accepted',
  'mint-fee',
  'swap-lost',
  'payment-lost',
  'payout-silent',
  'delivery-unanswered',
  'journal',
  'journal-rolled-back',
  'journal-in-use',
  'mint-lacks-unit',
  'payout-cannot-place',
  'card-changed',
  'nothing-to-offer',
  'internal',
  'sale-busy',
  'sale-archived',
  'sale-unreadable',
];

function err(
  kind: CardErrorKind,
  message: string,
  extra?: { sw?: string; signed?: boolean } & Record<string, unknown>,
): CardError {
  return new CardError(kind, message, extra);
}

describe('the card error table', () => {
  it('every kind has a plain title', () => {
    const keys = Object.keys(CARD_ERROR_TITLES).sort();
    expect(keys).toEqual([...ALL_KINDS].sort());
    expect(keys).toHaveLength(62);
    for (const kind of ALL_KINDS) {
      const title = CARD_ERROR_TITLES[kind];
      expect(title.length).toBeGreaterThan(0);
      expect(title).not.toContain('—');
      expect(title).not.toContain('–');
      expect(title).not.toMatch(/crypto|paid back/i);
      expect(title).not.toContain('NOT PAID');
    }
  });

  it('a signed error is never NOT PAID', () => {
    for (const kind of ALL_KINDS) {
      expect(errorOutcome(err(kind, 'm.', { signed: true })).kind).not.toBe('not-paid');
    }
  });

  it('a signed error the mint must finish is checking', () => {
    const swapLost = errorOutcome(err('swap-lost', 'm.', { signed: true, entry: 'pay:1' }));
    expect(swapLost.kind).toBe('checking');
    expect(swapLost).toMatchObject({ paymentId: 'pay:1' });

    const mint = errorOutcome(err('mint', 'm.', { signed: true }));
    expect(mint.kind).toBe('checking');
    expect(mint).toMatchObject({ paymentId: null });

    const badSignature = errorOutcome(err('bad-signature', 'm.', { signed: true, by: 'mint', paymentId: 'pay:2' }));
    expect(badSignature.kind).toBe('checking');
    expect(badSignature).toMatchObject({ paymentId: 'pay:2' });
  });

  it('a signed error the card must finish asks for the same card', () => {
    expect(errorOutcome(err('interrupted', 'm.', { signed: true }))).toEqual({ kind: 'tap-again', message: 'm.' });
    expect(errorOutcome(err('internal', 'm.', { signed: true }))).toEqual({ kind: 'tap-again', message: 'm.' });
    expect(errorOutcome(err('pin-needed', 'm.', { signed: true }))).toEqual({ kind: 'tap-again', message: 'm.' });
    expect(errorOutcome(err('bad-signature', 'm.', { signed: true, by: 'card' }))).toEqual({
      kind: 'tap-again',
      message: 'm.',
    });
  });

  it('a payment the mint has not paid is not paid yet', () => {
    expect(errorOutcome(err('payment-lost', 'NOT PAID: this card had signed earlier.', { signed: true }))).toEqual({
      kind: 'not-paid-yet',
      message: 'This card had signed earlier.',
    });
  });

  it('a sale paid already goes back to the card, signed or not', () => {
    expect(
      errorOutcome(err('same-sale', 'm.', { paymentId: 'pay:3', extra: 'paid-twice', signed: true })),
    ).toMatchObject({ kind: 'already-paid', extra: 'paid-twice', paymentId: 'pay:3' });
    expect(errorOutcome(err('same-sale', 'm.', { paymentId: 'pay:4', extra: 'late' }))).toMatchObject({
      kind: 'already-paid',
      extra: 'late',
      paymentId: 'pay:4',
    });
    expect(errorOutcome(err('same-sale', 'm.'))).toMatchObject({
      kind: 'not-paid',
      title: 'This sale is already paid or being paid',
    });
  });

  it("the record's errors stop the till", () => {
    for (const kind of ['journal', 'journal-in-use', 'journal-rolled-back'] as const) {
      expect(errorOutcome(err(kind, 'm.', { signed: true })).kind).toBe('stop');
      expect(errorOutcome(err(kind, 'm.')).kind).toBe('stop');
    }
  });

  it('busy has an outcome of its own', () => {
    expect(errorOutcome(err('busy', 'A card is being read already.'))).toEqual({
      kind: 'busy',
      message: 'A card is being read already.',
    });
  });

  it('an earlier payment finished first asks for the card again', () => {
    expect(errorOutcome(err('unfinished', 'm.'))).toEqual({ kind: 'unfinished', message: 'm.' });
  });

  it('every other error that took nothing is NOT PAID under its title', () => {
    expect(errorOutcome(err('not-enough', 'The card holds 12 sats.'))).toEqual({
      kind: 'not-paid',
      errorKind: 'not-enough',
      title: 'Not enough on the card',
      message: 'The card holds 12 sats.',
    });
    expect(errorOutcome(err('needs-exact', 'm.'))).toMatchObject({
      kind: 'not-paid',
      title: 'The card cannot pay this amount exactly',
    });
    expect(errorOutcome(err('wrong-pin', 'm.'))).toMatchObject({ kind: 'not-paid', title: 'Wrong PIN' });
    expect(errorOutcome(err('nothing-to-offer', 'm.'))).toMatchObject({
      kind: 'not-paid',
      title: 'The mint did not answer',
    });
  });

  it('a card error signed by its details counts as signed', () => {
    const e = err('interrupted', 'x');
    (e.details as Record<string, unknown>).signed = true;
    expect(wasSigned(e)).toBe(true);
    expect(errorOutcome(e).kind).toBe('tap-again');
  });

  it('anything that is not a card error took nothing', () => {
    const expected = {
      kind: 'not-paid',
      errorKind: 'internal',
      title: 'Something went wrong',
      message: UNKNOWN_ERROR_MESSAGE,
    };
    expect(errorOutcome(new Error('boom'))).toEqual(expected);
    expect(errorOutcome('x')).toEqual(expected);
  });

  it('the words under the title', () => {
    expect(errorMessage(err('mint', '  Gone.  '))).toBe('Gone.');
    expect(errorMessage(err('mint', 'NOT PAID: x'))).toBe('NOT PAID: x');
    expect(errorMessage(err('mint', '', { signed: true }))).toBe(SIGNED_EMPTY_MESSAGE);
    expect(errorMessage(err('mint', ''))).toBe('Nothing was taken.');
  });
});
