/* A sale nobody answers still has a way out: a sale being opened can be cancelled, and a tap that never reached the
 * reader (the reader or the till's queue silent) stops at once on Cancel or its 30 seconds. A tap that reached the reader
 * still waits for the library. What a take or an opening let go sends later changes nothing. */

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { type CardListener, type CardTransport, type Payment } from 'cashucard';
import { heldPayment, fakeTransport } from './helpers/fake-till';
import { press } from './helpers/render';
import { createSaleController, type Timers } from '../src/till/sale-controller';
import { OPEN_CANCELLED, type SaleState } from '../src/till/sale-machine';
import type { CardReader } from '../src/till/reader';
import { OpeningPanel } from '../src/screens/SalePanels';

/** Waits out the microtasks and the zero-delay waits a take runs through between its own steps. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(() => r(), 0));
};

interface FakeTimer {
  f: () => void;
  ms: number;
  cleared: boolean;
  fired: boolean;
}
function fakeTimers(): { timers: Timers; live(): Array<{ ms: number }>; made(): number; fire(): void } {
  const all: FakeTimer[] = [];
  const timers: Timers = {
    set(f, ms) {
      const h: FakeTimer = { f, ms, cleared: false, fired: false };
      all.push(h);
      return h;
    },
    clear(h) {
      (h as FakeTimer).cleared = true;
    },
  };
  const live = (): FakeTimer[] => all.filter((h) => !h.cleared && !h.fired);
  return {
    timers,
    live: () => live().map((h) => ({ ms: h.ms })),
    made: () => all.length,
    fire: () => {
      const l = live();
      if (l.length !== 1) throw new Error('expected exactly one live timer, got ' + l.length);
      l[0].fired = true;
      l[0].f();
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

type Script = (t: CardTransport, l: CardListener, id: string) => Promise<Payment>;

/** A controller over a card script, an optional reader and an optional openSale. */
function make(
  script: Script,
  o: { reader?: CardReader; openSale?: (sats: number) => Promise<string> } = {},
) {
  const service = {
    openSale: jest.fn(o.openSale ?? (async (_sats: number): Promise<string> => 's1')),
    takeCard: jest.fn((id: string, t: CardTransport, l: CardListener): Promise<Payment> => script(t, l, id)),
    withdrawSale: jest.fn(async (_saleId: string): Promise<Payment[]> => []),
  };
  const reader: CardReader = o.reader ?? {
    kind: 'card simulator',
    available: async () => true,
    transport: () => fakeTransport(),
  };
  const states: SaleState[] = [];
  const timers = fakeTimers();
  const ctl = createSaleController({ service, reader, onState: (s) => states.push(s), timers: timers.timers });
  return { ctl, service, states, timers };
}

function charge(ctl: ReturnType<typeof make>['ctl']): void {
  for (const d of ['2', '1', '0', '0']) ctl.input({ type: 'digit', d });
  ctl.input({ type: 'charge' });
}

