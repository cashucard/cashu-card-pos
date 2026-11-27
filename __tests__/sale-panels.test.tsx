import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AccessibilityInfo, ScrollView, StyleSheet, Text, useWindowDimensions } from 'react-native';
import { stageWords, type CardConfirmation } from 'cashucard';
import {
  ConfirmPanel,
  KeypadPanel,
  OpeningPanel,
  PinPanel,
  SALE_WORDS,
  sheetLines,
  TapPanel,
  wrongPinWords,
} from '../src/screens/SalePanels';
import type { PinState, TapState } from '../src/till/sale-machine';
import { CONFIRMATION } from './helpers/fake-till';
import { allText, has, ids, isDisabled, nodes, press, textOf } from './helpers/render';

/** The card of the fake till: 14 plus the mint's fee of 1 is 15, off a balance of 15. */
const C: CardConfirmation = { ...CONFIRMATION };

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

/** A button's label: the kit's Button carries it as a prop. */
function labelOf(tree: ReactTestRenderer, id: string): string {
  const found = nodes(tree, id);
  if (found.length === 0) {
    throw new Error('no node ' + id);
  }
  const label: unknown = found[0].props.label;
  return typeof label === 'string' ? label : '';
}

function tapState(over: Partial<TapState>): TapState {
  return { kind: 'tap', sats: 2100, saleId: 'sale-1', tap: 1, card: false, words: null, ending: null, ...over };
}

function pinState(over: Partial<PinState>): PinState {
  return {
    kind: 'pin',
    sats: 2100,
    saleId: 'sale-1',
    count: 0,
    why: 'allowance',
    wrong: false,
    tries: null,
    from: 'confirm',
    back: null,
    ...over,
  };
}

it('the keypad shows the amount and charges it', async () => {
  const send = jest.fn();
  const onBack = jest.fn();
  const tree = render(<KeypadPanel digits="2100" mints={['https://mint.test']} send={send} onBack={onBack} />);
  expect(textOf(tree, 'sale-title')).toBe('New sale');
  expect(textOf(tree, 'sale-amount')).toBe('2,100 sats');
  expect(labelOf(tree, 'sale-charge')).toBe('Charge 2,100 sats');
  expect(isDisabled(tree, 'sale-charge')).toBe(false);
  expect(textOf(tree, 'sale-mints')).toBe('Cards from: mint.test');
  expect(has(tree, 'sale-note')).toBe(false);
  const amount = tree.root.findAllByType(Text).find(n => n.props.testID === 'sale-amount')!;
  expect(amount.props.accessibilityLabel).toBe('2,100 sats');
  expect(amount.props.accessibilityHint).toBe('Sale limit is 1,000,000 sats.');
  await press(tree, 'key-7');
  expect(send).toHaveBeenLastCalledWith({ type: 'digit', d: '7' });
  await press(tree, 'key-back');
  await press(tree, 'key-clear');
  await press(tree, 'sale-charge');
  expect(send.mock.calls).toEqual([
    [{ type: 'digit', d: '7' }],
    [{ type: 'key-back' }],
    [{ type: 'key-clear' }],
    [{ type: 'charge' }],
  ]);
  await press(tree, 'nav-back');
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(4);
});

it('places Check balance directly below Charge, with or without an entered amount', async () => {
  for (const digits of ['', '5']) {
    const onBalance = jest.fn();
    const send = jest.fn();
    const tree = render(<KeypadPanel digits={digits} mints={[]} send={send} onBalance={onBalance} />);
    const all = ids(tree);
    expect(all[all.indexOf('sale-charge') + 1]).toBe('sale-balance');
    expect(isDisabled(tree, 'sale-balance')).toBe(false);
    expect(all).not.toContain('sale-card-actions');
    expect(all).not.toContain('sale-offline');
    expect(all).not.toContain('sale-topup');
    await press(tree, 'sale-balance');
    expect(onBalance).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  }
});

it('keeps an entered price visible when a mint stops taking cards', () => {
  const send = jest.fn();
  const tree = render(<KeypadPanel digits="15" mints={[]} send={send} canSell={false} />);
  expect(textOf(tree, 'sale-amount')).toBe('15 sats');
  expect(isDisabled(tree, 'sale-charge')).toBe(true);
  nodes(tree, 'sale-charge')[0].props.onPress();
  expect(send).not.toHaveBeenCalled();
  expect(has(tree, 'nav-back')).toBe(false);
});

