import React from 'react';
import { plural } from '../format';
import { SALES_STOPPED } from '../till/card-errors';
import type { MintEntry } from '../till/settings';
import { heldUnreadableWords } from '../till/payment-words';
import { keptWords } from '../till/settle';
import { Body, Button } from '../ui/kit';

export interface HomeProps {
  mints: MintEntry[];
  note: string | null;
  onOpenOwed: () => void;
  /** sats the keep-store holds (settled into this phone's wallet); shown only above 0 */
  kept?: number | null;
  /** what settle told the merchant and the merchant has not seen yet */
  notices?: readonly string[];
  /** the words for a settle that failed, or null */
  settleNote?: string | null;
  /** the merchant pressed Seen */
  onNoticesSeen?: () => void;
  /** how many notices wait behind those shown */
  noticesMore?: number;
  /** each shown notice's tone, by its place (normal when absent) */
  noticeTones?: readonly ('normal' | 'good' | 'bad')[];
  /** money owed to cards of mints the till does not take now (strandedWords), one line each, never dismissed */
  owed?: readonly string[];
  /** how many payments are held because their sale's record does not read (slice 2.3b); shown only above 0 */
  unreadable?: number;
  /** new sales are stopped: the phone did not save the record's generation (slice 2.4); the line is shown and New sale
   * is disabled while it holds */
  stopped?: boolean;
}

/** How many of the mints are taking cards, in words. */
export function homeStatus(mints: readonly MintEntry[]): string {
  let ok = 0;
  for (const m of mints) {
    if (m.status === 'ok') {
      ok += 1;
    }
  }
  if (ok > 0) {
    return 'Ready to take cards from ' + plural(ok, 'mint', 'mints') + '.';
  }
  if (mints.length > 0) {
    return 'No mint is taking cards. Check your mints in Settings.';
  }
  return 'No mint yet. Add one in Settings.';
}

export const HOME_WORDS = { seen: 'Seen' } as const;

/** '2 more notices wait after these. Press Seen to see them.' */
export function noticesMoreWords(n: number): string {
  if (n === 1) {
    return '1 more notice waits after these. Press Seen to see it.';
  }
  return plural(n, 'more notice', 'more notices') + ' wait after these. Press Seen to see them.';
}

/** Current readiness and the recorded notices the cashier can act on before taking a payment. */
export function TillNotices(p: HomeProps): React.JSX.Element {
  return (
    <>
      {!p.mints.some(mint => mint.status === 'ok') && (
        <Body testID="home-status" tone="muted">{homeStatus(p.mints)}</Body>
      )}
      {p.note !== null ? (
        <Body testID="home-note" tone="bad">
          {p.note}
        </Body>
      ) : null}
      {p.stopped === true ? (
        <Body testID="home-stopped" tone="bad">
          {SALES_STOPPED}
        </Body>
      ) : null}
      {p.kept !== undefined && p.kept !== null && p.kept > 0 ? (
        <Body testID="home-kept" tone="muted">{keptWords(p.kept)}</Body>
      ) : null}
      {p.settleNote !== undefined && p.settleNote !== null ? (
        <Body testID="home-settle" tone="bad">
          {p.settleNote}
        </Body>
      ) : null}
      {p.unreadable !== undefined && p.unreadable > 0 ? (
        <Body testID="home-unreadable" tone="bad">
          {heldUnreadableWords(p.unreadable)}
        </Body>
      ) : null}
      {(p.owed ?? []).map((o, i) => (
        <Body key={'owed-' + i} testID={'home-owed-' + i} tone="bad">
          {o}
        </Body>
      ))}
      {!!p.owed?.length && <Button testID="home-owed-open" label="Open Owed to cards" kind="plain"
        onPress={p.onOpenOwed} />}
      {(p.notices ?? []).map((n, i) => (
        <Body key={'notice-' + i} testID={'home-notice-' + i} tone={p.noticeTones?.[i] ?? 'normal'}>
          {n}
        </Body>
      ))}
      {p.noticesMore !== undefined && p.noticesMore > 0 ? (
        <Body testID="home-notice-more" tone="muted">
          {noticesMoreWords(p.noticesMore)}
        </Body>
      ) : null}
      {(p.notices ?? []).length > 0 ? (
        <Button testID="home-notice-ok" label={HOME_WORDS.seen} kind="plain" onPress={() => p.onNoticesSeen?.()} />
      ) : null}
    </>
  );
}
