/* The generation across an archive with cashucard 0.3.0 (slice 2.3b), over the real library, the real store and a fake
 * secure store. 0.3.0's archive() takes a sale's own row out too, and writes the lease again before its first move and
 * after its last, so the journal's highest generation is always on a row no archive moves. Held here, with the till's
 * hold on the generation during the job (order 18 of slice 2.3, kept): an archive then a new open; the app killed at
 * each move of a job, and between its last move and the lease's last write, then opened again; never a rollback, never
 * a missing record, and the next archive finishes the job with every payment counted once. */

import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { archiveTill, delivered, NOW, PATH, until, type ArchiveTill } from './helpers/archive-till';
import { dump } from './helpers/fake-sql';
import { fakeMint } from './helpers/fake-mint';
import type { FakeStore } from './helpers/fake-store';

const three = () => [delivered(1, NOW + 500), delivered(2, NOW + 1500), delivered(3, NOW + 2500)];
/** three payments, their three deliveries, and four sales' own rows: the three paid, and one withdrawn */
const MOVES = 10;

/** A till over three paid sales, and one more sale opened and withdrawn by the library after it opened: so the
 * record's newest rows, the ones the stored generation stands for, are rows the archive moves. */
async function four(): Promise<ArchiveTill> {
  const t = await archiveTill(three, { auto: false, mint: true });
  t.clock.now += 1000;
  await t.service.withdrawSale(await t.service.openSale(14));
  t.clock.now += 1000;
  expect(stored(t.f)).toBe(highest(t.f));
  return t;
}

/** the generation the secure store holds: the higher of its two slots */
function stored(f: FakeStore): number {
  return Math.max(Number(f.secure.items.get(TILL_NAMES.genA) ?? -1), Number(f.secure.items.get(TILL_NAMES.genB) ?? -1));
}

/** the journal's rows: id and generation */
const journal = (f: FakeStore) => dump(f.disk.files.get(PATH)!.db, 'journal').map((r) => ({ id: String(r.id), gen: Number(r.gen) }));
const highest = (f: FakeStore): number => journal(f).reduce((n, r) => Math.max(n, r.gen), 0);

/** A new run of the app over the same store (the old one killed): it opens, and archives what is left. */
async function reopen(t: ArchiveTill): Promise<void> {
  const again = createTillService({
    store: t.f.deps,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: fakeMint().http,
    now: () => t.clock.now,
    log: () => undefined,
    autoArchive: false,
  });
  expect(await again.open()).toMatchObject({ kind: 'ready' });
  expect(stored(t.f)).toBeGreaterThanOrEqual(highest(t.f));
  expect(await again.archiveNow('asked')).toMatchObject({ ok: true });
  expect(await again.payments()).toEqual([]);
  expect(await again.archivedTakings(null, null)).toEqual({ sats: 42, count: 3 });
  const archive = dump(t.f.disk.files.get(PATH)!.db, 'archive');
  expect(new Set(archive.map((r) => r.id)).size).toBe(archive.length);
  expect(archive.filter((r) => r.kind === 'sale')).toHaveLength(4);
  await again.close();
}

describe('the generation across an archive, cashucard 0.3.0', () => {
  it("an archive leaves the lease as the journal's newest row; the record opens again, never rolled back", async () => {
    const t = await four();
    expect(await t.service.archiveNow('asked')).toMatchObject({ payments: 3, rows: MOVES, ok: true });
    const rows = journal(t.f);
    expect(rows.map((r) => r.id)).toEqual(['lease']);
    expect(stored(t.f)).toBe(highest(t.f));
    await t.service.close();
    const again = createTillService({
      store: t.f.deps,
      names: TILL_NAMES,
      settingsNames: TILL_SETTINGS,
      http: fakeMint().http,
      now: () => t.clock.now,
      log: () => undefined,
      autoArchive: false,
    });
    expect(await again.open()).toMatchObject({ kind: 'ready' });
    expect(await again.archivedTakings(null, null)).toEqual({ sats: 42, count: 3 });
    await again.close();
  }, 60000);

  it('killed before each move of a job, the record opens again, never rolled back, and the next archive finishes it', async () => {
    for (let k = 0; k < MOVES; k += 1) {
      const t = await four();
      t.pause.at = k;
      void t.service.archiveNow('asked');
      await until(() => t.pause.waiting);
      // the job is cut off here, as by a kill: it never ends, and the till's hold never stores its generation
      expect(t.cut.removes).toBe(k);
      await reopen(t);
    }
  }, 120000);

  it("killed between a job's last move and the lease's last write, the record opens again, never rolled back", async () => {
    const t = await four();
    t.after.at = MOVES - 1;
    void t.service.archiveNow('asked');
    await until(() => t.after.waiting);
    expect(t.cut.removes).toBe(MOVES);
    expect(journal(t.f).map((r) => r.id)).toEqual(['lease']);
    await reopen(t);
  }, 60000);

  it("killed between two of a job's archived marks, or after the last before the lease is written again, the record opens again, never rolled back", async () => {
    for (let k = 1; k <= 4; k += 1) {
      const t = await four();
      t.marks.after = k;
      void t.service.archiveNow('asked');
      await until(() => t.marks.waiting);
      // the job is cut off here, as by a kill: k of the four sales are marked archived, nothing is moved yet
      expect(t.marks.count).toBe(k);
      expect(t.cut.removes).toBe(0);
      expect(highest(t.f)).toBeGreaterThan(stored(t.f));
      await reopen(t);
    }
  }, 120000);
});
