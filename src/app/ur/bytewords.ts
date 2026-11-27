// Minimal Bytewords alphabet (BCR-2020-012), from Foxy. See assets/licenses/Foxy-MIT.txt.
const alphabet = 'aeadaoaxaaahamatayasbkbdbnbtbabsbebybgbwbbbzcmchcscfcycwcecackctcxclcpcndkdadsdidedtdrdndwdpdmdldyeheyeoeeecenemetesftfrfnfsfmfhfzfpfwfxfyfefgflfdgagegrgsgtglgwgdgygmgughgohfhghdhkhthphhhlhyhehnhsidiaieihiyioisinimjejzjnjtjljojsjpjkjykpkoktkskkknkgkekikblblalylflslrlplnltloldlelulklgmnmymhmemomumwmdmtmsmknlnyndnsntnnnenboyoeotoxonolospdptpkpypspmplpepfpaprqdqzrerprlrorhrdrkrfryrnrsrtsesasrssskswstspsosgsbsfsntotktitttdtetytltbtstptatnuyuoutueurvtvyvovlvevwvavdvswlwdwmwpwewywswtwnwzwfwkykynylyaytzszoztzczezm';
const codes = new Map<string, number>();
for (let i = 0; i < 256; i++) codes.set(alphabet.slice(2 * i, 2 * i + 2), i);

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function readBytewords(text: string): Uint8Array {
  if (text.length < 10 || text.length % 2) throw new Error('Invalid Bytewords length');
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = codes.get(text.slice(2 * i, 2 * i + 2));
    if (byte === undefined) throw new Error('Invalid Bytewords');
    bytes[i] = byte;
  }
  const body = bytes.subarray(0, -4);
  if (crc32(body) !== new DataView(bytes.buffer).getUint32(body.length)) throw new Error('Invalid frame checksum');
  return body;
}
