/* Sales the till leaves open are withdrawn (slice 2.3b), over the real library cashucard 0.3.0 and the real store. The
 * library never archives an open sale that took nothing, so one left open would stay in the record for good. The till
 * withdraws (close(false)) the sale its sale screen left when the next one opens, and once per launch the sales an
 * earlier run left open (the app killed during a sale), but only when nothing counts for the sale: a sale with a
 * payment the library lists (held, or a claim its card may have signed) is left as it is, so no claim is lost. A new
 * sale never takes an id the archive holds. */

import { CardError, type CardListener, type Payment } from 'cashucard';
import { DAY_MS } from '../src/till/archive';
import { LEFT_SALES_MOST, newSaleId, SALE_ID_TRIES } from '../src/till/service';
import { archiveTill, held, NOW, PATH, refused, type ArchiveTill } from './helpers/archive-till';
import { dump } from './helpers/fake-sql';
import { fakeTransport } from './helpers/fake-till';

type R = Record<string, unknown>;
const F = require('./fixtures/archive-rows.json') as { held: R[]; delivered: R[] };
const listener: CardListener = { confirm: async () => ({ pay: false }) };
/** the customer's card refuses: nothing is taken, and no row is written */
const declined = async (): Promise<Payment> => {
  throw new CardError('declined', 'The card refused. Nothing was taken.');
};

const db = (t: ArchiveTill) => t.f.disk.files.get(PATH)!.db;

/** The sale's row as the journal keeps it, or undefined. */
function saleRow(t: ArchiveTill, saleId: string): R | undefined {
  const r = dump(db(t), 'journal').find((x) => x.id === 'sale:' + saleId);
  return r === undefined ? undefined : (JSON.parse(String(r.body)) as R);
}

/** The captured held sale as sale n, its payment a claim its card may have signed (taking, sign-asked): it counts. */
function claimed(n: number, at: number) {
  const rows = held(n, at) as unknown as R[];
  rows[1].state = 'taking';
  rows[1].step = 'sign-asked';
  delete rows[1].heldAt;
  return rows as unknown as ReturnType<typeof held>;
}

/** The captured held sale as sale n, its payment a claim the card let go (released): it took nothing, so payments()
 * does not list it, but it is an open claim the card may yet sign for. */
function released(n: number, at: number) {
  const rows = held(n, at) as unknown as R[];
  rows[1].state = 'none';
  rows[1].step = 'released';
  delete rows[1].heldAt;
  return rows as unknown as ReturnType<typeof held>;
}

/** Writes, as if the library had, a payment row of the sale in `state` at `step`: the fixture's held payment. */
function payFor(t: ArchiveTill, saleId: string, n: number, state: string, step: string): void {
  const p = JSON.parse(JSON.stringify(F.held.find((x) => x.kind === 'payment'))) as R;
  p.id = 'pay:' + String(8000 + n).padStart(32, '0');
  p.sale = saleId;
  p.state = state;
  p.step = step;
  db(t)
    .prepare('INSERT INTO journal (id, kind, gen, body, written_at) VALUES (?, ?, ?, ?, ?)')
    .run(p.id as string, 'payment', 0, JSON.stringify(p), t.clock.now);
}

