import React from 'react';
import type { ChoiceOffer } from '../app/boot';
import { confirmAsk, phraseTyped } from '../app/boot';
import type { OfferId, StoreMessage } from '../till/store/messages';
import { Body, Button, Field, Screen } from '../ui/kit';

/** While the till opens. */
export function OpeningScreen(): React.JSX.Element {
  return (
    <Screen title="Cashu Card POS" titleID="boot-title">
      <Body testID="boot-opening">Opening the till.</Body>
    </Screen>
  );
}

export interface StoreProblemProps {
  message: StoreMessage;
  note: string | null;
  onOffer: (id: OfferId) => void;
}

/** A state the till cannot open in, in the store's own words, with the offers it makes. */
export function StoreProblemScreen(p: StoreProblemProps): React.JSX.Element {
  return (
    <Screen title={p.message.title} titleID="store-title">
      <Body testID="store-body">{p.message.body}</Body>
      {p.note !== null ? (
        <Body testID="store-note" tone="bad">
          {p.note}
        </Body>
      ) : null}
      {p.message.offers.map((o) => (
        <Button
          key={o.id}
          testID={'store-offer-' + o.id}
          label={o.label}
          kind={o.guarded ? 'danger' : o.id === 'not-now' ? 'plain' : 'primary'}
          onPress={() => p.onOffer(o.id)}
        />
      ))}
      {p.message.notOffered.map((line, i) => (
        <Body key={'not-offered-' + i} testID={i === 0 ? 'store-not-offered' : 'store-not-offered-' + i} tone="muted">
          {i === 0 ? 'Not offered: ' + line : line}
        </Body>
      ))}
    </Screen>
  );
}

export interface ConfirmProps {
  offer: ChoiceOffer;
  typed: string;
  note: string | null;
  onType: (t: string) => void;
  onGo: () => void;
  onBack: () => void;
}

/** The typed phrase that must come before the device check. */
export function ConfirmScreen(p: ConfirmProps): React.JSX.Element {
  return (
    <Screen title={p.offer.label} titleID="confirm-title" onBack={p.onBack}>
      <Body testID="confirm-warning">{p.offer.warning ?? ''}</Body>
      <Body testID="confirm-ask">{confirmAsk(p.offer.id)}</Body>
      <Field testID="confirm-input" value={p.typed} onChangeText={p.onType} />
      {p.note !== null ? (
        <Body testID="confirm-error" tone="bad">
          {p.note}
        </Body>
      ) : null}
      <Button
        testID="confirm-go"
        label={p.offer.label}
        kind="danger"
        disabled={!phraseTyped(p.offer.id, p.typed)}
        onPress={p.onGo}
      />
    </Screen>
  );
}

export interface GateWaitProps {
  offer: ChoiceOffer;
}

/** While the phone asks the merchant to confirm it is them. */
export function GateWaitScreen(p: GateWaitProps): React.JSX.Element {
  return (
    <Screen title={p.offer.label} titleID="gate-title">
      <Body testID="gate-wait">Confirm on the phone that it is you.</Body>
    </Screen>
  );
}

/** The Closed screen's words: for a record made by a newer version, or storage that is not safe, nothing is chosen. */
export const CLOSED_WORDS: Readonly<Record<'choose' | 'newer-format' | 'store-refused', { body: string; again: string }>> = {
  choose: {
    body: 'It takes no payments until you choose what to do with its payment record. Nothing has been changed.',
    again: 'Choose now',
  },
  'newer-format': {
    body:
      'It takes no payments until the newer version of the app that made its record is installed. Nothing has been changed.',
    again: 'Check again',
  },
  'store-refused': {
    body: "It takes no payments while this phone's storage cannot keep its record safely. Nothing has been changed.",
    again: 'Check again',
  },
};

export interface ClosedProps {
  /** the store's state the merchant said Not now to; absent: the words for a choice */
  state?: StoreMessage['state'];
  onAgain: () => void;
}

/** The till closed because nothing was chosen. */
export function ClosedScreen(p: ClosedProps): React.JSX.Element {
  const words =
    p.state === 'newer-format' || p.state === 'store-refused' ? CLOSED_WORDS[p.state] : CLOSED_WORDS.choose;
  return (
    <Screen title="The till is closed" titleID="closed-title">
      <Body testID="closed-body">{words.body}</Body>
      <Button testID="closed-again" label={words.again} onPress={p.onAgain} />
    </Screen>
  );
}

export interface FailedProps {
  why: string;
  onAgain: () => void;
}

/** The till could not start at all. */
export function FailedScreen(p: FailedProps): React.JSX.Element {
  return (
    <Screen title="The till could not start" titleID="failed-title">
      <Body testID="failed-why">{p.why}</Body>
      <Body testID="failed-help" tone="muted">
        {'Try again. If it happens again, the details help support.'}
      </Body>
      <Button testID="failed-again" label="Try again" onPress={p.onAgain} />
    </Screen>
  );
}
