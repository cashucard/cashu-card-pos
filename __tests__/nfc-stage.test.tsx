import React from 'react';
import { Animated, Platform, SafeAreaView, ScrollView, StyleSheet, Text } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { stageWords } from 'cashucard';
import { TapPanel } from '../src/screens/SalePanels';
import { NfcStage } from '../src/screens/NfcStage';
import { SALE_MOST, type TapState } from '../src/till/sale-machine';
import * as motion from '../src/ui/motion';
import { has, nodes, textOf } from './helpers/render';

const waiting: TapState = { kind: 'tap', sats: SALE_MOST, saleId: 'fixture', tap: 1, card: false, words: null, ending: null };
let tree: ReactTestRenderer | undefined;
function show(state: TapState) {
  act(() => {
    const page = <TapPanel state={state} send={() => {}} />;
    if (tree) tree.update(page);
    else tree = renderer.create(page);
  });
  return tree!;
}
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  jest.restoreAllMocks();
});

test.each([
  ['Max', { width: 430, height: 932, scale: 3, fontScale: 1 }],
  ['small phone with large text', { width: 320, height: 568, scale: 2, fontScale: 2 }],
])('keeps the sale amount, instruction, progress, and illustration inside the upper safe area on %s', (_device, dims) => {
  jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue(dims);
  const first = show(waiting);
  const top = () => first.root.findAllByType(SafeAreaView).find(v => v.props.testID === 'nfc-top-half')!;
  expect(StyleSheet.flatten(top().props.style).height).toBe('50%');
  const heading = top().findAllByType(Text).find(n => n.props.testID === 'tap-title')!;
  expect(heading.props.accessibilityLabel).toBe(heading.props.children);
  if (typeof dims !== 'string' && dims.fontScale > 1) {
    expect(heading.props.adjustsFontSizeToFit).toBe(true);
    expect(heading.props.numberOfLines).toBe(2);
  }
  expect(top().findByType(ScrollView).props.contentInsetAdjustmentBehavior).toBe('never');
  for (const id of ['tap-amount', 'tap-title', 'tap-line', 'nfc-contact-guide']) {
    expect(top().findAll(n => n.props.testID === id).length).toBeGreaterThan(0);
  }
  expect(top().findAllByType(Text).some(n => n.props.accessibilityLabel === '1,000,000 sats')).toBe(true);
  show({ ...waiting, tap: 2 });
  expect(textOf(first, 'tap-title')).toBe('Hold the same card again');
  show({ ...waiting, card: true, words: stageWords('writing-change', { i: 1, n: 3 }) });
  expect(top().findAllByType(Text).some(n => n.props.children === 'Writing 1 of 3')).toBe(true);
  expect(first.root.findByType(NfcStage).props.gesture).toBe('hold');
  expect(has(first, 'tap-cancel')).toBe(false);
  show({ ...waiting, card: true, words: stageWords('remove') });
  expect(first.root.findByType(NfcStage).props.gesture).toBe('remove');
});

test('keeps Android on its existing reader layout and Core NFC waiting on the queue off-screen', () => {
  const android = jest.replaceProperty(Platform, 'OS', 'android');
  const first = show(waiting);
  expect(has(first, 'nfc-top-half')).toBe(false);
  expect(textOf(first, 'tap-title')).toBe('Hold the card to the back of the phone');
  expect(nodes(first, 'tap-cancel')[0].props.disabled).not.toBe(true);
  android.restore();
  show({ ...waiting, queued: true });
  expect(has(first, 'nfc-top-half')).toBe(false);
  expect(textOf(first, 'tap-title')).toBe('One moment');
});

test('keeps the hold cue running while the system scanner is visible, stopping for reduced motion or background', () => {
  const pref = jest.spyOn(motion, 'useMotionEnvironment').mockReturnValue({ reduced: false, visibility: 'inactive', backgroundEpoch: 0 });
  const loop = { start: jest.fn(), stop: jest.fn(), reset: jest.fn() };
  const repeat = jest.spyOn(Animated, 'loop').mockReturnValue(loop);
  const state = { ...waiting, card: true, words: stageWords('signing', { seconds: 3 }) };
  show(state);
  show({ ...state, words: stageWords('signing', { seconds: 4 }) });
  expect(loop.start).toHaveBeenCalledTimes(1);
  expect(repeat.mock.calls[0]).toHaveLength(1);
  pref.mockReturnValue({ reduced: true, visibility: 'inactive', backgroundEpoch: 0 });
  show(state);
  expect(loop.stop).toHaveBeenCalledTimes(1);
  pref.mockReturnValue({ reduced: false, visibility: 'background', backgroundEpoch: 1 });
  expect(textOf(show(state), 'tap-line')).toBe('Signing');
  expect(loop.start).toHaveBeenCalledTimes(1);
});
