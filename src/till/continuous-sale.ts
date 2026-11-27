import { CardError, type CardConfirmation, type CardTransport } from 'cashucard';
import { PRE_TAP_FEE_LIMIT } from './sale-machine';
import type { TapSession } from './tap-session';

/** Apply only the terms the holder could approve before presenting the card. The SDK
 * still validates the mint, proofs, card identity and the final plan before signing. */
export function withinApprovedTotal(quote: CardConfirmation, price: number): boolean {
  return quote.unit === 'sat' && quote.price === price && quote.kept === 0 && quote.leftover === 0 &&
    Number.isSafeInteger(quote.inputFees) && quote.inputFees >= 0 && quote.inputFees <= PRE_TAP_FEE_LIMIT &&
    quote.total === price + quote.inputFees;
}

/** The SDK has separate read and signing phases. Keep the physical contact between
 * just those two phases. A manual review, retry, error or completed job releases it. */
export function continuousSale(session: TapSession) {
  let firstRead = true;
  let betweenReads = false;
  // A native reconnect after accepting a quote needs a new holder decision.
  let approvedContactOnly = false;
  let freshPinGiven = false;

  async function release(message: string): Promise<void> {
    betweenReads = false;
    if (session.cardIn()) await session.end?.({ message });
  }

  const transport: CardTransport = {
    ...session,
    async begin(prompt) {
      if (betweenReads) {
        betweenReads = false;
        return;
      }
      if (approvedContactOnly && !freshPinGiven) {
        throw new CardError('stopped', 'The card needs another scan. Review the payment again before continuing.');
      }
      freshPinGiven = false;
      await session.begin?.(prompt);
    },
    async end(how) {
      if (firstRead) {
        firstRead = false;
        if (how?.error === undefined && session.cardIn()) {
          betweenReads = true;
          return;
        }
      }
      await session.end?.(how);
    },
  };
  return {
    transport, betweenReads: () => betweenReads, release,
    approveCurrentContact() { approvedContactOnly = true; },
    allowFreshPinRetry() { freshPinGiven = true; },
  };
}
