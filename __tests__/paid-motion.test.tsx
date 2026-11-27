import React from 'react';
import { Animated, AppState, type AppStateStatus } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { PaidCelebration } from '../src/screens/PaidCelebration';
import type { AfterScanSheet } from '../src/till/scan-sheet';
import { useMotionEnvironment } from '../src/ui/motion';

jest.mock('../src/ui/motion', () => ({ useMotionEnvironment: jest.fn() }));
const environment = jest.mocked(useMotionEnvironment);
const previousState = AppState.currentState;

function phone(reduced: boolean | null, visibility: AppStateStatus = 'active', backgroundEpoch = 0) {
  AppState.currentState = visibility;
  environment.mockReturnValue({ reduced, visibility, backgroundEpoch });
}

function sheet() {
  let close: (() => void) | undefined;
  const afterScanSheet: AfterScanSheet = callback => {
    close = callback;
    return () => { close = undefined; };
  };
  return { afterScanSheet, dismiss: () => act(() => close?.()) };
}

function show(afterScanSheet?: AfterScanSheet) {
  let tree!: ReactTestRenderer;
  const render = () => <PaidCelebration afterScanSheet={afterScanSheet} />;
  act(() => { tree = renderer.create(render()); });
  return {
    update: () => act(() => tree.update(render())),
    leave: () => act(() => tree.unmount()),
  };
}

function watchAnimation() {
  const animation = { start: jest.fn(), stop: jest.fn(), reset: jest.fn() };
  const timing = jest.spyOn(Animated, 'timing').mockReturnValue(animation);
  return { ...animation, timing };
}

afterEach(() => {
  AppState.currentState = previousState;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('waits for both the iOS foreground and the NFC dismissal, then plays once', () => {
  phone(false, 'inactive');
  const poses = jest.spyOn(Animated.Value.prototype, 'setValue');
  const motion = watchAnimation();
  const scan = sheet();
  const receipt = show(scan.afterScanSheet);
  expect(poses).toHaveBeenLastCalledWith(0);
  expect(motion.start).not.toHaveBeenCalled();
  phone(false);
  receipt.update();
  expect(poses).toHaveBeenLastCalledWith(0);
  expect(poses).not.toHaveBeenCalledWith(1);
  expect(motion.start).not.toHaveBeenCalled();
  scan.dismiss();
  expect(motion.start).toHaveBeenCalledTimes(1);
  receipt.update();
  scan.dismiss();
  expect(motion.start).toHaveBeenCalledTimes(1);
  receipt.leave();
  expect(motion.stop).toHaveBeenCalledTimes(1);
});

it('handles an already dismissed sheet and an initially unknown visibility or preference', () => {
  phone(null, 'unknown');
  const motion = watchAnimation();
  const alreadyClear: AfterScanSheet = callback => { callback(); return () => {}; };
  const receipt = show(alreadyClear);
  phone(null);
  receipt.update();
  expect(motion.start).not.toHaveBeenCalled();
  phone(false);
  receipt.update();
  expect(motion.start).toHaveBeenCalledTimes(1);
  receipt.leave();
});

it('shows the static receipt in reduced motion and never replays on a subsequent preference change', () => {
  phone(true);
  const motion = watchAnimation();
  const receipt = show();
  phone(false);
  receipt.update();
  expect(motion.start).not.toHaveBeenCalled();
  receipt.leave();
});

it('cancels a running animation on Reduce Motion and shows the finished stamp immediately', () => {
  phone(false);
  const motion = watchAnimation();
  const receipt = show();
  expect(motion.start).toHaveBeenCalledTimes(1);
  const settle = jest.spyOn(motion.timing.mock.calls[0][0], 'setValue');
  phone(true);
  receipt.update();
  expect(motion.stop).toHaveBeenCalledTimes(1);
  expect(settle).toHaveBeenCalledWith(1);
  phone(false);
  receipt.update();
  expect(motion.start).toHaveBeenCalledTimes(1);
  receipt.leave();
});

it('cannot celebrate after navigation or an intervening real app switch, even when foreground events are batched', () => {
  phone(false);
  const motion = watchAnimation();
  const scan = sheet();
  const departed = show(scan.afterScanSheet);
  departed.leave();
  scan.dismiss();
  const receipt = show(scan.afterScanSheet);
  phone(false, 'active', 1);
  receipt.update();
  scan.dismiss();
  expect(motion.start).not.toHaveBeenCalled();
  receipt.leave();
});

it('does not replay a receipt on return from unrelated authentication or an extended interruption', () => {
  jest.useFakeTimers();
  phone(false, 'inactive');
  const motion = watchAnimation();
  const ordinary = show();
  phone(false);
  ordinary.update();
  expect(motion.start).not.toHaveBeenCalled();
  ordinary.leave();
  const scan = sheet();
  const old = show(scan.afterScanSheet);
  jest.advanceTimersByTime(9000);
  scan.dismiss();
  expect(motion.start).not.toHaveBeenCalled();
  old.leave();
});


it('retires a pending NFC cue immediately if Reduce Motion is enabled while the sheet is closing', () => {
  phone(false);
  const motion = watchAnimation();
  const scan = sheet();
  const receipt = show(scan.afterScanSheet);
  phone(true);
  receipt.update();
  scan.dismiss();
  phone(false);
  receipt.update();
  scan.dismiss();
  expect(motion.start).not.toHaveBeenCalled();
  receipt.leave();
});
