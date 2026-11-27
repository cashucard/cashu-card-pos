/* Rules of the archive no earlier test held (slice 2.3 review), over the real library and the real store: a hand archive
 * asked while the till archives by itself waits for that run, then runs to its end; an archive the library answers
 * busy is asked again; a move whose commit fails leaves the payment in the record alone, and it moves at the next
 * archive; an older copy of a layout 1 record is still refused as rolled back once its layout is brought up to date. */

import { SCHEMA_VERSION } from '../src/till/store/sql';
import { CardError, open, walletPayout, type CashuCard, type HttpFetch } from 'cashucard';
import { openStore, type OpenStore } from '../src/till/store/open-store';
import { labNames } from '../src/till/store/types';
import { archiveTill, delivered, many, NOW, PATH } from './helpers/archive-till';
import { dump, restore, type NodeDb } from './helpers/fake-sql';
import { fakeStoreDeps, type FakeStore } from './helpers/fake-store';

const three = () => [delivered(1, NOW + 500), delivered(2, NOW + 1500), delivered(3, NOW + 2500)];

describe('the archive, rules held at last', () => {
  it('a hand archive asked while the till archives by itself waits for that run, then runs to its end', async () => {
    const t = await archiveTill(many(600), { auto: false });
    const auto = t.service.archiveNow('auto');
    const asked = t.service.archiveNow('asked');
    expect(await auto).toMatchObject({ why: 'auto', payments: 200, left: 400, ok: true });
    expect(await asked).toMatchObject({ why: 'asked', payments: 400, ok: true });
    expect(t.notes.filter((x) => x.scope === 'run').map((x) => x.n.why)).toEqual(['auto', 'asked']);
    expect(await t.service.payments()).toEqual([]);
    await t.service.close();
  }, 60000);

  it('an archive the library answers busy is asked again, and then runs', async () => {
    const t = await archiveTill(three, { auto: false });
    const c = await t.service.read(async (x: CashuCard) => x);
    const real = c.archive.bind(c);
    let calls = 0;
    c.archive = async (days: number) => {
      calls += 1;
      if (calls === 1) {
        throw new CardError('busy', 'A settle is running; archive after it.');
      }
      return real(days);
    };
    const n = await t.service.archiveNow('asked');
    expect(n).toMatchObject({ payments: 3, ok: true, error: null });
    expect(calls).toBe(2);
    await t.service.close();
  }, 60000);

  it('a move whose commit fails leaves the payment in the record alone, and it moves at the next archive', async () => {
    const t = await archiveTill(three, { auto: false });
    const driver = t.f.disk.drivers.filter((x) => !x.closed).pop()!;
    driver.failOn('COMMIT', 'disk I/O error');
    const first = await t.service.archiveNow('asked');
    expect(first.ok).toBe(false);
    const db = t.f.disk.files.get(PATH)!.db;
    expect(dump(db, 'archive')).toEqual([]);
    expect((await t.service.payments()).length).toBe(3);
    driver.clearFailures();
    const second = await t.service.archiveNow('asked');
    expect(second).toMatchObject({ payments: 3, ok: true });
    const archive = dump(db, 'archive');
    expect(new Set(archive.map((r) => r.id)).size).toBe(archive.length);
    expect(archive.filter((r) => r.kind === 'payment')).toHaveLength(3);
    expect(dump(db, 'journal').filter((r) => r.kind === 'payment')).toEqual([]);
    expect(await t.service.archivedTakings(null, null)).toEqual({ sats: 42, count: 3 });
    await t.service.close();
  }, 60000);

  it('an older copy of a layout 1 record is still refused as rolled back once its layout is brought up to date', async () => {
    const names = labNames('r');
    const path = '/app/lab/lab-r.db';
    const http: HttpFetch = async () => {
      throw new Error('no fetch expected');
    };
    const start = (s: OpenStore, acceptRollback: boolean): Promise<CashuCard> =>
      open({
        journal: s.journal,
        generationStore: s.generation,
        acceptRollback,
        payout: walletPayout({ mints: [], keep: s.keep.keep }),
        http,
        leftoverByPin: false,
        clock: null,
      });
    const invoice = 'lnbc140n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfs7lvu5';
    const used = async (f: FakeStore, sales: string[]): Promise<void> => {
      const out = await openStore(f.deps, names, { start });
      if (out.kind !== 'ready') {
        throw new Error(out.kind);
      }
      for (const id of sales) {
        await out.value.receive({ id, sats: 14, invoice });
      }
      await out.store.close();
    };
    const version = (db: NodeDb): number => Number(db.prepare('PRAGMA user_version').all()[0].user_version);
    const f = fakeStoreDeps();
    await used(f, ['a']);
    const db = f.disk.files.get(path)!.db;
    const snap = dump(db, 'journal');
    const ev = dump(db, 'till_events');
    await used(f, ['b', 'c']);
    // the copy kept after the first sale, as layout 1 made it, put back
    restore(db, 'journal', snap);
    restore(db, 'till_events', ev);
    db.exec('DROP TABLE lightning_sales; DROP TABLE backup_imported_payments; DROP TABLE backup_control; DROP TABLE card_topups; DROP TABLE offline_archive_cursor; DROP TABLE offline_spent_inputs; DROP TABLE offline_kits; DROP TABLE lightning_checkpoint; DROP TABLE lightning_sweeps; DROP TABLE lightning_payouts; DROP TABLE archive; DROP TABLE withdrawals; DROP TABLE extra_handoffs');
    db.exec('DROP INDEX kept_withdrawal; ALTER TABLE kept DROP COLUMN withdrawal');
    db.exec('PRAGMA user_version = 1');
    const out = await openStore(f.deps, names, { start });
    expect(out.kind).toBe('rolled-back');
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(dump(db, 'journal')).toEqual(snap);
  });
});
