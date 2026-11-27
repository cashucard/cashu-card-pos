/* The archive end to end (slice 2.3): the real AppRoot, the real till service over a fake store and a fake mint, and
 * the real cashucard library over rows it wrote itself (the scaffold's fixture). The merchant reads the Activity, opens
 * Records behind the owner check, archives by hand, shares the payment list and reads the Activity again: the totals
 * never change, the archived payments are counted once, and no token, key or id shows anywhere. */

jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/__mocks__/BackHandler'),
);

import type { Journal, Row } from 'cashucard';
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AppRoot } from '../src/app/AppRoot';
import type { AppReport, AppWiring } from '../src/app/wiring';
import { filledJournal, onceWith } from '../src/dev/record-fill';
import { benchGate } from '../src/till/guarded';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { fakeTransport } from './helpers/fake-till';
import { allText, has, nodes, press, textOf, until, untilText } from './helpers/render';

type R = Record<string, unknown>;
const F = require('./fixtures/archive-rows.json') as { held: R[]; delivered: R[] };
const NOW = new Date(2026, 10, 22, 12, 0).getTime();
const TEST_MINT = 'https://mint.test';

function copyOf(rows: R[], kind: string): R {
  const r = rows.find((x) => x.kind === kind);
  if (r === undefined) {
    throw new Error('the fixture has no ' + kind + ' row');
  }
  return JSON.parse(JSON.stringify(r)) as R;
}

/** The captured delivered sale as sale n: new ids, begun at `at`. */
function delivered(n: number, at: number): Row[] {
  const sid = 'a-' + n;
  const pid = 'pay:' + String(n).padStart(32, '0');
  const did = 'fx-' + String(n).padStart(26, '0');
  const sale = copyOf(F.delivered, 'sale');
  sale.id = 'sale:' + sid;
  (sale.sale as R).id = sid;
  sale.at = at;
  const pay = copyOf(F.delivered, 'payment');
  pay.id = pid;
  pay.sale = sid;
  pay.at = at;
  pay.heldAt = at + 100;
  pay.delivery = did;
  const del = copyOf(F.delivered, 'delivery');
  del.id = did;
  del.payments = [pid];
  (del.delivery as R).id = did;
  del.at = at + 200;
  return [sale, pay, del] as unknown as Row[];
}

/** The captured held sale as sale n, of a mint the till does not take, so that no settle delivers it. */
function held(n: number, at: number): Row[] {
  const sid = 'h-' + n;
  const sale = copyOf(F.held, 'sale');
  sale.id = 'sale:' + sid;
  (sale.sale as R).id = sid;
  sale.at = at;
  const pay = copyOf(F.held, 'payment');
  pay.id = 'pay:' + String(9000 + n).padStart(32, '0');
  pay.sale = sid;
  pay.at = at;
  pay.heldAt = at + 100;
  pay.mint = 'https://other.test';
  return [sale, pay] as unknown as Row[];
}

function make() {
  const f = fakeStoreDeps();
  const clock = { now: NOW };
  f.deps.now = () => clock.now;
  const mint = fakeMint();
  const logs: string[] = [];
  const reports: AppReport[] = [];
  const shared: Array<{ title: string; text: string }> = [];
  const ready = onceWith(async (j: Journal) => {
    const sales = [delivered(1, NOW + 500), delivered(2, NOW + 1500), delivered(3, NOW + 2500), held(4, NOW + 3500)];
    for (const rows of sales) {
      clock.now += 1000;
      for (const r of rows) {
        await j.write(r);
      }
    }
  });
  const service = createTillService({
    store: f.deps,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: mint.http,
    now: () => clock.now,
    random: () => 0.25,
    log: (l) => logs.push(l),
    autoArchive: false,
    devJournal: (j) => filledJournal(j, ready, true),
  });
  const wiring: AppWiring = {
    mode: 'development',
    service,
    gate: benchGate('allow'),
    reader: { kind: 'card simulator', available: async () => true, transport: () => fakeTransport() },
    report: (r) => reports.push(r),
    devMintPreset: TEST_MINT,
    now: () => clock.now,
    share: async (title: string, text: string) => {
      shared.push({ title, text });
    },
  };
  return { f, service, logs, reports, shared, wiring };
}

