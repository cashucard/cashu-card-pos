import { cardTag } from '../src/app/receipt-reference';
import type { CashuCard, GiveBack, Row } from 'cashucard';
import { archiveTill, held, NOW } from './helpers/archive-till';
import { identifiedReturn, readOwed, returnToCard, returnWords } from '../src/till/owed';
import type { TillService } from '../src/till/service';

function extra(state: 'held' | 'returned' = 'held', tried = false): Row[] {
  const rows = held(1, NOW);
  const p = rows[1];
  if (p.kind !== 'payment' || !p.proofs?.length || !p.card) throw new Error('fixture');
  const publicKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  p.card.key = publicKey;
  p.card.dateKey = publicKey;
  p.card.dateRefund = '';
  // The archive fixture redacts its proof bytes. Supply encodable test-only pieces.
  p.proofs = p.proofs.map((proof, i) => ({
    id: proof.id, amount: proof.amount, secret: 'customer-fixture-' + i, C: publicKey,
  }));
  p.extra = 'paid-twice';
  p.state = state;
  if (state === 'returned') {
    const proof = p.proofs[0];
    p.owed = [{ since: NOW, state: 'locked', reason: 'extra', amount: proof.amount, pieces: [{
      ...proof, keyset: proof.id.slice(0, 16), nonce: '11'.repeat(32), date: 0, dleq: null, written: false, tried,
    }] }];
    delete p.proofs;
  }
  return rows;
}

test.each(['held', 'returned'] as const)('the canonical SDK token for a %s extra is saved exactly once and survives restart', async state => {
  const rows = extra(state);
  const id = rows[1].id;
  const { service, f } = await archiveTill(() => [rows]);
  const reading = await service.withCard('read', readOwed);
  expect(reading.rows.some(r => r.id === id && r.reason === 'extra' && r.exportable)).toBe(true);
  const [one, two] = await Promise.all([service.customerToken(id), service.customerToken(id)]);
  expect(one).toMatch(/^cashu/);
  expect(two).toBe(one);
  expect((await service.customerHandoffs()).map(h => h.id)).toEqual([id]);
  expect(await service.kept()).toHaveLength(0);
  await service.close();
  const restarted = (await archiveTill(() => [], { f })).service;
  expect(await restarted.customerToken(id)).toBe(one);
  expect((await restarted.customerHandoffs())[0]).not.toHaveProperty('token');
  await restarted.close();
});

test('a customer token never takes merchant takings or an extra already tried on a card', async () => {
  const normal = held(2, NOW);
  const returned = extra('returned', true);
  const { service } = await archiveTill(() => [normal, returned]);
  for (const id of [normal[1].id, returned[1].id, 'unknown']) {
    await expect(service.customerToken(id)).rejects.toThrow();
  }
  expect(await service.customerHandoffs()).toHaveLength(0);
  expect((await service.payment(returned[1].id))?.state).toBe('returned');
  await service.close();
});

test('a late wallet payment can be handed back even though it has no card to tap', async () => {
  const rows = extra();
  const p = rows[1];
  if (p.kind !== 'payment') throw new Error('fixture');
  delete p.card;
  p.how = 'ecash';
  const { service } = await archiveTill(() => [rows]);
  expect((await service.withCard('read', readOwed)).rows).toContainEqual(expect.objectContaining({
    id: p.id, cardRef: 'Wallet payment', state: 'held', reason: 'extra', exportable: true,
  }));
  expect(await service.customerToken(p.id)).toMatch(/^cashu/);
  await service.close();
});

test('a partially written return can only continue on its card', async () => {
  const rows = extra('returned');
  const p = rows[1];
  if (p.kind !== 'payment' || !p.owed) throw new Error('fixture');
  const pieces = p.owed[0].pieces;
  pieces.push({ ...pieces[0], written: true, tried: true });
  const { service } = await archiveTill(() => [rows]);
  const reading = await service.withCard('read', readOwed);
  const returned = reading.rows.filter(r => r.reason === 'extra');
  expect(returned.map(r => r.state).sort()).toEqual(['owed', 'unconfirmed']);
  expect(returned.some(r => r.exportable)).toBe(false);
  await expect(service.customerToken(p.id)).rejects.toThrow();
  await service.close();
});

