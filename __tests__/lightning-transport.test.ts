import { Amount, createBlindSignature, createDLEQProof, deriveKeysetId, getDecodedToken, getEncodedToken, pointFromHex, hashToCurve, deserializeProofs } from '@cashu/cashu-ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import type { HttpFetch } from 'cashucard';
import { checkRestoredWithdrawals } from '../src/till/recovery-lightning';
import { reconcileSnapshot } from '../src/till/recovery-reconcile';
import { openStore } from '../src/till/store/open-store';
import { fakeStoreDeps } from './helpers/fake-store';
import { emptySettings } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { createLightningWallet } from '../src/till/lightning';
import { createSchema, createSerial } from '../src/till/store/db';
import { TillEvents } from '../src/till/store/events';
import { LightningStore } from '../src/till/store/lightning';
import { KeepStore } from '../src/till/store/keep-store';
import { fakeDriver, memoryDb } from './helpers/fake-sql';
import { verifyAddressInvoice } from '../src/till/lightning-address';
import {
  checkLightning, LightningFundsError, normalizeLightningAddress, prepareLightning, submitLightning,
} from '../src/till/lightning-transport';

const clock = 1800000000;
const metadata = JSON.stringify([['text/plain', 'Test fixture'], ['text/identifier', 'owner@address.test']]);
const preimage = '22'.repeat(32);
const paymentHash = sha256(hexToBytes(preimage));
// All keys here are fixed, public, synthetic test fixtures.
const key = (n: number) => hexToBytes(n.toString(16).padStart(64, '0'));
const numWords = (n: number, min = 1) => {
  const words = [];
  do {
    words.unshift(n % 32); n = Math.floor(n / 32);
  } while (n || words.length < min);
  return words;
};
const field = (tag: number, words: number[]) => [tag, Math.floor(words.length / 32), words.length % 32, ...words];
function fixtureInvoice(sats: number, text = metadata, plain = false) {
  const hrp = 'lnbcrt' + (sats * 10) + 'n';
  const pubkey = secp256k1.getPublicKey(key(47));
  const data = [
    ...numWords(clock, 7), ...field(1, bech32.toWords(paymentHash)),
    ...(plain ? field(13, bech32.toWords(utf8ToBytes(text))) : field(23, bech32.toWords(sha256(utf8ToBytes(text))))),
    ...field(19, bech32.toWords(pubkey)), ...field(16, bech32.toWords(sha256(pubkey))), ...field(6, numWords(120)),
  ];
  const bits = data.map(w => w.toString(2).padStart(5, '0')).join('');
  const packed = Uint8Array.from(bits.match(/.{1,8}/g)!, b => parseInt(b.padEnd(8, '0'), 2));
  const sig = secp256k1.sign(sha256(concatBytes(utf8ToBytes(hrp), packed)), key(47), { format: 'recovered', prehash: false });
  return bech32.encode(hrp, [...data, ...bech32.toWords(concatBytes(sig.slice(1), sig.slice(0, 1)))], 16384);
}

