import React from 'react';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import type { Claim, Payment, SkippedRow } from 'cashucard';
import { ActivityScreen, type ActivityProps } from '../src/screens/ActivityScreen';
import {
  ACTIVITY_REPORT_KEYS,
  ACTIVITY_WORDS,
  claimLine,
  paymentLine,
  type ActivityData,
  type ActivityReader,
} from '../src/app/activity';
import { Gap } from '../src/ui/kit';
import { LIGHT } from '../src/ui/theme';
import { heldPayment } from './helpers/fake-till';
import { allText, flush, has, nodes, press, textOf } from './helpers/render';

const NOW = new Date(2026, 10, 22, 12, 0).getTime();
const pay = (n: number, o: Partial<Payment> = {}): Payment => ({ ...heldPayment('s' + n), state: 'delivered',
  paymentId: 'pay:' + String(n).padStart(4, '0'), at: NOW - 60000 - n * 1000, ...o });
const C: Claim = { id: 'pay:c1', sale: 's-c', cardKey: '02' + 'c'.repeat(64), mint: 'https://mint.test', unit: 'sat',
  amount: 15, fee: 1, price: 14, step: 'released', at: NOW - 5000, asks: 2, misses: 0 };
/** A reader over `d`, which a test may change; `fail` makes the next reading's payments() reject; `reads` counts readings. */
function reader(d: ActivityData) {
  const r = {
    d,
    fail: false,
    reads: 0,
    payments: async (): Promise<Payment[]> => {
      r.reads += 1;
      if (r.fail) {
        r.fail = false;
        throw new Error('closed');
      }
      return r.d.payments;
    },
    openClaims: async (): Promise<Claim[]> => r.d.claims,
    olderRows: async (): Promise<SkippedRow[]> => r.d.older,
    damagedRows: async (): Promise<SkippedRow[]> => r.d.damaged,
    maybePaidTwice: async (): Promise<string[]> => r.d.twice,
  };
  return r;
}
const data = (o: Partial<ActivityData> = {}): ActivityData => ({ payments: [], claims: [], older: [], damaged: [],
  twice: [], ms: 0, ...o });
/** every tree this file draws, for the last test */
const trees: string[][] = [];
/** Renders the screen; answers the tree, the props' mocks and the settle listeners it registered. */
async function show(r: ActivityReader, o: Partial<ActivityProps> = {}) {
  const listeners: Array<(c: Payment[]) => void> = [];
  const off = jest.fn();
  const props: ActivityProps = {
    reader: r, now: () => NOW, pages: 1, onPages: jest.fn(), onOpen: jest.fn(), onBack: jest.fn(),
    onPayments: (l) => {
      listeners.push(l);
      return off;
    },
    onRead: jest.fn(),
    ...o,
  };
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<ActivityScreen {...props} />);
  });
  await flush();
  trees.push(allText(tree));
  return { tree, props, listeners, off };
}
/** The flattened colour of the Text a Body with that testID renders. */
const colourOf = (tree: ReactTestRenderer, id: string): unknown =>
  (StyleSheet.flatten(nodes(tree, id)[1].props.style) as Record<string, unknown>).color;
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = (value) => res(value);
  });
  return { promise, resolve };
}

/** The record of the second test. */
const secondRecord = (): ActivityData =>
  data({
    payments: [pay(1), pay(2, { state: 'taking' }), pay(3, { state: 'spent-not-restored' })],
    claims: [C],
    older: [{ id: 'o1', why: 'a pooled payment' }],
    damaged: [{ id: 'd1', why: 'no id' }],
  });

