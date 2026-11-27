// The Activity and a payment's page once payments are archived (slice 2.3): the totals add the archive's to the
// record's, each once; a line says how much is archived; a reader without an archive reads as before; a payment no
// longer in the record says it was archived.
import type { Claim, Payment } from 'cashucard';
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  ACTIVITY_WORDS,
  activityView,
  PAYMENT_WORDS,
  readActivity,
  startOfDay,
  type ActivityData,
  type ActivityReader,
  type Takings,
} from '../src/app/activity';
import { ActivityScreen } from '../src/screens/ActivityScreen';
import { PaymentScreen } from '../src/screens/PaymentScreen';
import { heldPayment } from './helpers/fake-till';
import { has, textOf, until } from './helpers/render';

const NOW = new Date(2026, 10, 22, 12, 0).getTime();
const pay = (n: number, o: Partial<Payment> = {}): Payment => ({
  ...heldPayment('s' + n),
  state: 'delivered',
  paymentId: 'pay:' + String(n).padStart(4, '0'),
  at: NOW - 60000 - n * 1000,
  ...o,
});
const data = (o: Partial<ActivityData> = {}): ActivityData => ({
  payments: [],
  claims: [],
  older: [],
  damaged: [],
  twice: [],
  ms: 0,
  ...o,
});

function reader(
  pays: Payment[],
  archived: { today: Takings; all: Takings } | null,
  calls: string[] = [],
): ActivityReader {
  const r: ActivityReader = {
    payments: async () => {
      calls.push('payments');
      return pays;
    },
    openClaims: async (): Promise<Claim[]> => {
      calls.push('openClaims');
      return [];
    },
    olderRows: async () => {
      calls.push('olderRows');
      return [];
    },
    damagedRows: async () => {
      calls.push('damagedRows');
      return [];
    },
    maybePaidTwice: async () => {
      calls.push('maybePaidTwice');
      return [];
    },
  };
  if (archived !== null) {
    r.archivedTakings = async (from: number | null, to: number | null): Promise<Takings> => {
      calls.push('archived ' + String(from) + ' ' + String(to));
      return from === null ? archived.all : archived.today;
    };
  }
  return r;
}

async function activity(r: ActivityReader): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <ActivityScreen
        reader={r}
        now={() => NOW}
        pages={1}
        onPages={() => undefined}
        onOpen={() => undefined}
        onPayments={() => () => undefined}
        onBack={() => undefined}
      />,
    );
  });
  await until(tree, 'act-all');
  return tree;
}

async function page(isArchived: boolean | null, found: Payment | null, asked: string[]): Promise<ReactTestRenderer> {
  const r: {
    payment(id: string): Promise<Payment | null>;
    maybePaidTwice(): Promise<string[]>;
    openClaims(): Promise<Claim[]>;
    isArchived?(id: string): Promise<boolean>;
  } = {
    payment: async () => found,
    maybePaidTwice: async () => [],
    openClaims: async () => [],
  };
  if (isArchived !== null) {
    r.isArchived = async (id: string): Promise<boolean> => {
      asked.push(id);
      return isArchived;
    };
  }
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <PaymentScreen paymentId="pay:0001" reader={r} onPayments={() => () => undefined} onBack={() => undefined} />,
    );
  });
  for (let i = 0; i < 20 && has(tree, 'payment-reading'); i += 1) {
    await act(async () => {
      await new Promise<void>((res) => setTimeout(res, 0));
    });
  }
  return tree;
}

