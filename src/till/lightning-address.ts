import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import type { HttpFetch } from 'cashucard';
import { lightningJson, LightningTransportError } from './lightning-http';

const domainLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeLightningAddress(text: string): string {
  const address = typeof text === 'string' ? text.trim() : '';
  const match = /^([a-z0-9_.+-]{1,64})@([a-z0-9.-]+)$/i.exec(address);
  if (match) {
    const user = match[1];
    const domain = match[2].toLowerCase();
    const labels = domain.split('.');
    if (user === user.toLowerCase() && user !== '.' && user !== '..' &&
        domain.length <= 253 && labels.length > 1 && labels.every(label => domainLabel.test(label)) &&
        !/^\d+$/.test(labels[labels.length - 1]) && !domain.endsWith('.onion')) {
      return user + '@' + domain;
    }
  }
  throw new LightningTransportError('Enter a Lightning address in the form name@domain.com.');
}

function wordNumber(words: number[]): number {
  const n = words.reduce((acc, w) => acc * 32 + w, 0);
  if (!Number.isSafeInteger(n)) throw new Error();
  return n;
}

/** An address invoice must match its published metadata and the exact millisatoshi amount. */
export function verifyAddressInvoice(invoice: string, amount: number, metadata: string, now: number,
  addressBoundDescription?: string):
  { paymentHash: string; expiresAt: number } {
  return verifyBoltInvoice(invoice, amount, now, {metadata, addressBoundDescription});
}

/** Direct mint quotes are authenticated by their configured HTTPS origin. They have no LUD-16 metadata. */
export function verifyMintInvoice(invoice: string, now: number) {
  return verifyBoltInvoice(invoice, null, now);
}

function verifyBoltInvoice(invoice:string, amount:number|null, now:number,
  address?: {metadata:string; addressBoundDescription?:string}) {
  try {
    const { prefix, words } = bech32.decode(invoice as `${string}1${string}`, 16384);
    const hrp = /^ln(?:bc|tb|tbs|bcrt)([1-9]\d{0,18})([munp]?)$/.exec(prefix);
    if (!hrp || words.length < 111) throw new Error();
    const picoBySuffix: Record<string, bigint> = {
      '': BigInt('1000000000000'), m: BigInt('1000000000'), u: BigInt(1000000), n: BigInt(1000), p: BigInt(1),
    };
    const pico = BigInt(hrp[1]) * picoBySuffix[hrp[2]];
    const sats = Number(pico / BigInt(10000));
    if (pico % BigInt(10000) !== BigInt(0) || !Number.isSafeInteger(sats) || (amount !== null && sats !== amount)) throw new Error();
    const data = words.slice(0, -104);
    const signature = bech32.fromWords(words.slice(-104));
    const tags = new Map<number, number[]>();
    // BOLT11 tags p=1, h=23, d=13, x=6, n=19. Unknown and repeatable routing hints are skipped.
    for (let i = 7; i < data.length;) {
      if (i + 3 > data.length) throw new Error();
      const type = data[i];
      const size = data[i + 1] * 32 + data[i + 2];
      i += 3;
      if (i + size > data.length) throw new Error();
      if ([1, 23, 13, 6, 19].includes(type)) {
        if (tags.has(type)) throw new Error();
        tags.set(type, data.slice(i, i + size));
      }
      i += size;
    }
    const p = bech32.fromWords(tags.get(1) ?? []);
    if (p.length !== 32 || tags.has(23) === tags.has(13)) throw new Error();
    if (tags.has(23)) {
      const hash = bech32.fromWords(tags.get(23)!);
      if (hash.length !== 32 || (address && bytesToHex(hash) !== bytesToHex(sha256(utf8ToBytes(address.metadata))))) throw new Error();
    } else {
      // Current LUD-06 permits plain descriptions. Accept one only after LUD-16 metadata
      // identifies the requested address, and only when the signed text matches byte for byte.
      const description = bech32.fromWords(tags.get(13)!);
      if (address && (address.addressBoundDescription === undefined ||
          bytesToHex(description) !== bytesToHex(utf8ToBytes(address.addressBoundDescription)))) throw new Error();
    }

    // BOLT11 signs the 5-bit words padded with zero bits to a byte boundary.
    const packed = new Uint8Array(Math.ceil(data.length * 5 / 8));
    let bit = 0;
    for (const word of data) {
      const offset = bit % 8;
      const index = Math.floor(bit / 8);
      packed[index] |= (word << 3) >>> offset;
      if (offset > 3) packed[index + 1] |= word << (11 - offset);
      bit += 5;
    }
    const digest = sha256(concatBytes(utf8ToBytes(prefix), packed));
    const recovered = concatBytes(signature.slice(64), signature.slice(0, 64));
    const key = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
    if (tags.has(19)) {
      const expected = bech32.fromWords(tags.get(19)!);
      if (bytesToHex(expected) !== bytesToHex(key) ||
          !secp256k1.verify(signature.slice(0, 64), digest, expected, { prehash: false })) throw new Error();
    }
    const seconds = tags.has(6) ? wordNumber(tags.get(6)!) : 3600;
    const expiresAt = (wordNumber(data.slice(0, 7)) + seconds) * 1000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error();
    return { paymentHash: bytesToHex(p), expiresAt, sats };
  } catch {
    throw new LightningTransportError(address
      ? 'The Lightning address returned an invalid, expired or mismatched invoice.'
      : 'The mint returned an invalid or expired Lightning invoice.');
  }
}

