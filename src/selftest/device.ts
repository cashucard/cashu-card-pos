import { NativeModules, Platform } from 'react-native';
import NfcManager from 'react-native-nfc-manager';
import {
  DEV_APDU_TIMEOUT_MS,
  DEV_BENCH_URL,
  DEV_CARDSIM_URL,
  DEV_MINT_NAME,
  DEV_PIN,
  DEV_ROUTES,
  DEV_SALE_SATS,
} from '../till/dev-config';
import { cardsimTransport } from '../till/dev-transport';
import { guardedFetch, MAX_BODY_BYTES, routedFetch, type RawFetch } from '../till/http';
import { openTill, type OpenTill, type TillOptions } from '../till/open';
import { deviceStoreDeps } from '../till/store/device';
import { labNames } from '../till/store/types';
import { wipeLabStore } from '../till/store/wipe';
import { openStoredTill } from '../till/stored-till';
import type { PolyfillGlobal, SelfTestDeps, SelfTestJournal } from './types';

declare const __DEV__: boolean;

/** The development wiring was asked for outside a development build. */
export class NotDevelopmentError extends Error {
  constructor() {
    super("the self-test's development wiring is for development builds only");
    this.name = 'NotDevelopmentError';
    Object.setPrototypeOf(this, NotDevelopmentError.prototype);
  }
}

/** Everything the self-test takes from this phone: React Native's fetch, the native modules, the development settings. */
export function deviceDeps(dev: boolean = __DEV__, journal: SelfTestJournal = 'memory'): SelfTestDeps {
  if (!dev) throw new NotDevelopmentError();
  const g = globalThis as unknown as PolyfillGlobal & {
    HermesInternal?: unknown;
    RN$Bridgeless?: unknown;
    nativeCallSyncHook?: unknown;
  };
  // read once, then called as a plain function: a method call would send `this` with it
  const native = (globalThis as unknown as { fetch: RawFetch }).fetch;
  const raw: RawFetch = (url, init) => native(url, init);
  const bridgeless = g.RN$Bridgeless === true;
  const tillOptions: TillOptions = {
    http: routedFetch(DEV_ROUTES, guardedFetch(raw, MAX_BODY_BYTES)),
    mints: [DEV_MINT_NAME],
  };

  return {
    platform: Platform.OS,
    now: () => Date.now(),
    global: g,
    hermes: typeof g.HermesInternal === 'object' && g.HermesInternal !== null,
    bridgeless,
    // the same test react-native-get-random-values makes before it falls back to Math.random
    nativeRandom:
      NativeModules.RNGetRandomValues != null &&
      (bridgeless || typeof g.nativeCallSyncHook !== 'undefined'),
    nfcLinked: NativeModules.NfcManager != null,
    nfcSupported: () => NfcManager.isSupported(),
    rawFetch: raw,
    benchUrl: DEV_BENCH_URL,
    saleId: 'selftest-' + Date.now(),
    saleSats: DEV_SALE_SATS,
    pin: DEV_PIN,
    mintName: DEV_MINT_NAME,
    makeTransport: () => cardsimTransport(DEV_CARDSIM_URL, raw, DEV_APDU_TIMEOUT_MS),
    openTill: () => (journal === 'memory' ? openTill(tillOptions) : openSelftestStore(tillOptions, dev)),
    journalKind: journal === 'memory' ? 'MemoryJournal' : 'SQLCipher journal',
    log: (line) => console.log(line),
    report: async (json) => {
      const r = await raw(DEV_BENCH_URL + '/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      });
      if (r.status !== 200) {
        throw new Error('the bench server answered ' + r.status);
      }
    },
  };
}

/** The self-test's till over a fresh SQLCipher store of its own (lab-selftest.db), wiped first. */
async function openSelftestStore(o: TillOptions, dev: boolean): Promise<OpenTill> {
  const store = deviceStoreDeps();
  const names = labNames('selftest');
  await wipeLabStore(store, names, dev);
  const out = await openStoredTill(store, { ...o, names });
  if (out.kind !== 'ready') {
    throw new Error('the journal store is ' + out.kind + ('why' in out ? ': ' + out.why : ''));
  }
  return out.value;
}
