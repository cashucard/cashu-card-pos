/* The sale screen: it owns the controller, shows the panel for the state, keeps Android's back while anything is
 * pending, reports each state to the app root, and answers the library no when it goes. */

import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { CardError, type CardListener, type CardTransport, type Payment } from 'cashucard';
import { SaleScreen, type SaleScreenProps } from '../src/screens/SaleScreen';
import { SALE_WORDS } from '../src/screens/SalePanels';
import type { SaleReport } from '../src/till/sale-machine';
import type { CardReader } from '../src/till/reader';
import { CONFIRMATION, fakeTransport, heldPayment } from './helpers/fake-till';
import { has, press, textOf, until, untilText } from './helpers/render';

const PIN = '8642';

type Script = (t: CardTransport, l: CardListener, id: string) => Promise<Payment>;

/** The till's three sale calls over a card script, as the controller needs them. */
function fakeService(script: Script): SaleScreenProps['service'] {
  return {
    openSale: jest.fn(async (_sats: number): Promise<string> => 's1'),
    takeCard: jest.fn((id: string, t: CardTransport, l: CardListener): Promise<Payment> => script(t, l, id)),
    withdrawSale: jest.fn(async (_saleId: string): Promise<Payment[]> => []),
  };
}

function reader(t: CardTransport): CardReader {
  return { kind: 'card simulator', available: async () => true, transport: () => t };
}

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The card the fake till draws: begin, the sheet, the answer, a held payment. */
function paysAfterConfirm(answers: Array<{ pay: boolean; pin?: string }>): Script {
  return async (t, l, id) => {
    await t.begin!('x');
    const a = await l.confirm(CONFIRMATION);
    answers.push(a);
    if (!a.pay) throw new CardError('declined', 'The payer did not accept. Nothing was taken.');
    return heldPayment(id);
  };
}

const onBack = jest.fn();
const onActivity = jest.fn();
const reports: SaleReport[] = [];

beforeEach(() => {
  onBack.mockClear();
  onActivity.mockClear();
  reports.length = 0;
});

async function mount(service: SaleScreenProps['service'], r: CardReader): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <SaleScreen
        service={service}
        reader={r}
        mints={['https://mint.test']}
        onBack={onBack}
        onActivity={onActivity}
        onReport={(rep) => reports.push(rep)}
      />,
    );
  });
  return tree;
}

/** 14 sats typed, then Charge. */
async function charge(tree: ReactTestRenderer): Promise<void> {
  await press(tree, 'key-1');
  await press(tree, 'key-4');
  await press(tree, 'sale-charge');
}

/** The whole sale: the keypad, the sheet, the PIN, then PAID and a new sale. */
async function toPaid(tree: ReactTestRenderer): Promise<void> {
  await charge(tree);
  await until(tree, 'sheet-pays');
  await press(tree, 'sheet-pay');
  await until(tree, 'pin-title');
  for (const d of PIN) await press(tree, 'pin-key-' + d);
  expect(textOf(tree, 'pin-dots')).toBe('●●●●');
  await press(tree, 'pin-ok');
  await untilText(tree, 'result-title', 'PAID');
}

it('a sale from the keypad to PAID', async () => {
  const tree = await mount(fakeService(paysAfterConfirm([])), reader(fakeTransport()));
  await toPaid(tree);
  await press(tree, 'result-new');
  await until(tree, 'sale-title');
  expect(textOf(tree, 'sale-amount')).toBe('0 sats');
});

it('the reports follow the sale and never hold the PIN', async () => {
  const tree = await mount(fakeService(paysAfterConfirm([])), reader(fakeTransport()));
  await toPaid(tree);
  await press(tree, 'result-new');
  await until(tree, 'sale-title');
  expect(reports[0].step).toBe('keypad');
  expect(reports.some((rep) => rep.step === 'pin')).toBe(true);
  expect(reports[reports.length - 1].step).toBe('keypad');
  expect(JSON.stringify(reports)).not.toContain(PIN);
});

it('back on the keypad leaves', async () => {
  const tree = await mount(fakeService(paysAfterConfirm([])), reader(fakeTransport()));
  expect(has(tree, 'nav-back')).toBe(true);
  await press(tree, 'nav-back');
  expect(onBack).toHaveBeenCalledTimes(1);
});

it('leaving the screen answers the library no', async () => {
  const answers: Array<{ pay: boolean; pin?: string }> = [];
  const tree = await mount(fakeService(paysAfterConfirm(answers)), reader(fakeTransport()));
  await charge(tree);
  await until(tree, 'sheet-pays');
  await act(async () => {
    tree.unmount();
  });
  expect(answers).toEqual([{ pay: false }]);
});

it('the panel follows the state', async () => {
  const gate = deferred<void>();
  const script: Script = async (t, _l, id) => {
    await t.begin!('x');
    await gate.promise;
    return heldPayment(id);
  };
  const tree = await mount(fakeService(script), reader(fakeTransport()));
  await charge(tree);
  await until(tree, 'tap-title');
  await untilText(tree, 'tap-title', SALE_WORDS.still);
  expect(has(tree, 'tap-cancel')).toBe(false);
  await act(async () => {
    gate.resolve(undefined);
  });
  await until(tree, 'result-title');
});
