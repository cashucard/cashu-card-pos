/* The Activity end to end (slice 1.4): the real AppRoot, the real till service over a fake store and a fake mint, and
 * the real cashucard library opened over them, with the card, the settle and the record's reads scripted. Each test
 * holds one rule a careless change would break: a state's words softened; an unfinished payment, a claim or a loss
 * hidden by paging; the customer's money counted as takings; a payment counted twice, or one not held counted at all;
 * a payment the till told may be paid twice left unmarked; a token, a key or an id on a screen, in a report or in a log;
 * the Activity or a payment asking the owner check; the list read inside the till's queue or waiting for a tap. */

jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/__mocks__/BackHandler'),
);

import {
  CardError,
  open,
  type CardListener,
  type CardTransport,
  type CashuCard,
  type Claim,
  type Payment,
} from 'cashucard';
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AppRoot } from '../src/app/AppRoot';
import type { AppReport, AppWiring } from '../src/app/wiring';
import { claimLine, paymentLine, type ActivityReport } from '../src/app/activity';
import type { ScheduleSource, TillReport } from '../src/till/settle';
import { benchGate } from '../src/till/guarded';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeStoreDeps } from './helpers/fake-store';
import { fakeMint } from './helpers/fake-mint';
import { fakeTransport, heldPayment } from './helpers/fake-till';
import { allText, flush, has, nodes, press, textOf, until, untilText } from './helpers/render';

const NOW = new Date(2026, 10, 22, 12, 0).getTime();
const TEST_MINT = 'https://mint.test';
type Script = (t: CardTransport, l: CardListener, id: string) => Promise<Payment>;
type Step = (k: CashuCard) => Promise<Payment[]>;
const pay = (n: number, o: Partial<Payment> = {}): Payment => ({ ...heldPayment('s' + n), state: 'delivered',
  paymentId: 'pay:' + String(n).padStart(4, '0'), at: NOW - 60000 - n * 1000, ...o });
const claim = (id: string, o: Partial<Claim> = {}): Claim => ({ id, sale: 's-c', cardKey: '02' + 'c'.repeat(64),
  mint: 'https://mint.test', unit: 'sat', amount: 15, fee: 1, price: 14, step: 'released', at: 5, asks: 0, misses: 0,
  ...o });
const TOKEN = 'cashuB' + 'x'.repeat(60);
const KEY = '02' + 'c'.repeat(64);
const PAY_ID = 'pay:' + 'd'.repeat(32);

/** The settle schedule's ear and its timers, as the app root hears them (as in __tests__/settle-schedule.test.ts). */
function source(front = true) {
  const timers: Array<{ f: () => void; ms: number; cleared: boolean; fired: boolean }> = [];
  const listeners: Array<(a: boolean) => void> = [];
  const state = { front };
  const src: ScheduleSource = {
    active: () => state.front,
    onActive: (l) => {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) {
          listeners.splice(i, 1);
        }
      };
    },
    timers: {
      set: (f, ms) => {
        const t = { f, ms, cleared: false, fired: false };
        timers.push(t);
        return t;
      },
      clear: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    },
  };
  const live = () => timers.filter((t) => !t.cleared && !t.fired);
  return {
    src,
    live,
    fire(): void {
      const l = live();
      if (l.length !== 1) {
        throw new Error('live timers: ' + l.length);
      }
      l[0].fired = true;
      l[0].f();
    },
  };
}

/** The whole app over fakes: the library's settle answers the next of `steps` ([] when none); its payments() answers
 * `pays.list`, which a test changes; its openClaims() answers o.claims when given; a sale's card answers the next of
 * `scripts`. */
function make(o: { claims?: () => Claim[] } = {}) {
  const f = fakeStoreDeps();
  const mint = fakeMint();
  const scripts: Script[] = [];
  const steps: Step[] = [];
  const pays: { list: Payment[] } = { list: [] };
  const reports: AppReport[] = [];
  const tills: TillReport[] = [];
  const acts: ActivityReport[] = [];
  const logs: string[] = [];
  const x = source();
  const service = createTillService({
    store: f.deps,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: mint.http,
    now: () => NOW,
    random: () => 0.25,
    log: (l) => logs.push(l),
    openLibrary: async (cfg) => {
      const k = await open(cfg);
      k.settle = async () => {
        const next = steps.shift();
        return next === undefined ? [] : next(k);
      };
      k.payments = async () => pays.list;
      if (o.claims !== undefined) {
        const cl = o.claims;
        k.openClaims = async () => cl();
      }
      const realSale = k.sale.bind(k);
      k.sale = async (id) => {
        const s = await realSale(id);
        s.card = async (t, l) => {
          const next = scripts.shift();
          if (next === undefined) {
            throw new Error('no card script left');
          }
          return next(t, l, id);
        };
        return s;
      };
      return k;
    },
  });
  const gate = benchGate('allow');
  const wiring: AppWiring = {
    mode: 'development',
    service,
    gate,
    reader: { kind: 'card simulator', available: async () => true, transport: () => fakeTransport() },
    report: (r) => reports.push(r),
    devMintPreset: TEST_MINT,
    now: () => NOW,
    schedule: x.src,
    reportTill: (r) => tills.push(r),
    reportActivity: (r) => acts.push(r),
  };
  return { service, scripts, steps, reports, tills, acts, logs, gate, x, wiring, pays };
}

