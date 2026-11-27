import React from 'react';
import { Animated } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { useRouteArrival } from '../src/app/route-arrival';
import type { RouteName } from '../src/app/nav';
import { useMotionAllowed } from '../src/ui/motion';

jest.mock('../src/ui/motion', () => ({ useMotionAllowed: jest.fn() }));

function Page({ route, requested }: { route: RouteName | null; requested: boolean }) {
  const style = useRouteArrival(route, requested);
  return <Animated.View testID={route ?? 'opening'} style={style} />;
}

describe('incoming page motion', () => {
  let tree: ReactTestRenderer | undefined;
  const animation = { start: jest.fn(), stop: jest.fn(), reset: jest.fn() };
  const allowed = jest.mocked(useMotionAllowed);

  function show(route: RouteName | null, requested = true) {
    act(() => {
      const page = <Page route={route} requested={requested} />;
      if (tree) tree.update(page);
      else tree = renderer.create(page);
    });
  }

  beforeEach(() => {
    allowed.mockReturnValue(true);
    jest.spyOn(Animated, 'timing').mockReturnValue(animation);
  });

  afterEach(() => {
    act(() => tree?.unmount());
    tree = undefined;
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('enters a new tab once, keeping the first screen and ordinary updates still', () => {
    show(null, false);
    show('sale', false);
    show('sale');
    expect(Animated.timing).not.toHaveBeenCalled();
    show('activity');
    expect(animation.start).toHaveBeenCalledTimes(1);
    expect(Animated.timing).toHaveBeenCalledWith(expect.any(Animated.Value), expect.objectContaining({
      useNativeDriver: true,
      isInteraction: false,
    }));
    show('activity');
    expect(animation.start).toHaveBeenCalledTimes(1);
    expect(tree!.root.findAllByProps({ testID: 'sale' })).toHaveLength(0);
  });

  it('skips automatic resets and cancels the current animation on leaving for a mint form', () => {
    show('sale', false);
    show('settings');
    show('mints');
    expect(animation.stop).toHaveBeenCalledTimes(1);
    show('add-mint');
    show('sale', false);
    expect(animation.start).toHaveBeenCalledTimes(1);
  });

  it('reacts to reduced motion immediately without replaying the current page', () => {
    show('activity', false);
    show('payment');
    allowed.mockReturnValue(false);
    show('payment');
    expect(animation.stop).toHaveBeenCalledTimes(1);
    show('wallet');
    allowed.mockReturnValue(true);
    show('wallet');
    expect(animation.start).toHaveBeenCalledTimes(1);
    show('owed');
    expect(animation.start).toHaveBeenCalledTimes(2);
  });
});
