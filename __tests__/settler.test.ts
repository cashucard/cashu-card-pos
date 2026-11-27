import { CardError, type CashuCard, type Payment } from 'cashucard';
import { createTillQueue, type JobKind } from '../src/till/queue';
import { heldPayment } from './helpers/fake-till';
import { createSettler, nowPaidWords } from '../src/till/settle';

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
function flush(): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, 0))
    .then(() => new Promise<void>((r) => setTimeout(r, 0)))
    .then(() => new Promise<void>((r) => setTimeout(r, 0)))
    .then(() => new Promise<void>((r) => setTimeout(r, 0)))
    .then(() => new Promise<void>((r) => setTimeout(r, 0)));
}

type Step = () => Promise<Payment[]>;

function make(steps: Step[] = [], befores: Payment[][] = []) {
  const queue = createTillQueue();
  const calls: Array<{ running: JobKind | null; tap: boolean }> = [];
  const waits: number[] = [];
  const clock = { t: 1000 };
  let active = 0;
  let most = 0;
  const card = {
    settle: async (): Promise<Payment[]> => {
      calls.push({ running: queue.running(), tap: queue.tapOpen() });
      active += 1;
      most = Math.max(most, active);
      try {
        const next = steps.shift();
        return next === undefined ? [] : await next();
      } finally {
        active -= 1;
      }
    },
    payments: async (): Promise<Payment[]> => befores.shift() ?? [],
  } as unknown as CashuCard;
  const s = createSettler({
    job: (f) => queue.run('settle', () => f(card)),
    wait: async (ms) => {
      waits.push(ms);
    },
    now: () => clock.t,
  });
  return { s, queue, calls, waits, clock, most: () => most };
}

const pay = (id: string, o: Partial<Payment> = {}): Payment => ({ ...heldPayment('s1'), paymentId: id, ...o });

const busy: Step = async () => {
  throw new CardError('busy', 'A settle is already running.');
};

