import { getDecodedToken, getTokenMetadata, PaymentRequest } from '@cashu/cashu-ts';
import { CardError, OfferError, parseOffer, type Asked, type CashuCard, type HttpFetch, type Journal, type Payment, type Row, type Sale } from 'cashucard';
import { askMint, MINT_TIMEOUT_MS } from './mint-check';

export type PhonePaymentResult =
  | { kind: 'paid'; payment: Payment }
  | { kind: 'pending'; message: string; paymentId?: string }
  | { kind: 'refused'; message: string }
  | { kind: 'return'; message: string };

export class PhonePaymentError extends Error {}
const EXACT = 'Ask the wallet to send the exact sale amount plus the mint’s input fee.';
const UNREADABLE = 'Use the Cashu token or payment response from the customer’s wallet.';
const CHECKING = 'The mint has not confirmed this payment. Keep the original token and check Activity before paying again.';
const MAX_PAYMENT_CHARS = 512 * 1024;
const MAX_PROOFS = 300;
const mintName = (mint: string) => mint.replace(/\/+$/, '');

class InexactPhonePayment extends CardError {
  constructor() { super('refused', EXACT); }
}

/** The SDK normally lets the payer donate sub-fee dust or receive change. At the
 * first durable write, its own mint-checked swap must match this checkout exactly.
 * Existing intents (including ones restored from a backup) must still settle. */
export async function writeExactPhonePayment(journal: Journal, row: Row): Promise<void> {
  if (row.kind === 'payment' && row.how === 'ecash' && row.step === 'signed' && row.swap &&
      (row.kept || row.swap.change.length) && !await journal.read(row.id)) {
    throw new InexactPhonePayment();
  }
  await journal.write(row);
}

type SaleLookup = (id: string) => Promise<Row | null>;

async function offerFor(sale: Sale, lookup?: SaleLookup): Promise<{ request: string; asked: Asked }> {
  try {
    const { request, asked } = parseOffer(sale.offer());
    if (request && asked?.id && asked.unit === 'sat' && asked.mints.length) return { request, asked };
  } catch (e) {
    // The NFC offer wraps the request in a fixed-size frame. A QR or copied
    // request can still name every mint in a long, verified sale record.
    if (e instanceof OfferError && e.kind === 'TooLong' && lookup) {
      const row = await lookup('sale:' + sale.id);
      if (row?.kind === 'sale' && row.sale.id === sale.id && !row.closed && !row.archived &&
          !row.offline && row.unit === 'sat' && row.mints.length) {
        const asked: Asked = { id: row.request, amount: row.amount, unit: row.unit, mints: row.mints, locked: false };
        const request = new PaymentRequest([], asked.id, asked.amount, asked.unit, asked.mints, row.sale.memo, true);
        return { asked, request: request.toEncodedCreqA() };
      }
    }
  }
  throw new PhonePaymentError('Open an online sale with a reachable mint to accept a phone wallet.');
}

export async function phoneRequest(sale: Sale, lookup?: SaleLookup): Promise<string> {
  return (await offerFor(sale, lookup)).request;
}

