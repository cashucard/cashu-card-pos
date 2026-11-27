import { Amount, getEncodedToken } from '@cashu/cashu-ts';
import type { Delivery } from 'cashucard';
import { createSchema, createSerial, openDatabase, upgradeSchema } from '../src/till/store/db';
import { TillEvents } from '../src/till/store/events';
import { KeepStore } from '../src/till/store/keep-store';
import { LightningStore, type LightningReservation } from '../src/till/store/lightning';
import { SCHEMA_VERSION } from '../src/till/store/sql';
import { checkpointItem, lightningCheckpoint } from '../src/till/store/lightning-checkpoint';
import { labNames } from '../src/till/store/types';
import { WalletStore } from '../src/till/store/wallet';
import { dump, restore } from './helpers/fake-sql';
import { fakeStoreDeps } from './helpers/fake-store';

const mint = 'https://merchant.test/';
const address = 'merchant@wallet.test';
const key = 'bb'.repeat(32);
const keyset = '01' + '22'.repeat(32);
const point = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

function delivery(id: string, amount: number, at = mint): Delivery {
  return {
    id, mint: at, unit: 'sat', amount,
    token: getEncodedToken({ mint: at, unit: 'sat', proofs: [{ id: keyset, secret: id, amount: Amount.from(amount), C: point }] }),
  };
}

const quote: LightningReservation = {
  id: 'local-id', paymentHash: '1f'.repeat(32), mint, address, amount: 5, maxFee: 2,
  automatic: false, expiresAt: 2000, inputIds: ['sale'], plan: '{"privateOutputs":"fixture"}',
};

async function setup() {
  let time = 1000;
  const now = () => time;
  const { disk, deps, secure } = fakeStoreDeps();
  const names = labNames('ln');
  const checkpoint = lightningCheckpoint(deps, names);
  const reopen = async () => {
    const { driver } = await openDatabase(disk.opener, '/d', 'payout.db', key);
    const serial = createSerial();
    return {
      driver,
      lightning: new LightningStore(driver, serial, now, checkpoint),
      ecash: new WalletStore(driver, serial),
      kept: new KeepStore(driver, serial, new TillEvents(driver, serial, now), now),
    };
  };
  const store = await reopen();
  await createSchema(store.driver);
  return {
    ...store, reopen, fd: disk.drivers[0], db: disk.files.get('/d/payout.db')!.db,
    secure, checkpointName: checkpointItem(names), setTime(t: number) { time = t; },
  };
}

it('reopens a paid transaction after loss of response, and makes its change available exactly once', async () => {
  const t = await setup();
  await t.kept.keep(delivery('sale', 16));
  await t.lightning.reserve(quote);
  expect(await t.lightning.available(mint)).toEqual([]);
  expect(await t.kept.totals()).toEqual([{ mint, unit: 'sat', amount: 16, count: 1 }]);
  await expect(t.ecash.prepare(mint, 'sat')).rejects.toThrow('No takings');
  expect(await Promise.all([t.lightning.start(quote.id), t.lightning.start(quote.id)])).toEqual([true, false]);
  await t.driver.close();
  const again = await t.reopen();
  expect(await again.lightning.start(quote.id)).toBe(false);
  expect(await again.lightning.active()).toEqual([expect.objectContaining({ id: quote.id, state: 'submitted', plan: quote.plan })]);
  await expect(again.lightning.cancel(quote.id)).rejects.toThrow();
  const change = delivery('spent-change-proof', 10);
  await again.lightning.paid(quote.id, change);
  await again.lightning.paid(quote.id, change);
  await again.kept.keep(delivery('sale', 16)); // redelivery is idempotent even after the melt.
  expect(await again.lightning.active()).toEqual([]);
  expect(await again.lightning.recent(mint)).toEqual([expect.objectContaining({ state: 'paid', fee: 1 })]);
  expect((await again.lightning.recent(mint))[0]).not.toHaveProperty('plan');
  expect((await again.lightning.get(quote.id))?.plan).toBe('');
  expect(await again.kept.totals()).toEqual([{ mint, unit: 'sat', amount: 10, count: 1 }]);
  await again.ecash.prepare(mint, 'sat');
  expect((await again.ecash.balances())[0].withdrawal?.amount).toBe(10);
});

