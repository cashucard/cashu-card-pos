/* The Activity and a payment's detail in the whole app (slice 1.4): Home's Activity and the sale's "See it in Activity"
 * open the Activity, a payment row opens that payment, Back keeps the Activity's pages while a payment is open, leaving
 * the Activity for Home starts it on page 1 again, both screens read again after every settle, neither asks the phone's
 * owner check, and the bench is told what each reading found (never a token, a key or an id). */

import {
  open,
  type CashuCard,
  type Claim,
  type Payment,
} from 'cashucard';
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AppRoot } from '../src/app/AppRoot';
import {
  ACTIVITY_REPORT_KEYS,
  paymentLine,
  type ActivityReport,
} from '../src/app/activity';
import { REPORT_KEYS, type AppReport, type AppWiring } from '../src/app/wiring';
import { benchGate } from '../src/till/guarded';
import { noReader } from '../src/till/reader';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import type { ScheduleSource } from '../src/till/settle';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { heldPayment } from './helpers/fake-till';
import { has, nodes, press, textOf, until, untilText } from './helpers/render';

const TEST_MINT = 'https://mint.test';

/** The settle schedule's ear and its timers, as the app root hears them. */
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
    tell(a: boolean): void {
      state.front = a;
      for (const l of listeners.slice()) {
        l(a);
      }
    },
    listening: () => listeners.length,
  };
}

const NOW = new Date(2026, 10, 22, 12, 0).getTime();
type Step = (k: CashuCard) => Promise<Payment[]>;
const pay = (n: number, o: Partial<Payment> = {}): Payment => ({ ...heldPayment('s' + n), state: 'delivered',
  paymentId: 'pay:' + String(n).padStart(4, '0'), at: NOW - 60000 - n * 1000, ...o });
interface Lib {
  payments?: () => Payment[];
  claims?: () => Claim[];
  src?: ScheduleSource;
}
function make(o: Lib = {}) {
  const f = fakeStoreDeps();
  const mint = fakeMint();
  const steps: Step[] = [];
  const service = createTillService({
    store: f.deps, names: TILL_NAMES, settingsNames: TILL_SETTINGS, http: mint.http, now: () => NOW,
    log: () => undefined,
    openLibrary: async (c) => {
      const k = await open(c);
      k.settle = async () => {
        const next = steps.shift();
        return next === undefined ? [] : next(k);
      };
      if (o.payments !== undefined) {
        const pays = o.payments;
        k.payments = async () => pays();
      }
      if (o.claims !== undefined) {
        const cl = o.claims;
        k.openClaims = async () => cl();
      }
      return k;
    },
  });
  const reports: AppReport[] = [];
  const acts: ActivityReport[] = [];
  const gate = benchGate('allow');
  const wiring: AppWiring = {
    mode: 'development', service, gate, reader: noReader(), report: (r) => reports.push(r),
    devMintPreset: 'https://mint.test', now: () => NOW, schedule: o.src, reportActivity: (r) => acts.push(r),
  };
  return { f, mint, service, steps, reports, acts, gate, wiring };
}

type Made = ReturnType<typeof make>;

/** The tree mounted last, for the afterEach. */
let last: ReactTestRenderer | null = null;

async function mount(w: AppWiring): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<AppRoot wiring={w} />);
  });
  last = tree;
  return tree;
}

