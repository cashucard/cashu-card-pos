jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/__mocks__/BackHandler'),
);

import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { BackHandler } from 'react-native';
import type { HttpFetch } from 'cashucard';
import { AppRoot } from '../src/app/AppRoot';
import type { AppReport, AppWiring } from '../src/app/wiring';
import { CLOSED_WORDS } from '../src/screens/BootScreens';
import { FIRSTRUN_LOST, FIRSTRUN_USED } from '../src/screens/FirstRunScreen';
import { GATE_WORDS, type DeviceGate, type GateResult } from '../src/till/gate';
import { benchGate } from '../src/till/guarded';
import { noReader } from '../src/till/reader';
import { createTillService, SETTINGS_LOST } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint, type FakeMint } from './helpers/fake-mint';
import { fakeStoreDeps, type FakeStore } from './helpers/fake-store';
import { has, nodes, press, textOf, until, untilText } from './helpers/render';

const PATH = '/app/till/till.db';
const TEST_MINT = 'https://mint.test';
const back = BackHandler as unknown as { mockPressBack(): void; exitApp: jest.Mock };
const mounted: ReactTestRenderer[] = [];

function make(f: FakeStore = fakeStoreDeps(), http: HttpFetch = fakeMint().http, gate: DeviceGate = benchGate('allow')) {
  const service = createTillService({
    store: f.deps, names: TILL_NAMES, settingsNames: TILL_SETTINGS, http, now: () => 1000, log: () => undefined,
  });
  const reports: AppReport[] = [];
  const wiring: AppWiring = {
    mode: 'development', service, gate, reader: noReader(), report: (r) => reports.push(r),
    devMintPreset: TEST_MINT, now: () => 1000,
  };
  return { f, service, reports, wiring };
}

async function mount(w: AppWiring): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<AppRoot wiring={w} />);
  });
  mounted.push(tree);
  return tree;
}

/** Unmounts every tree and closes its service: a relaunch over the same store. */
async function quit(t: ReturnType<typeof make>): Promise<void> {
  for (const tree of mounted.splice(0)) {
    await act(async () => {
      tree.unmount();
    });
  }
  await t.service.close();
}

/** On the Welcome: the test mint checked and added, then the till. */
async function addTestMint(tree: ReactTestRenderer): Promise<void> {
  await press(tree, 'firstrun-dev-mint');
  await until(tree, 'addmint-title');
  await press(tree, 'addmint-check');
  await untilText(tree, 'addmint-result', 'This mint can be used.');
  await press(tree, 'addmint-add');
}

/** A gate that answers each check in turn: true passes, false is a cancel. */
function turnGate(answers: boolean[]): DeviceGate {
  return {
    available: async () => true,
    check: async (): Promise<GateResult> =>
      answers.shift() === true ? { ok: true } : { ok: false, why: 'cancelled', words: GATE_WORDS.cancelled },
  };
}

/** A mint's http whose next ask starting with `path` waits until release(). */
function holdable(mint: FakeMint) {
  let path: string | null = null;
  const waiting: Array<() => void> = [];
  const http: HttpFetch = async (url, init) => {
    if (path !== null && url.startsWith(TEST_MINT + path)) {
      path = null;
      await new Promise<void>((r) => {
        waiting.push(r);
      });
    }
    return mint.http(url, init);
  };
  return {
    http,
    hold(p: string): void {
      path = p;
    },
    held: (): number => waiting.length,
    release(): void {
      for (const r of waiting.splice(0)) {
        r();
      }
    },
  };
}

const last = (t: ReturnType<typeof make>): AppReport => t.reports[t.reports.length - 1];

afterEach(async () => {
  for (const tree of mounted.splice(0)) {
    await act(async () => {
      tree.unmount();
    });
  }
  back.exitApp.mockClear();
});

it('a lost list of mints is told on the Welcome, and stays told on the till', async () => {
  const f = fakeStoreDeps();
  f.secure.items.set(TILL_SETTINGS.a, 'x');
  const t = make(f);
  const tree = await mount(t.wiring);
  await until(tree, 'firstrun-title');
  expect(textOf(tree, 'firstrun-note')).toBe(FIRSTRUN_LOST);
  expect(t.reports.some((r) => r.screen === 'first-run' && r.note === FIRSTRUN_LOST)).toBe(true);
  await addTestMint(tree);
  await until(tree, 'home-title');
  expect(textOf(tree, 'home-note')).toBe(SETTINGS_LOST);
  expect(last(t).note).toBe(SETTINGS_LOST);
});

it('a Welcome with nothing lost says nothing of it', async () => {
  const t = make();
  const tree = await mount(t.wiring);
  await until(tree, 'firstrun-title');
  expect(has(tree, 'firstrun-note')).toBe(false);
  expect(has(tree, 'firstrun-open')).toBe(false);
  expect(last(t).note).toBeNull();
});

it('a till opened before, with no mint, says so on the Welcome', async () => {
  const f = fakeStoreDeps();
  const t = make(f);
  const first = await mount(t.wiring);
  await until(first, 'firstrun-title');
  expect(has(first, 'firstrun-note')).toBe(false);
  await quit(t);

  const u = make(f);
  const tree = await mount(u.wiring);
  await until(tree, 'firstrun-title');
  expect(textOf(tree, 'firstrun-note')).toBe(FIRSTRUN_USED);
  const r = last(u);
  expect(r.note).toBe(FIRSTRUN_USED);
  expect(r.screen).toBe('first-run');
  expect(r.firstRun).toBe(false);
  await press(tree, 'firstrun-open');
  await until(tree, 'home-title');
  await press(tree, 'home-settings');
  await until(tree, 'settings-title');
  await press(tree, 'settings-owed');
  await until(tree, 'owed-title');
});

