import { open, walletPayout, type HttpFetch } from 'cashucard';
import { benchClient } from '../src/lab/bench';
import { parsePlan, PlanError } from '../src/lab/plan';
import { hex64, paymentRow } from '../src/lab/rows';
import { summarize } from '../src/lab/stats';
import { createSchema, createSerial, openDatabase } from '../src/till/store/db';
import { SqliteJournal } from '../src/till/store/journal';
import type { RawFetch, RawInit } from '../src/till/http';
import { fakeDisk } from './helpers/fake-sql';

const KEY = 'ab'.repeat(32);

const http: HttpFetch = async () => {
  throw new Error('no fetch expected');
};

async function setup() {
  const disk = fakeDisk();
  const { driver } = await openDatabase(disk.opener, '/d', 'j.db', KEY);
  await createSchema(driver);
  const j = new SqliteJournal(driver, createSerial(), () => 1000);
  return { disk, driver, j };
}

describe('the journal lab basics', () => {
  it('a plan that is not a lab plan is the self-test', () => {
    expect(parsePlan(null)).toEqual({ mode: 'selftest' });
    expect(parsePlan('x')).toEqual({ mode: 'selftest' });
    expect(parsePlan({})).toEqual({ mode: 'selftest' });
    expect(parsePlan({ mode: 'selftest' })).toEqual({ mode: 'selftest' });
    expect(parsePlan({ mode: 'other' })).toEqual({ mode: 'selftest' });
    expect(parsePlan({ mode: 'selftest-sqlcipher' })).toEqual({ mode: 'selftest-sqlcipher' });
  });

  it('a lab plan takes its defaults', () => {
    const plan = parsePlan({ mode: 'lab', lab: { action: 'burst', run: 'k1', name: 'kill' } });
    expect(plan).toEqual({
      mode: 'lab',
      lab: { action: 'burst', run: 'k1', name: 'kill', count: 20, durability: 'wal', samples: 200, sizes: [1000, 10000] },
    });
    if (plan.mode === 'lab') {
      expect('choice' in plan.lab).toBe(false);
    }
  });

  it('a lab plan keeps what it was given', () => {
    const lab = {
      action: 'open',
      run: 'v-2',
      name: 'rb',
      count: 5,
      choice: 'use-older',
      durability: 'delete',
      samples: 7,
      sizes: [20, 50],
    };
    expect(parsePlan({ mode: 'lab', lab })).toEqual({ mode: 'lab', lab });
  });

  it('a lab plan that is wrong is refused, by name', () => {
    const refused = (lab: unknown, pattern: RegExp): void => {
      let caught: unknown = null;
      try {
        parsePlan({ mode: 'lab', lab });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PlanError);
      expect((caught as Error).message).toMatch(pattern);
    };

    refused({ action: 'fly', run: 'k', name: 'n' }, /no such lab action: fly/);
    refused({ action: 'burst', run: 'K1', name: 'n' }, /a run is/);
    refused({ action: 'burst', run: '', name: 'n' }, /a run is/);
    refused({ action: 'burst', run: 'k', name: 'Kill' }, /a lab store name/);
    refused({ action: 'burst', run: 'k', name: 'a'.repeat(17) }, /a lab store name/);
    refused({ action: 'burst', run: 'k', name: 'n', count: 0 }, /count is/);
    refused({ action: 'burst', run: 'k', name: 'n', count: 1.5 }, /count is/);
    refused({ action: 'burst', run: 'k', name: 'n', choice: 'delete' }, /no such choice: delete/);
    refused({ action: 'burst', run: 'k', name: 'n', durability: 'off' }, /durability is/);
    refused({ action: 'burst', run: 'k', name: 'n', samples: 0 }, /samples is/);
    refused({ action: 'burst', run: 'k', name: 'n', sizes: [] }, /sizes are/);
    refused({ action: 'burst', run: 'k', name: 'n', sizes: [10, 5] }, /sizes are/);
    refused({ action: 'burst', run: 'k', name: 'n', sizes: [1, 2, 3, 4, 5] }, /sizes are/);
    refused({ action: 'burst', run: 'k', name: 'n', sizes: [0] }, /sizes are/);

    expect(() => parsePlan({ mode: 'lab' })).toThrow(/needs a lab object/);
  });

  it('hex64 is 64 hex characters, the same for the same input', () => {
    expect(hex64(3, 4)).toHaveLength(64);
    expect(hex64(3, 4)).toMatch(/^[0-9a-f]{64}$/);
    expect(hex64(3, 4)).toBe(hex64(3, 4));
    expect(hex64(3, 4)).not.toBe(hex64(3, 5));
  });

  it('a payment row is about the size asked, with its own id', () => {
    const r = paymentRow(1, 4400);
    const length = JSON.stringify(r).length;
    expect(length).toBeGreaterThanOrEqual(4400);
    expect(length).toBeLessThanOrEqual(4700);
    expect((r as unknown as { id: string }).id.startsWith('pay:')).toBe(true);
    const a = (paymentRow(1, 4400) as unknown as { id: string }).id;
    const b = (paymentRow(2, 4400) as unknown as { id: string }).id;
    expect(a).not.toBe(b);
  });

  it('the library reads the lab\'s rows as payments of this version', async () => {
    const { j } = await setup();
    for (const i of [1, 2, 3]) {
      await j.write(paymentRow(i, 4400));
    }
    const c = await open({
      journal: j,
      payout: walletPayout({ mints: [], keep: async () => undefined }),
      http,
      leftoverByPin: false,
      clock: null,
    });
    expect(await c.damagedRows()).toEqual([]);
    expect(await c.olderRows()).toEqual([]);
  });

  it('summarize gives the numbers of a list', () => {
    expect(summarize([])).toEqual({ n: 0, min: 0, median: 0, p90: 0, max: 0, mean: 0 });
    expect(summarize([5])).toEqual({ n: 1, min: 5, median: 5, p90: 5, max: 5, mean: 5 });
    expect(summarize([4, 1, 3, 2])).toEqual({ n: 4, min: 1, median: 2.5, p90: 4, max: 4, mean: 2.5 });
    expect(summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).p90).toBe(9);
    expect(summarize([1 / 3]).mean).toBe(0.33);
  });

  it('the bench client reads the plan and posts JSON', async () => {
    const calls: Array<{ url: string; init: RawInit }> = [];
    const raw: RawFetch = async (url, init) => {
      calls.push({ url, init });
      return { status: 200, text: async () => '{"mode":"selftest"}' };
    };
    const b = benchClient(raw, 'http://b');
    await expect(b.plan()).resolves.toEqual({ mode: 'selftest' });
    expect(calls[0].url).toBe('http://b/plan');
    expect(calls[0].init.method).toBe('GET');
    await b.post('/event', { a: 1 });
    expect(calls[1].url).toBe('http://b/event');
    expect(calls[1].init.method).toBe('POST');
    expect(calls[1].init.headers['Content-Type']).toBe('application/json');
    expect(calls[1].init.body).toBe('{"a":1}');
  });

  it('the bench client refuses an answer other than 200', async () => {
    const raw: RawFetch = async () => ({ status: 500, text: async () => 'no' });
    const b = benchClient(raw, 'http://b');
    await expect(b.post('/event', {})).rejects.toThrow(/answered 500 to \/event/);
    await expect(b.plan()).rejects.toThrow(/answered 500 to \/plan/);
  });
});
