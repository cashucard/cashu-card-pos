/* The sale screen lets its sale go (slice 2.3b): New sale pressed on a result, or the screen left on one. The till is
 * told at once, so the sale stops holding the archive back (no two minutes' wait after NOT PAID), and the sale is
 * withdrawn when nothing counts for it (cashucard 0.3.0 never archives an open sale that took nothing). While an
 * archive run waits for a sale, Records says so. Over the real library and the real store, and the controller and
 * Records over fakes. */

import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { CardError, type CardListener, type CardTransport, type Payment } from 'cashucard';
import { ARCHIVE_WORDS, type ArchiveProgress } from '../src/till/archive';
import { createSaleController } from '../src/till/sale-controller';
import type { CardReader } from '../src/till/reader';
import { RecordsScreen, type RecordsReader } from '../src/screens/RecordsScreen';
import { archiveTill, many, PATH, until } from './helpers/archive-till';
import { dump } from './helpers/fake-sql';
import { fakeTransport } from './helpers/fake-till';
import { has, textOf, until as untilShown } from './helpers/render';

const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));
const listener: CardListener = { confirm: async () => ({ pay: false }) };
const declined = async (): Promise<Payment> => {
  throw new CardError('declined', 'The card refused. Nothing was taken.');
};

describe('the sale screen lets its sale go', () => {
  it('a run waiting for the sale on the sale screen says so, and goes on at once when the screen lets the sale go', async () => {
    const t = await archiveTill(many(50), { auto: false, mint: true, wait: async () => tick(), card: [declined] });
    const id = await t.service.openSale(14);
    await expect(t.service.takeCard(id, fakeTransport(), listener)).rejects.toBeInstanceOf(CardError);
    const seen: Array<ArchiveProgress | null> = [];
    const off = t.service.onArchiveProgress((p) => seen.push(p));
    const run = t.service.archiveNow('asked');
    await until(() => seen.length > 0);
    expect(seen[0]).toEqual({ archived: 0, left: 0, waiting: true });
    expect(t.service.archiveProgress()).toEqual({ archived: 0, left: 0, waiting: true });
    // the clock stands still: the run goes on because the sale was let go, never because two minutes passed
    await t.service.leaveSale(id);
    expect(await run).toMatchObject({ payments: 50, ok: true });
    off();
    expect(seen[seen.length - 1]).toBeNull();
    expect(seen.filter((p) => p !== null && p.waiting === true)).toHaveLength(1);
    // withdrawn (nothing counted for it), and so archived with the rest
    expect(await t.service.isArchived('sale:' + id)).toBe(true);
    expect(dump(t.f.disk.files.get(PATH)!.db, 'journal').some((r) => r.id === 'sale:' + id)).toBe(false);
    await t.service.close();
  }, 60000);

  it('only the sale the screen has open is let go: any other id is left as it is', async () => {
    const t = await archiveTill(() => [], { auto: false, mint: true, card: [declined] });
    const id = await t.service.openSale(14);
    await expect(t.service.takeCard(id, fakeTransport(), listener)).rejects.toBeInstanceOf(CardError);
    await t.service.leaveSale('s-other');
    const row = dump(t.f.disk.files.get(PATH)!.db, 'journal').find((r) => r.id === 'sale:' + id)!;
    expect((JSON.parse(String(row.body)) as Record<string, unknown>).closed).toBeUndefined();
    await t.service.close();
  }, 60000);

  it('the controller tells the till when New sale is pressed on a result, and when the screen is left on one', async () => {
    const reader: CardReader = { kind: 'card simulator', available: async () => true, transport: () => fakeTransport() };
    const make = () => {
      const service = {
        openSale: jest.fn(async (): Promise<string> => 's1'),
        takeCard: jest.fn((_id: string, _t: CardTransport, _l: CardListener): Promise<Payment> => declined()),
        withdrawSale: jest.fn(async (): Promise<Payment[]> => []),
        leaveSale: jest.fn(async (_id: string): Promise<void> => undefined),
      };
      const ctl = createSaleController({ service, reader, onState: () => undefined });
      return { ctl, service };
    };
    const charge = (c: ReturnType<typeof make>['ctl']): void => {
      for (const d of ['1', '4']) c.input({ type: 'digit', d });
      c.input({ type: 'charge' });
    };
    const a = make();
    charge(a.ctl);
    for (let i = 0; i < 10; i += 1) await tick();
    expect(a.ctl.state()).toMatchObject({ kind: 'result', saleId: 's1', outcome: { kind: 'not-paid' } });
    expect(a.service.leaveSale).not.toHaveBeenCalled();
    a.ctl.input({ type: 'new' });
    expect(a.service.leaveSale).toHaveBeenCalledWith('s1');
    a.ctl.dispose();
    expect(a.service.leaveSale).toHaveBeenCalledTimes(1);
    const b = make();
    charge(b.ctl);
    for (let i = 0; i < 10; i += 1) await tick();
    b.ctl.dispose();
    expect(b.service.leaveSale).toHaveBeenCalledWith('s1');
    const c = make();
    c.ctl.dispose();
    expect(c.service.leaveSale).not.toHaveBeenCalled();
  });

  it('Records says the archive waits for the sale, and how far it has come once it has archived some', async () => {
    let tell: (p: ArchiveProgress | null) => void = () => undefined;
    const r: RecordsReader = {
      payments: async (): Promise<Payment[]> => [],
      archivedTakings: async () => ({ sats: 0, count: 0 }),
      archivedPayments: async () => [],
      archiveNow: async () => {
        throw new Error('not asked here');
      },
      lastArchive: () => null,
      archiveProgress: () => ({ archived: 0, left: 0, waiting: true }),
      onArchiveProgress: (l) => {
        tell = l;
        return () => undefined;
      },
    };
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<RecordsScreen reader={r} onBack={() => undefined} />);
    });
    await untilShown(tree, 'records-live');
    expect(textOf(tree, 'records-waiting')).toBe(ARCHIVE_WORDS.waiting);
    expect(ARCHIVE_WORDS.waiting).toBe(
      'The archive is waiting for the sale on the sale screen. It goes on once that sale is paid, withdrawn or left.',
    );
    expect(has(tree, 'records-progress')).toBe(false);
    await act(async () => {
      tell({ archived: 100, left: 20, waiting: true });
    });
    expect(has(tree, 'records-waiting')).toBe(true);
    expect(textOf(tree, 'records-progress')).toBe('Archived so far: 100 payments. Finished payments still in the record: 20.');
    await act(async () => {
      tell({ archived: 100, left: 20 });
    });
    expect(has(tree, 'records-waiting')).toBe(false);
    await act(async () => {
      tree.unmount();
    });
  });
});
