import React, { useEffect, useRef, useState } from 'react';
import { dateTime, hostOf } from '../format';
import type { DeviceGate } from '../till/gate';
import { guarded } from '../till/guarded';
import { MintInUseError, type RecheckNote, type TillService } from '../till/service';
import type { MintEntry } from '../till/settings';
import { Body, Button, Screen } from '../ui/kit';

export interface MintsProps {
  service: Pick<TillService, 'mints' | 'removeMint' | 'recheckMints'> & Partial<Pick<TillService, 'removalOf'>>;
  gate: DeviceGate;
  /** the mints the service holds now; when given, the list shown follows it */
  mints?: MintEntry[];
  /** told the outcome of each owner check this screen asks */
  onGate?: (outcome: 'passed' | 'refused') => void;
  /** the service's note of its last check-again pass */
  lastRecheck?: () => RecheckNote | null;
  onAdd: () => void;
  onBack: () => void;
}

/** How a mint on the list stands, in the merchant's words. */
export function mintStatusWords(m: MintEntry): string {
  if (m.status === 'ok') {
    return 'Taking cards from this mint. Checked ' + dateTime(m.checkedAt) + '.';
  }
  return (
    'Not taking cards from this mint: ' +
    (m.why ?? 'it did not pass its check.') +
    ' Check it again once the mint has fixed it.'
  );
}

export const MINTS_WORDS = {
  inUse:
    'Money is still owed to cards from this mint. Open Owed to cards and scan the original cards to return their change. The mint can be removed once nothing is owed.',
  topup: 'Finish the outstanding card top-up before removing this mint.',
  unfinished:
    "A card payment from this mint is not finished yet. The till finishes it with the mint, or at that card's next tap, and it may then owe the card its change. The mint can be removed once it is finished.",
  late:
    'Some card payments are still waiting for this mint. If one finishes after you remove the mint, Home will show any change due. Use Owed to cards to return it.',
  unproved:
    'Some change owed to cards from this mint was never proved by the mint. This version of the till cannot give that change back, whether it takes this mint or not.',
} as const;

/** The same list as far as the merchant can see: each mint's address, standing, reason, keysets and when checked. */
function sameList(a: readonly MintEntry[], b: readonly MintEntry[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.url !== y.url ||
      x.status !== y.status ||
      x.why !== y.why ||
      x.checkedAt !== y.checkedAt ||
      x.keysets.join(',') !== y.keysets.join(',')
    ) {
      return false;
    }
  }
  return true;
}

