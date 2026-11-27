import { Amount, OutputData, createRandomSecretKey, getEncodedToken, getPubKeyFromPrivKey, hashToCurve, signMintQuote, verifyDleqIfPresent } from '@cashu/cashu-ts';
import type { SerializedOutputData } from '@cashu/cashu-ts';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { CardError, type HttpFetch } from 'cashucard';
import { verifyMintInvoice } from './lightning-address';
import { lightningJson } from './lightning-http';
import { mintWallet } from './lightning-transport';
import { normalizeMintInput } from './mint-check';
import { mintObject, readMintQuote, requireMinting } from './mint-quote';
import type { LightningSaleRecord, LightningSaleStore } from './store/lightning-sales';
import { checkStates } from './wallet';

export interface LightningSaleReceipt {
  saleId: string;
  paymentId: string;
  mint: string;
  amount: number;
  invoice: string;
  expiresAt: number;
  createdAt: number;
  paidAt?: number;
  state: 'unpaid' | 'expired' | 'processing' | 'paid' | 'extra';
}

export class LightningStatusUnknown extends CardError {
  constructor(readonly saleId: string) {
    super('busy', 'Reconnect to check the Lightning invoice before taking another payment.');
  }
}

export class LightningPaymentReceived extends CardError {
  constructor(readonly receipt: LightningSaleReceipt) {
    super('same-sale', 'This invoice has already received a payment.');
  }
}

export async function createLightningInvoice(
  http: HttpFetch,
  mint: string,
  saleId: string,
  amount: number,
  now: () => number,
): Promise<LightningSaleRecord> {
  const [wallet] = await Promise.all([mintWallet(http, mint), requireMinting(http, mint, amount, false)]);
  const keys = wallet.keyChain.getCheapestKeyset();
  if (!keys.isActive || !keys.verify()) throw new Error('The mint has no verified issuing keys.');
  // Persist the original blinding data before the first customer or portable backup can see
  // the invoice. Either copy can then recover precisely the same notes after a lost reply.
  const outputs = OutputData.createRandomData(amount, keys).map(OutputData.serialize);
  const signingKey = createRandomSecretKey();
  const pubkey = bytesToHex(getPubKeyFromPrivKey(signingKey));
  const quote = readMintQuote(
    await lightningJson(http, mint + '/v1/mint/quote/bolt11', { amount, unit: 'sat', pubkey }),
    pubkey,
    amount,
  );
  const invoice = verifyMintInvoice(quote.request, now());
  const expiresAt = Math.min(invoice.expiresAt, quote.expiresAt);
  if (
    quote.state !== 'UNPAID' ||
    invoice.sats !== amount ||
    expiresAt <= now() ||
    (quote.paymentHash != null && quote.paymentHash !== invoice.paymentHash)
  ) {
    throw new Error('This mint did not offer an invoice for the exact sale price.');
  }
  return {
    saleId,
    paymentId: 'ln-' + saleId,
    mint,
    amount,
    invoice: quote.request,
    quote: quote.quote,
    expiresAt,
    createdAt: now(),
    state: 'unpaid',
    signingKey: bytesToHex(signingKey),
    pubkey,
    outputs,
  };
}

export async function checkMintQuote(http: HttpFetch, r: LightningSaleRecord) {
  const checked = normalizeMintInput(r.mint);
  if (!checked.ok || checked.url !== r.mint || !/^[A-Za-z0-9_-]{1,256}$/.test(r.quote))
    throw new Error('The saved mint quote is invalid.');
  const q = readMintQuote(
    await lightningJson(http, r.mint + '/v1/mint/quote/bolt11/' + r.quote),
    r.pubkey,
    r.amount,
  );
  if (q.quote !== r.quote || q.request !== r.invoice)
    throw new Error('The mint did not confirm the saved invoice.');
  return q.state;
}

function message(o: SerializedOutputData) {
  return { ...o.blindedMessage, amount: Number(o.blindedMessage.amount) };
}
type Signature = { amount: number; id: string; C_: string; dleq?: { e: string; s: string } };

