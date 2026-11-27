/* The Activity: what the record holds, in the till's own words (slice 1.4). Everything not finished is shown at the top,
 * whatever the record's length; only finished payments are paged. The record is read with reads only, never in the
 * till's queue. Nothing here shows a token, a card's key or an id. */

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Claim, Payment } from 'cashucard';
import { dateTime, hostOf, sats } from '../format';
import {
  ACTIVITY_START,
  ACTIVITY_WORDS,
  activityReport,
  activityStep,
  activityView,
  claimLine,
  damagedLine,
  moreWords,
  olderLine,
  owedLine,
  paymentLine,
  readActivity,
  shownWords,
  takingsWords,
  type ActivityEvent,
  type ActivityReader,
  type ActivityReport,
  type ActivityState,
  type LightningActivity,
} from '../app/activity';
import { paymentTone } from '../till/payment-words';
import { Body, Button, Gap, Screen } from '../ui/kit';
import { MerchantPanel } from './MerchantPanel';
import { FONT, SPACE, TOUCH, TYPE, useTheme } from '../ui/theme';

export interface ActivityProps {
  reader: ActivityReader;
  now: () => number;
  /** how many pages of finished payments are shown (the app root keeps it) */
  pages: number;
  onPages: (pages: number) => void;
  /** a payment row was pressed: its paymentId, for the route only */
  onOpen: (paymentId: string) => void;
  /** l after every settle that ended; answers the unsubscribe */
  onPayments: (l: (changed: Payment[]) => void) => () => void;
  /** development only: what each reading found */
  onRead?: (r: ActivityReport) => void;
  onBack?: () => void;
}

function Heading(p: { testID: string; children: string }): React.JSX.Element {
  const palette = useTheme();
  return (
    <Text testID={p.testID} accessibilityRole="header" style={[styles.heading, { color: palette.text }]}>
      {p.children}
    </Text>
  );
}

function PaymentRow(p: {
  section: 'unf' | 'loss' | 'pay';
  i: number;
  payment: Payment;
  /** the till told the merchant this payment may be paid twice: the row says so, in the bad tone */
  twice: boolean;
  onOpen: (paymentId: string) => void;
}): React.JSX.Element {
  const palette = useTheme();
  const words = paymentLine(p.payment, p.twice);
  /** the merchant's money not finished only because change is owed to its card: what is owed, in the plain tone */
  const owed = owedLine(p.payment);
  return (
    <Pressable
      testID={p.section + '-open-' + p.i}
      accessibilityRole="button"
      accessibilityLabel={owed === null ? words : words + '. ' + owed}
      onPress={() => p.onOpen(p.payment.paymentId)}
      style={({ pressed }) => [styles.row, { borderColor: palette.line, backgroundColor: pressed ? palette.plain : palette.field }]}
    >
      <View style={styles.rowCopy}>
        <Body testID={p.section + '-row-' + p.i} tone={p.twice ? 'bad' : paymentTone(p.payment)}>
          {words}
        </Body>
        {owed === null ? null : <Body testID={p.section + '-owed-' + p.i}>{owed}</Body>}
      </View>
      <View style={[styles.chevron, { borderColor: palette.muted }]} />
    </Pressable>
  );
}

function LightningRow({ row }: { row: LightningActivity }): React.JSX.Element {
  const state = row.state === 'paid' ? 'Paid' : row.state === 'extra' ? 'Customer return' : 'Confirming';
  return <MerchantPanel>
    <Body testID="act-lightning-amount" tone={row.state === 'paid' ? 'good' : 'normal'}>
      {sats(row.amount) + ' · ' + state}
    </Body>
    <Body tone="muted">{dateTime(row.at) + ' · ' + hostOf(row.mint)}</Body>
    {row.state === 'extra' && <Body>See Owed to Cards for the status of the customer’s return.</Body>}
  </MerchantPanel>;
}

/** An open claim that is a card payment waiting for its card: its line, pressable, opening that payment's page. */
function ClaimRow(p: { i: number; claim: Claim; onOpen: (paymentId: string) => void }): React.JSX.Element {
  const palette = useTheme();
  const words = claimLine(p.claim, true);
  return (
    <Pressable
      testID={'claim-open-' + p.i}
      accessibilityRole="button"
      accessibilityLabel={words}
      onPress={() => p.onOpen(p.claim.id)}
      style={({ pressed }) => [styles.row, { borderColor: palette.line, backgroundColor: pressed ? palette.plain : palette.field }]}
    >
      <View style={styles.rowCopy}><Body testID={'claim-row-' + p.i}>{words}</Body></View>
      <View style={[styles.chevron, { borderColor: palette.muted }]} />
    </Pressable>
  );
}

