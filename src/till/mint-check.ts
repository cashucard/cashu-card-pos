import { Keyset } from '@cashu/cashu-ts';
import type { HttpFetch } from 'cashucard';
import { groupDigits } from '../format';
import { BodyTooLargeError, RedirectRefusedError } from './http';
import { KEYSET_WORDS, MAX_KEYSETS, MAX_URL } from './settings';

export const MAX_FEE_PPK = 1000;
/** The largest amount an active keyset must have a key for, at least: 2^20 sats. */
export const LEAST_TOP_AMOUNT = '1048576';
export const MINT_TIMEOUT_MS = 15000;
/** Above this largest amount the passed amounts line no longer writes the number out. */
export const PLAIN_TOP = BigInt(1073741824); // 2^30
export const CHECK_WORDS = {
  tooLong: "This address is too long to be a mint's address.",
  manyKeysets: (n: number): string =>
    'It has ' + n + ' active keysets in sats. This till keeps at most ' + MAX_KEYSETS + '.',
  idUnkept: (id: string): string => 'It names a keyset in a form this till cannot keep: ' + id.slice(0, 24) + '.',
  amountsBillion: 'Its keys cover every amount from 1 sat to more than a billion sats.',
} as const;

export type MintCheckId =
  | 'address'
  | 'reach'
  | 'nut07'
  | 'nut09'
  | 'nut11'
  | 'nut12'
  | 'keyset'
  | 'fee'
  | 'amounts'
  | 'keys';
export interface MintCheckLine {
  id: MintCheckId;
  ok: boolean;
  words: string;
}
export interface MintCheckReport {
  /** the address checked: normalized when it parsed, else the text trimmed */
  url: string;
  /** every line passed */
  ok: boolean;
  /** false only when the mint gave no answer at some step: the report then says nothing about the mint itself */
  reached: boolean;
  lines: MintCheckLine[];
  /** the active keysets in sats, sorted by id; [] unless ok */
  keysets: string[];
}
export interface ListedKeyset {
  id: string;
  fee: number;
  expiry: number | undefined;
}

/** Asking the mint failed. `reached`: the mint answered, badly (a status other than 200, not JSON, a redirect, too
 * large); false: no answer at all (no connection, a timeout, no route). */
