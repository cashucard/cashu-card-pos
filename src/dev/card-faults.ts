import type { CardTransport } from 'cashucard';
import type { CardReader } from '../till/reader';
import { DevOnlyError } from '../till/store/wipe';

declare const __DEV__: boolean;

/** The bench plan's switches for the card simulator (development only). Counters: each use takes one off. */
export interface DevCardFaults {
  /** the next N taps find no card: begin never resolves (the till waits, and Cancel or its wait ends it); with
   * dropSigns also set, they count only once every lost signature has happened (a tap after the drop finds no card) */
  absentTaps: number;
  /** the next N signatures are lost: SIGN's answer is dropped and the card is gone until the next begin */
  dropSigns: number;
}

/** SIGN's instruction byte, and the applet's class. */
export const INS_SIGN = 0x24;
export const APPLET_CLA = 0xb0;
export const DROPPED_MESSAGE = 'development: the card left as it signed';

/** One transport of the reader with the faults applied. `faults` is the caller's, shared by every transport. */
function withFaults(t: CardTransport, faults: DevCardFaults): CardTransport {
  let gone = false;

  return {
    async begin(prompt: string): Promise<void> {
      if (faults.absentTaps > 0 && faults.dropSigns === 0) {
        faults.absentTaps -= 1;
        // no card in the field: begin never settles, so the till waits until Cancel or its own wait ends the tap
        return new Promise<void>(() => undefined);
      }
      gone = false;
      await t.begin?.(prompt);
    },

    async transceive(apdu: Uint8Array): Promise<Uint8Array> {
      if (gone) throw new Error(DROPPED_MESSAGE);
      const answer = await t.transceive(apdu);
      if (
        faults.dropSigns > 0 &&
        apdu.length >= 2 &&
        apdu[0] === APPLET_CLA &&
        apdu[1] === INS_SIGN &&
        answer.length > 4
      ) {
        faults.dropSigns -= 1;
        gone = true;
        throw new Error(DROPPED_MESSAGE);
      }
      return answer;
    },

    async end(how?: { error?: string; message?: string }): Promise<void> {
      await t.end?.(how);
    },

    setMessage(text: string): void {
      t.setMessage?.(text);
    },
  };
}

/** The card simulator's reader with the bench plan's faults applied. Development only: throws DevOnlyError otherwise. */
export function faultyReader(inner: CardReader, faults: DevCardFaults, dev: boolean = __DEV__): CardReader {
  if (!dev) {
    throw new DevOnlyError();
  }
  return {
    kind: inner.kind,
    available: () => inner.available(),
    transport: () => withFaults(inner.transport(), faults),
  };
}
