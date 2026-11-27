import { deriveKeysetId } from '@cashu/cashu-ts';
import type { HttpFetch } from 'cashucard';
import { checkMint, CHECK_WORDS, normalizeMintInput } from '../src/till/mint-check';
import type { MintCheckId, MintCheckReport } from '../src/till/mint-check';
import { fakeMint } from './helpers/fake-mint';

const lineOf = (r: MintCheckReport, id: MintCheckId) => r.lines.find((l) => l.id === id);
const GET = { method: 'GET', headers: {} };
const EXP = 2000000000;
const NUTS = { '7': { supported: true }, '9': { supported: true }, '11': { supported: true }, '12': { supported: true } };

/** A mint at https://mint.test with one active sat keyset whose id binds the expiry EXP, listed and given as asked. */
function expiringMint(listExpiry: number | undefined, keysExpiry: number | undefined): HttpFetch {
  const keys: Record<string, string> = {};
  for (let e = 0; e <= 20; e += 1) {
    keys[(BigInt(1) << BigInt(e)).toString()] = '02' + (e + 1).toString(16).padStart(64, '0');
  }
  const id = deriveKeysetId(keys, { unit: 'sat', input_fee_ppk: 100, versionByte: 1, expiry: EXP });
  const listed: Record<string, unknown> = { id, unit: 'sat', active: true, input_fee_ppk: 100 };
  if (listExpiry !== undefined) {
    listed.final_expiry = listExpiry;
  }
  const given: Record<string, unknown> = { id, unit: 'sat', input_fee_ppk: 100, keys };
  if (keysExpiry !== undefined) {
    given.final_expiry = keysExpiry;
  }
  const answers: Record<string, unknown> = {
    '/v1/info': { name: 'x', nuts: NUTS },
    '/v1/keysets': { keysets: [listed] },
    ['/v1/keys/' + id]: { keysets: [given] },
  };
  return async (url) => {
    const path = url.slice('https://mint.test'.length);
    if (!Object.prototype.hasOwnProperty.call(answers, path)) {
      return { status: 404, text: async () => 'no' };
    }
    return { status: 200, text: async () => JSON.stringify(answers[path]) };
  };
}

/** The fake mint's own /v1/keys answer for its first keyset, changed by `change`, served from then on. */
async function keysChanged(change: (k: Record<string, unknown>) => void) {
  const m = fakeMint();
  const id = m.ids[0];
  const body = JSON.parse(await (await m.http('https://mint.test/v1/keys/' + id, GET)).text()) as {
    keysets: Array<Record<string, unknown>>;
  };
  change(body.keysets[0]);
  m.set({ answers: { ['/v1/keys/' + id]: body } });
  return m;
}

