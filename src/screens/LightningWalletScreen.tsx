import React, { useEffect, useRef, useState } from 'react';
import { BackHandler, Keyboard } from 'react-native';
import { dateTime, sats } from '../format';
import { foregroundWalletAction, type CredentialSheetEvent } from '../till/foreground-wallet-action';
import type { DeviceGate, GateReason } from '../till/gate';
import {
  LightningWalletError,
  type LightningPayment,
  type LightningState,
  type LightningWallet,
  type SweepPolicy,
} from '../till/lightning';
import { Body, Button, Field, Screen } from '../ui/kit';
import { MerchantMessage, MerchantPanel, PanelLabel } from './MerchantPanel';
import { SaleAmount } from './SalePresentation';

interface Props {
  api: LightningWallet;
  mint: string;
  balance: () => Promise<number>;
  gate: DeviceGate;
  onBack: () => void;
  onCredentialSheet?: (event: CredentialSheetEvent) => void;
}

type Page = 'overview' | 'manual' | 'sweep' | 'review-sweep';

function wholeSats(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const amount = Number(text);
  return amount <= Math.floor(Number.MAX_SAFE_INTEGER / 1000) ? amount : null;
}

function addressLooksComplete(text: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(text.trim());
}

function AmountField({ label, id, value, onChange, disabled }: {
  label: string; id: string; value: string; onChange: (v: string) => void; disabled: boolean;
}): React.JSX.Element {
  return <>
    <PanelLabel>{label}</PanelLabel>
    <Field testID={id} accessibilityLabel={label} keyboardType="number-pad" placeholder="0"
      value={value} onChangeText={onChange} editable={!disabled} />
  </>;
}

function PaymentReceipt({ payment }: { payment: LightningPayment }): React.JSX.Element {
  const label = payment.automatic ? 'Automatic sweep' : 'Lightning withdrawal';
  const statusLabel = { quoted: 'Prepared', pending: 'Payment pending', paid: 'Payment sent', failed: 'Payment failed' };
  const quotedFee = payment.quotedFee ?? payment.maxFee;
  return (
    <MerchantPanel>
      <PanelLabel>{payment.status === 'quoted' && !payment.automatic ? 'Review withdrawal' : label + ' · ' + statusLabel[payment.status]}</PanelLabel>
      <SaleAmount testID="lightning-receipt-amount" receipt>{sats(payment.amount)}</SaleAmount>
      <Body testID="lightning-recipient">{payment.address}</Body>
      {payment.status === 'quoted' && !payment.automatic && payment.description && <>
        <PanelLabel>From the address provider</PanelLabel>
        <Body testID="lightning-description" tone="muted">{payment.description}</Body>
      </>}
      {payment.status === 'quoted' && <>
        <Body testID="lightning-maximum-fee">{'Maximum fees: ' + sats(payment.maxFee)}</Body>
        <Body testID="lightning-maximum-debit">{'Maximum total: ' + sats(payment.amount + payment.maxFee)}</Body>
        <Body tone="muted">{'Quote expires ' + dateTime(payment.expiresAt)}</Body>
      </>}
      {payment.status === 'pending' &&
        <Body testID="lightning-pending">The mint is checking this payment. You can leave Wallet and check it again later.</Body>}
      {payment.status === 'paid' && typeof payment.feePaid === 'number' &&
        <Body testID="lightning-paid-fee">{'Fees paid: ' + sats(payment.feePaid)}</Body>}
      {payment.status === 'paid' && typeof payment.feePaid === 'number' && payment.feePaid > quotedFee && <>
        <Body testID="lightning-fee-overage">{'The final fee was ' + sats(payment.feePaid - quotedFee) +
          ' above the quoted maximum of ' + sats(quotedFee) + '.'}</Body>
        {payment.automatic && payment.maxFee !== quotedFee &&
          <Body testID="lightning-sweep-fee-cap">{'Your sweep fee limit was ' + sats(payment.maxFee) + '.'}</Body>}
      </>}
    </MerchantPanel>
  );
}

function SweepDetails({ policy }: { policy: SweepPolicy }): React.JSX.Element {
  return <>
    <Body testID="sweep-destination">{policy.address}</Body>
    <Body>{'Keep at this mint: ' + sats(policy.threshold)}</Body>
    <Body>{'Maximum fees per sweep: ' + sats(policy.maxFee)}</Body>
  </>;
}

