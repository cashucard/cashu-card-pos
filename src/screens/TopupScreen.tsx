import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, BackHandler, Clipboard, StyleSheet, TextInput, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import type { TopupService, TopupTapState } from '../till/topup';
import { TOPUP_HISTORY_PAGE, topupIsOpen, type TopupReceipt } from '../till/store/topups';
import { Body, Button, Screen } from '../ui/kit';
import { sats } from '../format';
import { FONT, useTheme } from '../ui/theme';
import { NfcStage } from './NfcStage';
import { PaidCelebration } from './PaidCelebration';
import { AmountKeypad, type AmountKey } from './SalePanels';
import { SaleAmount } from './SalePresentation';
import { tokenQr } from './TokenScreen';

type Props = { service: TopupService; cardKey?: string; historyOnly?: boolean; onDone?: () => void; onBack: () => void };

const titles: Record<TopupReceipt['state'], string> = {
  invoice: 'Pay the invoice',
  expired: 'Invoice expired',
  issuing: 'Payment received',
  ready: 'Ready to load',
  loaded: 'Top-up complete',
};

function SavedTopups({
  service,
  cardKey,
  saved,
  disabled,
  open,
}: {
  service: TopupService;
  cardKey?: string;
  saved: TopupReceipt[];
  disabled: boolean;
  open: (r: TopupReceipt) => void;
}): React.JSX.Element {
  const [section, setSection] = useState<'open' | 'history' | null>(() => saved.some(topupIsOpen) ? 'open' : 'history');
  const [olderPages, setOlderPages] = useState<TopupReceipt[][]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const loadingRef = useRef(false);
  const pending = saved.filter(topupIsOpen);
  const history = saved.filter((r) => !topupIsOpen(r));
  const page = olderPages[olderPages.length - 1] ?? history;

  async function older() {
    if (loadingRef.current || page.length <= TOPUP_HISTORY_PAGE) return;
    loadingRef.current = true;
    setLoading(true);
    setError('');
    try {
      const rows = await service.older(cardKey, page[TOPUP_HISTORY_PAGE - 1]);
      setOlderPages((previous) => [...previous, rows]);
    } catch {
      setError('Older receipts could not be opened. Try again.');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }
  function receiptButton(r: TopupReceipt) {
    const mint = r.mint.replace(/^https:\/\//, '');
    return (
      <Button
        testID={'topup-saved-' + r.id}
        key={r.id}
        kind="plain"
        disabled={disabled}
        label={
          titles[r.state] +
          ' · ' +
          sats(r.amount) +
          '\n' +
          mint +
          ' · ' +
          new Date(r.createdAt).toLocaleString()
        }
        onPress={() => open(r)}
      />
    );
  }
  return (
    <>
      {pending.length > 0 && (
        <Button
          testID="topup-show-open"
          kind="plain"
          disabled={disabled}
          label={(section === 'open' ? 'Hide open top-ups' : 'Resume a top-up') + ' (' + pending.length + ')'}
          onPress={() => setSection(section === 'open' ? null : 'open')}
        />
      )}
      {section === 'open' &&
        [...pending.filter((r) => r.state !== 'invoice'), ...pending.filter((r) => r.state === 'invoice')].map(
          receiptButton,
        )}
      {history.length > 0 && (
        <Button
          testID="topup-show-history"
          kind="plain"
          disabled={disabled}
          label={section === 'history' ? 'Hide past top-ups' : 'Past top-ups'}
          onPress={() => setSection(section === 'history' ? null : 'history')}
        />
      )}
      {section === 'history' && (
        <>
          {page.slice(0, TOPUP_HISTORY_PAGE).map(receiptButton)}
          {olderPages.length > 0 && (
            <Button
              testID="topup-newer"
              kind="plain"
              disabled={disabled || loading}
              label="Newer receipts"
              onPress={() => {
                setError('');
                setOlderPages((previous) => previous.slice(0, -1));
              }}
            />
          )}
          {page.length > TOPUP_HISTORY_PAGE && (
            <Button
              testID="topup-older"
              kind="plain"
              disabled={disabled || loading}
              label={loading ? 'Opening receipts…' : 'Older receipts'}
              onPress={() => void older()}
            />
          )}
          {!!error && <Body tone="bad">{error}</Body>}
        </>
      )}
    </>
  );
}

export function TopupScreen({ service, cardKey, historyOnly = false, onDone, onBack }: Props): React.JSX.Element {
  const [tap, setTap] = useState<TopupTapState>('closed');
  const [celebrate, setCelebrate] = useState(false);
  const notice = (s: TopupTapState) => {
    if (mounted.current) setTap(s);
  };
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState('');
  const [confirmAmount, setConfirmAmount] = useState(false);
  const [receiptsReady, setReceiptsReady] = useState(false);
  const [listAttempt, setListAttempt] = useState(0);
  const [saved, setSaved] = useState<TopupReceipt[]>([]);
  const [receipt, setReceipt] = useState<TopupReceipt | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const active = useRef(false);
  const mounted = useRef(true);
  const theme = useTheme();
  const due = receipt?.state === 'invoice' && receipt.expiresAt > Date.now();
  const qr = useMemo(() => (due ? tokenQr(receipt!.invoice.toUpperCase()) : null), [due, receipt?.invoice]);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    setReceiptsReady(false);
    setError('');
    const exit = service.enterScreen();
    service
      .list(cardKey)
      .then((rows) => {
        if (current) {
          setSaved(rows);
          setReceiptsReady(true);
          if (cardKey && !historyOnly) setReceipt(rows.find(r => r.state === 'ready' || r.state === 'issuing') ?? rows.find(topupIsOpen) ?? null);
        }
      })
      .catch(() => {
        if (current) setError('Saved top-ups could not be opened.');
      });
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') setPin('');
      if (state === 'background') service.cancelTap();
    });
    return () => {
      current = false;
      mounted.current = false;
      service.cancelTap();
      exit();
      sub.remove();
    };
  }, [service, cardKey, historyOnly, listAttempt]);

  async function run(label: string, action: () => Promise<TopupReceipt>) {
    if (active.current) return;
    active.current = true;
    setBusy(label);
    setError('');
    setPin('');
    try {
      const next = await action();
      if (mounted.current) {
        setReceipt(next);
        setCelebrate(next.state === 'loaded');
      }
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : 'Could not finish this step. Open the original top-up again.');
    } finally {
      active.current = false;
      if (mounted.current) setBusy('');
    }
  }
  const receiptId = receipt?.id;
  const awaitingPayment = receipt?.state === 'invoice' || receipt?.state === 'issuing';
  useEffect(() => {
    if (!receiptId || !awaitingPayment) return;
    const originalReceipt = receiptId;
    let generation = 0;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function check() {
      if (active.current) return;
      const request = generation;
      active.current = true;
      try {
        const next = await service.refresh(originalReceipt);
        if (request === generation) {
          setReceipt(next);
          setError('');
        }
      } catch {
        // The receipt stays open. The next poll retries, and a manual check can explain a mint error.
      } finally {
        active.current = false;
      }
    }
    function stop() {
      generation++;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    }
    function start() {
      if (!timer) timer = setInterval(() => void check(), 8000);
    }
    if (AppState.currentState === 'active') start();
    const foreground = AppState.addEventListener('change', state => {
      if (state !== 'active') stop();
      else {
        start();
        void check();
      }
    });
    return () => { stop(); foreground.remove(); };
  }, [receiptId, awaitingPayment, service]);

  function back() {
    if (historyOnly && receipt) {
      setReceipt(null);
      setPin('');
      setCelebrate(false);
      setListAttempt(n => n + 1);
    } else if (!receipt && confirmAmount) {
      setPin('');
      setError('');
      setConfirmAmount(false);
    } else onBack();
  }
  const hardwareBack = useRef(() => {});
  hardwareBack.current = () => {
    if (tap === 'closed' && !busy) back();
  };
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      hardwareBack.current();
      return true;
    });
    return () => sub.remove();
  }, []);

  if (tap !== 'closed')
    return (
      <NfcStage
        gesture={tap === 'waiting' ? 'tap' : 'hold'}
        title={tap === 'waiting' ? 'Tap the card' : 'Keep holding the card'}
        titleID="topup-nfc-title"
        value={sats(receipt?.amount ?? Number(amount))}
        detail={
          receipt ? 'Verifying the paid top-up on this card.' : 'Checking the card before creating an invoice.'
        }
      >
        <Button testID="topup-cancel-tap" kind="plain" label="Cancel tap" onPress={() => service.cancelTap()} />
      </NfcStage>
    );
  function onAmountKey(key: AmountKey) {
    setAmount(previous => {
      if (key.type === 'key-clear') return '';
      if (key.type === 'key-back') return previous.slice(0, -1);
      return (previous + key.d).replace(/^0+/, '').slice(0, 10);
    });
  }

  const title = historyOnly && !receipt ? 'Top-up receipts' : receipt ? titles[receipt.state] : 'Top up card';
  const needPin = (!receipt && confirmAmount) || receipt?.state === 'ready';
  return (
    <Screen title={title} titleID="topup-title" onBack={busy ? undefined : back} adjustForKeyboard={needPin} keypad={!historyOnly && !receipt && !confirmAmount}>
      {!receiptsReady && !error && <Body tone="muted">Checking saved top-ups…</Body>}
      {!receiptsReady && !!error && <Button testID="topup-retry-list" label="Try again" onPress={() => setListAttempt(n => n + 1)} />}
      {receiptsReady && !receipt && historyOnly && (saved.length ? (
        <SavedTopups service={service} saved={saved} disabled={!!busy}
          open={r => { setPin(''); setError(''); setReceipt(r); }} />
      ) : <Body tone="muted">No top-ups yet.</Body>)}
      {receiptsReady && !receipt && !historyOnly && (
        <>
          <View style={confirmAmount ? styles.confirmAmount : styles.amountReading}>
            <SaleAmount testID="topup-amount">{sats(Number(amount))}</SaleAmount>
            <Body tone="muted">To add to this card</Body>
          </View>
          {!confirmAmount && <>
            <AmountKeypad onKey={onAmountKey} />
            <Button testID="topup-continue" label="Continue"
              disabled={Number(amount) < 1 || Number(amount) > 0xffffffff} onPress={() => setConfirmAmount(true)} />
            {Number(amount) > 0xffffffff && <Body tone="bad">The most you can add is 4,294,967,295 sats.</Body>}
          </>}
        </>
      )}
      {celebrate && receipt?.state === 'loaded' && <PaidCelebration afterScanSheet={service.afterScanSheet} />}
      {receipt && (
        <>
          <Body big testID="topup-credit">
            {sats(receipt.amount) + ' ' + (receipt.state === 'loaded' ? 'loaded' : 'to the card')}
          </Body>
          <Body tone="muted">{receipt.mint}</Body>
        </>
      )}
      {due && receipt && (
        <>
          <Body testID="topup-fee">
            {'Pay ' +
              sats(receipt.total) +
              ', including ' +
              sats(receipt.total - receipt.amount) +
              ' in mint fees. Your Lightning wallet shows any routing fee.'}
          </Body>
          {qr && (
            <View
              style={styles.qr}
              accessible
              accessibilityRole="image"
              accessibilityLabel="Lightning invoice QR code"
            >
              <Svg width="100%" height="100%" viewBox={'0 0 ' + qr.side + ' ' + qr.side}>
                <Rect width={qr.side} height={qr.side} fill="white" />
                <Path d={qr.path} fill="black" />
              </Svg>
            </View>
          )}
          <Body tone="muted">Scan with a Lightning wallet.</Body>
          <Button
            testID="topup-copy"
            label="Copy invoice"
            kind="plain"
            onPress={() => Clipboard.setString(receipt.invoice)}
          />
        </>
      )}
      {receipt && (receipt.state === 'invoice' || receipt.state === 'issuing' || receipt.state === 'expired') && (
        <Button
          testID="topup-check"
          disabled={!!busy}
          kind="plain"
          label="Check payment"
          onPress={() => void run('Checking payment…', () => service.refresh(receipt.id))}
        />
      )}
      {receiptsReady && needPin && (
        <>
          <Body>
            {receipt
              ? 'Payment received. Enter the PIN to load the same card.'
              : 'Enter the card PIN, then tap the card to create its invoice.'}
          </Body>
          <TextInput
            testID="topup-pin"
            value={pin}
            onChangeText={(s) => setPin(s.replace(/\D/g, '').slice(0, 8))}
            secureTextEntry
            autoComplete="off"
            autoCorrect={false}
            importantForAutofill="no"
            keyboardType="number-pad"
            accessibilityLabel="Card PIN"
            placeholder="Card PIN"
            editable={!busy}
            placeholderTextColor={theme.muted}
            style={[styles.pin, { color: theme.text, backgroundColor: theme.field, borderColor: theme.line }]}
          />
          <Button
            testID="topup-tap"
            label={receipt ? 'Tap to load card' : 'Tap to create invoice'}
            disabled={!!busy || pin.length < 4 || (!receipt && Number(amount) <= 0)}
            onPress={() =>
              void run('Hold the card to the phone…', () =>
                receipt
                  ? service.load(receipt.id, pin, notice)
                  : service.start(Number(amount), pin, cardKey, notice),
              )
            }
          />
        </>
      )}
      {receipt?.state === 'loaded' && <Button testID="topup-done" label={historyOnly ? 'Done' : 'New sale'} onPress={onDone ?? back} />}
      {!!busy && <Body testID="topup-busy">{busy}</Body>}
      {!!error && (
        <Body tone="bad" testID="topup-error">
          {error}
        </Body>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  amountReading: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  confirmAmount: { alignItems: 'center', paddingVertical: 18 },
  pin: {
    fontFamily: FONT.regular,
    fontSize: 20,
    minHeight: 56,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: 14,
    marginVertical: 12,
  },
  qr: {
    width: '100%',
    maxWidth: 300,
    aspectRatio: 1,
    alignSelf: 'center',
    backgroundColor: 'white',
    marginVertical: 12,
  },
});
