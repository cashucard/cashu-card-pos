import React from 'react';
import { PrivacyPolicyLink } from './PrivacyPolicyLink';
import { Body, Button, Gap, Screen } from '../ui/kit';

export const FIRSTRUN_LOST =
  "The till's list of mints could not be read. Add your mints again. The payment record has not been changed.";

export const FIRSTRUN_USED =
  'This till has been opened before and has no mint on its list. If it had mints and you did not remove them, the list was lost: add them again. The payment record has not been changed.';

export interface FirstRunProps {
  preset: string | null;
  /** the till's list of mints could not be read at this launch */
  listLost?: boolean;
  /** the till's payment record has been opened before, yet its list of mints is empty */
  used?: boolean;
  onAdd: (preset: string | null) => void;
  onRestore?: () => void;
  onOpenTill?: () => void;
}

/** The Welcome at first run: add the mint whose cards this till takes. */
export function FirstRunScreen(p: FirstRunProps): React.JSX.Element {
  return (
    <Screen title="Set up your till" titleID="firstrun-title">
      <Body testID="firstrun-body">
        {
          'Add the mint your customers use. The till checks it before you accept your first payment.'
        }
      </Body>
      {p.listLost === true ? (
        <Body testID="firstrun-note" tone="bad">
          {FIRSTRUN_LOST}
        </Body>
      ) : p.used === true ? (
        <Body testID="firstrun-note">{FIRSTRUN_USED}</Body>
      ) : null}
      <Button testID="firstrun-add" label="Add a mint" onPress={() => p.onAdd(null)} />
      {p.onRestore && <Button testID="firstrun-restore" label="Restore a backup"
        kind="plain" onPress={p.onRestore} />}
      {(p.used || p.listLost) && p.onOpenTill && <Button testID="firstrun-open" label="Open existing till"
        kind="plain" onPress={p.onOpenTill} />}
      {p.preset !== null ? (
        <>
          <Gap />
          <Body testID="firstrun-dev" tone="muted">
            {'Development build: a test mint is ready to add.'}
          </Body>
          <Button
            testID="firstrun-dev-mint"
            label="Add the test mint"
            kind="plain"
            onPress={() => p.onAdd(p.preset)}
          />
        </>
      ) : null}
      <PrivacyPolicyLink />
    </Screen>
  );
}
