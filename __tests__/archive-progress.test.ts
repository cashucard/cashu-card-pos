/* What the archive tells (slice 2.3 review): how far a run has come, from its own counts, told after each job that took
 * rows and dropped at its end; the words about sales meanwhile; and, once every payment is archived, words of their
 * own rather than "a payment that is not finished stays". */

import { ARCHIVE_WORDS, archiveResultWords, progressWords, type ArchiveProgress } from '../src/till/archive';
import { archiveTill, delivered, held, many, NOW } from './helpers/archive-till';

describe('what the archive tells', () => {
  it('the words: what is true about sales while archiving, how far it has come, and an archive with nothing left', () => {
    expect(ARCHIVE_WORDS.archiving).toBe(
      'Archiving, a part at a time. A sale goes first: it waits only for the part being archived when it is asked.',
    );
    expect(progressWords({ archived: 1, left: 1 })).toBe(
      'Archived so far: 1 payment. Finished payments still in the record: 1.',
    );
    expect(ARCHIVE_WORDS.empty).toBe('Every payment is archived. The record holds none now.');
  });

  it('the service tells the progress after each job that took rows, and nothing once the run ends', async () => {
    const t = await archiveTill(many(250), { auto: false });
    const seen: Array<ArchiveProgress | null> = [];
    const off = t.service.onArchiveProgress((p) => seen.push(p));
    await t.service.archiveNow('asked');
    off();
    expect(seen).toEqual([{ archived: 100, left: 150 }, { archived: 200, left: 50 }, { archived: 250, left: 0 }, null]);
    expect(t.service.archiveProgress()).toBeNull();
    await t.service.close();
  }, 60000);

  it('archiving again once every payment is archived says the record holds none; with one left unfinished, says so', async () => {
    const t = await archiveTill(() => [delivered(1, NOW + 500), delivered(2, NOW + 1500)], { auto: false });
    expect(archiveResultWords(await t.service.archiveNow('asked'))).toBe('Archived 2 payments.');
    expect(archiveResultWords(await t.service.archiveNow('asked'))).toBe(
      'Every payment is archived. The record holds none now.',
    );
    await t.service.close();
    const u = await archiveTill(() => [delivered(1, NOW + 500), held(2, NOW + 1500)], { auto: false });
    await u.service.archiveNow('asked');
    expect(archiveResultWords(await u.service.archiveNow('asked'))).toBe(
      'Nothing to archive now. A payment that is not finished stays in the record.',
    );
    await u.service.close();
  }, 60000);
});
