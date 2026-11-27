/* How far one archive job reaches (slice 2.3 review; slice 2.3b for cashucard 0.3.0), over the real library. The till
 * copies the library's rule (readySales) to count each job, and holds the library's clock still while it archives, so
 * archive() cuts exactly where the till placed the cut. Held here: the till's count is the library's own, rule by rule;
 * a job takes at most 100 payment rows even when the library reads its clock seconds after the till; sales that cannot
 * be archived take no place and never stop a job; a sale withdrawn with no payment at all goes. */

import { open, walletPayout, type CashuCard, type HttpFetch, type Row } from 'cashucard';
import { DAY_MS, readySales, unreadSales } from '../src/till/archive';
import { createSchema, createSerial, openDatabase } from '../src/till/store/db';
import { SqliteJournal } from '../src/till/store/journal';
import { SQL } from '../src/till/store/sql';
import type { SqlDriver } from '../src/till/store/types';
import { archiveTill, delivered, held, NOW } from './helpers/archive-till';
import { fakeDisk } from './helpers/fake-sql';

type R = Record<string, unknown>;
const F = require('./fixtures/archive-rows.json') as { held: R[]; delivered: R[] };
const KEY = 'ef'.repeat(32);
const http: HttpFetch = async () => {
  throw new Error('no fetch expected');
};

function copyOf(kind: string): R {
  const r = F.delivered.find((x) => x.kind === kind);
  if (r === undefined) {
    throw new Error('the fixture has no ' + kind + ' row');
  }
  return JSON.parse(JSON.stringify(r)) as R;
}

/** Sale `id`'s row, opened at `at`, with `o` over it. */
function saleRow(id: string, at: number, o: R = {}): Row {
  const s = copyOf('sale');
  return { ...s, id: 'sale:' + id, sale: { ...(s.sale as R), id }, at, ...o } as unknown as Row;
}

let next = 0;
/** A payment row of sale `id`: the fixture's delivered card payment, begun and held at `at`, with `o` over it. */
function pay(id: string, at: number, o: R = {}): Row {
  next += 1;
  return {
    ...copyOf('payment'),
    id: 'pay:' + String(next).padStart(32, '0'),
    sale: id,
    at,
    heldAt: at,
    ...o,
  } as unknown as Row;
}
const refusedAt = (id: string, at: number): Row => pay(id, at, { state: 'none', step: 'refused', heldAt: undefined });

/** A journal over the store's SQLite holding `rows` (and rows of raw bodies), and the library over it at NOW. */
async function setup(rows: Row[], raw: Array<[string, string, string]> = []): Promise<{ j: SqliteJournal; c: CashuCard }> {
  const disk = fakeDisk();
  const { driver } = await openDatabase(disk.opener, '/d', 'r.db', KEY);
  await createSchema(driver);
  const j = new SqliteJournal(driver, createSerial(), () => NOW);
  for (const r of rows) {
    await j.write(r);
  }
  for (const [id, kind, body] of raw) {
    await (driver as SqlDriver).run(SQL.journalUpsert, [id, kind, 0, body, NOW]);
  }
  const c = await open({
    journal: j,
    payout: walletPayout({ mints: [], keep: async () => undefined }),
    http,
    leftoverByPin: false,
    clock: null,
    now: () => NOW,
  });
  return { j, c };
}

/** At a cut `days` back: the sales the till counts as going (its copy of the rule, from the record as the service
 * reads it), and the sales the library's archive() then takes. */
async function both(j: SqliteJournal, c: CashuCard, days: number): Promise<{ till: string[]; library: string[] }> {
  const ids = [...(await c.damagedRows()), ...(await c.olderRows())].map((r) => r.id);
  const skip = new Set(ids);
  const ready = readySales(
    (await j.paymentFacts()).filter((f) => !skip.has(f.id)),
    (await j.saleFacts()).filter((s) => !skip.has('sale:' + s.id)),
    unreadSales(await j.rowsOf(ids)),
  );
  const before = NOW - days * DAY_MS;
  const till = ready.filter((r) => r.place <= before).map((r) => r.sale).sort();
  const library = (await c.archive(days)).filter((r) => r.kind === 'sale').map((r) => r.sale).sort();
  return { till, library };
}

