/* Home's line for money owed to cards of a mint the till does not take now (review of slice 1.3, B1), read from the
 * record, never dismissed; and the notices ten at a time (F2, F6). */

jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/__mocks__/BackHandler'),
);

import { open, type CashuCard, type Payment } from 'cashucard';
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AppRoot } from '../src/app/AppRoot';
import type { AppWiring } from '../src/app/wiring';
import { TillNotices, noticesMoreWords } from '../src/screens/HomeScreen';
import { MINTS_WORDS } from '../src/screens/MintsScreen';
import { benchGate } from '../src/till/guarded';
import { noReader } from '../src/till/reader';
import { createTillService } from '../src/till/service';
import type { ScheduleSource } from '../src/till/settle';
import { TILL_SETTINGS, type MintEntry } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { strandedOf, strandedWords } from '../src/till/stranded';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { heldPayment } from './helpers/fake-till';
import { allText, flush, has, press, textOf, until, untilText } from './helpers/render';

const TEST_MINT = 'https://mint.test';
const OTHER = 'https://mint.other';
const entry = (url: string, status: MintEntry['status']): MintEntry => ({
  url,
  addedAt: 1,
  checkedAt: 1,
  keysets: ['00'],
  status,
  why: status === 'ok' ? null : 'it did not pass its check.',
});
const OFF_50 =
  'Owed to cards from mint.test: 50 sats. This mint was removed from sales. Open Owed to cards and scan the original card. A return may have to wait for the mint.';
const OFF_7 =
  'Owed to cards from mint.other: 7 sats. This mint was removed from sales. Open Owed to cards and scan the original card. A return may have to wait for the mint.';
const LISTED_7 =
  'Owed to cards from mint.other: 7 sats. This mint is paused for sales. Open Owed to cards and scan the original card. A return may have to wait for the mint.';

/** The schedule's ear and its timers, the test firing the timer. */
function source() {
  const timers: Array<{ f: () => void; done: boolean }> = [];
  const src: ScheduleSource = {
    active: () => true,
    onActive: () => () => undefined,
    timers: {
      set: (f) => {
        const t = { f, done: false };
        timers.push(t);
        return t;
      },
      clear: (h) => {
        (h as { done: boolean }).done = true;
      },
    },
  };
  return {
    src,
    fire(): void {
      const live = timers.filter((t) => !t.done);
      if (live.length !== 1) {
        throw new Error('live timers: ' + live.length);
      }
      live[0].done = true;
      live[0].f();
    },
  };
}

type Step = (k: CashuCard) => Promise<Payment[]>;

function make(payments: () => Payment[]) {
  const f = fakeStoreDeps();
  const mint = fakeMint();
  const steps: Step[] = [];
  const x = source();
  const service = createTillService({
    store: f.deps,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: mint.http,
    now: () => 1000,
    log: () => undefined,
    openLibrary: async (c) => {
      const k = await open(c);
      k.settle = async () => {
        const next = steps.shift();
        return next === undefined ? [] : next(k);
      };
      k.payments = async () => payments();
      return k;
    },
  });
  const wiring: AppWiring = {
    mode: 'development',
    service,
    gate: benchGate('allow'),
    reader: noReader(),
    report: () => undefined,
    devMintPreset: TEST_MINT,
    now: () => 1000,
    schedule: x.src,
  };
  return { service, steps, x, wiring };
}

let last: ReactTestRenderer | null = null;

async function firstRun(w: AppWiring): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<AppRoot wiring={w} />);
  });
  last = tree;
  await until(tree, 'firstrun-title');
  await press(tree, 'firstrun-dev-mint');
  await until(tree, 'addmint-title');
  await press(tree, 'addmint-check');
  await untilText(tree, 'addmint-result', 'This mint can be used.');
  await press(tree, 'addmint-add');
  await until(tree, 'home-title');
  return tree;
}

afterEach(async () => {
  const tree = last;
  if (tree !== null) {
    await act(async () => {
      tree.unmount();
    });
    last = null;
  }
});

