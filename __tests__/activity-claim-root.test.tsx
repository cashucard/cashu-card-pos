/* A card payment whose tap dropped after SIGN, as the real cashucard library keeps it (slice 1.4, order 11). No test of
 * this repository runs the library's card flow (every one replaces sale(id)'s card), so the row is the one the library
 * itself writes at SIGN (dist/pay.js: the payment row of tap 2, then beforeSign: step 'sign-asked', state 'taking', its
 * claim), written into the record before the library first reads it, through the development seam the fill uses. The
 * real library then reads it, lists it as a taking payment and as an open claim of the same id, and settles over it;
 * the real till service and the real app root show it. So the Activity's reading of such a payment can never again
 * rest on a fixture the library does not produce. */

import { type Journal, type Row } from 'cashucard';
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AppRoot } from '../src/app/AppRoot';
import { claimLine, type ActivityReport } from '../src/app/activity';
import type { AppWiring } from '../src/app/wiring';
import { filledJournal, onceWith } from '../src/dev/record-fill';
import { benchGate } from '../src/till/guarded';
import { WAITING_WORDS } from '../src/till/payment-words';
import { noReader } from '../src/till/reader';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { allText, has, press, textOf, until, untilText } from './helpers/render';

const NOW = new Date(2026, 10, 22, 12, 0).getTime();
const ID = 'pay:' + 'a'.repeat(32);
const KEYSET = '00ad268c4d1f5826';
const hex = (c: string): string => '02' + c.repeat(64);
/** The row of a card payment of 14 sats at the test mint whose SIGN went out and whose signature was not had. */
const SIGNED: Row = {
  kind: 'payment',
  id: ID,
  sale: 's-drop',
  how: 'card',
  state: 'taking',
  step: 'sign-asked',
  at: NOW - 60000,
  mint: 'https://mint.test',
  unit: 'sat',
  amount: 14,
  fee: 1,
  total: 15,
  why: 'interrupted',
  card: { key: hex('c'), mint: 'https://mint.test', unit: 'sat', version: '3.0', format: 1 },
  claim: { misses: 0, since: NOW - 60000 },
  plan: {
    keyset: KEYSET,
    inputs: [
      { id: KEYSET, amount: 8, secret: 'a1'.repeat(32), C: hex('1'), slot: 0 },
      { id: KEYSET, amount: 8, secret: 'a2'.repeat(32), C: hex('2'), slot: 1 },
    ],
    own: [{ amount: 8, id: KEYSET, B_: hex('3'), secret: 'b3'.repeat(32), r: 'c3'.repeat(32) },
      { amount: 4, id: KEYSET, B_: hex('4'), secret: 'b4'.repeat(32), r: 'c4'.repeat(32) },
      { amount: 2, id: KEYSET, B_: hex('5'), secret: 'b5'.repeat(32), r: 'c5'.repeat(32) }],
    ownCount: 3,
    change: [{ amount: 1, B_: hex('6'), K: hex('7') }],
    sum: 16,
    fee: 1,
    net: 15,
    want: 14,
    digest: 'd'.repeat(64),
  },
} as unknown as Row;

function make() {
  const f = fakeStoreDeps();
  const mint = fakeMint();
  const once = onceWith(async (j: Journal) => {
    await j.write(SIGNED);
  });
  const service = createTillService({
    store: f.deps, names: TILL_NAMES, settingsNames: TILL_SETTINGS, http: mint.http, now: () => NOW,
    log: () => undefined,
    devJournal: (j) => filledJournal(j, once, true),
  });
  const acts: ActivityReport[] = [];
  const wiring: AppWiring = {
    mode: 'development', service, gate: benchGate('allow'), reader: noReader(), report: () => undefined,
    devMintPreset: 'https://mint.test', now: () => NOW, reportActivity: (r) => acts.push(r),
  };
  return { service, acts, wiring };
}

let last: ReactTestRenderer | null = null;

afterEach(async () => {
  const tree = last;
  if (tree !== null) {
    await act(async () => {
      tree.unmount();
    });
    last = null;
  }
});

it('a tap dropped after SIGN, as the real library keeps it, is one open claim waiting for its card, never CHECKING', async () => {
  const t = make();
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<AppRoot wiring={t.wiring} />);
  });
  last = tree;
  await until(tree, 'firstrun-title');
  await press(tree, 'firstrun-dev-mint');
  await until(tree, 'addmint-title');
  await press(tree, 'addmint-check');
  await untilText(tree, 'addmint-result', 'This mint can be used.');
  await press(tree, 'addmint-add');
  await until(tree, 'home-title');

  // the real library lists the one row twice: as a payment being taken, and as an open claim of step sign-asked
  const pays = await t.service.payments();
  const claims = await t.service.openClaims();
  expect(pays.map((p) => [p.paymentId, p.state])).toEqual([[ID, 'taking']]);
  expect(claims.map((c) => [c.id, c.step])).toEqual([[ID, 'sign-asked']]);

  await press(tree, 'home-activity');
  await until(tree, 'claim-row-0');
  expect(textOf(tree, 'claim-row-0')).toBe(claimLine(claims[0], true));
  expect(textOf(tree, 'claim-row-0')).toBe(
    '14 sats from a card · asked 0 times · started 22 Nov 2026, 11:59 · WAITING FOR THE CARD',
  );
  expect(textOf(tree, 'act-open-none')).toBe('None.');
  expect(has(tree, 'unf-row-0')).toBe(false);
  expect(textOf(tree, 'act-all')).toBe('Paid in this record: 0 sats in 0 payments');
  for (const s of allText(tree)) {
    expect(s).not.toContain('CHECKING');
  }
  const read = t.acts[t.acts.length - 1];
  expect([read.claims, read.unfinished, read.payments]).toEqual([1, 0, 0]);

  await press(tree, 'claim-open-0');
  await untilText(tree, 'payment-title', 'WAITING FOR THE CARD');
  expect(textOf(tree, 'payment-sentence')).toBe(WAITING_WORDS.sentence);
  expect(textOf(tree, 'payment-name')).toBe('14 sats · 22 Nov 2026, 11:59');
});
