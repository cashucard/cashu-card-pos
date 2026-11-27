import type { HttpFetch, Journal, Row } from 'cashucard';
import { remainingWithdrawal, type TokenAmount } from '../wallet';
import type { Serial } from './db';
import { handoffIndex, handoffToken, writeCustomerExport } from './extra-handoffs';
import { indexArchivedInputs } from './offline-archive';
import { SQL } from './sql';
import type { SqlDriver, SqlValue } from './types';

/** A row whose body does not read back as a JSON object: handed to the library with no kind, so the library lists it
 * under olderRows(), never reads it as money and never writes over it. The row stays in the file as it is. */
export interface UnreadableRow {
  id: string;
  unreadable: true;
}

/** The statement's parameters for a row: id, kind, gen, body, written_at. */
export function rowParams(row: Row, at: number): SqlValue[] {
  const id = (row as { id?: unknown }).id;
  if (typeof id !== 'string' || id === '' || id.length > 200) {
    throw new Error('a journal row needs an id of 1 to 200 characters');
  }
  const kind = String((row as { kind?: unknown }).kind);
  const g = (row as { gen?: unknown }).gen;
  const gen = typeof g === 'number' && Number.isSafeInteger(g) && g >= 0 ? g : 0;
  const body = JSON.stringify(row);
  return [id, kind, gen, body, at];
}

/** The unreadable row: an id and no kind. */
function unreadable(id: string): Row {
  return { id, unreadable: true } as UnreadableRow as unknown as Row;
}

/** A row's body as it reads back, or the unreadable row when it is not a JSON object. */
function parseBody(id: string, body: SqlValue): Row {
  if (typeof body !== 'string') {
    return unreadable(id);
  }
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return unreadable(id);
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return unreadable(id);
  }
  return v as Row;
}

/** A field of a row's body when it is of that type, else null. */
function field(o: Record<string, unknown> | null, k: string, t: 'string' | 'number'): string | number | null {
  if (o === null) {
    return null;
  }
  const v = o[k];
  if (t === 'number') {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  return typeof v === 'string' ? v : null;
}

/** The archive's statement parameters (SQL.archiveInsert) for a journal row as stored (its id, kind, gen, body and
 * written_at columns), moved at `at`: the row whole, then the sale, state, extra, time, price, fee, mint and unit read
 * from its body; each null when the body does not read as an object or the field is not of its type. */
export function archiveParams(x: Record<string, SqlValue>, at: number, o = objectOf(x.body)): SqlValue[] {
  return [
    String(x.id),
    String(x.kind),
    Number(x.gen),
    String(x.body),
    Number(x.written_at),
    at,
    field(o, 'sale', 'string'),
    field(o, 'state', 'string'),
    field(o, 'extra', 'string'),
    field(o, 'at', 'number'),
    field(o, 'amount', 'number'),
    field(o, 'fee', 'number'),
    field(o, 'mint', 'string'),
    field(o, 'unit', 'string'),
  ];
}

/** What the library's archive() reads of one payment row to decide whether it goes (slice 2.3 review; cashucard
 * dist/pay.js 655-658), read from the row's body: `held` is the later of when its payment began and when it was held,
 * the time archive() compares with its cut. */
export interface PaymentFacts {
  /** the row's id: the payment's paymentId */
  id: string;
  sale: string;
  state: string;
  step: string | null;
  how: string | null;
  extra: boolean;
  held: number;
  /** what the row still owes its card, not written yet, and what was written to the card on its word only and not
   * confirmed: the library's owedAmount and unconfirmedAmount (cashucard 0.3.0 src/journal.ts 381-406), read from the
   * body, for rows that took nothing too (slice 2.3b) */
  owed: number;
  unconfirmed: number;
  /** the secrets of the pieces the payment's plan spends (`plan.inputs`), for the library's rule that keeps a payment
   * whose pieces a claim or a loss also names (slice 2.3b). Held in memory for one archive job only: never logged,
   * shown, reported or kept */
  inputs: string[];
}

/** What the library's archive() reads of one sale row (cashucard 0.3.0, slice 2.3b): when it was opened, whether and
 * when it was closed (paid by the wallet or withdrawn), and whether an archive marked it. */
export interface SaleFacts {
  /** the sale's own id (`sale.id` in its body), as its payments name it */
  id: string;
  at: number;
  closed: boolean;
  /** when it was closed (ms), 0 when it was not */
  closedAt: number;
  archived: boolean;
}

/** A row the library does not read (damaged, or an earlier version's): its id, and the kind and the sale its body
 * names, each null where the body gives no text one (slice 2.3b: cashucard 0.3.0 keeps from the archive any sale such
 * a row may belong to). */
export interface UnreadRow {
  id: string;
  kind: string | null;
  sale: string | null;
}

type Obj = Record<string, unknown>;

/** A body as a JSON object, or null. */
function objectOf(body: SqlValue): Obj | null {
  if (typeof body !== 'string') {
    return null;
  }
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return null;
  }
  return v === null || typeof v !== 'object' || Array.isArray(v) ? null : (v as Obj);
}

