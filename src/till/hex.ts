/** Two lower-case hex digits per byte, in order. */
export function toHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 1) {
    out += b[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** The bytes a hex string names. Upper and lower case read the same; anything else is an error. */
export function fromHex(h: string): Uint8Array {
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) {
    throw new Error('not hex: ' + h.slice(0, 20));
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
