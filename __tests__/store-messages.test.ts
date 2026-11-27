import type { OpenStore, StoreOutcome } from '../src/till/store/open-store';
import { storeMessage } from '../src/till/store/messages';

const ALL: Array<StoreOutcome<unknown>> = [
  { kind: 'journal-missing', storedGeneration: 9 },
  { kind: 'rolled-back', journalGeneration: 3, storedGeneration: 9 },
  { kind: 'unreadable', why: 'x' },
  { kind: 'key-missing' },
  { kind: 'secure-store-unavailable', why: 'x' },
  { kind: 'files-unavailable', why: 'x' },
  { kind: 'newer-format', version: 2 },
  { kind: 'store-refused', why: 'x' },
  { kind: 'open-failed', why: 'x' },
];

const TITLES: Record<Exclude<StoreOutcome<unknown>['kind'], 'ready'>, string> = {
  'journal-missing': "This phone's payment record is missing",
  'rolled-back': 'This payment record is older than the one last used on this phone',
  unreadable: 'This phone cannot read its payment record',
  'key-missing': "The key to this phone's payment record is gone",
  'secure-store-unavailable': 'Unlock the phone, then try again',
  'newer-format': 'This record was made by a newer version of the app',
  'store-refused': "The till's storage did not start safely",
  'files-unavailable': "The till's record could not be opened",
  'open-failed': "The till's record could not be opened",
};

/** The message for one of the outcomes, never null (the test throws when it is). */
function messageOf(o: StoreOutcome<unknown>) {
  const m = storeMessage(o);
  if (m === null) {
    throw new Error('no message for ' + o.kind);
  }
  return m;
}

describe('what the merchant is told', () => {
  it('ready has no message', () => {
    expect(
      storeMessage({ kind: 'ready', value: 1, store: {} as OpenStore, firstRun: false }),
    ).toBeNull();
  });

  it('every other state has a title, a body, and a way to wait or try again', () => {
    for (const o of ALL) {
      const m = messageOf(o);
      expect(m.state).toBe(o.kind);
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.body.length).toBeGreaterThan(0);
      expect(['not-now', 'try-again']).toContain(m.offers[0].id);
    }
  });

  it('the titles are as written', () => {
    for (const o of ALL) {
      expect(messageOf(o).title).toBe(TITLES[o.kind as Exclude<StoreOutcome<unknown>['kind'], 'ready'>]);
    }
  });

  it('a missing record offers a new record only behind its warning and the device check', () => {
    const m = messageOf({ kind: 'journal-missing', storedGeneration: 9 });
    expect(m.offers.map((x) => x.id)).toEqual(['not-now', 'start-new']);
    const sn = m.offers.find((x) => x.id === 'start-new');
    expect(sn).toBeDefined();
    if (sn === undefined) {
      throw new Error('no start-new offer');
    }
    expect(sn.guarded).toBe(true);
    expect(sn.warning).toBe(
      'A new record starts empty. Any money or customer change from the missing record requires its encrypted backup.',
    );
    expect(m.body.endsWith('Nothing has been changed.')).toBe(true);
  });

  it('an older record offers itself, never a new record over it', () => {
    const m = messageOf({ kind: 'rolled-back', journalGeneration: 3, storedGeneration: 9 });
    expect(m.offers.map((x) => x.id)).toEqual(['not-now', 'use-older']);
    const uo = m.offers.find((x) => x.id === 'use-older');
    expect(uo).toBeDefined();
    if (uo === undefined) {
      throw new Error('no use-older offer');
    }
    expect(uo.guarded).toBe(true);
    expect(uo.warning).toContain('missing from it');
  });

  it('an unreadable record and a lost key offer to set it aside, never to delete it', () => {
    const ms = [
      messageOf({ kind: 'unreadable', why: 'x' }),
      messageOf({ kind: 'key-missing' }),
    ];
    for (const m of ms) {
      expect(m.offers.map((x) => x.id)).toEqual(['not-now', 'set-aside']);
      const sa = m.offers.find((x) => x.id === 'set-aside');
      expect(sa).toBeDefined();
      if (sa === undefined) {
        throw new Error('no set-aside offer');
      }
      expect(sa.guarded).toBe(true);
      expect(m.notOffered).toContain('Deleting the record.');
      for (const x of m.offers) {
        expect(['not-now', 'set-aside']).toContain(x.id);
      }
    }
  });

  it('a locked secure store offers only to try again', () => {
    const m = messageOf({ kind: 'secure-store-unavailable', why: 'x' });
    expect(m.offers.map((x) => x.id)).toEqual(['try-again']);
  });

  it('the states where nothing was done say so', () => {
    const unchanged = [
      'journal-missing',
      'rolled-back',
      'unreadable',
      'key-missing',
      'secure-store-unavailable',
      'newer-format',
    ];
    for (const o of ALL) {
      const m = messageOf(o);
      if (unchanged.includes(o.kind)) {
        expect(m.body.endsWith('Nothing has been changed.')).toBe(true);
      } else {
        expect(m.body.includes('Nothing has been changed.')).toBe(false);
      }
    }
  });

  it('no text uses a long dash', () => {
    for (const o of ALL) {
      const m = messageOf(o);
      const texts = [
        m.title,
        m.body,
        ...m.offers.flatMap((x) => (x.warning === null ? [x.label] : [x.label, x.warning])),
        ...m.notOffered,
      ];
      for (const t of texts) {
        expect(t).not.toContain('—');
        expect(t).not.toContain('–');
      }
    }
  });

  it('each call gives new arrays', () => {
    const first = messageOf({ kind: 'key-missing' });
    const second = messageOf({ kind: 'key-missing' });
    first.offers.push({ id: 'not-now', label: 'x', warning: null, guarded: false });
    expect(second.offers.length).toBe(2);
  });
});
