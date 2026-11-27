/* After an archive job the generation goes to the secure store at once again (slice 2.3 review), over the real library
 * and the real store: an archive job holds the generations the library hands over and stores the highest at its end
 * (order 18); the hold must end with the job, or every later write (a sale, a tap, a settle: writes that change money)
 * would leave the stored generation behind the journal until the next archive job. */

import type { Row } from 'cashucard';
import { TILL_NAMES } from '../src/till/store/types';
import { archiveTill, delivered, held, NOW, PATH } from './helpers/archive-till';
import { dump } from './helpers/fake-sql';
import type { FakeStore } from './helpers/fake-store';

/** the generation the secure store holds: the higher of its two slots */
function stored(f: FakeStore): number {
  return Math.max(Number(f.secure.items.get(TILL_NAMES.genA) ?? -1), Number(f.secure.items.get(TILL_NAMES.genB) ?? -1));
}

/** the highest generation among the journal's rows */
function highest(f: FakeStore): number {
  return dump(f.disk.files.get(PATH)!.db, 'journal').reduce((n, r) => Math.max(n, Number(r.gen)), 0);
}

/** how many times the generation was handed to the secure store */
const genSets = (f: FakeStore): number =>
  f.secure.sets.filter((n) => n === TILL_NAMES.genA || n === TILL_NAMES.genB).length;

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

describe('after an archive job', () => {
  it('a settle stores its generation at once', async () => {
    const t = await archiveTill(() => [delivered(1, NOW + 500), planned(2, NOW + 1500)], { auto: false, mint: true });
    expect(await t.service.archiveNow('asked')).toMatchObject({ payments: 1, ok: true });
    const before = genSets(t.f);
    await t.service.settleNow('asked');
    const pay = dump(t.f.disk.files.get(PATH)!.db, 'journal').find((r) => r.kind === 'payment')!;
    expect((JSON.parse(String(pay.body)) as Record<string, unknown>).step).toBe('abandoned');
    expect(genSets(t.f) - before).toBeGreaterThanOrEqual(1);
    expect(stored(t.f)).toBe(highest(t.f));
    await t.service.close();
  }, 60000);

  it('a sale stores its generation at once', async () => {
    const t = await archiveTill(() => [delivered(1, NOW + 500), held(2, NOW + 1500)], { auto: false, mint: true });
    expect(await t.service.archiveNow('asked')).toMatchObject({ payments: 1, ok: true });
    const before = genSets(t.f);
    t.clock.now += 1000;
    await t.service.openSale(14);
    expect(genSets(t.f) - before).toBeGreaterThanOrEqual(1);
    expect(stored(t.f)).toBe(highest(t.f));
    await t.service.close();
  }, 60000);
});
