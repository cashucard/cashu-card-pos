import { base64urlnopad, utf8 } from '@scure/base';
import { crc32, readBytewords } from './ur/bytewords';
import { makeFountainIndex } from './ur/fountain';

export type PaymentFrameResult =
  | { kind: 'complete'; text: string }
  | { kind: 'progress'; received: number; expected: number }
  | { kind: 'error'; message: string };

const MAX_QR_CHARS = 4296; // QR version 40-L in alphanumeric mode, used for uppercase UR frames.
const MAX_MESSAGE_BYTES = 100_000;
const MAX_PARTS = 512;
const INVALID = 'This payment QR could not be read. Copy the full payment from the customer’s wallet and use Paste payment.';

/** Only the definite byte string and 5-field unsigned fountain tuple used by UR:bytes. */
class Cbor {
  offset = 0;
  constructor(readonly data: Uint8Array) {}
  size(type: number) {
    const first = this.data[this.offset++];
    if (first === undefined || first >> 5 !== type) throw new Error('Invalid CBOR item');
    const additional = first & 31;
    if (additional < 24) return additional;
    if (additional > 26) throw new Error('Invalid CBOR size');
    const width = 1 << (additional - 24);
    if (this.offset + width > this.data.length) throw new Error('Truncated CBOR header');
    let value = 0;
    for (let i = 0; i < width; i++) value = value * 256 + this.data[this.offset++];
    return value;
  }
  finalBytes() {
    const length = this.size(2);
    if (!length || this.offset + length !== this.data.length) throw new Error('Invalid CBOR byte string');
    return this.data.subarray(this.offset);
  }
}

function paymentText(message: Uint8Array): string {
  const bytes = new Cbor(message).finalBytes();
  // Cashu wallets can present raw binary V4 tokens as well as the printable token text.
  if (bytes.length > 5 && bytes[0] === 99 && bytes[1] === 114 && bytes[2] === 97 && bytes[3] === 119 && bytes[4] === 66) {
    return 'cashuB' + base64urlnopad.encode(bytes.subarray(5));
  }
  // The pinned decoder rejects malformed UTF-8. Re-encoding the decoded text also calls
  // String.isWellFormed in Metro's production bundle, which this Hermes version lacks.
  return utf8.encode(bytes);
}

interface Equation { indexes: bigint; bytes: Uint8Array }
interface Part { sequence: number; count: number; length: number; checksum: number; bytes: Uint8Array }

function readPart(urlSequence: number, urlCount: number, encoded: string): Part {
  const input = new Cbor(readBytewords(encoded));
  if (input.size(4) !== 5) throw new Error('Invalid fountain tuple');
  const sequence = input.size(0), count = input.size(0), length = input.size(0), checksum = input.size(0);
  const bytes = input.finalBytes();
  if (sequence !== urlSequence || count !== urlCount || count < 2 || count > MAX_PARTS ||
      length < 1 || length > MAX_MESSAGE_BYTES || Math.ceil(length / bytes.length) !== count) {
    throw new Error('Invalid fountain geometry');
  }
  return { sequence, count, length, checksum, bytes };
}

function xor(target: Uint8Array, other: Uint8Array) {
  for (let i = 0; i < target.length; i++) target[i] ^= other[i];
}

/** Bounded row reduction accepts systematic frames in any order and mixed-only frames after the first cycle. */
class FountainMessage {
  private readonly rows: Array<Equation | undefined>;
  private readonly indexes: ReturnType<typeof makeFountainIndex>;
  private readonly seen = new Set<number>();
  private rank = 0;
  constructor(private readonly first: Part) {
    this.rows = Array(first.count);
    this.indexes = makeFountainIndex(first.count);
  }
  progress(): PaymentFrameResult { return { kind: 'progress', received: this.rank, expected: this.first.count }; }
  add(part: Part): PaymentFrameResult {
    const { count, length, checksum } = this.first;
    if (part.count !== count || part.length !== length || part.checksum !== checksum ||
        part.bytes.length !== this.first.bytes.length || this.seen.has(part.sequence)) return this.progress();
    if (this.seen.size >= count * 4 + 32) this.seen.clear();
    this.seen.add(part.sequence);
    let indexes = this.indexes(part.sequence, checksum);
    const bytes = part.bytes.slice();
    for (let i = 0; i < count; i++) {
      if (!(indexes & (1n << BigInt(i)))) continue;
      const row = this.rows[i];
      if (!row) {
        this.rows[i] = { indexes, bytes };
        this.rank++;
        break;
      }
      indexes ^= row.indexes;
      xor(bytes, row.bytes);
    }
    if (this.rank < count) return this.progress();
    const message = new Uint8Array(length);
    // Rows have only their pivot and columns to its right. Solve backwards in place.
    for (let i = count - 1; i >= 0; i--) {
      const row = this.rows[i]!;
      for (let j = i + 1; j < count; j++) {
        if (row.indexes & (1n << BigInt(j))) xor(row.bytes, this.rows[j]!.bytes);
      }
      const offset = i * row.bytes.length;
      message.set(row.bytes.subarray(0, length - offset), offset);
    }
    if (crc32(message) !== checksum) throw new Error('Invalid message checksum');
    return { kind: 'complete', text: paymentText(message) };
  }
}

/** Create once for a camera session. Bearer values are kept only in this closure, never in device storage. */
export function createPhonePaymentFrameReader() {
  let assembly: FountainMessage | undefined;
  return {
    read(text: string): PaymentFrameResult {
      if (!/^ur:/i.test(text)) return assembly ? assembly.progress() : { kind: 'complete', text };
      if (text.length > MAX_QR_CHARS) return { kind: 'error', message: INVALID };
      const match = /^ur:bytes\/(?:(\d{1,10})-(\d{1,4})\/)?([a-z]+)$/i.exec(text);
      if (!match) return assembly ? assembly.progress() : { kind: 'error', message: INVALID };
      try {
        const data = match[3].toLowerCase();
        if (match[1] === undefined) {
          if (assembly) return assembly.progress();
          return { kind: 'complete', text: paymentText(readBytewords(data)) };
        }
        const sequence = Number(match[1]), count = Number(match[2]);
        if (!sequence || sequence > 0xffffffff || count > MAX_PARTS) throw new Error('Invalid frame number');
        const part = readPart(sequence, count, data);
        assembly ??= new FountainMessage(part);
        const result = assembly.add(part);
        if (result.kind === 'complete') assembly = undefined;
        return result;
      } catch {
        return { kind: 'error', message: INVALID };
      }
    },
  };
}
