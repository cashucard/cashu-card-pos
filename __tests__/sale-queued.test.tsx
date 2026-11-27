/* A sale or a tap asked while a settle runs waits for it and says so; the card's wait starts only when the card is asked
 * for. The machine's `queued` flag, the controller's look at the queue, and the panels' words. */

import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { CardListener, CardTransport, Payment } from 'cashucard';
import { createSaleController, type SaleControllerDeps, type Timers } from '../src/till/sale-controller';
import type { TillQueue } from '../src/till/queue';
import type { CardReader } from '../src/till/reader';
import {
  OPEN_CANCELLED,
  SALE_START,
  saleStep,
  saleSummary,
  timerFor,
  type SaleEvent,
  type SaleState,
  type SaleStep,
  type TapState,
} from '../src/till/sale-machine';
import { OpeningPanel, TapPanel } from '../src/screens/SalePanels';
import { allText, has, press, textOf } from './helpers/render';

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

/** Steps through every event, answering the last step. A copy of each given state is kept to prove nothing was changed. */
function run(s: SaleState, ...events: SaleEvent[]): SaleStep {
  let state = s;
  let step: SaleStep = { state, effect: null };
  for (const e of events) {
    const before = JSON.stringify(state);
    step = saleStep(state, e);
    expect(JSON.stringify(state)).toBe(before);
    state = step.state;
  }
  return step;
}

function asTap(s: SaleState): TapState {
  if (s.kind !== 'tap') throw new Error('expected a tap');
  return s;
}

const tap1 = run(
  SALE_START,
  { type: 'digit', d: '2' },
  { type: 'digit', d: '1' },
  { type: 'digit', d: '0' },
  { type: 'digit', d: '0' },
  { type: 'charge' },
  { type: 'opened', saleId: 's1' },
).state;

describe('the sale machine', () => {
  it('a tap behind other work says so, and its card wait does not run', () => {
    const q = saleStep(tap1, { type: 'queued' });
    expect(q.state).toMatchObject({ kind: 'tap', queued: true });
    expect(q.effect).toBeNull();
    expect(timerFor(q.state)).toBeNull();
    const w = saleStep(q.state, { type: 'card-wait' });
    expect('queued' in w.state).toBe(false);
    const wt = asTap(w.state);
    expect(wt.card).toBe(false);
    expect(wt.tap).toBe(1);
    expect(timerFor(w.state)).toEqual({ key: 'card-1', ms: 30000 });
  });

  it('queued changes nothing with a card in the field, or outside a tap', () => {
    const withCard = saleStep(tap1, { type: 'card-here' }).state;
    expect(saleStep(withCard, { type: 'queued' }).state).toBe(withCard);
    expect(saleStep(SALE_START, { type: 'queued' }).state).toBe(SALE_START);
    const q = saleStep(tap1, { type: 'queued' }).state;
    expect(saleStep(q, { type: 'queued' }).state).toBe(q);
    const result: SaleState = {
      kind: 'result',
      sats: 2100,
      saleId: 's1',
      outcome: { kind: 'not-paid', errorKind: 'stopped', title: 'Cancelled', message: OPEN_CANCELLED },
      note: null,
    };
    expect(saleStep(result, { type: 'queued' }).state).toBe(result);
  });

  it('Cancel still stops a queued tap, and nothing is taken', () => {
    const q = saleStep(tap1, { type: 'queued' }).state;
    const c = saleStep(q, { type: 'cancel' });
    expect(c.state).toMatchObject({ kind: 'stopping', ending: 'cancel' });
    expect(c.effect).toEqual({ kind: 'stop' });
  });

  it('a queued tap of a sale the card may have signed for still remembers it', () => {
    const t = { ...asTap(tap1), signedBefore: true as const };
    const q = saleStep(t, { type: 'queued' }).state;
    const w = saleStep(q, { type: 'card-wait' }).state;
    expect(w).toEqual(t);
    expect('queued' in w).toBe(false);
    const c = saleStep(q, { type: 'cancel' });
    expect(c.state).toMatchObject({ kind: 'stopping', ending: 'cancel', signedBefore: true });
    const failed = saleStep(c.state, { type: 'failed', error: new Error('x') }).state;
    if (failed.kind !== 'result') throw new Error('expected a result');
    expect(failed.outcome.kind).toBe('tap-again');
  });

  it('an opening behind other work says so, and opens as before', () => {
    const o = run(SALE_START, { type: 'digit', d: '1' }, { type: 'digit', d: '4' }, { type: 'charge' }).state;
    expect(o).toMatchObject({ kind: 'opening', sats: 14 });
    const q = saleStep(o, { type: 'queued' });
    expect(q.state).toMatchObject({ kind: 'opening', sats: 14, queued: true });
    expect(q.effect).toBeNull();
    expect(saleStep(q.state, { type: 'queued' }).state).toBe(q.state);
    const opened = saleStep(q.state, { type: 'opened', saleId: 's2' });
    expect('queued' in opened.state).toBe(false);
    expect(opened.state).toMatchObject({ kind: 'tap', saleId: 's2', sats: 14, tap: 1 });
    expect(opened.effect).toEqual({ kind: 'take', saleId: 's2' });
    const cancelled = saleStep(q.state, { type: 'cancel' });
    expect(cancelled.state).toEqual({
      kind: 'result',
      sats: 14,
      saleId: null,
      outcome: { kind: 'not-paid', errorKind: 'stopped', title: 'Cancelled', message: OPEN_CANCELLED },
      note: null,
    });
    expect(cancelled.effect).toBeNull();
    expect(timerFor(q.state)).toBeNull();
  });

  it('the report says nothing of it', () => {
    const q = saleStep(tap1, { type: 'queued' }).state;
    expect(Object.keys(saleSummary(q)).sort()).toEqual(Object.keys(saleSummary(tap1)).sort());
  });
});

