/* The whole app seen while the settle works: the real AppRoot, the real sale screen, the real till service over a fake
 * store and a fake mint, and the real cashucard library opened over them. The card is a scripted sale(id) handle; each
 * settle's answer is a scripted step. Each test holds one rule a careless change would break: a payment the mint had not
 * taken turns PAID once a settle holds it, a settle waits for a tap (and a tap for a settle), money is called kept only
 * once the keep-store has it, a failed settle holds nothing up, and no token, key or id leaves the till's own words. */

jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/__mocks__/BackHandler'),
);

import {
  CardError,
  open,
  type CardListener,
  type CardTransport,
  type CashuCard,
  type Delivery,
  type Payment,
} from 'cashucard';
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AppRoot } from '../src/app/AppRoot';
import type { AppReport, AppWiring } from '../src/app/wiring';
import { benchGate } from '../src/till/guarded';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { SETTLE_WORDS, TILL_REPORT_KEYS, type ScheduleSource, type TillReport } from '../src/till/settle';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { fakeTransport, heldPayment } from './helpers/fake-till';
import { allText, flush, has, nodes, press, textOf, until, untilText } from './helpers/render';

type Script = (t: CardTransport, l: CardListener, id: string) => Promise<Payment>;
type Step = (k: CashuCard) => Promise<Payment[]>;

const PIN = '9753';
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
  const x = {
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
  return x;
}

/**
 * The whole app over fakes: the real library opened over the till's store and mint, with `settle` answering the next
 * scripted step (`[]` when none) and `sale(id)`'s card answering the next scripted script; the reports, the till's
 * reports, the logs, the settles asked (and whether one ran while a tap was open), and the wiring.
 */
function make(o: { payments?: () => Payment[] } = {}) {
  const f = fakeStoreDeps();
  const mint = fakeMint();
  const scripts: Script[] = [];
  const steps: Step[] = [];
  const settles: Array<{ tap: boolean }> = [];
  const reports: AppReport[] = [];
  const tills: TillReport[] = [];
  const logs: string[] = [];
  const x = source();
  let running = 0;
  let most = 0;
  let service!: ReturnType<typeof createTillService>;
  service = createTillService({
    store: f.deps,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: mint.http,
    now: () => 1000,
    random: () => 0.25,
    log: (l) => logs.push(l),
    openLibrary: async (cfg) => {
      const k = await open(cfg);
      k.settle = async () => {
        settles.push({ tap: service.queue.tapOpen() });
        running += 1;
        if (running > most) {
          most = running;
        }
        try {
          const next = steps.shift();
          return next === undefined ? [] : await next(k);
        } finally {
          running -= 1;
        }
      };
      if (o.payments !== undefined) {
        const pays = o.payments;
        k.payments = async () => pays();
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
  const wiring: AppWiring = {
    mode: 'development',
    service,
    gate: benchGate('allow'),
    reader: { kind: 'card simulator', available: async () => true, transport: () => fakeTransport() },
    report: (r) => reports.push(r),
    devMintPreset: TEST_MINT,
    now: () => 1000,
    schedule: x.src,
    reportTill: (r) => tills.push(r),
  };
  return {
    service,
    scripts,
    steps,
    settles,
    get most(): number {
      return most;
    },
    reports,
    tills,
    logs,
    f,
    x,
    wiring,
  };
}

type Made = ReturnType<typeof make>;

/** The tree mounted last, so a second app unmounts the first and the suite leaves nothing running. */
let last: ReactTestRenderer | null = null;

async function mount(w: AppWiring): Promise<ReactTestRenderer> {
  const was = last;
  if (was !== null) {
    await act(async () => {
      was.unmount();
    });
    last = null;
  }
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

/** 14 sats on the keypad, then Charge: the sale opens and the card is asked. */
async function sell(tree: ReactTestRenderer): Promise<void> {
  await press(tree, 'home-sale');
  await press(tree, 'key-1');
  await press(tree, 'key-4');
  await press(tree, 'sale-charge');
}

/** Flushes until the settles have taken every scripted step, at most 50 flushes. */
async function drained(t: Made): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (t.steps.length === 0) {
      return;
    }
    await flush();
  }
  throw new Error('the settles took no step: ' + t.steps.length + ' left');
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value);
    reject = rej;
  });
  return { promise, resolve, reject };
}