describe('the settle runner', () => {
  it('a settle runs as one settle job, and answers what it changed', async () => {
    const t = make([async () => [pay('pay:1', { state: 'delivered' })]]);
    await expect(t.s.settle('asked')).resolves.toEqual([pay('pay:1', { state: 'delivered' })]);
    expect(t.calls).toEqual([{ running: 'settle', tap: false }]);
  });

  it('a settle never starts while a card tap runs', async () => {
    const t = make();
    const g = deferred<void>();
    const card = t.queue.run('card', () => g.promise);
    const a = t.s.settle('timer');
    await flush();
    expect(t.calls).toEqual([]);
    g.resolve(undefined);
    await card;
    await a;
    expect(t.calls).toEqual([{ running: 'settle', tap: false }]);
  });

  it('one settle waiting at most; a request while one waits joins it', async () => {
    const t = make();
    const g = deferred<void>();
    const card = t.queue.run('card', () => g.promise);
    const a = t.s.settle('timer');
    const b = t.s.settle('front');
    const c = t.s.settle('asked');
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(t.s.waiting()).toBe(true);
    g.resolve(undefined);
    await a;
    await card;
    expect(t.calls.length).toBe(1);
    expect(t.s.waiting()).toBe(false);
    expect(t.s.last()?.why).toBe('timer');
  });

  it('a request while one runs waits for it, and one more runs after', async () => {
    const g2 = deferred<void>();
    const t = make([
      async () => {
        await g2.promise;
        return [];
      },
    ]);
    const a = t.s.settle('launch');
    await flush();
    expect(t.calls.length).toBe(1);
    const b = t.s.settle('after-card');
    expect(b).not.toBe(a);
    const c = t.s.settle('timer');
    expect(c).toBe(b);
    g2.resolve(undefined);
    await Promise.all([a, b]);
    expect(t.calls.length).toBe(2);
    expect(t.most()).toBe(1);
  });

  it('two settles never run at once', async () => {
    const step: Step = async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      return [];
    };
    const t = make([step, step, step, step, step]);
    const a = t.s.settle('timer');
    await flush();
    const b = t.s.settle('front');
    const c = t.s.settle('asked');
    await flush();
    const d = t.s.settle('after-card');
    await flush();
    const e = t.s.settle('launch');
    await Promise.all([a, b, c, d, e]);
    expect(t.most()).toBe(1);
    for (const call of t.calls) {
      expect(call.running).toBe('settle');
    }
  });

  it('busy is asked again after a second', async () => {
    const t = make([busy, busy, async () => []]);
    await expect(t.s.settle('asked')).resolves.toEqual([]);
    expect(t.waits).toEqual([1000, 1000]);
    expect(t.calls.length).toBe(3);
  });

  it('a library that stays busy is given up after thirty tries, and said so', async () => {
    const t = make(Array.from({ length: 30 }, () => busy));
    const thrown = await t.s.settle('asked').then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(CardError);
    expect((thrown as CardError).kind).toBe('busy');
    expect(t.calls.length).toBe(30);
    expect(t.waits.length).toBe(29);
    expect(t.s.last()?.ok).toBe(false);
    expect(t.s.last()?.error).toBe('busy');
  });

  it('every listener hears what changed, after the job', async () => {
    const t = make([async () => [pay('pay:1', { state: 'delivered' })]]);
    const heard1: Array<{ changed: Payment[]; running: JobKind | null }> = [];
    const heard2: Array<{ changed: Payment[]; running: JobKind | null }> = [];
    t.s.onPayments((changed) => heard1.push({ changed, running: t.queue.running() }));
    const off2 = t.s.onPayments((changed) => heard2.push({ changed, running: t.queue.running() }));
    await t.s.settle('asked');
    await flush();
    const want = { changed: [pay('pay:1', { state: 'delivered' })], running: null };
    expect(heard1).toEqual([want]);
    expect(heard2).toEqual([want]);
    off2();
    await t.s.settle('asked');
    await flush();
    expect(heard1.length).toBe(2);
    expect(heard2.length).toBe(1);
  });

  it('a settle that failed is heard as nothing changed', async () => {
    const bad = new CardError('journal', 'x.');
    const t = make([
      async () => {
        throw bad;
      },
      async () => {
        throw new Error('y');
      },
      async () => [],
    ]);
    const heard: Payment[][] = [];
    t.s.onPayments((changed) => heard.push(changed));
    await expect(t.s.settle('asked')).rejects.toBe(bad);
    await flush();
    expect(heard).toEqual([[]]);
    expect(t.s.last()?.ok).toBe(false);
    expect(t.s.last()?.error).toBe('journal');
    expect(t.s.last()?.changed).toBe(0);
    await expect(t.s.settle('asked')).rejects.toThrow(/y/);
    await flush();
    expect(t.s.last()?.ok).toBe(false);
    expect(t.s.last()?.error).toBe('internal');
    await expect(t.s.settle('asked')).resolves.toEqual([]);
    expect(t.s.last()?.ok).toBe(true);
  });

  it('the last settle is noted', async () => {
    const t = make([
      async () => {
        t.clock.t = 1250;
        return [pay('pay:1'), pay('pay:2')];
      },
    ]);
    expect(t.s.last()).toBeNull();
    await t.s.settle('asked');
    expect(t.s.last()).toEqual({ why: 'asked', at: 1250, ms: 250, ok: true, changed: 2, error: null, n: 1 });
    await t.s.settle('asked');
    expect(t.s.last()?.n).toBe(2);
  });

  it('a settle refused before it started changes nothing', async () => {
    const s = createSettler({
      job: () => Promise.reject(new Error('closed')),
      wait: async () => undefined,
      now: () => 1,
    });
    const heard: Payment[][] = [];
    s.onPayments((changed) => heard.push(changed));
    const first = s.settle('asked');
    await expect(first).rejects.toThrow(/closed/);
    await flush();
    expect(s.last()).toBeNull();
    expect(heard).toEqual([]);
    expect(s.waiting()).toBe(false);
    const second = s.settle('asked');
    expect(second).not.toBe(first);
    await expect(second).rejects.toThrow(/closed/);
  });

  it('a payment the till was checking, now paid, is told once', async () => {
    const t = make(
      [
        async () => [pay('pay:0', { state: 'delivered' })],
        async () => [pay('pay:0', { state: 'delivered' })],
        async () => [pay('pay:0', { state: 'delivered' })],
      ],
      [
        [pay('pay:0', { state: 'taking' })],
        [pay('pay:0', { state: 'delivered' })],
        [pay('pay:0', { state: 'taking' })],
      ],
    );
    await t.s.settle('asked');
    expect(t.s.notices()).toEqual([
      {
        paymentId: 'pay:0',
        words: "14 sats · PAID. Paid and kept in this phone's wallet. " + nowPaidWords(0),
      },
    ]);
    await t.s.settle('asked');
    expect(t.s.notices().length).toBe(1);
    t.s.seen();
    expect(t.s.notices()).toEqual([]);
    await t.s.settle('asked');
    expect(t.s.notices()).toEqual([]);
  });

  it('a loss, a payment paid twice and money owed to a card are told, in order', async () => {
    const t = make(
      [
        async () => [
          pay('pay:1', { state: 'gone' }),
          pay('pay:2', { state: 'spent-not-restored' }),
          pay('pay:3', { state: 'held', extra: 'paid-twice' }),
          pay('pay:4', { state: 'returned', extra: 'late', owedToCard: 13 }),
          pay('pay:5', { state: 'held', why: 'under-least' }),
        ],
      ],
      [[]],
    );
    await t.s.settle('asked');
    expect(t.s.notices().map((n) => n.paymentId)).toEqual(['pay:1', 'pay:2', 'pay:3', 'pay:4']);
  });

  it('every notice waits until it is seen; none is dropped, and Seen drops only those shown', async () => {
    const t = make([async () => Array.from({ length: 12 }, (_, i) => pay('pay:' + i, { state: 'gone' }))]);
    await t.s.settle('asked');
    expect(t.s.notices().length).toBe(12);
    expect(t.s.notices()[0].paymentId).toBe('pay:0');
    t.s.seen(10);
    expect(t.s.notices().map((n) => n.paymentId)).toEqual(['pay:10', 'pay:11']);
    t.s.seen(5);
    expect(t.s.notices()).toEqual([]);
  });

  it('nothing told holds a token', async () => {
    const t = make([async () => [pay('pay:1', { state: 'gone', change: 'cashuB' + 'x'.repeat(60) })]]);
    await t.s.settle('asked');
    expect(JSON.stringify(t.s.notices())).not.toContain('cashu');
    expect(JSON.stringify(t.s.last())).not.toContain('cashu');
  });
});
