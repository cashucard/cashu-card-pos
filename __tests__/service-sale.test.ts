import {
  CardError,
  open,
  type CardListener,
  type CardTransport,
  type CashuCard,
  type Payment,
} from 'cashucard';
import type { JobKind } from '../src/till/queue';
import {
  createTillService,
  newSaleId,
  TillNotOpenError,
  type TillService,
} from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { fakeTransport, heldPayment } from './helpers/fake-till';

type CardFn = (t: CardTransport, l: CardListener, id: string) => Promise<Payment>;

function make(card: CardFn[] = [], paymentsOf: (() => Promise<Payment[]>) | null = null) {
  const f = fakeStoreDeps();
  const mint = fakeMint();
  const libs: CashuCard[] = [];
  const handles: Array<{ id: string; lib: number }> = [];
  const receives: Array<{ id: string; sats?: number; running: JobKind | null }> = [];
  const closes: Array<{ id: string; paid: boolean; running: JobKind | null }> = [];
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
      const realReceive = k.receive.bind(k);
      k.receive = async (s) => {
        receives.push({ id: s.id, sats: s.sats, running: service.queue.running() });
        return realReceive(s);
      };
      const realSale = k.sale.bind(k);
      k.sale = async (id) => {
        const s = await realSale(id);
        handles.push({ id, lib: n });
        s.card = async (t, l) => {
          const next = card.shift();
          if (!next) {
            throw new Error('no card script left');
          }
          return next(t, l, id);
        };
        const realClose = s.close.bind(s);
        s.close = async (paid) => {
          closes.push({ id, paid, running: service.queue.running() });
          return realClose(paid);
        };
        return s;
      };
      if (paymentsOf !== null) {
        k.payments = paymentsOf;
      }
      return k;
    },
  });
  return { f, mint, service, libs, handles, receives, closes, waits, logs };
}

async function ready(t: ReturnType<typeof make>): Promise<void> {
  await t.service.open();
  await t.service.addMint(await t.service.checkMint('mint.test'));
}

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

const noListener = (): CardListener => ({ confirm: async () => ({ pay: false }) });

/** Lets every microtask and timer callback queued so far run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

/** The kind of the error a promise rejects with, checking it is a CardError. */
async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'no error';
  } catch (e) {
    expect(e).toBeInstanceOf(CardError);
    return (e as CardError).kind;
  }
}

