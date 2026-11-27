import type { AppReport, AppWiring } from '../app/wiring';
import { deviceRawFetch } from '../lab/device';
import type { AppPlan } from '../lab/plan';
import { DEV_BENCH_URL, DEV_MINT_NAME, DEV_ROUTES } from '../till/dev-config';
import { benchGate } from '../till/guarded';
import { guardedFetch, MAX_BODY_BYTES, routedFetch, type RawFetch } from '../till/http';
import { cardsimReader } from '../till/reader';
import { writeRecoveryCopy } from '../app/backup-files';
import { createTillService } from '../till/service';
import { TILL_SETTINGS } from '../till/settings';
import { deviceStoreDeps } from '../till/store/device';
import { keychainGate } from '../till/store/native';
import { TILL_NAMES } from '../till/store/types';
import { DevOnlyError } from '../till/store/wipe';
import { faultyReader } from './card-faults';
import { deviceSchedule, payoutForeground } from '../app/app-state';
import { shareText } from '../app/share';
import type { TillReport } from '../till/settle';
import { faultyHttp } from './mint-faults';
import { faultyGeneration, faultyJournal, faultyKeep, refusalWindow, type DevRecordFaults } from './record-faults';
import type { Journal } from 'cashucard';
import type { ActivityReport } from '../app/activity';
import { fillPayments, fillSales, filledJournal, onceWith } from './record-fill';

declare const __DEV__: boolean;

/** The till over this Mac's bench: development builds only (throws DevOnlyError otherwise, before touching anything). */
export function devAppWiring(plan: AppPlan, dev: boolean = __DEV__): AppWiring {
  if (!dev) {
    throw new DevOnlyError();
  }
  const raw = deviceRawFetch();
  const store = deviceStoreDeps();
  const mintHttp = routedFetch(DEV_ROUTES, guardedFetch(raw, MAX_BODY_BYTES));
  const record: DevRecordFaults | null = plan.record
    ? { failTapWrites: plan.record.failTapWrites, holdKeeps: plan.record.holdKeeps }
    : null;
  const devEvent = benchEvent(raw, DEV_BENCH_URL);
  /** whether a sale is being opened now: the generation's refusal may count from then (read once the service exists) */
  let saleRunning = (): boolean => false;
  /** development only (slice 2.4): whether a generation handed to the secure store is refused now, or null */
  const refuseGeneration =
    plan.generation === undefined || plan.generation.refuseMs === 0
      ? null
      : refusalWindow(plan.generation.refuseMs, plan.generation.fromSale === 1, () => saleRunning(), () => Date.now());
  /** whether a card tap runs now: the record's write fault applies only then (read once the service exists) */
  let tapOpen = (): boolean => false;
  /** development only: the plan's synthetic payments, written once into the record before the library first reads it */
  const fillCount = plan.fill === undefined ? 0 : plan.fill.payments;
  /** development only (slice 2.3): the plan's synthetic sales, which the library can archive */
  const salesCount = plan.archive === undefined ? 0 : plan.archive.sales;
  /** whether the till's archive holds a row of an id: the till hands it with the journal (slice 2.3b) */
  let archived = async (_id: string): Promise<boolean> => false;
  const fillOnce =
    fillCount === 0 && salesCount === 0
      ? null
      : onceWith(async (j: Journal) => {
          if (fillCount > 0) {
            const t0 = Date.now();
            const added = await fillPayments(j, fillCount);
            devEvent({ kind: 'dev-fault', fault: 'filled', rows: fillCount, added, ms: Date.now() - t0 });
          }
          if (salesCount > 0) {
            const t1 = Date.now();
            // never a sale whose id the archive holds (slice 2.3b)
            const added = await fillSales(j, salesCount, () => Date.now(), (id) => archived(id));
            devEvent({ kind: 'dev-fault', fault: 'filled-sales', sales: salesCount, added, ms: Date.now() - t1 });
          }
        });
  const service = createTillService({
    inForeground: payoutForeground,
    writeRecoveryCopy,
    store,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: plan.mint
      ? faultyHttp(
          mintHttp,
          { dropSwaps: plan.mint.dropSwaps, downMs: plan.mint.downMs, hideRestores: plan.mint.hideRestores },
          () => Date.now(),
          dev,
        )
      : mintHttp,
    now: () => Date.now(),
    log: (l) => console.log(l),
    autoArchive: plan.archive === undefined ? true : plan.archive.auto,
    onArchive: (n, scope) => devEvent({ kind: 'archive', scope, ...n }),
    devJournal:
      record === null && fillOnce === null
        ? undefined
        : (j, has) => {
            archived = has;
            const filled = fillOnce === null ? j : filledJournal(j, fillOnce, dev);
            return record === null ? filled : faultyJournal(filled, record, () => tapOpen(), dev);
          },
    devKeep:
      record === null
        ? undefined
        : (keep) => faultyKeep(keep, record, (amount) => devEvent({ kind: 'dev-fault', fault: 'keep-held', amount }), dev),
    devGeneration:
      refuseGeneration === null
        ? undefined
        : (g) =>
            faultyGeneration(g, refuseGeneration, () => devEvent({ kind: 'dev-fault', fault: 'generation-refused' }), dev),
  });
  tapOpen = () => service.queue.tapOpen();
  saleRunning = () => service.queue.running() === 'sale';
  const gate =
    plan.gate === 'device'
      ? keychainGate()
      : plan.gate === 'bench-allow'
        ? benchGate('allow')
        : benchGate('deny');
  return {
    mode: 'development',
    service,
    gate,
    reader: plan.card
      ? faultyReader(cardsimReader(raw, dev), { absentTaps: plan.card.absentTaps, dropSigns: plan.card.dropSigns }, dev)
      : cardsimReader(raw, dev),
    report: benchReporter(raw, DEV_BENCH_URL),
    devMintPreset: DEV_MINT_NAME,
    now: () => Date.now(),
    schedule: deviceSchedule(),
    share: shareText,
    reportTill: benchTillReporter(raw, DEV_BENCH_URL),
    reportActivity: benchActivityReporter(raw, DEV_BENCH_URL),
  };
}

/** Posts each report to the bench as an app event; never throws, never waits. */
export function benchReporter(raw: RawFetch, bench: string): (r: AppReport) => void {
  return (r: AppReport): void => {
    const post = async (): Promise<void> => {
      const answer = await raw(bench + '/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'app', ...r }),
      });
      if (answer.status !== 200) {
        throw new Error('report not delivered');
      }
    };
    void post().catch(() => {
      console.log('report not delivered');
    });
  };
}

/** Posts one development event to the bench's /event; never throws, never waits. */
export function benchEvent(raw: RawFetch, bench: string): (e: Record<string, unknown>) => void {
  return (e: Record<string, unknown>): void => {
    const post = async (): Promise<void> => {
      const answer = await raw(bench + '/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(e),
      });
      if (answer.status !== 200) {
        throw new Error('event not delivered');
      }
    };
    void post().catch(() => {
      console.log('event not delivered');
    });
  };
}

/** The till's report after each settle, posted to the bench as an event of kind 'till'. */
export function benchTillReporter(raw: RawFetch, bench: string): (r: TillReport) => void {
  const post = benchEvent(raw, bench);
  return (r: TillReport): void => {
    post({ kind: 'till', ...r });
  };
}

/** What the Activity read, posted to the bench as an event of kind 'activity'. */
export function benchActivityReporter(raw: RawFetch, bench: string): (r: ActivityReport) => void {
  const post = benchEvent(raw, bench);
  return (r: ActivityReport): void => {
    post({ kind: 'activity', ...r });
  };
}
