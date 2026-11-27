import type { RawFetch } from '../till/http';

export type BenchPath = '/event' | '/result';

export interface Bench {
  /** the plan for this launch, as the bench serves it (parsed JSON) */
  plan(): Promise<unknown>;
  /** post one JSON object; rejects unless the bench answered 200 */
  post(path: BenchPath, body: unknown): Promise<void>;
}

export function benchClient(raw: RawFetch, base: string): Bench {
  return {
    async plan(): Promise<unknown> {
      const r = await raw(base + '/plan', { method: 'GET', headers: {} });
      if (r.status !== 200) {
        throw new Error('the bench answered ' + r.status + ' to /plan');
      }
      return JSON.parse(await r.text()) as unknown;
    },
    async post(path: BenchPath, body: unknown): Promise<void> {
      const r = await raw(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status !== 200) {
        throw new Error('the bench answered ' + r.status + ' to ' + path);
      }
    },
  };
}
