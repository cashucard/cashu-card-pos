import React from 'react';
import { Clipboard, View } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { PaymentRequest } from '@cashu/cashu-ts';
import type { Payment } from 'cashucard';
import * as scanner from '../src/app/phone-payment-scanner';
import type { PhonePaymentResult } from '../src/till/phone-payment';
import { PhonePaymentScreen } from '../src/screens/PhonePaymentScreen';
import { heldPayment } from './helpers/fake-till';
import { allText, has, nodes, press, textOf } from './helpers/render';

const mint = 'https://mint.test';
const offer = new PaymentRequest([], 'request-id', 14, 'sat', [mint]).toEncodedCreqA();
const payment = heldPayment('sale-1');
let tree: ReactTestRenderer;
function setup() {
  let listener: (rows: Payment[]) => void = () => {};
  const service = {
    phoneOffer: jest.fn(async () => offer),
    takePhonePayment: jest.fn(async (_id: string, _value: string): Promise<PhonePaymentResult> => ({ kind: 'paid', payment })),
    payments: jest.fn(async (): Promise<Payment[]> => []),
    onPayments: (fn: (rows: Payment[]) => void) => { listener = fn; return () => { listener = () => {}; }; },
  };
  return { service, settle: (rows: Payment[]) => listener(rows), onNewSale: jest.fn(), onActivity: jest.fn(), onReturn: jest.fn(),
    beginTender: jest.fn(() => true), resumeCard: jest.fn(), onPaid: jest.fn() };
}
async function show(f: ReturnType<typeof setup>, cashu = true) {
  await act(async () => { tree = renderer.create(<PhonePaymentScreen saleId={payment.id} amount={14}
    lightning={{ invoice: 'lnbc140n1example' }} renderPin={wallet => <View testID="card-pin-checkout">{wallet}</View>} {...f} />); });
  if (cashu) await press(tree, 'checkout-switch-wallet');
}
afterEach(() => { act(() => tree?.unmount()); jest.restoreAllMocks(); });

test('opens a request for the keypad amount and scans once without exposing payment text', async () => {
  const f = setup();
  let resolveScan!: (text: string) => void;
  const scan = jest.spyOn(scanner, 'scanPhonePaymentQr').mockImplementation(() => new Promise(resolve => { resolveScan = resolve; }));
  await show(f);
  expect(f.service.phoneOffer).toHaveBeenCalledWith(payment.id);
  expect(has(tree, 'phone-request-qr')).toBe(true);
  expect(textOf(tree, 'phone-mints')).toContain('mint.test');
  const tap = nodes(tree, 'phone-scan')[0].props.onPress;
  await act(async () => { tap(); tap(); });
  expect(scan).toHaveBeenCalledTimes(1);
  await act(async () => resolveScan('customer-payment-example'));
  expect(f.service.takePhonePayment).toHaveBeenCalledWith(payment.id, 'customer-payment-example');
  expect(f.onPaid).toHaveBeenCalledTimes(1);
  expect(allText(tree).join(' ')).not.toContain('customer-payment-example');
});

test('pastes on request and allows a corrected payment after a definitive refusal', async () => {
  const f = setup();
  const read = jest.spyOn(Clipboard, 'getString').mockResolvedValue('example-payment');
  f.service.takePhonePayment.mockResolvedValueOnce({ kind: 'refused', message: 'This mint does not match the request.' });
  await show(f);
  expect(read).not.toHaveBeenCalled();
  await press(tree, 'phone-paste');
  expect(textOf(tree, 'phone-message')).toContain('mint does not match');
  expect(has(tree, 'phone-scan')).toBe(true);
  await press(tree, 'phone-paste');
  expect(f.onPaid).toHaveBeenCalledTimes(1);
  expect(f.service.phoneOffer).toHaveBeenCalledTimes(1);
  expect(f.resumeCard).toHaveBeenCalledTimes(1);
});

