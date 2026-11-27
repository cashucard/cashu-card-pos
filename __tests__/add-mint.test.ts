import {
  ADD_MINT_WORDS,
  addMintStart,
  addMintStep,
  lineWords,
  resultWords,
  type AddMintEvent,
  type AddMintState,
  type AddMintStep,
} from '../src/app/add-mint';
import type { MintCheckReport } from '../src/till/mint-check';

function report(ok: boolean, reached = true): MintCheckReport {
  return {
    url: 'https://mint.test',
    ok,
    reached,
    lines: [
      { id: 'address', ok, words: 'The address starts with https.' },
      { id: 'fee', ok, words: 'Its fee is within what this till takes.' },
    ],
    keysets: ok ? ['01' + 'ab'.repeat(32)] : [],
  };
}

/** A step that also checks the state given was not changed. */
function step(s: AddMintState, e: AddMintEvent): AddMintStep {
  const before = JSON.stringify(s);
  const r = addMintStep(s, e);
  expect(JSON.stringify(s)).toBe(before);
  return r;
}

function checkedState(rep: MintCheckReport): AddMintState {
  const c = step(addMintStart('https://mint.test'), { type: 'check' }).state;
  return step(c, { type: 'report', report: rep }).state;
}

function addingState(rep: MintCheckReport): AddMintState {
  return step(checkedState(rep), { type: 'add' }).state;
}

it('the preset fills the address', () => {
  expect(addMintStart('https://mint.test')).toEqual({
    kind: 'editing',
    text: 'https://mint.test',
    note: null,
  });
  expect(addMintStart(null)).toEqual({ kind: 'editing', text: '', note: null });
});

it('an empty address asks for one, and nothing is checked', () => {
  const r = step(addMintStart('  '), { type: 'check' });
  expect(r.state).toEqual({ kind: 'editing', text: '  ', note: ADD_MINT_WORDS.empty });
  expect(r.effect).toBeNull();
});

it('a check is asked, and its report shown', () => {
  const r = step(addMintStart('mint.test'), { type: 'check' });
  expect(r.state).toEqual({ kind: 'checking', text: 'mint.test' });
  expect(r.effect).toEqual({ kind: 'check', text: 'mint.test' });

  const c = step(r.state, { type: 'report', report: report(true) });
  expect(c.state).toEqual({
    kind: 'checked',
    text: 'mint.test',
    report: report(true),
    note: null,
  });
  expect(c.effect).toBeNull();
});

it('a check that fails to run is shown as a note', () => {
  const s = step(addMintStart('mint.test'), { type: 'check' }).state;
  const r = step(s, { type: 'check-failed', why: 'x' });
  expect(r.state).toEqual({ kind: 'editing', text: 'mint.test', note: 'x' });
  expect(r.effect).toBeNull();
});

it('a mint that passed is added only after the device check', () => {
  const okReport = report(true);
  const c = checkedState(okReport);
  const a = step(c, { type: 'add' });
  expect(a.state).toEqual({ kind: 'adding', text: 'https://mint.test', report: okReport });
  expect(a.effect).toEqual({ kind: 'gate' });

  const passed = step(a.state, { type: 'gate', result: { ok: true } });
  expect(passed.state).toBe(a.state);
  expect(passed.effect).toEqual({ kind: 'add', report: okReport });

  const done = step(passed.state, { type: 'added' });
  expect(done.state).toEqual({ kind: 'added', url: 'https://mint.test' });
  expect(done.effect).toBeNull();
});

it('a mint that did not pass cannot be added', () => {
  const c = checkedState(report(false));
  const r = step(c, { type: 'add' });
  expect(r.state).toBe(c);
  expect(r.effect).toBeNull();
});

it('a refused device check adds nothing', () => {
  const a = addingState(report(true));
  const r = step(a, {
    type: 'gate',
    result: { ok: false, why: 'cancelled', words: 'w.' },
  });
  expect(r.state).toEqual({
    kind: 'checked',
    text: 'https://mint.test',
    report: report(true),
    note: 'w.',
  });
  expect(r.effect).toBeNull();
});

it('a failed add is shown', () => {
  const a = addingState(report(true));
  const r = step(a, { type: 'add-failed', why: 'y' });
  expect(r.state).toEqual({
    kind: 'checked',
    text: 'https://mint.test',
    report: report(true),
    note: 'y',
  });
  expect(r.effect).toBeNull();
});

it('typing after a check starts over', () => {
  const c = checkedState(report(true));
  const r = step(c, { type: 'type', text: 'a.test' });
  expect(r.state).toEqual({ kind: 'editing', text: 'a.test', note: null });
  expect(r.effect).toBeNull();
});

it('the words', () => {
  expect(resultWords(report(true))).toBe('This mint can be used.');
  expect(resultWords(report(false))).toBe('This mint cannot be used.');
  expect(resultWords(report(false, false))).toBe(
    'The mint did not answer. Check the address, then try again.',
  );
  expect(lineWords({ ok: true, words: 'A.' })).toBe('Passed: A.');
  expect(lineWords({ ok: false, words: 'B.' })).toBe('Failed: B.');
});

it('nothing given is changed', () => {
  const states: AddMintState[] = [
    addMintStart(null),
    addMintStart('mint.test'),
    { kind: 'checking', text: 'mint.test' },
    checkedState(report(true)),
    checkedState(report(false)),
    addingState(report(true)),
    { kind: 'added', url: 'https://mint.test' },
  ];
  const events: AddMintEvent[] = [
    { type: 'type', text: 'a.test' },
    { type: 'check' },
    { type: 'report', report: report(true) },
    { type: 'check-failed', why: 'x' },
    { type: 'add' },
    { type: 'gate', result: { ok: true } },
    { type: 'gate', result: { ok: false, why: 'cancelled', words: 'w.' } },
    { type: 'added' },
    { type: 'add-failed', why: 'y' },
  ];
  for (const s of states) {
    const before = JSON.stringify(s);
    for (const e of events) {
      addMintStep(s, e);
    }
    expect(JSON.stringify(s)).toBe(before);
  }
});
