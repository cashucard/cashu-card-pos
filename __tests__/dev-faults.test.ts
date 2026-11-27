/* The bench plan's faults for the test mint, the till's record and the payout's keep (development only). */

import { MemoryJournal, type Delivery, type HttpFetch, type Row } from 'cashucard';
import {
  DROPPED_SWAP_MESSAGE,
  MINT_DOWN_MESSAGE,
  NOTHING_RESTORED,
  faultyHttp,
  pathOf,
  type DevMintFaults,
} from '../src/dev/mint-faults';
import {
  FAILED_WRITE_MESSAGE,
  faultyJournal,
  faultyKeep,
  type DevRecordFaults,
} from '../src/dev/record-faults';
import { DevOnlyError } from '../src/till/store/wipe';

const D: Delivery = {
  id: 'fx-' + 'a'.repeat(26),
  mint: 'https://mint.test',
  unit: 'sat',
  amount: 14,
  token: 'cashuB' + 'q'.repeat(60),
};

/** A mint fetch that records what it was asked and answers 200. */
function mintHttp(): { http: HttpFetch; calls: string[] } {
  const calls: string[] = [];
  const http: HttpFetch = async (url, init) => {
    calls.push(init.method + ' ' + pathOf(url));
    return { status: 200, text: async () => '{"ok":true}' };
  };
  return { http, calls };
}

function memJournal(): MemoryJournal {
  return new MemoryJournal();
}

const F: DevMintFaults = { dropSwaps: 0, downMs: 0, hideRestores: 0 };
const R: DevRecordFaults = { failTapWrites: 0, holdKeeps: 0 };

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(() => r(), 0));
};