export class MintAskError extends Error {
  readonly reached: boolean;
  constructor(message: string, reached: boolean) {
    super(message);
    this.name = 'MintAskError';
    this.reached = reached;
    Object.setPrototypeOf(this, MintAskError.prototype);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeMintInput(text: string): { ok: true; url: string } | { ok: false; words: string } {
  let t = text.trim();
  if (t === '') {
    return { ok: false, words: "Type the mint's address." };
  }
  if (/\s/.test(t)) {
    return { ok: false, words: "This is not a mint's address." };
  }
  if (!t.includes('://')) {
    t = 'https://' + t;
  }
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)([?#].*)?$/.exec(t);
  if (m === null) {
    return { ok: false, words: "This is not a mint's address." };
  }
  if (m[1].toLowerCase() !== 'https') {
    return { ok: false, words: "The mint's address must start with https://." };
  }
  if (m[4] !== undefined) {
    return { ok: false, words: "This is not a mint's address." };
  }
  let authority = m[2].toLowerCase();
  if (authority === '' || authority.includes('@')) {
    return { ok: false, words: "This is not a mint's address." };
  }
  if (authority.endsWith(':443')) {
    authority = authority.slice(0, -':443'.length);
  }
  const parts = /^([^:]*)(?::([^:]*))?$/.exec(authority);
  if (parts === null) {
    return { ok: false, words: "This is not a mint's address." };
  }
  const host = parts[1];
  const port = parts[2];
  const hostOk = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host);
  const portOk = port === undefined || /^[0-9]{1,5}$/.test(port);
  if (!hostOk || !portOk) {
    return { ok: false, words: "This is not a mint's address." };
  }
  if (host.endsWith('.onion')) {
    return { ok: false, words: 'This version does not take .onion mints.' };
  }
  const path = m[3].replace(/\/+$/, '');
  const url = 'https://' + authority + path;
  if (url.length > MAX_URL) {
    return { ok: false, words: CHECK_WORDS.tooLong };
  }
  return { ok: true, url };
}

export function amountsProblem(amounts: readonly string[]): string | null {
  if (amounts.length === 0) {
    return 'Its keys list no amounts.';
  }
  for (const a of amounts) {
    if (!/^[1-9][0-9]{0,19}$/.test(a)) {
      return 'Its keys list an amount that is not a whole number: ' + a.slice(0, 24) + '.';
    }
  }
  for (const a of amounts) {
    const b = BigInt(a);
    if ((b & (b - BigInt(1))) !== BigInt(0)) {
      return 'Its keys list an amount that is not a power of two: ' + groupDigits(a) + ' sats.';
    }
  }
  let top = BigInt(0);
  for (const a of amounts) {
    const b = BigInt(a);
    if (b > top) {
      top = b;
    }
  }
  const present = new Set(amounts);
  for (let x = BigInt(1); x <= top; x = x << BigInt(1)) {
    if (!present.has(x.toString())) {
      return 'Its keys lack the amount of ' + groupDigits(x.toString()) + ' sats.';
    }
  }
  if (top < BigInt(LEAST_TOP_AMOUNT)) {
    return (
      'Its keys stop at ' +
      groupDigits(top.toString()) +
      ' sats. This till needs every amount up to at least 1,048,576 sats.'
    );
  }
  return null;
}

function askFailure(e: unknown, signal: AbortSignal): MintAskError {
  if (e instanceof RedirectRefusedError) {
    return new MintAskError('it answered with a redirect, which this till refuses', true);
  }
  if (e instanceof BodyTooLargeError) {
    return new MintAskError('its answer was too large', true);
  }
  if (signal.aborted) {
    return new MintAskError('it did not answer in time', false);
  }
  const message = e instanceof Error ? e.message : String(e);
  return new MintAskError(message, false);
}

export async function askMint(http: HttpFetch, url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let r;
    try {
      r = await http(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (e) {
      throw askFailure(e, controller.signal);
    }
    if (r.status !== 200) {
      throw new MintAskError('it answered ' + r.status, true);
    }
    let text: string;
    try {
      text = await r.text();
    } catch (e) {
      throw askFailure(e, controller.signal);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new MintAskError('its answer is not JSON', true);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function activeSatKeysets(
  http: HttpFetch,
  mintUrl: string,
  timeoutMs: number = MINT_TIMEOUT_MS,
): Promise<ListedKeyset[]> {
  const answer = await askMint(http, mintUrl + '/v1/keysets', timeoutMs);
  if (!isRecord(answer) || !Array.isArray(answer.keysets)) {
    throw new MintAskError('its list of keysets is not as expected', true);
  }
  const listed: ListedKeyset[] = [];
  for (const item of answer.keysets) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.unit !== 'string' ||
      typeof item.active !== 'boolean'
    ) {
      throw new MintAskError('its list of keysets is not as expected', true);
    }
    const fee = item.input_fee_ppk;
    if (
      fee !== undefined &&
      fee !== null &&
      !(typeof fee === 'number' && Number.isInteger(fee) && fee >= 0)
    ) {
      throw new MintAskError('its list of keysets is not as expected', true);
    }
    const expiry = item.final_expiry;
    if (expiry !== undefined && expiry !== null && typeof expiry !== 'number') {
      throw new MintAskError('its list of keysets is not as expected', true);
    }
    if (item.active === true && item.unit === 'sat') {
      listed.push({
        id: item.id,
        fee: typeof fee === 'number' ? fee : 0,
        expiry: typeof expiry === 'number' ? expiry : undefined,
      });
    }
  }
  listed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return listed;
}

const NUT_WORDS: ReadonlyArray<{ id: MintCheckId; nut: string; yes: string; no: string }> = [
  {
    id: 'nut07',
    nut: '7',
    yes: 'It tells whether a piece is spent (NUT-07).',
    no: 'It does not tell whether a piece is spent (NUT-07).',
  },
  {
    id: 'nut09',
    nut: '9',
    yes: 'It can give back the signatures it made (NUT-09).',
    no: 'It cannot give back the signatures it made (NUT-09).',
  },
  {
    id: 'nut11',
    nut: '11',
    yes: 'It takes payments a card signs (NUT-11).',
    no: 'It does not take payments a card signs (NUT-11).',
  },
  {
    id: 'nut12',
    nut: '12',
    yes: 'It proves every signature it makes (NUT-12).',
    no: 'It does not prove its signatures (NUT-12).',
  },
];

function largestAmount(amounts: readonly string[]): bigint | null {
  let top: bigint | null = null;
  for (const a of amounts) {
    if (!/^[0-9]+$/.test(a)) {
      continue;
    }
    const b = BigInt(a);
    if (top === null || b > top) {
      top = b;
    }
  }
  return top;
}

export async function checkMint(
  http: HttpFetch,
  text: string,
  timeoutMs: number = MINT_TIMEOUT_MS,
): Promise<MintCheckReport> {
  const lines: MintCheckLine[] = [];
  let reached = true;

  const report = (url: string): MintCheckReport => ({
    url,
    ok: lines.length === 10 && lines.every((l) => l.ok),
    reached,
    lines,
    keysets: [],
  });

  const normalized = normalizeMintInput(text);
  if (!normalized.ok) {
    lines.push({ id: 'address', ok: false, words: normalized.words });
    return report(text.trim());
  }
  const url = normalized.url;
  lines.push({ id: 'address', ok: true, words: 'The address starts with https.' });

  let info: unknown;
  try {
    info = await askMint(http, url + '/v1/info', timeoutMs);
  } catch (e) {
    if (!(e instanceof MintAskError)) {
      throw e;
    }
    if (!e.reached) {
      lines.push({ id: 'reach', ok: false, words: 'The mint did not answer: ' + e.message + '.' });
      reached = false;
    } else {
      lines.push({
        id: 'reach',
        ok: false,
        words: 'The mint answered, but not as a mint does: ' + e.message + '.',
      });
    }
    return report(url);
  }
  lines.push({ id: 'reach', ok: true, words: 'The mint answered.' });

  const nuts = isRecord(info) && isRecord(info.nuts) ? info.nuts : {};
  for (const nut of NUT_WORDS) {
    const entry = nuts[nut.nut];
    const supported = isRecord(entry) && Boolean(entry.supported);
    lines.push({ id: nut.id, ok: supported, words: supported ? nut.yes : nut.no });
  }

  let listed: ListedKeyset[];
  try {
    listed = await activeSatKeysets(http, url, timeoutMs);
  } catch (e) {
    if (!(e instanceof MintAskError)) {
      throw e;
    }
    lines.push({ id: 'keyset', ok: false, words: 'It did not list its keysets: ' + e.message + '.' });
    reached = e.reached;
    return report(url);
  }
  if (listed.length === 0) {
    lines.push({ id: 'keyset', ok: false, words: 'It has no active keyset in sats.' });
    return report(url);
  }
  // What the store cannot keep stops the check here, before any keys are asked: no later line could change it. The
  // mint answered, so the report stays reached: this is a refusal, never "the mint did not answer".
  if (listed.length > MAX_KEYSETS) {
    lines.push({ id: 'keyset', ok: false, words: CHECK_WORDS.manyKeysets(listed.length) });
    return report(url);
  }
  const unkept = listed.find((k) => !KEYSET_WORDS.test(k.id));
  if (unkept !== undefined) {
    lines.push({ id: 'keyset', ok: false, words: CHECK_WORDS.idUnkept(unkept.id) });
    return report(url);
  }
  lines.push({
    id: 'keyset',
    ok: true,
    words:
      listed.length === 1
        ? 'It has an active keyset in sats.'
        : 'It has ' + listed.length + ' active keysets in sats.',
  });

  let topFee = 0;
  for (const k of listed) {
    if (k.fee > topFee) {
      topFee = k.fee;
    }
  }
  const feeOk = topFee <= MAX_FEE_PPK;
  lines.push({
    id: 'fee',
    ok: feeOk,
    words: feeOk
      ? 'Its fee is ' + groupDigits(String(topFee)) + ' ppk, within the 1,000 this till takes.'
      : 'Its fee is ' + groupDigits(String(topFee)) + ' ppk. This till takes at most 1,000.',
  });

  let amountsIssue: string | null = null;
  let least: bigint | null = null;
  let anyKeysRead = false;
  let keysWrong = false;

  for (const k of listed) {
    let answer: unknown;
    try {
      answer = await askMint(http, url + '/v1/keys/' + k.id, timeoutMs);
    } catch (e) {
      if (!(e instanceof MintAskError)) {
        throw e;
      }
      lines.push({ id: 'amounts', ok: false, words: 'It did not give its keys: ' + e.message + '.' });
      reached = e.reached;
      return report(url);
    }

    let found: Record<string, unknown> | undefined;
    if (isRecord(answer) && Array.isArray(answer.keysets)) {
      for (const item of answer.keysets) {
        if (isRecord(item) && item.id === k.id) {
          found = item;
          break;
        }
      }
    }

    let wrong = false;
    let keys: Record<string, string> | undefined;
    // the expiry the id is checked with: the listing's; when the listing gives none, the keys' own (as the library)
    let expiry: number | undefined = k.expiry;
    if (found === undefined) {
      wrong = true;
    } else {
      const saidExpiry = found.final_expiry;
      if (saidExpiry !== undefined && saidExpiry !== null) {
        if (typeof saidExpiry !== 'number') {
          wrong = true;
        } else if (k.expiry !== undefined && saidExpiry !== k.expiry) {
          wrong = true;
        } else if (k.expiry === undefined) {
          expiry = saidExpiry;
        }
      }
      const rawKeys = found.keys;
      if (isRecord(rawKeys) && Object.values(rawKeys).every((v) => typeof v === 'string')) {
        const read: Record<string, string> = {};
        for (const [amount, key] of Object.entries(rawKeys)) {
          read[amount] = key as string;
        }
        keys = read;
      } else {
        wrong = true;
      }
      if (found.unit !== 'sat') {
        wrong = true;
      }
      if (typeof found.input_fee_ppk === 'number' && found.input_fee_ppk !== k.fee) {
        wrong = true;
      }
    }

    if (keys !== undefined && !wrong) {
      const verified = Keyset.verifyKeysetId({
        id: k.id,
        unit: 'sat',
        keys,
        input_fee_ppk: k.fee,
        final_expiry: expiry,
      });
      if (!verified) {
        wrong = true;
      }
    }

    if (wrong) {
      keysWrong = true;
    }

    if (keys !== undefined) {
      anyKeysRead = true;
      const amounts = Object.keys(keys);
      const problem = amountsProblem(amounts);
      if (problem !== null) {
        if (amountsIssue === null) {
          amountsIssue = problem;
        }
      } else {
        const top = largestAmount(amounts);
        if (top !== null && (least === null || top < least)) {
          least = top;
        }
      }
    }
  }

  if (amountsIssue !== null) {
    lines.push({ id: 'amounts', ok: false, words: amountsIssue });
  } else if (anyKeysRead && least !== null) {
    lines.push({
      id: 'amounts',
      ok: true,
      words:
        least > PLAIN_TOP
          ? CHECK_WORDS.amountsBillion
          : 'Its keys cover every amount from 1 to ' + groupDigits(least.toString()) + ' sats.',
    });
  } else {
    lines.push({ id: 'amounts', ok: false, words: 'Its keys list no amounts.' });
  }

  if (keysWrong) {
    lines.push({ id: 'keys', ok: false, words: 'Its keys do not match their keyset id.' });
  } else {
    lines.push({ id: 'keys', ok: true, words: 'Its keys match their keyset id.' });
  }

  const ok = lines.length === 10 && lines.every((l) => l.ok);
  return { url, ok, reached, lines, keysets: ok ? listed.map((k) => k.id) : [] };
}
