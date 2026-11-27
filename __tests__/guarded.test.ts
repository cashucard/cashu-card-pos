import { GATE_REASONS, GATE_WORDS, type DeviceGate, type GateResult } from '../src/till/gate';
import { benchGate, gateResultOf, guarded } from '../src/till/guarded';

describe('the guarded action', () => {
  it('an allowed check runs the action', async () => {
    const g = benchGate('allow');
    const answer = await guarded(g, 'mints', async () => 7);
    expect(answer).toEqual({ ok: true, value: 7 });
    expect(g.asked).toEqual([GATE_REASONS.mints]);
  });

  it('a refused check does not run it', async () => {
    const g = benchGate('deny');
    const action = jest.fn(async () => 1);
    const answer = await guarded(g, 'mints', action);
    expect(action).not.toHaveBeenCalled();
    expect(answer).toEqual({ ok: false, why: 'cancelled', words: 'Not confirmed. Nothing was changed.' });
  });

  it('a phone with no passcode is told to set one, and nothing is asked', async () => {
    const check = jest.fn(async (_reason: string): Promise<GateResult> => ({ ok: true }));
    const action = jest.fn(async () => 1);

    const noPasscode: DeviceGate = { available: async () => false, check };
    const answer = await guarded(noPasscode, 'mints', action);
    expect(answer).toEqual({
      ok: false,
      why: 'unavailable',
      words: 'Set a passcode on this phone first. Then try again.',
    });
    expect(check).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();

    const brokenAvailability: DeviceGate = {
      available: async () => {
        throw new Error('no keychain');
      },
      check,
    };
    const again = await guarded(brokenAvailability, 'mints', action);
    expect(again).toEqual({
      ok: false,
      why: 'unavailable',
      words: GATE_WORDS.unavailable,
    });
    expect(check).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('a check that throws is a failure', async () => {
    const gate: DeviceGate = {
      available: async () => true,
      check: async () => {
        throw new Error('the sheet broke');
      },
    };
    const action = jest.fn(async () => 1);
    const answer = await guarded(gate, 'wallet', action);
    expect(answer).toEqual({ ok: false, why: 'failed', words: GATE_WORDS.failed });
    expect(action).not.toHaveBeenCalled();
  });

  it("the action's own failure is passed on", async () => {
    const g = benchGate('allow');
    await expect(
      guarded(g, 'records', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);
  });

  it('gateResultOf', () => {
    expect(gateResultOf({ ok: true, value: 1 })).toEqual({ ok: true });
    const refusal = { ok: false, why: 'cancelled', words: GATE_WORDS.cancelled } as const;
    expect(gateResultOf(refusal)).toEqual({ ok: false, why: 'cancelled', words: GATE_WORDS.cancelled });
  });
});
