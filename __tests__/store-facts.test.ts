/* What the store reads of the record for the archive (slice 2.3b), held to the real library cashucard 0.3.0: each
 * payment row's facts, its amounts owed to and unconfirmed on its card exactly as the library's own Payment gives
 * them, the secrets its plan spends; each sale row's facts; and the kind and the sale named by each row the library
 * does not read. The rows are the library's own (the scaffold's fixture), copied under new ids. */

import { open, walletPayout, type HttpFetch, type Row } from 'cashucard';
import { createSchema, createSerial, openDatabase } from '../src/till/store/db';
import { SqliteJournal } from '../src/till/store/journal';
import { SQL } from '../src/till/store/sql';
import type { SqlDriver } from '../src/till/store/types';
import { fakeDisk } from './helpers/fake-sql';

type R = Record<string, unknown>;
const F = require('./fixtures/archive-rows.json') as { held: R[]; delivered: R[] };
const KEY = 'cd'.repeat(32);
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

/** Payment n of sale a-n, as the fixture's delivered payment, with `o` over it. */
function payment(n: number, o: R = {}): Row {
  return { ...copyOf('payment'), id: 'pay:' + String(n).padStart(32, '0'), sale: 'a-' + n, ...o } as unknown as Row;
}

/** Sale a-n's row, as the fixture's, with `o` over it. */
function sale(n: number, o: R = {}): Row {
  const s = copyOf('sale');
  return { ...s, id: 'sale:a-' + n, sale: { ...(s.sale as R), id: 'a-' + n }, ...o } as unknown as Row;
}

const piece = (amount: number, o: R = {}): R => ({
  id: 'k',
  keyset: 'k',
  amount,
  nonce: 'n',
  C: 'c',
  date: 0,
  dleq: null,
  written: false,
  ...o,
});
const change = (amount: number, o: R = {}): R => ({ amount, B_: 'b', K: 'k', C_: 'c', dleq: null, written: false, ...o });

async function setup(): Promise<{ j: SqliteJournal; driver: SqlDriver }> {
  const disk = fakeDisk();
  const { driver } = await openDatabase(disk.opener, '/d', 'f.db', KEY);
  await createSchema(driver);
  return { j: new SqliteJournal(driver, createSerial(), () => 1000), driver };
}

const libraryOver = (journal: SqliteJournal) =>
  open({ journal, payout: walletPayout({ mints: [], keep: async () => undefined }), http, leftoverByPin: false, clock: null });

describe('what the store reads of the record for the archive', () => {
  it("a payment's amounts owed to and unconfirmed on its card are the library's own", async () => {
    const { j } = await setup();
    const rows = [
      payment(1),
      payment(2, {
        owed: [{ state: 'locked', since: 1, amount: 3, pieces: [piece(2), piece(1, { written: true })] }],
        cardChange: [change(4), change(8, { written: true })],
      }),
      payment(3, {
        owed: [
          { state: 'kept', since: 1, amount: 5, pieces: [] },
          { state: 'written', since: 1, amount: 6, pieces: [piece(6, { written: true, spent: true })] },
        ],
        cardChange: [change(16, { written: true, confirmed: true }), change(32, { written: true, gone: true })],
      }),
      payment(4, {
        owed: [{ state: 'stuck', since: 1, amount: 7, pieces: [piece(7), piece(9, { written: true, bad: true })] }],
      }),
    ];
    for (const r of rows) {
      await j.write(r);
    }
    const facts = await j.paymentFacts();
    const c = await libraryOver(j);
    const pays = await c.payments();
    expect(pays).toHaveLength(4);
    for (const p of pays) {
      const f = facts.find((x) => x.id === p.paymentId)!;
      expect({ owed: f.owed, unconfirmed: f.unconfirmed }).toEqual({ owed: p.owedToCard, unconfirmed: p.unconfirmed });
    }
    expect(facts.map((f) => [f.id.slice(-1), f.owed, f.unconfirmed])).toEqual([
      ['1', 0, 0],
      ['2', 6, 9],
      ['3', 0, 0],
      ['4', 7, 0],
    ]);
  });

  it('a row that took nothing gives its amounts too, and every row the secrets its plan spends', async () => {
    const { j } = await setup();
    const fixture = copyOf('payment');
    const secrets = ((fixture.plan as R).inputs as R[]).map((i) => i.secret);
    await j.write(payment(1, { state: 'none', step: 'refused', cardChange: [change(3)] }));
    const noPlan = payment(2) as unknown as R;
    delete noPlan.plan;
    await j.write(noPlan as unknown as Row);
    const facts = await j.paymentFacts();
    expect(facts.map((f) => [f.state, f.owed, f.unconfirmed])).toEqual([
      ['none', 3, 0],
      ['delivered', 0, 0],
    ]);
    expect(facts[0].inputs).toEqual(secrets);
    expect(secrets.length).toBeGreaterThan(0);
    expect(facts[1].inputs).toEqual([]);
  });

  it("each sale row's facts: when it was opened, whether and when it was closed, whether an archive marked it", async () => {
    const { j, driver } = await setup();
    await j.write(sale(1, { at: 100 }));
    await j.write(sale(2, { at: 200, closed: 'withdrawn', closedAt: 250 }));
    await j.write(sale(3, { at: 300, closed: 'paid', closedAt: 350, archived: 400 }));
    await driver.run(SQL.journalUpsert, ['sale:a-4', 'sale', 0, '{"kind":"sale",', 1]);
    expect(await j.saleFacts()).toEqual([
      { id: 'a-1', at: 100, closed: false, closedAt: 0, archived: false },
      { id: 'a-2', at: 200, closed: true, closedAt: 250, archived: false },
      { id: 'a-3', at: 300, closed: true, closedAt: 350, archived: true },
    ]);
  });

  it('the kind and the sale each row the library does not read names, as its body holds them', async () => {
    const { j, driver } = await setup();
    await j.write(sale(1));
    await j.write(payment(1));
    // a payment of this version with no mint (damaged), a row whose body is not JSON (an earlier or broken one)
    const damaged = payment(2) as unknown as R;
    delete damaged.mint;
    await driver.run(SQL.journalUpsert, [damaged.id as string, 'payment', 0, JSON.stringify(damaged), 1]);
    await driver.run(SQL.journalUpsert, ['pay:broken', 'payment', 0, '{"sale":', 1]);
    const c = await libraryOver(j);
    const ids = [...(await c.damagedRows()), ...(await c.olderRows())].map((r) => r.id).sort();
    expect(ids).toEqual([damaged.id as string, 'pay:broken'].sort());
    const rows = await j.rowsOf([...ids, 'pay:not-kept']);
    expect(rows.sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual(
      [
        { id: damaged.id as string, kind: 'payment', sale: 'a-2' },
        { id: 'pay:broken', kind: null, sale: null },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  });
});
