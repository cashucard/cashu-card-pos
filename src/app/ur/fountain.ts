// Fragment selection adapted from Foxy’s MIT-licensed build/wallet/06-animated-qr.js at 0e7b4fc.
// Foxy matches the encoder in @gandlaf21/bc-ur 1.1.12. See assets/licenses/Foxy-MIT.txt.
import { sha256 } from '@noble/hashes/sha2.js';

function xoshiro(sequence: number, checksum: number) {
  const seed = new DataView(new ArrayBuffer(8));
  seed.setUint32(0, sequence);
  seed.setUint32(4, checksum);
  const digest = sha256(new Uint8Array(seed.buffer));
  const words = Array.from({length: 4}, (_, i) => {
    let v = 0n;
    for (let j = i * 8; j < (i + 1) * 8; j++) v = (v << 8n) | BigInt(digest[j]);
    return v;
  });
  const mask = (1n << 64n) - 1n;
  const rotate = (value: bigint, n: bigint) => ((value << n) & mask) | (value >> (64n - n));
  return () => {
    const value = (rotate((words[1] * 5n) & mask, 7n) * 9n) & mask;
    const t = (words[1] << 17n) & mask;
    words[2] ^= words[0]; words[3] ^= words[1]; words[1] ^= words[2]; words[0] ^= words[3];
    words[2] ^= t; words[3] = rotate(words[3], 45n);
    // The reference encoder rounds its 64-bit sample to 20 decimal places, half up.
    const decimal = (value * 100000000000000000000n + (1n << 63n)) >> 64n;
    return decimal >= 100000000000000000000n ? 1 : Number('0.' + decimal.toString().padStart(20, '0'));
  };
}

export function makeFountainIndex(count: number) {
  const weights = Array.from({ length: count }, (_, i) => 1 / (i + 1));
  const sum = weights.reduce((a, b) => a + b, 0);
  const scaled = weights.map(p => p * count / sum);
  const prob = Array<number>(count).fill(1);
  const alias = Array<number>(count);
  const small: number[] = [], large: number[] = [];
  for (let i = count - 1; i >= 0; i--) (scaled[i] < 1 ? small : large).push(i);
  while (small.length && large.length) {
    const low = small.pop()!, high = large.pop()!;
    prob[low] = scaled[low];
    alias[low] = high;
    scaled[high] = scaled[high] + scaled[low] - 1;
    (scaled[high] < 1 ? small : large).push(high);
  }
  return (sequence: number, checksum: number): bigint => {
    if (sequence <= count) return 1n << BigInt(sequence - 1);
    const random = xoshiro(sequence, checksum);
    const column = Math.min(Math.floor(random() * count), count - 1);
    const degree = (random() < prob[column] ? column : alias[column]) + 1;
    const remaining = Array.from({length: count}, (_, i) => i);
    let result = 0n;
    for (let i = 0; i < degree; i++) {
      const at = Math.min(Math.floor(random() * remaining.length), remaining.length - 1);
      const [index] = remaining.splice(at, 1);
      result |= 1n << BigInt(index);
    }
    return result;
  };
}
