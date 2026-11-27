import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import type { ChoiceOffer } from '../src/app/boot';
import {
  ClosedScreen,
  ConfirmScreen,
  FailedScreen,
  GateWaitScreen,
  OpeningScreen,
  StoreProblemScreen,
} from '../src/screens/BootScreens';
import type { StoreChoice, StoreOutcome } from '../src/till/store/open-store';
import { storeMessage, type StoreMessage } from '../src/till/store/messages';
import { Button } from '../src/ui/kit';
import {
  allText,
  has,
  ids,
  isDisabled,
  press,
  textOf,
  typeInto,
} from './helpers/render';

/** The message for an outcome; the test throws when there is none. */
function message(o: StoreOutcome<unknown>): StoreMessage {
  const m = storeMessage(o);
  if (m === null) {
    throw new Error('no message for ' + o.kind);
  }
  return m;
}

/** The offer the message makes under a choice's id. */
function choice(m: StoreMessage, id: StoreChoice): ChoiceOffer {
  const o = m.offers.find((x) => x.id === id);
  if (o === undefined) {
    throw new Error('no offer ' + id);
  }
  return { id, label: o.label, warning: o.warning, guarded: o.guarded };
}

/** The message's offers that need a phrase and a device check. */
function guardedChoices(m: StoreMessage): ChoiceOffer[] {
  return m.offers
    .filter((o) => o.guarded)
    .map((o) => ({ id: o.id as StoreChoice, label: o.label, warning: o.warning, guarded: o.guarded }));
}

const ALL: StoreOutcome<unknown>[] = [
  { kind: 'journal-missing', storedGeneration: 3 },
  { kind: 'rolled-back', journalGeneration: 2, storedGeneration: 5 },
  { kind: 'unreadable', why: 'x' },
  { kind: 'key-missing' },
  { kind: 'secure-store-unavailable', why: 'x' },
  { kind: 'newer-format', version: 2 },
  { kind: 'store-refused', why: 'x' },
  { kind: 'open-failed', why: 'x' },
];

const missing = message(ALL[0]);
const locked = message(ALL[4]);

function render(el: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(el);
  });
  return tree;
}

it('the opening screen says the till is opening', () => {
  const tree = render(<OpeningScreen />);
  expect(textOf(tree, 'boot-title')).toBe('Cashu Card POS');
  expect(textOf(tree, 'boot-opening')).toBe('Opening the till.');
});

it("a missing record shows the store's own title, body and offers", () => {
  const tree = render(<StoreProblemScreen message={missing} note={null} onOffer={jest.fn()} />);
  expect(textOf(tree, 'store-title')).toBe(missing.title);
  expect(textOf(tree, 'store-body')).toBe(missing.body);
  expect(has(tree, 'store-offer-not-now')).toBe(true);
  expect(has(tree, 'store-offer-start-new')).toBe(true);
  expect(has(tree, 'store-offer-use-older')).toBe(false);
  expect(textOf(tree, 'store-not-offered').startsWith('Not offered: Rebuilding the missing payment record')).toBe(true);
  expect(has(tree, 'store-note')).toBe(false);
});

it('pressing an offer names it', async () => {
  const onOffer = jest.fn();
  const tree = render(<StoreProblemScreen message={missing} note={null} onOffer={onOffer} />);
  await press(tree, 'store-offer-start-new');
  expect(onOffer).toHaveBeenCalledTimes(1);
  expect(onOffer).toHaveBeenCalledWith('start-new');
  await press(tree, 'store-offer-not-now');
  expect(onOffer).toHaveBeenCalledWith('not-now');
});

it('a locked secure store offers only to try again', () => {
  const tree = render(<StoreProblemScreen message={locked} note={null} onOffer={jest.fn()} />);
  expect(ids(tree).filter((id) => id.startsWith('store-offer-'))).toEqual([
    'store-offer-try-again',
  ]);
});

it('a refusal of the device check shows as a note', () => {
  const note = 'Not confirmed. Nothing was changed.';
  const tree = render(<StoreProblemScreen message={missing} note={note} onOffer={jest.fn()} />);
  expect(textOf(tree, 'store-note')).toBe(note);
});

it('the confirm button waits for the phrase', async () => {
  const offer = choice(missing, 'start-new');
  const onGo = jest.fn();
  const first = render(
    <ConfirmScreen
      offer={offer}
      typed=""
      note={null}
      onType={jest.fn()}
      onGo={onGo}
      onBack={jest.fn()}
    />,
  );
  expect(isDisabled(first, 'confirm-go')).toBe(true);
  await expect(press(first, 'confirm-go')).rejects.toThrow();
  expect(textOf(first, 'confirm-ask')).toBe('To go on, type START NEW below.');
  expect(textOf(first, 'confirm-warning')).toBe(offer.warning);

  const second = render(
    <ConfirmScreen
      offer={offer}
      typed="start new"
      note={null}
      onType={jest.fn()}
      onGo={onGo}
      onBack={jest.fn()}
    />,
  );
  expect(isDisabled(second, 'confirm-go')).toBe(false);
  await press(second, 'confirm-go');
  expect(onGo).toHaveBeenCalledTimes(1);
});

