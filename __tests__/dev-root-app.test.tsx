import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { AppWiring } from '../src/app/wiring';
import { DevRoot } from '../src/dev/DevRoot';
import type { AppPlan } from '../src/lab/plan';
import { benchGate } from '../src/till/guarded';
import { noReader } from '../src/till/reader';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { flush, press, textOf, until } from './helpers/render';

const TEST_MINT = 'https://mint.test';

/** The till's wiring over the fakes, as AppRoot gets it in development. */
function wiring(): AppWiring {
  const f = fakeStoreDeps();
  const mint = fakeMint();
  return {
    mode: 'development',
    service: createTillService({
      store: f.deps,
      names: TILL_NAMES,
      settingsNames: TILL_SETTINGS,
      http: mint.http,
      now: () => 1000,
      log: () => undefined,
    }),
    gate: benchGate('allow'),
    reader: noReader(),
    report: () => undefined,
    devMintPreset: TEST_MINT,
    now: () => 1000,
  };
}

async function mount(props: React.ComponentProps<typeof DevRoot>): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<DevRoot {...props} />);
  });
  return tree;
}

it('an app plan shows the till', async () => {
  const app = jest.fn((_p: AppPlan) => wiring());
  const selftest = jest.fn();
  const lab = jest.fn();
  const tree = await mount({
    plan: async () => ({ mode: 'app', app: { gate: 'bench-allow' } }),
    selftest,
    lab,
    app,
  });
  await until(tree, 'firstrun-title');
  expect(app).toHaveBeenCalledTimes(1);
  expect(app).toHaveBeenCalledWith({ gate: 'bench-allow' });
  expect(selftest).not.toHaveBeenCalled();
  expect(lab).not.toHaveBeenCalled();
});

it("the till's wiring is made once", async () => {
  const app = jest.fn((_p: AppPlan) => wiring());
  const tree = await mount({
    plan: async () => ({ mode: 'app', app: { gate: 'bench-allow' } }),
    selftest: jest.fn(),
    lab: jest.fn(),
    app,
  });
  await until(tree, 'firstrun-title');
  await flush();
  await flush();
  await press(tree, 'firstrun-dev-mint');
  await until(tree, 'addmint-title');
  expect(app).toHaveBeenCalledTimes(1);
});

it('an app plan without app wiring is a plan failure', async () => {
  const tree = await mount({
    plan: async () => ({ mode: 'app', app: { gate: 'device' } }),
    selftest: jest.fn(),
    lab: jest.fn(),
  });
  await until(tree, 'dev-plan-error');
  expect(textOf(tree, 'dev-plan-error')).toBe('PLAN FAIL: no app wiring');
});
