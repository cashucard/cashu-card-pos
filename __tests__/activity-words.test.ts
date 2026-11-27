import type { Claim, Payment, PaymentState } from 'cashucard';
import { paymentTone, paymentWords, WAITING_WORDS, waitingForCard } from '../src/till/payment-words';
import {
  ACTIVITY_WORDS,
  PAYMENT_WORDS,
  claimLine,
  damagedLine,
  isCustomers,
  isDone,
  isLoss,
  isTakings,
  isUnfinished,
  moreWords,
  owedLine,
  olderLine,
  paymentLine,
  shownWords,
  startOfDay,
  takings,
  takingsWords,
} from '../src/app/activity';
import { heldPayment } from './helpers/fake-till';

const p = (o: Partial<Payment>): Payment => ({ ...heldPayment('s1'), ...o });
const STATES: PaymentState[] = ['taking', 'held', 'delivered', 'exported', 'gone', 'unrecovered', 'lost',
  'spent-not-restored', 'returning', 'returned'];
const EXTRAS: Array<Payment['extra']> = [undefined, 'paid-twice', 'late'];
const T = new Date(2026, 10, 22, 4, 10).getTime();
const C: Claim = { id: 'pay:aa', sale: 's1', cardKey: '02' + 'c'.repeat(64), mint: 'https://mint.test', unit: 'sat',
  amount: 15, fee: 1, price: 2100, step: 'released', at: T, asks: 3, misses: 0 };

const plain = (s: string): void => {
  expect(s).not.toContain('—');
  expect(s).not.toContain('–');
  expect(/crypto|paid back|settled/i.test(s)).toBe(false);
};

