import type { HttpFetch } from 'cashucard';
import { cardsimTransport } from '../src/till/dev-transport';

interface Seen {
  url: string;
  method: string;
  body: string;
}

function fakeHttp(answer: { status?: number; text?: string } = {}) {
  const seen: Seen[] = [];
  const fetchFn: HttpFetch = async (url, init) => {
    seen.push({ url, method: init.method, body: init.body ?? '' });
    const status = answer.status ?? 200;
    const text = answer.text ?? '';
    return { status, text: async () => text };
  };
  return { fetchFn, seen };
}

describe('the development card transport', () => {
  it('begin posts an empty fixture and counts the tap', async () => {
    const f = fakeHttp();
    const t = cardsimTransport('http://x', f.fetchFn, 1000);
    await t.begin!('tap the card');
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0].url).toBe('http://x/fixture');
    expect(f.seen[0].method).toBe('POST');
    expect(f.seen[0].body).toBe('{}');
    expect(t.taps).toBe(1);
  });

  it('transceive posts the command as lower-case hex and answers its bytes', async () => {
    const f = fakeHttp({ text: '{"hex":"03009000","sw":"9000"}' });
    const t = cardsimTransport('http://x', f.fetchFn, 1000);
    const answer = await t.transceive(new Uint8Array([0x00, 0xa4, 0x04, 0x00]));
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0].url).toBe('http://x/apdu');
    expect(f.seen[0].method).toBe('POST');
    expect(f.seen[0].body).toBe('{"hex":"00a40400"}');
    expect(answer).toEqual(new Uint8Array([3, 0, 0x90, 0]));
    expect(t.sent).toEqual(['00a40400']);
  });

  it('an upper-case answer is read the same', async () => {
    const f = fakeHttp({ text: '{"hex":"6A82","sw":"6A82"}' });
    const t = cardsimTransport('http://x', f.fetchFn, 1000);
    const answer = await t.transceive(new Uint8Array([0x00, 0xa4, 0x04, 0x00]));
    expect(answer).toEqual(new Uint8Array([0x6a, 0x82]));
  });

  it('a base with a trailing slash is joined once', async () => {
    const f = fakeHttp({ text: '{"hex":"9000"}' });
    const t = cardsimTransport('http://x/', f.fetchFn, 1000);
    await t.transceive(new Uint8Array([0x00, 0xa4, 0x04, 0x00]));
    expect(f.seen[0].url).toBe('http://x/apdu');
  });

  it('a status other than 200 throws with the status', async () => {
    const f = fakeHttp({ status: 400, text: 'bad' });
    const t = cardsimTransport('http://x', f.fetchFn, 1000);
    await expect(t.transceive(new Uint8Array([0x00, 0xa4, 0x04, 0x00]))).rejects.toThrow(/answered 400/);
  });

  it('an answer without hex throws', async () => {
    const noHex = fakeHttp({ text: '{"error":"x"}' });
    await expect(
      cardsimTransport('http://x', noHex.fetchFn, 1000).transceive(new Uint8Array([0x00, 0xa4, 0x04, 0x00])),
    ).rejects.toThrow(/no answer hex/);
    const oneByte = fakeHttp({ text: '{"hex":"90"}' });
    await expect(
      cardsimTransport('http://x', oneByte.fetchFn, 1000).transceive(new Uint8Array([0x00, 0xa4, 0x04, 0x00])),
    ).rejects.toThrow(/no answer hex/);
  });

  it('a command that takes too long is stopped', async () => {
    const stuck: HttpFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        (init.signal as unknown as { addEventListener(t: string, f: () => void): void }).addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      });
    await expect(
      cardsimTransport('http://x', stuck, 20).transceive(new Uint8Array([0, 0xa4, 4, 0])),
    ).rejects.toThrow(/timed out after 20 ms/);
  });
});
