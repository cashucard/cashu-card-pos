import { sha256 } from '@noble/hashes/sha2.js';
import { hashToCurve, pointFromHex } from '@cashu/cashu-ts';
import { CARD_AID, MemoryJournal, open, stageWords } from 'cashucard';
import { toHex } from '../till/hex';
import type { PolyfillGlobal } from './types';

export const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
export const H2C_ZERO32 = '024cce997d3b518f739663b757deaec95bcd9473c30a14ac2fd04023a739d1a725';
export const POINT_G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
export const POINT_2G = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';

export function checkEngine(hermes: boolean, bridgeless: boolean): string {
  if (!hermes) {
    throw new Error('not running on Hermes');
  }
  return 'Hermes; new architecture ' + (bridgeless ? 'on' : 'off');
}

export function checkPolyfills(g: PolyfillGlobal): string {
  const Encoder = g.TextEncoder;
  if (!Encoder) {
    throw new Error('no TextEncoder');
  }
  if (toHex(new Encoder().encode('abc')) !== '616263') {
    throw new Error('TextEncoder encodes abc wrongly');
  }

  const Decoder = g.TextDecoder;
  if (!Decoder) {
    throw new Error('no TextDecoder');
  }
  if (new Decoder().decode(new Uint8Array([0x63, 0x61, 0x73, 0x68, 0x75])) !== 'cashu') {
    throw new Error('TextDecoder decodes cashu wrongly');
  }

  let decoded = false;
  try {
    new Decoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new Uint8Array([0xff]));
    decoded = true;
  } catch {
    // expected: a decoder that honours fatal refuses 0xFF
  }
  if (decoded) {
    throw new Error('TextDecoder ignores fatal: it decoded 0xFF');
  }

  const URLClass = g.URL;
  if (!URLClass) {
    throw new Error('no URL');
  }
  const u = new URLClass('https://mint.test:8443/v1/keys?unit=sat');
  const protocol = u.protocol;
  const hostname = u.hostname;
  const port = u.port;
  const pathname = u.pathname;
  const search = u.search;
  if (!(protocol === 'https:' && hostname === 'mint.test' && port === '8443' && pathname === '/v1/keys' && search === '?unit=sat')) {
    throw new Error('URL parts wrong: ' + [protocol, hostname, port, pathname, search].join(' '));
  }

  const marks = g.__ccposPolyfills;
  return (
    'TextEncoder ' +
    (marks ? marks.textEncoder : 'unmarked') +
    ', TextDecoder ' +
    (marks ? marks.textDecoder : 'unmarked') +
    ' (fatal honoured), URL whole'
  );
}

export function checkRandom(g: PolyfillGlobal, nativeRandom: boolean): string {
  const c = g.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('no crypto.getRandomValues');
  }
  const a = new Uint8Array(32);
  const b = new Uint8Array(32);
  c.getRandomValues(a);
  c.getRandomValues(b);
  let zeros = true;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== 0) {
      zeros = false;
      break;
    }
  }
  if (zeros) {
    throw new Error('getRandomValues left 32 bytes at zero');
  }
  if (toHex(a) === toHex(b)) {
    throw new Error('getRandomValues gave the same 32 bytes twice');
  }
  if (!nativeRandom) {
    throw new Error('react-native-get-random-values has no native module here (it would fall back to Math.random)');
  }
  return 'getRandomValues: 2 x 32 bytes, distinct; native module';
}

export function checkHash(expected: string = SHA256_ABC): string {
  const h = toHex(sha256(new Uint8Array([0x61, 0x62, 0x63])));
  if (h !== expected) {
    throw new Error('sha256(abc) is ' + h);
  }
  return '@noble/hashes sha256(abc) = ' + h.slice(0, 16) + '…';
}

export function checkCurve(expected: string = H2C_ZERO32): string {
  const p = hashToCurve(new Uint8Array(32)).toHex(true);
  if (p !== expected) {
    throw new Error('hashToCurve(0^32) is ' + p);
  }
  const q = pointFromHex(POINT_G).multiply(2n).toHex(true);
  if (q !== POINT_2G) {
    throw new Error('2G is ' + q);
  }
  return 'cashu-ts hashToCurve(0^32) = ' + p.slice(0, 16) + '…; 2G = ' + q.slice(0, 16) + '…';
}

export async function checkLibrary(expected: string = 'F043415348554341524401'): Promise<string> {
  if (CARD_AID !== expected) {
    throw new Error('CARD_AID is ' + CARD_AID);
  }
  if (typeof open !== 'function') {
    throw new Error('open is not a function');
  }
  const w = stageWords('reading');
  if (w.short !== 'READING') {
    throw new Error('stageWords(reading) is ' + JSON.stringify(w));
  }
  const rows = await new MemoryJournal().list();
  if (rows.length !== 0) {
    throw new Error('a new MemoryJournal lists ' + rows.length + ' rows');
  }
  return 'cashucard loaded: CARD_AID ' + CARD_AID + ', open, stageWords, MemoryJournal';
}

export async function checkNfc(linked: boolean, supported: () => Promise<boolean>): Promise<string> {
  if (!linked) {
    throw new Error('the NfcManager native module is not linked');
  }
  let s: boolean;
  try {
    s = await supported();
  } catch (e) {
    throw new Error('NfcManager.isSupported threw: ' + (e instanceof Error ? e.message : String(e)));
  }
  return 'NfcManager linked; isSupported ' + s;
}