describe('money owed to cards of a mint the till does not take', () => {
  it('is counted per mint, from what a tap could give back, in sats', () => {
    const owed = (mint: string, o: Partial<Payment>): Payment => ({ ...heldPayment('s1'), mint, ...o });
    expect(strandedOf([owed(TEST_MINT, { owedToCard: 50 })], [entry(TEST_MINT, 'ok')])).toEqual([]);
    expect(strandedOf([owed(TEST_MINT, { owedToCard: 50 })], [])).toEqual([{ mint: TEST_MINT, sats: 50, listed: false }]);
    expect(
      strandedOf(
        [owed(TEST_MINT, { owedToCard: 50 }), owed('https://MINT.test/', { owedToCard: 18, stuck: 5, unproved: 5 })],
        [],
      ),
    ).toEqual([{ mint: TEST_MINT, sats: 63, listed: false }]);
    expect(strandedOf([owed(OTHER, { owedToCard: 7 })], [entry(TEST_MINT, 'ok'), entry(OTHER, 'refused')])).toEqual([
      { mint: OTHER, sats: 7, listed: true },
    ]);
    expect(strandedOf([owed(TEST_MINT, { owedToCard: 5, stuck: 5, unproved: 5 })], [])).toEqual([]);
    expect(strandedOf([owed(TEST_MINT, { owedToCard: 5, unit: 'usd' })], [])).toEqual([]);
    expect(strandedOf([owed(TEST_MINT, { owedToCard: 0 })], [])).toEqual([]);
  });

  it('is said plainly, with the host, the amount and what to do', () => {
    expect(strandedWords({ mint: TEST_MINT, sats: 50, listed: false })).toBe(OFF_50);
    expect(strandedWords({ mint: OTHER, sats: 7, listed: true })).toBe(LISTED_7);
    for (const s of [OFF_50, LISTED_7, noticesMoreWords(1), noticesMoreWords(2)]) {
      expect(s).not.toContain('—');
      expect(s).not.toContain('–');
      expect(s).not.toMatch(/crypto|paid back/i);
    }
  });

  it('Home shows each line, with no Seen of its own', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<TillNotices mints={[]} note={null} onOpenOwed={() => undefined} owed={[OFF_50, LISTED_7]} />);
    });
    expect(textOf(tree, 'home-owed-0')).toBe(OFF_50);
    expect(textOf(tree, 'home-owed-1')).toBe(LISTED_7);
    expect(has(tree, 'home-notice-ok')).toBe(false);
    await act(async () => {
      tree.unmount();
    });
  });

  it('a mint removed while a payment of it may never finish: when it finishes, Home says the card is owed, until it is given back', async () => {
    let pays: Payment[] = [];
    const t = make(() => pays);
    const tree = await firstRun(t.wiring);
    expect(has(tree, 'home-owed-0')).toBe(false);
    // the mint gave nothing back for what the card paid: NOT PAID YET, the library asks it again at each settle
    pays = [{ ...heldPayment('s1'), state: 'spent-not-restored' }];
    await press(tree, 'home-settings');
    await until(tree, 'settings-title');
    await press(tree, 'settings-mints');
    await until(tree, 'mints-title');
    await press(tree, 'mint-remove-0');
    await untilText(tree, 'mint-remove-risk-0', MINTS_WORDS.late);
    await press(tree, 'mint-remove-yes');
    await until(tree, 'mints-empty');
    await press(tree, 'nav-back');
    await until(tree, 'settings-title');
    await press(tree, 'nav-back');
    await until(tree, 'home-title');
    expect(has(tree, 'home-owed-0')).toBe(false);
    // a later settle has the mint give it back: the payment is paid, and its card is owed its change
    pays = [{ ...heldPayment('s1'), owedToCard: 50 }];
    t.steps.push(async () => [{ ...heldPayment('s1'), owedToCard: 50 }]);
    t.x.fire();
    await untilText(tree, 'home-owed-0', OFF_50);
    expect(has(tree, 'home-notice-ok')).toBe(false);
    await press(tree, 'home-owed-open');
    await until(tree, 'owed-title');
    await press(tree, 'home-sale');
    await until(tree, 'home-title');
    // still owed: a settle that changes nothing leaves the line
    t.x.fire();
    await flush();
    expect(textOf(tree, 'home-owed-0')).toBe(OFF_50);
    // given back on the card return tap: the line goes
    pays = [{ ...heldPayment('s1'), state: 'delivered', givenBack: 50 }];
    t.x.fire();
    await flush();
    await flush();
    expect(has(tree, 'home-owed-0')).toBe(false);
  });

  it('is read from the record at launch, before any settle tells anything', async () => {
    const t = make(() => [{ ...heldPayment('s9'), mint: OTHER, owedToCard: 7 }]);
    const tree = await firstRun(t.wiring);
    await untilText(tree, 'home-owed-0', OFF_7);
    expect(has(tree, 'home-notice-0')).toBe(false);
  });
});

describe('the notices on Home', () => {
  it('are shown ten at a time, oldest first, saying how many wait; Seen drops only those shown', async () => {
    const t = make(() => []);
    const tree = await firstRun(t.wiring);
    t.steps.push(async () =>
      Array.from({ length: 12 }, (_, i) => ({
        ...heldPayment('s' + i),
        paymentId: 'pay:' + i,
        state: 'gone' as const,
        amount: i + 1,
      })),
    );
    t.x.fire();
    await until(tree, 'home-notice-9');
    expect(textOf(tree, 'home-notice-0').startsWith('1 sat · LOST.')).toBe(true);
    expect(textOf(tree, 'home-notice-9').startsWith('10 sats · LOST.')).toBe(true);
    expect(has(tree, 'home-notice-10')).toBe(false);
    expect(textOf(tree, 'home-notice-more')).toBe('2 more notices wait after these. Press Seen to see them.');
    await press(tree, 'home-notice-ok');
    await flush();
    expect(textOf(tree, 'home-notice-0').startsWith('11 sats · LOST.')).toBe(true);
    expect(textOf(tree, 'home-notice-1').startsWith('12 sats · LOST.')).toBe(true);
    expect(has(tree, 'home-notice-2')).toBe(false);
    expect(has(tree, 'home-notice-more')).toBe(false);
    await press(tree, 'home-notice-ok');
    await flush();
    expect(has(tree, 'home-notice-0')).toBe(false);
    expect(allText(tree).join(' ')).not.toContain('LOST');
  });
});