/** What a fake queue says: `kind` running, `waiting` jobs waiting. */
function queueOf(kind: TillQueue['running'] extends () => infer R ? R : never, waiting: number): Pick<TillQueue, 'running' | 'waiting'> {
  return { running: () => kind, waiting: () => waiting };
}

type Script = (t: CardTransport, l: CardListener, id: string) => Promise<Payment>;

/** The till's three sale calls over a card script, as the controller needs them. */
function serviceOver(script: Script): SaleControllerDeps['service'] {
  return {
    openSale: jest.fn(async (_sats: number): Promise<string> => 's1'),
    takeCard: jest.fn((id: string, t: CardTransport, l: CardListener): Promise<Payment> => script(t, l, id)),
    withdrawSale: jest.fn(async (_saleId: string): Promise<Payment[]> => []),
  };
}

function start(
  service: SaleControllerDeps['service'],
  r: CardReader,
  queue?: Pick<TillQueue, 'running' | 'waiting'>,
) {
  const timers = fakeTimers();
  const ctl = createSaleController({ service, queue, reader: r, onState: () => undefined, timers: timers.timers });
  return { ctl, timers };
}

function make(script: Script, r: CardReader, queue?: Pick<TillQueue, 'running' | 'waiting'>) {
  const service = serviceOver(script);
  return { service, ...start(service, r, queue) };
}

function charge(ctl: ReturnType<typeof createSaleController>): void {
  for (const d of ['2', '1', '0', '0']) ctl.input({ type: 'digit', d });
  ctl.input({ type: 'charge' });
}

