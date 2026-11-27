/* The sale's screens while it is being taken: the keypad, the opening, the taps, the sheet and the PIN pad. Each shows
 * the state it is given and sends what was pressed; none of them decides anything, and none shows a PIN, a token, a
 * proof or a key. The PIN pad shows one dot per digit and never a digit. */

import React, { useEffect } from 'react';
import { AccessibilityInfo, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { CardConfirmation } from 'cashucard';
import type { SaleInput } from '../till/sale-controller';
import {
  AMOUNT_DIGITS,
  amountOf,
  chargeEnabled,
  PIN_LEAST,
  PRE_TAP_FEE_LIMIT,
  SALE_MOST,
  type PinState,
  type SaleState,
  type TapState,
} from '../till/sale-machine';
import { hostOf, sats } from '../format';
import { Body, Button, Screen } from '../ui/kit';
import { FONT, useTheme } from '../ui/theme';
import { SaleAmount, SaleStage, SaleSurface } from './SalePresentation';
import { NfcStage } from './NfcStage';

export type Send = (i: SaleInput) => void;
export const SALE_WORDS = {
  title: 'New sale',
  opening: 'Opening the sale.',
  most: 'Sale limit is ' + sats(SALE_MOST) + '.',
  tap1: 'Hold the card to the back of the phone',
  tap2: 'Hold the card to the phone again',
  waiting: 'Waiting for a card',
  queuedTitle: 'One moment',
  queued: 'The till is finishing earlier payments with the mint. Then it asks for the card.',
  openingQueued: 'One moment. The till is finishing earlier payments with the mint. Then it opens the sale.',
  still: 'Hold the card still',
  stopping: 'Stopping',
  stoppingLine: 'Stopping the sale.',
  pays: 'THE CARD PAYS',
  pinNeed: 'The card asks for its PIN: this payment is over its no-PIN limit.',
  no: 'Saying no takes nothing.',
  pay: 'Pay',
  payPin: 'Enter the PIN and pay',
  decline: 'Do not pay',
  pinTitle: "Enter the card's PIN",
  pinWhy: {
    allowance: "This payment is over the card's no-PIN limit.",
    leftover: 'Use the PIN to collect change on this card.',
    recover: 'The card needs its PIN to finish a payment it started.',
  },
  dot: '●',
} as const;

/** 'Wrong PIN. Try again.' (tries null), 'Wrong PIN. 1 try left.', 'Wrong PIN. 2 tries left.' */
export function wrongPinWords(tries: number | null): string {
  if (tries === null) {
    return 'Wrong PIN. Try again.';
  }
  return 'Wrong PIN. ' + String(tries) + (tries === 1 ? ' try left.' : ' tries left.');
}

/** The sheet's lines, in order, each with its testID; a line whose amount is 0 is left out. */
export function sheetLines(c: CardConfirmation): Array<{ id: string; words: string }> {
  const lines: Array<{ id: string; words: string }> = [
    { id: 'sheet-total', words: sats(c.total) },
    { id: 'sheet-price', words: 'Price: ' + sats(c.price) },
    { id: 'sheet-fee', words: "The mint's fee: " + sats(c.inputFees) },
  ];
  if (c.kept > 0) {
    lines.push({ id: 'sheet-kept', words: 'Kept by the till: ' + sats(c.kept) + ' (too small to give back)' });
  }
  if (c.cardChange > 0) {
    lines.push({
      id: 'sheet-change',
      words: 'The card makes its own change: ' + sats(c.cardChange) + ', written back in this tap',
    });
  }
  if (c.leftover > 0) {
    lines.push({
      id: 'sheet-leftover',
      words: 'Change for this card: ' + sats(c.leftover) + '. Enter the card PIN to receive it. If it cannot fit now, bring this card and PIN back to this till.',
    });
  }
  lines.push({ id: 'sheet-balance', words: 'On the card: ' + sats(c.balance) });
  if (c.unchecked > 0) {
    lines.push({ id: 'sheet-unchecked', words: 'Not counted: ' + sats(c.unchecked) + ' the till could not check' });
  }
  lines.push({ id: 'sheet-mint', words: 'Mint: ' + hostOf(c.mint) });
  if (c.pinNeeded && c.pinFor === 'allowance') {
    lines.push({ id: 'sheet-pin', words: SALE_WORDS.pinNeed });
  }
  lines.push({ id: 'sheet-no', words: SALE_WORDS.no });
  return lines;
}

interface KeySpec<T = SaleInput> {
  id: string;
  label: string;
  input: T;
}

/** Both pads share the physical key positions, including a separate row for action buttons. */
function KeyGrid<T>({ keys, send, amountPad = false }: {
  keys: Array<KeySpec<T> | null>;
  send: (input: T) => void;
  amountPad?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const { height } = useWindowDimensions();
  const rows: React.JSX.Element[] = [];
  for (let start = 0; start < keys.length; start += 3) {
    rows.push(
      <View key={start} style={styles.row}>
        {keys.slice(start, start + 3).map((key, index) => {
          if (!key) return <View key={'space-' + index} style={styles.space} />;
          const utility = key.label.length > 1;
          return (
            <Pressable
              key={key.id}
              testID={key.id}
              accessibilityRole="button"
              accessibilityLabel={key.label === 'Delete' ? 'Delete last digit' : key.label}
              onPress={() => send(key.input)}
              style={({ pressed }) => [
                styles.key,
                amountPad && (height < 780 ? styles.compactAmountKey : styles.amountKey),
                { backgroundColor: pressed ? theme.plain : theme.field, borderColor: theme.line },
              ]}
            >
              <Text style={[utility ? styles.utility : styles.digit, !utility && amountPad && styles.amountDigit, { color: utility ? theme.muted : theme.text }]}>
                {key.label}
              </Text>
            </Pressable>
          );
        })}
      </View>,
    );
  }
  return <View style={[styles.grid, amountPad && height < 700 && styles.compactGrid]}>{rows}</View>;
}

export type AmountKey = Extract<SaleInput, { type: 'digit' | 'key-back' | 'key-clear' }>;

export function AmountKeypad({ onKey }: { onKey(key: AmountKey): void }): React.JSX.Element {
  const keys: KeySpec<AmountKey>[] = [
    { id: 'key-1', label: '1', input: { type: 'digit', d: '1' } },
    { id: 'key-2', label: '2', input: { type: 'digit', d: '2' } },
    { id: 'key-3', label: '3', input: { type: 'digit', d: '3' } },
    { id: 'key-4', label: '4', input: { type: 'digit', d: '4' } },
    { id: 'key-5', label: '5', input: { type: 'digit', d: '5' } },
    { id: 'key-6', label: '6', input: { type: 'digit', d: '6' } },
    { id: 'key-7', label: '7', input: { type: 'digit', d: '7' } },
    { id: 'key-8', label: '8', input: { type: 'digit', d: '8' } },
    { id: 'key-9', label: '9', input: { type: 'digit', d: '9' } },
    { id: 'key-clear', label: 'Clear', input: { type: 'key-clear' } },
    { id: 'key-0', label: '0', input: { type: 'digit', d: '0' } },
    { id: 'key-back', label: 'Delete', input: { type: 'key-back' } },
  ];
  return <KeyGrid keys={keys} send={onKey} amountPad />;
}

/** The keypad: the amount in sats as the digits grow, and Charge when it may be pressed. */
export function KeypadPanel(p: {
  digits: string;
  mints: string[];
  send: Send;
  onBack?: () => void;
  onBalance?: () => void;
  notices?: React.ReactNode;
  canSell?: boolean;
}): React.JSX.Element {
  const amount = amountOf(p.digits);
  const canCharge = chargeEnabled(p.digits) && p.canSell !== false;
  const theme = useTheme();
  const { height } = useWindowDimensions();
  return (
    <Screen title={SALE_WORDS.title} titleID="sale-title" onBack={p.onBack} keypad>
      {p.notices}
      <View style={[styles.amountReading, height < 700 && styles.shortAmountReading]}>
        <SaleAmount testID="sale-amount" keypadLimitHint={SALE_WORDS.most}>{sats(amount)}</SaleAmount>
        {p.mints.length > 0 && (
          <Text testID="sale-mints" style={[styles.caption, { color: theme.muted }]}>
            {'Cards from: ' + p.mints.map(hostOf).join(', ')}
          </Text>
        )}
      </View>
      {p.digits.length >= AMOUNT_DIGITS - 1 ? (
        <Text
          testID="sale-note"
          accessibilityLiveRegion="polite"
          style={[styles.limit, { color: amount > SALE_MOST ? theme.bad : theme.muted }]}
        >
          {SALE_WORDS.most}
        </Text>
      ) : null}
      <AmountKeypad onKey={p.send} />
      <Button
        testID="sale-charge"
        label={amount > 0 ? 'Charge ' + sats(amount) : 'Charge'}
        disabled={!canCharge}
        onPress={() => {
          if (canCharge) p.send({ type: 'charge' });
        }}
      />
      {p.onBalance && <Button testID="sale-balance" label="Check balance" kind="plain" onPress={p.onBalance} />}
    </Screen>
  );
}

/** The moment between Charge and the card: the till is opening the sale. Nothing can be taken yet, so Cancel is here. */
export function OpeningPanel(p: { sats: number; queued?: boolean; send: Send }): React.JSX.Element {
  return (
    <SaleStage
      title={SALE_WORDS.title}
      titleID="sale-title"
      signal="busy"
      amount={sats(p.sats)}
      amountID="opening-amount"
      description={<Body testID="sale-opening">{p.queued ? SALE_WORDS.openingQueued : SALE_WORDS.opening}</Body>}
    >
      <Button testID="opening-cancel" label="Cancel" kind="plain" onPress={() => p.send({ type: 'cancel' })} />
    </SaleStage>
  );
}

/** The taps: waiting for a card (and Cancel), then the stages as the library reports them, then Stopping. */
export function TapPanel(p: {
  state: TapState | Extract<SaleState, { kind: 'stopping' }>;
  send: Send;
}): React.JSX.Element {
  const s = p.state;
  const ios = Platform.OS === 'ios';
  const stopping = s.kind === 'stopping';
  const inField = !stopping && s.card;
  const queued = !stopping && !inField && s.queued === true;
  let title: string, detail: string | undefined;
  if (stopping) {
    title = SALE_WORDS.stopping;
    detail = SALE_WORDS.stoppingLine;
  } else if (inField) {
    title = s.words?.title ?? SALE_WORDS.still;
    detail = s.words?.sheet;
  } else if (queued) {
    title = SALE_WORDS.queuedTitle;
    detail = SALE_WORDS.queued;
  } else {
    title = s.tap === 1 ? (ios ? 'Hold card at top of iPhone' : SALE_WORDS.tap1)
      : (ios ? 'Hold the same card again' : SALE_WORDS.tap2);
    detail = SALE_WORDS.waiting;
  }

  const cancel = !stopping && !inField &&
    <Button testID="tap-cancel" label="Cancel" kind="plain" onPress={() => p.send({ type: 'cancel' })} />;
  if (ios && !queued) {
    const gesture = stopping ? 'stopping' : !inField ? 'tap'
      : s.words?.short === 'TRANSFERRING' ? 'remove' : 'hold';
    return (
      <NfcStage gesture={gesture} title={title} titleID="tap-title"
        value={sats(s.sats)} valueID="tap-amount" detail={detail} detailID="tap-line">
        {cancel}
      </NfcStage>
    );
  }
  return (
    <SaleStage focusKey={inField ? 'reading-card' : undefined} title={title} titleID="tap-title"
      signal={stopping || queued ? 'busy' : 'card'} amount={sats(s.sats)} amountID="tap-amount"
      description={detail ? <Body testID="tap-line">{detail}</Body> : null}>
      {cancel}
    </SaleStage>
  );
}

/** THE CARD PAYS: every line of the sheet, then Pay and Do not pay. */
export function ConfirmPanel(p: { c: CardConfirmation; send: Send }): React.JSX.Element {
  return (
    <Screen title={SALE_WORDS.pays} titleID="sheet-pays">
      <SaleSurface>
        {sheetLines(p.c).map((line) =>
          line.id === 'sheet-total' ? (
            <SaleAmount key={line.id} testID={line.id}>
              {line.words}
            </SaleAmount>
          ) : (
            <Body key={line.id} testID={line.id}>
              {line.words}
            </Body>
          ),
        )}
      </SaleSurface>
      <Button
        testID="sheet-pay"
        label={p.c.pinNeeded ? SALE_WORDS.payPin : SALE_WORDS.pay}
        onPress={() => p.send({ type: 'pay' })}
      />
      <Button
        testID="sheet-decline"
        label={SALE_WORDS.decline}
        kind="plain"
        onPress={() => p.send({ type: 'decline' })}
      />
    </Screen>
  );
}

/** The PIN pad: why the PIN is asked, a dot per digit, and OK once there are enough. Never a digit. */
export function PinPanel(p: {
  state:
    | (Pick<PinState, 'count' | 'wrong' | 'tries' | 'why'> & { kind?: 'pin' })
    | Extract<SaleState, { kind: 'preflight' }>;
  send: Send;
  wallet?: React.ReactNode;
}): React.JSX.Element {
  const s = p.state;
  // Cancel is not in the grid beside 0, where a thumb would hit it: it is its own button, below OK
  const keys: Array<KeySpec | null> = [
    { id: 'pin-key-1', label: '1', input: { type: 'pin-digit', d: '1' } },
    { id: 'pin-key-2', label: '2', input: { type: 'pin-digit', d: '2' } },
    { id: 'pin-key-3', label: '3', input: { type: 'pin-digit', d: '3' } },
    { id: 'pin-key-4', label: '4', input: { type: 'pin-digit', d: '4' } },
    { id: 'pin-key-5', label: '5', input: { type: 'pin-digit', d: '5' } },
    { id: 'pin-key-6', label: '6', input: { type: 'pin-digit', d: '6' } },
    { id: 'pin-key-7', label: '7', input: { type: 'pin-digit', d: '7' } },
    { id: 'pin-key-8', label: '8', input: { type: 'pin-digit', d: '8' } },
    { id: 'pin-key-9', label: '9', input: { type: 'pin-digit', d: '9' } },
    null,
    { id: 'pin-key-0', label: '0', input: { type: 'pin-digit', d: '0' } },
    { id: 'pin-back', label: 'Delete', input: { type: 'pin-back' } },
  ];
  const review = s.kind === 'preflight';
  const offline = review && s.mode === 'offline';
  const checking = review && s.mode === 'detecting';
  const shared = review && s.shared === true;
  const needsPin = !review || shared || offline;
  const preparing = shared && !offline && !s.saleId;
  useEffect(() => {
    if (offline) AccessibilityInfo.announceForAccessibility('Offline payment. Enter your card PIN before tapping.');
  }, [offline]);
  const theme = useTheme();
  return (
    <Screen title={offline ? 'Offline payment' : review && p.wallet ? sats(s.sats) : review ? 'Approve payment' : SALE_WORDS.pinTitle} titleID="pin-title" keypad={review}>
      {p.wallet}
      {review && p.wallet ? (
        <>
          <Text testID="pin-why" style={[styles.cardLabel, { color: theme.text }]}>Pay by card</Text>
          <Text testID="preflight-limit" style={[styles.hint, { color: theme.muted }]}>
            {'Enter the PIN, then press Pay. Mint fee up to ' + sats(PRE_TAP_FEE_LIMIT) +
              '. You’ll review any higher fee or held change.'}
          </Text>
        </>
      ) : review ? (
        <>
          <SaleSurface>
            <SaleAmount testID="preflight-price">{sats(s.sats)}</SaleAmount>
            <Body testID="preflight-limit">
              {checking ? 'Checking the connection…' : offline
                ? 'The card needs exact notes, including a mint fee of up to ' + sats(PRE_TAP_FEE_LIMIT) +
                  '. The till checks the payment with the mint when it’s back online.'
                : 'Mint fee up to ' + sats(PRE_TAP_FEE_LIMIT) +
                  '. You’ll review a higher fee or any change the till needs to hold.'}
            </Body>
          </SaleSurface>
          <Body testID="pin-why">{offline ? 'Enter your card PIN before tapping.'
            : shared ? 'Enter the card PIN, then press Pay.'
            : checking ? 'You can enter the card PIN now.'
            : 'Enter your card PIN before tapping, or leave it blank for a no-PIN payment.'}</Body>
        </>
      ) : (
        <>
          <Body testID="pin-why">{SALE_WORDS.pinWhy[s.why]}</Body>
          {s.wrong ? (
            <Body testID="pin-wrong" tone="bad">
              {wrongPinWords(s.tries)}
            </Body>
          ) : null}
        </>
      )}
      <Text
        testID="pin-dots"
        accessibilityLabel={s.count === 1 ? 'One PIN digit entered' : s.count + ' PIN digits entered'}
        style={[styles.pinDots, { backgroundColor: theme.field, color: theme.text, borderColor: theme.line }]}
      >
        {SALE_WORDS.dot.repeat(s.count)}
      </Text>
      <KeyGrid keys={keys} send={p.send} />
      <Button
        testID="pin-ok"
        label={review ? (shared && !offline ? 'Pay with Cashu card · up to ' : 'Pay up to ') + sats(s.sats + PRE_TAP_FEE_LIMIT) : 'OK'}
        disabled={checking || preparing || (s.count < PIN_LEAST && (needsPin || s.count !== 0))}
        onPress={() => p.send({ type: 'pin-ok' })}
      />
      {review && !offline && !shared ? (
        <Button
          testID="preflight-reviewed"
          disabled={checking || preparing}
          label="Review exact total first"
          kind="plain"
          onPress={() => p.send({ type: 'review-first' })}
        />
      ) : null}
      <Button testID="pin-cancel" label="Cancel" kind="plain" onPress={() => p.send({ type: 'pin-cancel' })} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  amountReading: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 8, gap: 2 },
  shortAmountReading: { paddingVertical: 0, gap: 0 },
  grid: { gap: 6, marginBottom: 8 },
  compactGrid: { gap: 4, marginBottom: 4 },
  row: { flexDirection: 'row', gap: 6 },
  space: { flex: 1 },
  key: {
    flex: 1,
    minHeight: 54,
    paddingHorizontal: 3,
    paddingVertical: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
  },
  amountKey: { minHeight: 64 },
  compactAmountKey: { minHeight: 48 },
  amountDigit: { fontSize: 29 },
  digit: { fontSize: 27, textAlign: 'center', fontFamily: FONT.semibold, fontVariant: ['tabular-nums'] },
  utility: { fontSize: 15, textAlign: 'center', fontFamily: FONT.semibold },
  caption: { fontFamily: FONT.regular, fontSize: 15, textAlign: 'center' },
  limit: { textAlign: 'center', fontSize: 13, marginTop: 5, fontFamily: FONT.regular },
  cardLabel: { fontFamily: FONT.bold, fontSize: 19, marginTop: 6, marginBottom: 2 },
  hint: { fontFamily: FONT.regular, fontSize: 15, marginBottom: 8 },
  pinDots: {
    minHeight: 44,
    textAlign: 'center',
    fontSize: 19,
    paddingVertical: 10,
    letterSpacing: 4,
    borderWidth: 1,
    borderRadius: 12,
    marginBottom: 8,
  },
});
