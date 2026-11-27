jest.mock('react-native-nfc-manager', () => {
  class UserCancel extends Error {}
  class UnsupportedFeature extends Error {}
  class RadioDisabled extends Error {}
  return {
    __esModule: true,
    default: {
      setEventListener: jest.fn(),
      start: jest.fn(async () => undefined),
      isSupported: jest.fn(async () => true),
      isEnabled: jest.fn(async () => true),
      registerTagEvent: jest.fn(async () => undefined),
      unregisterTagEvent: jest.fn(async () => undefined),
      requestTechnology: jest.fn(async () => 'IsoDep'),
      setTimeout: jest.fn(async () => undefined),
      sendCommandAPDUIOS: jest.fn(async () => ({ response: [3, 1], sw1: 0x90, sw2: 0 })),
      isoDepHandler: { transceive: jest.fn(async () => [3, 1, 0x90, 0]) },
      cancelTechnologyRequest: jest.fn(async () => undefined),
      setAlertMessageIOS: jest.fn(async () => undefined),
      invalidateSessionWithErrorIOS: jest.fn(async () => undefined),
    },
    NfcEvents: { SessionClosed: 'NfcManagerSessionClosed' },
    NfcTech: { IsoDep: 'IsoDep' },
    NfcAdapter: { FLAG_READER_NFC_A: 1, FLAG_READER_SKIP_NDEF_CHECK: 128 },
    NfcError: { UserCancel, UnsupportedFeature, RadioDisabled },
  };
});

import NfcManager, { NfcError, NfcTech } from 'react-native-nfc-manager';
import { phoneReader } from '../src/till/nfc-reader';
import { releaseReader } from '../src/till/reader';
import { tapSession } from '../src/till/tap-session';

const driver = jest.mocked(NfcManager);

afterEach(() => { jest.clearAllMocks(); });

it('keeps NDEF disabled across the sale, including PIN entry, tap gaps and the receipt', async () => {
  const reader = phoneReader('android');
  const leaveSale = reader.enterSaleScreen!();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(driver.registerTagEvent).toHaveBeenCalledWith({ isReaderModeEnabled: true, readerModeFlags: 129 });
  expect(driver.requestTechnology).not.toHaveBeenCalled();
  const transport = reader.transport();
  for (const prompt of ['Quote', 'Pay']) {
    await transport.begin!(prompt);
    await transport.end!();
    expect(driver.unregisterTagEvent).not.toHaveBeenCalled();
  }
  expect(driver.registerTagEvent).toHaveBeenCalledTimes(1);
  leaveSale();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(driver.unregisterTagEvent).toHaveBeenCalledTimes(1);
  expect(phoneReader('ios').enterSaleScreen).toBeUndefined();
});

it('does not release Android reader mode underneath a tap if the sale screen closes first', async () => {
  const reader = phoneReader('android');
  const leaveSale = reader.enterSaleScreen!();
  const transport = reader.transport();
  await transport.begin!('Pay');
  leaveSale();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(driver.unregisterTagEvent).not.toHaveBeenCalled();
  await transport.end!();
  expect(driver.unregisterTagEvent).toHaveBeenCalledTimes(1);
});

it('cancels a tap while Android is registering without opening IsoDep afterwards', async () => {
  let ready!: () => void;
  let registrationStarted!: () => void;
  const started = new Promise<void>(resolve => { registrationStarted = resolve; });
  driver.registerTagEvent.mockImplementationOnce(() => new Promise<void>(resolve => {
    ready = resolve;
    registrationStarted();
  }));
  const transport = phoneReader('android').transport();
  const opening = expect(transport.begin!('Pay')).rejects.toMatchObject({ kind: 'stopped' });
  await started;
  const closing = transport.end!();
  ready();
  await Promise.all([opening, closing]);
  expect(driver.requestTechnology).not.toHaveBeenCalled();
  expect(driver.unregisterTagEvent).toHaveBeenCalledTimes(1);
});

it('waits for a departing sale to unregister before opening the next foreground reader', async () => {
  let finishUnregister!: () => void;
  let unregisterStarted!: () => void;
  const started = new Promise<void>(resolve => { unregisterStarted = resolve; });
  driver.unregisterTagEvent.mockImplementationOnce(() => new Promise<void>(resolve => {
    finishUnregister = resolve;
    unregisterStarted();
  }));
  const reader = phoneReader('android');
  const leaveFirst = reader.enterSaleScreen!();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  leaveFirst();
  await started;
  const leaveSecond = reader.enterSaleScreen!();
  const transport = reader.transport();
  const opening = transport.begin!('Pay');
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(driver.requestTechnology).not.toHaveBeenCalled();
  expect(driver.registerTagEvent).toHaveBeenCalledTimes(1);
  finishUnregister();
  await opening;
  expect(driver.registerTagEvent).toHaveBeenCalledTimes(2);
  expect(driver.requestTechnology).toHaveBeenCalledTimes(1);
  leaveSecond();
  await transport.end!();
  expect(driver.unregisterTagEvent).toHaveBeenCalledTimes(2);
});

