/* The sale's results, in words that never overstate what the card did: PAID only for a payment the till holds, CHECKING
 * while the mint has not finished, and never NOT PAID for anything the card signed. The withdraw question and the two
 * withdraw screens are here too. Nothing here shows a PIN, a token, a proof or a key. */

import React from 'react';
import type { Payment } from 'cashucard';
import type { AfterScanSheet } from '../till/scan-sheet';
import { paymentFigures } from '../till/payment-words';
import type { SaleState } from '../till/sale-machine';
import { hostOf, sats } from '../format';
import { SaleStage, SaleSurface } from './SalePresentation';
import { Body, Button, Gap, Screen } from '../ui/kit';
import type { Send } from './SalePanels';

export const RESULT_WORDS = {
  paid: 'PAID',
  checking: 'CHECKING',
  checkingBody:
    'The card has paid. The till is checking the payment with the mint. Do not hand over the goods until it shows PAID.',
  alreadyPaid: 'ALREADY PAID',
  alreadyPaidBody:
    "This sale was already paid. This card's payment goes back to the card at its next tap. Do not take another payment for this sale.",
  alreadyLate: 'ALREADY WITHDRAWN',
  alreadyLateBody:
    "This sale was withdrawn before this card's payment arrived. It goes back to the card at its next tap. Do not take another payment for this sale.",
  tapAgain: 'TAP THE SAME CARD AGAIN',
  tapAgainBody:
    'The card started paying and did not finish. Hold the same card to the phone again to finish it. Do not take another payment for this sale yet.',
  unfinished: 'TAP AGAIN',
  unfinishedBody: 'An earlier payment of this card was finished first. Hold the card again to pay this sale.',
  notPaid: 'NOT PAID',
  notPaidYet: 'NOT PAID YET',
  notPaidYetBody:
    'The card signed, but the mint has not paid this payment. The till keeps it and asks the mint again. Do not hand over the goods.',
  stop: 'STOP',
  stopBody: 'The till could not keep its record. Do not take more payments. Close the app and open it again.',
  withdrawn: 'SALE WITHDRAWN',
  withdrawnBody:
    'Nothing more is taken for this sale. If the card finished paying, its money goes back to it at its next tap.',
  withdrawTitle: 'Withdraw the sale',
  withdrawCard: 'Withdraw this sale? If the card finished paying, its money goes back to the card at its next tap.',
  withdrawMint:
    "Withdraw this sale? If the mint takes the card's payment later, it goes back to the card at its next tap.",
  withdrawYes: 'Withdraw the sale',
  withdrawNoCard: 'Keep waiting for the card',
  withdrawNoMint: 'Keep the sale open',
  withdrawing: 'Withdrawing the sale.',
  holdAgain: 'Hold the card again',
  tryAgain: 'Try again',
  otherWay: 'The customer paid another way',
  activity: 'See it in Activity',
  newSale: 'New sale',
} as const;

/** "The card paid the mint's fee of 1 sat." */
export function feeWords(fee: number): string {
  return "The card paid the mint's fee of " + sats(fee) + '.';
}

/** 'A card payment of 14 sats was already taken for this sale. The customer has paid twice: give back their other payment.' */
export function paidTwiceWords(total: number): string {
  return (
    'A card payment of ' +
    sats(total) +
    ' was already taken for this sale. The customer has paid twice: give back their other payment.'
  );
}

type ResultState = Extract<SaleState, { kind: 'result' }>;
type ResultOutcome = ResultState['outcome'];
type ShownOutcome = Exclude<ResultOutcome, { kind: 'withdraw-asked' } | { kind: 'withdrawing' }>;

/** The headline's tone: good only where the goods may be handed over (PAID, and a sale already paid), bad where
 * nothing came for the sale or the till must stop (NOT PAID, NOT PAID YET, STOP), and plain where the merchant waits or
 * acts (CHECKING, TAP THE SAME CARD AGAIN, TAP AGAIN, SALE WITHDRAWN, ALREADY WITHDRAWN). The words always say it too. */
export function resultTone(o: ShownOutcome): 'normal' | 'good' | 'bad' {
  switch (o.kind) {
    case 'wallet-paid':
    case 'paid':
      return 'good';
    case 'already-paid':
      return o.extra === 'paid-twice' ? 'good' : 'normal';
    case 'offline-loss':
    case 'not-paid':
    case 'not-paid-yet':
    case 'stop':
      return 'bad';
    case 'lightning-extra':
    case 'lightning-processing':
    case 'checking':
    case 'saved-offline':
    case 'tap-again':
    case 'unfinished':
    case 'withdrawn':
      return 'normal';
  }
}

