import {
  CardError,
  open,
  type CardListener,
  type CardTransport,
  type CashuCard,
  type Delivery,
  type Journal,
  type Payment,
} from 'cashucard';
import type { JobKind } from '../src/till/queue';
import {
  createTillService,
  TillNotOpenError,
  type TillService,
  type TillServiceDeps,
} from '../src/till/service';
import { nowPaidWords } from '../src/till/settle';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint, type FakeMint } from './helpers/fake-mint';
import { fakeStoreDeps, type FakeStore } from './helpers/fake-store';
import { fakeTransport, heldPayment } from './helpers/fake-till';

type Step = (k: CashuCard) => Promise<Payment[]>;
type CardFn = (t: CardTransport, l: CardListener, id: string) => Promise<Payment>;
interface MakeOptions {
  steps?: Step[];
  cards?: CardFn[];
  /** when given, the library's payments() answers this */
  payments?: () => Payment[];
  f?: FakeStore;
  mint?: FakeMint;
  extra?: Partial<TillServiceDeps>;
}
function make(o: MakeOptions = {}) {
  const f = o.f ?? fakeStoreDeps();
  const mint = o.mint ?? fakeMint();
  const steps = o.steps ?? [];
  const cards = o.cards ?? [];
  const settles: Array<{ running: JobKind | null; tap: boolean; lib: number }> = [];
  const libs: CashuCard[] = [];
  const waits: number[] = [];
  const logs: string[] = [];
  let service!: TillService;
  service = createTillService({
    store: f.deps,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: mint.http,
    now: () => 1000,
    log: (l) => logs.push(l),
    random: () => 0.25,
    wait: async (ms) => {
      waits.push(ms);
    },
    openLibrary: async (c) => {
      const k = await open(c);
      const n = libs.push(k) - 1;
      k.settle = async () => {
        settles.push({ running: service.queue.running(), tap: service.queue.tapOpen(), lib: n });
        const next = steps.shift();
        return next === undefined ? [] : next(k);
      };
      if (o.payments !== undefined) {
        const pays = o.payments;
        k.payments = async () => pays();
      }
      const realSale = k.sale.bind(k);
      k.sale = async (id) => {
        const s = await realSale(id);
        s.card = async (t, l) => {
          const next = cards.shift();
          if (!next) {
            throw new Error('no card script left');
          }
          return next(t, l, id);
        };
        return s;
      };
      return k;
    },
    ...o.extra,
  });
  return { f, mint, service, libs, settles, steps, cards, waits, logs };
}

async function ready(t: ReturnType<typeof make>): Promise<void> {
  await t.service.open();
  await t.service.addMint(await t.service.checkMint('mint.test'));
}

const D: Delivery = {
  id: 'fx-' + 'a'.repeat(26),
  mint: 'https://mint.test',
  unit: 'sat',
  amount: 14,
  token: 'cashuB' + 'q'.repeat(60),
};
/** a step that hands D to the payout (the till's real keep-store) and says it delivered pay:00 */
const delivering: Step = async (k) => {
  await k.c.payout.deliver(D);
  return [{ ...heldPayment('s1'), state: 'delivered' }];
};

const noListener = (): CardListener => ({ confirm: async () => ({ pay: false }) });

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value);
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every microtask and timer callback queued so far run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

