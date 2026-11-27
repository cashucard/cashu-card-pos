import type { RawFetch, RawInit, RawResponse } from '../../src/till/http';

/** follows: answers a redirect from its target, as React Native does; stops: answers the 3xx itself; no-url: follows
 * but reports no URL on any answer; honours-error: throws for redirect 'error', else follows. */
export type BenchMode = 'follows' | 'stops' | 'no-url' | 'honours-error';
export interface FakeBench {
  raw: RawFetch;
  landed: Array<{ method: string; bodyBytes: number }>;
  calls: Array<{ url: string; init: RawInit }>;
}
export function fakeBench(
  base: string,
  mode: BenchMode,
  failures: Readonly<Record<string, number>> = {},
): FakeBench {
  const landed: Array<{ method: string; bodyBytes: number }> = [];
  const calls: Array<{ url: string; init: RawInit }> = [];

  const answer = (status: number, body: string, at: string): RawResponse => ({
    status,
    url: mode === 'no-url' ? undefined : at,
    headers: { get: () => null },
    text: async () => body,
  });

  const raw: RawFetch = async (url, init) => {
    calls.push({ url, init });
    const path = url.slice(base.length);
    const failure = failures[path];
    if (failure !== undefined) {
      return answer(failure, 'failed', url);
    }
    if (path === '/reset') {
      landed.length = 0;
      return answer(200, 'reset', url);
    }
    if (path === '/ping') {
      return answer(200, 'ok', url);
    }
    if (path === '/hits') {
      return answer(200, JSON.stringify({ landed }), url);
    }
    if (path === '/redirect/302' || path === '/redirect/307') {
      const code = path === '/redirect/302' ? 302 : 307;
      if (mode === 'honours-error' && init.redirect === 'error') {
        throw new TypeError('redirect refused by fetch');
      }
      if (mode === 'stops') {
        return answer(code, 'moved', url);
      }
      landed.push({
        method: code === 302 && init.method === 'POST' ? 'GET' : init.method,
        bodyBytes: code === 307 ? (init.body ?? '').length : 0,
      });
      return answer(200, 'landed', base + '/landed');
    }
    return answer(404, 'no such path', url);
  };

  return { raw, landed, calls };
}