/** Compact audit counts live below the sales when an entire section is empty. */
function EmptySection(p: { id: string; label: string }): React.JSX.Element {
  const palette = useTheme();
  return <View style={styles.emptyRow}>
    <Text testID={p.id} accessibilityRole="header" style={[styles.emptyLabel, { color: palette.muted }]}>
      {p.label}
    </Text>
    <Body testID={p.id + '-none'} tone="muted">{ACTIVITY_WORDS.none}</Body>
  </View>;
}

export function ActivityScreen(p: ActivityProps): React.JSX.Element {
  const [state, setState] = useState<ActivityState>(ACTIVITY_START);
  const stateRef = useRef<ActivityState>(ACTIVITY_START);
  const props = useRef<ActivityProps>(p);
  props.current = p;
  const seq = useRef(0);
  const alive = useRef(true);

  function apply(e: ActivityEvent): void {
    const next = activityStep(stateRef.current, e);
    stateRef.current = next;
    setState(next);
  }

  /** One reading; only the newest reading's answer is used. */
  function read(): void {
    seq.current += 1;
    const mine = seq.current;
    const q = props.current;
    readActivity(q.reader, q.now).then(
      (data) => {
        if (!alive.current || mine !== seq.current) {
          return;
        }
        apply({ type: 'read', data });
        const r = props.current;
        if (r.onRead !== undefined) {
          const at = r.now();
          try {
            r.onRead(activityReport(at, data, activityView(data, r.pages, data.at ?? at)));
          } catch {
            // the host's report is not the till's business
          }
        }
      },
      () => {
        if (!alive.current || mine !== seq.current) {
          return;
        }
        apply({ type: 'fail' });
      },
    );
  }

  useEffect(() => {
    alive.current = true;
    read();
    const off = props.current.onPayments(() => {
      if (alive.current) {
        read();
      }
    });
    return () => {
      alive.current = false;
      off();
    };
  }, []);

  if (state.kind === 'reading') {
    return (
      <Screen title={ACTIVITY_WORDS.title} titleID="act-title" onBack={p.onBack}>
        <Body testID="act-reading" tone="muted">
          {ACTIVITY_WORDS.reading}
        </Body>
      </Screen>
    );
  }
  if (state.kind === 'failed') {
    return (
      <Screen title={ACTIVITY_WORDS.title} titleID="act-title" onBack={p.onBack}>
        <Body testID="act-failed" tone="bad">
          {ACTIVITY_WORDS.failed}
        </Body>
        <Button
          testID="act-again"
          label={ACTIVITY_WORDS.again}
          kind="plain"
          onPress={() => {
            apply({ type: 'again' });
            read();
          }}
        />
      </Screen>
    );
  }

  // "today" is the reading's own (slice 2.3 review): a drawing after midnight does not move it
  const v = activityView(state.data, p.pages, state.data.at ?? p.now());
  const twice = new Set(v.twice);
  const waiting = new Set(v.waiting);
  const emptySections = [
    { id: 'act-open', label: ACTIVITY_WORDS.open, empty: !v.unfinished.length },
    { id: 'act-claims', label: ACTIVITY_WORDS.claims, empty: !v.claims.length },
    { id: 'act-losses', label: ACTIVITY_WORDS.losses, empty: !v.losses.length },
    { id: 'act-rows', label: ACTIVITY_WORDS.rows, empty: !v.older.length && !v.damaged.length },
  ].filter(section => section.empty);
  return (
    <Screen title={ACTIVITY_WORDS.title} titleID="act-title" onBack={p.onBack}>
      {state.stale ? (
        <Body testID="act-stale" tone="bad">{ACTIVITY_WORDS.stale}</Body>
      ) : null}
      <MerchantPanel>
        <Body testID="act-today">{takingsWords(ACTIVITY_WORDS.todayLead, v.today)}</Body>
        <Body testID="act-all" tone="muted">{takingsWords(ACTIVITY_WORDS.allLead, v.all)}</Body>
        {v.archived.count > 0 ? (
          <Body testID="act-archived">{takingsWords(ACTIVITY_WORDS.archivedLead, v.archived)}</Body>
        ) : null}
        <Body testID="act-totals-note" tone="muted">{ACTIVITY_WORDS.totalsNote}</Body>
      </MerchantPanel>
      {v.lightningOpen.length + v.lightningPaid.length > 0 && <>
        <Heading testID="act-lightning">Lightning payments</Heading>
        {v.lightningOpen.concat(v.lightningPaid).map(row => <LightningRow key={row.paymentId} row={row} />)}
        {v.lightningMore > 0 && <Button testID="act-lightning-more" label="More Lightning payments"
          kind="plain" onPress={() => p.onPages(p.pages + 1)} />}
      </>}
      {v.unfinished.length > 0 && <>
        <Heading testID="act-open">{ACTIVITY_WORDS.open}</Heading>
        {v.unfinished.map((x, i) => (
          <PaymentRow key={x.paymentId} section="unf" i={i} payment={x} twice={twice.has(x.paymentId)} onOpen={p.onOpen} />
        ))}
      </>}
      {v.claims.length > 0 && <>
        <Heading testID="act-claims">{ACTIVITY_WORDS.claims}</Heading>
        <Body testID="act-claims-help" tone="muted">{ACTIVITY_WORDS.claimsHelp}</Body>
        {v.claims.map((c, i) => waiting.has(c.id) ?
          <ClaimRow key={c.id} i={i} claim={c} onOpen={p.onOpen} /> :
          <Body key={c.id} testID={'claim-row-' + i}>{claimLine(c)}</Body>
        )}
      </>}
      {v.losses.length > 0 && <>
        <Heading testID="act-losses">{ACTIVITY_WORDS.losses}</Heading>
        {v.losses.map((x, i) => (
          <PaymentRow key={x.paymentId} section="loss" i={i} payment={x} twice={twice.has(x.paymentId)} onOpen={p.onOpen} />
        ))}
      </>}
      <Heading testID="act-payments">{ACTIVITY_WORDS.payments}</Heading>
      <Body testID="act-payments-note" tone="muted">{ACTIVITY_WORDS.paymentsNote}</Body>
      {v.done.length === 0 && <Body testID="act-payments-none" tone="muted">{ACTIVITY_WORDS.none}</Body>}
      {v.done.map((x, i) => (
        <PaymentRow key={x.paymentId} section="pay" i={i} payment={x} twice={twice.has(x.paymentId)} onOpen={p.onOpen} />
      ))}
      {v.doneTotal > v.done.length ? <Gap /> : null}
      {v.doneTotal > v.done.length ? (
        <Body testID="act-shown" tone="muted">
          {shownWords(v.done.length, v.doneTotal)}
        </Body>
      ) : null}
      {v.more > 0 ? (
        <Button testID="act-more" label={moreWords(v.more)} kind="plain" onPress={() => p.onPages(p.pages + 1)} />
      ) : null}

      {v.older.length + v.damaged.length > 0 && <Heading testID="act-rows">{ACTIVITY_WORDS.rows}</Heading>}
      {v.older.map((r, i) => (
        <Body key={'older-' + i} testID={'row-older-' + i} tone="muted">
          {olderLine(r)}
        </Body>
      ))}
      {v.damaged.map((r, i) => (
        <Body key={'damaged-' + i} testID={'row-damaged-' + i} tone="muted">
          {damagedLine(r)}
        </Body>
      ))}
      {emptySections.length > 0 && <MerchantPanel>
        {emptySections.map(s => <EmptySection key={s.id} id={s.id} label={s.label} />)}
      </MerchantPanel>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: TYPE.button, fontFamily: FONT.bold, marginTop: SPACE.s, marginBottom: SPACE.s },
  emptyRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.m, alignItems: 'baseline' },
  emptyLabel: { flexGrow: 1, fontFamily: FONT.regular, fontSize: TYPE.small, marginBottom: SPACE.s },
  rowCopy: { flex: 1 },
  chevron: { width: 9, height: 9, borderRightWidth: 2, borderTopWidth: 2, transform: [{ rotate: '45deg' }], marginHorizontal: SPACE.s },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: TOUCH, borderWidth: 1, borderRadius: 15, marginBottom: SPACE.s, paddingHorizontal: SPACE.m, paddingTop: SPACE.s },
});
