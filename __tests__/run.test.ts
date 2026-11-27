import { fakeBench } from './helpers/fake-bench';
import { fakeTill, fakeTransport } from './helpers/fake-till';
import { describeError, runSelfTest } from '../src/selftest/run';
import { STEP_IDS, type PolyfillGlobal, type SelfTestDeps, type StepId } from '../src/selftest/types';

const real = globalThis as unknown as PolyfillGlobal;

/** A global whose text classes and URL are Node's own and whose random source is a counter. */
function goodGlobal(): PolyfillGlobal {
  let n = 1;
  const counter = (array: Uint8Array): Uint8Array => {
    for (let i = 0; i < array.length; i += 1) {
      array[i] = (n + i) & 255;
    }
    n += 1;
    return array;
  };
  return {
    crypto: { getRandomValues: counter },
    TextEncoder: real.TextEncoder,
    TextDecoder: real.TextDecoder,
    URL: real.URL,
    __ccposPolyfills: { textEncoder: 'native', textDecoder: 'polyfill' },
  };
}

/** Everything the run takes from a good phone, over fakes. */
function goodDeps(over: Partial<SelfTestDeps> = {}): SelfTestDeps {
  let clock = 0;
  const base: SelfTestDeps = {
    platform: 'ios',
    now: () => {
      clock += 5;
      return clock;
    },
    global: goodGlobal(),
    hermes: true,
    bridgeless: true,
    nativeRandom: true,
    nfcLinked: true,
    nfcSupported: async () => false,
    rawFetch: fakeBench('http://b.test', 'stops').raw,
    benchUrl: 'http://b.test',
    saleId: 's1',
    saleSats: 14,
    pin: '1234',
    mintName: 'https://mint.test',
    makeTransport: fakeTransport,
    openTill: async () => fakeTill(),
    log: () => undefined,
    report: async () => undefined,
  };
  return { ...base, ...over };
}

describe('the self-test run', () => {
  it('every step passes over fakes, in order', async () => {
    const seen: StepId[] = [];
    const r = await runSelfTest(goodDeps(), (x) => seen.push(x.id));
    expect(r.pass).toBe(true);
    expect(r.reported).toBe(true);
    expect(r.steps.map((s) => s.id)).toEqual([...STEP_IDS]);
    expect(seen).toEqual([...STEP_IDS]);
    for (const s of r.steps) {
      expect(s.ms).toBeGreaterThanOrEqual(5);
    }
    expect(r.redirect).not.toBeNull();
    expect(r.redirect?.guard302).toBe('refused');
    expect(r.redirect?.followed).toBe(false);
  });

  it('a phone that follows redirects itself fails the redirect step (slice 2.5)', async () => {
    const r = await runSelfTest(goodDeps({ rawFetch: fakeBench('http://b.test', 'follows').raw }));
    const redirect = r.steps.find((s) => s.id === 'redirect');
    expect(redirect?.ok).toBe(false);
    expect(redirect?.detail).toContain('followed a redirect itself');
    expect(r.pass).toBe(false);
  });

  it('the open step names the journal it used', async () => {
    const r = await runSelfTest(goodDeps({ journalKind: 'SQLCipher journal' }));
    const open = r.steps.find((s) => s.id === 'open');
    expect(open?.detail.startsWith('SQLCipher journal, ')).toBe(true);
    expect(r.journal).toBe('SQLCipher journal');
  });

  it('without a journal kind the report says MemoryJournal', async () => {
    const r = await runSelfTest(goodDeps());
    const open = r.steps.find((s) => s.id === 'open');
    expect(open?.detail.startsWith('MemoryJournal, ')).toBe(true);
    expect(r.journal).toBe('MemoryJournal');
  });

  it('the report is logged once and sent once', async () => {
    const logged: string[] = [];
    const sent: string[] = [];
    const deps = goodDeps({
      log: (line) => {
        logged.push(line);
      },
      report: async (json) => {
        sent.push(json);
      },
    });
    await runSelfTest(deps);
    expect(logged).toHaveLength(1);
    expect(logged[0].startsWith('CCPOS_SELFTEST ')).toBe(true);
    expect(sent).toHaveLength(1);
    const report = JSON.parse(sent[0]) as { pass: boolean; steps: unknown[] };
    expect(report.pass).toBe(true);
    expect(report.steps).toHaveLength(11);
  });

  it('a failing step is recorded and the run goes on', async () => {
    const r = await runSelfTest(goodDeps({ nativeRandom: false }));
    const random = r.steps.find((s) => s.id === 'random');
    expect(random).toBeDefined();
    expect(random?.ok).toBe(false);
    expect(random?.detail).toMatch(/Math.random/);
    expect(r.steps.filter((s) => s.id !== 'random').every((s) => s.ok)).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('sale and settle are skipped when the till does not open', async () => {
    const r = await runSelfTest(
      goodDeps({
        openTill: async () => {
          throw new Error('no journal');
        },
      }),
    );
    const open = r.steps.find((s) => s.id === 'open');
    expect(open?.ok).toBe(false);
    expect(open?.detail).toBe('no journal');
    const sale = r.steps.find((s) => s.id === 'sale');
    expect(sale?.detail).toBe('skipped: open failed');
    expect(sale?.ms).toBe(0);
    const settle = r.steps.find((s) => s.id === 'settle');
    expect(settle?.detail).toBe('skipped: sale failed');
    expect(settle?.ms).toBe(0);
  });

  it("a card error's kind leads its detail", async () => {
    const r = await runSelfTest(
      goodDeps({
        openTill: async () =>
          fakeTill({
            card: async () => {
              throw Object.assign(new Error('The card holds 12.'), { kind: 'not-enough' });
            },
          }),
      }),
    );
    const sale = r.steps.find((s) => s.id === 'sale');
    expect(sale?.detail).toBe('not-enough: The card holds 12.');
    const settle = r.steps.find((s) => s.id === 'settle');
    expect(settle?.detail).toBe('skipped: sale failed');
  });

  it('a report that cannot be sent does not fail the run', async () => {
    const r = await runSelfTest(
      goodDeps({
        report: async () => {
          throw new Error('down');
        },
      }),
    );
    expect(r.pass).toBe(true);
  });

  it('a report that cannot be delivered is recorded', async () => {
    const r = await runSelfTest(
      goodDeps({
        report: async () => {
          throw new Error('down');
        },
      }),
    );
    expect(r.pass).toBe(true);
    expect(r.reported).toBe(false);
  });

  it('a bench server that cannot be reached fails only the redirect step', async () => {
    const r = await runSelfTest(
      goodDeps({
        rawFetch: async () => {
          throw new Error('refused');
        },
      }),
    );
    const redirect = r.steps.find((s) => s.id === 'redirect');
    expect(redirect?.ok).toBe(false);
    expect(redirect?.detail).toBe('refused');
    expect(r.redirect).toBeNull();
    expect(r.steps.find((s) => s.id === 'sale')?.ok).toBe(true);
    expect(r.steps.find((s) => s.id === 'settle')?.ok).toBe(true);
  });

  it('describeError reads a card error, an Error and anything else', () => {
    expect(describeError(Object.assign(new Error('m'), { kind: 'busy' }))).toBe('busy: m');
    expect(describeError(new Error('m'))).toBe('m');
    expect(describeError(42)).toBe('42');
  });
});
