import React from 'react';
import { Platform } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AppRoot } from '../src/app/AppRoot';
import { REPORT_KEYS, type AppReport, type AppWiring } from '../src/app/wiring';
import { GATE_REASONS, type DeviceGate } from '../src/till/gate';
import { benchGate } from '../src/till/guarded';
import { noReader } from '../src/till/reader';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import {
  has,
  isDisabled,
  nodes,
  press,
  textOf,
  typeInto,
  until,
  untilText,
} from './helpers/render';

const PATH = '/app/till/till.db';
const TEST_MINT = 'https://mint.test';

type Gate = DeviceGate & { readonly asked: string[] };

/** Every service made here, so the last test can read every report they sent. */
const allReports: AppReport[][] = [];

function make(f = fakeStoreDeps(), mint = fakeMint(), gate: Gate = benchGate('allow')) {
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
    reader: noReader(),
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
  expect(nodes(tree, 'addmint-url')[0].props.value).toBe(TEST_MINT);
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

/** A relaunch of the first run, with the record's file deleted. */
async function missing(t: Made, gate: Gate = benchGate('allow')): Promise<{ u: Made; tree: ReactTestRenderer }> {
  const u = await relaunch(t, gate);
  u.f.disk.files.delete(PATH);
  const tree = await mount(u.wiring);
  await untilText(tree, 'store-title', "This phone's payment record is missing");
  return { u, tree };
}

/** From the store's words to the confirm screen, with the phrase typed and the device check asked. */
async function startNew(tree: ReactTestRenderer): Promise<void> {
  await press(tree, 'store-offer-start-new');
  await until(tree, 'confirm-title');
  expect(isDisabled(tree, 'confirm-go')).toBe(true);
  await typeInto(tree, 'confirm-input', 'start new');
  await press(tree, 'confirm-go');
}

it('a first run shows the Welcome, and the test mint is checked and added', async () => {
  const t = make();
  const tree = await firstRun(t);
  expect(textOf(tree, 'sale-mints')).toBe('Cards from: mint.test');
  expect(t.gate.asked).toEqual([GATE_REASONS.mints]);
});

it('a relaunch opens straight to the till with its mint', async () => {
  const t = make();
  await firstRun(t);
  const u = await relaunch(t);
  const tree = await mount(u.wiring);
  await until(tree, 'home-title');
  expect(u.reports.some((r) => r.screen === 'first-run')).toBe(false);
  expect(u.reports[u.reports.length - 1]).toEqual({
    at: 1000,
    boot: 'ready',
    store: null,
    screen: 'sale',
    firstRun: false,
    mints: [{ url: TEST_MINT, status: 'ok' }],
    gate: null,
    note: null,
    sale: expect.objectContaining({ step: 'keypad', sats: 0 }),
  });
});

it("a missing record shows the store's words, and Not now closes the till", async () => {
  const t = make();
  await firstRun(t);
  const { u, tree } = await missing(t);
  expect(has(tree, 'store-offer-start-new')).toBe(true);
  expect(u.f.disk.files.has(PATH)).toBe(false);
  expect(u.reports.some((r) => r.boot === 'problem' && r.store === 'journal-missing')).toBe(true);
  await press(tree, 'store-offer-not-now');
  await until(tree, 'closed-title');
  await press(tree, 'closed-again');
  await until(tree, 'store-title');
  expect(u.f.disk.files.has(PATH)).toBe(false);
});

it('a new record is started only after the phrase and the device check', async () => {
  const t = make();
  await firstRun(t);
  const { u, tree } = await missing(t);
  await startNew(tree);
  await until(tree, 'home-title');
  expect(u.gate.asked).toContain(GATE_REASONS['start-new']);
  expect(u.f.disk.files.has(PATH)).toBe(true);
  expect(textOf(tree, 'sale-mints')).toBe('Cards from: mint.test');
});

it('a refused device check starts nothing', async () => {
  const t = make();
  await firstRun(t);
  const { u, tree } = await missing(t, benchGate('deny'));
  await startNew(tree);
  await untilText(tree, 'confirm-error', 'Not confirmed. Nothing was changed.');
  expect(u.f.disk.files.has(PATH)).toBe(false);
  expect(u.reports.some((r) => r.gate === 'refused')).toBe(true);
});

it('the mints are behind the device check', async () => {
  const t = make();
  await firstRun(t);

  const denied = await relaunch(t, benchGate('deny'));
  const first = await mount(denied.wiring);
  await until(first, 'home-title');
  await press(first, 'home-settings');
  await until(first, 'settings-title');
  await untilText(
    first,
    'settings-gate',
    "Changing mints, records and the wallet asks for this phone's passcode, Face ID or fingerprint.",
  );
  await press(first, 'settings-mints');
  await untilText(first, 'settings-note', 'Not confirmed. Nothing was changed.');
  expect(has(first, 'mints-title')).toBe(false);

  const allowed = await relaunch(denied);
  const second = await mount(allowed.wiring);
  await until(second, 'home-title');
  await press(second, 'home-settings');
  await until(second, 'settings-title');
  await press(second, 'settings-mints');
  await until(second, 'mints-title');
  expect(textOf(second, 'mint-row-0')).toBe(TEST_MINT);
  await press(second, 'nav-back');
  await until(second, 'settings-title');
});

it.each([['ios', 'button'], ['android', 'tab']] as const)(
  'identifies the active and available merchant tabs to screen readers on %s',
  async (os, role) => {
    const platform = jest.replaceProperty(Platform, 'OS', os);
    try {
      const tree = await firstRun(make());
      const labels = { sale: 'Sell', activity: 'Activity', wallet: 'Wallet', owed: 'Owed to cards' };
      for (const [tab, label] of Object.entries(labels)) {
        expect(nodes(tree, 'home-' + tab)[0].props).toMatchObject({
          accessibilityRole: role, accessibilityLabel: label, accessibilityState: { selected: tab === 'sale' },
        });
      }
      await press(tree, 'home-activity');
      await until(tree, 'act-title');
      expect(nodes(tree, 'home-activity')[0].props.accessibilityState.selected).toBe(true);
      expect(nodes(tree, 'home-sale')[0].props.accessibilityState.selected).toBe(false);
    } finally {
      platform.restore();
    }
  },
);

it('the merchant wallet opens behind the device check, and back comes home', async () => {
  const t = make();
  const tree = await firstRun(t);
  await press(tree, 'home-wallet');
  await untilText(tree, 'wallet-title', 'Wallet');
  expect(t.gate.asked[t.gate.asked.length - 1]).toBe(GATE_REASONS.wallet);
  await press(tree, 'home-sale');
  await until(tree, 'home-title');
});

it('opens card returns from Settings, and back returns to Settings', async () => {
  const t = make();
  const tree = await firstRun(t);
  await press(tree, 'home-settings');
  await until(tree, 'settings-title');
  await press(tree, 'settings-owed');
  await until(tree, 'owed-title');
  await press(tree, 'nav-back');
  await until(tree, 'settings-title');
});

it('the activity shows the record, and back comes home', async () => {
  const t = make();
  const tree = await firstRun(t);
  await press(tree, 'home-activity');
  await untilText(tree, 'act-title', 'Activity');
  await untilText(tree, 'act-payments-none', 'None.');
  await press(tree, 'home-sale');
  await until(tree, 'home-title');
});

it('about tells the build and the reader', async () => {
  const t = make();
  const tree = await firstRun(t);
  await press(tree, 'home-settings');
  await until(tree, 'settings-title');
  await press(tree, 'settings-about');
  await until(tree, 'about-title');
  expect(textOf(tree, 'about-app')).toBe('Cashu Card POS Version unavailable (development build)');
  expect(textOf(tree, 'about-reader')).toBe('Card reader: none in this version');
});

it('a till that cannot read its secure store offers to try again', async () => {
  const t = make();
  t.f.secure.failGet.add('*');
  const tree = await mount(t.wiring);
  await untilText(tree, 'store-title', 'Unlock the phone, then try again');
  t.f.secure.failGet.clear();
  await press(tree, 'store-offer-try-again');
  await until(tree, 'firstrun-title');
});

it('adding a mint from the Mints screen comes back to it', async () => {
  const t = make();
  const tree = await firstRun(t);
  await press(tree, 'home-settings');
  await until(tree, 'settings-title');
  await press(tree, 'settings-mints');
  await until(tree, 'mints-title');
  await press(tree, 'mints-add');
  await until(tree, 'addmint-title');
  expect(nodes(tree, 'addmint-url')[0].props.value).toBe('');
  await typeInto(tree, 'addmint-url', 'mint.test');
  await press(tree, 'addmint-check');
  await untilText(tree, 'addmint-result', 'This mint can be used.');
  await press(tree, 'addmint-add');
  await until(tree, 'mints-title');
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

it('shows the backup picker on a fresh till before a mint is added', async () => {
  const t = make();
  const tree = await mount(t.wiring);
  await until(tree, 'firstrun-restore');
  await press(tree, 'firstrun-restore');
  await until(tree, 'backup-choose');
  expect(t.service.mints()).toEqual([]);
  expect(has(tree,'backup-finish')).toBe(false);
  await press(tree,'nav-back');
  expect(has(tree,'firstrun-add')).toBe(true);
});
