import type { OpenTill } from '../till/open';
import { checkCurve, checkEngine, checkHash, checkLibrary, checkNfc, checkPolyfills, checkRandom } from './probes';
import { judgeRedirect, redirectProbe } from './redirect';
import { logLine } from './report';
import { checkSale, settleAndCheck, takeSale } from './sale';
import type { RedirectFindings, SelfTestDeps, SelfTestReport, StepId, StepResult } from './types';

/** A failure as one line: a card error keeps its kind, an Error its message, anything else is written out. */
export function describeError(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const o = e as { kind?: unknown; message?: unknown };
    if (typeof o.kind === 'string' && typeof o.message === 'string') {
      return o.kind + ': ' + o.message;
    }
  }
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}

/** Run every self-test step in order and build the report the screen, the log and the bench server get. */
export async function runSelfTest(
  d: SelfTestDeps,
  onStep?: (r: StepResult) => void,
): Promise<SelfTestReport> {
  const steps: StepResult[] = [];
  let redirect: RedirectFindings | null = null;
  let till: OpenTill | null = null;

  const step = async (id: StepId, fn: () => string | Promise<string>): Promise<boolean> => {
    const t0 = d.now();
    let detail: string;
    let ok: boolean;
    try {
      detail = await fn();
      ok = true;
    } catch (e) {
      detail = describeError(e);
      ok = false;
    }
    const result: StepResult = { id, ok, ms: d.now() - t0, detail };
    steps.push(result);
    onStep?.(result);
    return ok;
  };

  const skip = (id: StepId, what: StepId): void => {
    const result: StepResult = { id, ok: false, ms: 0, detail: 'skipped: ' + what + ' failed' };
    steps.push(result);
    onStep?.(result);
  };

  await step('engine', () => checkEngine(d.hermes, d.bridgeless));
  await step('polyfills', () => checkPolyfills(d.global));
  await step('random', () => checkRandom(d.global, d.nativeRandom));
  await step('hash', () => checkHash());
  await step('curve', () => checkCurve());
  await step('library', () => checkLibrary());
  await step('nfc', () => checkNfc(d.nfcLinked, d.nfcSupported));

  await step('redirect', async () => {
    const findings = await redirectProbe(d.rawFetch, d.benchUrl);
    redirect = findings;
    return judgeRedirect(findings);
  });

  const openOk = await step('open', async () => {
    const opened = await d.openTill();
    till = opened;
    const n = (await opened.cashuCard.payments()).length;
    return (d.journalKind ?? 'MemoryJournal') + ', walletPayout for ' + d.mintName + ', leftoverByPin false; ' + n + ' payments';
  });

  // read the till through a function: the steps above assign it inside callbacks, where narrowing does not follow
  const opened: OpenTill | null = ((): OpenTill | null => till)();

  let saleOk = false;
  if (openOk && opened !== null) {
    saleOk = await step('sale', async () => {
      const facts = await takeSale(opened.cashuCard, d.makeTransport(), {
        id: d.saleId,
        sats: d.saleSats,
        pin: d.pin,
        now: d.now,
      });
      return checkSale(facts, { sats: d.saleSats });
    });
  } else {
    skip('sale', 'open');
  }

  if (saleOk && opened !== null) {
    await step('settle', async () =>
      settleAndCheck(opened.cashuCard, opened.keep, { id: d.saleId, sats: d.saleSats, mint: d.mintName }),
    );
  } else {
    skip('settle', 'sale');
  }

  const report: SelfTestReport = {
    v: 1,
    app: 'cashu-card-pos',
    slice: '0.2',
    platform: d.platform,
    at: d.now(),
    pass: steps.every((s) => s.ok),
    steps,
    redirect,
    journal: d.journalKind ?? 'MemoryJournal',
    reported: false,
  };

  d.log(logLine(report));
  try {
    await d.report(JSON.stringify(report));
    report.reported = true;
  } catch {
    // the screen and the log still carry the result
  }

  return report;
}
