/* Records with cashucard 0.3.0 (slice 2.3b): its counts follow an archive run, whoever asked for it; it says how many
 * rows the library cannot read and what they hold back from the archive; and while such rows are there it never says
 * that every payment is archived. */

import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { Payment, SkippedRow } from 'cashucard';
import { ARCHIVE_WORDS, archivedWords, archiveResultWords, liveWords, unreadWords, type ArchiveNote } from '../src/till/archive';
import { RecordsScreen, type RecordsReader } from '../src/screens/RecordsScreen';
import { archiveTill, many, PRICE } from './helpers/archive-till';
import { has, press, textOf, until, untilText } from './helpers/render';

const NOTE: ArchiveNote = { why: 'asked', at: 0, ms: 0, bites: 1, payments: 0, rows: 0, left: 0, ok: true, error: null };
const row = (n: number): SkippedRow => ({ id: 'pay:' + n, why: 'a payment without its mint' });

function reader(damaged: number, older: number): RecordsReader {
  return {
    payments: async (): Promise<Payment[]> => [],
    archivedTakings: async () => ({ sats: 0, count: 0 }),
    archivedPayments: async () => [],
    archiveNow: async () => NOTE,
    lastArchive: () => null,
    damagedRows: async () => Array.from({ length: damaged }, (_, i) => row(i)),
    olderRows: async () => Array.from({ length: older }, (_, i) => row(100 + i)),
  };
}

async function show(r: RecordsReader): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<RecordsScreen reader={r} onBack={() => undefined} />);
  });
  await until(tree, 'records-live');
  return tree;
}

describe('Records with cashucard 0.3.0', () => {
  it('says how many rows this version cannot read, and that any sale they may belong to stays in the record', async () => {
    expect(unreadWords(2, 1)).toBe(
      'Rows this version cannot read: 2 damaged, 1 of an earlier version. The Activity lists them. Until they are put right, any sale they may belong to stays in the record.',
    );
    expect(unreadWords(0, 3)).toBe(
      'Rows this version cannot read: 3 of an earlier version. The Activity lists them. Until they are put right, any sale they may belong to stays in the record.',
    );
    const tree = await show(reader(2, 1));
    expect(textOf(tree, 'records-unread')).toBe(unreadWords(2, 1));
    const none = await show(reader(0, 0));
    expect(has(none, 'records-unread')).toBe(false);
  });

  it('never says every payment is archived while such rows are there', async () => {
    expect(archiveResultWords(NOTE, true)).toBe(ARCHIVE_WORDS.heldBack);
    expect(ARCHIVE_WORDS.heldBack).toBe(
      'Nothing more can be archived now. Rows this version cannot read keep some sales in the record.',
    );
    expect(archiveResultWords(NOTE)).toBe(ARCHIVE_WORDS.empty);
    expect(archiveResultWords({ ...NOTE, payments: 3 }, true)).toBe('Archived 3 payments.');
    const tree = await show(reader(1, 0));
    await press(tree, 'records-archive');
    await untilText(tree, 'records-result', ARCHIVE_WORDS.heldBack);
    const clear = await show(reader(0, 0));
    await press(clear, 'records-archive');
    await untilText(clear, 'records-result', ARCHIVE_WORDS.empty);
  });

  it('its counts follow an archive run that someone else asked for', async () => {
    const t = await archiveTill(many(250), { auto: false });
    const tree = await show(t.service);
    await untilText(tree, 'records-live', liveWords(250));
    await act(async () => {
      await t.service.archiveNow('asked');
    });
    await untilText(tree, 'records-live', liveWords(0));
    expect(textOf(tree, 'records-archived')).toBe(archivedWords({ sats: 250 * PRICE, count: 250 }));
    await act(async () => {
      tree.unmount();
    });
    await t.service.close();
  }, 60000);
});