it('recovers unsettled change if the final write fails and never loses a reserved input', async () => {
  const t = await setup();
  await t.kept.keep(delivery('sale', 8));
  t.fd.failOn('INSERT INTO lightning_payouts', 'disk full');
  await expect(t.lightning.reserve(quote)).rejects.toThrow('disk full');
  expect(await t.lightning.available(mint)).toHaveLength(1);
  t.fd.clearFailures();
  await t.lightning.reserve(quote);
  await t.lightning.start(quote.id);
  t.fd.failOn("SET state='paid'", 'disk full');
  await expect(t.lightning.paid(quote.id, delivery('change', 2))).rejects.toThrow('disk full');
  t.fd.clearFailures();
  expect(await t.lightning.available(mint)).toEqual([]);
  expect((await t.lightning.active())[0].plan).toBe(quote.plan);
  await t.lightning.paid(quote.id, delivery('change', 2));
  expect((await t.lightning.available(mint))[0].amount).toBe(2);
});

it('accounts for confirmed change from a payout that exceeded its original quote, exactly once', async () => {
  const t = await setup();
  const original = { ...quote, amount: 20 };
  await t.kept.keep(delivery('sale', 64));
  await t.lightning.reserve(original);
  await t.lightning.start(original.id);
  const change = delivery('confirmed-change', 40);
  const verified = { paymentHash: original.paymentHash, actualFee: 4 };
  for (const evidence of [undefined, { ...verified, paymentHash: 'ab'.repeat(32) }, { ...verified, actualFee: 3 }]) {
    await expect(t.lightning.paid(original.id, change, evidence)).rejects.toThrow('expected change');
  }
  expect(await t.lightning.available(mint)).toEqual([]);
  await expect(t.lightning.paid(original.id, delivery('wrong-mint', 40, 'https://elsewhere.test'), verified)).rejects.toThrow();
  await t.lightning.paid(original.id, change, verified);
  await t.lightning.paid(original.id, change, verified);
  expect(await t.lightning.recent(mint)).toEqual([expect.objectContaining({ amount: 20, maxFee: 2, fee: 4, state: 'paid' })]);
  expect((await t.lightning.available(mint)).map(r => r.amount)).toEqual([40]);
});

it('retains the merchant fee ceiling and the provider quote when those limits differ', async () => {
  const t = await setup();
  await t.kept.keep(delivery('sale', 32));
  await expect(t.lightning.reserve({ ...quote, maxFee: 4, quotedFee: 5 })).rejects.toThrow();
  const r = { ...quote, amount: 24, maxFee: 4, quotedFee: 2 };
  await t.lightning.reserve(r);
  await t.lightning.start(r.id);
  const change = delivery('change', 4);
  await expect(t.lightning.paid(r.id, change)).rejects.toThrow('expected change');
  await t.lightning.paid(r.id, change, { paymentHash: r.paymentHash, actualFee: 4 });
  expect(await t.lightning.recent(mint)).toEqual([expect.objectContaining({ quotedFee: 2, maxFee: 4, fee: 4 })]);
});

