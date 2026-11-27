import React from 'react';
import { AppState } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { CardError, type CardBalance, type CashuCard } from 'cashucard';
import { CardBalanceScreen } from '../src/screens/CardBalanceScreen';
import * as readerApi from '../src/till/card-balance';
import type { CardReader } from '../src/till/reader';
import type { TillService } from '../src/till/service';
import { allText, has, press, textOf } from './helpers/render';

const cardKey = '02' + 'af'.repeat(32);
const balance: CardBalance = { mint: 'https://mint.test', unit: 'sat', amounts: { sat: 0, usd: 4 }, cardKey };
const withCard: TillService['withCard'] = (_job, action) => action({} as CashuCard);
const reader: CardReader = {
  kind: 'nfc', available: async () => true,
  transport: () => { throw new Error('unexpected NFC'); },
};
const entry = { url: balance.mint, addedAt: 1, checkedAt: 1, keysets: [], why: null, status: 'ok' as const };

beforeEach(() => { AppState.currentState = 'active'; });
afterEach(() => { jest.restoreAllMocks(); });

async function render(accepted = true) {
  let tree!: ReactTestRenderer;
  const onTopUp = jest.fn();
  const onCharge = jest.fn();
  const onBack = jest.fn();
  await act(async () => {
    tree = renderer.create(<CardBalanceScreen reader={reader}
      service={{ withCard, mints: () => accepted ? [entry] : [] }} onTopUp={onTopUp} onCharge={onCharge} onBack={onBack} />);
  });
  return { tree, onTopUp, onBack, onCharge };
}

test('shows both listed currencies, the mint and a top-up action bound to the scanned card', async () => {
  const scan = jest.spyOn(readerApi, 'scanCardBalance').mockResolvedValue(balance);
  const { tree, onTopUp, onBack, onCharge } = await render();
  expect(scan).toHaveBeenCalledTimes(1);
  expect(textOf(tree, 'balance-amount')).toBe('0 sats');
  expect(textOf(tree, 'balance-other')).toBe('4 US cents');
  expect(textOf(tree, 'balance-mint')).toBe(balance.mint);
  expect(allText(tree).join(' ')).not.toContain(cardKey);
  await press(tree, 'balance-top-up');
  expect(onTopUp).toHaveBeenCalledWith(balance);
  await press(tree, 'balance-charge');
  expect(onCharge).toHaveBeenCalledTimes(1);
  await press(tree, 'balance-done');
  expect(onBack).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});

test('shows another mint’s balance without offering a payment to it', async () => {
  jest.spyOn(readerApi, 'scanCardBalance').mockResolvedValue(balance);
  const { tree } = await render(false);
  expect(textOf(tree, 'balance-mint')).toBe(balance.mint);
  expect(has(tree, 'balance-top-up')).toBe(false);
  expect(has(tree, 'balance-top-up-unavailable')).toBe(true);
  expect(has(tree, 'balance-charge')).toBe(false);
  act(() => tree.unmount());
});

test('a failed read does not show a zero balance; an explicit retry reads again', async () => {
  const scan = jest.spyOn(readerApi, 'scanCardBalance')
    .mockRejectedValueOnce(new CardError('gone', 'Moved away.')).mockResolvedValueOnce(balance);
  const { tree } = await render();
  expect(has(tree, 'balance-amount')).toBe(false);
  expect(has(tree, 'balance-top-up')).toBe(false);
  await press(tree, 'balance-retry');
  expect(scan).toHaveBeenCalledTimes(2);
  expect(textOf(tree, 'balance-amount')).toBe('0 sats');
  act(() => tree.unmount());
});

test('leaving a waiting scan aborts the NFC session', async () => {
  const scan = jest.spyOn(readerApi, 'scanCardBalance').mockImplementation(async () => new Promise(() => {}));
  const { tree } = await render();
  expect(has(tree, 'nfc-top-half')).toBe(true);
  const signal = scan.mock.calls[0][2];
  act(() => tree.unmount());
  expect(signal.aborted).toBe(true);
});

test('a request cancelled while queued never starts the reader', async () => {
  const abort = new AbortController();
  let start!: () => void;
  const queued: TillService['withCard'] = (_kind, action) => new Promise((resolve, reject) => {
    start = () => action({} as CashuCard).then(resolve, reject);
  });
  const available = jest.fn(async () => true);
  const pending = readerApi.scanCardBalance({ withCard: queued }, { ...reader, available }, abort.signal, () => {});
  abort.abort();
  start();
  await expect(pending).rejects.toMatchObject({ kind: 'stopped' });
  expect(available).not.toHaveBeenCalled();
});
