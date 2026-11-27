import { AppState, Platform } from 'react-native';
import type { DeviceGate, GateReason } from './gate';
import { guarded } from './guarded';

export type CredentialSheetEvent = 'open' | 'verified' | 'dismissed';
// Native owner verification and the host's active notification may cross on the bridge.
// The deadline also runs on the wall clock when the OS suspends JavaScript timers.
const RESUME_MS = 1500;

/** A native credential Activity can cover the app on Android. Wait for the same
 * foreground screen before allowing an authorized wallet action to start. */
export async function foregroundWalletAction(
  gate: DeviceGate,
  reason: GateReason,
  lifetime: AbortSignal,
  interruptedMessage: string,
  action: (stillInFront: () => boolean) => Promise<string>,
  onAndroidSheet?: (event: CredentialSheetEvent) => void,
): Promise<string> {
  let state = AppState.currentState;
  if (lifetime.aborted || state !== 'active') return interruptedMessage;
  let stage: 'checking-device' | 'auth' | 'resuming' | 'authorized' = 'checking-device';
  let interrupted = false;
  let wake: (() => void) | undefined;
  const subscription = AppState.addEventListener('change', next => {
    state = next;
    const coveredDuringRead = stage === 'authorized' && next !== 'active';
    const androidPrompt = Platform.OS === 'android' && stage === 'auth';
    if (coveredDuringRead || (next === 'background' && !androidPrompt)) interrupted = true;
    wake?.();
  });
  const abort = () => { interrupted = true; wake?.(); };
  lifetime.addEventListener('abort', abort);
  const mayShow = () => !interrupted && !lifetime.aborted && state === 'active';
  let androidSheetOpen = false;
  try {
    const prompt: DeviceGate = {
      available: () => gate.available(),
      check: async words => {
        if (!mayShow()) return { ok: false, why: 'cancelled', words: interruptedMessage };
        stage = 'auth';
        if (Platform.OS === 'android' && onAndroidSheet) {
          androidSheetOpen = true;
          onAndroidSheet('open');
        }
        return gate.check(words);
      },
    };
    const checked = await guarded(prompt, reason, async () => {
      stage = 'resuming';
      if (!interrupted && !lifetime.aborted && state !== 'active') {
        const until = Date.now() + RESUME_MS;
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { interrupted = true; resolve(); }, RESUME_MS);
          wake = () => {
            if (state !== 'active' && !interrupted) return;
            if (Date.now() >= until) interrupted = true;
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
      }
      if (!mayShow()) return interruptedMessage;
      stage = 'authorized';
      if (androidSheetOpen) {
        androidSheetOpen = false;
        onAndroidSheet?.('verified');
      }
      return action(mayShow);
    });
    return checked.ok ? checked.value : checked.words;
  } finally {
    if (androidSheetOpen) onAndroidSheet?.('dismissed');
    lifetime.removeEventListener('abort', abort);
    subscription.remove();
  }
}