function titleOf(o: ShownOutcome): string {
  switch (o.kind) {
    case 'wallet-paid':
    case 'paid':
      return RESULT_WORDS.paid;
    case 'lightning-extra':
      return 'Customer return';
    case 'lightning-processing':
      return 'Confirming Lightning payment';
    case 'offline-loss':
      return 'Offline payment lost';
    case 'saved-offline':
      return 'Saved offline';
    case 'checking':
      return RESULT_WORDS.checking;
    case 'already-paid':
      return o.extra === 'paid-twice' ? RESULT_WORDS.alreadyPaid : RESULT_WORDS.alreadyLate;
    case 'tap-again':
      return RESULT_WORDS.tapAgain;
    case 'unfinished':
      return RESULT_WORDS.unfinished;
    case 'not-paid':
      return RESULT_WORDS.notPaid;
    case 'not-paid-yet':
      return RESULT_WORDS.notPaidYet;
    case 'stop':
      return RESULT_WORDS.stop;
    case 'withdrawn':
      return RESULT_WORDS.withdrawn;
  }
}

/** The library's message under the title, when it has one; muted: it is the library's, not the till's own line. */
function messageLine(message: string): React.JSX.Element | null {
  if (message === '') return null;
  return (
    <Body testID="result-message" tone="muted">
      {message}
    </Body>
  );
}

