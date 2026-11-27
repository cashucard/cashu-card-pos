import { CardError } from 'cashucard';
import { CONFIRMATION, heldPayment } from './helpers/fake-till';
import {
  amountOf,
  saleBackAllowed,
  saleStep,
  saleSummary,
  SALE_START,
  timerFor,
  type PinState,
  type SaleEvent,
  type SaleOutcome,
  type SaleReport,
  type SaleState,
  type SaleStep,
  type TapState,
} from '../src/till/sale-machine';

/** The result of a sale of 2,100 sats, on `saleId` unless it did not open. */
function result(outcome: SaleOutcome, saleId: string | null = 's1'): SaleState {
  return { kind: 'result', sats: 2100, saleId, outcome, note: null };
}

const TAP: SaleOutcome = { kind: 'tap-again', message: 'm.' };
const CHECK: SaleOutcome = { kind: 'checking', paymentId: 'pay:00', message: '' };
const YET: SaleOutcome = { kind: 'not-paid-yet', message: 'y.' };
const NOT: SaleOutcome = { kind: 'not-paid', errorKind: 'not-enough', title: 'Not enough on the card', message: 'n.' };
const UNFINISHED: SaleOutcome = { kind: 'unfinished', message: 'u.' };
const PAID: SaleOutcome = { kind: 'paid', payment: heldPayment('s1') };
const ALREADY: SaleOutcome = { kind: 'already-paid', extra: 'paid-twice', message: '' };
const STOP: SaleOutcome = { kind: 'stop', message: 's.' };
const WITHDRAWN: SaleOutcome = { kind: 'withdrawn', paidBefore: [] };

const tap1: TapState = { kind: 'tap', sats: 2100, saleId: 's1', tap: 1, card: false, words: null, ending: null };
const tap2: TapState = { ...tap1, tap: 2 };
const tapCard: TapState = { ...tap1, card: true };
const sheet: SaleState = { kind: 'confirm', sats: 2100, saleId: 's1', c: CONFIRMATION };
const pin: PinState = {
  kind: 'pin', sats: 2100, saleId: 's1', count: 4, why: 'allowance', wrong: true, tries: null, from: 'confirm', back: null,
};
const stopping: SaleState = { kind: 'stopping', sats: 2100, saleId: 's1', ending: 'cancel' };
const opening: SaleState = { kind: 'opening', sats: 2100 };

/** Steps through every event, answering the last step. A change of the given state fails the test. */
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

function digits(text: string): SaleEvent[] {
  return text.split('').map((d): SaleEvent => ({ type: 'digit', d }));
}

function outcomeOf(s: SaleState): SaleOutcome {
  if (s.kind !== 'result') throw new Error('expected a result');
  return s.outcome;
}

const asked: SaleState = run(result(TAP), { type: 'other-way' }).state;
const withdrawing: SaleState = run(asked, { type: 'withdraw-yes' }).state;

/** Every state this file builds, for the report's keys. */
const everyState: SaleState[] = [
  SALE_START,
  opening,
  tap1,
  tap2,
  tapCard,
  sheet,
  pin,
  stopping,
  result(TAP),
  result(CHECK),
  result(YET),
  result(NOT),
  result(PAID),
  result(ALREADY),
  result(UNFINISHED),
  result(STOP),
  result(WITHDRAWN),
  result(NOT, null),
  asked,
  withdrawing,
];

/** The report's ten fields, named once so the compiler refuses a missing or an extra one. */
const REPORT_FIELDS: Readonly<Record<keyof SaleReport, true>> = {
  step: true,
  sats: true,
  tap: true,
  card: true,
  pinWhy: true,
  pinWrong: true,
  outcome: true,
  errorKind: true,
  title: true,
  paid: true,
};

