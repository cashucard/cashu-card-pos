import { createTillQueue } from '../src/till/queue';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value);
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every microtask and timer callback queued so far run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the till queue', () => {
  it('jobs run one at a time, in the order asked', async () => {
    const q = createTillQueue();
    const log: string[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const runs = [1, 2, 3].map((n) =>
      q.run('sale', async () => {
        log.push('start ' + n);
        await gates[n - 1].promise;
        log.push('end ' + n);
        return n;
      }),
    );
    await flush();
    expect(log).toEqual(['start 1']);
    gates[0].resolve(undefined);
    await flush();
    expect(log).toEqual(['start 1', 'end 1', 'start 2']);
    gates[1].resolve(undefined);
    gates[2].resolve(undefined);
    await flush();
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
    await expect(runs[0]).resolves.toBe(1);
    await expect(runs[1]).resolves.toBe(2);
    await expect(runs[2]).resolves.toBe(3);
  });

  it('a failed job does not stop the next', async () => {
    const q = createTillQueue();
    const failed = q.run('sale', async () => {
      throw new Error('x');
    });
    const next = q.run('sale', async () => 2);
    await expect(failed).rejects.toThrow(/x/);
    await expect(next).resolves.toBe(2);
  });

  it('running and waiting tell what the queue holds', async () => {
    const q = createTillQueue();
    const card = deferred<void>();
    const settle = deferred<void>();
    const cardRun = q.run('card', async () => {
      await card.promise;
    });
    const settleRun = q.run('settle', async () => {
      await settle.promise;
    });
    await flush();
    expect(q.running()).toBe('card');
    expect(q.waiting()).toBe(1);
    expect(q.tapOpen()).toBe(true);
    card.resolve(undefined);
    await flush();
    expect(q.running()).toBe('settle');
    expect(q.tapOpen()).toBe(false);
    expect(q.waiting()).toBe(0);
    settle.resolve(undefined);
    await cardRun;
    await settleRun;
    await flush();
    expect(q.running()).toBe(null);
  });

  it('a settle never starts while a card job runs', async () => {
    const q = createTillQueue();
    const card = deferred<void>();
    const seen: { tap: boolean; kind: string | null } = { tap: true, kind: null };
    const cardRun = q.run('card', async () => {
      await card.promise;
    });
    const settleRun = q.run('settle', async () => {
      seen.tap = q.tapOpen();
      seen.kind = q.running();
    });
    await flush();
    card.resolve(undefined);
    await settleRun;
    await cardRun;
    expect(seen.tap).toBe(false);
    expect(seen.kind).toBe('settle');
  });

  it('idle waits for every job asked, and never rejects', async () => {
    const q = createTillQueue();
    let done = 0;
    const failed = q.run('settle', async () => {
      done += 1;
      throw new Error('x');
    });
    const next = q.run('settle', async () => {
      done += 1;
      return 2;
    });
    failed.catch(() => undefined);
    await q.idle();
    expect(done).toBe(2);
    await expect(next).resolves.toBe(2);
  });

  it('a job may ask for another without waiting for it', async () => {
    const q = createTillQueue();
    const order: string[] = [];
    const settleDone = deferred<void>();
    const reopen = q.run('reopen', async () => {
      order.push('reopen');
      void q.run('settle', async () => {
        order.push('settle');
        settleDone.resolve(undefined);
      });
    });
    await reopen;
    await settleDone.promise;
    expect(order).toEqual(['reopen', 'settle']);
  });
});
