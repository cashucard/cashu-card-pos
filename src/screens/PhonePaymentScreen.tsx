import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, Clipboard, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { Payment } from 'cashucard';
import { decodePaymentRequest } from '@cashu/cashu-ts';
import { PhonePaymentScannerError, scanPhonePaymentQr } from '../app/phone-payment-scanner';
import { hostOf, sats } from '../format';
import { PhonePaymentError } from '../till/phone-payment';
import type { TillService } from '../till/service';
import { Body, Button } from '../ui/kit';
import { FONT, useTheme } from '../ui/theme';
import { CashuQr } from './CashuQr';
import { MerchantMessage } from './MerchantPanel';
import { SaleStage } from './SalePresentation';

export type PhoneService = Pick<TillService, 'phoneOffer' | 'takePhonePayment' | 'payments' | 'onPayments'>;
interface Props {
  amount: number;
  service: PhoneService;
  saleId: string;
  /** The sale controller owns both the displayed invoice and the PIN lifetime. */
  lightning: { invoice?: string; message?: string };
  retryLightning?: () => void;
  renderPin(wallet: React.JSX.Element): React.JSX.Element;
  beginTender(): boolean;
  resumeCard(): void;
  onPaid(): void;
  onActivity(): void;
  onNewSale(): void;
  onReturn(): void;
}

type Stage =
  | { kind: 'opening' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'request'; offer: string; mints: string[] }
  | { kind: 'receiving' }
  | { kind: 'pending'; message: string; paymentId?: string }
  | { kind: 'ended'; message: string }
  | { kind: 'return'; message: string };

