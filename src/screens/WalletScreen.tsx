import React, { useEffect, useRef, useState } from 'react';
import { AppState, BackHandler } from 'react-native';
import { cashuAmount } from '../format';
import type { CredentialSheetEvent } from '../till/foreground-wallet-action';
import { LightningWalletScreen } from './LightningWalletScreen';
import type { DeviceGate } from '../till/gate';
import { revealToken } from '../till/reveal-token';
import type { WalletBalance, WalletReader } from '../till/wallet';
import { Body, Button, Screen } from '../ui/kit';
import { MerchantMessage, MerchantPanel, PanelLabel } from './MerchantPanel';
import { SaleAmount } from './SalePresentation';
import { TokenScreen } from './TokenScreen';
import { WalletRefreshed } from './WalletRefreshed';

export interface WalletProps {
  service: WalletReader;
  gate: DeviceGate;
  share?: (title: string, text: string) => Promise<void>;
  onBack(): void;
  onCredentialSheet?: (event: CredentialSheetEvent) => void;
  renderOverview?: (page: React.JSX.Element) => React.JSX.Element;
}

export function WalletScreen({ service, gate, share, onBack, renderOverview, onCredentialSheet }: WalletProps): React.JSX.Element {
  const [balances, setBalances] = useState<WalletBalance[] | null>(null);
  const [lightningMint, setLightningMint] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshId, setRefreshId] = useState<number | null>(null);
  const readVersion = useRef(0);
  const [review, setReview] = useState<WalletBalance | null>(null);
  const mounted = useRef(false);
  const running = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const [shown, setShown] = useState<{ title: string; mint: string; token: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    lifetime.current = controller;
    const initialRead = ++readVersion.current;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        if (running.current) readVersion.current++;
        setRefreshId(null);
        setShown(null);
        setReview(null);
      }
    });
    service.walletBalances().then(
      (groups) => {
        if (!controller.signal.aborted && initialRead === readVersion.current) setBalances(groups);
      },
      () => {
        if (!controller.signal.aborted && initialRead === readVersion.current) setMessage('Could not read the wallet. Refresh to try again.');
      },
    );
    return () => {
      mounted.current = false;
      controller.abort();
      subscription.remove();
    };
  }, [service]);

  useEffect(() => {
    if (!review && !shown && !busy) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy) return true;
      if (shown) {
        setShown(null);
        setMessage('Check redemption after your wallet receives the token.');
      } else {
        setReview(null);
      }
      return true;
    });
    return () => back.remove();
  }, [review, shown, busy]);

  // A bare refresh reads the wallet once. Other actions use the same read to update balances.
  const act = async (job?: () => Promise<string>) => {
    if (running.current) return;
    running.current = true;
    const version = ++readVersion.current;
    setRefreshId(null);
    setBusy(true);
    setMessage('');
    try {
      if (job) {
        const note = await job();
        if (mounted.current) setMessage(note);
      }
    } catch {
      if (mounted.current) setMessage('Could not finish. Refresh to see your takings and try again.');
    } finally {
      try {
        const groups = await service.walletBalances();
        if (mounted.current) {
          setBalances(groups);
          if (!job && version === readVersion.current) setRefreshId(version);
        }
      } catch {
        if (mounted.current) setMessage('Could not read the wallet. Refresh to try again.');
      }
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  if (lightningMint && service.lightning) {
    return <LightningWalletScreen key={lightningMint} api={service.lightning} mint={lightningMint}
      gate={gate} onCredentialSheet={onCredentialSheet}
      balance={async () => (await service.walletBalances()).find(g => g.mint === lightningMint && g.unit === 'sat')?.available ?? 0}
      onBack={() => { setLightningMint(null); void act(async () => ''); }} />;
  }

  if (shown) {
    return (
      <TokenScreen
        title={shown.title}
        mint={shown.mint}
        token={shown.token}
        share={share}
        onDone={() => {
          setShown(null);
          setMessage('Check redemption after your wallet receives the token.');
        }}
      />
    );
  }

  if (review) {
    return (
      <Screen title="Withdraw as eCash" titleID="wallet-review-title" onBack={busy ? undefined : () => setReview(null)}>
        <MerchantPanel>
          <PanelLabel>Available at this mint</PanelLabel>
          <SaleAmount testID="wallet-review-amount" receipt>{cashuAmount(review.available, review.unit)}</SaleAmount>
          <Body>{review.mint}</Body>
        </MerchantPanel>
        <Body>Prepare a token from this mint for your own Cashu wallet. You’ll see its amount before you share it. Large balances can take more than one withdrawal.</Body>
        <Button testID="wallet-confirm-prepare" label="Prepare withdrawal token" disabled={busy} onPress={() => {
          void act(async () => {
            try {
              const current = (await service.walletBalances()).find(row => row.mint === review.mint && row.unit === review.unit);
              if (!current || current.withdrawal || current.available !== review.available)
                return 'This balance changed. Review the current amount before withdrawing.';
              await service.prepareWithdrawal(review.mint, review.unit);
              return 'Your token is ready to share.';
            } finally {
              if (mounted.current) setReview(null);
            }
          });
        }} />
      </Screen>
    );
  }

  const page = (
    <Screen title="Wallet" titleID="wallet-title" onBack={renderOverview || busy ? undefined : onBack}>
      {balances === null && !message ? <Body>Reading your wallet…</Body> : null}
      {message ? <MerchantMessage id="wallet-message">{message}</MerchantMessage> : null}
      {balances?.length === 0 ? (
        <MerchantPanel>
          <PanelLabel>Available to withdraw</PanelLabel>
          <Body>No takings available</Body>
          <Body tone="muted">Takings appear here when a mint confirms a sale.</Body>
        </MerchantPanel>
      ) : null}
      {balances?.map((group) => {
        const active = group.withdrawal;
        const key = group.mint + '/' + group.unit;
        return (
          <MerchantPanel key={key}>
            <Body>{group.mint}</Body>
            {group.available > 0 || (service.lightning && group.unit === 'sat' && !active) ? (
              <>
                <PanelLabel>Available to withdraw</PanelLabel>
                <SaleAmount testID={'wallet-amount-' + key} receipt>{cashuAmount(group.available, group.unit)}</SaleAmount>
              </>
            ) : null}
            {service.lightning && group.unit === 'sat' &&
              <Button testID={'wallet-lightning-' + key} label="Lightning withdrawals"
                accessibilityLabel={'Lightning withdrawals for ' + group.mint}
                disabled={busy} onPress={() => { setRefreshId(null); setLightningMint(group.mint); }} />}
            {active ? (
              <>
                <PanelLabel>In withdrawal</PanelLabel>
                <SaleAmount testID={'wallet-withdrawing-' + active.id} receipt>{cashuAmount(active.amount, group.unit)}</SaleAmount>
                <Body>
                  {active.pending
                    ? 'The mint is processing the payment.'
                    : 'Anyone with this token can redeem it. Open it in your own Cashu wallet.'}
                </Body>
                {group.available > 0 && <Body tone="muted">Redeem this token before starting another withdrawal from this mint.</Body>}
                {!active.pending ? (
                  <Button
                    label="Show withdrawal token"
                    accessibilityLabel={'Show ' + cashuAmount(active.amount, group.unit) + ' withdrawal token from ' + group.mint}
                    testID={'wallet-share-' + active.id}
                    disabled={busy}
                    onPress={() => {
                      void act(async () => {
                        if (!lifetime.current) return '';
                        return revealToken(gate, lifetime.current.signal,
                          () => service.withdrawalToken(active.id),
                          token => setShown({ title: cashuAmount(active.amount, group.unit) + ' withdrawal', mint: group.mint, token }),
                        );
                      });
                    }}
                  />
                ) : null}
                <Button
                  label="Check redemption"
                  accessibilityLabel={'Check redemption of ' + cashuAmount(active.amount, group.unit) + ' from ' + group.mint}
                  testID={'wallet-check-' + active.id}
                  disabled={busy}
                  kind="plain"
                  onPress={() => {
                    void act(async () => {
                      const result = await service.checkWithdrawal(active.id);
                      if (!result.amount) return 'The mint confirmed redemption.';
                      if (result.pending) return 'The mint is processing the payment. Check again shortly.';
                      if (result.amount < active.amount)
                        return 'Part redeemed. Share the remaining token with your wallet.';
                      return 'The mint shows the token is still unspent.';
                    });
                  }}
                />
              </>
            ) : (
              <Button
                label="Withdraw as eCash"
                kind={service.lightning && group.unit === 'sat' ? 'plain' : 'primary'}
                accessibilityLabel={'Withdraw as eCash from ' + group.mint + ', ' + cashuAmount(group.available, group.unit) + ' available'}
                testID={'wallet-prepare-' + key}
                disabled={busy || group.available <= 0}
                onPress={() => { setRefreshId(null); setReview(group); }}
              />
            )}
          </MerchantPanel>
        );
      })}
      {refreshId !== null && !busy && <WalletRefreshed key={refreshId} />}
      <Button
        label="Refresh"
        testID="wallet-refresh"
        kind="plain"
        disabled={busy}
        onPress={() => {
          void act();
        }}
      />
    </Screen>
  );
  return renderOverview && !busy ? renderOverview(page) : page;
}
