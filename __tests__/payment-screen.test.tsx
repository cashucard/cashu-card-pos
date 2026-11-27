/* One payment's detail: its headline in its tone, its amount, what it means, each figure, the fee, the mint and the
 * time; in the till's own words, never a token, a card's key or an id. */

import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import type { Claim, Payment } from 'cashucard';
import { PaymentScreen, type PaymentProps } from '../src/screens/PaymentScreen';
import { paymentWords, WAITING_WORDS } from '../src/till/payment-words';
import { LIGHT } from '../src/ui/theme';
import { heldPayment } from './helpers/fake-till';
import { allText, flush, has, nodes, press, textOf } from './helpers/render';

const T = new Date(2026, 10, 22, 4, 10).getTime();
const pay = (o: Partial<Payment> = {}): Payment => ({ ...heldPayment('s1'), state: 'delivered', paymentId: 'pay:01',
  at: T, ...o });
const W: Claim = { id: 'pay:01', sale: 's1', cardKey: '02' + 'c'.repeat(64), mint: 'https://mint.test', unit: 'sat',
  amount: 15, fee: 1, price: 14, step: 'sign-asked', at: T - 5000, asks: 1, misses: 0 };
/** A reader answering `r.answer`, which a test may change; `asked` keeps every paymentId asked; `twice` is what the
 * kept notices say may be paid twice. */
function reader(answer: Payment | null) {
  const r = {
    answer,
    fail: false,
    twice: [] as string[],
    claims: [] as Claim[],
    asked: [] as string[],
    payment: async (id: string): Promise<Payment | null> => {
      r.asked.push(id);
      if (r.fail) {
        throw new Error('closed');
      }
      return r.answer;
    },
    openClaims: async (): Promise<Claim[]> => r.claims,
    maybePaidTwice: async (): Promise<string[]> => r.twice,
  };
  return r;
}
const trees: string[][] = [];
async function show(r: PaymentProps['reader'], paymentId = 'pay:01') {
  const listeners: Array<(c: Payment[]) => void> = [];
  const off = jest.fn();
  const onBack = jest.fn();
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <PaymentScreen
        paymentId={paymentId}
        reader={r}
        onPayments={(l) => {
          listeners.push(l);
          return off;
        }}
        onBack={onBack}
      />,
    );
  });
  await flush();
  trees.push(allText(tree));
  return { tree, listeners, off, onBack };
}
const colourOf = (tree: ReactTestRenderer, id: string): unknown =>
  (StyleSheet.flatten(nodes(tree, id)[0].props.style) as Record<string, unknown>).color;
/** The colour of the Text a Body with that testID renders (`nodes(tree, id)[0]` is the Body, `[1]` its Text). */
const bodyColourOf = (tree: ReactTestRenderer, id: string): unknown =>
  (StyleSheet.flatten(nodes(tree, id)[1].props.style) as Record<string, unknown>).color;
/** every testID in the tree that starts with `prefix` */
const withPrefix = (tree: ReactTestRenderer, prefix: string): string[] =>
  tree.root
    .findAll((n) => typeof n.props.testID === 'string' && (n.props.testID as string).startsWith(prefix))
    .map((n) => n.props.testID as string);
const TWICE =
  'The payment of 22 Nov 2026, 04:10 was not finished when its sale ended. It is paid now. If the customer paid that sale another way too, it is paid twice.';

it('a paid payment says so in green, with its amount, its meaning and its lines', async () => {
  const r = reader(pay({ amount: 2100, fee: 1, mint: 'https://Mint.Test:3338' }));
  const { tree } = await show(r);
  expect(textOf(tree, 'payment-title')).toBe('PAID');
  expect(colourOf(tree, 'payment-title')).toBe(LIGHT.good);
  expect(textOf(tree, 'payment-amount')).toBe('2,100 sats');
  expect(textOf(tree, 'payment-sentence')).toBe("Paid and kept in this phone's wallet.");
  expect(textOf(tree, 'payment-fee')).toBe("The mint's fee: 1 sat");
  expect(textOf(tree, 'payment-mint')).toBe('Mint: mint.test:3338');
  expect(textOf(tree, 'payment-at')).toBe('Phone wallet payment of 22 Nov 2026, 04:10');
  expect(has(tree, 'payment-customers')).toBe(false);
  expect(has(tree, 'payment-twice')).toBe(false);
  expect(withPrefix(tree, 'payment-owed')).toEqual([]);
  expect(r.asked).toEqual(['pay:01']);
});

