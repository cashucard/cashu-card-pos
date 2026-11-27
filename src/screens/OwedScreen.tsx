import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Platform } from 'react-native';
import { cashuAmount, dateTime, plural } from '../format';
import { receiptReference, tagReference } from '../app/receipt-reference';
import { RecoveryActionError } from '../till/recovery-actions';
import type { DeviceGate } from '../till/gate';
import { revealToken } from '../till/reveal-token';
import { readOwed, returnError, returnToCard, returnWords, rowWords, type OwedReading } from '../till/owed';
import type { CardReader } from '../till/reader';
import type { SaleInput } from '../till/sale-controller';
import { PIN_LEAST, PIN_MOST } from '../till/sale-machine';
import type { TillService } from '../till/service';
import type { CustomerHandoff } from '../till/store/extra-handoffs';
import { Body, Button, Screen } from '../ui/kit';
import { MerchantMessage, MerchantPanel, PanelLabel } from './MerchantPanel';
import { SaleAmount } from './SalePresentation';
import { PinPanel } from './SalePanels';
import { TokenScreen } from './TokenScreen';
import { NfcStage } from './NfcStage';

type Service = Pick<TillService, 'withCard' | 'settleNow' | 'onPayments' | 'customerHandoffs' | 'customerToken'>;

interface Props {
  service: Service;
  reader: CardReader;
  gate: DeviceGate;
  share?: (title: string, token: string) => Promise<void>;
  onBack: () => void;
  renderOverview?: (page: React.JSX.Element) => React.JSX.Element;
}

interface Snapshot extends OwedReading {
  handoffs: CustomerHandoff[];
}

interface Selection {
  id: string;
  description: string;
  source: 'card' | 'wallet';
  saved: boolean;
  mint: string;
}

