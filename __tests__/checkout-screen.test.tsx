import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { CheckoutScreen } from '../src/screens/CheckoutScreen';
import type { SaleController } from '../src/till/sale-controller';
import type { LightningSaleReceipt } from '../src/till/lightning-sale';
import { has, isDisabled, press, textOf } from './helpers/render';

const id = 'checkout';
const invoice = { saleId: id, paymentId: 'ln-checkout', mint: 'https://mint.test', amount: 12,
  invoice: 'lnbc120n1example', createdAt: Date.now(), expiresAt: Date.now() + 120000,
  state: 'unpaid' } satisfies LightningSaleReceipt;
let tree: ReactTestRenderer;

async function show(initial = invoice as LightningSaleReceipt, firstOfferFails = false, verifyInvoice = false) {
  const service = {
    lightningOffer: jest.fn(async () => initial),
    checkLightningSale: jest.fn(async (): Promise<LightningSaleReceipt> => invoice),
    phoneOffer: jest.fn(), takePhonePayment: jest.fn(), payments: jest.fn(), onPayments: jest.fn(),
  };
  if (verifyInvoice) service.checkLightningSale.mockRejectedValueOnce(new Error('Mint unreachable.'));
  if (firstOfferFails) service.lightningOffer.mockRejectedValueOnce(new Error('Mint connection interrupted.'));
  const controller = { input: jest.fn(), holdWallet: jest.fn(), releaseWallet: jest.fn(), walletPaid: jest.fn(),
    walletProcessing: jest.fn(), walletExtra: jest.fn(), invoiceUnpaid: jest.fn() };
  const onActivity = jest.fn();
  await act(async () => {
    tree = renderer.create(<CheckoutScreen saleId={id} state={{ kind: 'preflight', saleId: id, shared: true, verifyInvoice: verifyInvoice || undefined, sats: 12, count: 0 }}
      service={service} controller={controller as unknown as SaleController} onActivity={onActivity} onReturn={jest.fn()} />);
  });
  return { service, controller, onActivity };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => { act(() => tree?.unmount()); jest.useRealTimers(); });

test('the shared PIN screen starts with an exact-price Lightning QR, then hides all tenders while crediting a paid invoice', async () => {
  const { service, controller, onActivity } = await show();
  expect(service.lightningOffer).toHaveBeenCalledTimes(1);
  expect(has(tree, 'lightning-request-qr')).toBe(true);
  expect(has(tree, 'pin-dots')).toBe(true);
  expect(isDisabled(tree, 'pin-ok')).toBe(true);
  expect(has(tree, 'preflight-reviewed')).toBe(false);
  service.checkLightningSale.mockResolvedValueOnce({ ...invoice, state: 'processing' });
  await act(async () => { jest.advanceTimersByTime(2500); });
  expect(controller.walletProcessing).toHaveBeenCalledWith(id);
  expect(has(tree, 'lightning-request-qr')).toBe(false);
  expect(has(tree, 'pin-ok')).toBe(false);
  await press(tree, 'lightning-activity');
  expect(onActivity).toHaveBeenCalled();
  service.checkLightningSale.mockResolvedValueOnce({ ...invoice, state: 'paid' });
  await act(async () => { jest.advanceTimersByTime(2500); });
  expect(controller.walletPaid).toHaveBeenCalledWith(id, 'Lightning');
  expect(controller.input).not.toHaveBeenCalled();
});

test('expiry removes the QR locally even while the mint is slow, and an extra goes to the return flow', async () => {
  const { service, controller } = await show({ ...invoice, expiresAt: Date.now() + 1000 });
  await act(async () => { jest.advanceTimersByTime(1001); });
  expect(has(tree, 'lightning-request-qr')).toBe(false);
  expect(textOf(tree, 'lightning-caption')).toContain('expired');
  service.checkLightningSale.mockResolvedValueOnce({ ...invoice, state: 'extra' });
  await act(async () => { jest.advanceTimersByTime(1500); });
  expect(controller.walletExtra).toHaveBeenCalledWith(id);
  expect(controller.walletPaid).not.toHaveBeenCalled();
});

test('a failed Lightning offer leaves card entry available and can be retried on the same sale', async () => {
  const { service, controller } = await show(invoice, true);
  expect(has(tree, 'lightning-request-qr')).toBe(false);
  expect(has(tree, 'pin-key-1')).toBe(true);
  await press(tree, 'lightning-retry');
  expect(service.lightningOffer.mock.calls).toHaveLength(2);
  expect(service.lightningOffer).toHaveBeenNthCalledWith(1, id);
  expect(service.lightningOffer).toHaveBeenNthCalledWith(2, id);
  expect(has(tree, 'lightning-request-qr')).toBe(true);
  expect(controller.walletPaid).not.toHaveBeenCalled();
});


test.each(['paid', 'unpaid'] as const)('rechecks the original invoice after a card attempt fails to verify it (%s)', async state => {
  const { service, controller } = await show(invoice, false, true);
  expect(service.lightningOffer).not.toHaveBeenCalled();
  expect(service.checkLightningSale).toHaveBeenCalledWith(id);
  expect(has(tree, 'lightning-verifying')).toBe(true);
  expect(has(tree, 'lightning-request-qr')).toBe(false);
  expect(has(tree, 'pin-ok')).toBe(false);
  expect(controller.invoiceUnpaid).not.toHaveBeenCalled();
  service.checkLightningSale.mockResolvedValueOnce({ ...invoice, state });
  await act(async () => { jest.advanceTimersByTime(2500); });
  if (state === 'paid') {
    expect(controller.walletPaid).toHaveBeenCalledWith(id, 'Lightning');
    expect(controller.invoiceUnpaid).not.toHaveBeenCalled();
  } else {
    expect(controller.invoiceUnpaid).toHaveBeenCalledWith(id);
    expect(controller.walletPaid).not.toHaveBeenCalled();
  }
  expect(service.lightningOffer).not.toHaveBeenCalled();
});
