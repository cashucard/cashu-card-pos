import { open, type Config } from 'cashucard';
import { sameUrl } from '../src/till/http';
import { emptySettings, saveSettings, TILL_SETTINGS, type MintEntry } from '../src/till/settings';
import { createTillService, SETTINGS_LOST, TillNotOpenError, type TillServiceDeps } from '../src/till/service';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint, type FakeMint } from './helpers/fake-mint';
import { fakeStoreDeps, type FakeStore } from './helpers/fake-store';

const PATH = '/app/till/till.db';

function make(f: FakeStore = fakeStoreDeps(), mint: FakeMint = fakeMint(), extra: Partial<TillServiceDeps> = {}) {
  const logs: string[] = [];
  const service = createTillService({
    store: f.deps,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: mint.http,
    now: () => 1000,
    log: (l) => logs.push(l),
    ...extra,
  });
  return { f, mint, service, logs };
}

function ok(url: string): MintEntry {
  return { url, addedAt: 1, checkedAt: 1, keysets: [], status: 'ok', why: null };
}

function refused(url: string): MintEntry {
  return { url, addedAt: 1, checkedAt: 1, keysets: [], status: 'refused', why: 'it did not pass its check.' };
}

describe('the till service', () => {
  it('a first run opens ready, with no mint', async () => {
    const { f, service } = make();
    const seen: string[] = [];
    service.subscribe((p) => seen.push(p.kind));
    const p = await service.open();
    expect(p).toEqual({ kind: 'ready', firstRun: true, mints: [], note: null });
    expect(seen).toEqual(['opening', 'ready']);
    expect(f.disk.files.has(PATH)).toBe(true);
  });

  it('open twice at once opens one store', async () => {
    const { f, service } = make();
    const p1 = service.open();
    const p2 = service.open();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
    expect(f.disk.drivers.length).toBe(1);
  });

  it('open when ready changes nothing', async () => {
    const { f, service } = make();
    const first = await service.open();
    const second = await service.open();
    expect(second).toBe(first);
    expect(f.disk.drivers.length).toBe(1);
  });

  it("a missing record is a problem with the store's own words, and nothing is made", async () => {
    const f = fakeStoreDeps();
    const first = make(f);
    await first.service.open();
    await first.service.close();
    f.disk.files.delete(PATH);
    const second = make(f);
    const p = await second.service.open();
    expect(p.kind).toBe('problem');
    if (p.kind !== 'problem') {
      throw new Error(p.kind);
    }
    expect(p.message.state).toBe('journal-missing');
    expect(p.message.title).toBe("This phone's payment record is missing");
    expect(p.message.offers.map((o) => o.id)).toEqual(['not-now', 'start-new']);
    expect(f.disk.files.has(PATH)).toBe(false);
  });

  it('not now closes the till; open with the choice starts a new record', async () => {
    const f = fakeStoreDeps();
    const first = make(f);
    await first.service.open();
    await first.service.close();
    f.disk.files.delete(PATH);
    const { service } = make(f);
    const problem = await service.open();
    if (problem.kind !== 'problem') {
      throw new Error(problem.kind);
    }
    service.notNow();
    const closed = service.phase();
    expect(closed.kind).toBe('closed');
    if (closed.kind !== 'closed') {
      throw new Error(closed.kind);
    }
    expect(closed.message.state).toBe('journal-missing');
    const p = await service.open('start-new');
    expect(p.kind).toBe('ready');
    if (p.kind !== 'ready') {
      throw new Error(p.kind);
    }
    expect(p.firstRun).toBe(true);
    expect(f.disk.files.has(PATH)).toBe(true);
  });

  it('not now does nothing when the till is ready', async () => {
    const { service } = make();
    await service.open();
    service.notNow();
    expect(service.phase().kind).toBe('ready');
  });

  it('a secure store that cannot be read is a problem, never a first run', async () => {
    const f = fakeStoreDeps();
    f.secure.failGet.add('*');
    const { service } = make(f);
    const p = await service.open();
    expect(p.kind).toBe('problem');
    if (p.kind !== 'problem') {
      throw new Error(p.kind);
    }
    expect(p.message.state).toBe('secure-store-unavailable');
    expect(p.message.offers[0].id).toBe('try-again');
    expect(f.disk.files.has(PATH)).toBe(false);
    f.secure.failGet.clear();
    const again = await service.open();
    expect(again.kind).toBe('ready');
  });

  it('a damaged list of mints opens with none, and says so', async () => {
    const f = fakeStoreDeps();
    f.secure.items.set(TILL_SETTINGS.a, 'x');
    const { service } = make(f);
    const p = await service.open();
    expect(p.kind).toBe('ready');
    if (p.kind !== 'ready') {
      throw new Error(p.kind);
    }
    expect(p.mints).toEqual([]);
    expect(p.note).toBe(SETTINGS_LOST);
  });

  it("the library is opened with the accepted mints only, and the store's rollback guard", async () => {
    const f = fakeStoreDeps();
    const configs: Config[] = [];
    await saveSettings(f.deps.secure, TILL_SETTINGS, emptySettings(), [
      ok('https://mint.test'),
      refused('https://other.test'),
    ]);
    const { service } = make(f, fakeMint(), {
      openLibrary: async (c: Config) => {
        configs.push(c);
        return open(c);
      },
    });
    const p = await service.open();
    expect(p.kind).toBe('ready');
    expect(configs.length).toBe(1);
    const accepts = await configs[0].payout.accepts();
    expect(accepts.mints.length).toBe(1);
    expect(sameUrl(accepts.mints[0], 'https://mint.test')).toBe(true);
    expect(configs[0].leftoverByPin).toBe(false);
    expect(configs[0].acceptRollback).toBe(false);
    expect(configs[0].generationStore).toBeDefined();
    expect(configs[0].exclusive).toBeUndefined();
  });

  it("the library failing at open is the store's open-failed", async () => {
    const { service } = make(fakeStoreDeps(), fakeMint(), {
      openLibrary: async () => {
        throw new Error('boom');
      },
    });
    const p = await service.open();
    expect(p.kind).toBe('problem');
    if (p.kind !== 'problem') {
      throw new Error(p.kind);
    }
    expect(p.message.state).toBe('open-failed');
  });

  it('withCard runs inside the queue, and refuses before the till is open', async () => {
    const { service } = make();
    await expect(service.withCard('settle', async () => 1)).rejects.toBeInstanceOf(TillNotOpenError);
    await expect(service.read(async () => 1)).rejects.toBeInstanceOf(TillNotOpenError);
    await service.open();
    let inside: string | null = null;
    const answer = await service.withCard('settle', async (c) => {
      inside = service.queue.running();
      return typeof c.payments;
    });
    expect(answer).toBe('function');
    expect(inside).toBe('settle');
  });

  it('close lets the till be opened again', async () => {
    const { f, service } = make();
    await service.open();
    await service.close();
    const p = await service.open();
    expect(p.kind).toBe('ready');
    if (p.kind !== 'ready') {
      throw new Error(p.kind);
    }
    expect(p.firstRun).toBe(false);
    expect(f.disk.drivers.length).toBe(2);
  });

  it('the log names the phase and nothing else', async () => {
    const f = fakeStoreDeps();
    const first = make(f);
    await first.service.open();
    await first.service.close();
    f.disk.files.delete(PATH);
    const second = make(f);
    await second.service.open();
    second.service.notNow();
    await second.service.open('start-new');
    const lines = [...first.logs, ...second.logs];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^till: (opening|ready|failed|problem [a-z-]+|closed [a-z-]+)$/);
    }
  });
});