const D: Delivery = {
  id: 'fx-' + 'a'.repeat(26),
  mint: TEST_MINT,
  unit: 'sat',
  amount: 14,
  token: 'cashuB' + 'q'.repeat(60),
};

/** A settle that delivers the 14 sats into this phone's keep-store, and answers the payment delivered. */
const delivering: Step = async (k) => {
  await k.c.payout.deliver(D);
  return [{ ...heldPayment('s1'), state: 'delivered' }];
};

/** A take the mint had not taken: the card signed, the mint answered 503, so the payment is kept for settle. */
const lostSwap: Script = async (tr) => {
  await tr.begin?.('1');
  throw new CardError(
    'swap-lost',
    "The card's mint has not taken the payment yet (503). It is kept, and tried again by settle; do not take another payment for this sale.",
    { signed: true, entry: 'pay:00' },
  );
};

/** A card that pays 14 sats: begin, then the held payment. */
const paying: Script = async (tr, _l, id) => {
  await tr.begin?.('1');
  return heldPayment(id);
};

afterEach(async () => {
  const tree = last;
  if (tree !== null) {
    await act(async () => {
      tree.unmount();
    });
    last = null;
  }
});

it('a payment the mint had not taken turns PAID on the sale screen once a settle holds it', async () => {
  const t = make();
  const tree = await firstRun(t);
  // the settle after the card job: the mint has still not taken it
  t.steps.push(async () => [{ ...heldPayment('s1'), state: 'taking', why: 'swap-waiting: 503' }]);
  t.scripts.push(lostSwap);
  await sell(tree);
  await untilText(tree, 'result-title', 'CHECKING');
  await drained(t);
  await flush();
  expect(textOf(tree, 'result-title')).toBe('CHECKING');
  expect(t.reports.some((r) => r.sale !== null && r.sale.outcome === 'paid')).toBe(false);
  // the timer's settle delivers it
  t.steps.push(delivering);
  t.x.fire();
  await untilText(tree, 'result-title', 'PAID');
  expect(textOf(tree, 'result-amount')).toBe('14 sats');
});

it('PAID is never shown while the payment is still being taken', async () => {
  const t = make();
  const tree = await firstRun(t);
  t.steps.push(async () => [{ ...heldPayment('s1'), state: 'taking', why: 'swap-waiting: 503' }]);
  t.scripts.push(lostSwap);
  await sell(tree);
  await untilText(tree, 'result-title', 'CHECKING');
  await drained(t);
  // the timer's settle: still being taken
  t.steps.push(async () => [{ ...heldPayment('s1'), state: 'taking' }]);
  t.x.fire();
  await drained(t);
  await flush();
  expect(textOf(tree, 'result-title')).toBe('CHECKING');
  expect(allText(tree)).not.toContain('PAID');
  expect(t.reports.some((r) => r.sale !== null && r.sale.outcome === 'paid')).toBe(false);
});

it('a sale asked during a settle waits for it, says so, and is never refused', async () => {
  const settleGate = deferred<void>();
  const cardGate = deferred<void>();
  const t = make();
  const tree = await firstRun(t);
  await flush();
  t.steps.push(async () => {
    await settleGate.promise;
    return [];
  });
  t.x.fire();
  await flush();
  t.scripts.push(async (tr, _l, id) => {
    await tr.begin?.('1');
    await cardGate.promise;
    return heldPayment(id);
  });
  await sell(tree);
  await untilText(
    tree,
    'sale-opening',
    'One moment. The till is finishing earlier payments with the mint. Then it opens the sale.',
  );
  expect(has(tree, 'result-title')).toBe(false);
  settleGate.resolve(undefined);
  await untilText(tree, 'tap-title', 'Hold the card still');
  expect(has(tree, 'result-title')).toBe(false);
  cardGate.resolve(undefined);
  await untilText(tree, 'result-title', 'PAID');
  for (const s of t.settles) {
    expect(s.tap).toBe(false);
  }
});

