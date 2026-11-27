import type { HttpFetch } from 'cashucard';
import { RedirectRefusedError } from '../src/till/http';
import {
  activeSatKeysets,
  amountsProblem,
  checkMint,
  MintAskError,
  normalizeMintInput,
} from '../src/till/mint-check';
import type { MintCheckId, MintCheckReport } from '../src/till/mint-check';
import { fakeMint } from './helpers/fake-mint';

const good = () => fakeMint();
const lineOf = (r: MintCheckReport, id: MintCheckId) => r.lines.find((l) => l.id === id);

const pow2 = (from: number, to: number): string[] => {
  const out: string[] = [];
  for (let e = from; e <= to; e += 1) {
    out.push((BigInt(1) << BigInt(e)).toString());
  }
  return out;
};

describe('the mint check', () => {
  it('an address is made https and plain', () => {
    expect(normalizeMintInput('mint.test')).toEqual({ ok: true, url: 'https://mint.test' });
    expect(normalizeMintInput('  https://Mint.Test/  ')).toEqual({ ok: true, url: 'https://mint.test' });
    expect(normalizeMintInput('https://mint.test:443/cashu/')).toEqual({
      ok: true,
      url: 'https://mint.test/cashu',
    });
    expect(normalizeMintInput('https://mint.test:3338')).toEqual({
      ok: true,
      url: 'https://mint.test:3338',
    });
  });

  it('an address that is not https, or not an address, is refused with its own words', () => {
    for (const text of ['http://mint.test', 'ftp://x.test']) {
      expect(normalizeMintInput(text)).toEqual({
        ok: false,
        words: "The mint's address must start with https://.",
      });
    }
    for (const text of ['', '   ']) {
      expect(normalizeMintInput(text)).toEqual({ ok: false, words: "Type the mint's address." });
    }
    for (const text of [
      'https://user@mint.test',
      'https://mint.test?x=1',
      'https://mint.test#a',
      'https://mi nt.test',
      'https://',
      'https://mint_test',
    ]) {
      expect(normalizeMintInput(text)).toEqual({ ok: false, words: "This is not a mint's address." });
    }
    expect(normalizeMintInput('https://abc.onion')).toEqual({
      ok: false,
      words: 'This version does not take .onion mints.',
    });
  });

  it('amounts must be every power of two up to at least 2^20', () => {
    expect(amountsProblem(pow2(0, 20))).toBeNull();
    expect(amountsProblem(pow2(0, 63))).toBeNull();
    expect(amountsProblem(pow2(0, 20).filter((a) => a !== '4'))).toBe(
      'Its keys lack the amount of 4 sats.',
    );
    expect(amountsProblem([...pow2(0, 20), '3'])).toBe(
      'Its keys list an amount that is not a power of two: 3 sats.',
    );
    expect(amountsProblem(pow2(0, 19))).toBe(
      'Its keys stop at 524,288 sats. This till needs every amount up to at least 1,048,576 sats.',
    );
    expect(amountsProblem([])).toBe('Its keys list no amounts.');
    expect(amountsProblem(['1', '02'])).toBe('Its keys list an amount that is not a whole number: 02.');
  });

  it('a good mint passes every line', async () => {
    const m = good();
    const r = await checkMint(m.http, 'mint.test');
    expect(r.ok).toBe(true);
    expect(r.reached).toBe(true);
    expect(r.url).toBe('https://mint.test');
    expect(r.lines.map((l) => l.id)).toEqual([
      'address',
      'reach',
      'nut07',
      'nut09',
      'nut11',
      'nut12',
      'keyset',
      'fee',
      'amounts',
      'keys',
    ]);
    for (const line of r.lines) {
      expect(line.ok).toBe(true);
    }
    expect(lineOf(r, 'fee')?.words).toBe('Its fee is 100 ppk, within the 1,000 this till takes.');
    expect(lineOf(r, 'amounts')?.words).toBe(
      'Its keys cover every amount from 1 to 1,048,576 sats.',
    );
    expect(r.keysets).toEqual(m.ids);
  });

  it('a mint with keys up to 2^63 passes', async () => {
    const r = await checkMint(fakeMint({ top: 63 }).http, 'mint.test');
    expect(r.ok).toBe(true);
    expect(lineOf(r, 'amounts')?.words).toBe(
      'Its keys cover every amount from 1 sat to more than a billion sats.',
    );
  });

  it('each NUT the till needs is checked', async () => {
    const all = ['7', '9', '11', '12'];
    const table: Record<string, { id: MintCheckId; words: string }> = {
      '7': {
        id: 'nut07',
        words: 'It does not tell whether a piece is spent (NUT-07).',
      },
      '9': {
        id: 'nut09',
        words: 'It cannot give back the signatures it made (NUT-09).',
      },
      '11': {
        id: 'nut11',
        words: 'It does not take payments a card signs (NUT-11).',
      },
      '12': {
        id: 'nut12',
        words: 'It does not prove its signatures (NUT-12).',
      },
    };
    for (const missing of all) {
      const m = fakeMint({ nuts: all.filter((n) => n !== missing) });
      const r = await checkMint(m.http, 'mint.test');
      expect(r.ok).toBe(false);
      expect(r.reached).toBe(true);
      expect(r.lines).toHaveLength(10);
      const line = lineOf(r, table[missing].id);
      expect(line?.ok).toBe(false);
      expect(line?.words).toBe(table[missing].words);
      for (const other of all.filter((n) => n !== missing)) {
        expect(lineOf(r, table[other].id)?.ok).toBe(true);
      }
    }
  });

  it('a fee over 1,000 ppk is refused, and 1,000 is taken', async () => {
    const high = await checkMint(fakeMint({ fee: 1001 }).http, 'mint.test');
    expect(lineOf(high, 'fee')?.ok).toBe(false);
    expect(lineOf(high, 'fee')?.words).toBe('Its fee is 1,001 ppk. This till takes at most 1,000.');
    expect(high.ok).toBe(false);
    expect(high.keysets).toEqual([]);

    const at = await checkMint(fakeMint({ fee: 1000 }).http, 'mint.test');
    expect(at.ok).toBe(true);
  });

  it('a missing amount is refused', async () => {
    const r = await checkMint(fakeMint({ skip: [5] }).http, 'mint.test');
    expect(lineOf(r, 'amounts')?.ok).toBe(false);
    expect(lineOf(r, 'amounts')?.words).toBe('Its keys lack the amount of 32 sats.');
  });

  it('keys that do not derive their id are refused', async () => {
    const r = await checkMint(fakeMint({ badId: true }).http, 'mint.test');
    expect(lineOf(r, 'keys')?.ok).toBe(false);
    expect(lineOf(r, 'keys')?.words).toBe('Its keys do not match their keyset id.');
    expect(lineOf(r, 'amounts')?.ok).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('a mint with no active keyset in sats is refused', async () => {
    const r = await checkMint(fakeMint({ keysets: 0 }).http, 'mint.test');
    expect(r.lines).toHaveLength(7);
    expect(r.lines[6].id).toBe('keyset');
    expect(r.lines[6].ok).toBe(false);
    expect(r.lines[6].words).toBe('It has no active keyset in sats.');
  });

  it('two keysets are both checked', async () => {
    const m = fakeMint({ keysets: 2 });
    const r = await checkMint(m.http, 'mint.test');
    expect(lineOf(r, 'keyset')?.words).toBe('It has 2 active keysets in sats.');
    expect(r.keysets).toEqual(m.ids);
    for (const id of m.ids) {
      expect(m.calls).toContain('/v1/keys/' + id);
    }
  });

  it('the inactive keyset and the usd keyset are left alone', async () => {
    const m = good();
    const r = await checkMint(m.http, 'mint.test');
    expect(m.calls).not.toContain('/v1/keys/00aaaaaaaaaaaaaa');
    expect(m.calls).not.toContain('/v1/keys/00ffffffffffffff');
    expect(r.keysets).toHaveLength(1);
  });

  it('a mint that does not answer is not refused', async () => {
    const r = await checkMint(fakeMint({ down: true }).http, 'mint.test');
    expect(r.lines).toHaveLength(2);
    expect(lineOf(r, 'reach')?.ok).toBe(false);
    expect(lineOf(r, 'reach')?.words.startsWith('The mint did not answer: ')).toBe(true);
    expect(r.reached).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('a mint that answers badly is refused', async () => {
    const r = await checkMint(fakeMint({ status: { '/v1/info': 500 } }).http, 'mint.test');
    expect(lineOf(r, 'reach')?.words).toBe(
      'The mint answered, but not as a mint does: it answered 500.',
    );
    expect(r.reached).toBe(true);
  });

  it('a mint that does not answer in time is not refused', async () => {
    const http: HttpFetch = async (_url, init) =>
      new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const r = await checkMint(http, 'mint.test', 30);
    expect(lineOf(r, 'reach')?.words).toBe('The mint did not answer: it did not answer in time.');
    expect(r.reached).toBe(false);
  });

  it('a redirected answer is a bad answer', async () => {
    const http: HttpFetch = async (url) => {
      throw new RedirectRefusedError(url, 'https://other.test/', 302);
    };
    const r = await checkMint(http, 'mint.test');
    expect(r.reached).toBe(true);
    expect(lineOf(r, 'reach')?.words).toContain('redirect');
  });

  it('a refused address asks nothing', async () => {
    const m = good();
    const r = await checkMint(m.http, 'http://mint.test');
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].id).toBe('address');
    expect(r.lines[0].ok).toBe(false);
    expect(r.reached).toBe(true);
    expect(r.url).toBe('http://mint.test');
    expect(m.calls).toEqual([]);
  });

  it('the mint is asked only at its own address', async () => {
    const m = good();
    await checkMint(m.http, 'mint.test');
    for (const call of m.calls) {
      expect(call.startsWith('/v1/')).toBe(true);
    }
  });

  it('a list of keysets that is not as expected is a bad answer', async () => {
    const m = fakeMint({ answers: { '/v1/keysets': { keysets: 'x' } } });
    await expect(activeSatKeysets(m.http, 'https://mint.test')).rejects.toBeInstanceOf(MintAskError);
    await expect(activeSatKeysets(m.http, 'https://mint.test')).rejects.toMatchObject({
      reached: true,
    });
    const r = await checkMint(m.http, 'mint.test');
    expect(lineOf(r, 'keyset')?.ok).toBe(false);
    expect(lineOf(r, 'keyset')?.words).toBe(
      'It did not list its keysets: its list of keysets is not as expected.',
    );
  });

  it('no text uses a long dash', async () => {
    const reports: MintCheckReport[] = [
      await checkMint(good().http, 'mint.test'),
      await checkMint(fakeMint({ down: true }).http, 'mint.test'),
      await checkMint(fakeMint({ fee: 1001 }).http, 'mint.test'),
      await checkMint(fakeMint({ badId: true }).http, 'mint.test'),
      await checkMint(fakeMint({ keysets: 0 }).http, 'mint.test'),
      await checkMint(fakeMint({ skip: [5] }).http, 'mint.test'),
      await checkMint(fakeMint({ status: { '/v1/info': 500 } }).http, 'mint.test'),
      await checkMint(good().http, 'http://mint.test'),
    ];
    for (const r of reports) {
      for (const line of r.lines) {
        expect(line.words).not.toContain('—');
        expect(line.words).not.toContain('–');
      }
    }
  });
});