it("each figure has its own line, in the table's words", async () => {
  const { tree } = await show(
    reader(pay({ state: 'held', owedToCard: 5, unconfirmed: 3, givenBack: 14, kept: 1, stuck: 2, unproved: 1, lost: 7 })),
  );
  expect(textOf(tree, 'payment-owed')).toBe('Owed to the card, not written yet: 5 sats');
  expect(textOf(tree, 'payment-unconfirmed')).toBe('Written to the card, not confirmed yet: 3 sats');
  expect(textOf(tree, 'payment-written')).toBe('Change written to the card: 11 sats');
  expect(textOf(tree, 'payment-kept')).toBe('Kept by the till: 1 sat (too small to give back)');
  expect(textOf(tree, 'payment-stuck')).toBe("Change waiting for the mint's proof: 2 sats");
  expect(textOf(tree, 'payment-unproved')).toBe('Change the mint never proved: 1 sat. It stays owed.');
  expect(textOf(tree, 'payment-lost')).toBe('Lost from the card: 7 sats');
  for (const s of allText(tree)) {
    expect(s).not.toContain('8 sats');
  }
});

it("the customer's money says it is not takings, and is never green", async () => {
  const rows: Array<{ o: Partial<Payment>; title: string; colour: string }> = [
    { o: { state: 'held', extra: 'paid-twice' }, title: 'PAID TWICE', colour: LIGHT.bad },
    { o: { state: 'held', extra: 'late' }, title: 'PAID LATE', colour: LIGHT.bad },
    { o: { state: 'held', extra: 'late', why: 'date-too-near' }, title: 'KEPT FOR THE CUSTOMER', colour: LIGHT.text },
    { o: { state: 'returned', extra: 'late', owedToCard: 13 }, title: 'OWED TO THE CARD', colour: LIGHT.text },
    { o: { state: 'returned', extra: 'late', givenBack: 13, unconfirmed: 13 }, title: 'WRITTEN TO THE CARD',
      colour: LIGHT.text },
    { o: { state: 'returning', extra: 'late' }, title: 'GOING BACK TO THE CARD', colour: LIGHT.text },
  ];
  for (const row of rows) {
    const { tree } = await show(reader(pay(row.o)));
    expect(textOf(tree, 'payment-customers')).toBe("This money is the customer's. It is not counted as takings.");
    expect(textOf(tree, 'payment-title')).toBe(row.title);
    expect(colourOf(tree, 'payment-title')).toBe(row.colour);
    expect(colourOf(tree, 'payment-title')).not.toBe(LIGHT.good);
  }
  const { tree } = await show(reader(pay({ state: 'returned', extra: 'late', owedToCard: 13 })));
  expect(textOf(tree, 'payment-owed')).toBe('Owed to the card, not written yet: 13 sats');
});

it('a payment not held is never called PAID, and a loss is red', async () => {
  const cases: Array<[Payment['state'], string]> = [
    ['taking', LIGHT.text],
    ['unrecovered', LIGHT.text],
    ['lost', LIGHT.bad],
    ['spent-not-restored', LIGHT.bad],
    ['gone', LIGHT.bad],
  ];
  for (const [state, colour] of cases) {
    const { tree } = await show(reader(pay({ state })));
    expect(textOf(tree, 'payment-title')).toBe(paymentWords(pay({ state })).headline);
    for (const s of allText(tree)) {
      expect(s).not.toBe('PAID');
    }
    expect(colourOf(tree, 'payment-title')).toBe(colour);
  }
});

it('a payment paid after its sale was left unfinished says it may be paid twice, in the bad tone', async () => {
  const r = reader(pay());
  r.twice = ['pay:00', 'pay:01'];
  const { tree } = await show(r);
  expect(textOf(tree, 'payment-title')).toBe('PAID');
  expect(colourOf(tree, 'payment-title')).toBe(LIGHT.bad);
  expect(textOf(tree, 'payment-twice')).toBe(TWICE);
  expect(bodyColourOf(tree, 'payment-twice')).toBe(LIGHT.bad);
  expect(has(tree, 'payment-customers')).toBe(false);

  const other = reader(pay());
  other.twice = ['pay:02'];
  const { tree: second } = await show(other);
  expect(has(second, 'payment-twice')).toBe(false);
  expect(colourOf(second, 'payment-title')).toBe(LIGHT.good);
});

