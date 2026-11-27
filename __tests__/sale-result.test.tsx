/* The sale's results: the words the merchant is told once a card payment has ended. PAID only for a held payment,
 * CHECKING while the mint has not finished, never NOT PAID for anything the card signed, and never "paid back". */

import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { heldPayment } from './helpers/fake-till';
import { RESULT_WORDS, paidTwiceWords, ResultPanel } from '../src/screens/SaleResult';
import type { SaleOutcome, SaleState } from '../src/till/sale-machine';
import { allText, has, ids, nodes, press, textOf } from './helpers/render';

/** Every tree made in this file, for the last test's sweep of the words. */
const created: ReactTestRenderer[] = [];

function render(el: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(el);
  });
  created.push(tree);
  return tree;
}

type ResultState = Extract<SaleState, { kind: 'result' }>;

/** A result of a sale of 2,100 sats, on 's1'. */
function res(outcome: SaleOutcome, note: string | null = null): ResultState {
  return { kind: 'result', sats: 2100, saleId: 's1', outcome, note };
}

function show(state: ResultState, send: jest.Mock = jest.fn(), onActivity: jest.Mock = jest.fn()): ReactTestRenderer {
  return render(<ResultPanel state={state} send={send} onActivity={onActivity} />);
}

/** A button's label: the kit's Button carries it as a prop. */
function labelOf(tree: ReactTestRenderer, id: string): string {
  const found = nodes(tree, id);
  if (found.length === 0) {
    throw new Error('no node ' + id);
  }
  const label: unknown = found[0].props.label;
  return typeof label === 'string' ? label : '';
}

const TAP: SaleOutcome = { kind: 'tap-again', message: 'm.' };

it('PAID shows the amount, the fee and the figures above zero', async () => {
  const send = jest.fn();
  const onActivity = jest.fn();
  const payment = { ...heldPayment('s1'), mint: 'https://testnut.cashu.space', givenBack: 11 };
  const tree = show(res({ kind: 'paid', payment }), send, onActivity);
  expect(textOf(tree, 'result-title')).toBe('PAID');
  expect(has(tree, 'result-celebration')).toBe(true);
  expect(textOf(tree, 'result-amount')).toBe('14 sats');
  expect(textOf(tree, 'result-fee')).toBe("The card paid the mint's fee of 1 sat.");
  expect(textOf(tree, 'result-written')).toBe('Change written to the card: 11 sats');
  expect(has(tree, 'result-owed')).toBe(false);
  expect(textOf(tree, 'result-mint')).toBe('testnut.cashu.space');
  await press(tree, 'result-activity');
  expect(onActivity).toHaveBeenCalledTimes(1);
  await press(tree, 'result-new');
  expect(send).toHaveBeenCalledWith({ type: 'new' });
});

it('checking never says PAID', async () => {
  const send = jest.fn();
  const onActivity = jest.fn();
  const tree = show(res({ kind: 'checking', paymentId: 'pay:00', message: '' }), send, onActivity);
  expect(textOf(tree, 'result-title')).toBe('CHECKING');
  expect(has(tree, 'result-celebration')).toBe(false);
  expect(textOf(tree, 'result-body')).toBe(RESULT_WORDS.checkingBody);
  expect(allText(tree)).not.toContain('PAID');
  await press(tree, 'result-activity');
  expect(onActivity).toHaveBeenCalledTimes(1);
  await press(tree, 'result-other-way');
  expect(send).toHaveBeenLastCalledWith({ type: 'other-way' });
});

it('a signed error is never NOT PAID', async () => {
  const send = jest.fn();
  const message = 'The card was taken away as it was signing.';
  const tree = show(res({ kind: 'tap-again', message }), send);
  expect(textOf(tree, 'result-title')).toBe('TAP THE SAME CARD AGAIN');
  expect(textOf(tree, 'result-message')).toBe(message);
  expect(labelOf(tree, 'result-retry')).toBe('Hold the card again');
  await press(tree, 'result-retry');
  expect(send).toHaveBeenLastCalledWith({ type: 'retry' });
  expect(has(tree, 'result-other-way')).toBe(true);
  expect(has(tree, 'result-new')).toBe(false);
  expect(allText(tree)).not.toContain('NOT PAID');

  const yet = show(res({ kind: 'not-paid-yet', message: '' }));
  expect(textOf(yet, 'result-title')).toBe('NOT PAID YET');
  expect(has(yet, 'result-other-way')).toBe(true);
});

it('a sale already paid goes back to the card', () => {
  const twice = show(res({ kind: 'already-paid', extra: 'paid-twice', message: '' }));
  expect(textOf(twice, 'result-title')).toBe('ALREADY PAID');
  expect(has(twice, 'result-celebration')).toBe(false);
  expect(textOf(twice, 'result-body')).toBe(RESULT_WORDS.alreadyPaidBody);
  expect(has(twice, 'result-new')).toBe(true);
  expect(has(twice, 'result-retry')).toBe(false);

  const late = show(res({ kind: 'already-paid', extra: 'late', message: '' }));
  expect(textOf(late, 'result-title')).toBe('ALREADY WITHDRAWN');
  expect(textOf(late, 'result-body')).toBe(RESULT_WORDS.alreadyLateBody);
  expect(has(late, 'result-new')).toBe(true);
  expect(has(late, 'result-retry')).toBe(false);
});