export function ResultPanel(p: { state: ResultState; send: Send; onActivity: () => void; onReturn?: () => void; afterScanSheet?: AfterScanSheet }): React.JSX.Element {
  const o = p.state.outcome;
  const note =
    p.state.note !== null ? (
      <Body testID="result-note" tone="bad">
        {p.state.note}
      </Body>
    ) : null;

  if (o.kind === 'withdraw-asked') {
    return (
      <Screen title={RESULT_WORDS.withdrawTitle} titleID="withdraw-title">
        <Body testID="withdraw-warning">
          {o.back.kind === 'tap-again' ? RESULT_WORDS.withdrawCard : RESULT_WORDS.withdrawMint}
        </Body>
        <Button
          testID="withdraw-no"
          label={o.back.kind === 'tap-again' ? RESULT_WORDS.withdrawNoCard : RESULT_WORDS.withdrawNoMint}
          kind="plain"
          onPress={() => p.send({ type: 'withdraw-no' })}
        />
        <Gap />
        <Button
          testID="withdraw-yes"
          label={RESULT_WORDS.withdrawYes}
          kind="danger"
          onPress={() => p.send({ type: 'withdraw-yes' })}
        />
        {note}
      </Screen>
    );
  }
  if (o.kind === 'withdrawing') {
    return (
      <Screen title={RESULT_WORDS.withdrawTitle} titleID="withdraw-title">
        <Body testID="withdraw-wait">{RESULT_WORDS.withdrawing}</Body>
        {note}
      </Screen>
    );
  }

  const newButton = <Button testID="result-new" label={RESULT_WORDS.newSale} onPress={() => p.send({ type: 'new' })} />;
  const otherWayButton = (
    <Button
      testID="result-other-way"
      label={RESULT_WORDS.otherWay}
      kind="plain"
      onPress={() => p.send({ type: 'other-way' })}
    />
  );

  let detail: React.ReactNode;
  let actions: React.ReactNode;
  let signal: React.ComponentProps<typeof SaleStage>['signal'];
  switch (o.kind) {
    case 'wallet-paid':
      signal = 'paid';
      detail = <Body testID="result-body">{'Paid with ' + o.rail + '.'}</Body>;
      actions = <>{newButton}<Button testID="result-activity" label="View activity" kind="plain" onPress={p.onActivity} /></>;
      break;
    case 'lightning-processing':
      signal = 'busy';
      detail = <Body testID="result-body">The invoice was paid. The till is collecting the payment from the mint.</Body>;
      actions = <><Button testID="result-activity" label="View activity" onPress={p.onActivity} />{newButton}</>;
      break;
    case 'lightning-extra':
      signal = 'attention';
      detail = <Body testID="result-body">The Lightning payment arrived after the sale closed. Return it to the customer who paid.</Body>;
      actions = <>{p.onReturn && <Button testID="result-return" label="Open Owed to Cards" onPress={p.onReturn} />}
        <Button testID="result-activity" label="View activity" kind="plain" onPress={p.onActivity} />{newButton}</>;
      break;
    case 'paid':
      signal = 'paid';
      detail = (
        <SaleSurface>
          {o.payment.fee > 0 ? <Body testID="result-fee">{feeWords(o.payment.fee)}</Body> : null}
          {paymentFigures(o.payment).map((f) => (
            <Body key={f.id} testID={'result-' + f.id}>
              {f.words}
            </Body>
          ))}
          {o.payment.owedToCard > o.payment.unproved ? (
            <Body testID="result-collect-change">To collect your change, bring this card and its PIN back to this till. Choose Owed to Cards.</Body>
          ) : null}
          <Body testID="result-mint" tone="muted">
            {hostOf(o.payment.mint)}
          </Body>
        </SaleSurface>
      );
      actions = (
        <>
          {newButton}
          <Button testID="result-activity" label="View activity" kind="plain" onPress={p.onActivity} />
        </>
      );
      break;
    case 'offline-loss':
    case 'saved-offline':
      signal = o.kind === 'offline-loss' ? 'declined' : 'saved';
      detail = <Body testID="result-body">{o.kind === 'offline-loss'
        ? 'The mint says these notes were spent elsewhere. This sale added nothing to Wallet.'
        : 'Saved on this phone. The till will check the payment with the mint when you reconnect.'}</Body>;
      actions = <>{newButton}<Button testID="result-activity" label="View activity" kind="plain" onPress={p.onActivity} /></>;
      break;
    case 'checking':
      signal = 'busy';
      detail = (
        <>
          <Body testID="result-body">{RESULT_WORDS.checkingBody}</Body>
          {messageLine(o.message)}
        </>
      );
      actions = (
        <>
          <Button testID="result-activity" label={RESULT_WORDS.activity} kind="plain" onPress={p.onActivity} />
          {otherWayButton}
          {newButton}
        </>
      );
      break;
    case 'already-paid':
      signal = 'attention';
      detail = (
        <Body testID="result-body">
          {o.extra === 'paid-twice' ? RESULT_WORDS.alreadyPaidBody : RESULT_WORDS.alreadyLateBody}
        </Body>
      );
      actions = newButton;
      break;
    case 'tap-again':
    case 'unfinished':
      signal = 'card';
      detail = (
        <>
          <Body testID="result-body">
            {o.kind === 'tap-again' ? RESULT_WORDS.tapAgainBody : RESULT_WORDS.unfinishedBody}
          </Body>
          {o.kind === 'tap-again' && messageLine(o.message)}
        </>
      );
      actions = (
        <>
          <Button testID="result-retry" label={RESULT_WORDS.holdAgain} onPress={() => p.send({ type: 'retry' })} />
          {o.kind === 'tap-again' ? otherWayButton : newButton}
        </>
      );
      break;
    case 'not-paid':
      signal = 'declined';
      detail = (
        <>
          <Body testID="result-kind">{o.title}</Body>
          <Body testID="result-message">{o.message}</Body>
        </>
      );
      actions = (
        <>
          {o.ended ? null : (
            <Button testID="result-retry" label={RESULT_WORDS.tryAgain} onPress={() => p.send({ type: 'retry' })} />
          )}
          {newButton}
        </>
      );
      break;
    case 'not-paid-yet':
      signal = 'attention';
      detail = (
        <>
          <Body testID="result-body">{RESULT_WORDS.notPaidYetBody}</Body>
          {messageLine(o.message)}
        </>
      );
      actions = (
        <>
          {otherWayButton}
          {newButton}
        </>
      );
      break;
    case 'stop':
      signal = 'declined';
      detail = (
        <>
          <Body testID="result-body" tone="bad">
            {RESULT_WORDS.stopBody}
          </Body>
          {messageLine(o.message)}
        </>
      );
      break;
    case 'withdrawn':
      signal = 'cancelled';
      detail = (
        <>
          <Body testID="result-body">{RESULT_WORDS.withdrawnBody}</Body>
          {o.paidBefore.length > 0 ? (
            <Body testID="result-paid-twice" tone="bad">
              {paidTwiceWords(o.paidBefore.reduce((sum: number, q: Payment) => sum + q.amount, 0))}
            </Body>
          ) : null}
        </>
      );
      actions = newButton;
      break;
  }
  return (
    <SaleStage
      title={titleOf(o)}
      titleID="result-title"
      resultTone={resultTone(o)}
      signal={signal}
      afterScanSheet={o.kind === 'paid' ? p.afterScanSheet : undefined}
      receiptKey={o.kind === 'paid' ? o.payment.paymentId : o.kind === 'wallet-paid' ? p.state.saleId ?? undefined : undefined}
      amount={sats(o.kind === 'paid' ? o.payment.amount : p.state.sats)}
      amountID="result-amount"
    >
      {detail}
      {actions}
      {note}
    </SaleStage>
  );
}
