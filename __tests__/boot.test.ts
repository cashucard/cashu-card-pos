import {
  BOOT_START,
  CONFIRM_PHRASES,
  bootStep,
  confirmAsk,
  phraseTyped,
  type BootEvent,
  type BootState,
  type BootStep,
} from '../src/app/boot';
import { storeMessage, type StoreMessage } from '../src/till/store/messages';
import type { StoreChoice } from '../src/till/store/open-store';
import type { TillPhase } from '../src/till/service';

/** The message for an outcome; the test throws when there is none. */
function message(o: Parameters<typeof storeMessage>[0]): StoreMessage {
  const m = storeMessage(o);
  if (m === null) {
    throw new Error('no message for ' + o.kind);
  }
  return m;
}

const missing = message({ kind: 'journal-missing', storedGeneration: 3 });
const older = message({ kind: 'rolled-back', journalGeneration: 2, storedGeneration: 5 });
const locked = message({ kind: 'secure-store-unavailable', why: 'x' });

/** A step that also checks the state given was not changed. */
function step(s: BootState, e: BootEvent): BootStep {
  const before = JSON.stringify(s);
  const r = bootStep(s, e);
  expect(JSON.stringify(s)).toBe(before);
  return r;
}

function problem(m: StoreMessage): BootState {
  return step(BOOT_START, { type: 'phase', phase: { kind: 'problem', message: m } }).state;
}

function gateState(m: StoreMessage, id: StoreChoice): BootState {
  const c = step(problem(m), { type: 'offer', id }).state;
  const t = step(c, { type: 'type', text: CONFIRM_PHRASES[id] }).state;
  expect(t.kind).toBe('confirm');
  return step(t, { type: 'go' }).state;
}

it('the phase of the service is followed', () => {
  const phases: TillPhase[] = [
    { kind: 'opening' },
    { kind: 'problem', message: missing },
    { kind: 'closed', message: locked },
    { kind: 'ready', firstRun: false, mints: [], note: null },
    { kind: 'failed', why: 'x' },
  ];
  const want: BootState[] = [
    { kind: 'opening' },
    { kind: 'problem', message: missing, note: null },
    { kind: 'closed', message: locked },
    { kind: 'ready' },
    { kind: 'failed', why: 'x' },
  ];
  for (let i = 0; i < phases.length; i += 1) {
    expect(step(BOOT_START, { type: 'phase', phase: phases[i] })).toEqual({
      state: want[i],
      effect: null,
    });
  }
});

it('not now asks the service to close the till', () => {
  const s = problem(missing);
  const r = step(s, { type: 'offer', id: 'not-now' });
  expect(r.state).toBe(s);
  expect(r.effect).toEqual({ kind: 'not-now' });
});

it('try again opens again', () => {
  const r = step(problem(locked), { type: 'offer', id: 'try-again' });
  expect(r.state).toEqual({ kind: 'opening' });
  expect(r.effect).toEqual({ kind: 'open' });
});

it('a new record asks for the phrase first', () => {
  const offer = missing.offers.find((o) => o.id === 'start-new');
  const r = step(problem(missing), { type: 'offer', id: 'start-new' });
  expect(r.state).toEqual({ kind: 'confirm', message: missing, offer, typed: '', note: null });
  expect(r.effect).toBeNull();
  if (r.state.kind === 'confirm') {
    expect(r.state.offer.id).toBe('start-new');
    expect(r.state.offer).toBe(offer);
  }
});

it('an offer the message does not make is ignored', () => {
  const s = problem(missing);
  const r = step(s, { type: 'offer', id: 'use-older' });
  expect(r.state).toBe(s);
  expect(r.effect).toBeNull();
});

it('the phrase must be typed before the device check', () => {
  const offer = missing.offers.find((o) => o.id === 'start-new');
  const c = step(problem(missing), { type: 'offer', id: 'start-new' }).state;
  expect(step(c, { type: 'go' })).toEqual({ state: c, effect: null });

  const one = step(c, { type: 'type', text: 'start' }).state;
  expect(step(one, { type: 'go' })).toEqual({ state: one, effect: null });

  const typed = step(c, { type: 'type', text: '  start   new ' }).state;
  const r = step(typed, { type: 'go' });
  expect(r.state).toEqual({ kind: 'gate', message: missing, offer });
  expect(r.effect).toEqual({ kind: 'gate', reason: 'start-new' });
});