/** The objects of a list field; none when it is not a list. */
function objects(v: unknown): Obj[] {
  return Array.isArray(v) ? v.filter((x): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x)) : [];
}

/** A piece's or a change's amount, 0 when it gives none. */
function amountOf(x: Obj): number {
  return typeof x.amount === 'number' && Number.isFinite(x.amount) ? x.amount : 0;
}

/** The library's owedAmount: the pieces not written of lots `locked` or `stuck`, and the card's own change not
 * written. */
export function owedOf(o: Obj): number {
  let n = 0;
  for (const l of objects(o.owed)) {
    if (l.state === 'locked' || l.state === 'stuck') {
      for (const p of objects(l.pieces)) {
        n += p.written ? 0 : amountOf(p);
      }
    }
  }
  for (const c of objects(o.cardChange)) {
    n += c.written ? 0 : amountOf(c);
  }
  return n;
}

/** The library's unconfirmedAmount: the card's own change written and not gone, confirmed or bad; and the pieces of
 * lots not `kept` written and not spent, confirmed or bad. */
export function unconfirmedOf(o: Obj): number {
  let n = 0;
  for (const c of objects(o.cardChange)) {
    n += c.written && !c.gone && !c.confirmed && !c.bad ? amountOf(c) : 0;
  }
  for (const l of objects(o.owed)) {
    if (l.state !== 'kept') {
      for (const p of objects(l.pieces)) {
        n += p.written && !p.spent && !p.confirmed && !p.bad ? amountOf(p) : 0;
      }
    }
  }
  return n;
}

/** The secrets of `plan.inputs`, none when the row has no plan. */
function inputsOf(o: Obj): string[] {
  const plan = o.plan;
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    return [];
  }
  const out: string[] = [];
  for (const i of objects((plan as Obj).inputs)) {
    if (typeof i.secret === 'string') {
      out.push(i.secret);
    }
  }
  return out;
}

/** A sale row's facts, or null when its body does not read as one (one with no id of its own the library does not read
 * either). */
function saleFactsOf(body: SqlValue): SaleFacts | null {
  const o = objectOf(body);
  if (o === null || typeof o.id !== 'string') {
    return null;
  }
  if (o.sale === null || typeof o.sale !== 'object' || typeof o.at !== 'number' || !Number.isFinite(o.at)) {
    return null;
  }
  const id = (o.sale as Obj).id;
  if (typeof id !== 'string') {
    return null;
  }
  return {
    id,
    at: o.at,
    closed: !!o.closed,
    closedAt: typeof o.closedAt === 'number' && Number.isFinite(o.closedAt) ? o.closedAt : 0,
    archived: !!o.archived,
  };
}

/** A payment row's facts, or null when its body does not read as one (the library does not take such a row either). The
 * row is named by the id in its body, as the library names it; a body with no id of its own is left out, as the library
 * leaves it out. */
function factsOf(body: SqlValue): PaymentFacts | null {
  if (typeof body !== 'string') {
    return null;
  }
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return null;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string') {
    return null;
  }
  if (typeof o.sale !== 'string' || typeof o.state !== 'string' || typeof o.at !== 'number' || !Number.isFinite(o.at)) {
    return null;
  }
  const heldAt = typeof o.heldAt === 'number' && Number.isFinite(o.heldAt) ? o.heldAt : 0;
  return {
    id: o.id,
    sale: o.sale,
    state: o.state,
    step: typeof o.step === 'string' ? o.step : null,
    how: typeof o.how === 'string' ? o.how : null,
    extra: !!o.extra,
    held: Math.max(o.at, heldAt),
    owed: owedOf(o),
    unconfirmed: unconfirmedOf(o),
    inputs: inputsOf(o),
  };
}

