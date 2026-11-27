/* The sale open on the sale screen is never archived (slice 2.3 review; slice 2.3b for cashucard 0.3.0), over the real
 * library and the real store. cashucard 0.3.0's archive() never takes an open sale whose only payments took nothing (a
 * card refused, a tap given up): such a sale may still be paid. So the merchant may stay on NOT PAID, Try again, as long
 * as they like, whoever archives meanwhile, by hand or by itself at the line, and the till needs no guard of its own.
 * Once another sale is opened, the one left open is withdrawn (nothing counted for it) and then archived. */

import { CardError, type CardListener, type Payment } from 'cashucard';
import { DAY_MS, NO_UNREAD, readySales, SALE_OPEN_MOST } from '../src/till/archive';
import type { PaymentFacts, SaleFacts } from '../src/till/store/journal';
import { archiveTill, delivered, held, NOW, PATH, refused, type ArchiveTill } from './helpers/archive-till';
import { dump } from './helpers/fake-sql';
import { fakeTransport, heldPayment } from './helpers/fake-till';

const listener: CardListener = { confirm: async () => ({ pay: false }) };
/** the customer's card refuses: nothing is taken */
const declined = async (): Promise<Payment> => {
  throw new CardError('declined', 'The card refused. Nothing was taken.');
};
/** a card that pays at once */
const paid = async (_t: unknown, _l: unknown, id: string): Promise<Payment> => ({
  ...heldPayment(id),
  paymentId: 'pay:' + id,
});
/** the refused attempt of sale `r-3` (the helper's `refused(3, …)`) */
const ATTEMPT = 'pay:' + String(7003).padStart(32, '0');

/** Whether the library marked that sale archived: its row's `archived`, which makes every later tap of it refused
 * `same-sale` (cashucard dist/pay.js 1019-1020, `live`). */
function marked(t: ArchiveTill, saleId: string): boolean {
  const row = dump(t.f.disk.files.get(PATH)!.db, 'journal').find((r) => r.id === 'sale:' + saleId);
  if (row === undefined) {
    throw new Error('no row of sale ' + saleId);
  }
  return (JSON.parse(String(row.body)) as Record<string, unknown>).archived !== undefined;
}

const inJournal = (t: ArchiveTill, id: string): boolean =>
  dump(t.f.disk.files.get(PATH)!.db, 'journal').some((r) => r.id === id);

describe('the sale open on the sale screen', () => {
  it('survives a hand archive after two idle minutes on NOT PAID, and is then paid', async () => {
    const t = await archiveTill(
      () => [delivered(1, NOW - 600000), delivered(2, NOW - 500000), refused(3, NOW + 2500)],
      { auto: false, mint: true, card: [declined, paid] },
    );
    await expect(t.service.takeCard('r-3', fakeTransport(), listener)).rejects.toBeInstanceOf(CardError);
    // the merchant stays on NOT PAID, Try again, for more than two minutes
    t.clock.now += SALE_OPEN_MOST + 1;
    const n = await t.service.archiveNow('asked');
    expect(n).toMatchObject({ payments: 2, ok: true });
    expect(marked(t, 'r-3')).toBe(false);
    expect(inJournal(t, ATTEMPT)).toBe(true);
    const p = await t.service.takeCard('r-3', fakeTransport(), listener);
    expect(p.state).toBe('held');
    await t.service.close();
  }, 60000);

  it('survives the till archiving by itself at the line', async () => {
    const t = await archiveTill(
      () => [
        ...Array.from({ length: 450 }, (_, i) => held(i + 1, NOW - DAY_MS + i * 1000)),
        ...Array.from({ length: 60 }, (_, i) => delivered(i + 1, NOW - 900000 + i * 1000)),
        refused(3, NOW + 2500),
      ],
      { auto: false, mint: true, card: [declined] },
    );
    await expect(t.service.takeCard('r-3', fakeTransport(), listener)).rejects.toBeInstanceOf(CardError);
    t.clock.now += SALE_OPEN_MOST + 1;
    const n = await t.service.archiveNow('auto');
    expect(n).toMatchObject({ payments: 60, ok: true });
    expect(marked(t, 'r-3')).toBe(false);
    expect(inJournal(t, ATTEMPT)).toBe(true);
    await t.service.close();
  }, 60000);

  it('once another sale is opened, the one left open is withdrawn, then archived like any other', async () => {
    const t = await archiveTill(() => [delivered(1, NOW - 600000), refused(3, NOW + 2500)], {
      auto: false,
      mint: true,
      card: [declined],
    });
    await expect(t.service.takeCard('r-3', fakeTransport(), listener)).rejects.toBeInstanceOf(CardError);
    t.clock.now += SALE_OPEN_MOST + 1;
    await t.service.openSale(14);
    // slice 2.3b: cashucard 0.3.0 never archives an open sale that took nothing, so the till withdraws the one it left
    const row = dump(t.f.disk.files.get(PATH)!.db, 'journal').find((r) => r.id === 'sale:r-3')!;
    expect((JSON.parse(String(row.body)) as Record<string, unknown>).closed).toBe('withdrawn');
    t.clock.now += SALE_OPEN_MOST + 1;
    await t.service.archiveNow('asked');
    expect(inJournal(t, 'sale:r-3')).toBe(false);
    expect(inJournal(t, ATTEMPT)).toBe(false);
    expect(await t.service.isArchived('sale:r-3')).toBe(true);
    await t.service.close();
  }, 60000);

  it("by the library's own rule an open sale that took nothing is never ready, so the till keeps no guard of its own", () => {
    const fact = (n: number, sale: string, held: number, o: Partial<PaymentFacts> = {}): PaymentFacts => ({
      id: 'pay:' + n,
      sale,
      state: 'delivered',
      step: 'swapped',
      how: 'card',
      extra: false,
      held,
      owed: 0,
      unconfirmed: 0,
      inputs: [],
      ...o,
    });
    const sale = (id: string, at: number, o: Partial<SaleFacts> = {}): SaleFacts => ({
      id,
      at,
      closed: false,
      closedAt: 0,
      archived: false,
      ...o,
    });
    const facts = [fact(1, 'a', NOW - 900000), fact(2, 'open', NOW - 10000, { state: 'none', step: 'refused' })];
    const ready = readySales(facts, [sale('a', NOW - 900000), sale('open', NOW - 10000)], NO_UNREAD);
    expect(ready.map((r) => r.sale)).toEqual(['a']);
    // withdrawn, it is ready, by the time of its close
    const closed = readySales(facts, [sale('a', NOW - 900000), sale('open', NOW - 10000, { closed: true, closedAt: NOW - 5000 })], NO_UNREAD);
    expect(closed.map((r) => [r.sale, r.place])).toEqual([
      ['a', NOW - 900000],
      ['open', NOW - 5000],
    ]);
    expect(DAY_MS).toBe(86400000);
  });
});