describe('the Activity list in plain words', () => {
  it('a payment written back to its card is not called owed', () => {
    const a = paymentWords(p({ state: 'returned', extra: 'late', owedToCard: 0, givenBack: 13, unconfirmed: 13 }));
    expect(a.headline).toBe('WRITTEN TO THE CARD');
    expect(a.sentence).toBe(
      "The customer's money was written to the card. The till counts it as the card's once the mint shows the card has used it.",
    );
    expect(a.figures.map((f) => f.id)).toEqual(['unconfirmed']);
    const b = paymentWords(p({ state: 'returned', extra: 'late', owedToCard: 0, givenBack: 13, unconfirmed: 0 }));
    expect(b.sentence).toBe("The customer's money was written to the card, and the till has confirmed it.");
    expect(b.figures.map((f) => f.id)).toEqual(['written']);
    expect(
      paymentWords(p({ state: 'returned', extra: 'late', owedToCard: 0, givenBack: 0, unconfirmed: 0 })).headline,
    ).toBe('WRITTEN TO THE CARD');
    const c = paymentWords(p({ state: 'returned', extra: 'late', owedToCard: 13 }));
    expect(c.headline).toBe('OWED TO THE CARD');
    expect(c.figures.map((f) => f.id)).toEqual(['owed']);
    expect(
      paymentWords(p({ state: 'returned', extra: 'late', owedToCard: 5, givenBack: 8, unconfirmed: 8 })).headline,
    ).toBe('OWED TO THE CARD');
  });

  it("an extra payment taken out is the customer's", () => {
    for (const extra of ['late', 'paid-twice'] as const) {
      const w = paymentWords(p({ state: 'exported', extra }));
      expect(w.headline).toBe('TAKEN OUT FOR THE CUSTOMER');
      expect(w.sentence).toBe("The customer's money was taken out by hand as a token, to give back to them.");
    }
    expect(paymentWords(p({ state: 'exported' })).headline).toBe('TAKEN OUT');
  });

  it("the tone is good only for the merchant's money", () => {
    for (const s of STATES) {
      const want = s === 'held' || s === 'delivered' || s === 'exported'
        ? 'good'
        : s === 'gone' || s === 'lost' || s === 'spent-not-restored'
          ? 'bad'
          : 'normal';
      expect([s, paymentTone(p({ state: s }))]).toEqual([s, want]);
    }
    // the customer paid more than the sale: paid twice or late is bad, as Home's notice is
    expect(paymentTone(p({ state: 'held', extra: 'paid-twice' }))).toBe('bad');
    expect(paymentTone(p({ state: 'held', extra: 'late' }))).toBe('bad');
    // money kept for its customer, going back, owed to, written to or taken out for the card is plain, never green
    expect(paymentTone(p({ state: 'held', extra: 'late', why: 'date-too-near' }))).toBe('normal');
    expect(paymentTone(p({ state: 'held', extra: 'paid-twice', why: 'date-too-near' }))).toBe('normal');
    for (const x of ['paid-twice', 'late'] as const) {
      for (const s of ['exported', 'returning', 'returned'] as const) {
        expect([x, s, paymentTone(p({ state: s, extra: x }))]).toEqual([x, s, 'normal']);
      }
      expect(paymentTone(p({ state: 'returned', extra: x, owedToCard: 13 }))).toBe('normal');
      expect(paymentTone(p({ state: 'delivered', extra: x }))).not.toBe('good');
    }
    // a state this till does not know is never green
    expect(paymentTone(p({ state: 'none' as unknown as PaymentState }))).toBe('normal');
  });

  it('every payment is a loss, not finished, or finished, and never two of them', () => {
    for (const s of STATES) {
      for (const x of EXTRAS) {
        for (const o of [0, 5]) {
          const q = p({ state: s, extra: x, owedToCard: o });
          expect(isLoss(q)).toBe(s === 'lost' || s === 'spent-not-restored' || s === 'gone');
          expect(isLoss(q) && isUnfinished(q)).toBe(false);
          expect(isLoss(q) || isUnfinished(q) || isDone(q)).toBe(true);
          if (!isLoss(q)) {
            expect(isUnfinished(q)).toBe(!isDone(q));
          }
        }
      }
    }
  });

  it('what is not finished', () => {
    const yes = [
      p({ state: 'taking' }),
      p({ state: 'unrecovered' }),
      p({ state: 'returning', extra: 'late' }),
      p({ state: 'returned', extra: 'late', owedToCard: 13 }),
      p({ state: 'held', extra: 'paid-twice' }),
      p({ state: 'held', extra: 'late', why: 'date-too-near' }),
      p({ state: 'delivered', owedToCard: 5 }),
      p({ state: 'none' as unknown as PaymentState }),
    ];
    const no = [
      p({ state: 'held' }),
      p({ state: 'delivered' }),
      p({ state: 'exported' }),
      p({ state: 'gone' }),
      p({ state: 'returned', extra: 'late', givenBack: 13, unconfirmed: 13 }),
      p({ state: 'returned', extra: 'late' }),
      p({ state: 'lost' }),
      p({ state: 'spent-not-restored' }),
    ];
    for (const q of yes) {
      expect(isUnfinished(q)).toBe(true);
    }
    for (const q of no) {
      expect(isUnfinished(q)).toBe(false);
    }
  });

  it("takings count the price of the merchant's money only, each payment once", () => {
    const pay = (n: number, o: Partial<Payment>): Payment => p({ paymentId: 'pay:' + n, at: T, ...o });
    const pays: Payment[] = [
      pay(1, { state: 'delivered', amount: 14 }),
      pay(2, { state: 'held', amount: 20 }),
      pay(3, { state: 'exported', amount: 30 }),
      pay(4, { state: 'held', extra: 'paid-twice', amount: 40 }),
      pay(5, { state: 'held', extra: 'late', amount: 50 }),
      pay(6, { state: 'returning', extra: 'late', amount: 60 }),
      pay(7, { state: 'returned', extra: 'late', amount: 70 }),
      pay(8, { state: 'exported', extra: 'late', amount: 80 }),
      pay(9, { state: 'taking', amount: 90 }),
      pay(10, { state: 'gone', amount: 100 }),
      pay(11, { state: 'lost', amount: 110 }),
      pay(12, { state: 'spent-not-restored', amount: 120 }),
      pay(13, { state: 'unrecovered', amount: 130 }),
      pay(14, { state: 'delivered', owedToCard: 5, amount: 7 }),
    ];
    expect(takings(pays, null)).toEqual({ sats: 71, count: 4 });
    expect(pays.filter(isTakings).map((x) => x.paymentId)).toEqual(['pay:1', 'pay:2', 'pay:3', 'pay:14']);
    expect(pays.filter(isCustomers).map((x) => x.paymentId)).toEqual([
      'pay:4',
      'pay:5',
      'pay:6',
      'pay:7',
      'pay:8',
    ]);
    expect(takings([pays[0], pays[0], { ...pays[0] }], null)).toEqual({ sats: 14, count: 1 });
    expect(takings([], null)).toEqual({ sats: 0, count: 0 });
  });

  it("today counts from the phone's own midnight", () => {
    expect(startOfDay(T)).toBe(new Date(2026, 10, 22).getTime());
    const m = startOfDay(T);
    const two = [
      p({ state: 'delivered', paymentId: 'pay:a', at: m - 1 }),
      p({ state: 'delivered', paymentId: 'pay:b', at: m }),
    ];
    expect(takings(two, m)).toEqual({ sats: 14, count: 1 });
  });

  it('the lines say the amount, the headline and the time', () => {
    expect(paymentLine(p({ amount: 2100, state: 'delivered', at: T }))).toBe(
      '2,100 sats · PAID · 22 Nov 2026, 04:10',
    );
    expect(paymentLine(p({ state: 'taking', at: T }))).toBe('14 sats · CHECKING · 22 Nov 2026, 04:10');
    expect(paymentLine(p({ state: 'spent-not-restored', at: T }))).toBe(
      '14 sats · NOT PAID YET: A FAULT AT THE MINT · 22 Nov 2026, 04:10',
    );
    expect(claimLine(C)).toBe('2,100 sats from a card · asked 3 times · started 22 Nov 2026, 04:10');
    expect(claimLine({ ...C, asks: 1 })).toContain('asked 1 time ·');
    expect(claimLine({ ...C, asks: 0 })).toContain('asked 0 times');
    expect(olderLine({ id: 'x', why: 'a pooled payment' })).toBe(
      'A row of an earlier version: a pooled payment. It is kept as it is.',
    );
    expect(damagedLine({ id: 'y', why: 'no id' })).toBe(
      'A row this version cannot read: no id. It is kept as it is.',
    );
    expect(takingsWords(ACTIVITY_WORDS.todayLead, { sats: 42, count: 3 })).toBe('Paid today: 42 sats in 3 payments');
    expect(takingsWords(ACTIVITY_WORDS.allLead, { sats: 1, count: 1 })).toBe(
      'Paid in this record: 1 sat in 1 payment',
    );
    expect(takingsWords(ACTIVITY_WORDS.allLead, { sats: 140000, count: 10000 })).toBe(
      'Paid in this record: 140,000 sats in 10,000 payments',
    );
    expect(moreWords(50)).toBe('Show 50 more');
    expect(shownWords(50, 1234)).toBe('Showing 50 of 1,234 payments.');
  });

  it('a payment whose sale was left unfinished and paid later says it may be paid twice', () => {
    expect(paymentLine(p({ state: 'delivered', at: T }), true)).toBe(
      '14 sats · PAID · 22 Nov 2026, 04:10 · SALE LEFT UNFINISHED: MAY BE PAID TWICE',
    );
    expect(paymentLine(p({ state: 'delivered', at: T }), false)).toBe('14 sats · PAID · 22 Nov 2026, 04:10');
    expect(ACTIVITY_WORDS.twice).toBe(' · SALE LEFT UNFINISHED: MAY BE PAID TWICE');
  });

  it('no line carries a token, a key or an id', () => {
    const q = p({
      change: 'cashuB' + 'x'.repeat(60),
      cardKey: '02' + 'c'.repeat(64),
      paymentId: 'pay:' + 'd'.repeat(32),
      delivery: { id: 'fx-' + 'e'.repeat(26) },
    });
    for (const line of [paymentLine(q), paymentLine(q, true)]) {
      for (const bad of ['cashu', 'cccc', 'dddd', 'eeee', 'pay:']) {
        expect(line).not.toContain(bad);
      }
    }
    const c = claimLine(C);
    expect(c).not.toContain('cccc');
    expect(c).not.toContain('pay:');
  });

  it('a payment whose pieces were spent elsewhere is a loss, never finished and never takings', () => {
    for (const x of EXTRAS) {
      const q = p({ state: 'gone', extra: x });
      expect(isLoss(q)).toBe(true);
      expect(isUnfinished(q)).toBe(false);
      expect(isTakings(q)).toBe(false);
      expect(paymentWords(q).headline).toBe('LOST');
      expect(paymentTone(q)).toBe('bad');
    }
  });

  it('kept by the till is never takings: only the price counts', () => {
    const q = p({ state: 'delivered', paymentId: 'pay:k', amount: 14, kept: 3, at: T });
    expect(takings([q], null)).toEqual({ sats: 14, count: 1 });
    expect(takings([q], startOfDay(T), T)).toEqual({ sats: 14, count: 1 });
  });

  it('today ends now: a payment dated after now is not counted', () => {
    const m = startOfDay(T);
    const three = [
      p({ state: 'delivered', paymentId: 'pay:a', at: m }),
      p({ state: 'delivered', paymentId: 'pay:b', at: T }),
      p({ state: 'delivered', paymentId: 'pay:c', at: T + 1 }),
    ];
    expect(takings(three, m, T)).toEqual({ sats: 28, count: 2 });
    expect(takings(three, m)).toEqual({ sats: 42, count: 3 });
    expect(takings(three, null)).toEqual({ sats: 42, count: 3 });
  });

  it('a paid payment still owing change to its card says what is owed', () => {
    expect(ACTIVITY_WORDS.owedLead).toBe('Change owed to the card, not written yet: ');
    expect(owedLine(p({ state: 'delivered', owedToCard: 3 }))).toBe('Change owed to the card, not written yet: 3 sats');
    expect(owedLine(p({ state: 'held', owedToCard: 1 }))).toBe('Change owed to the card, not written yet: 1 sat');
    expect(owedLine(p({ state: 'exported', owedToCard: 2100 }))).toBe(
      'Change owed to the card, not written yet: 2,100 sats',
    );
    for (const q of [
      p({ state: 'delivered' }),
      p({ state: 'held', owedToCard: 0 }),
      p({ state: 'returned', extra: 'late', owedToCard: 13 }),
      p({ state: 'held', extra: 'paid-twice', owedToCard: 5 }),
      p({ state: 'exported', extra: 'late', owedToCard: 5 }),
      p({ state: 'taking', owedToCard: 5 }),
      p({ state: 'lost', owedToCard: 5 }),
    ]) {
      expect(owedLine(q)).toBeNull();
    }
    plain(ACTIVITY_WORDS.owedLead);
  });

  it('a card payment the record lists as taking is waiting for its card only while its open claim is sign-asked', () => {
    const q = p({ state: 'taking', paymentId: 'pay:w', at: T });
    const signAsked: Claim = { ...C, id: 'pay:w', step: 'sign-asked' };
    expect(waitingForCard(q, [signAsked])).toBe(true);
    // a swap sent to the mint and not answered: no claim, so it is being checked with the mint
    expect(waitingForCard(q, [])).toBe(false);
    expect(waitingForCard(q, [{ ...signAsked, id: 'pay:other' }])).toBe(false);
    // only a claim of step sign-asked is a payment waiting for its card
    expect(waitingForCard(q, [{ ...signAsked, step: 'released' }])).toBe(false);
    expect(waitingForCard(p({ state: 'unrecovered', paymentId: 'pay:w' }), [{ ...signAsked, step: 'unrecovered' }])).toBe(
      false,
    );
    expect(waitingForCard(p({ state: 'held', paymentId: 'pay:w' }), [signAsked])).toBe(false);
    expect(WAITING_WORDS.headline).toBe('WAITING FOR THE CARD');
    expect(WAITING_WORDS.sentence).toBe(
      "The card began this payment and may have signed it. Nothing is paid until the same card is tapped at this till again; it may ask for its PIN. Do not hand over the goods for it. If its sale was paid another way or withdrawn, the money this card pays is the customer's and goes back to the card.",
    );
    expect(WAITING_WORDS.sentence).not.toContain('checking');
    plain(WAITING_WORDS.headline);
    plain(WAITING_WORDS.sentence);
    expect(claimLine(signAsked, true)).toBe(
      '2,100 sats from a card · asked 3 times · started 22 Nov 2026, 04:10 · WAITING FOR THE CARD',
    );
    expect(claimLine(signAsked)).toBe('2,100 sats from a card · asked 3 times · started 22 Nov 2026, 04:10');
  });

  it("a row of the customer's money says so, unless its headline names the customer already", () => {
    expect(paymentLine(p({ state: 'returned', extra: 'late', at: T }))).toBe(
      "14 sats · WRITTEN TO THE CARD · 22 Nov 2026, 04:10 · THE CUSTOMER'S MONEY",
    );
    expect(paymentLine(p({ state: 'held', extra: 'paid-twice', at: T }))).toBe(
      "14 sats · PAID TWICE · 22 Nov 2026, 04:10 · THE CUSTOMER'S MONEY",
    );
    expect(paymentLine(p({ state: 'returned', extra: 'late', owedToCard: 13, at: T }))).toBe(
      "14 sats · OWED TO THE CARD · 22 Nov 2026, 04:10 · THE CUSTOMER'S MONEY",
    );
    expect(paymentLine(p({ state: 'exported', extra: 'late', at: T }))).toBe(
      '14 sats · TAKEN OUT FOR THE CUSTOMER · 22 Nov 2026, 04:10',
    );
    expect(paymentLine(p({ state: 'held', extra: 'late', why: 'date-too-near', at: T }))).toBe(
      '14 sats · KEPT FOR THE CUSTOMER · 22 Nov 2026, 04:10',
    );
    expect(paymentLine(p({ state: 'delivered', at: T }))).toBe('14 sats · PAID · 22 Nov 2026, 04:10');
    expect(ACTIVITY_WORDS.customers).toBe(" · THE CUSTOMER'S MONEY");
  });

  it('the words are plain', () => {
    for (const s of Object.values(ACTIVITY_WORDS)) {
      plain(s);
    }
    for (const s of Object.values(PAYMENT_WORDS)) {
      plain(s);
    }
    const headlines: string[] = [];
    for (const s of STATES) {
      for (const x of EXTRAS) {
        const w = paymentWords(p({ state: s, extra: x }));
        plain(w.headline);
        plain(w.sentence);
        headlines.push(w.headline);
      }
    }
    // both returned sentences of the first test
    plain(
      paymentWords(p({ state: 'returned', extra: 'late', owedToCard: 0, givenBack: 13, unconfirmed: 13 })).sentence,
    );
    plain(
      paymentWords(p({ state: 'returned', extra: 'late', owedToCard: 0, givenBack: 13, unconfirmed: 0 })).sentence,
    );
    const lines = [
      paymentLine(p({ amount: 2100, state: 'delivered', at: T })),
      paymentLine(p({ state: 'taking', at: T })),
      paymentLine(p({ state: 'spent-not-restored', at: T })),
      paymentLine(p({ state: 'delivered', at: T }), true),
      paymentLine(p({ state: 'delivered', at: T }), false),
      claimLine(C),
      claimLine({ ...C, asks: 1 }),
      claimLine({ ...C, asks: 0 }),
      olderLine({ id: 'x', why: 'a pooled payment' }),
      damagedLine({ id: 'y', why: 'no id' }),
      takingsWords(ACTIVITY_WORDS.todayLead, { sats: 42, count: 3 }),
      takingsWords(ACTIVITY_WORDS.allLead, { sats: 140000, count: 10000 }),
      moreWords(50),
      shownWords(50, 1234),
    ];
    for (const line of lines) {
      plain(line);
    }
    for (const headline of headlines) {
      expect(headline).not.toBe('NOT PAID');
    }
  });

  it("slice 1.2's table is unchanged where this order did not change it", () => {
    const w = paymentWords(p({ state: 'exported' }));
    expect(w.headline).toBe('TAKEN OUT');
    expect(w.sentence).toBe('Paid and taken out by hand as a token.');
    expect(w.figures).toEqual([]);
    expect(paymentWords(p({ state: 'held' })).headline).toBe('PAID');
    expect(paymentWords(p({ state: 'returning' })).headline).toBe('GOING BACK TO THE CARD');
  });
});
