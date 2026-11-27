import React from 'react';
import { AccessibilityInfo, AppState, Text, type AppStateStatus } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { MotionPreference, useMotionAllowed, useMotionEnvironment } from '../src/ui/motion';

function Probe(): React.JSX.Element {
  return <Text>{useMotionAllowed() ? 'moving' : 'still'}</Text>;
}

function mount(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => { tree = renderer.create(<MotionPreference><Probe /></MotionPreference>); });
  return tree;
}

function state(tree: ReactTestRenderer): string {
  return tree.root.findByType(Probe).findByType(Text).props.children;
}

// Use the RN 0.77 Jest preset's real method signatures and default removable subscriptions.
const changes = jest.mocked(AppState.addEventListener);
const subscribePreference: (
  event: 'reduceMotionChanged', listener: (reduced: boolean) => void,
) => { remove: () => void } = AccessibilityInfo.addEventListener;
const preferences = jest.mocked(subscribePreference);
const query = jest.mocked(AccessibilityInfo.isReduceMotionEnabled);
const initialAppState = AppState.currentState;

function motionEvent(reduced: boolean): void {
  const [event, listener] = preferences.mock.calls[0];
  expect(event).toBe('reduceMotionChanged');
  act(() => listener(reduced));
}

function appEvent(next: AppStateStatus): void {
  const [event, listener] = changes.mock.calls[0];
  expect(event).toBe('change');
  AppState.currentState = next;
  act(() => (listener as (value: AppStateStatus) => void)(next));
}

beforeEach(() => {
  jest.clearAllMocks();
  AppState.currentState = 'active';
});
afterEach(() => { AppState.currentState = initialAppState; });

it('defaults to still until the system replies, then follows the live Reduce Motion setting', async () => {
  const tree = mount();
  expect(state(tree)).toBe('still');
  await act(async () => {});
  expect(state(tree)).toBe('moving');
  motionEvent(true);
  expect(state(tree)).toBe('still');
  motionEvent(false);
  expect(state(tree)).toBe('moving');
  act(() => tree.unmount());
});

it('ignores a stale initial response after a newer motion setting event', async () => {
  let answer!: (reduced: boolean) => void;
  query.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  const tree = mount();
  motionEvent(false);
  expect(state(tree)).toBe('moving');
  await act(async () => { answer(true); });
  expect(state(tree)).toBe('moving');
  act(() => tree.unmount());
});

it('keeps an inactive or background app still, including when the preference changes there', async () => {
  AppState.currentState = 'unknown';
  const tree = mount();
  await act(async () => {});
  expect(state(tree)).toBe('still');
  appEvent('active');
  expect(state(tree)).toBe('moving');
  appEvent('inactive');
  expect(state(tree)).toBe('still');
  appEvent('background');
  motionEvent(true);
  motionEvent(false);
  expect(state(tree)).toBe('still');
  appEvent('active');
  expect(state(tree)).toBe('moving');
  act(() => tree.unmount());
});

it('keeps motion off if the preference query fails, then accepts a live event', async () => {
  query.mockRejectedValueOnce(new Error('preference unavailable'));
  const tree = mount();
  await act(async () => {});
  expect(state(tree)).toBe('still');
  motionEvent(false);
  expect(state(tree)).toBe('moving');
  act(() => tree.unmount());
});

it('removes both subscriptions on unmount while the initial query is still pending', async () => {
  let answer!: (reduced: boolean) => void;
  query.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  const tree = mount();
  const appSubscription = changes.mock.results[0].value;
  const motionSubscription = preferences.mock.results[0].value;
  act(() => tree.unmount());
  expect(appSubscription.remove).toHaveBeenCalledTimes(1);
  expect(motionSubscription.remove).toHaveBeenCalledTimes(1);
  await act(async () => { answer(false); });
});


it('records an intervening background when React receives both app-switch events in a single turn', async () => {
  function Scene(): React.JSX.Element {
    const { visibility, reduced, backgroundEpoch } = useMotionEnvironment();
    return <Text>{String(visibility) + '/' + String(reduced) + '/' + backgroundEpoch}</Text>;
  }
  let tree!: ReactTestRenderer;
  await act(async () => { tree = renderer.create(<MotionPreference><Scene /></MotionPreference>); });
  const scene = () => tree.root.findByType(Scene).findByType(Text).props.children;
  const listener = changes.mock.calls[0][1] as (status: AppStateStatus) => void;
  expect(scene()).toBe('active/false/0');
  act(() => { listener('inactive'); listener('active'); });
  expect(scene()).toBe('active/false/0');
  act(() => { listener('background'); listener('background'); listener('active'); });
  expect(scene()).toBe('active/false/1');
  act(() => tree.unmount());
});
