/* The bench plan's faults on the card simulator's reader: taps that find no card, and signatures lost as the card leaves. */

import type { CardTransport } from 'cashucard';
import { APPLET_CLA, DROPPED_MESSAGE, INS_SIGN, faultyReader } from '../src/dev/card-faults';
import type { CardReader } from '../src/till/reader';
import { DevOnlyError } from '../src/till/store/wipe';
import { fakeTransport } from './helpers/fake-till';

const inner: CardReader = { kind: 'card simulator', available: async () => true, transport: () => fakeTransport() };

/** A transport whose SIGN answers 70 bytes (a signature) and every other command 90 00. */
function signingTransport(): CardTransport {
  return {
    async begin(_prompt: string): Promise<void> {
      // a card is there
    },
    async transceive(apdu: Uint8Array): Promise<Uint8Array> {
      if (apdu[0] === APPLET_CLA && apdu[1] === INS_SIGN) return new Uint8Array(70);
      return new Uint8Array([0x90, 0x00]);
    },
  };
}

const signingReader: CardReader = {
  kind: 'card simulator',
  available: async () => true,
  transport: () => signingTransport(),
};

/** SIGN answered 4 bytes: the card's "not yet", which is never a signature. */
const notYetReader: CardReader = {
  kind: 'card simulator',
  available: async () => true,
  transport: () => ({
    async begin(_prompt: string): Promise<void> {
      // a card is there
    },
    async transceive(_apdu: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array([0x90, 0x00, 0x00, 0x00]);
    },
  }),
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(() => r(), 0));
};

describe('the development card faults', () => {
  it('the faults are for development only', () => {
    expect(() => faultyReader(inner, { absentTaps: 0, dropSigns: 0 }, false)).toThrow(DevOnlyError);
  });

  it('an absent tap waits, once', async () => {
    const faults = { absentTaps: 1, dropSigns: 0 };
    const reader = faultyReader(inner, faults, true);

    const first = reader.transport();
    const waiting = first.begin?.('x');
    let settled = false;
    void waiting?.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await flush();
    expect(settled).toBe(false);
    expect(faults.absentTaps).toBe(0);

    const second = reader.transport();
    await second.begin?.('x');
    expect(settled).toBe(false);
  });

  it('a lost signature drops the card until the next tap', async () => {
    const faults = { absentTaps: 0, dropSigns: 1 };
    const t = faultyReader(signingReader, faults, true).transport();

    await t.begin?.('x');
    await expect(t.transceive(new Uint8Array([0x00, 0xa4]))).resolves.toEqual(new Uint8Array([0x90, 0x00]));
    await expect(t.transceive(new Uint8Array([APPLET_CLA, INS_SIGN, 0, 0]))).rejects.toThrow(DROPPED_MESSAGE);
    await expect(t.transceive(new Uint8Array([0x00, 0xa4]))).rejects.toThrow(DROPPED_MESSAGE);
    expect(faults.dropSigns).toBe(0);

    await t.begin?.('x');
    const answer = await t.transceive(new Uint8Array([APPLET_CLA, INS_SIGN, 0, 0]));
    expect(answer).toHaveLength(70);
  });

  it('a not-yet answer to SIGN is never dropped', async () => {
    const faults = { absentTaps: 0, dropSigns: 1 };
    const t = faultyReader(notYetReader, faults, true).transport();

    await t.begin?.('x');
    const answer = await t.transceive(new Uint8Array([APPLET_CLA, INS_SIGN, 0, 0]));
    expect(answer).toEqual(new Uint8Array([0x90, 0x00, 0x00, 0x00]));
    expect(faults.dropSigns).toBe(1);
  });

  it('the counters count across transports', async () => {
    const faults = { absentTaps: 2, dropSigns: 0 };
    const reader = faultyReader(inner, faults, true);

    let settled = 0;
    const watch = (p: Promise<void> | undefined): void => {
      void p?.then(
        () => {
          settled += 1;
        },
        () => {
          settled += 1;
        },
      );
    };
    watch(reader.transport().begin?.('x'));
    watch(reader.transport().begin?.('x'));
    await flush();
    expect(settled).toBe(0);
    expect(faults.absentTaps).toBe(0);

    await reader.transport().begin?.('x');
    await flush();
    expect(settled).toBe(0);
  });

  it('with both switches, the absent taps come after the lost signature', async () => {
    const faults = { absentTaps: 1, dropSigns: 1 };
    const reader = faultyReader(signingReader, faults, true);

    const t = reader.transport();
    await t.begin?.('x');
    expect(faults.absentTaps).toBe(1);
    await expect(t.transceive(new Uint8Array([APPLET_CLA, INS_SIGN, 0, 0]))).rejects.toThrow(DROPPED_MESSAGE);
    expect(faults.dropSigns).toBe(0);

    let settled = false;
    void reader
      .transport()
      .begin?.('x')
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    await flush();
    expect(settled).toBe(false);
    expect(faults.absentTaps).toBe(0);
  });

  it('the reader says what it is', async () => {
    const reader = faultyReader(inner, { absentTaps: 0, dropSigns: 0 }, true);
    expect(reader.kind).toBe('card simulator');
    await expect(reader.available()).resolves.toBe(true);
  });
});
