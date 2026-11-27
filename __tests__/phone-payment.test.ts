import { Amount, decodePaymentRequest, getEncodedToken } from '@cashu/cashu-ts';
import { base64urlnopad } from '@scure/base';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { buildOffer, MemoryJournal, OfferError, parseOffer, type CashuCard, type HttpFetch, type Row, type Sale } from 'cashucard';
import { phoneRequest, receivePhonePayment, writeExactPhonePayment } from '../src/till/phone-payment';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { heldPayment } from './helpers/fake-till';

const mint = 'https://mint.test';
const C = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const proof = (id: string, amount: number) => ({ id, amount, secret: 'synthetic customer proof', C });
const v3 = (value: object) => 'cashuA' + base64urlnopad.encode(utf8ToBytes(JSON.stringify(value)));

async function fixture(sats = 2) {
  const m = fakeMint();
  const store = fakeStoreDeps();
  const till = createTillService({ store: store.deps, log: () => {}, now: () => 1000, http: m.http, names: TILL_NAMES, settingsNames: TILL_SETTINGS });
  await till.open();
  await till.addMint(await till.checkMint(mint));
  const id = await till.openSale(sats);
  const request = await till.phoneOffer(id);
  const offer = buildOffer({ request });
  const asked = parseOffer(offer).asked!;
  return { till, m, id, offer, asked };
}

it('offers a request naming the sale amount and accepted mint, and closes an unused QR', async () => {
  const { till, id, asked } = await fixture();
  expect(asked).toMatchObject({ amount: 2, unit: 'sat', mints: [mint], locked: false });
  await till.leaveSale(id);
  expect((await till.takePhonePayment(id, 'cashuBbad')).kind).toBe('refused');
  await expect(till.phoneOffer(id)).rejects.toThrow('closed');
});

it('refuses short, overpaid and sub-fee dust payments before any swap or journal intent', async () => {
  const { till, m, id, asked } = await fixture();
  // One input costs one sat. 4 sats is one sat over and the SDK could otherwise keep this dust.
  for (const amount of [1, 4, 8]) {
    const response = { id: asked.id, mint, unit: 'sat', proofs: [proof(m.ids[0], amount)] };
    const result = await till.takePhonePayment(id, JSON.stringify(response));
    expect(result).toEqual({ kind: 'refused', message: expect.stringMatching(/exact sale amount/) });
  }
  await till.queue.idle();
  expect(m.calls).not.toContain('/v1/swap');
  expect(await till.payments()).toEqual([]);
  expect(await till.kept()).toEqual([]);
});

it('refuses another request, unapproved mint, wrong unit and malformed or oversized tokens without contacting the supplied mint', async () => {
  const { till, m, id, asked } = await fixture();
  const baseline = m.calls.length;
  const p = proof(m.ids[0], 4);
  const payload = { id: asked.id, mint, unit: 'sat', proofs: [p] };
  const inputs = [JSON.stringify({ ...payload, id: 'other' }), JSON.stringify({ ...payload, id: undefined }), JSON.stringify({ ...payload, mint: 'https://other.test' }),
    v3({ token: [{ mint: 'https://other.test', proofs: [p] }] }), JSON.stringify({ ...payload, unit: 'usd' }),
    v3({ token: [{ mint, proofs: [p] }], unit: 'usd' }),
    v3({ token: [{ mint, proofs: [p] }, { mint: 'https://other.test', proofs: [p] }] }), 'https://other.test/#cashuBabc', 'cashuBnotvalid',
    'cashuB' + '0'.repeat(512 * 1024)];
  for (const input of inputs) expect((await till.takePhonePayment(id, input)).kind).toBe('refused');
  await till.queue.idle();
  expect(m.calls.slice(baseline)).toEqual([]);
});

