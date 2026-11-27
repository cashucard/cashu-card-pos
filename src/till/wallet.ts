// A kept delivery is a Cashu v4 bearer token. Only the mint's NUT-07 result can remove value from a withdrawal.
import { getDecodedTokenBinary, getEncodedToken, hashToCurve, type Proof } from '@cashu/cashu-ts';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';
import { YS_PER_ASK, type HttpFetch } from 'cashucard';
import { normalizeMintInput, MINT_TIMEOUT_MS } from './mint-check';
import { sameUrl } from './http';

export interface WalletBalance {
  mint: string;
  unit: string;
  available: number;
  withdrawal: { id: string; amount: number; pending: boolean } | null;
}

export interface TokenAmount {
  token: string;
  amount: number;
}

export interface WalletReader {
  readonly lightning?: import('./lightning').LightningWallet;
  walletBalances(): Promise<WalletBalance[]>;
  prepareWithdrawal(mint: string, unit: string): Promise<void>;
  withdrawalToken(id: string): Promise<string>;
  checkWithdrawal(id: string): Promise<{ amount: number; pending: boolean }>;
}

function mintAddress(mint: string): string {
  const parsed = normalizeMintInput(mint);
  if (!parsed.ok || !sameUrl(parsed.url, mint)) {
    throw new Error('The stored mint address could not be verified.');
  }
  return parsed.url;
}

export function deliveryProofs(row: TokenAmount, mint: string, unit: string): Proof[] {
  if (!row.token.startsWith('cashuB')) throw new Error('Unsupported withdrawal token.');
  // The binary codec accepts the same CBOR as cashuB, prefixed by "crawB". The
  // wire keyset IDs stay short; no mint contact is required to share a token.
  const cbor = base64urlnopad.decode(row.token.slice(6).replace(/=+$/, ''));
  const raw = new Uint8Array(5 + cbor.length);
  raw.set([99, 114, 97, 119, 66]);
  raw.set(cbor, 5);
  const decoded = getDecodedTokenBinary(raw);
  if (
    !sameUrl(decoded.mint, mint) ||
    decoded.unit !== unit ||
    !decoded.proofs.length ||
    proofAmount(decoded.proofs) !== row.amount
  ) {
    throw new Error('The stored token does not match its wallet entry.');
  }
  return decoded.proofs;
}

function proofAmount(proofs: Proof[]): number {
  let sum = 0;
  for (const proof of proofs) {
    const n = proof.amount.toNumber();
    if (!Number.isSafeInteger(n) || n <= 0 || !proof.secret) throw new Error('Invalid withdrawal proof.');
    sum += n;
  }
  if (!Number.isSafeInteger(sum)) throw new Error('Invalid withdrawal amount.');
  return sum;
}

export function combineDeliveries(mint: string, unit: string, rows: TokenAmount[]): TokenAmount {
  const url = mintAddress(mint);
  const proofs = rows.flatMap((row) => deliveryProofs(row, url, unit));
  if (!proofs.length || new Set(proofs.map((p) => p.secret)).size !== proofs.length) {
    throw new Error('The withdrawal has missing or duplicate proofs.');
  }
  return { token: getEncodedToken({ mint: url, unit, proofs }), amount: proofAmount(proofs) };
}

type ProofState = 'SPENT' | 'PENDING' | 'UNSPENT';

export async function checkStates(http: HttpFetch, mint: string, ys: string[]): Promise<Map<string, ProofState>> {
  const states = new Map<string, ProofState>();
  for (let i = 0; i < ys.length; i += YS_PER_ASK) {
    const group = ys.slice(i, i + YS_PER_ASK);
    const expected = new Set(group);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);
    try {
      const r = await http(mint + '/v1/checkstate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Ys: group }),
        signal: controller.signal,
        redirect: 'manual',
      });
      if (r.status !== 200 || r.redirected || (r.url && !sameUrl(r.url, mint + '/v1/checkstate'))) {
        throw new Error('The mint could not confirm redemption.');
      }
      const result = JSON.parse(await r.text());
      if (!Array.isArray(result?.states) || result.states.length !== group.length) {
        throw new Error('The mint returned incomplete proof states.');
      }
      for (const item of result.states) {
        const y = typeof item?.Y === 'string' ? item.Y.toLowerCase() : '';
        if (!expected.delete(y) || !['SPENT', 'PENDING', 'UNSPENT'].includes(item.state)) {
          throw new Error('The mint returned an unexpected proof state.');
        }
        states.set(y, item.state);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  return states;
}

export async function remainingWithdrawal(
  http: HttpFetch,
  mint: string,
  unit: string,
  current: TokenAmount,
): Promise<TokenAmount & { pending: boolean }> {
  const url = mintAddress(mint);
  const proofs = deliveryProofs(current, url, unit);
  const ys = proofs.map((p) => hashToCurve(utf8ToBytes(p.secret)).toHex(true));
  if (new Set(ys).size !== ys.length) throw new Error('Duplicate withdrawal proofs.');
  const states = await checkStates(http, url, ys);
  const left = proofs.filter((_, i) => states.get(ys[i]) !== 'SPENT');
  const pending = ys.some((y) => states.get(y) === 'PENDING');
  const amount = proofAmount(left);
  const token =
    left.length === proofs.length
      ? current.token
      : left.length
        ? getEncodedToken({ mint: url, unit, proofs: left })
        : '';
  return { amount, token, pending };
}