describe('sales the till leaves open', () => {
  it('the sale left after a refused tap is withdrawn when the next sale opens', async () => {
    const t = await archiveTill(() => [], { auto: false, mint: true, card: [declined] });
    const first = await t.service.openSale(14);
    await expect(t.service.takeCard(first, fakeTransport(), listener)).rejects.toBeInstanceOf(CardError);
    expect(saleRow(t, first)?.closed).toBeUndefined();
    t.clock.now += 1000;
    const second = await t.service.openSale(21);
    expect(second).not.toBe(first);
    expect(saleRow(t, first)?.closed).toBe('withdrawn');
    expect(saleRow(t, second)?.closed).toBeUndefined();
    await t.service.close();
  }, 60000);

  it('a sale with a held payment, or a claim its card may have signed, is never withdrawn when the next one opens', async () => {
    for (const [state, step] of [
      ['held', 'swapped'],
      ['taking', 'sign-asked'],
    ]) {
      const t = await archiveTill(() => [], { auto: false, mint: true, card: [declined] });
      const first = await t.service.openSale(14);
      await expect(t.service.takeCard(first, fakeTransport(), listener)).rejects.toBeInstanceOf(CardError);
      payFor(t, first, 1, state, step);
      t.clock.now += 1000;
      await t.service.openSale(21);
      expect(saleRow(t, first)?.closed).toBeUndefined();
      expect((await t.service.payments()).filter((p) => p.id === first).map((p) => p.state)).toEqual([state]);
      await t.service.close();
    }
  }, 60000);

  it('a sale whose claim the card let go (released) is never withdrawn, when the next one opens or the screen leaves it', async () => {
    const t = await archiveTill(() => [], { auto: false, mint: true, card: [declined, declined] });
    const first = await t.service.openSale(14);
    await expect(t.service.takeCard(first, fakeTransport(), listener)).rejects.toBeInstanceOf(CardError);
    payFor(t, first, 1, 'none', 'released');
    t.clock.now += 1000;
    const second = await t.service.openSale(21);
    expect(saleRow(t, first)?.closed).toBeUndefined();
    await expect(t.service.takeCard(second, fakeTransport(), listener)).rejects.toBeInstanceOf(CardError);
    payFor(t, second, 2, 'none', 'released');
    await t.service.leaveSale(second);
    expect(saleRow(t, second)?.closed).toBeUndefined();
    expect((await t.service.payments()).filter((p) => p.id === first || p.id === second)).toEqual([]);
    await t.service.close();
  }, 60000);

  it('at a launch, after its first settle, the sales an earlier run left open are withdrawn when nothing counts for them', async () => {
    const t = await archiveTill(
      () => [
        refused(1, NOW - DAY_MS),
        refused(2, NOW - DAY_MS + 1000),
        claimed(3, NOW - DAY_MS + 2000),
        released(4, NOW - DAY_MS + 3000),
      ],
      { auto: false, mint: true },
    );
    expect(LEFT_SALES_MOST).toBe(10);
    await t.service.settleNow('launch');
    expect(saleRow(t, 'r-1')?.closed).toBe('withdrawn');
    expect(saleRow(t, 'r-2')?.closed).toBe('withdrawn');
    expect(saleRow(t, 'h-3')?.closed).toBeUndefined();
    expect(saleRow(t, 'h-4')?.closed).toBeUndefined();
    // once per launch: a sale opened in this run and left is withdrawn by the next opening, never by a later settle
    const mine = await t.service.openSale(14);
    await t.service.settleNow('asked');
    expect(saleRow(t, mine)?.closed).toBeUndefined();
    await t.service.close();
  }, 60000);

  it('a new sale never takes an id the archive holds', async () => {
    const t = await archiveTill(() => [], { auto: false, mint: true });
    // the id the till draws now (its random is fixed at 0.25 in these tests), as an archive would hold it
    const taken = newSaleId(t.clock.now, () => 0.25);
    db(t)
      .prepare('INSERT INTO archive (id, kind, gen, written_at, archived_at, body) VALUES (?, ?, ?, ?, ?, ?)')
      .run('sale:' + taken, 'sale', 1, 1, 1, '{}');
    expect(SALE_ID_TRIES).toBe(5);
    await expect(t.service.openSale(14)).rejects.toMatchObject({ kind: 'same-sale' });
    expect(saleRow(t, taken)).toBeUndefined();
    t.clock.now += 1;
    const id = await t.service.openSale(14);
    expect(id).not.toBe(taken);
    expect(saleRow(t, id)).toBeDefined();
    await t.service.close();
  }, 60000);
});