it('upgrades active and completed layout-4 payouts in place and keeps their row order and reservation', async () => {
  const t = await setup();
  await t.kept.keep(delivery('prior-sale', 8));
  await t.lightning.reserve({ ...quote, id: 'prior', inputIds: ['prior-sale'], paymentHash: '0d'.repeat(32) });
  await t.lightning.start('prior');
  await t.lightning.paid('prior', delivery('old-change', 2));
  await t.kept.keep(delivery('sale', 64));
  await t.lightning.setPolicy(mint, address, 8, 4);
  await t.lightning.reserve({ ...quote, amount: 20 });
  await t.lightning.start(quote.id);
  // Recreate the installed layout, including the original fee constraint, without a separate quoted_fee.
  const cols = 'rowid,id,payment_hash,mint,address,amount,max_fee,input_amount,input_count,automatic,state,created_at,updated_at,expires_at,fee,plan';
  const query = 'SELECT ' + cols + ' FROM lightning_payouts ORDER BY rowid';
  const defs = await t.driver.run("SELECT sql FROM sqlite_master WHERE tbl_name='lightning_payouts' AND sql IS NOT NULL ORDER BY type DESC");
  await t.driver.run('CREATE TEMP TABLE fixture_rows AS ' + query);
  await t.driver.run('DROP TABLE lightning_payouts');
  for (const row of defs.rows) {
    const ddl = String(row.sql).replace(/\s+quoted_fee INTEGER[^\n]+/, '').replace('fee <= input_amount - amount', 'fee <= max_fee');
    await t.driver.run(ddl);
  }
  await t.driver.run('INSERT INTO lightning_payouts (' + cols + ') SELECT ' + cols + ' FROM fixture_rows');
  await t.driver.run('DROP TABLE fixture_rows');
  await t.driver.run('DROP TABLE lightning_sales');
  await t.driver.run('DROP TABLE backup_imported_payments');
  await t.driver.run('DROP TABLE backup_control');
  await t.driver.run('DROP TABLE card_topups');
  await t.driver.run('DROP TABLE offline_archive_cursor');
  await t.driver.run('DROP TABLE offline_spent_inputs');
  await t.driver.run('DROP TABLE offline_kits');
  await t.driver.run('PRAGMA user_version=4');
  const before = (await t.driver.run(query)).rows;
  t.fd.failOn('ALTER TABLE lightning_payouts_v5', 'injected disk error');
  await expect(upgradeSchema(t.driver, 4)).rejects.toThrow();
  expect((await t.driver.run('PRAGMA user_version')).rows[0].user_version).toBe(4);
  expect((await t.driver.run(query)).rows).toEqual(before);
  t.fd.clearFailures();
  await upgradeSchema(t.driver, 4);
  expect((await t.driver.run(query)).rows).toEqual(before);
  expect((await t.driver.run('PRAGMA foreign_key_check')).rows).toEqual([]);
  expect(await t.lightning.policies()).toEqual([{ mint, address, threshold: 8, maxFee: 4 }]);
  expect((await t.lightning.active())[0]).toMatchObject({ id: quote.id, state: 'submitted', plan: quote.plan, quotedFee: quote.maxFee });
  expect((await t.lightning.available(mint)).map(r => r.amount)).toEqual([2]);
  await t.lightning.paid(quote.id, delivery('restored-change', 40), { paymentHash: quote.paymentHash, actualFee: 4 });
  expect((await t.lightning.available(mint)).map(r => r.amount)).toEqual([2, 40]);
});

it('keeps submitted inputs reserved despite expiry and credits only valid change for this quote', async () => {
  const t = await setup();
  await t.kept.keep(delivery('sale', 8));
  await t.lightning.reserve(quote);
  await t.lightning.start(quote.id);
  t.setTime(6000);
  await t.lightning.expireQuotes();
  await expect(t.lightning.cancel(quote.id)).rejects.toThrow();
  await expect(t.lightning.paid(quote.id, null)).rejects.toThrow('expected change');
  await expect(t.lightning.paid(quote.id, delivery('bad-mint', 2, 'https://someone.test'))).rejects.toThrow('does not match');
  await expect(t.lightning.paid(quote.id, delivery('too-much', 4))).rejects.toThrow('expected change');
  expect((await t.lightning.get(quote.id))?.state).toBe('submitted');
  await t.lightning.failed(quote.id);
  await t.lightning.failed(quote.id);
  expect((await t.lightning.recent(mint))[0].state).toBe('failed');
  expect((await t.lightning.available(mint)).map(r => r.id)).toEqual(['sale']);
  await expect(t.lightning.paid(quote.id, delivery('late', 2))).rejects.toThrow();
});

it('allows only a submitted reservation to be abandoned before dispatch, leaving the hash used', async () => {
  const t = await setup();
  await t.kept.keep(delivery('sale', 8));
  await t.lightning.reserve(quote);
  await expect(t.lightning.abandonBeforePost(quote.id)).rejects.toThrow();
  expect(await t.lightning.start(quote.id)).toBe(true);
  await t.lightning.abandonBeforePost(quote.id);
  await t.lightning.abandonBeforePost(quote.id);
  expect((await t.lightning.get(quote.id))?.state).toBe('cancelled');
  expect((await t.lightning.available(mint)).map(x => x.id)).toEqual(['sale']);
  await expect(t.lightning.reserve({ ...quote, id: 'other' })).rejects.toThrow();
  expect(await t.lightning.start(quote.id)).toBe(false);
});

it('rejects the same invoice hash at a second mint and rolls back every newly selected input', async () => {
  const t = await setup();
  const second = 'https://second.test/path';
  await t.kept.keep(delivery('sale', 8));
  await t.kept.keep(delivery('other', 16, second));
  await t.lightning.reserve(quote);
  await t.lightning.start(quote.id);
  await t.lightning.paid(quote.id, delivery('change', 1));
  await expect(t.lightning.reserve({
    ...quote, id: 'another-id', mint: second, paymentHash: quote.paymentHash.toUpperCase(), inputIds: ['other'],
  })).rejects.toThrow();
  expect(await t.lightning.available(second)).toEqual([expect.objectContaining({ id: 'other', amount: 16 })]);
  await t.lightning.reserve({ ...quote, id: 'second', paymentHash: '02'.repeat(32), mint: second, inputIds: ['other'] });
  expect(await t.lightning.mints()).toEqual([mint, second]);
});

