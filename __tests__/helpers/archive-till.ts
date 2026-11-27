/* A till for the archive's tests (slice 2.3 review), over the real cashucard library and the real store layer on a fake
 * disk. The rows are what the library itself wrote: the scaffold's fixture holds a card sale of 14 sats as the library
 * left it held, and as it left it delivered; each builder copies them under new ids and times. Moves into the archive
 * can be paused at one point, and the library's next list of the record can be made to wait, so a test can place a
 * reading exactly across moves. */

import { open as openCashuCard, type CardListener, type CardTransport, type Journal, type Payment, type Row } from 'cashucard';
import { filledJournal, onceWith } from '../../src/dev/record-fill';
import type { ArchiveNote } from '../../src/till/archive';
import { createTillService, type TillService } from '../../src/till/service';
import { TILL_SETTINGS } from '../../src/till/settings';
import { TILL_NAMES } from '../../src/till/store/types';
import { fakeMint } from './fake-mint';
import { fakeStoreDeps, type FakeStore } from './fake-store';

type R = Record<string, unknown>;
const F = require('../fixtures/archive-rows.json') as { held: R[]; delivered: R[] };

export const NOW = new Date(2026, 10, 22, 12, 0).getTime();
export const PATH = '/app/till/till.db';

function copyOf(rows: R[], kind: string): R {
  const r = rows.find((x) => x.kind === kind);
  if (r === undefined) {
    throw new Error('the fixture has no ' + kind + ' row');
  }
  return JSON.parse(JSON.stringify(r)) as R;
}

/** The price of the fixture's sale. */
export const PRICE = Number(copyOf(F.delivered, 'payment').amount);

function saleRow(rows: R[], sid: string, at: number): R {
  const sale = copyOf(rows, 'sale');
  sale.id = 'sale:' + sid;
  (sale.sale as R).id = sid;
  sale.at = at;
  return sale;
}

/** The captured delivered sale as sale n: begun at `at`, held at `heldAt`, delivered 100 ms after it was held. */
export function delivered(n: number, at: number, heldAt: number = at + 100): Row[] {
  const sid = 'a-' + n;
  const pid = 'pay:' + String(n).padStart(32, '0');
  const did = 'fx-' + String(n).padStart(26, '0');
  const pay = copyOf(F.delivered, 'payment');
  pay.id = pid;
  pay.sale = sid;
  pay.at = at;
  pay.heldAt = heldAt;
  pay.delivery = did;
  const del = copyOf(F.delivered, 'delivery');
  del.id = did;
  del.payments = [pid];
  (del.delivery as R).id = did;
  del.at = heldAt + 100;
  return [saleRow(F.delivered, sid, at), pay, del] as unknown as Row[];
}

/** The captured held sale as sale n: held, not delivered (never final). */
export function held(n: number, at: number): Row[] {
  const sid = 'h-' + n;
  const pay = copyOf(F.held, 'payment');
  pay.id = 'pay:' + String(9000 + n).padStart(32, '0');
  pay.sale = sid;
  pay.at = at;
  pay.heldAt = at + 100;
  return [saleRow(F.held, sid, at), pay] as unknown as Row[];
}

/** Sale n whose one card payment took nothing: the captured held payment refused at the card (state none, step refused),
 * its pieces gone. Final for the library; never listed as a payment. */
export function refused(n: number, at: number): Row[] {
  const sid = 'r-' + n;
  const pay = copyOf(F.held, 'payment');
  pay.id = 'pay:' + String(7000 + n).padStart(32, '0');
  pay.sale = sid;
  pay.at = at;
  pay.state = 'none';
  pay.step = 'refused';
  delete pay.heldAt;
  delete pay.proofs;
  return [saleRow(F.held, sid, at), pay] as unknown as Row[];
}

/** Sale n as refused(n, at), then withdrawn by the till 50 ms later (its row closed 'withdrawn'): cashucard 0.3.0
 * archives a closed sale that took nothing, by the time of its close; an open one never. */
export function withdrawn(n: number, at: number): Row[] {
  const rows = refused(n, at) as unknown as R[];
  rows[0].closed = 'withdrawn';
  rows[0].closedAt = at + 50;
  return rows as unknown as Row[];
}

/** `n` delivered sales, one a second. */
export const many = (n: number) => (): Row[][] =>
  Array.from({ length: n }, (_, i) => delivered(i + 1, NOW + (i + 1) * 1000 - 500));

export interface ArchiveTill {
  f: FakeStore;
  service: TillService;
  clock: { now: number };
  /** moves into the archive done; from `failAfter` on (0 or more), each throws before it moves */
  cut: { removes: number; failAfter: number };
  /** the move numbered `at` (0 is the first; -1 never) waits until release() is called; `waiting` while it does */
  pause: { at: number; waiting: boolean; release: () => void };
  /** the move numbered `at` (0 is the first; -1 never), once the store has moved the row into the archive and before
   * the library is told, waits until release() is called; `waiting` while it does (slice 2.3b) */
  after: { at: number; waiting: boolean; release: () => void };
  /** run once, after the library's next list of the record has been read and before that list is answered */
  hooks: { list: (() => Promise<void>) | null };
  /** archived marks written (a sale's row written with `archived`); once `after` of them are written (1 or more; -1
   * never), the next write of the record waits until release() is called, `waiting` while it does */
  marks: { after: number; count: number; waiting: boolean; release: () => void };
  notes: Array<{ n: ArchiveNote; scope: string }>;
  logs: string[];
  /** what the till tells the development journal of its archive: whether it holds a row of an id (slice 2.3b) */
  archived: (id: string) => Promise<boolean>;
}