describe('sales an earlier run left open, beside rows the library does not read', () => {
  it('at a launch, a sale such a row names is never withdrawn, and while one names no sale, none is', async () => {
    const named = await archiveTill(() => [refused(1, NOW - DAY_MS), refused(2, NOW - DAY_MS + 1000)], {
      auto: false,
      mint: true,
    });
    await named.service.close();
    // a payment row of sale r-1 that this version cannot read (it has no mint): it may hold r-1's money
    const p = JSON.parse(JSON.stringify(F.held.find((x) => x.kind === 'payment'))) as R;
    p.id = 'pay:' + String(8100).padStart(32, '0');
    p.sale = 'r-1';
    delete p.mint;
    db(named)
      .prepare('INSERT INTO journal (id, kind, gen, body, written_at) VALUES (?, ?, ?, ?, ?)')
      .run(p.id as string, 'payment', 0, JSON.stringify(p), named.clock.now);
    const again = await archiveTill(() => [], { auto: false, mint: true, f: named.f });
    await again.service.settleNow('launch');
    expect(saleRow(again, 'r-1')?.closed).toBeUndefined();
    expect(saleRow(again, 'r-2')?.closed).toBe('withdrawn');
    await again.service.close();

    const unnamed = await archiveTill(() => [refused(3, NOW - DAY_MS)], { auto: false, mint: true });
    await unnamed.service.close();
    db(unnamed)
      .prepare('INSERT INTO journal (id, kind, gen, body, written_at) VALUES (?, ?, ?, ?, ?)')
      .run('pay:broken', 'payment', 0, '{"sale":', unnamed.clock.now);
    const later = await archiveTill(() => [], { auto: false, mint: true, f: unnamed.f });
    await later.service.settleNow('launch');
    expect(saleRow(later, 'r-3')?.closed).toBeUndefined();
    await later.service.close();
  }, 60000);

  it('at a launch, while a row with no id of its own may hold a payment, no sale is withdrawn', async () => {
    const t = await archiveTill(() => [refused(1, NOW - DAY_MS), refused(2, NOW - DAY_MS + 1000)], {
      auto: false,
      mint: true,
    });
    await t.service.close();
    // a payment row of sale r-1 whose body has no id: the library does not read it, and names it ''
    const p = JSON.parse(JSON.stringify(F.held.find((x) => x.kind === 'payment'))) as R;
    delete p.id;
    p.sale = 'r-1';
    db(t)
      .prepare('INSERT INTO journal (id, kind, gen, body, written_at) VALUES (?, ?, ?, ?, ?)')
      .run('pay:' + String(8200).padStart(32, '0'), 'payment', 0, JSON.stringify(p), t.clock.now);
    const again = await archiveTill(() => [], { auto: false, mint: true, f: t.f });
    await again.service.settleNow('launch');
    expect(saleRow(again, 'r-1')?.closed).toBeUndefined();
    expect(saleRow(again, 'r-2')?.closed).toBeUndefined();
    await again.service.close();
  }, 60000);
});

describe("a launch tells this run's sales by their ids, not by the clock", () => {
  it("a sale opened in this run is never withdrawn at a launch with the clock put back, and an earlier run's is with it put ahead", async () => {
    const t = await archiveTill(() => [refused(1, NOW - DAY_MS), refused(2, NOW + DAY_MS)], { auto: false, mint: true });
    t.clock.now -= 3600000;
    const first = await t.service.openSale(14);
    // a take of it cut short: it counts while the next sale opens, and the launch's settle gives it up
    payFor(t, first, 1, 'taking', 'planned');
    t.clock.now += 1000;
    const second = await t.service.openSale(21);
    expect(saleRow(t, first)?.closed).toBeUndefined();
    await t.service.settleNow('launch');
    expect((await t.service.payments()).filter((p) => p.id === first)).toEqual([]);
    expect(saleRow(t, first)?.closed).toBeUndefined();
    expect(saleRow(t, second)?.closed).toBeUndefined();
    expect(saleRow(t, 'r-1')?.closed).toBe('withdrawn');
    expect(saleRow(t, 'r-2')?.closed).toBe('withdrawn');
    await t.service.close();
  }, 60000);
});
