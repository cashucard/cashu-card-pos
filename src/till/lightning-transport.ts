import { Amount, Mint, OutputData, Wallet, deserializeProofs, getEncodedToken, hashToCurve, serializeProofs } from '@cashu/cashu-ts';
import type { Proof, RequestFn, SerializedBlindedSignature, SerializedOutputData } from '@cashu/cashu-ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { HttpFetch } from 'cashucard';
import { sameUrl } from './http';
import { addressInvoice, normalizeLightningAddress } from './lightning-address';
import { lightningJson, LightningFundsError, LightningTransportError } from './lightning-http';
import { planSplit, splitLightning, toMintInputs, type LightningSplit } from './lightning-split';
import { normalizeMintInput } from './mint-check';
import { checkStates, type TokenAmount } from './wallet';
import type { VerifiedLightningOverage } from './store/lightning';

export { normalizeLightningAddress, LightningFundsError, LightningTransportError };

export interface LightningPlan {
  mint: string;
  address: string;
  amount: number;
  /** Optional display-only text supplied by the verified Lightning address. */
  description?: string;
  paymentHash: string;
  invoice: string;
  quoteId: string;
  expiresAt: number;
  /** Wait for both the invoice and quote to expire before releasing a transmitted reservation. */
  releaseAfter: number;
  inputIds: string[];
  /** Face value of all reserved deliveries, including pieces unneeded by the melt. */
  inputAmount: number;
  inputFee: number;
  /** Original provider fee reserve. Legacy plans predate physical fee bounds. */
  quoteReserve?: number;
  split?: LightningSplit;
  /** A restored database can reconcile these outputs but cannot authorize a fresh payment. */
  reconcileOnly?: boolean;
  maxFee: number;
  /** Private. Only the encrypted ledger may store these bearer proofs and change secrets. */
  inputs: string[];
  retained: string[];
  outputs: SerializedOutputData[];
}

export type LightningResult =
  | { state: 'pending' }
  | { state: 'paid'; change: TokenAmount | null; verifiedOverage?: VerifiedLightningOverage }
  | { state: 'reshaped'; plan: LightningPlan; replacement: TokenAmount }
  | { state: 'failed' };

interface PrepareRequest {
  mint: string;
  address: string;
  amount: number;
  feeCap?: number;
  rows: Array<TokenAmount & { id: string }>;
  now: () => number;
}

function satTotal(proofs: Proof[]): number {
  const amount = proofs.reduce((total, proof) => total + proof.amount.toNumber(), 0);
  if (!Number.isSafeInteger(amount)) throw new Error();
  return amount;
}

function mintUrl(mint: string): string {
  const parsed = normalizeMintInput(mint);
  if (!parsed.ok || !sameUrl(mint, parsed.url)) throw new LightningTransportError('This mint address could not be verified.');
  return parsed.url;
}

export async function mintWallet(http: HttpFetch, mint: string): Promise<Wallet> {
  // Only fetch public keysets and mint information through the SDK. Payment submission is exactly one
  // explicit POST after the application has persisted the inputs, quote id and private change outputs.
  const request: RequestFn = async <T>({ endpoint, method = 'GET' }: { endpoint: string; method?: string }) => {
    if (method !== 'GET' || !endpoint.startsWith(mint + '/') ||
        !/^\/v1\/(info|keysets|keys(?:\/[a-fA-F0-9]+)?)$/.test(endpoint.slice(mint.length))) throw new Error();
    return await lightningJson(http, endpoint) as T;
  };
  const wallet = new Wallet(new Mint(mint, { customRequest: request }), { unit: 'sat' });
  await wallet.loadMint();
  return wallet;
}

type RawQuote = {
  quote?: unknown; amount?: unknown; fee_reserve?: unknown; unit?: unknown; request?: unknown;
  method?: unknown; expiry?: unknown; state?: unknown; change?: unknown; payment_preimage?: unknown;
};

function validQuote(value: unknown, invoice: string, amount: number) {
  const q = value as RawQuote | null;
  if (!q || typeof q.quote !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(q.quote) ||
      q.unit !== 'sat' || q.request !== invoice || q.amount !== amount ||
      (q.method !== undefined && q.method !== 'bolt11') ||
      typeof q.fee_reserve !== 'number' || !Number.isSafeInteger(q.fee_reserve) || q.fee_reserve < 0 ||
      typeof q.expiry !== 'number' || !Number.isSafeInteger(q.expiry * 1000) || q.expiry <= 0 ||
      !['PAID', 'PENDING', 'UNPAID'].includes(String(q.state))) {
    throw new LightningTransportError('The mint returned an incomplete or mismatched Lightning quote.');
  }
  return { ...q, quote: q.quote, reserve: q.fee_reserve, expiry: q.expiry * 1000 };
}

