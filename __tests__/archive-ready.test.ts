/* cashucard 0.3.0's archive rule as the till copies it to size a job (slice 2.3b), as plain functions: which payment
 * rows are final, which payments are kept as evidence for a claim or a loss, what unreadable rows hold back, which
 * sales are ready and where each is placed, and how far one job reaches. The real library is held to the same rule
 * in archive-reach.test.ts. */

import {
  DAY_MS,
  evidenceOf,
  jobReach,
  NO_UNREAD,
  paymentFinal,
  readyCount,
  readySales,
  unreadSales,
  type ReadySale,
} from '../src/till/archive';
import type { PaymentFacts, SaleFacts } from '../src/till/store/journal';

const NOW = new Date(2026, 10, 23, 12, 0).getTime();

/** Payment row n of sale `sale`: delivered, held at `held`, owing nothing, unless told otherwise. */
const fact = (n: number, sale: string, held: number, o: Partial<PaymentFacts> = {}): PaymentFacts => ({
  id: 'pay:' + n,
  sale,
  state: 'delivered',
  step: 'swapped',
  how: 'card',
  extra: false,
  held,
  owed: 0,
  unconfirmed: 0,
  inputs: [],
  ...o,
});
/** Sale `id` opened at `at`: open and not marked, unless told otherwise. */
const sale = (id: string, at: number, o: Partial<SaleFacts> = {}): SaleFacts => ({
  id,
  at,
  closed: false,
  closedAt: 0,
  archived: false,
  ...o,
});
const never = (): boolean => false;
const placed = (r: readonly ReadySale[]): number[] => r.map((x) => x.place).sort((a, b) => a - b);