it('converts v3 tokens, v4 short IDs from inactive keysets and cashu: URI tokens to the sale’s own payment payload', async () => {
  const { m, id, offer, asked } = await fixture(3);
  const p = proof(m.ids[0], 4);
  const keysets: HttpFetch = async () => ({ status: 200, text: async () => JSON.stringify({ keysets: [{ id: p.id, unit: 'sat', active: false }] }) });
  const ecash = jest.fn(async () => ({ status: 200 as const }));
  const sale = { id, offer: () => offer, ecash } as unknown as Sale;
  const payment = { ...heldPayment(id), amount: 3 };
  const payments = jest.fn(async () => [payment]);
  const card = { payments } as unknown as CashuCard;
  const b = getEncodedToken({ mint, unit: 'sat', proofs: [{ ...p, amount: Amount.from(4) }] });
  for (const input of [b, 'cashu:' + b, v3({ token: [{ mint, proofs: [p] }] })]) {
    payments.mockResolvedValueOnce([]);
    expect(await receivePhonePayment(card, sale, input, [mint], keysets)).toEqual({ kind: 'paid', payment });
    expect(ecash).toHaveBeenLastCalledWith(JSON.stringify({ id: asked.id, mint, unit: 'sat', proofs: [p] }));
  }
  expect((await receivePhonePayment(card, sale, b, [], keysets)).kind).toBe('refused');
  expect(ecash).toHaveBeenCalledTimes(3);
});

it('keeps unknown outcomes pending and never calls a late extra a paid sale', async () => {
  const { m, id, offer, asked } = await fixture();
  const input = JSON.stringify({ id: asked.id, mint, unit: 'sat', proofs: [proof(m.ids[0], 2)] });
  const base = heldPayment(id);
  const card = { payments: jest.fn() } as unknown as CashuCard;
  const sale = { id, offer: () => offer, ecash: jest.fn() } as unknown as Sale;
  const take = () => receivePhonePayment(card, sale, input, [mint], m.http);
  (sale.ecash as jest.Mock).mockResolvedValue({ status: 409 });
  (card.payments as jest.Mock).mockResolvedValue([{ ...base, state: 'taking', why: 'bad-signature' }]);
  expect(await take()).toMatchObject({ kind: 'pending', paymentId: base.paymentId });
  (card.payments as jest.Mock).mockResolvedValue([]);
  (sale.ecash as jest.Mock).mockResolvedValue({ status: 504 });
  expect((await take()).kind).toBe('pending');
  (sale.ecash as jest.Mock).mockResolvedValue({ status: 200 });
  const old = { ...base, cardKey: 'old-card', paymentId: 'pay:old' };
  (card.payments as jest.Mock).mockResolvedValueOnce([old]).mockResolvedValue([old, { ...base, extra: 'late' }]);
  expect(await take()).toMatchObject({ kind: 'return', message: expect.stringContaining('Owed to Cards') });
  (card.payments as jest.Mock).mockRejectedValue(new Error('storage unavailable'));
  expect((await take()).kind).toBe('pending');
});

it('preserves existing swap intents with change when recovering an older journal', async () => {
  const journal = new MemoryJournal();
  const row = { id: 'pay:old', kind: 'payment', how: 'ecash', step: 'signed', kept: 1, swap: { change: [] } } as unknown as Row;
  await expect(writeExactPhonePayment(journal, row)).rejects.toThrow(/exact sale amount/);
  expect(await journal.read(row.id)).toBeNull();
  await journal.write(row);
  await expect(writeExactPhonePayment(journal, row)).resolves.toBeUndefined();
});

it('offers every accepted mint even when their URLs exceed the NFC envelope', async () => {
  const { id, asked } = await fixture();
  const mints = Array.from({ length: 20 }, (_, n) => 'https://mint' + n + '.test/' + 'a'.repeat(220));
  const sale = { id, offer() { throw new OfferError('TooLong', 'NFC envelope'); } } as unknown as Sale;
  const lookup = async (): Promise<Row> => ({ id: 'sale:' + id, kind: 'sale', sale: { id, sats: 2 },
    at: 1000, unit: 'sat', amount: 2, request: asked.id, mints });
  const result = decodePaymentRequest(await phoneRequest(sale, lookup));
  expect(result.amount?.toNumber()).toBe(2);
  expect(result.mints).toEqual(mints);
  expect(result.id).toBe(asked.id);
  expect(result.singleUse).toBe(true);
});