/** Quoting only obtains an invoice and reads and prepares local proofs. It never sends a proof. */
export async function prepareLightning(http: HttpFetch, request: PrepareRequest): Promise<LightningPlan> {
  try {
    const { amount, rows, now } = request;
    const mint = mintUrl(request.mint);
    const address = normalizeLightningAddress(request.address);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new LightningTransportError('Enter a positive amount in whole sats.');
    }
    if (amount > rows.reduce((sum, row) => sum + row.amount, 0)) throw new LightningFundsError();
    const wallet = await mintWallet(http, mint);
    const info = wallet.getMintInfo();
    if (!info.supportsMintMeltMethod('melt', 'bolt11', 'sat')) {
      throw new LightningTransportError('This mint does not support Lightning withdrawals in sats.');
    }
    if (!info.isSupported(7).supported) {
      throw new LightningTransportError('This mint cannot confirm which takings were spent.');
    }
    const { invoice, paymentHash, description, expiresAt: invoiceExpiry } = await addressInvoice(http, address, amount, now);
    const q = validQuote(await lightningJson(http, mint + '/v1/melt/quote/bolt11', { unit: 'sat', request: invoice }), invoice, amount);
    const expiresAt = Math.min(invoiceExpiry, q.expiry);
    if (q.state !== 'UNPAID' || expiresAt <= now()) throw new LightningTransportError('The Lightning quote is no longer available.');

    const proofs: Proof[] = [];
    const owners = new Map<string, string>();
    const rowIds = new Set<string>();
    for (const row of rows) {
      if (!row.token.startsWith('cashuB') || rowIds.has(row.id)) throw new Error();
      rowIds.add(row.id);
      const token = wallet.decodeToken(row.token);
      if (!sameUrl(token.mint, mint) || token.unit !== 'sat' || !token.proofs.length || satTotal(token.proofs) !== row.amount) {
        throw new Error();
      }
      for (const proof of token.proofs) {
        if (owners.has(proof.secret) || proof.amount.isZero()) throw new Error();
        owners.set(proof.secret, row.id);
        proofs.push(proof);
      }
    }
    const required = amount + q.reserve;
    if (!Number.isSafeInteger(required) || required > satTotal(proofs)) throw new LightningFundsError();
    const { send, keep } = wallet.selectProofsToSend(proofs, required, true);
    const inputFee = wallet.getFeesForProofs(send).toNumber();
    const submitted = satTotal(send);
    if (submitted < required + inputFee) throw new LightningFundsError();
    const nut08Change = info.isSupported(8).supported;
    if (submitted > amount + inputFee && (!nut08Change || !info.isSupported(9).supported || !info.isSupported(12).supported)) {
      throw new LightningTransportError('This mint cannot return verifiable, recoverable change for this withdrawal.');
    }
    const quotedFee = inputFee + q.reserve;
    const maxFee = Math.min(request.feeCap ?? quotedFee, submitted - amount);
    if (!Number.isSafeInteger(maxFee) || maxFee < quotedFee || !Number.isSafeInteger(amount + maxFee)) {
      throw new LightningTransportError('The quoted fees exceed your sweep fee limit.');
    }
    // A large denomination lets a misbehaving mint keep more than its quoted fee. Bound the face
    // value before sending. The merchant keeps any extra proofs locally throughout the melt.
    const split = submitted > amount + maxFee ? planSplit(wallet, send, amount + maxFee, submitted) : undefined;
    const ids = new Set(send.map(p => owners.get(p.secret)!));
    const retained = keep.filter(p => ids.has(owners.get(p.secret)!));
    const preview = await wallet.prepareMelt('bolt11', { quote: q.quote, amount: Amount.from(amount) }, send, { nut08Change });
    return {
      mint: request.mint, address, amount, invoice, description, paymentHash, quoteId: q.quote, expiresAt,
      releaseAfter: Math.max(invoiceExpiry, q.expiry), inputAmount: submitted + satTotal(retained),
      inputIds: Array.from(ids), inputFee, maxFee, quoteReserve: q.reserve, ...(split && { split }),
      inputs: serializeProofs(send), retained: serializeProofs(retained), outputs: preview.outputData.map(o => OutputData.serialize(o)),
    };
  } catch (e) {
    if (e instanceof LightningTransportError) throw e;
    throw new LightningTransportError('Could not prepare the withdrawal with this mint.');
  }
}

