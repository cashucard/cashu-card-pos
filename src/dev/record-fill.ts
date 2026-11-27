/* The development build's synthetic payments (slice 1.4): many delivered payments written once into the record, so that
 * the simulator run can time the Activity over a long record. Development builds only; never in a release build. */

import type { Journal, Row } from 'cashucard';
import { hex64, LAB_ROW_BYTES, paymentRow } from '../lab/rows';
import { DevOnlyError } from '../till/store/wipe';

declare const __DEV__: boolean;

/** The sale id of synthetic sale i (slice 2.3), apart from every id slice 1.4's synthetic payments use. */
export function fillSaleId(i: number): string {
  return 'm2-' + i;
}

/** Synthetic sale i, delivered, of 14 sats (slice 2.3): its sale row and its payment row (paymentRow's, about 4,400
 * characters, joined to the sale, with no delivery), begun at `at`, so that the library's archive() takes it as final. */
export function saleRows(i: number, at: number): Row[] {
  const id = fillSaleId(i);
  const pay = paymentRow(i, LAB_ROW_BYTES) as unknown as Record<string, unknown>;
  pay.id = 'pay:' + hex64(i, 7).slice(0, 32);
  pay.sale = id;
  pay.at = at;
  delete pay.delivery;
  delete pay.ref;
  const sale = {
    kind: 'sale',
    id: 'sale:' + id,
    sale: { id, sats: 14 },
    request: hex64(i, 8).slice(0, 32),
    unit: 'sat',
    amount: 14,
    mints: ['https://mint.test'],
    at,
  };
  return [sale as unknown as Row, pay as unknown as Row];
}

/** Writes synthetic sales 1 to `count` (saleRows, each begun at now() when it is written), with the journal's insert
 * where it has one, else its write. A sale whose row is kept already is left as it is, its payment too; so is one
 * whose row the archive holds (`archived`, by row id): cashucard 0.3.0 takes a sale's own row out when it archives
 * the sale, so a sale archived since is never written again under the same id. Answers how many sales were new. */
export async function fillSales(
  j: Journal,
  count: number,
  now: () => number,
  archived: (id: string) => Promise<boolean> = async () => false,
): Promise<number> {
  let added = 0;
  for (let i = 1; i <= count; i += 1) {
    const id = 'sale:' + fillSaleId(i);
    if ((await j.read(id)) !== null || (await archived(id))) {
      continue;
    }
    for (const row of saleRows(i, now())) {
      if (j.insert !== undefined) {
        await j.insert(row);
      } else {
        await j.write(row);
      }
    }
    added += 1;
  }
  return added;
}

/** f run at most once, with the argument of its first call; every caller waits for that one run, and its failure. */
export function onceWith<T>(f: (x: T) => Promise<void>): (x: T) => Promise<void> {
  let run: Promise<void> | null = null;
  return (x: T): Promise<void> => {
    if (run === null) {
      run = f(x);
    }
    return run;
  };
}

/** Writes `count` synthetic delivered payments, paymentRow(i, LAB_ROW_BYTES) for i from 1 to count, each with the
 * journal's insert where it has one (a row already there is left as it is), else with its write; answers how many
 * were new. */
export async function fillPayments(j: Journal, count: number): Promise<number> {
  let added = 0;
  for (let i = 1; i <= count; i += 1) {
    const row: Row = paymentRow(i, LAB_ROW_BYTES);
    if (j.insert !== undefined) {
      if (await j.insert(row)) {
        added += 1;
      }
    } else {
      await j.write(row);
      added += 1;
    }
  }
  return added;
}

/** The journal with ready(inner) awaited before each of its calls; DevOnlyError outside development, before anything
 * else. A journal without insert or remove stays without it. */
export function filledJournal(inner: Journal, ready: (j: Journal) => Promise<void>, dev: boolean = __DEV__): Journal {
  if (!dev) {
    throw new DevOnlyError();
  }
  const j: Journal = {
    write: async (row: Row): Promise<void> => {
      await ready(inner);
      await inner.write(row);
    },
    read: async (id: string): Promise<Row | null> => {
      await ready(inner);
      return inner.read(id);
    },
    list: async (): Promise<Row[]> => {
      await ready(inner);
      return inner.list();
    },
  };
  const insert = inner.insert;
  if (insert !== undefined) {
    j.insert = async (row: Row): Promise<boolean> => {
      await ready(inner);
      return insert.call(inner, row);
    };
  }
  const remove = inner.remove;
  if (remove !== undefined) {
    j.remove = async (id: string): Promise<void> => {
      await ready(inner);
      await remove.call(inner, id);
    };
  }
  return j;
}