it('a tap asked again during a settle says One moment, and can still be cancelled', async () => {
  const settleGate = deferred<void>();
  const t = make();
  const tree = await firstRun(t);
  // the settle after the first card job holds
  t.steps.push(async () => {
    await settleGate.promise;
    return [];
  });
  t.scripts.push(async (tr) => {
    await tr.begin?.('1');
    throw new CardError('interrupted', 'The card was taken away as it was signing.', { signed: true });
  });
  t.scripts.push(paying);
  await sell(tree);
  await untilText(tree, 'result-title', 'TAP THE SAME CARD AGAIN');
  await press(tree, 'result-retry');
  await untilText(tree, 'tap-title', 'One moment');
  expect(textOf(tree, 'tap-line')).toBe('The till is finishing earlier payments with the mint. Then it asks for the card.');
  expect(has(tree, 'tap-cancel')).toBe(true);
  // a take that never reached the reader's begin is let go at once; the card may have signed in the first tap
  await press(tree, 'tap-cancel');
  await untilText(tree, 'result-title', 'TAP THE SAME CARD AGAIN');
  expect(textOf(tree, 'result-message')).toBe('Cancelled. The card may already have signed this payment in an earlier tap.');
  expect(has(tree, 'result-new')).toBe(false);
  settleGate.resolve(undefined);
  await drained(t);
  await flush();
  await flush();
  expect(textOf(tree, 'result-title')).toBe('TAP THE SAME CARD AGAIN');
  // the queued card job ran `paying` once the settle ended, and its begin was refused at once: the card was never asked
  expect(t.scripts.length).toBe(0);
  expect(t.reports.some((r) => r.sale !== null && r.sale.outcome === 'not-paid')).toBe(false);
});

it('a CHECKING that named no payment turns PAID once a settle holds a payment of its sale', async () => {
  const t = make();
  const tree = await firstRun(t);
  const ids: string[] = [];
  t.scripts.push(async (tr, _l, id) => {
    ids.push(id);
    await tr.begin?.('1');
    throw new CardError('mint', 'The mint did not answer.', { signed: true });
  });
  await sell(tree);
  await untilText(tree, 'result-title', 'CHECKING');
  await drained(t);
  await flush();
  // another sale's payment: never this sale's PAID
  t.steps.push(async () => [{ ...heldPayment('s-other'), paymentId: 'pay:08', state: 'delivered' }]);
  t.x.fire();
  await drained(t);
  await flush();
  expect(textOf(tree, 'result-title')).toBe('CHECKING');
  t.steps.push(async () => [{ ...heldPayment(ids[0]), paymentId: 'pay:07', state: 'delivered' }]);
  t.x.fire();
  await untilText(tree, 'result-title', 'PAID');
  expect(textOf(tree, 'result-amount')).toBe('14 sats');
});

it('a settle never starts during a tap, and two never run at once', async () => {
  const t = make();
  const tree = await firstRun(t);
  // every settle is asked during the tap: the timer, the app going to the back and coming to the front, settleNow
  t.scripts.push(async (tr, _l, id) => {
    await tr.begin?.('1');
    t.x.fire();
    t.x.tell(false);
    t.x.tell(true);
    void t.service.settleNow('asked');
    await new Promise<void>((r) => setTimeout(r, 0));
    return heldPayment(id);
  });
  await sell(tree);
  await untilText(tree, 'result-title', 'PAID');
  for (let i = 0; i < 5; i += 1) {
    await flush();
  }
  expect(t.settles.length).toBeGreaterThanOrEqual(2);
  for (const s of t.settles) {
    expect(s.tap).toBe(false);
  }
  expect(t.most).toBe(1);
});

