/* The payment list as CSV text (slice 2.3), for the merchant's own books: every payment the record lists and every
 * archived payment, one line each. It is built only when the merchant asks, handed to the share sheet and dropped: never
 * logged, kept or reported. It never holds a token, a proof, a key, a card's key, a payment's, a sale's or a delivery's
 * id, or a row of the record. */

import type { Payment } from 'cashucard';
import { hostOf } from '../format';
import { paymentWords } from '../till/payment-words';
import type { LightningSaleReceipt } from '../till/lightning-sale';
import type { ArchivedPayment } from '../till/store/archive';
import { isTakings } from './activity';

export const CSV_HEADER = 'date,time,sats,what,takings,fee_sats,mint,archived';
/** The share sheet's title. */
export const CSV_TITLE = 'Cashu Card POS payments';

const pad2 = (n: number): string => (n < 10 ? '0' + n : String(n));

/** The phone's local date and time of `ms`: ['2026-11-22', '04:10']. */
export function csvWhen(ms: number): [string, string] {
  const d = new Date(ms);
  return [
    String(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()),
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()),
  ];
}

/** One field: text a spreadsheet would run as a formula (starting with = + - @) gets a ' in front; then it is quoted,
 * its quotes doubled, when it holds a comma, a quote or a line break. */
export function csvField(s: string): string {
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
  return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

/** What an archived payment was, in the payment table's words (the library archives only these states). */
export function archivedWhat(state: string): string {
  if (state === 'delivered') {
    return 'PAID';
  }
  if (state === 'exported') {
    return 'TAKEN OUT';
  }
  if (state === 'gone') {
    return 'LOST';
  }
  return state.toUpperCase();
}

interface Line {
  at: number;
  archived: boolean;
  cells: string[];
}

/** The list: the header, then one line per archived payment and per payment the record lists, oldest first (at the
 * same time, the archived one first), every line ended by CRLF. */
export function paymentsCsv(live: readonly Payment[], archived: readonly ArchivedPayment[], lightning: readonly LightningSaleReceipt[] = []): string {
  const lines: Line[] = [];
  for (const a of archived) {
    const [date, time] = csvWhen(a.at);
    const paid = a.state === 'delivered' || a.state === 'exported';
    lines.push({
      at: a.at,
      archived: true,
      cells: [date, time, String(a.amount), archivedWhat(a.state), paid ? 'yes' : 'no', String(a.fee), hostOf(a.mint), 'yes'],
    });
  }
  for (const p of live) {
    const [date, time] = csvWhen(p.at);
    lines.push({
      at: p.at,
      archived: false,
      cells: [
        date,
        time,
        String(p.amount),
        paymentWords(p).headline,
        isTakings(p) ? 'yes' : 'no',
        String(p.fee),
        hostOf(p.mint),
        'no',
      ],
    });
  }
  for (const receipt of lightning) {
    if (receipt.state === 'unpaid' || receipt.state === 'expired') continue;
    const at = receipt.paidAt ?? receipt.createdAt;
    const [date, time] = csvWhen(at);
    const paid = receipt.state === 'paid';
    const what = paid ? 'PAID · Lightning' : receipt.state === 'extra' ? 'CUSTOMER RETURN · Lightning' : 'CONFIRMING · Lightning';
    lines.push({at, archived: false, cells: [date, time, String(receipt.amount), what, paid ? 'yes' : 'no', '', hostOf(receipt.mint), 'no']});
  }
  lines.sort((x, y) => {
    if (x.at !== y.at) {
      return x.at - y.at;
    }
    if (x.archived === y.archived) {
      return 0;
    }
    return x.archived ? -1 : 1;
  });
  return [CSV_HEADER, ...lines.map((l) => l.cells.map(csvField).join(','))].join('\r\n') + '\r\n';
}