async function restore(http: HttpFetch, r: LightningSaleRecord, keyset: string): Promise<Signature[]> {
  const outputs = r.outputs!.map((o) => ({ ...message(o), id: keyset }));
  const reply = mintObject(await lightningJson(http, r.mint + '/v1/restore', { outputs }));
  const found = reply.outputs,
    sigs = reply.signatures ?? reply.promises;
  if (
    !Array.isArray(found) ||
    !Array.isArray(sigs) ||
    sigs.length !== found.length ||
    (found.length !== 0 && found.length !== outputs.length)
  )
    throw new Error('The mint has not restored all the notes yet.');
  if (!found.length) return [];
  return outputs.map((o) => {
    const i = found.findIndex((x) => x && x.B_ === o.B_ && x.amount === o.amount);
    if (i < 0 || !sigs[i] || (found[i].id !== keyset && found[i].id !== sigs[i].id))
      throw new Error('The mint returned different outputs.');
    return sigs[i];
  });
}

/** A restore never invents replacement note secrets. A rotated keyset can sign the same saved
 * blinded messages only when the quote is still unissued and all previous issue attempts have been checked. */
export async function claimLightningInvoice(
  http: HttpFetch,
  store: LightningSaleStore,
  r: LightningSaleRecord,
  now: () => number,
): Promise<void> {
  if (!r.signingKey || !r.outputs?.length || !r.destination || r.state !== 'processing')
    throw new Error('The paid invoice needs recovery.');
  const wallet = await mintWallet(http, r.mint);
  const savedKeys = [r.outputs[0].blindedMessage.id, ...(r.previousKeysets ?? [])];
  let signatures: Signature[] = [];
  for (const keyset of savedKeys) {
    signatures = await restore(http, r, keyset);
    if (signatures.length) break;
  }
  const recovered = signatures.length > 0;
  if (!recovered) {
    if ((await checkMintQuote(http, r)) !== 'PAID') throw new Error('The paid notes are being recovered.');
    const active = wallet.keyChain.getCheapestKeyset();
    if (!active.isActive || !active.verify()) throw new Error('The mint has no verified issuing keys.');
    if (r.outputs[0].blindedMessage.id !== active.id) {
      if (r.outputs.some((o) => !active.keys[Number(o.blindedMessage.amount)]))
        throw new Error('The mint cannot yet issue these saved notes.');
      const previous = [r.outputs[0].blindedMessage.id, ...(r.previousKeysets ?? [])];
      r.previousKeysets = previous.filter((k) => k !== active.id);
      r.outputs = r.outputs.map((o) => ({ ...o, blindedMessage: { ...o.blindedMessage, id: active.id } }));
    }
    await store.save(r, now());
    const outputs = r.outputs.map(message);
    const signature = signMintQuote(
      r.signingKey,
      r.quote,
      outputs.map((o) => ({ ...o, amount: Amount.from(o.amount) })),
    );
    const raw = mintObject(
      await lightningJson(http, r.mint + '/v1/mint/bolt11', { quote: r.quote, outputs, signature }),
    );
    if (!Array.isArray(raw.signatures)) throw new Error('The mint has not confirmed issuance.');
    signatures = raw.signatures;
  }
  if (!r.outputs || signatures.length !== r.outputs.length)
    throw new Error('The mint returned an incomplete payment.');
  const id = signatures[0]?.id;
  // A portable copy may predate the key rotation under which these *same* secrets
  // were signed. A restored signature still has to verify against the mint's sat keys.
  if (!id || (!recovered && id !== r.outputs[0].blindedMessage.id))
    throw new Error('The mint returned different notes.');
  await wallet.ensureOperableKeysets([id]);
  const keys = wallet.keyChain.getKeyset(id);
  if (keys.unit !== 'sat' || !keys.verify()) throw new Error('The mint keys could not be verified.');
  const proofs = r.outputs.map((o, i) => {
    const sig = signatures[i];
    if (!sig?.dleq || sig.id !== id || sig.amount !== Number(o.blindedMessage.amount))
      throw new Error('The minted amount could not be verified.');
    const output = OutputData.deserialize({ ...o, blindedMessage: { ...o.blindedMessage, id } });
    const p = output.toProof({ ...sig, amount: Amount.from(sig.amount) }, keys);
    if (!p.dleq || !verifyDleqIfPresent(p, keys)) throw new Error('The minted notes could not be verified.');
    return p;
  });
  const ys = proofs.map((p) => hashToCurve(utf8ToBytes(p.secret)).toHex(true));
  if (new Set(ys).size !== proofs.length || proofs.reduce((a, p) => a + p.amount.toNumber(), 0) !== r.amount)
    throw new Error('The original sale amount was not recovered.');
  const states = await checkStates(http, r.mint, ys);
  if (!ys.every((y) => states.get(y) === 'UNSPENT'))
    throw new Error('The saved notes are no longer all spendable.');
  await store.post(r, getEncodedToken({ mint: r.mint, unit: 'sat', proofs }), now());
}
