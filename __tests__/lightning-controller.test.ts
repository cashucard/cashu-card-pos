import { Amount, getEncodedToken } from '@cashu/cashu-ts';
import { createLightningWallet } from '../src/till/lightning';
import type { LightningPlan, LightningResult, prepareLightning } from '../src/till/lightning-transport';
import { createSchema, createSerial } from '../src/till/store/db';
import { KeepStore } from '../src/till/store/keep-store';
import { LightningStore } from '../src/till/store/lightning';
import { TillEvents } from '../src/till/store/events';
import { fakeDriver, memoryDb } from './helpers/fake-sql';

const mint = 'https://wallet.test/';
const address = 'merchant@address.test';
const policy = { address, threshold: 20, maxFee: 3 };
const keyset = '01' + '22'.repeat(32);
const point = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

function delivery(id: string, amount: number, at = mint) {
  const proofs = [{ id: keyset, secret: id, amount: Amount.from(amount), C: point }];
  return { id, mint: at, unit: 'sat' as const, amount, token: getEncodedToken({ mint: at, unit: 'sat', proofs }) };
}

async function fixture() {
  const driver = fakeDriver(memoryDb());
  const serial = createSerial();
  let seq = 0;
  let revision: string | null = null;
  const context = { now: 1000, foreground: true, approved: true, fee: 1 };
  const now = () => context.now;
  await createSchema(driver);
  const ledger = new LightningStore(driver, serial, now, {
    read: async () => revision,
    advance: async () => (revision = String(++seq)),
  });
  const kept = new KeepStore(driver, serial, new TillEvents(driver, serial, now), now);
  const prepare = jest.fn(async (_http: Parameters<typeof prepareLightning>[0], q: Parameters<typeof prepareLightning>[1]): Promise<LightningPlan> => ({
    mint: q.mint, address: q.address, amount: q.amount, paymentHash: (++seq).toString(16).padStart(64,'0'),
    invoice: 'test-only', quoteId: String(seq), expiresAt: now()+100, releaseAfter: now()+200,
    inputIds: q.rows.map(r => r.id), inputAmount: q.rows.reduce((n,r) => n+r.amount,0),
    maxFee: context.fee, inputFee: 0, inputs: [], retained: [], outputs: [],
  }));
  function paid(plan: LightningPlan): LightningResult {
    const remainder = plan.inputAmount - plan.amount - plan.maxFee;
    return { state: 'paid', change: remainder ? delivery('change-'+plan.quoteId, remainder, plan.mint) : null };
  }
  const submit = jest.fn(async (_http: Parameters<typeof prepareLightning>[0], plan: LightningPlan) => paid(plan));
  const check = jest.fn(async (_http: Parameters<typeof prepareLightning>[0], plan: LightningPlan) => paid(plan));
  const open = () => createLightningWallet({
    ledger, now, newId: () => 'local-'+(++seq), http: jest.fn(),
    acceptsMint: () => context.approved, inForeground: () => context.foreground, protocol: { prepare, submit, check },
  });
  const wallet = open();
  return { wallet, ledger, kept, open, submit, check, prepare, context };
}

it('leaves a manual quote untouched by sweeps and by reopening, and concurrent confirms pay just once', async () => {
  const t = await fixture();
  await t.kept.keep(delivery('sale',32));
  const quote = await t.wallet.quote(mint,address,12);
  const repeated = await t.wallet.quote(mint,address,12);
  expect(repeated.id).toBe(quote.id);
  await t.wallet.configure(mint, policy);
  await t.wallet.tick();
  await t.wallet.close();
  const next = t.open();
  await next.tick();
  expect(t.submit).not.toHaveBeenCalled();
  await Promise.all([next.confirm(mint,quote.id),next.confirm(mint,quote.id)]);
  expect(t.submit).toHaveBeenCalledTimes(1);
  expect((await next.state(mint)).payment).toMatchObject({ status:'paid', amount:12, feePaid:1, automatic:false });
  await next.close();
});

