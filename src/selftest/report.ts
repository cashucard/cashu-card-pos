import { STEP_IDS, type SelfTestReport, type StepResult } from './types';

export const LOG_TAG = 'CCPOS_SELFTEST';

/** One step as a line for the screen: id, verdict, time, detail (shortened to 300 characters). */
export function formatLine(r: StepResult): string {
  const d = r.detail.length <= 300 ? r.detail : r.detail.slice(0, 299) + '…';
  return r.id + ' ' + (r.ok ? 'PASS' : 'FAIL') + ' ' + r.ms + ' ms: ' + d;
}

/** The run's verdict: running, passed, or the ids of what failed (or that the run is incomplete). */
export function verdict(steps: StepResult[], done: boolean): string {
  if (!done) {
    return 'SELFTEST RUNNING (' + steps.length + ' of ' + STEP_IDS.length + ')';
  }
  const failed = steps.filter((s) => !s.ok).map((s) => s.id);
  if (failed.length === 0 && steps.length === STEP_IDS.length) {
    return 'SELFTEST PASS';
  }
  return 'SELFTEST FAIL: ' + (failed.length > 0 ? failed.join(', ') : 'incomplete');
}

/** The report as one log line under the self-test's tag. */
export function logLine(r: SelfTestReport): string {
  return LOG_TAG + ' ' + JSON.stringify(r);
}
