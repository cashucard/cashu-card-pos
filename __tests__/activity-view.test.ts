import type { Claim, Payment } from 'cashucard';
import {
  ACTIVITY_PAGE,
  ACTIVITY_REPORT_KEYS,
  ACTIVITY_START,
  activityReport,
  activityStep,
  activityView,
  isTakings,
  newestFirst,
  readActivity,
  startOfDay,
  takings,
  type ActivityData,
  type ActivityReader,
} from '../src/app/activity';
import { heldPayment } from './helpers/fake-till';

const NOW = new Date(2026, 10, 22, 12, 0).getTime();
const pay = (n: number, o: Partial<Payment> = {}): Payment => ({
  ...heldPayment('s' + n),
  state: 'delivered',
  paymentId: 'pay:' + String(n).padStart(4, '0'),
  at: NOW - 60000 - n * 1000,
  ...o,
});
const claim = (id: string, o: Partial<Claim> = {}): Claim => ({ id, sale: 's-c', cardKey: '02' + 'c'.repeat(64),
  mint: 'https://mint.test', unit: 'sat', amount: 15, fee: 1, price: 14, step: 'released', at: 5, asks: 0, misses: 0,
  ...o });
const data = (o: Partial<ActivityData> = {}): ActivityData => ({ payments: [], claims: [], older: [], damaged: [],
  twice: [], ms: 0, ...o });
const ids = (ps: readonly Payment[]): string[] => ps.map((x) => x.paymentId);
const many = (n: number): Payment[] => Array.from({ length: n }, (_, i) => pay(i + 1));

const readerOf = (calls: string[]): ActivityReader => ({
  async payments(): Promise<Payment[]> {
    calls.push('payments');
    return [pay(1)];
  },
  async openClaims(): Promise<Claim[]> {
    calls.push('openClaims');
    return [claim('pay:c')];
  },
  async olderRows() {
    calls.push('olderRows');
    return [{ id: 'o', why: 'w' }];
  },
  async damagedRows() {
    calls.push('damagedRows');
    return [];
  },
  async maybePaidTwice(): Promise<string[]> {
    calls.push('maybePaidTwice');
    return ['pay:0001'];
  },
});

const clockOf = (...times: number[]): (() => number) => {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
};

