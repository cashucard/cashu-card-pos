import type { Delivery } from 'cashucard';
import { normalizeMintInput } from '../mint-check';
import { sameUrl } from '../http';
import { checkDelivery } from './keep-store';
import type { SqlValue } from './types';

export const badRecord = () => new Error('This backup has an unsupported or damaged payment record.');

export interface BackupColumn {
  name: string;
  integer: boolean;
  required: boolean;
}

function body(raw: SqlValue): Record<string, unknown> {
  const v = JSON.parse(String(raw));
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw badRecord();
  return v;
}

/** SQLite can coerce text in an integer column and accept malformed JSON as text. Preserve the
 * stored value exactly or reject it, including inconsistencies between financial bodies and their indexes. */
export function validateBackupRow(name: string, columns: BackupColumn[], values: SqlValue[]): void {
  const r: Record<string, SqlValue> = {};
  for (const [i, c] of columns.entries()) {
    const v = values[i];
    if (v === null ? c.required : c.integer ? !Number.isSafeInteger(v) || Number(v) < 0 : typeof v !== 'string') throw badRecord();
    r[c.name] = v;
  }
  if (r._rowid_ === 0 || r.seq === 0 || r.id === '') throw badRecord();
  switch (name) {
    case 'journal':
    case 'archive': {
      const b = body(r.body);
      if (b.id !== r.id || String(b.kind) !== r.kind || (b.gen ?? 0) !== r.gen) throw badRecord();
      break;
    }
    case 'kept': {
      const d = body(r.body);
      checkDelivery(d as unknown as Delivery);
      if (d.id !== r.id || d.unit !== r.unit || d.token !== r.token || d.amount !== r.amount ||
          d.mint !== r.mint || !sameUrl(String(r.mint), String(r.mint_norm))) throw badRecord();
      break;
    }
    case 'withdrawals':
    case 'extra_handoffs': {
      if (!['sat', 'usd'].includes(String(r.unit)) || (r.amount === 0 ? r.token !== '' : !String(r.token).startsWith('cashu')) ||
          (name === 'withdrawals' && (r.deliveries === 0 || ![0, 1].includes(Number(r.pending))))) throw badRecord();
      break;
    }
    case 'lightning_sales': {
      const b = body(r.body);
      const mint = normalizeMintInput(String(r.mint));
      const final = b.state === 'paid' || b.state === 'extra';
      const paid = final || b.state === 'processing';
      if ((b.abandoned !== undefined && b.abandoned !== true) || !mint.ok || mint.url !== r.mint || b.mint !== r.mint || b.saleId !== r.sale || b.paymentId !== 'ln-' + r.sale ||
          typeof b.saleId !== 'string' || !/^s-[a-z0-9]+-[a-z0-9]{6}$/.test(b.saleId) ||
          b.state !== r.state || !['unpaid','expired','processing','paid','extra'].includes(String(b.state)) ||
          b.createdAt !== r.created_at || !Number.isSafeInteger(b.expiresAt) || Number(b.expiresAt) <= Number(b.createdAt) ||
          !Number.isSafeInteger(b.amount) || Number(b.amount) < 1 || Number(b.amount) > 1_000_000 ||
          typeof b.invoice !== 'string' || !/^(?:lnbc|lntb|lnbcrt)/i.test(b.invoice) ||
          !/^[a-zA-Z0-9_-]{1,256}$/.test(String(b.quote)) || !/^(02|03)[a-f0-9]{64}$/.test(String(b.pubkey)) ||
          (final ? b.signingKey !== undefined || b.outputs !== undefined : !/^[a-f0-9]{64}$/.test(String(b.signingKey))) ||
          (paid ? !Number.isSafeInteger(b.paidAt) || !['sale','return'].includes(String(b.destination)) :
            b.paidAt !== undefined || b.destination !== undefined) ||
          (!final && !Array.isArray(b.outputs)) ||
          (b.previousKeysets !== undefined && (!Array.isArray(b.previousKeysets) ||
            b.previousKeysets.some(k => typeof k !== 'string' || !/^[a-f0-9]{16,66}$/.test(k)))) ||
          (b.state === 'paid' && b.destination !== 'sale') || (b.state === 'extra' && b.destination !== 'return')) throw badRecord();
      if (b.outputs !== undefined && (!Array.isArray(b.outputs) || !b.outputs.length || b.outputs.length > 64 ||
          b.outputs.some(o => !o || typeof o.secret !== 'string' || !/^[1-9][0-9]*$/.test(o.blindingFactor) ||
            !o.blindedMessage || !Number.isSafeInteger(Number(o.blindedMessage.amount)) || Number(o.blindedMessage.amount) < 1 ||
            !/^(02|03)[a-f0-9]{64}$/.test(o.blindedMessage.B_) || !/^[a-f0-9]+$/.test(o.blindedMessage.id)) ||
          b.outputs.reduce((n,o) => n + Number(o.blindedMessage.amount), 0) !== b.amount)) throw badRecord();
      break;
    }
    case 'card_topups': {
      const b = body(r.body);
      if (b.id !== r.id || b.cardKey !== r.card || b.revision !== r.revision || b.state !== r.state ||
          b.createdAt !== r.created_at || typeof b.mint !== 'string' || !sameUrl(b.mint, String(r.mint)) ||
          !['invoice','issuing','ready','loaded','expired'].includes(String(r.state)) || !Array.isArray(b.outputs) ||
          !Array.isArray(b.delivered) || !b.attempts || typeof b.attempts !== 'object' || Array.isArray(b.attempts) ||
          typeof b.amount !== 'number' || !Number.isSafeInteger(b.amount) || b.amount <= 0 ||
          typeof b.total !== 'number' || !Number.isSafeInteger(b.total) || b.total < b.amount ||
          (r.state === 'ready' && (!Array.isArray(b.pieces) || b.outputs.length !== b.pieces.length || !b.pieces.length))) throw badRecord();
      break;
    }
    case 'lightning_payouts': {
      if (!/^[0-9a-f]{64}$/.test(String(r.payment_hash))) throw badRecord();
      const open = r.state === 'submitted' || r.state === 'quoted';
      if (open ? typeof body(r.plan).quoteId !== 'string' : r.plan !== '') throw badRecord();
      break;
    }
    case 'offline_spent_inputs':
      if (!/^[0-9a-f]{64}$/.test(String(r.digest))) throw badRecord();
      break;
    case 'offline_archive_cursor':
      if (r.id !== 1) throw badRecord();
      break;
  }
}
