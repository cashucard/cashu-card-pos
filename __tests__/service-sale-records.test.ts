/* A sale's records after an archive (cashucard 0.3.0), over the real library and the real store: a tap of a sale that
 * was archived is told `sale-archived` (its records taken out: the library's `empty` from sale(id), which the till
 * tells as archived, never as the card's "Nothing to pay with"; or marked archived by an archive cut short), and never
 * TAP THE SAME CARD AGAIN; withdrawing such a sale reads as over, not as a failure. */

import { CardError, type CardListener } from 'cashucard';
import { outcomeOfTake } from '../src/till/sale-machine';
import { archiveTill, delivered, NOW } from './helpers/archive-till';
import { fakeTransport } from './helpers/fake-till';

const listener: CardListener = { confirm: async () => ({ pay: false }) };

async function thrown(p: Promise<unknown>): Promise<CardError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CardError) {
      return e;
    }
    throw e;
  }
  throw new Error('it did not throw');
}

describe("a sale's records after an archive", () => {
  it('a tap of a sale whose records were archived and taken out is told sale-archived, and ends the sale', async () => {
    const t = await archiveTill(() => [delivered(1, NOW + 500)], { auto: false, mint: true });
    expect(await t.service.archiveNow('asked')).toMatchObject({ payments: 1, ok: true });
    const e = await thrown(t.service.takeCard('a-1', fakeTransport(), listener));
    expect(e.kind).toBe('sale-archived');
    expect(outcomeOfTake(e, null, true)).toMatchObject({ kind: 'not-paid', errorKind: 'sale-archived', ended: true });
    expect(await t.service.withdrawSale('a-1')).toEqual([]);
    await t.service.close();
  }, 60000);

  it('a sale an archive marked and did not finish is told sale-archived too, and withdrawing it reads as over', async () => {
    const t = await archiveTill(() => [delivered(1, NOW + 500)], { auto: false, mint: true, failRemovesAfter: 0 });
    expect(await t.service.archiveNow('asked')).toMatchObject({ ok: false });
    expect((await t.service.payments()).map((p) => p.state)).toEqual(['delivered']);
    const e = await thrown(t.service.takeCard('a-1', fakeTransport(), listener));
    expect(e.kind).toBe('sale-archived');
    expect(await t.service.withdrawSale('a-1')).toEqual([]);
    await t.service.close();
  }, 60000);
});
