import { CardError, type CardTransport } from 'cashucard';

/** The words for a waiting tap the merchant cancelled: nothing was taken. */
export const CANCELLED_MESSAGE = 'Cancelled before a card was held to the phone. Nothing was taken.';
/** The line the reader's own sheet shows when a waiting tap is cancelled. */
export const CANCELLED_SHEET = 'Cancelled.';

/** What a tap's session tells the controller. */
export interface TapSessionHooks {
  /** the take's signal (the controller's AbortController) */
  signal: AbortSignal;
  /** called at each begin, before the reader is asked */
  onWait: () => void;
  /** called once the reader's begin resolved: a card is in the field */
  onCard: () => void;
}

/** The reader's transport for one card payment: a wait can be cancelled, and the controller is told of each stage. */
export interface TapSession extends CardTransport {
  /** whether a card is in the field now: begin resolved and end not called since */
  cardIn(): boolean;
}

/** The error a waiting begin rejects with once the signal is aborted. */
export function cancelledError(): CardError {
  return new CardError('stopped', CANCELLED_MESSAGE, { aborted: true });
}

/** The reader's transport for one card payment. It tells the controller when the till waits for a card (`onWait`) and
 * when a card is in the field (`onCard`), and it makes Cancel work while no card is there: the library passes no signal
 * to `begin`, so an NFC session waiting for a card would otherwise wait until the phone gives up. On the take's abort a
 * waiting `begin` rejects at once with the library's `stopped` error (nothing was taken) and the reader's session is
 * told to end. Once a card is in the field the session is never stopped here: the library stops only before its next
 * command, and the controller never aborts while a card is there. */
export function tapSession(inner: CardTransport, h: TapSessionHooks): TapSession {
  let here = false;

  /** End the reader's session after a cancelled wait. A sheet line is not worth a payment: a throw is ignored. */
  function stopInner(): void {
    try {
      const ended = inner.end?.({ error: CANCELLED_SHEET });
      if (ended) ended.catch(() => undefined);
    } catch {
      // the session is gone either way
    }
  }

  const session: TapSession = {
    async begin(prompt: string): Promise<void> {
      here = false;
      h.onWait();
      if (h.signal.aborted) {
        throw cancelledError();
      }
      const started: Promise<void> = inner.begin ? inner.begin(prompt) : Promise.resolve();
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          h.signal.removeEventListener('abort', onAbort);
          stopInner();
          reject(cancelledError());
        };
        h.signal.addEventListener('abort', onAbort);
        started.then(
          () => {
            if (settled) return;
            settled = true;
            h.signal.removeEventListener('abort', onAbort);
            here = true;
            h.onCard();
            resolve();
          },
          (e: unknown) => {
            if (settled) return;
            settled = true;
            h.signal.removeEventListener('abort', onAbort);
            reject(e);
          },
        );
      });
    },

    async transceive(apdu: Uint8Array): Promise<Uint8Array> {
      return inner.transceive(apdu);
    },

    setMessage(text: string): void {
      try {
        inner.setMessage?.(text);
      } catch {
        // a sheet's line is not worth a payment
      }
    },

    async end(how?: { error?: string; message?: string }): Promise<void> {
      here = false;
      await inner.end?.(how);
    },

    cardIn(): boolean {
      return here;
    },
  };
  return session;
}