function TextAction({ label, id, onPress, disabled }: {
  label: string; id: string; onPress(): void; disabled?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  return <Pressable testID={id} onPress={onPress} disabled={disabled} accessibilityRole="button"
    accessibilityState={{ disabled: !!disabled }} style={styles.action}>
    <Text style={[styles.actionText, { color: theme.good }]}>{label}</Text>
  </Pressable>;
}

/** Keep the PIN pad in place while the mint prepares the scannable invoice. */
function RequestRow({ qr, children, loading }: {
  qr?: (width: number) => React.ReactNode; children: React.ReactNode; loading?: boolean;
}): React.JSX.Element {
  const { width, fontScale } = useWindowDimensions();
  const theme = useTheme();
  const narrow = width < 350 || fontScale > 1.35;
  const qrWidth = narrow ? 180 : Math.min(182, Math.floor((width - 60) * 0.48));
  return <View style={[styles.requestRow, narrow && styles.stacked]}>
    {qr ? <View style={{ width: qrWidth }}>{qr(qrWidth)}</View> : loading &&
      <View style={[styles.placeholder, { width: qrWidth, height: qrWidth + 24 }]}>
        <ActivityIndicator color={theme.muted} />
      </View>}
    <View style={styles.info}>{children}</View>
  </View>;
}

export function PreparingInvoice(): React.JSX.Element {
  const theme = useTheme();
  return <View style={[styles.panel, { borderColor: theme.line }]}>
    <RequestRow loading>
      <Text style={[styles.heading, { color: theme.text }]}>Pay with Lightning</Text>
      <Text style={[styles.caption, { color: theme.muted }]}>Preparing the invoice…</Text>
    </RequestRow>
  </View>;
}

export function PhonePaymentScreen({
  amount, saleId, service, lightning, retryLightning, renderPin, beginTender, resumeCard, onPaid, onActivity, onNewSale, onReturn,
}: Props): React.JSX.Element {
  const [mode, setMode] = useState<'lightning' | 'cashu'>('lightning');
  const [stage, setStage] = useState<Stage>({ kind: 'opening' });
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState('');
  const [reading, setReading] = useState(false);
  const active = useRef(true);
  const busy = useRef(false);
  const theme = useTheme();

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    if (mode !== 'cashu') return;
    let current = true;
    setStage({ kind: 'opening' });
    setMessage('');
    void service.phoneOffer(saleId).then(offer => {
      if (current) setStage({ kind: 'request', offer, mints: decodePaymentRequest(offer).mints ?? [] });
    }).catch(error => {
      if (current) setStage({ kind: 'unavailable', message: error instanceof PhonePaymentError
        ? error.message : 'The Cashu request couldn’t open. Check the mint connection.' });
    });
    return () => { current = false; };
  }, [saleId, service, attempt, mode]);

  // A swap with an unknown outcome belongs to this sale. Only its recorded mint result can mark it paid.
  useEffect(() => {
    if (stage.kind !== 'pending') return;
    let watching = true;
    const reconcile = (rows: Payment[]) => {
      if (!watching) return;
      const matches = rows.filter(p => p.id === saleId && !p.cardKey && p.unit === 'sat' && p.amount === amount &&
        (!stage.paymentId || p.paymentId === stage.paymentId));
      const paid = matches.find(p => !p.extra && (p.state === 'held' || p.state === 'delivered' || p.state === 'exported'));
      if (paid) {
        watching = false;
        onPaid();
      } else if (matches.some(p => p.extra && p.state === 'held')) {
        watching = false;
        setStage({ kind: 'return', message: 'The mint confirmed this extra payment. Give it back to the customer who sent it.' });
      } else if (stage.paymentId && matches.some(p => p.state === 'gone')) {
        watching = false;
        setStage({ kind: 'ended', message: 'The mint declined this payment. The customer can check the token in their wallet.' });
      }
    };
    const check = () => { void service.payments().then(reconcile, () => undefined); };
    const off = service.onPayments(reconcile);
    const front = AppState.addEventListener('change', state => { if (state === 'active') check(); });
    check();
    return () => { watching = false; off(); front.remove(); };
  }, [amount, service, saleId, stage, onPaid]);

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy.current || stage.kind === 'receiving') return true;
      if (stage.kind === 'return') { onReturn(); return true; }
      if (stage.kind === 'pending') { onActivity(); return true; }
      if (stage.kind === 'ended') { onNewSale(); return true; }
      return false;
    });
    return () => back.remove();
  }, [stage.kind, onActivity, onNewSale, onReturn]);

  async function receive(source: 'scan' | 'paste') {
    if (!active.current || busy.current || stage.kind !== 'request' || !beginTender()) return;
    let allowCardAgain = true;
    busy.current = true;
    setReading(true);
    setMessage('');
    try {
      let text: string | null;
      try {
        text = source === 'scan' ? await scanPhonePaymentQr() : await Clipboard.getString();
      } catch (error) {
        if (!active.current) return;
        if (source === 'paste') setMessage('Couldn’t read the clipboard. Copy the wallet payment or scan its QR code.');
        else if (error instanceof PhonePaymentScannerError) setMessage(error.message);
        else if (error && typeof error === 'object' && 'code' in error && error.code === 'camera_denied') {
          setMessage('Allow camera access in Settings or paste the payment instead.');
        } else setMessage('Couldn’t scan the payment. Check camera access or paste the full token from the customer’s wallet.');
        return;
      }
      if (!active.current || text === null) return;
      if (!text.trim()) {
        setMessage('Copy the payment from the customer’s wallet, then paste it here.');
        return;
      }
      setStage({ kind: 'receiving' });
      allowCardAgain = false;
      const result = await service.takePhonePayment(saleId, text);
      if (!active.current) return;
      if (result.kind === 'refused') {
        allowCardAgain = true;
        setStage(stage);
        setMessage(result.message);
      } else if (result.kind === 'paid') {
        onPaid();
      } else {
        setStage(result);
      }
    } catch {
      // If the mint was contacted, guessing "declined" here would invite a second payment.
      if (active.current) setStage({ kind: 'pending', message: 'The till couldn’t confirm the payment. Keep the customer’s token and check Activity before trying again.' });
    } finally {
      busy.current = false;
      if (active.current) {
        if (allowCardAgain) resumeCard();
        setReading(false);
      }
    }
  }

  if (mode === 'lightning' || stage.kind === 'opening' || stage.kind === 'unavailable' || stage.kind === 'request') {
    const cashu = mode === 'cashu';
    const request = cashu ? (stage.kind === 'request' ? stage.offer : undefined) : lightning.invoice;
    function switchMode() {
      if (busy.current) return;
      setMessage('');
      setMode(cashu ? 'lightning' : 'cashu');
    }
    const panel = <View testID="checkout-qr-panel" style={[styles.panel, { borderColor: theme.line }]}>
      <RequestRow loading={cashu ? stage.kind === 'opening' : !lightning.message}
        qr={request ? qrWidth =>
          <CashuQr value={request} label={(cashu ? 'Cashu payment request' : 'Lightning invoice') + ' for ' + sats(amount)}
            imageID={cashu ? 'phone-request-qr' : 'lightning-request-qr'} maxWidth={qrWidth}
            fallback={<TextAction id="phone-request-copy" label={cashu ? 'Copy request' : 'Copy invoice'} onPress={() => {
              try { Clipboard.setString(request); setMessage(cashu ? 'Request copied.' : 'Invoice copied.'); }
              catch { setMessage('Couldn’t copy the request.'); }
            }} />} /> : undefined}>
          <Text style={[styles.heading, { color: theme.text }]}>{cashu ? 'Pay with Cashu' : 'Pay with Lightning'}</Text>
          <Text testID={cashu ? 'phone-caption' : 'lightning-caption'} style={[styles.caption, { color: theme.muted }]}>
            {cashu ? stage.kind === 'unavailable' ? stage.message : request ? 'Scan with a Cashu wallet, then share its payment with the cashier.' : 'Preparing the Cashu request…'
              : lightning.message || (request ? 'Scan to pay this amount.' : 'Preparing the invoice…')}
          </Text>
          {cashu && stage.kind === 'request' && stage.mints.length > 0 &&
            <Text testID="phone-mints" style={[styles.mint, { color: theme.muted }]}>{stage.mints.map(hostOf).join(', ')}</Text>}
          {!cashu && retryLightning && <TextAction id="lightning-retry" label="Retry Lightning" onPress={retryLightning} />}
          {cashu && stage.kind === 'unavailable' && <TextAction id="phone-retry" label="Try again" onPress={() => setAttempt(n => n + 1)} />}
          <TextAction id="checkout-switch-wallet" disabled={reading} label={cashu ? 'Use Lightning' : 'Use a Cashu wallet'} onPress={switchMode} />
      </RequestRow>
      {cashu && stage.kind === 'request' && <View style={styles.actions}>
        <TextAction id="phone-scan" label="Scan payment" disabled={reading} onPress={() => { void receive('scan'); }} />
        <TextAction id="phone-paste" label="Paste payment" disabled={reading} onPress={() => { void receive('paste'); }} />
      </View>}
      {message !== '' && <MerchantMessage id="phone-message">{message}</MerchantMessage>}
    </View>;
    return renderPin(panel);
  }

  const pending = stage.kind === 'pending';
  const titles = {
    opening: 'Opening request', receiving: 'Checking payment', pending: 'Awaiting confirmation',
    ended: 'Payment declined', unavailable: 'Request unavailable', return: 'Customer return',
  };
  const detail = 'message' in stage ? stage.message
    : stage.kind === 'receiving' ? 'Checking the customer’s payment with the mint.' : undefined;
  return <SaleStage title={titles[stage.kind]} titleID="phone-title" amount={sats(amount)} amountID="phone-amount"
    signal={pending || stage.kind === 'return' ? 'attention' : stage.kind === 'ended' ? 'declined' : 'busy'}
    description={detail ? <Body testID="phone-detail">{detail}</Body> : undefined}>
    {stage.kind === 'return' && <Button testID="phone-return" label="Open Owed to cards" onPress={onReturn} />}
    {(stage.kind === 'ended') && <Button testID="phone-new" label="New sale" onPress={onNewSale} />}
    {(pending || stage.kind === 'ended') && <Button testID="phone-activity" label="View Activity" kind={pending ? 'primary' : 'plain'} onPress={onActivity} />}
  </SaleStage>;
}

const styles = StyleSheet.create({
  panel: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 5, marginBottom: 3 },
  requestRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  stacked: { flexDirection: 'column', alignItems: 'stretch', gap: 0 },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  info: { flexShrink: 1, flexGrow: 1 },
  heading: { fontFamily: FONT.bold, fontSize: 20 },
  caption: { fontFamily: FONT.regular, fontSize: 15, marginTop: 3 },
  mint: { fontFamily: FONT.regular, fontSize: 13, marginTop: 3 },
  actions: { flexDirection: 'row', gap: 22, justifyContent: 'center', flexWrap: 'wrap' },
  action: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  actionText: { fontFamily: FONT.semibold, fontSize: 15 },
});
