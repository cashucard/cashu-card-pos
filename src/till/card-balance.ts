import { CardError, readCardBalance, type CardBalance } from 'cashucard';
import type { CardReader } from './reader';
import type { TillService } from './service';
import { tapSession } from './tap-session';

export type { CardBalance } from 'cashucard';

/** Serialize with other card work, including a settle already running when the cashier presses Check balance. */
export function scanCardBalance(service: Pick<TillService, 'withCard'>, reader: CardReader, signal: AbortSignal,
  onCard: () => void): Promise<CardBalance> {
  return service.withCard('card', async () => {
    if (signal.aborted) throw new CardError('stopped', 'Balance check cancelled.');
    if (!(await reader.available())) throw new CardError('no-reader', 'Turn on NFC to check the card.');
    const transport = tapSession(reader.transport(), { signal, onWait: () => {}, onCard });
    return readCardBalance(transport, { signal });
  });
}
