import type { DevTransport } from '../till/dev-transport';
import type { RawFetch } from '../till/http';
import type { OpenTill } from '../till/open';

/** The self-test's steps, in the order they run. */
export const STEP_IDS = [
  'engine',
  'polyfills',
  'random',
  'hash',
  'curve',
  'library',
  'nfc',
  'redirect',
  'open',
  'sale',
  'settle',
] as const;
export type StepId = (typeof STEP_IDS)[number];

export interface StepResult {
  id: StepId;
  ok: boolean;
  /** how long the step took, ms */
  ms: number;
  /** one line: what passed, or what failed */
  detail: string;
}

/** The globals the probes read (globalThis on the phone; fakes in tests). */
export interface PolyfillGlobal {
  crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
  TextEncoder?: new () => { encode(s: string): Uint8Array };
  TextDecoder?: new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) => {
    decode(b: Uint8Array): string;
  };
  URL?: new (u: string) => { protocol: string; hostname: string; port: string; pathname: string; search: string };
  /** set by src/polyfills.js: which text classes are Hermes's own and which the polyfill's */
  __ccposPolyfills?: { textEncoder: string; textDecoder: string };
}

/** One refused answer, as the guard saw it. */
export interface RedirectAnswer {
  status: number;
  url: string;
  /** the URL is the one that was asked */
  original: boolean;
}

/** What the redirect probe found (order 04; slice 2.5 added what the guard was answered). */
export interface RedirectFindings {
  /** the URL React Native reported for a plain answer from /ping ('' when none) */
  pingUrl: string;
  /** the guard took that plain answer */
  pingAccepted: boolean;
  /** what the guard did with a GET answered 302, and with a POST answered 307 */
  guard302: 'refused' | 'accepted' | 'error';
  guard307post: 'refused' | 'accepted' | 'error';
  /** what the guard was answered when it refused: the status and the URL fetch reported, and whether that URL is the
   * one that was asked (slice 2.5: the phone must hand the 3xx itself to JavaScript). null when it did not refuse. */
  got302: RedirectAnswer | null;
  got307post: RedirectAnswer | null;
  /** what fetch itself did with redirect: 'error' and with redirect: 'manual' on a 302 */
  rawError: string;
  rawManual: string;
  /** whether any request reached the redirect's target, and how many of each */
  followed: boolean;
  landedGet: number;
  landedPost: number;
  /** a POST reached the target with its body */
  postBodyForwarded: boolean;
}

export interface SelfTestReport {
  v: 1;
  app: 'cashu-card-pos';
  slice: '0.2';
  platform: string;
  /** when the run ended, ms since the epoch */
  at: number;
  pass: boolean;
  steps: StepResult[];
  redirect: RedirectFindings | null;
  /** the journal the till opened over */
  journal?: string;
  /** whether the report reached the bench server (false when the post failed) */
  reported?: boolean;
}

/** Which journal the self-test's till opens over. */
export type SelfTestJournal = 'memory' | 'sqlcipher';

/** Everything the self-test takes from the device: real on the phone (src/selftest/device.ts), fakes in tests. */
export interface SelfTestDeps {
  platform: string;
  now: () => number;
  global: PolyfillGlobal;
  /** HermesInternal is present */
  hermes: boolean;
  /** RN$Bridgeless is true: the new architecture */
  bridgeless: boolean;
  /** react-native-get-random-values has its native module and does not take its Math.random path */
  nativeRandom: boolean;
  /** NativeModules.NfcManager is present */
  nfcLinked: boolean;
  nfcSupported: () => Promise<boolean>;
  /** React Native's own fetch */
  rawFetch: RawFetch;
  /** the bench server (DEV_BENCH_URL) */
  benchUrl: string;
  saleId: string;
  saleSats: number;
  pin: string;
  /** the https name of the mint the till takes */
  mintName: string;
  makeTransport: () => DevTransport;
  openTill: () => Promise<OpenTill>;
  /** which journal the till opens over, for the report: 'MemoryJournal' when not given */
  journalKind?: string;
  log: (line: string) => void;
  report: (json: string) => Promise<void>;
}
