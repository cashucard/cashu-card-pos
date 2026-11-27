import { open, type Config } from 'cashucard';
import { sameUrl } from '../src/till/http';
import type { JobKind } from '../src/till/queue';
import {
  createTillService,
  MintInUseError,
  MintNotCheckedError,
  TillNotOpenError,
  mintInUse,
  type TillService,
} from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { heldPayment } from './helpers/fake-till';

const PATH = '/app/till/till.db';

type Library = Awaited<ReturnType<typeof open>>;

function make(
  f = fakeStoreDeps(),
  mint = fakeMint(),
  clock = { t: 1000 },
  opener: (c: Config) => Promise<Library> = open,
) {
  const configs: Config[] = [];
  const reopenKinds: Array<JobKind | null> = [];
  let service!: TillService;
  service = createTillService({
    store: f.deps,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: mint.http,
    now: () => clock.t,
    log: () => undefined,
    openLibrary: async (c) => {
      configs.push(c);
      reopenKinds.push(service.queue.running());
      return opener(c);
    },
  });
  return { f, mint, clock, service, configs, reopenKinds };
}

/** The mints the library takes, as its payout answers them. */
async function taken(c: Config): Promise<string[]> {
  return (await c.payout.accepts()).mints;
}

async function addGood(t: ReturnType<typeof make>): Promise<void> {
  await t.service.open();
  await t.service.addMint(await t.service.checkMint('mint.test'));
}

type Pay = ReturnType<typeof heldPayment>;

/** A payment of `url` in that state. */
function pay(state: Pay['state'], url: string = 'https://mint.test'): Pay {
  return { ...heldPayment('s'), state, mint: url };
}