/** How many rows the store reads into objects before it lets other work run (slice 2.3b): a long record's reads never
 * hold the JS thread for long, so a press on the screen is served between two parts of one. */
export const ROWS_PER_TURN = 250;

/** Lets other work run: a timer of 0 ms, so that touches and timers queued meanwhile are served first. */
function turn(): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, 0));
}

/** The library's Journal over the store's SQLite. Every write is one statement in autocommit mode and resolves only
 * after that statement has finished, which is after its commit. */
export class SqliteJournal implements Journal {
  private readonly driver: SqlDriver;
  private readonly serial: Serial;
  private readonly now: () => number;
  /** moves into the archive begun (slice 2.3 review): moves() */
  private moved = 0;
  private exportingExtra: string | null = null;

  constructor(driver: SqlDriver, serial: Serial, now: () => number) {
    this.driver = driver;
    this.serial = serial;
    this.now = now;
  }

  async write(row: Row): Promise<void> {
    const now = this.now();
    const params = rowParams(row, now);
    if (this.exportingExtra === row.id && row.kind === 'payment' && row.state === 'exported' && row.extra) {
      await this.serial(() => writeCustomerExport(this.driver, row, params, now));
      return;
    }
    await this.serial(() => this.driver.run(SQL.journalUpsert, params));
  }

  /** An extra leaves only through the SDK. Its last write also saves a copy for the customer. */
  async customerExport(id: string, issue: () => Promise<string>): Promise<string> {
    const saved = await this.customerToken(id);
    if (saved !== null) return saved;
    if (this.exportingExtra !== null) throw new Error('A customer return is already being prepared.');
    this.exportingExtra = id;
    try {
      const token = await issue();
      if (await this.customerToken(id) !== token) throw new Error('The customer token could not be verified.');
      return token;
    } finally {
      this.exportingExtra = null;
    }
  }

  customerHandoffs() {
    return this.serial(() => handoffIndex(this.driver));
  }

  customerToken(id: string) {
    return this.serial(() => handoffToken(this.driver, id));
  }

  /** A fully redeemed handoff keeps its row and an empty token. customerExport treats that
   * tombstone as a saved outcome, so re-opening a receipt can never export a second time. */
  async checkCustomerHandoff(id: string, http: HttpFetch): Promise<TokenAmount & { pending: boolean }> {
    const original = await this.serial(async () => (await this.driver.run(
      'SELECT mint,unit,amount,token FROM extra_handoffs WHERE payment_id=?', [id],
    )).rows[0]);
    if (!original) throw new Error('The saved customer return could not be found.');
    if (original.amount === 0) return { amount: 0, token: '', pending: false };
    const left = await remainingWithdrawal(http, String(original.mint), String(original.unit), {
      amount: Number(original.amount), token: String(original.token),
    });
    if (left.pending) return left;
    const saved = await this.serial(() => this.driver.run(
      'UPDATE extra_handoffs SET amount=?,token=? WHERE payment_id=? AND amount=? AND token=?',
      [left.amount, left.token, id, original.amount, original.token],
    ));
    if (saved.rowsAffected !== 1) throw new Error('The customer return changed. Check it again.');
    return left;
  }

  async insert(row: Row): Promise<boolean> {
    const params = rowParams(row, this.now());
    const r = await this.serial(() => this.driver.run(SQL.journalInsert, params));
    return r.rowsAffected === 1;
  }

  async read(id: string): Promise<Row | null> {
    const r = await this.serial(() => this.driver.run(SQL.journalRead, [id]));
    if (r.rows.length === 0) {
      return null;
    }
    return parseBody(id, r.rows[0].body);
  }

  async list(): Promise<Row[]> {
    const r = await this.serial(() => this.driver.run(SQL.journalList));
    const out: Row[] = [];
    for (let i = 0; i < r.rows.length; i += 1) {
      if (i > 0 && i % ROWS_PER_TURN === 0) {
        await turn();
      }
      out.push(parseBody(String(r.rows[i].id), r.rows[i].body));
    }
    return out;
  }

