/* The till service archives (slice 2.3), over the real cashucard library and the real store layer on a fake disk. The
 * rows are what the library itself writes: the scaffold's fixture holds a card sale of 14 sats as the library left it
 * held, and as it left it delivered, captured on the harness's model bench; each test copies them under new ids and
 * times. Each test holds one rule: a row moved once, never lost or doubled; the totals unchanged by an archive; the
 * money kept in the phone untouched; the archive only in the queue, never beside a tap; by itself in jobs of at most
 * 100 until under 500; a crash part way recovered; the record opening afterwards with no rollback. */

import type { Journal, Row } from 'cashucard';
import { takings } from '../src/app/activity';
import { filledJournal, onceWith } from '../src/dev/record-fill';
import type { ArchiveNote } from '../src/till/archive';
import { createTillService, TillNotOpenError } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps, type FakeStore } from './helpers/fake-store';
import { dump } from './helpers/fake-sql';

type R = Record<string, unknown>;
const F = require('./fixtures/archive-rows.json') as { held: R[]; delivered: R[] };
const NOW = new Date(2026, 10, 22, 12, 0).getTime();
const PATH = '/app/till/till.db';

function copyOf(rows: R[], kind: string): R {
  const r = rows.find((x) => x.kind === kind);
  if (r === undefined) {
    throw new Error('the fixture has no ' + kind + ' row');
  }
  return JSON.parse(JSON.stringify(r)) as R;
}

/** The captured delivered sale as sale n: new ids, begun at `at`, held 100 ms and delivered 200 ms later. */
function delivered(n: number, at: number): Row[] {
  const sid = 'a-' + n;
  const pid = 'pay:' + String(n).padStart(32, '0');
  const did = 'fx-' + String(n).padStart(26, '0');
  const sale = copyOf(F.delivered, 'sale');
  sale.id = 'sale:' + sid;
  (sale.sale as R).id = sid;
  sale.at = at;
  const pay = copyOf(F.delivered, 'payment');
  pay.id = pid;
  pay.sale = sid;
  pay.at = at;
  pay.heldAt = at + 100;
  pay.delivery = did;
  const del = copyOf(F.delivered, 'delivery');
  del.id = did;
  del.payments = [pid];
  (del.delivery as R).id = did;
  del.at = at + 200;
  return [sale, pay, del] as unknown as Row[];
}

/** The captured held sale as sale n: held, not delivered. */
function held(n: number, at: number): Row[] {
  const sid = 'h-' + n;
  const sale = copyOf(F.held, 'sale');
  sale.id = 'sale:' + sid;
  (sale.sale as R).id = sid;
  sale.at = at;
  const pay = copyOf(F.held, 'payment');
  pay.id = 'pay:' + String(9000 + n).padStart(32, '0');
  pay.sale = sid;
  pay.at = at;
  pay.heldAt = at + 100;
  return [sale, pay] as unknown as Row[];
}

/** An open till over a fake store whose record holds `sales` (each written 1 s after the one before, the store's
 * clock and the till's the same), the library opened over it. */
async function till(sales: () => Row[][], o: { auto?: boolean; failRemovesAfter?: number; f?: FakeStore } = {}) {
  const f = o.f ?? fakeStoreDeps();
  const clock = { now: NOW };
  f.deps.now = () => clock.now;
  const cut = { removes: 0, failAfter: o.failRemovesAfter ?? -1 };
  const notes: Array<{ n: ArchiveNote; scope: string }> = [];
  const logs: string[] = [];
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
    wait: async () => undefined,
    autoArchive: o.auto,
    onArchive: (n, scope) => notes.push({ n, scope }),
    devJournal: (j) => {
      const filled = filledJournal(j, ready, true);
      const remove = filled.remove!;
      return {
        ...filled,
        remove: async (id: string): Promise<void> => {
          if (cut.failAfter >= 0 && cut.removes >= cut.failAfter) {
            throw new Error('the app was killed');
          }
          cut.removes += 1;
          await remove(id);
        },
      };
    },
  });
  await service.open();
  return { f, service, clock, cut, notes, logs };
}

const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));
const db = (f: FakeStore) => f.disk.files.get(PATH)!.db;
const PRICE = Number(copyOf(F.delivered, 'payment').amount);

/** three delivered sales, then one held */
const four = (): Row[][] => [
  delivered(1, NOW + 500),
  delivered(2, NOW + 1500),
  delivered(3, NOW + 2500),
  held(4, NOW + 3500),
];

/** `n` delivered sales */
const many = (n: number) => (): Row[][] =>
  Array.from({ length: n }, (_, i) => delivered(i + 1, NOW + (i + 1) * 1000 - 500));

