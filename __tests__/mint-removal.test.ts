import { open, type Config, type Payment } from 'cashucard';
import { sameUrl } from '../src/till/http';
import type { JobKind } from '../src/till/queue';
import { createTillService, MintInUseError, type TillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { MINTS_WORDS } from '../src/screens/MintsScreen';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { heldPayment } from './helpers/fake-till';

type Library = Awaited<ReturnType<typeof open>>;

function make(
  f = fakeStoreDeps(),
  mint = fakeMint(),
  clock = { t: 1000 },
  opener: (c: Config) => Promise<Library> = open,
) {
  const configs: Config[] = [];
  const reopenKinds: Array<JobKind | null> = [];
  let service!: TillService;
  let pays: Payment[] = [];
  let settled = 0;
  service = createTillService({
    store: f.deps,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: mint.http,
    now: () => clock.t,
    log: () => undefined,
    openLibrary: async (c) => {
      configs.push(c);
      reopenKinds.push(service.queue.running());
      const k = await opener(c);
      k.payments = async () => pays;
      k.settle = async () => {
        settled += 1;
        return [];
      };
      return k;
    },
  });
  return {
    f,
    mint,
    clock,
    service,
    configs,
    reopenKinds,
    setPays(next: Payment[]): void {
      pays = next;
    },
    settled(): number {
      return settled;
    },
  };
}

/** The mints the library takes, as its payout answers them. */
async function taken(c: Config): Promise<string[]> {
  return (await c.payout.accepts()).mints;
}

async function addGood(t: ReturnType<typeof make>): Promise<void> {
  await t.service.open();
  await t.service.addMint(await t.service.checkMint('mint.test'));
}

describe('removing a mint', () => {
  it('keeps a mint with a paid card top-up and clears its offline permission when later removed', async () => {
    const t = make();
    await addGood(t);
    const driver = t.f.disk.drivers[0];
    await driver.run("INSERT INTO card_topups VALUES(?, ?, ?, 'ready', 1, 1, '{}')",
      ['unloaded', 'fixture-card', 'https://mint.test/']);
    expect(await t.service.hasReadyOfflineMint()).toBe(true);
    expect((await t.service.removalOf('https://mint.test')).refused).toBe('topup');
    await expect(t.service.removeMint('https://mint.test/')).rejects.toHaveProperty('why', 'topup');
    expect((await driver.run('SELECT mint FROM offline_kits')).rows).toHaveLength(1);
    await driver.run("UPDATE card_topups SET state='loaded'");
    await t.service.removeMint('https://mint.test');
    expect((await driver.run('SELECT mint FROM offline_kits')).rows).toEqual([]);
    expect((await driver.run('SELECT state FROM card_topups')).rows).toEqual([{state: 'loaded'}]);
    await t.service.close();
  });

  it('a mint whose payments may never finish, but owe no card, is removed', async () => {
    const t = make();
    await addGood(t);
    t.setPays([
      { ...heldPayment('s1'), state: 'taking', why: 'bad-signature' },
      { ...heldPayment('s2'), state: 'spent-not-restored' },
      { ...heldPayment('s3'), state: 'lost' },
    ]);
    await expect(t.service.removeMint('https://mint.test')).resolves.toBeUndefined();
    expect(t.service.mints()).toEqual([]);
    expect(await taken(t.configs[t.configs.length - 1])).toEqual([]);
  });

  it('settle still runs after its mint was removed', async () => {
    const t = make();
    await addGood(t);
    t.setPays([
      { ...heldPayment('s1'), state: 'taking', why: 'bad-signature' },
      { ...heldPayment('s2'), state: 'spent-not-restored' },
      { ...heldPayment('s3'), state: 'lost' },
    ]);
    await expect(t.service.removeMint('https://mint.test')).resolves.toBeUndefined();
    expect(t.service.mints()).toEqual([]);
    expect(await taken(t.configs[t.configs.length - 1])).toEqual([]);
    await expect(t.service.settleNow('asked')).resolves.toEqual([]);
    expect(t.settled()).toBe(1);
  });

  it('a mint that owes a card its change is never removed, and says why', async () => {
    const t = make();
    await addGood(t);
    t.setPays([{ ...heldPayment('s1'), owedToCard: 3 }]);
    let error: unknown = null;
    try {
      await t.service.removeMint('https://mint.test');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MintInUseError);
    expect((error as MintInUseError).url).toBe('https://mint.test');
    expect(t.service.mints().length).toBe(1);
    expect(t.service.mints()[0].url).toBe('https://mint.test');
  });

  it('a card payment still being taken refuses the removal until it is finished and owes nothing', async () => {
    const t = make();
    await addGood(t);
    const refusal = async (): Promise<unknown> => {
      try {
        await t.service.removeMint('https://mint.test');
        return null;
      } catch (e) {
        return e;
      }
    };
    // the swap's answer was lost: CHECKING, nothing owed to the card yet
    t.setPays([{ ...heldPayment('s1'), state: 'taking', why: 'swap-waiting: 503' }]);
    let e = await refusal();
    expect(e).toBeInstanceOf(MintInUseError);
    expect((e as MintInUseError).why).toBe('unfinished');
    // an open claim: the card signed, the till has not had the signature back
    t.setPays([{ ...heldPayment('s1'), state: 'unrecovered' }]);
    e = await refusal();
    expect((e as MintInUseError).why).toBe('unfinished');
    // settle landed the swap: the card is owed its change
    t.setPays([{ ...heldPayment('s1'), owedToCard: 50 }]);
    e = await refusal();
    expect((e as MintInUseError).why).toBe('owed');
    expect(t.service.mints().length).toBe(1);
    // the card's next tap was given its change
    t.setPays([{ ...heldPayment('s1'), state: 'delivered', givenBack: 50 }]);
    expect(await refusal()).toBeNull();
    expect(t.service.mints()).toEqual([]);
  });

  it('what a removal would leave is read from the record', async () => {
    const t = make();
    await addGood(t);
    t.setPays([]);
    expect(await t.service.removalOf('https://mint.test')).toEqual({ refused: null, late: false, unproved: false });
    t.setPays([
      { ...heldPayment('s1'), state: 'spent-not-restored' },
      { ...heldPayment('s2'), owedToCard: 5, stuck: 5, unproved: 5 },
    ]);
    expect(await t.service.removalOf('https://mint.test')).toEqual({ refused: null, late: true, unproved: true });
    t.setPays([{ ...heldPayment('s1'), state: 'taking' }]);
    expect(await t.service.removalOf('https://mint.test')).toEqual({ refused: 'unfinished', late: false, unproved: false });
    t.setPays([{ ...heldPayment('s1'), state: 'taking', why: 'bad-signature' }]);
    expect(await t.service.removalOf('https://mint.test')).toEqual({ refused: null, late: true, unproved: false });
    t.setPays([{ ...heldPayment('s1'), mint: 'https://other.test', state: 'taking' }]);
    expect(await t.service.removalOf('https://mint.test')).toEqual({ refused: null, late: false, unproved: false });
  });

  it('the reason given is plain', () => {
    expect(MINTS_WORDS.unfinished).toContain('not finished yet');
    expect(MINTS_WORDS.late).toContain('Owed to cards');
    expect(MINTS_WORDS.unproved).toContain('never proved');
    for (const w of [MINTS_WORDS.unfinished, MINTS_WORDS.late, MINTS_WORDS.unproved]) {
      expect(w).not.toContain('—');
      expect(w).not.toContain('–');
      expect(w).not.toMatch(/crypto|paid back/i);
    }
    expect(MINTS_WORDS.inUse).toContain('owed to cards');
    expect(MINTS_WORDS.inUse).not.toContain('—');
    expect(MINTS_WORDS.inUse).not.toContain('–');
    expect(MINTS_WORDS.inUse).not.toMatch(/crypto|paid back/i);
  });
});
