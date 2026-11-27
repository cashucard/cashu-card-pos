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
jest.mock('../src/till/store/device', () => ({
  deviceStoreDeps: jest.fn(() => require('./helpers/fake-store').fakeStoreDeps().deps),
}));
jest.mock('react-native-nfc-manager', () => ({
  __esModule: true,
  default: { isSupported: jest.fn(async () => false) },
}));
jest.mock('../src/lab/device', () => ({
  deviceRawFetch: jest.fn(),
  fetchDevPlan: jest.fn(),
  labDeps: jest.fn(),
}));
jest.mock('../src/dev/app-wiring', () => ({
  devAppWiring: jest.fn(),
  benchReporter: jest.fn(),
}));

import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import App from '../App';
import { releaseWiring } from '../src/app/release-wiring';
import type { AppReport } from '../src/app/wiring';
import { devAppWiring } from '../src/dev/app-wiring';
import { fetchDevPlan } from '../src/lab/device';
import { GATE_WORDS } from '../src/till/gate';
import { deviceStoreDeps } from '../src/till/store/device';
import { fakeStoreDeps } from './helpers/fake-store';
import { has, press, textOf, until } from './helpers/render';

const R: AppReport = {
  at: 1, boot: 'ready', store: null, screen: 'sale', firstRun: false,
  mints: [{ url: 'https://mint.test', status: 'ok' }], gate: null, note: null, sale: null,
};
const g = globalThis as unknown as { fetch: unknown; __DEV__: boolean };
const realFetch = g.fetch;
afterEach(() => {
  g.fetch = realFetch;
});

describe('the release path', () => {
  it("the release wiring takes the phone's own owner check", async () => {
    const w = releaseWiring();
    expect(w.mode).toBe('release');
    expect(w.devMintPreset).toBeNull();
    expect(await w.gate.available()).toBe(false);
    expect(await w.gate.check('x')).toEqual({
      ok: false,
      why: 'unavailable',
      words: GATE_WORDS.unavailable,
    });
  });

  it('the release wiring asks mints through the guarded fetch', async () => {
    const fetch = jest.fn(async (_url: string) => ({
      status: 200,
      url: 'https://other.test/v1/info',
      text: async () => '{}',
    }));
    g.fetch = fetch;
    const w = releaseWiring();
    const r = await w.service.checkMint('mint.test');
    const reach = r.lines.find((l) => l.id === 'reach');
    expect(reach).toBeDefined();
    expect(reach?.ok).toBe(false);
    expect((reach === undefined ? '' : reach.words).toLowerCase()).toContain('redirect');
    expect(fetch.mock.calls[0][0]).toBe('https://mint.test/v1/info');
  });

  it('the release wiring uses NFC and detects a phone without a reader', async () => {
    expect(releaseWiring().reader.kind).toBe('nfc');
    expect(await releaseWiring().reader.available()).toBe(false);
  });

  it('the release wiring reports nothing, to no one', async () => {
    const fetch = jest.fn();
    g.fetch = fetch;
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const w = releaseWiring();
    w.report(R);
    await new Promise<void>((r) => {
      setTimeout(() => r(), 0);
    });
    expect(log).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('the release wiring imports nothing of development', () => {
    const fs = require('fs') as { readFileSync(path: string, encoding: string): string };
    const src = fs.readFileSync('src/app/release-wiring.ts', 'utf8');
    expect(src).not.toMatch(/from '\.\.\/(dev|lab|selftest)\//);
    expect(src.includes('dev-config')).toBe(false);
    expect(src.includes('benchGate')).toBe(false);
    expect(src.includes('keychainGate()')).toBe(true);
    expect(src.includes('guardedFetch(raw, MAX_BODY_BYTES)')).toBe(true);
    expect(src.includes('releaseReader()')).toBe(true);
  });

  it("a release build's App is the till, never the development root", async () => {
    const before = g.__DEV__;
    g.__DEV__ = false;
    try {
      const storage = fakeStoreDeps().deps;
      jest.mocked(deviceStoreDeps).mockReturnValueOnce(storage).mockReturnValueOnce(storage);
      const previousTill = releaseWiring().service;
      await previousTill.open();
      await previousTill.close();

      let tree!: ReactTestRenderer;
      await act(async () => {
        tree = renderer.create(<App versionName="4.2.1" buildNumber="70001" />);
      });
      await until(tree, 'firstrun-title');
      expect(has(tree, 'firstrun-dev')).toBe(false);
      expect(fetchDevPlan).not.toHaveBeenCalled();
      expect(devAppWiring).not.toHaveBeenCalled();
      await press(tree, 'firstrun-open');
      await press(tree, 'home-settings');
      await press(tree, 'settings-about');
      expect(textOf(tree, 'about-app')).toBe('Cashu Card POS 4.2.1 (70001)');
      await act(async () => {
        tree.unmount();
      });
    } finally {
      g.__DEV__ = before;
    }
  });
});