type Made = ReturnType<typeof make>;

/** Every tree drawn in this file, for the last test. */
const texts: string[] = [];
let last: ReactTestRenderer | null = null;

async function firstRun(t: Made): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<AppRoot wiring={t.wiring} />);
  });
  last = tree;
  await until(tree, 'firstrun-title');
  await press(tree, 'firstrun-dev-mint');
  await until(tree, 'addmint-title');
  expect(nodes(tree, 'addmint-url')[0].props.value).toBe(TEST_MINT);
  await press(tree, 'addmint-check');
  await untilText(tree, 'addmint-result', 'This mint can be used.');
  await press(tree, 'addmint-add');
  await until(tree, 'home-title');
  return tree;
}

/** 14 sats on the keypad, then Charge. */
async function sell(tree: ReactTestRenderer): Promise<void> {
  await press(tree, 'home-sale');
  await press(tree, 'key-1');
  await press(tree, 'key-4');
  await press(tree, 'sale-charge');
}

/** The texts of prefix-row-0, prefix-row-1, ... while they exist. */
function rows(tree: ReactTestRenderer, prefix: string): string[] {
  const out: string[] = [];
  for (let i = 0; has(tree, prefix + '-row-' + i); i += 1) {
    out.push(textOf(tree, prefix + '-row-' + i));
  }
  return out;
}

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

afterEach(async () => {
  const tree = last;
  if (tree !== null) {
    texts.push(...allText(tree));
    await act(async () => {
      tree.unmount();
    });
    last = null;
  }
});

it('a sale the mint has not taken is listed as CHECKING, never counted, and PAID once a settle holds it', async () => {
  const t = make();
  const tree = await firstRun(t);
  t.scripts.push(async (tr, _l, id) => {
    await tr.begin?.('1');
    t.pays.list = [pay(1, { id, state: 'taking' })];
    throw new CardError('swap-lost', 'The mint has not answered.', { signed: true, entry: 'pay:0001' });
  });
  await sell(tree);
  await untilText(tree, 'result-title', 'CHECKING');
  await press(tree, 'result-activity');
  await untilText(tree, 'unf-row-0', paymentLine(pay(1, { state: 'taking' })));
  expect(textOf(tree, 'unf-row-0')).toBe('14 sats · CHECKING · 22 Nov 2026, 11:58');
  expect(textOf(tree, 'act-all')).toBe('Paid in this record: 0 sats in 0 payments');
  expect(has(tree, 'pay-row-0')).toBe(false);
  t.steps.push(async () => {
    t.pays.list = [pay(1)];
    return [pay(1)];
  });
  t.x.fire();
  // it was CHECKING before this settle paid it: the till told it may be paid twice, and the row says so
  await untilText(tree, 'pay-row-0', paymentLine(pay(1), true));
  expect(textOf(tree, 'pay-row-0')).toBe('14 sats · PAID · 22 Nov 2026, 11:58 · SALE LEFT UNFINISHED: MAY BE PAID TWICE');
  expect(textOf(tree, 'act-all')).toBe('Paid in this record: 14 sats in 1 payment');
  expect(has(tree, 'unf-row-0')).toBe(false);
  await press(tree, 'pay-open-0');
  await untilText(tree, 'payment-title', 'PAID');
  expect(textOf(tree, 'payment-twice')).toBe(
    'The payment of 22 Nov 2026, 11:58 was not finished when its sale ended. It is paid now. If the customer paid that sale another way too, it is paid twice.',
  );
});

