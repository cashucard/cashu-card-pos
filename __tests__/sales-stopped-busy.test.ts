/* While new sales are stopped (slice 2.4 review, R2): a tap that ended `sale-busy` reads NOT PAID even when the card
 * may have signed in an earlier tap. Its Try again may finish a payment already begun, so it goes on. Every other
 * NOT PAID is still refused with the till's words. */

import { CardError } from 'cashucard';
import { CARD_ERROR_TITLES, SALE_RECORD_WORDS, SALES_STOPPED_TITLE, SALES_STOPPED_WHY } from '../src/till/card-errors';
import { outcomeOfTake, saleStep, type SaleOutcome, type SaleState } from '../src/till/sale-machine';

function result(outcome: SaleOutcome, saleId: string | null = 's1'): SaleState {
  return { kind: 'result', sats: 2100, saleId, outcome, note: null };
}

const BUSY: SaleOutcome = {
  kind: 'not-paid',
  errorKind: 'sale-busy',
  title: CARD_ERROR_TITLES['sale-busy'],
  message: SALE_RECORD_WORDS['sale-busy'],
};
const DECLINED: SaleOutcome = { kind: 'not-paid', errorKind: 'declined', title: 'Declined', message: 'Nothing was taken.' };
const REFUSED: SaleOutcome = { kind: 'not-paid', errorKind: 'busy', title: SALES_STOPPED_TITLE, message: SALES_STOPPED_WHY };

describe('Try again after a tap that ended sale-busy, while new sales are stopped', () => {
  it('a tap that ends sale-busy reads NOT PAID even when the card may have signed before', () => {
    expect(outcomeOfTake(new CardError('sale-busy', 'x'), null, true)).toEqual(BUSY);
    expect(outcomeOfTake(new CardError('sale-busy', 'x'), null, false)).toEqual(BUSY);
  });

  it('goes on for the same sale: the card is taken again and nothing is refused', () => {
    const r = saleStep(result(BUSY), { type: 'retry', stopped: true });
    expect(r.effect).toEqual({ kind: 'take', saleId: 's1' });
    expect(r.state.kind).toBe('tap');
  });

  it('is as before while new sales are taken', () => {
    expect(saleStep(result(BUSY), { type: 'retry', stopped: false }).effect).toEqual({ kind: 'take', saleId: 's1' });
    expect(saleStep(result(BUSY), { type: 'retry' }).effect).toEqual({ kind: 'take', saleId: 's1' });
  });

  it('with no sale open it is a new sale and is refused', () => {
    expect(saleStep(result(BUSY, null), { type: 'retry', stopped: true })).toEqual({ state: result(REFUSED, null), effect: null });
  });

  it('every other NOT PAID is still refused', () => {
    expect(saleStep(result(DECLINED), { type: 'retry', stopped: true })).toEqual({ state: result(REFUSED), effect: null });
    expect(saleStep(result(REFUSED), { type: 'retry', stopped: true })).toEqual({ state: result(REFUSED), effect: null });
  });
});