export function OwedScreen({ service, reader, gate, share, onBack, renderOverview }: Props): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [message, setMessage] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [token, setToken] = useState<{ mint: string; value: string } | null>(null);
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'reading' | 'pin' | 'sharing'>('idle');
  const [retryTag, setRetryTag] = useState<string | null>(null);
  const [pinLength, setPinLength] = useState(0);
  const pin = useRef('');
  const session = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const alive = useRef(false);
  const inFront = useRef(true);
  const serial = useRef(0);
  const lifetime = useRef<AbortController | null>(null);

  const refresh = useCallback(async (checkRedemption = false) => {
    const version = ++serial.current;
    try {
      const data = await service.withCard('read', readOwed);
      const handoffs = await service.customerHandoffs(checkRedemption);
      if (alive.current && version === serial.current) {
        setSnapshot({ ...data, handoffs });
        setReadFailed(false);
      }
    } catch {
      if (alive.current && version === serial.current) setReadFailed(true);
    }
  }, [service]);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    lifetime.current = controller;
    void refresh();
    const off = service.onPayments(() => { void refresh(); });
    const listener = AppState.addEventListener('change', state => {
      if (state === 'background') {
        inFront.current = false;
        pin.current = '';
        setPinLength(0);
        session.current?.abort();
        setRetryTag(null);
        setSelection(null);
        setToken(null);
        setPhase(current => current === 'pin' ? 'idle' : current);
      } else if (state === 'active') {
        inFront.current = true;
      }
    });
    return () => {
      alive.current = false;
      controller.abort();
      pin.current = '';
      session.current?.abort();
      off();
      listener.remove();
    };
  }, [refresh, service]);

  useEffect(() => {
    if (phase === 'idle' && !selection && !token) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phase === 'waiting') session.current?.abort();
      if (phase === 'pin') {
        pin.current = '';
        setPinLength(0);
        setPhase('idle');
      }
      if (phase === 'idle') {
        setSelection(null);
        if (token) {
          setToken(null);
          setMessage('Return token saved. You can open the same token again.');
        }
      }
      return true;
    });
    return () => back.remove();
  }, [phase, selection, token]);

  async function tap(expected: string | null): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    const controller = new AbortController();
    session.current = controller;
    setPhase('waiting');
    setMessage('');
    setRetryTag(null);
    try {
      const { result, tag } = await returnToCard(service, reader, expected, () => {
        const digits = pin.current;
        pin.current = '';
        return digits || null;
      }, controller.signal, () => { if (alive.current) setPhase('reading'); });
      if (alive.current && inFront.current) {
        // The SDK gives amounts without a unit. Show them only when the record ties that
        // card to a single currency; cards can support more than one.
        const ref = tag === null ? null : tagReference(tag);
        const units = new Set(snapshot?.rows.filter(row => row.cardRef === ref).map(row => row.unit));
        setMessage(returnWords(result, units.size === 1 ? [...units][0] : undefined));
        setRetryTag(result.pinNeeded ? tag : null);
      }
    } catch (error) {
      if (alive.current) setMessage(returnError(error));
    } finally {
      pin.current = '';
      session.current = null;
      busy.current = false;
      if (alive.current) {
        setPinLength(0);
        setPhase('idle');
        void refresh();
      }
    }
  }

  function onPin(input: SaleInput): void {
    switch (input.type) {
      case 'pin-digit':
        if (pin.current.length < PIN_MOST) pin.current += input.d;
        break;
      case 'pin-back': pin.current = pin.current.slice(0, -1); break;
      case 'pin-ok':
        if (retryTag && pin.current.length >= PIN_LEAST) void tap(retryTag);
        return;
      case 'pin-cancel':
        pin.current = '';
        setPhase('idle');
        break;
      default: return;
    }
    setPinLength(pin.current.length);
  }

  async function exportSelected(): Promise<void> {
    if (!selection || busy.current || !lifetime.current) return;
    const selected = selection;
    busy.current = true;
    setPhase('sharing');
    setMessage('');
    try {
      const note = await revealToken(gate, lifetime.current.signal, () => service.customerToken(selected.id),
        value => setToken({ value, mint: selected.mint }));
      if (note && alive.current) setMessage(note);
    } catch (error) {
      if (alive.current) setMessage(error instanceof RecoveryActionError ? error.message :
        'Couldn’t open this return. Refresh to see whether a token is saved or the return is still pending.');
    } finally {
      busy.current = false;
      if (alive.current) {
        setSelection(null);
        setPhase('idle');
        void refresh();
      }
    }
  }

  if (token !== null) {
    return <TokenScreen title="Customer return token" token={token.value} mint={token.mint} share={share} onDone={() => {
      setToken(null);
      setMessage('Return token saved. You can open the same token again.');
    }} />;
  }
  if (phase === 'pin') {
    return <PinPanel state={{ count: pinLength, why: 'recover', wrong: false, tries: null }} send={onPin} />;
  }
  if (phase === 'waiting' || phase === 'reading') {
    const waiting = phase === 'waiting';
    const title = waiting ? 'Tap the original card' : 'Hold the card still';
    const cancel = waiting && <Button testID="owed-cancel" label="Cancel" kind="plain" onPress={() => session.current?.abort()} />;
    if (Platform.OS === 'ios') {
      return <NfcStage gesture={waiting ? 'tap' : 'hold'} value="Customer return" title={title} titleID="owed-scan-title"
        detail={waiting ? 'Hold it at the top of the iPhone.' : 'Keep it there until the return finishes.'}>{cancel}</NfcStage>;
    }
    return (
      <Screen title={title} titleID="owed-scan-title">
        <MerchantPanel><Body>Keep the card at the back of the phone until the return finishes.</Body></MerchantPanel>
        {cancel}
      </Screen>
    );
  }
  if (selection) {
    return (
      <Screen title="Give a token to the customer" titleID="owed-export-title">
        <MerchantPanel><PanelLabel>Customer return</PanelLabel><Body>{selection.description}</Body></MerchantPanel>
        <Body>{selection.saved ? 'This shares the same saved token again.' : selection.source === 'wallet'
          ? 'Give this token only to the customer whose wallet sent the extra payment.' :
          'This takes the extra payment out of the automatic card return. Give the token only to the customer who made this payment.'}</Body>
        <Body tone="muted">{selection.source === 'wallet' ? 'Anyone who receives this token can redeem it.' :
          'A bearer token can be redeemed by anyone who receives it. A token locked to the card needs the holder’s wallet.'}</Body>
        <Button testID="owed-confirm-export" label="Verify and show token" disabled={phase === 'sharing'} onPress={() => { void exportSelected(); }} />
        <Button testID="owed-decline-export" label="Cancel" kind="plain" disabled={phase === 'sharing'} onPress={() => setSelection(null)} />
      </Screen>
    );
  }

  const sums = new Map<string, { mint: string; unit: string; owed: number; written: number }>();
  for (const row of snapshot?.rows ?? []) {
    const key = row.mint + '/' + row.unit;
    const sum = sums.get(key) ?? { mint: row.mint, unit: row.unit, owed: 0, written: 0 };
    if (row.state === 'unconfirmed') sum.written += row.amount;
    else sum.owed += row.amount;
    sums.set(key, sum);
  }

  const page = (
    <Screen title="Owed to cards" titleID="owed-title" onBack={renderOverview ? undefined : onBack}>
      {readFailed && <Body tone="bad">Couldn’t refresh the return record. Amounts shown may be out of date.</Body>}
      {!snapshot && !readFailed && <Body>Reading customer returns…</Body>}
      {message !== '' && <MerchantMessage id="owed-message">{message}</MerchantMessage>}
      {snapshot && !readFailed && sums.size === 0 && snapshot.claims === 0 && (
        <MerchantPanel>
          <Body>No outstanding returns</Body>
          <Body tone="muted">Customer change and extra payments waiting to be returned appear here.</Body>
        </MerchantPanel>
      )}
      {[...sums].map(([key, n]) => (
        <MerchantPanel key={key}>
          <PanelLabel>Customer funds at this mint</PanelLabel>
          <Body>{n.mint}</Body>
          {n.owed > 0 && <SaleAmount testID={'owed-amount-' + key} receipt>{cashuAmount(n.owed, n.unit) + ' owed'}</SaleAmount>}
          {n.written > 0 && <Body>{cashuAmount(n.written, n.unit) + ' written, awaiting confirmation'}</Body>}
        </MerchantPanel>
      ))}
      {snapshot && snapshot.claims > 0 && <Body>{plural(snapshot.claims, 'interrupted payment', 'interrupted payments') + ' waiting for a card.'}</Body>}
      {retryTag !== null && <Button testID="owed-pin" label="Continue with card PIN" onPress={() => setPhase('pin')} />}
      <Button testID="owed-scan" label="Scan card for a return" onPress={() => { void tap(null); }} />
      {snapshot?.rows.map((row, i) => (
        <MerchantPanel key={row.id + row.reason + row.state}>
          <PanelLabel>{row.cardRef}</PanelLabel>
          <Body>{rowWords(row)}</Body>
          <Body tone="muted">{receiptReference(row.id) + ' · ' + dateTime(row.at)}</Body>
          <Body tone="muted">{row.mint}</Body>
          {!readFailed && row.exportable &&
            <Button testID={'owed-export-' + i} label="Return as a token" kind="plain"
              accessibilityLabel={'Return ' + cashuAmount(row.amount, row.unit) + ' as a token, ' + row.cardRef + ', ' + receiptReference(row.id) + ', ' + row.mint}
              onPress={() => setSelection({ id: row.id, mint: row.mint, source: row.source, description: receiptReference(row.id) + ' · ' + row.cardRef + ' · ' + row.mint + ' · ' + dateTime(row.at) + ' · ' + rowWords(row), saved: false })} />}
        </MerchantPanel>
      ))}
      {snapshot && snapshot.handoffs.length > 0 && <PanelLabel>Saved customer tokens</PanelLabel>}
      {snapshot?.handoffs.map((h, i) => {
        const description = [cashuAmount(h.amount, h.unit), h.mint, dateTime(h.at), receiptReference(h.id), h.cardRef].filter(Boolean).join(' · ');
        return <MerchantPanel key={h.id}><Body>{description}</Body>
          {!readFailed && <Button testID={'owed-share-' + i} label="Open saved token" kind="plain"
            accessibilityLabel={'Open saved return token for ' + description}
            onPress={() => setSelection({ id: h.id, mint: h.mint, source: h.cardRef ? 'card' : 'wallet', description, saved: true })} />}</MerchantPanel>;
      })}
      <Button testID="owed-refresh" label="Refresh" kind="plain" onPress={() => { void refresh(true); }} />
    </Screen>
  );
  return renderOverview ? renderOverview(page) : page;
}
