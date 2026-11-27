import React, { createContext, useContext, useEffect, useState } from 'react';
import { AccessibilityInfo, AppState, type AppStateStatus } from 'react-native';

interface MotionEnvironment {
  reduced: boolean | null;
  visibility: AppStateStatus | null;
  /** A real app switch discards any pending receipt, even if foreground changes are batched. */
  backgroundEpoch: number;
}
const Motion = createContext<MotionEnvironment>({ reduced: null, visibility: null, backgroundEpoch: 0 });

export function MotionPreference({children}: {children: React.ReactNode}): React.JSX.Element {
  const [reduced, setReduced] = useState<boolean | null>(null);
  const [scene, setScene] = useState({ visibility: AppState.currentState, backgroundEpoch: 0 });
  useEffect(() => {
    let live = true;
    let notified = false;
    function visibilityChanged(visibility: AppStateStatus) {
      setScene(previous => previous.visibility === visibility ? previous : {
        visibility,
        backgroundEpoch: previous.backgroundEpoch + (visibility === 'background' ? 1 : 0),
      });
    }
    const foreground = AppState.addEventListener('change', visibilityChanged);
    visibilityChanged(AppState.currentState);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
      notified = true;
      if (live) setReduced(value);
    });
    AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (live && !notified) setReduced(value);
    }, () => {});
    return () => {
      live = false;
      subscription.remove();
      foreground.remove();
    };
  }, []);
  return <Motion.Provider value={{ ...scene, reduced }}>{children}</Motion.Provider>;
}

export function useMotionEnvironment(): MotionEnvironment {
  return useContext(Motion);
}

export function useMotionAllowed(): boolean {
  const { reduced, visibility } = useMotionEnvironment();
  return reduced === false && visibility === 'active';
}