it('a NOT PAID YET payment later paid says it may be paid twice', async () => {
  const r = reader(pay({ state: 'spent-not-restored' }));
  const { tree, listeners } = await show(r);
  expect(textOf(tree, 'payment-title')).toBe('NOT PAID YET: A FAULT AT THE MINT');
  expect(has(tree, 'payment-twice')).toBe(false);
  r.answer = pay();
  r.twice = ['pay:01'];
  await act(async () => {
    for (const l of listeners) {
      l([pay()]);
    }
  });
  await flush();
  expect(textOf(tree, 'payment-title')).toBe('PAID');
  expect(colourOf(tree, 'payment-title')).toBe(LIGHT.bad);
  expect(textOf(tree, 'payment-twice')).toBe(TWICE);
});

it('a payment not in the record says so', async () => {
  const { tree } = await show(reader(null));
  expect(textOf(tree, 'payment-title')).toBe('Payment');
  expect(textOf(tree, 'payment-missing')).toBe('This payment is not in the record.');
});

it('while it is read the screen says so', async () => {
  const r = reader(pay());
  r.payment = () => new Promise<Payment | null>(() => undefined);
  const { tree } = await show(r);
  expect(textOf(tree, 'payment-title')).toBe('Payment');
  expect(textOf(tree, 'payment-reading')).toBe('Reading the record.');
});

it('a reading that fails says so, unless the payment is already shown', async () => {
  const r = reader(pay());
  r.fail = true;
  const { tree } = await show(r);
  expect(textOf(tree, 'payment-failed')).toBe('The record could not be read now. Go back and try again.');

  const r2 = reader(pay());
  const { tree: shown, listeners } = await show(r2);
  expect(textOf(shown, 'payment-title')).toBe('PAID');
  r2.fail = true;
  await act(async () => {
    for (const l of listeners) {
      l([]);
    }
  });
  await flush();
  expect(textOf(shown, 'payment-title')).toBe('PAID');
  expect(has(shown, 'payment-failed')).toBe(false);
});

it('a settle that changed it shows it as it is now', async () => {
  const r = reader(pay({ state: 'taking' }));
  const { tree, listeners } = await show(r);
  expect(textOf(tree, 'payment-title')).toBe('CHECKING');
  r.answer = pay();
  await act(async () => {
    for (const l of listeners) {
      l([pay()]);
    }
  });
  await flush();
  expect(textOf(tree, 'payment-title')).toBe('PAID');
  expect(r.asked).toEqual(['pay:01', 'pay:01']);
});

it('nothing on the screen is a token, a key or an id', async () => {
  const id = 'pay:' + 'd'.repeat(32);
  const r = reader(
    pay({
      change: 'cashuB' + 'x'.repeat(60),
      cardKey: '02' + 'c'.repeat(64),
      paymentId: id,
      delivery: { id: 'fx-' + 'e'.repeat(26) },
    }),
  );
  r.twice = [id];
  const { tree } = await show(r, id);
  expect(has(tree, 'payment-twice')).toBe(true);
  for (const s of allText(tree)) {
    expect(s).not.toContain('cashu');
    expect(s).not.toContain('cccc');
    expect(s).not.toContain('dddd');
    expect(s).not.toContain('eeee');
    expect(s).not.toContain('fx-');
    expect(s).not.toContain('pay:');
  }
});

it('back, and leaving stops listening', async () => {
  const r = reader(pay());
  const { tree, listeners, off, onBack } = await show(r);
  await press(tree, 'nav-back');
  expect(onBack).toHaveBeenCalledTimes(1);
  act(() => {
    tree.unmount();
  });
  expect(off).toHaveBeenCalledTimes(1);
  const asked = r.asked.length;
  await act(async () => {
    for (const l of listeners) {
      l([pay()]);
    }
  });
  await flush();
  expect(r.asked.length).toBe(asked);
});