describe('the Activity screen', () => {
  it('while the record is read the screen says so', async () => {
    const r: ActivityReader = {
      payments: () => new Promise<Payment[]>(() => undefined),
      openClaims: async () => [],
      olderRows: async () => [],
      damagedRows: async () => [],
      maybePaidTwice: async () => [],
    };
    const { tree, props } = await show(r);
    expect(textOf(tree, 'act-title')).toBe('Activity');
    expect(textOf(tree, 'act-reading')).toBe('Reading the record.');
    expect(has(tree, 'act-today')).toBe(false);
    await press(tree, 'nav-back');
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('each part of the record is in its own section, in its own words', async () => {
    const r = reader(secondRecord());
    const { tree } = await show(r);
    expect(textOf(tree, 'act-today')).toBe('Paid today: 14 sats in 1 payment');
    expect(textOf(tree, 'act-all')).toBe('Paid in this record: 14 sats in 1 payment');
    expect(textOf(tree, 'act-totals-note')).toBe(ACTIVITY_WORDS.totalsNote);
    expect(textOf(tree, 'act-open')).toBe('Not finished');
    expect(textOf(tree, 'unf-row-0')).toBe(paymentLine(pay(2, { state: 'taking' })));
    expect(textOf(tree, 'act-claims')).toBe('Open claims');
    expect(textOf(tree, 'act-claims-help')).toBe(ACTIVITY_WORDS.claimsHelp);
    expect(textOf(tree, 'claim-row-0')).toBe(claimLine(C));
    expect(textOf(tree, 'act-losses')).toBe('Losses');
    expect(textOf(tree, 'loss-row-0')).toBe(paymentLine(pay(3, { state: 'spent-not-restored' })));
    expect(textOf(tree, 'act-payments')).toBe('Payments');
    expect(textOf(tree, 'act-payments-note')).toBe('Sales that took nothing are not listed.');
    expect(textOf(tree, 'pay-row-0')).toBe(paymentLine(pay(1)));
    expect(textOf(tree, 'act-rows')).toBe('Rows kept as they are');
    expect(textOf(tree, 'row-older-0')).toBe('A row of an earlier version: a pooled payment. It is kept as it is.');
    expect(textOf(tree, 'row-damaged-0')).toBe('A row this version cannot read: no id. It is kept as it is.');
    for (const id of ['act-open-none', 'act-claims-none', 'act-losses-none', 'act-payments-none', 'act-rows-none',
      'act-more', 'act-shown', 'act-stale']) {
      expect([id, has(tree, id)]).toEqual([id, false]);
    }
  });

  it('an empty record says None. in every section', async () => {
    const { tree } = await show(reader(data()));
    for (const id of ['act-open-none', 'act-claims-none', 'act-losses-none', 'act-payments-none', 'act-rows-none']) {
      expect([id, textOf(tree, id)]).toEqual([id, 'None.']);
    }
    expect(textOf(tree, 'act-today')).toBe('Paid today: 0 sats in 0 payments');
    for (const id of ['act-claims-help', 'act-more', 'act-shown', 'pay-row-0']) {
      expect([id, has(tree, id)]).toEqual([id, false]);
    }
  });

  it('each row has the tone of its words', async () => {
    const a = await show(reader(secondRecord()));
    expect(colourOf(a.tree, 'pay-row-0')).toBe(LIGHT.good);
    expect(colourOf(a.tree, 'loss-row-0')).toBe(LIGHT.bad);
    expect(colourOf(a.tree, 'unf-row-0')).toBe(LIGHT.text);

    const b = await show(reader(data({ payments: [pay(1, { state: 'held', extra: 'paid-twice' })] })));
    expect(colourOf(b.tree, 'unf-row-0')).toBe(LIGHT.bad);

    const c = await show(reader(data({ payments: [pay(1, { state: 'held', extra: 'late', why: 'date-too-near' })] })));
    expect(colourOf(c.tree, 'unf-row-0')).toBe(LIGHT.text);

    const d = await show(reader(data({ payments: [pay(1, { state: 'returned', extra: 'late', owedToCard: 13 })] })));
    expect(colourOf(d.tree, 'unf-row-0')).toBe(LIGHT.text);
  });

  it('a payment the till told may be paid twice says so on its row, in the bad tone', async () => {
    const { tree } = await show(reader(data({ payments: [pay(1), pay(2)], twice: ['pay:0001'] })));
    expect(textOf(tree, 'pay-row-0')).toBe(
      '14 sats · PAID · 22 Nov 2026, 11:58 · SALE LEFT UNFINISHED: MAY BE PAID TWICE',
    );
    expect(textOf(tree, 'pay-row-0')).toBe(paymentLine(pay(1), true));
    expect(colourOf(tree, 'pay-row-0')).toBe(LIGHT.bad);
    expect(textOf(tree, 'pay-row-1')).toBe(paymentLine(pay(2)));
    expect(colourOf(tree, 'pay-row-1')).toBe(LIGHT.good);
    expect(textOf(tree, 'act-all')).toBe('Paid in this record: 28 sats in 2 payments');
  });

  it('a payment row opens that payment; a claim or a kept row opens nothing', async () => {
    const { tree, props } = await show(reader(secondRecord()));
    await press(tree, 'pay-open-0');
    await press(tree, 'unf-open-0');
    await press(tree, 'loss-open-0');
    expect((props.onOpen as jest.Mock).mock.calls.map((x) => x[0])).toEqual(['pay:0001', 'pay:0002', 'pay:0003']);
    expect(has(tree, 'claim-open-0')).toBe(false);
    expect(nodes(tree, 'claim-row-0')[0].props.onPress).toBeUndefined();
    expect(nodes(tree, 'row-older-0')[0].props.onPress).toBeUndefined();
  });

  it('finished payments come fifty at a time, and nothing not finished is ever left out', async () => {
    const pays: Payment[] = [];
    for (let n = 1; n <= 120; n += 1) {
      pays.push(pay(n));
    }
    pays.push(pay(500, { state: 'taking', at: 0 }), pay(501, { state: 'lost', at: 1 }));
    const r = reader(data({ payments: pays, claims: [C] }));
    const { tree, props } = await show(r, { pages: 1 });
    expect(has(tree, 'pay-row-49')).toBe(true);
    expect(has(tree, 'pay-row-50')).toBe(false);
    expect(has(tree, 'unf-row-0')).toBe(true);
    expect(has(tree, 'loss-row-0')).toBe(true);
    expect(has(tree, 'claim-row-0')).toBe(true);
    expect(textOf(tree, 'act-shown')).toBe('Showing 50 of 120 payments.');
    expect(nodes(tree, 'act-more')[0].props.label).toBe('Show 50 more');
    await press(tree, 'act-more');
    expect(props.onPages).toHaveBeenCalledWith(2);

    await act(async () => {
      tree.update(<ActivityScreen {...props} pages={3} />);
    });
    expect(has(tree, 'pay-row-119')).toBe(true);
    expect(has(tree, 'act-more')).toBe(false);
    expect(has(tree, 'act-shown')).toBe(false);
    expect(has(tree, 'unf-row-0')).toBe(true);
    expect(has(tree, 'loss-row-0')).toBe(true);
    expect(has(tree, 'claim-row-0')).toBe(true);
    expect(r.reads).toBe(1);
  });

  it('a settle that changed payments reads the record again', async () => {
    const r = reader(data({ payments: [pay(1, { state: 'taking' })] }));
    const { tree, listeners } = await show(r);
    expect(has(tree, 'unf-row-0')).toBe(true);
    r.d = data({ payments: [pay(1)] });
    await act(async () => {
      for (const l of listeners) {
        l([pay(1)]);
      }
    });
    await flush();
    expect(has(tree, 'unf-row-0')).toBe(false);
    expect(textOf(tree, 'act-open-none')).toBe('None.');
    expect(textOf(tree, 'pay-row-0')).toBe(paymentLine(pay(1)));
    expect(r.reads).toBe(2);
  });

  it('a reading that fails says so, keeps what it showed, and can be tried again', async () => {
    const r = reader(data({ payments: [pay(1)] }));
    r.fail = true;
    const { tree, listeners } = await show(r);
    expect(textOf(tree, 'act-failed')).toBe('The record could not be read now.');
    await press(tree, 'act-again');
    await flush();
    expect(has(tree, 'pay-row-0')).toBe(true);
    expect(has(tree, 'act-failed')).toBe(false);
    r.fail = true;
    await act(async () => {
      for (const l of listeners) {
        l([]);
      }
    });
    await flush();
    expect(textOf(tree, 'act-stale')).toBe('The record could not be read again now. This may not be the latest.');
    expect(has(tree, 'pay-row-0')).toBe(true);
  });

  it('an older reading never overwrites a newer one', async () => {
    const g = deferred<Payment[]>();
    let reads = 0;
    const r: ActivityReader = {
      payments: async (): Promise<Payment[]> => {
        reads += 1;
        if (reads === 1) {
          return g.promise;
        }
        return [pay(2)];
      },
      openClaims: async () => [],
      olderRows: async () => [],
      damagedRows: async () => [],
      maybePaidTwice: async () => [],
    };
    const { tree, listeners } = await show(r);
    await act(async () => {
      for (const l of listeners) {
        l([]);
      }
    });
    await flush();
    expect(textOf(tree, 'pay-row-0')).toBe(paymentLine(pay(2)));
    await act(async () => {
      g.resolve([pay(1, { state: 'taking' })]);
    });
    await flush();
    expect(textOf(tree, 'pay-row-0')).toBe(paymentLine(pay(2)));
    expect(has(tree, 'unf-row-0')).toBe(false);
  });

  it('the bench is told what each reading found, counts only', async () => {
    const secret = 'pay:' + 'd'.repeat(32);
    const r = reader(data({
      payments: [pay(1, { change: 'cashuB' + 'x'.repeat(60), cardKey: '02' + 'c'.repeat(64), paymentId: secret }),
        pay(2, { state: 'taking' })],
      claims: [C],
      twice: [secret],
    }));
    const { tree, props } = await show(r);
    const onRead = props.onRead as jest.Mock;
    expect(onRead).toHaveBeenCalledTimes(1);
    const report = onRead.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(report).sort()).toEqual([...ACTIVITY_REPORT_KEYS].sort());
    expect(report.payments).toBe(2);
    expect(report.unfinished).toBe(1);
    expect(report.claims).toBe(1);
    expect(report.shown).toBe(1);
    const text = JSON.stringify(report);
    for (const bad of ['cashu', 'pay:', 'cccc']) {
      expect(text).not.toContain(bad);
    }

    const throwing = await show(reader(data({ payments: [pay(1)] })), {
      onRead: jest.fn(() => {
        throw new Error('x');
      }),
    });
    expect(has(throwing.tree, 'pay-row-0')).toBe(true);
  });

  it('nothing on the screen is a token, a key or an id', async () => {
    const secret = 'pay:' + 'd'.repeat(32);
    const { tree } = await show(reader(data({
      payments: [pay(1, { change: 'cashuB' + 'x'.repeat(60), cardKey: '02' + 'c'.repeat(64), paymentId: secret }),
        pay(2, { state: 'taking' })],
      claims: [C],
      twice: [secret],
    })));
    for (const s of allText(tree)) {
      for (const bad of ['cashu', 'cccc', 'dddd', 'pay:']) {
        expect(s).not.toContain(bad);
      }
    }
  });

  it('leaving the screen stops listening and reading', async () => {
    const r = reader(data({ payments: [pay(1)] }));
    const { tree, listeners, off } = await show(r);
    await act(async () => {
      tree.unmount();
    });
    expect(off).toHaveBeenCalledTimes(1);
    const n = r.reads;
    await act(async () => {
      for (const l of listeners) {
        l([]);
      }
    });
    await flush();
    expect(r.reads).toBe(n);
  });

  it('a paid payment not finished because change is owed to its card says so on its row, its PAID still green', async () => {
    const { tree } = await show(reader(data({ payments: [pay(1, { owedToCard: 3 }), pay(2)] })));
    expect(textOf(tree, 'unf-row-0')).toBe('14 sats · PAID · 22 Nov 2026, 11:58');
    expect(colourOf(tree, 'unf-row-0')).toBe(LIGHT.good);
    expect(textOf(tree, 'unf-owed-0')).toBe('Change owed to the card, not written yet: 3 sats');
    expect(colourOf(tree, 'unf-owed-0')).toBe(LIGHT.text);
    expect(nodes(tree, 'unf-open-0')[0].props.accessibilityLabel).toBe(
      '14 sats · PAID · 22 Nov 2026, 11:58. Change owed to the card, not written yet: 3 sats',
    );
    expect(textOf(tree, 'pay-row-0')).toBe(paymentLine(pay(2)));
    expect(has(tree, 'pay-owed-0')).toBe(false);
    expect(textOf(tree, 'act-all')).toBe('Paid in this record: 28 sats in 2 payments');
  });

  it('a payment whose pieces were spent elsewhere is listed under Losses, in red, never paged and never counted', async () => {
    const pays: Payment[] = [];
    for (let n = 1; n <= 120; n += 1) {
      pays.push(pay(n));
    }
    pays.push(pay(500, { state: 'gone', at: 0 }));
    const { tree } = await show(reader(data({ payments: pays })));
    expect(has(tree, 'act-losses-none')).toBe(false);
    expect(textOf(tree, 'loss-row-0')).toBe(paymentLine(pay(500, { state: 'gone', at: 0 })));
    expect(textOf(tree, 'loss-row-0')).toContain(' · LOST · ');
    expect(colourOf(tree, 'loss-row-0')).toBe(LIGHT.bad);
    expect(textOf(tree, 'act-shown')).toBe('Showing 50 of 120 payments.');
    expect(textOf(tree, 'act-all')).toBe('Paid in this record: 1,680 sats in 120 payments');
  });

  it('more than a page of unfinished payments, open claims and losses are all shown, none paged', async () => {
    const pays: Payment[] = [];
    const claims: Claim[] = [];
    for (let n = 1; n <= 60; n += 1) {
      pays.push(pay(n));
      pays.push(pay(100 + n, { state: 'taking' }));
      pays.push(pay(200 + n, { state: n % 2 === 0 ? 'lost' : 'spent-not-restored' }));
      claims.push({ ...C, id: 'pay:c' + n, at: NOW - 5000 - n });
    }
    const { tree } = await show(reader(data({ payments: pays, claims })), { pages: 1 });
    expect(has(tree, 'unf-row-59')).toBe(true);
    expect(has(tree, 'unf-row-60')).toBe(false);
    expect(has(tree, 'claim-row-59')).toBe(true);
    expect(has(tree, 'claim-row-60')).toBe(false);
    expect(has(tree, 'loss-row-59')).toBe(true);
    expect(has(tree, 'loss-row-60')).toBe(false);
    expect(has(tree, 'pay-row-49')).toBe(true);
    expect(has(tree, 'pay-row-50')).toBe(false);
    expect(textOf(tree, 'act-shown')).toBe('Showing 50 of 60 payments.');
  });

  it('a card payment waiting for its card is listed once, as its open claim, which opens its payment', async () => {
    const w: Claim = { ...C, id: 'pay:0001', step: 'sign-asked' };
    const { tree, props } = await show(reader(data({ payments: [pay(1, { state: 'taking' })], claims: [w] })));
    expect(has(tree, 'unf-row-0')).toBe(false);
    expect(textOf(tree, 'act-open-none')).toBe('None.');
    expect(textOf(tree, 'claim-row-0')).toBe(claimLine(w, true));
    expect(textOf(tree, 'claim-row-0')).toContain(' · WAITING FOR THE CARD');
    expect(textOf(tree, 'act-claims-help')).toBe(ACTIVITY_WORDS.claimsHelp);
    expect(textOf(tree, 'act-all')).toBe('Paid in this record: 0 sats in 0 payments');
    await press(tree, 'claim-open-0');
    expect((props.onOpen as jest.Mock).mock.calls.map((x) => x[0])).toEqual(['pay:0001']);
    expect(colourOf(tree, 'claim-row-0')).toBe(LIGHT.text);
  });

  it('a gap comes before the line that says what is off the page, and only when something is', async () => {
    const pays: Payment[] = [];
    for (let n = 1; n <= 120; n += 1) {
      pays.push(pay(n));
    }
    const paged = await show(reader(data({ payments: pays })), { pages: 1 });
    const gaps: ReactTestInstance[] = paged.tree.root.findAllByType(Gap);
    expect(gaps.length).toBe(1);
    expect(textOf(paged.tree, 'act-shown')).toBe('Showing 50 of 120 payments.');

    const whole = await show(reader(data({ payments: pays })), { pages: 3 });
    expect(whole.tree.root.findAllByType(Gap).length).toBe(0);
    expect(has(whole.tree, 'act-shown')).toBe(false);

    const short = await show(reader(data({ payments: pays.slice(0, 30) })), { pages: 1 });
    expect(short.tree.root.findAllByType(Gap).length).toBe(0);
    expect(has(short.tree, 'act-shown')).toBe(false);
  });

  it('the gap sits directly above "Showing 50 of N payments."', async () => {
    const pays: Payment[] = [];
    for (let n = 1; n <= 60; n += 1) {
      pays.push(pay(n));
    }
    const { tree } = await show(reader(data({ payments: pays })));
    const shown = nodes(tree, 'act-shown')[0];
    const siblings = (shown.parent as ReactTestInstance).children;
    const at = siblings.indexOf(shown);
    expect(at).toBeGreaterThan(0);
    expect((siblings[at - 1] as ReactTestInstance).type).toBe(Gap);
  });

  it('the words are plain', () => {
    expect(trees.length).toBeGreaterThan(5);
    for (const tree of trees) {
      for (const s of tree) {
        expect(s).not.toContain('—');
        expect(s).not.toContain('–');
        expect(/crypto|paid back|settled/i.test(s)).toBe(false);
      }
    }
  });
});
