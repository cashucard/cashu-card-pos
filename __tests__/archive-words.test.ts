/* What an archive tells the merchant (slice 2.3 review): "Archived N payments." counts what the merchant calls a
 * payment, as "Paid and archived" and the payment list do, never a card attempt that took nothing (those are archived
 * too, and counted in the job's rows only). A job that archived only such attempts made progress: the run goes on. */

import { archiveResultWords } from '../src/till/archive';
import { archiveTill, delivered, NOW, withdrawn } from './helpers/archive-till';

const DAY = 86400000;

describe('what an archive tells', () => {
  it('Archived N payments counts the payments that took something, never an attempt that took nothing', async () => {
    const t = await archiveTill(
      () => [
        delivered(1, NOW + 500),
        withdrawn(2, NOW + 1500),
        delivered(3, NOW + 2500),
        withdrawn(4, NOW + 3500),
        delivered(5, NOW + 4500),
      ],
      { auto: false },
    );
    const n = await t.service.archiveNow('asked');
    // three sales of payment, delivery and sale row; two withdrawn sales of attempt and sale row (cashucard 0.3.0)
    expect(n).toMatchObject({ payments: 3, rows: 13, ok: true });
    expect(archiveResultWords(n)).toBe('Archived 3 payments.');
    expect((await t.service.archivedTakings(null, null)).count).toBe(3);
    expect(await t.service.archivedPayments()).toHaveLength(3);
    expect(t.service.lastArchive()).toMatchObject({ payments: 3 });
    await t.service.close();
  }, 60000);

  it('a job that archives only attempts that took nothing does not end the run', async () => {
    const t = await archiveTill(
      () => [
        ...Array.from({ length: 100 }, (_, i) => withdrawn(i + 1, NOW - DAY + i * 1000)),
        ...Array.from({ length: 30 }, (_, i) => delivered(i + 1, NOW + i * 1000)),
      ],
      { auto: false },
    );
    const n = await t.service.archiveNow('asked');
    const jobs = t.notes.filter((x) => x.scope === 'job').map((x) => [x.n.payments, x.n.rows]);
    expect(jobs).toEqual([
      [0, 200],
      [30, 90],
      [0, 0],
    ]);
    expect(n).toMatchObject({ payments: 30, ok: true });
    expect(archiveResultWords(n)).toBe('Archived 30 payments.');
    expect(await t.service.payments()).toEqual([]);
    await t.service.close();
  }, 60000);
});
