import type { CardConfirmation, CardListener, CashuCard, Payment, Stage } from 'cashucard';
import type { DevTransport } from '../till/dev-transport';
import type { MemoryKeep } from '../till/keep';

/** What one card take did: the payment, what was shown, the stages, the PIN asks, the taps and the time. */
export interface SaleFacts {
  payment: Payment;
  confirmation: CardConfirmation | null;
  stages: Stage[];
  pinAsks: number;
  taps: number;
  ms: number;
}

/** Open the sale, take the card's payment in two taps, and collect what happened. */
export async function takeSale(
  cashuCard: Pick<CashuCard, 'receive'>,
  transport: DevTransport,
  o: { id: string; sats: number; pin: string; now: () => number },
): Promise<SaleFacts> {
  const t0 = o.now();
  const sale = await cashuCard.receive({ id: o.id, sats: o.sats });

  let confirmation: CardConfirmation | null = null;
  const stages: Stage[] = [];
  let pinAsks = 0;

  const listener: CardListener = {
    confirm: async (c) => {
      confirmation = c;
      return { pay: true, pin: o.pin };
    },
    askPin: async () => {
      pinAsks += 1;
      return o.pin;
    },
    onStage: (stage) => {
      stages.push(stage);
    },
  };

  const payment = await sale.card(transport, listener);

  return { payment, confirmation, stages, pinAsks, taps: transport.taps, ms: o.now() - t0 };
}

/** The one line the sale step shows; throws when the take is not an exact two-tap payment of the price. */
export function checkSale(f: SaleFacts, o: { sats: number }): string {
  if (f.payment.state !== 'held') {
    throw new Error(
      'the payment is ' + f.payment.state + (f.payment.why ? ' (' + f.payment.why + ')' : '') + ', not held',
    );
  }
  if (f.confirmation === null) {
    throw new Error('no confirmation was shown');
  }
  const c = f.confirmation;
  if (c.change !== 'none') {
    throw new Error('the card would get change (' + c.change + ') where it pays exactly');
  }
  if (f.payment.amount !== o.sats) {
    throw new Error('the payment is for ' + f.payment.amount + ', not ' + o.sats);
  }
  if (c.total !== o.sats + f.payment.fee + c.kept) {
    throw new Error('the card paid ' + c.total + ', not ' + (o.sats + f.payment.fee + c.kept));
  }
  if (f.taps < 2) {
    throw new Error('only ' + f.taps + ' taps');
  }
  return (
    'held ' +
    f.payment.amount +
    ' sats + fee ' +
    f.payment.fee +
    '; the card paid ' +
    c.total +
    ' of ' +
    c.balance +
    '; ' +
    f.taps +
    ' taps; ' +
    f.ms +
    ' ms; ' +
    f.stages.join('>')
  );
}

/** Settle the till and check that one delivery of the price reached the keep at the mint. */
export async function settleAndCheck(
  cashuCard: Pick<CashuCard, 'settle' | 'payments'>,
  keep: Pick<MemoryKeep, 'calls'>,
  o: { id: string; sats: number; mint: string },
): Promise<string> {
  await cashuCard.settle();

  if (keep.calls.length !== 1) {
    throw new Error(keep.calls.length + ' deliveries to keep, not 1');
  }
  const d = keep.calls[0];
  if (d.amount !== o.sats) {
    throw new Error('the delivery is ' + d.amount + ' sats, not ' + o.sats);
  }
  if (d.mint !== o.mint) {
    throw new Error('the delivery names ' + d.mint + ', not ' + o.mint);
  }
  if (!d.token.startsWith('cashuB')) {
    throw new Error('the delivery is not a cashuB token');
  }

  const p = (await cashuCard.payments()).find((x) => x.id === o.id);
  if (!p || p.state !== 'delivered') {
    throw new Error('the payment is ' + (p ? p.state : 'missing') + ', not delivered');
  }

  return 'delivered ' + d.amount + ' sats at ' + d.mint + ' to keep as a ' + d.token.length + '-character cashuB token';
}
