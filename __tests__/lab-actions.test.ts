import type { HttpFetch } from 'cashucard';
import { describeOutcome, runLab, type LabDeps } from '../src/lab/actions';
import type { LabPlan } from '../src/lab/plan';
import { openStoredTill } from '../src/till/stored-till';
import { SCHEMA_VERSION, SQL } from '../src/till/store/sql';
import { labNames } from '../src/till/store/types';
import { wipeLabStore } from '../src/till/store/wipe';
import { fakeStoreDeps, type FakeStore } from './helpers/fake-store';
import { dump } from './helpers/fake-sql';

const http: HttpFetch = async () => {
  throw new Error('no fetch expected');
};

type Post = { path: string; body: Record<string, unknown>; ids: string[] };

function labOver(f: FakeStore, over: Partial<LabDeps> = {}): { d: LabDeps; posts: Post[] } {
  const posts: Post[] = [];
  const idsNow = (): string[] => {
    const file = f.disk.files.get('/app/lab/lab-k.db');
    return file ? dump(file.db, 'journal').map((r) => String(r.id)) : [];
  };
  let t = 0;
  const d: LabDeps = {
    store: f.deps,
    bench: {
      plan: async () => ({}),
      post: async (path, body) => {
        posts.push({ path, body: body as Record<string, unknown>, ids: idsNow() });
      },
    },
    clock: () => (t += 1),
    openTill: (names, choice, durability) => openStoredTill(f.deps, { names, choice, durability, http, mints: [] }),
    wipe: (names) => wipeLabStore(f.deps, names, true),
    ...over,
  };
  return { d, posts };
}

const plan = (o: Partial<LabPlan>): LabPlan =>
  ({ action: 'burst', run: 'k1', name: 'k', count: 20, durability: 'wal', samples: 200, sizes: [1000, 10000], ...o });

const PATH = '/app/lab/lab-k.db';