it('money is called kept only once the keep-store has it, and a delivery is kept once', async () => {
  const t = make();
  const tree = await firstRun(t);
  await flush();
  // says delivered, hands nothing over
  t.steps.push(async () => [{ ...heldPayment('s1'), state: 'delivered' }]);
  t.x.fire();
  await drained(t);
  await flush();
  expect(has(tree, 'home-kept')).toBe(false);
  expect(await t.service.kept()).toEqual([]);
  t.steps.push(delivering);
  t.x.fire();
  await drained(t);
  await untilText(tree, 'home-kept', 'Kept in this phone: 14 sats');
  expect(await t.service.kept()).toEqual([{ mint: 'https://mint.test/', unit: 'sat', amount: 14, count: 1 }]);
  // the same delivery id again
  t.steps.push(delivering);
  t.x.fire();
  await drained(t);
  await flush();
  expect(textOf(tree, 'home-kept')).toBe('Kept in this phone: 14 sats');
  expect(await t.service.kept()).toEqual([{ mint: 'https://mint.test/', unit: 'sat', amount: 14, count: 1 }]);
  expect(t.tills[t.tills.length - 1].kept).toEqual({ sats: 14, deliveries: 1 });
});

it('a sale paid by a card is followed by a settle that delivers it', async () => {
  const t = make();
  const tree = await firstRun(t);
  await flush();
  t.steps.push(delivering);
  t.scripts.push(paying);
  await sell(tree);
  await untilText(tree, 'result-title', 'PAID');
  await drained(t);
  await flush();
  expect(t.settles.length).toBeGreaterThanOrEqual(1);
  expect(t.service.lastSettle()?.why).toBe('after-card');
  await press(tree, 'result-new');
  await untilText(tree, 'home-kept', 'Kept in this phone: 14 sats');
});

it('money owed to a card is told on Home, once, until seen', async () => {
  const t = make();
  const tree = await firstRun(t);
  await flush();
  t.steps.push(async () => [{ ...heldPayment('s1'), state: 'returned', owedToCard: 13 }]);
  t.x.fire();
  await untilText(
    tree,
    'home-notice-0',
    '13 sats · OWED TO THE CARD. It is written back to the card at its next tap, with the PIN. Owed to the card, not written yet: 13 sats.',
  );
  await press(tree, 'home-notice-ok');
  await flush();
  expect(has(tree, 'home-notice-0')).toBe(false);
  t.steps.push(async () => [{ ...heldPayment('s1'), state: 'returned', owedToCard: 13 }]);
  t.x.fire();
  await flush();
  expect(has(tree, 'home-notice-0')).toBe(false);
});

it('a settle that failed holds nothing up', async () => {
  const t = make();
  const tree = await firstRun(t);
  await flush();
  t.steps.push(async () => {
    throw new CardError('mint', 'The mint did not answer.');
  });
  t.x.fire();
  await untilText(tree, 'home-settle', SETTLE_WORDS.later);
  t.scripts.push(paying);
  await sell(tree);
  await untilText(tree, 'result-title', 'PAID');
});

it('no token, key or id reaches a report, an event, a log or a notice', async () => {
  const t = make();
  const tree = await firstRun(t);
  await flush();
  let saleId = '';
  // two deliveries of D (the second the same id)
  t.steps.push(delivering);
  t.x.fire();
  await untilText(tree, 'home-kept', 'Kept in this phone: 14 sats');
  t.steps.push(delivering);
  t.x.fire();
  await drained(t);
  await flush();
  // money owed to a card, told on Home
  t.steps.push(async () => [{ ...heldPayment('s1'), state: 'returned', extra: 'late', owedToCard: 13 }]);
  t.x.fire();
  await until(tree, 'home-notice-0');
  const home = allText(tree).join('\n');
  // a card sale
  t.scripts.push(async (tr, _l, id) => {
    saleId = id;
    await tr.begin?.('1');
    return heldPayment(id);
  });
  await sell(tree);
  await untilText(tree, 'result-title', 'PAID');
  await drained(t);
  await flush();
  expect(saleId.startsWith('s-')).toBe(true);
  const seen = [
    JSON.stringify(t.reports),
    JSON.stringify(t.tills),
    t.logs.join('\n'),
    t.service.notices().map((n) => n.words).join('\n'),
  ].join('\n');
  expect(seen.includes('cashu')).toBe(false);
  expect(seen.includes(D.token)).toBe(false);
  expect(seen.includes(D.id)).toBe(false);
  expect(seen.includes(saleId)).toBe(false);
  expect(seen.includes('pay:')).toBe(false);
  expect(seen.includes(PIN)).toBe(false);
  expect(/[0-9a-f]{64}/.test(seen)).toBe(false);
  for (const s of [JSON.stringify(t.reports), JSON.stringify(t.tills), t.logs.join('\n'), t.f.logs.join('\n'), home, allText(tree).join('\n')]) {
    expect(s).not.toMatch(/cashu[AB]/);
    expect(s).not.toMatch(/[0-9a-f]{64}/);
  }
  for (const line of t.logs) {
    expect(line).toMatch(/^till: /);
  }
});