describe('the till service settles', () => {
  it('a settle runs as a settle job, on the library opened last', async () => {
    const t = make();
    await ready(t);
    await expect(t.service.settleNow('asked')).resolves.toEqual([]);
    expect(t.settles).toEqual([{ running: 'settle', tap: false, lib: 1 }]);
  });

  it('a settle is asked after every card job, and never during it', async () => {
    const t = make();
    await ready(t);
    const id = await t.service.openSale(14);
    const g = deferred<void>();
    t.cards.push(async (_t, _l, cid) => {
      await g.promise;
      return heldPayment(cid);
    });
    const p = t.service.takeCard(id, fakeTransport(), noListener());
    await flush();
    expect(t.settles).toEqual([]);
    g.resolve(undefined);
    await p;
    await flush();
    expect(t.settles.length).toBe(1);
    expect(t.settles[0].running).toBe('settle');
    expect(t.settles[0].tap).toBe(false);

    t.cards.push(async () => {
      throw new CardError('declined', 'No.');
    });
    await expect(t.service.takeCard(id, fakeTransport(), noListener())).rejects.toBeInstanceOf(CardError);
    await flush();
    expect(t.settles.length).toBe(2);
  });

  it('a settle asked during a tap waits for it, and one waiting is joined', async () => {
    const t = make();
    await ready(t);
    const id = await t.service.openSale(14);
    const g = deferred<void>();
    t.cards.push(async (_t, _l, cid) => {
      await g.promise;
      return heldPayment(cid);
    });
    const p = t.service.takeCard(id, fakeTransport(), noListener());
    const a = t.service.settleNow('timer');
    const b = t.service.settleNow('front');
    expect(b).toBe(a);
    await flush();
    expect(t.settles).toEqual([]);
    g.resolve(undefined);
    await p;
    await a;
    await flush();
    expect(t.settles.length).toBeGreaterThanOrEqual(1);
    expect(t.settles.length).toBeLessThanOrEqual(2);
    for (const s of t.settles) {
      expect(s.tap).toBe(false);
      expect(s.running).toBe('settle');
    }
  });

  it('busy from the library is asked again after a second', async () => {
    const busy: Step = async () => {
      throw new CardError('busy', 'A settle is already running.');
    };
    const t = make({ steps: [busy, busy, async () => []] });
    await ready(t);
    await expect(t.service.settleNow('asked')).resolves.toEqual([]);
    expect(t.waits).toEqual([1000, 1000]);
  });

  it('what a settle changed goes to the listeners', async () => {
    const t = make({ steps: [delivering, delivering] });
    await ready(t);
    const l = jest.fn();
    const off = t.service.onPayments(l);
    await t.service.settleNow('asked');
    await flush();
    expect(l).toHaveBeenCalledTimes(1);
    expect(l).toHaveBeenCalledWith([{ ...heldPayment('s1'), state: 'delivered' }]);
    off();
    await t.service.settleNow('asked');
    await flush();
    expect(l).toHaveBeenCalledTimes(1);
  });

  it('kept is what the keep-store holds, never what the record says', async () => {
    const t = make({
      steps: [async () => [{ ...heldPayment('s1'), state: 'delivered' }], delivering, delivering],
    });
    await ready(t);
    expect(await t.service.kept()).toEqual([]);
    await t.service.settleNow('asked');
    expect(await t.service.kept()).toEqual([]);
    await t.service.settleNow('asked');
    expect(await t.service.kept()).toEqual([{ mint: 'https://mint.test/', unit: 'sat', amount: 14, count: 1 }]);
    await t.service.settleNow('asked');
    expect(await t.service.kept()).toEqual([{ mint: 'https://mint.test/', unit: 'sat', amount: 14, count: 1 }]);
  });

  it('a delivery kept before the app died is there at the next launch, once', async () => {
    const t = make({
      steps: [delivering],
      extra: {
        devKeep: (keep) => async (d) => {
          await keep(d);
          await new Promise<void>(() => undefined);
        },
      },
    });
    await ready(t);
    void t.service.settleNow('asked');
    for (let i = 0; i < 50 && (await t.service.kept()).length !== 1; i += 1) {
      await flush();
    }
    expect((await t.service.kept()).length).toBe(1);

    const u = make({ f: t.f, mint: t.mint, steps: [delivering] });
    await ready(u);
    await u.service.settleNow('launch');
    expect(await u.service.kept()).toEqual([{ mint: 'https://mint.test/', unit: 'sat', amount: 14, count: 1 }]);
  });

  it('the last settle is noted, and its notices told once', async () => {
    let pays: Payment[] = [{ ...heldPayment('s1'), state: 'taking' }];
    const t = make({ steps: [delivering, delivering], payments: () => pays });
    await ready(t);
    expect(t.service.lastSettle()).toBeNull();
    await t.service.settleNow('asked');
    const note = t.service.lastSettle();
    expect(note?.why).toBe('asked');
    expect(note?.ok).toBe(true);
    expect(note?.changed).toBe(1);
    expect(note?.n).toBe(1);
    expect(t.service.notices()).toEqual([
      { paymentId: 'pay:00', words: "14 sats · PAID. Paid and kept in this phone's wallet. " + nowPaidWords(0) },
    ]);
    t.service.noticesSeen();
    expect(t.service.notices()).toEqual([]);
    pays = [{ ...heldPayment('s1'), state: 'taking' }];
    await t.service.settleNow('asked');
    expect(t.service.notices()).toEqual([]);
  });

  it('payments are read outside the queue', async () => {
    const t = make({ payments: () => [heldPayment('s1')] });
    await ready(t);
    const g = deferred<void>();
    void t.service.withCard('card', () => g.promise);
    await flush();
    await expect(t.service.payments()).resolves.toEqual([heldPayment('s1')]);
    g.resolve(undefined);
  });

  it('nothing is settled or read before the till is open', async () => {
    const t = make();
    await expect(t.service.settleNow('asked')).rejects.toBeInstanceOf(TillNotOpenError);
    await expect(t.service.kept()).rejects.toBeInstanceOf(TillNotOpenError);
    await expect(t.service.payments()).rejects.toBeInstanceOf(TillNotOpenError);
    expect(t.service.lastSettle()).toBeNull();
    expect(t.service.notices()).toEqual([]);
  });

  it('the service logs nothing of a settle, and no token', async () => {
    const t = make({ steps: [delivering] });
    await ready(t);
    await t.service.settleNow('asked');
    for (const line of t.logs) {
      expect(line).toMatch(/^till: (opening|ready)$/);
    }
    expect(JSON.stringify([t.service.lastSettle(), t.service.notices()])).not.toContain('cashu');
  });

  it('the journal and the keep can be wrapped for development', async () => {
    const wrapped: Journal[] = [];
    const keeps: string[] = [];
    const t = make({
      steps: [delivering],
      extra: {
        devJournal: (j) => {
          wrapped.push(j);
          return j;
        },
        devKeep: (keep) => async (d) => {
          keeps.push(d.id);
          await keep(d);
        },
      },
    });
    await ready(t);
    expect(wrapped.length).toBe(2);
    await t.service.settleNow('asked');
    expect(keeps).toEqual([D.id]);
    expect(await t.service.kept()).toEqual([{ mint: 'https://mint.test/', unit: 'sat', amount: 14, count: 1 }]);
  });
});