/** What a check-again found, in the merchant's words. */
export function recheckWords(before: readonly MintEntry[], after: readonly MintEntry[], note: RecheckNote): string {
  let out = 'Checked all again on ' + dateTime(note.at) + '.';
  if (note.unreached.length === 0) {
    out += sameList(before, after) ? ' Nothing has changed.' : ' The list shows what it found.';
    return out;
  }
  for (const url of note.unreached) {
    out += ' ' + hostOf(url) + ' did not answer, so it is left as it was.';
  }
  return out;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The mints the till takes: each one's standing, removing one behind a warning and the device check, and checking
 * them all again. */
export function MintsScreen(p: MintsProps): React.JSX.Element {
  const [mints, setMints] = useState<MintEntry[]>(() => p.mints ?? p.service.mints());
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  /** the removal question's warnings for the mint asked about */
  const [risk, setRisk] = useState<string[]>([]);
  /** questions asked so far: only the last one's warnings are shown */
  const asks = useRef(0);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // the service's list, whenever it changes (a check-again that finished elsewhere, the launch's)
  useEffect(() => {
    if (p.mints !== undefined) {
      setMints(p.mints);
    }
  }, [p.mints]);

  async function remove(url: string): Promise<void> {
    setBusy(true);
    setChecked(null);
    try {
      const g = await guarded(p.gate, 'mints', async () => undefined);
      if (!live.current) {
        return;
      }
      if (p.onGate !== undefined) {
        p.onGate(g.ok ? 'passed' : 'refused');
      }
      if (!g.ok) {
        setNote(g.words);
        return;
      }
      await p.service.removeMint(url);
      if (!live.current) {
        return;
      }
      setMints(p.service.mints());
      setConfirm(null);
    } catch (e) {
      if (!live.current) {
        return;
      }
      if (e instanceof MintInUseError) {
        setNote(e.why === 'owed' ? MINTS_WORDS.inUse : MINTS_WORDS[e.why]);
      } else {
        setNote('The mint was not removed: ' + msg(e));
      }
    } finally {
      if (live.current) {
        setBusy(false);
      }
    }
  }

  /** The removal question's warnings for that mint: what may be left owed if it is removed (none when nothing). */
  async function askRisk(url: string): Promise<void> {
    asks.current += 1;
    const mine = asks.current;
    setRisk([]);
    if (p.service.removalOf === undefined) {
      return;
    }
    try {
      const r = await p.service.removalOf(url);
      if (!live.current || mine !== asks.current) {
        return;
      }
      const words: string[] = [];
      if (r.late) {
        words.push(MINTS_WORDS.late);
      }
      if (r.unproved) {
        words.push(MINTS_WORDS.unproved);
      }
      setRisk(words);
    } catch {
      // no warning can be read now: the removal itself still checks the record
    }
  }

  async function recheck(): Promise<void> {
    setBusy(true);
    setNote(null);
    setChecked(null);
    const before = mints;
    try {
      const list = await p.service.recheckMints();
      if (live.current) {
        setMints(list);
        const last = p.lastRecheck === undefined ? null : p.lastRecheck();
        setChecked(last === null ? null : recheckWords(before, list, last));
      }
    } catch (e) {
      if (live.current) {
        setNote('The check did not finish: ' + msg(e));
      }
    } finally {
      if (live.current) {
        setBusy(false);
      }
    }
  }

  const warning = confirm === null ? null : mints.find((m) => m.url === confirm) ?? null;

  return (
    <Screen title="Mints" titleID="mints-title" onBack={p.onBack}>
      <Body testID="mints-body">The till takes cards from these mints only.</Body>
      {mints.length === 0 ? (
        <Body testID="mints-empty" tone="muted">
          No mint yet. Add the mint your customers use.
        </Body>
      ) : null}
      {mints.map((m, i) => (
        <React.Fragment key={m.url}>
          <Body testID={'mint-row-' + i}>{m.url}</Body>
          <Body testID={'mint-status-' + i} tone={m.status === 'ok' ? 'good' : 'bad'}>
            {mintStatusWords(m)}
          </Body>
          <Button
            testID={'mint-remove-' + i}
            label="Stop taking this mint"
            kind="danger"
            disabled={busy}
            onPress={() => {
              setConfirm(m.url);
              setNote(null);
              void askRisk(m.url);
            }}
          />
        </React.Fragment>
      ))}
      {warning !== null ? (
        <React.Fragment>
          <Body testID="mint-remove-warning">
            {'Stop taking cards from ' +
              warning.url +
              '? Payments already taken from it stay in the record.'}
          </Body>
          {risk.map((w, i) => (
            <Body key={'risk-' + i} testID={'mint-remove-risk-' + i} tone="bad">
              {w}
            </Body>
          ))}
          <Button
            testID="mint-remove-yes"
            label="Stop taking it"
            kind="danger"
            disabled={busy}
            onPress={() => {
              void remove(warning.url);
            }}
          />
          <Button
            testID="mint-remove-no"
            label="Keep it"
            kind="plain"
            onPress={() => setConfirm(null)}
          />
        </React.Fragment>
      ) : null}
      {checked !== null ? (
        <Body testID="mints-checked" tone="muted">
          {checked}
        </Body>
      ) : null}
      {note !== null ? (
        <Body testID="mints-note" tone="bad">
          {note}
        </Body>
      ) : null}
      <Button testID="mints-add" label="Add a mint" onPress={p.onAdd} />
      <Button
        testID="mints-recheck"
        label="Check all again"
        kind="plain"
        disabled={busy}
        onPress={() => {
          void recheck();
        }}
      />
    </Screen>
  );
}