function trustedMint(value: unknown, asked: Asked, accepted: readonly string[]): string {
  if (typeof value === 'string') {
    const mint = mintName(value);
    if (asked.mints.includes(mint) && accepted.includes(mint)) return mint;
  }
  throw new PhonePaymentError('This sale does not accept that mint. The customer can keep the token.');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function paymentPayload(text: string, asked: Asked, accepted: readonly string[], http: HttpFetch): Promise<string> {
  if (text.length > MAX_PAYMENT_CHARS) throw new PhonePaymentError('The payment is too large for this till.');
  const value = text.trim();
  if (value.startsWith('{')) {
    let payload: unknown;
    try { payload = JSON.parse(value); } catch { throw new PhonePaymentError(UNREADABLE); }
    if (!record(payload)) throw new PhonePaymentError(UNREADABLE);
    if (payload.id !== asked.id) throw new PhonePaymentError('That payment response belongs to a different sale.');
    trustedMint(payload.mint, asked, accepted);
    if (payload.unit !== 'sat') throw new PhonePaymentError('This sale accepts sats only.');
    // Pass the original bytes through so the SDK also checks duplicate fields, integer spelling and proof structure.
    return value;
  }

  if (!/^(?:web\+cashu:\/\/|cashu:\/\/|cashu:)?cashu[AB][A-Za-z0-9+/_=-]+$/.test(value)) {
    throw new PhonePaymentError(UNREADABLE);
  }
  let meta: ReturnType<typeof getTokenMetadata>;
  try { meta = getTokenMetadata(value); } catch { throw new PhonePaymentError(UNREADABLE); }
  // Only reach the merchant's enrolled mint, never a URL supplied solely by a QR code.
  const mint = trustedMint(meta.mint, asked, accepted);
  if (meta.unit !== 'sat') throw new PhonePaymentError('This sale accepts sats only.');
  if (!meta.proofAmounts.length || meta.proofAmounts.length > MAX_PROOFS) throw new PhonePaymentError(UNREADABLE);

  // NUT-00 v4 shortens v2 keyset IDs, including IDs of now-inactive but still redeemable notes.
  let response: unknown;
  try { response = await askMint(http, mint + '/v1/keysets', MINT_TIMEOUT_MS); } catch {
    throw new PhonePaymentError('The mint could not be reached. Keep the token and try again online.');
  }
  if (!record(response) || !Array.isArray(response.keysets)) throw new PhonePaymentError('The mint could not confirm its keys.');
  const ids = response.keysets.filter(record).filter(k => k.unit === 'sat' && typeof k.id === 'string').map(k => k.id as string);
  try {
    const token = getDecodedToken(value, ids);
    const proofs = token.proofs.map(p => ({ id: p.id, amount: p.amount.toNumber(), secret: p.secret, C: p.C, dleq: p.dleq }));
    return JSON.stringify({ id: asked.id, mint, unit: 'sat', proofs });
  } catch {
    throw new PhonePaymentError('The token or its mint keys could not be verified. The customer can keep the token.');
  }
}

export async function receivePhonePayment(c: CashuCard, sale: Sale, text: string,
  accepted: readonly string[], http: HttpFetch, lookup?: SaleLookup): Promise<PhonePaymentResult> {
  let payload: string;
  try {
    payload = await paymentPayload(text, (await offerFor(sale, lookup)).asked, accepted, http);
  } catch (e) {
    return { kind: 'refused', message: e instanceof PhonePaymentError ? e.message : UNREADABLE };
  }

  try {
    // A late swap can finish alongside an earlier successful tender for this sale.
    // Attribute the answer only to the receipt created for these inputs.
    const before = new Set((await c.payments()).filter(p => p.id === sale.id).map(p => p.paymentId));
    const answer = await sale.ecash(payload);
    const rows = (await c.payments()).filter(p => p.id === sale.id);
    if (answer.status === 200) {
      const receipt = rows.find(p => !before.has(p.paymentId) && !p.cardKey);
      if (receipt?.extra) return { kind: 'return', message: 'This payment arrived after the sale closed. Open Owed to Cards to return it to the customer.' };
      if (receipt && (receipt.state === 'held' || receipt.state === 'delivered' || receipt.state === 'exported')) {
        return { kind: 'paid', payment: receipt };
      }
    }
    const taking = rows.find(p => !p.extra && p.state === 'taking');
    if (taking) return { kind: 'pending', message: CHECKING, paymentId: taking.paymentId };
    if (answer.status === 200 || answer.status === 504) return { kind: 'pending', message: CHECKING };
    // All ecash refusal words are authored by the SDK (no bearer material or remote error text).
    const why = answer.why;
    return { kind: 'refused', message: why?.includes('over the price') || why?.includes('short of the price') ?
      EXACT : why || 'The mint declined this payment.' };
  } catch (e) {
    if (e instanceof InexactPhonePayment) return { kind: 'refused', message: EXACT };
    // A storage/read error after a swap went out cannot safely be reported as a decline.
    return { kind: 'pending', message: CHECKING };
  }
}
