import React from 'react';
import { AppState, BackHandler, type AppStateStatus } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { TopupScreen } from '../src/screens/TopupScreen';
import type { TopupReceipt } from '../src/till/store/topups';
import type { TopupService, TopupTapState } from '../src/till/topup';
import { has, ids, press, typeInto, textOf } from './helpers/render';

const invoice: TopupReceipt = {
  id: 'saved',
  state: 'invoice',
  expiresAt: Date.now() + 3_600_000,
  invoice: 'lnbc10000test',
  cardKey: 'original',
  mint: 'https://mint.test',
  total: 11,
  amount: 10,
  createdAt: Date.now(),
};
function service() {
  const api = {
    enterScreen: jest.fn(() => () => {}),
    cancelTap: jest.fn(),
    list: jest.fn(async () => [] as TopupReceipt[]),
    older: jest.fn(async (_card: string | undefined, _before: TopupReceipt) => [] as TopupReceipt[]),
    start: jest.fn(async () => invoice),
    refresh: jest.fn(async () => ({ ...invoice, state: 'ready' }) as TopupReceipt),
    load: jest.fn(
      async (_id: string, _pin: string, _notice?: (state: TopupTapState) => void) =>
        ({ ...invoice, state: 'loaded' }) as TopupReceipt,
    ),
  };
  return api;
}

it('separates the invoice price, mint fee and credited amount, and celebrates only after the finish tap', async () => {
  const api = service();
  const onDone = jest.fn();
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<TopupScreen service={api as unknown as TopupService} cardKey="original" onBack={() => {}} onDone={onDone} />);
  });
  try {
    expect(has(tree, 'topup-pin')).toBe(false);
    await press(tree, 'key-1');
    await press(tree, 'key-0');
    await press(tree, 'topup-continue');
    await typeInto(tree, 'topup-pin', '1234');
    await press(tree, 'topup-tap');
    expect(api.start).toHaveBeenCalledWith(10, '1234', 'original', expect.any(Function));
    expect(textOf(tree, 'topup-fee')).toContain('Pay 11 sats, including 1 sat in mint fees');
    expect(has(tree, 'result-celebration')).toBe(false);
    await press(tree, 'topup-check');
    await typeInto(tree, 'topup-pin', '1234');
    let resolve!: (r: TopupReceipt) => void;
    api.load.mockImplementationOnce(async (_id, _pin, notice) => {
      notice?.('holding');
      const r = await new Promise<TopupReceipt>((done) => {
        resolve = done;
      });
      notice?.('closed');
      return r;
    });
    await press(tree, 'topup-tap');
    expect(has(tree, 'nfc-top-half')).toBe(true);
    expect(has(tree, 'result-celebration')).toBe(false);
    await act(async () => {
      resolve({ ...invoice, state: 'loaded' });
    });
    expect(has(tree, 'result-celebration')).toBe(true);
    expect(textOf(tree, 'topup-credit')).toContain('10 sats loaded');
    await press(tree, 'topup-done');
    expect(onDone).toHaveBeenCalledTimes(1);
  } finally {
    act(() => tree.unmount());
  }
  expect(api.cancelTap).toHaveBeenCalled();
});

it('opens saved requests directly in receipt history and can recover an older expired request', async () => {
  const api = service();
  const past = Array.from({ length: 10 }, (_, i) => ({
    ...invoice,
    id: 'expired-' + i,
    state: 'expired' as const,
    createdAt: 1000 - i,
  }));
  const paid = { ...invoice, id: 'paid', state: 'ready' as const };
  api.list.mockResolvedValue([invoice, paid, ...past.slice(0, 9)]);
  api.older.mockResolvedValue(past.slice(8));
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<TopupScreen service={api as unknown as TopupService} historyOnly onBack={() => {}} />);
  });
  try {
    expect(has(tree, 'topup-amount')).toBe(false);
    expect(has(tree, 'topup-pin')).toBe(false);
    expect(has(tree, 'topup-tap')).toBe(false);
    expect(ids(tree).indexOf('topup-saved-paid')).toBeLessThan(ids(tree).indexOf('topup-saved-saved'));
    await press(tree, 'topup-show-history');
    expect(ids(tree).filter((id) => id.startsWith('topup-saved-'))).toHaveLength(8);
    await press(tree, 'topup-older');
    expect(api.older).toHaveBeenCalledWith(undefined, past[7]);
    expect(has(tree, 'topup-saved-expired-0')).toBe(false);
    await press(tree, 'topup-newer');
    expect(has(tree, 'topup-saved-expired-0')).toBe(true);
    await press(tree, 'topup-older');
    await press(tree, 'topup-saved-expired-9');
    await press(tree, 'topup-check');
    expect(api.refresh).toHaveBeenCalledWith('expired-9');
  } finally {
    act(() => tree.unmount());
  }
});

