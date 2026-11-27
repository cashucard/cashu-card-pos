// The development build's synthetic sales and archive switch (slice 2.3): the plan's archive field; sales the real
// library lists as delivered payments and archives as final; asked again, only what is not there, and never a sale
// archived since.
import { MemoryJournal, open, walletPayout, type HttpFetch } from 'cashucard';
import { fillSaleId, fillSales, saleRows } from '../src/dev/record-fill';
import { parsePlan, PlanError } from '../src/lab/plan';
import { archiveTill, delivered, NOW } from './helpers/archive-till';

const T = new Date(2026, 10, 22, 12, 0).getTime();
const http: HttpFetch = async () => {
  throw new Error('no fetch expected');
};
const libraryOver = (journal: MemoryJournal) =>
  open({
    journal,
    payout: walletPayout({ mints: [], keep: async () => undefined }),
    http,
    leftoverByPin: false,
    clock: null,
    now: () => T,
  });

describe('the development archive plan and its sales', () => {
  it('the plan asks for synthetic sales and may keep the till from archiving by itself', () => {
    expect(parsePlan({ mode: 'app', app: { gate: 'bench-allow', archive: { auto: false, sales: 1000 } } })).toEqual({
      mode: 'app',
      app: { gate: 'bench-allow', archive: { auto: false, sales: 1000 } },
    });
    expect(parsePlan({ mode: 'app', app: { gate: 'bench-allow', archive: {} } })).toEqual({
      mode: 'app',
      app: { gate: 'bench-allow', archive: { auto: true, sales: 0 } },
    });
    expect(parsePlan({ mode: 'app', app: { gate: 'bench-allow' } })).toEqual({
      mode: 'app',
      app: { gate: 'bench-allow' },
    });
    for (const bad of [{ sales: 20001 }, { sales: 1.5 }, { sales: -1 }, { auto: 'no' }]) {
      expect(() => parsePlan({ mode: 'app', app: { gate: 'bench-allow', archive: bad } })).toThrow(PlanError);
    }
    expect(() => parsePlan({ mode: 'app', app: { gate: 'bench-allow', archive: 5 } })).toThrow(PlanError);
  });

  it('a synthetic sale is a sale row and a delivered payment row joined to it, of 14 sats', () => {
    const [sale, pay] = saleRows(3, T - 5000) as unknown as Array<Record<string, unknown>>;
    expect(sale.id).toBe('sale:' + fillSaleId(3));
    expect((sale.sale as Record<string, unknown>).id).toBe('m2-3');
    expect(pay.sale).toBe('m2-3');
    expect(pay.state).toBe('delivered');
    expect(pay.amount).toBe(14);
    expect(pay.at).toBe(T - 5000);
    expect(pay.delivery).toBeUndefined();
    expect(JSON.stringify(pay).length).toBeGreaterThanOrEqual(4000);
  });

  it('the real library lists them as delivered payments and archives them as final', async () => {
    const j = new MemoryJournal();
    let clock = T - 10000;
    expect(await fillSales(j, 3, () => (clock += 10))).toBe(3);
    const c = await libraryOver(j);
    const pays = await c.payments();
    expect(pays.map((p) => [p.id, p.state, p.amount])).toEqual([
      ['m2-1', 'delivered', 14],
      ['m2-2', 'delivered', 14],
      ['m2-3', 'delivered', 14],
    ]);
    const out = await c.archive(0);
    expect(out.filter((r) => r.kind === 'payment').map((r) => r.sale).sort()).toEqual(['m2-1', 'm2-2', 'm2-3']);
    // cashucard 0.3.0 takes each sale's own row out with it
    expect(out.filter((r) => r.kind === 'sale').map((r) => r.id).sort()).toEqual(['sale:m2-1', 'sale:m2-2', 'sale:m2-3']);
    expect(await c.payments()).toEqual([]);
    expect(j.rows.has('sale:m2-1')).toBe(false);
  });

  it('asked again it adds only the sales not there, and never a sale archived since', async () => {
    const j = new MemoryJournal();
    expect(await fillSales(j, 2, () => T - 10000)).toBe(2);
    expect(await fillSales(j, 2, () => T - 10000)).toBe(0);
    const c = await libraryOver(j);
    // the archive's rows, as the till's archive table holds them: the fill is told of them
    const gone = new Set((await c.archive(0)).map((r) => r.id));
    const archived = async (id: string): Promise<boolean> => gone.has(id);
    expect(await fillSales(j, 4, () => T - 5000, archived)).toBe(2);
    expect((await c.payments()).map((p) => p.id)).toEqual(['m2-3', 'm2-4']);
  });

  it('the till tells the development journal what its archive holds, so the fill never writes an id archived since', async () => {
    const t = await archiveTill(() => [delivered(1, NOW + 500)], { auto: false });
    expect(await t.archived('sale:a-1')).toBe(false);
    expect(await t.service.archiveNow('asked')).toMatchObject({ payments: 1, ok: true });
    expect(await t.archived('sale:a-1')).toBe(true);
    expect(await t.archived('sale:a-2')).toBe(false);
    await t.service.close();
  }, 60000);
});