export async function addressInvoice(http: HttpFetch, address: string, sats: number, now: () => number) {
  const [name, domain] = normalizeLightningAddress(address).split('@');
  const msat = sats * 1000;
  if (!Number.isSafeInteger(sats) || sats < 1 || !Number.isSafeInteger(msat)) {
    throw new LightningTransportError('Enter a positive amount in whole sats.');
  }
  const response = await lightningJson(http, 'https://' + domain + '/.well-known/lnurlp/' + name) as {
    tag?: unknown; callback?: unknown; metadata?: unknown; minSendable?: unknown; maxSendable?: unknown;
  } | null;
  if (!response || response.tag !== 'payRequest' || typeof response.metadata !== 'string' ||
      typeof response.callback !== 'string' || typeof response.minSendable !== 'number' ||
      typeof response.maxSendable !== 'number' || !Number.isSafeInteger(response.minSendable) ||
      !Number.isSafeInteger(response.maxSendable) || response.minSendable <= 0 ||
      response.maxSendable < response.minSendable) {
    throw new LightningTransportError('This Lightning address did not return payment details.');
  }
  if (msat < response.minSendable || msat > response.maxSendable) {
    throw new LightningTransportError('This amount is outside the receiving Lightning address’s limits.');
  }
  let callback: URL;
  let description: string;
  let addressBoundDescription: string | undefined;
  try {
    callback = new URL(response.callback);
    if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash) throw new Error();
    const metadata: unknown = JSON.parse(response.metadata);
    if (!Array.isArray(metadata) || !metadata.every(Array.isArray)) throw new Error();
    const descriptions = metadata.filter(entry => entry[0] === 'text/plain');
    if (descriptions.length !== 1 || typeof descriptions[0][1] !== 'string') throw new Error();
    description = descriptions[0][1];
    const identifiers = metadata.filter(entry => entry[0] === 'text/identifier' || entry[0] === 'text/email');
    if (identifiers.length) {
      const requested = name + '@' + domain;
      const untagged = name.split('+')[0] + '@' + domain;
      if (!identifiers.some(entry => {
        const id = normalizeLightningAddress(entry[1]);
        return id === requested || id === untagged;
      })) throw new Error();
      addressBoundDescription = description;
    }
    callback.searchParams.set('amount', String(msat));
  } catch {
    throw new LightningTransportError('This Lightning address returned invalid payment details.');
  }
  const answer = await lightningJson(http, callback.toString()) as {pr?: unknown} | null;
  if (typeof answer?.pr !== 'string') throw new LightningTransportError('The Lightning address did not issue an invoice.');
  const invoice = answer.pr;
  // Verify the original bytes. Only the separate display copy is shortened and stripped of
  // control, zero-width and bidi override/isolate characters from the address provider.
  const verified = verifyAddressInvoice(invoice, sats, response.metadata, now(), addressBoundDescription);
  const safe = description.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const display = Array.from(safe).slice(0, 161);
  return { invoice, ...verified, description: display.length <= 160 ? display.join('') : display.slice(0, 159).join('') + '…' };
}