it('refuses an unavailable input, cross-mint inputs, repeated IDs, and a conflicting quote in the same mint', async () => {
  const t = await setup();
  await t.kept.keep(delivery('moved', 8));
  await t.ecash.prepare(mint, 'sat');
  await t.kept.keep(delivery('sale', 8));
  await t.kept.keep(delivery('s2', 8));
  await t.kept.keep(delivery('foreign', 16, 'https://another.test'));
  for (const ids of [['sale', 'moved'], ['sale', 'absent'], ['sale','sale'], ['sale','foreign']]) {
    await expect(t.lightning.reserve({ ...quote, inputIds: ids })).rejects.toThrow();
  }
  await expect(t.lightning.reserve({ ...quote, amount: 8, maxFee: 1 })).rejects.toThrow();
  expect((await t.lightning.available(mint)).map(x => x.id)).toEqual(['sale','s2']);
  await t.lightning.reserve(quote);
  await expect(t.lightning.reserve({ ...quote, id: 'q2', inputIds: ['s2'], paymentHash: '9a'.repeat(32) })).rejects.toThrow();
  expect((await t.lightning.available(mint)).map(x => x.id)).toEqual(['s2']);
  expect((await t.ecash.balances()).find(row => row.mint === mint)?.withdrawal?.id).toBe('moved');
});

it('only an unsubmitted quote can expire or be cancelled and an expired quote never leaves the database ready to send', async () => {
  const t = await setup();
  await t.kept.keep(delivery('sale', 8));
  await t.lightning.reserve(quote);
  t.setTime(quote.expiresAt);
  expect(await t.lightning.start(quote.id)).toBe(false);
  expect((await t.lightning.get(quote.id))?.state).toBe('cancelled');
  await t.lightning.cancel(quote.id);
  t.setTime(1000);
  const second = { ...quote, paymentHash: '88'.repeat(32), id: 'next' };
  await t.lightning.reserve(second);
  t.setTime(quote.expiresAt + 1);
  await t.lightning.expireQuotes();
  expect(await t.lightning.active()).toEqual([]);
  expect((await t.lightning.available(mint))[0].id).toBe('sale');
});

it('keeps the current withdrawal first in Wallet when the phone clock moves backwards', async () => {
  const t = await setup();
  await t.kept.keep(delivery('sale', 8));
  await t.lightning.reserve(quote);
  await t.lightning.cancel(quote.id);
  t.setTime(500);
  const current = { ...quote, paymentHash: '89'.repeat(32), id: 'current' };
  await t.lightning.reserve(current);
  expect((await t.lightning.recent(mint)).map(row => row.id)).toEqual([current.id, quote.id]);
});

it('enforces the sweep destination, retained balance and maximum total fee at reserve and submission', async () => {
  const t = await setup();
  const auto = { ...quote, automatic: true };
  await t.kept.keep(delivery('sale', 8));
  await t.kept.keep(delivery('store-floor', 8));
  await t.lightning.setPolicy(mint, address, 9, 2);
  for (const changed of [{ address: 'somebody@wallet.test' }, { amount: 6 }, { maxFee: 3 }]) {
    await expect(t.lightning.reserve({ ...auto, ...changed })).rejects.toThrow();
  }
  await t.lightning.reserve(auto); // 16 - 5 - 2 = 9
  await t.ecash.prepare(mint, 'sat'); // competing withdrawal takes the unreserved 8 before submission
  expect(await t.lightning.start(auto.id)).toBe(false);
  expect((await t.lightning.available(mint))[0].amount).toBe(8);
  expect(await t.lightning.policies()).toEqual([{ mint, address, threshold: 9, maxFee: 2 }]);
});

it('editing or disabling a sweep cancels its quote but preserves a payment already in flight', async () => {
  const t = await setup();
  await t.kept.keep(delivery('sale', 16));
  await t.lightning.setPolicy(mint, address, 0, 2);
  await t.lightning.reserve({ ...quote, automatic: true });
  await t.lightning.setPolicy(mint, address, 1, 2);
  expect(await t.lightning.start(quote.id)).toBe(false);
  const id = 'next';
  await t.lightning.reserve({ ...quote, id, paymentHash: 'ab'.repeat(32), automatic: true });
  expect(await t.lightning.start(id)).toBe(true);
  await t.lightning.disablePolicy(mint);
  expect(await t.lightning.policies()).toEqual([]);
  expect((await t.lightning.active())[0].state).toBe('submitted');
  expect(await t.lightning.available(mint)).toEqual([]);
});

