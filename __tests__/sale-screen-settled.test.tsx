/* The sale screen hears the service's settles while it is shown: every changed payment is handed to the machine, which
 * alone decides PAID; the till's queue reaches the controller, and a sale opened behind a settle says it waits. */

import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { CardError, type CardListener, type CardTransport, type Payment } from 'cashucard';
import { SaleScreen, type SaleScreenProps } from '../src/screens/SaleScreen';
import { saleStep, type SaleState } from '../src/till/sale-machine';
import type { CardReader } from '../src/till/reader';
import { heldPayment, fakeTransport } from './helpers/fake-till';
import { has, press, textOf, untilText } from './helpers/render';

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

const onBack = jest.fn();
const onActivity = jest.fn();

beforeEach(() => {
  onBack.mockClear();
  onActivity.mockClear();
});

interface MountProps {
  queue?: SaleScreenProps['queue'];
  onPayments?: SaleScreenProps['onPayments'];
}

async function mount(
  service: SaleScreenProps['service'],
  r: CardReader,
  extra: MountProps = {},
): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <SaleScreen
        service={service}
        reader={r}
        mints={['https://mint.test']}
        onBack={onBack}
        onActivity={onActivity}
        onReport={() => undefined}
        queue={extra.queue}
        onPayments={extra.onPayments}
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

/** A signed swap that the mint has not taken: CHECKING, its error names its entry ('pay:00'). */
async function lost(t: CardTransport, _l: CardListener, _id: string): Promise<Payment> {
  await t.begin?.('1');
  throw new CardError(
    'swap-lost',
    "The card's mint has not taken the payment yet (503). It is kept, and tried again by settle; do not take another payment for this sale.",
    { signed: true, entry: 'pay:00' },
  );
}

/** A signed mint error that names no payment: CHECKING with paymentId null. */
async function mintLost(t: CardTransport, _l: CardListener, _id: string): Promise<Payment> {
  await t.begin?.('1');
  throw new CardError('mint', 'The mint did not answer.', { signed: true });
}

function hub() {
  const ls: Array<(changed: Payment[]) => void> = [];
  return {
    onPayments: (l: (changed: Payment[]) => void) => {
      ls.push(l);
      return () => {
        const i = ls.indexOf(l);
        if (i >= 0) {
          ls.splice(i, 1);
        }
      };
    },
    emit: async (changed: Payment[]) => {
      await act(async () => {
        for (const l of ls.slice()) {
          l(changed);
        }
      });
    },
    count: () => ls.length,
  };
}

type Hub = ReturnType<typeof hub>;

/** The one held payment of the fake sale. */
const X = heldPayment('s1');

/** Charges 14 sats with a script that ends CHECKING, then delivers the sale's payment: the screen shows PAID. */
async function toPaidBySettle(h: Hub, script: Script = lost): Promise<ReactTestRenderer> {
  const tree = await mount(fakeService(script), reader(fakeTransport()), { onPayments: h.onPayments });
  await charge(tree);
  await untilText(tree, 'result-title', 'CHECKING');
  await h.emit([{ ...X, state: 'delivered' }]);
  await untilText(tree, 'result-title', 'PAID');
  return tree;
}

it('CHECKING turns PAID only when settle holds its own payment', async () => {
  const h = hub();
  const tree = await mount(fakeService(lost), reader(fakeTransport()), { onPayments: h.onPayments });
  await charge(tree);
  await untilText(tree, 'result-title', 'CHECKING');

  await h.emit([{ ...X, state: 'taking', why: 'swap-waiting: 503' }]);
  expect(textOf(tree, 'result-title')).toBe('CHECKING');

  await h.emit([{ ...X, paymentId: 'pay:01', state: 'delivered' }]);
  expect(textOf(tree, 'result-title')).toBe('CHECKING');

  await h.emit([{ ...X, state: 'held', extra: 'paid-twice' }]);
  expect(textOf(tree, 'result-title')).toBe('CHECKING');

  await h.emit([{ ...X, state: 'delivered' }]);
  await untilText(tree, 'result-title', 'PAID');
  expect(textOf(tree, 'result-amount')).toBe('14 sats');
});

