jest.mock('react-native-keychain', () => ({
  __esModule: true,
  isPasscodeAuthAvailable: jest.fn(async () => false),
  hasGenericPassword: jest.fn(async () => true),
  setGenericPassword: jest.fn(async () => ({ service: 's', storage: 'keychain' })),
  getGenericPassword: jest.fn(async () => false),
  resetGenericPassword: jest.fn(async () => true),
  ACCESS_CONTROL: { BIOMETRY_ANY_OR_DEVICE_PASSCODE: 'BiometryAnyOrDevicePasscode' },
  ACCESSIBLE: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AccessibleAfterFirstUnlockThisDeviceOnly',
  },
  STORAGE_TYPE: { AES_GCM: 'KeystoreAESGCM', AES_GCM_NO_AUTH: 'KeystoreAESGCM_NoAuth' },
  SECURITY_LEVEL: { SECURE_SOFTWARE: 1 },
}));

import { GATE_WORDS } from '../src/till/gate';
import { ANDROID_CANCEL_CODES, GATE_ITEM, gateCancelled, keychainGate } from '../src/till/store/native';

const K = jest.requireMock('react-native-keychain') as {
  isPasscodeAuthAvailable: jest.Mock;
  hasGenericPassword: jest.Mock;
  setGenericPassword: jest.Mock;
  getGenericPassword: jest.Mock;
};
const FOUND = { service: GATE_ITEM, username: 'ccpos', password: 'gate', storage: 'keychain' };
beforeEach(() => {
  K.isPasscodeAuthAvailable.mockReset().mockResolvedValue(true);
  K.hasGenericPassword.mockReset().mockResolvedValue(true);
  K.setGenericPassword.mockReset().mockResolvedValue({ service: GATE_ITEM, storage: 'keychain' });
  K.getGenericPassword.mockReset().mockResolvedValue(FOUND);
});
/** Every options object passed to the keychain. */
const optionsPassed = (): Array<Record<string, unknown>> => [
  ...K.hasGenericPassword.mock.calls.map((c) => c[0] as Record<string, unknown>),
  ...K.setGenericPassword.mock.calls.map((c) => c[2] as Record<string, unknown>),
  ...K.getGenericPassword.mock.calls.map((c) => c[0] as Record<string, unknown>),
];

