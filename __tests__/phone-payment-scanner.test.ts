import { DeviceEventEmitter, NativeModules } from 'react-native';
import { scanPhonePaymentQr } from '../src/app/phone-payment-scanner';

jest.mock('../src/app/phone-payment-frames', () => ({
  createPhonePaymentFrameReader: () => ({
    read: (text: string) => text === 'partial' ? { kind: 'progress', received: 1, expected: 3 }
      : text === 'invalid' ? { kind: 'error', message: 'This payment QR is incomplete.' }
      : { kind: 'complete', text },
  }),
}));

function cameraFixture() {
  let active = '';
  let dismiss!: (success: boolean) => void;
  const native = {
    addListener: jest.fn(), removeListeners: jest.fn(), showProgress: jest.fn(),
    scan: jest.fn((session: string) => {
      active = session;
      return new Promise<boolean>(resolve => { dismiss = resolve; });
    }),
    finishScan: jest.fn(() => dismiss(true)),
  };
  NativeModules.CCPOSPaymentScanner = native;
  const frame = (text: string, session = active) =>
    DeviceEventEmitter.emit('CCPOSPaymentFrame', { session, text });
  return { native, frame, cancel: () => dismiss(false), session: () => active };
}
afterEach(() => { delete NativeModules.CCPOSPaymentScanner; });

it('keeps the camera open for a partial QR and delivers the finished payment only once', async () => {
  const f = cameraFixture();
  const scan = scanPhonePaymentQr();
  f.frame('wrong session', 'old');
  f.frame('partial');
  expect(f.native.showProgress).toHaveBeenCalledWith(f.session(), 1, 3);
  expect(f.native.finishScan).not.toHaveBeenCalled();
  f.frame('finished payment');
  f.frame('another payment');
  await expect(scan).resolves.toBe('finished payment');
  expect(f.native.finishScan).toHaveBeenCalledTimes(1);
  f.frame('camera already dismissed');
  expect(f.native.finishScan).toHaveBeenCalledTimes(1);
});

it('discards partial frames on cancellation and starts fresh when the cashier scans again', async () => {
  const f = cameraFixture();
  const first = scanPhonePaymentQr();
  const old = f.session();
  f.frame('partial');
  f.cancel();
  await expect(first).resolves.toBeNull();
  const second = scanPhonePaymentQr();
  f.frame('previous payment', old);
  f.frame('new payment');
  await expect(second).resolves.toBe('new payment');
});

it('closes the camera on unreadable frames and returns only the decoder’s user-facing error', async () => {
  const f = cameraFixture();
  const scan = scanPhonePaymentQr();
  f.frame('invalid');
  await expect(scan).rejects.toThrow('This payment QR is incomplete.');
  expect(f.native.finishScan).toHaveBeenCalledTimes(1);
});