it('upgrades a build-9 database while preserving a live Cashu withdrawal and unreserved takings', async () => {
  const t = await setup();
  await t.driver.run('DROP TABLE lightning_checkpoint');
  await t.driver.run('DROP TABLE lightning_payouts');
  await t.driver.run('DROP TABLE lightning_sweeps');
  await t.driver.run('DROP TABLE lightning_sales');
  await t.driver.run('DROP TABLE backup_imported_payments');
  await t.driver.run('DROP TABLE backup_control');
  await t.driver.run('DROP TABLE card_topups');
  await t.driver.run('DROP TABLE offline_archive_cursor');
  await t.driver.run('DROP TABLE offline_spent_inputs');
  await t.driver.run('DROP TABLE offline_kits');
  await t.driver.run('PRAGMA user_version=3');
  await t.kept.keep(delivery('still-withdrawing', 8));
  await t.ecash.prepare(mint, 'sat');
  const outstanding = await t.ecash.token('still-withdrawing');
  await t.kept.keep(delivery('sale', 16));
  await t.driver.close();

  const after = await t.reopen();
  await upgradeSchema(after.driver, 3);
  expect((await after.driver.run('PRAGMA user_version')).rows[0].user_version).toBe(SCHEMA_VERSION);
  expect(await after.lightning.active()).toEqual([]);
  expect(await after.lightning.policies()).toEqual([]);
  expect(await after.ecash.token('still-withdrawing')).toBe(outstanding);
  await after.lightning.reserve(quote);
  expect((await after.kept.totals())[0]).toMatchObject({ amount: 24, count: 2 });
  expect(await after.ecash.token('still-withdrawing')).toBe(outstanding);
});

it('disarms an older wallet restored between card sales and checks the old quote without sending it', async () => {
  const t = await setup();
  await t.kept.keep(delivery('sale', 16));
  await t.lightning.setPolicy(mint, address, 5, 2);
  await t.lightning.reserve({ ...quote, automatic: true });
  const tables = ['lightning_payouts', 'lightning_sweeps', 'lightning_checkpoint', 'kept'];
  const snapshot = tables.map(table => ({ table, rows: dump(t.db, table) }));
  expect(await t.lightning.start(quote.id)).toBe(true);
  await t.lightning.disablePolicy(mint);
  await t.driver.close();
  for (const { table, rows } of snapshot) restore(t.db, table, rows);

  const again = await t.reopen();
  expect(await again.lightning.start(quote.id)).toBe(false);
  expect(await again.lightning.policies()).toEqual([]);
  expect((await again.lightning.get(quote.id))?.state).toBe('submitted');
  expect(await again.lightning.available(mint)).toEqual([]);
  await again.lightning.paid(quote.id, delivery('original-change', 10));
  expect((await again.lightning.available(mint))[0].amount).toBe(10);
});

it('keeps an ambiguous start check-only if SQLite fails after the independent device revision was saved', async () => {
  const t = await setup();
  await t.kept.keep(delivery('sale', 8));
  await t.lightning.reserve(quote);
  t.fd.failOn('INSERT OR REPLACE INTO lightning_checkpoint', 'disk full');
  await expect(t.lightning.start(quote.id)).rejects.toThrow('disk full');
  expect(t.secure.items.has(t.checkpointName)).toBe(true);
  t.fd.clearFailures();
  expect(await t.lightning.start(quote.id)).toBe(false);
  expect((await t.lightning.get(quote.id))?.state).toBe('submitted');
  expect(await t.lightning.available(mint)).toEqual([]);
});

it('preserves the existing quote when the phone cannot store a new authorization', async () => {
  const t = await setup();
  await t.kept.keep(delivery('sale', 8));
  await t.lightning.reserve(quote);
  t.secure.failSet.add(t.checkpointName);
  await expect(t.lightning.start(quote.id)).rejects.toThrow();
  await expect(t.lightning.setPolicy(mint, address, 0, 2)).rejects.toThrow();
  expect((await t.lightning.get(quote.id))?.state).toBe('quoted');
  expect(await t.lightning.policies()).toEqual([]);
  t.secure.failSet.clear();
  expect(await t.lightning.start(quote.id)).toBe(true);
});