const mint = 'https://mint.test';
const name = 'owner@address.test';
function fixture(fees = 100) {
  let now = clock * 1000;
  let state: 'UNPAID' | 'PENDING' | 'PAID' = 'UNPAID';
  let inputState = 'UNSPENT';
  let quoteAmount = 5;
  let quoteNonce = 'quote-1';
  let invoice = fixtureInvoice(5);
  let omitChange = false;
  let restoreAvailable = false;
  let wrongRestoreOutput = false;
  let partialRestore = false;
  let badRestoreDleq = false;
  let partialChange = false;
  let supportsDleq = true;
  let badSignature = false;
  let badPreimage = false;
  let advertisedMetadata = metadata;
  let plainInvoice: string | undefined;
  let loseReply = false;
  let misdirect = false;
  let routingFee = 1;
  let reserve = 1;
  let splitExpected = false;
  let loseSplit = false;
  let dropBeforeSplit = false;
  let corruptSplit = false;
  let truncatedSplit = false;
  const swaps: any[] = [];
  const minted = new Map<string, { output: any; signature: any }>();
  const spent = new Set<string>();
  function signOutput(output: any, amount: number) {
    const B = pointFromHex(output.B_);
    const sk = key(Math.log2(amount) + 1);
    const signature = createBlindSignature(B, sk, id);
    const proof = createDLEQProof(B, sk);
    return { id, amount, C_: signature.C_.toHex(true), dleq: { e: bytesToHex(proof.e), s: bytesToHex(proof.s) } };
  }
  const satKeys: Record<string, string> = {};
  for (let i = 0; i < 21; i++) satKeys[String(2 ** i)] = bytesToHex(secp256k1.getPublicKey(key(i + 1)));
  const id = deriveKeysetId(satKeys, { versionByte: 1, unit: 'sat', input_fee_ppk: fees });
  const descriptor = { id, unit: 'sat', input_fee_ppk: fees, active: true };
  const rows = [{
    id: 'merchant-1', amount: 27,
    token: getEncodedToken({ mint, unit: 'sat', proofs: [16, 8, 2, 1].map(v =>
      ({ id, amount: Amount.from(v), secret: 'sale-' + v, C: satKeys[String(v)] })) }),
  }];
  const writes: Record<string, any>[] = [];
  const restores: Record<string, any>[] = [];
  let change: object[] = [];
  const quote = () => ({
    quote: quoteNonce, request: invoice, state, unit: 'sat', amount: quoteAmount, fee_reserve: reserve, expiry: clock + 90,
    change: omitChange ? [] : badSignature ? [{ ...change[0], dleq: { e: '00'.repeat(32), s: '00'.repeat(32) } }] :
      partialChange ? change.slice(0, 1) : change,
    payment_preimage: state === 'PAID' ? (badPreimage ? 'ab'.repeat(32) : preimage) : null,
  });
  const http: HttpFetch = async (url, init) => {
    const answer = (body: unknown) => ({ status: 200, text: async () => JSON.stringify(body), url: misdirect ? 'https://unexpected.test/' : url });
    if (url === 'https://address.test/.well-known/lnurlp/owner') {
      return answer({ tag: 'payRequest', metadata: advertisedMetadata, minSendable: 1000, maxSendable: 10000000, callback: 'https://receiver.test/pay?account=7' });
    }
    if (url.startsWith('https://receiver.test/pay?account=7&amount=')) {
      invoice = fixtureInvoice(Number(url.split('amount=')[1]) / 1000, plainInvoice ?? advertisedMetadata, plainInvoice !== undefined);
      return answer({ pr: invoice });
    }
    if (url === mint + '/v1/info') return answer({
      name: 'Fixture', version: 'Fixture/1', nuts: {
        '5': { methods: [{ method: 'bolt11', unit: 'sat' }], disabled: false },
        '7': { supported: true }, '8': { supported: true }, '9': { supported: true }, '12': { supported: supportsDleq },
      },
    });
    if (url === mint + '/v1/keysets') return answer({ keysets: [descriptor] });
    if (url === mint + '/v1/keys' || url === mint + '/v1/keys/' + id) {
      return answer({ keysets: [{ ...descriptor, keys: satKeys }] });
    }
    if (url === mint + '/v1/melt/quote/bolt11') return answer(quote());
    if (url === mint + '/v1/melt/quote/bolt11/quote-1') return answer(quote());
    if (url === mint + '/v1/swap') {
      const raw = JSON.parse(init.body!);
      swaps.push(raw);
      if (dropBeforeSplit) { dropBeforeSplit = false; throw new Error('disconnected before request'); }
      raw.inputs.forEach((p: {secret: string}) => { spent.add(hashToCurve(utf8ToBytes(p.secret)).toHex(true)); });
      const signatures = raw.outputs.map((output: any) => {
        const signature = signOutput(output, output.amount);
        minted.set(output.B_, { output, signature });
        return signature;
      });
      if (loseSplit) throw new Error('lost after signing');
      return answer({ signatures });
    }
    if (url === mint + '/v1/checkstate' && splitExpected) {
      return answer({ states: JSON.parse(init.body!).Ys.map((Y: string) => ({ Y, state: spent.has(Y) ? 'SPENT' : 'UNSPENT' })) });
    }
    if (url === mint + '/v1/restore' && splitExpected && JSON.parse(init.body!).outputs.some((o: any) => o.amount > 0)) {
      const records = JSON.parse(init.body!).outputs.map((o: any) => minted.get(o.B_)).filter(Boolean).reverse();
      if (truncatedSplit) records.pop();
      return answer({ outputs: records.map((r: any) => r.output), signatures: records.map((r: any) =>
        corruptSplit ? { ...r.signature, amount: r.signature.amount * 2 } : r.signature) });
    }
    if (url === mint + '/v1/checkstate') {
      return answer({ states: JSON.parse(init.body!).Ys.map((Y: string) => ({ Y, state: inputState })) });
    }
    if (url === mint + '/v1/restore' && restoreAvailable) {
      const payload = JSON.parse(init.body!);
      restores.push(payload);
      const signatures = partialRestore ? change.slice(0, 1) : change;
      const outputs = writes[0].outputs.slice(0, signatures.length).reverse();
      if (wrongRestoreOutput) outputs[0] = { ...outputs[0], B_: 'unrequested' };
      const returned = [...signatures].reverse();
      if (badRestoreDleq) returned[0] = { ...returned[0], dleq: { e: '00'.repeat(32), s: '00'.repeat(32) } };
      return answer({ outputs, signatures: returned });
    }
    if (url === mint + '/v1/melt/bolt11') {
      const payload = JSON.parse(init.body!);
      writes.push(payload);
      payload.inputs.forEach((p: { secret: string }) => spent.add(hashToCurve(utf8ToBytes(p.secret)).toHex(true)));
      const total = payload.inputs.reduce((a: number, p: { amount: number }) => a + p.amount, 0);
      const refund = total - quoteAmount - Math.ceil(payload.inputs.length * fees / 1000) - routingFee;
      const parts = Array.from({ length: 16 }, (_, i) => 2 ** i).filter(v => (refund & v) !== 0);
      change = parts.map((amount, i) => {
        const B = pointFromHex(payload.outputs[i].B_);
        const sk = key(Math.log2(amount) + 1);
        const sig = createBlindSignature(B, sk, id);
        const dleq = createDLEQProof(B, sk);
        return { id, amount, C_: sig.C_.toHex(true), dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) } };
      });
      state = 'PAID'; inputState = 'SPENT';
      if (loseReply) throw new Error('late transport loss');
      return answer(quote());
    }
    throw new Error('Unexpected request path ' + url);
  };
  return {
    http, rows, id, writes, restores, swaps,
    forSplit: (fee: number) => {
      splitExpected = true; quoteAmount = 24; reserve = 2; routingFee = fee;
      rows.splice(0, rows.length, ...[32, 8].map(n => ({ id: 'merchant-' + n, amount: n, token: getEncodedToken({
        mint, unit: 'sat', proofs: [{ id, amount: Amount.from(n), C: satKeys[n], secret: 'sale-' + n }],
      }) })));
    },
    disconnectBeforeSplit: () => { dropBeforeSplit = true; },
    loseSplit: () => { loseSplit = true; }, corruptSplit: (v: boolean) => { corruptSplit = v; },
    truncateSplit: (v: boolean) => { truncatedSplit = v; },
    now: () => now,
    setTime: (v: number) => { now = v; }, setState: (v: typeof state) => { state = v; },
    proofState: (v: string) => { inputState = v; }, mismatchedQuote: () => { quoteNonce = 'other-quote'; },
    wrongAmount: () => { quoteAmount = 6; }, corrupt: (v: boolean) => { omitChange = v; },
    allowRestore: () => { restoreAvailable = true; }, wrongRestore: (v: boolean) => { wrongRestoreOutput = v; },
    disableDleq: () => { supportsDleq = false; },
    timeoutAfterPosting: () => { loseReply = true; }, redirect: () => { misdirect = true; },
    freeRoute: () => { routingFee = 0; },
    corruptSignature: (v: boolean) => { badSignature = v; },
    corruptPreimage: (v: boolean) => { badPreimage = v; },
    partialRestore: (v: boolean) => { partialRestore = v; }, partialChange: (v: boolean) => { partialChange = v; },
    badRestoreDleq: (v: boolean) => { badRestoreDleq = v; },
    highFee: () => {
      quoteAmount = 20; routingFee = 3;
      rows[0] = { id: 'one-sale', amount: 64, token: getEncodedToken({
        mint, unit: 'sat', proofs: [{ id, amount: Amount.from(64), C: satKeys['64'], secret: 'public-sale-64' }],
      }) };
    },
    setMetadata: (v: string) => { advertisedMetadata = v; },
    setDescription: (v: string) => { plainInvoice = v; },
  };
}
type Fake = ReturnType<typeof fixture>;
function prepare(f: Fake) { return prepareLightning(f.http, { mint: mint + '/', rows: f.rows, now: f.now, address: name, amount: 5, feeCap: 3 }); }