it('keeps compact keypad targets at 48 points and both actions visible to the scroll view', () => {
  const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions')
    .mockReturnValue({ width: 375, height: 667, scale: 2, fontScale: 1 } satisfies ReturnType<typeof useWindowDimensions>);
  try {
    const tree = render(<KeypadPanel digits="" mints={['https://mint.test']} send={jest.fn()} onBalance={jest.fn()} />);
    const scroll = tree.root.findByType(ScrollView);
    const key = scroll.findAll(n => n.props.testID === 'key-1' && typeof n.props.style === 'function')[0];
    expect(StyleSheet.flatten(key.props.style({ pressed: false })).minHeight).toBe(48);
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle).paddingBottom).toBe(8);
    expect(scroll.findAll(n => n.props.testID === 'sale-charge').length).toBeGreaterThan(0);
    expect(scroll.findAll(n => n.props.testID === 'sale-balance').length).toBeGreaterThan(0);
  } finally {
    dimensions.mockRestore();
  }
});

it('keeps the maximum amount and Charge in the scrolling sale at 320 points and double text', () => {
  const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions')
    .mockReturnValue({ width: 320, height: 568, scale: 2, fontScale: 2 } satisfies ReturnType<typeof useWindowDimensions>);
  try {
    const tree = render(<KeypadPanel digits="1000000" mints={['https://testnut.cashu.space']} send={jest.fn()} onBalance={jest.fn()} />);
    const scroll = tree.root.findByType(ScrollView);
    const number = scroll.findAllByType(Text).find(n => n.props.testID === 'sale-amount')!;
    expect(number.props.accessibilityLabel).toBe('1,000,000 sats');
    const unit = number.findAllByType(Text).find(n => n.props.children === ' sats')!;
    expect(StyleSheet.flatten(unit.props.style).fontSize).toBeLessThan(StyleSheet.flatten(number.props.style).fontSize);
    expect(number.props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(number.props.style).fontSize * 2 * 0.68 * '1,000,000'.length).toBeLessThanOrEqual(244);
    expect(scroll.findAll(n => n.props.testID === 'sale-charge').length).toBeGreaterThan(0);
    expect(scroll.findAll(n => n.props.testID === 'sale-balance').length).toBeGreaterThan(0);
    expect(isDisabled(tree, 'sale-charge')).toBe(false);
  } finally {
    dimensions.mockRestore();
  }
});

it('shows the pre-tap fee cap and the maximum approved total before the reader opens', async () => {
  const send = jest.fn();
  const tree = render(<PinPanel state={{ kind: 'preflight', count: 4, sats: 15 }} send={send} />);
  expect(textOf(tree, 'preflight-price')).toBe('15 sats');
  expect(textOf(tree, 'preflight-limit')).toContain('Mint fee up to 1 sat');
  expect(labelOf(tree, 'pin-ok')).toBe('Pay up to 16 sats');
  expect(textOf(tree, 'pin-dots')).toBe('●●●●');
  expect(nodes(tree, 'pin-dots')[0].props.accessibilityLabel).toBe('4 PIN digits entered');
  await press(tree, 'pin-ok');
  expect(send).toHaveBeenCalledWith({ type: 'pin-ok' });
});

it('accepts PIN digits while checking connectivity and waits before charging', async () => {
  const send = jest.fn();
  const tree = render(<PinPanel state={{ kind: 'preflight', count: 4, sats: 15, mode: 'detecting' }} send={send} />);
  expect(textOf(tree, 'preflight-limit')).toContain('Checking');
  expect(isDisabled(tree, 'pin-ok')).toBe(true);
  expect(isDisabled(tree, 'preflight-reviewed')).toBe(true);
  await press(tree, 'pin-key-1');
  expect(send).toHaveBeenCalledWith({ type: 'pin-digit', d: '1' });
});

it('announces a switch to offline checkout once while the holder enters their PIN', () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  const send = jest.fn();
  const panel = (mode: 'detecting' | 'offline', count: number) =>
    <PinPanel state={{ kind: 'preflight', sats: 15, mode, count }} send={send} />;
  try {
    const tree = render(panel('detecting', 0));
    act(() => tree.update(panel('offline', 0)));
    act(() => tree.update(panel('offline', 1)));
    expect(announce.mock.calls).toEqual([['Offline payment. Enter your card PIN before tapping.']]);
  } finally {
    announce.mockRestore();
  }
});

it('asks for a PIN and discloses exact notes and deferred mint confirmation offline', () => {
  for (const count of [0, 3, 4, 8]) {
    const tree = render(<PinPanel state={{ kind: 'preflight', count, sats: 15, mode: 'offline' }} send={jest.fn()} />);
    expect(textOf(tree, 'pin-title')).toBe('Offline payment');
    expect(textOf(tree, 'preflight-limit')).toMatch(/exact notes.+1 sat.+back online/);
    expect(labelOf(tree, 'pin-ok')).toBe('Pay up to 16 sats');
    expect(isDisabled(tree, 'pin-ok')).toBe(count < 4);
    expect(has(tree, 'preflight-reviewed')).toBe(false);
    expect(textOf(tree, 'pin-why')).not.toContain('leave it blank');
  }
});

