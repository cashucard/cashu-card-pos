/* The Mints screen's removal question and refusal (review of slice 1.3, B1): the refusal says which reason holds, and
 * the question warns of payments that may never finish and of change the mint never proved. */

import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { MINTS_WORDS, MintsScreen, type MintsProps } from '../src/screens/MintsScreen';
import { benchGate } from '../src/till/guarded';
import { MintInUseError, type MintRemoval } from '../src/till/service';
import type { MintEntry } from '../src/till/settings';
import { flush, has, press, textOf, untilText } from './helpers/render';

const URL = 'https://mint.test';
const OK: MintEntry = { url: URL, addedAt: 1, checkedAt: 1, keysets: ['00'], status: 'ok', why: null };

function service(removal: MintRemoval | null, refuse: MintInUseError | null): MintsProps['service'] {
  const s: MintsProps['service'] = {
    mints: () => [OK],
    removeMint: async () => {
      if (refuse !== null) {
        throw refuse;
      }
    },
    recheckMints: async () => [OK],
  };
  if (removal !== null) {
    s.removalOf = async () => removal;
  }
  return s;
}

async function mount(s: MintsProps['service']): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <MintsScreen service={s} gate={benchGate('allow')} onAdd={() => undefined} onBack={() => undefined} />,
    );
  });
  return tree;
}

it('a card payment not finished yet is the reason given, and what ends it', async () => {
  const tree = await mount(service(null, new MintInUseError(URL, 'unfinished')));
  await press(tree, 'mint-remove-0');
  await press(tree, 'mint-remove-yes');
  await untilText(tree, 'mints-note', MINTS_WORDS.unfinished);
  expect(has(tree, 'mint-row-0')).toBe(true);
});

it('money owed is the reason given, and what ends it', async () => {
  const tree = await mount(service(null, new MintInUseError(URL, 'owed')));
  await press(tree, 'mint-remove-0');
  await press(tree, 'mint-remove-yes');
  await untilText(tree, 'mints-note', MINTS_WORDS.inUse);
});

it('the question warns of payments that may never finish, and of unproved change', async () => {
  const tree = await mount(service({ refused: null, late: true, unproved: true }, null));
  await press(tree, 'mint-remove-0');
  await flush();
  expect(textOf(tree, 'mint-remove-risk-0')).toBe(MINTS_WORDS.late);
  expect(textOf(tree, 'mint-remove-risk-1')).toBe(MINTS_WORDS.unproved);
  expect(has(tree, 'mint-remove-yes')).toBe(true);
});

it('only unproved change: one warning', async () => {
  const tree = await mount(service({ refused: null, late: false, unproved: true }, null));
  await press(tree, 'mint-remove-0');
  await flush();
  expect(textOf(tree, 'mint-remove-risk-0')).toBe(MINTS_WORDS.unproved);
  expect(has(tree, 'mint-remove-risk-1')).toBe(false);
});

it('nothing that may never finish: no warning', async () => {
  for (const removal of [{ refused: null, late: false, unproved: false }, null]) {
    const tree = await mount(service(removal, null));
    await press(tree, 'mint-remove-0');
    await flush();
    expect(has(tree, 'mint-remove-warning')).toBe(true);
    expect(has(tree, 'mint-remove-risk-0')).toBe(false);
  }
});
