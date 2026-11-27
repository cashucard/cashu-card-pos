/* The sale's controller: the machine's effects run through the till, the library's callbacks become its events, and what
 * the machine must not hold is held here and only here (the answers, the take's signal, the wait, the PIN's digits). */

import { CardError, stageWords, type CardListener, type CardTransport, type Payment } from 'cashucard';
import { LightningPaymentReceived, LightningStatusUnknown } from '../src/till/lightning-sale';
import { CONFIRMATION, heldPayment, fakeTransport } from './helpers/fake-till';
import { createSaleController, NO_READER_MESSAGE, type SaleController, type Timers } from '../src/till/sale-controller';
import type { SaleState } from '../src/till/sale-machine';
import type { CardReader } from '../src/till/reader';

const PIN = '8642';

/** Waits out the microtasks and the zero-delay waits a take runs through between its own steps. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(() => r(), 0));
};

/** The controller's waits, held by the test: nothing fires until it says so. */
interface FakeTimer {
  f: () => void;
  ms: number;
  cleared: boolean;
  fired: boolean;
}
function fakeTimers(): { timers: Timers; live(): Array<{ ms: number }>; fire(): void } {
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
  return {
    timers,
    live: () => all.filter((h) => !h.cleared && !h.fired).map((h) => ({ ms: h.ms })),
    fire: () => {
      const live = all.filter((h) => !h.cleared && !h.fired);
      if (live.length !== 1) throw new Error('expected exactly one live timer, got ' + live.length);
      const h = live[0];
      h.fired = true;
      h.f();
    },
  };
}

/** A transport whose begin waits for the test to settle it: no card is in the field until resolveBegin. */
function gateTransport(): { t: CardTransport; resolveBegin: () => void } {
  let resolveBegin: () => void = () => undefined;
  const begun = new Promise<void>((r) => {
    resolveBegin = r;
  });
  const t: CardTransport = {
    begin: jest.fn(() => begun),
    transceive: jest.fn(async (_apdu: Uint8Array) => new Uint8Array([0x90, 0x00])),
    end: jest.fn(async () => undefined),
  };
  return { t, resolveBegin };
}

function reader(t: CardTransport, available = true): CardReader {
  return { kind: 'card simulator', available: async () => available, transport: () => t };
}

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A promise that never settles: a take that is still running when the test ends. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/** A controller over a fake till's card script and a given reader. */
function makeWith(script: (t: CardTransport, l: CardListener, id: string) => Promise<Payment>, r: CardReader) {
  const service = {
    openSale: jest.fn(async (_sats: number): Promise<string> => 's1'),
    takeCard: jest.fn((id: string, t: CardTransport, l: CardListener): Promise<Payment> => script(t, l, id)),
    withdrawSale: jest.fn(async (_saleId: string): Promise<Payment[]> => []),
  };
  const states: SaleState[] = [];
  const timers = fakeTimers();
  const ctl = createSaleController({ service, reader: r, onState: (s) => states.push(s), timers: timers.timers });
  return { ctl, service, states, timers };
}

/** A controller over the card script, a transport and the reader's availability. */
function make(
  script: (t: CardTransport, l: CardListener, id: string) => Promise<Payment>,
  transport: CardTransport = gateTransport().t,
  available = true,
) {
  return makeWith(script, reader(transport, available));
}

function charge(ctl: SaleController): void {
  for (const d of ['2', '1', '0', '0']) ctl.input({ type: 'digit', d });
  ctl.input({ type: 'charge' });
}

function pinIn(ctl: SaleController, pin: string): void {
  for (const d of pin) ctl.input({ type: 'pin-digit', d });
  ctl.input({ type: 'pin-ok' });
}

/** The result a state is, or a failed test. */
function resultOf(s: SaleState): Extract<SaleState, { kind: 'result' }> {
  if (s.kind !== 'result') throw new Error('expected a result, got ' + s.kind);
  return s;
}

