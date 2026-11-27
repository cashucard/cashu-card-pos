/* What the merchant reads at a glance. A take the till ended itself says so in the till's own words, never in the
 * library's words for another cause; the result's headline is the largest text on its screen, in a tone that matches
 * its words; the PIN pad's Cancel is out of the digit grid; the withdraw question puts the safe choice first. */

import React from 'react';
import { StyleSheet, Text } from 'react-native';
import renderer, { act, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { CardError } from 'cashucard';
import { CONFIRMATION, heldPayment } from './helpers/fake-till';
import { ids, nodes } from './helpers/render';
import {
  ENDING_WORDS,
  MAY_HAVE_SIGNED,
  saleStep,
  type PinState,
  type SaleEvent,
  type SaleOutcome,
  type SaleState,
  type TapState,
} from '../src/till/sale-machine';
import { cancelledError } from '../src/till/tap-session';
import { ResultPanel } from '../src/screens/SaleResult';
import { PinPanel } from '../src/screens/SalePanels';
import { LIGHT, TYPE } from '../src/ui/theme';

function run(s: SaleState, ...events: SaleEvent[]): SaleState {
  let at = s;
  for (const e of events) at = saleStep(at, e).state;
  return at;
}

function outcomeOf(s: SaleState): SaleOutcome {
  if (s.kind !== 'result') throw new Error('expected a result, got ' + s.kind);
  return s.outcome;
}

const tap1: TapState = { kind: 'tap', sats: 2100, saleId: 's1', tap: 1, card: false, words: null, ending: null };
const tapCard: TapState = { ...tap1, card: true };
const sheet: SaleState = run(tapCard, { type: 'confirm-asked', c: CONFIRMATION });
const FOUR: SaleEvent[] = [{ type: 'pin-key' }, { type: 'pin-key' }, { type: 'pin-key' }, { type: 'pin-key' }];
const PAYER_SAID_NO = new CardError('declined', 'The payer did not accept. Nothing was taken.');
const LIBRARY_CANCELLED = cancelledError();

/** The NOT PAID a take ended in: its title and its message. */
function said(s: SaleState): { title: string; message: string } {
  const o = outcomeOf(s);
  if (o.kind !== 'not-paid') throw new Error('expected not-paid, got ' + o.kind);
  return { title: o.title, message: o.message };
}

describe('a take the till ended itself', () => {
  it('Cancel before a card says so', () => {
    const end = run(tap1, { type: 'cancel' }, { type: 'failed', error: LIBRARY_CANCELLED });
    expect(said(end)).toEqual({
      title: 'Cancelled',
      message: 'Cancel was pressed before a card was held to the phone. Nothing was taken.',
    });
  });

  it("the card's wait running out never says Cancelled", () => {
    const end = run(tap1, { type: 'timeout' }, { type: 'failed', error: LIBRARY_CANCELLED });
    expect(said(end)).toEqual({
      title: 'Time ran out',
      message: 'No card was held to the phone for 30 seconds. Nothing was taken.',
    });
    expect(said(end).message).not.toContain('Cancel');
  });

  it('Do not pay says what was pressed, not Not paid twice', () => {
    const end = run(sheet, { type: 'decline' }, { type: 'failed', error: PAYER_SAID_NO });
    expect(said(end)).toEqual({ title: 'Declined', message: 'Do not pay was pressed. Nothing was taken.' });
  });

  it("the sheet's wait running out says so", () => {
    const end = run(sheet, { type: 'timeout' }, { type: 'failed', error: PAYER_SAID_NO });
    expect(said(end)).toEqual({
      title: 'Time ran out',
      message: 'Nobody pressed Pay or Do not pay for 2 minutes. Nothing was taken.',
    });
  });

  it('Cancel and the wait at the PIN pad never blame the payer', () => {
    const pin = run(sheet, { type: 'pay' });
    const cancelled = run(pin, { type: 'pin-cancel' }, { type: 'failed', error: PAYER_SAID_NO });
    expect(said(cancelled)).toEqual({ title: 'Cancelled', message: 'Cancel was pressed on the PIN pad. Nothing was taken.' });
    const timedOut = run(pin, { type: 'timeout' }, { type: 'failed', error: PAYER_SAID_NO });
    expect(said(timedOut)).toEqual({
      title: 'Time ran out',
      message: 'No key of the PIN pad was pressed for a minute. Nothing was taken.',
    });
  });

  it('Cancel after a wrong PIN names the Cancel, once', () => {
    const tap2: TapState = { ...tap1, tap: 2, card: true };
    const asked = run(tap2, { type: 'pin-asked', why: 'allowance', wrong: true, tries: 2 });
    const end = run(asked, { type: 'pin-cancel' }, {
      type: 'failed',
      error: new CardError('wrong-pin', 'Wrong PIN. 2 tries left.', { tries: 2 }),
    });
    expect(said(end)).toEqual({ title: 'Cancelled', message: 'Cancel was pressed on the PIN pad. Nothing was taken.' });
    const waited = run(asked, { type: 'timeout' }, { type: 'failed', error: new CardError('pin-needed', 'Card needs PIN entered.') });
    expect(said(waited).title).toBe('Time ran out');
  });

  it("no ending ever shows the library's words for another cause", () => {
    const libraryWords = [PAYER_SAID_NO.message, LIBRARY_CANCELLED.message, 'Wrong PIN. 2 tries left.', 'Card needs PIN entered.'];
    for (const ending of Object.keys(ENDING_WORDS) as Array<keyof typeof ENDING_WORDS>) {
      const w = ENDING_WORDS[ending];
      for (const bad of libraryWords) expect(w.message).not.toBe(bad);
      expect(w.message.endsWith('Nothing was taken.')).toBe(true);
      expect(w.message.includes(w.title)).toBe(false);
    }
  });

  it("a fact only the library knows keeps the library's words", () => {
    const poor = run(tap1, { type: 'cancel' }, {
      type: 'failed',
      error: new CardError('not-enough', 'The card holds 12 sats that this reader could check, and this needs 2101 with its fee.'),
    });
    expect(said(poor)).toEqual({
      title: 'Not enough on the card',
      message: 'The card holds 12 sats that this reader could check, and this needs 2101 with its fee.',
    });
    const wrong = run(tapCard, { type: 'failed', error: new CardError('wrong-pin', 'Wrong PIN. 2 tries left.') });
    expect(said(wrong)).toEqual({ title: 'Wrong PIN', message: 'Wrong PIN. 2 tries left.' });
    const leftover = run(tapCard, { type: 'failed', error: PAYER_SAID_NO });
    expect(said(leftover)).toEqual({ title: 'Not paid', message: PAYER_SAID_NO.message });
  });

  it('a PIN to finish an earlier payment, not given, leaves the tap as it was', () => {
    const asked = run(tapCard, { type: 'pin-asked', why: 'recover', wrong: false, tries: 3 });
    const step = saleStep(asked, { type: 'pin-cancel' });
    expect(step.state).toBe(tapCard);
    expect(step.effect).toEqual({ kind: 'answer-pin', give: false });
    expect(saleStep(asked, { type: 'timeout' }).state).toBe(tapCard);
    const later = run(step.state, { type: 'failed', error: new CardError('not-enough', 'The card holds 12 sats.') });
    expect(said(later)).toEqual({ title: 'Not enough on the card', message: 'The card holds 12 sats.' });
  });

  it('where the card may have signed, an ending never says Nothing was taken', () => {
    const signed = run({ ...tapCard, tap: 2 }, { type: 'failed', error: new CardError('interrupted', 'm.', { signed: true }) });
    const retry = run(signed, { type: 'retry' }, { type: 'card-here' }, { type: 'confirm-asked', c: CONFIRMATION });
    const declined = run(retry, { type: 'decline' }, { type: 'failed', error: PAYER_SAID_NO });
    expect(outcomeOf(declined)).toEqual({ kind: 'tap-again', message: 'Declined. ' + MAY_HAVE_SIGNED });
    const pinCancelled = run(retry, { type: 'pay' }, { type: 'pin-cancel' }, { type: 'failed', error: PAYER_SAID_NO });
    expect(outcomeOf(pinCancelled)).toEqual({ kind: 'tap-again', message: 'Cancelled. ' + MAY_HAVE_SIGNED });
    const timedOut = run(signed, { type: 'retry' }, { type: 'timeout' }, { type: 'failed', error: LIBRARY_CANCELLED });
    expect(outcomeOf(timedOut)).toEqual({ kind: 'tap-again', message: 'Time ran out. ' + MAY_HAVE_SIGNED });
    for (const s of [declined, pinCancelled, timedOut]) expect(JSON.stringify(s)).not.toContain('Nothing was taken');
  });
});

/** Every tree made in this file is unmounted at the end. */
const made: ReactTestRenderer[] = [];
afterAll(() => {
  act(() => {
    for (const t of made) t.unmount();
  });
});

function render(el: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(el);
  });
  made.push(tree);
  return tree;
}

