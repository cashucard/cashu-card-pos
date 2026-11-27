/* The Activity's reads through the till service (slice 1.4): open claims, the rows kept as they are, and the paymentIds
 * the kept notices named as maybe paid twice. Each is a read through read(): outside the queue, never a job, nothing
 * before the till is open, and no log line. */

import { open, type CashuCard, type Claim, type Journal, type Payment, type Row } from 'cashucard';
import { createTillService, nowPaidIds, TillNotOpenError, type TillServiceDeps } from '../src/till/service';
import type { ActivityReader } from '../src/app/activity';
import { TILL_NAMES } from '../src/till/store/types';
import { TILL_SETTINGS } from '../src/till/settings';
import { fakeStoreDeps, type FakeStore } from './helpers/fake-store';
import { fakeMint } from './helpers/fake-mint';
import { heldPayment } from './helpers/fake-till';

interface MakeOptions {
  /** when given, the library's openClaims() answers this */
  claims?: () => Claim[];
  /** when given, the library's payments() answers this */
  payments?: () => Payment[];
  /** when given, the library's settle() answers the next of these ([] when none) */
  steps?: Array<(k: CashuCard) => Promise<Payment[]>>;
  /** the store to open (a relaunch passes the earlier one's) */
  f?: FakeStore;
  extra?: Partial<TillServiceDeps>;
}
function make(o: MakeOptions = {}) {
  const f = o.f ?? fakeStoreDeps();
  const mint = fakeMint();
  const logs: string[] = [];
  const service = createTillService({
    store: f.deps, names: TILL_NAMES, settingsNames: TILL_SETTINGS, http: mint.http, now: () => 1000,
    log: (l) => logs.push(l), random: () => 0.25,
    openLibrary: async (c) => {
      const k = await open(c);
      if (o.claims !== undefined) {
        const cl = o.claims;
        k.openClaims = async () => cl();
      }
      if (o.payments !== undefined) {
        const pays = o.payments;
        k.payments = async () => pays();
      }
      if (o.steps !== undefined) {
        const steps = o.steps;
        k.settle = async () => {
          const next = steps.shift();
          return next === undefined ? [] : next(k);
        };
      }
      return k;
    },
    ...o.extra,
  });
  return { f, mint, service, logs };
}
async function ready(t: ReturnType<typeof make>): Promise<void> {
  await t.service.open();
  await t.service.addMint(await t.service.checkMint('mint.test'));
}
/** The journal, with `rows` added to what list() answers (never written): the library lists them as it finds them. */
function withRows(inner: Journal, rows: Row[]): Journal {
  const j: Journal = {
    write: (row: Row) => inner.write(row),
    read: (id: string) => inner.read(id),
    list: async () => [...(await inner.list()), ...rows],
  };
  const insert = inner.insert;
  if (insert !== undefined) {
    j.insert = (row: Row) => insert.call(inner, row);
  }
  const remove = inner.remove;
  if (remove !== undefined) {
    j.remove = (id: string) => remove.call(inner, id);
  }
  return j;
}
const OLDER = { id: 'old-1', kind: 'pool', pool: true } as unknown as Row;
const DAMAGED = { id: 'pay:bad', kind: 'payment' } as unknown as Row;
const C: Claim = { id: 'pay:c1', sale: 's-1', cardKey: '02' + 'c'.repeat(64), mint: 'https://mint.test', unit: 'sat',
  amount: 15, fee: 1, price: 14, step: 'released', at: 5, asks: 2, misses: 0 };

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

const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

