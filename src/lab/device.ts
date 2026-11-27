import type { HttpFetch } from 'cashucard';
import { DEV_BENCH_URL } from '../till/dev-config';
import type { RawFetch } from '../till/http';
import { deviceStoreDeps } from '../till/store/device';
import { DevOnlyError, wipeLabStore } from '../till/store/wipe';
import { openStoredTill } from '../till/stored-till';
import type { LabDeps } from './actions';
import { benchClient } from './bench';
import { parsePlan, type DevPlan } from './plan';

/** React Native's own fetch, called as a plain function. */
export function deviceRawFetch(): RawFetch {
  const native = (globalThis as unknown as { fetch: RawFetch }).fetch;
  return (url, init) => native(url, init);
}

/** The lab's till asks no mint (its sales are invoice-only): every request is refused. */
export const refuseAll: HttpFetch = async () => {
  throw new Error('the journal lab asks no mint');
};

/** The lab's device wiring: the real store, the bench on this Mac. Development builds only. */
export function labDeps(dev: boolean = __DEV__): LabDeps {
  if (!dev) {
    throw new DevOnlyError();
  }
  const store = deviceStoreDeps();
  const perf = (globalThis as unknown as { performance?: { now?: () => number } }).performance;
  return {
    store,
    bench: benchClient(deviceRawFetch(), DEV_BENCH_URL),
    clock: perf && typeof perf.now === 'function' ? () => perf.now!() : () => Date.now(),
    openTill: (names, choice, durability) =>
      openStoredTill(store, { names, choice, durability, http: refuseAll, mints: [] }),
    wipe: (names) => wipeLabStore(store, names, dev),
  };
}

/** The plan for this launch: the self-test when the bench cannot be reached; a lab plan that is wrong throws PlanError.
 * Development builds only. */
export async function fetchDevPlan(raw: RawFetch, bench: string, dev: boolean = __DEV__): Promise<DevPlan> {
  if (!dev) {
    throw new DevOnlyError();
  }
  let v: unknown;
  try {
    v = await benchClient(raw, bench).plan();
  } catch {
    return { mode: 'selftest' };
  }
  return parsePlan(v);
}