it('no charge at 0 or over the most', () => {
  const send = jest.fn();
  const zero = render(<KeypadPanel digits="" mints={[]} send={send} onBack={jest.fn()} />);
  expect(labelOf(zero, 'sale-charge')).toBe('Charge');
  expect(isDisabled(zero, 'sale-charge')).toBe(true);
  expect(has(zero, 'sale-mints')).toBe(false);
  const over = render(<KeypadPanel digits="1000001" mints={[]} send={send} onBack={jest.fn()} />);
  expect(isDisabled(over, 'sale-charge')).toBe(true);
  expect(textOf(over, 'sale-note')).toBe(SALE_WORDS.most);
  const near = render(<KeypadPanel digits="100000" mints={[]} send={send} />);
  expect(textOf(near, 'sale-note')).toBe(SALE_WORDS.most);
  const most = render(<KeypadPanel digits="1000000" mints={[]} send={send} onBack={jest.fn()} />);
  expect(labelOf(most, 'sale-charge')).toBe('Charge 1,000,000 sats');
  expect(isDisabled(most, 'sale-charge')).toBe(false);
});

it('the tap screen waits for a card and can be cancelled', async () => {
  const send = jest.fn();
  const tree = render(<TapPanel state={tapState({ tap: 1, card: false })} send={send} />);
  expect(textOf(tree, 'tap-title')).toBe('Hold card at top of iPhone');
  expect(textOf(tree, 'tap-amount')).toBe('2,100 sats');
  expect(textOf(tree, 'tap-line')).toBe('Waiting for a card');
  await press(tree, 'tap-cancel');
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenLastCalledWith({ type: 'cancel' });
  const second = render(<TapPanel state={tapState({ tap: 2, card: false })} send={send} />);
  expect(textOf(second, 'tap-title')).toBe('Hold the same card again');
});

it('with a card in the field the stages show, and there is no Cancel', () => {
  const send = jest.fn();
  const signing = render(<TapPanel state={tapState({ card: true, words: stageWords('signing', { seconds: 3 }) })} send={send} />);
  expect(textOf(signing, 'tap-title')).toBe('KEEP HOLDING · 3 s');
  expect(textOf(signing, 'tap-line')).toBe('Signing');
  expect(has(signing, 'tap-cancel')).toBe(false);
  const quiet = render(<TapPanel state={tapState({ card: true, words: stageWords('confirming') })} send={send} />);
  expect(has(quiet, 'tap-line')).toBe(false);
  const nothing = render(<TapPanel state={tapState({ card: true, words: null })} send={send} />);
  expect(textOf(nothing, 'tap-title')).toBe('Hold the card still');
  expect(has(nothing, 'tap-cancel')).toBe(false);
});

it('stopping says so, with no button', () => {
  const send = jest.fn();
  const tree = render(<TapPanel state={{ kind: 'stopping', sats: 2100, saleId: 'sale-1', ending: 'cancel' }} send={send} />);
  expect(textOf(tree, 'tap-title')).toBe('Stopping');
  expect(textOf(tree, 'tap-amount')).toBe('2,100 sats');
  expect(textOf(tree, 'tap-line')).toBe('Stopping the sale.');
  expect(has(tree, 'tap-cancel')).toBe(false);
});

it('the sheet says what the card pays', async () => {
  const send = jest.fn();
  const tree = render(<ConfirmPanel c={C} send={send} />);
  expect(textOf(tree, 'sheet-pays')).toBe('THE CARD PAYS');
  expect(textOf(tree, 'sheet-total')).toBe('15 sats');
  expect(textOf(tree, 'sheet-price')).toBe('Price: 14 sats');
  expect(textOf(tree, 'sheet-fee')).toBe("The mint's fee: 1 sat");
  expect(textOf(tree, 'sheet-balance')).toBe('On the card: 15 sats');
  expect(textOf(tree, 'sheet-mint')).toBe('Mint: mint.test');
  expect(textOf(tree, 'sheet-pin')).toBe(SALE_WORDS.pinNeed);
  expect(textOf(tree, 'sheet-no')).toBe('Saying no takes nothing.');
  expect(labelOf(tree, 'sheet-pay')).toBe('Enter the PIN and pay');
  expect(has(tree, 'sheet-kept')).toBe(false);
  expect(has(tree, 'sheet-change')).toBe(false);
  expect(has(tree, 'sheet-leftover')).toBe(false);
  expect(has(tree, 'sheet-unchecked')).toBe(false);
  await press(tree, 'sheet-pay');
  expect(send).toHaveBeenLastCalledWith({ type: 'pay' });
  await press(tree, 'sheet-decline');
  expect(send).toHaveBeenLastCalledWith({ type: 'decline' });
});

