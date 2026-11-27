import {
  MemoryJournal,
  type CardConfirmation,
  type CardListener,
  type Delivery,
  type Payment,
  type Sale,
} from 'cashucard';
import type { DevTransport } from '../../src/till/dev-transport';
import { memoryKeep } from '../../src/till/keep';
import type { OpenTill } from '../../src/till/open';

/** The exact payment a card of 8, 4, 2, 1 makes for 14 sats: no change, 15 off a balance of 15. */
export const CONFIRMATION: CardConfirmation = {
  price: 14,
  unit: 'sat',
  inputFees: 1,
  total: 15,
  balance: 15,
  unchecked: 0,
  mint: 'https://mint.test',
  pinNeeded: true,
  pinFor: 'allowance',
  change: 'none',
  changeAmount: 0,
  cardChange: 0,
  leftover: 0,
  kept: 0,
  version: '3.0',
  design: 'FX1',
};

/** The payment a card take answers with once the mint has signed. */
export function heldPayment(id: string): Payment {
  return {
    id,
    state: 'held',
    mint: 'https://mint.test',
    unit: 'sat',
    amount: 14,
    fee: 1,
    owedToCard: 0,
    givenBack: 0,
    unconfirmed: 0,
    kept: 0,
    stuck: 0,
    unproved: 0,
    paymentId: 'pay:00',
    at: 0,
  };
}

/** The card simulator's transport, without the simulator: a tap counts, a command answers 9000. */
export function fakeTransport(): DevTransport {
  const sent: string[] = [];
  const t: DevTransport = {
    sent,
    taps: 0,
    async begin(_prompt: string): Promise<void> {
      t.taps += 1;
    },
    async transceive(_apdu: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array([0x90, 0x00]);
    },
  };
  return t;
}

const DEFAULT_DELIVERY: Delivery = {
  id: 'fx-aaaaaaaaaaaaaaaaaaaaaaaaaa',
  mint: 'https://mint.test',
  unit: 'sat',
  amount: 14,
  token: 'cashuB' + 'q'.repeat(60),
};

/** What the fake speaks instead of the card: what a take does, what settle delivers. */
export interface FakeTillScript {
  /** what sale.card does; default: two begin() calls on the transport, confirm(CONFIRMATION), then heldPayment(id) */
  card?: (transport: DevTransport, l: CardListener, id: string) => Promise<Payment>;
  /** deliveries settle() makes; default: one of 14 sats at https://mint.test with a cashuB token */
  deliveries?: Delivery[];
  /** the state settle() leaves the payments in; default: delivered */
  paymentState?: Payment['state'];
}

export interface FakeTill extends OpenTill {
  received: Array<{ id: string; sats?: number }>;
  settled: number;
}

/** The default take: tap, confirm, tap, PAID, a held payment. */
async function defaultCard(t: DevTransport, l: CardListener, id: string): Promise<Payment> {
  await t.begin?.('tap 1');
  await l.confirm(CONFIRMATION);
  await t.begin?.('tap 2');
  l.onStage?.('paid', { title: 'PAID', sheet: 'Paid', short: 'PAID' }, {});
  return heldPayment(id);
}

/** A till over fakes: the card the script draws, a memory journal and an in-memory keep. */
export function fakeTill(s: FakeTillScript = {}): FakeTill {
  const received: Array<{ id: string; sats?: number }> = [];
  const payments: Payment[] = [];
  const keep = memoryKeep();
  let settled = 0;

  const cashuCard = {
    async receive(rec: { id: string; sats?: number }): Promise<Sale> {
      received.push({ id: rec.id, sats: rec.sats });
      return {
        card: async (t: DevTransport, l: CardListener): Promise<Payment> => {
          const p = await (s.card ?? defaultCard)(t, l, rec.id);
          payments.push(p);
          return p;
        },
      } as unknown as Sale;
    },
    async settle(): Promise<Payment[]> {
      settled += 1;
      for (const d of s.deliveries ?? [DEFAULT_DELIVERY]) {
        await keep.keep(d);
      }
      for (const p of payments) {
        p.state = s.paymentState ?? 'delivered';
      }
      return payments;
    },
    async payments(): Promise<Payment[]> {
      return payments;
    },
  } as unknown as OpenTill['cashuCard'];

  return {
    cashuCard,
    journal: new MemoryJournal(),
    keep,
    received,
    get settled(): number {
      return settled;
    },
  };
}
