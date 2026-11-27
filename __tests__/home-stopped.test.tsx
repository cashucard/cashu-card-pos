/* Home says that new sales are stopped, and New sale is disabled while it holds (slice 2.4, ENG-909 b). The screen
 * alone first; then the app over the real till, the real library cashucard 0.3.0 and a secure store that refuses the
 * generation's sets. */

import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AppRoot } from '../src/app/AppRoot';
import type { AppWiring } from '../src/app/wiring';
import { TillNotices } from '../src/screens/HomeScreen';
import { SALES_STOPPED } from '../src/till/card-errors';
import { benchGate } from '../src/till/guarded';
import { noReader } from '../src/till/reader';
import { createTillService, type TillService } from '../src/till/service';
import type { MintEntry } from '../src/till/settings';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps, type FakeStore } from './helpers/fake-store';
import { flush, has, isDisabled, press, textOf, until, untilText } from './helpers/render';

const OK: MintEntry = { url: 'https://mint.test', addedAt: 1, checkedAt: 1, keysets: ['00'], status: 'ok', why: null };

describe('Home', () => {
  function home(stopped: boolean | undefined): ReactTestRenderer {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(<TillNotices mints={[OK]} note={null} onOpenOwed={jest.fn()} stopped={stopped} />);
    });
    return tree;
  }

  it('says that new sales are stopped, in the words given, and New sale is disabled', () => {
    const tree = home(true);
    expect(textOf(tree, 'home-stopped')).toBe(
      "New sales are stopped. This phone did not save the record's safety counter. Payments already taken are kept and settled. Close the app and open it again; if this stays, restart the phone.",
    );
    expect(textOf(tree, 'home-stopped')).toBe(SALES_STOPPED);
  });

  it('says nothing of it otherwise, and New sale may be pressed', () => {
    for (const s of [false, undefined]) {
      const tree = home(s);
      expect(has(tree, 'home-stopped')).toBe(false);

    }
  });
});

describe('the app over the real till', () => {
  function make(f: FakeStore = fakeStoreDeps()): { f: FakeStore; service: TillService; wiring: AppWiring } {
    let now = 1000;
    const service = createTillService({
      store: f.deps, names: TILL_NAMES, settingsNames: TILL_SETTINGS, http: fakeMint().http, now: () => (now += 1000),
      log: () => undefined,
    });
    const wiring: AppWiring = {
      mode: 'development', service, gate: benchGate('allow'), reader: noReader(), report: () => undefined,
      devMintPreset: 'https://mint.test', now: () => 1000,
    };
    return { f, service, wiring };
  }

  async function mount(w: AppWiring): Promise<ReactTestRenderer> {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<AppRoot wiring={w} />);
    });
    return tree;
  }

  function refuse(f: FakeStore): void {
    f.secure.failSet.add(TILL_NAMES.genA);
    f.secure.failSet.add(TILL_NAMES.genB);
  }

  it('Home follows the till: stopped at the first refused generation, taken again at the next one kept, and stopped from the launch when the launch is refused', async () => {
    const t = make();
    const tree = await mount(t.wiring);
    await until(tree, 'firstrun-title');
    await press(tree, 'firstrun-dev-mint');
    await until(tree, 'addmint-title');
    await press(tree, 'addmint-check');
    await untilText(tree, 'addmint-result', 'This mint can be used.');
    await press(tree, 'addmint-add');
    await until(tree, 'home-title');
    await flush();
    expect(has(tree, 'home-stopped')).toBe(false);
    await press(tree, 'key-1');
    expect(isDisabled(tree, 'sale-charge')).toBe(false);

    refuse(t.f);
    await act(async () => {
      await t.service.openSale(14);
    });
    expect(textOf(tree, 'home-stopped')).toBe(SALES_STOPPED);
    expect(isDisabled(tree, 'sale-charge')).toBe(true);

    t.f.secure.failSet.clear();
    await act(async () => {
      await t.service.settleNow('asked');
    });
    expect(has(tree, 'home-stopped')).toBe(false);
    expect(isDisabled(tree, 'sale-charge')).toBe(false);

    await act(async () => {
      tree.unmount();
    });
    await t.service.close();
    refuse(t.f);
    const again = make(t.f);
    const tree2 = await mount(again.wiring);
    await until(tree2, 'home-title');
    await flush();
    expect(textOf(tree2, 'home-stopped')).toBe(SALES_STOPPED);
    await press(tree2, 'key-1');
    expect(isDisabled(tree2, 'sale-charge')).toBe(true);
    await act(async () => {
      tree2.unmount();
    });
    await again.service.close();
  }, 60000);
});
