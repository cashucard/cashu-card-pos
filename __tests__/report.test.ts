import { LOG_TAG, formatLine, logLine, verdict } from '../src/selftest/report';
import { STEP_IDS, type SelfTestReport, type StepResult } from '../src/selftest/types';

function steps(ok: (id: (typeof STEP_IDS)[number]) => boolean): StepResult[] {
  return STEP_IDS.map((id) => ({ id, ok: ok(id), ms: 1, detail: 'ok' }));
}

describe('the self-test report', () => {
  it('formatLine shows the id, the verdict, the time and the detail', () => {
    expect(formatLine({ id: 'hash', ok: true, ms: 3, detail: 'fine' })).toBe('hash PASS 3 ms: fine');
    expect(formatLine({ id: 'hash', ok: false, ms: 3, detail: 'fine' })).toBe('hash FAIL 3 ms: fine');
  });

  it('formatLine shortens a long detail to 300 characters', () => {
    const line = formatLine({ id: 'hash', ok: true, ms: 3, detail: 'x'.repeat(400) });
    expect(line.endsWith('x'.repeat(299) + '…')).toBe(true);
  });

  it('verdict while running counts the steps', () => {
    expect(verdict([], false)).toBe('SELFTEST RUNNING (0 of 11)');
  });

  it('verdict passes only a whole run of passed steps', () => {
    expect(verdict(steps(() => true), true)).toBe('SELFTEST PASS');
  });

  it('verdict names the failed steps', () => {
    expect(verdict(steps((id) => id !== 'random' && id !== 'sale'), true)).toBe(
      'SELFTEST FAIL: random, sale',
    );
  });

  it('verdict calls a short run incomplete', () => {
    const two: StepResult[] = [
      { id: 'engine', ok: true, ms: 1, detail: 'ok' },
      { id: 'polyfills', ok: true, ms: 1, detail: 'ok' },
    ];
    expect(verdict(two, true)).toBe('SELFTEST FAIL: incomplete');
  });

  it('logLine is the tag and the report as JSON', () => {
    const report: SelfTestReport = {
      v: 1,
      app: 'cashu-card-pos',
      slice: '0.2',
      platform: 'ios',
      at: 1,
      pass: true,
      steps: [],
      redirect: null,
    };
    const line = logLine(report);
    expect(line.startsWith('CCPOS_SELFTEST ')).toBe(true);
    expect(JSON.parse(line.slice(LOG_TAG.length + 1))).toEqual(report);
  });
});
