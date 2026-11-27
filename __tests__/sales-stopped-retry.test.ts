/* While new sales are stopped (slice 2.4, ENG-909 b): Try again after NOT PAID counts as a new sale and is refused with
 * the till's words; Hold the card again, after TAP THE SAME CARD AGAIN or TAP AGAIN, finishes a payment already begun
 * and goes on. The rule is the sale machine's; the controller reads whether sales are stopped at the press. */

import { CardError, type CardListener, type CardTransport, type Payment } from 'cashucard';
import { errorOutcome, SALES_STOPPED, SALES_STOPPED_TITLE, SALES_STOPPED_WHY, SalesStoppedError } from '../src/till/card-errors';
import { createSaleController, type Timers } from '../src/till/sale-controller';
import { saleStep, type SaleOutcome, type SaleState } from '../src/till/sale-machine';
import type { CardReader } from '../src/till/reader';
import { fakeTransport } from './helpers/fake-till';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
};

function result(outcome: SaleOutcome, saleId: string | null = 's1'): SaleState {
  return { kind: 'result', sats: 2100, saleId, outcome, note: null };
}

const NOT_PAID: SaleOutcome = { kind: 'not-paid', errorKind: 'declined', title: 'Declined', message: 'Nothing was taken.' };
const REFUSED: SaleOutcome = { kind: 'not-paid', errorKind: 'busy', title: SALES_STOPPED_TITLE, message: SALES_STOPPED_WHY };

describe('the words', () => {
  it("are the brief's, whole on Home and in two parts under NOT PAID", () => {
    expect(SALES_STOPPED).toBe(
      "New sales are stopped. This phone did not save the record's safety counter. Payments already taken are kept and settled. Close the app and open it again; if this stays, restart the phone.",
    );
    expect(SALES_STOPPED_TITLE + '. ' + SALES_STOPPED_WHY).toBe(SALES_STOPPED);
    expect(new SalesStoppedError().message).toBe(SALES_STOPPED);
  });

  it('a sale refused at its opening is NOT PAID with them, and Try again is still offered', () => {
    expect(errorOutcome(new SalesStoppedError())).toEqual(REFUSED);
    const opened = saleStep({ kind: 'opening', sats: 2100 }, { type: 'open-failed', error: new SalesStoppedError() });
    expect(opened).toEqual({ state: result(REFUSED, null), effect: null });
  });
});

describe('the retry rule of the sale machine', () => {
  it('Try again after NOT PAID is refused with the words while new sales are stopped, and nothing is asked of the till', () => {
    expect(saleStep(result(NOT_PAID), { type: 'retry', stopped: true })).toEqual({ state: result(REFUSED), effect: null });
    expect(saleStep(result(NOT_PAID, null), { type: 'retry', stopped: true })).toEqual({ state: result(REFUSED, null), effect: null });
    // pressed again while still stopped: refused again
    expect(saleStep(result(REFUSED), { type: 'retry', stopped: true })).toEqual({ state: result(REFUSED), effect: null });
  });

  it('Try again after NOT PAID takes the card again once new sales are taken', () => {
    for (const e of [{ type: 'retry' as const }, { type: 'retry' as const, stopped: false }]) {
      expect(saleStep(result(NOT_PAID), e).effect).toEqual({ kind: 'take', saleId: 's1' });
      expect(saleStep(result(REFUSED), e).effect).toEqual({ kind: 'take', saleId: 's1' });
      expect(saleStep(result(REFUSED, null), e).effect).toEqual({ kind: 'open-sale', sats: 2100 });
    }
  });

  it('Hold the card again goes on while new sales are stopped: a payment already begun is finished', () => {
    const again: SaleOutcome[] = [
      { kind: 'tap-again', message: 'x' },
      { kind: 'unfinished', message: 'x' },
    ];
    for (const o of again) {
      const r = saleStep(result(o), { type: 'retry', stopped: true });
      expect(r.effect).toEqual({ kind: 'take', saleId: 's1' });
      expect(r.state.kind).toBe('tap');
    }
  });

  it('a sale that is over is still never taken again', () => {
    const over: SaleOutcome = { ...NOT_PAID, ended: true };
    expect(saleStep(result(over), { type: 'retry', stopped: true })).toEqual({ state: result(over), effect: null });
  });
});

describe('the controller reads whether new sales are stopped at the press', () => {
  function make(stopped: { now: boolean } | null) {
    const declined = async (_id: string, _t: CardTransport, _l: CardListener): Promise<Payment> => {
      throw new CardError('declined', 'The card refused. Nothing was taken.');
    };
    const service = {
      openSale: jest.fn(async (_sats: number): Promise<string> => 's1'),
      takeCard: jest.fn(declined),
      withdrawSale: jest.fn(async (_saleId: string): Promise<Payment[]> => []),
      ...(stopped === null ? {} : { salesStopped: () => stopped.now }),
    };
    const reader: CardReader = { kind: 'card simulator', available: async () => true, transport: () => fakeTransport() };
    const timers: Timers = { set: () => ({}), clear: () => undefined };
    const states: SaleState[] = [];
    const ctl = createSaleController({ service, reader, onState: (s) => states.push(s), timers });
    return { ctl, service };
  }

  async function notPaid(ctl: ReturnType<typeof make>['ctl']): Promise<void> {
    for (const d of ['2', '1']) ctl.input({ type: 'digit', d });
    ctl.input({ type: 'charge' });
    await flush();
    const s = ctl.state();
    expect(s.kind === 'result' && s.outcome.kind).toBe('not-paid');
  }

  it('stopped: Try again asks the till for no card, and the words are shown', async () => {
    const stopped = { now: false };
    const { ctl, service } = make(stopped);
    await notPaid(ctl);
    expect(service.takeCard).toHaveBeenCalledTimes(1);
    stopped.now = true;
    ctl.input({ type: 'retry' });
    await flush();
    expect(service.takeCard).toHaveBeenCalledTimes(1);
    expect(service.openSale).toHaveBeenCalledTimes(1);
    expect(ctl.state()).toEqual({ ...result(REFUSED), sats: 21 });
    // lifted: the same press takes the card again
    stopped.now = false;
    ctl.input({ type: 'retry' });
    await flush();
    expect(service.takeCard).toHaveBeenCalledTimes(2);
    ctl.dispose();
  });

  it('a till that does not say is never stopped', async () => {
    const { ctl, service } = make(null);
    await notPaid(ctl);
    ctl.input({ type: 'retry' });
    await flush();
    expect(service.takeCard).toHaveBeenCalledTimes(2);
    ctl.dispose();
  });
});

