import { noticeKey, noticeOf, noticeToneOf } from '../src/till/settle';
import { nowPaidIds } from '../src/till/service';
import type { Payment } from 'cashucard';
import type { PaymentWords } from '../src/till/payment-words';
import { isPaid, paymentFigures, paymentWords } from '../src/till/payment-words';
import { heldPayment } from './helpers/fake-till';

const p = (o: Partial<Payment>): Payment => ({ ...heldPayment('s1'), ...o });

const STATES: Payment['state'][] = [
  'taking',
  'held',
  'delivered',
  'exported',
  'gone',
  'unrecovered',
  'lost',
  'spent-not-restored',
  'returning',
  'returned',
];

/** Every row of the table; the last one is a state this till does not know. */
const ROWS: Array<{ state: Payment['state']; why?: string; extra?: Payment['extra'] }> = [
  { state: 'taking', why: 'bad-signature' },
  { state: 'taking', why: 'swap-waiting: 503' },
  { state: 'taking' },
  { state: 'held', why: 'date-too-near', extra: 'late' },
  { state: 'held', extra: 'paid-twice' },
  { state: 'held', extra: 'late' },
  { state: 'held' },
  { state: 'delivered' },
  { state: 'exported' },
  { state: 'gone' },
  { state: 'unrecovered' },
  { state: 'lost' },
  { state: 'spent-not-restored' },
  { state: 'returning' },
  { state: 'returned' },
  { state: 'none' as unknown as Payment['state'] },
];

const read = (o: Partial<Payment>): PaymentWords => paymentWords(p(o));

/** What a payment says, without its figures: one row of the table. */
const said = (o: Partial<Payment>): { headline: string; sentence: string } => {
  const w = read(o);
  return { headline: w.headline, sentence: w.sentence };
};

