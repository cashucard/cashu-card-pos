/* Readings of the record and the archive while the till archives (slice 2.3 review), over the real library and the real
 * store: a row moved into the archive during a reading would be counted in both, or in neither. A steady reading is
 * made once outside the queue; when a row moved during it, it is made again as a job of the queue, where no archive job
 * runs beside it. Every reading counts each payment exactly once. */

import type { JobKind } from '../src/till/queue';
import { TillNotOpenError, createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { archiveTill, many, NOW, until, type ArchiveTill } from './helpers/archive-till';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';

/** The kinds of the queue's jobs asked from now on. */
function kinds(t: ArchiveTill): string[] {
  const seen: string[] = [];
  const q = t.service.queue;
  const run = q.run.bind(q);
  q.run = <T>(kind: JobKind, f: () => Promise<T>): Promise<T> => {
    seen.push(kind);
    return run(kind, f);
  };
  return seen;
}

/** How many payments the record and the archive hold, in one steady reading. */
async function counted(t: ArchiveTill): Promise<number> {
  return t.service.steady(async () => {
    const live = (await t.service.payments()).length;
    const archived = (await t.service.archivedTakings(null, null)).count;
    return live + archived;
  });
}

describe('steady readings', () => {
  it('a reading during which no row moves is made once, outside the queue', async () => {
    const t = await archiveTill(many(5), { auto: false });
    const seen = kinds(t);
    let runs = 0;
    const n = await t.service.steady(async () => {
      runs += 1;
      return (await t.service.payments()).length;
    });
    expect(n).toBe(5);
    expect(runs).toBe(1);
    expect(seen).toEqual([]);
    await t.service.close();
  });

  it('a reading asked while an archive job runs is made in the queue after the job, and counts every payment once', async () => {
    const t = await archiveTill(many(300), { auto: false });
    const seen = kinds(t);
    // the 50th row is in the archive now, and the library has not yet taken it out of the rows it read for the job
    t.after.at = 49;
    const run = t.service.archiveNow('asked');
    await until(() => t.after.waiting);
    let got: number | null = null;
    const reading = counted(t).then((n) => {
      got = n;
    });
    for (let i = 0; i < 20; i += 1) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    expect(seen).toContain('read');
    expect(got).toBeNull();
    t.after.release();
    await reading;
    expect(got).toBe(300);
    expect((await run).ok).toBe(true);
    expect(await counted(t)).toBe(300);
    await t.service.close();
  }, 60000);

  it('readings repeated while an archive runs: every one counts each payment once', async () => {
    const t = await archiveTill(many(300), { auto: false });
    let done = false;
    const run = t.service.archiveNow('asked').then((n) => {
      done = true;
      return n;
    });
    const seen: number[] = [];
    while (!done) {
      seen.push(await counted(t));
    }
    expect((await run).payments).toBe(300);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((n) => n !== 300)).toEqual([]);
    await t.service.close();
  }, 60000);

  it('before the till is open a steady reading is refused, and nothing is read', async () => {
    const service = createTillService({
      store: fakeStoreDeps().deps,
      names: TILL_NAMES,
      settingsNames: TILL_SETTINGS,
      http: fakeMint().http,
      now: () => NOW,
      log: () => undefined,
    });
    let runs = 0;
    await expect(
      service.steady(async () => {
        runs += 1;
        return 0;
      }),
    ).rejects.toBeInstanceOf(TillNotOpenError);
    expect(runs).toBe(0);
  });
});