describe('the till service and its mints', () => {
  it('a mint that passed its check is added, and the library takes it', async () => {
    const t = make();
    await addGood(t);
    expect(t.service.phase()).toEqual({
      kind: 'ready',
      firstRun: true,
      mints: [
        { url: 'https://mint.test', addedAt: 1000, checkedAt: 1000, keysets: t.mint.ids, status: 'ok', why: null },
      ],
      note: null,
    });
    expect(t.configs.length).toBe(2);
    const later = await taken(t.configs[1]);
    expect(later.length).toBe(1);
    expect(sameUrl(later[0], 'https://mint.test')).toBe(true);
    expect(await taken(t.configs[0])).toEqual([]);
  });

  it('the library is opened again inside the queue for the change', async () => {
    const t = make();
    await addGood(t);
    expect(t.reopenKinds).toEqual([null, 'reopen']);
  });

  it('the mint is still there after a relaunch', async () => {
    const t = make();
    await addGood(t);
    await t.service.close();
    const u = make(t.f, t.mint);
    const p = await u.service.open();
    expect(p.kind).toBe('ready');
    if (p.kind !== 'ready') {
      throw new Error(p.kind);
    }
    expect(p.firstRun).toBe(false);
    expect(p.mints.length).toBe(1);
    const later = await taken(u.configs[0]);
    expect(later.length).toBe(1);
  });

  it('a mint that did not pass is never added', async () => {
    const t = make(fakeStoreDeps(), fakeMint({ fee: 2000 }));
    await t.service.open();
    const r = await t.service.checkMint('mint.test');
    expect(r.ok).toBe(false);
    await expect(t.service.addMint(r)).rejects.toBeInstanceOf(MintNotCheckedError);
    expect(t.service.mints()).toEqual([]);
    expect(t.configs.length).toBe(1);
  });

  it('adding before the till is open is refused', async () => {
    const t = make();
    const passing = await t.service.checkMint('mint.test');
    expect(passing.ok).toBe(true);
    await expect(t.service.addMint(passing)).rejects.toBeInstanceOf(TillNotOpenError);
    await expect(t.service.removeMint('https://mint.test')).rejects.toBeInstanceOf(TillNotOpenError);
    await expect(t.service.recheckMints()).rejects.toBeInstanceOf(TillNotOpenError);
  });

  it('adding the same mint again checks it again and keeps when it was added', async () => {
    const t = make();
    await addGood(t);
    t.clock.t = 2000;
    await t.service.addMint(await t.service.checkMint('https://MINT.test/'));
    const m = t.service.mints();
    expect(m.length).toBe(1);
    expect(m[0].url).toBe('https://mint.test');
    expect(m[0].addedAt).toBe(1000);
    expect(m[0].checkedAt).toBe(2000);
  });

  it('a mint is removed, and the library no longer takes it', async () => {
    const t = make();
    await addGood(t);
    await t.service.removeMint('https://mint.test');
    expect(t.service.mints()).toEqual([]);
    const p = t.service.phase();
    expect(p.kind).toBe('ready');
    if (p.kind !== 'ready') {
      throw new Error(p.kind);
    }
    expect(p.mints).toEqual([]);
    expect(await taken(t.configs[t.configs.length - 1])).toEqual([]);
    await t.service.close();
    const u = make(t.f, t.mint);
    const q = await u.service.open();
    expect(q.kind).toBe('ready');
    if (q.kind !== 'ready') {
      throw new Error(q.kind);
    }
    expect(q.mints).toEqual([]);
    expect(await taken(u.configs[0])).toEqual([]);
  });

  it('a mint that still owes a card money is never removed', async () => {
    const t = make(fakeStoreDeps(), fakeMint(), { t: 1000 }, async (c) => {
      const k = await open(c);
      k.payments = async () => [{ ...heldPayment('s1'), state: 'returned', extra: 'late', owedToCard: 13 }];
      return k;
    });
    await addGood(t);
    const before = t.configs.length;
    let error: unknown = null;
    try {
      await t.service.removeMint('https://mint.test');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MintInUseError);
    expect((error as MintInUseError).url).toBe('https://mint.test');
    expect(t.service.mints().length).toBe(1);
    expect(t.configs.length).toBe(before);
  });

  it('mintInUse counts money owed to a card, and a card payment still being taken', () => {
    const url = 'https://mint.test';
    const states = ['taking', 'held', 'delivered', 'exported', 'gone', 'unrecovered', 'lost', 'spent-not-restored', 'returning', 'returned'] as const;
    for (const state of states) {
      expect(mintInUse([pay(state)], url)).toBe(state === 'taking' || state === 'unrecovered');
      expect(mintInUse([{ ...pay(state), owedToCard: 1 }], url)).toBe(true);
    }
    expect(mintInUse([{ ...pay('taking'), why: 'swap-waiting: 503' }], url)).toBe(true);
    expect(mintInUse([{ ...pay('taking'), why: 'bad-signature' }], url)).toBe(false);
    expect(mintInUse([{ ...pay('held'), owedToCard: 5, stuck: 5, unproved: 5 }], url)).toBe(false);
    expect(mintInUse([{ ...pay('held'), owedToCard: 8, stuck: 5, unproved: 5 }], url)).toBe(true);
    expect(mintInUse([{ ...pay('held'), extra: 'paid-twice' }], url)).toBe(true);
    expect(mintInUse([{ ...pay('held'), extra: 'late' }], url)).toBe(true);
    expect(mintInUse([{ ...pay('returning'), extra: 'late' }], url)).toBe(true);
    expect(mintInUse([{ ...pay('held'), extra: 'late', why: 'date-too-near' }], url)).toBe(false);
    expect(mintInUse([{ ...pay('exported'), extra: 'late' }], url)).toBe(false);
    expect(mintInUse([{ ...pay('held', 'https://other.test'), owedToCard: 5 }], url)).toBe(false);
    expect(mintInUse([{ ...pay('held'), owedToCard: 5 }], 'https://MINT.test/')).toBe(true);
  });

  it('a check again leaves a mint whose keysets are the same', async () => {
    const t = make();
    await addGood(t);
    const before = t.mint.calls.length;
    const n = t.configs.length;
    await t.service.recheckMints();
    const m = t.service.mints();
    expect(m.length).toBe(1);
    expect(m[0].checkedAt).toBe(1000);
    expect(t.mint.calls.slice(before)).toEqual(['/v1/keysets']);
    expect(t.configs.length).toBe(n);
  });

  it('a mint that changed its keysets is checked again in full, and kept when it passes', async () => {
    const t = make();
    await addGood(t);
    const old = t.mint.ids.slice();
    t.mint.set({ generation: 1 });
    t.clock.t = 3000;
    const n = t.configs.length;
    await t.service.recheckMints();
    const m = t.service.mints();
    expect(m.length).toBe(1);
    expect(m[0].keysets).toEqual(t.mint.ids);
    expect(m[0].keysets).not.toEqual(old);
    expect(m[0].checkedAt).toBe(3000);
    expect(m[0].status).toBe('ok');
    expect(t.configs.length).toBe(n + 1);
    const later = await taken(t.configs[t.configs.length - 1]);
    expect(later.length).toBe(1);
  });

  it('a mint whose new keysets fail is refused, and the library no longer takes it', async () => {
    const t = make();
    await addGood(t);
    const old = t.mint.ids.slice();
    t.mint.set({ generation: 1, fee: 5000 });
    await t.service.recheckMints();
    const m = t.service.mints();
    expect(m.length).toBe(1);
    expect(m[0].status).toBe('refused');
    expect(m[0].why).toBe('Its fee is 5,000 ppk. This till takes at most 1,000.');
    expect(m[0].keysets).toEqual(old);
    expect(await taken(t.configs[t.configs.length - 1])).toEqual([]);
    const p = t.service.phase();
    expect(p.kind).toBe('ready');
    if (p.kind !== 'ready') {
      throw new Error(p.kind);
    }
    expect(p.mints.length).toBe(1);
    expect(p.mints[0].status).toBe('refused');
  });

  it('a refused mint is checked again in full, and taken again when it passes', async () => {
    const t = make();
    await addGood(t);
    t.mint.set({ generation: 1, fee: 5000 });
    await t.service.recheckMints();
    expect(t.service.mints()[0].status).toBe('refused');
    t.mint.set({ fee: 100 });
    await t.service.recheckMints();
    const m = t.service.mints();
    expect(m.length).toBe(1);
    expect(m[0].status).toBe('ok');
    expect(m[0].why).toBeNull();
    expect(m[0].keysets).toEqual(t.mint.ids);
    expect((await taken(t.configs[t.configs.length - 1])).length).toBe(1);
  });

  it('a mint that does not answer is left as it was', async () => {
    const t = make();
    await addGood(t);
    const n = t.configs.length;
    t.mint.set({ down: true });
    await t.service.recheckMints();
    let m = t.service.mints();
    expect(m.length).toBe(1);
    expect(m[0].status).toBe('ok');
    expect(m[0].checkedAt).toBe(1000);
    expect(t.configs.length).toBe(n);

    t.mint.set({ generation: 1, fee: 5000, down: false });
    await t.service.recheckMints();
    m = t.service.mints();
    expect(m[0].status).toBe('refused');
    const why = m[0].why;
    expect(t.configs.length).toBe(n + 1);

    t.mint.set({ down: true });
    await t.service.recheckMints();
    m = t.service.mints();
    expect(m.length).toBe(1);
    expect(m[0].status).toBe('refused');
    expect(m[0].why).toBe(why);
    expect(t.configs.length).toBe(n + 1);
  });

  it('a change of the mints survives a relaunch', async () => {
    const t = make();
    await addGood(t);
    t.mint.set({ generation: 1, fee: 5000 });
    await t.service.recheckMints();
    expect(t.service.mints()[0].status).toBe('refused');
    await t.service.close();
    const u = make(t.f, t.mint);
    const p = await u.service.open();
    expect(p.kind).toBe('ready');
    if (p.kind !== 'ready') {
      throw new Error(p.kind);
    }
    expect(p.mints.length).toBe(1);
    expect(p.mints[0].status).toBe('refused');
    expect(await taken(u.configs[0])).toEqual([]);
  });
});