describe('a payment in plain words', () => {
  it('directs a wallet payer to keep a pending token and the cashier to return late ecash through Owed to cards', () => {
    expect(said({ state: 'taking' }).sentence).toContain('Keep the original token');
    expect(said({ state: 'held', extra: 'late' }).sentence).toContain('Owed to cards');
    expect(said({ state: 'held', extra: 'paid-twice' }).sentence).toContain('customer’s wallet');
  });

  it('each state reads as the table says', () => {
    expect(said({ state: 'taking', why: 'bad-signature' })).toEqual({
      headline: 'CHECKING',
      sentence: 'The mint has not proved its signatures yet. The till asks it again.',
    });
    expect(said({ state: 'taking', why: 'swap-waiting: 503' })).toEqual({
      headline: 'CHECKING',
      sentence: 'The mint has not taken the payment yet. The till sends it again.',
    });
    expect(said({ state: 'taking', cardKey: 'card' })).toEqual({
      headline: 'CHECKING',
      sentence:
        'The card has paid. The till is checking the payment with the mint. Do not hand over the goods yet.',
    });
    expect(said({ state: 'held', why: 'date-too-near', extra: 'late' })).toEqual({
      headline: 'KEPT FOR THE CUSTOMER',
      sentence: "It cannot go back to the card yet: the card's date is too near. It is kept for the customer.",
    });
    expect(said({ state: 'held', extra: 'paid-twice', cardKey: 'card' })).toEqual({
      headline: 'PAID TWICE',
      sentence: 'This sale was already paid. This payment goes back to the card at its next tap.',
    });
    expect(said({ state: 'held', extra: 'late', cardKey: 'card' })).toEqual({
      headline: 'PAID LATE',
      sentence: 'This sale was withdrawn before this payment arrived. It goes back to the card at its next tap.',
    });
    expect(said({ state: 'held' })).toEqual({
      headline: 'PAID',
      sentence: "Paid. The money is in this phone's record, waiting to be kept in its wallet.",
    });
    expect(said({ state: 'delivered' })).toEqual({
      headline: 'PAID',
      sentence: "Paid and kept in this phone's wallet.",
    });
    expect(said({ state: 'exported' })).toEqual({
      headline: 'TAKEN OUT',
      sentence: 'Paid and taken out by hand as a token.',
    });
    expect(said({ state: 'gone' })).toEqual({
      headline: 'LOST',
      sentence: 'The mint says these pieces were spent elsewhere. Nobody this till can reach has them.',
    });
    expect(said({ state: 'unrecovered' })).toEqual({
      headline: 'NOT FINISHED',
      sentence: 'The card spent its pieces but has not given its signature. Tap the same card again, with its PIN.',
    });
    expect(said({ state: 'lost' })).toEqual({
      headline: 'NOT PAID YET: THE MINT CHANGED ITS KEYS',
      sentence: 'The mint changed its keys while the card signed. The till asks the mint again.',
    });
    expect(said({ state: 'spent-not-restored' })).toEqual({
      headline: 'NOT PAID YET: A FAULT AT THE MINT',
      sentence: "The mint says the card's pieces are spent but gave nothing back. The till asks the mint again.",
    });
    expect(said({ state: 'returning' })).toEqual({
      headline: 'GOING BACK TO THE CARD',
      sentence: 'This payment is being made back into money for the card.',
    });
    expect(said({ state: 'returned', owedToCard: 13 })).toEqual({
      headline: 'OWED TO THE CARD',
      sentence: 'It is written back to the card at its next tap, with the PIN.',
    });
    expect(said({ state: 'returned' })).toEqual({
      headline: 'WRITTEN TO THE CARD',
      sentence: "The customer's money was written to the card, and the till has confirmed it.",
    });
    expect(said({ state: 'none' as unknown as Payment['state'] })).toEqual({
      headline: 'CHECKING',
      sentence: 'The till is checking this payment.',
    });
  });

  it('PAID only for a held payment that is not extra, or a delivered one', () => {
    for (const state of STATES) {
      const q = p({ state });
      const want = state === 'held' || state === 'delivered';
      expect(isPaid(q)).toBe(want);
      expect(paymentWords(q).headline === 'PAID').toBe(want);
    }
    for (const extra of ['paid-twice', 'late'] as const) {
      const q = p({ state: 'held', extra });
      expect(isPaid(q)).toBe(false);
      expect(paymentWords(q).headline === 'PAID').toBe(false);
    }
  });

  it('a payment being taken is checking, whatever it waits for', () => {
    for (const why of [undefined, 'bad-signature', 'swap-waiting: 503']) {
      expect(paymentWords(p({ state: 'taking', why })).headline).toBe('CHECKING');
    }
  });

  it('the figures above zero, in order', () => {
    const w = paymentWords(
      p({ owedToCard: 5, unconfirmed: 3, givenBack: 14, kept: 1, stuck: 2, unproved: 1, lost: 7 }),
    );
    expect(w.figures.map((f) => f.id)).toEqual([
      'owed',
      'unconfirmed',
      'written',
      'kept',
      'stuck',
      'unproved',
      'lost',
    ]);
    expect(w.figures.map((f) => f.words)).toEqual([
      'Owed to the card, not written yet: 5 sats',
      'Written to the card, not confirmed yet: 3 sats',
      'Change written to the card: 11 sats',
      'Kept by the till: 1 sat (too small to give back)',
      "Change waiting for the mint's proof: 2 sats",
      'Change the mint never proved: 1 sat. It stays owed.',
      'Lost from the card: 7 sats',
    ]);
  });

  it('no figure for nothing', () => {
    expect(paymentWords(heldPayment('s1')).figures).toEqual([]);
    const w = paymentWords(p({ givenBack: 5, unconfirmed: 5 }));
    expect(w.figures.map((f) => f.id)).toEqual(['unconfirmed']);
  });

  it('the two owed figures are never added', () => {
    const figures = paymentFigures(p({ owedToCard: 5, unconfirmed: 3 }));
    expect(figures.map((f) => f.id)).toEqual(['owed', 'unconfirmed']);
    for (const f of figures) {
      expect(f.words).not.toContain('8 sats');
    }
  });

  it('the words are plain', () => {
    const said: string[] = [];
    const headlines: string[] = [];
    for (const r of ROWS) {
      const w = paymentWords(p(r));
      headlines.push(w.headline);
      said.push(w.headline, w.sentence);
      for (const f of w.figures) {
        said.push(f.words);
      }
    }
    const withFigures = paymentWords(
      p({ owedToCard: 5, unconfirmed: 3, givenBack: 14, kept: 1, stuck: 2, unproved: 1, lost: 7 }),
    );
    for (const f of withFigures.figures) {
      said.push(f.words);
    }
    expect(said.length).toBeGreaterThan(0);
    for (const text of said) {
      expect(text).not.toContain('—');
      expect(text).not.toContain('–');
      expect(/crypto|paid back/i.test(text)).toBe(false);
    }
    for (const headline of headlines) {
      expect(headline).not.toBe('NOT PAID');
    }
  });
});

it('keeps pending offline sales out of takings and identifies mint settlement without a second-payment warning', () => {
  const pending = p({ state: 'taking', offline: true });
  expect(isPaid(pending)).toBe(false);
  expect(paymentWords(pending).headline).toBe('OFFLINE · PENDING');
  const paid = { ...pending, state: 'delivered' as const };
  expect(noticeOf('taking', paid)).toContain('mint confirmed');
  expect(noticeToneOf('taking', paid)).toBe('good');
  expect(nowPaidIds([noticeKey(paid)])).toEqual([]);
  const lost = { ...pending, state: 'gone' as const };
  expect(isPaid(lost)).toBe(false);
  expect(paymentWords(lost).headline).toBe('OFFLINE · LOST');
});
