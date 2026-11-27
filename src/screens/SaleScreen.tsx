/* The sale, as the one screen the merchant works in: it owns the controller, shows the panel for the state, keeps
 * Android's back while anything is pending, and tells the app root each state's summary. When it goes, the controller
 * answers the library no. Nothing here logs, shows or holds a PIN, a token, a proof or a key. */

import React, { useEffect, useRef, useState } from 'react';
import { AppState, BackHandler } from 'react-native';
import type { Payment } from 'cashucard';
import type { TillQueue } from '../till/queue';
import type { CardReader } from '../till/reader';
import { deviceNetworkStatus } from '../till/device-network';
import { createSaleController, type SaleController, type SaleInput } from '../till/sale-controller';
import {
  SALE_START,
  saleBackAllowed,
  saleSummary,
  type SaleReport,
  type SaleState,
} from '../till/sale-machine';
import type { TillService } from '../till/service';
import { ConfirmPanel, KeypadPanel, OpeningPanel, PinPanel, TapPanel } from './SalePanels';
import { PreparingInvoice } from './PhonePaymentScreen';
import { ResultPanel } from './SaleResult';
import { CheckoutScreen, hasCheckout, type CheckoutService } from './CheckoutScreen';

export interface SaleScreenProps {
  service: Pick<TillService, 'openSale' | 'takeCard' | 'withdrawSale'> &
    Partial<Pick<TillService, 'leaveSale' | 'salesStopped' | 'hasReadyOfflineMint' | 'takeOfflineCard'> & CheckoutService>;
  reader: CardReader;
  /** the addresses of the mints taking cards */
  mints: string[];
  onBack?: () => void;
  onBalance?: (digits: string) => void;
  onReturn?: () => void;
  initialDigits?: string;
  renderKeypad?: (page: React.JSX.Element) => React.JSX.Element;
  notices?: React.ReactNode;
  canSell?: boolean;
  onActivity: () => void;
  /** each state's summary, for the app's report */
  onReport: (r: SaleReport) => void;
  /** the till's queue (the controller tells a card job that waits behind other work); absent: never told */
  queue?: Pick<TillQueue, 'running' | 'waiting'>;
  /** the service's settles, heard while the screen is shown (TillService.onPayments); absent: none heard */
  onPayments?: (l: (changed: Payment[]) => void) => () => void;
}

export function SaleScreen(p: SaleScreenProps): React.JSX.Element {
  const [state, setState] = useState<SaleState>(() => p.initialDigits ? { kind: 'keypad', digits: p.initialDigits } : SALE_START);
  const live = useRef(true);
  const ctl = useRef<SaleController | null>(null);
  /** the newest onReport, so a state that arrives late still reaches the app root */
  const report = useRef(p.onReport);
  report.current = p.onReport;

  useEffect(() => p.reader.enterSaleScreen?.(), [p.reader]);

  if (ctl.current === null) {
    ctl.current = createSaleController({
      initialDigits: p.initialDigits,
      service: p.service,
      reader: p.reader,
      networkStatus: p.reader.kind === 'nfc' ? deviceNetworkStatus : undefined,
      queue: p.queue,
      onState: (s): void => {
        if (live.current) {
          setState(s);
          report.current(saleSummary(s));
        }
      },
    });
  }

  useEffect(() => {
    live.current = true;
    p.onReport(saleSummary(ctl.current!.state()));
    // React Native calls the back handler added last first: this one runs before the app root's. Answering true keeps
    // the merchant on the sale; false lets the root go back.
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const controller = ctl.current!;
      const current = controller.state();
      if (!saleBackAllowed(current)) return true;
      if (current.kind === 'result' && p.renderKeypad) {
        controller.input({ type: 'new' });
        return true;
      }
      return false;
    });
    const appState = AppState.addEventListener('change', next => {
      if (next === 'background') ctl.current?.background();
      else if (next === 'active') ctl.current?.foreground();
    });
    const offPayments =
      p.onPayments === undefined
        ? null
        : p.onPayments((changed) => {
            for (const x of changed) {
              ctl.current?.settled(x);
            }
          });
    return () => {
      live.current = false;
      sub.remove();
      appState.remove();
      offPayments?.();
      ctl.current?.dispose();
    };
  }, []);

  const send = (i: SaleInput): void => {
    ctl.current?.input(i);
  };

  switch (state.kind) {
    case 'keypad': {
      const page = <KeypadPanel digits={state.digits} mints={p.mints} send={send}
        onBack={p.onBack}
        onBalance={p.onBalance && (() => p.onBalance?.(state.digits))} notices={p.notices} canSell={p.canSell} />;
      return p.renderKeypad ? p.renderKeypad(page) : page;
    }
    case 'opening':
      return <OpeningPanel sats={state.sats} queued={state.queued === true} send={send} />;
    case 'tap':
    case 'stopping':
      return <TapPanel state={state} send={send} />;
    case 'confirm':
      return <ConfirmPanel c={state.c} send={send} />;
    case 'preflight':
      if (state.saleId && !state.mode && hasCheckout(p.service)) {
        return <CheckoutScreen key={state.saleId} saleId={state.saleId} state={state} service={p.service}
          controller={ctl.current} onActivity={p.onActivity} onReturn={p.onReturn ?? p.onActivity} />;
      }
      return <PinPanel state={state} send={send}
        wallet={state.shared && state.mode !== 'offline' ? <PreparingInvoice /> : undefined} />;
    case 'pin':
      return <PinPanel state={state} send={send} />;
    case 'result':
      return <ResultPanel state={state} afterScanSheet={p.reader.afterScanSheet} send={send} onActivity={p.onActivity} onReturn={p.onReturn} />;
  }
}
