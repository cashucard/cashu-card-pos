/* The real library's row for a card payment whose SIGN went out and whose signature was never had (slice 1.4): the
 * record lists it as a taking payment AND as a sign-asked open claim. The Activity must list it once, as its open claim,
 * in the true words of a payment waiting for its card, and count none of it as takings. */

import type { Journal, Row } from 'cashucard';
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { activityView, claimLine, readActivity } from '../src/app/activity';
import { filledJournal, onceWith } from '../src/dev/record-fill';
import { ActivityScreen } from '../src/screens/ActivityScreen';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { allText, has, press, textOf, untilText } from './helpers/render';

const NOW = new Date(2026, 10, 22, 12, 0).getTime();
const PAY_ID = 'pay:' + 'a'.repeat(32);
const SALE = 's-w';
const CARD_KEY = '02' + 'c'.repeat(64);
const STARTED = NOW - 60000;
/** What the library writes at SIGN before it asks the card for its signature: the plan set out, the step sign-asked,
 * the payment taking, the claim begun. */
const ROW: Row = {
  kind: 'payment',
  id: PAY_ID,
  sale: SALE,
  how: 'card',
  state: 'taking',
  step: 'sign-asked',
  claim: { misses: 0, since: STARTED },
  at: STARTED,
  mint: 'https://mint.test',
  unit: 'sat',
  amount: 14,
  fee: 1,
  card: { key: CARD_KEY, mint: 'https://mint.test', unit: 'sat', version: '3.0', format: 1 },
  plan: { keyset: '00'.repeat(16), inputs: [], own: [], ownCount: 0, change: [], sum: 15, fee: 1, net: 14, want: 14,
    digest: 'f'.repeat(64) },
} as unknown as Row;

/** An open till over a fake store and a fake mint, with the real library reading a record that holds that row. */
async function till() {
  const f = fakeStoreDeps();
  const mint = fakeMint();
  const ready = onceWith(async (j: Journal) => {
    await j.write(ROW);
  });
  const service = createTillService({
    store: f.deps,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: mint.http,
    now: () => NOW,
    log: () => undefined,
    random: () => 0.25,
    devJournal: (j) => filledJournal(j, ready, true),
  });
  await service.open();
  await service.addMint(await service.checkMint('mint.test'));
  return service;
}

it('the real record lists a payment dropped after SIGN as taking and as its own sign-asked claim', async () => {
  const service = await till();
  const payments = await service.payments();
  expect(payments.map((p) => [p.paymentId, p.id, p.state, p.amount, p.fee, p.at])).toEqual([
    [PAY_ID, SALE, 'taking', 14, 1, STARTED],
  ]);
  const claims = await service.openClaims();
  expect(claims.map((c) => [c.id, c.sale, c.step, c.amount, c.price, c.asks, c.misses, c.at])).toEqual([
    [PAY_ID, SALE, 'sign-asked', 15, 14, 0, 0, STARTED],
  ]);
});

it('the Activity lists it once, as its open claim, waiting for the card, and counts none of it', async () => {
  const service = await till();
  const v = activityView(await readActivity(service, () => NOW), 1, NOW);
  expect(v.waiting).toEqual([PAY_ID]);
  expect(v.claims.map((c) => c.id)).toEqual([PAY_ID]);
  expect(v.unfinished).toEqual([]);
  expect(v.done).toEqual([]);
  expect(v.losses).toEqual([]);
  expect(v.count).toBe(0);
  expect(v.all).toEqual({ sats: 0, count: 0 });
  expect(v.today).toEqual({ sats: 0, count: 0 });
  expect(claimLine(v.claims[0], true)).toBe(
    '14 sats from a card · asked 0 times · started 22 Nov 2026, 11:59 · WAITING FOR THE CARD',
  );
});

it('the screen shows it as a pressable claim row in the waiting words, with no payment row', async () => {
  const service = await till();
  const opened: string[] = [];
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <ActivityScreen
        reader={service}
        now={() => NOW}
        pages={1}
        onPages={() => undefined}
        onOpen={(id) => opened.push(id)}
        onPayments={(l) => service.onPayments(l)}
        onBack={() => undefined}
        onRead={() => undefined}
      />,
    );
  });
  await untilText(
    tree,
    'claim-row-0',
    '14 sats from a card · asked 0 times · started 22 Nov 2026, 11:59 · WAITING FOR THE CARD',
  );
  expect(has(tree, 'unf-row-0')).toBe(false);
  expect(textOf(tree, 'act-open-none')).toBe('None.');
  expect(textOf(tree, 'act-all')).toBe('Paid in this record: 0 sats in 0 payments');
  await press(tree, 'claim-open-0');
  expect(opened).toEqual([PAY_ID]);
  for (const s of allText(tree)) {
    expect(s).not.toContain('CHECKING');
    expect(s).not.toContain('checking');
    expect(s).not.toContain('—');
    expect(s).not.toContain('–');
    expect(/crypto|paid back|settled/i.test(s)).toBe(false);
  }
  act(() => {
    tree.unmount();
  });
});
