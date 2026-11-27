import type { Claim, Payment } from 'cashucard';
import { plural, sats } from '../format';

export type FigureId = 'owed' | 'unconfirmed' | 'written' | 'kept' | 'stuck' | 'unproved' | 'lost';
export interface PaymentFigure {
  id: FigureId;
  words: string;
}
export interface PaymentWords {
  headline: string;
  sentence: string;
  figures: PaymentFigure[];
}

/** A held payment's why while its sale's row is kept but does not read (cashucard 0.3.0's SALE_UNREADABLE, slice
 * 2.3b): it is never delivered, marked extra or made back until the row reads again, and then goes on by itself. */
export const SALE_UNREADABLE = 'sale-unreadable';

/** How many payments the record holds back because their sale's row does not read (held, why SALE_UNREADABLE). */
export function heldUnreadable(pays: readonly Payment[]): number {
  return pays.filter((p) => p.state === 'held' && p.extra === undefined && p.why === SALE_UNREADABLE).length;
}

/** Home's line for them: '1 payment is held: its sale's record cannot be read on this phone. …' */
export function heldUnreadableWords(n: number): string {
  return n === 1
    ? "1 payment is held: its sale's record cannot be read on this phone. Nothing is lost. Records says more."
    : plural(n, 'payment', 'payments') +
        " are held: their sales' records cannot be read on this phone. Nothing is lost. Records says more.";
}

/** Whether the merchant may be told PAID: held and not an extra payment, or delivered. Never at taking. */
export function isPaid(p: Payment): boolean {
  return (p.state === 'held' && p.extra === undefined) || p.state === 'delivered';
}

interface Row {
  headline: string;
  sentence: string;
}

const CHECKING: Row = {
  headline: 'CHECKING',
  sentence: 'The till is checking this payment.',
};

function rowOf(p: Payment): Row {
  const why = p.why ?? '';
  if (p.state === 'taking') {
    if (p.offline) {
      return {
        headline: 'OFFLINE · PENDING',
        sentence: 'This offline payment is waiting for the mint. Keep the till open when you reconnect.',
      };
    }
    if (why === 'bad-signature') {
      return {
        headline: 'CHECKING',
        sentence: 'The mint has not proved its signatures yet. The till asks it again.',
      };
    }
    if (why.startsWith('swap-waiting')) {
      return {
        headline: 'CHECKING',
        sentence: 'The mint has not taken the payment yet. The till sends it again.',
      };
    }
    return {
      headline: 'CHECKING',
      sentence: p.cardKey
        ? 'The card has paid. The till is checking the payment with the mint. Do not hand over the goods yet.'
        : 'The till is checking the wallet payment with the mint. Keep the original token until the payment is confirmed.',
    };
  }
  if (p.state === 'held') {
    if (p.extra === undefined && why === SALE_UNREADABLE) {
      return {
        headline: "PAID, HELD: ITS SALE'S RECORD DOES NOT READ",
        sentence:
          "The payment is confirmed, but this sale's record cannot be read on this phone, so the money waits in the record and is not kept in the wallet yet. It goes on by itself once the record reads. Records says more.",
      };
    }
    if (p.extra !== undefined && why === 'date-too-near') {
      return {
        headline: 'KEPT FOR THE CUSTOMER',
        sentence: "It cannot go back to the card yet: the card's date is too near. It is kept for the customer.",
      };
    }
    if (p.extra === 'paid-twice') {
      return {
        headline: 'PAID TWICE',
        sentence: p.cardKey ? 'This sale was already paid. This payment goes back to the card at its next tap.'
          : 'This sale was already paid. Open Owed to cards to return the extra payment to the customer’s wallet.',
      };
    }
    if (p.extra === 'late') {
      return {
        headline: 'PAID LATE',
        sentence: p.cardKey ? 'This sale was withdrawn before this payment arrived. It goes back to the card at its next tap.'
          : 'This payment arrived after the sale was withdrawn. Open Owed to cards to return it to the customer’s wallet.',
      };
    }
    return {
      headline: 'PAID',
      sentence: "Paid. The money is in this phone's record, waiting to be kept in its wallet.",
    };
  }
  if (p.state === 'delivered') {
    if (p.offline) return { headline: 'PAID', sentence: 'The mint confirmed the offline payment. The takings are in Wallet.' };
    return { headline: 'PAID', sentence: "Paid and kept in this phone's wallet." };
  }
  if (p.state === 'exported') {
    if (p.extra !== undefined) {
      return {
        headline: 'TAKEN OUT FOR THE CUSTOMER',
        sentence: "The customer's money was taken out by hand as a token, to give back to them.",
      };
    }
    return { headline: 'TAKEN OUT', sentence: 'Paid and taken out by hand as a token.' };
  }
  if (p.state === 'gone') {
    if (p.offline) return { headline: 'OFFLINE · LOST', sentence: 'The mint reports these notes were spent elsewhere. This sale added nothing to Wallet.' };
    return {
      headline: 'LOST',
      sentence: 'The mint says these pieces were spent elsewhere. Nobody this till can reach has them.',
    };
  }
  if (p.state === 'unrecovered') {
    return {
      headline: 'NOT FINISHED',
      sentence: 'The card spent its pieces but has not given its signature. Tap the same card again, with its PIN.',
    };
  }
  if (p.state === 'lost') {
    return {
      headline: 'NOT PAID YET: THE MINT CHANGED ITS KEYS',
      sentence: 'The mint changed its keys while the card signed. The till asks the mint again.',
    };
  }
  if (p.state === 'spent-not-restored') {
    return {
      headline: 'NOT PAID YET: A FAULT AT THE MINT',
      sentence: "The mint says the card's pieces are spent but gave nothing back. The till asks the mint again.",
    };
  }
  if (p.state === 'returning') {
    return {
      headline: 'GOING BACK TO THE CARD',
      sentence: 'This payment is being made back into money for the card.',
    };
  }
  if (p.state === 'returned') {
    if (p.owedToCard > 0) {
      return {
        headline: 'OWED TO THE CARD',
        sentence: 'It is written back to the card at its next tap, with the PIN.',
      };
    }
    return {
      headline: 'WRITTEN TO THE CARD',
      sentence:
        p.unconfirmed > 0
          ? "The customer's money was written to the card. The till counts it as the card's once the mint shows the card has used it."
          : "The customer's money was written to the card, and the till has confirmed it.",
    };
  }
  return CHECKING;
}

