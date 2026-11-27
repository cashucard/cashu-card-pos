import type { ActivityReport } from './activity';
import type { BootState } from './boot';
import type { RouteName } from './nav';
import type { DeviceGate } from '../till/gate';
import type { CardReader } from '../till/reader';
import type { SaleReport } from '../till/sale-machine';
import type { TillService } from '../till/service';
import type { ScheduleSource, TillReport } from '../till/settle';

export const LIBRARY_VERSION = '0.4.0';

/** What the app shows, for the host (development) and nothing else. */
export interface AppReport {
  at: number;
  boot: BootState['kind'];
  /** the store's state while the till is not open (journal-missing, ...); else null */
  store: string | null;
  /** the route shown once the till is open; else null */
  screen: RouteName | null;
  firstRun: boolean | null;
  mints: Array<{ url: string; status: 'ok' | 'refused' }>;
  /** the last device check's outcome in this run */
  gate: 'passed' | 'refused' | null;
  /** the note on the screen, if any */
  note: string | null;
  /** the sale's summary while the sale screen is shown; else null */
  sale: SaleReport | null;
}
export const REPORT_KEYS: readonly string[] = ['at', 'boot', 'store', 'screen', 'firstRun', 'mints', 'gate', 'note', 'sale'];

/** Everything the app takes from the device. Built once: by releaseWiring() or, in development, devAppWiring(). */
export interface AppWiring {
  mode: 'development' | 'release';
  service: TillService;
  gate: DeviceGate;
  reader: CardReader;
  report: (r: AppReport) => void;
  /** the test mint's address in a development build; null in a release build */
  devMintPreset: string | null;
  now: () => number;
  /** the settle schedule's ear on the app's front, and its timer; absent: only the launch's and the card jobs'
   * settles run (tests) */
  schedule?: ScheduleSource;
  /** development only: the till's state for the host after each settle; a release build has none */
  reportTill?: (r: TillReport) => void;
  /** development only: what the Activity read, after each reading; a release build has none */
  reportActivity?: (r: ActivityReport) => void;
  /** hands text to the phone's share sheet (slice 2.3: the payment list); absent: Records offers no sharing */
  share?: (title: string, text: string) => Promise<void>;
}