describe("the archive rule, as the till copies it from cashucard 0.3.0", () => {
  it('a payment row is final when it took its money or took nothing, and owes its card nothing', () => {
    const f = fact(1, 'a', NOW);
    expect(paymentFinal(f, never)).toBe(true);
    expect(paymentFinal({ ...f, owed: 3 }, never)).toBe(false);
    expect(paymentFinal({ ...f, unconfirmed: 2 }, never)).toBe(false);
    expect(paymentFinal({ ...f, extra: true }, never)).toBe(false);
    expect(paymentFinal(f, () => true)).toBe(false);
    for (const step of ['sign-asked', 'released', 'unrecovered', 'spent-not-restored']) {
      expect(paymentFinal({ ...f, step }, never)).toBe(false);
    }
    for (const state of ['held', 'taking', 'returning', 'returned', 'lost', 'unrecovered', 'spent-not-restored']) {
      expect(paymentFinal({ ...f, state }, never)).toBe(false);
    }
    expect(paymentFinal({ ...f, state: 'exported' }, never)).toBe(true);
    expect(paymentFinal({ ...f, state: 'gone', how: 'ecash' }, never)).toBe(true);
    expect(paymentFinal({ ...f, state: 'gone', how: 'card' }, never)).toBe(false);
    expect(paymentFinal({ ...f, state: 'none', step: 'refused' }, never)).toBe(true);
    expect(paymentFinal({ ...f, state: 'none', step: 'abandoned' }, never)).toBe(true);
    expect(paymentFinal({ ...f, state: 'none', step: 'planned' }, never)).toBe(false);
    // an attempt that took nothing but owes its card is not final either
    expect(paymentFinal({ ...f, state: 'none', step: 'refused', owed: 1 }, never)).toBe(false);
  });

  it('a payment whose pieces a claim, a signed swap or a loss also spends is kept as evidence', () => {
    const done = fact(1, 'a', NOW, { inputs: ['s1', 's2'] });
    const other = fact(2, 'b', NOW, { inputs: ['s9'] });
    for (const o of [
      { state: 'taking', step: 'sign-asked' },
      { state: 'taking', step: 'released' },
      { state: 'unrecovered', step: 'unrecovered' },
      { state: 'taking', step: 'signed' },
      { state: 'spent-not-restored', step: 'spent-not-restored' },
      { state: 'lost', step: 'swapped' },
    ]) {
      const open = fact(3, 'c', NOW, { ...o, inputs: ['s2', 's3'] });
      const kept = evidenceOf([done, other, open]);
      expect(kept(done)).toBe(true);
      expect(kept(other)).toBe(false);
    }
    // once the claim is closed (swapped), nothing is kept for it
    const closed = fact(3, 'c', NOW, { state: 'delivered', step: 'swapped', inputs: ['s2'] });
    expect(evidenceOf([done, closed])(done)).toBe(false);
  });

  it('rows the library does not read hold back the sales they name, and, when one names none, every sale with nothing counted', () => {
    expect(
      unreadSales([
        { id: 'sale:x', kind: 'sale', sale: null },
        { id: 'fx-1', kind: 'delivery', sale: null },
        { id: 'card:1', kind: 'card', sale: null },
      ]),
    ).toEqual({ sales: new Set(), unnamed: false });
    expect(unreadSales([{ id: 'pay:1', kind: 'payment', sale: 'a' }])).toEqual({ sales: new Set(['a']), unnamed: false });
    expect(unreadSales([{ id: 'pay:2', kind: null, sale: null }]).unnamed).toBe(true);
    expect(unreadSales([{ id: 'pay:3', kind: 'payment', sale: '' }]).unnamed).toBe(true);
    const facts = [fact(1, 'a', NOW - 9000), fact(2, 'b', NOW - 8000), fact(3, 'w', NOW - 7000, { state: 'none', step: 'refused' })];
    const sales = [sale('a', NOW - 9000), sale('b', NOW - 8000), sale('w', NOW - 7000, { closed: true, closedAt: NOW - 6000 })];
    expect(readySales(facts, sales, NO_UNREAD)).toHaveLength(3);
    // a row naming sale a holds a back; a row naming no sale holds back w (nothing counted), never b (delivered)
    expect(placed(readySales(facts, sales, { sales: new Set(['a']), unnamed: false }))).toEqual([NOW - 8000, NOW - 6000]);
    expect(placed(readySales(facts, sales, { sales: new Set(), unnamed: true }))).toEqual([NOW - 9000, NOW - 8000]);
  });

  it('which sales are ready, and where each is placed', () => {
    const facts = [
      // open, paid: placed by when its payment was held
      fact(1, 'paid', NOW - 9000),
      // open, only a refused attempt: never ready (it may still be paid)
      fact(2, 'open-refused', NOW - 8500, { state: 'none', step: 'refused' }),
      // withdrawn after a refused attempt: placed by the later of its attempt, its opening and its close
      fact(3, 'withdrawn', NOW - 8000, { state: 'none', step: 'refused' }),
      // marked archived by an archive that stopped part way: placed at 0, whatever its times
      fact(4, 'marked', NOW + 60000),
      // one payment delivered and one held: not ready
      fact(5, 'half', NOW - 7000),
      fact(6, 'half', NOW - 6000, { state: 'held' }),
    ];
    const sales = [
      sale('paid', NOW - 9100),
      sale('open-refused', NOW - 8600),
      sale('withdrawn', NOW - 8100, { closed: true, closedAt: NOW - 7500 }),
      sale('marked', NOW - 100, { archived: true }),
      sale('half', NOW - 7100),
      // open, no payment: never ready; withdrawn with no payment row at all: ready by its close; paid by the wallet
      sale('empty-open', NOW - 5000),
      sale('empty-withdrawn', NOW - 4000, { closed: true, closedAt: NOW - 3000 }),
      sale('wallet-paid', NOW - 2000, { closed: true, closedAt: NOW - 2500 }),
    ];
    const ready = readySales(facts, sales, NO_UNREAD);
    expect(placed(ready)).toEqual([0, NOW - 9000, NOW - 7500, NOW - 3000, NOW - 2000]);
    expect(ready.map((x) => x.sale).sort()).toEqual(['empty-withdrawn', 'marked', 'paid', 'wallet-paid', 'withdrawn']);
    expect(ready.map((r) => [r.place, r.weight, r.payments]).sort((a, b) => a[0] - b[0])).toEqual([
      [0, 1, 1],
      [NOW - 9000, 1, 1],
      [NOW - 7500, 1, 0],
      [NOW - 3000, 1, 0],
      [NOW - 2000, 1, 0],
    ]);
    expect(readyCount(ready)).toBe(2);
    // a sale marked and named by an unreadable row is held back too
    expect(placed(readySales(facts, sales, { sales: new Set(['marked']), unnamed: false }))).not.toContain(0);
  });

  it('one job reaches the oldest sales up to the bite, halfway to the next, and never stops on a sale alone over it', () => {
    const r = (place: number, weight = 1): ReadySale => ({ sale: 's' + place, place, weight, payments: weight });
    const ready = Array.from({ length: 150 }, (_, i) => r(NOW - 150000 + i * 1000));
    const days = jobReach(ready, NOW, 100) as number;
    const before = NOW - days * DAY_MS;
    expect(ready.filter((x) => x.place <= before)).toHaveLength(100);
    expect(before).toBe(NOW - 150000 + 99 * 1000 + 500);
    // the same place goes together; the oldest always goes
    expect(jobReach([r(NOW - 5000, 150), r(NOW - 4000)], NOW, 100)).toBe((NOW - (NOW - 4500)) / DAY_MS);
    // a marked sale (place 0) counts first
    const withMarked = [r(0, 30), ...Array.from({ length: 100 }, (_, i) => r(NOW - 100000 + i * 1000))];
    const d2 = jobReach(withMarked, NOW, 100) as number;
    expect(withMarked.filter((x) => x.place <= NOW - d2 * DAY_MS).reduce((n, x) => n + x.weight, 0)).toBe(100);
    // everything fits: up to now
    expect(jobReach([r(NOW - 5000), r(NOW - 4000)], NOW, 100)).toBe(0);
    expect(jobReach([], NOW, 100)).toBeNull();
    expect(jobReach([r(NOW - 5000)], NOW, 0)).toBeNull();
    // a clock put back asks up to now
    expect(jobReach([r(NOW + 60000), r(NOW + 120000)], NOW, 1)).toBe(0);
  });
});
