import { settleSchedule, type ScheduleSource, type SettleWhy } from '../src/till/settle';

function source(front = true) {
  const timers: Array<{ f: () => void; ms: number; cleared: boolean; fired: boolean }> = [];
  const listeners: Array<(a: boolean) => void> = [];
  const state = { front };
  const src: ScheduleSource = {
    active: () => state.front,
    onActive: (l) => {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) {
          listeners.splice(i, 1);
        }
      };
    },
    timers: {
      set: (f, ms) => {
        const t = { f, ms, cleared: false, fired: false };
        timers.push(t);
        return t;
      },
      clear: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    },
  };
  const live = () => timers.filter((t) => !t.cleared && !t.fired);
  return {
    src,
    live,
    fire(): void {
      const l = live();
      if (l.length !== 1) {
        throw new Error('live timers: ' + l.length);
      }
      l[0].fired = true;
      l[0].f();
    },
    tell(a: boolean): void {
      state.front = a;
      for (const l of listeners.slice()) {
        l(a);
      }
    },
    listening: () => listeners.length,
  };
}

function make(src: ScheduleSource | null, fail = false) {
  const whys: SettleWhy[] = [];
  let checks = 0;
  const clock = { t: 0 };
  const s = settleSchedule({
    settle: async (why) => {
      whys.push(why);
      if (fail) {
        throw new Error('no');
      }
    },
    recheck: async () => {
      checks += 1;
      if (fail) {
        throw new Error('no');
      }
    },
    now: () => clock.t,
    source: src,
  });
  return { s, whys, checks: () => checks, clock };
}

/** Lets every microtask and timer callback queued so far run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

test('the launch checks the mints again and settles, once', async () => {
  const t = make(source().src);
  t.s.start();
  await flush();
  expect(t.whys).toEqual(['launch']);
  expect(t.checks()).toBe(1);
  t.s.start();
  await flush();
  expect(t.whys).toEqual(['launch']);
  expect(t.checks()).toBe(1);
});

test('without a source only the launch runs', async () => {
  const t = make(null);
  t.s.start();
  await flush();
  expect(t.whys).toEqual(['launch']);
  expect(t.checks()).toBe(1);
  await flush();
  expect(t.whys).toEqual(['launch']);
  expect(t.checks()).toBe(1);
});

test('every three minutes while in front', async () => {
  const x = source();
  const t = make(x.src);
  t.s.start();
  await flush();
  const armed = x.live();
  expect(armed.length).toBe(1);
  expect(armed[0].ms).toBe(180000);
  x.fire();
  await flush();
  expect(t.whys).toEqual(['launch', 'timer']);
  const again = x.live();
  expect(again.length).toBe(1);
  expect(again[0].ms).toBe(180000);
  x.fire();
  await flush();
  expect(t.whys).toEqual(['launch', 'timer', 'timer']);
});

test('coming to the front settles; going to the back stops the timer', async () => {
  const x = source();
  const t = make(x.src);
  t.s.start();
  await flush();
  expect(x.live().length).toBe(1);
  x.tell(false);
  expect(x.live()).toEqual([]);
  x.tell(false);
  await flush();
  expect(t.whys).toEqual(['launch']);
  x.tell(true);
  await flush();
  expect(t.whys).toEqual(['launch', 'front']);
  expect(x.live().length).toBe(1);
  x.tell(true);
  await flush();
  expect(t.whys).toEqual(['launch', 'front']);
  expect(x.live().length).toBe(1);
});

test('starting in the back arms no timer until the front', async () => {
  const x = source(false);
  const t = make(x.src);
  t.s.start();
  await flush();
  expect(t.whys).toEqual(['launch']);
  expect(x.live()).toEqual([]);
  x.tell(true);
  await flush();
  expect(t.whys).toEqual(['launch', 'front']);
  expect(x.live().length).toBe(1);
});

test('the mints are asked again at most every hour', async () => {
  const x = source();
  const t = make(x.src);
  t.s.start();
  await flush();
  expect(t.checks()).toBe(1);
  t.clock.t = 180000;
  x.fire();
  await flush();
  expect(t.checks()).toBe(1);
  x.tell(false);
  t.clock.t = 1000000;
  x.tell(true);
  await flush();
  expect(t.checks()).toBe(1);
  t.clock.t = 3600000;
  x.fire();
  await flush();
  expect(t.checks()).toBe(2);
  t.clock.t = 3700000;
  x.fire();
  await flush();
  expect(t.checks()).toBe(2);
});

test('a clock put back asks the mints again at once', async () => {
  const x = source();
  const t = make(x.src);
  t.clock.t = 5000000;
  t.s.start();
  await flush();
  expect(t.checks()).toBe(1);
  t.clock.t = 100;
  x.fire();
  await flush();
  expect(t.checks()).toBe(2);
});

test('a settle or a check that fails stops nothing', async () => {
  const x = source();
  const t = make(x.src, true);
  t.s.start();
  await flush();
  x.fire();
  await flush();
  x.fire();
  await flush();
  expect(t.whys.length).toBe(3);
  expect(t.checks()).toBe(1);
  expect(x.live().length).toBe(1);
});

test('a settle that throws at once is caught', () => {
  const s = settleSchedule({
    settle: () => {
      throw new Error('at once');
    },
    recheck: async () => undefined,
    now: () => 0,
    source: null,
  });
  expect(() => s.start()).not.toThrow();
});

test('after stop nothing more is asked', async () => {
  const x = source();
  const t = make(x.src);
  t.s.start();
  await flush();
  t.s.stop();
  expect(x.live()).toEqual([]);
  expect(x.listening()).toBe(0);
  x.tell(false);
  x.tell(true);
  await flush();
  expect(t.whys).toEqual(['launch']);
  t.s.start();
  await flush();
  expect(t.whys).toEqual(['launch']);
});