  /** Moves the row of `id` into the archive (CashuCard.archive's remove): the row whole, with archiveParams, and its
   * delete from the journal, in one transaction, inside the store's one serial lane. A row not kept: nothing is done.
   * An id archived before is replaced by the row moved now (the library never uses an id twice; tests and the bench
   * fill may).
   * A failure at any step rolls the transaction back (the row stays in the journal, nothing is in the archive) and is
   * passed on. */
  async remove(id: string): Promise<void> {
    await this.serial(async () => {
      // counted as the move begins in the lane, before any of its statements, whatever it then does
      this.moved += 1;
      const r = await this.driver.run(SQL.journalRow, [id]);
      if (r.rows.length === 0) {
        return;
      }
      const row = r.rows[0];
      const body = objectOf(row.body);
      const params = archiveParams(row, this.now(), body);
      await this.driver.run(SQL.begin);
      try {
        await this.driver.run(SQL.archiveInsert, params);
        if (row.kind === 'payment' && body && (body.state === 'delivered' || body.state === 'exported')) {
          await indexArchivedInputs(this.driver, row.body);
        }
        await this.driver.run(SQL.journalRemove, [id]);
        await this.driver.run(SQL.commit);
      } catch (e) {
        await this.driver.run(SQL.rollback).catch(() => undefined);
        throw e;
      }
    });
  }

  /** How many moves into the archive have begun since this journal was made (slice 2.3 review). A move is one job of
   * the store's serial lane, counted as that job begins. A reading made of several jobs of the lane that reads this
   * number before its first job and finds it unchanged after its last one had no row move between them: a move that
   * began before the first read ended before the reading's first job, and any other one changed the number. */
  moves(): number {
    return this.moved;
  }

  /** how many rows of that kind the journal keeps (slice 2.3: the archive's line counts payment rows); no body is read */
  async count(kind: string): Promise<number> {
    const r = await this.serial(() => this.driver.run(SQL.journalCount, [kind]));
    return Number(r.rows[0]?.n ?? 0);
  }

  /** when each payment row was last written (ms, the store's clock), by its id; no body is read */
  async writtenAt(): Promise<Map<string, number>> {
    const r = await this.serial(() => this.driver.run(SQL.journalWritten));
    const out = new Map<string, number>();
    for (const x of r.rows) {
      out.set(String(x.id), Number(x.written_at));
    }
    return out;
  }

  /** every payment row's facts (slice 2.3 review: how far back one archive job reaches); rows that do not read are left out */
  async paymentFacts(): Promise<PaymentFacts[]> {
    const r = await this.serial(() => this.driver.run(SQL.journalPayments));
    const out: PaymentFacts[] = [];
    for (let i = 0; i < r.rows.length; i += 1) {
      if (i > 0 && i % ROWS_PER_TURN === 0) {
        await turn();
      }
      const f = factsOf(r.rows[i].body);
      if (f !== null) {
        out.push(f);
      }
    }
    return out;
  }

  /** every sale row's facts (slice 2.3b: which sales cashucard 0.3.0's archive() takes); rows that do not read are left
   * out */
  async saleFacts(): Promise<SaleFacts[]> {
    const r = await this.serial(() => this.driver.run(SQL.journalSaleRows));
    const out: SaleFacts[] = [];
    for (let i = 0; i < r.rows.length; i += 1) {
      if (i > 0 && i % ROWS_PER_TURN === 0) {
        await turn();
      }
      const f = saleFactsOf(r.rows[i].body);
      if (f !== null) {
        out.push(f);
      }
    }
    return out;
  }

  /** The kind and the sale each of these rows names, read from its body as kept (slice 2.3b), for the rows the library
   * does not read (its damagedRows() and olderRows()); a row no longer kept is left out. */
  async rowsOf(ids: readonly string[]): Promise<UnreadRow[]> {
    const out: UnreadRow[] = [];
    for (const id of ids) {
      const r = await this.serial(() => this.driver.run(SQL.journalRead, [id]));
      if (r.rows.length === 0) {
        continue;
      }
      const o = objectOf(r.rows[0].body);
      out.push({
        id,
        kind: o !== null && typeof o.kind === 'string' ? o.kind : null,
        sale: o !== null && typeof o.sale === 'string' ? o.sale : null,
      });
    }
    return out;
  }

  /** how many rows are kept and the highest generation among them (the open checks and the lab) */
  async stats(): Promise<{ rows: number; gen: number }> {
    const r = await this.serial(() => this.driver.run(SQL.journalStats));
    return { rows: Number(r.rows[0]?.n ?? 0), gen: Number(r.rows[0]?.gen ?? 0) };
  }
}
