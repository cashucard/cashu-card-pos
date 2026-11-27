import { offlineInputFingerprint } from 'cashucard';
import { MAX_BACKUP_BYTES } from '../src/till/store/backup-crypto';
import { parseBackupRecord, readBackupRecord, replaceInitialRows } from '../src/till/store/backup-record';
import { emptySettings, saveSettings, TILL_SETTINGS, type TillSettings } from '../src/till/settings';
import { openStore, type OpenStore } from '../src/till/store/open-store';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeStoreDeps } from './helpers/fake-store';

jest.setTimeout(150_000);
const PASSPHRASE = 'one two three four five correct';
const MINT = 'https://mint.test';
const settings: TillSettings = { v: 1, seq: 1, mints: [
  { url: MINT, addedAt: 1, checkedAt: 2, keysets: [], status: 'ok', why: null },
] };

async function ready() {
  const device = fakeStoreDeps();
  const result = await openStore(device.deps, TILL_NAMES, { start: async () => true });
  if (result.kind !== 'ready') throw Error(result.kind);
  return { store: result.store, device };
}

let source: OpenStore;
let doc: string;

beforeAll(async () => {
  source = (await ready()).store;
  await source.driver.run("INSERT INTO journal VALUES('lease','lease',12,?,1)", [JSON.stringify({ kind:'lease', id:'lease', gen:12, at:1, beat:1, owner:'testing' })]);
  await source.generation.set(12);
  await source.driver.run("INSERT INTO journal VALUES('sale:1','sale',9,?,1)", [JSON.stringify({kind:'sale',id:'sale:1',gen:9})]);
  await source.driver.run("INSERT INTO journal VALUES('pay:old','payment',8,?,1)", [JSON.stringify({kind:'payment',id:'pay:old',gen:8})]);
  await source.driver.run("INSERT INTO kept VALUES('delivery','https://mint.test','https://mint.test','sat',12,?,?,1,NULL)", ['cashuBfixture', JSON.stringify({id:'delivery',mint:MINT,unit:'sat',amount:12,token:'cashuBfixture'})]);
  await source.driver.run("INSERT INTO extra_handoffs VALUES('customer',?,'sat',4,2,'original-card','cashuBchange')", [MINT]);
  await source.driver.run("INSERT INTO withdrawals VALUES('withdrawal',?,'sat','cashuBreserved',5,1,1)", [MINT]);
  await source.driver.run("INSERT INTO card_topups VALUES('topup','test-card',?,'ready',2,1,?)", [MINT, JSON.stringify({id:'topup',cardKey:'test-card',mint:MINT,state:'ready',revision:2,createdAt:1,amount:1,total:1,outputs:[{}],pieces:[{}],delivered:[],attempts:{},private:'fixture'})]);
  await source.driver.run("INSERT INTO lightning_sweeps VALUES(?,'some@example.test',100,3)", [MINT]);
  await source.driver.run("INSERT INTO lightning_payouts(id,payment_hash,mint,address,amount,max_fee,quoted_fee,input_amount,input_count,automatic,state,created_at,updated_at,expires_at,plan) VALUES ('lightning',?,?,'some@example.test',8,3,3,15,1,0,'quoted',1,2,100,?)", ['00'.repeat(32), MINT, '{"quoteId":"fixture","split":{"fixture":true}}']);
  await source.driver.run("INSERT INTO offline_kits VALUES(?,'null')", [MINT]);
  await source.driver.run("INSERT INTO offline_spent_inputs VALUES(?,?)", [MINT,offlineInputFingerprint('fixture-digest')]);
  await source.driver.run("INSERT INTO archive (_rowid_,id,kind,gen,written_at,archived_at,body) VALUES(93,'archived','sale',5,2,3,?)", [JSON.stringify({id:'archived',kind:'sale',gen:5})]);
  for (let i=0; i<130; i++) {
    await source.driver.run("INSERT INTO archive(_rowid_,id,kind,gen,written_at,archived_at,body) VALUES(?,?,'sale',5,2,3,?)", [200+i*2,'history-'+i,JSON.stringify({id:'history-'+i,kind:'sale',gen:5})]);
    await source.driver.run("INSERT INTO offline_spent_inputs VALUES(?,?)", [MINT,offlineInputFingerprint('history-'+i)]);
  }
  doc = await source.backups.exportFile(PASSPHRASE, settings);
});

