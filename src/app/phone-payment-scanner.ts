import { NativeEventEmitter, NativeModules } from 'react-native';
import { createPhonePaymentFrameReader } from './phone-payment-frames';

export class PhonePaymentScannerError extends Error {}

let nextScan = 0;

/** The native scanner stays open while a moving wallet QR is assembled on this device. */
export async function scanPhonePaymentQr(): Promise<string | null> {
  const camera = NativeModules.CCPOSPaymentScanner;
  if (!camera?.scan) throw new PhonePaymentScannerError('The camera is unavailable. Paste the payment instead.');
  const session = String(++nextScan);
  const frames = createPhonePaymentFrameReader();
  let outcome: { text: string } | { error: string } | undefined;
  const listener = new NativeEventEmitter(camera).addListener('CCPOSPaymentFrame', event => {
    if (event.session !== session || outcome || typeof event.text !== 'string') return;
    try {
      const frame = frames.read(event.text);
      if (frame.kind === 'progress') {
        camera.showProgress(session, frame.received, frame.expected);
        return;
      }
      outcome = frame.kind === 'complete' ? { text: frame.text } : { error: frame.message };
    } catch {
      outcome = { error: 'This QR could not be read. Paste the payment instead.' };
    }
    camera.finishScan(session);
  });
  try {
    const completed = await camera.scan(session);
    if (!completed || !outcome) return null;
    if ('error' in outcome) throw new PhonePaymentScannerError(outcome.error);
    return outcome.text;
  } catch (error) {
    if (error instanceof PhonePaymentScannerError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'camera_denied') {
      throw new PhonePaymentScannerError('Allow camera access in Settings or paste the payment.');
    }
    throw new PhonePaymentScannerError('The camera is unavailable. Paste the payment instead.');
  } finally {
    listener.remove();
  }
}