/** The figures above zero, in the order of the figure table. */
export function paymentFigures(p: Payment): PaymentFigure[] {
  const figures: PaymentFigure[] = [];
  if (p.owedToCard > 0) {
    figures.push({ id: 'owed', words: 'Owed to the card, not written yet: ' + sats(p.owedToCard) });
  }
  if (p.unconfirmed > 0) {
    figures.push({ id: 'unconfirmed', words: 'Written to the card, not confirmed yet: ' + sats(p.unconfirmed) });
  }
  const written = p.givenBack - p.unconfirmed;
  if (written > 0) {
    figures.push({ id: 'written', words: 'Change written to the card: ' + sats(written) });
  }
  if (p.kept > 0) {
    figures.push({ id: 'kept', words: 'Kept by the till: ' + sats(p.kept) + ' (too small to give back)' });
  }
  if (p.stuck > 0) {
    figures.push({ id: 'stuck', words: "Change waiting for the mint's proof: " + sats(p.stuck) });
  }
  if (p.unproved > 0) {
    figures.push({ id: 'unproved', words: 'Change the mint never proved: ' + sats(p.unproved) + '. It stays owed.' });
  }
  const lost = p.lost ?? 0;
  if (lost > 0) {
    figures.push({ id: 'lost', words: 'Lost from the card: ' + sats(lost) });
  }
  return figures;
}

/** The headline and sentence by the table, and paymentFigures(p). */
export function paymentWords(p: Payment): PaymentWords {
  const row = rowOf(p);
  return { headline: row.headline, sentence: row.sentence, figures: paymentFigures(p) };
}

/** A card payment the library lists as `taking` that is in truth an open claim waiting for its card: its SIGN went out
 * and its signature was not had. The library writes it with step `sign-asked` and state `taking` (cashucard
 * dist/pay.js, beforeSign), so `payments()` lists it as taking and `openClaims()` lists the same row as a claim of step
 * `sign-asked`, the claim's `id` being the payment's `paymentId`. Nothing of it is with the mint; only that card's next
 * tap at this till finishes it. A `taking` payment whose swap was sent (step `signed` or `swapped`) is no claim: it is
 * being checked with the mint, CHECKING. */
export function waitingForCard(p: Payment, claims: readonly Claim[]): boolean {
  return p.state === 'taking' && claims.some((c) => c.id === p.paymentId && c.step === 'sign-asked');
}

/** What a card payment waiting for its card is called (waitingForCard), never CHECKING. Whether its sale was withdrawn
 * cannot be read (no Payment or Claim field says so; a late payment is marked only once its signature is had), so the
 * sentence says what happens in either case. Plain in tone: the merchant waits for the card, or acts. */
export const WAITING_WORDS = {
  headline: 'WAITING FOR THE CARD',
  sentence:
    "The card began this payment and may have signed it. Nothing is paid until the same card is tapped at this till again; it may ask for its PIN. Do not hand over the goods for it. If its sale was paid another way or withdrawn, the money this card pays is the customer's and goes back to the card.",
} as const;

/** The headline's tone, as the notices and the sale's result have it: good only for the merchant's money, where the
 * goods may be handed over (PAID, TAKEN OUT); bad for a loss (LOST), a payment the mint has not paid (NOT PAID YET) and
 * a payment paid twice or late (the customer paid more than the sale); plain where the till, the card or the merchant
 * still has something to do, and for the customer's money owed to, written to or kept for the card. */
export function paymentTone(p: Payment): 'normal' | 'good' | 'bad' {
  if (p.state === 'gone' || p.state === 'lost' || p.state === 'spent-not-restored') {
    return 'bad';
  }
  if (p.state === 'held' && p.extra !== undefined) {
    return p.why === 'date-too-near' ? 'normal' : 'bad';
  }
  if (p.extra === undefined && (isPaid(p) || p.state === 'exported')) {
    return 'good';
  }
  return 'normal';
}