test('address invoices bind exact amount, original metadata, payee signature and fresh expiry', () => {
  const invoice = fixtureInvoice(5);
  expect(normalizeLightningAddress(' owner@Address.Test ')).toBe(name);
  expect(normalizeLightningAddress('owner+till@Address.Test')).toBe('owner+till@address.test');
  for (const bad of ['..@address.test', 'x@y@z.test', 'x@x.test/abc', 'x@bad:port', 'x@x..test']) {
    expect(() => normalizeLightningAddress(bad)).toThrow();
  }
  expect(verifyAddressInvoice(invoice, 5, metadata, clock * 1000).paymentHash).toBe(bytesToHex(paymentHash));
  expect(() => verifyAddressInvoice(invoice, 6, metadata, clock * 1000)).toThrow();
  expect(() => verifyAddressInvoice(invoice, 5, '[]', clock * 1000)).toThrow();
  expect(() => verifyAddressInvoice(invoice, 5, metadata, (clock + 120) * 1000)).toThrow();
  const { prefix, words } = bech32.decode(invoice, 16384);
  words[words.length - 20] ^= 1;
  expect(() => verifyAddressInvoice(bech32.encode(prefix, words, 16384), 5, metadata, clock * 1000)).toThrow();
});

test('one melt preserves unsubmitted pieces and returns verified fee change to the merchant', async () => {
  const f = fixture();
  f.freeRoute();
  const plan = await prepare(f);
  expect(f.writes).toHaveLength(0);
  expect(plan.inputIds).toEqual(['merchant-1']);
  expect(plan.inputAmount).toBe(27);
  expect(plan.maxFee).toBe(3);
  expect(plan.paymentHash).toBe(bytesToHex(paymentHash));
  const result = await submitLightning(f.http, JSON.parse(JSON.stringify(plan)), f.now);
  expect(result.state).toBe('paid');
  if (result.state !== 'paid' || !result.change) throw new Error('No change');
  expect(result.change.amount).toBe(21);
  expect(getDecodedToken(result.change.token, [f.id]).proofs.reduce((n,p) => n + p.amount.toNumber(), 0)).toBe(21);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].inputs.every((p: object) => !('dleq' in p))).toBe(true);
});