describe('the till archives', () => {
  it('the fixture is what the library wrote: a sale of 14 sats, held, then delivered', () => {
    expect(PRICE).toBe(14);
    expect(copyOf(F.held, 'payment').state).toBe('held');
    expect(copyOf(F.delivered, 'payment').state).toBe('delivered');
    expect(copyOf(F.delivered, 'delivery').state).toBe('delivered');
  });

  it('by hand: final payments leave the record for the archive, once, and the totals do not change', async () => {
    const t = await till(four, { auto: false });
    const before = await t.service.payments();
    expect(before.map((p) => p.state).sort()).toEqual(['delivered', 'delivered', 'delivered', 'held']);
    const paidBefore = takings(before, null);
    expect(paidBefore).toEqual({ sats: 4 * PRICE, count: 4 });

    const n = await t.service.archiveNow('asked');
    // three payments, their three deliveries and their three sales' own rows (cashucard 0.3.0 archives a sale whole)
    expect(n).toMatchObject({ why: 'asked', payments: 3, rows: 9, left: 1, ok: true, error: null });

    const after = await t.service.payments();
    expect(after.map((p) => p.state)).toEqual(['held']);
    const archived = await t.service.archivedTakings(null, null);
    expect(archived).toEqual({ sats: 3 * PRICE, count: 3 });
    const live = takings(after, null);
    expect({ sats: live.sats + archived.sats, count: live.count + archived.count }).toEqual(paidBefore);
    for (const p of before) {
      expect(await t.service.isArchived(p.paymentId)).toBe(p.state === 'delivered');
    }
    const journal = dump(db(t.f), 'journal');
    const archive = dump(db(t.f), 'archive');
    for (const r of archive) {
      expect(journal.map((x) => x.id)).not.toContain(r.id);
    }
    expect(archive.filter((r) => r.kind === 'payment')).toHaveLength(3);
    expect(journal.filter((r) => r.kind === 'sale')).toHaveLength(1);
    expect(archive.filter((r) => r.kind === 'sale')).toHaveLength(3);
    expect(t.service.lastArchive()).toMatchObject({ payments: 3, ok: true });
    await t.service.close();
  });

  it('the money kept in the phone is untouched by an archive', async () => {
    const t = await till(four, { auto: false });
    db(t.f)
      .prepare(
        'INSERT INTO kept (id, mint, mint_norm, unit, amount, token, body, kept_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('fx-kept', 'https://mint.test', 'https://mint.test/', 'sat', 42, 'cashuB' + 'k'.repeat(40), '{}', 1);
    const kept = await t.service.kept();
    const rows = dump(db(t.f), 'kept');
    await t.service.archiveNow('asked');
    expect(await t.service.kept()).toEqual(kept);
    expect(dump(db(t.f), 'kept')).toEqual(rows);
    await t.service.close();
  });

  it('the record opens again after an archive, with no rollback, and the archive is still there', async () => {
    const t = await till(four, { auto: false });
    await t.service.archiveNow('asked');
    await t.service.close();
    const again = createTillService({
      store: t.f.deps,
      names: TILL_NAMES,
      settingsNames: TILL_SETTINGS,
      http: fakeMint().http,
      now: () => t.clock.now,
      log: () => undefined,
      autoArchive: false,
    });
    expect((await again.open()).kind).toBe('ready');
    expect((await again.payments()).map((p) => p.state)).toEqual(['held']);
    expect(await again.archivedTakings(null, null)).toEqual({ sats: 3 * PRICE, count: 3 });
    await again.close();
  });

  it('a crash part way: what moved stays moved, the rest moves at the next archive, nothing lost or twice', async () => {
    const t = await till(four, { auto: false, failRemovesAfter: 2 });
    const first = await t.service.archiveNow('asked');
    expect(first.ok).toBe(false);
    expect(await t.service.archivedTakings(null, null)).toEqual({ sats: 2 * PRICE, count: 2 });
    expect((await t.service.payments()).length).toBe(2);
    t.cut.failAfter = -1;
    const second = await t.service.archiveNow('asked');
    expect(second.ok).toBe(true);
    expect(await t.service.archivedTakings(null, null)).toEqual({ sats: 3 * PRICE, count: 3 });
    expect((await t.service.payments()).map((p) => p.state)).toEqual(['held']);
    const archive = dump(db(t.f), 'archive');
    expect(new Set(archive.map((r) => r.id)).size).toBe(archive.length);
    expect(dump(db(t.f), 'journal').filter((r) => r.kind === 'delivery')).toEqual([]);
    await t.service.close();
    const again = createTillService({
      store: t.f.deps,
      names: TILL_NAMES,
      settingsNames: TILL_SETTINGS,
      http: fakeMint().http,
      now: () => t.clock.now,
      log: () => undefined,
      autoArchive: false,
    });
    expect((await again.open()).kind).toBe('ready');
    expect(await again.archivedTakings(null, null)).toEqual({ sats: 3 * PRICE, count: 3 });
    await again.close();
  });

  it('an archive waits for a card tap in the queue, and runs after it', async () => {
    const t = await till(four, { auto: false });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tap = t.service.queue.run('card', () => gate);
    const run = t.service.archiveNow('asked');
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    expect(t.service.queue.running()).toBe('card');
    expect((await t.service.payments()).length).toBe(4);
    expect(await t.service.archivedTakings(null, null)).toEqual({ sats: 0, count: 0 });
    release();
    await tap;
    expect((await run).payments).toBe(3);
    await t.service.close();
  });

  it('by itself after a settle: jobs of at most 100, oldest first, until the record holds fewer than 500', async () => {
    const t = await till(many(600));
    expect((await t.service.payments()).length).toBe(600);
    await t.service.settleNow('asked');
    const n = await t.service.archiveNow('auto');
    expect(n).toMatchObject({ why: 'auto', bites: 2, payments: 200, left: 400, ok: true });
    const jobs = t.notes.filter((x) => x.scope === 'job').map((x) => x.n.payments);
    expect(jobs).toEqual([100, 100]);
    expect(t.notes.filter((x) => x.scope === 'run')).toHaveLength(1);
    const left = await t.service.payments();
    expect(left.length).toBe(400);
    expect(Math.min(...left.map((p) => p.at))).toBe(NOW + 201 * 1000 - 500);
    expect(await t.service.archivedTakings(null, null)).toEqual({ sats: 200 * PRICE, count: 200 });
    await t.service.close();
  }, 60000);

  it('the development switch keeps the till from archiving by itself', async () => {
    const t = await till(many(600), { auto: false });
    await t.service.settleNow('asked');
    for (let i = 0; i < 5; i += 1) {
      await flush();
    }
    expect((await t.service.payments()).length).toBe(600);
    expect(t.service.lastArchive()).toBeNull();
    expect(t.notes).toEqual([]);
    await t.service.close();
  }, 60000);

  it('under the line a settle archives nothing, and runs no archive job', async () => {
    // three delivered sales only: the fixture's held payment carries redacted proofs, which a settle cannot deliver
    const t = await till(() => four().slice(0, 3));
    await t.service.settleNow('asked');
    const n = await t.service.archiveNow('auto');
    expect(n).toMatchObject({ bites: 0, payments: 0 });
    expect(t.notes).toEqual([]);
    expect(t.logs).not.toContain('till: archive');
    expect((await t.service.payments()).length).toBe(3);
    await t.service.close();
  });

  it('one run at a time: a second ask joins the first, and an automatic one joins any', async () => {
    const t = await till(four, { auto: false });
    const a = t.service.archiveNow('asked');
    expect(t.service.archiveNow('asked')).toBe(a);
    expect(t.service.archiveNow('auto')).toBe(a);
    expect((await a).payments).toBe(3);
    await t.service.close();
  });

  it('before the till is open nothing is archived or read', async () => {
    const service = createTillService({
      store: fakeStoreDeps().deps,
      names: TILL_NAMES,
      settingsNames: TILL_SETTINGS,
      http: fakeMint().http,
      now: () => NOW,
      log: () => undefined,
    });
    await expect(service.archiveNow('asked')).rejects.toBeInstanceOf(TillNotOpenError);
    await expect(service.archivedTakings(null, null)).rejects.toBeInstanceOf(TillNotOpenError);
    await expect(service.isArchived('pay:x')).rejects.toBeInstanceOf(TillNotOpenError);
    await expect(service.archivedPayments()).rejects.toBeInstanceOf(TillNotOpenError);
  });

  it('the log says only that an archive ran, and the notes hold counts and times only', async () => {
    const t = await till(four, { auto: false });
    await t.service.archiveNow('asked');
    for (const l of t.logs) {
      expect(l.startsWith('till: ')).toBe(true);
    }
    expect(t.logs).toContain('till: archive');
    const text = JSON.stringify(t.notes);
    for (const bad of ['pay:', 'sale:', 'fx-', 'cashu', 'a-1']) {
      expect(text).not.toContain(bad);
    }
    expect(JSON.stringify(t.logs)).not.toContain('pay:');
    await t.service.close();
  });
});
