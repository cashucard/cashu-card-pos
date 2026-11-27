/* One tap's session: a card in the field, Cancel while no card is there, and the reader's own failures passed on. */

import { CardError, type CardTransport } from 'cashucard';
import {
  CANCELLED_MESSAGE,
  CANCELLED_SHEET,
  type TapSessionHooks,
  tapSession,
} from '../src/till/tap-session';

interface Held {
  t: CardTransport;
  resolveBegin: () => void;
  rejectBegin: (e: unknown) => void;
  ends: Array<unknown>;
}

/** A transport whose begin waits for the test to settle it; end records how it was closed. */
function held(): Held {
  const ends: Array<unknown> = [];
  let resolveBegin: () => void = () => undefined;
  let rejectBegin: (e: unknown) => void = () => undefined;
  const begun = new Promise<void>((resolve, reject) => {
    resolveBegin = resolve;
    rejectBegin = reject;
  });
  const t: CardTransport = {
    begin: jest.fn(() => begun),
    transceive: jest.fn(async (_apdu: Uint8Array) => new Uint8Array([0x90, 0x00])),
    end: jest.fn(async (how?: { error?: string; message?: string }) => {
      ends.push(how);
    }),
  };
  return { t, resolveBegin, rejectBegin, ends };
}

function hooks(ctl: AbortController): TapSessionHooks {
  return { signal: ctl.signal, onWait: jest.fn(), onCard: jest.fn() };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(() => r(), 0));
};

/** The error a promise rejects with, for its own checks. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  let e: unknown = null;
  try {
    await p;
  } catch (caught) {
    e = caught;
  }
  return e;
}

describe('a tap session', () => {
  it('a card in the field is told once begin resolves', async () => {
    const { t, resolveBegin } = held();
    const ctl = new AbortController();
    const h = hooks(ctl);
    const s = tapSession(t, h);

    const p = s.begin!('x');
    expect(h.onWait).toHaveBeenCalledTimes(1);
    expect(h.onCard).not.toHaveBeenCalled();
    expect(s.cardIn()).toBe(false);

    resolveBegin();
    await p;
    expect(h.onCard).toHaveBeenCalledTimes(1);
    expect(s.cardIn()).toBe(true);

    await s.end!();
    expect(s.cardIn()).toBe(false);
  });

  it('Cancel while waiting stops the tap with nothing taken', async () => {
    const { t, resolveBegin, ends } = held();
    const ctl = new AbortController();
    const h = hooks(ctl);
    const s = tapSession(t, h);

    const p = s.begin!('x');
    ctl.abort();

    const e = await rejection(p);
    expect(e).toBeInstanceOf(CardError);
    const ce = e as CardError;
    expect(ce.kind).toBe('stopped');
    expect(ce.signed).toBe(false);
    expect(ce.message).toBe(CANCELLED_MESSAGE);
    expect(ends).toEqual([{ error: CANCELLED_SHEET }]);
    expect(h.onCard).not.toHaveBeenCalled();

    resolveBegin();
    await flush();
    expect(s.cardIn()).toBe(false);
  });

  it('an aborted take never begins', async () => {
    const { t } = held();
    const ctl = new AbortController();
    const h = hooks(ctl);
    const s = tapSession(t, h);

    ctl.abort();
    const e = await rejection(s.begin!('x'));
    expect(e).toBeInstanceOf(CardError);
    expect((e as CardError).kind).toBe('stopped');
    expect(t.begin as jest.Mock).not.toHaveBeenCalled();
  });

  it('the reader’s own failure is passed on', async () => {
    const { t, rejectBegin } = held();
    const ctl = new AbortController();
    const h = hooks(ctl);
    const s = tapSession(t, h);

    const p = s.begin!('x');
    rejectBegin(new Error('nfc off'));
    await expect(p).rejects.toThrow(/nfc off/);
    expect(h.onCard).not.toHaveBeenCalled();
    expect(s.cardIn()).toBe(false);
  });

  it('once a card is in the field an abort stops nothing here', async () => {
    const { t, resolveBegin } = held();
    const ctl = new AbortController();
    const h = hooks(ctl);
    const s = tapSession(t, h);

    const p = s.begin!('x');
    resolveBegin();
    await p;

    ctl.abort();
    const answer = await s.transceive(new Uint8Array([1]));
    expect(t.transceive).toHaveBeenCalledTimes(1);
    expect(answer).toEqual(new Uint8Array([0x90, 0x00]));
  });

  it('a transport with no begin has its card at once', async () => {
    const ctl = new AbortController();
    const h = hooks(ctl);
    const s = tapSession({ transceive: async () => new Uint8Array([0x90, 0]) }, h);

    await s.begin!('x');
    expect(h.onCard).toHaveBeenCalledTimes(1);
    expect(s.cardIn()).toBe(true);
  });

  it('an end that throws while cancelling is ignored', async () => {
    const { t } = held();
    t.end = jest.fn(async () => {
      throw new Error('closed');
    });
    const ctl = new AbortController();
    const h = hooks(ctl);
    const s = tapSession(t, h);

    const p = s.begin!('x');
    ctl.abort();

    const e = await rejection(p);
    expect(e).toBeInstanceOf(CardError);
    expect((e as CardError).kind).toBe('stopped');
    expect(t.end as jest.Mock).toHaveBeenCalledTimes(1);
    await flush();
  });
});
