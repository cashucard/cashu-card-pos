import React from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { WalletScreen } from '../src/screens/WalletScreen';
import { benchGate } from '../src/till/guarded';
import type { DeviceGate, GateResult } from '../src/till/gate';
import { LightningWalletError, type LightningPayment, type LightningState, type LightningWallet } from '../src/till/lightning';
import type { WalletReader } from '../src/till/wallet';
import { allText, has, isDisabled, press, textOf, typeInto, untilText } from './helpers/render';

const mint = 'https://test-mint.example';
const address = 'merchant@example.test';
const sample: LightningPayment = {
  id: 'quote-for-tests', address, amount: 40, maxFee: 3, automatic: false, description: 'Island café',
  expiresAt: Date.now() + 3_600_000, status: 'quoted',
};

function fixture(initial: LightningPayment | null = null, available = 100) {
  let state: LightningState = { policy: null, payment: initial };
  const api: jest.Mocked<LightningWallet> = {
    state: jest.fn(async (_mint: string) => state),
    quote: jest.fn(async (_mint, destination, amount) => {
      state = { ...state, payment: { ...sample, address: destination, amount } };
      return state.payment!;
    }),
    confirm: jest.fn(async (_mint: string, _id: string) => {
      state = { ...state, payment: { ...state.payment!, status: 'pending' } };
      return state.payment!;
    }),
    cancel: jest.fn(async (_mint: string, _id: string) => { state = { ...state, payment: null }; }),
    configure: jest.fn(async (_mint, policy) => { state = { ...state, policy }; }),
    refresh: jest.fn(async (_mint: string) => {
      state = { ...state, payment: state.payment ? { ...state.payment, status: 'paid', feePaid: 1 } : null };
      return state;
    }),
  };
  const wallet: WalletReader = {
    walletBalances: async () => [{ mint, unit: 'sat', available, withdrawal: null }],
    withdrawalToken: jest.fn(), checkWithdrawal: jest.fn(), prepareWithdrawal: jest.fn(), lightning: api,
  };
  return { wallet, api };
}

let tree: ReactTestRenderer;
async function mount(wallet: WalletReader, gate: DeviceGate = benchGate('allow')) {
  await act(async () => {
    tree = renderer.create(<WalletScreen service={wallet} gate={gate} onBack={jest.fn()} />);
  });
  await press(tree, 'wallet-lightning-' + mint + '/sat');
}

async function enterQuote() {
  await press(tree, 'lightning-manual');
  await typeInto(tree, 'lightning-address', address);
  await typeInto(tree, 'lightning-amount', '40');
  await press(tree, 'lightning-get-quote');
}

async function enterSweep() {
  await press(tree, 'lightning-sweep');
  await typeInto(tree, 'lightning-address', address);
  await typeInto(tree, 'sweep-threshold', '200');
  await typeInto(tree, 'sweep-max-fee', '5');
  await press(tree, 'sweep-review');
}

beforeEach(() => { AppState.currentState = 'active'; });
afterEach(() => { act(() => tree?.unmount()); jest.restoreAllMocks(); });

it('reviews the exact recipient, amount, fees and maximum debit before the owner can send', async () => {
  const { wallet, api } = fixture();
  const gate = benchGate('allow');
  await mount(wallet, gate);
  await enterQuote();
  expect(api.quote).toHaveBeenCalledWith(mint, address, 40);
  expect(api.confirm).not.toHaveBeenCalled();
  expect(textOf(tree, 'lightning-recipient')).toBe(address);
  expect(textOf(tree, 'lightning-description')).toBe('Island café');
  expect(textOf(tree, 'lightning-maximum-debit')).toBe('Maximum total: 43 sats');
  expect(textOf(tree, 'lightning-maximum-fee')).toBe('Maximum fees: 3 sats');
  expect(gate.asked).toHaveLength(0);
  await press(tree, 'lightning-send');
  expect(api.confirm).toHaveBeenCalledWith(mint, sample.id);
  expect(gate.asked).toEqual(['Confirm this Lightning withdrawal.']);
  expect(has(tree, 'lightning-pending')).toBe(true);
  expect(has(tree, 'lightning-send')).toBe(false);
  expect(has(tree, 'lightning-manual')).toBe(false);
  await press(tree, 'lightning-check');
  expect(api.confirm).toHaveBeenCalledTimes(1);
  expect(textOf(tree, 'lightning-paid-fee')).toBe('Fees paid: 1 sat');
});

it('restores a pending transfer at an empty mint and checks the original payment without sending again', async () => {
  const { wallet, api } = fixture({ ...sample, status: 'pending', automatic: true }, 0);
  await mount(wallet);
  expect(has(tree, 'lightning-pending')).toBe(true);
  expect(allText(tree)).toContain('Automatic sweep · Payment pending');
  await press(tree, 'lightning-check');
  expect(api.refresh).toHaveBeenCalledWith(mint);
  expect(api.quote).not.toHaveBeenCalled();
  expect(api.confirm).not.toHaveBeenCalled();
});

it('shows the actual fee and quoted maximum on a paid overcharge, with no resend action', async () => {
  const { wallet } = fixture({ ...sample, amount: 20, maxFee: 2, status: 'paid', feePaid: 4 });
  await mount(wallet);
  expect(allText(tree)).toContain('Lightning withdrawal · Payment sent');
  expect(textOf(tree, 'lightning-paid-fee')).toBe('Fees paid: 4 sats');
  expect(textOf(tree, 'lightning-fee-overage')).toBe('The final fee was 2 sats above the quoted maximum of 2 sats.');
  expect(has(tree, 'lightning-send')).toBe(false);
});

