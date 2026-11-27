import { MemoryJournal, type Journal, type Row } from 'cashucard';
import { parsePlan, PlanError } from '../src/lab/plan';
import { LAB_ROW_BYTES } from '../src/lab/rows';
import { fillPayments, filledJournal, onceWith } from '../src/dev/record-fill';
import { benchActivityReporter, devAppWiring } from '../src/dev/app-wiring';
import type { RawInit } from '../src/till/http';
import { DevOnlyError } from '../src/till/store/wipe';
import type { ActivityReport } from '../src/app/activity';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeStoreDeps } from './helpers/fake-store';
import { fakeMint } from './helpers/fake-mint';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value);
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets the promise chains and their catch run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

const A: ActivityReport = {
  at: 1,
  ms: 30,
  payments: 3,
  unfinished: 1,
  claims: 0,
  losses: 0,
  done: 2,
  shown: 2,
  older: 0,
  damaged: 0,
  today: { sats: 28, count: 2 },
  all: { sats: 28, count: 2 },
};
describe('the synthetic payments plan', () => {
  it('an app plan may ask for synthetic payments', () => {
    expect(parsePlan({ mode: 'app', app: { gate: 'bench-allow', fill: { payments: 1000 } } })).toEqual({
      mode: 'app',
      app: { gate: 'bench-allow', fill: { payments: 1000 } },
    });
    expect(
      parsePlan({ mode: 'app', app: { gate: 'bench-allow', record: { holdKeeps: 1 }, fill: { payments: 1000 } } }),
    ).toEqual({
      mode: 'app',
      app: { gate: 'bench-allow', record: { failTapWrites: 0, holdKeeps: 1 }, fill: { payments: 1000 } },
    });
  });

  it('a wrong fill is refused, by name', () => {
    expect(() => parsePlan({ mode: 'app', app: { fill: 'x' } })).toThrow(PlanError);
    expect(() => parsePlan({ mode: 'app', app: { fill: 'x' } })).toThrow(/fill is an object/);
    for (const payments of [0, 20001, 1.5, '10']) {
      expect(() => parsePlan({ mode: 'app', app: { fill: { payments } } })).toThrow(
        /fill\.payments is a whole number from 1 to 20000/,
      );
    }
    expect(() => parsePlan({ mode: 'app', app: { fill: {} } })).toThrow(
      /fill\.payments is a whole number from 1 to 20000/,
    );
  });

  it('a plan without a fill has none', () => {
    const plain = parsePlan({ mode: 'app', app: { gate: 'bench-allow' } });
    expect(plain).toEqual({ mode: 'app', app: { gate: 'bench-allow' } });
    expect(plain.mode === 'app' && 'fill' in plain.app).toBe(false);
  });
});

describe('filling the record', () => {
  it('synthetic payments are written once, and asking again adds nothing', async () => {
    const j = new MemoryJournal();
    expect(await fillPayments(j, 3)).toBe(3);
    expect(await fillPayments(j, 3)).toBe(0);
    expect(await fillPayments(j, 5)).toBe(2);
    const payments = (await j.list()).filter((r) => (r as { kind?: unknown }).kind === 'payment');
    expect(payments.length).toBe(5);
    for (const p of payments) {
      expect((p as { state?: unknown }).state).toBe('delivered');
      expect(JSON.stringify(p).length).toBeGreaterThanOrEqual(LAB_ROW_BYTES);
    }
  });

  it('a journal without insert is written to', async () => {
    const rows = new Map<string, Row>();
    const inner: Journal = {
      write: async (row: Row): Promise<void> => {
        rows.set(row.id, row);
      },
      read: async (id: string): Promise<Row | null> => rows.get(id) ?? null,
      list: async (): Promise<Row[]> => [...rows.values()],
    };
    expect(await fillPayments(inner, 2)).toBe(2);
    expect((await inner.list()).length).toBe(2);
  });

  it('the fill runs once, and every caller waits for it', async () => {
    const g = deferred<void>();
    let calls = 0;
    const once = onceWith(async (_x: number) => {
      calls += 1;
      await g.promise;
    });
    let doneA = false;
    let doneB = false;
    const a = once(1).then(() => {
      doneA = true;
    });
    const b = once(2).then(() => {
      doneB = true;
    });
    expect(calls).toBe(1);
    await settle();
    expect(doneA).toBe(false);
    expect(doneB).toBe(false);
    g.resolve(undefined);
    await a;
    await b;
    expect(doneA).toBe(true);
    expect(doneB).toBe(true);
    await once(3);
    expect(calls).toBe(1);

    const err = new Error('no');
    let failedCalls = 0;
    const failing = onceWith(async (_x: number) => {
      failedCalls += 1;
      throw err;
    });
    await expect(failing(1)).rejects.toBe(err);
    await expect(failing(2)).rejects.toBe(err);
    expect(failedCalls).toBe(1);
  });

  it('the filled journal waits for the fill before every call', async () => {
    const inner = new MemoryJournal();
    const g = deferred<void>();
    const ready = onceWith(async (x: Journal) => {
      await g.promise;
      await fillPayments(x, 2);
    });
    const j = filledJournal(inner, ready, true);
    let done = false;
    const l = j.list().then((rows) => {
      done = true;
      return rows;
    });
    await settle();
    expect(done).toBe(false);
    g.resolve(undefined);
    expect((await l).length).toBe(2);
    expect(typeof j.insert).toBe('function');
    expect(typeof j.remove).toBe('function');

    const rows = new Map<string, Row>();
    const inner2: Journal = {
      write: async (row: Row): Promise<void> => {
        rows.set(row.id, row);
      },
      read: async (id: string): Promise<Row | null> => rows.get(id) ?? null,
      list: async (): Promise<Row[]> => [...rows.values()],
    };
    const j2 = filledJournal(inner2, async () => undefined, true);
    expect(j2.insert).toBeUndefined();
    expect(j2.remove).toBeUndefined();
  });

  it('the filled journal refuses outside development', () => {
    expect(() => filledJournal(new MemoryJournal(), async () => undefined, false)).toThrow(DevOnlyError);
  });
});

