/* The one queue every journal write of the till goes through: one job at a time, in the order asked. It knows which job
 * is running and whether that job holds a card in the field, so a settle, an export or an archive never starts while a
 * card tap is open. Sales, card taps, settle, export and archive are its later callers; the reopen of the library is
 * already one. */

/** 'read': a reading of the record and the archive made again where no archive job runs beside it (service steady). */
export type JobKind =
  | 'reopen'
  | 'sale'
  | 'card'
  | 'close-sale'
  | 'settle'
  | 'give-back'
  | 'export'
  | 'archive'
  | 'read';
/** The jobs that hold a card in the field. */
export const TAP_JOBS: readonly JobKind[] = ['card', 'give-back'];

export interface TillQueue {
  /** Runs f once every job asked before it has settled; one job at a time, in the order asked. Answers f's result or
   * its rejection. A job that fails never stops the next. A job must never await run() itself (it would wait for its
   * own end); it may call run() and return. */
  run<T>(kind: JobKind, f: () => Promise<T>): Promise<T>;
  /** The kind of the job running now, or null. */
  running(): JobKind | null;
  /** Whether the job running now is in TAP_JOBS. */
  tapOpen(): boolean;
  /** Jobs asked and not started yet. */
  waiting(): number;
  /** Resolves once every job asked so far has settled (never rejects). */
  idle(): Promise<void>;
}

export function createTillQueue(): TillQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  let running: JobKind | null = null;

  return {
    run<T>(kind: JobKind, f: () => Promise<T>): Promise<T> {
      waiting += 1;
      const next = tail.then(async () => {
        waiting -= 1;
        running = kind;
        try {
          return await f();
        } finally {
          running = null;
        }
      });
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    running: () => running,
    tapOpen: () => running !== null && TAP_JOBS.includes(running),
    waiting: () => waiting,
    idle: () => {
      const now = tail;
      return now.then(
        () => undefined,
        () => undefined,
      );
    },
  };
}
