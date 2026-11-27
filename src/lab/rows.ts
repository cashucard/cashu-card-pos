import type { Row } from 'cashucard';

/** A BOLT11 test invoice for 14 sats (slice 0.2's tests): the library opens an invoice-only sale without asking any mint. */
export const INVOICE_14 = 'lnbc140n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfs7lvu5';
export const LAB_SALE_SATS = 14;
/** About what one card payment's row takes in the journal (the library's README, "Growth"). */
export const LAB_ROW_BYTES = 4400;

/** 64 hex characters, the same for the same i and k. */
export function hex64(i: number, k: number): string {
  return (i * 1000003 + k)
    .toString(16)
    .padStart(16, '0')
    .slice(-16)
    .repeat(4);
}

/** A delivered card payment of the library's shape, of at least `bytes` characters of JSON, for the timings only. */
export function paymentRow(i: number, bytes: number): Row {
  const proofs: Array<{ id: string; amount: number; secret: string; C: string }> = [];
  const row = {
    kind: 'payment',
    id: 'pay:' + hex64(i, 0).slice(0, 32),
    sale: 'sale:m-' + i,
    how: 'card',
    state: 'delivered',
    step: 'swapped',
    at: 1700000000000 + i,
    mint: 'https://mint.test',
    unit: 'sat',
    amount: 14,
    fee: 1,
    total: 15,
    delivery: 'fx-' + 'a'.repeat(26),
    ref: 'fx-' + 'a'.repeat(26),
    proofs,
  };
  let k = 1;
  while (JSON.stringify(row).length < bytes) {
    proofs.push({ id: '00ad268c4d1f5826', amount: 2 ** (k % 8), secret: hex64(i, k), C: '02' + hex64(i, k + 1000) });
    k += 1;
  }
  return row as unknown as Row;
}
