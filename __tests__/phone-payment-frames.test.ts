import { createPhonePaymentFrameReader } from '../src/app/phone-payment-frames';
import f from './fixtures/foxy-phone-payment-qr.json';

const complete = { kind: 'complete', text: f.token };

test('ordinary Cashu tokens and NUT-18 replies reach payment validation intact', () => {
  for (const text of [f.token, '{"id":"test","mint":"https://fixture.invalid"}']) {
    expect(createPhonePaymentFrameReader().read(text)).toEqual({ kind: 'complete', text });
  }
});

test('Foxy frames decode out of order with duplicates and uppercase camera text', () => {
  const reader = createPhonePaymentFrameReader();
  for (let i = f.count - 1; i > 0; i--) {
    const progress = { kind: 'progress', received: f.count - i, expected: f.count };
    expect(reader.read(f.frames[i].toUpperCase())).toEqual(progress);
    expect(reader.read(f.frames[i])).toEqual(progress);
  }
  expect(reader.read(f.frames[0])).toEqual(complete);
});

test('binary crawB in a UR message decodes to the original spendable token format', () => {
  expect(createPhonePaymentFrameReader().read(f.binaryFrame)).toEqual(complete);
});

test('preserves long numeric QR text and reads upper-case UR frames beyond byte-mode QR capacity', () => {
  const digits = '0'.repeat(4000);
  expect(createPhonePaymentFrameReader().read(digits)).toEqual({ kind: 'complete', text: digits });
  expect(f.largeFrame.length).toBeGreaterThan(3000);
  expect(createPhonePaymentFrameReader().read(f.largeFrame.toUpperCase())).toEqual({ kind: 'complete', text: '0'.repeat(1600) });
});

test('a scanner joining after every original frame has passed recovers Foxy’s fountain token', () => {
  const reader = createPhonePaymentFrameReader();
  let recovered = false;
  for (const frame of f.frames.slice(f.count)) {
    const result = reader.read(frame);
    if (result.kind === 'complete') {
      expect(result).toEqual(complete);
      recovered = true;
      break;
    }
    expect(result.kind).toBe('progress');
  }
  expect(recovered).toBe(true);
});

test('one-part UR:bytes scans without retaining state; another token cannot replace an in-progress message', () => {
  const reader = createPhonePaymentFrameReader();
  expect(reader.read(f.singleFrame)).toEqual({ kind: 'complete', text: f.singleToken });
  expect(reader.read(f.frames[0])).toEqual({ kind: 'progress', received: 1, expected: f.count });
  for (const other of [f.singleFrame, f.singleToken, 'ur:crypto-psbt/test']) {
    expect(reader.read(other)).toEqual({ kind: 'progress', received: 1, expected: f.count });
  }
});

test('rejects an invalid checksum, invalid Bytewords, a different type, excessive bounds and a mismatched frame header', () => {
  const invalids = [f.frames[0].slice(0, -2) + (f.frames[0].endsWith('ae') ? 'ad' : 'ae'),
    f.frames[0].replace('1-', '2-'), f.frames[0].replace(/-\d+\//, '-9999/'),
    'ur:bytes/not-a-frame', 'ur:bytes/fwrtpeadsfwllu', 'ur:crypto-psbt/aabbccdd', 'ur:bytes/' + 'ae'.repeat(2500)];
  for (const text of invalids) expect(createPhonePaymentFrameReader().read(text).kind).toBe('error');
});