describe('the sale results', () => {
  it('try again takes the same sale again', () => {
    const step = run(result(TAP), { type: 'retry' });
    expect(step.state).toEqual({
      kind: 'tap', sats: 2100, saleId: 's1', tap: 1, card: false, words: null, ending: null, signedBefore: true,
    });
    expect(step.effect).toEqual({ kind: 'take', saleId: 's1' });
    for (const o of [UNFINISHED, NOT]) {
      const again = run(result(o), { type: 'retry' });
      expect(again.state).toEqual({ kind: 'tap', sats: 2100, saleId: 's1', tap: 1, card: false, words: null, ending: null });
      expect(again.effect).toEqual({ kind: 'take', saleId: 's1' });
    }
  });

  it('try again after a sale that did not open opens one', () => {
    const step = run(result(NOT, null), { type: 'retry' });
    expect(step.state).toEqual({ kind: 'opening', sats: 2100 });
    expect(step.effect).toEqual({ kind: 'open-sale', sats: 2100 });
  });

  it('nothing is tried again on a result that took the money', () => {
    for (const o of [PAID, CHECK, ALREADY, WITHDRAWN, STOP]) {
      const s = result(o);
      const step = run(s, { type: 'retry' });
      expect(step.state).toBe(s);
      expect(step.effect).toBeNull();
    }
  });

  it('the customer paid another way: withdraw is asked first', () => {
    const ask = run(result(TAP), { type: 'other-way' });
    expect(ask.state).toEqual({ kind: 'result', sats: 2100, saleId: 's1', outcome: { kind: 'withdraw-asked', back: TAP }, note: null });
    expect(ask.effect).toBeNull();
    const no = run(ask.state, { type: 'withdraw-no' });
    expect(outcomeOf(no.state)).toBe(TAP);
    expect(no.effect).toBeNull();
    const yes = run(ask.state, { type: 'withdraw-yes' });
    expect(outcomeOf(yes.state)).toEqual({ kind: 'withdrawing', back: TAP });
    expect(yes.effect).toEqual({ kind: 'withdraw', saleId: 's1' });
  });

  it('withdraw is offered on checking and not paid yet too, never on a sale that took nothing or was paid', () => {
    for (const o of [CHECK, YET]) {
      const ask = run(result(o), { type: 'other-way' });
      expect(outcomeOf(ask.state)).toEqual({ kind: 'withdraw-asked', back: o });
      expect(ask.effect).toBeNull();
    }
    for (const o of [NOT, PAID, UNFINISHED]) {
      const s = result(o);
      const ask = run(s, { type: 'other-way' });
      expect(ask.state).toBe(s);
      expect(ask.effect).toBeNull();
    }
  });

  it('a withdrawn sale says when a payment was already taken', () => {
    const taking = run(withdrawing, { type: 'withdrawn', others: [{ ...heldPayment('s1'), state: 'taking' }] });
    expect(outcomeOf(taking.state)).toEqual({ kind: 'withdrawn', paidBefore: [] });
    const held = heldPayment('s1');
    const taken = run(withdrawing, { type: 'withdrawn', others: [held] });
    const outcome = outcomeOf(taken.state);
    expect(outcome).toEqual({ kind: 'withdrawn', paidBefore: [held] });
    if (outcome.kind !== 'withdrawn') throw new Error('expected a withdrawn result');
    expect(outcome.paidBefore).toContain(held);
    const late = run(withdrawing, { type: 'withdrawn', others: [{ ...heldPayment('s1'), extra: 'late' }] });
    expect(outcomeOf(late.state)).toEqual({ kind: 'withdrawn', paidBefore: [] });
  });

  it('a withdraw that failed goes back, and says so', () => {
    const back = run(withdrawing, { type: 'withdraw-failed', error: new CardError('mint', 'The mint did not answer.') });
    expect(outcomeOf(back.state)).toBe(TAP);
    expect(back.state).toEqual({
      kind: 'result',
      sats: 2100,
      saleId: 's1',
      outcome: TAP,
      note: 'The sale was not withdrawn: The mint did not answer.',
    });
    expect(back.effect).toBeNull();
    const stopped = run(withdrawing, { type: 'withdraw-failed', error: new CardError('journal', 'The journal could not be written.') });
    expect(outcomeOf(stopped.state)).toEqual({ kind: 'stop', message: 'The journal could not be written.' });
    expect(stopped.effect).toBeNull();
  });

  it('a new sale only from a result that is finished', () => {
    for (const o of [PAID, CHECK, ALREADY, UNFINISHED, NOT, YET, WITHDRAWN]) {
      const step = run(result(o), { type: 'new' });
      expect(step.state).toBe(SALE_START);
      expect(step.effect).toBeNull();
    }
    for (const s of [result(TAP), result(STOP), asked, withdrawing]) {
      const step = run(s, { type: 'new' });
      expect(step.state).toBe(s);
      expect(step.effect).toBeNull();
    }
  });

  it('checking turns PAID only when its own payment is held', () => {
    const step = run(result(CHECK), { type: 'settled', payment: heldPayment('s1') });
    expect(outcomeOf(step.state)).toEqual({ kind: 'paid', payment: heldPayment('s1') });
    expect(step.effect).toBeNull();
    const other = { ...heldPayment('s1'), paymentId: 'pay:01' };
    const checking = result(CHECK);
    const wrongSale = run(checking, { type: 'settled', payment: other });
    expect(wrongSale.state).toBe(checking);
    const taking = run(result(CHECK), { type: 'settled', payment: { ...heldPayment('s1'), state: 'taking' } });
    expect(outcomeOf(taking.state)).toEqual(CHECK);
    const twice = run(result(CHECK), { type: 'settled', payment: { ...heldPayment('s1'), extra: 'paid-twice' } });
    expect(outcomeOf(twice.state)).toEqual(CHECK);
  });

  it('a result ignores the library', () => {
    const s = result(TAP);
    const done = run(s, { type: 'done', payment: heldPayment('s1') });
    expect(done.state).toBe(s);
    expect(done.effect).toBeNull();
    const failed = run(s, { type: 'failed', error: new CardError('declined', 'No.') });
    expect(failed.state).toBe(s);
    expect(failed.effect).toBeNull();
  });

  it('the waits', () => {
    expect(timerFor(tap1)).toEqual({ key: 'card-1', ms: 30000 });
    expect(timerFor(tap2)).toEqual({ key: 'card-2', ms: 30000 });
    expect(timerFor(tapCard)).toBeNull();
    expect(timerFor(sheet)).toEqual({ key: 'confirm', ms: 120000 });
    expect(timerFor({ ...pin, count: 3 })).toEqual({ key: 'pin-3', ms: 60000 });
    for (const s of [SALE_START, opening, stopping, result(TAP)]) expect(timerFor(s)).toBeNull();
  });

  it("Android's back leaves only when nothing is pending", () => {
    const pending: SaleState[] = [
      SALE_START, result(PAID), result(CHECK), result(ALREADY), result(UNFINISHED), result(NOT), result(YET), result(WITHDRAWN),
    ];
    for (const s of pending) expect(saleBackAllowed(s)).toBe(true);
    const held: SaleState[] = [opening, tap1, sheet, pin, stopping, result(TAP), result(STOP), asked, withdrawing];
    for (const s of held) expect(saleBackAllowed(s)).toBe(false);
  });

  it('the report says where the sale is and never the PIN', () => {
    const report = saleSummary(pin);
    expect(report).toEqual({
      step: 'pin',
      sats: 2100,
      tap: null,
      card: null,
      pinWhy: 'allowance',
      pinWrong: true,
      outcome: null,
      errorKind: null,
      title: null,
      paid: null,
    });
    expect(JSON.stringify(report)).not.toContain('4');
    const notPaid = saleSummary(result(NOT));
    expect(notPaid.step).toBe('result');
    expect(notPaid.outcome).toBe('not-paid');
    expect(notPaid.errorKind).toBe('not-enough');
    expect(notPaid.title).toBe('Not enough on the card');
    const paid = saleSummary(result(PAID));
    expect(paid.outcome).toBe('paid');
    expect(paid.paid).toEqual({ state: 'held', amount: 14, fee: 1 });
    const keypad = saleSummary({ kind: 'keypad', digits: '2100' });
    expect(keypad.step).toBe('keypad');
    expect(keypad.sats).toBe(2100);
    expect(keypad.sats).toBe(amountOf('2100'));
    const fields = Object.keys(REPORT_FIELDS).sort();
    expect(fields).toHaveLength(10);
    for (const s of everyState) expect(Object.keys(saleSummary(s)).sort()).toEqual(fields);
  });

  it('nothing given is changed', () => {
    const flows: Array<[SaleState, SaleEvent[]]> = [
      [SALE_START, [...digits('2100'), { type: 'charge' }]],
      [opening, [{ type: 'opened', saleId: 's1' }]],
      [tap1, [{ type: 'card-here' }, { type: 'cancel' }, { type: 'timeout' }]],
      [sheet, [{ type: 'pay' }]],
      [pin, [{ type: 'pin-key' }, { type: 'pin-back' }, { type: 'timeout' }]],
      [stopping, [{ type: 'failed', error: new CardError('stopped', 'Stopped.') }]],
      [result(TAP), [{ type: 'card-wait' }, { type: 'retry' }]],
      [result(NOT, null), [{ type: 'retry' }]],
      [result(CHECK), [{ type: 'settled', payment: heldPayment('s1') }]],
      [result(TAP), [{ type: 'other-way' }, { type: 'withdraw-no' }]],
      [asked, [{ type: 'withdraw-yes' }]],
      [withdrawing, [{ type: 'withdrawn', others: [heldPayment('s1')] }]],
      [withdrawing, [{ type: 'withdraw-failed', error: new CardError('mint', 'm.') }]],
      [result(NOT), [{ type: 'new' }]],
    ];
    for (const [start, events] of flows) {
      let s = start;
      for (const e of events) {
        const before = JSON.stringify(s);
        const step = saleStep(s, e);
        expect(JSON.stringify(s)).toBe(before);
        s = step.state;
      }
    }
  });
});