describe("the till counts each job as cashucard 0.3.0's archive() takes it", () => {
  it('rule by rule: paid, held, withdrawn, open, closed with no payment, evidence, owed change, marked, recent', async () => {
    const old = NOW - 5 * DAY_MS;
    const { j, c } = await setup([
      saleRow('d1', old),
      pay('d1', old),
      saleRow('h2', old),
      pay('h2', old, { state: 'held' }),
      saleRow('w3', old, { closed: 'withdrawn', closedAt: NOW - 2 * DAY_MS }),
      refusedAt('w3', old),
      saleRow('o4', old),
      refusedAt('o4', old),
      saleRow('e5', old, { closed: 'paid', closedAt: NOW - 3 * DAY_MS }),
      saleRow('n6', old),
      saleRow('ev7', old),
      pay('ev7', old, { plan: { ...(copyOf('payment').plan as R), inputs: [{ secret: 'zz' }] } }),
      saleRow('c8', old),
      pay('c8', old, { state: 'taking', step: 'sign-asked', heldAt: undefined, plan: { ...(copyOf('payment').plan as R), inputs: [{ secret: 'zz' }] } }),
      saleRow('ow9', old),
      pay('ow9', old, { cardChange: [{ amount: 2, B_: 'b', K: 'k', C_: 'c', dleq: null, written: false }] }),
      saleRow('m13', old, { archived: NOW }),
      pay('m13', NOW + DAY_MS),
      saleRow('r14', NOW - 3600000),
      pay('r14', NOW - 3600000),
    ]);
    const a = await both(j, c, 1);
    expect(a.till).toEqual(a.library);
    expect(a.library).toEqual(['d1', 'e5', 'm13', 'w3']);
    const b = await both(j, c, 0);
    expect(b.till).toEqual(b.library);
    expect(b.library).toEqual(['r14']);
  });

  it('a row the library does not read holds back the sale it names', async () => {
    const old = NOW - 5 * DAY_MS;
    const damaged = pay('u10', old) as unknown as R;
    delete damaged.mint;
    const { j, c } = await setup(
      [saleRow('u10', old), pay('u10', old), saleRow('d11', old), pay('d11', old)],
      [[damaged.id as string, 'payment', JSON.stringify(damaged)]],
    );
    const a = await both(j, c, 0);
    expect(a.till).toEqual(a.library);
    expect(a.library).toEqual(['d11']);
  });

  it('a row that names no sale holds back every sale with nothing counted for it, never a paid one', async () => {
    const old = NOW - 5 * DAY_MS;
    const { j, c } = await setup(
      [
        saleRow('w12', old, { closed: 'withdrawn', closedAt: old }),
        refusedAt('w12', old),
        saleRow('d13', old),
        pay('d13', old),
        saleRow('e14', old, { closed: 'paid', closedAt: old }),
      ],
      [['pay:broken', 'payment', '{"sale":']],
    );
    const a = await both(j, c, 0);
    expect(a.till).toEqual(a.library);
    expect(a.library).toEqual(['d13']);
  });

  it('a row with no id of its own is left out of the count, as the library leaves it out; a row is named by its own id', async () => {
    const old = NOW - 5 * DAY_MS;
    // sale u15's payment, a claim, in a body with no id: the library does not read it (it names it ''), so its secrets
    // are no evidence; they are the fixture's, as d16's are
    const noId = pay('u15', old, { state: 'taking', step: 'sign-asked', heldAt: undefined }) as unknown as R;
    const column = noId.id as string;
    delete noId.id;
    // sale v17's only payment, delivered, in a row whose body names an id other than the row's: the library reads it
    const elsewhere = pay('v17', old) as unknown as R;
    const own = elsewhere.id as string;
    elsewhere.id = 'pay:' + String(9917).padStart(32, '0');
    const { j, c } = await setup(
      [saleRow('u15', old), saleRow('d16', old), pay('d16', old), saleRow('v17', old)],
      [
        [column, 'payment', JSON.stringify(noId)],
        [own, 'payment', JSON.stringify(elsewhere)],
      ],
    );
    expect(await c.damagedRows()).toEqual([{ id: '', why: 'no id' }]);
    const a = await both(j, c, 0);
    expect(a.till).toEqual(a.library);
    expect(a.library).toEqual(['d16', 'v17']);
  });

  it('rule by rule, the rest: exported, gone, extra, evidence by a loss, unconfirmed change, abandoned, held or closed late', async () => {
    const old = NOW - 5 * DAY_MS;
    const late = NOW - 3600000;
    const plan = (secret: string): R => ({ ...(copyOf('payment').plan as R), inputs: [{ secret }] });
    const { j, c } = await setup([
      saleRow('x20', old),
      pay('x20', old, { state: 'exported' }),
      saleRow('g21', old),
      pay('g21', old, { state: 'gone' }),
      saleRow('g22', old),
      pay('g22', old, { state: 'gone', how: 'ecash' }),
      saleRow('e23', old),
      pay('e23', old),
      pay('e23', old, { extra: 'late' }),
      saleRow('l24', old),
      pay('l24', old, { state: 'lost', plan: plan('yy') }),
      saleRow('k25', old),
      pay('k25', old, { plan: plan('yy') }),
      saleRow('s26', old),
      pay('s26', old, { state: 'spent-not-restored', step: 'spent-not-restored', plan: plan('xx') }),
      saleRow('k27', old),
      pay('k27', old, { plan: plan('xx') }),
      saleRow('u28', old),
      pay('u28', old, { cardChange: [{ amount: 2, B_: 'b', K: 'k', C_: 'c', dleq: null, written: true }] }),
      saleRow('a29', old, { closed: 'withdrawn', closedAt: old }),
      pay('a29', old, { state: 'none', step: 'abandoned', heldAt: undefined }),
      saleRow('o30', old),
      pay('o30', old, { state: 'none', step: 'abandoned', heldAt: undefined }),
      saleRow('h31', old),
      pay('h31', old, { heldAt: late }),
      saleRow('c32', old, { closed: 'withdrawn', closedAt: late }),
      refusedAt('c32', old),
    ]);
    const a = await both(j, c, 1);
    expect(a.till).toEqual(a.library);
    expect(a.library).toEqual(['a29', 'g22', 'x20']);
    const b = await both(j, c, 0);
    expect(b.till).toEqual(b.library);
    expect(b.library).toEqual(['c32', 'h31']);
  });
});

