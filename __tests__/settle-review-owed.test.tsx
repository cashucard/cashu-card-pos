/* Three tests the review of slice 1.3 found missing (carried into slice 1.4): the amount is on CHECKING before any
 * settle; a card job that itself answers a payment still being taken shows CHECKING, never PAID; and Home's line for
 * money owed to cards of a mint the till no longer takes is read again at once when a check-again refuses that mint,
 * not only at the next settle. The real AppRoot, the real till service over a fake store and a fake mint, and the real
 * library, with its settle and the card scripted. */

jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/__mocks__/BackHandler'),
);

import { CardError, open, type CardListener, type CardTransport, type CashuCard, type Payment } from 'cashucard';
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AppRoot } from '../src/app/AppRoot';
import type { AppWiring } from '../src/app/wiring';
import { benchGate } from '../src/till/guarded';
import { createTillService } from '../src/till/service';
import type { ScheduleSource } from '../src/till/settle';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { fakeTransport, heldPayment } from './helpers/fake-till';
import { allText, flush, has, textOf, until, untilText, press } from './helpers/render';

type Script = (t: CardTransport, l: CardListener, id: string) => Promise<Payment>;
type Step = (k: CashuCard) => Promise<Payment[]>;

const TEST_MINT = 'https://mint.test';
const LISTED_50 =
  'Owed to cards from mint.test: 50 sats. This mint is paused for sales. Open Owed to cards and scan the original card. A return may have to wait for the mint.';

/** The schedule's ear, always in front, and its timers, which only the test fires. */
function source(): ScheduleSource {
  return {
    active: () => true,
    onActive: () => () => undefined,
    timers: { set: () => ({}), clear: () => undefined },
  };
}

/** The whole app over fakes: settle answers the next of `steps` ([] when none) and counts in `settles`; a sale's card
 * answers the next of `scripts`; payments() answers o.payments when given. */
function make(o: { payments?: () => Payment[] } = {}) {
  const f = fakeStoreDeps();
  const mint = fakeMint();
  const scripts: Script[] = [];
  const steps: Step[] = [];
  const counts = { settles: 0 };
  const service = createTillService({
    store: f.deps,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: mint.http,
    now: () => 1000,
    random: () => 0.25,
    log: () => undefined,
    openLibrary: async (cfg) => {
      const k = await open(cfg);
      k.settle = async () => {
        counts.settles += 1;
        const next = steps.shift();
        return next === undefined ? [] : next(k);
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
    report: () => undefined,
    devMintPreset: TEST_MINT,
    now: () => 1000,
    schedule: source(),
  };
  return { service, mint, scripts, steps, counts, wiring };
}

let last: ReactTestRenderer | null = null;

async function firstRun(w: AppWiring): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<AppRoot wiring={w} />);
  });
  last = tree;
  await until(tree, 'firstrun-title');
  await press(tree, 'firstrun-dev-mint');
  await until(tree, 'addmint-title');
  await press(tree, 'addmint-check');
  await untilText(tree, 'addmint-result', 'This mint can be used.');
  await press(tree, 'addmint-add');
  await until(tree, 'home-title');
  return tree;
}

async function sell(tree: ReactTestRenderer): Promise<void> {
  await press(tree, 'home-sale');
  await press(tree, 'key-1');
  await press(tree, 'key-4');
  await press(tree, 'sale-charge');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

it('the amount is shown on CHECKING before any settle', async () => {
  const t = make();
  const tree = await firstRun(t.wiring);
  t.scripts.push(async (tr) => {
    await tr.begin?.('1');
    throw new CardError(
      'swap-lost',
      "The card's mint has not taken the payment yet (503). It is kept, and tried again by settle; do not take another payment for this sale.",
      { signed: true, entry: 'pay:00' },
    );
  });
  const before = t.counts.settles;
  await sell(tree);
  await untilText(tree, 'result-title', 'CHECKING');
  expect(textOf(tree, 'result-amount')).toBe('14 sats');
  await flush();
  expect(textOf(tree, 'result-title')).toBe('CHECKING');
  expect(textOf(tree, 'result-amount')).toBe('14 sats');
  // the settle after the card job answered nothing: the amount was there without any settle holding the payment
  expect(t.counts.settles).toBe(before + 1);
});

it('a card job that itself answers a payment still being taken shows CHECKING, never PAID', async () => {
  const gate = deferred();
  const t = make();
  const tree = await firstRun(t.wiring);
  t.scripts.push(async (tr, _l, id) => {
    await tr.begin?.('1');
    await gate.promise;
    return { ...heldPayment(id), state: 'taking' };
  });
  await sell(tree);
  await until(tree, 'tap-title');
  await flush();
  expect(has(tree, 'result-title')).toBe(false);
  expect(allText(tree)).not.toContain('PAID');
  gate.resolve();
  await untilText(tree, 'result-title', 'CHECKING');
  expect(textOf(tree, 'result-amount')).toBe('14 sats');
  expect(allText(tree)).not.toContain('PAID');
  await flush();
  expect(textOf(tree, 'result-title')).toBe('CHECKING');
  expect(allText(tree)).not.toContain('PAID');
});

it("Home reads the record again when a check-again refuses a mint whose cards are owed money, before any settle", async () => {
  const t = make({ payments: () => [{ ...heldPayment('s1'), owedToCard: 50 }] });
  const tree = await firstRun(t.wiring);
  await flush();
  // the mint is taken: what its card is owed is given back at the card's next tap, so Home says nothing of it
  expect(has(tree, 'home-owed-0')).toBe(false);
  const settles = t.counts.settles;
  // the mint's keysets change and fail the check: the till stops taking it
  t.mint.set({ generation: 1, fee: 5000 });
  await act(async () => {
    await t.service.recheckMints();
  });
  expect(t.service.mints()[0].status).toBe('refused');
  await untilText(tree, 'home-owed-0', LISTED_50);
  // no settle ran in between: the line came from the change of the mints
  expect(t.counts.settles).toBe(settles);
});
