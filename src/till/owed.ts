import { CardError, type CardTransport, type CashuCard, type GiveBack, type Owed, type Payment, type Unit } from 'cashucard';
import { cashuAmount, plural } from '../format';
import { cardReference, cardTag } from '../app/receipt-reference';
import { toHex } from './hex';
import { CARD_ERROR_TITLES } from './card-errors';
import { type CardReader } from './reader';
import type { TillService } from './service';
import { tapSession } from './tap-session';

export interface ReturnRow {
  id: string;
  cardRef: string;
  source: 'wallet' | 'card';
  mint: string;
  unit: Unit;
  at: number;
  amount: number;
  state: Owed['state'];
  reason: Owed['reason'];
  why?: string;
  exportable: boolean;
}

export interface OwedReading {
  rows: ReturnRow[];
  claims: number;
}

function hasReturn(p: Payment): boolean {
  return p.owedToCard > 0 || p.unconfirmed > 0 ||
    (!!p.extra && ['held', 'returning', 'returned'].includes(p.state));
}

/** owedTotals groups the SDK's piece list by payment, source and state; an in-flight extra
 * may still be in bearer form and therefore absent from Payment.owedToCard. */
export async function readOwed(card: Pick<CashuCard, 'payments' | 'openClaims' | 'owedTotals' | 'needsGiveBack'>): Promise<OwedReading> {
  const pays = await card.payments();
  const openClaims = await card.openClaims();
  const byId = new Map(pays.map(p => [p.paymentId, p]));
  const keys = new Set(pays.filter(hasReturn).map(p => p.cardKey).filter((k): k is string => !!k));
  const claimKeys = new Set(openClaims.map(c => c.cardKey));
  // A late payment made by a phone has no card key. The SDK records its settled
  // sale amount as a held extra, payable to its sender by token only.
  const rows: ReturnRow[] = pays.filter(p => !p.cardKey && p.extra && p.state === 'held').map(p => ({
    id: p.paymentId, source: 'wallet', cardRef: 'Wallet payment', mint: p.mint, unit: p.unit, at: p.at, amount: p.amount,
    state: 'held', reason: 'extra', exportable: true,
  }));
  let claims = 0;
  for (const key of claimKeys) {
    if (await card.needsGiveBack(key)) {
      claims += openClaims.filter(c => c.cardKey === key).length;
    }
  }
  for (const key of keys) {
    const totals = await card.owedTotals(key);
    const partlyWritten = new Set(totals.filter(line => line.reason === 'extra' &&
      (line.state === 'unconfirmed' || line.state === 'unproved')).map(line => line.paymentId));
    for (const line of totals) {
      const p = byId.get(line.paymentId);
      if (!p) continue;
      rows.push({
        id: p.paymentId, source: 'card', cardRef: cardReference(key), mint: p.mint, unit: p.unit, at: p.at, amount: line.amount,
        state: line.state, reason: line.reason, why: line.why,
        exportable: !!p.extra && line.reason === 'extra' && !partlyWritten.has(line.paymentId),
      });
    }
  }
  return { rows: rows.sort((a, b) => b.at - a.at), claims };
}

export function rowWords(row: ReturnRow): string {
  const why = row.reason === 'extra' ? 'Extra payment' : 'Change';
  const amount = cashuAmount(row.amount, row.unit);
  if (row.state === 'unconfirmed') return amount + ' · Written, awaiting confirmation';
  if (row.state === 'unproved') return amount + ' · Awaiting a valid mint proof';
  if (row.why === 'date-too-near') return amount + ' · Held for the customer. The card’s return date is too near.';
  if (row.state === 'returning') return amount + ' · The mint is preparing the return';
  if (row.state === 'held') return amount + ' · Extra payment held for the customer';
  return amount + ' · ' + why + ' to return';
}

export interface ReturnTap {
  result: GiveBack;
  /** Fingerprint of the observed key, held between the first scan and a PIN retry. */
  tag: string | null;
}

/** Observe the SDK's normal CCP 3.x GET_PUBKEY; a PIN retry must match that scan before
 * the SDK can verify the PIN. The key and the commands never enter the UI or the journal. */
export function identifiedReturn(inner: CardTransport, expected: string | null) {
  let tag: string | null = null;
  const transport: CardTransport = {
    begin: (prompt) => inner.begin?.(prompt) ?? Promise.resolve(),
    async transceive(command) {
      const response = await inner.transceive(command);
      if (command.length === 5 && command[0] === 0xb0 && command[1] === 0x10 &&
          command[2] === 0 && command[3] === 0 && command[4] === 33 &&
          response.length === 35 && response[33] === 0x90 && response[34] === 0) {
        tag = cardTag(toHex(response.subarray(0, 33)));
        if (expected !== null && tag !== expected) throw new CardError('other-card', 'Use the card from the previous tap.');
      }
      return response;
    },
    setMessage: (words) => inner.setMessage?.(words),
    end: (result) => inner.end?.(result) ?? Promise.resolve(),
  };
  return { transport, tag: () => tag };
}

export async function returnToCard(service: Pick<TillService, 'withCard' | 'settleNow'>, reader: CardReader,
  expected: string | null, pin: () => string | null, signal: AbortSignal, onCard: () => void): Promise<ReturnTap> {
  try {
    return await service.withCard('give-back', async c => {
      if (signal.aborted) throw new CardError('stopped', 'Card return cancelled.');
      if (!(await reader.available())) throw new CardError('no-reader', 'Turn on NFC to scan a card.');
      const visit = identifiedReturn(reader.transport(), expected);
      const session = tapSession(visit.transport, { signal, onCard, onWait: () => {} });
      const deadline = Date.now() + 90_000;
      for (;;) {
        try {
          const result = await c.giveBackToCard(session, {
            signal, deadline, askPin: async () => expected !== null && visit.tag() === expected ? pin() : null,
          });
          return { result, tag: visit.tag() };
        } catch (error) {
          if (!(error instanceof CardError && error.kind === 'busy') || signal.aborted || Date.now() >= deadline) throw error;
          await new Promise<void>(resolve => setTimeout(resolve, 350));
        }
      }
    });
  } finally {
    void service.settleNow('after-card').catch(() => undefined);
  }
}

export function returnWords(result: GiveBack, unit?: string): string {
  const words: string[] = [];
  if (result.written > 0) words.push(unit ? 'Written to the card: ' + cashuAmount(result.written, unit) + '.' : 'Change was written to the card.');
  if (result.recovered.length) words.push('Recovered ' + plural(result.recovered.length, 'payment', 'payments') + '.');
  if (result.unrecovered.length) words.push('An earlier payment still needs recovery.');
  if (result.pinNeeded) words.push('Tap again with the card’s PIN to continue.');
  else if (result.owed > 0 || result.waiting) words.push('The return is still pending. Check its status below before trying again.');
  return words.join(' ') || 'This tap had nothing to write. Present the original card for any return still shown.';
}

export function returnError(error: unknown): string {
  if (error instanceof CardError) {
    if (error.kind === 'wrong-pin') return 'Wrong card PIN. Check it before trying again.';
    if (error.kind === 'busy') return 'The till is finishing an earlier operation. Try again.';
    if (error.kind === 'stopped') return 'Tap cancelled. Check the latest return status below.';
    return CARD_ERROR_TITLES[error.kind] + '. Check the latest return status below.';
  }
  return 'Couldn’t finish the return. Check its status before tapping the same card again.';
}
