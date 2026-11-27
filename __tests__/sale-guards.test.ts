/* The sale controller's own guards and the PIN's digits, each held by a test that fails without it. The sale machine never
 * asks the controller to break some of these guards, so those tests drive the controller with a machine of their own
 * (`step`). */

import { CardError, type CardListener, type CardTransport, type Payment } from 'cashucard';
import { CONFIRMATION, heldPayment, fakeTransport } from './helpers/fake-till';
import { createSaleController, STILL_TAKING_MESSAGE, type Timers } from '../src/till/sale-controller';
import type { SaleEvent, SaleState, SaleStep, TapState } from '../src/till/sale-machine';
import type { CardReader } from '../src/till/reader';

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

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

type Script = (t: CardTransport, l: CardListener, id: string) => Promise<Payment>;

/** A controller over a card script, an optional reader and an optional machine. */
function make(
  script: Script,
  o: { reader?: CardReader; step?: (s: SaleState, e: SaleEvent) => SaleStep } = {},
) {
  const service = {
    openSale: jest.fn(async (_sats: number): Promise<string> => 's1'),
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
  const ctl = createSaleController({ service, reader, onState: (s) => states.push(s), timers: timers.timers, step: o.step });
  return { ctl, service, states, timers };
}

function charge(ctl: ReturnType<typeof make>['ctl']): void {
  for (const d of ['2', '1', '0', '0']) ctl.input({ type: 'digit', d });
  ctl.input({ type: 'charge' });
}

const TAP: TapState = { kind: 'tap', sats: 2100, saleId: 's1', tap: 1, card: false, words: null, ending: null };
const RESULT: SaleState = {
  kind: 'result',
  sats: 2100,
  saleId: 's1',
  outcome: { kind: 'not-paid', errorKind: 'not-enough', title: 'Not enough on the card', message: 'n.' },
  note: null,
};

/** A machine of the test's own: `charge` starts a take on 's1'; the rows given answer their events; every other event
 * leaves the state as it is. The events it was given are kept in `seen`. */
function machine(rows: Partial<Record<SaleEvent['type'], SaleStep>>, seen: SaleEvent[] = []) {
  return (s: SaleState, e: SaleEvent): SaleStep => {
    seen.push(e);
    if (e.type === 'charge') return { state: TAP, effect: { kind: 'take', saleId: 's1' } };
    const row = rows[e.type];
    return row ?? { state: s, effect: null };
  };
}


describe("the sale controller's own guards", () => {
  it('a second take never starts while one runs', async () => {
    const { ctl, service } = make(async () => never<Payment>(), {
      step: machine({ retry: { state: TAP, effect: { kind: 'take', saleId: 's1' } } }),
    });
    charge(ctl);
    await flush();
    expect(service.takeCard).toHaveBeenCalledTimes(1);
    ctl.input({ type: 'retry' });
    await flush();
    expect(service.takeCard).toHaveBeenCalledTimes(1);
    expect(ctl.taking()).toBe(true);
  });

  it('a withdraw never runs while a take runs', async () => {
    const seen: SaleEvent[] = [];
    const { ctl, service } = make(async () => never<Payment>(), {
      step: machine({ 'other-way': { state: TAP, effect: { kind: 'withdraw', saleId: 's1' } } }, seen),
    });
    charge(ctl);
    await flush();
    ctl.input({ type: 'other-way' });
    await flush();
    expect(service.withdrawSale).not.toHaveBeenCalled();
    const failed = seen.find((e) => e.type === 'withdraw-failed');
    expect(failed).toBeDefined();
    if (failed === undefined || failed.type !== 'withdraw-failed') throw new Error('no withdraw-failed');
    expect(failed.error).toBeInstanceOf(CardError);
    expect((failed.error as CardError).kind).toBe('busy');
    expect((failed.error as CardError).message).toBe(STILL_TAKING_MESSAGE);
  });

  it('the controller never stops a tap with a card in the field, whatever the machine asks', async () => {
    let signal: AbortSignal | undefined;
    const { ctl } = make(
      async (t, l) => {
        signal = l.signal;
        await t.begin!('x');
        return never<Payment>();
      },
      { step: machine({ cancel: { state: TAP, effect: { kind: 'stop' } } }) },
    );
    charge(ctl);
    await flush();
    ctl.input({ type: 'cancel' });
    await flush();
    expect(signal?.aborted).toBe(false);
    expect(ctl.taking()).toBe(true);
  });

  it('a take that ends answers what it left asked', async () => {
    let asked: Promise<{ pay: boolean; pin?: string }> | null = null;
    const { ctl } = make(
      async (t, l, id) => {
        await t.begin!('x');
        asked = l.confirm(CONFIRMATION);
        return heldPayment(id);
      },
      { step: machine({}) },
    );
    charge(ctl);
    await flush();
    let answer: { pay: boolean; pin?: string } | null = null;
    if (asked === null) throw new Error('the script never asked');
    void (asked as Promise<{ pay: boolean; pin?: string }>).then((a) => {
      answer = a;
    });
    await flush();
    expect(answer).toEqual({ pay: false });
    expect(ctl.taking()).toBe(false);
  });

  it('a result answers what the library asked', async () => {
    let answer: { pay: boolean; pin?: string } | null = null;
    const { ctl } = make(
      async (t, l) => {
        await t.begin!('x');
        answer = await l.confirm(CONFIRMATION);
        return never<Payment>();
      },
      { step: machine({ 'confirm-asked': { state: RESULT, effect: null } }) },
    );
    charge(ctl);
    await flush();
    expect(answer).toEqual({ pay: false });
    expect(ctl.taking()).toBe(true);
  });
});

describe('the PIN digits', () => {
  it('a PIN asked again after a wrong one gets only the new digits', async () => {
    const got: Array<string | null> = [];
    const { ctl } = make(async (t, l, id) => {
      await t.begin!('x');
      const a = await l.confirm(CONFIRMATION);
      got.push(a.pin ?? null);
      got.push(await l.askPin!({ wrong: true, tries: 2, why: 'allowance' }));
      return heldPayment(id);
    });
    charge(ctl);
    await flush();
    ctl.input({ type: 'pay' });
    for (const d of '8642') ctl.input({ type: 'pin-digit', d });
    ctl.input({ type: 'pin-ok' });
    await flush();
    expect(ctl.state().kind).toBe('pin');
    expect(ctl.pinHeld()).toBe(false);
    for (const d of '1234') ctl.input({ type: 'pin-digit', d });
    ctl.input({ type: 'pin-ok' });
    await flush();
    expect(got).toEqual(['8642', '1234']);
  });

  it('no digit is held once the PIN pad is left', async () => {
    const atPad = async () => {
      const m = make(async (t, l) => {
        await t.begin!('x');
        await l.confirm(CONFIRMATION);
        return never<Payment>();
      });
      charge(m.ctl);
      await flush();
      m.ctl.input({ type: 'pay' });
      for (const d of '86') m.ctl.input({ type: 'pin-digit', d });
      expect(m.ctl.pinHeld()).toBe(true);
      return m;
    };
    const cancelled = await atPad();
    cancelled.ctl.input({ type: 'pin-cancel' });
    expect(cancelled.ctl.pinHeld()).toBe(false);
    const timedOut = await atPad();
    timedOut.timers.fire();
    expect(timedOut.ctl.pinHeld()).toBe(false);
    const left = await atPad();
    left.ctl.dispose();
    expect(left.ctl.pinHeld()).toBe(false);
  });

  it("the PIN pad's wait starts again at every key, past eight digits too", async () => {
    const { ctl, timers } = make(async (t, l) => {
      await t.begin!('x');
      await l.confirm(CONFIRMATION);
      return never<Payment>();
    });
    charge(ctl);
    await flush();
    ctl.input({ type: 'pay' });
    for (let i = 0; i < 12; i += 1) ctl.input({ type: 'pin-digit', d: '1' });
    expect(timers.live()).toEqual([{ ms: 60000 }]);
    const atTwelve = timers.made();
    // the thirteenth digit changes nothing on the pad, but the wait counts again from it
    ctl.input({ type: 'pin-digit', d: '1' });
    expect(ctl.state()).toMatchObject({ kind: 'pin', count: 8 });
    expect(timers.made()).toBe(atTwelve + 1);
    expect(timers.live()).toEqual([{ ms: 60000 }]);
    for (let i = 0; i < 12; i += 1) ctl.input({ type: 'pin-back' });
    const atNone = timers.made();
    // Delete with no digit left changes nothing on the pad, but the wait counts again from it
    ctl.input({ type: 'pin-back' });
    expect(ctl.state()).toMatchObject({ kind: 'pin', count: 0 });
    expect(timers.made()).toBe(atNone + 1);
    expect(timers.live()).toEqual([{ ms: 60000 }]);
  });
});