describe("the phone's owner check over the keychain", () => {
  it('a phone with no passcode is refused, and nothing is read or written', async () => {
    K.isPasscodeAuthAvailable.mockResolvedValue(false);
    const gate = keychainGate();
    expect(await gate.available()).toBe(false);
    expect(await gate.check('Confirm.')).toEqual({
      ok: false,
      why: 'unavailable',
      words: GATE_WORDS.unavailable,
    });
    expect(K.hasGenericPassword).not.toHaveBeenCalled();
    expect(K.setGenericPassword).not.toHaveBeenCalled();
    expect(K.getGenericPassword).not.toHaveBeenCalled();
  });

  it('a passcode check that throws is no passcode, and the check does not pass', async () => {
    K.isPasscodeAuthAvailable.mockRejectedValue(new Error('no'));
    expect(await keychainGate().available()).toBe(false);
    expect((await keychainGate().check('Confirm.')).ok).toBe(false);
  });

  it("a first check makes the item, then reads it with the system's prompt", async () => {
    K.hasGenericPassword.mockResolvedValue(false);
    expect(await keychainGate().check('Confirm it is you.')).toEqual({ ok: true });
    expect(K.setGenericPassword).toHaveBeenCalledTimes(1);
    expect(K.setGenericPassword).toHaveBeenCalledWith('ccpos', 'gate', {
      service: GATE_ITEM,
      accessControl: 'BiometryAnyOrDevicePasscode',
      accessible: 'AccessibleWhenUnlockedThisDeviceOnly',
      storage: 'KeystoreAESGCM',
      authenticationPrompt: { title: 'Confirm it is you.', cancel: 'Cancel' },
    });
    expect(K.getGenericPassword).toHaveBeenCalledTimes(1);
    expect(K.getGenericPassword).toHaveBeenCalledWith({
      service: GATE_ITEM,
      accessControl: 'BiometryAnyOrDevicePasscode',
      authenticationPrompt: { title: 'Confirm it is you.', cancel: 'Cancel' },
    });
    expect(GATE_ITEM).toBe('org.cashucard.pos.gate');
  });

  it('a later check only reads, with the prompt, every time', async () => {
    expect(await keychainGate().check('Confirm.')).toEqual({ ok: true });
    expect(await keychainGate().check('Confirm.')).toEqual({ ok: true });
    expect(K.setGenericPassword).not.toHaveBeenCalled();
    expect(K.getGenericPassword).toHaveBeenCalledTimes(2);
  });

  it('a read that finds nothing fails', async () => {
    K.getGenericPassword.mockResolvedValue(false);
    expect(await keychainGate().check('Confirm.')).toEqual({
      ok: false,
      why: 'failed',
      words: GATE_WORDS.failed,
    });
  });

  it('a read that throws fails with its code; a cancel is a cancel', async () => {
    K.getGenericPassword.mockRejectedValue(Object.assign(new Error('boom'), { code: '-25293' }));
    expect(await keychainGate().check('Confirm.')).toEqual({
      ok: false,
      why: 'failed',
      words: GATE_WORDS.failed + ' (-25293)',
    });
    K.getGenericPassword.mockRejectedValue(Object.assign(new Error('x'), { code: '-128' }));
    expect(await keychainGate().check('Confirm.')).toEqual({
      ok: false,
      why: 'cancelled',
      words: GATE_WORDS.cancelled,
    });
  });

  it('a cancel is told by its code, never by its words (ENG-911)', async () => {
    const CANCELLED = { ok: false, why: 'cancelled', words: GATE_WORDS.cancelled };
    // Android, the phone in German: the sheet closed by the person (10), by its Cancel button (13), by the system (5)
    expect(ANDROID_CANCEL_CODES).toEqual([5, 10, 13]);
    for (const n of [10, 13, 5]) {
      K.getGenericPassword.mockRejectedValue(
        Object.assign(new Error('code: ' + n + ', msg: Authentifizierung abgebrochen'), { code: 'E_CRYPTO_FAILED' }),
      );
      expect(await keychainGate().check('Confirm.')).toEqual(CANCELLED);
    }
    // making the item at the first check is cancelled the same way
    K.hasGenericPassword.mockResolvedValue(false);
    K.setGenericPassword.mockRejectedValue(
      Object.assign(new Error('code: 10, msg: Authentication canceled'), { code: 'E_CRYPTO_FAILED' }),
    );
    expect(await keychainGate().check('Confirm.')).toEqual(CANCELLED);
    K.hasGenericPassword.mockResolvedValue(true);
    // another code is a failure, whatever its words say
    K.getGenericPassword.mockRejectedValue(
      Object.assign(new Error('code: 7, msg: Too many attempts. Canceled.'), { code: 'E_CRYPTO_FAILED' }),
    );
    expect(await keychainGate().check('Confirm.')).toEqual({
      ok: false,
      why: 'failed',
      words: GATE_WORDS.failed + ' (E_CRYPTO_FAILED)',
    });
    // words alone are never a cancel: no code, or a code that is not the keychain's
    K.getGenericPassword.mockRejectedValue(new Error('User canceled the operation.'));
    expect(await keychainGate().check('Confirm.')).toEqual({ ok: false, why: 'failed', words: GATE_WORDS.failed });
    expect(gateCancelled('E_UNKNOWN_ERROR', 'code: 10, msg: Authentication canceled')).toBe(false);
    expect(gateCancelled('E_CRYPTO_FAILED', 'Authentication canceled, code: 10, msg: x')).toBe(false);
    expect(gateCancelled('-128', '')).toBe(true);
  });

  it('an item that cannot be made fails, and nothing is read', async () => {
    K.hasGenericPassword.mockResolvedValue(false);
    K.setGenericPassword.mockResolvedValue(false);
    expect(await keychainGate().check('Confirm.')).toEqual({
      ok: false,
      why: 'failed',
      words: GATE_WORDS.failed,
    });
    expect(K.getGenericPassword).not.toHaveBeenCalled();
  });

  it('cloudSync is never passed', async () => {
    K.hasGenericPassword.mockResolvedValueOnce(false);
    await keychainGate().check('Confirm.');
    await keychainGate().check('Confirm.');
    expect(optionsPassed().length).toBeGreaterThan(0);
    for (const o of optionsPassed()) {
      expect(Object.prototype.hasOwnProperty.call(o, 'cloudSync')).toBe(false);
    }
  });
});
