/* A sale goes ahead of the archive (slice 2.3 review), over the real library, the real store and the real till service:
 * a sale asked while an archive job runs waits for that job only, and its tap waits for none; no archive job starts
 * while a sale is open; the run goes on once the sale is paid or withdrawn, or left alone for SALE_OPEN_MOST; a busy
 * till is still archived, between its sales; closing the till ends a run that waits. */

import type { CardListener, Payment } from 'cashucard';
import { SALE_OPEN_MOST } from '../src/till/archive';
import type { JobKind } from '../src/till/queue';
import { archiveTill, many, until, type ArchiveTill } from './helpers/archive-till';
import { fakeTransport, heldPayment } from './helpers/fake-till';

const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));
/** the run's pause: yields to the test, whose clock stands still unless the test moves it */
const wait = async (): Promise<void> => tick();
const listener: CardListener = { confirm: async () => ({ pay: false }) };
/** a card that pays at once: the sale is paid */
const paid = async (_t: unknown, _l: unknown, id: string): Promise<Payment> => ({
  ...heldPayment(id),
  paymentId: 'pay:' + id,
});

/** The kinds of the queue's jobs from now on, in the order they began. */
function begun(t: ArchiveTill): JobKind[] {
  const seen: JobKind[] = [];
  const q = t.service.queue;
  const run = q.run.bind(q);
  q.run = <T>(kind: JobKind, f: () => Promise<T>): Promise<T> =>
    run(kind, async () => {
      seen.push(kind);
      return f();
    });
  return seen;
}

describe('a sale goes ahead of the archive', () => {
  it('a sale asked while an archive job runs waits for that job only, and its tap waits for none', async () => {
    const t = await archiveTill(many(300), { auto: false, wait, mint: true, card: [paid] });
    const seen = begun(t);
    t.pause.at = 10;
    const run = t.service.archiveNow('asked');
    await until(() => t.pause.waiting);
    const opening = t.service.openSale(14);
    t.pause.release();
    const saleId = await opening;
    // as on the phone, the tap is asked a moment after the opening ends
    for (let i = 0; i < 20; i += 1) {
      await tick();
    }
    const tap = await t.service.takeCard(saleId, fakeTransport(), listener);
    expect(tap.state).toBe('held');
    const sale = seen.indexOf('sale');
    const card = seen.indexOf('card');
    expect(seen.slice(0, sale)).toEqual(['archive']);
    expect(seen.slice(sale + 1, card)).toEqual([]);
    expect(await run).toMatchObject({ payments: 300, ok: true });
    await t.service.close();
  }, 60000);

  it('no archive job starts while a sale is open, and the run goes on to its end once the sale is withdrawn', async () => {
    const t = await archiveTill(many(150), { auto: false, wait, mint: true });
    const seen = begun(t);
    const saleId = await t.service.openSale(14);
    let done = false;
    const run = t.service.archiveNow('asked').then((n) => {
      done = true;
      return n;
    });
    for (let i = 0; i < 50; i += 1) {
      await tick();
    }
    expect(seen.filter((k) => k === 'archive')).toEqual([]);
    expect(done).toBe(false);
    await t.service.withdrawSale(saleId);
    expect(await run).toMatchObject({ payments: 150, ok: true });
    await t.service.close();
  }, 60000);

  it('a sale left open with nothing asked of it stops holding the archive back after SALE_OPEN_MOST', async () => {
    const t = await archiveTill(many(50), { auto: false, wait, mint: true });
    const seen = begun(t);
    await t.service.openSale(14);
    const run = t.service.archiveNow('asked');
    for (let i = 0; i < 50; i += 1) {
      await tick();
    }
    expect(seen.filter((k) => k === 'archive')).toEqual([]);
    expect(SALE_OPEN_MOST).toBe(120000);
    t.clock.now += SALE_OPEN_MOST + 1;
    expect(await run).toMatchObject({ payments: 50, ok: true });
    await t.service.close();
  }, 60000);

  it('a busy till is archived between its sales, never between a sale and its tap', async () => {
    const t = await archiveTill(many(300), {
      auto: false,
      wait,
      mint: true,
      card: Array.from({ length: 5 }, () => paid),
    });
    const seen = begun(t);
    const run = t.service.archiveNow('asked');
    for (let i = 0; i < 5; i += 1) {
      // a sale id is made from the clock: each sale a second after the one before
      t.clock.now += 1000;
      const id = await t.service.openSale(14);
      for (let k = 0; k < 5; k += 1) {
        await tick();
      }
      await t.service.takeCard(id, fakeTransport(), listener);
    }
    expect(await run).toMatchObject({ payments: 300, ok: true });
    for (let i = 0; i < seen.length; i += 1) {
      if (seen[i] === 'sale') {
        expect(seen[i + 1]).toBe('card');
      }
    }
    expect(seen.filter((k) => k === 'sale')).toHaveLength(5);
    await t.service.close();
  }, 60000);

  it('closing the till ends a run that waits for a sale, and no archive job runs', async () => {
    const t = await archiveTill(many(50), { auto: false, wait, mint: true });
    const seen = begun(t);
    await t.service.openSale(14);
    const run = t.service.archiveNow('asked');
    for (let i = 0; i < 20; i += 1) {
      await tick();
    }
    await t.service.close();
    expect(await run).toMatchObject({ bites: 0, payments: 0 });
    expect(seen.filter((k) => k === 'archive')).toEqual([]);
  }, 60000);
});
