import { fakeBench } from './helpers/fake-bench';
import { judgeRedirect, redirectProbe } from '../src/selftest/redirect';
import type { RawFetch } from '../src/till/http';
import type { RedirectFindings } from '../src/selftest/types';

const B = 'http://b.test';

let good: RedirectFindings;
let stopped: RedirectFindings;

describe('the redirect probe', () => {
  it('a fetch that follows redirects: the guard refuses both and the target was reached', async () => {
    const f = await redirectProbe(fakeBench(B, 'follows').raw, B);
    good = f;
    expect(f.pingUrl).toBe('http://b.test/ping');
    expect(f.pingAccepted).toBe(true);
    expect(f.guard302).toBe('refused');
    expect(f.guard307post).toBe('refused');
    expect(f.rawError).toBe('status 200 at http://b.test/landed');
    expect(f.rawManual).toBe('status 200 at http://b.test/landed');
    expect(f.followed).toBe(true);
    expect(f.landedGet).toBe(3);
    expect(f.landedPost).toBe(1);
    expect(f.postBodyForwarded).toBe(true);
    expect(f.got302).toEqual({ status: 200, url: 'http://b.test/landed', original: false });
    expect(f.got307post).toEqual({ status: 200, url: 'http://b.test/landed', original: false });
    // slice 2.5: a phone that follows fails the step, although the guard refused both answers
    expect(() => judgeRedirect(f)).toThrow(/the phone followed a redirect itself/);
    expect(() => judgeRedirect(f)).toThrow(/at the target: 3 GET, 1 POST with its body/);
  });

  it('a fetch that stops at the 3xx: the guard refuses on the status and nothing lands', async () => {
    const f = await redirectProbe(fakeBench(B, 'stops').raw, B);
    expect(f.guard302).toBe('refused');
    expect(f.guard307post).toBe('refused');
    expect(f.rawError).toBe('status 302 at http://b.test/redirect/302');
    expect(f.followed).toBe(false);
    expect(f.landedGet).toBe(0);
    expect(f.landedPost).toBe(0);
    expect(f.got302).toEqual({ status: 302, url: 'http://b.test/redirect/302', original: true });
    expect(f.got307post).toEqual({ status: 307, url: 'http://b.test/redirect/307', original: true });
    stopped = f;
    expect(judgeRedirect(f)).toBe(
      'the phone did not follow a 302 or a 307 POST: JavaScript got 302 and 307 at the address asked, and the guard ' +
        'refused both; at the target: 0 GET, 0 POST',
    );
  });

  it('nothing landed, but the 3xx did not reach JavaScript as itself: the judgement fails', () => {
    expect(() =>
      judgeRedirect({ ...stopped, got307post: { status: 200, url: 'http://b.test/redirect/307', original: true } }),
    ).toThrow(/a 307 POST reached JavaScript as status 200/);
    expect(() =>
      judgeRedirect({ ...stopped, got302: { status: 302, url: 'http://b.test/landed', original: false } }),
    ).toThrow(/a 302 reached JavaScript as status 302 at http:\/\/b.test\/landed, not as 302 at the address asked/);
    expect(() => judgeRedirect({ ...stopped, got302: null })).toThrow(/a 302 reached JavaScript as nothing/);
  });

  it('one request at the target is enough to fail the judgement', () => {
    expect(() => judgeRedirect({ ...stopped, landedPost: 1 })).toThrow(/the phone followed a redirect itself/);
    expect(() => judgeRedirect({ ...stopped, landedGet: 1 })).toThrow(/the phone followed a redirect itself/);
  });

  it('a fetch that reports no URL: the plain answer is refused and the judgement fails', async () => {
    const f = await redirectProbe(fakeBench(B, 'no-url').raw, B);
    expect(f.pingUrl).toBe('');
    expect(f.pingAccepted).toBe(false);
    expect(() => judgeRedirect(f)).toThrow(/no answer URL/);
  });

  it('a fetch that honours redirect error is recorded as threw', async () => {
    const f = await redirectProbe(fakeBench(B, 'honours-error').raw, B);
    expect(f.rawError).toBe('threw: redirect refused by fetch');
    expect(f.rawManual.startsWith('status 200')).toBe(true);
  });

  it('the probe starts from an empty record', async () => {
    const bench = fakeBench(B, 'follows');
    bench.landed.push({ method: 'GET', bodyBytes: 0 }, { method: 'POST', bodyBytes: 4 });
    const f = await redirectProbe(bench.raw, B);
    expect(f.landedGet).toBe(3);
  });

  it('the probe sends its POST with a body and a trailing slash in the bench is joined once', async () => {
    const bench = fakeBench(B, 'follows');
    await redirectProbe(bench.raw, B + '/');
    for (const call of bench.calls) {
      expect(call.url.startsWith('http://b.test/')).toBe(true);
      expect(call.url).not.toContain('//reset');
    }
    const call = bench.calls.find((c) => c.url === 'http://b.test/redirect/307');
    expect(call).toBeDefined();
    expect(call?.init.method).toBe('POST');
    expect(call?.init.body).toBe('{"probe":307}');
  });

  it('a guard that took a redirect fails the judgement', () => {
    expect(() => judgeRedirect({ ...good, guard302: 'accepted' })).toThrow(/a 302 was accepted/);
  });

  it('an error in the guard is not a refusal', () => {
    expect(() => judgeRedirect({ ...good, guard307post: 'error' })).toThrow(/a 307 POST was error/);
  });

  it('a guard that throws another error is not a refusal', async () => {
    const bench = fakeBench(B, 'follows');
    const raw: RawFetch = async (url, init) => {
      if (url.includes('/redirect/')) {
        throw new Error('boom');
      }
      return bench.raw(url, init);
    };
    const f = await redirectProbe(raw, B);
    expect(f.guard302).toBe('error');
    expect(f.guard307post).toBe('error');
    expect(() => judgeRedirect(f)).toThrow();
  });

  it('a bench server that does not answer /hits fails the probe', async () => {
    await expect(redirectProbe(fakeBench(B, 'follows', { '/hits': 500 }).raw, B)).rejects.toThrow(/\/hits/);
  });

  it('a bench server that does not answer /reset fails the probe', async () => {
    await expect(redirectProbe(fakeBench(B, 'follows', { '/reset': 500 }).raw, B)).rejects.toThrow(/\/reset/);
  });
});
