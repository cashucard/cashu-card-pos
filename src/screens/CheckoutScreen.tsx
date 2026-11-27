import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { sats } from '../format';
import type { LightningSaleReceipt } from '../till/lightning-sale';
import type { SaleController } from '../till/sale-controller';
import type { SaleState } from '../till/sale-machine';
import type { TillService } from '../till/service';
import { Body, Button } from '../ui/kit';
import { PhonePaymentScreen, type PhoneService } from './PhonePaymentScreen';
import { PinPanel } from './SalePanels';
import { SaleStage } from './SalePresentation';

export type CheckoutService = PhoneService & Pick<TillService, 'lightningOffer' | 'checkLightningSale'>;
export function hasCheckout(service: Partial<CheckoutService>): service is CheckoutService {
  return !!(service.lightningOffer && service.checkLightningSale && service.phoneOffer && service.takePhonePayment &&
    service.payments && service.onPayments);
}

export function CheckoutScreen({ saleId, state, service, controller, onActivity, onReturn }: {
  saleId: string;
  state: Extract<SaleState, { kind: 'preflight' }>;
  service: CheckoutService;
  controller: SaleController;
  onActivity(): void;
  onReturn(): void;
}): React.JSX.Element {
  const [lightning, setLightning] = useState<{ invoice?: string; message?: string }>({});
  const [processing, setProcessing] = useState(false);
  const [offerAttempt, setOfferAttempt] = useState(0);
  const [canRetry, setCanRetry] = useState(false);
  // Re-entering preflight after NFC creates a fresh checkout instance. Keep that
  // first verification independent of the state change when the invoice clears.
  const verifyOnEntry = useRef(state.verifyInvoice === true);
  const cashuPaid = useCallback(() => controller.walletPaid(saleId, 'Cashu'), [controller, saleId]);

  useEffect(() => {
    setCanRetry(false);
    setLightning({});
    let active = true;
    let visible = AppState.currentState !== 'background';
    let working = false;
    let finished = false;
    let verifying = verifyOnEntry.current;
    let opened = verifying;
    let delay = 2500;
    let poll: ReturnType<typeof setTimeout>;
    let expiry: ReturnType<typeof setTimeout>;

    // A quote belongs to this sale even after changing the displayed QR to Cashu.
    function show(row: LightningSaleReceipt) {
      if (!active || row.saleId !== saleId) return;
      clearTimeout(expiry);
      if (verifying && (row.state === 'unpaid' || row.state === 'expired')) {
        verifying = false;
        verifyOnEntry.current = false;
        controller.invoiceUnpaid(saleId);
      }
      switch (row.state) {
        case 'paid':
          finished = true;
          controller.walletPaid(saleId, 'Lightning');
          return;
        case 'extra':
          finished = true;
          controller.walletExtra(saleId);
          return;
        case 'processing':
          controller.walletProcessing(saleId);
          setProcessing(true);
          setLightning({});
          return;
        case 'expired':
          delay = 15000;
          setLightning({ message: 'Invoice expired. Start a new sale for a fresh invoice or pay by card.' });
          return;
        case 'unpaid': {
          const timeLeft = row.expiresAt - Date.now();
          if (timeLeft <= 0) {
            setLightning({ message: 'Invoice expired. Checking its final status.' });
            return;
          }
          setLightning({ invoice: row.invoice });
          if (timeLeft <= 2147483647) {
            expiry = setTimeout(() => {
              if (active) setLightning({ message: 'Invoice expired. Checking its final status.' });
            }, timeLeft);
          }
          return;
        }
      }
    }

    async function check() {
      if (!active || !visible || finished || working) return;
      clearTimeout(poll);
      working = true;
      try {
        const row = opened ? await service.checkLightningSale(saleId) : await service.lightningOffer(saleId);
        opened = true;
        show(row);
      } catch {
        if (active) {
          setCanRetry(!opened);
          setLightning({ message: opened ? 'Reconnecting to check the invoice.' : 'Lightning is unavailable for this sale.' });
        }
      } finally {
        working = false;
        if (active && visible && !finished && opened) poll = setTimeout(() => { void check(); }, delay);
      }
    }

    void check();
    const app = AppState.addEventListener('change', next => {
      visible = next === 'active';
      if (visible) void check();
      else clearTimeout(poll);
    });
    return () => {
      active = false;
      clearTimeout(poll);
      clearTimeout(expiry);
      app.remove();
    };
  }, [controller, saleId, service, offerAttempt]);

  if (state.verifyInvoice && !processing) {
    return <SaleStage title="Checking Lightning payment" titleID="lightning-verifying" signal="busy"
      amount={sats(state.sats)} amountID="lightning-amount"
      description={<Body>The till is checking the original invoice with the mint. Wait for its status before taking another payment.</Body>}>
      <Button testID="lightning-activity" label="View activity" kind="plain" onPress={onActivity} />
    </SaleStage>;
  }
  if (processing) {
    return <SaleStage title="Confirming Lightning payment" titleID="lightning-processing" amount={sats(state.sats)}
      amountID="lightning-amount" signal="busy"
      description={<Body>The invoice was paid. The till is collecting the payment from the mint.</Body>}>
      <Button testID="lightning-activity" label="View activity" kind="plain" onPress={onActivity} />
    </SaleStage>;
  }
  return <PhonePaymentScreen saleId={saleId} amount={state.sats} service={service} lightning={lightning}
    retryLightning={canRetry ? () => setOfferAttempt(n => n + 1) : undefined}
    onPaid={cashuPaid} beginTender={() => controller.holdWallet(saleId)} resumeCard={() => controller.releaseWallet(saleId)}
    onNewSale={() => { controller.releaseWallet(saleId); controller.input({ type: 'pin-cancel' }); }}
    onActivity={onActivity} onReturn={onReturn}
    renderPin={panel => <PinPanel state={state} send={i => controller.input(i)} wallet={panel} />} />;
}