describe('the development mint, record and keep faults', () => {
  it('the faults are for development only', () => {
    expect(() => faultyHttp(mintHttp().http, F, () => 0, false)).toThrow(DevOnlyError);
    expect(() => faultyJournal(memJournal(), R, () => true, false)).toThrow(DevOnlyError);
    expect(() => faultyKeep(async () => undefined, R, () => undefined, false)).toThrow(DevOnlyError);
  });

  it("a URL's path is read without the host or the query", () => {
    expect(pathOf('https://mint.test/v1/swap')).toBe('/v1/swap');
    expect(pathOf('https://mint.test:443/v1/keys/00ab?x=1')).toBe('/v1/keys/00ab');
    expect(pathOf('https://mint.test')).toBe('');
    expect(pathOf('nonsense')).toBe('');
  });

  it('a dropped swap reaches the mint, and its answer is lost', async () => {
    const faults: DevMintFaults = { ...F, dropSwaps: 1 };
    const m = mintHttp();
    const clock = { t: 1000 };
    const h = faultyHttp(m.http, faults, () => clock.t);

    await expect(h('https://mint.test/v1/swap', { method: 'POST', headers: {} })).rejects.toThrow(
      DROPPED_SWAP_MESSAGE,
    );
    expect(m.calls).toEqual(['POST /v1/swap']);
    expect(faults.dropSwaps).toBe(0);

    const second = await h('https://mint.test/v1/swap', { method: 'POST', headers: {} });
    expect(second.status).toBe(200);
    expect(m.calls).toEqual(['POST /v1/swap', 'POST /v1/swap']);
  });

  it('after a dropped swap the mint is silent for a while', async () => {
    const faults: DevMintFaults = { ...F, dropSwaps: 1, downMs: 20000 };
    const m = mintHttp();
    const clock = { t: 1000 };
    const h = faultyHttp(m.http, faults, () => clock.t);

    await expect(h('https://mint.test/v1/swap', { method: 'POST', headers: {} })).rejects.toThrow(
      /answer to the swap was lost/,
    );

    clock.t = 1000;
    await expect(h('https://mint.test/v1/keysets', { method: 'GET', headers: {} })).rejects.toThrow(
      MINT_DOWN_MESSAGE,
    );
    expect(m.calls).toEqual(['POST /v1/swap']);

    clock.t = 20999;
    await expect(h('https://mint.test/v1/keysets', { method: 'GET', headers: {} })).rejects.toThrow(
      MINT_DOWN_MESSAGE,
    );
    expect(m.calls).toEqual(['POST /v1/swap']);

    clock.t = 21000;
    const answer = await h('https://mint.test/v1/keysets', { method: 'GET', headers: {} });
    expect(answer.status).toBe(200);
  });

  it('a hidden restore says the mint signed nothing, once', async () => {
    const faults: DevMintFaults = { ...F, hideRestores: 1 };
    const m = mintHttp();
    const clock = { t: 1000 };
    const h = faultyHttp(m.http, faults, () => clock.t);

    const hidden = await h('https://mint.test/v1/restore', { method: 'POST', headers: {} });
    expect(hidden.status).toBe(200);
    await expect(hidden.text()).resolves.toBe(NOTHING_RESTORED);
    expect(m.calls).toEqual([]);

    await h('https://mint.test/v1/restore', { method: 'POST', headers: {} });
    expect(m.calls).toEqual(['POST /v1/restore']);
  });

  it('everything else goes to the mint as it is', async () => {
    const faults: DevMintFaults = { ...F };
    const m = mintHttp();
    const clock = { t: 1000 };
    const h = faultyHttp(m.http, faults, () => clock.t);

    const info = await h('https://mint.test/v1/info', { method: 'GET', headers: {} });
    const check = await h('https://mint.test/v1/checkstate', { method: 'POST', headers: {} });
    expect(info.status).toBe(200);
    expect(check.status).toBe(200);
    expect(m.calls).toEqual(['GET /v1/info', 'POST /v1/checkstate']);
  });

  it('a write during a tap fails, and only during a tap', async () => {
    const tap = { open: false };
    const j = faultyJournal(memJournal(), { failTapWrites: 1, holdKeeps: 0 }, () => tap.open);

    await expect(j.write({ kind: 'card', id: 'card:x', key: 'x', taps: 1 } as Row)).resolves.toBeUndefined();

    tap.open = true;
    await expect(j.write({ kind: 'card', id: 'card:w', key: 'w', taps: 1 } as Row)).rejects.toThrow(
      FAILED_WRITE_MESSAGE,
    );
    await expect(j.write({ kind: 'card', id: 'card:w', key: 'w', taps: 1 } as Row)).resolves.toBeUndefined();

    const rows = await j.list();
    expect(rows).toHaveLength(2);
  });

  it('the journal keeps what the inner one can do', async () => {
    const j = faultyJournal(memJournal(), R, () => false);
    expect(typeof j.insert).toBe('function');
    expect(typeof j.remove).toBe('function');
    const inserted = await j.insert?.({ kind: 'card', id: 'card:y', key: 'y', taps: 0 } as Row);
    expect(inserted).toBe(true);

    const bare = faultyJournal(
      {
        write: async () => undefined,
        read: async () => null,
        list: async () => [],
      },
      R,
      () => false,
    );
    expect('remove' in bare).toBe(false);
    expect('insert' in bare).toBe(false);
  });

  it('a held keep is committed first, then never ends, and says only the amount', async () => {
    const kept: Delivery[] = [];
    const heard: unknown[] = [];
    const k = faultyKeep(
      async (d) => {
        kept.push(d);
      },
      { failTapWrites: 0, holdKeeps: 1 },
      (a) => heard.push(a),
    );

    let settled = false;
    void k(D).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    expect(kept).toEqual([D]);
    expect(heard).toEqual([14]);
    expect(settled).toBe(false);

    await expect(k(D)).resolves.toBeUndefined();
  });

  it('a report that fails never changes the hold', async () => {
    const kept: Delivery[] = [];
    const k = faultyKeep(
      async (d) => {
        kept.push(d);
      },
      { failTapWrites: 0, holdKeeps: 1 },
      () => {
        throw new Error('the report failed');
      },
    );

    let settled = false;
    void k(D).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    expect(kept).toEqual([D]);
    expect(settled).toBe(false);
  });
});