test('PIN retry checks the public key read by the SDK before transmitting a PIN', async () => {
  const key = '02' + '23'.repeat(32);
  const response = new Uint8Array([2, ...Array(32).fill(35), 0x90, 0]);
  const command = new Uint8Array([0xb0, 0x10, 0, 0, 33]);
  const t = { transceive: async () => response };
  const visit = identifiedReturn(t, cardTag(key));
  expect(visit.tag()).toBeNull();
  expect(await visit.transport.transceive(command)).toEqual(response);
  expect(visit.tag()).toBe(cardTag(key));
  const other = identifiedReturn(t, cardTag('03' + '45'.repeat(32)));
  await expect(other.transport.transceive(command)).rejects.toMatchObject({ kind: 'other-card' });
});

test('a return asks for a PIN between sessions and only provides it on a new tap of the same card', async () => {
  const report: GiveBack = { written: 0, owed: 4, waiting: 'pin-not-given', pinNeeded: true, recovered: [], unrecovered: [] };
  const command = Uint8Array.from([0xb0, 0x10, 0, 0, 33]);
  let keyPart = 35;
  const pin = jest.fn(() => '2468');
  const reader = {
    kind: 'nfc' as const, available: async () => true,
    transport: () => ({
      transceive: async () => Uint8Array.from([2, ...Array(32).fill(keyPart), 0x90, 0]),
    }),
  };
  const giveBackToCard: CashuCard['giveBackToCard'] = async (transport, listener) => {
    await transport.begin?.('tap');
    await transport.transceive(command);
    const supplied = await listener.askPin({ wrong: false, tries: null, why: 'recover' });
    return supplied ? { ...report, waiting: '', owed: 0, written: 4, pinNeeded: false } : report;
  };
  const service = {
    withCard: async <T,>(_kind: string, run: (c: CashuCard) => Promise<T>) => run({ giveBackToCard } as CashuCard),
    settleNow: jest.fn(async () => []),
  } as Pick<TillService, 'withCard' | 'settleNow'>;
  const tap = (tag: string | null) => returnToCard(service, reader, tag, pin, new AbortController().signal, () => {});
  const first = await tap(null);
  expect(first.result.pinNeeded).toBe(true);
  expect(pin).not.toHaveBeenCalled();
  keyPart = 36;
  await expect(tap(first.tag)).rejects.toMatchObject({ kind: 'other-card' });
  expect(pin).not.toHaveBeenCalled();
  keyPart = 35;
  expect((await tap(first.tag)).result.written).toBe(4);
  expect(pin).toHaveBeenCalledTimes(1);
  expect(service.settleNow).toHaveBeenCalledTimes(3);
});

test('a declined PIN and an interrupted earlier payment stay pending', () => {
  expect(returnWords({ written: 0, owed: 4, waiting: 'pin-not-given', pinNeeded: true, recovered: [], unrecovered: ['previous'] }))
    .toMatch(/earlier payment.*PIN/);
});

test('a failed handoff write preserves the payable extra and can be retried', async () => {
  const rows = extra();
  const id = rows[1].id;
  const { f, service } = await archiveTill(() => [rows]);
  const driver = f.disk.drivers[f.disk.drivers.length - 1];
  driver.failOn('INSERT INTO extra_handoffs', 'disk is full');
  await expect(service.customerToken(id)).rejects.toThrow();
  expect((await service.payment(id))?.state).toBe('held');
  expect(await service.customerHandoffs()).toEqual([]);
  driver.clearFailures();
  expect(await service.customerToken(id)).toMatch(/^cashu/);
  await service.close();
});

test('tap results keep the amount awaiting confirmation distinct from change still owed and held extras', async () => {
  const rows = extra();
  const p = rows[1];
  if (p.kind !== 'payment') throw new Error('fixture');
  const template = p.proofs![0];
  const change = { amount: 1, B_: template.C, C_: template.C, K: template.C, dleq: null, written: false };
  p.cardChange = [{ ...change, amount: 2 }, { ...change, amount: 3, written: true }];
  const { service } = await archiveTill(() => [rows]);
  const { rows: output } = await service.withCard('read', readOwed);
  expect(output.find(r => r.state === 'owed' && r.reason === 'change')?.amount).toBe(2);
  expect(output.find(r => r.state === 'unconfirmed' && r.reason === 'change')?.amount).toBe(3);
  expect(output.find(r => r.state === 'held' && r.reason === 'extra')?.amount).toBeGreaterThan(0);
  await service.close();
});
