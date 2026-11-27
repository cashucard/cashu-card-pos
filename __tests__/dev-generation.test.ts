/* The development switch that makes the secure store refuse the record's generation (slice 2.4): the bench plan's
 * `generation`, the refusal's window, the faulty store, and the till stopped by it over the real library. */

import { devAppWiring } from '../src/dev/app-wiring';
import { faultyGeneration, refusalWindow, REFUSED_SET_MESSAGE } from '../src/dev/record-faults';
import { parsePlan, PlanError } from '../src/lab/plan';
import { SalesStoppedError } from '../src/till/card-errors';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { generationStore } from '../src/till/store/secret';
import { TILL_NAMES } from '../src/till/store/types';
import { DevOnlyError } from '../src/till/store/wipe';
import { fakeMint } from './helpers/fake-mint';
import { fakeSecure } from './helpers/fake-secure';
import { fakeStoreDeps } from './helpers/fake-store';

describe("the bench plan's generation switch", () => {
  it('is read with its two numbers, each 0 when absent', () => {
    expect(parsePlan({ mode: 'app', app: { gate: 'bench-allow', generation: { refuseMs: 60000, fromSale: 1 } } })).toEqual({
      mode: 'app',
      app: { gate: 'bench-allow', generation: { refuseMs: 60000, fromSale: 1 } },
    });
    expect(parsePlan({ mode: 'app', app: { gate: 'bench-allow', generation: {} } })).toEqual({
      mode: 'app',
      app: { gate: 'bench-allow', generation: { refuseMs: 0, fromSale: 0 } },
    });
    expect(parsePlan({ mode: 'app', app: { gate: 'bench-allow' } })).toEqual({ mode: 'app', app: { gate: 'bench-allow' } });
  });

  it('a wrong one is refused, by name', () => {
    expect(() => parsePlan({ mode: 'app', app: { generation: 3 } })).toThrow(PlanError);
    expect(() => parsePlan({ mode: 'app', app: { generation: 3 } })).toThrow(/generation is an object/);
    expect(() => parsePlan({ mode: 'app', app: { generation: { refuseMs: 3600001 } } })).toThrow(
      /a fault switch is a whole number from 0 to 3600000: refuseMs/,
    );
    expect(() => parsePlan({ mode: 'app', app: { generation: { fromSale: 2 } } })).toThrow(
      /a fault switch is a whole number from 0 to 1: fromSale/,
    );
  });
});

describe('the refusal', () => {
  it('counted from the launch: for its ms, then no more', () => {
    const clock = { now: 1000 };
    const refuse = refusalWindow(500, false, () => false, () => clock.now);
    expect(refuse()).toBe(true);
    clock.now = 1499;
    expect(refuse()).toBe(true);
    clock.now = 1500;
    expect(refuse()).toBe(false);
  });

  it("counted from the first sale's opening: nothing before it, then for its ms", () => {
    const clock = { now: 1000 };
    const sale = { running: false };
    const refuse = refusalWindow(500, true, () => sale.running, () => clock.now);
    expect(refuse()).toBe(false);
    clock.now = 5000;
    expect(refuse()).toBe(false);
    sale.running = true;
    expect(refuse()).toBe(true);
    sale.running = false;
    clock.now = 5499;
    expect(refuse()).toBe(true);
    clock.now = 5500;
    expect(refuse()).toBe(false);
  });

  it('the faulty store refuses a set before the secure store is asked, tells it, and lets reads through', async () => {
    const s = fakeSecure();
    const on = { refuse: false };
    let told = 0;
    const g = faultyGeneration(generationStore(s, TILL_NAMES), () => on.refuse, () => { told += 1; }, true);
    await g.set(3);
    on.refuse = true;
    const sets = s.sets.length;
    await expect(g.set(4)).rejects.toThrow(REFUSED_SET_MESSAGE);
    expect(s.sets.length).toBe(sets);
    expect(told).toBe(1);
    expect(await g.get()).toBe(3);
    on.refuse = false;
    await g.set(5);
    expect(await g.get()).toBe(5);
  });

  it('a report that throws never changes the refusal', async () => {
    const g = faultyGeneration(generationStore(fakeSecure(), TILL_NAMES), () => true, () => { throw new Error('report'); }, true);
    await expect(g.set(1)).rejects.toThrow(REFUSED_SET_MESSAGE);
  });

  it('never outside development', () => {
    expect(() => faultyGeneration(generationStore(fakeSecure(), TILL_NAMES), () => true, () => undefined, false)).toThrow(DevOnlyError);
    expect(() => devAppWiring({ gate: 'device', generation: { refuseMs: 1000, fromSale: 0 } }, false)).toThrow(DevOnlyError);
  });
});

describe('the till over the switch and the real library', () => {
  it("stops new sales from the first sale's opening, and takes them again at the first settle after the window", async () => {
    const f = fakeStoreDeps();
    const clock = { now: 1000 };
    f.deps.now = () => clock.now;
    let saleRunning = (): boolean => false;
    let refused = 0;
    const refuse = refusalWindow(60000, true, () => saleRunning(), () => clock.now);
    const service = createTillService({
      store: f.deps, names: TILL_NAMES, settingsNames: TILL_SETTINGS, http: fakeMint().http, now: () => clock.now,
      log: () => undefined,
      wait: async () => undefined,
      devGeneration: (g) => faultyGeneration(g, refuse, () => { refused += 1; }, true),
    });
    saleRunning = () => service.queue.running() === 'sale';
    await service.open();
    await service.addMint(await service.checkMint('mint.test'));
    await service.settleNow('launch');
    expect(service.salesStopped()).toBe(false);
    expect(refused).toBe(0);
    await service.openSale(14);
    expect(service.salesStopped()).toBe(true);
    expect(refused).toBe(1);
    clock.now += 1000;
    await expect(service.openSale(21)).rejects.toBeInstanceOf(SalesStoppedError);
    // inside the window a settle hands the generation over again, and it is refused again
    await service.settleNow('asked');
    expect(service.salesStopped()).toBe(true);
    expect(refused).toBe(2);
    clock.now += 60000;
    await service.settleNow('asked');
    expect(service.salesStopped()).toBe(false);
    expect(refused).toBe(2);
    await expect(service.openSale(21)).resolves.toEqual(expect.any(String));
    await service.close();
  }, 60000);
});