/** An open till over a fake store whose record holds `sales` (each written 1 s after the one before, the store's clock
 * and the till's the same), the library opened over it. */
export async function archiveTill(
  sales: () => Row[][],
  o: {
    auto?: boolean;
    failRemovesAfter?: number;
    f?: FakeStore;
    /** the service's wait (its pauses); by default one that answers at once */
    wait?: (ms: number) => Promise<void>;
    /** what the next card taps do, in order: each answers the payment; none given, the library's own card */
    card?: Array<(t: CardTransport, l: CardListener, saleId: string) => Promise<Payment>>;
    /** the fake mint added to the till's list once it is open, so that sales open */
    mint?: boolean;
    /** ms the till's clock moves on at every read of the journal's lease, the first thing the library's fence does: as
     * on a busy phone, where archive() reads its clock seconds after the till read its own (slice 2.3b) */
    drift?: number;
  } = {},
): Promise<ArchiveTill> {
  const f = o.f ?? fakeStoreDeps();
  const clock = { now: NOW };
  f.deps.now = () => clock.now;
  const cut = { removes: 0, failAfter: o.failRemovesAfter ?? -1 };
  let open: (() => void) | null = null;
  const pause = {
    at: -1,
    waiting: false,
    release: (): void => {
      const r = open;
      open = null;
      r?.();
    },
  };
  let openAfter: (() => void) | null = null;
  const after = {
    at: -1,
    waiting: false,
    release: (): void => {
      const r = openAfter;
      openAfter = null;
      r?.();
    },
  };
  const hooks: { list: (() => Promise<void>) | null } = { list: null };
  let openMark: (() => void) | null = null;
  const marks = {
    after: -1,
    count: 0,
    waiting: false,
    release: (): void => {
      const r = openMark;
      openMark = null;
      r?.();
    },
  };
  const notes: Array<{ n: ArchiveNote; scope: string }> = [];
  const logs: string[] = [];
  let archived: (id: string) => Promise<boolean> = async () => {
    throw new Error('the till has not handed its archive check yet');
  };
  const ready = onceWith(async (j: Journal) => {
    for (const rows of sales()) {
      clock.now += 1000;
      for (const r of rows) {
        await j.write(r);
      }
    }
  });
  const service = createTillService({
    store: f.deps,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: fakeMint().http,
    now: () => clock.now,
    log: (l) => logs.push(l),
    random: () => 0.25,
    wait: o.wait ?? (async () => undefined),
    openLibrary: async (c) => {
      const k = await openCashuCard(c);
      const scripts = o.card;
      if (scripts !== undefined) {
        const realSale = k.sale.bind(k);
        k.sale = async (id) => {
          const s = await realSale(id);
          s.card = async (t, l) => {
            const next = scripts.shift();
            if (next === undefined) {
              throw new Error('no card script left');
            }
            return next(t, l, id);
          };
          return s;
        };
      }
      return k;
    },
    autoArchive: o.auto,
    onArchive: (n, scope) => notes.push({ n, scope }),
    devJournal: (j, has) => {
      archived = has;
      const filled = filledJournal(j, ready, true);
      const remove = filled.remove!;
      const list = filled.list.bind(filled);
      const read = filled.read.bind(filled);
      const write = filled.write.bind(filled);
      return {
        ...filled,
        write: async (r: Row): Promise<void> => {
          if (marks.after >= 0 && marks.count === marks.after) {
            marks.after = -1;
            marks.waiting = true;
            await new Promise<void>((res) => {
              openMark = res;
            });
            marks.waiting = false;
          }
          await write(r);
          if (r.kind === 'sale' && !!(r as unknown as Record<string, unknown>).archived) {
            marks.count += 1;
          }
        },
        read: async (id: string): Promise<Row | null> => {
          if (id === 'lease' && o.drift !== undefined) {
            clock.now += o.drift;
          }
          return read(id);
        },
        list: async (): Promise<Row[]> => {
          const rows = await list();
          const h = hooks.list;
          if (h !== null) {
            hooks.list = null;
            await h();
          }
          return rows;
        },
        remove: async (id: string): Promise<void> => {
          if (cut.failAfter >= 0 && cut.removes >= cut.failAfter) {
            throw new Error('the app was killed');
          }
          if (pause.at >= 0 && cut.removes === pause.at) {
            pause.at = -1;
            pause.waiting = true;
            await new Promise<void>((r) => {
              open = r;
            });
            pause.waiting = false;
          }
          cut.removes += 1;
          await remove(id);
          if (after.at >= 0 && cut.removes === after.at + 1) {
            after.at = -1;
            after.waiting = true;
            await new Promise<void>((r) => {
              openAfter = r;
            });
            after.waiting = false;
          }
        },
      };
    },
  });
  await service.open();
  if (o.mint === true) {
    await service.addMint(await service.checkMint('mint.test'));
  }
  return { f, service, clock, cut, pause, after, hooks, marks, notes, logs, archived: (id) => archived(id) };
}

/** Lets other work run until `ok()` holds; throws when it never does. */
export async function until(ok: () => boolean, most: number = 5000): Promise<void> {
  for (let i = 0; i < most; i += 1) {
    if (ok()) {
      return;
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  throw new Error('never came');
}