it("the sheet names what is kept, the card's own change and what was not counted", () => {
  const send = jest.fn();
  const c: CardConfirmation = { ...C, kept: 1, cardChange: 11, unchecked: 5, pinNeeded: false, pinFor: null };
  const tree = render(<ConfirmPanel c={c} send={send} />);
  expect(textOf(tree, 'sheet-kept')).toBe('Kept by the till: 1 sat (too small to give back)');
  expect(textOf(tree, 'sheet-change')).toBe('The card makes its own change: 11 sats, written back in this tap');
  expect(textOf(tree, 'sheet-unchecked')).toBe('Not counted: 5 sats the till could not check');
  expect(has(tree, 'sheet-pin')).toBe(false);
  expect(labelOf(tree, 'sheet-pay')).toBe('Pay');
  expect(sheetLines(c).map((line) => line.id)).toEqual([
    'sheet-total',
    'sheet-price',
    'sheet-fee',
    'sheet-kept',
    'sheet-change',
    'sheet-balance',
    'sheet-unchecked',
    'sheet-mint',
    'sheet-no',
  ]);
});

it('the PIN pad shows dots, never digits', async () => {
  const send = jest.fn();
  const three = render(<PinPanel state={pinState({ count: 3, why: 'allowance', wrong: false })} send={send} />);
  expect(textOf(three, 'pin-title')).toBe("Enter the card's PIN");
  expect(textOf(three, 'pin-why')).toBe("This payment is over the card's no-PIN limit.");
  expect(textOf(three, 'pin-dots')).toBe('●●●');
  expect(has(three, 'pin-wrong')).toBe(false);
  expect(isDisabled(three, 'pin-ok')).toBe(true);
  await press(three, 'pin-key-5');
  expect(send).toHaveBeenLastCalledWith({ type: 'pin-digit', d: '5' });
  const four = render(<PinPanel state={pinState({ count: 4, why: 'allowance', wrong: false })} send={send} />);
  expect(textOf(four, 'pin-dots')).toBe('●●●●');
  expect(isDisabled(four, 'pin-ok')).toBe(false);
  await press(four, 'pin-back');
  await press(four, 'pin-cancel');
  await press(four, 'pin-ok');
  expect(send.mock.calls.slice(-3)).toEqual([[{ type: 'pin-back' }], [{ type: 'pin-cancel' }], [{ type: 'pin-ok' }]]);
  for (const tree of [three, four]) {
    for (const line of allText(tree)) {
      expect(/[0-9][\s\S]*[0-9]/.test(line)).toBe(false);
    }
  }
});

it('a wrong PIN says how many tries are left', () => {
  const send = jest.fn();
  expect(wrongPinWords(2)).toBe('Wrong PIN. 2 tries left.');
  expect(wrongPinWords(1)).toBe('Wrong PIN. 1 try left.');
  expect(wrongPinWords(null)).toBe('Wrong PIN. Try again.');
  const two = render(<PinPanel state={pinState({ wrong: true, tries: 2 })} send={send} />);
  expect(textOf(two, 'pin-wrong')).toBe('Wrong PIN. 2 tries left.');
  const one = render(<PinPanel state={pinState({ wrong: true, tries: 1 })} send={send} />);
  expect(textOf(one, 'pin-wrong')).toBe('Wrong PIN. 1 try left.');
  const none = render(<PinPanel state={pinState({ wrong: true, tries: null })} send={send} />);
  expect(textOf(none, 'pin-wrong')).toBe('Wrong PIN. Try again.');
  const recover = render(<PinPanel state={pinState({ why: 'recover' })} send={send} />);
  expect(textOf(recover, 'pin-why')).toBe('The card needs its PIN to finish a payment it started.');
});

it('no panel uses a long dash, the word crypto, or paid back', () => {
  render(<OpeningPanel sats={2100} send={() => undefined} />);
  expect(created.length).toBeGreaterThan(0);
  for (const tree of created) {
    for (const line of allText(tree)) {
      expect(line.includes('—')).toBe(false);
      expect(line.includes('–')).toBe(false);
      expect(/crypto|paid back/i.test(line)).toBe(false);
    }
  }
});
