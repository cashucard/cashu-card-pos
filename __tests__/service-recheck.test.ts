import { open, type Config, type HttpFetch } from 'cashucard';
import { sameUrl } from '../src/till/http';
import {
  createTillService,
  MintListFullError,
  SETTINGS_LOST,
  TillNotOpenError,
  type TillService,
} from '../src/till/service';
import { emptySettings, saveSettings, TILL_SETTINGS, type MintEntry } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint, type FakeMint } from './helpers/fake-mint';
import { fakeStoreDeps, type FakeStore } from './helpers/fake-store';

/** A mint's http whose next `count` asks starting with `path` wait until release(). */
function holdable(mint: FakeMint, base = 'https://mint.test') {
  let path: string | null = null;
  let left = 0;
  const waiting: Array<() => void> = [];
  const http: HttpFetch = async (url, init) => {
    if (path !== null && left > 0 && url.startsWith(base + path)) {
      left -= 1;
      await new Promise<void>((r) => {
        waiting.push(r);
      });
    }
    return mint.http(url, init);
  };
  return {
    http,
    hold(p: string, count = 1): void {
      path = p;
      left = count;
    },
    held: (): number => waiting.length,
    release(): void {
      for (const r of waiting.splice(0)) {
        r();
      }
    },
  };
}

/** Lets every timer and microtask queued so far run. */
function tick(): Promise<void> {
  return new Promise<void>((r) => {
    setTimeout(() => r(), 0);
  });
}

/** Lets timers and microtasks run until f() is true, at most 200 rounds; else throws. */
async function until(f: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !f(); i += 1) {
    await tick();
  }
  if (!f()) {
    throw new Error('never');
  }
}

function make(http: HttpFetch, f: FakeStore = fakeStoreDeps(), clock = { t: 1000 }) {
  const configs: Config[] = [];
  const service: TillService = createTillService({
    store: f.deps, names: TILL_NAMES, settingsNames: TILL_SETTINGS, http,
    now: () => clock.t, log: () => undefined,
    openLibrary: async (c) => {
      configs.push(c);
      return open(c);
    },
  });
  return { f, service, configs, clock };
}

const keysetsAsked = (m: FakeMint): number => m.calls.filter((c) => c === '/v1/keysets').length;

