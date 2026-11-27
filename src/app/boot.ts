import type { GateReason, GateResult } from '../till/gate';
import type { TillPhase } from '../till/service';
import type { OfferId, StoreMessage, StoreOffer } from '../till/store/messages';
import type { StoreChoice } from '../till/store/open-store';

export type ChoiceOffer = StoreOffer & { id: StoreChoice };
export type BootState =
  | { kind: 'opening' }
  | { kind: 'problem'; message: StoreMessage; note: string | null }
  | { kind: 'confirm'; message: StoreMessage; offer: ChoiceOffer; typed: string; note: string | null }
  | { kind: 'gate'; message: StoreMessage; offer: ChoiceOffer }
  | { kind: 'closed'; message: StoreMessage }
  | { kind: 'ready' }
  | { kind: 'failed'; why: string };
export type BootEvent =
  | { type: 'phase'; phase: TillPhase }
  | { type: 'offer'; id: OfferId }
  | { type: 'type'; text: string }
  | { type: 'go' }
  | { type: 'gate'; result: GateResult }
  | { type: 'back' }
  | { type: 'again' };
export type BootEffect =
  | { kind: 'open'; choice?: StoreChoice }
  | { kind: 'not-now' }
  | { kind: 'gate'; reason: GateReason };
export interface BootStep { state: BootState; effect: BootEffect | null }

export const BOOT_START: BootState = { kind: 'opening' };
export const CONFIRM_PHRASES: Readonly<Record<StoreChoice, string>> = {
  'start-new': 'START NEW', 'use-older': 'USE OLDER', 'set-aside': 'SET ASIDE',
};

/** Whether the merchant typed the phrase: trimmed, in capitals, runs of spaces made one. */
export function phraseTyped(choice: StoreChoice, text: string): boolean {
  return text.trim().replace(/\s+/g, ' ').toUpperCase() === CONFIRM_PHRASES[choice];
}

/** 'To go on, type START NEW below.' */
export function confirmAsk(choice: StoreChoice): string {
  return 'To go on, type ' + CONFIRM_PHRASES[choice] + ' below.';
}

export function isChoice(id: OfferId): id is StoreChoice {
  return id === 'start-new' || id === 'use-older' || id === 'set-aside';
}

/** The offer the message makes under that id, if it makes one. */
function offered(message: StoreMessage, id: OfferId): StoreOffer | null {
  for (const offer of message.offers) {
    if (offer.id === id) {
      return offer;
    }
  }
  return null;
}

export function bootStep(s: BootState, e: BootEvent): BootStep {
  if (e.type === 'phase') {
    switch (e.phase.kind) {
      case 'opening':
        return { state: { kind: 'opening' }, effect: null };
      case 'problem':
        return { state: { kind: 'problem', message: e.phase.message, note: null }, effect: null };
      case 'closed':
        return { state: { kind: 'closed', message: e.phase.message }, effect: null };
      case 'ready':
        return { state: { kind: 'ready' }, effect: null };
      case 'failed':
        return { state: { kind: 'failed', why: e.phase.why }, effect: null };
    }
  }
  switch (s.kind) {
    case 'problem': {
      if (e.type !== 'offer') {
        return { state: s, effect: null };
      }
      const found = offered(s.message, e.id);
      if (found === null) {
        return { state: s, effect: null };
      }
      if (found.id === 'not-now') {
        return { state: s, effect: { kind: 'not-now' } };
      }
      if (found.id === 'try-again') {
        return { state: { kind: 'opening' }, effect: { kind: 'open' } };
      }
      if (!isChoice(found.id)) {
        return { state: s, effect: null };
      }
      // isChoice has just checked the id, and this keeps the very object the message makes
      const offer: ChoiceOffer = found as ChoiceOffer;
      if (offer.guarded) {
        return {
          state: { kind: 'confirm', message: s.message, offer, typed: '', note: null },
          effect: null,
        };
      }
      return { state: { kind: 'opening' }, effect: { kind: 'open', choice: offer.id } };
    }
    case 'confirm': {
      if (e.type === 'type') {
        return { state: { ...s, typed: e.text, note: null }, effect: null };
      }
      if (e.type === 'go') {
        if (!phraseTyped(s.offer.id, s.typed)) {
          return { state: s, effect: null };
        }
        return {
          state: { kind: 'gate', message: s.message, offer: s.offer },
          effect: { kind: 'gate', reason: s.offer.id },
        };
      }
      if (e.type === 'back') {
        return { state: { kind: 'problem', message: s.message, note: null }, effect: null };
      }
      return { state: s, effect: null };
    }
    case 'gate': {
      if (e.type !== 'gate') {
        return { state: s, effect: null };
      }
      if (e.result.ok) {
        return { state: { kind: 'opening' }, effect: { kind: 'open', choice: s.offer.id } };
      }
      return {
        state: { kind: 'confirm', message: s.message, offer: s.offer, typed: '', note: e.result.words },
        effect: null,
      };
    }
    case 'closed':
      if (e.type === 'again') {
        return { state: { kind: 'opening' }, effect: { kind: 'open' } };
      }
      return { state: s, effect: null };
    case 'failed':
      if (e.type === 'again') {
        return { state: { kind: 'opening' }, effect: { kind: 'open' } };
      }
      return { state: s, effect: null };
    case 'opening':
    case 'ready':
      return { state: s, effect: null };
  }
}