describe('the till service and its sales', () => {
  it('a sale id is the clock and six characters', () => {
    expect(newSaleId(1000, () => 0)).toBe('s-rs-000000');
    expect(newSaleId(1000, () => 0.25)).toBe('s-rs-900000');
    for (const id of [newSaleId(1000, () => 0), newSaleId(1000, () => 0.25)]) {
      expect(id).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
    }
  });

  it('a sale is opened with its price in sats, inside the queue', async () => {
    const t = make();
    await ready(t);
    const id = await t.service.openSale(2100);
    expect(id).toBe('s-rs-900000');
    expect(t.receives).toEqual([{ id, sats: 2100, running: 'sale' }]);
  });

  it('a price outside 1 to 1,000,000 sats opens nothing', async () => {
    const t = make();
    await ready(t);
    expect(await kindOf(t.service.openSale(0))).toBe('bad-sale');
    expect(await kindOf(t.service.openSale(1000001))).toBe('bad-sale');
    expect(await kindOf(t.service.openSale(1.5))).toBe('bad-sale');
    expect(t.receives).toEqual([]);
  });

  it('the same id is never opened twice', async () => {
    const t = make();
    await ready(t);
    await expect(t.service.openSale(14)).resolves.toBe('s-rs-900000');
    expect(await kindOf(t.service.openSale(14))).toBe('same-sale');
  });

  it('a card is taken in a card job, on a handle asked for in that job', async () => {
    let sawKind: JobKind | null = null;
    let sawTap = false;
    const t = make([
      async (_t, _l, id) => {
        sawKind = t.service.queue.running();
        sawTap = t.service.queue.tapOpen();
        return heldPayment(id);
      },
    ]);
    await ready(t);
    const id = await t.service.openSale(14);
    await expect(t.service.takeCard(id, fakeTransport(), noListener())).resolves.toEqual(heldPayment(id));
    expect(sawKind).toBe('card');
    expect(sawTap).toBe(true);
    expect(t.handles).toEqual([{ id, lib: 1 }]);
  });

  it('a settle asked during a tap waits for the tap', async () => {
    const gate = deferred<void>();
    const order: string[] = [];
    const t = make([
      async (_t, _l, id) => {
        await gate.promise;
        order.push('card end');
        return heldPayment(id);
      },
    ]);
    await ready(t);
    const id = await t.service.openSale(14);
    const cardRun = t.service.takeCard(id, fakeTransport(), noListener());
    const settleRun = t.service.withCard('settle', async () => {
      order.push('settle');
    });
    await flush();
    expect(order).toEqual([]);
    gate.resolve(undefined);
    await Promise.all([cardRun, settleRun]);
    expect(order).toEqual(['card end', 'settle']);
  });

  it('a sale opened before the library was opened again is taken by the new one', async () => {
    const t = make([async (_t, _l, id) => heldPayment(id)]);
    await ready(t);
    const id = await t.service.openSale(14);
    await t.service.addMint(await t.service.checkMint('mint.test'));
    expect(t.libs.length).toBe(3);
    await expect(t.service.takeCard(id, fakeTransport(), noListener())).resolves.toEqual(heldPayment(id));
    expect(t.handles).toEqual([{ id, lib: 2 }]);
  });

  it('busy is tried again after a second, and never reaches the screen', async () => {
    const busy: CardFn = async () => {
      throw new CardError('busy', 'A card is being read already.');
    };
    const t = make([busy, busy, async (_t, _l, id) => heldPayment(id)]);
    await ready(t);
    const id = await t.service.openSale(14);
    await expect(t.service.takeCard(id, fakeTransport(), noListener())).resolves.toEqual(heldPayment(id));
    expect(t.waits).toEqual([1000, 1000]);
    expect(t.handles.length).toBe(3);
  });

  it('busy once the merchant stopped is a stop', async () => {
    const stopped = new AbortController();
    stopped.abort();
    const listener: CardListener = { confirm: async () => ({ pay: false }), signal: stopped.signal };
    const t = make([
      async () => {
        throw new CardError('busy', 'A card is being read already.');
      },
    ]);
    await ready(t);
    const id = await t.service.openSale(14);
    expect(await kindOf(t.service.takeCard(id, fakeTransport(), listener))).toBe('stopped');
    expect(t.waits).toEqual([]);
  });

  it('every other error is passed on as it came', async () => {
    const e = new CardError('interrupted', 'x', { signed: true });
    const t = make([
      async () => {
        throw e;
      },
    ]);
    await ready(t);
    const id = await t.service.openSale(14);
    await expect(t.service.takeCard(id, fakeTransport(), noListener())).rejects.toBe(e);
    expect(t.waits).toEqual([]);
  });

  it('a sale is withdrawn with close(false), in its own job, after any card job', async () => {
    const gate = deferred<void>();
    const t = make([
      async (_t, _l, id) => {
        await gate.promise;
        return heldPayment(id);
      },
    ]);
    await ready(t);
    const id = await t.service.openSale(14);
    const cardRun = t.service.takeCard(id, fakeTransport(), noListener());
    const closeRun = t.service.withdrawSale(id);
    await flush();
    expect(t.closes).toEqual([]);
    gate.resolve(undefined);
    await Promise.all([cardRun, closeRun]);
    expect(t.closes).toEqual([{ id, paid: false, running: 'close-sale' }]);
  });

  it("withdrawing answers close's own answer", async () => {
    const t = make();
    await ready(t);
    const id = await t.service.openSale(14);
    await expect(t.service.withdrawSale(id)).resolves.toEqual([]);
    await expect(t.service.withdrawSale(id)).resolves.toEqual([]);
  });

  it('a payment is found by its own id', async () => {
    const t = make([], async () => [heldPayment('s1')]);
    await ready(t);
    await expect(t.service.payment('pay:00')).resolves.toEqual(heldPayment('s1'));
    await expect(t.service.payment('pay:01')).resolves.toBeNull();
  });

  it('nothing of a sale is done before the till is open', async () => {
    const t = make();
    await expect(t.service.openSale(14)).rejects.toBeInstanceOf(TillNotOpenError);
    await expect(t.service.takeCard('s', fakeTransport(), noListener())).rejects.toBeInstanceOf(TillNotOpenError);
    await expect(t.service.withdrawSale('s')).rejects.toBeInstanceOf(TillNotOpenError);
    await expect(t.service.payment('p')).rejects.toBeInstanceOf(TillNotOpenError);
  });

  it('the service logs no sale', async () => {
    const t = make([async (_t, _l, id) => heldPayment(id)]);
    await ready(t);
    const id = await t.service.openSale(14);
    await t.service.takeCard(id, fakeTransport(), noListener());
    await t.service.withdrawSale(id);
    for (const line of t.logs) {
      expect(line).toMatch(/^till: (opening|ready)$/);
    }
  });
});
