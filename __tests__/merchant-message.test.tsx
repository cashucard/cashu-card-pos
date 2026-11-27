import React from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { MerchantMessage } from '../src/screens/MerchantPanel';

let tree: ReactTestRenderer | undefined;
async function show(words: string) {
  await act(async () => {
    const page = <MerchantMessage id="wallet-message">{words}</MerchantMessage>;
    if (tree) tree.update(page);
    else tree = renderer.create(page);
  });
}
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

test('VoiceOver announces each new status once, ignoring stale and removed messages', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  let answer!: (enabled: boolean) => void;
  const enabled = jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
  const speak = jest.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions').mockImplementation(() => {});
  await show('Your token is ready to share.');
  await show('Your token is ready to share.');
  enabled.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  await show('The mint is processing the payment.');
  await show('The mint confirmed redemption.');
  await act(async () => { answer(true); });
  enabled.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  await show('Please refresh.');
  act(() => tree!.unmount());
  tree = undefined;
  await act(async () => { answer(true); });
  expect(speak.mock.calls).toEqual([
    ['Your token is ready to share.', { queue: true }],
    ['The mint confirmed redemption.', { queue: true }],
  ]);
});

test.each([['ios', false], ['android', true]] as const)(
  '%s with screen reader enabled=%s leaves explicit announcements off', async (os, enabled) => {
    jest.replaceProperty(Platform, 'OS', os);
    jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(enabled);
    const speak = jest.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions').mockImplementation(() => {});
    await show('Written to the card: 2 sats.');
    expect(speak).not.toHaveBeenCalled();
    expect(tree!.root.findAllByType(View).some(n => n.props.accessibilityLiveRegion === 'polite')).toBe(true);
  },
);
