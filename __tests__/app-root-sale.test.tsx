jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/__mocks__/BackHandler'),
);

import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, BackHandler, Platform, type AppStateStatus } from 'react-native';
import { AppRoot } from '../src/app/AppRoot';
import { REPORT_KEYS, type AppReport, type AppWiring } from '../src/app/wiring';
import { parsePlan, PlanError } from '../src/lab/plan';
import { GATE_REASONS, type DeviceGate, type GateResult } from '../src/till/gate';
import { benchGate } from '../src/till/guarded';
import { noReader, type CardReader } from '../src/till/reader';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { flush, has, press, textOf, until, untilText } from './helpers/render';

const TEST_MINT = 'https://mint.test';
const back = BackHandler as unknown as { mockPressBack(): void; exitApp: jest.Mock };

type Gate = DeviceGate & { readonly asked: string[] };

/** Every service made here, so the last test can read every report they sent. */
const allReports: AppReport[][] = [];

function make(
  f = fakeStoreDeps(),
  mint = fakeMint(),
  gate: Gate = benchGate('allow'),
  reader: CardReader = noReader(),
) {
  const service = createTillService({
    store: f.deps,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: mint.http,
    now: () => 1000,
    log: () => undefined,
  });
  const reports: AppReport[] = [];
  const wiring: AppWiring = {
    mode: 'development',
    service,
    gate,
    reader,
    report: (r) => reports.push(r),
    devMintPreset: TEST_MINT,
    now: () => 1000,
  };
  allReports.push(reports);
  return { f, mint, gate, service, reports, wiring };
}

type Made = ReturnType<typeof make>;

/** The tree mounted last, for relaunch. */
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
  await press(tree, 'addmint-check');
  await untilText(tree, 'addmint-result', 'This mint can be used.');
  await press(tree, 'addmint-add');
  await until(tree, 'home-title');
  return tree;
}

/** The app quit and opened again over the same store: a new service and a new wiring. */
async function relaunch(t: Made, gate: Gate = benchGate('allow')): Promise<Made> {
  const tree = last;
  if (tree !== null) {
    await act(async () => {
      tree.unmount();
    });
    last = null;
  }
  await t.service.close();
  return make(t.f, t.mint, gate);
}

/** A reader whose tap never finds a card: begin never settles. */
function waitingReader(): CardReader {
  return {
    kind: 'card simulator',
    available: async () => true,
    transport: () => ({
      begin: () => new Promise<void>(() => undefined),
      transceive: async () => new Uint8Array([0x90, 0x00]),
    }),
  };
}

const lastReport = (t: Made): AppReport => t.reports[t.reports.length - 1];

beforeEach(() => {
  jest.mocked(AppState.addEventListener).mockImplementation(() => ({ remove: jest.fn() }));
});

afterEach(async () => {
  const tree = last;
  if (tree !== null) {
    await act(async () => {
      tree.unmount();
    });
    last = null;
  }
  back.exitApp.mockClear();
});

it('opens directly on Sell and switches between the merchant tabs', async () => {
  const t = make();
  const tree = await firstRun(t);
  await untilText(tree, 'sale-title', 'New sale');
  expect(textOf(tree, 'sale-mints')).toBe('Cards from: mint.test');
  await press(tree, 'home-owed');
  await until(tree, 'owed-title');
  await press(tree, 'home-wallet');
  await until(tree, 'wallet-title');
  expect(t.gate.asked).toContain(GATE_REASONS.wallet);
  await press(tree, 'home-activity');
  await until(tree, 'act-title');
  await act(async () => back.mockPressBack());
  await until(tree, 'sale-title');
});

it('opens balance directly from Sell and keeps saved top-ups and offline settings in Settings', async () => {
  const t = make();
  const tree = await firstRun(t);
  expect(has(tree, 'sale-card-actions')).toBe(false);
  expect(has(tree, 'sale-offline')).toBe(false);
  expect(has(tree, 'sale-topup')).toBe(false);
  await press(tree, 'key-6');
  await press(tree, 'sale-balance');
  await until(tree, 'balance-title');
  await press(tree, 'nav-back');
  expect(textOf(tree, 'sale-amount')).toBe('6 sats');
  await press(tree, 'home-settings');
  await press(tree, 'settings-topup-receipts');
  await untilText(tree, 'topup-title', 'Top-up receipts');
  expect(t.gate.asked).toContain(GATE_REASONS.records);
  expect(has(tree, 'topup-continue')).toBe(false);
  await press(tree, 'nav-back');
  await press(tree, 'settings-offline-settings');
  await until(tree, 'offline-settings-title');
});