it('nothing unfinished, no claim and no loss is ever paged away', async () => {
  const t = make({ claims: () => [claim('pay:c1')] });
  t.pays.list = [...Array.from({ length: 130 }, (_, i) => pay(i + 1)), pay(900, { state: 'taking', at: 0 }),
    pay(901, { state: 'unrecovered', at: 1 }), pay(902, { state: 'spent-not-restored', at: 2 }),
    pay(903, { state: 'held', extra: 'late', at: 3 })];
  const tree = await firstRun(t);
  await press(tree, 'home-activity');
  await until(tree, 'pay-row-0');
  expect(rows(tree, 'unf')).toEqual([
    paymentLine(pay(903, { state: 'held', extra: 'late', at: 3 })),
    paymentLine(pay(901, { state: 'unrecovered', at: 1 })),
    paymentLine(pay(900, { state: 'taking', at: 0 })),
  ]);
  expect(rows(tree, 'loss')).toEqual([paymentLine(pay(902, { state: 'spent-not-restored', at: 2 }))]);
  expect(textOf(tree, 'claim-row-0')).toBe(claimLine(claim('pay:c1')));
  expect(textOf(tree, 'claim-row-0').startsWith('14 sats from a card · asked 0 times · started ')).toBe(true);
  expect(has(tree, 'pay-row-49')).toBe(true);
  expect(has(tree, 'pay-row-50')).toBe(false);
  expect(textOf(tree, 'act-shown')).toBe('Showing 50 of 130 payments.');
  expect(textOf(tree, 'act-all')).toBe('Paid in this record: 1,820 sats in 130 payments');
});

it("the customer's money is never counted as takings", async () => {
  const t = make();
  t.pays.list = [pay(1, { state: 'held', extra: 'paid-twice' }), pay(2, { state: 'held', extra: 'late' }),
    pay(3, { state: 'held', extra: 'late', why: 'date-too-near' }), pay(4, { state: 'returning', extra: 'late' }),
    pay(5, { state: 'returned', extra: 'late', owedToCard: 13 }),
    pay(6, { state: 'returned', extra: 'late', givenBack: 13, unconfirmed: 13 }),
    pay(7, { state: 'exported', extra: 'late' }), pay(8)];
  const tree = await firstRun(t);
  await press(tree, 'home-activity');
  await until(tree, 'pay-row-0');
  expect(textOf(tree, 'act-all')).toBe('Paid in this record: 14 sats in 1 payment');
  expect(textOf(tree, 'act-today')).toBe('Paid today: 14 sats in 1 payment');
  expect(rows(tree, 'unf').map((s) => s.split(' · ')[1])).toEqual([
    'PAID TWICE', 'PAID LATE', 'KEPT FOR THE CUSTOMER', 'GOING BACK TO THE CARD', 'OWED TO THE CARD',
  ]);
  expect(rows(tree, 'pay').map((s) => s.split(' · ')[1])).toEqual(['WRITTEN TO THE CARD', 'TAKEN OUT FOR THE CUSTOMER', 'PAID']);
  await press(tree, 'unf-open-0');
  await untilText(tree, 'payment-title', 'PAID TWICE');
  expect(textOf(tree, 'payment-customers')).toBe("This money is the customer's. It is not counted as takings.");
  expect(textOf(tree, 'payment-title')).not.toBe('PAID');
});

it('a payment is counted once, however often it is listed or read', async () => {
  const t = make();
  t.pays.list = [pay(1, { owedToCard: 5 }), pay(1, { owedToCard: 5 }), pay(2)];
  const tree = await firstRun(t);
  await press(tree, 'home-activity');
  await until(tree, 'act-all');
  await until(tree, 'pay-row-0');
  expect(textOf(tree, 'act-all')).toBe('Paid in this record: 28 sats in 2 payments');
  expect(rows(tree, 'unf')).toEqual([paymentLine(pay(1, { owedToCard: 5 }))]);
  expect(rows(tree, 'pay')).toEqual([paymentLine(pay(2))]);
  const n = t.acts.length;
  t.steps.push(async () => [pay(2)]);
  t.x.fire();
  for (let i = 0; i < 20 && t.acts.length === n; i += 1) {
    await flush();
  }
  expect(t.acts.length).toBe(n + 1);
  expect(textOf(tree, 'act-all')).toBe('Paid in this record: 28 sats in 2 payments');
  expect(t.acts[t.acts.length - 1].all).toEqual({ sats: 28, count: 2 });
});

