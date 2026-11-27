import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { DevRoot } from '../src/dev/DevRoot';
import type { LabResult } from '../src/lab/actions';
import { LabScreen } from '../src/lab/LabScreen';
import { fetchDevPlan, labDeps } from '../src/lab/device';
import { PlanError, type DevPlan, type LabPlan } from '../src/lab/plan';
import type { SelfTestScreenProps } from '../src/selftest/SelfTestScreen';
import type { SelfTestJournal, SelfTestReport } from '../src/selftest/types';
import type { RawFetch } from '../src/till/http';
import { DevOnlyError } from '../src/till/store/wipe';

function textOf(tree: ReactTestRenderer, id: string): string {
  const nodes = tree.root.findAll((n) => n.props.testID === id);
  expect(nodes.length).toBeGreaterThan(0);
  return ([] as unknown[]).concat(nodes[0].props.children).join('');
}

function has(tree: ReactTestRenderer, id: string): boolean {
  return tree.root.findAll((n) => n.props.testID === id).length > 0;
}

const P: LabPlan = {
  action: 'burst',
  run: 'k1',
  name: 'kill',
  count: 20,
  durability: 'wal',
  samples: 200,
  sizes: [1000, 10000],
};

/** A self-test run that never finishes: the screen stays as it first rendered. */
const pendingSelftest = (): SelfTestScreenProps['run'] => (_onStep) =>
  new Promise<SelfTestReport>(() => undefined);

/** A lab run that never finishes. */
const pendingLab = (): ((onLine: (line: string) => void) => Promise<LabResult>) => (_onLine) =>
  new Promise<LabResult>(() => undefined);

/** A raw fetch answering every request with 200 and `body`. */
const answering = (body: string): RawFetch => async () => ({
  status: 200,
  url: 'http://b/plan',
  text: async () => body,
});

describe('the development root', () => {
  let tree!: ReactTestRenderer;

  it('the self-test plan shows the self-test over the memory journal', async () => {
    const selftest = jest.fn((_journal: SelfTestJournal) => pendingSelftest());
    await act(async () => {
      tree = renderer.create(
        <DevRoot
          plan={async (): Promise<DevPlan> => ({ mode: 'selftest' })}
          selftest={selftest}
          lab={jest.fn()}
        />,
      );
    });
    expect(selftest).toHaveBeenCalledTimes(1);
    expect(selftest).toHaveBeenCalledWith('memory');
    expect(has(tree, 'selftest-title')).toBe(true);
  });

  it('the real-journal plan shows the self-test over SQLCipher', async () => {
    const selftest = jest.fn((_journal: SelfTestJournal) => pendingSelftest());
    await act(async () => {
      tree = renderer.create(
        <DevRoot
          plan={async (): Promise<DevPlan> => ({ mode: 'selftest-sqlcipher' })}
          selftest={selftest}
          lab={jest.fn()}
        />,
      );
    });
    expect(selftest).toHaveBeenCalledTimes(1);
    expect(selftest).toHaveBeenCalledWith('sqlcipher');
    expect(has(tree, 'selftest-title')).toBe(true);
  });

  it('a lab plan shows the lab', async () => {
    const selftest = jest.fn((_journal: SelfTestJournal) => pendingSelftest());
    const lab = jest.fn((_p: LabPlan) => pendingLab());
    await act(async () => {
      tree = renderer.create(
        <DevRoot plan={async (): Promise<DevPlan> => ({ mode: 'lab', lab: P })} selftest={selftest} lab={lab} />,
      );
    });
    expect(lab).toHaveBeenCalledTimes(1);
    expect(lab).toHaveBeenCalledWith(P);
    expect(selftest).not.toHaveBeenCalled();
    expect(has(tree, 'lab-title')).toBe(true);
    expect(textOf(tree, 'lab-plan')).toBe('burst k1 on lab-kill');
  });

  it('a plan that cannot be read is shown and nothing runs', async () => {
    const selftest = jest.fn((_journal: SelfTestJournal) => pendingSelftest());
    const lab = jest.fn((_p: LabPlan) => pendingLab());
    await act(async () => {
      tree = renderer.create(
        <DevRoot
          plan={async (): Promise<DevPlan> => {
            throw new PlanError('bad');
          }}
          selftest={selftest}
          lab={lab}
        />,
      );
    });
    expect(textOf(tree, 'dev-plan-error')).toBe('PLAN FAIL: bad');
    expect(selftest).not.toHaveBeenCalled();
    expect(lab).not.toHaveBeenCalled();
  });

  it('the lab screen shows each line and the result', async () => {
    const run = jest.fn(async (onLine: (line: string) => void): Promise<LabResult> => {
      onLine('wrote 100');
      return { run: 'k1', action: 'burst', state: 'ready', wrote: 100 };
    });
    await act(async () => {
      tree = renderer.create(<LabScreen plan={P} run={run} />);
    });
    expect(textOf(tree, 'lab-line-0')).toBe('wrote 100');
    expect(textOf(tree, 'lab-state')).toBe('LAB burst ready');
    expect(has(tree, 'lab-done')).toBe(true);
    expect(has(tree, 'lab-message')).toBe(false);
  });

  it('the lab screen shows what the merchant would be told', async () => {
    const run = async (): Promise<LabResult> => ({
      run: 'v1',
      action: 'open',
      state: 'journal-missing',
      storedGeneration: 3,
    });
    await act(async () => {
      tree = renderer.create(<LabScreen plan={P} run={run} />);
    });
    expect(textOf(tree, 'lab-message')).toBe(
      "This phone's payment record is missing: Not now / Start a new record",
    );
  });

  it('a failed lab run is shown', async () => {
    const run = async (): Promise<LabResult> => {
      throw new Error('x');
    };
    await act(async () => {
      tree = renderer.create(<LabScreen plan={P} run={run} />);
    });
    expect(textOf(tree, 'lab-state')).toBe('LAB FAIL: x');
    expect(has(tree, 'lab-done')).toBe(true);
  });
});

describe('the development plan', () => {
  it('the plan is the self-test when the bench cannot be reached', async () => {
    const unreachable: RawFetch = async () => {
      throw new Error('no bench');
    };
    await expect(fetchDevPlan(unreachable, 'http://b', true)).resolves.toEqual({ mode: 'selftest' });

    const served = JSON.stringify({ mode: 'lab', lab: { action: 'burst', run: 'k1', name: 'kill' } });
    await expect(fetchDevPlan(answering(served), 'http://b', true)).resolves.toEqual({
      mode: 'lab',
      lab: { action: 'burst', run: 'k1', name: 'kill', count: 20, durability: 'wal', samples: 200, sizes: [1000, 10000] },
    });

    const bad = '{"mode":"lab","lab":{"action":"fly","run":"k","name":"n"}}';
    await expect(fetchDevPlan(answering(bad), 'http://b', true)).rejects.toBeInstanceOf(PlanError);
  });

  it('the lab wiring refuses outside development', async () => {
    expect(() => labDeps(false)).toThrow(DevOnlyError);
    const raw: RawFetch = async () => {
      throw new Error('no bench');
    };
    await expect(fetchDevPlan(raw, 'http://b', false)).rejects.toBeInstanceOf(DevOnlyError);
  });
});
