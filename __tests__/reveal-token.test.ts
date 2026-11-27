import { AppState, Platform, type AppStateStatus } from 'react-native';
import { revealToken } from '../src/till/reveal-token';
import type { GateResult } from '../src/till/gate';

function pending<T>() {
  let resolve!: (value: T) => void;
  const result = new Promise<T>(r => { resolve = r; });
  return { result, resolve };
}

function phone(platform: 'ios' | 'android') {
  jest.replaceProperty(Platform, 'OS', platform);
  AppState.currentState = 'active';
  const handlers = new Set<(s: AppStateStatus) => void>();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, cb) => {
    const fn = cb as (s: AppStateStatus) => void;
    handlers.add(fn);
    return { remove: () => { handlers.delete(fn); } };
  });
  return (state: AppStateStatus) => {
    AppState.currentState = state;
    for (const f of handlers) f(state);
  };
}

function request() {
  const auth = pending<GateResult>();
  const checked = pending<void>();
  const gate = {
    available: async () => true,
    check: jest.fn(async () => { checked.resolve(); return auth.result; }),
  };
  const controller = new AbortController();
  const read = jest.fn(async () => 'a private test token');
  const show = jest.fn();
  const action = revealToken(gate, controller.signal, read, show);
  return { action, auth, checked, controller, gate, read, show };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test.each([
  ['android', 'background'], ['ios', 'inactive'],
] as const)('a successful %s system prompt waits for POS to resume before reading or showing the token', async (platform, overlay) => {
  const change = phone(platform);
  const ask = request();
  await ask.checked.result;
  change(overlay);
  ask.auth.resolve({ ok: true });
  await new Promise<void>(r => setTimeout(r, 0));
  expect(ask.read).not.toHaveBeenCalled();
  change('active');
  expect(await ask.action).toBe('');
  expect(ask.gate.check).toHaveBeenCalledTimes(1);
  expect(ask.read).toHaveBeenCalledTimes(1);
  expect(ask.show).toHaveBeenCalledWith('a private test token');
});

test('an iOS app switch invalidates the request even if the native check later succeeds', async () => {
  const change = phone('ios');
  const ask = request();
  await ask.checked.result;
  change('inactive');
  change('background');
  change('active');
  ask.auth.resolve({ ok: true });
  expect(await ask.action).toMatch(/verify again/);
  expect(ask.read).not.toHaveBeenCalled();
});

test('Android can resume first, but it still needs a successful credential result', async () => {
  const change = phone('android');
  const ask = request();
  await ask.checked.result;
  change('background');
  change('active');
  expect(ask.read).not.toHaveBeenCalled();
  ask.auth.resolve({ ok: false, why: 'cancelled', words: 'Not confirmed.' });
  expect(await ask.action).toBe('Not confirmed.');
  expect(ask.read).not.toHaveBeenCalled();

  const retry = request();
  await retry.checked.result;
  change('background');
  change('active');
  retry.auth.resolve({ ok: true });
  expect(await retry.action).toBe('');
  expect(retry.show).toHaveBeenCalledTimes(1);
});

test('Android stays covered after the prompt closes and cannot reveal on a later foreground', async () => {
  jest.useFakeTimers();
  const change = phone('android');
  const ask = request();
  await ask.checked.result;
  change('background');
  ask.auth.resolve({ ok: true });
  await jest.advanceTimersByTimeAsync(10_000);
  change('active');
  expect(await ask.action).toMatch(/verify again/);
  expect(ask.read).not.toHaveBeenCalled();
});

test('leaving the screen while waiting for the prompt to dismiss cancels the handoff', async () => {
  const change = phone('android');
  const ask = request();
  await ask.checked.result;
  change('background');
  ask.auth.resolve({ ok: true });
  await new Promise<void>(r => setTimeout(r, 0));
  ask.controller.abort();
  expect(await ask.action).toMatch(/verify again/);
  change('active');
  expect(ask.show).not.toHaveBeenCalled();
  expect(ask.read).not.toHaveBeenCalled();
});