describe('the filled record through the till', () => {
  it('synthetic payments read as delivered payments of 14 sats, and a settle leaves them as they are', async () => {
    const f = fakeStoreDeps();
    const mint = fakeMint();
    const ready = onceWith(async (x: Journal) => {
      await fillPayments(x, 120);
    });
    const service = createTillService({
      store: f.deps,
      names: TILL_NAMES,
      settingsNames: TILL_SETTINGS,
      http: mint.http,
      now: () => 1000,
      log: () => undefined,
      devJournal: (j) => filledJournal(j, ready, true),
    });
    await service.open();
    await service.addMint(await service.checkMint('mint.test'));
    const pays = await service.payments();
    expect(pays.length).toBe(120);
    for (const p of pays) {
      expect(p.state).toBe('delivered');
      expect(p.amount).toBe(14);
      expect(p.unit).toBe('sat');
      expect(p.extra).toBeUndefined();
      expect(p.owedToCard).toBe(0);
    }
    expect(await service.openClaims()).toEqual([]);
    expect(await service.olderRows()).toEqual([]);
    expect(await service.damagedRows()).toEqual([]);
    expect(await service.maybePaidTwice()).toEqual([]);
    expect(await service.settleNow('asked')).toEqual([]);
    const after = await service.payments();
    expect(after.length).toBe(120);
    for (const p of after) {
      expect(p.state).toBe('delivered');
    }
  });
});

describe('the activity event and the release build', () => {
  it('the bench is told each Activity reading as an activity event', async () => {
    const raw = jest.fn(async (_url: string, _init: RawInit) => ({
      status: 200,
      text: async () => 'kept',
    }));
    benchActivityReporter(raw as unknown as Parameters<typeof benchActivityReporter>[0], 'http://127.0.0.1:19887')(A);
    await settle();
    expect(raw).toHaveBeenCalledTimes(1);
    const [url, init] = raw.mock.calls[0] as [string, RawInit];
    expect(url).toBe('http://127.0.0.1:19887/event');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'activity', ...A });
  });

  it('the development wiring still refuses outside development', () => {
    expect(() => devAppWiring({ gate: 'device', fill: { payments: 10 } }, false)).toThrow(DevOnlyError);
  });

  it('the development wiring hands the fill its own development flag, never true', () => {
    const fs = require('fs') as { readFileSync(path: string, encoding: string): string };
    const src = fs.readFileSync('src/dev/app-wiring.ts', 'utf8');
    expect(src.includes('filledJournal(j, fillOnce, dev)')).toBe(true);
    expect(src.includes('filledJournal(j, fillOnce, true)')).toBe(false);
    expect(src.split('filledJournal(').length - 1).toBe(1);
  });

  it('no fill reaches the release build', () => {
    const fs = require('fs') as {
      readFileSync(path: string, encoding: string): string;
      readdirSync(path: string): string[];
    };
    const files = ['src/app/release-wiring.ts'];
    for (const dir of ['src/till', 'src/app']) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.ts') && !name.endsWith('.tsx')) {
          continue;
        }
        files.push(dir + '/' + name);
      }
    }
    expect(files.length).toBeGreaterThan(10);
    const names = ['record-fill', 'filledJournal', 'fillPayments', 'reportActivity: bench'];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const name of names) {
        expect([file, name, src.includes(name)]).toEqual([file, name, false]);
      }
    }
  });
});
