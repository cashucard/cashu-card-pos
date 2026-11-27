import { deriveKeysetId } from '@cashu/cashu-ts';
import type { HttpFetch } from 'cashucard';

export interface FakeMintOptions {
  /** default 'https://mint.test' */
  base?: string;
  /** the NUTs listed as supported; default ['7', '9', '11', '12'] */
  nuts?: string[];
  /** every active sat keyset's input_fee_ppk; default 100 */
  fee?: number;
  /** the largest exponent: amounts 2^0 .. 2^top; default 20 */
  top?: number;
  /** exponents left out of the keys */
  skip?: number[];
  /** the first keyset's keys changed after its id was made, so the id does not derive from them */
  badId?: boolean;
  /** how many active sat keysets; default 1 */
  keysets?: number;
  /** changes every key and so every id (a mint that rotated its keysets); default 0 */
  generation?: number;
  /** every request throws new TypeError('Network request failed') */
  down?: boolean;
  /** a path answered with this status and the body 'no' */
  status?: Record<string, number>;
  /** a path answered with this body (JSON.stringify of it), status 200 */
  answers?: Record<string, unknown>;
}

export interface FakeMint {
  http: HttpFetch;
  /** every path asked, in order ('/v1/info', ...) */
  calls: string[];
  /** the active sat keysets' ids, sorted */
  readonly ids: string[];
  /** change options from now on (ids follow) */
  set(o: Partial<FakeMintOptions>): void;
}

interface BuiltKeyset {
  id: string;
  fee: number;
  keys: Record<string, string>;
}

const DEFAULT_BASE = 'https://mint.test';

function answer(status: number, body: string): { status: number; text(): Promise<string> } {
  return { status, text: async () => body };
}

function hasOwn(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

export function fakeMint(o?: FakeMintOptions): FakeMint {
  let opts: FakeMintOptions = { ...(o ?? {}) };
  let built: BuiltKeyset[] | null = null;
  const calls: string[] = [];

  const base = (): string => opts.base ?? DEFAULT_BASE;

  const keysets = (): BuiltKeyset[] => {
    if (built !== null) {
      return built;
    }
    const fee = opts.fee ?? 100;
    const top = opts.top ?? 20;
    const skip = opts.skip ?? [];
    const count = opts.keysets ?? 1;
    const generation = opts.generation ?? 0;
    const out: BuiltKeyset[] = [];
    for (let k = 0; k < count; k += 1) {
      const keys: Record<string, string> = {};
      for (let e = 0; e <= top; e += 1) {
        if (skip.includes(e)) {
          continue;
        }
        const amount = (BigInt(1) << BigInt(e)).toString();
        const offset = generation * 100000 + k * 1000 + e + 1;
        keys[amount] = '02' + offset.toString(16).padStart(64, '0');
      }
      const id = deriveKeysetId(keys, { unit: 'sat', input_fee_ppk: fee, versionByte: 1 });
      if (opts.badId === true && k === 0) {
        keys['1'] = '03' + 'f'.repeat(64);
      }
      out.push({ id, fee, keys });
    }
    built = out;
    return out;
  };

  const ids = (): string[] => keysets().map((k) => k.id).sort();

  const defaultAnswer = (path: string): { status: number; text(): Promise<string> } => {
    if (path === '/v1/info') {
      const nuts: Record<string, unknown> = { '4': { methods: [] } };
      for (const nut of opts.nuts ?? ['7', '9', '11', '12']) {
        nuts[nut] = { supported: true };
      }
      return answer(200, JSON.stringify({ name: 'Fake mint', version: 'fake/1', nuts }));
    }
    if (path === '/v1/keysets') {
      const list: unknown[] = keysets().map((k) => ({
        id: k.id,
        unit: 'sat',
        active: true,
        input_fee_ppk: k.fee,
      }));
      list.push({ id: '00aaaaaaaaaaaaaa', unit: 'sat', active: false, input_fee_ppk: 0 });
      list.push({ id: '00ffffffffffffff', unit: 'usd', active: true, input_fee_ppk: 0 });
      return answer(200, JSON.stringify({ keysets: list }));
    }
    if (path.startsWith('/v1/keys/')) {
      const id = path.slice('/v1/keys/'.length);
      const keyset = keysets().find((k) => k.id === id);
      if (keyset !== undefined) {
        return answer(
          200,
          JSON.stringify({
            keysets: [{ id: keyset.id, unit: 'sat', input_fee_ppk: keyset.fee, keys: keyset.keys }],
          }),
        );
      }
    }
    return answer(404, 'no');
  };

  const http: HttpFetch = async (url) => {
    if (!url.startsWith(base())) {
      throw new TypeError('no route for ' + url);
    }
    const path = url.slice(base().length);
    calls.push(path);
    if (opts.down === true) {
      throw new TypeError('Network request failed');
    }
    const statusMap = opts.status ?? {};
    if (hasOwn(statusMap, path)) {
      return answer(statusMap[path], 'no');
    }
    const answers = opts.answers ?? {};
    if (hasOwn(answers, path)) {
      return answer(200, JSON.stringify(answers[path]));
    }
    return defaultAnswer(path);
  };

  return {
    http,
    calls,
    get ids(): string[] {
      return ids();
    },
    set(next: Partial<FakeMintOptions>): void {
      opts = { ...opts, ...next };
      built = null;
    },
  };
}
