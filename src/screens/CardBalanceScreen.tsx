import React, { useEffect, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { CardError } from 'cashucard';
import { cashuAmount } from '../format';
import { scanCardBalance, type CardBalance } from '../till/card-balance';
import { CARD_ERROR_TITLES } from '../till/card-errors';
import type { CardReader } from '../till/reader';
import type { TillService } from '../till/service';
import { findMint } from '../till/settings';
import { Body, Button, Screen } from '../ui/kit';
import { SaleStage } from './SalePresentation';
import { NfcStage } from './NfcStage';

type State = { kind: 'waiting' | 'reading' | 'paused' } | { kind: 'error'; words: string } | { kind: 'done'; balance: CardBalance };

interface Props {
  service: Pick<TillService, 'withCard' | 'mints'>;
  reader: CardReader;
  onBack(): void;
  onCharge?(): void;
  onTopUp(balance: CardBalance): void;
}

export function CardBalanceScreen({ service, reader, onBack, onTopUp, onCharge }: Props): React.JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ kind: 'waiting' });
  useEffect(() => reader.enterSaleScreen?.(), [reader]);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const pause = () => {
      controller.abort();
      setState({ kind: 'paused' });
    };
    const listener = AppState.addEventListener('change', value => {
      if (value === 'background') pause();
    });
    if (AppState.currentState === 'background') pause();
    else {
      setState({ kind: 'waiting' });
      void scanCardBalance(service, reader, signal, () => {
        if (!signal.aborted) setState({ kind: 'reading' });
      }).then(balance => {
        if (!signal.aborted) setState({ kind: 'done', balance });
      }, error => {
        if (!signal.aborted) {
          const words = error instanceof CardError ? CARD_ERROR_TITLES[error.kind] : 'Couldn’t read the balance';
          setState({ kind: 'error', words });
        }
      });
    }
    return () => { controller.abort(); listener.remove(); };
  }, [attempt, reader, service]);

  const again = () => setAttempt(n => n + 1);
  if (state.kind === 'waiting' || state.kind === 'reading') {
    const waiting = state.kind === 'waiting';
    return <NfcStage gesture={waiting ? 'tap' : 'hold'} title={waiting ? 'Tap the card' : 'Hold the card still'}
      titleID="balance-scan-title" value="Check balance"
      detail={waiting ? Platform.OS === 'ios' ? 'Hold it at the top of the iPhone.' : 'Hold it against the back of the phone.' : 'Reading the amounts on this card.'}>
      <Button testID="balance-cancel" label="Cancel" kind="plain" onPress={onBack} />
    </NfcStage>;
  }
  if (state.kind !== 'done') {
    return <Screen title={state.kind === 'error' ? state.words : 'Check balance'} titleID="balance-title" onBack={onBack}>
      <Button testID="balance-retry" label="Scan card" onPress={again} />
    </Screen>;
  }
  const { balance } = state;
  const other = balance.unit === 'sat' ? 'usd' : 'sat';
  const accepted = findMint(service.mints(), balance.mint)?.status === 'ok';
  return (
    <SaleStage title="Card balance" titleID="balance-title" signal="paid" afterScanSheet={reader.afterScanSheet}
      amount={cashuAmount(balance.amounts[balance.unit], balance.unit)} amountID="balance-amount"
      description={<>
        {balance.amounts[other] > 0 && <Body testID="balance-other" big>{cashuAmount(balance.amounts[other], other)}</Body>}
        <Body tone="muted">Listed on this card</Body>
        <Body testID="balance-mint" tone="muted">{balance.mint}</Body>
      </>}>
      {(!accepted || balance.unit !== 'sat') && (
        <Body testID="balance-top-up-unavailable" tone="muted">{accepted ? 'This till tops up sat cards.' : 'To top up, use a till that accepts this mint.'}</Body>
      )}
      <View style={styles.actions}>
        {accepted && balance.unit === 'sat' && onCharge && <View style={styles.action}>
          <Button testID="balance-charge" label="Charge card" kind="plain" onPress={onCharge} />
        </View>}
        {accepted && balance.unit === 'sat' && <View style={styles.action}>
          <Button testID="balance-top-up" label="Top up card" onPress={() => onTopUp(balance)} />
        </View>}
      </View>
      <Button testID="balance-done" label="Done" kind="plain" onPress={onBack} />
    </SaleStage>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 10 },
  action: { flexGrow: 1, flexBasis: 134 },
});