/** The first run: the Welcome, the test mint checked and added, then the till. */
async function firstRun(t: Made): Promise<ReactTestRenderer> {
  const tree = await mount(t.wiring);
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

afterEach(async () => {
  const tree = last;
  if (tree !== null) {
    await act(async () => {
      tree.unmount();
    });
    last = null;
  }
});

it('the activity lists what the record holds, and back comes home', async () => {
  const t = make({ payments: () => [pay(1), pay(2, { state: 'taking' })] });
  const tree = await firstRun(t);
  await press(tree, 'home-activity');
  await untilText(tree, 'unf-row-0', paymentLine(pay(2, { state: 'taking' })));
  await untilText(tree, 'pay-row-0', paymentLine(pay(1)));
  await untilText(tree, 'act-today', 'Paid today: 14 sats in 1 payment');
  await press(tree, 'home-sale');
  await until(tree, 'home-title');
});

it('a payment opened from the activity comes back to the same pages; leaving the activity starts it on the first', async () => {
  const pays: Payment[] = [];
  for (let n = 1; n <= 120; n += 1) {
    pays.push(pay(n));
  }
  const t = make({ payments: () => pays });
  const tree = await firstRun(t);
  await press(tree, 'home-activity');
  await until(tree, 'pay-row-49');
  await press(tree, 'act-more');
  await until(tree, 'pay-row-99');
  await press(tree, 'pay-open-99');
  await untilText(tree, 'payment-title', 'PAID');
  await untilText(tree, 'payment-amount', '14 sats');
  await press(tree, 'nav-back');
  await until(tree, 'act-title');
  await until(tree, 'pay-row-99');
  await press(tree, 'home-sale');
  await until(tree, 'home-title');
  await press(tree, 'home-activity');
  await until(tree, 'pay-row-49');
  expect(has(tree, 'pay-row-50')).toBe(false);
});

it('the activity and the payment read again after a settle, and mark a payment the till told may be paid twice', async () => {
  const x = source();
  let pays: Payment[] = [pay(1, { state: 'taking' })];
  const t = make({ payments: () => pays, src: x.src });
  const tree = await firstRun(t);
  await press(tree, 'home-activity');
  await until(tree, 'unf-row-0');
  await press(tree, 'unf-open-0');
  await untilText(tree, 'payment-title', 'CHECKING');
  expect(has(tree, 'payment-twice')).toBe(false);
  // the settle has the mint take it: it was CHECKING before, so the till tells it may be paid twice (slice 1.3)
  t.steps.push(async () => {
    pays = [pay(1)];
    return [pay(1)];
  });
  x.fire();
  await untilText(tree, 'payment-title', 'PAID');
  await untilText(
    tree,
    'payment-twice',
    'The payment of 22 Nov 2026, 11:58 was not finished when its sale ended. It is paid now. If the customer paid that sale another way too, it is paid twice.',
  );
  await press(tree, 'nav-back');
  await until(tree, 'act-title');
  await untilText(tree, 'pay-row-0', paymentLine(pay(1), true));
  expect(textOf(tree, 'pay-row-0')).toBe('14 sats · PAID · 22 Nov 2026, 11:58 · SALE LEFT UNFINISHED: MAY BE PAID TWICE');
  expect(has(tree, 'unf-row-0')).toBe(false);
  // Seen on Home drops the notice; the mark is read from the notices kept, so it stays
  await press(tree, 'home-sale');
  await until(tree, 'home-notice-0');
  await press(tree, 'home-notice-ok');
  await press(tree, 'home-activity');
  await untilText(tree, 'pay-row-0', paymentLine(pay(1), true));
});

it('the report names the route shown, never more', async () => {
  const t = make();
  const tree = await firstRun(t);
  const before = t.reports[t.reports.length - 1];
  await press(tree, 'home-activity');
  await until(tree, 'act-payments-none');
  const after = t.reports[t.reports.length - 1];
  expect(after.screen).toBe('activity');
  expect(after.gate).toBe(before.gate);
});

it('the activity and a payment ask no owner check', async () => {
  const t = make({ payments: () => [pay(1)] });
  const tree = await firstRun(t);
  const n = t.gate.asked.length;
  await press(tree, 'home-activity');
  await until(tree, 'pay-row-0');
  await press(tree, 'pay-open-0');
  await until(tree, 'payment-amount');
  expect(t.gate.asked.length).toBe(n);
});

it("the bench is told what the activity read, as counts, and the app's report carries no id", async () => {
  const t = make({
    payments: () => [
      pay(1, { change: 'cashuB' + 'x'.repeat(60), cardKey: '02' + 'c'.repeat(64), paymentId: 'pay:' + 'd'.repeat(32) }),
      pay(2, { state: 'lost' }),
    ],
    claims: () => [
      { id: 'pay:' + 'f'.repeat(32), sale: 's-c', cardKey: '02' + 'c'.repeat(64), mint: 'https://mint.test', unit: 'sat',
        amount: 15, fee: 1, price: 14, step: 'released', at: 5, asks: 0, misses: 0 },
    ],
  });
  const tree = await firstRun(t);
  await press(tree, 'home-activity');
  await until(tree, 'pay-row-0');
  await press(tree, 'pay-open-0');
  await until(tree, 'payment-amount');
  expect(t.acts.length).toBeGreaterThanOrEqual(1);
  const last = t.acts[t.acts.length - 1];
  expect(last.payments).toBe(2);
  expect(last.losses).toBe(1);
  expect(last.claims).toBe(1);
  expect(last.all).toEqual({ sats: 14, count: 1 });
  for (const r of t.acts) {
    expect(Object.keys(r).sort()).toEqual([...ACTIVITY_REPORT_KEYS].sort());
  }
  for (const r of t.reports) {
    expect(Object.keys(r).sort()).toEqual([...REPORT_KEYS].sort());
  }
  const text = JSON.stringify([t.acts, t.reports]);
  expect(text.includes('cashu')).toBe(false);
  expect(text.includes('cccc')).toBe(false);
  expect(text.includes('dddd')).toBe(false);
  expect(text.includes('ffff')).toBe(false);
  expect(text.includes('pay:')).toBe(false);
  expect(t.reports.some((r) => r.screen === 'payment')).toBe(true);
});

it('a wiring without an activity report is fine', async () => {
  const t = make({ payments: () => [pay(1)] });
  delete (t.wiring as { reportActivity?: unknown }).reportActivity;
  const tree = await firstRun(t);
  await press(tree, 'home-activity');
  await until(tree, 'pay-row-0');
});

it('the release wiring reports no activity', () => {
  const fs = require('fs') as { readFileSync(path: string, encoding: string): string };
  const src = fs.readFileSync('src/app/release-wiring.ts', 'utf8');
  expect(src.includes('reportActivity')).toBe(false);
});