test('export encrypts and authenticates all financial records and mint settings; manually inspecting a file leaves records untouched', async () => {
  expect(doc).toMatch(/^CASHU-POS-BACKUP-1\n/);
  for (const sensitive of ['cashuB','mint.test','some@example.test','test-card','fixture','private',PASSPHRASE]) expect(doc).not.toContain(sensitive);
  const {store} = await ready();
  const old = await store.backups.status();
  expect(old).toEqual({ canRestore:true, verifiedExport:false, lastExportAt:null, recovery:null, changeEnabled:false });
  await expect(store.backups.inspectFile(doc, PASSPHRASE)).resolves.toEqual({id:expect.stringMatching(/^[0-9a-f]{64}$/),createdAt:1000,generation:12,mints:[MINT]});
  expect(await store.backups.status()).toEqual(old);
  await expect(store.backups.restoreFile(doc, 'an incorrect backup password')).rejects.toThrow(/passphrase/i);
  const tampered = doc.slice(0, 113) + (doc[113] === 'Q' ? 'N' : 'Q') + doc.slice(114);
  await expect(store.backups.restoreFile(tampered, PASSPHRASE)).rejects.toThrow();
  expect(await store.backups.status()).toEqual(old);
});

test('fresh import is atomic, preserves pending assets and row order, and disarms authorizations before wallet access', async () => {
  const {store,device} = await ready();
  const driver = device.disk.drivers[0];
  driver.failOn("UPDATE backup_control SET recovery_id", 'IO failure');
  await expect(store.backups.restoreFile(doc, PASSPHRASE)).rejects.toThrow('IO failure');
  expect((await store.driver.run('SELECT * FROM kept')).rows).toEqual([]);
  expect((await store.backups.status()).canRestore).toBe(true);
  driver.clearFailures();
  const state = await store.backups.restoreFile(doc, PASSPHRASE);
  const id = state.recovery!.id;
  expect(state).toMatchObject({verifiedExport:false,canRestore:false,changeEnabled:false,recovery:{phase:'quarantined',mints:settings.mints}});
  await expect(store.backups.restoreFile(doc, PASSPHRASE)).resolves.toEqual(state);
  expect(await store.backups.restoredPaymentIds()).toEqual(['customer','pay:old']);
  expect((await store.driver.run('SELECT id,amount FROM kept')).rows).toEqual([{id:'delivery',amount:12}]);
  expect((await store.driver.run('SELECT id,amount FROM withdrawals')).rows).toEqual([{id:'withdrawal',amount:5}]);
  expect((await store.driver.run('SELECT payment_id,amount FROM extra_handoffs')).rows).toEqual([{payment_id:'customer',amount:4}]);
  expect((await store.driver.run('SELECT id,state FROM card_topups')).rows).toEqual([{id:'topup',state:'ready'}]);
  expect((await store.driver.run('SELECT state,plan FROM lightning_payouts')).rows).toEqual([{state:'submitted',plan:'{"quoteId":"fixture","split":{"fixture":true},"reconcileOnly":true}'}]);
  expect((await store.driver.run('SELECT * FROM lightning_sweeps')).rows).toEqual([]);
  expect((await store.driver.run('SELECT * FROM offline_kits')).rows).toEqual([]);
  expect((await store.driver.run('SELECT count(*) AS n FROM offline_spent_inputs')).rows).toEqual([{n:131}]);
  expect((await store.driver.run("SELECT mint FROM offline_spent_inputs WHERE digest=?", [offlineInputFingerprint('fixture-digest')])).rows).toEqual([{mint:MINT}]);
  expect((await store.driver.run("SELECT _rowid_ AS idx FROM archive WHERE id='archived'")).rows).toEqual([{idx:93}]);
  expect((await store.driver.run('SELECT max(_rowid_) AS top,count(*) AS n FROM archive')).rows).toEqual([{top:458,n:131}]);
  await expect(store.backups.setChangeEnabled(true)).rejects.toThrow();
  await expect(store.backups.activate('wrong',async()=>{})).rejects.toThrow();
  await expect(store.backups.activate(id,async db=>{
    await db.run('DELETE FROM kept');
    throw Error('mint states are ambiguous');
  })).rejects.toThrow('ambiguous');
  expect((await store.driver.run('SELECT id FROM kept')).rows).toHaveLength(1);
  expect((await store.backups.status()).recovery!.phase).toBe('quarantined');
  await expect(store.backups.activate(id, async () => {})).rejects.toThrow('waiting for mint confirmation');
  await store.backups.activate(id, async db=>{
    await db.run("UPDATE lightning_payouts SET state='failed',plan='' WHERE id='lightning'");
    await db.run('DELETE FROM kept');
  });
  expect((await store.backups.status()).recovery!.phase).toBe('active');
  await store.driver.run("INSERT INTO journal VALUES('pay:new','payment',99,'{}',2)");
  expect(await store.backups.restoredPaymentIds()).toEqual(['customer','pay:old']);
  await expect(store.backups.restoreFile(doc, PASSPHRASE)).rejects.toThrow('fresh till');
});

