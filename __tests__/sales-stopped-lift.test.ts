/* New sales stopped lift by themselves (slice 2.4, ENG-909 b), over the real library cashucard 0.3.0 and the real
 * store: a till that is stopped writes no new sale, so the library may hand over no further generation; every settle
 * hands the secure store the generation it refused once more. */

import { SalesStoppedError } from '../src/till/card-errors';
import { TILL_NAMES } from '../src/till/store/types';
import { archiveTill, PATH, type ArchiveTill } from './helpers/archive-till';
import { dump } from './helpers/fake-sql';

function refuse(t: ArchiveTill): void {
  t.f.secure.failSet.add(TILL_NAMES.genA);
  t.f.secure.failSet.add(TILL_NAMES.genB);
}

/** the generation the secure store holds: the higher of its two slots */
function stored(t: ArchiveTill): number {
  return Math.max(Number(t.f.secure.items.get(TILL_NAMES.genA) ?? -1), Number(t.f.secure.items.get(TILL_NAMES.genB) ?? -1));
}

/** the highest generation among the journal's rows */
function highest(t: ArchiveTill): number {
  return dump(t.f.disk.files.get(PATH)!.db, 'journal').reduce((n, r) => Math.max(n, Number(r.gen)), 0);
}

describe('new sales stopped lift by themselves', () => {
  it('a settle with nothing to write stores the generation the store refused, and a sale is taken again', async () => {
    const t = await archiveTill(() => [], { auto: false, mint: true });
    // the launch's settle first, so that the settle below has nothing of its own to do
    await t.service.settleNow('launch');
    refuse(t);
    await t.service.openSale(14);
    expect(t.service.salesStopped()).toBe(true);
    expect(stored(t)).toBeLessThan(highest(t));
    t.f.secure.failSet.clear();
    const rows = dump(t.f.disk.files.get(PATH)!.db, 'journal').length;
    await t.service.settleNow('asked');
    expect(dump(t.f.disk.files.get(PATH)!.db, 'journal').length).toBe(rows);
    expect(t.service.salesStopped()).toBe(false);
    expect(stored(t)).toBe(highest(t));
    t.clock.now += 1000;
    await expect(t.service.openSale(21)).resolves.toEqual(expect.any(String));
    await t.service.close();
  }, 60000);

  it('while the store still refuses, a settle ends as before and new sales stay stopped', async () => {
    const t = await archiveTill(() => [], { auto: false, mint: true });
    await t.service.settleNow('launch');
    refuse(t);
    await t.service.openSale(14);
    await expect(t.service.settleNow('asked')).resolves.toEqual([]);
    expect(t.service.salesStopped()).toBe(true);
    expect(t.service.lastSettle()).toMatchObject({ ok: true });
    t.clock.now += 1000;
    await expect(t.service.openSale(21)).rejects.toBeInstanceOf(SalesStoppedError);
    await t.service.close();
  }, 60000);
});