describe('the sale controller', () => {
  it('a sale is opened for the amount typed, then the card is asked for', async () => {
    const g = gateTransport();
    const { ctl, service } = make(async (t) => {
      await t.begin!('x');
      return never<Payment>();
    }, g.t);
    charge(ctl);
    await flush();
    expect(service.openSale).toHaveBeenCalledTimes(1);
    expect(service.openSale).toHaveBeenCalledWith(2100);
    expect(service.takeCard).toHaveBeenCalledTimes(1);
    expect(service.takeCard.mock.calls[0][0]).toBe('s1');
    expect(ctl.state()).toEqual({ kind: 'tap', sats: 2100, saleId: 's1', tap: 1, card: false, words: null, ending: null });
    g.resolveBegin();
    await flush();
    expect(ctl.state()).toMatchObject({ kind: 'tap', tap: 1, card: true });
  });

  it('the PIN goes to the library once, and is never kept', async () => {
    let a: { pay: boolean; pin?: string } | null = null;
    const { ctl, states } = make(async (t, l, id) => {
      await t.begin!('x');
      a = await l.confirm(CONFIRMATION);
      return heldPayment(id);
    }, fakeTransport());
    charge(ctl);
    await flush();
    ctl.input({ type: 'pay' });
    pinIn(ctl, PIN);
    await flush();
    expect(a).toEqual({ pay: true, pin: '8642' });
    expect(resultOf(ctl.state()).outcome.kind).toBe('paid');
    for (const s of states.map((x) => JSON.stringify(x))) expect(s).not.toContain('8642');
    const pinKeys = ['back', 'count', 'from', 'kind', 'saleId', 'sats', 'tries', 'why', 'wrong'];
    for (const s of states) {
      if (s.kind === 'pin') expect(Object.keys(s).sort()).toEqual(pinKeys);
    }
  });

  it('OK waits for four digits', async () => {
    let a: { pay: boolean; pin?: string } | null = null;
    const { ctl } = make(async (t, l) => {
      await t.begin!('x');
      a = await l.confirm(CONFIRMATION);
      return never<Payment>();
    }, fakeTransport());
    charge(ctl);
    await flush();
    ctl.input({ type: 'pay' });
    for (const d of ['8', '6', '4']) ctl.input({ type: 'pin-digit', d });
    ctl.input({ type: 'pin-ok' });
    await flush();
    expect(ctl.state().kind).toBe('pin');
    expect(a).toBeNull();
  });

  it('Delete takes the last digit off', async () => {
    let a: { pay: boolean; pin?: string } | null = null;
    const { ctl } = make(async (t, l) => {
      await t.begin!('x');
      a = await l.confirm(CONFIRMATION);
      return never<Payment>();
    }, fakeTransport());
    charge(ctl);
    await flush();
    ctl.input({ type: 'pay' });
    for (const d of ['8', '6', '4', '2', '9']) ctl.input({ type: 'pin-digit', d });
    ctl.input({ type: 'pin-back' });
    ctl.input({ type: 'pin-ok' });
    await flush();
    expect(a).toEqual({ pay: true, pin: '8642' });
  });

  it('digits typed outside the PIN pad go nowhere', async () => {
    const { ctl, states } = make(async () => never<Payment>());
    ctl.input({ type: 'pin-digit', d: '5' });
    await flush();
    expect(states).toEqual([]);
    expect(ctl.state()).toEqual({ kind: 'keypad', digits: '' });
  });

  it('PAID only when the library answers a held payment', async () => {
    const { ctl, states } = make(async (t, l, id) => {
      await t.begin!('x');
      return { ...heldPayment(id), state: 'taking' };
    }, fakeTransport());
    charge(ctl);
    await flush();
    expect(resultOf(ctl.state()).outcome.kind).toBe('checking');
    for (const s of states) {
      if (s.kind === 'result') expect(s.outcome.kind).not.toBe('paid');
    }
  });

  it('a wrong PIN asks again, and the new PIN goes to the library', async () => {
    let answer: string | null = null;
    const { ctl } = make(async (_t, l) => {
      answer = await l.askPin!({ wrong: true, tries: 2, why: 'allowance' });
      return never<Payment>();
    });
    charge(ctl);
    await flush();
    expect(ctl.state()).toMatchObject({ kind: 'pin', wrong: true, tries: 2 });
    pinIn(ctl, '1234');
    await flush();
    expect(answer).toBe('1234');
    expect(ctl.state()).toMatchObject({ kind: 'tap', tap: 1 });
  });

  it('Cancel while no card is in the field stops the tap, and nothing is taken', async () => {
    const { ctl } = make(async (t) => {
      try {
        await t.begin!('x');
      } catch (e) {
        throw e;
      }
      return heldPayment('s1');
    });
    charge(ctl);
    await flush();
    ctl.input({ type: 'cancel' });
    expect(ctl.state().kind).toBe('stopping');
    await flush();
    expect(resultOf(ctl.state()).outcome).toMatchObject({ kind: 'not-paid', title: 'Cancelled', errorKind: 'stopped' });
  });

  it('there is no Cancel with a card in the field', async () => {
    const g = gateTransport();
    const seen: { signal?: AbortSignal } = {};
    const { ctl } = make(async (t, l) => {
      seen.signal = l.signal;
      await t.begin!('x');
      return never<Payment>();
    }, g.t);
    charge(ctl);
    await flush();
    g.resolveBegin();
    await flush();
    const before = JSON.stringify(ctl.state());
    ctl.input({ type: 'cancel' });
    await flush();
    expect(JSON.stringify(ctl.state())).toBe(before);
    expect(seen.signal?.aborted).toBe(false);
  });

  it('a card that does not come in 30 seconds stops the tap', async () => {
    const { ctl, timers } = make(async (t) => {
      await t.begin!('x');
      return heldPayment('s1');
    });
    charge(ctl);
    await flush();
    expect(timers.live().map((x) => x.ms)).toEqual([30000]);
    timers.fire();
    await flush();
    expect(resultOf(ctl.state()).outcome).toMatchObject({ kind: 'not-paid', title: 'Time ran out' });
  });

  it('the sheet waits 120 seconds, then says no', async () => {
    const answers: Array<{ pay: boolean; pin?: string }> = [];
    const { ctl, timers } = make(async (t, l) => {
      await t.begin!('x');
      const a = await l.confirm(CONFIRMATION);
      answers.push(a);
      if (!a.pay) throw new CardError('declined', 'The payer did not accept. Nothing was taken.');
      return heldPayment('s1');
    }, fakeTransport());
    charge(ctl);
    await flush();
    expect(ctl.state().kind).toBe('confirm');
    expect(timers.live().map((x) => x.ms)).toEqual([120000]);
    timers.fire();
    await flush();
    expect(answers).toEqual([{ pay: false }]);
    expect(resultOf(ctl.state()).outcome).toMatchObject({ kind: 'not-paid', title: 'Time ran out' });
  });

  it('the PIN pad waits 60 seconds from the last key', async () => {
    const answers: Array<{ pay: boolean; pin?: string }> = [];
    const { ctl, timers } = make(async (t, l) => {
      await t.begin!('x');
      answers.push(await l.confirm(CONFIRMATION));
      return never<Payment>();
    }, fakeTransport());
    charge(ctl);
    await flush();
    ctl.input({ type: 'pay' });
    expect(timers.live().map((x) => x.ms)).toEqual([60000]);
    ctl.input({ type: 'pin-digit', d: '1' });
    expect(timers.live().map((x) => x.ms)).toEqual([60000]);
    timers.fire();
    await flush();
    expect(answers).toEqual([{ pay: false }]);
  });

  it("a card's waiting time stops once a card is in the field", async () => {
    const g = gateTransport();
    const { ctl, timers } = make(async (t) => {
      await t.begin!('x');
      return never<Payment>();
    }, g.t);
    charge(ctl);
    await flush();
    g.resolveBegin();
    await flush();
    expect(timers.live()).toEqual([]);
  });

  it('one card payment at a time', async () => {
    const held = deferred<Payment>();
    const { ctl, service } = make(async () => held.promise);
    charge(ctl);
    await flush();
    const before = JSON.stringify(ctl.state());
    ctl.input({ type: 'retry' });
    ctl.input({ type: 'charge' });
    ctl.input({ type: 'new' });
    await flush();
    expect(JSON.stringify(ctl.state())).toBe(before);
    expect(service.takeCard).toHaveBeenCalledTimes(1);
    expect(ctl.taking()).toBe(true);
    held.resolve(heldPayment('s1'));
    await flush();
    expect(ctl.taking()).toBe(false);
  });

  it('withdraw only after the take has ended, with close(false)', async () => {
    const order: string[] = [];
    const { ctl, service } = make(async () => {
      order.push('take end');
      throw new CardError('interrupted', 'm.', { signed: true });
    });
    service.withdrawSale.mockImplementation(async (_saleId: string): Promise<Payment[]> => {
      order.push('withdraw');
      return [];
    });
    charge(ctl);
    await flush();
    expect(resultOf(ctl.state()).outcome.kind).toBe('tap-again');
    ctl.input({ type: 'other-way' });
    ctl.input({ type: 'withdraw-yes' });
    await flush();
    expect(service.withdrawSale).toHaveBeenCalledTimes(1);
    expect(service.withdrawSale).toHaveBeenCalledWith('s1');
    expect(order).toEqual(['take end', 'withdraw']);
    expect(resultOf(ctl.state()).outcome.kind).toBe('withdrawn');
  });

  it('leaving the screen answers no, and stops only a tap with no card', async () => {
    // (a) the sheet is up: the confirm is answered no, and the card in the field is not stopped
    const asked: Array<{ pay: boolean; pin?: string }> = [];
    const a = make(async (t, l) => {
      await t.begin!('x');
      asked.push(await l.confirm(CONFIRMATION));
      return heldPayment('s1');
    }, fakeTransport());
    charge(a.ctl);
    await flush();
    expect(a.ctl.state().kind).toBe('confirm');
    const aCount = a.states.length;
    a.ctl.dispose();
    await flush();
    expect(asked).toEqual([{ pay: false }]);
    expect(a.timers.live()).toEqual([]);
    expect(a.states.length).toBe(aCount);

    // (b) a tap with no card in the field: the signal is aborted
    const seenB: { signal?: AbortSignal } = {};
    const b = make(async (t, l) => {
      seenB.signal = l.signal;
      await t.begin!('x');
      return heldPayment('s1');
    });
    charge(b.ctl);
    await flush();
    const bCount = b.states.length;
    b.ctl.dispose();
    await flush();
    expect(seenB.signal?.aborted).toBe(true);
    expect(b.timers.live()).toEqual([]);
    expect(b.states.length).toBe(bCount);

    // (c) a card is in the field and the script waits: the signal is left alone
    const g = gateTransport();
    const seenC: { signal?: AbortSignal } = {};
    const c = make(async (t, l) => {
      seenC.signal = l.signal;
      await t.begin!('x');
      return never<Payment>();
    }, g.t);
    charge(c.ctl);
    await flush();
    g.resolveBegin();
    await flush();
    const cCount = c.states.length;
    c.ctl.dispose();
    await flush();
    expect(seenC.signal?.aborted).toBe(false);
    expect(c.timers.live()).toEqual([]);
    expect(c.states.length).toBe(cCount);
  });

  it('a question asked after the screen has gone is answered no', async () => {
    const gone = deferred<void>();
    const answers: { c: { pay: boolean; pin?: string } | null; p: string | null } = { c: null, p: null };
    const { ctl } = make(async (_t, l, id) => {
      await gone.promise;
      answers.c = await l.confirm(CONFIRMATION);
      answers.p = await l.askPin!({ wrong: false, tries: null });
      return heldPayment(id);
    });
    charge(ctl);
    await flush();
    ctl.dispose();
    gone.resolve(undefined);
    await flush();
    expect(answers.c).toEqual({ pay: false });
    expect(answers.p).toBeNull();
  });

  it('a phone with no reader is told so, and the library is never asked', async () => {
    const none = make(async () => heldPayment('s1'), gateTransport().t, false);
    charge(none.ctl);
    await flush();
    expect(resultOf(none.ctl.state()).outcome).toMatchObject({
      kind: 'not-paid',
      errorKind: 'no-reader',
      message: NO_READER_MESSAGE,
    });
    expect(none.service.takeCard).not.toHaveBeenCalled();

    const noTransport: CardReader = {
      kind: 'card simulator',
      available: async () => true,
      transport: () => {
        throw new Error('none');
      },
    };
    const thrown = makeWith(async () => heldPayment('s1'), noTransport);
    charge(thrown.ctl);
    await flush();
    expect(resultOf(thrown.ctl.state()).outcome).toMatchObject({
      kind: 'not-paid',
      errorKind: 'no-reader',
      message: NO_READER_MESSAGE,
    });
    expect(thrown.service.takeCard).not.toHaveBeenCalled();
  });

  it('the stages show as the library reports them', async () => {
    const { ctl } = make(async (_t, l) => {
      l.onStage?.('signing', stageWords('signing', { seconds: 1 }), {});
      l.onStage?.('failed', stageWords('failed'), {});
      return never<Payment>();
    });
    charge(ctl);
    await flush();
    const s = ctl.state();
    if (s.kind !== 'tap') throw new Error('expected a tap');
    expect(s.words).toEqual(stageWords('signing', { seconds: 1 }));
  });
});