it('exposes sweep setup before a first sale, checks after settlement in front, and revokes it if the mint is removed', async () => {
  let foreground = false;
  const t = make({ steps: [delivering], extra: { inForeground: () => foreground } });
  await ready(t);
  const mint = 'https://mint.test/';
  expect(await t.service.walletBalances()).toContainEqual({ mint, unit: 'sat', available: 0, withdrawal: null });
  await t.service.lightning!.configure(mint, { address: 'merchant@address.test', threshold: 2, maxFee: 1 });
  await t.service.settleNow('timer');
  await flush();
  expect((await t.service.lightning!.state(mint)).sweepNotice).toBeUndefined();
  foreground = true;
  await t.service.settleNow('front');
  await flush();
  // This card mint accepts the sale but does not support sat-denominated Lightning payouts.
  // Seeing a notice here proves the foreground scheduler invoked the wallet without a Wallet screen.
  const state = await t.service.lightning!.state(mint);
  expect(state.sweepNotice).toEqual(expect.any(String));
  expect(state.payment).toBeNull();
  await t.service.removeMint(mint);
  expect((await t.service.lightning!.state(mint)).policy).toBeNull();
  expect((await t.service.walletBalances()).find(group => group.mint === mint)?.available).toBe(14);
  await t.service.close();
});
