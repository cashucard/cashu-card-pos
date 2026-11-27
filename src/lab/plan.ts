import type { Durability } from '../till/store/db';
import type { StoreChoice } from '../till/store/open-store';

export const LAB_ACTIONS = ['burst', 'open', 'inspect', 'measure', 'wipe'] as const;
export type LabAction = (typeof LAB_ACTIONS)[number];

export interface LabPlan {
  action: LabAction;
  /** names the events and the result: 1 to 24 of a-z 0-9 - */
  run: string;
  /** the lab store, labNames(name): 1 to 16 of a-z 0-9 */
  name: string;
  /** burst: how many sales; default 20 */
  count: number;
  /** open: the merchant's choice for this one open */
  choice?: StoreChoice;
  /** default 'wal' */
  durability: Durability;
  /** measure: the timed repeats of each small step; default 200 */
  samples: number;
  /** measure: the journal sizes at which list() and a reopen are timed; default [1000, 10000] */
  sizes: number[];
}

export type AppGate = 'device' | 'bench-allow' | 'bench-deny';
export interface AppCardPlan { absentTaps: number; dropSigns: number }
export interface AppMintPlan { dropSwaps: number; downMs: number; hideRestores: number }
export interface AppRecordPlan { failTapWrites: number; holdKeeps: number }
export interface AppFillPlan { payments: number }
/** Development only (slice 2.3): `sales` synthetic delivered sales written once into the record, which the library can
 * archive; `auto` false keeps the till from archiving by itself, to time a long record before archiving. */
export interface AppArchivePlan { auto: boolean; sales: number }
/** Development only (slice 2.4): for `refuseMs` ms every generation the library hands the secure store is refused, so
 * the till stops new sales; counted from the launch, or with `fromSale` 1 from the first sale's opening of the run. */
export interface AppGenerationPlan { refuseMs: number; fromSale: number }
export interface AppPlan {
  gate: AppGate;
  card?: AppCardPlan;
  mint?: AppMintPlan;
  record?: AppRecordPlan;
  fill?: AppFillPlan;
  archive?: AppArchivePlan;
  generation?: AppGenerationPlan;
}
export type DevPlan = { mode: 'selftest' } | { mode: 'selftest-sqlcipher' } | { mode: 'lab'; lab: LabPlan } | { mode: 'app'; app: AppPlan };

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
    Object.setPrototypeOf(this, PlanError.prototype);
  }
}