test('lost reply recovers the original durable change outputs without another payment', async () => {
  const f = fixture();
  f.timeoutAfterPosting();
  const plan = await prepare(f);
  expect(await submitLightning(f.http, plan, f.now)).toEqual({ state: 'pending' });
  f.corrupt(true);
  f.freeRoute();
  expect(await checkLightning(f.http, plan, f.now)).toEqual({ state: 'pending' });
  f.corrupt(false);
  f.corruptSignature(true);
  expect(await checkLightning(f.http, plan, f.now)).toEqual({ state: 'pending' });
  f.corruptSignature(false);
  f.corruptPreimage(true);
  expect(await checkLightning(f.http, plan, f.now)).toEqual({ state: 'pending' });
  f.corruptPreimage(false);
  const paid = await checkLightning(f.http, JSON.parse(JSON.stringify(plan)), f.now);
  expect(paid.state).toBe('paid');
  expect(f.writes).toHaveLength(1);
  f.proofState('PENDING');
  expect(await checkLightning(f.http, plan, f.now)).toEqual({ state: 'pending' });
});

test('failed status requires the same expired quote and all submitted inputs independently unspent', async () => {
  const f = fixture();
  const plan = await prepare(f);
  f.setTime((clock + 91) * 1000);
  expect(await submitLightning(f.http, plan, f.now)).toEqual({ state: 'pending' });
  f.setTime((clock + 121) * 1000);
  f.setState('PENDING');
  expect(await checkLightning(f.http, plan, f.now)).toEqual({ state: 'pending' });
  f.setState('UNPAID'); f.proofState('PENDING');
  expect(await checkLightning(f.http, plan, f.now)).toEqual({ state: 'pending' });
  f.proofState('UNSPENT');
  expect(await checkLightning(f.http, plan, f.now)).toEqual({ state: 'failed' });
  f.mismatchedQuote();
  expect(await checkLightning(f.http, plan, f.now)).toEqual({ state: 'pending' });
  expect(f.writes).toHaveLength(0);
});

test('restore recovers omitted change using only the original blinded outputs', async () => {
  const f = fixture();
  f.timeoutAfterPosting();
  const plan = await prepare(f);
  expect(await submitLightning(f.http, plan, f.now)).toEqual({ state: 'pending' });
  f.corrupt(true);
  f.allowRestore();
  f.wrongRestore(true);
  expect(await checkLightning(f.http, plan, f.now)).toEqual({ state: 'pending' });
  f.wrongRestore(false);
  const paid = await checkLightning(f.http, plan, f.now);
  expect(paid.state === 'paid' && paid.change?.amount).toBe(20);
  expect(Object.keys(f.restores[0])).toEqual(['outputs']);
  expect(f.restores[0].outputs).toEqual(f.writes[0].outputs);
  expect(f.writes).toHaveLength(1);
});