describe('the Activity list as plain functions', () => {
  it('what is not finished, the claims and the losses are shown whatever the length of the list', () => {
    const d = data({
      payments: [
        ...many(130),
        pay(200, { state: 'taking', at: 0 }),
        pay(201, { state: 'unrecovered', at: 1 }),
        pay(202, { state: 'spent-not-restored', at: 2 }),
        pay(203, { state: 'held', extra: 'paid-twice', at: 3 }),
      ],
      claims: [claim('pay:c1')],
    });
    const v = activityView(d, 1, NOW);
    expect(ACTIVITY_PAGE).toBe(50);
    expect(ids(v.unfinished)).toEqual(['pay:0203', 'pay:0201', 'pay:0200']);
    expect(ids(v.losses)).toEqual(['pay:0202']);
    expect(v.claims.map((c) => c.id)).toEqual(['pay:c1']);
    expect(v.done.length).toBe(50);
    expect(v.doneTotal).toBe(130);
    expect(v.more).toBe(50);
    expect(ids(v.done)[0]).toBe('pay:0001');
    expect(ids(v.done)[49]).toBe('pay:0050');

    const two = activityView(d, 2, NOW);
    expect(two.done.length).toBe(100);
    expect(two.more).toBe(30);

    const three = activityView(d, 3, NOW);
    expect(three.done.length).toBe(130);
    expect(three.more).toBe(0);

    for (const pages of [0, -1, 1.5]) {
      const bad = activityView(d, pages, NOW);
      expect(bad.done.length).toBe(50);
      expect(bad.more).toBe(50);
    }
  });

  it('the finished payments are newest first, the same time by id', () => {
    const pays: Payment[] = [
      pay(1, { at: 10, paymentId: 'pay:b' }),
      pay(2, { at: 10, paymentId: 'pay:a' }),
      pay(3, { at: 10, paymentId: 'pay:c' }),
      pay(4, { at: 20, paymentId: 'pay:z' }),
    ];
    const v = activityView(data({ payments: pays }), 1, NOW);
    expect(ids(v.done)).toEqual(['pay:z', 'pay:a', 'pay:b', 'pay:c']);
    const before = ids(pays);
    newestFirst(pays);
    expect(ids(pays)).toEqual(before);
  });

  it('a claim the record also lists as a payment is shown once, as the payment', () => {
    const v = activityView(
      data({
        payments: [pay(1, { state: 'unrecovered', paymentId: 'pay:u' })],
        claims: [claim('pay:u', { step: 'unrecovered' }), claim('pay:v')],
      }),
      1,
      NOW,
    );
    expect(v.claims.map((c) => c.id)).toEqual(['pay:v']);
    expect(ids(v.unfinished)).toEqual(['pay:u']);
  });

  it('every payment is in one section only, and counted once', () => {
    const states: Array<Payment['state']> = ['taking', 'held', 'delivered', 'exported', 'gone', 'unrecovered', 'lost',
      'spent-not-restored', 'returning', 'returned'];
    const extras: Array<Payment['extra']> = [undefined, 'paid-twice', 'late'];
    const owes = [0, 5];
    const pays: Payment[] = [pay(0)];
    let i = 1;
    for (const s of states) {
      for (const x of extras) {
        for (const o of owes) {
          pays.push(pay(i, { state: s, extra: x, owedToCard: o }));
          i += 1;
        }
      }
    }
    pays.push(pay(0));
    const v = activityView(data({ payments: pays }), 100, NOW);
    expect(v.count).toBe(pays.length - 1);
    const union = ids([...v.unfinished, ...v.losses, ...v.done]);
    expect(new Set(union).size).toBe(union.length);
    const unique = Array.from(new Set(pays.map((p) => p.paymentId)));
    expect(union.slice().sort()).toEqual(unique.slice().sort());
    expect(v.all).toEqual(takings(pays, null));
    expect(v.all.count).toBe(pays.filter(isTakings).length - 1);
  });

  it('the totals are over the whole record, never the page', () => {
    const d = data({ payments: many(130) });
    const v = activityView(d, 1, NOW);
    expect(v.all).toEqual({ sats: 1820, count: 130 });
    expect(v.today).toEqual({ sats: 1820, count: 130 });

    const d2 = data({ payments: [...many(130), pay(131, { at: startOfDay(NOW) - 1 })] });
    const v2 = activityView(d2, 1, NOW);
    expect(v2.all).toEqual({ sats: 1834, count: 131 });
    expect(v2.today).toEqual({ sats: 1820, count: 130 });
  });

  it('a loss is never counted as takings, and never shown among the finished', () => {
    const v = activityView(
      data({ payments: [pay(1, { state: 'lost' }), pay(2, { state: 'spent-not-restored' }), pay(3)] }),
      1,
      NOW,
    );
    expect(v.all).toEqual({ sats: 14, count: 1 });
    expect(ids(v.done)).toEqual(['pay:0003']);
    expect(ids(v.losses)).toEqual(['pay:0001', 'pay:0002']);
  });

  it('the payments told as maybe paid twice are marked once each, only while the record lists them', () => {
    const v = activityView(data({ payments: [pay(1), pay(2)], twice: ['pay:0002', 'pay:0002', 'pay:9999'] }), 1, NOW);
    expect(v.twice).toEqual(['pay:0002']);
    expect(v.all).toEqual({ sats: 28, count: 2 });
    expect(ids(v.done)).toEqual(['pay:0001', 'pay:0002']);
    expect(activityView(data({ payments: [pay(1)] }), 1, NOW).twice).toEqual([]);
  });

  it('the report holds counts only', () => {
    const d = data({
      payments: [
        pay(1, {
          change: 'cashuB' + 'x'.repeat(60),
          cardKey: '02' + 'c'.repeat(64),
          paymentId: 'pay:' + 'd'.repeat(32),
          delivery: { id: 'fx-' + 'e'.repeat(26) },
        }),
        pay(2, { state: 'taking' }),
        pay(3, { state: 'lost' }),
      ],
      claims: [claim('pay:' + 'f'.repeat(32))],
      older: [{ id: 'old-row-7', why: 'a pooled payment' }],
      damaged: [{ id: 'bad-row-8', why: 'no id' }],
      twice: ['pay:' + 'd'.repeat(32)],
      ms: 42,
    });
    const r = activityReport(9, d, activityView(d, 1, NOW));
    expect(Object.keys(r).sort()).toEqual([...ACTIVITY_REPORT_KEYS].sort());
    expect(r).toEqual({
      at: 9,
      ms: 42,
      payments: 3,
      unfinished: 1,
      claims: 1,
      losses: 1,
      done: 1,
      shown: 1,
      older: 1,
      damaged: 1,
      today: { sats: 14, count: 1 },
      all: { sats: 14, count: 1 },
    });
    const text = JSON.stringify(r);
    for (const bad of ['cashu', 'pay:', 'fx-', 'cccc', 'old-row', 'bad-row', 'pooled']) {
      expect(text).not.toContain(bad);
    }
  });

  it('the record is read with five reads, one after the other, and timed', async () => {
    const calls: string[] = [];
    const d = await readActivity(readerOf(calls), clockOf(100, 350));
    expect(d).toEqual({
      payments: [pay(1)],
      claims: [claim('pay:c')],
      older: [{ id: 'o', why: 'w' }],
      damaged: [],
      twice: ['pay:0001'],
      ms: 250,
    });
    expect(calls).toEqual(['payments', 'openClaims', 'olderRows', 'damagedRows', 'maybePaidTwice']);

    const back: string[] = [];
    const late = await readActivity(readerOf(back), clockOf(100, 40));
    expect(late.ms).toBe(0);
  });

  it('a read that fails is passed on, and nothing after it is read', async () => {
    const calls: string[] = [];
    const r = readerOf(calls);
    const closed = new Error('closed');
    const failing: ActivityReader = {
      ...r,
      async openClaims(): Promise<Claim[]> {
        calls.push('openClaims');
        throw closed;
      },
    };
    await expect(readActivity(failing, clockOf(0))).rejects.toBe(closed);
    expect(calls).toEqual(['payments', 'openClaims']);
  });

  it('more than a page of unfinished payments, open claims and losses are all shown, none paged', () => {
    const open = Array.from({ length: 60 }, (_, i) => pay(300 + i, { state: 'taking', at: i }));
    const lost = Array.from({ length: 60 }, (_, i) =>
      pay(400 + i, { state: i % 2 === 0 ? 'lost' : 'spent-not-restored', at: i }),
    );
    const claims = Array.from({ length: 60 }, (_, i) => claim('pay:c' + i, { at: i }));
    const v = activityView(data({ payments: [...many(130), ...open, ...lost], claims }), 1, NOW);
    expect(v.unfinished.length).toBe(60);
    expect(v.losses.length).toBe(60);
    expect(v.claims.length).toBe(60);
    expect(v.done.length).toBe(50);
    expect(v.doneTotal).toBe(130);
    expect(v.all).toEqual({ sats: 1820, count: 130 });
  });

  it('a payment whose pieces were spent elsewhere is listed under Losses, never paged and never counted', () => {
    const v = activityView(data({ payments: [...many(130), pay(500, { state: 'gone', at: 0 })] }), 1, NOW);
    expect(ids(v.losses)).toEqual(['pay:0500']);
    expect(ids(v.unfinished)).toEqual([]);
    expect(ids(v.done)).not.toContain('pay:0500');
    expect(v.doneTotal).toBe(130);
    expect(v.all).toEqual({ sats: 1820, count: 130 });
  });

  it('kept by the till is in neither total', () => {
    const v = activityView(data({ payments: [pay(1, { kept: 3 }), pay(2, { kept: 1, state: 'held' })] }), 1, NOW);
    expect(v.today).toEqual({ sats: 28, count: 2 });
    expect(v.all).toEqual({ sats: 28, count: 2 });
  });

  it('a payment dated after now is not paid today, but is in the whole record', () => {
    const v = activityView(data({ payments: [pay(1), pay(2, { at: NOW + 60000 })] }), 1, NOW);
    expect(v.today).toEqual({ sats: 14, count: 1 });
    expect(v.all).toEqual({ sats: 28, count: 2 });
  });

  it('a card payment waiting for its card is listed once, as its open claim, and is never counted', () => {
    const d = data({
      payments: [pay(1, { state: 'taking', paymentId: 'pay:w' }), pay(2)],
      claims: [claim('pay:w', { step: 'sign-asked' }), claim('pay:v')],
    });
    const v = activityView(d, 1, NOW);
    expect(v.waiting).toEqual(['pay:w']);
    expect(v.claims.map((c) => c.id)).toEqual(['pay:w', 'pay:v']);
    expect(ids(v.unfinished)).toEqual([]);
    expect(ids(v.done)).toEqual(['pay:0002']);
    expect(v.count).toBe(1);
    expect(v.all).toEqual({ sats: 14, count: 1 });
    expect(v.today).toEqual({ sats: 14, count: 1 });

    const checked = activityView(
      data({
        payments: [pay(1, { state: 'taking', paymentId: 'pay:w' })],
        claims: [claim('pay:w', { step: 'released' }), claim('pay:x', { step: 'unrecovered' })],
      }),
      1,
      NOW,
    );
    expect(checked.waiting).toEqual([]);
    expect(checked.claims.map((c) => c.id)).toEqual(['pay:x']);
    expect(ids(checked.unfinished)).toEqual(['pay:w']);
  });

  it("the screen's state keeps what it showed when a later reading fails", () => {
    const a = data({ payments: [pay(1)] });
    const shown = activityStep(ACTIVITY_START, { type: 'read', data: a });
    expect(shown).toEqual({ kind: 'shown', data: a, stale: false });
    expect(activityStep(shown, { type: 'fail' })).toEqual({ kind: 'shown', data: a, stale: true });
    expect(activityStep(ACTIVITY_START, { type: 'fail' })).toEqual({ kind: 'failed' });
    const failed = activityStep(ACTIVITY_START, { type: 'fail' });
    expect(activityStep(failed, { type: 'again' })).toEqual({ kind: 'reading' });
    expect(activityStep(shown, { type: 'again' })).toBe(shown);
  });
});