const CHOICES: readonly StoreChoice[] = ['start-new', 'use-older', 'set-aside'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isWhole(v: unknown, from: number, to: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= from && v <= to;
}

/** One card switch of an app plan: 0 when absent, else a whole number from 0 to 100. */
function cardSwitch(c: Record<string, unknown>, name: 'absentTaps' | 'dropSigns'): number {
  const x = c[name];
  if (x === undefined) {
    return 0;
  }
  if (!isWhole(x, 0, 100)) {
    throw new PlanError('a card switch is a whole number from 0 to 100: ' + name);
  }
  return x;
}

/** One mint or record fault switch of an app plan: 0 when absent, else a whole number from 0 to most. */
function faultSwitch(c: Record<string, unknown>, name: string, most: number): number {
  const x = c[name];
  if (x === undefined) {
    return 0;
  }
  if (!isWhole(x, 0, most)) {
    throw new PlanError('a fault switch is a whole number from 0 to ' + most + ': ' + name);
  }
  return x;
}

/** The plan the bench served: the self-test unless it names another mode; a lab plan is checked field by field. */
export function parsePlan(v: unknown): DevPlan {
  if (!isObj(v)) {
    return { mode: 'selftest' };
  }
  const mode = v.mode;
  if (mode === 'selftest-sqlcipher') {
    return { mode: 'selftest-sqlcipher' };
  }
  if (mode === 'app') {
    const a = v.app;
    if (a === undefined) {
      return { mode: 'app', app: { gate: 'device' } };
    }
    if (!isObj(a)) {
      throw new PlanError("an app plan's app is an object");
    }
    let gate: AppGate = 'device';
    const g = a.gate;
    if (g === 'device' || g === 'bench-allow' || g === 'bench-deny') {
      gate = g;
    } else if (g !== undefined) {
      throw new PlanError('no such gate: ' + String(g));
    }
    const app: AppPlan = { gate };
    const card = a.card;
    if (card !== undefined) {
      if (!isObj(card)) {
        throw new PlanError("an app plan's card is an object");
      }
      app.card = { absentTaps: cardSwitch(card, 'absentTaps'), dropSigns: cardSwitch(card, 'dropSigns') };
    }
    const mintFaults = a.mint;
    if (mintFaults !== undefined) {
      if (!isObj(mintFaults)) {
        throw new PlanError("an app plan's mint is an object");
      }
      app.mint = {
        dropSwaps: faultSwitch(mintFaults, 'dropSwaps', 100),
        downMs: faultSwitch(mintFaults, 'downMs', 600000),
        hideRestores: faultSwitch(mintFaults, 'hideRestores', 100),
      };
    }
    const recordFaults = a.record;
    if (recordFaults !== undefined) {
      if (!isObj(recordFaults)) {
        throw new PlanError("an app plan's record is an object");
      }
      app.record = {
        failTapWrites: faultSwitch(recordFaults, 'failTapWrites', 100),
        holdKeeps: faultSwitch(recordFaults, 'holdKeeps', 100),
      };
    }
    const fill = a.fill;
    if (fill !== undefined) {
      if (!isObj(fill)) {
        throw new PlanError("an app plan's fill is an object");
      }
      const n = fill.payments;
      if (!isWhole(n, 1, 20000)) {
        throw new PlanError('fill.payments is a whole number from 1 to 20000');
      }
      app.fill = { payments: n };
    }
    const archive = a.archive;
    if (archive !== undefined) {
      if (!isObj(archive)) {
        throw new PlanError("an app plan's archive is an object");
      }
      let auto = true;
      const x = archive.auto;
      if (x !== undefined) {
        if (typeof x !== 'boolean') {
          throw new PlanError('archive.auto is true or false');
        }
        auto = x;
      }
      let sales = 0;
      const s = archive.sales;
      if (s !== undefined) {
        if (!isWhole(s, 0, 20000)) {
          throw new PlanError('archive.sales is a whole number from 0 to 20000');
        }
        sales = s;
      }
      app.archive = { auto, sales };
    }
    const generation = a.generation;
    if (generation !== undefined) {
      if (!isObj(generation)) {
        throw new PlanError("an app plan's generation is an object");
      }
      app.generation = {
        refuseMs: faultSwitch(generation, 'refuseMs', 3600000),
        fromSale: faultSwitch(generation, 'fromSale', 1),
      };
    }
    return { mode: 'app', app };
  }
  if (mode !== 'lab') {
    return { mode: 'selftest' };
  }
  const l = v.lab;
  if (!isObj(l)) {
    throw new PlanError('a lab plan needs a lab object');
  }

  const rawAction = l.action;
  if (typeof rawAction !== 'string' || !(LAB_ACTIONS as readonly string[]).includes(rawAction)) {
    throw new PlanError('no such lab action: ' + String(l.action));
  }
  const action = rawAction as LabAction;

  const run = l.run;
  if (typeof run !== 'string' || !/^[a-z0-9-]{1,24}$/.test(run)) {
    throw new PlanError('a run is 1 to 24 of a-z 0-9 -');
  }

  const name = l.name;
  if (typeof name !== 'string' || !/^[a-z0-9]{1,16}$/.test(name)) {
    throw new PlanError('a lab store name is 1 to 16 of a-z 0-9');
  }

  let count = 20;
  if (l.count !== undefined) {
    if (!isWhole(l.count, 1, 10000000)) {
      throw new PlanError('count is a whole number from 1 to 10000000');
    }
    count = l.count;
  }

  let choice: StoreChoice | undefined;
  if (l.choice !== undefined) {
    if (typeof l.choice !== 'string' || !CHOICES.includes(l.choice as StoreChoice)) {
      throw new PlanError('no such choice: ' + String(l.choice));
    }
    choice = l.choice as StoreChoice;
  }

  let durability: Durability = 'wal';
  if (l.durability !== undefined) {
    if (l.durability !== 'wal' && l.durability !== 'delete') {
      throw new PlanError('durability is wal or delete');
    }
    durability = l.durability;
  }

  let samples = 200;
  if (l.samples !== undefined) {
    if (!isWhole(l.samples, 1, 10000)) {
      throw new PlanError('samples is a whole number from 1 to 10000');
    }
    samples = l.samples;
  }

  let sizes: number[] = [1000, 10000];
  if (l.sizes !== undefined) {
    const rawSizes = l.sizes;
    if (
      !Array.isArray(rawSizes) ||
      rawSizes.length < 1 ||
      rawSizes.length > 4 ||
      !rawSizes.every((x, i) => isWhole(x, 1, 100000) && (i === 0 || x > (rawSizes[i - 1] as number)))
    ) {
      throw new PlanError('sizes are 1 to 4 whole numbers from 1 to 100000, rising');
    }
    sizes = rawSizes.slice() as number[];
  }

  const lab: LabPlan = { action, run, name, count, durability, samples, sizes };
  if (choice !== undefined) {
    lab.choice = choice;
  }
  return { mode: 'lab', lab };
}