test('a settled overcharge requires SPENT inputs, a bound receipt and complete matching signed change from restore', async () => {
  const f = fixture();
  f.highFee();
  // Recreate the encrypted plan persisted by build 10 before its old unbounded POST.
  const plan = await prepareLightning(f.http, { mint: mint + '/', rows: f.rows, now: f.now, address: name, amount: 20, feeCap: 44 });
  delete plan.quoteReserve;
  plan.maxFee = 2;
  expect(await submitLightning(f.http, plan, f.now)).toEqual({ state: 'failed' });
  expect(f.writes).toHaveLength(0);
  await f.http(mint + '/v1/melt/bolt11', { method: 'POST', headers: {}, redirect: 'manual', body: JSON.stringify({
    quote: plan.quoteId, inputs: deserializeProofs(plan.inputs).map(p => ({ ...p, amount: p.amount.toNumber() })),
    outputs: plan.outputs.map(o => ({ ...o.blindedMessage, amount: Number(o.blindedMessage.amount) })),
  }) });
  f.allowRestore();
  const check = () => checkLightning(f.http, JSON.parse(JSON.stringify(plan)), f.now);
  f.proofState('PENDING');
  expect(await check()).toEqual({ state: 'pending' });
  f.proofState('SPENT'); f.corruptPreimage(true);
  expect(await check()).toEqual({ state: 'pending' });
  f.corruptPreimage(false); f.wrongRestore(true);
  expect(await check()).toEqual({ state: 'pending' });
  f.wrongRestore(false); f.badRestoreDleq(true);
  expect(await check()).toEqual({ state: 'pending' });
  f.badRestoreDleq(false); f.partialRestore(true);
  expect(await check()).toEqual({ state: 'pending' });
  f.partialRestore(false); f.partialChange(true);
  expect(await check()).toEqual({ state: 'pending' });
  f.partialChange(false); f.corrupt(true);
  expect(await check()).toEqual({ state: 'pending' });
  f.corrupt(false); f.corruptSignature(true);
  expect(await check()).toEqual({ state: 'pending' });
  f.corruptSignature(false);
  const result = await check();
  expect(result).toMatchObject({ state: 'paid', change: { amount: 40 },
    verifiedOverage: { paymentHash: bytesToHex(paymentHash), actualFee: 4 } });
  expect(f.writes).toHaveLength(1);
  expect(f.restores.every(request => JSON.stringify(request.outputs) === JSON.stringify(f.writes[0].outputs))).toBe(true);
});

test('mismatched mint quote, redirect and insufficient funds never send inputs', async () => {
  const f = fixture();
  f.wrongAmount();
  await expect(prepare(f)).rejects.toThrow('mismatched');
  f.redirect();
  await expect(prepare(f)).rejects.toThrow();
  await expect(prepareLightning(f.http, { address: name, mint, amount: 28, rows: f.rows, now: f.now })).rejects.toBeInstanceOf(LightningFundsError);
  expect(f.writes).toHaveLength(0);
  const limited = fixture();
  limited.disableDleq();
  await expect(prepare(limited)).rejects.toThrow('verifiable, recoverable change');
  expect(limited.writes).toHaveLength(0);
});


test('a signed plain description must exactly match metadata naming the chosen recipient', async () => {
  const f = fixture();
  f.setDescription('Test fixture');
  expect((await prepare(f)).amount).toBe(5);
  f.setDescription('Different description');
  await expect(prepare(f)).rejects.toThrow('mismatched invoice');
  f.setDescription('Test fixture');
  f.setMetadata(JSON.stringify([['text/plain', 'Test fixture']]));
  await expect(prepare(f)).rejects.toThrow('mismatched invoice');
  f.setMetadata(JSON.stringify([['text/plain', 'Test fixture'], ['text/identifier', 'other@address.test']]));
  await expect(prepare(f)).rejects.toThrow('invalid payment details');
  expect(f.writes).toHaveLength(0);
});

test('manual review receives bounded display text while the invoice binds the original metadata', async () => {
  const f = fixture();
  const description = 'This\nbill\u202e ' + 'x'.repeat(240);
  f.setMetadata(JSON.stringify([['text/plain', description], ['text/identifier', name]]));
  const plan = await prepare(f);
  expect(plan.description).toHaveLength(160);
  expect(plan.description).toMatch(/^This bill x+…$/);
});

