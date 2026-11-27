import { CardError, type CardTransport } from 'cashucard';
import { cardReaderAvailable, nfcTransport } from 'cashucard-react-native';
import NfcManager, { NfcAdapter, NfcEvents } from 'react-native-nfc-manager';
import { iosScanSheet } from './scan-sheet';
import type { CardReader } from './reader';

interface Tap {
  adapter: CardTransport;
  phase: 'queued' | 'registering' | 'waiting' | 'connected' | 'failed';
  ended: boolean;
  opening: Promise<void>;
}

/** The card library handles iOS APDU framing and Android IsoDep. The phone has one NFC
 * session shared by sales and returns, including the time it takes to dismiss a cancelled scan. */
export function phoneReader(platform: 'ios' | 'android'): CardReader {
  const sheet = platform === 'ios' ? iosScanSheet() : undefined;
  let owner: Tap | null = null;
  let closing = Promise.resolve();
  let saleScreens = 0;
  let registered: boolean | undefined = false;
  let registration = Promise.resolve();

  // Register before requestTechnology. Android then leaves reader mode in place when the
  // adapter closes IsoDep, so a card still in the field cannot dispatch its NDEF URL.
  // The native manager suspends registration on Activity pause and restores it on resume.
  function syncReaderMode(): Promise<void> {
    if (platform !== 'android') return Promise.resolve();
    registration = registration.catch(() => undefined).then(async () => {
      const needed = saleScreens > 0 || owner !== null;
      if (needed === registered) return;
      // If a bridge call fails, retry against the native adapter on the next change or tap.
      registered = undefined;
      if (needed) {
        await NfcManager.registerTagEvent({
          isReaderModeEnabled: true,
          readerModeFlags: NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
        });
      } else {
        await NfcManager.unregisterTagEvent();
      }
      registered = needed;
    });
    return registration;
  }

  function enterSaleScreen(): () => void {
    saleScreens += 1;
    // NFC can be unavailable on entry. A real tap checks availability and retries registration.
    void syncReaderMode().catch(() => undefined);
    return () => {
      saleScreens -= 1;
      void syncReaderMode().catch(() => undefined);
    };
  }

  function transport(): CardTransport {
    let tap: Tap | null = null;

    async function end(old: Tap | null, how?: { error?: string; message?: string }): Promise<void> {
      if (!old || old.ended) return closing;
      old.ended = true;
      // A begin waiting for another tap to finish has not touched the OS.
      if (old.phase === 'queued') return closing;

      closing = (async () => {
        try {
          if (old.phase === 'registering') {
            // begin observes ended before asking for a tag. Wait before releasing registration.
            await old.opening.catch(() => undefined);
          } else if (old.phase !== 'connected') {
            // The upstream adapter closes only after a tag has been found. Android registers
            // reader mode asynchronously, so a cancel can reach the bridge before its request.
            // Repeat only while that same request is still pending, before another tap can open.
            do {
              await NfcManager.cancelTechnologyRequest({ delayMsAndroid: 0 }).catch(() => undefined);
              if (old.phase === 'waiting') {
                await Promise.race([
                  old.opening.catch(() => undefined),
                  new Promise<void>(resolve => setTimeout(resolve, 100)),
                ]);
              }
            } while (old.phase === 'waiting');
          }
          if (old.phase === 'connected') sheet?.closing();
          await old.adapter.end?.(how);
        } finally {
          owner = null;
          await syncReaderMode().catch(() => undefined);
        }
      })();
      return closing;
    }

    return {
      async begin(prompt) {
        if (tap && !tap.ended) throw new CardError('busy', 'A card tap is already in progress.');
        const current: Tap = {
          adapter: nfcTransport({ platform }),
          phase: 'queued', ended: false, opening: Promise.resolve(),
        };
        tap = current;
        await closing;
        if (current.ended) throw new CardError('stopped', 'Card scan cancelled.');
        if (owner) throw new CardError('busy', 'The phone is already reading a card.');
        owner = current;
        current.phase = 'registering';
        current.opening = (async () => {
          await syncReaderMode();
          if (current.ended) throw new CardError('stopped', 'Card scan cancelled.');
          current.phase = 'waiting';
          await current.adapter.begin!(prompt);
          current.phase = 'connected';
          if (sheet) {
            sheet.connected();
            // A UI notification must never change the outcome of the card operation. The dismissal timer is a fallback.
            try { NfcManager.setEventListener(NfcEvents.SessionClosed, sheet.closed); } catch { /* optional notification */ }
          }
        })().catch(error => {
          current.phase = 'failed';
          throw error;
        });
        try {
          await current.opening;
          if (current.ended) throw new CardError('stopped', 'Card scan cancelled.');
        } catch (e) {
          await end(current);
          throw e;
        }
      },
      async transceive(command) {
        if (!tap || tap.phase !== 'connected' || tap.ended) throw new CardError('stopped', 'The card scan has ended.');
        return tap.adapter.transceive(command);
      },
      setMessage(text) {
        if (tap?.phase === 'connected' && !tap.ended) tap.adapter.setMessage?.(text);
      },
      end: how => end(tap, how),
    };
  }

  return {
    kind: 'nfc', available: cardReaderAvailable, transport, afterScanSheet: sheet?.whenClear,
    enterSaleScreen: platform === 'android' ? enterSaleScreen : undefined,
  };
}