it('a CHECKING that named no payment turns PAID once a payment of its own sale is paid', async () => {
  const h = hub();
  const tree = await mount(fakeService(mintLost), reader(fakeTransport()), { onPayments: h.onPayments });
  await charge(tree);
  await untilText(tree, 'result-title', 'CHECKING');

  await h.emit([
    { ...heldPayment('s2'), paymentId: 'pay:09', state: 'delivered' },
    { ...X, state: 'taking' },
    { ...X, state: 'held', extra: 'late' },
  ]);
  expect(textOf(tree, 'result-title')).toBe('CHECKING');

  await h.emit([{ ...X, paymentId: 'pay:07', state: 'held' }]);
  await untilText(tree, 'result-title', 'PAID');
});

it('the machine matches a CHECKING with no payment on its sale, and still asks isPaid', () => {
  const c: SaleState = {
    kind: 'result',
    sats: 14,
    saleId: 's1',
    outcome: { kind: 'checking', paymentId: null, message: '' },
    note: null,
  };
  const settled = (payment: Payment): SaleState => saleStep(c, { type: 'settled', payment }).state;

  expect(settled({ ...heldPayment('s2'), state: 'delivered' })).toBe(c);
  expect(settled({ ...heldPayment('s1'), state: 'taking' })).toBe(c);
  expect(settled({ ...heldPayment('s1'), extra: 'paid-twice' })).toBe(c);

  const paid = settled(heldPayment('s1'));
  if (paid.kind !== 'result') throw new Error('expected a result');
  expect(paid.outcome.kind).toBe('paid');

  const named: SaleState = {
    kind: 'result',
    sats: 14,
    saleId: 's1',
    outcome: { kind: 'checking', paymentId: 'pay:00', message: '' },
    note: null,
  };
  expect(saleStep(named, { type: 'settled', payment: { ...heldPayment('s1'), paymentId: 'pay:01' } }).state).toBe(named);
});

it('a settle that changes nothing leaves the screen as it was', async () => {
  const h = hub();
  const tree = await mount(fakeService(lost), reader(fakeTransport()), { onPayments: h.onPayments });

  await h.emit([]);
  await h.emit([{ ...X, state: 'delivered' }]);

  expect(has(tree, 'sale-title')).toBe(true);
  expect(textOf(tree, 'sale-amount')).toBe('0 sats');
  expect(has(tree, 'result-title')).toBe(false);
});

it('a PAID result heard again stays PAID', async () => {
  const h = hub();
  const tree = await toPaidBySettle(h);

  await h.emit([{ ...X, state: 'delivered' }]);
  await untilText(tree, 'result-title', 'PAID');
});

it('leaving the screen stops hearing settles', async () => {
  const h = hub();
  const tree = await mount(fakeService(lost), reader(fakeTransport()), { onPayments: h.onPayments });
  expect(h.count()).toBe(1);
  await act(async () => {
    tree.unmount();
  });
  expect(h.count()).toBe(0);
});

it('without the new props the screen works as before', async () => {
  const tree = await mount(fakeService(lost), reader(fakeTransport()));
  await charge(tree);
  await untilText(tree, 'result-title', 'CHECKING');
});

it('a card job behind a settle shows One moment', async () => {
  const tree = await mount(
    fakeService(() => new Promise<Payment>(() => undefined)),
    reader(fakeTransport()),
    { queue: { running: () => 'settle' as const, waiting: () => 1 } },
  );
  await charge(tree);
  await untilText(tree, 'tap-title', 'One moment');
  expect(has(tree, 'tap-cancel')).toBe(true);
});

it('a sale opened behind a settle shows One moment', async () => {
  const service: SaleScreenProps['service'] = {
    openSale: jest.fn((_sats: number): Promise<string> => new Promise<string>(() => undefined)),
    takeCard: jest.fn((_id: string, _t: CardTransport, _l: CardListener): Promise<Payment> => new Promise<Payment>(() => undefined)),
    withdrawSale: jest.fn(async (_saleId: string): Promise<Payment[]> => []),
  };
  const tree = await mount(service, reader(fakeTransport()), {
    queue: { running: () => 'settle' as const, waiting: () => 1 },
  });
  await charge(tree);
  await untilText(
    tree,
    'sale-opening',
    'One moment. The till is finishing earlier payments with the mint. Then it opens the sale.',
  );
});
