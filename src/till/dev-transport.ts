import type { CardTransport, HttpFetch } from 'cashucard';
import { fromHex, toHex } from './hex';

/** The card simulator's transport, and what it has carried. */
export interface DevTransport extends CardTransport {
  /** each command's APDU as lower-case hex, in order */
  readonly sent: string[];
  /** taps so far (begin calls) */
  taps: number;
}

type Answer = { status: number; text(): Promise<string> };

/** The transport of the card simulator (cardsim) over HTTP: one fixture call per tap, one APDU call per command. */
export function cardsimTransport(base: string, fetchFn: HttpFetch, timeoutMs: number): DevTransport {
  const root = base.replace(/\/+$/, '');

  async function post(path: string, body: string): Promise<string> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let r: Answer;
    let text: string;
    try {
      r = await fetchFn(root + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctl.signal,
      });
      text = await r.text();
    } catch (e) {
      if (ctl.signal.aborted) {
        throw new Error('cardsim ' + path + ' timed out after ' + timeoutMs + ' ms');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (r.status !== 200) {
      throw new Error('cardsim ' + path + ' answered ' + r.status + ': ' + text.slice(0, 200));
    }
    return text;
  }

  const sent: string[] = [];
  const t: DevTransport = {
    sent,
    taps: 0,
    async begin(_prompt: string): Promise<void> {
      await post('/fixture', '{}');
      t.taps += 1;
    },
    async transceive(apdu: Uint8Array): Promise<Uint8Array> {
      const hex = toHex(apdu);
      sent.push(hex);
      const text = await post('/apdu', JSON.stringify({ hex }));
      const j = JSON.parse(text) as { hex?: unknown };
      if (typeof j.hex !== 'string' || !/^([0-9a-fA-F]{2}){2,}$/.test(j.hex)) {
        throw new Error('cardsim /apdu gave no answer hex');
      }
      return fromHex(j.hex);
    },
    async end(): Promise<void> {
      // nothing to close: the simulator keeps no session between calls
    },
    setMessage(_text: string): void {
      // the simulator shows no sheet
    },
  };
  return t;
}
