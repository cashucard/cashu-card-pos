import React from 'react';
import { AppState, SafeAreaView, Text } from 'react-native';
import * as owed from '../src/till/owed';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { CashuCard, Payment } from 'cashucard';
import { OwedScreen } from '../src/screens/OwedScreen';
import { receiptReference } from '../src/app/receipt-reference';
import type { TillService } from '../src/till/service';
import type { GateResult } from '../src/till/gate';
import { allText, has, press, textOf } from './helpers/render';
import { noReader } from '../src/till/reader';
import { heldPayment } from './helpers/fake-till';

beforeEach(() => { AppState.currentState = 'active'; });

async function render(authorized: boolean, customerHandoffs: TillService['customerHandoffs'] = async () => [], walletReturn = false) {
  const ids = ['pay:eg1', 'pay:eg2'];
  const payments = ids.map((paymentId, i): Payment => ({
    ...heldPayment('sale'), paymentId, extra: 'late', owedToCard: 0, unconfirmed: 0,
    cardKey: walletReturn ? undefined : '02' + String(i + 3).repeat(64), amount: 8, at: 1760000000000,
  }));
  const card = {
    payments: async () => payments,
    openClaims: async () => [],
    owedTotals: async (key: string) => [{ amount: 8, state: 'held', reason: 'extra', pieces: 1, sale: 'sale',
      paymentId: payments.find(p => p.cardKey === key)!.paymentId }],
  } as unknown as CashuCard;
  const customerToken = jest.fn(async (id: string) => 'synthetic-token-for-' + id);
  const service = {
    withCard: async <T,>(_k: string, f: (c: CashuCard) => Promise<T>) => f(card),
    customerHandoffs,
    onPayments: () => () => {},
    customerToken,
    settleNow: async () => [],
  } as Pick<TillService, 'withCard' | 'settleNow' | 'onPayments' | 'customerToken' | 'customerHandoffs'>;
  const check = jest.fn(async (): Promise<GateResult> => authorized ? { ok: true } : { ok: false, why: 'cancelled', words: 'Cancelled' });
  const share = jest.fn(async () => {});
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<OwedScreen service={service} gate={{ check, available: async () => true }} share={share}
      reader={noReader()} onBack={() => {}} />);
  });
  return { ids, tree, share, customerToken, check };
}

test('two same-amount, same-minute returns have distinguishable receipts in the list and confirmation', async () => {
  const { ids, tree, share, customerToken, check } = await render(true);
  const a = receiptReference(ids[0]);
  const b = receiptReference(ids[1]);
  expect(allText(tree).join(' ')).toContain(a);
  expect(allText(tree).join(' ')).toContain(b);
  await press(tree, 'owed-export-1');
  expect(allText(tree).join(' ')).toContain(b);
  expect(allText(tree).join(' ')).not.toContain(a);
  expect(customerToken).not.toHaveBeenCalled();
  await press(tree, 'owed-confirm-export');
  expect(check).toHaveBeenCalledTimes(1);
  expect(customerToken).toHaveBeenCalledWith(ids[1]);
  expect(has(tree, 'token-qr')).toBe(true);
  expect(share).not.toHaveBeenCalled();
  await press(tree, 'token-share');
  expect(share).toHaveBeenCalledWith('Customer return token', 'synthetic-token-for-' + ids[1]);
  expect(allText(tree).join(' ')).not.toContain('synthetic-token');
  await press(tree, 'token-done');
  expect(has(tree, 'token-qr')).toBe(false);
  act(() => tree.unmount());
});

test('cancelling the owner prompt or the warning leaves the customer token untouched', async () => {
  const { tree, share, customerToken, check } = await render(false);
  await press(tree, 'owed-export-0');
  await press(tree, 'owed-decline-export');
  expect(check).not.toHaveBeenCalled();
  await press(tree, 'owed-export-0');
  await press(tree, 'owed-confirm-export');
  expect(textOf(tree, 'owed-message')).toBe('Cancelled');
  expect(customerToken).not.toHaveBeenCalled();
  expect(share).not.toHaveBeenCalled();
  expect(has(tree, 'owed-scan')).toBe(true);
  act(() => tree.unmount());
});

test('keeps the original-card return prompt and progress above the iOS sheet', async () => {
  let detected!: () => void;
  const read = jest.spyOn(owed, 'returnToCard').mockImplementation(async (_service, _reader, _tag, _pin, _signal, onCard) => {
    detected = onCard;
    return new Promise(() => {});
  });
  const { tree } = await render(true);
  try {
    await press(tree, 'owed-scan');
    const upper = () => tree.root.findAllByType(SafeAreaView).find(v => v.props.testID === 'nfc-top-half')!;
    const words = () => upper().findAllByType(Text).map(t => t.props.children);
    expect(words()).toEqual(['Customer return', 'Tap the original card', 'Hold it at the top of the iPhone.']);
    expect(has(tree, 'owed-cancel')).toBe(true);
    act(() => detected());
    expect(words()).toEqual(['Customer return', 'Hold the card still', 'Keep it there until the return finishes.']);
    expect(has(tree, 'owed-cancel')).toBe(false);
  } finally {
    act(() => tree.unmount());
    read.mockRestore();
  }
});

test('Refresh asks for current saved customer returns and removes redeemed receipts', async () => {
  let redeemed = false;
  const amount = jest.fn(async (check?: boolean) => {
    if (check) redeemed = true;
    return redeemed ? [] : [{id:'saved-1',cardRef:null,mint:'https://mint.test',unit:'sat',amount:3,at:1}];
  });
  const {tree} = await render(true, amount);
  expect(has(tree, 'owed-share-0')).toBe(true);
  await press(tree, 'owed-refresh');
  expect(amount).toHaveBeenCalledWith(true);
  expect(has(tree, 'owed-share-0')).toBe(false);
});

test('a wallet return goes to its original sender and does not ask for a card', async () => {
  const { tree } = await render(true, async () => [], true);
  await press(tree, 'owed-export-0');
  expect(allText(tree).join(' ')).toContain('the customer whose wallet sent the extra payment');
  expect(allText(tree).join(' ')).not.toContain('automatic card return');
  act(() => tree.unmount());
});
