import type { AppReport } from '../src/app/wiring';
import { benchReporter, devAppWiring } from '../src/dev/app-wiring';
import { parsePlan, PlanError } from '../src/lab/plan';
import type { RawFetch, RawInit } from '../src/till/http';
import { DevOnlyError } from '../src/till/store/wipe';

const R: AppReport = {
  at: 1000,
  boot: 'ready',
  store: null,
  screen: 'sale',
  firstRun: false,
  mints: [{ url: 'https://mint.test', status: 'ok' }],
  gate: null,
  note: null,
  sale: null,
};

/** Lets the reporter's promise chain and its catch run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

describe('the app plan', () => {
  it("an app plan takes the phone's own check unless the bench says otherwise", () => {
    expect(parsePlan({ mode: 'app' })).toEqual({ mode: 'app', app: { gate: 'device' } });
    expect(parsePlan({ mode: 'app', app: { gate: 'bench-allow' } })).toEqual({
      mode: 'app',
      app: { gate: 'bench-allow' },
    });
    expect(parsePlan({ mode: 'app', app: { gate: 'bench-deny' } })).toEqual({
      mode: 'app',
      app: { gate: 'bench-deny' },
    });
    expect(parsePlan({ mode: 'app', app: {} })).toEqual({ mode: 'app', app: { gate: 'device' } });
  });

  it('a wrong app plan is refused, by name', () => {
    expect(() => parsePlan({ mode: 'app', app: { gate: 'x' } })).toThrow(PlanError);
    expect(() => parsePlan({ mode: 'app', app: { gate: 'x' } })).toThrow(/no such gate: x/);
    expect(() => parsePlan({ mode: 'app', app: 'x' })).toThrow(/app is an object/);
  });

  it('the other plans are as before', () => {
    expect(parsePlan({ mode: 'other' })).toEqual({ mode: 'selftest' });
    expect(parsePlan(null)).toEqual({ mode: 'selftest' });
  });

  it('the development wiring refuses outside development', () => {
    expect(() => devAppWiring({ gate: 'device' }, false)).toThrow(DevOnlyError);
  });
});

describe('the bench reporter', () => {
  it('the bench reporter posts the report as an app event', async () => {
    const raw = jest.fn(async (_url: string, _init: RawInit) => ({
      status: 200,
      text: async () => 'kept',
    }));
    benchReporter(raw as unknown as RawFetch, 'http://b')(R);
    await settle();

    expect(raw).toHaveBeenCalledTimes(1);
    const [url, init] = raw.mock.calls[0] as [string, RawInit];
    expect(url).toBe('http://b/event');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'app', ...R });
  });

  it('a report that cannot be delivered is dropped quietly', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const rejecting = jest.fn(async (_url: string, _init: RawInit) => {
        throw new Error('no bench');
      });
      expect(() => benchReporter(rejecting as unknown as RawFetch, 'http://b')(R)).not.toThrow();
      await settle();

      const refused = jest.fn(async (_url: string, _init: RawInit) => ({
        status: 500,
        text: async () => 'no',
      }));
      expect(() => benchReporter(refused as unknown as RawFetch, 'http://b')(R)).not.toThrow();
      await settle();

      const thrower = (() => {
        throw new Error('sync');
      }) as unknown as RawFetch;
      expect(() => benchReporter(thrower, 'http://b')(R)).not.toThrow();
      await settle();

      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