function result(outcome: SaleOutcome): Extract<SaleState, { kind: 'result' }> {
  return { kind: 'result', sats: 2100, saleId: 's1', outcome, note: null };
}

/** The flattened style of the first node with that testID. */
function styleOf(tree: ReactTestRenderer, id: string): Record<string, unknown> {
  return StyleSheet.flatten(nodes(tree, id)[0].props.style) as Record<string, unknown>;
}

/** Every font size the tree's text uses. */
function fontSizes(tree: ReactTestRenderer): number[] {
  const out: number[] = [];
  for (const n of tree.root.findAllByType(Text)) {
    const size = (StyleSheet.flatten(n.props.style) as Record<string, unknown>).fontSize;
    if (typeof size === 'number') out.push(size);
  }
  return out;
}

describe("the result's headline", () => {
  const cases: Array<[string, SaleOutcome, string]> = [
    ['PAID', { kind: 'paid', payment: heldPayment('s1') }, LIGHT.good],
    ['ALREADY PAID', { kind: 'already-paid', extra: 'paid-twice', message: '' }, LIGHT.good],
    ['ALREADY WITHDRAWN', { kind: 'already-paid', extra: 'late', message: '' }, LIGHT.text],
    ['NOT PAID', { kind: 'not-paid', errorKind: 'not-enough', title: 'Not enough on the card', message: 'n.' }, LIGHT.bad],
    ['NOT PAID YET', { kind: 'not-paid-yet', message: 'y.' }, LIGHT.bad],
    ['STOP', { kind: 'stop', message: 's.' }, LIGHT.bad],
    ['CHECKING', { kind: 'checking', paymentId: 'pay:00', message: '' }, LIGHT.text],
    ['TAP THE SAME CARD AGAIN', { kind: 'tap-again', message: 'm.' }, LIGHT.text],
    ['TAP AGAIN', { kind: 'unfinished', message: 'u.' }, LIGHT.text],
    ['SALE WITHDRAWN', { kind: 'withdrawn', paidBefore: [] }, LIGHT.text],
  ];

  it('has its tone, and its words say the same', () => {
    for (const [words, outcome, colour] of cases) {
      const tree = render(<ResultPanel state={result(outcome)} send={jest.fn()} onActivity={jest.fn()} />);
      const title = nodes(tree, 'result-title')[0];
      expect(title.props.children).toBe(words);
      expect(styleOf(tree, 'result-title').color).toBe(colour);
    }
  });

  it('is the largest text on the screen', () => {
    expect(TYPE.headline).toBeGreaterThan(TYPE.amount);
    for (const [, outcome] of cases) {
      const tree = render(<ResultPanel state={result(outcome)} send={jest.fn()} onActivity={jest.fn()} />);
      const size = styleOf(tree, 'result-title').fontSize;
      expect(size).toBe(TYPE.headline);
      for (const other of fontSizes(tree)) expect(other).toBeLessThanOrEqual(TYPE.headline);
    }
  });
});

