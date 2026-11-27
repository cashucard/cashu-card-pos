/* The generation during an archive job (slice 2.3 review), over the real library, the real store and a fake secure store:
 * the library hands the secure store a generation after every journal write, and on an Android phone each such write
 * costs about 136 ms. During an archive job (whose only writes are the library's archived marks) the till keeps them
 * and stores the highest once, at the job's end. A job cut off before its end leaves the stored generation behind the
 * journal's, which the next open accepts (never a rollback) and then brings level. Every other write still stores its
 * generation at once. */

import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { archiveTill, delivered, NOW, PATH, until } from './helpers/archive-till';
import { dump } from './helpers/fake-sql';
import { fakeMint } from './helpers/fake-mint';
import type { FakeStore } from './helpers/fake-store';

const three = () => [delivered(1, NOW + 500), delivered(2, NOW + 1500), delivered(3, NOW + 2500)];

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

describe('the generation during an archive job', () => {
  it("an archive job stores the generation once, at its end, the journal's highest", async () => {
    const t = await archiveTill(three, { auto: false });
    const before = genSets(t.f);
    const n = await t.service.archiveNow('asked');
    expect(n).toMatchObject({ payments: 3, ok: true });
    expect(genSets(t.f) - before).toBe(1);
    expect(stored(t.f)).toBe(highest(t.f));
    await t.service.close();
  }, 60000);

  it('a sale still stores the generation after its write, at once', async () => {
    const t = await archiveTill(three, { auto: false, mint: true });
    const before = genSets(t.f);
    await t.service.openSale(14);
    expect(genSets(t.f) - before).toBeGreaterThanOrEqual(1);
    expect(stored(t.f)).toBe(highest(t.f));
    await t.service.close();
  }, 60000);

  it('a job cut off before its end leaves the stored generation behind, and the record opens with no rollback', async () => {
    const t = await archiveTill(three, { auto: false });
    t.pause.at = 0;
    void t.service.archiveNow('asked');
    await until(() => t.pause.waiting);
    // the three archived marks are written and committed; the job is cut off here, as by a kill: it never ends
    expect(stored(t.f)).toBeLessThan(highest(t.f));
    const again = createTillService({
      store: t.f.deps,
      names: TILL_NAMES,
      settingsNames: TILL_SETTINGS,
      http: fakeMint().http,
      now: () => t.clock.now,
      log: () => undefined,
      autoArchive: false,
    });
    expect((await again.open()).kind).toBe('ready');
    expect(stored(t.f)).toBeGreaterThanOrEqual(highest(t.f));
    expect((await again.payments()).length).toBe(3);
    expect(await again.archiveNow('asked')).toMatchObject({ payments: 3, ok: true });
    expect(await again.archivedTakings(null, null)).toEqual({ sats: 42, count: 3 });
    await again.close();
  }, 60000);

  it('a job that fails part way still stores the generation at its end', async () => {
    const t = await archiveTill(three, { auto: false, failRemovesAfter: 1 });
    const n = await t.service.archiveNow('asked');
    expect(n.ok).toBe(false);
    expect(stored(t.f)).toBe(highest(t.f));
    await t.service.close();
  }, 60000);

  it("a secure store that refuses the job's generation is logged, and the job ends as it would", async () => {
    const t = await archiveTill(three, { auto: false });
    t.f.secure.failSet.add('*');
    const n = await t.service.archiveNow('asked');
    t.f.secure.failSet.clear();
    expect(n).toMatchObject({ payments: 3, ok: true });
    expect(
      t.f.logs.filter((l) => l.startsWith("the journal's generation could not be stored outside it after an archive job")),
    ).toHaveLength(1);
    await t.service.close();
  }, 60000);
});