it('phraseTyped and confirmAsk', () => {
  expect(phraseTyped('use-older', 'use older')).toBe(true);
  expect(phraseTyped('use-older', 'USE  OLDER ')).toBe(true);
  expect(phraseTyped('use-older', 'use-older')).toBe(false);
  expect(phraseTyped('set-aside', 'SET ASIDE')).toBe(true);
  expect(confirmAsk('set-aside')).toBe('To go on, type SET ASIDE below.');
});

it('a passed device check opens with the choice', () => {
  const g = gateState(missing, 'start-new');
  const r = step(g, { type: 'gate', result: { ok: true } });
  expect(r.state).toEqual({ kind: 'opening' });
  expect(r.effect).toEqual({ kind: 'open', choice: 'start-new' });
});

it('a refused device check goes back to the phrase with its words', () => {
  const g = gateState(missing, 'start-new');
  const offer = missing.offers.find((o) => o.id === 'start-new');
  const r = step(g, {
    type: 'gate',
    result: { ok: false, why: 'cancelled', words: 'Not confirmed. Nothing was changed.' },
  });
  expect(r.state).toEqual({
    kind: 'confirm',
    message: missing,
    offer,
    typed: '',
    note: 'Not confirmed. Nothing was changed.',
  });
  expect(r.effect).toBeNull();
});

it('back from the phrase is the problem again', () => {
  const c = step(problem(older), { type: 'offer', id: 'use-older' }).state;
  const r = step(c, { type: 'back' });
  expect(r.state).toEqual({ kind: 'problem', message: older, note: null });
  expect(r.effect).toBeNull();
});

it('an older record goes the same way', () => {
  const c = step(problem(older), { type: 'offer', id: 'use-older' }).state;
  const typed = step(c, { type: 'type', text: 'USE OLDER' }).state;
  const r = step(typed, { type: 'go' });
  expect(r.effect).toEqual({ kind: 'gate', reason: 'use-older' });
  const after = step(r.state, { type: 'gate', result: { ok: true } });
  expect(after.state).toEqual({ kind: 'opening' });
  expect(after.effect).toEqual({ kind: 'open', choice: 'use-older' });
});

it('a closed or failed till opens again on again', () => {
  const closed: BootState = { kind: 'closed', message: locked };
  expect(step(closed, { type: 'again' })).toEqual({
    state: { kind: 'opening' },
    effect: { kind: 'open' },
  });
  const failed: BootState = { kind: 'failed', why: 'x' };
  expect(step(failed, { type: 'again' })).toEqual({
    state: { kind: 'opening' },
    effect: { kind: 'open' },
  });
  const p = problem(missing);
  const r = step(p, { type: 'again' });
  expect(r.state).toBe(p);
  expect(r.effect).toBeNull();
});

it('nothing given is changed', () => {
  const states: BootState[] = [
    BOOT_START,
    { kind: 'ready' },
    problem(missing),
    { kind: 'closed', message: locked },
    { kind: 'failed', why: 'x' },
    gateState(missing, 'start-new'),
  ];
  const events: BootEvent[] = [
    { type: 'phase', phase: { kind: 'opening' } },
    { type: 'phase', phase: { kind: 'ready', firstRun: false, mints: [], note: null } },
    { type: 'offer', id: 'not-now' },
    { type: 'offer', id: 'try-again' },
    { type: 'offer', id: 'start-new' },
    { type: 'offer', id: 'set-aside' },
    { type: 'type', text: 'START NEW' },
    { type: 'go' },
    { type: 'gate', result: { ok: true } },
    { type: 'gate', result: { ok: false, why: 'cancelled', words: 'w.' } },
    { type: 'back' },
    { type: 'again' },
  ];
  for (const s of states) {
    const before = JSON.stringify(s);
    for (const e of events) {
      bootStep(s, e);
    }
    expect(JSON.stringify(s)).toBe(before);
  }
});