describe('a way out of a sale nobody answers', () => {
  it('a tap whose reader never answers stops at once on Cancel, and its late answer changes nothing', async () => {
    const answered = deferred<boolean>();
    let calls = 0;
    const reader: CardReader = {
      kind: 'card simulator',
      available: () => {
        calls += 1;
        return calls === 1 ? answered.promise : Promise.resolve(true);
      },
      transport: () => fakeTransport(),
    };
    const { ctl, service } = make(async () => never<Payment>(), { reader });
    charge(ctl);
    await flush();
    expect(ctl.state()).toMatchObject({ kind: 'tap', card: false });
    ctl.input({ type: 'cancel' });
    expect(ctl.state().kind).toBe('stopping');
    await flush();
    expect(ctl.state()).toMatchObject({
      kind: 'result',
      outcome: { kind: 'not-paid', errorKind: 'stopped', title: 'Cancelled' },
    });
    expect(ctl.taking()).toBe(false);
    answered.resolve(true);
    await flush();
    expect(service.takeCard).not.toHaveBeenCalled();
    expect(ctl.state()).toMatchObject({ kind: 'result', outcome: { kind: 'not-paid' } });
  });

  it('a tap the reader never answers stops when its 30 seconds run out', async () => {
    const reader: CardReader = { kind: 'card simulator', available: () => never<boolean>(), transport: () => fakeTransport() };
    const { ctl, timers } = make(async () => never<Payment>(), { reader });
    charge(ctl);
    await flush();
    expect(timers.live()).toEqual([{ ms: 30000 }]);
    timers.fire();
    await flush();
    expect(ctl.state()).toMatchObject({ kind: 'result', outcome: { kind: 'not-paid', title: 'Time ran out' } });
  });

  it('a tap waiting in the queue stops at once, and its late payment never reaches the next sale', async () => {
    const queued = deferred<Payment>();
    const scripts: Script[] = [async () => queued.promise, async () => never<Payment>()];
    let id = 0;
    const { ctl, service } = make((t, l, s) => scripts.shift()!(t, l, s), {
      openSale: async () => {
        id += 1;
        return 's' + String(id);
      },
    });
    charge(ctl);
    await flush();
    ctl.input({ type: 'cancel' });
    await flush();
    expect(ctl.state()).toMatchObject({ kind: 'result', outcome: { kind: 'not-paid', title: 'Cancelled' } });
    ctl.input({ type: 'new' });
    charge(ctl);
    await flush();
    expect(service.takeCard).toHaveBeenCalledTimes(2);
    expect(service.takeCard.mock.calls[1][0]).toBe('s2');
    expect(ctl.state()).toMatchObject({ kind: 'tap', saleId: 's2' });
    queued.resolve(heldPayment('s1'));
    await flush();
    expect(ctl.state()).toMatchObject({ kind: 'tap', saleId: 's2' });
    expect(ctl.taking()).toBe(true);
  });

  it('a tap that reached the reader waits for the library, as before', async () => {
    let signal: AbortSignal | undefined;
    const answer = deferred<void>();
    const { ctl } = make(
      async (t, l) => {
        signal = l.signal;
        try {
          await t.begin!('x');
        } catch (e) {
          await answer.promise;
          throw e;
        }
        return never<Payment>();
      },
      {
        reader: {
          kind: 'card simulator',
          available: async () => true,
          transport: () => ({ begin: () => never<void>(), transceive: async () => new Uint8Array([0x90, 0x00]) }),
        },
      },
    );
    charge(ctl);
    await flush();
    ctl.input({ type: 'cancel' });
    await flush();
    expect(signal?.aborted).toBe(true);
    // the library was asked for a card, so the sale waits for its answer
    expect(ctl.state().kind).toBe('stopping');
    expect(ctl.taking()).toBe(true);
    answer.resolve();
    await flush();
    expect(ctl.state()).toMatchObject({ kind: 'result', outcome: { kind: 'not-paid', title: 'Cancelled' } });
  });

  it('a sale being opened can be cancelled, and its late id is dropped', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const opens = [first.promise, second.promise];
    const { ctl, service } = make(async () => never<Payment>(), { openSale: () => opens.shift()! });
    charge(ctl);
    await flush();
    expect(ctl.state()).toEqual({ kind: 'opening', sats: 2100 });
    ctl.input({ type: 'cancel' });
    expect(ctl.state()).toEqual({
      kind: 'result',
      sats: 2100,
      saleId: null,
      outcome: { kind: 'not-paid', errorKind: 'stopped', title: 'Cancelled', message: OPEN_CANCELLED },
      note: null,
    });
    ctl.input({ type: 'new' });
    charge(ctl);
    await flush();
    expect(ctl.state().kind).toBe('opening');
    first.resolve('s1');
    await flush();
    expect(ctl.state().kind).toBe('opening');
    expect(service.takeCard).not.toHaveBeenCalled();
    second.resolve('s2');
    await flush();
    expect(service.takeCard).toHaveBeenCalledTimes(1);
    expect(service.takeCard.mock.calls[0][0]).toBe('s2');
  });

  it('the opening screen offers Cancel', async () => {
    const send = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<OpeningPanel sats={2100} send={send} />);
    });
    await press(tree, 'opening-cancel');
    expect(send).toHaveBeenCalledWith({ type: 'cancel' });
  });
});