it('typing is passed on, and back goes back', async () => {
  const onType = jest.fn();
  const onBack = jest.fn();
  const tree = render(
    <ConfirmScreen
      offer={choice(missing, 'start-new')}
      typed=""
      note={null}
      onType={onType}
      onGo={jest.fn()}
      onBack={onBack}
    />,
  );
  await typeInto(tree, 'confirm-input', 'x');
  expect(onType).toHaveBeenCalledWith('x');
  await press(tree, 'nav-back');
  expect(onBack).toHaveBeenCalledTimes(1);
});

it('a refused device check shows on the confirm screen', () => {
  const note = 'Not confirmed. Nothing was changed.';
  const tree = render(
    <ConfirmScreen
      offer={choice(missing, 'start-new')}
      typed=""
      note={note}
      onType={jest.fn()}
      onGo={jest.fn()}
      onBack={jest.fn()}
    />,
  );
  expect(textOf(tree, 'confirm-error')).toBe(note);
});

it('the device check, closed and failed screens', async () => {
  const gate = render(<GateWaitScreen offer={choice(missing, 'start-new')} />);
  expect(textOf(gate, 'gate-wait')).toBe('Confirm on the phone that it is you.');

  const onAgainClosed = jest.fn();
  const closed = render(<ClosedScreen onAgain={onAgainClosed} />);
  expect(textOf(closed, 'closed-title')).toBe('The till is closed');
  await press(closed, 'closed-again');
  expect(onAgainClosed).toHaveBeenCalledTimes(1);

  const onAgainFailed = jest.fn();
  const failed = render(<FailedScreen why="boom" onAgain={onAgainFailed} />);
  expect(textOf(failed, 'failed-why')).toBe('boom');
  await press(failed, 'failed-again');
  expect(onAgainFailed).toHaveBeenCalledTimes(1);
});

it('no launch screen uses a long dash or the word crypto', () => {
  const trees: ReactTestRenderer[] = [render(<OpeningScreen />)];
  for (const o of ALL) {
    const m = message(o);
    trees.push(render(<StoreProblemScreen message={m} note={null} onOffer={jest.fn()} />));
    trees.push(
      render(
        <StoreProblemScreen
          message={m}
          note="Not confirmed. Nothing was changed."
          onOffer={jest.fn()}
        />,
      ),
    );
    for (const offer of guardedChoices(m)) {
      trees.push(
        render(
          <ConfirmScreen
            offer={offer}
            typed=""
            note={null}
            onType={jest.fn()}
            onGo={jest.fn()}
            onBack={jest.fn()}
          />,
        ),
      );
      trees.push(
        render(
          <ConfirmScreen
            offer={offer}
            typed="x"
            note="Not confirmed. Nothing was changed."
            onType={jest.fn()}
            onGo={jest.fn()}
            onBack={jest.fn()}
          />,
        ),
      );
      trees.push(render(<GateWaitScreen offer={offer} />));
    }
    trees.push(render(<ClosedScreen onAgain={jest.fn()} />));
    trees.push(render(<FailedScreen why="boom" onAgain={jest.fn()} />));
  }
  const read: string[] = [];
  for (const tree of trees) {
    for (const text of allText(tree)) {
      read.push(text);
      expect(text).not.toContain('—');
      expect(text).not.toContain('–');
      expect(/crypto/i.test(text)).toBe(false);
    }
  }
  expect(read).toContain('Opening the till.');
  expect(read).toContain('The till is closed');
});

it("the kit's buttons are large and say what they are", () => {
  const tree = render(<Button testID="kit-button" label="Pay" onPress={jest.fn()} />);
  const button = tree.root.findAll(
    (n) => n.props.testID === 'kit-button' && n.props.accessibilityRole === 'button',
  )[0];
  expect(button).toBeDefined();
  for (const pressed of [false, true]) {
    const resolved = typeof button.props.style === 'function' ? button.props.style({pressed}) : button.props.style;
    expect(Number(StyleSheet.flatten(resolved).minHeight)).toBeGreaterThanOrEqual(56);
  }
  expect(button.props.accessibilityRole).toBe('button');
  expect(button.props.accessibilityLabel).toBe('Pay');

  const off = render(<Button testID="kit-disabled" label="Pay" onPress={jest.fn()} disabled />);
  const disabled = off.root.findAll(
    (n) => n.props.testID === 'kit-disabled' && n.props.accessibilityRole === 'button',
  )[0];
  expect(disabled.props.accessibilityState).toEqual({ disabled: true });
});
