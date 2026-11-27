/* A sale that waits in the queue when new sales stop is refused too (slice 2.4 review, R1), over the real library
 * cashucard 0.3.0 and the real store. Charge is pressed while new sales are still taken. A settle in front of the sale
 * writes a row, and the secure store refuses its generation. The sale's job looks again before it writes anything. */

import { CashuCard, type Row } from 'cashucard';
import { SALES_STOPPED, SalesStoppedError } from '../src/till/card-errors';
import { TILL_NAMES } from '../src/till/store/types';
import { archiveTill, held, NOW, PATH, type ArchiveTill } from './helpers/archive-till';
import { dump } from './helpers/fake-sql';

/** the secure store refuses every set of the generation's two items from now on */
function refuse(t: ArchiveTill): void {
  t.f.secure.failSet.add(TILL_NAMES.genA);
  t.f.secure.failSet.add(TILL_NAMES.genB);
}

/** how many sale rows the journal holds */
function saleRows(t: ArchiveTill): number {
  return dump(t.f.disk.files.get(PATH)!.db, 'journal').filter((r) => r.kind === 'sale').length;
}

/** Sale n whose card payment was set out and never signed: the next settle writes it given up (`abandoned`), a write
 * that needs no mint. */
function planned(n: number, at: number): Row[] {
  const rows = held(n, at) as unknown as Array<Record<string, unknown>>;
  const p = rows[1];
  p.state = 'taking';
  p.step = 'planned';
  delete p.heldAt;
  return rows as unknown as Row[];
}

describe('a sale waiting in the queue when new sales stop', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('behind a settle whose save is refused: the sale is refused, no sale row is written, the library is not asked for it', async () => {
    const t = await archiveTill(() => [planned(1, NOW + 1500)], { auto: false, mint: true });
    const receive = jest.spyOn(CashuCard.prototype, 'receive');
    refuse(t);
    const rows = saleRows(t);
    // the settle gives the planned payment up: a write of the record, whose generation the store refuses
    const settle = t.service.settleNow('asked');
    // Charge, pressed while that settle runs: new sales are still taken, so the sale joins the queue behind it
    expect(t.service.salesStopped()).toBe(false);
    const sale = t.service.openSale(14);
    sale.catch(() => undefined);
    expect(t.service.queue.waiting()).toBeGreaterThan(0);
    await settle;
    expect(t.service.salesStopped()).toBe(true);
    await expect(sale).rejects.toBeInstanceOf(SalesStoppedError);
    await expect(sale).rejects.toThrow(SALES_STOPPED);
    expect(saleRows(t)).toBe(rows);
    expect(receive).not.toHaveBeenCalled();
    await t.service.close();
  }, 60000);
});