describe('the sale controller', () => {
  it('a take asked behind another job is shown as waiting for it', async () => {
    const g = deferred<void>();
    const { ctl, timers } = make(
      async (t) => {
        await g.promise;
        await t.begin?.('1');
        return never<Payment>();
      },
      reader(gateTransport().t),
      queueOf('settle', 1),
    );
    charge(ctl);
    await flush();
    expect(ctl.state()).toMatchObject({ kind: 'tap', queued: true });
    expect(timers.live()).toEqual([]);
    g.resolve(undefined);
    await flush();
    const s = ctl.state();
    expect('queued' in s).toBe(false);
    const tap = asTap(s);
    expect(tap.card).toBe(false);
    expect(timers.live()).toEqual([{ ms: 30000 }]);
  });

  it('a job waiting ahead counts too; an idle queue does not', async () => {
    const script = async (): Promise<Payment> => never<Payment>();
    const ahead = make(script, reader(gateTransport().t), { running: () => null, waiting: () => 2 });
    charge(ahead.ctl);
    await flush();
    expect(ahead.ctl.state()).toMatchObject({ kind: 'tap', queued: true });

    const one = make(script, reader(gateTransport().t), { running: () => null, waiting: () => 1 });
    charge(one.ctl);
    await flush();
    expect(one.ctl.state().kind).toBe('tap');
    expect('queued' in one.ctl.state()).toBe(false);

    const none = make(script, reader(gateTransport().t));
    charge(none.ctl);
    await flush();
    expect(none.ctl.state().kind).toBe('tap');
    expect('queued' in none.ctl.state()).toBe(false);
  });

  it('Cancel while queued stops the take', async () => {
    const seen: { signal?: AbortSignal } = {};
    const { ctl } = make(
      async (_t, l) => {
        seen.signal = l.signal;
        return never<Payment>();
      },
      reader(gateTransport().t),
      queueOf('settle', 1),
    );
    charge(ctl);
    await flush();
    expect(ctl.state()).toMatchObject({ kind: 'tap', queued: true });
    ctl.input({ type: 'cancel' });
    expect(ctl.state()).toMatchObject({ kind: 'stopping', ending: 'cancel' });
    expect(seen.signal?.aborted).toBe(true);
    await flush();
    const s = ctl.state();
    if (s.kind !== 'result') throw new Error('expected a result');
    expect(s.outcome).toMatchObject({ kind: 'not-paid', title: 'Cancelled' });
  });

  it('a sale opened behind another job is shown as waiting, then asks for the card', async () => {
    const gOpen = deferred<string>();
    const service: SaleControllerDeps['service'] = {
      openSale: jest.fn((_sats: number): Promise<string> => gOpen.promise),
      takeCard: jest.fn((_id: string, _t: CardTransport, _l: CardListener): Promise<Payment> => never<Payment>()),
      withdrawSale: jest.fn(async (_saleId: string): Promise<Payment[]> => []),
    };
    const { ctl } = start(service, reader(gateTransport().t), queueOf('settle', 1));
    charge(ctl);
    expect(ctl.state()).toMatchObject({ kind: 'opening', sats: 2100, queued: true });
    gOpen.resolve('s1');
    await flush();
    expect(ctl.state().kind).toBe('tap');
    expect(ctl.state()).toMatchObject({ kind: 'tap', saleId: 's1', queued: true });
  });
});

/** Every tree made in this file, for the last test's sweep of the words. */
const created: ReactTestRenderer[] = [];

function render(el: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(el);
  });
  created.push(tree);
  return tree;
}

describe('the sale panels', () => {
  it('a queued tap says the till is busy, and can be cancelled', async () => {
    const send = jest.fn();
    const tree = render(<TapPanel state={{ ...asTap(tap1), queued: true }} send={send} />);
    expect(textOf(tree, 'tap-title')).toBe('One moment');
    expect(textOf(tree, 'tap-line')).toBe(
      'The till is finishing earlier payments with the mint. Then it asks for the card.',
    );
    expect(textOf(tree, 'tap-amount')).toBe('2,100 sats');
    await press(tree, 'tap-cancel');
    expect(send).toHaveBeenLastCalledWith({ type: 'cancel' });
    const plain = render(<TapPanel state={asTap(tap1)} send={send} />);
    expect(textOf(plain, 'tap-title')).toBe('Hold card at top of iPhone');
    expect(textOf(plain, 'tap-line')).toBe('Waiting for a card');
  });

  it('a queued opening says the till is busy, and keeps its Cancel', async () => {
    const send = jest.fn();
    const tree = render(<OpeningPanel sats={14} queued send={send} />);
    expect(textOf(tree, 'sale-opening')).toBe(
      'One moment. The till is finishing earlier payments with the mint. Then it opens the sale.',
    );
    expect(has(tree, 'opening-cancel')).toBe(true);
    await press(tree, 'opening-cancel');
    expect(send).toHaveBeenLastCalledWith({ type: 'cancel' });
    const plain = render(<OpeningPanel sats={14} send={send} />);
    expect(textOf(plain, 'sale-opening')).toBe('Opening the sale.');
  });

  it('the words are plain', () => {
    render(<TapPanel state={{ ...asTap(tap1), queued: true }} send={() => undefined} />);
    render(<OpeningPanel sats={14} queued send={() => undefined} />);
    expect(created.length).toBeGreaterThan(0);
    for (const tree of created) {
      for (const line of allText(tree)) {
        expect(line.includes('—')).toBe(false);
        expect(line.includes('–')).toBe(false);
        expect(/crypto|paid back/i.test(line)).toBe(false);
      }
    }
  });
});