test('shows a pending receipt until the mint confirms this exact wallet payment', async () => {
  const f = setup();
  jest.spyOn(scanner, 'scanPhonePaymentQr').mockResolvedValue('example-payment');
  f.service.takePhonePayment.mockResolvedValue({ kind: 'pending', message: 'Checking with the mint.', paymentId: payment.paymentId });
  await show(f);
  await press(tree, 'phone-scan');
  expect(textOf(tree, 'phone-title')).toBe('Awaiting confirmation');
  expect(has(tree, 'phone-paste')).toBe(false);
  act(() => f.settle([{ ...payment, state: 'taking' }, { ...payment, extra: 'late', paymentId: 'other' }, { ...payment, id: 'other' },
    { ...payment, paymentId: 'other' }, { ...payment, cardKey: 'card' }]));
  expect(textOf(tree, 'phone-title')).toBe('Awaiting confirmation');
  act(() => f.settle([{ ...payment, state: 'delivered' }]));
  expect(f.onPaid).toHaveBeenCalledTimes(1);
});

test('a cancelled customer QR scan keeps the shared card checkout alive and releases its lock', async () => {
  const f = setup();
  jest.spyOn(scanner, 'scanPhonePaymentQr').mockResolvedValue(null);
  await show(f);
  await press(tree, 'phone-scan');
  expect(f.service.takePhonePayment).not.toHaveBeenCalled();
  expect(f.beginTender).toHaveBeenCalledTimes(1);
  expect(f.resumeCard).toHaveBeenCalledTimes(1);
  expect(has(tree, 'card-pin-checkout')).toBe(true);
});

test('the PIN screen posts Lightning immediately and shows just one QR when switching to Cashu and back', async () => {
  const f = setup();
  await show(f, false);
  expect(has(tree, 'card-pin-checkout')).toBe(true);
  expect(has(tree, 'lightning-request-qr')).toBe(true);
  expect(has(tree, 'phone-request-qr')).toBe(false);
  expect(f.service.phoneOffer).not.toHaveBeenCalled();
  await press(tree, 'checkout-switch-wallet');
  expect(has(tree, 'lightning-request-qr')).toBe(false);
  expect(has(tree, 'phone-request-qr')).toBe(true);
  await press(tree, 'checkout-switch-wallet');
  expect(has(tree, 'lightning-request-qr')).toBe(true);
  expect(has(tree, 'phone-request-qr')).toBe(false);
  expect(f.beginTender).not.toHaveBeenCalled();
});
test('a scanner permission error offers paste without submitting payment data', async () => {
  const f = setup();
  jest.spyOn(scanner, 'scanPhonePaymentQr').mockRejectedValue(new Error('camera permission denied'));
  await show(f);
  await press(tree, 'phone-scan');
  expect(textOf(tree, 'phone-message')).toContain('paste');
  expect(f.service.takePhonePayment).not.toHaveBeenCalled();
  expect(has(tree, 'phone-paste')).toBe(true);
});

test('a Cashu response can’t enter settlement after another tender has claimed the sale', async () => {
  const f = setup();
  f.beginTender.mockReturnValue(false);
  const scan = jest.spyOn(scanner, 'scanPhonePaymentQr');
  await show(f);
  await press(tree, 'phone-scan');
  expect(scan).not.toHaveBeenCalled();
  expect(f.service.takePhonePayment).not.toHaveBeenCalled();
});

test('a late swap belongs to the original payer and opens the return screen', async () => {
  const f = setup();
  jest.spyOn(scanner, 'scanPhonePaymentQr').mockResolvedValue('example-payment');
  f.service.takePhonePayment.mockResolvedValue({ kind: 'pending', message: 'Waiting for the mint.', paymentId: payment.paymentId });
  await show(f);
  await press(tree, 'phone-scan');
  act(() => f.settle([{ ...payment, state: 'held', extra: 'late' }]));
  expect(textOf(tree, 'phone-title')).toBe('Customer return');
  expect(has(tree, 'result-celebration')).toBe(false);
  await press(tree, 'phone-return');
  expect(f.onReturn).toHaveBeenCalled();
});
