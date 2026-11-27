import { AppState, type AppStateStatus } from 'react-native';
import type { ScheduleSource } from '../till/settle';

/** In front is any state but the back: iOS's brief 'inactive' (the owner check's prompt, the notification shade) is
 * not leaving. */
export function inFront(s: AppStateStatus | null | undefined): boolean {
  return s !== 'background';
}

export function payoutForeground(): boolean {
  return AppState.currentState === 'active';
}

/** The settle schedule's ear on React Native's AppState, and the phone's own timers. */
export function deviceSchedule(): ScheduleSource {
  return {
    active: () => inFront(AppState.currentState),
    onActive: (l) => {
      const sub = AppState.addEventListener('change', (s) => l(inFront(s)));
      return () => sub.remove();
    },
    timers: {
      set: (f, ms) => setTimeout(f, ms),
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
  };
}