it('uses the physical adapter in release and checks the device each time', async () => {
  const reader = releaseReader();
  expect(reader.kind).toBe('nfc');
  expect(await reader.available()).toBe(true);
  driver.isEnabled.mockResolvedValueOnce(false);
  expect(await reader.available()).toBe(false);
  driver.isSupported.mockResolvedValueOnce(false);
  expect(await reader.available()).toBe(false);
});

it.each(['ios', 'android'] as const)('%s reads two taps, including both card status bytes', async platform => {
  const t = phoneReader(platform).transport();
  const command = Uint8Array.from([0xb0, 1, 0, 0, 0]);
  for (const prompt of ['Read the card', 'Hold the same card again']) {
    await t.begin!(prompt);
    expect(driver.requestTechnology).toHaveBeenLastCalledWith(NfcTech.IsoDep, {
      alertMessage: prompt, isReaderModeEnabled: true, readerModeFlags: 129,
    });
    expect(await t.transceive(command)).toEqual(Uint8Array.from([3, 1, 0x90, 0]));
    await t.end!({ message: 'Done' });
    await expect(t.transceive(command)).rejects.toMatchObject({ kind: 'stopped' });
  }
  if (platform === 'ios') {
    expect(driver.sendCommandAPDUIOS).toHaveBeenCalledWith(Array.from(command));
    expect(driver.setAlertMessageIOS).toHaveBeenCalledWith('Done');
  } else {
    expect(driver.isoDepHandler.transceive).toHaveBeenCalledWith(Array.from(command));
    expect(driver.setTimeout).toHaveBeenCalledWith(5_000);
  }
});

it('cancels a pending scan, drains it, then lets a different job use the radio', async () => {
  const reader = phoneReader('android');
  let cancelScan!: (error: Error) => void;
  let requested!: () => void;
  const started = new Promise<void>(r => { requested = r; });
  driver.requestTechnology.mockImplementationOnce(() => new Promise((_res, reject) => {
    cancelScan = reject;
    requested();
  }));
  // The first cancellation can reach Android before its asynchronous reader registration.
  driver.cancelTechnologyRequest.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
    cancelScan(new NfcError.UserCancel());
  });
  const abort = new AbortController();
  const first = tapSession(reader.transport(), { signal: abort.signal, onWait: jest.fn(), onCard: jest.fn() });
  const attempt = first.begin!('Read card');
  const cancelled = expect(attempt).rejects.toMatchObject({ kind: 'stopped' });
  await started;
  abort.abort();
  await cancelled;
  const next = reader.transport();
  await next.begin!('Return to card');
  expect(driver.requestTechnology).toHaveBeenCalledTimes(2);
  expect(driver.cancelTechnologyRequest).toHaveBeenCalledTimes(2);
  await next.end!();
});

it('ignores repeated end on a finished transport while a different card is in the field', async () => {
  const reader = phoneReader('ios');
  const sale = reader.transport();
  await sale.begin!('Read sale');
  await sale.end!();
  const owed = reader.transport();
  await owed.begin!('Read for return');
  await sale.end!();
  expect(driver.cancelTechnologyRequest).toHaveBeenCalledTimes(1);
  await owed.end!();
});

it('releases a detected tag if setting its Android timeout fails', async () => {
  const reader = phoneReader('android');
  const first = reader.transport();
  driver.setTimeout.mockRejectedValueOnce(new Error('tag left'));
  await expect(first.begin!('Hold card')).rejects.toThrow('tag left');
  expect(driver.cancelTechnologyRequest).toHaveBeenCalled();
  const next = reader.transport();
  await next.begin!('Hold again');
  await next.end!();
});

it('maps a dismissed native iOS sheet to cancellation without opening it again', async () => {
  driver.requestTechnology.mockRejectedValueOnce(new NfcError.UserCancel());
  const t = phoneReader('ios').transport();
  await expect(t.begin!('Hold card')).rejects.toMatchObject({ kind: 'stopped' });
  expect(driver.requestTechnology).toHaveBeenCalledTimes(1);
});


it('waits for native iOS invalidation and sheet dismissal without delaying the card result', async () => {
  jest.useFakeTimers();
  try {
    const reader = phoneReader('ios');
    const tap = reader.transport();
    await tap.begin!('Hold card');
    const visible = jest.fn();
    reader.afterScanSheet!(visible);
    await tap.end!();
    jest.advanceTimersByTime(800);
    expect(visible).not.toHaveBeenCalled();
    const [event, callback] = driver.setEventListener.mock.calls[0];
    expect(event).toBe('NfcManagerSessionClosed');
    (callback as () => void)();
    jest.advanceTimersByTime(1499);
    (callback as () => void)(); // Some bridges repeat the notification. The first dismissal deadline stands.
    expect(visible).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(visible).toHaveBeenCalledTimes(1);
    const late = jest.fn();
    reader.afterScanSheet!(late);
    expect(late).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});

it('falls back if iOS drops its close event and cancels a departed receipt', async () => {
  jest.useFakeTimers();
  try {
    const reader = phoneReader('ios');
    const tap = reader.transport();
    await tap.begin!('Hold card');
    await tap.end!();
    const gone = jest.fn();
    const present = jest.fn();
    const cancel = reader.afterScanSheet!(gone);
    reader.afterScanSheet!(present);
    cancel();
    jest.advanceTimersByTime(3499);
    expect(present).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(present).toHaveBeenCalledTimes(1);
    expect(gone).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});
