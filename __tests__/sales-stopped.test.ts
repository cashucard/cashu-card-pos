/* The till stops new sales when the phone's secure store refuses the record's generation (slice 2.4, ENG-909 b), over
 * the real library cashucard 0.3.0 and the real store, with a secure store that refuses some sets. The trigger is the
 * library's own hand-over of the generation after a write, never a stub of it. */

import { CardError, type CardListener, type Payment, type Row } from 'cashucard';
import { SALES_STOPPED, SalesStoppedError } from '../src/till/card-errors';
import { TILL_NAMES } from '../src/till/store/types';
import { archiveTill, delivered, held, NOW, PATH, type ArchiveTill } from './helpers/archive-till';
import { dump } from './helpers/fake-sql';
import { fakeTransport } from './helpers/fake-till';

const LIBRARY_LINE = '[card] the journal’s generation could not be stored outside it: the secure store did not keep it';
const listener: CardListener = { confirm: async () => ({ pay: false }) };
/** the customer's card refuses: nothing is taken, and no row is written */
const declined = async (): Promise<Payment> => {
  throw new CardError('declined', 'The card refused. Nothing was taken.');
};

/** the secure store refuses every set of the generation's two items from now on */
function refuse(t: ArchiveTill): void {
  t.f.secure.failSet.add(TILL_NAMES.genA);
  t.f.secure.failSet.add(TILL_NAMES.genB);
}

/** the secure store keeps every set again */
function allow(t: ArchiveTill): void {
  t.f.secure.failSet.clear();
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

describe('new sales stop when the generation cannot be stored', () => {
  it('one refused generation stops new sales at once: the next sale is refused before the queue, and no row is written', async () => {
    const t = await archiveTill(() => [], { auto: false, mint: true, card: [declined] });
    expect(t.service.salesStopped()).toBe(false);
    refuse(t);
    // the sale whose own row the library wrote when the store first refused: it is opened, and goes on
    const first = await t.service.openSale(14);
    expect(t.service.salesStopped()).toBe(true);
    expect(t.logs).toContain('till: new sales stopped');
    // the library's own line still reaches the store's log: nothing is swallowed
    expect(t.f.logs).toContain(LIBRARY_LINE);
    const rows = saleRows(t);
    const sets = t.f.secure.sets.length;
    t.clock.now += 1000;
    const second = t.service.openSale(21);
    // refused before the queue: no job was asked
    expect(t.service.queue.running()).toBeNull();
    expect(t.service.queue.waiting()).toBe(0);
    await expect(second).rejects.toBeInstanceOf(SalesStoppedError);
    await expect(second).rejects.toThrow(SALES_STOPPED);
    expect(saleRows(t)).toBe(rows);
    expect(t.f.secure.sets.length).toBe(sets);
    // the sale already opened still takes its card: the card is asked (and here refuses)
    const tap = t.service.takeCard(first, fakeTransport(), listener);
    await expect(tap).rejects.toBeInstanceOf(CardError);
    await expect(tap).rejects.toMatchObject({ kind: 'declined' });
    await t.service.close();
  }, 60000);

  it('the next generation the store keeps lifts it, and a sale is taken again', async () => {
    const t = await archiveTill(() => [], { auto: false, mint: true });
    const told: boolean[] = [];
    const off = t.service.onSalesStopped((s) => told.push(s));
    refuse(t);
    const first = await t.service.openSale(14);
    expect(t.service.salesStopped()).toBe(true);
    allow(t);
    // a write of the record that is no new sale: the sale withdrawn
    await t.service.withdrawSale(first);
    expect(t.service.salesStopped()).toBe(false);
    expect(t.logs).toContain('till: new sales taken again');
    t.clock.now += 1000;
    await expect(t.service.openSale(21)).resolves.toEqual(expect.any(String));
    expect(told).toEqual([true, false]);
    off();
    refuse(t);
    t.clock.now += 1000;
    await t.service.openSale(7);
    expect(t.service.salesStopped()).toBe(true);
    expect(told).toEqual([true, false]);
    await t.service.close();
  }, 60000);

  it('settle, the archive and the readings still run while new sales are stopped', async () => {
    const t = await archiveTill(() => [delivered(1, NOW + 500), planned(2, NOW + 1500)], { auto: false, mint: true });
    refuse(t);
    // the settle gives the planned payment up: a write of the record, whose generation the store refuses
    await t.service.settleNow('asked');
    expect(t.service.salesStopped()).toBe(true);
    const pay = dump(t.f.disk.files.get(PATH)!.db, 'journal').find((r) => r.kind === 'payment' && String(r.body).includes('"sale":"h-2"'))!;
    expect((JSON.parse(String(pay.body)) as Record<string, unknown>).step).toBe('abandoned');
    expect(await t.service.archiveNow('asked')).toMatchObject({ payments: 1, ok: true });
    expect(Array.isArray(await t.service.payments())).toBe(true);
    expect(Array.isArray(await t.service.kept())).toBe(true);
    expect((await t.service.archivedPayments()).length).toBe(1);
    expect(t.service.salesStopped()).toBe(true);
    t.clock.now += 1000;
    await expect(t.service.openSale(14)).rejects.toBeInstanceOf(SalesStoppedError);
    await t.service.close();
  }, 60000);

  it('a launch whose own generation is refused opens with new sales stopped; one whose generation is kept opens with them taken', async () => {
    const t = await archiveTill(() => [], { auto: false, mint: true });
    refuse(t);
    await t.service.openSale(14);
    expect(t.service.salesStopped()).toBe(true);
    await t.service.close();
    const stillRefused = await archiveTill(() => [], { auto: false, f: t.f });
    expect(stillRefused.service.phase().kind).toBe('ready');
    expect(stillRefused.service.salesStopped()).toBe(true);
    await expect(stillRefused.service.openSale(14)).rejects.toBeInstanceOf(SalesStoppedError);
    await stillRefused.service.close();
    allow(t);
    const again = await archiveTill(() => [], { auto: false, f: t.f });
    expect(again.service.salesStopped()).toBe(false);
    again.clock.now += 5000;
    await expect(again.service.openSale(14)).resolves.toEqual(expect.any(String));
    await again.service.close();
  }, 60000);
});
