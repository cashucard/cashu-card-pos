import type { HttpFetch } from 'cashucard';
import { DevOnlyError } from '../till/store/wipe';

declare const __DEV__: boolean;

/** The bench plan's switches for the test mint (development only). Counters: each use takes one off. */
export interface DevMintFaults {
  /** the next N swaps: sent to the mint, and its answer thrown away */
  dropSwaps: number;
  /** after a dropped swap the mint answers nothing at all for this long, ms */
  downMs: number;
  /** the next N restores (POST /v1/restore) answer that the mint signed nothing */
  hideRestores: number;
}
export const DROPPED_SWAP_MESSAGE = "development: the mint's answer to the swap was lost";
export const MINT_DOWN_MESSAGE = 'development: the mint does not answer';
/** A restore's answer when the mint signed none of the outputs asked. */
export const NOTHING_RESTORED = '{"outputs":[],"signatures":[]}';

/** A URL's path: what follows the host, without the query or fragment; '' when it has none. */
export function pathOf(url: string): string {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*([^?#]*)/.exec(url);
  return m === null ? '' : m[1];
}

/** The mint fetch with the faults applied; DevOnlyError outside development, before anything else. */
export function faultyHttp(
  inner: HttpFetch,
  faults: DevMintFaults,
  now: () => number,
  dev: boolean = __DEV__,
): HttpFetch {
  if (!dev) {
    throw new DevOnlyError();
  }
  let downUntil = 0;
  return async (url, init) => {
    if (now() < downUntil) {
      throw new Error(MINT_DOWN_MESSAGE);
    }
    const path = pathOf(url);
    if (init.method === 'POST' && path === '/v1/restore' && faults.hideRestores > 0) {
      faults.hideRestores -= 1;
      return { status: 200, text: async () => NOTHING_RESTORED };
    }
    if (init.method === 'POST' && path === '/v1/swap' && faults.dropSwaps > 0) {
      faults.dropSwaps -= 1;
      const r = await inner(url, init);
      await r.text();
      downUntil = now() + faults.downMs;
      throw new Error(DROPPED_SWAP_MESSAGE);
    }
    return inner(url, init);
  };
}
