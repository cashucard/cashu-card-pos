/* Records while the till archives (slice 2.3 review): how far the run has come, from the run's own counts, shown as each
 * job ends whoever asked for the run, and dropped when it ends. */

import type { Payment } from 'cashucard';
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { RecordsScreen, type RecordsReader } from '../src/screens/RecordsScreen';
import type { ArchiveProgress } from '../src/till/archive';
import { has, textOf, until } from './helpers/render';

function reader(): { r: RecordsReader; tell: (p: ArchiveProgress | null) => void; now: { p: ArchiveProgress | null } } {
  const listeners: Array<(p: ArchiveProgress | null) => void> = [];
  const now: { p: ArchiveProgress | null } = { p: null };
  const r: RecordsReader = {
    payments: async (): Promise<Payment[]> => [],
    archivedTakings: async () => ({ sats: 0, count: 0 }),
    archivedPayments: async () => [],
    archiveNow: async () => {
      throw new Error('not asked here');
    },
    lastArchive: () => null,
    archiveProgress: () => now.p,
    onArchiveProgress: (l) => {
      listeners.push(l);
      return () => {
        listeners.splice(listeners.indexOf(l), 1);
      };
    },
  };
  return {
    r,
    now,
    tell: (p) => {
      now.p = p;
      for (const l of listeners.slice()) {
        l(p);
      }
    },
  };
}

describe('Records while the till archives', () => {
  it("shows how far an archive has come, from the run's own counts, and drops it when the run ends", async () => {
    const f = reader();
    f.now.p = { archived: 100, left: 900 };
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<RecordsScreen reader={f.r} onBack={() => undefined} />);
    });
    await until(tree, 'records-live');
    expect(textOf(tree, 'records-progress')).toBe(
      'Archived so far: 100 payments. Finished payments still in the record: 900.',
    );
    await act(async () => {
      f.tell({ archived: 1200, left: 0 });
    });
    expect(textOf(tree, 'records-progress')).toBe(
      'Archived so far: 1,200 payments. Finished payments still in the record: 0.',
    );
    await act(async () => {
      f.tell(null);
    });
    expect(has(tree, 'records-progress')).toBe(false);
    await act(async () => {
      tree.unmount();
    });
  });
});