it('a payment not held is never counted, nor called PAID', async () => {
  const t = make();
  t.pays.list = [pay(1, { state: 'taking' }), pay(2, { state: 'unrecovered' }), pay(3, { state: 'lost' }),
    pay(4, { state: 'spent-not-restored' }), pay(5, { state: 'gone' })];
  const tree = await firstRun(t);
  await press(tree, 'home-activity');
  await until(tree, 'loss-row-2');
  expect(textOf(tree, 'act-all')).toBe('Paid in this record: 0 sats in 0 payments');
  for (const s of allText(tree)) {
    expect(s).not.toContain(' · PAID · ');
  }
  expect(textOf(tree, 'loss-row-0').startsWith('14 sats · NOT PAID YET: ')).toBe(true);
  expect(textOf(tree, 'loss-row-1').startsWith('14 sats · NOT PAID YET: ')).toBe(true);
  // a payment whose pieces were spent elsewhere is a loss too: listed under Losses, never among the finished
  expect(textOf(tree, 'loss-row-2')).toBe(paymentLine(pay(5, { state: 'gone' })));
  expect(textOf(tree, 'loss-row-2')).toContain(' · LOST · ');
  expect(textOf(tree, 'act-payments-none')).toBe('None.');
});

it('no token, key or id reaches a screen, a report or a log', async () => {
  const t = make({ claims: () => [claim('pay:' + 'f'.repeat(32))] });
  t.pays.list = [pay(1, { change: TOKEN, cardKey: KEY, paymentId: PAY_ID, delivery: { id: 'fx-' + 'e'.repeat(26) } })];
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const tree = await firstRun(t);
    await press(tree, 'home-activity');
    await until(tree, 'pay-row-0');
    const seen = [...allText(tree)];
    await press(tree, 'pay-open-0');
    await until(tree, 'payment-amount');
    seen.push(...allText(tree));
    const bads = ['cashu', 'cccc', 'dddd', 'eeee', 'ffff', 'fx-', 'pay:'];
    for (const s of seen) {
      for (const bad of bads) {
        expect(s).not.toContain(bad);
      }
    }
    const out = JSON.stringify([t.reports, t.tills, t.acts, t.logs]);
    for (const bad of bads) {
      expect(out).not.toContain(bad);
    }
    expect(out).not.toMatch(/[0-9a-f]{32}/);
    for (const spy of [log, warn, error]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain('cashu');
        }
      }
    }
  } finally {
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  }
});

it('the activity and a payment ask no owner check', async () => {
  const t = make();
  t.pays.list = [pay(1)];
  const tree = await firstRun(t);
  const n = t.gate.asked.length;
  await press(tree, 'home-activity');
  await until(tree, 'pay-row-0');
  await press(tree, 'pay-open-0');
  await until(tree, 'payment-amount');
  await press(tree, 'nav-back');
  await until(tree, 'act-title');
  await press(tree, 'home-sale');
  await until(tree, 'home-title');
  expect(t.gate.asked.length).toBe(n);
});

it('the activity is read outside the queue, and never waits for a tap', async () => {
  const t = make();
  t.pays.list = [pay(1)];
  const tree = await firstRun(t);
  const g = deferred<void>();
  const held = t.service.withCard('card', () => g.promise);
  await flush();
  expect(t.service.queue.tapOpen()).toBe(true);
  await press(tree, 'home-activity');
  await untilText(tree, 'pay-row-0', paymentLine(pay(1)));
  expect(t.service.queue.tapOpen()).toBe(true);
  await press(tree, 'pay-open-0');
  await untilText(tree, 'payment-title', 'PAID');
  expect(t.service.queue.tapOpen()).toBe(true);
  g.resolve();
  await held;
});

it('a sale that took nothing is never listed', async () => {
  const t = make();
  const tree = await firstRun(t);
  t.scripts.push(async () => {
    throw new CardError('declined', 'The payer did not accept. Nothing was taken.', { signed: false });
  });
  await sell(tree);
  await untilText(tree, 'result-title', 'NOT PAID');
  await press(tree, 'result-new');
  await until(tree, 'home-title');
  await press(tree, 'home-activity');
  await until(tree, 'act-payments-none');
  expect(textOf(tree, 'act-payments-none')).toBe('None.');
  expect(textOf(tree, 'act-open-none')).toBe('None.');
  expect(textOf(tree, 'act-all')).toBe('Paid in this record: 0 sats in 0 payments');
});

it('the words are plain', () => {
  expect(texts.length).toBeGreaterThan(50);
  for (const s of texts) {
    expect(s).not.toContain('—');
    expect(s).not.toContain('–');
    expect(s).not.toMatch(/crypto|paid back|settled/i);
  }
});
