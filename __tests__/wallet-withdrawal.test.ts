import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Amount, getEncodedToken, getTokenMetadata, hashToCurve } from '@cashu/cashu-ts';
import type { Delivery, HttpFetch } from 'cashucard';
import { WalletStore } from '../src/till/store/wallet';
import { KeepStore } from '../src/till/store/keep-store';
import { TillEvents } from '../src/till/store/events';
import { createSchema, createSerial, openDatabase } from '../src/till/store/db';
import { fakeDisk } from './helpers/fake-sql';

const mint = 'https://mint.test';
const key = 'ab'.repeat(32);
const point = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const id = '01' + '01'.repeat(32);

function delivery(name: string, pieces: number[], url = mint): Delivery {
  const proofs = pieces.map((v, i) => ({ amount: Amount.from(v), id, secret: name + i, C: point }));
  return {
    id: name,
    mint: url,
    unit: 'sat',
    amount: pieces.reduce((a, b) => a + b, 0),
    token: getEncodedToken({ mint: url, unit: 'sat', proofs }),
  };
}

async function setup() {
  const disk = fakeDisk();
  const { driver } = await openDatabase(disk.opener, '/d', 'wallet.db', key);
  await createSchema(driver);
  const serial = createSerial();
  const events = new TillEvents(driver, serial, () => 42);
  return {
    wallet: new WalletStore(driver, serial),
    kept: new KeepStore(driver, serial, events, () => 42),
    disk,
  };
}

const y = (secret: string) => hashToCurve(utf8ToBytes(secret)).toHex(true);
function mintStates(f: (ys: string[]) => Array<{ Y: string; state: string }>): HttpFetch {
  return async (url, init) => {
    expect(url).toBe(mint + '/v1/checkstate');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body!);
    expect(Object.keys(body)).toEqual(['Ys']);
    return { status: 200, text: async () => JSON.stringify({ states: f(body.Ys) }) };
  };
}

it('freezes deliveries once and reopens the same token after restart, leaving new takings separate', async () => {
  const { wallet, kept, disk } = await setup();
  const a = delivery('first', [4]);
  const b = delivery('second', [2, 1]);
  await kept.keep(a);
  await kept.keep(b);
  await Promise.all([wallet.prepare(mint + '/', 'sat'), wallet.prepare(mint + '/', 'sat')]);
  const token = await wallet.token('first');
  expect(getTokenMetadata(token).amount.toNumber()).toBe(7);
  await kept.keep(delivery('third', [8]));
  await kept.keep(a);
  const { driver } = await openDatabase(disk.opener, '/d', 'wallet.db', key);
  const reopened = new WalletStore(driver, createSerial());
  expect(await reopened.token('first')).toBe(token);
  expect(await reopened.balances()).toEqual([
    { mint: mint + '/', unit: 'sat', available: 8, withdrawal: { id: 'first', amount: 7, pending: false } },
  ]);
  expect((await kept.totals())[0].amount).toBe(15);
});

it('reserves pending pieces, keeps unspent pieces shareable on retry, and clears only confirmed spent value', async () => {
  const { wallet, kept } = await setup();
  await kept.keep(delivery('sale', [8, 2, 1]));
  await wallet.prepare(mint + '/', 'sat');
  expect(
    await wallet.check(
      'sale',
      mintStates((ys) =>
        ys
          .map((Y) => ({
            Y,
            state: Y === y('sale0') ? 'SPENT' : Y === y('sale1') ? 'PENDING' : 'UNSPENT',
          }))
          .reverse(),
      ),
    ),
  ).toEqual({ amount: 3, pending: true });
  await expect(wallet.token('sale')).rejects.toThrow();
  expect((await kept.totals())[0].amount).toBe(3);
  expect(
    await wallet.check(
      'sale',
      mintStates((ys) => ys.map((Y) => ({ Y, state: 'UNSPENT' }))),
    ),
  ).toEqual({ amount: 3, pending: false });
  expect(
    getTokenMetadata(await wallet.token('sale'))
      .incompleteProofs.map((p) => p.secret)
      .sort(),
  ).toEqual(['sale1', 'sale2']);
  await wallet.check(
    'sale',
    mintStates((ys) => ys.map((Y) => ({ Y, state: 'SPENT' }))),
  );
  expect(await kept.totals()).toEqual([]);
  await expect(wallet.token('sale')).rejects.toThrow();
  await kept.keep(delivery('sale', [8, 2, 1]));
  expect(await wallet.balances()).toEqual([]);
});

