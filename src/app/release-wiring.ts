import { releaseReader } from '../till/reader';
import { createTillService } from '../till/service';
import { TILL_SETTINGS } from '../till/settings';
import { deviceStoreDeps } from '../till/store/device';
import { keychainGate } from '../till/store/native';
import { TILL_NAMES } from '../till/store/types';
import { guardedFetch, MAX_BODY_BYTES, type RawFetch } from '../till/http';
import type { AppWiring } from './wiring';
import { deviceSchedule, payoutForeground } from './app-state';
import { writeRecoveryCopy } from './backup-files';
import { shareText } from './share';

/** The till on a phone: the store, the guarded mint fetch, the owner check, the NFC reader, no report.
 * What a release build logs: the service's own log is off. The store's log is console.log, so the phone's system log,
 * and it carries the card library's lines: a generation that could not be stored outside the record, a payout or a
 * mint that did not answer, a payment that could not be finished now, each with the error's message. Nothing the
 * till holds is ever written to it: no PIN, key, token, proof, Keychain value or row of the record
 * (__tests__/log-privacy.test.ts holds this for every path the tests drive). */
export function releaseWiring(): AppWiring {
  const native = (globalThis as unknown as { fetch: RawFetch }).fetch;
  const raw: RawFetch = (url, init) => native(url, init);
  const store = deviceStoreDeps();
  const service = createTillService({
    inForeground: payoutForeground,
    writeRecoveryCopy,
    store,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: guardedFetch(raw, MAX_BODY_BYTES),
    now: () => Date.now(),
    log: () => undefined,
  });
  return {
    mode: 'release',
    service,
    gate: keychainGate(),
    reader: releaseReader(),
    report: () => undefined,
    devMintPreset: null,
    now: () => Date.now(),
    schedule: deviceSchedule(),
    share: shareText,
  };
}