describe('the mint check and what the till keeps', () => {
  it('an address longer than the store keeps is refused, and nothing is asked', async () => {
    const m = fakeMint();
    const r = await checkMint(m.http, 'mint.test/' + 'a'.repeat(300));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toEqual({ id: 'address', ok: false, words: CHECK_WORDS.tooLong });
    expect(r.ok).toBe(false);
    expect(m.calls).toEqual([]);
    expect(normalizeMintInput('mint.test/' + 'a'.repeat(270)).ok).toBe(true);
  });

  it('more active keysets than the store keeps are refused, and no keys are asked', async () => {
    const m = fakeMint({ keysets: 17 });
    const r = await checkMint(m.http, 'mint.test');
    expect(r.ok).toBe(false);
    expect(r.lines).toHaveLength(7);
    expect(lineOf(r, 'keyset')).toEqual({
      id: 'keyset',
      ok: false,
      words: 'It has 17 active keysets in sats. This till keeps at most 16.',
    });
    expect(m.calls.some((c) => c.startsWith('/v1/keys/'))).toBe(false);
  });

  it('a mint with too many keysets answered: the report is reached', async () => {
    const r = await checkMint(fakeMint({ keysets: 17 }).http, 'mint.test');
    expect(r.reached).toBe(true);
    expect(lineOf(r, 'keyset')).toEqual({
      id: 'keyset',
      ok: false,
      words: 'It has 17 active keysets in sats. This till keeps at most 16.',
    });
  });

  it('sixteen active keysets pass', async () => {
    const r = await checkMint(fakeMint({ keysets: 16 }).http, 'mint.test');
    expect(r.ok).toBe(true);
    expect(r.keysets).toHaveLength(16);
  });

  it('a keyset id the till cannot keep is refused, and never asked for', async () => {
    const m = fakeMint({
      answers: {
        '/v1/keysets': {
          keysets: [{ id: 'I2yN+iRYfkzT', unit: 'sat', active: true, input_fee_ppk: 0 }],
        },
      },
    });
    const r = await checkMint(m.http, 'mint.test');
    expect(r.ok).toBe(false);
    expect(lineOf(r, 'keyset')?.words).toBe(
      'It names a keyset in a form this till cannot keep: I2yN+iRYfkzT.',
    );
    expect(m.calls.some((c) => c.startsWith('/v1/keys/'))).toBe(false);
  });

  it('a mint with a keyset id the till cannot keep answered: the report is reached', async () => {
    const m = fakeMint({
      answers: {
        '/v1/keysets': {
          keysets: [{ id: 'I2yN+iRYfkzT', unit: 'sat', active: true, input_fee_ppk: 0 }],
        },
      },
    });
    const r = await checkMint(m.http, 'mint.test');
    expect(r.reached).toBe(true);
    expect(lineOf(r, 'keyset')?.ok).toBe(false);
  });

  it('keys that name another unit than their listing are refused', async () => {
    const m = await keysChanged((k) => {
      k.unit = 'usd';
    });
    const r = await checkMint(m.http, 'mint.test');
    expect(r.ok).toBe(false);
    expect(lineOf(r, 'keys')).toEqual({
      id: 'keys',
      ok: false,
      words: 'Its keys do not match their keyset id.',
    });
  });

  it('keys that give another fee than their listing are refused', async () => {
    const m = await keysChanged((k) => {
      k.input_fee_ppk = 200;
    });
    const r = await checkMint(m.http, 'mint.test');
    expect(r.ok).toBe(false);
    expect(lineOf(r, 'keys')?.ok).toBe(false);
  });

  it("keys with the listing's own expiry pass", async () => {
    const r = await checkMint(expiringMint(EXP, EXP), 'mint.test');
    expect(r.ok).toBe(true);
  });

  it('keys that give another expiry than their listing are refused', async () => {
    const r = await checkMint(expiringMint(EXP, EXP + 1), 'mint.test');
    expect(r.ok).toBe(false);
    expect(lineOf(r, 'keys')?.ok).toBe(false);
  });

  it("the listing's expiry is used when the keys give none", async () => {
    const r = await checkMint(expiringMint(EXP, undefined), 'mint.test');
    expect(r.ok).toBe(true);
  });

  it("the keys' expiry is used when the listing gives none, as the library does", async () => {
    const r = await checkMint(expiringMint(undefined, EXP), 'mint.test');
    expect(r.ok).toBe(true);
  });

  it('an expiry given by neither is refused when the id binds one', async () => {
    const r = await checkMint(expiringMint(undefined, undefined), 'mint.test');
    expect(r.ok).toBe(false);
    expect(lineOf(r, 'keys')?.ok).toBe(false);
  });

  it('large amounts are said plainly', async () => {
    expect(lineOf(await checkMint(fakeMint({ top: 30 }).http, 'mint.test'), 'amounts')?.words).toBe(
      'Its keys cover every amount from 1 to 1,073,741,824 sats.',
    );
    expect(lineOf(await checkMint(fakeMint({ top: 31 }).http, 'mint.test'), 'amounts')?.words).toBe(
      CHECK_WORDS.amountsBillion,
    );
    expect(lineOf(await checkMint(fakeMint({ top: 20 }).http, 'mint.test'), 'amounts')?.words).toBe(
      'Its keys cover every amount from 1 to 1,048,576 sats.',
    );
  });

  it('the new words use no long dash', () => {
    for (const words of [
      CHECK_WORDS.tooLong,
      CHECK_WORDS.manyKeysets(17),
      CHECK_WORDS.idUnkept('x'),
      CHECK_WORDS.amountsBillion,
    ]) {
      expect(words.includes('—')).toBe(false);
      expect(words.includes('–')).toBe(false);
      expect(/crypto/i.test(words)).toBe(false);
    }
  });
});