/** Whether a node sits inside a row of the key grid. */
function inRow(n: ReactTestInstance): boolean {
  for (let at: ReactTestInstance | null = n.parent; at !== null; at = at.parent) {
    const style = StyleSheet.flatten(at.props.style) as Record<string, unknown> | undefined;
    if (style !== undefined && style !== null && style.flexDirection === 'row') return true;
  }
  return false;
}

describe('the buttons a thumb lands on', () => {
  const pinState: PinState = {
    kind: 'pin', sats: 2100, saleId: 's1', count: 4, why: 'allowance', wrong: false, tries: null, from: 'confirm', back: null,
  };

  it("the PIN pad's Cancel is below OK, out of the digit grid", () => {
    const tree = render(<PinPanel state={pinState} send={jest.fn()} />);
    const order = ids(tree);
    expect(order.indexOf('pin-key-0')).toBeLessThan(order.indexOf('pin-back'));
    expect(order.indexOf('pin-back')).toBeLessThan(order.indexOf('pin-ok'));
    expect(order.indexOf('pin-ok')).toBeLessThan(order.indexOf('pin-cancel'));
    expect(order[order.length - 1]).toBe('pin-cancel');
    expect(inRow(nodes(tree, 'pin-cancel')[0])).toBe(false);
    expect(inRow(nodes(tree, 'pin-key-0')[0])).toBe(true);
    expect(inRow(nodes(tree, 'pin-back')[0])).toBe(true);
  });

  it('the withdraw question puts the safe choice first', () => {
    for (const back of [
      { kind: 'tap-again', message: 'm.' } as const,
      { kind: 'checking', paymentId: null, message: '' } as const,
    ]) {
      const tree = render(
        <ResultPanel state={result({ kind: 'withdraw-asked', back })} send={jest.fn()} onActivity={jest.fn()} />,
      );
      const order = ids(tree).filter((id) => id === 'withdraw-no' || id === 'withdraw-yes');
      expect(order).toEqual(['withdraw-no', 'withdraw-yes']);
    }
  });
});
