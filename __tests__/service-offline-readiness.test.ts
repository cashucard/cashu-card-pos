import { OFFLINE_LIMITS, type HttpFetch } from 'cashucard';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { generationStore } from '../src/till/store/secret';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';

const url = 'https://mint.test';
const halfLife = OFFLINE_LIMITS.maxAgeMs / 2;

function setup(mint = fakeMint(), http: HttpFetch = mint.http) {
  const f = fakeStoreDeps();
  const clock = { now: 1000 };
  const make = () => createTillService({
    store: f.deps, names: TILL_NAMES, settingsNames: TILL_SETTINGS, http,
    now: () => clock.now, log: () => undefined,
  });
  const service = make();
  async function add() {
    await service.open();
    await service.addMint(await service.checkMint(url));
  }
  return { service, make, f, mint, clock, add };
}

it('prepares a newly accepted mint and refreshes before expiry or on rotation, without extending keys on failure', async () => {
  const t = setup();
  await t.add();
  expect(await t.service.hasReadyOfflineMint()).toBe(true);
  const initial = await t.service.offlineStatus(url);
  t.clock.now += halfLife - 1;
  await t.service.recheckMints();
  expect(await t.service.offlineStatus(url)).toEqual(initial);
  t.clock.now++;
  await t.service.recheckMints();
  expect((await t.service.offlineStatus(url)).expires).toBe(t.clock.now + OFFLINE_LIMITS.maxAgeMs);
  t.clock.now++;
  t.mint.set({ generation: 1 });
  await t.service.recheckMints();
  expect(await t.service.offlineStatus(url)).toMatchObject({ ready: true, expires: t.clock.now + OFFLINE_LIMITS.maxAgeMs });

  t.mint.set({ down: true });
  t.clock.now += OFFLINE_LIMITS.maxAgeMs;
  await t.service.recheckMints();
  expect(await t.service.offlineStatus(url)).toMatchObject({ enabled: true, ready: false, expires: t.clock.now });
  const journal = t.f.disk.drivers[0];
  const before = (await journal.run('SELECT * FROM journal')).rows;
  await expect(t.service.openSale(5, true)).rejects.toThrow(/current mint keys/);
  expect((await journal.run('SELECT * FROM journal')).rows).toEqual(before);
  await t.service.close();
});

it('keeps an explicit off choice during a refresh and after relaunch; the owner can enable it once', async () => {
  const mint = fakeMint();
  let hold = false;
  let started!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(r => { started = r; });
  const resume = new Promise<void>(r => { release = r; });
  const t = setup(mint, async (uri, init) => {
    if (hold && uri.endsWith('/v1/info')) { started(); await resume; }
    return mint.http(uri, init);
  });
  await t.add();
  hold = true;
  t.clock.now += halfLife;
  const refresh = t.service.recheckMints();
  await waiting;
  await t.service.disableOffline(url);
  release();
  await refresh;
  expect(await t.service.hasReadyOfflineMint()).toBe(false);
  await t.service.close();
  const restarted = t.make();
  await restarted.open();
  await restarted.recheckMints();
  await restarted.addMint(await restarted.checkMint(url));
  expect(await restarted.offlineStatus(url)).toMatchObject({ enabled: false, ready: false });
  await restarted.prepareOffline(url);
  expect(await restarted.hasReadyOfflineMint()).toBe(true);
  await restarted.close();
});

it('retries preparation after reconnect on the foreground settle when the first key fetch failed', async () => {
  const t = setup();
  await t.service.open();
  const report = await t.service.checkMint(url);
  t.mint.set({ down: true });
  await t.service.addMint(report);
  expect(await t.service.offlineStatus(url)).toMatchObject({ enabled: true, ready: false });
  await t.service.recheckMints();
  t.mint.set({ down: false });
  t.clock.now += 180_000;
  await t.service.settleNow('timer');
  for (let i = 0; i < 100 && !await t.service.hasReadyOfflineMint(); i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  expect(await t.service.hasReadyOfflineMint()).toBe(true);
  await t.service.close();
});

it('disarms a restored wallet and requires an explicit new enable after a healthy mint recheck', async () => {
  const t = setup();
  await t.add();
  await t.service.close();
  await generationStore(t.f.secure, TILL_NAMES).set(100);
  const restored = t.make();
  expect((await restored.open('use-older')).kind).toBe('ready');
  await restored.recheckMints();
  expect(await restored.offlineStatus(url)).toMatchObject({ enabled: false, ready: false });
  await restored.close();
});

it('rejects over-limit and at-cap offline sales before any new sale record', async () => {
  const t = setup();
  await t.add();
  const db = t.f.disk.drivers[0];
  await expect(t.service.openSale(OFFLINE_LIMITS.sale + 1, true)).rejects.toThrow(/up to/);
  const row = { kind: 'payment', step: 'signed', state: 'taking', offline: true, amount: OFFLINE_LIMITS.sats };
  await db.run("INSERT INTO journal(id,kind,gen,body,written_at) VALUES('pending','payment',1,?,1)", [JSON.stringify(row)]);
  const before = (await db.run('SELECT * FROM journal')).rows;
  await expect(t.service.openSale(1, true)).rejects.toThrow(/settle pending sales/);
  expect((await db.run('SELECT * FROM journal')).rows).toEqual(before);
  await t.service.close();
});
