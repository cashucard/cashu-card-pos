import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Easing } from 'react-native';
import { useMotionAllowed } from '../ui/motion';
import type { RouteName } from './nav';

export function isDetailWithArrival(route: RouteName): boolean {
  return ['settings', 'backups', 'about', 'payment', 'card-balance', 'card-top-up', 'topup-receipts', 'offline-settings'].includes(route);
}

/** Animate the new page in place. Navigation never waits for the motion and never retains the old page. */
export function useRouteArrival(route: RouteName | null, requested: boolean) {
  const allowed = useMotionAllowed();
  const previous = useRef<RouteName | null>(null);
  const [progress] = useState(() => new Animated.Value(1));

  useLayoutEffect(() => {
    const changed = previous.current !== null && previous.current !== route;
    previous.current = route;
    if (!changed || !allowed || !requested || !route || AppState.currentState === 'background') return;
    const tab = route === 'sale' || route === 'activity' || route === 'wallet' || route === 'owed';
    if (!tab && !isDetailWithArrival(route)) return;

    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
      isInteraction: false,
    });
    animation.start();
    return () => {
      animation.stop();
      progress.setValue(1);
    };
  }, [route, allowed, requested, progress]);

  const style = useMemo(() => ({
    opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }),
    transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
  }), [progress]);
  return allowed ? style : undefined;
}
