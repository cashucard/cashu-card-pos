/* One payment, in the till's own words (slice 1.4): the payment table's headline, sentence and figures, never softer.
 * Nothing here shows a token, a card's key or an id. */

import React, { useEffect, useRef, useState } from 'react';
import type { Claim, Payment } from 'cashucard';
import { isCustomers, PAYMENT_WORDS } from '../app/activity';
import { dateTime, hostOf, sats } from '../format';
import { cardReference, receiptReference } from '../app/receipt-reference';
import { paymentFigures, paymentTone, paymentWords, WAITING_WORDS, waitingForCard } from '../till/payment-words';
import { nowPaidWords } from '../till/settle';
import { MerchantPanel, PanelLabel } from './MerchantPanel';
import { Body, Screen } from '../ui/kit';

export interface PaymentProps {
  /** the payment's id in the record: read with, never shown */
  paymentId: string;
  reader: {
    payment(paymentId: string): Promise<Payment | null>;
    /** the paymentIds the till told the merchant may be paid twice (from its kept notices) */
    maybePaidTwice(): Promise<string[]>;
    /** the record's open claims: a payment listed as taking that is one of them is waiting for its card */
    openClaims(): Promise<Claim[]>;
    /** whether the payment was archived (slice 2.3); absent: never asked */
    isArchived?(paymentId: string): Promise<boolean>;
  };
  /** l after every settle that ended; answers the unsubscribe */
  onPayments: (l: (changed: Payment[]) => void) => () => void;
  onBack: () => void;
}

type Shown =
  | { kind: 'reading' }
  | { kind: 'shown'; payment: Payment; twice: boolean; stale: boolean; waiting: boolean }
  | { kind: 'missing' }
  | { kind: 'archived' }
  | { kind: 'failed' };

/** "The mint's fee: 1 sat" */
export function feeLine(fee: number): string {
  return PAYMENT_WORDS.feeLead + sats(fee);
}

/** "14 sats · 22 Nov 2026, 04:10": the page's name, above its headline, as the payment's row in the Activity begins */
export function nameLine(x: Payment): string {
  return sats(x.amount) + ' · ' + dateTime(x.at);
}

export function PaymentScreen(p: PaymentProps): React.JSX.Element {
  const [shown, setShown] = useState<Shown>({ kind: 'reading' });
  const shownRef = useRef<Shown>({ kind: 'reading' });
  const props = useRef<PaymentProps>(p);
  props.current = p;
  const seq = useRef(0);
  const alive = useRef(true);

  function put(s: Shown): void {
    shownRef.current = s;
    setShown(s);
  }

  /** One reading; only the newest reading's answer is used. A failure keeps a payment already shown, and says that it
   * may not be the latest; the next reading that answers takes that away. */
  function read(): void {
    seq.current += 1;
    const mine = seq.current;
    const q = props.current;
    const reading = async (): Promise<Shown> => {
      const x = await q.reader.payment(q.paymentId);
      if (x === null) {
        const archived = q.reader.isArchived;
        if (archived !== undefined && (await archived.call(q.reader, q.paymentId))) {
          return { kind: 'archived' };
        }
        return { kind: 'missing' };
      }
      const waiting = x.state === 'taking' && waitingForCard(x, await q.reader.openClaims());
      const twice = await q.reader.maybePaidTwice();
      return { kind: 'shown', payment: x, twice: twice.includes(x.paymentId), stale: false, waiting };
    };
    reading().then(
      (s) => {
        if (!alive.current || mine !== seq.current) {
          return;
        }
        put(s);
      },
      () => {
        if (!alive.current || mine !== seq.current) {
          return;
        }
        const s = shownRef.current;
        if (s.kind === 'shown') {
          put({ kind: 'shown', payment: s.payment, twice: s.twice, stale: true, waiting: s.waiting });
        } else {
          put({ kind: 'failed' });
        }
      },
    );
  }

  useEffect(() => {
    alive.current = true;
    read();
    const off = props.current.onPayments(() => {
      if (alive.current) {
        read();
      }
    });
    return () => {
      alive.current = false;
      off();
    };
  }, []);

  if (shown.kind !== 'shown') {
    const line =
      shown.kind === 'reading'
        ? { id: 'payment-reading', words: PAYMENT_WORDS.reading, tone: 'muted' as const }
        : shown.kind === 'missing'
          ? { id: 'payment-missing', words: PAYMENT_WORDS.missing, tone: 'normal' as const }
          : shown.kind === 'archived'
            ? { id: 'payment-archived', words: PAYMENT_WORDS.archived, tone: 'normal' as const }
            : { id: 'payment-failed', words: PAYMENT_WORDS.failed, tone: 'bad' as const };
    return (
      <Screen title={PAYMENT_WORDS.title} titleID="payment-title" onBack={p.onBack}>
        <Body testID={line.id} tone={line.tone}>
          {line.words}
        </Body>
      </Screen>
    );
  }

  const x = shown.payment;
  // a card payment waiting for its card: never CHECKING, and in the plain tone (the merchant waits for the card, or acts)
  const w = shown.waiting
    ? { headline: WAITING_WORDS.headline, sentence: WAITING_WORDS.sentence, figures: paymentFigures(x) }
    : paymentWords(x);
  return (
    <Screen
      title={w.headline}
      titleID="payment-title"
      headline
      titleTone={shown.twice ? 'bad' : shown.waiting ? 'normal' : paymentTone(x)}
      overline={nameLine(x)}
      overlineID="payment-name"
      onBack={p.onBack}
    >
      {shown.stale ? (
        <Body testID="payment-stale" tone="bad">
          {PAYMENT_WORDS.stale}
        </Body>
      ) : null}
      <MerchantPanel>
        <Body testID="payment-amount" big>
          {sats(x.amount)}
        </Body>
        <Body testID="payment-sentence">{w.sentence}</Body>
        {shown.twice ? (
          <Body testID="payment-twice" tone="bad">
            {nowPaidWords(x.at)}
          </Body>
        ) : null}
        {isCustomers(x) ? <Body testID="payment-customers">{PAYMENT_WORDS.customers}</Body> : null}
        {w.figures.map((f) => (
          <Body key={f.id} testID={'payment-' + f.id}>
            {f.words}
          </Body>
        ))}
      </MerchantPanel>
      <MerchantPanel>
        <PanelLabel>Receipt details</PanelLabel>
        <Body testID="payment-fee" tone="muted">
          {feeLine(x.fee)}
        </Body>
        <Body testID="payment-mint" tone="muted">
          {PAYMENT_WORDS.mintLead + hostOf(x.mint)}
        </Body>
        <Body testID="payment-ref" tone="muted">
          {[receiptReference(x.paymentId), x.cardKey ? cardReference(x.cardKey) : null].filter(Boolean).join(' · ')}
        </Body>
        <Body testID="payment-at" tone="muted">
          {(x.cardKey ? PAYMENT_WORDS.atLead : 'Phone wallet payment of ') + dateTime(x.at)}
        </Body>
      </MerchantPanel>
    </Screen>
  );
}
