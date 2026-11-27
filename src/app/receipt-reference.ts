import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { toHex } from '../till/hex';

/** A display reference only. A return tap matches the full card key inside the SDK. */
function digestOf(kind: 'receipt' | 'card', value: string): string {
  return toHex(sha256(utf8ToBytes(kind + '/' + value))).toUpperCase();
}

function short(digest: string): string {
  return [digest.slice(0, 4), digest.slice(4, 8), digest.slice(8, 12)].join('-');
}

export const receiptReference = (id: string): string => 'Receipt ' + short(digestOf('receipt', id));
export const cardTag = (key: string): string => digestOf('card', key);
export const tagReference = (tag: string): string => 'Card ' + short(tag);
export const cardReference = (key: string): string => tagReference(cardTag(key));