describe('the journal lab actions', () => {
  it('burst writes each sale and reports it only after it is written', async () => {
    const f = fakeStoreDeps();
    const { d, posts } = labOver(f);
    const r = await runLab(d, plan({ count: 5 }), () => undefined);
    expect(r.state).toBe('ready');
    expect(r.wrote).toBe(5);

    const events = posts.filter((p) => p.path === '/event');
    expect(events).toHaveLength(6);
    expect(events[0].body.kind).toBe('ready');
    const wrote = events.slice(1);
    expect(wrote.map((p) => p.body.i)).toEqual([1, 2, 3, 4, 5]);
    expect(wrote.map((p) => p.body.id)).toEqual(['k1-1', 'k1-2', 'k1-3', 'k1-4', 'k1-5']);
    for (const p of wrote) {
      expect(Object.keys(p.body)).toEqual(['run', 'kind', 'i', 'id']);
      expect(p.ids).toContain('sale:' + String(p.body.id));
    }

    const last = posts[posts.length - 1];
    expect(last.path).toBe('/result');
    expect(last.body).toEqual(r);
  });

  it('burst on a store that is not ready reports its state and writes nothing', async () => {
    const f = fakeStoreDeps();
    const { d, posts } = labOver(f);
    await runLab(d, plan({ count: 1 }), () => undefined);
    f.disk.files.delete(PATH);
    posts.length = 0;
    const r = await runLab(d, plan({ count: 1, run: 'k2' }), () => undefined);
    expect(r.state).toBe('journal-missing');
    expect(r.storedGeneration as number).toBeGreaterThanOrEqual(1);
    expect(posts.filter((p) => p.path === '/event')).toHaveLength(0);
    expect(f.disk.files.has(PATH)).toBe(false);
  });

  it('open reports the sales found and the store\'s facts', async () => {
    const f = fakeStoreDeps();
    const { d } = labOver(f);
    await runLab(d, plan({ count: 3 }), () => undefined);
    const r = await runLab(d, plan({ action: 'open', run: 'v1' }), () => undefined);
    expect(r.state).toBe('ready');
    expect(r.firstRun).toBe(false);
    expect(r.saleIds).toEqual(['k1-1', 'k1-2', 'k1-3']);
    expect(r.excluded).toEqual({ dir: true, file: true });
    expect(r.cipherVersion).toBe('4.6.1 community');
    expect(r.events).toEqual(['created']);
    expect(r.rows as number).toBeGreaterThanOrEqual(4);
    expect(r.stored).toEqual(r.gen);
  });

  it('open with a choice acts on its state', async () => {
    const f = fakeStoreDeps();
    const { d } = labOver(f);
    await runLab(d, plan({ count: 1 }), () => undefined);
    f.disk.files.delete(PATH);
    const r = await runLab(d, plan({ action: 'open', run: 'v2', choice: 'start-new' }), () => undefined);
    expect(r.state).toBe('ready');
    expect(r.events as string[]).toContain('started-new-after-missing');
    expect(r.saleIds).toEqual([]);
  });

  it('inspect reads without writing', async () => {
    const f = fakeStoreDeps();
    const { d } = labOver(f);
    await runLab(d, plan({ count: 2 }), () => undefined);
    const file = f.disk.files.get(PATH);
    if (file === undefined) {
      throw new Error('the lab file is missing');
    }
    const before = dump(file.db, 'journal');
    const r = await runLab(d, plan({ action: 'inspect', run: 'i1' }), () => undefined);
    expect(r.state).toBe('opened');
    expect(r.version).toBe(SCHEMA_VERSION);
    expect(r.rows).toBe(before.length);
    const highest = Math.max(...before.map((x) => Number(x.gen)));
    expect(r.gen).toBe(highest);
    expect(typeof r.leaseBeat).toBe('number');
    expect(dump(file.db, 'journal')).toEqual(before);
  });

  it('inspect of a missing file and of a missing key', async () => {
    const f = fakeStoreDeps();
    const { d } = labOver(f);
    await runLab(d, plan({ count: 1 }), () => undefined);
    f.disk.files.delete(PATH);
    const missing = await runLab(d, plan({ action: 'inspect', run: 'i2' }), () => undefined);
    expect(missing.state).toBe('no-file');
    expect(missing.key).toBe(true);
    expect(missing.stored as number).toBeGreaterThanOrEqual(1);

    const g = fakeStoreDeps();
    const second = labOver(g);
    await runLab(second.d, plan({ count: 1 }), () => undefined);
    g.secure.items.delete(labNames('k').key);
    const nokey = await runLab(second.d, plan({ action: 'inspect', run: 'i3' }), () => undefined);
    expect(nokey.state).toBe('no-key');
    expect(g.secure.items.has(labNames('k').key)).toBe(false);
  });

  it('measure reports every timing and the list at each size', async () => {
    const f = fakeStoreDeps();
    const { d } = labOver(f);
    const r = await runLab(
      d,
      plan({ action: 'measure', run: 'm1', name: 'm', samples: 5, sizes: [20, 30] }),
      () => undefined,
    );
    expect(r.state).toBe('ready');
    for (const k of ['writeMs', 'setMs', 'bothMs', 'saleMs', 'getMs'] as const) {
      expect((r[k] as { n: number }).n).toBe(5);
    }
    const sizes = r.sizes as Array<{ rows: number; listMs: { n: number }; reopenMs: { n: number } }>;
    expect(sizes).toHaveLength(2);
    expect(sizes[0].rows).toBeGreaterThanOrEqual(20);
    expect(sizes[1].rows).toBeGreaterThanOrEqual(30);
    for (const s of sizes) {
      expect(s.listMs.n).toBe(5);
      expect(s.reopenMs.n).toBe(3);
    }
    expect(f.disk.files.has('/app/lab/lab-m.db')).toBe(false);
  });

  it('measure with delete durability asks for DELETE', async () => {
    const f = fakeStoreDeps();
    const { d } = labOver(f);
    const r = await runLab(
      d,
      plan({ action: 'measure', run: 'm2', name: 'm', samples: 2, sizes: [5], durability: 'delete' }),
      () => undefined,
    );
    expect(r.state).toBe('ready');
    expect(r.durability).toBe('delete');
    expect(f.disk.drivers.some((driver) => driver.log.includes(SQL.journalModeDelete))).toBe(true);
  });

  it('wipe removes the lab store', async () => {
    const f = fakeStoreDeps();
    const { d } = labOver(f);
    await runLab(d, plan({ count: 1 }), () => undefined);
    const r = await runLab(d, plan({ action: 'wipe', run: 'w1' }), () => undefined);
    expect(r.state).toBe('wiped');
    expect(f.disk.files.has(PATH)).toBe(false);
  });

  it('an action that throws is reported as an error', async () => {
    const f = fakeStoreDeps();
    const { d, posts } = labOver(f, {
      openTill: async () => {
        throw new Error('boom');
      },
    });
    const r = await runLab(d, plan({}), () => undefined);
    expect(r).toEqual({ run: 'k1', action: 'burst', state: 'error', why: 'boom' });
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe('/result');
    expect(posts[0].body).toEqual({ run: 'k1', action: 'burst', state: 'error', why: 'boom' });
  });

  it('describeOutcome never carries the store, the till or a key', async () => {
    const f = fakeStoreDeps();
    const out = await openStoredTill(f.deps, { names: labNames('k'), http, mints: [] });
    expect(Object.keys(describeOutcome(out))).toEqual(['state', 'firstRun']);
    const key = f.secure.items.get(labNames('k').key);
    expect(key).toBeDefined();
    expect(JSON.stringify(describeOutcome(out))).not.toContain(key);
  });
});
