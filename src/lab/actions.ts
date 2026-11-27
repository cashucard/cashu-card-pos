import type { OpenTill } from '../till/open';
import type { Durability } from '../till/store/db';
import { createSerial, openDatabase, type OpenDb } from '../till/store/db';
import { rowParams, SqliteJournal } from '../till/store/journal';
import type { StoreChoice, StoreOutcome } from '../till/store/open-store';
import { generationStore, readKey } from '../till/store/secret';
import { SQL } from '../till/store/sql';
import { labNames, type SqlDriver, type StoreDeps, type StoreNames } from '../till/store/types';
import type { Bench } from './bench';
import type { LabAction, LabPlan } from './plan';
import { INVOICE_14, LAB_ROW_BYTES, LAB_SALE_SATS, paymentRow } from './rows';
import { summarize } from './stats';

/** `msg(e)`: what an error says, in one line. */
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface LabDeps {
  store: StoreDeps;
  bench: Bench;
  /** a clock for the timings, ms with a fraction */
  clock: () => number;
  /** openStoredTill over the device, with an http that refuses everything and no mints */
  openTill: (names: StoreNames, choice: StoreChoice | undefined, durability: Durability) => Promise<StoreOutcome<OpenTill>>;
  /** wipeLabStore over the device, development only */
  wipe: (names: StoreNames) => Promise<void>;
}

export interface LabResult {
  run: string;
  action: LabAction;
  state: string;
  [key: string]: unknown;
}

/** An outcome as plain data: its kind as `state` and its fields, never the store or the till. */
export function describeOutcome(o: StoreOutcome<unknown>): Record<string, unknown> {
  const r = { ...(o as unknown as Record<string, unknown>) };
  const state = String(r.kind);
  delete r.kind;
  delete r.store;
  delete r.value;
  return { state, ...r };
}

/** Insert `count` synthetic payment rows, indexes start to start + count - 1, in one transaction; answers the next index.
 * Only while nothing else uses the store (it does not go through the store's queue). */
export async function fillRows(driver: SqlDriver, count: number, start: number): Promise<number> {
  if (count <= 0) {
    return start;
  }
  await driver.run(SQL.begin);
  try {
    for (let i = start; i <= start + count - 1; i += 1) {
      await driver.run(SQL.journalInsert, rowParams(paymentRow(i, LAB_ROW_BYTES), 0));
    }
    await driver.run(SQL.commit);
  } catch (e) {
    await driver.run(SQL.rollback).catch(() => undefined);
    throw e;
  }
  return start + count;
}

