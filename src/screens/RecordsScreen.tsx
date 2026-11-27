/* Records (slice 2.3): what the record holds and what is archived, archiving by hand (the merchant's "clear the till"),
 * and the payment list for the share sheet. Behind the owner check on entry (nav GATED, the `records` reason); nothing
 * here asks it again. Nothing here shows a token, a key or an id. The payment list is built only when asked, handed to
 * the share sheet and dropped. Resetting the record comes in a later slice. */

import React, { useEffect, useRef, useState } from 'react';
import type { Payment, SkippedRow } from 'cashucard';
import type { LightningSaleReceipt } from '../till/lightning-sale';
import { CSV_TITLE, paymentsCsv } from '../app/csv';
import {
  ARCHIVE_WORDS,
  archivedWords,
  archiveResultWords,
  lastArchiveWords,
  liveWords,
  progressWords,
  unreadWords,
  type ArchiveNote,
  type ArchiveProgress,
  type ArchiveWhy,
} from '../till/archive';
import type { ArchivedPayment, ArchivedTakings } from '../till/store/archive';
import { Body, Button, Gap, Screen } from '../ui/kit';

/** What Records needs of the till service, and nothing else. */
export interface RecordsReader {
  listLightningSales?(): Promise<LightningSaleReceipt[]>;
  payments(): Promise<Payment[]>;
  archivedTakings(from: number | null, to: number | null): Promise<ArchivedTakings>;
  archivedPayments(): Promise<ArchivedPayment[]>;
  archiveNow(why: ArchiveWhy): Promise<ArchiveNote>;
  lastArchive(): ArchiveNote | null;
  /** how far the archive run going now has come, or null (slice 2.3 review); absent: never shown */
  archiveProgress?(): ArchiveProgress | null;
  /** l after each job of a run, null at its end; answers the unsubscribe */
  onArchiveProgress?(l: (p: ArchiveProgress | null) => void): () => void;
  /** runs a whole reading so that no payment is read in both the record and the archive, or in neither (the till
   * service's steady, slice 2.3 review); absent: the reading is made as it is */
  steady?<T>(f: () => Promise<T>): Promise<T>;
  /** the rows the library does not read (slice 2.3b): damaged ones, and an earlier version's; absent: none told */
  damagedRows?(): Promise<SkippedRow[]>;
  olderRows?(): Promise<SkippedRow[]>;
}

export interface RecordsProps {
  reader: RecordsReader;
  /** hands the payment list to the phone's share sheet; absent: the list cannot be shared here */
  share?: (title: string, text: string) => Promise<void>;
  onBack: () => void;
}

type Counts =
  | { kind: 'reading' }
  | { kind: 'shown'; live: number; archived: ArchivedTakings; damaged: number; older: number }
  | { kind: 'failed' };