test.each([0, 2, 4])('private swap protects the 12-sat floor at actual Lightning fee %i, through a lost swap reply', async fee => {
  const f = fixture(0);
  f.forSplit(fee);
  f.loseSplit();
  const plan = await prepareLightning(f.http, { mint, address: name, amount: 24, feeCap: 4, rows: f.rows, now: f.now });
  expect(plan).toMatchObject({ amount: 24, maxFee: 4, quoteReserve: 2, inputIds: ['merchant-32'] });
  expect(plan.split).toBeDefined();
  expect(f.swaps).toHaveLength(0);
  const persisted = JSON.parse(JSON.stringify(plan));
  expect(await submitLightning(f.http, persisted, f.now)).toEqual({ state: 'pending' });
  expect(f.swaps).toHaveLength(1);
  expect(f.writes).toHaveLength(0);
  f.truncateSplit(true);
  expect(await checkLightning(f.http, persisted, f.now)).toEqual({ state: 'pending' });
  f.truncateSplit(false); f.corruptSplit(true);
  expect(await checkLightning(f.http, persisted, f.now)).toEqual({ state: 'pending' });
  f.corruptSplit(false);
  const swap = await checkLightning(f.http, persisted, f.now);
  expect(swap.state).toBe('reshaped');
  if (swap.state !== 'reshaped') throw new Error('expected restored split');
  expect(f.swaps).toHaveLength(1);
  expect(swap.replacement.amount).toBe(32);
  expect(swap.plan.quoteId).toBe(plan.quoteId);
  expect(swap.plan.outputs).toEqual(plan.outputs);
  expect(swap.plan.retained).toHaveLength(1);
  if (fee === 4) {
    expect(await submitLightning(f.http, swap.plan, f.now)).toEqual({ state: 'pending' });
    f.allowRestore();
  } else {
    f.allowRestore();
    await submitLightning(f.http, swap.plan, f.now);
  }
  const paid = await checkLightning(f.http, swap.plan, f.now);
  expect(paid).toMatchObject({ state: 'paid', change: { amount: 8 - fee } });
  if (fee === 4) expect(paid).toMatchObject({ verifiedOverage: { actualFee: 4, paymentHash: plan.paymentHash } });
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].inputs.reduce((n: number, p: { amount: number }) => n + p.amount, 0)).toBe(28);
  expect(f.writes[0].inputs.every((p: { secret: string }) => p.secret !== 'sale-8' && p.secret !== 'sale-32')).toBe(true);
});

test('restores missing change before deciding whether a bounded payout requires an overcharge preimage', async () => {
  for (const fee of [2, 4]) {
    const f = fixture(0);
    f.forSplit(fee); f.allowRestore();
    const plan = await prepareLightning(f.http, { mint, address: name, amount: 24, feeCap: 4, rows: f.rows, now: f.now });
    const split = await submitLightning(f.http, plan, f.now);
    if (split.state !== 'reshaped') throw new Error('expected bounded inputs');
    const sparseStatus: HttpFetch = async (url, init) => {
      const response = await f.http(url, init);
      if (url !== mint + '/v1/melt/quote/bolt11/quote-1') return response;
      const receipt = JSON.parse(await response.text());
      delete receipt.change; delete receipt.payment_preimage;
      return { ...response, text: async () => JSON.stringify(receipt) };
    };
    const actual = await submitLightning(sparseStatus, split.plan, f.now);
    if (fee === 2) expect(actual).toMatchObject({ state: 'paid', change: { amount: 6 } });
    else expect(actual).toEqual({ state: 'pending' });
    expect(f.restores).toHaveLength(1);
    expect(f.writes).toHaveLength(1);
  }
});

test('a recovered split can only credit an untouched proof from the same delivery while it is unspent', async () => {
  const f = fixture(0);
  f.forSplit(4); f.loseSplit();
  const proofs = f.rows.flatMap(row => getDecodedToken(row.token, [f.id]).proofs);
  f.rows.splice(0, f.rows.length, { id: 'one-delivery', amount: 40, token: getEncodedToken({ mint, unit: 'sat', proofs }) });
  const plan = await prepareLightning(f.http, { mint, address: name, amount: 24, feeCap: 4, rows: f.rows, now: f.now });
  const [retained] = deserializeProofs(plan.retained);
  expect(retained.amount.toNumber()).toBe(8);
  const y = hashToCurve(utf8ToBytes(retained.secret)).toHex(true);
  expect(await submitLightning(f.http, plan, f.now)).toEqual({ state: 'pending' });
  for (const state of ['SPENT', 'PENDING']) {
    const changed: HttpFetch = async (url, init) => {
      const response = await f.http(url, init);
      if (url !== mint + '/v1/checkstate') return response;
      const body = JSON.parse(await response.text());
      for (const proof of body.states) if (proof.Y === y) proof.state = state;
      return { ...response, text: async () => JSON.stringify(body) };
    };
    expect(await checkLightning(changed, plan, f.now)).toEqual({ state: 'pending' });
  }
  expect(await checkLightning(f.http, plan, f.now)).toMatchObject({ state: 'reshaped', replacement: { amount: 40 } });
  expect(f.swaps).toHaveLength(1);
  expect(f.writes).toHaveLength(0);
});