/** Call only for the first dispatch of a durably reserved plan. Recover using checkLightning. */
export async function submitLightning(http: HttpFetch, plan: LightningPlan, now: () => number): Promise<LightningResult> {
  const mint = mintUrl(plan.mint);
  if (plan.reconcileOnly || now() >= plan.expiresAt) return checkLightning(http, plan, now);
  if (plan.split) {
    try { return await splitLightning(http, mint, plan, () => mintWallet(http, mint), false); }
    catch { return { state: 'pending' }; }
  }
  const selected = deserializeProofs(plan.inputs);
  // Also protect quotes created by older builds but never submitted. Recovery of previously sent
  // plans runs separately and can still establish the true receipt for their original invoice.
  if (satTotal(selected) > plan.amount + plan.maxFee) return { state: 'failed' };
  const inputs = toMintInputs(selected);
  const outputs = wireOutputs(plan);
  // Never resubmit on a timeout. Some mints return immediately, others settle before replying.
  try {
    const response = await lightningJson(http, mint + '/v1/melt/bolt11', { quote: plan.quoteId, inputs, outputs });
    // With a separate merchant fee cap the original status endpoint is the source of the final
    // receipt, even when a mint replies PAID immediately and the entire allowed fee was consumed.
    if (plan.quoteReserve !== undefined && plan.maxFee > plan.quoteReserve + plan.inputFee) {
      return checkLightning(http, plan, now);
    }
    return await interpretQuote(http, plan, response, now);
  } catch {
    return { state: 'pending' };
  }
}

function wireOutputs(plan: LightningPlan) {
  return plan.outputs.map(o => ({ ...o.blindedMessage, amount: Number(o.blindedMessage.amount) }));
}

/** NUT-09 lets a mint return only the blanks it actually signed, in any order. */
async function restoreChange(http: HttpFetch, mint: string, plan: LightningPlan) {
  const restored = await lightningJson(http, mint + '/v1/restore', { outputs: wireOutputs(plan) }) as {
    outputs?: unknown; signatures?: unknown;
  } | null;
  if (!restored || !Array.isArray(restored.outputs) || !Array.isArray(restored.signatures) ||
      restored.signatures.length !== restored.outputs.length || restored.outputs.length > plan.outputs.length) throw new Error();
  const originals = new Map(plan.outputs.map(o => [o.blindedMessage.B_, o]));
  const signatures = restored.signatures;
  const blanks = restored.outputs.map((o, i) => {
    const original = originals.get(o?.B_);
    const sig = signatures[i];
    if (!original || !sig || o.id !== original.blindedMessage.id || sig.id !== o.id ||
        !Number.isSafeInteger(o.amount) || (o.amount !== 0 && o.amount !== sig.amount)) throw new Error();
    originals.delete(o.B_);
    return original;
  });
  // NUT-08 assigns value to the leading blanks. NUT-09 may reorder them, but a gap
  // means this response cannot establish the complete change for the original melt.
  if (plan.outputs.slice(0, blanks.length).some(o => originals.has(o.blindedMessage.B_))) throw new Error();
  return { blanks, signatures };
}

export async function checkLightning(http: HttpFetch, plan: LightningPlan, now: () => number, quarantined = false): Promise<LightningResult> {
  try {
    const mint = mintUrl(plan.mint);
    const status = () => lightningJson(http, mint + '/v1/melt/quote/bolt11/' + encodeURIComponent(plan.quoteId));
    if (plan.split) {
      // A restored plan may observe an issued swap. If these outputs were never issued,
      // release only after the original quote expires and every original melt input is unspent.
      return await splitLightning(http, mint, plan, () => mintWallet(http, mint), true, async () => {
        const result = await interpretQuote(http, plan, await status(), now);
        return result.state === 'failed' ? result : { state: 'pending' };
      }, quarantined);
    }
    return await interpretQuote(http, plan, await status(), now);
  } catch {
    return { state: 'pending' };
  }
}

