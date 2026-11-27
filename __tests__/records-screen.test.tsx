// Records (slice 2.3): the counts, archiving by hand once at a time, what an archive did in plain words, the payment
// list handed to the share sheet with no token, key or id in it, and a record that cannot be read.
import type { Payment } from 'cashucard';
import React from 'react';
import { StyleSheet } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { RecordsScreen, type RecordsReader } from '../src/screens/RecordsScreen';
import { ARCHIVE_WORDS, type ArchiveNote } from '../src/till/archive';
import type { ArchivedPayment, ArchivedTakings } from '../src/till/store/archive';
import { LIGHT } from '../src/ui/theme';
import { heldPayment } from './helpers/fake-till';
import { has, isDisabled, nodes, press, textOf, until, untilText } from './helpers/render';

const AT = new Date(2026, 10, 22, 4, 10).getTime();
const note = (o: Partial<ArchiveNote>): ArchiveNote => ({
  why: 'asked',
  at: AT,
  ms: 5,
  bites: 1,
  payments: 0,
  rows: 0,
  left: 0,
  ok: true,
  error: null,
  ...o,
});
const colourOf = (tree: ReactTestRenderer, id: string): unknown =>
  (StyleSheet.flatten(nodes(tree, id)[1].props.style) as Record<string, unknown>).color;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
    });
  }
};

interface Fake extends RecordsReader {
  calls: string[];
  live: Payment[];
  archived: ArchivedTakings;
  list: ArchivedPayment[];
  next: Array<() => Promise<ArchiveNote>>;
  last: ArchiveNote | null;
  failReads: boolean;
}

function fake(): Fake {
  const f: Fake = {
    calls: [],
    live: [
      {
        ...heldPayment('s-secret-sale'),
        at: AT,
        paymentId: 'pay:' + 'd'.repeat(32),
        cardKey: '02' + 'c'.repeat(64),
        change: 'cashuB' + 'x'.repeat(60),
      },
    ],
    archived: { sats: 140, count: 10 },
    list: [{ state: 'delivered', at: AT - 60000, amount: 14, fee: 1, mint: 'https://mint.test', unit: 'sat' }],
    next: [],
    last: null,
    failReads: false,
    payments: async () => {
      f.calls.push('payments');
      if (f.failReads) {
        throw new Error('the store is closed');
      }
      return f.live;
    },
    archivedTakings: async (from: number | null, to: number | null) => {
      f.calls.push('archivedTakings ' + String(from) + ' ' + String(to));
      return f.archived;
    },
    archivedPayments: async () => {
      f.calls.push('archivedPayments');
      return f.list;
    },
    archiveNow: async (why) => {
      f.calls.push('archiveNow ' + why);
      const n = f.next.shift();
      if (n === undefined) {
        throw new Error('the till is not open');
      }
      return n();
    },
    lastArchive: () => f.last,
  };
  return f;
}

let last: ReactTestRenderer | null = null;

async function show(f: Fake, share?: (title: string, text: string) => Promise<void>): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<RecordsScreen reader={f} share={share} onBack={() => undefined} />);
  });
  last = tree;
  await flush();
  return tree;
}

afterEach(async () => {
  const tree = last;
  if (tree !== null) {
    await act(async () => {
      tree.unmount();
    });
    last = null;
  }
});

