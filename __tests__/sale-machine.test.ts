import { CardError, stageWords, type CardConfirmation } from 'cashucard';
import { CONFIRMATION, heldPayment } from './helpers/fake-till';
import {
  amountOf,
  chargeEnabled,
  saleStep,
  SALE_START,
  STAGE_WORDS_HERE,
  type PinState,
  type SaleEvent,
  type SaleOutcome,
  type SaleState,
  type SaleStep,
  type TapState,
} from '../src/till/sale-machine';

/** The confirmation the card asks: its PIN is needed for the over-allowance payment. */
const C: CardConfirmation = { ...CONFIRMATION };
/** The confirmation that needs no PIN. */
const C0 = { ...CONFIRMATION, pinNeeded: false, pinFor: null };

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

function digits(text: string): SaleEvent[] {
  return text.split('').map((d): SaleEvent => ({ type: 'digit', d }));
}

function asTap(s: SaleState): TapState {
  if (s.kind !== 'tap') throw new Error('expected a tap');
  return s;
}

function asPin(s: SaleState): PinState {
  if (s.kind !== 'pin') throw new Error('expected a pin');
  return s;
}

function outcomeOfResult(s: SaleState): SaleOutcome {
  if (s.kind !== 'result') throw new Error('expected a result');
  return s.outcome;
}

function titleOfResult(s: SaleState): string {
  const outcome = outcomeOfResult(s);
  if (outcome.kind !== 'not-paid') throw new Error('expected a not-paid result');
  return outcome.title;
}

const tap1 = run(SALE_START, ...digits('2100'), { type: 'charge' }, { type: 'opened', saleId: 's1' }).state;