test('previous activity, a stale generation, or prior settings make restoration fail closed', async () => {
  const {store,device} = await ready();
  await saveSettings(device.secure, TILL_SETTINGS, emptySettings(), []);
  await expect(store.backups.restoreFile(doc, PASSPHRASE)).rejects.toThrow('fresh till');
  const target = (await ready()).store;
  await target.driver.run("INSERT INTO till_events(at,kind,detail) VALUES(1,'notice','old record')");
  await expect(target.backups.restoreFile(doc, PASSPHRASE)).rejects.toThrow('fresh till');
  const stale = (await ready()).store;
  await stale.generation.set(15);
  await expect(stale.backups.restoreFile(doc, PASSPHRASE)).rejects.toThrow('predates');
  await expect(stale.backups.exportFile(PASSPHRASE, emptySettings())).rejects.toThrow('generation');
});

test('PIN change requires confirmed saved bytes, automatic writers require the same passphrase and use unique nonces',async()=>{
  await expect(source.backups.setChangeEnabled(true)).rejects.toThrow();
  await expect(source.backups.confirmExport(doc + 'a')).rejects.toThrow('match');
  await source.backups.confirmExport(doc);
  await source.backups.confirmExport(doc);
  await source.backups.setChangeEnabled(true);
  expect((await source.backups.status()).changeEnabled).toBe(true);
  await expect(source.backups.unlockWriter('wrong passphrase for this')).rejects.toThrow('passphrase');
  const writer = await source.backups.unlockWriter(PASSPHRASE);
  const a = await writer.write(settings);
  const b = await writer.write(settings);
  expect(a).not.toBe(b);
  expect(await source.backups.inspectFile(a,PASSPHRASE)).toMatchObject({generation:12});
  writer.close();
  await expect(writer.write(settings)).rejects.toThrow('Unlock');
  await source.backups.setChangeEnabled(false);
  expect((await source.backups.status()).changeEnabled).toBe(false);
});

test('rejects damaged authenticated row bodies, wrong SQLite storage classes and a reused row index',async()=>{
  const s=(await ready()).store;
  for (const defect of ['body','type','rowid','columns']) {
    const snapshot=await readBackupRecord(source.driver,1000,settings);
    const t=snapshot.tables.kept;
    if(defect==='body') t.rows[0][t.columns.indexOf('body')]=JSON.stringify({amount:1});
    if(defect==='type') t.rows[0][t.columns.indexOf('kept_at')]='a';
    if(defect==='rowid') t.rows[0][0]=0;
    if(defect==='columns') t.columns[2]='another_table';
    await s.driver.run('BEGIN');
    await expect(replaceInitialRows(s.driver,snapshot,1000)).rejects.toThrow('damaged');
    await s.driver.run('ROLLBACK');
    expect((await s.backups.status()).canRestore).toBe(true);
  }
});

test('a single oversized database field is refused before it crosses the native bridge',async()=>{
  const {device,store}=await ready();
  await store.driver.run("INSERT INTO till_events(at,kind,detail) VALUES(1,'note',hex(zeroblob(?)))", [MAX_BACKUP_BYTES / 2 + 1]);
  await expect(readBackupRecord(store.driver,1000,emptySettings())).rejects.toThrow('16 MiB');
  expect(device.disk.drivers[0].log.some(sql => sql.includes(' AS backup_cursor,') && sql.includes(' FROM till_events '))).toBe(false);
});


test('a layout-8 portable backup restores into a till that accepts Lightning payments', async () => {
  const source = (await ready()).store;
  await source.keep.keep({id:'old', mint:MINT, unit:'sat', amount:12, token:'cashu-old'});
  const record = await readBackupRecord(source.driver, 42, settings);
  const {lightning_sales: empty, ...tables} = record.tables;
  expect(empty.rows).toEqual([]);
  const imported = parseBackupRecord(JSON.stringify({...record, layout:8, tables}));
  const target = (await ready()).store;
  await replaceInitialRows(target.driver, imported, 50);
  expect(await target.keep.totals()).toEqual(await source.keep.totals());
  expect(await target.lightningSales.list()).toEqual([]);
  await source.close();
  await target.close();
});