it('Charge shows the Lightning invoice alongside PIN entry and takes the cashier back to the entered amount', async () => {
  const t = make();
  const tree = await firstRun(t);
  await press(tree, 'key-6');
  expect(has(tree, 'sale-phone-wallet')).toBe(false);
  const quote = {amount: 6, state: 'unpaid' as const, mint: TEST_MINT, invoice: 'lnbc60n1test', expiresAt: Date.now() + 60000, createdAt: Date.now(), paymentId: 'unit-test'};
  jest.spyOn(t.service, 'lightningOffer').mockImplementation(async saleId => ({...quote, saleId}));
  jest.spyOn(t.service, 'checkLightningSale').mockImplementation(async saleId => ({...quote, saleId}));
  await press(tree, 'sale-charge');
  await until(tree, 'lightning-request-qr');
  expect(has(tree, 'pin-key-1')).toBe(true);
  expect(has(tree, 'tap-title')).toBe(false);
  await press(tree, 'pin-cancel');
  expect(textOf(tree, 'sale-amount')).toBe('6 sats');
});

it('discards a late wallet approval after the cashier starts a sale', async () => {
  let approve!: (result: GateResult) => void;
  const gate = benchGate('allow');
  const t = make(fakeStoreDeps(), fakeMint(), gate, waitingReader());
  const tree = await firstRun(t);
  jest.spyOn(gate, 'check').mockImplementationOnce(() => new Promise(resolve => { approve = resolve; }));
  await press(tree, 'home-wallet');
  await press(tree, 'key-1');
  await press(tree, 'sale-charge');
  await until(tree, 'tap-title');
  await act(async () => approve({ ok: true }));
  expect(has(tree, 'wallet-title')).toBe(false);
  expect(has(tree, 'tap-title')).toBe(true);
});

it('a biometric sheet can finish in place, and backgrounding locks the wallet', async () => {
  const handlers = new Set<(s: AppStateStatus) => void>();
  const appState = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    const fn = listener as (s: AppStateStatus) => void;
    handlers.add(fn);
    return { remove: () => { handlers.delete(fn); } };
  });
  const change = (s: AppStateStatus) => act(async () => {
    for (const listener of [...handlers]) listener(s);
  });
  try {
    const gate = benchGate('allow');
    const t = make(fakeStoreDeps(), fakeMint(), gate);
    const tree = await firstRun(t);
    let approve!: (r: GateResult) => void;
    jest.spyOn(gate, 'check').mockImplementationOnce(() => new Promise(resolve => { approve = resolve; }));
    await press(tree, 'home-wallet');
    await change('inactive');
    await change('active');
    await act(async () => approve({ ok: true }));
    await until(tree, 'wallet-title');
    await change('background');
    await change('active');
    await until(tree, 'sale-title');
    expect(has(tree, 'wallet-title')).toBe(false);
    const asks = gate.asked.length;
    await press(tree, 'home-wallet');
    await until(tree, 'wallet-title');
    expect(gate.asked.slice(asks)).toEqual([GATE_REASONS.wallet]);
    await press(tree, 'home-settings');
    await until(tree, 'settings-title');
    jest.spyOn(gate, 'check').mockResolvedValueOnce({ ok: false, why: 'cancelled', words: 'Cancelled' });
    await press(tree, 'nav-back');
    await until(tree, 'sale-title');
    expect(has(tree, 'wallet-title')).toBe(false);
    expect(textOf(tree, 'home-note')).toBe('Cancelled');
  } finally { appState.mockRestore(); }
});

it.each([true, false])('keeps Android’s withdrawal confirmation in place through its credential Activity (approved=%s)', async approved => {
  const platform = jest.replaceProperty(Platform, 'OS', 'android');
  const initialState = AppState.currentState;
  AppState.currentState = 'active';
  const handlers = new Set<(s: AppStateStatus) => void>();
  const subscription = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    const fn = listener as (s: AppStateStatus) => void;
    handlers.add(fn);
    return { remove: () => { handlers.delete(fn); } };
  });
  try {
    const t = make();
    const tree = await firstRun(t);
    const api = t.service.lightning!;
    const quote = {
      id: 'example', amount: 4, maxFee: 1, address: 'owner@example.test',
      status: 'quoted' as const, automatic: false, expiresAt: Date.now() + 60_000,
    };
    jest.spyOn(api, 'state').mockResolvedValue({ policy: null, payment: quote });
    const sent = jest.spyOn(api, 'confirm').mockResolvedValue({ ...quote, status: 'pending' });
    await press(tree, 'home-wallet');
    const walletEntry = 'wallet-lightning-' + (await t.service.walletBalances())[0].mint + '/sat';
    await until(tree, walletEntry);
    await press(tree, walletEntry);
    await until(tree, 'lightning-send');
    let decide!: (r: GateResult) => void;
    jest.spyOn(t.gate, 'check').mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    await press(tree, 'lightning-send');
    await until(tree, 'lightning-verifying');
    await act(async () => {
      for (const handler of [...handlers]) handler('background');
      for (const handler of [...handlers]) handler('active');
      decide(approved ? { ok: true } : { ok: false, why: 'cancelled', words: 'Cancelled' });
    });
    expect(sent).toHaveBeenCalledTimes(approved ? 1 : 0);
    await until(tree, approved ? 'lightning-title' : 'sale-title');
  } finally {
    subscription.mockRestore();
    platform.restore();
    AppState.currentState = initialState;
  }
});

