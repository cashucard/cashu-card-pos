import { benchEvent, benchTillReporter, devAppWiring } from '../src/dev/app-wiring';
import { parsePlan, PlanError } from '../src/lab/plan';
import type { RawFetch, RawInit } from '../src/till/http';
import type { TillReport } from '../src/till/settle';
import { DevOnlyError } from '../src/till/store/wipe';

const T: TillReport = {
  at: 1,
  kept: { sats: 14, deliveries: 1 },
  payments: { delivered: 1 },
  extra: 0,
  settle: { why: 'timer', ok: true, changed: 1, error: null, ms: 3 },
  settles: 2,
  notices: ['n.'],
};

/** Lets the reporter's promise chain and its catch run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

describe('the app plan faults', () => {
  it("an app plan may switch the mint's faults on", () => {
    expect(parsePlan({ mode: 'app', app: { gate: 'bench-allow', mint: { dropSwaps: 1, downMs: 20000 } } })).toEqual({
      mode: 'app',
      app: { gate: 'bench-allow', mint: { dropSwaps: 1, downMs: 20000, hideRestores: 0 } },
    });
  });

  it("an app plan may switch the record's faults on", () => {
    expect(parsePlan({ mode: 'app', app: { gate: 'bench-allow', record: { holdKeeps: 1 } } })).toEqual({
      mode: 'app',
      app: { gate: 'bench-allow', record: { failTapWrites: 0, holdKeeps: 1 } },
    });
    expect(parsePlan({ mode: 'app', app: { gate: 'bench-allow', record: { failTapWrites: 2 } } })).toEqual({
      mode: 'app',
      app: { gate: 'bench-allow', record: { failTapWrites: 2, holdKeeps: 0 } },
    });
  });

  it('a wrong fault switch is refused, by name', () => {
    expect(() => parsePlan({ mode: 'app', app: { mint: 'x' } })).toThrow(PlanError);
    expect(() => parsePlan({ mode: 'app', app: { mint: 'x' } })).toThrow(/mint is an object/);
    expect(() => parsePlan({ mode: 'app', app: { record: 3 } })).toThrow(PlanError);
    expect(() => parsePlan({ mode: 'app', app: { record: 3 } })).toThrow(/record is an object/);
    expect(() => parsePlan({ mode: 'app', app: { mint: { downMs: 600001 } } })).toThrow(
      /a fault switch is a whole number from 0 to 600000: downMs/,
    );
    expect(() => parsePlan({ mode: 'app', app: { record: { failTapWrites: -1 } } })).toThrow(
      /from 0 to 100: failTapWrites/,
    );
    expect(() => parsePlan({ mode: 'app', app: { mint: { dropSwaps: 1.5 } } })).toThrow(/dropSwaps/);
  });

  it('a plan without faults is as before, and the switches go together', () => {
    const plain = parsePlan({ mode: 'app', app: { gate: 'bench-allow' } });
    expect(plain).toEqual({ mode: 'app', app: { gate: 'bench-allow' } });
    expect(plain.mode === 'app' && 'mint' in plain.app).toBe(false);
    expect(plain.mode === 'app' && 'record' in plain.app).toBe(false);

    expect(
      parsePlan({
        mode: 'app',
        app: { gate: 'bench-allow', card: { dropSigns: 1 }, mint: { hideRestores: 1 }, record: { holdKeeps: 1 } },
      }),
    ).toEqual({
      mode: 'app',
      app: {
        gate: 'bench-allow',
        card: { absentTaps: 0, dropSigns: 1 },
        mint: { dropSwaps: 0, downMs: 0, hideRestores: 1 },
        record: { failTapWrites: 0, holdKeeps: 1 },
      },
    });
  });
});

describe('the development events', () => {
  it("the bench is told the till's report as a till event", async () => {
    const raw = jest.fn(async (_url: string, _init: RawInit) => ({
      status: 200,
      text: async () => 'kept',
    }));
    benchTillReporter(raw as unknown as RawFetch, 'http://127.0.0.1:19887')(T);
    await settle();

    expect(raw).toHaveBeenCalledTimes(1);
    const [url, init] = raw.mock.calls[0] as [string, RawInit];
    expect(url).toBe('http://127.0.0.1:19887/event');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'till', ...T });
  });

  it('a development event the bench did not take is dropped quietly', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const raw = jest.fn(async (_url: string, _init: RawInit) => {
        throw new Error('no bench');
      });
      expect(() =>
        benchEvent(raw as unknown as RawFetch, 'http://b')({ kind: 'dev-fault', fault: 'keep-held', amount: 14 }),
      ).not.toThrow();
      await settle();
      expect(log).toHaveBeenCalledWith('event not delivered');
    } finally {
      log.mockRestore();
    }
  });

  it('the development wiring still refuses outside development', () => {
    expect(() =>
      devAppWiring(
        {
          gate: 'device',
          mint: { dropSwaps: 1, downMs: 0, hideRestores: 0 },
          record: { failTapWrites: 1, holdKeeps: 1 },
        },
        false,
      ),
    ).toThrow(DevOnlyError);
  });

  it('no fault reaches the release build', () => {
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
    const names = ['mint-faults', 'record-faults', 'faultyHttp', 'faultyJournal', 'faultyKeep'];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const name of names) {
        expect([file, name, src.includes(name)]).toEqual([file, name, false]);
      }
    }
  });
});
