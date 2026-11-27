import { Amount, getEncodedToken, hashToCurve } from '@cashu/cashu-ts';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { MemoryJournal, walletPayout, type Delivery, type HttpFetch, type Row } from 'cashucard';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { protectedChangeJournal, reconciledPayout, reconcileSnapshot } from '../src/till/recovery-reconcile';
import { fakeStoreDeps } from './helpers/fake-store';

const mint = 'https://fixture.test';
const passphrase = 'test wallet on a test bench';
const noteY = (n: number) => hashToCurve(utf8ToBytes('local-test-'+n)).toHex(true);
const testProof = (n: number) => ({
  id: '01' + 'ab'.repeat(32), amount: Amount.from(n), secret: 'local-test-'+n,
  C: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
});
const delivery: Delivery = {
  id:'fixture', amount:3, mint, unit:'sat',
  token:getEncodedToken({mint,unit:'sat',proofs:[testProof(1),testProof(2)]}),
};
const spent = new Set<string>();
let pending = false;
const http: HttpFetch = async (url, init) => {
  if (url !== mint+'/v1/checkstate') throw new Error('Unexpected mint request');
  const states=JSON.parse(init.body!).Ys.map((Y:string) => ({
    Y, state: pending ? 'PENDING' : spent.has(Y) ? 'SPENT' : 'UNSPENT',
  }));
  return {status:200,text:async()=>JSON.stringify({states})};
};
function setup(device = fakeStoreDeps(), save = jest.fn(async (_:string) => {})) {
  const service = createTillService({store:device.deps,names:TILL_NAMES,settingsNames:TILL_SETTINGS,
    http,now:()=>42,log:()=>{},writeRecoveryCopy:save});
  return {service,device,save};
}

test('a restart in quarantine keeps sales and payouts closed; only verified, unspent notes reach the replacement wallet', async () => {
  const source=setup();
  await source.service.open();
  await source.device.disk.drivers[0].run('INSERT INTO kept(id,mint,mint_norm,unit,amount,token,body,kept_at) VALUES(?,?,?,?,?,?,?,?)',
    [delivery.id,mint,mint,'sat',delivery.amount,delivery.token,JSON.stringify(delivery),1]);
  const file=await source.service.recovery.exportFile(passphrase);
  await source.service.recovery.confirmSaved(file);
  await expect(source.service.recovery.setChangeEnabled(true,'a different passphrase')).rejects.toThrow();
  await source.service.recovery.setChangeEnabled(true,passphrase);
  expect((await source.service.recovery.status()).changeUnlocked).toBe(true);
  expect(source.save).toHaveBeenCalledTimes(1);
  await source.service.close();
  const original=setup(source.device).service;
  await original.open();
  expect(await original.recovery.status()).toMatchObject({changeEnabled:true,changeUnlocked:false,canRestore:false});
  await original.close();
  const target=setup();
  await target.service.open();
  await target.service.recovery.importFile(file,passphrase);
  expect(target.service.phase()).toMatchObject({kind:'ready',restoring:true});
  await target.service.close();
  const replacement=setup(target.device).service;
  expect(await replacement.open()).toMatchObject({kind:'ready',restoring:true});
  expect(replacement.lightning).toBeUndefined();
  await expect(replacement.openSale(1)).rejects.toThrow();
  await expect(replacement.walletBalances()).rejects.toThrow();
  pending=true;
  await expect(replacement.recovery.finishRestore()).rejects.toThrow(/pending/);
  pending=false;
  spent.add(noteY(2));
  await replacement.recovery.finishRestore();
  expect(await replacement.walletBalances()).toEqual([{mint,unit:'sat',available:1,withdrawal:null}]);
  expect((await replacement.recovery.status()).changeEnabled).toBe(false);
  await expect(replacement.recovery.importFile(file,passphrase)).rejects.toThrow(/fresh/);
  await expect(replacement.recovery.finishRestore()).rejects.toThrow();
  await replacement.close();
  spent.clear();
}, 60_000);

test('a recovered late delivery cannot credit spent or pending proofs', async () => {
  const keep=jest.fn(async (_:Delivery)=>{});
  const safe=reconciledPayout(walletPayout({mints:[mint],keep}),http);
  pending=true;
  expect((await safe.deliver(delivery)).kind).toBe('later');
  pending=false;
  spent.add(noteY(1)); spent.add(noteY(2));
  expect(await safe.deliver(delivery)).toMatchObject({kind:'refused',gone:true});
  expect(keep).not.toHaveBeenCalled();
  spent.delete(noteY(1));
  expect((await safe.deliver(delivery)).kind).toBe('delivered');
  expect(keep.mock.calls[0][0].amount).toBe(1);
  spent.clear();
});

