// The archive's rule (slice 2.3): what looks final, how far back one job reaches, and the words of Records.
import type { Payment } from 'cashucard';
import {
  ARCHIVE_AT,
  ARCHIVE_BITE,
  ARCHIVE_NOTE_KEYS,
  ARCHIVE_WORDS,
  archiveDays,
  archivedWords,
  archiveResultWords,
  DAY_MS,
  lastArchiveWords,
  liveWords,
  looksFinal,
  RECORD_LINE,
  type ArchiveNote,
} from '../src/till/archive';
import { heldPayment } from './helpers/fake-till';

const NOW = new Date(2026, 10, 22, 12, 0).getTime();
const p = (n: number, o: Partial<Payment> = {}): Payment => ({
  ...heldPayment('s-' + n),
  state: 'delivered',
  paymentId: 'pay:' + String(n).padStart(4, '0'),
  at: NOW - 100000 + n,
  ...o,
});
/** written at NOW - 100000 + 10 * n for every payment given */
const writtenOf = (pays: readonly Payment[]): Map<string, number> =>
  new Map(pays.map((x) => [x.paymentId, NOW - 100000 + 10 * Number(x.paymentId.slice(4))]));
/** the time archive() reaches back to, for those days */
const reach = (days: number): number => NOW - days * DAY_MS;
const note = (o: Partial<ArchiveNote>): ArchiveNote => ({
  why: 'asked',
  at: new Date(2026, 10, 22, 4, 10).getTime(),
  ms: 10,
  bites: 1,
  payments: 0,
  rows: 0,
  left: 0,
  ok: true,
  error: null,
  ...o,
});
const plain = (s: string): void => {
  expect(s).not.toContain('—');
  expect(s).not.toContain('–');
  expect(/crypto|paid back|settled/i.test(s)).toBe(false);
};

describe('the archive rule', () => {
  it('the line, the start and the bite', () => {
    expect(RECORD_LINE).toBe(1000);
    expect(ARCHIVE_AT).toBe(500);
    expect(ARCHIVE_BITE).toBe(100);
    expect(ARCHIVE_AT).toBeLessThan(RECORD_LINE);
    expect(ARCHIVE_BITE).toBeLessThanOrEqual(ARCHIVE_AT);
  });

  it('only a delivered or taken out payment of the merchant, owing and holding nothing for the card, looks final', () => {
    expect(looksFinal(p(1))).toBe(true);
    expect(looksFinal(p(1, { state: 'exported' }))).toBe(true);
    for (const s of ['taking', 'held', 'gone', 'unrecovered', 'lost', 'spent-not-restored', 'returning', 'returned'] as const) {
      expect(looksFinal(p(1, { state: s }))).toBe(false);
    }
    expect(looksFinal(p(1, { extra: 'paid-twice' }))).toBe(false);
    expect(looksFinal(p(1, { extra: 'late', state: 'exported' }))).toBe(false);
    expect(looksFinal(p(1, { owedToCard: 3 }))).toBe(false);
    expect(looksFinal(p(1, { unconfirmed: 3 }))).toBe(false);
  });

  it('one job reaches back to the bite-th oldest payment that looks final, by when its row was written', () => {
    const pays = Array.from({ length: 250 }, (_, i) => p(i + 1));
    const days = archiveDays(pays, writtenOf(pays), NOW, 100)!;
    expect(days).not.toBeNull();
    const t100 = NOW - 100000 + 1000;
    const t101 = NOW - 100000 + 1010;
    expect(reach(days)).toBeGreaterThanOrEqual(t100);
    // a millisecond past the 100th: no rounding of days can leave it out
    expect(reach(days)).toBeGreaterThan(t100 + 0.5);
    expect(reach(days)).toBeLessThan(t101);
    const all = archiveDays(pays, writtenOf(pays), NOW, 1000)!;
    expect(reach(all)).toBeGreaterThanOrEqual(NOW - 100000 + 2500);
  });

  it('a payment that does not look final, and every payment of its sale, never sets how far back', () => {
    const pays = [
      p(1, { state: 'taking' }),
      p(2, { id: 's-9' }),
      p(3, { id: 's-9', state: 'held' }),
      p(4),
      p(5),
    ];
    const days = archiveDays(pays, writtenOf(pays), NOW, 1)!;
    expect(reach(days)).toBeGreaterThanOrEqual(NOW - 100000 + 40);
    expect(reach(days)).toBeLessThan(NOW - 100000 + 50);
    expect(archiveDays([p(1, { state: 'taking' }), p(2, { state: 'lost' })], writtenOf([p(1), p(2)]), NOW, 100)).toBeNull();
  });

  it('nothing to reach: no payment, none written, or no bite', () => {
    expect(archiveDays([], new Map(), NOW, 100)).toBeNull();
    expect(archiveDays([p(1)], new Map(), NOW, 100)).toBeNull();
    expect(archiveDays([p(1)], writtenOf([p(1)]), NOW, 0)).toBeNull();
  });

  it('a clock put back asks up to now, never into the future', () => {
    const pays = [p(1)];
    expect(archiveDays(pays, new Map([['pay:0001', NOW + 60000]]), NOW, 100)).toBe(0);
  });

  it('the note holds counts and times only', () => {
    expect(Object.keys(note({})).sort()).toEqual([...ARCHIVE_NOTE_KEYS].sort());
  });

  it('the words of Records', () => {
    expect(ARCHIVE_WORDS.title).toBe('Records and reset');
    expect(liveWords(312)).toBe('In the record now: 312 payments.');
    expect(liveWords(1)).toBe('In the record now: 1 payment.');
    expect(archivedWords({ sats: 140000, count: 10000 })).toBe('Paid and archived: 140,000 sats in 10,000 payments.');
    expect(archivedWords({ sats: 0, count: 0 })).toBe('Paid and archived: 0 sats in 0 payments.');
    expect(lastArchiveWords(note({ payments: 100 }))).toBe('Last archived: 22 Nov 2026, 04:10, 100 payments.');
    expect(archiveResultWords(note({ payments: 312 }))).toBe('Archived 312 payments.');
    expect(archiveResultWords(note({ payments: 1 }))).toBe('Archived 1 payment.');
    expect(archiveResultWords(note({ payments: 0, left: 4 }))).toBe(
      'Nothing to archive now. A payment that is not finished stays in the record.',
    );
    expect(archiveResultWords(note({ payments: 0, left: 0 }))).toBe(
      'Every payment is archived. The record holds none now.',
    );
    expect(archiveResultWords(note({ payments: 200, ok: false, error: 'journal' }))).toBe(
      'Archived 200 payments, then the archive stopped. Nothing was lost. Try again later.',
    );
    expect(archiveResultWords(note({ payments: 0, ok: false, error: 'busy' }))).toBe(
      'The archive could not run now. Nothing was lost. Try again later.',
    );
    for (const w of Object.values(ARCHIVE_WORDS)) {
      plain(w);
    }
    expect(ARCHIVE_WORDS.shareNote).toContain('eCash');
  });
});