it('a re-read that fails keeps the payment shown and says it may not be the latest', async () => {
  const r = reader(pay({ state: 'taking' }));
  const { tree, listeners } = await show(r);
  expect(textOf(tree, 'payment-title')).toBe('CHECKING');
  expect(has(tree, 'payment-stale')).toBe(false);
  r.fail = true;
  await act(async () => {
    for (const l of listeners) {
      l([]);
    }
  });
  await flush();
  expect(textOf(tree, 'payment-title')).toBe('CHECKING');
  expect(textOf(tree, 'payment-stale')).toBe('The record could not be read again now. This may not be the latest.');
  expect(bodyColourOf(tree, 'payment-stale')).toBe(LIGHT.bad);
  expect(has(tree, 'payment-failed')).toBe(false);
  r.fail = false;
  r.answer = pay();
  await act(async () => {
    for (const l of listeners) {
      l([pay()]);
    }
  });
  await flush();
  expect(textOf(tree, 'payment-title')).toBe('PAID');
  expect(has(tree, 'payment-stale')).toBe(false);
});

it('an older reading never overwrites a newer one', async () => {
  let answerFirst!: (x: Payment | null) => void;
  let calls = 0;
  const r: PaymentProps['reader'] = {
    payment: (): Promise<Payment | null> => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Payment | null>((res) => {
          answerFirst = res;
        });
      }
      return Promise.resolve(pay());
    },
    openClaims: async (): Promise<Claim[]> => [],
    maybePaidTwice: async (): Promise<string[]> => [],
  };
  const { tree, listeners } = await show(r);
  await act(async () => {
    for (const l of listeners) {
      l([pay()]);
    }
  });
  await flush();
  expect(textOf(tree, 'payment-title')).toBe('PAID');
  await act(async () => {
    answerFirst(pay({ state: 'taking' }));
  });
  await flush();
  expect(textOf(tree, 'payment-title')).toBe('PAID');
  expect(calls).toBe(2);
});

it('a payment waiting for its card is named above its headline and says so, never CHECKING', async () => {
  const r = reader(pay({ state: 'taking' }));
  r.claims = [W];
  const { tree } = await show(r);
  expect(textOf(tree, 'payment-name')).toBe('14 sats · 22 Nov 2026, 04:10');
  expect(textOf(tree, 'payment-title')).toBe(WAITING_WORDS.headline);
  expect(textOf(tree, 'payment-sentence')).toBe(WAITING_WORDS.sentence);
  expect(colourOf(tree, 'payment-title')).toBe(LIGHT.text);
  expect(has(tree, 'payment-customers')).toBe(false);
  expect(withPrefix(tree, 'payment-owed')).toEqual([]);
  for (const s of allText(tree)) {
    expect(s).not.toContain('CHECKING');
    expect(s).not.toContain('checking');
  }
});

it('a payment being checked with the mint still says CHECKING, with its name above', async () => {
  const r = reader(pay({ state: 'taking' }));
  r.claims = [{ ...W, id: 'pay:other' }, { ...W, step: 'released' }, { ...W, step: 'unrecovered' }];
  const { tree } = await show(r);
  expect(textOf(tree, 'payment-name')).toBe('14 sats · 22 Nov 2026, 04:10');
  expect(textOf(tree, 'payment-title')).toBe('CHECKING');
  expect(textOf(tree, 'payment-sentence')).toBe(paymentWords(pay({ state: 'taking' })).sentence);
  expect(textOf(tree, 'payment-title')).not.toBe(WAITING_WORDS.headline);
  expect(colourOf(tree, 'payment-title')).toBe(LIGHT.text);

  const noClaims = reader(pay({ state: 'taking' }));
  const { tree: none } = await show(noClaims);
  expect(textOf(none, 'payment-title')).toBe('CHECKING');
  expect(textOf(none, 'payment-name')).toBe('14 sats · 22 Nov 2026, 04:10');
});

it('the page name is muted and sits above the headline', async () => {
  const { tree } = await show(reader(pay({ amount: 2100 })));
  expect(textOf(tree, 'payment-name')).toBe('2,100 sats · 22 Nov 2026, 04:10');
  expect(colourOf(tree, 'payment-name')).toBe(LIGHT.muted);
  expect(textOf(tree, 'payment-title')).toBe('PAID');
  const all = allText(tree);
  expect(all.indexOf('2,100 sats · 22 Nov 2026, 04:10')).toBeLessThan(all.indexOf('PAID'));
});

it('the words are plain', () => {
  expect(trees.length).toBeGreaterThan(5);
  for (const tree of trees) {
    for (const s of tree) {
      expect(s).not.toContain('—');
      expect(s).not.toContain('–');
      expect(/crypto|paid back|settled/i.test(s)).toBe(false);
    }
  }
});