describe('shared Lightning and card checkout', () => {
  function fixture(open = jest.fn(async () => 'sale-1')) {
    const timers = fakeTimers();
    const service = {
      openSale: open, withdrawSale: jest.fn(), takeCard: jest.fn((_id: string) => never<Payment>()),
      leaveSale: jest.fn(async () => undefined), lightningOffer: jest.fn(),
    };
    const ctl = createSaleController({
      service, reader: { ...reader(gateTransport().t), kind: 'nfc' },
      onState: () => undefined, timers: timers.timers,
    });
    charge(ctl);
    return {ctl, timers, service};
  }

  it('opens once for both tenders and requires deliberate PIN submission before NFC', async () => {
    const opening = deferred<string>();
    const {ctl, service} = fixture(jest.fn(() => opening.promise));
    pinIn(ctl, PIN);
    expect(service.takeCard).not.toHaveBeenCalled();
    opening.resolve('sale-1');
    await flush();
    expect(ctl.state()).toMatchObject({kind:'preflight', saleId:'sale-1', count:4});
    ctl.input({type:'pin-ok'});
    await flush();
    expect(service.takeCard).toHaveBeenCalledTimes(1);
    expect(service.takeCard.mock.calls[0][0]).toBe('sale-1');
    expect(service.openSale).toHaveBeenCalledTimes(1);
    ctl.dispose();
  });

  it('retains the invoice when an idle PIN expires or a camera backgrounds the application', async () => {
    const {ctl, timers, service} = fixture();
    await flush();
    ctl.input({type:'pin-ok'});
    expect(timers.live()).toHaveLength(0);
    ctl.input({type:'pin-digit', d:'2'});
    timers.fire();
    expect(ctl.pinHeld()).toBe(false);
    expect(ctl.state()).toMatchObject({kind:'preflight',saleId:'sale-1',count:0});
    ctl.input({type:'pin-digit', d:'3'});
    expect(ctl.holdWallet('sale-1')).toBe(true);
    expect(ctl.pinHeld()).toBe(false);
    ctl.background();
    ctl.foreground();
    ctl.walletProcessing('sale-1');
    ctl.releaseWallet('sale-1');
    pinIn(ctl, PIN);
    expect(service.takeCard).not.toHaveBeenCalled();
    ctl.walletPaid('foreign-sale','Lightning');
    expect(ctl.state().kind).toBe('preflight');
    ctl.walletPaid('sale-1','Lightning');
    expect(ctl.state()).toMatchObject({kind:'result',outcome:{kind:'wallet-paid',rail:'Lightning'}});
    ctl.input({type:'new'});
    expect(service.leaveSale).toHaveBeenCalledWith('sale-1');
    expect(ctl.state().kind).toBe('keypad');
    ctl.dispose();
  });

  it('releases an opening cancelled checkout, and isolates its callbacks from the next sale', async () => {
    const opening = deferred<string>();
    const open = jest.fn(() => Promise.resolve('second')).mockReturnValueOnce(opening.promise);
    const {ctl, service} = fixture(open);
    ctl.input({type:'pin-cancel'});
    ctl.input({type:'charge'});
    await flush();
    opening.resolve('first');
    await flush();
    expect(service.leaveSale).toHaveBeenCalledWith('first');
    ctl.walletPaid('first','Lightning');
    expect(ctl.state()).toMatchObject({kind:'preflight', saleId:'second'});
    ctl.walletExtra('second');
    expect(ctl.state()).toMatchObject({kind:'result',outcome:{kind:'lightning-extra'}});
    ctl.dispose();
  });
});