it('includes confirmed Lightning sales in takings and keeps processing or extra receipts separate', async () => {
  const base = { saleId: 'sale', mint: 'https://mint.test', amount: 8, expiresAt: NOW + 1000,
    createdAt: NOW - 1000, invoice: 'private-invoice-example' };
  const d = await readActivity({ ...readerOf([]), payments: async () => [], listLightningSales: async () => [
    { ...base, paymentId: 'today', state: 'paid', paidAt: NOW },
    { ...base, paymentId: 'yesterday', state: 'paid', paidAt: NOW - 86400000 },
    { ...base, paymentId: 'wait', state: 'processing' },
    { ...base, paymentId: 'extra', state: 'extra' },
    { ...base, paymentId: 'offer', state: 'unpaid' },
    { ...base, paymentId: 'expired', state: 'expired' },
  ] }, () => NOW);
  const v = activityView(d, 1, NOW);
  expect(v.all).toEqual({ count: 2, sats: 16 });
  expect(v.today).toEqual({ count: 1, sats: 8 });
  expect(v.lightningPaid.map(row => row.paymentId)).toEqual(['today', 'yesterday']);
  expect(v.lightningOpen.map(row => row.state)).toEqual(['processing', 'extra']);
  expect(JSON.stringify(d)).not.toContain(base.invoice);
});