/** Do one lab action, post its result to the bench, and answer it. */
export async function runLab(d: LabDeps, p: LabPlan, onLine: (line: string) => void): Promise<LabResult> {
  const names = labNames(p.name);

  const finish = async (body: Record<string, unknown>): Promise<LabResult> => {
    const result = { run: p.run, action: p.action, ...body } as LabResult;
    await d.bench.post('/result', result);
    return result;
  };

  try {
    switch (p.action) {
      case 'burst': {
        const out = await d.openTill(names, p.choice, p.durability);
        if (out.kind !== 'ready') {
          return finish(describeOutcome(out));
        }
        const st = await out.store.journal.stats();
        const stored = await out.store.generation.get();
        await d.bench.post('/event', { run: p.run, kind: 'ready', rows: st.rows, gen: st.gen, stored });
        for (let i = 1; i <= p.count; i += 1) {
          const id = p.run + '-' + i;
          await out.value.cashuCard.receive({ id, sats: LAB_SALE_SATS, invoice: INVOICE_14 });
          await d.bench.post('/event', { run: p.run, kind: 'wrote', i, id });
          if (i % 100 === 0) {
            onLine('wrote ' + i);
          }
        }
        await out.store.close();
        return finish({ state: 'ready', wrote: p.count });
      }

      case 'open': {
        const out = await d.openTill(names, p.choice, p.durability);
        if (out.kind !== 'ready') {
          return finish(describeOutcome(out));
        }
        const s = out.store;
        const rows = await s.journal.list();
        const saleIds = rows.filter((r) => r.kind === 'sale').map((r) => String(r.id).slice('sale:'.length));
        const st = await s.journal.stats();
        const stored = await s.generation.get();
        const excluded = {
          dir: await d.store.files.excluded(s.dir),
          file: await d.store.files.excluded(s.path),
        };
        const events = (await s.events.list()).map((e) => e.kind);
        await s.close();
        return finish({
          state: 'ready',
          firstRun: out.firstRun,
          rows: st.rows,
          gen: st.gen,
          stored,
          saleIds,
          excluded,
          cipherVersion: s.cipherVersion,
          events,
        });
      }

      case 'inspect': {
        const dir = await d.store.files.dir(names.dir);
        const path = dir + '/' + names.file;
        const present = await d.store.files.exists(path);
        let key: string | null = null;
        let stored: number | null = null;
        try {
          key = await readKey(d.store.secure, names);
          stored = await generationStore(d.store.secure, names).get();
        } catch (e) {
          return finish({ state: 'secure-store-unavailable', why: msg(e) });
        }
        if (!present) {
          return finish({ state: 'no-file', key: key !== null, stored });
        }
        if (key === null) {
          return finish({ state: 'no-key', stored });
        }
        let db: OpenDb;
        try {
          db = await openDatabase(d.store.opener, dir, names.file, key, p.durability);
        } catch (e) {
          return finish({ state: 'not-openable', why: msg(e), stored });
        }
        try {
          if (db.version === 0) {
            return finish({
              state: 'opened',
              version: 0,
              rows: 0,
              gen: 0,
              stored,
              leaseBeat: null,
              cipherVersion: db.cipherVersion,
            });
          }
          const j = new SqliteJournal(db.driver, createSerial(), d.store.now);
          const st = await j.stats();
          const lease = await j.read('lease');
          const leaseBeat = lease ? Number((lease as unknown as { beat?: unknown }).beat) : null;
          return finish({
            state: 'opened',
            version: db.version,
            rows: st.rows,
            gen: st.gen,
            stored,
            leaseBeat,
            cipherVersion: db.cipherVersion,
          });
        } finally {
          await db.driver.close();
        }
      }

      case 'measure': {
        await d.wipe(names);
        const first = await d.openTill(names, undefined, p.durability);
        if (first.kind !== 'ready') {
          return finish(describeOutcome(first));
        }
        let s = first.store;
        let cc = first.value.cashuCard;

        const writeMs: number[] = [];
        const setMs: number[] = [];
        const bothMs: number[] = [];
        const g0 = (await s.generation.get()) ?? 0;
        for (let i = 1; i <= p.samples; i += 1) {
          const row = paymentRow(i, LAB_ROW_BYTES);
          const t0 = d.clock();
          await s.journal.write(row);
          const t1 = d.clock();
          await s.generation.set(g0);
          const t2 = d.clock();
          writeMs.push(t1 - t0);
          setMs.push(t2 - t1);
          bothMs.push(t2 - t0);
        }
        onLine('timed ' + p.samples + ' rows');

        const saleMs: number[] = [];
        for (let i = 1; i <= p.samples; i += 1) {
          const t0 = d.clock();
          await cc.receive({ id: p.run + '-s' + i, sats: LAB_SALE_SATS, invoice: INVOICE_14 });
          saleMs.push(d.clock() - t0);
        }

        const getMs: number[] = [];
        const gets = Math.min(50, p.samples);
        for (let i = 1; i <= gets; i += 1) {
          const t0 = d.clock();
          await s.generation.get();
          getMs.push(d.clock() - t0);
        }

        let next = p.samples + 1;
        const sizes: Array<Record<string, unknown>> = [];
        for (const target of p.sizes) {
          const st = await s.journal.stats();
          next = await fillRows(s.driver, target - st.rows, next);

          const listMs: number[] = [];
          let rows = 0;
          for (let i = 1; i <= 5; i += 1) {
            const t0 = d.clock();
            const all = await s.journal.list();
            listMs.push(d.clock() - t0);
            rows = all.length;
          }

          const reopenMs: number[] = [];
          for (let i = 1; i <= 3; i += 1) {
            await s.close();
            const t0 = d.clock();
            const out = await d.openTill(names, undefined, p.durability);
            reopenMs.push(d.clock() - t0);
            if (out.kind !== 'ready') {
              return finish({ ...describeOutcome(out), at: target });
            }
            s = out.store;
            cc = out.value.cashuCard;
          }

          sizes.push({ target, rows, listMs: summarize(listMs), reopenMs: summarize(reopenMs) });
          onLine('timed list at ' + rows + ' rows');
        }

        await s.close();
        await d.wipe(names);
        return finish({
          state: 'ready',
          durability: p.durability,
          samples: p.samples,
          writeMs: summarize(writeMs),
          setMs: summarize(setMs),
          bothMs: summarize(bothMs),
          saleMs: summarize(saleMs),
          getMs: summarize(getMs),
          sizes,
        });
      }

      case 'wipe': {
        await d.wipe(names);
        return finish({ state: 'wiped' });
      }

      default:
        return finish({ state: 'error', why: 'no such lab action: ' + String(p.action) });
    }
  } catch (e) {
    return finish({ state: 'error', why: msg(e) });
  }
}
