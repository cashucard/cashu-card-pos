import type { Payment, PaymentState } from 'cashucard';
import { heldPayment } from './helpers/fake-till';
import { isPaid } from '../src/till/payment-words';
import {
  SETTLE_WORDS,
  TILL_REPORT_KEYS,
  UNFINISHED_STATES,
  keptOf,
  keptWords,
  noticeKey,
  noticeOf,
  noticeWords,
  nowPaidWords,
  settleProblem,
  tillReport,
  type SettleNote,
} from '../src/till/settle';

const p = (o: Partial<Payment>): Payment => ({ ...heldPayment('s1'), ...o });

const STATES: PaymentState[] = [
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

function plain(s: string): void {
  expect(s).not.toContain('—');
  expect(s).not.toContain('–');
  expect(s).not.toMatch(/crypto|paid back/i);
}

describe('settle words', () => {
  it('a notice says the amount, the headline and the sentence', () => {
    expect(noticeWords(p({ state: 'delivered' }))).toBe("14 sats · PAID. Paid and kept in this phone's wallet.");
    expect(noticeWords(p({ state: 'returned', extra: 'late', owedToCard: 13 }))).toBe(
      '13 sats · OWED TO THE CARD. It is written back to the card at its next tap, with the PIN. Owed to the card, not written yet: 13 sats.',
    );
    const words = noticeWords(p({ state: 'gone', unproved: 1, stuck: 1 }));
    expect(words.endsWith('Change the mint never proved: 1 sat. It stays owed.')).toBe(true);
    expect(words).not.toContain('..');
  });

  it('a settle tells a loss, a payment paid twice or late, and money owed to a card', () => {
    const cases: Array<Partial<Payment>> = [
      { state: 'gone' },
      { state: 'lost' },
      { state: 'spent-not-restored' },
      { state: 'returned', extra: 'late' },
      { state: 'held', extra: 'paid-twice' },
      { state: 'held', extra: 'late' },
    ];
    for (const x of cases) {
      expect(noticeOf('taking', p(x))).not.toBeNull();
      expect(noticeOf(undefined, p(x))).not.toBeNull();
    }
  });

  it('a payment the till was checking is told once it is paid', () => {
    for (const b of UNFINISHED_STATES) {
      expect(noticeOf(b, p({ state: 'delivered' }))).toBe(
        noticeWords(p({ state: 'delivered' })) + ' ' + nowPaidWords(0),
      );
      expect(noticeOf(b, p({ state: 'held' }))).toBe(noticeWords(p({ state: 'held' })) + ' ' + nowPaidWords(0));
    }
    expect(noticeOf('held', p({ state: 'delivered' }))).toBeNull();
    expect(noticeOf(undefined, p({ state: 'delivered' }))).toBeNull();
  });

  it('a sale left as CHECKING or NOT PAID YET that is now paid is told with its amount and time', () => {
    const at = new Date(2026, 10, 22, 4, 10).getTime();
    const want =
      "14 sats · PAID. Paid and kept in this phone's wallet. The payment of 22 Nov 2026, 04:10 was not finished when its sale ended. It is paid now. If the customer paid that sale another way too, it is paid twice.";
    const befores: PaymentState[] = ['taking', 'spent-not-restored'];
    for (const b of befores) {
      expect(noticeOf(b, p({ state: 'delivered', at }))).toBe(want);
    }
    expect(nowPaidWords(at)).toBe(want.slice(want.indexOf('The payment of ')));
  });

  it('nothing else is told', () => {
    expect(noticeOf('taking', p({ state: 'taking', why: 'swap-waiting: x' }))).toBeNull();
    expect(noticeOf('held', p({ state: 'returning', extra: 'late' }))).toBeNull();
    expect(noticeOf('held', p({ state: 'exported' }))).toBeNull();
    expect(noticeOf('held', p({ state: 'held' }))).toBeNull();
  });

  it('PAID is told only for a payment that is paid', () => {
    for (const s of STATES) {
      const words = noticeOf('taking', p({ state: s }));
      if (words !== null && words.includes(' · PAID.')) {
        expect(isPaid(p({ state: s }))).toBe(true);
      }
    }
    expect(noticeOf('taking', p({ state: 'taking' }))).toBeNull();
  });

  it('a notice is told once per payment, state and extra', () => {
    expect(noticeKey(p({ state: 'held', extra: 'late' }))).toBe('pay:00|held|late');
    expect(noticeKey(p({ state: 'delivered' }))).toBe('pay:00|delivered|');
  });

  it('the kept line counts sats in the keep-store, and every delivery', () => {
    expect(
      keptOf([
        { mint: 'https://mint.test', unit: 'sat', amount: 14, count: 1 },
        { mint: 'https://other.test', unit: 'sat', amount: 28, count: 2 },
        { mint: 'https://mint.test', unit: 'usd', amount: 5, count: 1 },
      ]),
    ).toEqual({ sats: 42, deliveries: 3 });
    expect(keptOf([])).toEqual({ sats: 0, deliveries: 0 });
    expect(keptWords(2100)).toBe('Kept in this phone: 2,100 sats');
    expect(keptWords(1)).toBe('Kept in this phone: 1 sat');
  });

  it('a settle that failed is told; one that went well is not', () => {
    const N = { why: 'timer', at: 1, ms: 0, ok: true, changed: 0, error: null, n: 1 } as SettleNote;
    expect(settleProblem(null)).toBeNull();
    expect(settleProblem(N)).toBeNull();
    for (const k of ['journal', 'journal-in-use', 'journal-rolled-back']) {
      expect(settleProblem({ ...N, ok: false, error: k })).toBe(SETTLE_WORDS.record);
    }
    for (const k of ['busy', 'internal', 'mint']) {
      expect(settleProblem({ ...N, ok: false, error: k })).toBe(SETTLE_WORDS.later);
    }
  });

  it('the report counts every payment by its state', () => {
    const pays: Payment[] = STATES.map((s, i) => p({ state: s, paymentId: 'pay:' + i }));
    pays.push(p({ state: 'held', extra: 'late', paymentId: 'pay:x' }));
    const r = tillReport(5, { sats: 14, deliveries: 1 }, pays, null, []);
    const want: Partial<Record<PaymentState, number>> = {};
    for (const s of STATES) {
      want[s] = 1;
    }
    want.held = 2;
    expect(r.payments).toEqual(want);
    expect(r.extra).toBe(1);
    expect(r.settle).toBeNull();
    expect(r.settles).toBe(0);
    expect(r.at).toBe(5);
    expect(Object.keys(r).sort()).toEqual([...TILL_REPORT_KEYS].sort());
    expect(tillReport(5, { sats: 0, deliveries: 0 }, [], null, []).payments).toEqual({});
  });

  it('the report holds the last settle and the notices, and never a token or an id', () => {
    const n = { why: 'front', at: 9, ms: 30, ok: false, changed: 0, error: 'journal', n: 4 } as SettleNote;
    const t = { paymentId: 'pay:' + 'a'.repeat(64), words: 'w.' };
    const r = tillReport(
      9,
      { sats: 14, deliveries: 1 },
      [p({ change: 'cashuB' + 'x'.repeat(60), paymentId: 'pay:' + 'b'.repeat(64) })],
      n,
      [t],
    );
    expect(r.settle).toEqual({ why: 'front', ok: false, changed: 0, error: 'journal', ms: 30 });
    expect(r.settles).toBe(4);
    expect(r.notices).toEqual(['w.']);
    expect(JSON.stringify(r)).not.toContain('cashu');
    expect(JSON.stringify(r)).not.toMatch(/[0-9a-f]{64}/);
  });

  it('the words are plain', () => {
    plain(SETTLE_WORDS.record);
    plain(SETTLE_WORDS.later);
    plain(keptWords(5));
    plain(nowPaidWords(0));
    for (const s of STATES) {
      plain(noticeWords(p({ state: s })));
      const words = noticeOf('taking', p({ state: s }));
      if (words !== null) {
        plain(words);
      }
    }
  });
});
