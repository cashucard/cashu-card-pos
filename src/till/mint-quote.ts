import type { HttpFetch } from 'cashucard';
import { lightningJson } from './lightning-http';

export function mintObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The mint returned an incomplete response.');
  return value as Record<string, unknown>;
}
export function readMintQuote(value: unknown, pubkey: string, amount: number) {
  const q = mintObject(value);
  const state = q.state,
    expires = q.expiry;
  if (
    typeof q.quote !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,256}$/.test(q.quote) ||
    q.pubkey !== pubkey ||
    (q.amount !== undefined && q.amount !== amount) ||
    (q.unit !== undefined && q.unit !== 'sat') ||
    typeof q.request !== 'string' ||
    (state !== 'UNPAID' && state !== 'PAID' && state !== 'ISSUED') ||
    (expires != null &&
      (typeof expires !== 'number' || !Number.isSafeInteger(expires * 1000) || expires <= 0))
  ) {
    throw new Error('The mint did not bind this invoice to the request.');
  }
  return {
    quote: q.quote,
    request: q.request,
    paymentHash: q.payment_hash,
    state,
    expiresAt: typeof expires === 'number' ? expires * 1000 : Infinity,
  };
}

export async function requireMinting(http: HttpFetch, mint: string, amount: number, card: boolean) {
  const info = mintObject(await lightningJson(http, mint + '/v1/info'));
  const nuts = mintObject(info.nuts),
    funding = mintObject(nuts[4]);
  const methods = funding.methods;
  const supportsAmount = (method: unknown) => {
    const m = mintObject(method);
    return (
      m.method === 'bolt11' &&
      m.unit === 'sat' &&
      (m.min_amount === undefined || (typeof m.min_amount === 'number' && m.min_amount <= amount)) &&
      (m.max_amount === undefined || (typeof m.max_amount === 'number' && m.max_amount >= amount))
    );
  };
  if (
    !(card ? [7, 9, 11, 12, 20] : [7, 9, 12, 20]).every(
      (n) => nuts[n] && mintObject(nuts[n]).supported === true,
    ) ||
    funding.disabled === true ||
    !Array.isArray(methods) ||
    !methods.some(supportsAmount)
  ) {
    throw new Error('This mint cannot receive that Lightning amount with recoverable notes.');
  }
}