test('declines a fee-bearing internal swap before sending any proof and caps a manual quote at its reviewed fee', async () => {
  const f = fixture(100);
  f.forSplit(2);
  await expect(prepareLightning(f.http, { mint, address: name, amount: 24, feeCap: 4, rows: f.rows, now: f.now }))
    .rejects.toThrow('charges for making change');
  expect(f.swaps).toHaveLength(0);
  expect(f.writes).toHaveLength(0);
  const free = fixture(0);
  free.forSplit(2);
  const manual = await prepareLightning(free.http, { mint, address: name, amount: 24, rows: free.rows, now: free.now });
  expect(manual.maxFee).toBe(2);
  const r = await submitLightning(free.http, manual, free.now);
  expect(r.state).toBe('reshaped');
  if (r.state === 'reshaped') expect(deserializeProofs(r.plan.inputs).reduce((n, p) => n + p.amount.toNumber(), 0)).toBe(26);
});

test.each(['continue', 'revoke', 'restore'] as const)('atomic swap recovery with the encrypted ledger and original quote: %s', async mode => {
  const f = fixture(0);
  f.forSplit(4); f.loseSplit(); f.allowRestore();
  const driver = fakeDriver(memoryDb()); const serial = createSerial();
  await createSchema(driver);
  let revision: string | null = null;
  let rev = 0; let foreground = false;
  const checkpoint = { read: async () => revision, advance: async () => (revision = String(++rev)) };
  const kept = new KeepStore(driver, serial, new TillEvents(driver, serial, f.now), f.now);
  const open = () => {
    const ledger = new LightningStore(driver, serial, f.now, checkpoint);
    return { ledger, wallet: createLightningWallet({ ledger, http: f.http, now: f.now,
      newId: () => 'pilot-' + ++rev, acceptsMint: () => true, inForeground: () => foreground }) };
  };
  for (const r of f.rows) await kept.keep({ ...r, mint, unit: 'sat' });
  const initial = open();
  await initial.wallet.configure(mint, { address: name, threshold: 12, maxFee: 4 });
  await initial.wallet.tick();
  foreground = true;
  await initial.wallet.tick();
  expect((await initial.wallet.state(mint)).payment?.status).toBe('pending');
  expect((await initial.ledger.available(mint)).map(p => p.amount)).toEqual([8]);
  expect(f.swaps).toHaveLength(1); expect(f.writes).toHaveLength(0);
  if (mode === 'revoke') await initial.wallet.configure(mint, null);
  await initial.wallet.close();
  const reopened = open();
  if (mode === 'restore') await reopened.ledger.disarmRestored();
  // Concurrent refreshes can retrieve the same signatures. The encrypted journal exchanges the
  // originals only once; a repeated delivery of the same sale never makes a spent source available.
  await Promise.all([reopened.wallet.refresh(mint), reopened.wallet.refresh(mint)]);
  await kept.keep({ ...f.rows[0], mint, unit: 'sat' });
  await Promise.all([reopened.wallet.tick(), reopened.wallet.tick()]);
  if (mode === 'restore') {
    f.setTime((clock + 121) * 1000);
    await reopened.wallet.refresh(mint);
  }
  const live = await reopened.ledger.available(mint);
  if (mode === 'continue') {
    expect((await reopened.wallet.state(mint)).payment).toMatchObject({ status: 'paid', amount: 24, feePaid: 4 });
    expect(live.map(r => r.amount).sort((a,b) => a-b)).toEqual([4,8]);
    expect(f.writes).toHaveLength(1);
  } else {
    expect(f.writes).toHaveLength(0);
    expect(live.map(r => r.amount).sort((a,b) => a-b)).toEqual([8,32]);
    expect(live.some(r => r.id === 'merchant-32')).toBe(false);
  }
  expect(f.swaps).toHaveLength(1);
  await reopened.wallet.close();
});

test('only a live original wallet can retry a missing swap with the identical zero-fee inputs and outputs', async () => {
  const f = fixture(0);
  f.forSplit(2); f.disconnectBeforeSplit();
  const saved = JSON.parse(JSON.stringify(await prepareLightning(f.http, {
    mint, address: name, amount: 24, feeCap: 4, rows: f.rows, now: f.now,
  })));
  expect(await submitLightning(f.http, saved, f.now)).toEqual({ state: 'pending' });
  f.setTime((clock + 121) * 1000);
  expect(await checkLightning(f.http, { ...saved, reconcileOnly: true }, f.now)).toEqual({ state: 'failed' });
  expect(f.swaps).toHaveLength(1);
  const result = await checkLightning(f.http, saved, f.now);
  expect(result).toMatchObject({ state: 'reshaped' });
  expect(f.swaps).toHaveLength(2);
  expect(f.swaps[1]).toEqual(f.swaps[0]);
  expect(f.writes).toHaveLength(0);
  if (result.state === 'reshaped') {
    expect(await checkLightning(f.http, result.plan, f.now)).toEqual({ state: 'failed' });
  }
  expect(f.writes).toHaveLength(0);
});

