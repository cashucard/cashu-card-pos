import React, { useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import {
  addMintStart,
  addMintStep,
  lineWords,
  resultWords,
  type AddMintEffect,
  type AddMintEvent,
  type AddMintState,
} from '../app/add-mint';
import type { DeviceGate } from '../till/gate';
import { gateResultOf, guarded } from '../till/guarded';
import type { MintCheckReport } from '../till/mint-check';
import type { TillService } from '../till/service';
import { Body, Button, Field, Screen } from '../ui/kit';

export interface AddMintProps {
  service: Pick<TillService, 'checkMint' | 'addMint'>;
  gate: DeviceGate;
  /** told the outcome of the owner check this screen asks */
  onGate?: (outcome: 'passed' | 'refused') => void;
  preset: string | null;
  /** once the mint is added */
  onDone: () => void;
  onBack: () => void;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Adding a mint: type its address, see every line of its check, then add it once the device check passed. */
export function AddMintScreen(p: AddMintProps): React.JSX.Element {
  const [state, setState] = useState<AddMintState>(() => addMintStart(p.preset));
  const current = useRef<AddMintState>(state);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  function run(effect: AddMintEffect): void {
    if (effect.kind === 'check') {
      p.service.checkMint(effect.text).then(
        (report) => {
          if (live.current) {
            dispatch({ type: 'report', report });
          }
        },
        (e: unknown) => {
          if (live.current) {
            dispatch({ type: 'check-failed', why: 'The check did not run: ' + msg(e) });
          }
        },
      );
    } else if (effect.kind === 'gate') {
      void guarded(p.gate, 'mints', async () => undefined).then((g) => {
        if (live.current) {
          if (p.onGate !== undefined) {
            p.onGate(g.ok ? 'passed' : 'refused');
          }
          dispatch({ type: 'gate', result: gateResultOf(g) });
        }
      });
    } else {
      p.service.addMint(effect.report).then(
        () => {
          if (live.current) {
            dispatch({ type: 'added' });
          }
        },
        (e: unknown) => {
          if (live.current) {
            dispatch({ type: 'add-failed', why: 'The mint was not added: ' + msg(e) });
          }
        },
      );
    }
  }

  function dispatch(e: AddMintEvent): void {
    const step = addMintStep(current.current, e);
    current.current = step.state;
    setState(step.state);
    if (step.effect !== null) {
      run(step.effect);
    }
  }

  const added = state.kind === 'added';
  useEffect(() => {
    if (added) {
      p.onDone();
    }
  }, [added]);

  const text = state.kind === 'added' ? '' : state.text;
  const busy = state.kind === 'checking' || state.kind === 'adding';
  let report: MintCheckReport | null = null;
  if (state.kind === 'checked' || state.kind === 'adding') {
    report = state.report;
  }
  const note = state.kind === 'editing' || state.kind === 'checked' ? state.note : null;

  return (
    <Screen title="Add a mint" titleID="addmint-title" onBack={p.onBack}>
      <Body testID="addmint-body">{"Type the mint's address. It must start with https."}</Body>
      <Field
        testID="addmint-url"
        value={text}
        onChangeText={(t) => dispatch({ type: 'type', text: t })}
        placeholder="https://mint.example.com"
        url
      />
      <Button
        testID="addmint-check"
        label="Check this mint"
        disabled={busy}
        onPress={() => {
          // the keyboard goes: it covered the check's lines and Add this mint under them (ENG-911)
          Keyboard.dismiss();
          dispatch({ type: 'check' });
        }}
      />
      {state.kind === 'checking' ? (
        <Body testID="addmint-checking" tone="muted">
          Checking the mint.
        </Body>
      ) : null}
      {report !== null
        ? report.lines.map((line) => (
            <Body
              key={line.id}
              testID={'addmint-line-' + line.id}
              tone={line.ok ? 'good' : 'bad'}
            >
              {lineWords(line)}
            </Body>
          ))
        : null}
      {report !== null ? (
        <Body testID="addmint-result" tone={report.ok ? 'good' : 'bad'}>
          {resultWords(report)}
        </Body>
      ) : null}
      {report !== null && report.ok ? (
        <Body tone="muted">This phone will also prepare offline payments. The mint settles them when you reconnect. You can turn them off in Settings.</Body>
      ) : null}
      {report !== null && report.ok ? (
        <Button
          testID="addmint-add"
          label="Add this mint"
          disabled={state.kind === 'adding'}
          onPress={() => dispatch({ type: 'add' })}
        />
      ) : null}
      {state.kind === 'adding' ? (
        <Body testID="addmint-adding" tone="muted">
          Adding the mint.
        </Body>
      ) : null}
      {note !== null ? (
        <Body testID="addmint-note" tone="bad">
          {note}
        </Body>
      ) : null}
      {state.kind === 'added' ? (
        <Body testID="addmint-added" tone="good">
          The mint was added.
        </Body>
      ) : null}
    </Screen>
  );
}

