import type { HttpFetch } from 'cashucard';
import { DEV_MINT_NAME, DEV_MINT_URL, DEV_ROUTES, DEV_SALE_SATS } from '../src/till/dev-config';
import { guardedFetch, normalizeUrl, routedFetch, sameUrl } from '../src/till/http';
import type { RawFetch, RawInit } from '../src/till/http';

const ASK = 'http://127.0.0.1:13338/v1/keys';
const INIT = { method: 'GET', headers: { Accept: 'application/json' } };

function fakeRaw(answer: { status: number; url?: string; contentLength?: string; body?: string }) {
  const seen: Array<{ url: string; init: RawInit }> = [];
  let reads = 0;
  const raw: RawFetch = async (url, init) => {
    seen.push({ url, init });
    return {
      status: answer.status,
      url: answer.url,
      headers: {
        get: (n: string) => (n.toLowerCase() === 'content-length' ? answer.contentLength ?? null : null),
      },
      text: async () => {
        reads += 1;
        return answer.body ?? '';
      },
    };
  };
  return { raw, seen, reads: () => reads };
}

describe('the till fetch', () => {
  it('normalizeUrl lower-cases scheme and host and drops a default port', () => {
    expect(normalizeUrl('HTTPS://Mint.Test:443/v1/keys')).toBe('https://mint.test/v1/keys');
    expect(normalizeUrl('http://127.0.0.1:80')).toBe('http://127.0.0.1/');
    expect(normalizeUrl('http://127.0.0.1:13338/v1/keys?unit=sat')).toBe(
      'http://127.0.0.1:13338/v1/keys?unit=sat',
    );
    expect(normalizeUrl('https://mint.test?x=1')).toBe('https://mint.test/?x=1');
    expect(normalizeUrl('https://mint.test/a#frag')).toBe('https://mint.test/a');
  });

  it('normalizeUrl gives null for what is not a URL', () => {
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('https://')).toBeNull();
  });

  it('sameUrl is false when either side is empty or not a URL', () => {
    expect(sameUrl(ASK, '')).toBe(false);
    expect(sameUrl('', '')).toBe(false);
    expect(sameUrl('x', 'x')).toBe(false);
    expect(sameUrl(ASK, 'HTTP://127.0.0.1:13338/v1/keys')).toBe(true);
  });

  it('guardedFetch passes a plain answer through', async () => {
    const f = fakeRaw({ status: 200, url: ASK, body: 'ok' });
    const res = await guardedFetch(f.raw, 1000)(ASK, INIT);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0].url).toBe(ASK);
    expect(f.seen[0].init).toBe(INIT);
  });

  it('guardedFetch reads the body once', async () => {
    const f = fakeRaw({ status: 200, url: ASK, body: 'ok' });
    const res = await guardedFetch(f.raw, 1000)(ASK, INIT);
    expect(await res.text()).toBe('ok');
    expect(await res.text()).toBe('ok');
    expect(f.reads()).toBe(1);
  });

  it('guardedFetch refuses a 3xx status', async () => {
    const f = fakeRaw({ status: 302, url: ASK });
    await expect(guardedFetch(f.raw, 1000)(ASK, INIT)).rejects.toMatchObject({
      name: 'RedirectRefusedError',
      status: 302,
      asked: ASK,
    });
    expect(f.reads()).toBe(0);
  });

  // slice 2.5 (ENG-905): the phone no longer follows a redirect, so the 3xx itself arrives, with the URL that was asked
  it.each([301, 302, 303, 307, 308])('guardedFetch refuses a %i answered with the original URL', async (status) => {
    const f = fakeRaw({ status, url: ASK, body: 'moved' });
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"proofs":[]}' };
    await expect(guardedFetch(f.raw, 1000)(ASK, init)).rejects.toMatchObject({
      name: 'RedirectRefusedError',
      status,
      asked: ASK,
      answered: ASK,
    });
    expect(f.seen.length).toBe(1);
    expect(f.reads()).toBe(0);
  });

  it('guardedFetch refuses an answer from another URL', async () => {
    const answered = 'http://127.0.0.1:19887/landed';
    const f = fakeRaw({ status: 200, url: answered, body: 'landed' });
    await expect(guardedFetch(f.raw, 1000)(ASK, INIT)).rejects.toMatchObject({
      name: 'RedirectRefusedError',
      answered,
      status: 200,
    });
    await expect(guardedFetch(f.raw, 1000)(ASK, INIT)).rejects.toThrow(/refused a redirect/);
    expect(f.reads()).toBe(0);
  });

  it('an answer from another port is refused', async () => {
    const asked = 'https://mint.test/v1/info';
    const answered = 'https://mint.test:8443/v1/info';
    const f = fakeRaw({ status: 200, url: answered, body: 'info' });
    await expect(guardedFetch(f.raw, 1000)(asked, INIT)).rejects.toMatchObject({
      name: 'RedirectRefusedError',
      asked,
      answered,
      status: 200,
    });
  });

  it('an answer from another scheme is refused', async () => {
    const asked = 'https://mint.test/v1/info';
    const answered = 'http://mint.test/v1/info';
    const f = fakeRaw({ status: 200, url: answered, body: 'info' });
    await expect(guardedFetch(f.raw, 1000)(asked, INIT)).rejects.toMatchObject({
      name: 'RedirectRefusedError',
      asked,
      answered,
      status: 200,
    });
  });

  it('an answer from a path with a trailing slash is refused', async () => {
    const asked = 'https://mint.test/v1/info';
    const answered = 'https://mint.test/v1/info/';
    const f = fakeRaw({ status: 200, url: answered, body: 'info' });
    await expect(guardedFetch(f.raw, 1000)(asked, INIT)).rejects.toMatchObject({
      name: 'RedirectRefusedError',
      asked,
      answered,
      status: 200,
    });
  });

  it('guardedFetch refuses an answer with no URL', async () => {
    const f = fakeRaw({ status: 200, body: 'ok' });
    await expect(guardedFetch(f.raw, 1000)(ASK, INIT)).rejects.toMatchObject({
      name: 'RedirectRefusedError',
      answered: '',
    });
    await expect(guardedFetch(f.raw, 1000)(ASK, INIT)).rejects.toThrow(/with no URL/);
  });

  it('guardedFetch refuses a body over the cap by its length header, unread', async () => {
    const f = fakeRaw({ status: 200, url: ASK, contentLength: '2000', body: 'x' });
    await expect(guardedFetch(f.raw, 1000)(ASK, INIT)).rejects.toMatchObject({
      name: 'BodyTooLargeError',
      size: 2000,
    });
    expect(f.reads()).toBe(0);
  });

  it('guardedFetch refuses a body over the cap once read', async () => {
    const f = fakeRaw({ status: 200, url: ASK, body: 'x'.repeat(1001) });
    await expect(guardedFetch(f.raw, 1000)(ASK, INIT)).rejects.toMatchObject({
      name: 'BodyTooLargeError',
      size: 1001,
    });
  });

  it('guardedFetch takes a body at the cap', async () => {
    const f = fakeRaw({ status: 200, url: ASK, contentLength: '1000', body: 'x'.repeat(1000) });
    await expect(guardedFetch(f.raw, 1000)(ASK, INIT)).resolves.toBeDefined();
  });

  it('guardedFetch passes a 4xx through for the library to read', async () => {
    const f = fakeRaw({ status: 400, url: ASK, body: '{"code":11001}' });
    const res = await guardedFetch(f.raw, 1000)(ASK, INIT);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('{"code":11001}');
  });

  it('routedFetch sends an https name to its route, keeping path and query', async () => {
    const calls: Array<{ url: string; init: RawInit }> = [];
    const inner: HttpFetch = async (url, init) => {
      calls.push({ url, init });
      return { status: 200, text: async () => 'r' };
    };
    const fetch = routedFetch({ 'mint.test': 'http://127.0.0.1:13338/' }, inner);
    const res = await fetch('https://mint.test/v1/keys/00ab?unit=sat', INIT);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:13338/v1/keys/00ab?unit=sat');
    expect(calls[0].init).toBe(INIT);
  });

  it('routedFetch matches the host whatever its case', async () => {
    const calls: string[] = [];
    const inner: HttpFetch = async (url) => {
      calls.push(url);
      return { status: 200, text: async () => 'r' };
    };
    const fetch = routedFetch({ 'mint.test': 'http://127.0.0.1:13338/' }, inner);
    await fetch('https://MINT.test/v1/info', INIT);
    expect(calls[0]).toBe('http://127.0.0.1:13338/v1/info');
  });

  it('routedFetch refuses a host with no route and a plain-http URL', async () => {
    let called = 0;
    const inner: HttpFetch = async () => {
      called += 1;
      return { status: 200, text: async () => 'r' };
    };
    const fetch = routedFetch({ 'mint.test': 'http://127.0.0.1:13338/' }, inner);
    for (const url of [
      'https://other.test/v1/info',
      'http://mint.test/v1/info',
      'https://constructor/v1/info',
    ]) {
      await expect(fetch(url, INIT)).rejects.toMatchObject({ name: 'NoRouteError' });
    }
    expect(called).toBe(0);
  });

  it('the development settings name an https mint routed to the local mint', () => {
    expect(DEV_MINT_NAME.startsWith('https://')).toBe(true);
    expect(DEV_ROUTES['mint.test']).toBe(DEV_MINT_URL);
    expect(DEV_SALE_SATS).toBe(14);
  });
});