let last: ReactTestRenderer | null = null;

async function firstRun(t: ReturnType<typeof make>): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<AppRoot wiring={t.wiring} />);
  });
  last = tree;
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

it('the merchant archives by hand in Records, shares the list, and the Activity counts every payment once', async () => {
  const t = make();
  const tree = await firstRun(t);

  await press(tree, 'home-activity');
  await untilText(tree, 'act-all', 'Paid in this record: 56 sats in 4 payments');
  expect(has(tree, 'act-archived')).toBe(false);
  await press(tree, 'home-sale');
  await until(tree, 'home-title');

  await press(tree, 'home-settings');
  await until(tree, 'settings-title');
  await press(tree, 'settings-records');
  await until(tree, 'records-title');
  expect(textOf(tree, 'records-title')).toBe('Records and reset');
  expect(has(tree, 'placeholder-body')).toBe(false);
  await untilText(tree, 'records-live', 'In the record now: 4 payments.');
  expect(textOf(tree, 'records-archived')).toBe('Paid and archived: 0 sats in 0 payments.');
  expect(t.reports.some((r) => r.screen === 'records' && r.gate === 'passed')).toBe(true);

  await press(tree, 'records-archive');
  await untilText(tree, 'records-result', 'Archived 3 payments.');
  await untilText(tree, 'records-live', 'In the record now: 1 payment.');
  expect(textOf(tree, 'records-archived')).toBe('Paid and archived: 42 sats in 3 payments.');
  expect(textOf(tree, 'records-last').startsWith('Last archived: 22 Nov 2026, 12:00, 3 payments')).toBe(true);
  expect((await t.service.payments()).map((p) => p.state)).toEqual(['held']);

  await press(tree, 'records-share');
  for (let i = 0; i < 20 && t.shared.length === 0; i += 1) {
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
    });
  }
  expect(t.shared).toHaveLength(1);
  expect(t.shared[0].title).toBe('Cashu Card POS payments');
  expect(t.shared[0].text.split('\r\n')).toEqual([
    'date,time,sats,what,takings,fee_sats,mint,archived',
    '2026-11-22,12:00,14,PAID,yes,1,mint.test,yes',
    '2026-11-22,12:00,14,PAID,yes,1,mint.test,yes',
    '2026-11-22,12:00,14,PAID,yes,1,mint.test,yes',
    '2026-11-22,12:00,14,PAID,yes,1,other.test,no',
    '',
  ]);

  await press(tree, 'nav-back');
  await until(tree, 'settings-title');
  await press(tree, 'nav-back');
  await until(tree, 'home-title');
  await press(tree, 'home-activity');
  await untilText(tree, 'act-all', 'Paid in this record: 56 sats in 4 payments');
  expect(textOf(tree, 'act-archived')).toBe('Of these, archived: 42 sats in 3 payments');
  expect(textOf(tree, 'pay-row-0')).toBe('14 sats · PAID · 22 Nov 2026, 12:00');
  expect(has(tree, 'pay-row-1')).toBe(false);

  const shown = [...allText(tree), t.shared[0].text, ...t.logs, JSON.stringify(t.reports)].join('\n');
  for (const bad of ['pay:', 'cashu', 'sale:', 'fx-', 'a-1', 'h-4', '02cccc']) {
    expect(shown).not.toContain(bad);
  }
  for (const l of t.logs) {
    expect(l.startsWith('till: ')).toBe(true);
  }
});

it('the Records screen is behind the owner check: refused, it is never shown and nothing is archived', async () => {
  const t = make();
  const tree = await firstRun(t);
  // refused from here on: adding the first mint asks the owner check too
  t.wiring.gate = benchGate('deny');
  await press(tree, 'home-settings');
  await until(tree, 'settings-title');
  await press(tree, 'settings-records');
  await untilText(tree, 'settings-note', 'Not confirmed. Nothing was changed.');
  expect(has(tree, 'records-title')).toBe(false);
  expect(await t.service.archivedTakings(null, null)).toEqual({ sats: 0, count: 0 });
  expect((await t.service.payments()).length).toBe(4);
});