it('the owner check of an add reaches the report', async () => {
  const t = make();
  const tree = await mount(t.wiring);
  await until(tree, 'firstrun-title');
  await addTestMint(tree);
  await until(tree, 'home-title');
  expect(last(t).gate).toBe('passed');

  const u = make(fakeStoreDeps(), fakeMint().http, benchGate('deny'));
  const treeU = await mount(u.wiring);
  await until(treeU, 'firstrun-title');
  await addTestMint(treeU);
  await untilText(treeU, 'addmint-note', 'Not confirmed. Nothing was changed.');
  expect(last(u).gate).toBe('refused');
});

it('the owner check of a removal reaches the report', async () => {
  const f = fakeStoreDeps();
  const m = fakeMint();
  const t = make(f, m.http);
  const first = await mount(t.wiring);
  await until(first, 'firstrun-title');
  await addTestMint(first);
  await until(first, 'home-title');
  await quit(t);

  const u = make(f, m.http, turnGate([true, false]));
  const tree = await mount(u.wiring);
  await until(tree, 'home-title');
  await press(tree, 'home-settings');
  await until(tree, 'settings-title');
  await press(tree, 'settings-mints');
  await until(tree, 'mints-title');
  expect(last(u).gate).toBe('passed');
  await press(tree, 'mint-remove-0');
  await press(tree, 'mint-remove-yes');
  await untilText(tree, 'mints-note', 'Not confirmed. Nothing was changed.');
  expect(last(u).gate).toBe('refused');
  expect(has(tree, 'mint-row-0')).toBe(true);
});

it('the Mints screen shows a check-again that finishes while it is open', async () => {
  const f = fakeStoreDeps();
  const m = fakeMint();
  const t = make(f, m.http);
  const first = await mount(t.wiring);
  await until(first, 'firstrun-title');
  await addTestMint(first);
  await until(first, 'home-title');
  await quit(t);

  m.set({ generation: 1, fee: 5000 });
  const h = holdable(m);
  h.hold('/v1/keys/');
  const u = make(f, h.http);
  const tree = await mount(u.wiring);
  await until(tree, 'home-title');
  await press(tree, 'home-settings');
  await press(tree, 'settings-mints');
  await until(tree, 'mints-title');
  for (let i = 0; i < 100 && h.held() !== 1; i += 1) {
    await act(async () => {
      await new Promise<void>((r) => {
        setTimeout(() => r(), 0);
      });
    });
  }
  expect(h.held()).toBe(1);
  expect(textOf(tree, 'mint-status-0').startsWith('Taking cards from this mint.')).toBe(true);
  h.release();
  await untilText(
    tree,
    'mint-status-0',
    'Not taking cards from this mint: Its fee is 5,000 ppk. This till takes at most 1,000. Check it again once the mint has fixed it.',
  );
});

it('a check-again from the Mints screen says when it ran', async () => {
  const f = fakeStoreDeps();
  const m = fakeMint();
  const t = make(f, m.http);
  const first = await mount(t.wiring);
  await until(first, 'firstrun-title');
  await addTestMint(first);
  await until(first, 'home-title');
  await quit(t);

  const u = make(f, m.http);
  const tree = await mount(u.wiring);
  await until(tree, 'home-title');
  await press(tree, 'home-settings');
  await press(tree, 'settings-mints');
  await until(tree, 'mints-title');
  await press(tree, 'mints-recheck');
  await until(tree, 'mints-checked');
  expect(textOf(tree, 'mints-checked')).toMatch(/^Checked all again on .+\. Nothing has changed\.$/);
});

it('the closed screen of unsafe storage has its own words', async () => {
  const f = fakeStoreDeps();
  f.secure.items.set(TILL_NAMES.genA, 'x');
  const t = make(f);
  const tree = await mount(t.wiring);
  await until(tree, 'store-title');
  await press(tree, 'store-offer-not-now');
  await until(tree, 'closed-title');
  expect(textOf(tree, 'closed-body')).toBe(CLOSED_WORDS['store-refused'].body);
  expect(nodes(tree, 'closed-again')[0].props.label).toBe('Check again');
});

it("Android's back leaves the confirm screen for the store's words", async () => {
  const f = fakeStoreDeps();
  const t = make(f);
  const first = await mount(t.wiring);
  await until(first, 'firstrun-title');
  await quit(t);
  f.disk.files.delete(PATH);
  const u = make(f);
  const tree = await mount(u.wiring);
  await untilText(tree, 'store-title', "This phone's payment record is missing");
  await press(tree, 'store-offer-start-new');
  await until(tree, 'confirm-title');
  await act(async () => {
    back.mockPressBack();
  });
  await until(tree, 'store-title');
  expect(has(tree, 'confirm-title')).toBe(false);
  expect(back.exitApp).not.toHaveBeenCalled();
  expect(f.disk.files.has(PATH)).toBe(false);
});

it("Android's back goes back in the till, and at its root leaves to the phone", async () => {
  const t = make();
  const tree = await mount(t.wiring);
  await until(tree, 'firstrun-title');
  await addTestMint(tree);
  await until(tree, 'home-title');
  await press(tree, 'home-settings');
  await until(tree, 'settings-title');
  await act(async () => {
    back.mockPressBack();
  });
  await until(tree, 'home-title');
  expect(back.exitApp).not.toHaveBeenCalled();
  await act(async () => {
    back.mockPressBack();
  });
  expect(back.exitApp).toHaveBeenCalledTimes(1);
  expect(has(tree, 'home-title')).toBe(true);
});
