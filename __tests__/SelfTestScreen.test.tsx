import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { SelfTestScreen } from '../src/selftest/SelfTestScreen';
import { STEP_IDS, type SelfTestReport, type StepResult } from '../src/selftest/types';

function textOf(tree: ReactTestRenderer, id: string): string {
  const nodes = tree.root.findAll((n) => n.props.testID === id);
  expect(nodes.length).toBeGreaterThan(0);
  return ([] as unknown[]).concat(nodes[0].props.children).join('');
}

function has(tree: ReactTestRenderer, id: string): boolean {
  return tree.root.findAll((n) => n.props.testID === id).length > 0;
}

function report(pass: boolean, steps: StepResult[]): SelfTestReport {
  return {
    v: 1,
    app: 'cashu-card-pos',
    slice: '0.2',
    platform: 'ios',
    at: 0,
    pass,
    steps,
    redirect: null,
  };
}

const allOk: StepResult[] = STEP_IDS.map((id) => ({ id, ok: true, ms: 1, detail: 'fine' }));

describe('the self-test screen', () => {
  let tree!: ReactTestRenderer;
  let finish!: (r: SelfTestReport) => void;
  let fail!: (e: Error) => void;
  let push!: (r: StepResult) => void;
  let run!: jest.Mock;

  /** Render the screen over a run this test drives: push steps when it likes, then finish or fail. */
  const start = async (): Promise<void> => {
    run = jest.fn((onStep: (r: StepResult) => void) => {
      push = onStep;
      return new Promise<SelfTestReport>((res, rej) => {
        finish = res;
        fail = rej;
      });
    });
    await act(async () => {
      tree = renderer.create(<SelfTestScreen run={run} />);
    });
  };

  it('shows RUNNING before any step', async () => {
    await start();
    expect(textOf(tree, 'selftest-verdict')).toBe('SELFTEST RUNNING (0 of 11)');
    expect(has(tree, 'selftest-done')).toBe(false);
    expect(textOf(tree, 'selftest-title')).toBe('Cashu Card POS: shell self-test');
  });

  it('shows each step as it arrives', async () => {
    await start();
    await act(async () => {
      push({ id: 'engine', ok: true, ms: 2, detail: 'Hermes' });
    });
    expect(textOf(tree, 'step-engine')).toBe('engine PASS 2 ms: Hermes');
    expect(textOf(tree, 'selftest-verdict')).toBe('SELFTEST RUNNING (1 of 11)');
  });

  it('shows PASS and DONE at the end of a passed run', async () => {
    await start();
    await act(async () => {
      finish(report(true, allOk));
    });
    expect(textOf(tree, 'selftest-verdict')).toBe('SELFTEST PASS');
    expect(textOf(tree, 'selftest-done')).toBe('DONE');
    for (const id of STEP_IDS) {
      expect(has(tree, 'step-' + id)).toBe(true);
    }
  });

  it('shows FAIL with the failed steps', async () => {
    const steps: StepResult[] = allOk.map((s) =>
      s.id === 'sale' || s.id === 'settle' ? { ...s, ok: false, detail: 'refused' } : s,
    );
    await start();
    await act(async () => {
      finish(report(false, steps));
    });
    expect(textOf(tree, 'selftest-verdict')).toBe('SELFTEST FAIL: sale, settle');
    expect(textOf(tree, 'step-sale').startsWith('sale FAIL')).toBe(true);
  });

  it('shows FAIL when the run itself throws', async () => {
    await start();
    await act(async () => {
      fail(new Error('boom'));
    });
    expect(textOf(tree, 'selftest-verdict')).toBe('SELFTEST FAIL: boom');
    expect(has(tree, 'selftest-done')).toBe(true);
  });

  it('runs the self-test once', async () => {
    await start();
    await act(async () => {
      finish(report(true, allOk));
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('says when the report was not delivered', async () => {
    await start();
    await act(async () => {
      finish({ ...report(true, allOk), reported: false });
    });
    expect(textOf(tree, 'selftest-unreported')).toBe('report not delivered');
  });
});
