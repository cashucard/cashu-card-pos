import { walletPayout, type Delivery } from 'cashucard';
import { createSchema, createSerial, openDatabase } from '../src/till/store/db';
import { TillEvents } from '../src/till/store/events';
import { KeepStore } from '../src/till/store/keep-store';
import { dump, fakeDisk } from './helpers/fake-sql';

const KEY = 'ab'.repeat(32);

const D: Delivery = {
  id: 'fx-aaaaaaaaaaaaaaaaaaaaaaaaaa',
  mint: 'https://mint.test',
  unit: 'sat',
  amount: 14,
  token: 'cashuB' + 'q'.repeat(60),
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

async function setup() {
  const disk = fakeDisk();
  const { driver } = await openDatabase(disk.opener, '/d', 'k.db', KEY);
  await createSchema(driver);
  const fd = disk.drivers[0];
  const db = disk.files.get('/d/k.db')!.db;
  const serial = createSerial();
  const events = new TillEvents(driver, serial, () => 1000);
  const ks = new KeepStore(driver, serial, events, () => 1000);
  return { disk, driver, fd, db, events, ks };
}

describe('the keep store over SQLite', () => {
  it('a delivery is kept and listed', async () => {
    const { ks } = await setup();
    await ks.keep(D);
    expect(await ks.list()).toEqual([D]);
    expect(await ks.totals()).toEqual([
      { mint: 'https://mint.test/', unit: 'sat', amount: 14, count: 1 },
    ]);
  });

  it('the same delivery twice is kept once', async () => {
    const { ks, events } = await setup();
    await ks.keep(D);
    await ks.keep(D);
    expect(ks.calls.length).toBe(2);
    expect(await ks.list()).toHaveLength(1);
    expect((await ks.totals())[0].amount).toBe(14);
    expect(await events.list()).toEqual([]);
  });

  it('the first delivery of an id wins, and the second is noted without its token', async () => {
    const { ks, events } = await setup();
    await ks.keep(D);
    await expect(ks.keep({ ...D, token: 'cashuBother' })).resolves.toBeUndefined();
    expect((await ks.list())[0].token).toBe(D.token);
    const notes = await events.list();
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe('keep-mismatch');
    expect(notes[0].detail).toContain(D.id);
    expect(notes[0].detail).not.toContain('cashuB');
  });

  it('keep resolves only after the row is committed', async () => {
    const { ks, fd, db } = await setup();
    const release = fd.hold('INSERT INTO kept');
    let done = false;
    const p = ks.keep(D).then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    expect(dump(db, 'kept')).toEqual([]);
    release();
    await p;
    expect(done).toBe(true);
    expect(dump(db, 'kept')).toHaveLength(1);
  });

  it('a failed store rejects, so the library tries again later', async () => {
    const { ks, fd } = await setup();
    fd.failOn('INSERT INTO kept', 'disk full');
    await expect(ks.keep(D)).rejects.toThrow(/disk full/);
    const payout = walletPayout({ mints: [], keep: ks.keep });
    await expect(payout.deliver(D)).resolves.toMatchObject({ kind: 'later' });
    fd.clearFailures();
    await expect(payout.deliver(D)).resolves.toMatchObject({ kind: 'delivered' });
    expect(await ks.list()).toHaveLength(1);
  });

  it('a delivery of the wrong shape is refused and nothing is kept', async () => {
    const { ks } = await setup();
    const bad: Delivery[] = [
      { ...D, amount: 0 } as Delivery,
      { ...D, amount: 1.5 } as Delivery,
      { ...D, token: 'x' } as Delivery,
      { ...D, id: '' } as Delivery,
      { ...D, id: 'a b' } as Delivery,
      { ...D, unit: 'eur' } as unknown as Delivery,
    ];
    for (const d of bad) {
      await expect(ks.keep(d)).rejects.toThrow(/cannot be kept/);
    }
    expect(await ks.list()).toEqual([]);
    expect(ks.calls).toEqual([]);
  });

  it('totals group by the mint as normalized', async () => {
    const { ks } = await setup();
    await ks.keep({ ...D, id: 'fx-' + 'a'.repeat(26), mint: 'https://Mint.Test', amount: 14 });
    await ks.keep({ ...D, id: 'fx-' + 'b'.repeat(26), mint: 'https://mint.test:443', amount: 5 });
    await ks.keep({ ...D, id: 'fx-' + 'c'.repeat(26), mint: 'https://other.test', amount: 2 });
    expect(await ks.totals()).toEqual([
      { mint: 'https://mint.test/', unit: 'sat', amount: 19, count: 2 },
      { mint: 'https://other.test/', unit: 'sat', amount: 2, count: 1 },
    ]);
  });

  it('the kept delivery is a copy', async () => {
    const { ks } = await setup();
    const d: Delivery = { ...D };
    await ks.keep(d);
    d.amount = 99;
    expect((await ks.list())[0].amount).toBe(14);
    expect(ks.calls[0].amount).toBe(14);
  });

  it('events are listed in order with their time', async () => {
    const { events } = await setup();
    await events.add('created', 'first run');
    await events.add('set-aside', 'x');
    expect(await events.list()).toEqual([
      { seq: 1, at: 1000, kind: 'created', detail: 'first run' },
      { seq: 2, at: 1000, kind: 'set-aside', detail: 'x' },
    ]);
  });
});
