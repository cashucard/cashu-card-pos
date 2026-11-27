import { GATE_REASONS, GATE_WORDS, type DeviceGate, type GateReason, type GateResult } from './gate';

/** What guarded() answers: the action's value once the check passed, or why the check did not. */
export type Guarded<T> = { ok: true; value: T } | { ok: false; why: 'unavailable' | 'cancelled' | 'failed'; words: string };

/** f runs only once the phone's owner check passed for this reason. A phone with no passcode (available() false or
 * rejecting) is 'unavailable' with GATE_WORDS.unavailable, and the check is not asked. A refused check is answered as
 * it came. f's own rejection is passed on. */
export async function guarded<T>(gate: DeviceGate, reason: GateReason, f: () => Promise<T>): Promise<Guarded<T>> {
  let available: boolean;
  try {
    available = await gate.available();
  } catch {
    available = false;
  }
  if (!available) {
    return { ok: false, why: 'unavailable', words: GATE_WORDS.unavailable };
  }
  let result: GateResult;
  try {
    result = await gate.check(GATE_REASONS[reason]);
  } catch {
    return { ok: false, why: 'failed', words: GATE_WORDS.failed };
  }
  if (!result.ok) {
    return { ok: false, why: result.why, words: result.words };
  }
  return { ok: true, value: await f() };
}

/** A check that asks nothing: for development builds only (the development wiring refuses outside development).
 * 'allow' passes every check; 'deny' answers { ok: false, why: 'cancelled', words: GATE_WORDS.cancelled }.
 * available() is true. Every reason asked is kept in `asked`. */
export function benchGate(answer: 'allow' | 'deny'): DeviceGate & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    available: async () => true,
    check: async (reason: string): Promise<GateResult> => {
      asked.push(reason);
      if (answer === 'allow') {
        return { ok: true };
      }
      return { ok: false, why: 'cancelled', words: GATE_WORDS.cancelled };
    },
  };
}

/** The result of a Guarded, as the GateResult a state machine takes. */
export function gateResultOf<T>(g: Guarded<T>): GateResult {
  if (g.ok) {
    return { ok: true };
  }
  return { ok: false, why: g.why, words: g.words };
}