it("not paid shows the kind's title over the library's words", () => {
  const tree = show(
    res({ kind: 'not-paid', errorKind: 'not-enough', title: 'Not enough on the card', message: 'The card holds 12 sats.' }),
  );
  expect(textOf(tree, 'result-title')).toBe('NOT PAID');
  expect(has(tree, 'result-celebration')).toBe(false);
  expect(textOf(tree, 'result-kind')).toBe('Not enough on the card');
  expect(textOf(tree, 'result-message')).toBe('The card holds 12 sats.');
  expect(labelOf(tree, 'result-retry')).toBe('Try again');
});

it('the withdraw question names what happens to the money', async () => {
  const send = jest.fn();
  const askedTap = show(res({ kind: 'withdraw-asked', back: TAP }), send);
  expect(textOf(askedTap, 'withdraw-warning')).toBe(RESULT_WORDS.withdrawCard);
  expect(labelOf(askedTap, 'withdraw-no')).toBe('Keep waiting for the card');
  await press(askedTap, 'withdraw-yes');
  expect(send).toHaveBeenLastCalledWith({ type: 'withdraw-yes' });

  const askedMint = show(res({ kind: 'withdraw-asked', back: { kind: 'checking', paymentId: null, message: '' } }));
  expect(textOf(askedMint, 'withdraw-warning')).toBe(RESULT_WORDS.withdrawMint);
  expect(labelOf(askedMint, 'withdraw-no')).toBe('Keep the sale open');

  const going = show(res({ kind: 'withdrawing', back: TAP }));
  expect(textOf(going, 'withdraw-wait')).toBe('Withdrawing the sale.');
  expect(going.root.findAll((n) => typeof n.props.onPress === 'function')).toHaveLength(0);
});

it('a withdrawn sale says when the customer paid twice', () => {
  const none = show(res({ kind: 'withdrawn', paidBefore: [] }));
  expect(has(none, 'result-paid-twice')).toBe(false);
  const twice = show(res({ kind: 'withdrawn', paidBefore: [heldPayment('s1')] }));
  expect(textOf(twice, 'result-paid-twice')).toBe(paidTwiceWords(14));
  expect(paidTwiceWords(14)).toBe(
    'A card payment of 14 sats was already taken for this sale. The customer has paid twice: give back their other payment.',
  );
  expect(has(twice, 'result-new')).toBe(true);
});

it('stop has nothing to press', () => {
  const tree = show(res({ kind: 'stop', message: 'The journal could not be written.' }));
  expect(textOf(tree, 'result-title')).toBe('STOP');
  expect(ids(tree).filter((id) => id.startsWith('result-') && typeof nodes(tree, id)[0].props.onPress === 'function')).toEqual(
    [],
  );
  for (const id of ['result-new', 'result-retry', 'result-other-way', 'result-activity']) {
    expect(has(tree, id)).toBe(false);
  }
});

it('a note shows last', () => {
  const tree = show(res(TAP, 'The sale was not withdrawn: x'));
  expect(textOf(tree, 'result-note')).toBe('The sale was not withdrawn: x');
  const order = ids(tree);
  expect(order[order.length - 1]).toBe('result-note');
});

/** The long dashes, written by their code points so this file itself holds neither. */
const LONG_DASHES = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)];

it('no result uses a long dash, the word crypto, or paid back', () => {
  expect(created.length).toBeGreaterThan(0);
  for (const tree of created) {
    for (const text of allText(tree)) {
      for (const dash of LONG_DASHES) expect(text).not.toContain(dash);
      expect(text.toLowerCase()).not.toContain('crypto');
      expect(text.toLowerCase()).not.toContain('paid back');
    }
  }
});


it('shows a QR payment receipt with the sale amount and celebrates the winning tender', () => {
  for (const rail of ['Lightning', 'Cashu'] as const) {
    const tree = show(res({ kind: 'wallet-paid', rail }), jest.fn(), jest.fn());
    expect(textOf(tree, 'result-title')).toBe('PAID');
    expect(textOf(tree, 'result-amount')).toBe('2,100 sats');
    expect(textOf(tree, 'result-body')).toContain(rail);
    expect(has(tree, 'result-celebration')).toBe(true);
    expect(has(tree, 'result-retry')).toBe(false);
    act(() => tree.unmount());
  }
});

it('links an extra Lightning receipt to the existing customer return', async () => {
  const owed = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => { tree = renderer.create(<ResultPanel state={res({ kind: 'lightning-extra' })} send={jest.fn()}
    onActivity={jest.fn()} onReturn={owed} />); });
  expect(has(tree, 'result-celebration')).toBe(false);
  await press(tree, 'result-return');
  expect(owed).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});