async function quarantined(f: Fake, split = false) {
  const { deps } = fakeStoreDeps();
  const result = await openStore(deps, TILL_NAMES, {start: async() => true});
  if (result.kind !== 'ready') throw new Error('Test till unavailable.');
  const s = result.store;
  const p = split
    ? await prepareLightning(f.http, {mint, address:name, amount:24, feeCap:4, rows:f.rows, now:f.now})
    : await prepare(f);
  for (const delivery of f.rows) await s.keep.keep({...delivery, mint, unit:'sat'});
  await s.lightning.reserve({id:'old',paymentHash:p.paymentHash,mint,address:name,amount:p.amount,maxFee:p.maxFee,
    quotedFee:p.inputFee + p.quoteReserve!,automatic:false,expiresAt:p.expiresAt,inputIds:p.inputIds,plan:JSON.stringify(p)});
  await s.lightning.disarmRestored();
  await s.driver.run("UPDATE backup_control SET recovery_id='recovery',recovery_phase='quarantined',recovery_at=1,recovery_settings=? WHERE id=1",
    [JSON.stringify(emptySettings())]);
  const activate = async (read: HttpFetch) => {
    await checkRestoredWithdrawals(s, read, f.now);
    await s.backups.activate('recovery', await reconcileSnapshot(s.driver, read));
  };
  return {s, p, activate};
}

test('quarantined unpaid split never starts a swap and only releases the original reservation after expiry', async () => {
  const f = fixture(0); f.forSplit(2);
  const {s, activate} = await quarantined(f, true);
  await expect(activate(f.http)).rejects.toThrow('mint has not confirmed');
  expect((await s.backups.status()).recovery?.phase).toBe('quarantined');
  expect((await s.lightning.get('old'))?.state).toBe('submitted');
  f.setTime((clock+121)*1000);
  await activate(f.http);
  expect((await s.lightning.get('old'))?.state).toBe('failed');
  expect((await s.lightning.available(mint)).map(r=>r.amount).sort((a,b)=>a-b)).toEqual([8,32]);
  expect(f.swaps).toHaveLength(0);
  expect(f.writes).toHaveLength(0);
});

test('an earlier paid melt credits only the unspent remainder, without a second melt', async () => {
  const f = fixture(); f.freeRoute();
  const {s,p,activate} = await quarantined(f);
  const paid = await submitLightning(f.http,p,f.now);
  if (paid.state !== 'paid' || !paid.change) throw new Error('Missing change');
  const remaining = getDecodedToken(paid.change.token,[f.id]).proofs.sort((a,b)=>a.amount.toNumber()-b.amount.toNumber())[0];
  const y = hashToCurve(utf8ToBytes(remaining.secret)).toHex(true);
  const partial: HttpFetch = async (url,init) => {
    if (url !== mint + '/v1/checkstate') return f.http(url,init);
    const states = JSON.parse(init.body!).Ys.map((Y:string)=>({Y,state:Y === y ? 'UNSPENT':'SPENT'}));
    return {status:200,url,text:async()=>JSON.stringify({states})};
  };
  await activate(partial);
  expect((await s.lightning.get('old'))?.state).toBe('paid');
  expect((await s.lightning.available(mint)).map(r=>r.amount)).toEqual([remaining.amount.toNumber()]);
  expect(f.writes).toHaveLength(1);
  expect(f.swaps).toHaveLength(0);
});

test('an expired unpaid quote on a backup never releases a spent or pending reserved input', async () => {
  const f = fixture();
  const {s,activate} = await quarantined(f);
  f.setTime((clock+121)*1000);
  for (const outcome of ['SPENT','PENDING']) {
    f.proofState(outcome);
    await expect(activate(f.http)).rejects.toThrow('mint has not confirmed');
    expect((await s.lightning.available(mint))).toEqual([]);
    expect((await s.lightning.get('old'))?.state).toBe('submitted');
  }
  expect(f.writes).toHaveLength(0);
});

test('recovery of a previously transmitted split and melt records each only once', async () => {
  const f = fixture(0); f.forSplit(2); f.allowRestore();
  const {s,p,activate} = await quarantined(f,true);
  const split = await submitLightning(f.http,p,f.now);
  if (split.state !== 'reshaped') throw new Error('Missing split');
  await submitLightning(f.http,split.plan,f.now);
  await activate(f.http);
  expect((await s.lightning.get('old'))?.state).toBe('paid');
  expect((await s.lightning.available(mint)).map(r=>r.amount).sort((a,b)=>a-b)).toEqual([6,8]);
  expect(f.writes).toHaveLength(1);
  expect(f.swaps).toHaveLength(1);
});