describe('the till service reads the record for the Activity', () => {
  it('a new record has no claims and no rows kept as they are', async () => {
    const t = make();
    await ready(t);
    expect(await t.service.openClaims()).toEqual([]);
    expect(await t.service.olderRows()).toEqual([]);
    expect(await t.service.damagedRows()).toEqual([]);
    expect(await t.service.maybePaidTwice()).toEqual([]);
  });

  it('rows of an earlier version and rows that do not read are listed, by what they are', async () => {
    const t = make({ extra: { devJournal: (j) => withRows(j, [OLDER, DAMAGED]) } });
    await ready(t);
    expect(await t.service.olderRows()).toEqual([{ id: 'old-1', why: 'a pooled payment' }]);
    const damaged = await t.service.damagedRows();
    expect(damaged.length).toBe(1);
    expect(damaged[0].id).toBe('pay:bad');
    expect(damaged[0].why).toBe('a payment without its sale, way, step, state, amount or mint');
    expect(await t.service.payments()).toEqual([]);
  });

  it("open claims are the library's own, as it answers them", async () => {
    const t = make({ claims: () => [C] });
    await ready(t);
    expect(await t.service.openClaims()).toEqual([C]);
  });

  it('the reads run outside the queue, and never wait for a tap', async () => {
    const t = make({ claims: () => [C] });
    await ready(t);
    const g = deferred<void>();
    const held = t.service.withCard('card', () => g.promise);
    await flush();
    expect(t.service.queue.tapOpen()).toBe(true);
    expect(await t.service.openClaims()).toEqual([C]);
    expect(await t.service.olderRows()).toEqual([]);
    expect(await t.service.damagedRows()).toEqual([]);
    expect(await t.service.payments()).toEqual([]);
    expect(await t.service.maybePaidTwice()).toEqual([]);
    expect(t.service.queue.tapOpen()).toBe(true);
    g.resolve(undefined);
    await held;
  });

  it('a read is never a job', async () => {
    const t = make();
    await ready(t);
    const kinds: string[] = [];
    const realRun = t.service.queue.run.bind(t.service.queue);
    t.service.queue.run = ((kind: string, f: () => Promise<unknown>) => {
      kinds.push(kind);
      return realRun(kind as Parameters<typeof realRun>[0], f);
    }) as unknown as typeof t.service.queue.run;
    await t.service.openClaims();
    await t.service.olderRows();
    await t.service.damagedRows();
    await t.service.payments();
    await t.service.maybePaidTwice();
    expect(kinds).toEqual([]);
  });

  it('nothing is read before the till is open', async () => {
    const t = make();
    await expect(t.service.openClaims()).rejects.toBeInstanceOf(TillNotOpenError);
    await expect(t.service.olderRows()).rejects.toBeInstanceOf(TillNotOpenError);
    await expect(t.service.damagedRows()).rejects.toBeInstanceOf(TillNotOpenError);
    await expect(t.service.maybePaidTwice()).rejects.toBeInstanceOf(TillNotOpenError);
  });

  it('the service logs nothing of a read', async () => {
    const t = make({ claims: () => [C] });
    await ready(t);
    await t.service.openClaims();
    await t.service.olderRows();
    await t.service.damagedRows();
    await t.service.maybePaidTwice();
    expect(t.logs.length).toBeGreaterThan(0);
    for (const line of t.logs) {
      expect(line).toMatch(/^till: (opening|ready)$/);
    }
  });

  it('the service is an activity reader', async () => {
    const t = make();
    await ready(t);
    const r: ActivityReader = t.service;
    expect(typeof r.openClaims).toBe('function');
    expect(typeof r.maybePaidTwice).toBe('function');
  });
});

describe('the may be paid twice mark', () => {
  it('only a notice that a payment was paid after its sale ended names it as maybe paid twice', () => {
    expect(
      nowPaidIds([
        'pay:a|delivered|',
        'pay:b|held|',
        'pay:c|held|paid-twice',
        'pay:d|held|late',
        'pay:e|gone|',
        'pay:f|returned|late',
        'pay:g|written|0',
        'pay:h|spent-not-restored|',
        'pay:a|delivered|',
        'pay:i|delivered|late',
        'nonsense',
        '|held|',
      ]),
    ).toEqual(['pay:a', 'pay:b', 'pay:i']);
    expect(nowPaidIds([])).toEqual([]);
  });

  it('a payment told as maybe paid twice is read from the notices kept, also after a relaunch, and Seen does not drop it', async () => {
    let pays: Payment[] = [{ ...heldPayment('s1'), paymentId: 'pay:07', state: 'taking' }];
    const t = make({
      payments: () => pays,
      steps: [async () => [{ ...heldPayment('s1'), paymentId: 'pay:07', state: 'delivered' }]],
    });
    await ready(t);
    expect(await t.service.maybePaidTwice()).toEqual([]);
    await t.service.settleNow('asked');
    expect(t.service.notices().map((n) => n.words.endsWith('If the customer paid that sale another way too, it is paid twice.'))).toEqual([true]);
    expect(await t.service.maybePaidTwice()).toEqual(['pay:07']);
    t.service.noticesSeen();
    await flush();
    expect(await t.service.maybePaidTwice()).toEqual(['pay:07']);
    await t.service.close();

    // the next launch, over the same store: nothing of it is in memory, the kept notices still name it
    pays = [{ ...heldPayment('s1'), paymentId: 'pay:07', state: 'delivered' }];
    const u = make({ f: t.f, payments: () => pays });
    expect((await u.service.open()).kind).toBe('ready');
    expect(u.service.notices()).toEqual([]);
    expect(await u.service.maybePaidTwice()).toEqual(['pay:07']);
  });

  it('a payment paid twice by its state, or a loss, is not named as maybe paid twice', async () => {
    const pays: Payment[] = [
      { ...heldPayment('s1'), paymentId: 'pay:08', state: 'taking' },
      { ...heldPayment('s2'), paymentId: 'pay:09', state: 'taking' },
    ];
    const t = make({
      payments: () => pays,
      steps: [async () => [
        { ...heldPayment('s1'), paymentId: 'pay:08', state: 'held', extra: 'paid-twice' },
        { ...heldPayment('s2'), paymentId: 'pay:09', state: 'spent-not-restored' },
      ]],
    });
    await ready(t);
    await t.service.settleNow('asked');
    expect(t.service.notices().length).toBe(2);
    expect(await t.service.maybePaidTwice()).toEqual([]);
  });
});