describe('archive jobs over the real library', () => {
  it('one job takes at most 100 payments, even when hundreds held before its reach were delivered after it', async () => {
    // 100 sales held and delivered now; then 400 sales held five days ago whose rows were written after them (their
    // mint was down; the settle after it came back delivered them)
    const t = await archiveTill(
      () => [
        ...Array.from({ length: 100 }, (_, i) => delivered(i + 1, NOW + i * 1000)),
        ...Array.from({ length: 400 }, (_, i) => delivered(1000 + i, NOW - 5 * DAY_MS + i * 1000)),
      ],
      { auto: false },
    );
    const n = await t.service.archiveNow('asked');
    const jobs = t.notes.filter((x) => x.scope === 'job').map((x) => x.n.payments);
    expect(Math.max(...jobs)).toBeLessThanOrEqual(100);
    expect(jobs.slice(0, 5)).toEqual([100, 100, 100, 100, 100]);
    expect(n).toMatchObject({ payments: 500, ok: true });
    expect(await t.service.payments()).toEqual([]);
    await t.service.close();
  }, 60000);

  it('every job takes exactly what the till counted, even when the library reads its clock seconds after the till', async () => {
    // 300 sales 10 ms apart; the library's fence reads its clock 10 s after the till placed the cut
    const t = await archiveTill(() => Array.from({ length: 300 }, (_, i) => delivered(i + 1, NOW + i * 10)), {
      auto: false,
      drift: 10000,
    });
    const n = await t.service.archiveNow('asked');
    const jobs = t.notes.filter((x) => x.scope === 'job').map((x) => x.n.payments);
    expect(jobs).toEqual([100, 100, 100, 0]);
    expect(n).toMatchObject({ payments: 300, ok: true });
    await t.service.close();
  }, 60000);

  it('old sales that cannot be archived take no place: the jobs archive the rest, then stop', async () => {
    const t = await archiveTill(
      () => [
        ...Array.from({ length: 150 }, (_, i) => held(i + 1, NOW - DAY_MS + i * 1000)),
        ...Array.from({ length: 120 }, (_, i) => delivered(i + 1, NOW + i * 1000)),
      ],
      { auto: false },
    );
    const n = await t.service.archiveNow('asked');
    const jobs = t.notes.filter((x) => x.scope === 'job').map((x) => x.n.payments);
    expect(jobs).toEqual([100, 20, 0]);
    expect(n).toMatchObject({ payments: 120, ok: true });
    expect((await t.service.payments()).map((p) => p.state)).toEqual(Array.from({ length: 150 }, () => 'held'));
    await t.service.close();
  }, 60000);

  it('a sale withdrawn with no payment at all goes, its own row with it', async () => {
    const t = await archiveTill(() => [], { auto: false, mint: true });
    const id = await t.service.openSale(14);
    await t.service.withdrawSale(id);
    t.clock.now += 1000;
    const n = await t.service.archiveNow('asked');
    expect(n).toMatchObject({ payments: 0, rows: 1, ok: true });
    expect(await t.service.isArchived('sale:' + id)).toBe(true);
    await t.service.close();
  }, 60000);
});