it('incomplete, duplicate, unknown and failed mint replies cannot erase or replace a token', async () => {
  const { wallet, kept } = await setup();
  await kept.keep(delivery('k', [2, 1]));
  await wallet.prepare(mint + '/', 'sat');
  const unchanged = await wallet.token('k');
  for (const reply of [
    mintStates(() => []),
    mintStates(([Y]) => [
      { Y, state: 'SPENT' },
      { Y, state: 'SPENT' },
    ]),
    mintStates((ys) => ys.map((Y) => ({ Y, state: 'other' }))),
    mintStates((ys) => ys.map(() => ({ Y: y('unknown'), state: 'SPENT' }))),
    async () => {
      throw new Error('offline');
    },
  ]) {
    await expect(wallet.check('k', reply)).rejects.toThrow();
    expect(await wallet.token('k')).toBe(unchanged);
  }
});

it('a token with another mint or repeated proofs stays in the keep-store without creating a withdrawal', async () => {
  const { wallet, kept } = await setup();
  const wrong = delivery('k', [1], 'https://other.test');
  await kept.keep({ ...wrong, mint });
  await expect(wallet.prepare(mint + '/', 'sat')).rejects.toThrow();
  expect((await wallet.balances())[0]).toMatchObject({ available: 1, withdrawal: null });
  const { wallet: other, kept: right } = await setup();
  const d = delivery('x', [1]);
  await right.keep(d);
  await right.keep({ ...d, id: 'y' });
  await expect(other.prepare(mint + '/', 'sat')).rejects.toThrow('duplicate');
});

it('a failed database write cannot orphan the funds or expose a half-prepared transfer', async () => {
  const { wallet, kept, disk } = await setup();
  await kept.keep(delivery('k', [1]));
  disk.drivers[0].failOn('UPDATE kept SET withdrawal', 'disk full');
  await expect(wallet.prepare(mint + '/', 'sat')).rejects.toThrow('disk full');
  expect(await kept.totals()).toEqual([{ mint: mint + '/', unit: 'sat', amount: 1, count: 1 }]);
  await expect(wallet.token('k')).rejects.toThrow();
});

it('keeps newly accepted funds, distinct mint addresses and units in separate withdrawals', async () => {
  const { wallet, kept } = await setup();
  const eurMint = 'https://second.test/path';
  const cents = getEncodedToken({
    mint,
    unit: 'usd',
    proofs: [{ amount: Amount.from(2), id, C: point, secret: 'cents' }],
  });
  await kept.keep(delivery('sat', [4]));
  await kept.keep(delivery('other', [8], eurMint));
  await kept.keep({ id: 'cents', mint, unit: 'usd', amount: 2, token: cents });
  await wallet.prepare(mint + '/', 'usd');
  expect(getTokenMetadata(await wallet.token('cents')).unit).toBe('usd');
  expect(await wallet.balances()).toEqual([
    { mint: mint + '/', unit: 'sat', available: 4, withdrawal: null },
    { mint: mint + '/', unit: 'usd', available: 0, withdrawal: { id: 'cents', amount: 2, pending: false } },
    { mint: eurMint, unit: 'sat', available: 8, withdrawal: null },
  ]);
  await kept.keep({ ...delivery('mismatch', [1]), unit: 'usd' });
  await wallet.check(
    'cents',
    mintStates((ys) => ys.map((Y) => ({ Y, state: 'SPENT' }))),
  );
  await expect(wallet.prepare(mint + '/', 'usd')).rejects.toThrow('does not match');
});

it('commits partial redemption only after the durable save succeeds', async () => {
  const { wallet, kept, disk } = await setup();
  await kept.keep(delivery('x', [1, 2]));
  await wallet.prepare(mint + '/', 'sat');
  const token = await wallet.token('x');
  disk.drivers[0].failOn('UPDATE withdrawals SET token', 'disk full');
  await expect(
    wallet.check(
      'x',
      mintStates((ys) => ys.map((Y, i) => ({ Y, state: i === 0 ? 'SPENT' : 'UNSPENT' }))),
    ),
  ).rejects.toThrow('disk full');
  expect(await wallet.token('x')).toBe(token);
  expect((await kept.totals())[0].amount).toBe(3);
});