export function LightningWalletScreen({ api, mint, balance, gate, onBack, onCredentialSheet }: Props): React.JSX.Element {
  const [state, setState] = useState<LightningState | null>(null);
  const [available, setAvailable] = useState(0);
  const [page, setPage] = useState<Page>('overview');
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [threshold, setThreshold] = useState('');
  const [maxFee, setMaxFee] = useState('');
  const [proposed, setProposed] = useState<SweepPolicy | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const running = useRef(false);

  async function read(signal: AbortSignal, askMint = false): Promise<void> {
    const latest = askMint ? await api.refresh(mint) : await api.state(mint);
    const amountAvailable = await balance();
    if (!signal.aborted) {
      setState(latest);
      setAvailable(amountAvailable);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void read(controller.signal).catch(() => {
      if (!controller.signal.aborted) setMessage('Could not read this mint’s withdrawals.');
    });
    return () => controller.abort();
  }, [api, mint]);

  function back(): void {
    if (running.current) return;
    setMessage('');
    if (page === 'overview') onBack();
    else setPage(page === 'review-sweep' ? 'sweep' : 'overview');
  }

  useEffect(() => {
    const event = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; });
    return () => event.remove();
  }, [page, onBack]);

  async function run(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || running.current) return;
    Keyboard.dismiss();
    running.current = true;
    setBusy(true);
    setMessage('');
    try {
      await action(signal);
    } catch (error) {
      if (signal.aborted) return;
      setMessage(error instanceof LightningWalletError ? error.message : 'Could not finish. Check the withdrawal status before trying again.');
      // A request can reach the mint even when the response cannot reach this phone.
      try { await read(signal); } catch { if (!signal.aborted) setState(null); }
    } finally {
      running.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  async function authorize(signal: AbortSignal, reason: GateReason, action: () => Promise<void>): Promise<void> {
    setAuthorizing(true);
    try {
      const message = await foregroundWalletAction(gate, reason, signal, 'Return to Wallet and confirm again.', async () => {
        setAuthorizing(false);
        await action();
        return '';
      }, onCredentialSheet);
      if (message && !signal.aborted) setMessage(message);
    } finally {
      if (!signal.aborted) setAuthorizing(false);
    }
  }

  function enterForm(next: 'manual' | 'sweep'): void {
    setAddress(state?.policy?.address ?? '');
    setAmount('');
    setThreshold(state?.policy?.threshold.toString() ?? '');
    setMaxFee(state?.policy?.maxFee.toString() ?? '');
    setProposed(null);
    setMessage('');
    setPage(next);
  }

  const payment = state?.payment;
  const policy = state?.policy;
  // Refresh a quote that expires while it is on screen. The service also checks
  // expiry when claiming the quote, including time spent in a credential sheet.
  useEffect(() => {
    if (!payment || payment.status !== 'quoted') return;
    const remaining = payment.expiresAt - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => {
      if (!running.current) void run(current => read(current));
    }, Math.min(remaining + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [payment?.id, payment?.status, payment?.expiresAt]);

  const note = message ? <MerchantMessage id="wallet-message">{message}</MerchantMessage> : null;
  const addressField = <>
    <PanelLabel>Lightning address</PanelLabel>
    <Field testID="lightning-address" accessibilityLabel="Lightning address" keyboardType="email-address"
      placeholder="name@example.com" value={address} onChangeText={setAddress} editable={!busy} />
  </>;
  const onNavigateBack = busy ? undefined : back;

  if (authorizing) {
    return <Screen title="Confirm on this phone" titleID="lightning-verifying">
      <Body>Follow the confirmation prompt on your phone.</Body>
    </Screen>;
  }

  if (page === 'manual') {
    return <Screen title="Withdraw to Lightning" titleID="lightning-manual-title" adjustForKeyboard onBack={onNavigateBack}>
      <MerchantPanel>
        <PanelLabel>Available at this mint</PanelLabel>
        <SaleAmount testID="lightning-manual-balance" receipt>{sats(available)}</SaleAmount>
        <Body tone="muted">{mint}</Body>
      </MerchantPanel>
      {addressField}
      <AmountField id="lightning-amount" label="Amount to send (sats)" value={amount} onChange={setAmount} disabled={busy} />
      <Body tone="muted">Review the fees before you send.</Body>
      {note}
      <Button testID="lightning-get-quote" label={busy ? 'Getting quote…' : 'Review withdrawal'} disabled={busy} onPress={() => {
        const n = wholeSats(amount);
        if (!addressLooksComplete(address)) { setMessage('Enter a Lightning address such as name@example.com.'); return; }
        if (n === null || n <= 0) { setMessage('Enter a positive, whole number of sats.'); return; }
        if (n > available) { setMessage('The amount exceeds your available takings at this mint.'); return; }
        void run(async signal => {
          await api.quote(mint, address.trim(), n);
          if (!signal.aborted) setPage('overview');
          await read(signal);
        });
      }} />
    </Screen>;
  }

  if (page === 'sweep') {
    return <Screen title="Automatic sweep" titleID="lightning-sweep-title" adjustForKeyboard onBack={onNavigateBack}>
      <Body tone="muted">{mint}</Body>
      <Body>While the till is open, send takings above the balance you choose. Fees come out of the excess.</Body>
      {addressField}
      <AmountField id="sweep-threshold" label="Balance to keep (sats)" value={threshold} onChange={setThreshold} disabled={busy} />
      <AmountField id="sweep-max-fee" label="Maximum fees per sweep (sats)" value={maxFee} onChange={setMaxFee} disabled={busy} />
      {note}
      <Button testID="sweep-review" label="Review automatic sweep" disabled={busy} onPress={() => {
        Keyboard.dismiss();
        const keep = wholeSats(threshold), cap = wholeSats(maxFee);
        if (!addressLooksComplete(address)) { setMessage('Enter a Lightning address such as name@example.com.'); return; }
        if (keep === null || cap === null) { setMessage('Enter whole sats for the balance and fee limit. You can set either to zero.'); return; }
        setProposed({ address: address.trim(), threshold: keep, maxFee: cap });
        setMessage('');
        setPage('review-sweep');
      }} />
      {policy && <Button testID="sweep-disable" label="Turn off automatic sweep" kind="plain" disabled={busy} onPress={() => {
        void run(signal => authorize(signal, 'lightning-sweep', async () => {
          await api.configure(mint, null);
          if (!signal.aborted) setPage('overview');
          await read(signal);
        }));
      }} />}
    </Screen>;
  }

  if (page === 'review-sweep' && proposed) {
    return <Screen title="Review automatic sweep" titleID="sweep-review-title" onBack={onNavigateBack}>
      <MerchantPanel>
        <PanelLabel>Send excess takings to</PanelLabel>
        <SweepDetails policy={proposed} />
        <Body tone="muted">{mint}</Body>
      </MerchantPanel>
      <Body>The first sweep can start as soon as you confirm. Future sweeps use these settings while the till is open.</Body>
      {note}
      <Button testID="sweep-confirm" label={busy ? 'Saving…' : policy ? 'Save sweep changes' : 'Enable automatic sweep'} disabled={busy} onPress={() => {
        void run(signal => authorize(signal, 'lightning-sweep', async () => {
          await api.configure(mint, proposed);
          if (!signal.aborted) setPage('overview');
          await read(signal);
        }));
      }} />
    </Screen>;
  }

  return <Screen title="Lightning withdrawals" titleID="lightning-title" onBack={onNavigateBack}>
    <Body tone="muted">{mint}</Body>
    {note}
    {!state ? <>
      {!message && <Body>Reading withdrawals…</Body>}
      {message && <Button testID="lightning-reload" label="Check again" disabled={busy}
        onPress={() => { void run(signal => read(signal)); }} />}
    </> : <>
      {payment && <PaymentReceipt payment={payment} />}
      {payment?.status === 'quoted' && !payment.automatic && <>
        <Button testID="lightning-send" label={busy ? 'Sending…' : 'Send ' + sats(payment.amount)} disabled={busy || Date.now() >= payment.expiresAt} onPress={() => {
          void run(signal => authorize(signal, 'lightning-send', async () => {
            await api.confirm(mint, payment.id);
            await read(signal);
          }));
        }} />
        <Button testID="lightning-cancel" label="Cancel quote" kind="plain" disabled={busy} onPress={() => {
          void run(async signal => { await api.cancel(mint, payment.id); await read(signal); });
        }} />
      </>}
      {(payment?.status === 'pending' || (payment?.status === 'quoted' && payment.automatic)) &&
        <Button testID="lightning-check" label={busy ? 'Checking…' : 'Check payment'} disabled={busy} onPress={() => { void run(signal => read(signal, true)); }} />}
      {payment?.status !== 'quoted' && payment?.status !== 'pending' && <>
        <PanelLabel>Available to withdraw</PanelLabel>
        <SaleAmount testID="lightning-available" receipt>{sats(available)}</SaleAmount>
        <Button testID="lightning-manual" label="Withdraw to Lightning address" disabled={busy || available <= 0}
          onPress={() => enterForm('manual')} />
      </>}
      <MerchantPanel>
        <PanelLabel>Automatic sweep</PanelLabel>
        {policy ? <SweepDetails policy={policy} /> : <Body>Off</Body>}
        {state.sweepNotice && <Body tone="muted">{state.sweepNotice}</Body>}
        <Button testID="lightning-sweep" label={policy ? 'Edit automatic sweep' : 'Set up automatic sweep'} kind="plain"
          disabled={busy} onPress={() => enterForm('sweep')} />
      </MerchantPanel>
      {payment?.status !== 'pending' && payment?.status !== 'quoted' && <Button
        testID="lightning-refresh" label="Refresh" kind="plain" disabled={busy}
        onPress={() => { void run(signal => read(signal, true)); }} />}
    </>}
  </Screen>;
}