it('distinguishes an automatic sweep’s quoted fee from the merchant’s limit', async () => {
  const { wallet } = fixture({ ...sample, automatic: true, amount: 24, maxFee: 4, quotedFee: 2, status: 'paid', feePaid: 4 });
  await mount(wallet);
  expect(textOf(tree, 'lightning-fee-overage')).toBe('The final fee was 2 sats above the quoted maximum of 2 sats.');
  expect(textOf(tree, 'lightning-sweep-fee-cap')).toBe('Your sweep fee limit was 4 sats.');
});

it('a denied owner check keeps the quote available for cancellation', async () => {
  const { wallet, api } = fixture(sample);
  await mount(wallet, benchGate('deny'));
  await press(tree, 'lightning-send');
  expect(api.confirm).not.toHaveBeenCalled();
  expect(has(tree, 'lightning-send')).toBe(true);
  await press(tree, 'lightning-cancel');
  expect(api.cancel).toHaveBeenCalledWith(mint, sample.id);
  expect(has(tree, 'lightning-manual')).toBe(true);
});

it('lets an empty SAT wallet opt in, edit and disable a per-mint sweep with fresh approval', async () => {
  const { wallet, api } = fixture(null, 0);
  const gate = benchGate('allow');
  await mount(wallet, gate);
  expect(isDisabled(tree, 'lightning-manual')).toBe(true);
  await enterSweep();
  expect(api.configure).not.toHaveBeenCalled();
  expect(textOf(tree, 'sweep-destination')).toBe(address);
  expect(allText(tree)).toContain('Keep at this mint: 200 sats');
  await press(tree, 'sweep-confirm');
  expect(api.configure).toHaveBeenCalledWith(mint, { address, threshold: 200, maxFee: 5 });
  await press(tree, 'lightning-sweep');
  await typeInto(tree, 'sweep-threshold', '0');
  await typeInto(tree, 'sweep-max-fee', '0');
  await press(tree, 'sweep-review');
  await press(tree, 'sweep-confirm');
  expect(api.configure).toHaveBeenLastCalledWith(mint, { address, threshold: 0, maxFee: 0 });
  await press(tree, 'lightning-sweep');
  await press(tree, 'sweep-disable');
  expect(api.configure).toHaveBeenLastCalledWith(mint, null);
  expect(gate.asked).toEqual(Array(3).fill('Confirm this change to automatic withdrawals.'));
});

it('validates whole sats and rejects an invalid address before requesting a quote', async () => {
  const { wallet, api } = fixture();
  await mount(wallet);
  await press(tree, 'lightning-manual');
  await typeInto(tree, 'lightning-address', 'incomplete');
  await press(tree, 'lightning-get-quote');
  expect(textOf(tree, 'wallet-message')).toMatch(/Lightning address/);
  await typeInto(tree, 'lightning-address', address);
  for (const amount of ['1e2', '0.5', '-1', '0', '1000000000000000000000000000', '101']) {
    await typeInto(tree, 'lightning-amount', amount);
    await press(tree, 'lightning-get-quote');
  }
  expect(api.quote).not.toHaveBeenCalled();
});

it('shows curated payment errors, keeping a raw mint response off screen', async () => {
  const { wallet, api } = fixture();
  await mount(wallet);
  api.quote.mockRejectedValueOnce(new Error('private-invoice-or-proof'));
  await enterQuote();
  expect(allText(tree).join(' ')).not.toContain('private-invoice-or-proof');
  api.quote.mockRejectedValueOnce(new LightningWalletError('Fees exceed your available takings.'));
  await press(tree, 'lightning-get-quote');
  expect(textOf(tree, 'wallet-message')).toBe('Fees exceed your available takings.');
});

it('refuses to send after the iPhone backgrounds while an owner prompt is open', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  const listeners = new Set<(s: AppStateStatus) => void>();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_name, listener) => {
    const fn = listener as (s: AppStateStatus) => void;
    listeners.add(fn);
    return { remove: () => { listeners.delete(fn); } };
  });
  let finish!: (v: GateResult) => void;
  const gate = { available: async () => true, check: jest.fn(() => new Promise<GateResult>(r => { finish = r; })) };
  const { wallet, api } = fixture(sample);
  await mount(wallet, gate);
  await press(tree, 'lightning-send');
  expect(gate.check).toHaveBeenCalledTimes(1);
  await act(async () => {
    for (const fn of [...listeners]) fn('background');
    for (const fn of [...listeners]) fn('active');
    finish({ ok: true });
  });
  expect(api.confirm).not.toHaveBeenCalled();
  await untilText(tree, 'wallet-message', 'Return to Wallet and confirm again.');
});

it('shows the original automatic sweep quote without offering a manual send', async () => {
  const { wallet } = fixture({ ...sample, automatic: true });
  await mount(wallet);
  expect(has(tree, 'lightning-send')).toBe(false);
  expect(has(tree, 'lightning-cancel')).toBe(false);
  expect(has(tree, 'lightning-check')).toBe(true);
});

it('keeps sweep settings off when the owner cancels', async () => {
  const { wallet, api } = fixture();
  await mount(wallet, benchGate('deny'));
  await enterSweep();
  await press(tree, 'sweep-confirm');
  expect(api.configure).not.toHaveBeenCalled();
  expect(has(tree, 'sweep-review-title')).toBe(true);
  expect(textOf(tree, 'wallet-message')).toBe('Not confirmed. Nothing was changed.');
});

it('permits discarding an expired manual quote but never confirms it', async () => {
  const { wallet, api } = fixture({ ...sample, expiresAt: Date.now() - 1 });
  await mount(wallet);
  expect(isDisabled(tree, 'lightning-send')).toBe(true);
  await press(tree, 'lightning-cancel');
  expect(api.confirm).not.toHaveBeenCalled();
});
