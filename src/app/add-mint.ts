import type { GateResult } from '../till/gate';
import type { MintCheckReport } from '../till/mint-check';

export type AddMintState =
  | { kind: 'editing'; text: string; note: string | null }
  | { kind: 'checking'; text: string }
  | { kind: 'checked'; text: string; report: MintCheckReport; note: string | null }
  | { kind: 'adding'; text: string; report: MintCheckReport }
  | { kind: 'added'; url: string };
export type AddMintEvent =
  | { type: 'type'; text: string }
  | { type: 'check' }
  | { type: 'report'; report: MintCheckReport }
  | { type: 'check-failed'; why: string }
  | { type: 'add' }
  | { type: 'gate'; result: GateResult }
  | { type: 'added' }
  | { type: 'add-failed'; why: string };
export type AddMintEffect = { kind: 'check'; text: string } | { kind: 'gate' } | { kind: 'add'; report: MintCheckReport };
export interface AddMintStep { state: AddMintState; effect: AddMintEffect | null }

export const ADD_MINT_WORDS = {
  empty: "Type the mint's address first.",
  usable: 'This mint can be used.',
  unusable: 'This mint cannot be used.',
  unreached: 'The mint did not answer. Check the address, then try again.',
} as const;

/** { kind: 'editing', text: preset ?? '', note: null } */
export function addMintStart(preset: string | null): AddMintState {
  return { kind: 'editing', text: preset ?? '', note: null };
}

/** usable when ok; unreached when not reached; else unusable */
export function resultWords(r: MintCheckReport): string {
  if (r.ok) {
    return ADD_MINT_WORDS.usable;
  }
  if (!r.reached) {
    return ADD_MINT_WORDS.unreached;
  }
  return ADD_MINT_WORDS.unusable;
}

/** 'Passed: ' or 'Failed: ' and the line's words */
export function lineWords(l: { ok: boolean; words: string }): string {
  return (l.ok ? 'Passed: ' : 'Failed: ') + l.words;
}

export function addMintStep(s: AddMintState, e: AddMintEvent): AddMintStep {
  switch (s.kind) {
    case 'editing': {
      if (e.type === 'type') {
        return { state: { kind: 'editing', text: e.text, note: null }, effect: null };
      }
      if (e.type === 'check') {
        if (s.text.trim() === '') {
          return { state: { kind: 'editing', text: s.text, note: ADD_MINT_WORDS.empty }, effect: null };
        }
        return { state: { kind: 'checking', text: s.text }, effect: { kind: 'check', text: s.text } };
      }
      return { state: s, effect: null };
    }
    case 'checking': {
      if (e.type === 'report') {
        return { state: { kind: 'checked', text: s.text, report: e.report, note: null }, effect: null };
      }
      if (e.type === 'check-failed') {
        return { state: { kind: 'editing', text: s.text, note: e.why }, effect: null };
      }
      return { state: s, effect: null };
    }
    case 'checked': {
      if (e.type === 'type') {
        return { state: { kind: 'editing', text: e.text, note: null }, effect: null };
      }
      if (e.type === 'check') {
        return { state: { kind: 'checking', text: s.text }, effect: { kind: 'check', text: s.text } };
      }
      if (e.type === 'add') {
        if (!s.report.ok) {
          return { state: s, effect: null };
        }
        return { state: { kind: 'adding', text: s.text, report: s.report }, effect: { kind: 'gate' } };
      }
      return { state: s, effect: null };
    }
    case 'adding': {
      if (e.type === 'gate') {
        if (!e.result.ok) {
          return {
            state: { kind: 'checked', text: s.text, report: s.report, note: e.result.words },
            effect: null,
          };
        }
        return { state: s, effect: { kind: 'add', report: s.report } };
      }
      if (e.type === 'added') {
        return { state: { kind: 'added', url: s.report.url }, effect: null };
      }
      if (e.type === 'add-failed') {
        return { state: { kind: 'checked', text: s.text, report: s.report, note: e.why }, effect: null };
      }
      return { state: s, effect: null };
    }
    case 'added':
      return { state: s, effect: null };
  }
}