describe('checking the mints again', () => {
  it('a mint removed while a check-again runs stays removed', async () => {
    const m = fakeMint();
    const h = holdable(m);
    const t = make(h.http);
    await t.service.open();
    await t.service.addMint(await t.service.checkMint('mint.test'));
    m.set({ generation: 1 });
    h.hold('/v1/keys/');
    const again = t.service.recheckMints();
    await until(() => h.held() === 1);
    await t.service.removeMint('https://mint.test');
    h.release();
    await again;
    expect(t.service.mints()).toEqual([]);
    const accepts = await t.configs[t.configs.length - 1].payout.accepts();
    expect(accepts.mints).toEqual([]);
  });

  it('a check-again never writes over a mint added again while it ran', async () => {
    const m = fakeMint();
    const h = holdable(m);
    const t = make(h.http);
    await t.service.open();
    await t.service.addMint(await t.service.checkMint('mint.test'));
    m.set({ generation: 1, fee: 5000 });
    h.hold('/v1/keys/');
    const again = t.service.recheckMints();
    await until(() => h.held() === 1);
    m.set({ generation: 2, fee: 100 });
    t.clock.t = 2000;
    await t.service.addMint(await t.service.checkMint('mint.test'));
    h.release();
    await again;
    const got = t.service.mints();
    expect(got.length).toBe(1);
    expect(got[0].status).toBe('ok');
    expect(got[0].keysets).toEqual(m.ids);
    expect(got[0].checkedAt).toBe(2000);
  });

  it('one check-again at a time; a request while one runs waits, and a third joins it', async () => {
    const m = fakeMint();
    const h = holdable(m);
    const t = make(h.http);
    await t.service.open();
    await t.service.addMint(await t.service.checkMint('mint.test'));
    const before = keysetsAsked(m);
    h.hold('/v1/keysets');
    const a = t.service.recheckMints();
    await until(() => h.held() === 1);
    const b = t.service.recheckMints();
    const c = t.service.recheckMints();
    await tick();
    expect(keysetsAsked(m)).toBe(before);
    h.release();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(keysetsAsked(m) - before).toBe(2);
    expect(rb).toBe(rc);
    expect(ra).toEqual(rb);
    await t.service.recheckMints();
    expect(keysetsAsked(m) - before).toBe(3);
  });

  it("a mint whose entry the store cannot keep never drops another mint's result", async () => {
    const a = fakeMint({ base: 'https://mint.test' });
    const b = fakeMint({ base: 'https://other.test' });
    const http: HttpFetch = async (url, init) =>
      url.startsWith('https://other.test') ? b.http(url, init) : a.http(url, init);
    const t = make(http);
    await t.service.open();
    await t.service.addMint(await t.service.checkMint('mint.test'));
    await t.service.addMint(await t.service.checkMint('other.test'));
    a.set({ generation: 1, fee: 5000 });
    b.set({ generation: 1, keysets: 17 });
    const n = t.configs.length;
    await expect(t.service.recheckMints()).resolves.toBeDefined();
    const mint = t.service.mints().find((e) => sameUrl(e.url, 'https://mint.test'));
    expect(mint).toBeDefined();
    if (mint === undefined) {
      throw new Error('no mint.test');
    }
    expect(mint.status).toBe('refused');
    expect(mint.why).toBe('Its fee is 5,000 ppk. This till takes at most 1,000.');
    expect(t.configs.length).toBe(n + 1);
    const taken = (await t.configs[t.configs.length - 1].payout.accepts()).mints;
    expect(taken).toEqual([]);
    const other = t.service.mints().find((e) => sameUrl(e.url, 'https://other.test'));
    expect(other).toBeDefined();
    if (other === undefined) {
      throw new Error('no other.test');
    }
    expect(other.status).toBe('refused');
    expect(other.why).toBe('It has 17 active keysets in sats. This till keeps at most 16.');
  });

  it('a refused mint\'s reason is kept whole when it is short', async () => {
    const m = fakeMint();
    const t = make(m.http);
    await t.service.open();
    await t.service.addMint(await t.service.checkMint('mint.test'));
    m.set({ generation: 1, status: { '/v1/info': 500 } });
    await t.service.recheckMints();
    const got = t.service.mints();
    expect(got.length).toBe(1);
    expect(got[0].status).toBe('refused');
    expect(got[0].why).toBe('The mint answered, but not as a mint does: it answered 500.');
  });

  it('the last pass is noted, with the mints that did not answer', async () => {
    const m = fakeMint();
    const t = make(m.http);
    await t.service.open();
    await t.service.addMint(await t.service.checkMint('mint.test'));
    expect(t.service.lastRecheck()).toBeNull();
    t.clock.t = 3000;
    m.set({ down: true });
    await t.service.recheckMints();
    expect(t.service.lastRecheck()).toEqual({ at: 3000, unreached: ['https://mint.test'] });
    m.set({ down: false });
    t.clock.t = 4000;
    await t.service.recheckMints();
    expect(t.service.lastRecheck()).toEqual({ at: 4000, unreached: [] });
  });

  it('a check-again before the till is open is refused', async () => {
    const t = make(fakeMint().http);
    await expect(t.service.recheckMints()).rejects.toBeInstanceOf(TillNotOpenError);
  });

  it('a 21st mint is refused by name', async () => {
    const f = fakeStoreDeps();
    const list: MintEntry[] = [];
    for (let i = 1; i <= 20; i += 1) {
      list.push({ url: 'https://m' + i + '.test', addedAt: 1, checkedAt: 1, keysets: [], status: 'ok', why: null });
    }
    await saveSettings(f.deps.secure, TILL_SETTINGS, emptySettings(), list);
    const m = fakeMint();
    const t = make(m.http, f);
    await t.service.open();
    await expect(t.service.addMint(await t.service.checkMint('mint.test'))).rejects.toBeInstanceOf(MintListFullError);
    expect(t.service.mints().length).toBe(20);
    const again = { ...(await t.service.checkMint('mint.test')), url: 'https://m1.test' };
    await expect(t.service.addMint(again)).resolves.toBeUndefined();
    expect(t.service.mints().length).toBe(20);
  });

  it('the lost-list note stays when a mint is added', async () => {
    const f = fakeStoreDeps();
    f.secure.items.set(TILL_SETTINGS.a, 'x');
    const m = fakeMint();
    const t = make(m.http, f);
    const p = await t.service.open();
    expect(p.kind).toBe('ready');
    if (p.kind !== 'ready') {
      throw new Error(p.kind);
    }
    expect(p.note).toBe(SETTINGS_LOST);
    await t.service.addMint(await t.service.checkMint('mint.test'));
    const q = t.service.phase();
    expect(q.kind).toBe('ready');
    if (q.kind !== 'ready') {
      throw new Error(q.kind);
    }
    expect(q.mints.length).toBe(1);
    expect(q.note).toBe(SETTINGS_LOST);
  });

  it('close waits for the job that runs, and refuses one asked after it', async () => {
    const m = fakeMint();
    const t = make(m.http);
    await t.service.open();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const running = t.service.withCard('settle', async () => {
      await gate;
      return 'done';
    });
    let closed = false;
    const c = t.service.close().then(() => {
      closed = true;
    });
    await tick();
    await tick();
    await tick();
    expect(closed).toBe(false);
    expect(t.f.disk.drivers[0].closed).toBe(false);
    await expect(t.service.withCard('settle', async () => 'late')).rejects.toBeInstanceOf(TillNotOpenError);
    await expect(t.service.read(async () => 1)).rejects.toBeInstanceOf(TillNotOpenError);
    release();
    await expect(running).resolves.toBe('done');
    await c;
    expect(closed).toBe(true);
    expect(t.f.disk.drivers[0].closed).toBe(true);
    expect((await t.service.open()).kind).toBe('ready');
  });
});