describe('Records', () => {
  it('says what the record holds, what is paid and archived, and why the till archives', async () => {
    const f = fake();
    const tree = await show(f, async () => undefined);
    expect(textOf(tree, 'records-title')).toBe('Records and reset');
    expect(textOf(tree, 'records-live')).toBe('In the record now: 1 payment.');
    expect(textOf(tree, 'records-archived')).toBe('Paid and archived: 140 sats in 10 payments.');
    expect(textOf(tree, 'records-help')).toBe(ARCHIVE_WORDS.help);
    expect(textOf(tree, 'records-reset')).toBe('Resetting the record comes in a later version.');
    expect(nodes(tree, 'records-archive')[0].props.label).toBe('Archive finished payments now');
    expect(nodes(tree, 'records-share')[0].props.label).toBe('Share the payment list');
    expect(has(tree, 'records-last')).toBe(false);
    expect(has(tree, 'records-result')).toBe(false);
    expect(f.calls).toEqual(['payments', 'archivedTakings null null']);
  });

  it('archiving by hand runs one asked archive, says what it did, and reads the record again', async () => {
    const f = fake();
    f.next.push(async () => {
      f.live = [];
      f.archived = { sats: 154, count: 11 };
      f.last = note({ payments: 1 });
      return note({ payments: 1 });
    });
    const tree = await show(f);
    await press(tree, 'records-archive');
    await untilText(tree, 'records-result', 'Archived 1 payment.');
    await untilText(tree, 'records-live', 'In the record now: 0 payments.');
    expect(textOf(tree, 'records-archived')).toBe('Paid and archived: 154 sats in 11 payments.');
    expect(textOf(tree, 'records-last')).toBe('Last archived: 22 Nov 2026, 04:10, 1 payment.');
    expect(colourOf(tree, 'records-result')).toBe(LIGHT.text);
    expect(f.calls.filter((c) => c.startsWith('archiveNow'))).toEqual(['archiveNow asked']);
    expect(isDisabled(tree, 'records-archive')).toBe(false);
  });

  it('a second press while an archive runs does nothing, and nothing else can start meanwhile', async () => {
    const f = fake();
    let finish!: (n: ArchiveNote) => void;
    f.next.push(
      () =>
        new Promise<ArchiveNote>((r) => {
          finish = r;
        }),
    );
    const tree = await show(f, async () => undefined);
    const button = nodes(tree, 'records-archive')[0];
    await act(async () => {
      button.props.onPress();
      button.props.onPress();
    });
    await flush();
    expect(f.calls.filter((c) => c.startsWith('archiveNow'))).toEqual(['archiveNow asked']);
    expect(isDisabled(tree, 'records-archive')).toBe(true);
    expect(isDisabled(tree, 'records-share')).toBe(true);
    expect(textOf(tree, 'records-archiving')).toBe(
      'Archiving, a part at a time. A sale goes first: it waits only for the part being archived when it is asked.',
    );
    await act(async () => {
      finish(note({ payments: 3 }));
    });
    await untilText(tree, 'records-result', 'Archived 3 payments.');
    expect(has(tree, 'records-archiving')).toBe(false);
  });

  it('an archive that stopped, or one the till refused, is told in the bad tone', async () => {
    const f = fake();
    f.next.push(async () => note({ payments: 200, ok: false, error: 'journal' }));
    const tree = await show(f);
    await press(tree, 'records-archive');
    await untilText(
      tree,
      'records-result',
      'Archived 200 payments, then the archive stopped. Nothing was lost. Try again later.',
    );
    expect(colourOf(tree, 'records-result')).toBe(LIGHT.bad);
    await press(tree, 'records-archive');
    await untilText(tree, 'records-result', 'The till is not open. Nothing was archived.');
    expect(colourOf(tree, 'records-result')).toBe(LIGHT.bad);
  });

  it('sharing builds the list from the record and the archive when pressed, and hands only that to the share sheet', async () => {
    const f = fake();
    const shared: Array<{ title: string; text: string }> = [];
    const tree = await show(f, async (title, text) => {
      shared.push({ title, text });
    });
    expect(f.calls).not.toContain('archivedPayments');
    expect(textOf(tree, 'records-share-note')).toBe(
      'The list holds dates, amounts and what each payment was. It holds no eCash and no keys.',
    );
    await press(tree, 'records-share');
    await flush();
    expect(shared).toHaveLength(1);
    expect(shared[0].title).toBe('Cashu Card POS payments');
    const lines = shared[0].text.split('\r\n');
    expect(lines).toEqual([
      'date,time,sats,what,takings,fee_sats,mint,archived',
      '2026-11-22,04:09,14,PAID,yes,1,mint.test,yes',
      '2026-11-22,04:10,14,PAID,yes,1,mint.test,no',
      '',
    ]);
    for (const bad of ['cashu', 'pay:', 'cccc', 'dddd', 's-secret']) {
      expect(shared[0].text).not.toContain(bad);
    }
    expect(has(tree, 'records-share-failed')).toBe(false);
    expect(isDisabled(tree, 'records-share')).toBe(false);
  });

  it('a share that fails says so; with no share sheet there is nothing to press', async () => {
    const f = fake();
    const tree = await show(f, async () => {
      throw new Error('the sheet was refused');
    });
    await press(tree, 'records-share');
    await until(tree, 'records-share-failed');
    expect(textOf(tree, 'records-share-failed')).toBe('The list could not be shared now.');
    expect(colourOf(tree, 'records-share-failed')).toBe(LIGHT.bad);
    await act(async () => {
      tree.unmount();
    });
    last = null;
    const bare = await show(fake());
    expect(has(bare, 'records-share')).toBe(false);
    expect(has(bare, 'records-share-note')).toBe(false);
    expect(has(bare, 'records-archive')).toBe(true);
  });

  it('a record that cannot be read says so, and shows no count', async () => {
    const f = fake();
    f.failReads = true;
    const tree = await show(f);
    expect(textOf(tree, 'records-failed')).toBe('The record could not be read now.');
    expect(has(tree, 'records-live')).toBe(false);
    expect(has(tree, 'records-archived')).toBe(false);
  });
});