describe('the Activity with an archive', () => {
  it('the totals add the archived payments to the record payments, each once, and say how much is archived', () => {
    const v = activityView(
      data({
        payments: [pay(1), pay(2), pay(3)],
        archived: { today: { sats: 28, count: 2 }, all: { sats: 140, count: 10 } },
      }),
      1,
      NOW,
    );
    expect(v.today).toEqual({ sats: 70, count: 5 });
    expect(v.all).toEqual({ sats: 182, count: 13 });
    expect(v.archived).toEqual({ sats: 140, count: 10 });
    expect(v.count).toBe(3);
    expect(v.done.length).toBe(3);
    const none = activityView(data({ payments: [pay(1)] }), 1, NOW);
    expect(none.all).toEqual({ sats: 14, count: 1 });
    expect(none.today).toEqual({ sats: 14, count: 1 });
    expect(none.archived).toEqual({ sats: 0, count: 0 });
  });

  it('a reading is one steady reading of the record and the archive, its today counted to its own time', async () => {
    const calls: string[] = [];
    const times = [NOW - 500, NOW, NOW + 250];
    let i = 0;
    const r = reader([pay(1)], { today: { sats: 28, count: 2 }, all: { sats: 140, count: 10 } }, calls);
    r.steady = async <T,>(f: () => Promise<T>): Promise<T> => {
      calls.push('steady');
      const v = await f();
      calls.push('steady done');
      return v;
    };
    const d = await readActivity(r, () => times[Math.min(i++, times.length - 1)]);
    expect(calls).toEqual([
      'steady',
      'payments',
      'openClaims',
      'olderRows',
      'damagedRows',
      'maybePaidTwice',
      'archived ' + String(startOfDay(NOW)) + ' ' + String(NOW),
      'archived null null',
      'steady done',
    ]);
    expect(d.archived).toEqual({ today: { sats: 28, count: 2 }, all: { sats: 140, count: 10 } });
    expect(d.at).toBe(NOW);
    expect(d.ms).toBe(750);
  });

  it('a reader without an archive is read as before', async () => {
    const calls: string[] = [];
    let ticks = 0;
    const d = await readActivity(reader([pay(1)], null, calls), () => {
      ticks += 1;
      return NOW;
    });
    expect(calls).toEqual(['payments', 'openClaims', 'olderRows', 'damagedRows', 'maybePaidTwice']);
    expect('archived' in d).toBe(false);
    expect(ticks).toBe(2);
  });

  it('the Activity says how much of its totals is archived, only when something is', async () => {
    const tree = await activity(reader([pay(1)], { today: { sats: 0, count: 0 }, all: { sats: 140, count: 10 } }));
    expect(textOf(tree, 'act-today')).toBe('Paid today: 14 sats in 1 payment');
    expect(textOf(tree, 'act-all')).toBe('Paid in this record: 154 sats in 11 payments');
    expect(textOf(tree, 'act-archived')).toBe('Of these, archived: 140 sats in 10 payments');
    expect(ACTIVITY_WORDS.archivedLead).toBe('Of these, archived: ');
    await act(async () => {
      tree.unmount();
    });
    const plain = await activity(reader([pay(1)], null));
    expect(has(plain, 'act-archived')).toBe(false);
    expect(textOf(plain, 'act-all')).toBe('Paid in this record: 14 sats in 1 payment');
    await act(async () => {
      plain.unmount();
    });
    const empty = await activity(reader([pay(1)], { today: { sats: 0, count: 0 }, all: { sats: 0, count: 0 } }));
    expect(has(empty, 'act-archived')).toBe(false);
    await act(async () => {
      empty.unmount();
    });
  });

  it('the Activity counts today to the time of its reading, never to the time it is drawn again', async () => {
    const night = new Date(2026, 10, 22, 23, 59).getTime();
    const clock = { now: night };
    const r = reader([pay(1, { at: night - 60000 })], { today: { sats: 28, count: 2 }, all: { sats: 140, count: 10 } });
    const screen = (pages: number): React.JSX.Element => (
      <ActivityScreen
        reader={r}
        now={() => clock.now}
        pages={pages}
        onPages={() => undefined}
        onOpen={() => undefined}
        onPayments={() => () => undefined}
        onBack={() => undefined}
      />
    );
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(screen(1));
    });
    await until(tree, 'act-all');
    expect(textOf(tree, 'act-today')).toBe('Paid today: 42 sats in 3 payments');
    // past midnight, drawn again with no new reading: still the reading's day
    clock.now = new Date(2026, 10, 23, 0, 1).getTime();
    await act(async () => {
      tree.update(screen(2));
    });
    expect(textOf(tree, 'act-today')).toBe('Paid today: 42 sats in 3 payments');
    expect(textOf(tree, 'act-all')).toBe('Paid in this record: 154 sats in 11 payments');
    await act(async () => {
      tree.unmount();
    });
  });

  it('a payment no longer in the record says it was archived, when it was', async () => {
    const asked: string[] = [];
    const tree = await page(true, null, asked);
    expect(textOf(tree, 'payment-archived')).toBe(
      'This payment was archived. It still counts in the totals, and it is in the payment list in Records.',
    );
    expect(PAYMENT_WORDS.archived).toBe(textOf(tree, 'payment-archived'));
    expect(has(tree, 'payment-missing')).toBe(false);
    expect(textOf(tree, 'payment-title')).toBe('Payment');
    expect(asked).toEqual(['pay:0001']);
    await act(async () => {
      tree.unmount();
    });
    const no = await page(false, null, asked);
    expect(textOf(no, 'payment-missing')).toBe('This payment is not in the record.');
    expect(has(no, 'payment-archived')).toBe(false);
    await act(async () => {
      no.unmount();
    });
    const old = await page(null, null, asked);
    expect(textOf(old, 'payment-missing')).toBe('This payment is not in the record.');
    await act(async () => {
      old.unmount();
    });
  });

  it('a payment in the record never asks the archive', async () => {
    const asked: string[] = [];
    const tree = await page(true, pay(1), asked);
    expect(textOf(tree, 'payment-title')).toBe('PAID');
    expect(has(tree, 'payment-archived')).toBe(false);
    expect(asked).toEqual([]);
    await act(async () => {
      tree.unmount();
    });
  });
});
