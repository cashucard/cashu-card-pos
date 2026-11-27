import type { Payment } from 'cashucard';
import { hostOf, sats } from '../format';
import { sameUrl } from './http';
import type { MintEntry } from './settings';

/** Money the record owes to cards of one mint the till does not take now. */
export interface Stranded {
  /** the mint as the payment names it */
  mint: string;
  sats: number;
  /** true: on the till's list but not taking cards; false: not on the list */
  listed: boolean;
}

/** The money owed to cards (owedToCard less what the mint never proved, sats only) of each mint the till does not take
 * now: off its list, or on it but not taking cards. The separate give-back tap reaches these cards even when sales
 * from the same mint are paused or disabled. One entry per mint, in the record's order. */
export function strandedOf(payments: readonly Payment[], mints: readonly MintEntry[]): Stranded[] {
  const out: Stranded[] = [];
  for (const p of payments) {
    const owed = p.owedToCard - p.unproved;
    if (owed <= 0 || p.unit !== 'sat') {
      continue;
    }
    const m = mints.find((x) => sameUrl(x.url, p.mint)) ?? null;
    if (m !== null && m.status === 'ok') {
      continue;
    }
    const s = out.find((x) => sameUrl(x.mint, p.mint));
    if (s !== undefined) {
      s.sats += owed;
    } else {
      out.push({ mint: p.mint, sats: owed, listed: m !== null });
    }
  }
  return out;
}

/** Home's line for one such mint. */
export function strandedWords(s: Stranded): string {
  const lead = 'Owed to cards from ' + hostOf(s.mint) + ': ' + sats(s.sats) + '. ';
  if (s.listed) {
    return (
      lead +
      'This mint is paused for sales. Open Owed to cards and scan the original card. A return may have to wait for the mint.'
    );
  }
  return (
    lead +
    'This mint was removed from sales. Open Owed to cards and scan the original card. A return may have to wait for the mint.'
  );
}