export function RecordsScreen(p: RecordsProps): React.JSX.Element {
  const [counts, setCounts] = useState<Counts>({ kind: 'reading' });
  const [busy, setBusy] = useState<'archive' | 'share' | null>(null);
  const [progress, setProgress] = useState<ArchiveProgress | null>(() => p.reader.archiveProgress?.() ?? null);
  const [result, setResult] = useState<{ words: string; bad: boolean } | null>(null);
  const [shareFailed, setShareFailed] = useState(false);
  const props = useRef<RecordsProps>(p);
  props.current = p;
  const alive = useRef(true);
  const seq = useRef(0);
  /** set at once by a press, so that a second press before the screen draws again does nothing */
  const working = useRef(false);
  /** rows the library does not read, as the last reading found them (slice 2.3b) */
  const unread = useRef(0);

  /** rows the library does not read, by kind, as read on entry: they come only from outside, never from an archive */
  const rows = useRef<{ damaged: number; older: number } | null>(null);

  /** One reading of the counts; only the newest reading's answer is used. The rows the library does not read are read
   * on the first only (slice 2.3b). */
  function read(): void {
    seq.current += 1;
    const mine = seq.current;
    const r = props.current.reader;
    const reading = async (): Promise<Counts> => {
      const lightning = await r.listLightningSales?.() ?? [];
      const received = lightning.filter(row => row.state !== 'unpaid' && row.state !== 'expired');
      const live = (await r.payments()).length + received.length;
      const archived = await r.archivedTakings(null, null);
      if (rows.current === null) {
        rows.current = {
          damaged: r.damagedRows === undefined ? 0 : (await r.damagedRows()).length,
          older: r.olderRows === undefined ? 0 : (await r.olderRows()).length,
        };
      }
      return { kind: 'shown', live, archived, damaged: rows.current.damaged, older: rows.current.older };
    };
    (r.steady === undefined ? reading() : r.steady(reading)).then(
      (c) => {
        if (alive.current && mine === seq.current) {
          if (c.kind === 'shown') {
            unread.current = c.damaged + c.older;
          }
          setCounts(c);
        }
      },
      () => {
        if (alive.current && mine === seq.current) {
          setCounts({ kind: 'failed' });
        }
      },
    );
  }

  useEffect(() => {
    alive.current = true;
    read();
    // how far an archive run has come, whoever asked for it, told after each of its jobs; the counts are read again
    // each time, so that they follow the run (slice 2.3b)
    const off = props.current.reader.onArchiveProgress?.((x) => {
      if (alive.current) {
        setProgress(x);
        read();
      }
    });
    return () => {
      alive.current = false;
      off?.();
    };
  }, []);

  function archive(): void {
    if (working.current) {
      return;
    }
    working.current = true;
    setBusy('archive');
    setResult(null);
    props.current.reader.archiveNow('asked').then(
      (n) => {
        working.current = false;
        if (!alive.current) {
          return;
        }
        setBusy(null);
        setResult({ words: archiveResultWords(n, unread.current > 0), bad: !n.ok });
        read();
      },
      () => {
        working.current = false;
        if (!alive.current) {
          return;
        }
        setBusy(null);
        setResult({ words: ARCHIVE_WORDS.notOpen, bad: true });
      },
    );
  }

  function share(): void {
    const s = props.current.share;
    if (working.current || s === undefined) {
      return;
    }
    working.current = true;
    setBusy('share');
    setShareFailed(false);
    const r = props.current.reader;
    const list = async (): Promise<string> => paymentsCsv(await r.payments(), await r.archivedPayments(), await r.listLightningSales?.());
    const run = async (): Promise<void> => {
      // one steady reading of the record and the archive: no payment listed twice or left out
      const text = r.steady === undefined ? await list() : await r.steady(list);
      await s(CSV_TITLE, text);
    };
    run().then(
      () => {
        working.current = false;
        if (alive.current) {
          setBusy(null);
        }
      },
      () => {
        working.current = false;
        if (alive.current) {
          setBusy(null);
          setShareFailed(true);
        }
      },
    );
  }

  const last = p.reader.lastArchive();
  return (
    <Screen title={ARCHIVE_WORDS.title} titleID="records-title" onBack={p.onBack}>
      {counts.kind === 'reading' ? (
        <Body testID="records-reading" tone="muted">
          {ARCHIVE_WORDS.reading}
        </Body>
      ) : null}
      {counts.kind === 'failed' ? (
        <Body testID="records-failed" tone="bad">
          {ARCHIVE_WORDS.readFailed}
        </Body>
      ) : null}
      {counts.kind === 'shown' ? <Body testID="records-live">{liveWords(counts.live)}</Body> : null}
      {counts.kind === 'shown' ? <Body testID="records-archived">{archivedWords(counts.archived)}</Body> : null}
      {counts.kind === 'shown' && counts.damaged + counts.older > 0 ? (
        <Body testID="records-unread" tone="bad">
          {unreadWords(counts.damaged, counts.older)}
        </Body>
      ) : null}
      {last !== null && last.payments > 0 ? (
        <Body testID="records-last" tone="muted">
          {lastArchiveWords(last)}
        </Body>
      ) : null}
      <Body testID="records-help" tone="muted">
        {ARCHIVE_WORDS.help}
      </Body>
      <Gap />
      <Button
        testID="records-archive"
        label={ARCHIVE_WORDS.archive}
        kind="plain"
        disabled={busy !== null}
        onPress={archive}
      />
      {busy === 'archive' ? (
        <Body testID="records-archiving" tone="muted">
          {ARCHIVE_WORDS.archiving}
        </Body>
      ) : null}
      {progress !== null && progress.waiting === true ? (
        <Body testID="records-waiting" tone="muted">
          {ARCHIVE_WORDS.waiting}
        </Body>
      ) : null}
      {progress !== null && (progress.waiting !== true || progress.archived > 0) ? (
        <Body testID="records-progress" tone="muted">
          {progressWords(progress)}
        </Body>
      ) : null}
      {result !== null ? (
        <Body testID="records-result" tone={result.bad ? 'bad' : 'normal'}>
          {result.words}
        </Body>
      ) : null}
      {p.share === undefined ? null : <Gap />}
      {p.share === undefined ? null : (
        <Button
          testID="records-share"
          label={ARCHIVE_WORDS.share}
          kind="plain"
          disabled={busy !== null}
          onPress={share}
        />
      )}
      {p.share === undefined ? null : (
        <Body testID="records-share-note" tone="muted">
          {ARCHIVE_WORDS.shareNote}
        </Body>
      )}
      {shareFailed ? (
        <Body testID="records-share-failed" tone="bad">
          {ARCHIVE_WORDS.shareFailed}
        </Body>
      ) : null}
      <Gap />
      <Body testID="records-reset" tone="muted">
        {ARCHIVE_WORDS.reset}
      </Body>
    </Screen>
  );
}
