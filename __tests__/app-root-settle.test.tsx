import {
  CardError,
  open,
  type CashuCard,
  type Delivery,
  type Payment,
} from 'cashucard';
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AppRoot } from '../src/app/AppRoot';
import { inFront } from '../src/app/app-state';
import { REPORT_KEYS, type AppReport, type AppWiring } from '../src/app/wiring';
import { benchGate } from '../src/till/guarded';
import { noReader } from '../src/till/reader';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import {
  SETTLE_WORDS,
  TILL_REPORT_KEYS,
  nowPaidWords,
  type ScheduleSource,
  type SettleWhy,
  type TillReport,
} from '../src/till/settle';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { heldPayment } from './helpers/fake-till';
import { flush, has, nodes, press, until, untilText } from './helpers/render';

const TEST_MINT = 'https://mint.test';

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

type Step = (k: CashuCard) => Promise<Payment[]>;
function make(o: { src?: ScheduleSource; payments?: () => Payment[] } = {}) {
  const f = fakeStoreDeps();
  const mint = fakeMint();
  const steps: Step[] = [];
  const whys: SettleWhy[] = [];
  const service = createTillService({
    store: f.deps, names: TILL_NAMES, settingsNames: TILL_SETTINGS, http: mint.http, now: () => 1000,
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
      return k;
    },
  });
  const realSettle = service.settleNow;
  service.settleNow = (why) => {
    whys.push(why);
    return realSettle(why);
  };
  const reports: AppReport[] = [];
  const tills: TillReport[] = [];
  const gate = benchGate('allow');
  const wiring: AppWiring = {
    mode: 'development', service, gate, reader: noReader(), report: (r) => reports.push(r),
    devMintPreset: 'https://mint.test', now: () => 1000, schedule: o.src, reportTill: (r) => tills.push(r),
  };
  return { f, mint, service, steps, whys, reports, tills, gate, wiring };
}

type Made = ReturnType<typeof make>;

async function mount(w: AppWiring): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<AppRoot wiring={w} />);
  });
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

const D: Delivery = { id: 'fx-' + 'a'.repeat(26), mint: 'https://mint.test', unit: 'sat', amount: 14, token: 'cashuB' + 'q'.repeat(60) };
const delivering: Step = async (k) => {
  await k.c.payout.deliver(D);
  return [{ ...heldPayment('s1'), state: 'delivered' }];
};

it('the till settles at launch, and its timer runs while in front', async () => {
  const x = source();
  const t = make({ src: x.src });
  const tree = await mount(t.wiring);
  await until(tree, 'firstrun-title');
  await flush();
  expect(t.whys).toEqual(['launch']);
  const armed = x.live();
  expect(armed.length).toBe(1);
  expect(armed[0].ms).toBe(180000);
});

it('coming to the front settles, and so does each three minutes', async () => {
  const x = source();
  const t = make({ src: x.src });
  await firstRun(t);
  x.tell(false);
  x.tell(true);
  await flush();
  expect(t.whys).toContain('front');
  x.fire();
  await flush();
  expect(t.whys[t.whys.length - 1]).toBe('timer');
});

it('Home shows what the keep-store holds once a settle delivered it', async () => {
  const x = source();
  const t = make({ src: x.src });
  const tree = await firstRun(t);
  expect(has(tree, 'home-kept')).toBe(false);
  t.steps.push(delivering);
  x.fire();
  await untilText(tree, 'home-kept', 'Kept in this phone: 14 sats');
});

it('a payment the record says is delivered is not shown as kept unless the keep-store has it', async () => {
  const x = source();
  const t = make({ src: x.src });
  const tree = await firstRun(t);
  t.steps.push(async () => [{ ...heldPayment('s1'), state: 'delivered' }]);
  x.fire();
  await flush();
  expect(has(tree, 'home-kept')).toBe(false);
});

it('Home tells each notice once, until it is seen', async () => {
  const x = source();
  let pays: Payment[] = [{ ...heldPayment('s1'), state: 'taking' }];
  const t = make({ src: x.src, payments: () => pays });
  const tree = await firstRun(t);
  t.steps.push(async () => [{ ...heldPayment('s1'), state: 'delivered' }]);
  x.fire();
  await untilText(
    tree,
    'home-notice-0',
    "14 sats · PAID. Paid and kept in this phone's wallet. " + nowPaidWords(0),
  );
  await press(tree, 'home-notice-ok');
  await flush();
  expect(has(tree, 'home-notice-0')).toBe(false);
  t.steps.push(async () => [{ ...heldPayment('s1'), state: 'delivered' }]);
  x.fire();
  await flush();
  expect(has(tree, 'home-notice-0')).toBe(false);
});

it('a settle that could not keep the record says so on Home', async () => {
  const x = source();
  const t = make({ src: x.src });
  const tree = await firstRun(t);
  t.steps.push(async () => {
    throw new CardError('journal', 'x.');
  });
  x.fire();
  await untilText(tree, 'home-settle', SETTLE_WORDS.record);
  t.steps.push(async () => []);
  x.fire();
  await flush();
  expect(has(tree, 'home-settle')).toBe(false);
});

it('the bench is told what the till holds, and never a token', async () => {
  const x = source();
  const t = make({ src: x.src });
  await firstRun(t);
  t.steps.push(delivering);
  x.fire();
  await flush();
  const last = t.tills[t.tills.length - 1];
  expect(last.kept).toEqual({ sats: 14, deliveries: 1 });
  expect(last.settle === null ? null : last.settle.why).toBe('timer');
  expect(last.settle === null ? null : last.settle.ok).toBe(true);
  for (const r of t.tills) {
    expect(Object.keys(r).sort()).toEqual([...TILL_REPORT_KEYS].sort());
  }
  const text = JSON.stringify(t.tills);
  expect(text.includes('cashu')).toBe(false);
  expect(/[0-9a-f]{64}/.test(text)).toBe(false);
  for (const r of t.reports) {
    expect(Object.keys(r).sort()).toEqual([...REPORT_KEYS].sort());
  }
});

it('settling asks no owner check', async () => {
  const x = source();
  const t = make({ src: x.src });
  await firstRun(t);
  const n = t.gate.asked.length;
  t.steps.push(delivering);
  x.fire();
  await flush();
  expect(t.gate.asked.length).toBe(n);
});

it('leaving the app root stops the schedule', async () => {
  const x = source();
  const t = make({ src: x.src });
  const tree = await firstRun(t);
  await act(async () => {
    tree.unmount();
  });
  expect(x.live()).toEqual([]);
  expect(x.listening()).toBe(0);
  const w = t.whys.length;
  x.tell(false);
  x.tell(true);
  await flush();
  expect(t.whys.length).toBe(w);
});

it('without a schedule source only the launch settles', async () => {
  const t = make();
  await firstRun(t);
  await flush();
  expect(t.whys).toEqual(['launch']);
});

it('the release wiring has a schedule and no till report', () => {
  const fs = require('fs') as { readFileSync(path: string, encoding: string): string };
  const src = fs.readFileSync('src/app/release-wiring.ts', 'utf8');
  expect(src.includes('schedule: deviceSchedule()')).toBe(true);
  expect(src.includes('reportTill')).toBe(false);
  expect(src.includes('devJournal')).toBe(false);
  expect(src.includes('devKeep')).toBe(false);
});

it('in front is any state but the back', () => {
  expect(inFront('active')).toBe(true);
  expect(inFront('inactive')).toBe(true);
  expect(inFront('unknown')).toBe(true);
  expect(inFront('background')).toBe(false);
});
