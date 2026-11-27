import type { Delivery, GenerationStore, Journal, Row } from 'cashucard';
import { DevOnlyError } from '../till/store/wipe';

declare const __DEV__: boolean;

/** The bench plan's switches for the till's record (development only). Counters: each use takes one off. */
export interface DevRecordFaults {
  /** the next N journal writes made while a card tap runs fail */
  failTapWrites: number;
  /** the next N deliveries are kept, then the settle holds for ever */
  holdKeeps: number;
}
export const FAILED_WRITE_MESSAGE = 'development: the record could not be written';

/** The journal with the write fault applied; DevOnlyError outside development, before anything else. */
export function faultyJournal(
  inner: Journal,
  faults: DevRecordFaults,
  tapOpen: () => boolean,
  dev: boolean = __DEV__,
): Journal {
  if (!dev) {
    throw new DevOnlyError();
  }
  const j: Journal = {
    write: async (row: Row): Promise<void> => {
      if (faults.failTapWrites > 0 && tapOpen()) {
        faults.failTapWrites -= 1;
        throw new Error(FAILED_WRITE_MESSAGE);
      }
      await inner.write(row);
    },
    read: (id: string) => inner.read(id),
    list: () => inner.list(),
  };
  const insert = inner.insert;
  if (insert !== undefined) {
    j.insert = (row: Row) => insert.call(inner, row);
  }
  const remove = inner.remove;
  if (remove !== undefined) {
    j.remove = (id: string) => remove.call(inner, id);
  }
  return j;
}

/** The payout's keep with the hold applied; onHeld is told the delivery's amount (never its token or id). */
export function faultyKeep(
  inner: (d: Delivery) => Promise<void>,
  faults: DevRecordFaults,
  onHeld: (amount: number) => void,
  dev: boolean = __DEV__,
): (d: Delivery) => Promise<void> {
  if (!dev) {
    throw new DevOnlyError();
  }
  return async (d: Delivery): Promise<void> => {
    await inner(d);
    if (faults.holdKeeps > 0) {
      faults.holdKeeps -= 1;
      try {
        onHeld(d.amount);
      } catch {
        // a report that fails never changes the hold
      }
      await new Promise<void>(() => undefined);
    }
  };
}

export const REFUSED_SET_MESSAGE = 'development: the secure store did not keep the generation';

/** Whether a generation handed to the secure store is refused now (development only, slice 2.4): for `ms` from the
 * launch, or with `fromSale` from the first one handed over while a sale is being opened. */
export function refusalWindow(
  ms: number,
  fromSale: boolean,
  saleRunning: () => boolean,
  now: () => number,
): () => boolean {
  let from: number | null = fromSale ? null : now();
  return (): boolean => {
    if (from === null) {
      if (!saleRunning()) {
        return false;
      }
      from = now();
    }
    return now() - from < ms;
  };
}

/** The generation store with the refusal applied: while `refuse()` holds, a set is refused before the secure store is
 * asked, and onRefused is told. Reads go through. DevOnlyError outside development, before anything else. */
export function faultyGeneration(
  inner: GenerationStore,
  refuse: () => boolean,
  onRefused: () => void,
  dev: boolean = __DEV__,
): GenerationStore {
  if (!dev) {
    throw new DevOnlyError();
  }
  return {
    get: () => inner.get(),
    set: async (g: number): Promise<void> => {
      if (refuse()) {
        try {
          onRefused();
        } catch {
          // a report that fails never changes the refusal
        }
        throw new Error(REFUSED_SET_MESSAGE);
      }
      await inner.set(g);
    },
  };
}