it('Seen asks no owner check', async () => {
  const t = make();
  const tree = await firstRun(t);
  const gate = t.wiring.gate as ReturnType<typeof benchGate>;
  t.steps.push(async () => [{ ...heldPayment('s1'), state: 'returned', extra: 'late', owedToCard: 13 }]);
  t.x.fire();
  await until(tree, 'home-notice-0');
  const n = gate.asked.length;
  await press(tree, 'home-notice-ok');
  await flush();
  expect(has(tree, 'home-notice-0')).toBe(false);
  expect(gate.asked.length).toBe(n);
});

it('NOT PAID YET never turns PAID on the sale screen; Home tells it once it is paid', async () => {
  let pays: Payment[] = [];
  const t = make({ payments: () => pays });
  const tree = await firstRun(t);
  // the card signed, the mint says its pieces are spent and gave nothing back
  t.scripts.push(async (tr) => {
    await tr.begin?.('1');
    throw new CardError('payment-lost', 'NOT PAID: the mint gave nothing back.', { signed: true, paymentId: 'pay:00' });
  });
  await sell(tree);
  await untilText(tree, 'result-title', 'NOT PAID YET');
  await drained(t);
  // a settle has the mint give it back: the payment is delivered
  pays = [{ ...heldPayment('s1'), state: 'spent-not-restored' }];
  t.steps.push(async () => [{ ...heldPayment('s1'), state: 'delivered' }]);
  t.x.fire();
  await drained(t);
  await flush();
  expect(textOf(tree, 'result-title')).toBe('NOT PAID YET');
  expect(t.reports.some((r) => r.sale !== null && r.sale.outcome === 'paid')).toBe(false);
  await press(tree, 'result-new');
  await until(tree, 'home-notice-0');
  expect(textOf(tree, 'home-notice-0')).toContain('It is paid now. If the customer paid that sale another way too, it is paid twice.');
});

it('the till event carries no payment as it is, nor its card key, change or id', async () => {
  const cardKey = '02' + 'ab'.repeat(32);
  const change = 'cashuB' + 'z'.repeat(60);
  const t = make({
    payments: () => [
      { ...heldPayment('s1'), paymentId: 'pay:41', cardKey, change, state: 'spent-not-restored' },
      { ...heldPayment('s2'), paymentId: 'pay:42', cardKey, owedToCard: 13, state: 'returned', extra: 'late' },
    ],
  });
  await firstRun(t);
  t.steps.push(async () => [{ ...heldPayment('s2'), paymentId: 'pay:42', cardKey, owedToCard: 13, state: 'returned', extra: 'late' }]);
  t.x.fire();
  await drained(t);
  await flush();
  expect(t.tills.length).toBeGreaterThan(0);
  for (const r of t.tills) {
    expect(Object.keys(r).sort()).toEqual([...TILL_REPORT_KEYS].sort());
    const s = JSON.stringify(r);
    expect(s.includes(cardKey)).toBe(false);
    expect(s.includes('cashu')).toBe(false);
    expect(s.includes('pay:')).toBe(false);
  }
  const lastTill = t.tills[t.tills.length - 1];
  expect(lastTill.payments).toEqual({ 'spent-not-restored': 1, returned: 1 });
});