describe('the sale machine', () => {
  it('the keypad takes digits, at most seven, and no leading zero', () => {
    expect(run(SALE_START, { type: 'digit', d: '0' }).state).toBe(SALE_START);
    const seven = run(SALE_START, ...digits('1234567')).state;
    expect(seven).toEqual({ kind: 'keypad', digits: '1234567' });
    expect(run(seven, { type: 'digit', d: '8' }).state).toBe(seven);
    expect(run(seven, { type: 'digit', d: 'x' }).state).toBe(seven);
    expect(run(seven, { type: 'digit', d: '12' }).state).toBe(seven);
    const six = run(seven, { type: 'key-back' }).state;
    expect(six).toEqual({ kind: 'keypad', digits: '123456' });
    expect(run(six, { type: 'key-clear' }).state).toEqual({ kind: 'keypad', digits: '' });
  });

  it('charge opens a sale of 1 to 1,000,000 sats', () => {
    expect(run(SALE_START, { type: 'charge' }).state).toBe(SALE_START);
    const most = run(SALE_START, ...digits('1000000'), { type: 'charge' });
    expect(most.state).toEqual({ kind: 'opening', sats: 1000000 });
    expect(most.effect).toEqual({ kind: 'open-sale', sats: 1000000 });
    const over = run(SALE_START, ...digits('1000001')).state;
    const overCharged = run(over, { type: 'charge' });
    expect(overCharged.state).toBe(over);
    expect(overCharged.effect).toBeNull();
    expect(chargeEnabled('1')).toBe(true);
    expect(amountOf('')).toBe(0);
  });

  it('the opened sale asks for a card', () => {
    const step = run({ kind: 'opening', sats: 2100 }, { type: 'opened', saleId: 's1' });
    expect(step.state).toEqual({ kind: 'tap', sats: 2100, saleId: 's1', tap: 1, card: false, words: null, ending: null });
    expect(step.effect).toEqual({ kind: 'take', saleId: 's1' });
  });

  it('a sale that did not open is not paid', () => {
    const step = run({ kind: 'opening', sats: 2100 }, { type: 'open-failed', error: new Error('x') });
    expect(step.effect).toBeNull();
    expect(step.state.kind).toBe('result');
    if (step.state.kind !== 'result') throw new Error('expected a result');
    expect(step.state.saleId).toBeNull();
    expect(step.state.outcome.kind).toBe('not-paid');
    if (step.state.outcome.kind === 'not-paid') expect(step.state.outcome.title).toBe('Something went wrong');
  });

  it('whether a card is in the field comes from the transport', () => {
    const t1 = asTap(tap1);
    const reading = run(t1, { type: 'stage', stage: 'reading', words: stageWords('reading') });
    const shown = asTap(reading.state);
    expect(shown.words).toEqual(stageWords('reading'));
    expect(shown.card).toBe(false);
    const here = run(shown, { type: 'card-here' });
    expect(asTap(here.state).card).toBe(true);
    const gone = run(here.state, { type: 'card-wait' });
    expect(asTap(gone.state).card).toBe(false);
  });

  it('the stages show as the library reports them, but never NOT PAID or PAID during a tap', () => {
    const t1 = asTap(tap1);
    const signing = stageWords('signing', { seconds: 2 });
    const shown = run(t1, { type: 'stage', stage: 'signing', words: signing });
    expect(asTap(shown.state).words).toEqual(signing);
    const failed = run(shown.state, { type: 'stage', stage: 'failed', words: stageWords('failed') });
    expect(failed.state).toBe(shown.state);
    const paid = run(shown.state, { type: 'stage', stage: 'paid', words: stageWords('paid') });
    expect(paid.state).toBe(shown.state);
    const pin = run(shown.state, { type: 'stage', stage: 'pin', words: stageWords('pin') });
    expect(pin.state).toBe(shown.state);
    const confirming = run(shown.state, { type: 'stage', stage: 'confirming', words: stageWords('confirming') });
    expect(asTap(confirming.state).words).toEqual(STAGE_WORDS_HERE.confirming);
    const remove = run(confirming.state, { type: 'stage', stage: 'remove', words: stageWords('remove') });
    expect(asTap(remove.state).words).toEqual(STAGE_WORDS_HERE.remove);
  });

  it('cancel and the card wait stop only a tap with no card', () => {
    const t1 = asTap(tap1);
    const cancelled = run(t1, { type: 'cancel' });
    expect(cancelled.state).toEqual({ kind: 'stopping', sats: t1.sats, saleId: t1.saleId, ending: 'cancel' });
    expect(cancelled.effect).toEqual({ kind: 'stop' });
    const timedOut = run(t1, { type: 'timeout' });
    expect(timedOut.state).toEqual({ kind: 'stopping', sats: t1.sats, saleId: t1.saleId, ending: 'timeout' });
    expect(timedOut.effect).toEqual({ kind: 'stop' });
    const withCard = run(t1, { type: 'card-here' }).state;
    const afterCancel = run(withCard, { type: 'cancel' });
    expect(afterCancel.state).toBe(withCard);
    expect(afterCancel.effect).toBeNull();
    const afterTimeout = run(afterCancel.state, { type: 'timeout' });
    expect(afterTimeout.state).toBe(withCard);
    expect(afterTimeout.effect).toBeNull();
  });

  it('the sheet, then pay with no PIN, is tap 2', () => {
    const t1 = asTap(tap1);
    const sheet = run(t1, { type: 'confirm-asked', c: C0 });
    expect(sheet.state).toEqual({ kind: 'confirm', sats: t1.sats, saleId: t1.saleId, c: C0 });
    const paid = run(sheet.state, { type: 'pay' });
    expect(paid.state).toEqual({ kind: 'tap', sats: t1.sats, saleId: t1.saleId, tap: 2, card: false, words: null, ending: null });
    expect(paid.effect).toEqual({ kind: 'answer-confirm', pay: true, pin: false });
  });

  it('pay with a PIN needed opens the PIN pad, and OK waits for four digits', () => {
    const t1 = asTap(tap1);
    const sheet = run(t1, { type: 'confirm-asked', c: C });
    const pin = run(sheet.state, { type: 'pay' });
    expect(pin.state).toEqual({
      kind: 'pin',
      sats: t1.sats,
      saleId: t1.saleId,
      count: 0,
      why: 'allowance',
      wrong: false,
      tries: null,
      from: 'confirm',
      back: null,
    });
    expect(pin.effect).toBeNull();
    const three = run(pin.state, { type: 'pin-key' }, { type: 'pin-key' }, { type: 'pin-key' });
    const early = run(three.state, { type: 'pin-ok' });
    expect(early.state).toBe(three.state);
    expect(early.effect).toBeNull();
    const four = run(three.state, { type: 'pin-key' });
    const ok = run(four.state, { type: 'pin-ok' });
    expect(ok.state).toEqual({ kind: 'tap', sats: t1.sats, saleId: t1.saleId, tap: 2, card: false, words: null, ending: null });
    expect(ok.effect).toEqual({ kind: 'answer-confirm', pay: true, pin: true });
  });

  it('the PIN pad counts digits and never more than eight', () => {
    const t1 = asTap(tap1);
    const pin = asPin(run(run(t1, { type: 'confirm-asked', c: C }).state, { type: 'pay' }).state);
    let s: SaleState = pin;
    for (let i = 0; i < 13; i += 1) s = run(s, { type: 'pin-key' }).state;
    expect(asPin(s).count).toBe(8);
    expect(asPin(run(s, { type: 'pin-back' }).state).count).toBe(7);
    expect(run(pin, { type: 'pin-back' }).state).toBe(pin);
  });

  it('saying no at the sheet or the PIN pad takes nothing', () => {
    const t1 = asTap(tap1);
    const sheet = run(t1, { type: 'confirm-asked', c: C }).state;
    const declined = run(sheet, { type: 'decline' });
    expect(declined.state).toEqual({ kind: 'stopping', sats: t1.sats, saleId: t1.saleId, ending: 'sheet-no' });
    expect(declined.effect).toEqual({ kind: 'answer-confirm', pay: false, pin: false });
    const pin = run(sheet, { type: 'pay' }).state;
    const pinCancel = run(pin, { type: 'pin-cancel' });
    expect(pinCancel.state).toEqual({ kind: 'stopping', sats: t1.sats, saleId: t1.saleId, ending: 'pin-cancel' });
    expect(pinCancel.effect).toEqual({ kind: 'answer-confirm', pay: false, pin: false });
    const sheetTimeout = run(sheet, { type: 'timeout' });
    expect(sheetTimeout.state).toEqual({ kind: 'stopping', sats: t1.sats, saleId: t1.saleId, ending: 'sheet-timeout' });
    expect(sheetTimeout.effect).toEqual({ kind: 'answer-confirm', pay: false, pin: false });
    const pinTimeout = run(pin, { type: 'timeout' });
    expect(pinTimeout.state).toEqual({ kind: 'stopping', sats: t1.sats, saleId: t1.saleId, ending: 'pin-timeout' });
    expect(pinTimeout.effect).toEqual({ kind: 'answer-confirm', pay: false, pin: false });
  });

  it('a PIN the library asks for goes back to the tap it came from', () => {
    const tap2 = run(tap1, { type: 'confirm-asked', c: C0 }, { type: 'pay' }, { type: 'card-here' }).state;
    const asked = run(tap2, { type: 'pin-asked', why: 'allowance', wrong: true, tries: 2 });
    expect(asked.state).toEqual({
      kind: 'pin',
      sats: 2100,
      saleId: 's1',
      count: 0,
      why: 'allowance',
      wrong: true,
      tries: 2,
      from: 'ask',
      back: tap2,
    });
    expect(asked.effect).toBeNull();
    const pin = asPin(asked.state);
    const ok = run(pin, { type: 'pin-key' }, { type: 'pin-key' }, { type: 'pin-key' }, { type: 'pin-key' }, { type: 'pin-ok' });
    expect(ok.state).toBe(tap2);
    expect(ok.effect).toEqual({ kind: 'answer-pin', give: true });
    const cancelled = run(pin, { type: 'pin-cancel' });
    expect(cancelled.state).toEqual({ ...asTap(tap2), ending: 'pin-cancel' });
    expect(cancelled.effect).toEqual({ kind: 'answer-pin', give: false });
  });

  it('an ask the screen cannot answer is answered no at once', () => {
    const asked = run(SALE_START, { type: 'confirm-asked', c: C });
    expect(asked.state).toBe(SALE_START);
    expect(asked.effect).toEqual({ kind: 'answer-confirm', pay: false, pin: false });
    const stopping: SaleState = { kind: 'stopping', sats: 2100, saleId: 's1', ending: 'cancel' };
    const askedPin = run(stopping, { type: 'pin-asked', why: 'allowance', wrong: false, tries: null });
    expect(askedPin.state).toBe(stopping);
    expect(askedPin.effect).toEqual({ kind: 'answer-pin', give: false });
  });

  it('PAID only for a held payment', () => {
    const t1 = asTap(tap1);
    const paid = run(t1, { type: 'done', payment: heldPayment('s1') });
    expect(outcomeOfResult(paid.state)).toEqual({ kind: 'paid', payment: heldPayment('s1') });
    const checking = run(t1, { type: 'done', payment: { ...heldPayment('s1'), state: 'taking', why: 'swap-waiting' } });
    expect(outcomeOfResult(checking.state)).toEqual({ kind: 'checking', paymentId: 'pay:00', message: '' });
    const twice = run(t1, { type: 'done', payment: { ...heldPayment('s1'), extra: 'paid-twice' } });
    expect(outcomeOfResult(twice.state)).toEqual({ kind: 'already-paid', extra: 'paid-twice', message: '' });
  });

  it('a signed error is never NOT PAID', () => {
    const t1 = asTap(tap1);
    const interrupted = run(t1, { type: 'failed', error: new CardError('interrupted', 'm.', { signed: true }) });
    expect(outcomeOfResult(interrupted.state).kind).toBe('tap-again');
    const lost = run(t1, { type: 'failed', error: new CardError('payment-lost', 'NOT PAID: m.', { signed: true }) });
    const outcome = outcomeOfResult(lost.state);
    expect(outcome.kind).toBe('not-paid-yet');
    if (outcome.kind === 'not-paid-yet') expect(outcome.message).toBe('M.');
  });

  it("the merchant's own ending names the result", () => {
    const cancelled: SaleState = { kind: 'stopping', sats: 2100, saleId: 's1', ending: 'cancel' };
    const timedOut: SaleState = { kind: 'stopping', sats: 2100, saleId: 's1', ending: 'timeout' };
    const plain: SaleState = { kind: 'stopping', sats: 2100, saleId: 's1', ending: null };
    const byMerchant = run(cancelled, { type: 'failed', error: new CardError('stopped', 'Stopped.') });
    const byTime = run(timedOut, { type: 'failed', error: new CardError('stopped', 'Stopped.') });
    const declined = run(plain, { type: 'failed', error: new CardError('declined', 'No.') });
    const wrongPin = run(cancelled, { type: 'failed', error: new CardError('wrong-pin', 'Wrong.') });
    expect(titleOfResult(byMerchant.state)).toBe('Cancelled');
    expect(titleOfResult(byTime.state)).toBe('Time ran out');
    expect(titleOfResult(declined.state)).toBe('Not paid');
    expect(titleOfResult(wrongPin.state)).toBe('Wrong PIN');
  });

  it('a result ignores the transport', () => {
    const result = run(tap1, { type: 'done', payment: heldPayment('s1') }).state;
    const after = run(result, { type: 'card-wait' });
    expect(after.state).toBe(result);
    expect(after.effect).toBeNull();
  });

  it('nothing given is changed', () => {
    const opening: SaleState = { kind: 'opening', sats: 2100 };
    const sheet = run(tap1, { type: 'confirm-asked', c: C }).state;
    const pin = run(sheet, { type: 'pay' }).state;
    const stopping: SaleState = { kind: 'stopping', sats: 2100, saleId: 's1', ending: 'cancel' };
    const result = run(tap1, { type: 'failed', error: new CardError('declined', 'No.') }).state;
    const flows: Array<[SaleState, SaleEvent[]]> = [
      [SALE_START, [...digits('2100'), { type: 'charge' }]],
      [opening, [{ type: 'opened', saleId: 's1' }]],
      [tap1, [{ type: 'card-here' }, { type: 'stage', stage: 'reading', words: stageWords('reading') }, { type: 'cancel' }]],
      [sheet, [{ type: 'pay' }]],
      [pin, [{ type: 'pin-key' }, { type: 'pin-back' }, { type: 'timeout' }]],
      [stopping, [{ type: 'failed', error: new CardError('stopped', 'Stopped.') }]],
      [result, [{ type: 'card-wait' }, { type: 'retry' }]],
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