test('the same live note cannot count as both a merchant taking and a customer return', async () => {
  const {service, device} = setup();
  await service.open();
  const db = device.disk.drivers[0];
  await db.run('INSERT INTO kept(id,mint,mint_norm,unit,amount,token,body,kept_at) VALUES(?,?,?,?,?,?,?,?)',
    [delivery.id, mint, mint, 'sat', delivery.amount, delivery.token, JSON.stringify(delivery), 1]);
  await db.run('INSERT INTO extra_handoffs(payment_id,mint,unit,amount,created_at,card_ref,token) VALUES(?,?,?,?,?,?,?)',
    ['customer', mint, 'sat', delivery.amount, 1, null, delivery.token]);
  await expect(reconcileSnapshot(db, http)).rejects.toThrow('same available note twice');
  await service.close();
});

test('a new sale on an activated replacement can deliver without a restore-time mint check', async () => {
  const keep = jest.fn(async (_: Delivery) => {});
  const check = jest.fn(async () => false);
  const fetch = jest.fn(async () => { throw new Error('unexpected request'); });
  const payout = reconciledPayout(walletPayout({mints:[mint], keep}), fetch, check);
  expect((await payout.deliver(delivery)).kind).toBe('delivered');
  expect(check).toHaveBeenCalledWith(delivery.id);
  expect(fetch).not.toHaveBeenCalled();
  expect(keep).toHaveBeenCalledTimes(1);
});

test('a failed recovery-folder write stops the signing intent; after signing it keeps the existing sale recoverable', async () => {
  const journal=new MemoryJournal();
  const save=jest.fn(async()=>{});
  const unavailable=jest.fn();
  const wrapper=protectedChangeJournal(journal,{save,unavailable},new Set());
  const row={kind:'payment',id:'pay:test',step:'sign-asked',plan:{own:[{},{}],ownCount:1}} as unknown as Extract<Row,{kind:'payment'}>;
  save.mockRejectedValueOnce(new Error('folder unavailable'));
  await expect(wrapper.write(row)).rejects.toThrow(/copy/);
  expect((await journal.read(row.id))?.id).toBe(row.id);
  await wrapper.write(row);
  save.mockRejectedValueOnce(new Error('folder offline'));
  await expect(wrapper.write({...row,step:'signed'})).resolves.toBeUndefined();
  expect(unavailable).toHaveBeenCalledTimes(2);
});

test('a customer return redeemed after activation shrinks on refresh, never reissues after full redemption', async () => {
  const source = setup();
  await source.service.open();
  await source.device.disk.drivers[0].run(
    'INSERT INTO extra_handoffs(payment_id,mint,unit,amount,token,created_at) VALUES(?,?,?,?,?,?)',
    ['saved-return', mint, 'sat', delivery.amount, delivery.token, 1],
  );
  const encrypted = await source.service.recovery.exportFile(passphrase);
  await source.service.close();
  const target = setup();
  await target.service.open();
  await target.service.recovery.importFile(encrypted, passphrase);
  await target.service.recovery.finishRestore();
  try {
    expect(await target.service.customerHandoffs()).toMatchObject([{id:'saved-return',amount:3}]);
    pending = true;
    await expect(target.service.customerToken('saved-return')).rejects.toThrow('still checking');
    expect(await target.service.customerHandoffs()).toMatchObject([{amount:3}]);
    pending = false;
    spent.add(noteY(2));
    expect(await target.service.customerHandoffs(true)).toMatchObject([{amount:1}]);
    const reduced = await target.service.customerToken('saved-return');
    expect(reduced).toBe(getEncodedToken({mint,unit:'sat',proofs:[testProof(1)]}));
    spent.add(noteY(1));
    await expect(target.service.customerToken('saved-return')).rejects.toThrow('has been redeemed');
    expect(await target.service.customerHandoffs()).toEqual([]);
    const db = target.device.disk.drivers[0];
    expect((await db.run('SELECT amount,token FROM extra_handoffs')).rows).toEqual([{amount:0,token:''}]);
    await target.service.close();
    const reopened = setup(target.device).service;
    await reopened.open();
    await expect(reopened.customerToken('saved-return')).rejects.toThrow('has been redeemed');
    await reopened.close();
  } finally {
    pending = false;
    spent.clear();
  }
}, 60_000);
