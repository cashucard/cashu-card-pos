/* The three kinds of a sale's records (cashucard 0.3.0) on the sale screen: an archive holding the sale for a moment
 * (`sale-busy`), a sale archived (`sale-archived`) and a sale whose record does not read (`sale-unreadable`). Each has
 * the till's own words, never the library's (they name its calls); none is ever TAP THE SAME CARD AGAIN; a sale over
 * (archived, or its record unreadable) is never offered Try again, and `sale-busy` is. */

import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { CardError, type CardErrorKind } from 'cashucard';
import { CARD_ERROR_TITLES, errorOutcome, SALE_RECORD_WORDS } from '../src/till/card-errors';
import { outcomeOfTake, saleBackAllowed, saleStep, SALE_OVER_KINDS, type SaleOutcome, type SaleState } from '../src/till/sale-machine';
import { ResultPanel } from '../src/screens/SaleResult';
import { has } from './helpers/render';

const KINDS: Array<'sale-busy' | 'sale-archived' | 'sale-unreadable'> = ['sale-busy', 'sale-archived', 'sale-unreadable'];
const library = (kind: CardErrorKind): CardError => new CardError(kind, 'see damagedRows: the library words.');

function result(outcome: SaleOutcome): Extract<SaleState, { kind: 'result' }> {
  return { kind: 'result', sats: 2100, saleId: 's1', outcome, note: null };
}

function show(o: SaleOutcome): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(<ResultPanel state={result(o)} send={jest.fn()} onActivity={jest.fn()} />);
  });
  return tree;
}

describe("the kinds of a sale's records", () => {
  it("each has the till's own title and words, never the library's message", () => {
    for (const kind of KINDS) {
      const o = errorOutcome(library(kind));
      expect(o).toEqual({ kind: 'not-paid', errorKind: kind, title: CARD_ERROR_TITLES[kind], message: SALE_RECORD_WORDS[kind] });
      expect(SALE_RECORD_WORDS[kind]).toContain('Nothing was taken.');
      expect(SALE_RECORD_WORDS[kind]).not.toMatch(/damagedRows|sale\(|[—–]/);
    }
    expect(CARD_ERROR_TITLES['sale-busy']).toBe('The till is archiving this sale');
    expect(CARD_ERROR_TITLES['sale-archived']).toBe('This sale is over');
    expect(CARD_ERROR_TITLES['sale-unreadable']).toBe("This sale's record cannot be read");
  });

  it('a sale archived, or whose record does not read, ends the sale: never TAP THE SAME CARD AGAIN, never Try again', () => {
    expect(SALE_OVER_KINDS).toEqual(['sale-archived', 'sale-unreadable']);
    for (const kind of SALE_OVER_KINDS) {
      for (const signedBefore of [false, true]) {
        const o = outcomeOfTake(library(kind), null, signedBefore);
        expect(o).toMatchObject({ kind: 'not-paid', errorKind: kind, ended: true });
        const s = result(o);
        expect(saleStep(s, { type: 'retry' })).toEqual({ state: s, effect: null });
        expect(saleStep(s, { type: 'new' }).state).toEqual({ kind: 'keypad', digits: '' });
        expect(saleBackAllowed(s)).toBe(true);
      }
    }
  });

  it('a sale an archive holds for a moment is NOT PAID with Try again, even after an earlier tap the card may have signed', () => {
    for (const signedBefore of [false, true]) {
      const o = outcomeOfTake(library('sale-busy'), null, signedBefore);
      expect(o).toEqual({
        kind: 'not-paid',
        errorKind: 'sale-busy',
        title: CARD_ERROR_TITLES['sale-busy'],
        message: SALE_RECORD_WORDS['sale-busy'],
      });
      expect(saleStep(result(o), { type: 'retry' }).effect).toEqual({ kind: 'take', saleId: 's1' });
    }
  });

  it('the result shows Try again for a sale an archive holds, and only New sale for a sale that is over', () => {
    const busy = show(outcomeOfTake(library('sale-busy'), null, false));
    expect(has(busy, 'result-retry')).toBe(true);
    expect(has(busy, 'result-new')).toBe(true);
    for (const kind of SALE_OVER_KINDS) {
      const over = show(outcomeOfTake(library(kind), null, false));
      expect(has(over, 'result-retry')).toBe(false);
      expect(has(over, 'result-new')).toBe(true);
      expect(has(over, 'result-message')).toBe(true);
    }
  });
});
