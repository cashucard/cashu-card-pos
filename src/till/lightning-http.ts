import { JSONInt } from '@cashu/cashu-ts';
import type { HttpFetch } from 'cashucard';
import { MAX_BODY_BYTES, sameUrl } from './http';
import { MINT_TIMEOUT_MS } from './mint-check';

/** Only locally authored messages may be shown to the merchant. */
export class LightningTransportError extends Error {}
export class LightningFundsError extends LightningTransportError {
  constructor() { super('The available takings do not cover this amount and its fees.'); }
}

export async function lightningJson(http: HttpFetch, url: string, body?: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);
  try {
    const response = await http(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSONInt.stringify(body),
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status !== 200 || response.redirected || (response.url && !sameUrl(response.url, url))) {
      throw new Error();
    }
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) throw new Error();
    return JSONInt.parse(text);
  } catch {
    throw new LightningTransportError('The payment service did not return a usable response.');
  } finally {
    clearTimeout(timer);
  }
}