it('checks the original quote after a lost answer and restart; a second press cannot send it again', async () => {
  const t = await fixture();
  await t.kept.keep(delivery('sale',32));
  const q = await t.wallet.quote(mint,address,10);
  t.submit.mockRejectedValueOnce(new Error('simulated loss of response'));
  expect((await t.wallet.confirm(mint,q.id)).status).toBe('pending');
  expect(await t.ledger.available(mint)).toEqual([]);
  await t.wallet.close();
  const next=t.open();
  expect((await next.refresh(mint)).payment).toMatchObject({ id:q.id,status:'paid',feePaid:1 });
  expect(t.check).toHaveBeenCalledTimes(1);
  expect(t.check.mock.calls[0][1].quoteId).toBe(t.submit.mock.calls[0][1].quoteId);
  await next.confirm(mint,q.id);
  expect(t.submit).toHaveBeenCalledTimes(1);
  await next.close();
});

it('refuses to post when the phone leaves the foreground during the durable start', async () => {
  const t = await fixture();
  await t.kept.keep(delivery('sale',16));
  const q=await t.wallet.quote(mint,address,8);
  const start=t.ledger.start.bind(t.ledger);
  jest.spyOn(t.ledger,'start').mockImplementationOnce(async id => {
    const won=await start(id);
    t.context.foreground=false;
    return won;
  });
  await expect(t.wallet.confirm(mint,q.id)).rejects.toThrow('Open the till');
  expect(t.submit).not.toHaveBeenCalled();
  expect((await t.ledger.available(mint))[0].amount).toBe(16);
  expect((await t.wallet.state(mint)).payment).toBeNull();
});

it('waits at the floor and when the till is in the background, rejects excessive fees and retains the chosen balance',async()=>{
  const t=await fixture();
  t.context.foreground=false;
  await t.kept.keep(delivery('sale',16));
  await t.wallet.configure(mint,policy);
  await t.wallet.tick();
  t.context.foreground=true;
  await t.wallet.tick();
  expect(t.prepare).not.toHaveBeenCalled();
  await t.kept.keep(delivery('other-sale',16));
  t.context.fee=4;
  await t.wallet.tick();
  expect(t.submit).not.toHaveBeenCalled();
  expect((await t.wallet.state(mint)).sweepNotice).toMatch(/exceed/i);
  t.context.fee=2;
  await Promise.all([t.wallet.tick(),t.wallet.tick()]);
  expect((await t.wallet.state(mint)).payment).toMatchObject({status:'paid',amount:9,feePaid:2,automatic:true});
  expect((await t.ledger.available(mint))[0].amount).toBe(21);
  await t.wallet.tick();
  expect(t.submit).toHaveBeenCalledTimes(1);
});

it('honors turning off a sweep while its invoice is being prepared; manual withdrawal remains available',async()=>{
  const t=await fixture();
  t.context.foreground=false;
  await t.kept.keep(delivery('sale',64));
  await t.wallet.configure(mint,policy);
  await t.wallet.tick();
  const prepare=t.prepare.getMockImplementation()!;
  t.prepare.mockImplementationOnce(async (http,request)=>{
    const plan=await prepare(http,request);
    await t.wallet.configure(mint,null);
    return plan;
  });
  t.context.foreground=true;
  await t.wallet.tick();
  expect(t.submit).not.toHaveBeenCalled();
  expect((await t.wallet.state(mint)).policy).toBeNull();
  const q=await t.wallet.quote(mint,address,3);
  await t.wallet.confirm(mint,q.id);
  expect(t.submit).toHaveBeenCalledTimes(1);
});

it('cancels or expires unsent quotes and refuses invalid input before contacting the destination',async()=>{
  const t=await fixture();
  await t.kept.keep(delivery('sale',16));
  await expect(t.wallet.quote(mint,'other',1)).rejects.toThrow('Lightning address');
  await expect(t.wallet.quote(mint,address,0.1)).rejects.toThrow('whole sats');
  await expect(t.wallet.quote(mint,address,20)).rejects.toThrow('enough');
  t.context.approved=false;
  await expect(t.wallet.configure(mint,policy)).rejects.toThrow('Add and check');
  expect(t.prepare).not.toHaveBeenCalled();
  let q=await t.wallet.quote(mint,address,2);
  await t.wallet.cancel(mint,q.id);
  q=await t.wallet.quote(mint,address,4);
  t.context.now=q.expiresAt;
  expect((await t.wallet.state(mint)).payment).toBeNull();
  expect((await t.ledger.available(mint))[0].amount).toBe(16);
  expect(t.submit).not.toHaveBeenCalled();
});