it('checks saved top-ups before offering an invoice after a temporary receipt read failure', async () => {
  const api = service();
  api.list.mockRejectedValueOnce(new Error('Busy')).mockResolvedValueOnce([{ ...invoice, state: 'ready' }]);
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<TopupScreen service={api as unknown as TopupService} cardKey="original" onBack={() => {}} />);
  });
  try {
    expect(has(tree, 'topup-amount')).toBe(false);
    await press(tree, 'topup-retry-list');
    expect(has(tree, 'topup-amount')).toBe(false);
    expect(has(tree, 'topup-pin')).toBe(true);
    expect(api.start).not.toHaveBeenCalled();
  } finally {
    act(() => tree.unmount());
  }
});

it('can reopen the original paid request directly from the balance screen', async () => {
  const api = service();
  api.list.mockResolvedValue([{ ...invoice, state: 'ready' }]);
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <TopupScreen service={api as unknown as TopupService} cardKey="original" onBack={() => {}} />,
    );
  });
  try {
    expect(api.list).toHaveBeenCalledWith('original');
    expect(has(tree, 'topup-amount')).toBe(false);
    expect(has(tree, 'topup-copy')).toBe(false);
    expect(has(tree, 'topup-pin')).toBe(true);
  } finally {
    act(() => tree.unmount());
  }
});

it('detects payment on the original receipt after a delay, retry and foreground return', async () => {
  jest.useFakeTimers();
  const previous = AppState.currentState;
  AppState.currentState = 'active';
  const listeners = new Set<(state: AppStateStatus) => void>();
  const subscribe = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
    listeners.add(handler);
    return { remove: () => { listeners.delete(handler); } };
  });
  const api = service();
  api.list.mockResolvedValue([invoice]);
  let resolve!: (result: TopupReceipt) => void;
  api.refresh.mockImplementationOnce(() => new Promise(done => { resolve = done; }))
    .mockRejectedValueOnce(new Error('Network delay'))
    .mockResolvedValueOnce({ ...invoice, state: 'issuing' });
  const tick = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });
  const change = (state: AppStateStatus) => act(async () => {
    AppState.currentState = state;
    listeners.forEach(listener => listener(state));
  });
  let tree!: ReactTestRenderer;
  try {
    await act(async () => {
      tree = renderer.create(<TopupScreen service={api as unknown as TopupService} cardKey="original" onBack={() => {}} />);
    });
    await tick(32000);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    await change('background');
    await act(async () => { resolve({ ...invoice, state: 'ready' }); });
    await tick(16000);
    expect(has(tree, 'topup-copy')).toBe(true);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    await change('active');
    expect(api.refresh).toHaveBeenCalledTimes(2);
    await tick(8000);
    expect(textOf(tree, 'topup-title')).toBe('Payment received');
    await tick(8000);
    expect(textOf(tree, 'topup-title')).toBe('Ready to load');
    await tick(16000);
    expect(api.refresh.mock.calls).toEqual([['saved'], ['saved'], ['saved'], ['saved']]);
    expect(api.start).not.toHaveBeenCalled();
    expect(api.load).not.toHaveBeenCalled();
    expect(has(tree, 'topup-pin')).toBe(true);
  } finally {
    if (tree) act(() => tree.unmount());
    subscribe.mockRestore();
    AppState.currentState = previous;
    jest.useRealTimers();
  }
});

it('uses Android Back to edit the top-up amount before leaving checkout', async () => {
  let hardwareBack!: () => boolean | null | undefined;
  const sub = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    hardwareBack = handler; return {remove: jest.fn()};
  });
  const onBack = jest.fn();
  const api = service();
  let tree!: ReactTestRenderer;
  try {
    await act(async () => { tree = renderer.create(<TopupScreen service={api as unknown as TopupService} cardKey="original" onBack={onBack} />); });
    await press(tree, 'key-5');
    await press(tree, 'topup-continue');
    expect(has(tree, 'topup-pin')).toBe(true);
    await act(async () => { expect(hardwareBack()).toBe(true); });
    expect(textOf(tree, 'topup-amount')).toBe('5 sats');
    expect(has(tree, 'topup-pin')).toBe(false);
    expect(onBack).not.toHaveBeenCalled();
    await act(async () => { hardwareBack(); });
    expect(onBack).toHaveBeenCalledTimes(1);
  } finally { if (tree) act(() => tree.unmount()); sub.mockRestore(); }
});