it('shows the received Lightning payment when it beats the PIN submit to the mint', async () => {
  const {ctl} = makeWith(async () => {
    throw new LightningPaymentReceived({saleId:'s1', paymentId:'ln-s1', amount:2100, state:'paid',
      mint:'https://mint.test',invoice:'test-invoice',expiresAt:1000,createdAt:100});
  }, reader(gateTransport().t));
  charge(ctl);
  await flush();
  expect(ctl.state()).toMatchObject({kind:'result',saleId:'s1',outcome:{kind:'wallet-paid',rail:'Lightning'}});
  expect(ctl.pinHeld()).toBe(false);
  ctl.dispose();
});

it('checks the original invoice after a failed status request before enabling either tender again', async () => {
  const script = jest.fn(async () => { throw new LightningStatusUnknown('s1'); });
  const {ctl} = makeWith(script, reader(gateTransport().t));
  charge(ctl);
  await flush();
  expect(ctl.state()).toMatchObject({kind:'preflight',saleId:'s1',verifyInvoice:true,count:0});
  pinIn(ctl, PIN);
  expect(ctl.pinHeld()).toBe(false);
  expect(ctl.holdWallet('s1')).toBe(false);
  expect(script).toHaveBeenCalledTimes(1);
  ctl.invoiceUnpaid('old-sale');
  expect(ctl.state()).toMatchObject({verifyInvoice:true});
  ctl.invoiceUnpaid('s1');
  expect(ctl.state()).not.toHaveProperty('verifyInvoice');
  ctl.input({type:'pin-digit',d:'3'});
  expect(ctl.pinHeld()).toBe(true);
  ctl.dispose();
});