it('the report carries the sale only while it is shown', async () => {
  const t = make();
  const tree = await firstRun(t);
  await press(tree, 'home-sale');
  await until(tree, 'sale-title');
  await flush();
  const onSale = lastReport(t);
  expect(onSale.screen).toBe('sale');
  expect(onSale.sale === null ? null : onSale.sale.step).toBe('keypad');
  expect(onSale.sale === null ? null : onSale.sale.sats).toBe(0);

  await press(tree, 'key-1');
  await flush();
  expect(t.reports.some((r) => r.sale !== null && r.sale.sats === 1)).toBe(true);

  await press(tree, 'home-activity');
  await until(tree, 'act-title');
  await flush();
  const home = lastReport(t);
  expect(home.screen).toBe('activity');
  expect(home.sale).toBeNull();
});

it('a phone with no reader is told so, and nothing is taken', async () => {
  const t = make();
  const tree = await firstRun(t);
  await press(tree, 'home-sale');
  await until(tree, 'sale-title');
  await press(tree, 'key-1');
  await press(tree, 'key-4');
  await press(tree, 'sale-charge');
  await until(tree, 'checkout-qr-panel');
  for (const digit of ['1','2','3','4']) await press(tree, 'pin-key-' + digit);
  await press(tree, 'pin-ok');
  await untilText(tree, 'result-title', 'NOT PAID');
  expect(textOf(tree, 'result-kind')).toBe('No card reader');
  expect(
    t.reports.some(
      (r) => r.sale !== null && r.sale.outcome === 'not-paid' && r.sale.errorKind === 'no-reader',
    ),
  ).toBe(true);
});

it('the reports carry only what the screen shows', () => {
  const all: AppReport[] = [];
  for (const list of allReports) {
    all.push(...list);
  }
  expect(all.length).toBeGreaterThan(0);
  for (const r of all) {
    expect(Object.keys(r).sort()).toEqual([...REPORT_KEYS].sort());
  }
  const text = JSON.stringify(all);
  expect(/[0-9a-f]{64}/.test(text)).toBe(false);
  expect(text.includes('cashu')).toBe(false);
});

it("an app plan may switch the card's faults on", () => {
  expect(parsePlan({ mode: 'app', app: { gate: 'bench-allow', card: { absentTaps: 1 } } })).toEqual({
    mode: 'app',
    app: { gate: 'bench-allow', card: { absentTaps: 1, dropSigns: 0 } },
  });

  expect(() => parsePlan({ mode: 'app', app: { card: 'x' } })).toThrow(PlanError);
  expect(() => parsePlan({ mode: 'app', app: { card: 'x' } })).toThrow(/card is an object/);

  expect(() => parsePlan({ mode: 'app', app: { card: { dropSigns: -1 } } })).toThrow(
    /a card switch is a whole number/,
  );
  expect(() => parsePlan({ mode: 'app', app: { card: { absentTaps: 1.5 } } })).toThrow(
    /a card switch is a whole number/,
  );

  const plain = parsePlan({ mode: 'app' });
  expect(plain.mode === 'app' && 'card' in plain.app).toBe(false);

  expect(parsePlan({ mode: 'app', app: { card: { dropSigns: 2 } } })).toEqual({
    mode: 'app',
    app: { gate: 'device', card: { absentTaps: 0, dropSigns: 2 } },
  });
});

it("Android's back stays on a sale being taken, and leaves it once nothing is pending", async () => {
  const t = make(fakeStoreDeps(), fakeMint(), benchGate('allow'), waitingReader());
  const tree = await firstRun(t);
  await until(tree, 'sale-title');
  await press(tree, 'key-1');
  await press(tree, 'key-4');
  await press(tree, 'sale-charge');
  await untilText(tree, 'tap-line', 'Waiting for a card');
  await act(async () => {
    back.mockPressBack();
  });
  await flush();
  expect(has(tree, 'tap-title')).toBe(true);
  expect(has(tree, 'home-settings')).toBe(false);
  expect(has(tree, 'home-wallet')).toBe(false);
  expect(has(tree, 'home-title')).toBe(false);
  expect(back.exitApp).not.toHaveBeenCalled();

  await press(tree, 'tap-cancel');
  await untilText(tree, 'result-kind', 'Cancelled');
  await act(async () => {
    back.mockPressBack();
  });
  await until(tree, 'home-title');
});
