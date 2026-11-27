/* The whole app through one sale: the real screen, the real controller, the real till service, the real journal, the
 * real cashucard library, a fake store, a fake mint, and a card scripted only by wrapping sale(id)'s card and close.
 * Each test holds one rule a careless change would break. */

jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/__mocks__/BackHandler'),
);

import {
  CardError,
  open,
  stageWords,
  type CardConfirmation,
  type CardListener,
  type CardTransport,
  type Payment,
} from 'cashucard';
import React from 'react';
import { BackHandler } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AppRoot } from '../src/app/AppRoot';
import type { AppReport, AppWiring } from '../src/app/wiring';
import { benchGate } from '../src/till/guarded';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { CONFIRMATION, fakeTransport, heldPayment } from './helpers/fake-till';
import { allText, flush, has, press, textOf, until, untilText } from './helpers/render';

type Script = (t: CardTransport, l: CardListener, id: string) => Promise<Payment>;

const PIN = '9753';
const C2100: CardConfirmation = { ...CONFIRMATION, price: 2100, inputFees: 1, total: 2101, balance: 2200 };

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

/** The whole app over fakes: the service, its reports, logs, closes and sale handles, the shared order, the wiring. */
function make(scripts: Script[], order: string[] = []) {
  const f = fakeStoreDeps();
  const mint = fakeMint();
  const reports: AppReport[] = [];
  const logs: string[] = [];
  const closes: Array<{ id: string; paid: boolean; running: string | null }> = [];
  const handles: Array<{ id: string; lib: number }> = [];
  let libs = 0;
  let service!: ReturnType<typeof createTillService>;
  service = createTillService({
    store: f.deps,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: mint.http,
    now: () => 1000,
    log: (l) => logs.push(l),
    random: () => 0.25,
    openLibrary: async (c) => {
      const k = await open(c);
      const n = libs;
      libs += 1;
      const realSale = k.sale.bind(k);
      k.sale = async (id) => {
        const s = await realSale(id);
        handles.push({ id, lib: n });
        s.card = async (t, l) => {
          const next = scripts.shift();
          if (next === undefined) {
            throw new Error('no card script left');
          }
          return next(t, l, id);
        };
        const realClose = s.close.bind(s);
        s.close = async (paid) => {
          order.push('close');
          closes.push({ id, paid, running: service.queue.running() });
          return realClose(paid);
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
    devMintPreset: 'https://mint.test',
    now: () => 1000,
  };
  return { service, reports, logs, closes, handles, order, wiring };
}

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
async function firstRun(w: AppWiring): Promise<ReactTestRenderer> {
  const tree = await mount(w);
  await until(tree, 'firstrun-title');
  await press(tree, 'firstrun-dev-mint');
  await until(tree, 'addmint-title');
  await press(tree, 'addmint-check');
  await untilText(tree, 'addmint-result', 'This mint can be used.');
  await press(tree, 'addmint-add');
  await until(tree, 'home-title');
  return tree;
}

/** 2,100 sats on the keypad, then Charge: the card is asked. */
async function charge(tree: ReactTestRenderer): Promise<void> {
  await press(tree, 'home-sale');
  await press(tree, 'key-2');
  await press(tree, 'key-1');
  await press(tree, 'key-0');
  await press(tree, 'key-0');
  await press(tree, 'sale-charge');
}

/** As charge, then until THE CARD PAYS. */
async function toSheet(tree: ReactTestRenderer): Promise<void> {
  await charge(tree);
  await until(tree, 'sheet-pays');
}

/** The PIN pad: one key per digit, then OK. */
async function pinIn(tree: ReactTestRenderer, pin: string): Promise<void> {
  for (const d of pin) {
    await press(tree, 'pin-key-' + d);
  }
  await press(tree, 'pin-ok');
}

/** A card that pays 2,100 plus its 1 sat fee: reading, THE CARD PAYS, the PIN, signing, then PAID and the held payment. */
function paying(seen: string[]): Script {
  return async (t, l, id) => {
    await t.begin?.('1');
    l.onStage?.('reading', stageWords('reading'), {});
    const a = await l.confirm(C2100);
    if (!a.pay) {
      throw new CardError('declined', 'The payer did not accept. Nothing was taken.');
    }
    seen.push(a.pin ?? '');
    await t.begin?.('2');
    l.onStage?.('signing', stageWords('signing', { seconds: 1 }), {});
    l.onStage?.('paid', stageWords('paid'), {});
    return { ...heldPayment(id), amount: 2100 };
  };
}

/** As paying, but the library answers with a payment still taking, held behind the gate. */
function payingTaking(gate: Deferred<void>): Script {
  return async (t, l, id) => {
    await t.begin?.('1');
    l.onStage?.('reading', stageWords('reading'), {});
    await l.confirm(C2100);
    await t.begin?.('2');
    l.onStage?.('signing', stageWords('signing', { seconds: 1 }), {});
    l.onStage?.('paid', stageWords('paid'), {});
    await gate.promise;
    return { ...heldPayment(id), state: 'taking' };
  };
}

/** A card whose take throws, after the tap: `e` is what the library throws. */
function throwing(order: string[], e: CardError): Script {
  return async (t) => {
    await t.begin?.('1');
    order.push('card end');
    throw e;
  };
}

/** A card whose tap was dropped after it signed: the next tap asks its PIN to finish, then answers the payment. */
function recovering(seen: string[]): Script {
  return async (t, l, id) => {
    await t.begin?.('1');
    const p = await l.askPin!({ wrong: false, tries: 3, why: 'recover' });
    seen.push(p ?? '');
    return heldPayment(id);
  };
}

/** A card that begins, holds the tap open behind the gate, then ends its job and answers the payment. */
function holding(order: string[], gate: Deferred<void>): Script {
  return async (t, _l, id) => {
    await t.begin?.('1');
    await gate.promise;
    order.push('card end');
    return heldPayment(id);
  };
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

it('a plain sale is PAID, and the PIN reaches only the library', async () => {
  const seen: string[] = [];
  const t = make([paying(seen)]);
  const tree = await firstRun(t.wiring);
  await toSheet(tree);
  expect(textOf(tree, 'sheet-total')).toBe('2,101 sats');
  await press(tree, 'sheet-pay');
  await until(tree, 'pin-title');
  await pinIn(tree, PIN);
  await untilText(tree, 'result-title', 'PAID');
  await flush();
  expect(textOf(tree, 'result-amount')).toBe('2,100 sats');
  expect(seen).toEqual([PIN]);
  expect(JSON.stringify(t.reports)).not.toContain(PIN);
  expect(t.logs.join('\n')).not.toContain(PIN);
  expect(
    t.reports.some(
      (r) =>
        r.sale !== null &&
        r.sale.outcome === 'paid' &&
        r.sale.paid !== null &&
        r.sale.paid.state === 'held',
    ),
  ).toBe(true);
});

it('PAID never shows before the payment is held', async () => {
  const gate = deferred<void>();
  const t = make([payingTaking(gate)]);
  const tree = await firstRun(t.wiring);
  await toSheet(tree);
  await press(tree, 'sheet-pay');
  await until(tree, 'pin-title');
  await pinIn(tree, PIN);
  await flush();
  expect(has(tree, 'result-title')).toBe(false);
  const words = allText(tree);
  expect(words).not.toContain('PAID');
  expect(words).not.toContain('PAYMENT RECEIVED');
  gate.resolve(undefined);
  await untilText(tree, 'result-title', 'CHECKING');
  expect(t.reports.some((r) => r.sale !== null && r.sale.outcome === 'paid')).toBe(false);
});

it('a signed error is never NOT PAID', async () => {
  const order: string[] = [];
  const t = make(
    [throwing(order, new CardError('interrupted', 'The card was taken away as it was signing.', { signed: true }))],
    order,
  );
  const tree = await firstRun(t.wiring);
  await charge(tree);
  await untilText(tree, 'result-title', 'TAP THE SAME CARD AGAIN');
  expect(has(tree, 'result-new')).toBe(false);
  expect(t.reports.some((r) => r.sale !== null && r.sale.outcome === 'not-paid')).toBe(false);

  const order2: string[] = [];
  const t2 = make(
    [
      throwing(
        order2,
        new CardError('payment-lost', 'NOT PAID: the mint says the pieces are spent.', { signed: true }),
      ),
    ],
    order2,
  );
  const tree2 = await firstRun(t2.wiring);
  await charge(tree2);
  await untilText(tree2, 'result-title', 'NOT PAID YET');
  expect(allText(tree2).some((s) => s.startsWith('NOT PAID:'))).toBe(false);
});

it('a tap dropped after the card signed is finished at the next tap', async () => {
  const seen: string[] = [];
  const order: string[] = [];
  const t = make(
    [
      throwing(order, new CardError('interrupted', 'The card was taken away as it was signing.', { signed: true })),
      recovering(seen),
    ],
    order,
  );
  const tree = await firstRun(t.wiring);
  await charge(tree);
  await untilText(tree, 'result-title', 'TAP THE SAME CARD AGAIN');
  await press(tree, 'result-retry');
  await until(tree, 'pin-title');
  expect(textOf(tree, 'pin-why')).toBe('The card needs its PIN to finish a payment it started.');
  await pinIn(tree, PIN);
  await untilText(tree, 'result-title', 'PAID');
  expect(t.handles.length).toBe(2);
  expect(t.handles[0].id).toBe(t.handles[1].id);
  expect(seen).toEqual([PIN]);
});

it('the customer paid another way: the sale is withdrawn only after the card job ended', async () => {
  const order: string[] = [];
  const t = make(
    [throwing(order, new CardError('interrupted', 'The card was taken away as it was signing.', { signed: true }))],
    order,
  );
  const tree = await firstRun(t.wiring);
  await charge(tree);
  await untilText(tree, 'result-title', 'TAP THE SAME CARD AGAIN');
  await press(tree, 'result-other-way');
  await until(tree, 'withdraw-warning');
  await press(tree, 'withdraw-yes');
  await untilText(tree, 'result-title', 'SALE WITHDRAWN');
  expect(t.closes).toEqual([{ id: t.handles[0].id, paid: false, running: 'close-sale' }]);
  expect(t.order).toEqual(['card end', 'close']);
  expect(has(tree, 'result-paid-twice')).toBe(false);
});

it('a sale already paid goes back to the card', async () => {
  const order: string[] = [];
  const t = make(
    [
      throwing(
        order,
        new CardError('same-sale', 'This sale was already paid.', {
          paymentId: 'pay:9',
          extra: 'paid-twice',
          signed: true,
        }),
      ),
    ],
    order,
  );
  const tree = await firstRun(t.wiring);
  await charge(tree);
  await untilText(tree, 'result-title', 'ALREADY PAID');
  expect(has(tree, 'result-new')).toBe(true);
});

it('not enough on the card is NOT PAID, and no sheet was shown', async () => {
  const order: string[] = [];
  const t = make(
    [
      throwing(
        order,
        new CardError(
          'not-enough',
          'The card holds 12 sats that this reader could check, and this needs 2101 with its fee.',
          { balance: 12 },
        ),
      ),
    ],
    order,
  );
  const tree = await firstRun(t.wiring);
  await charge(tree);
  await untilText(tree, 'result-title', 'NOT PAID');
  expect(textOf(tree, 'result-kind')).toBe('Not enough on the card');
  expect(t.reports.some((r) => r.sale !== null && r.sale.step === 'confirm')).toBe(false);
});

it('a settle asked during a tap waits for the tap', async () => {
  const gate = deferred<void>();
  const order: string[] = [];
  const t = make([holding(order, gate)], order);
  const tree = await firstRun(t.wiring);
  await charge(tree);
  await until(tree, 'tap-title');
  await flush();
  void t.service.withCard('settle', async () => {
    t.order.push('settle');
  });
  await flush();
  expect(t.order).toEqual([]);
  gate.resolve(undefined);
  await until(tree, 'result-title');
  await flush();
  expect(t.order).toEqual(['card end', 'settle']);
});

it('one card payment at a time', async () => {
  const gate = deferred<void>();
  let calls = 0;
  const script: Script = async (t, _l, id) => {
    calls += 1;
    await t.begin?.('1');
    await gate.promise;
    return heldPayment(id);
  };
  const t = make([script]);
  const tree = await firstRun(t.wiring);
  await charge(tree);
  await until(tree, 'tap-title');
  await flush();
  expect(t.service.queue.running()).toBe('card');
  expect(t.service.queue.waiting()).toBe(0);
  expect(calls).toBe(1);
  gate.resolve(undefined);
  await untilText(tree, 'result-title', 'PAID');
  expect(calls).toBe(1);
});

it('the PIN pad shows dots only', async () => {
  const seen: string[] = [];
  const t = make([paying(seen)]);
  const tree = await firstRun(t.wiring);
  await toSheet(tree);
  await press(tree, 'sheet-pay');
  await until(tree, 'pin-title');
  await press(tree, 'pin-key-9');
  await press(tree, 'pin-key-7');
  await press(tree, 'pin-key-5');
  expect(textOf(tree, 'pin-dots')).toBe('●●●');
  const words = allText(tree);
  expect(words).not.toContain('975');
  expect(words).not.toContain('9753');
});

it('a retry the card did not finish after it signed is never NOT PAID', async () => {
  const order: string[] = [];
  const t = make(
    [
      throwing(order, new CardError('interrupted', 'The card was taken away as it was signing.', { signed: true })),
      async () => {
        throw new CardError('stopped', 'Cancelled before a card was held to the phone. Nothing was taken.', { aborted: true });
      },
    ],
    order,
  );
  const tree = await firstRun(t.wiring);
  await charge(tree);
  await untilText(tree, 'result-title', 'TAP THE SAME CARD AGAIN');
  await press(tree, 'result-retry');
  await untilText(tree, 'result-message', 'Stopped. The card may already have signed this payment in an earlier tap.');
  expect(textOf(tree, 'result-title')).toBe('TAP THE SAME CARD AGAIN');
  expect(has(tree, 'result-new')).toBe(false);
  expect(has(tree, 'result-other-way')).toBe(true);
  expect(allText(tree).some((s) => /not paid|nothing was taken/i.test(s))).toBe(false);
  expect(t.reports.some((r) => r.sale !== null && r.sale.outcome === 'not-paid')).toBe(false);
  const shown = t.reports[t.reports.length - 1];
  expect(shown.sale).toMatchObject({ step: 'result', outcome: 'tap-again' });
  await act(async () => {
    (BackHandler as unknown as { mockPressBack(): void }).mockPressBack();
  });
  await flush();
  expect(has(tree, 'result-title')).toBe(true);
  expect(has(tree, 'home-title')).toBe(false);
});

it('a second payment refused while the sale waits for the card is withdrawn, never NOT PAID', async () => {
  const order: string[] = [];
  const t = make(
    [
      throwing(order, new CardError('interrupted', 'The card was taken away as it was signing.', { signed: true })),
      throwing(
        order,
        new CardError(
          'same-sale',
          'This sale has been paid already, or waits for a payment that may have been signed. Nothing was taken.',
        ),
      ),
    ],
    order,
  );
  const tree = await firstRun(t.wiring);
  await charge(tree);
  await untilText(tree, 'result-title', 'TAP THE SAME CARD AGAIN');
  await press(tree, 'result-retry');
  await untilText(
    tree,
    'result-message',
    'This sale waits for a payment a card may already have signed, so no second payment was begun.',
  );
  expect(has(tree, 'result-new')).toBe(false);
  expect(allText(tree).some((s) => /not paid|nothing was taken/i.test(s))).toBe(false);
  await press(tree, 'result-other-way');
  await until(tree, 'withdraw-warning');
  await press(tree, 'withdraw-yes');
  await untilText(tree, 'result-title', 'SALE WITHDRAWN');
  expect(t.closes.length).toBe(1);
  expect(t.closes[0].paid).toBe(false);
  expect(has(tree, 'result-new')).toBe(true);
});
