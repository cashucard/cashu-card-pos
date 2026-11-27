import { offlineInputFingerprint, type Row } from 'cashucard';
import { createSchema, createSerial, upgradeSchema } from '../src/till/store/db';
import { SqliteJournal } from '../src/till/store/journal';
import { OfflineSettingsStore } from '../src/till/store/offline';
import { backfillArchiveBatch } from '../src/till/store/offline-archive';
import { fakeDriver, memoryDb } from './helpers/fake-sql';

const mint = 'https://mint.test';
const row = (i: number) => ({
  kind: 'payment', id: 'p' + i, state: 'delivered', how: 'card', step: 'swapped', mint: mint + '/',
  plan: { inputs: [{secret:'local-card-proof-' + i}] },
}) as Row;
const digest = (i: number) => offlineInputFingerprint('local-card-proof-' + i);

it('moves a settled input to the spent index with the same commit, scoped to its mint', async () => {
  const driver = fakeDriver(memoryDb());
  await createSchema(driver);
  const serial = createSerial();
  const journal = new SqliteJournal(driver, serial, Date.now);
  const offline = new OfflineSettingsStore(driver, serial);
  await journal.write(row(7));
  driver.failOn('INSERT OR IGNORE INTO offline_spent_inputs','disk full');
  await expect(journal.remove('p7')).rejects.toThrow('disk full');
  expect(await journal.read('p7')).toMatchObject({id:'p7'});
  expect((await driver.run('SELECT * FROM archive')).rows).toHaveLength(0);
  driver.clearFailures();
  await journal.remove('p7');
  expect(await journal.read('p7')).toBeNull();
  expect(await offline.spentInputs(mint, [digest(1),digest(7)])).toEqual([digest(7)]);
  expect(await offline.spentInputs('https://other.test', [digest(7)])).toEqual([]);
  expect((await driver.run('SELECT * FROM offline_spent_inputs')).rows).toEqual([{mint,digest:digest(7)}]);
});

it('resumes indexing a layout 6 archive after interruption', async () => {
  const driver = fakeDriver(memoryDb());
  await createSchema(driver);
  driver.db.exec('DROP TABLE lightning_sales; DROP TABLE backup_imported_payments; DROP TABLE backup_control; DROP TABLE offline_spent_inputs; DROP TABLE offline_archive_cursor; PRAGMA user_version=6');
  for (let i=1; i<=66; i++) {
    await driver.run('INSERT INTO archive(id,kind,gen,written_at,archived_at,state,mint,body) VALUES (?,?,0,0,0,?,?,?)',
      ['p'+i, 'payment', 'delivered', mint, JSON.stringify(row(i))]);
  }
  await upgradeSchema(driver, 6);
  expect((await driver.run('SELECT * FROM offline_spent_inputs')).rows).toHaveLength(0);
  expect(await backfillArchiveBatch(driver)).toBe(false);
  driver.failOn('UPDATE offline_archive_cursor','interrupted');
  await expect(backfillArchiveBatch(driver)).rejects.toThrow('interrupted');
  expect((await driver.run('SELECT * FROM offline_spent_inputs')).rows).toHaveLength(64);
  driver.clearFailures();
  const restarted = new OfflineSettingsStore(driver,createSerial());
  expect((await restarted.spentInputs(mint,[digest(1),digest(66)])).sort()).toEqual([digest(1),digest(66)].sort());
  expect((await driver.run('SELECT * FROM offline_spent_inputs')).rows).toHaveLength(66);
  expect((await driver.run('SELECT count(*) AS n FROM archive')).rows[0].n).toBe(66);
});