async function interpretQuote(http: HttpFetch, plan: LightningPlan, raw: unknown, now: () => number): Promise<LightningResult> {
  const q = validQuote(raw, plan.invoice, plan.amount);
  if (q.quote !== plan.quoteId || q.reserve !== (plan.quoteReserve ?? plan.maxFee - plan.inputFee)) return { state: 'pending' };
  if (q.state === 'PENDING' || (q.state === 'UNPAID' && now() < Math.max(plan.releaseAfter, q.expiry))) return { state: 'pending' };
  const mint = mintUrl(plan.mint);
  const inputs = deserializeProofs(plan.inputs);
  const ys = inputs.map(p => hashToCurve(utf8ToBytes(p.secret)).toHex(true));
  const states = await checkStates(http, mint, ys);
  if (q.state === 'UNPAID') {
    return ys.every(y => states.get(y) === 'UNSPENT') ? { state: 'failed' } : { state: 'pending' };
  }
  if (!ys.every(y => states.get(y) === 'SPENT')) return { state: 'pending' };
  if (q.payment_preimage != null && (typeof q.payment_preimage !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(q.payment_preimage) || bytesToHex(sha256(hexToBytes(q.payment_preimage))) !== plan.paymentHash)) {
    return { state: 'pending' };
  }
  let wallet: Wallet | undefined;
  async function verify(blanks: SerializedOutputData[], raw: unknown): Promise<Proof[]> {
    if (!Array.isArray(raw) || raw.length > blanks.length) throw new Error();
    if (!raw.length) return [];
    const sigs: SerializedBlindedSignature[] = raw.map(s => {
      if (!s || typeof s.id !== 'string' || typeof s.C_ !== 'string' ||
          !Number.isSafeInteger(s.amount) || s.amount < 0 || (s.amount > 0 && !s.dleq)) throw new Error();
      return { ...s, amount: Amount.from(s.amount) };
    });
    wallet ??= await mintWallet(http, mint);
    await wallet.ensureOperableKeysets(sigs.filter(s => !s.amount.isZero()).map(s => s.id));
    // The SDK verifies each DLEQ against this precise blank and denomination.
    return wallet.createMeltChangeProofs(blanks.map(o => OutputData.deserialize(o)), sigs);
  }
  const retained = deserializeProofs(plan.retained);
  if (satTotal(inputs) + satTotal(retained) !== plan.inputAmount) return { state: 'pending' };
  const inline = await verify(plan.outputs, q.change ?? []);
  let refund = inline;
  const costOf = (change: Proof[]) => plan.inputAmount - satTotal(retained) - satTotal(change) - plan.amount;
  let cost = costOf(inline);
  let verifiedOverage: VerifiedLightningOverage | undefined;
  const quoteFee = plan.inputFee + q.reserve;
  const bounded = plan.quoteReserve !== undefined && satTotal(inputs) <= plan.amount + plan.maxFee;
  if (plan.outputs.length && (q.change == null || cost < plan.inputFee || cost > plan.maxFee ||
      (bounded && cost > quoteFee))) {
    // A truncated reply can look exactly like a high fee. Query every original blank and
    // verify the mint's independent answer before reporting what the merchant actually got.
    const restored = await restoreChange(http, mint, plan);
    refund = await verify(restored.blanks, restored.signatures);
    const bySecret = new Map(refund.map(p => [p.secret, p]));
    if (inline.some(p => {
      const recovered = bySecret.get(p.secret);
      return !recovered || p.id !== recovered.id || p.C !== recovered.C || !p.amount.equals(recovered.amount);
    })) return { state: 'pending' };
    cost = costOf(refund);
    // Disclosing an overcharge requires the same complete nonempty set of signed change
    // from both endpoints. Never turn an empty or partial recovery into a merchant fee.
    if ((bounded && cost > quoteFee && cost <= plan.maxFee && q.payment_preimage) ||
        (cost > plan.maxFee && inline.length && inline.length === refund.length)) {
      verifiedOverage = { paymentHash: plan.paymentHash, actualFee: cost };
    }
  }
  // An omitted inline refund initially looks like a high fee. Require preimage evidence for
  // a bounded overcharge only after restoration has established the actual amount.
  if (cost < plan.inputFee || (cost > plan.maxFee && !verifiedOverage) ||
      (bounded && cost > quoteFee && !verifiedOverage)) return { state: 'pending' };
  const changeProofs = [...retained, ...refund];
  const amount = satTotal(changeProofs);
  return {
    state: 'paid',
    change: amount ? { amount, token: getEncodedToken({ mint, unit: 'sat', proofs: changeProofs }) } : null,
    ...(verifiedOverage && { verifiedOverage }),
  };
}
