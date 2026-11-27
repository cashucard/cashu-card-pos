/* Money owed to a card, then written to it at a paying tap (the simulator run of slice 1.3): the notice that said it was
 * owed is never left saying "not written yet", and the merchant is told once that it went back, from the record, across
 * a relaunch too. And how notices, the kept line and a waiting opening read. */

jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/__mocks__/BackHandler'),
);

import { open, type CashuCard, type CardListener, type CardTransport, type Payment } from 'cashucard';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { TYPE } from '../src/ui/theme';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AppRoot } from '../src/app/AppRoot';
import type { AppWiring } from '../src/app/wiring';
import { TillNotices } from '../src/screens/HomeScreen';
import { OpeningPanel } from '../src/screens/SalePanels';
import { benchGate } from '../src/till/guarded';
import { createTillQueue } from '../src/till/queue';
import { createTillService } from '../src/till/service';
import {
  createSettler,
  eventBook,
  noticeLead,
  noticeToneOf,
  nowPaidWords,
  writtenWords,
  type NoticeBook,
  type NoticeRow,
  type ScheduleSource,
} from '../src/till/settle';
import { TILL_SETTINGS } from '../src/till/settings';
import type { TillEvent, TillEventKind } from '../src/till/store/events';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint, type FakeMint } from './helpers/fake-mint';
import { fakeStoreDeps, type FakeStore } from './helpers/fake-store';
import { fakeTransport, heldPayment } from './helpers/fake-till';
import { allText, flush, has, nodes, press, textOf, until, untilText } from './helpers/render';

const OWED13 =
  '13 sats · OWED TO THE CARD. It is written back to the card at its next tap, with the PIN. Owed to the card, not written yet: 13 sats.';
const WRITTEN13 =
  "13 sats · WRITTEN TO THE CARD. The customer's money was written to the card. The till counts it as the card's once the mint shows the card has used it. Written to the card, not confirmed yet: 13 sats.";

/** The withdrawn sale's payment made back for its card: 13 sats owed to the card. */
const owed13: Payment = { ...heldPayment('s1'), paymentId: 'pay:13', state: 'returned', extra: 'late', owedToCard: 13 };
/** The same payment once the card's next paying tap wrote the 13 sats onto it (the card has not spent them yet). */
const written13: Payment = { ...owed13, owedToCard: 0, givenBack: 13, unconfirmed: 13 };

async function flushAll(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

/** The till's events in memory, as TillEvents keeps them. */
function memoryEvents() {
  const list: TillEvent[] = [];
  return {
    list: async (): Promise<TillEvent[]> => list.slice(),
    add: async (kind: TillEventKind, detail: string): Promise<void> => {
      list.push({ seq: list.length + 1, at: 1, kind, detail });
    },
    all: list,
  };
}

/** A settler over one queue: the library's settle answers the next of `changed` ([] when none), its payments() the
 * record as `record()` holds it now. */
function settlerOver(book: NoticeBook | null, record: () => Payment[], changed: Payment[][]) {
  const queue = createTillQueue();
  const card = {
    settle: async (): Promise<Payment[]> => changed.shift() ?? [],
    payments: async (): Promise<Payment[]> => record(),
  } as unknown as CashuCard;
  return createSettler({
    job: (f) => queue.run('settle', () => f(card)),
    wait: async () => undefined,
    now: () => 1,
    book: book === null ? undefined : () => book,
  });
}

describe('a notice of money owed to a card, once a tap wrote it', () => {
  it('not seen yet: it is made again from the record, in its place, and nothing more is told', async () => {
    const rows: NoticeRow[] = [];
    const book: NoticeBook = {
      load: async () => ({ unseen: [], told: [] }),
      told: async (n) => {
        rows.push({ ...n });
      },
      seen: async () => undefined,
    };
    let rec: Payment[] = [];
    const s = settlerOver(book, () => rec, [[owed13]]);
    await s.settle('asked');
    expect(s.shown()).toEqual([{ words: OWED13, tone: 'normal' }]);
    // the card's next paying tap wrote it; the settle after that card job reports nothing changed
    rec = [written13];
    await s.settle('after-card');
    expect(s.shown()).toEqual([{ words: WRITTEN13, tone: 'normal' }]);
    expect(s.notices().map((n) => n.paymentId)).toEqual(['pay:13']);
    expect(rows.map((r) => [r.key, r.owed, r.words])).toEqual([
      ['pay:13|returned|late', 13, OWED13],
      ['pay:13|returned|late', 0, WRITTEN13],
    ]);
    await s.settle('timer');
    expect(s.shown()).toEqual([{ words: WRITTEN13, tone: 'normal' }]);
    expect(rows.length).toBe(2);
    expect(allWords(s.shown())).not.toContain('not written yet');
  });

  it('seen already: that it was written is told once, as its own notice', async () => {
    let rec: Payment[] = [];
    const s = settlerOver(null, () => rec, [[owed13]]);
    await s.settle('asked');
    s.seen();
    rec = [written13];
    await s.settle('after-card');
    expect(s.shown()).toEqual([{ words: WRITTEN13, tone: 'normal' }]);
    s.seen();
    await s.settle('timer');
    await s.settle('timer');
    expect(s.shown()).toEqual([]);
  });

  it('part written, then the rest: one notice that says all that was written', async () => {
    let rec: Payment[] = [];
    const s = settlerOver(null, () => rec, [[owed13]]);
    await s.settle('asked');
    s.seen();
    rec = [{ ...owed13, owedToCard: 5, givenBack: 8, unconfirmed: 8 }];
    await s.settle('after-card');
    expect(s.shown()).toEqual([
      {
        words:
          "8 sats · WRITTEN TO THE CARD. Part of the customer's money was written to the card. Still owed to the card, not written yet: 5 sats.",
        tone: 'normal',
      },
    ]);
    rec = [written13];
    await s.settle('after-card');
    expect(s.shown()).toEqual([{ words: WRITTEN13, tone: 'normal' }]);
  });

  it('a payment paid now with change owed keeps its warning once the change is written', async () => {
    const paid: Payment = { ...heldPayment('s1'), state: 'delivered', owedToCard: 50 };
    let rec: Payment[] = [{ ...paid, state: 'taking', owedToCard: 0 }];
    const s = settlerOver(null, () => rec, [[paid]]);
    await s.settle('asked');
    const told = s.shown();
    expect(told.length).toBe(1);
    expect(told[0].tone).toBe('bad');
    expect(told[0].words).toContain('Owed to the card, not written yet: 50 sats.');
    rec = [{ ...paid, owedToCard: 0, givenBack: 50, unconfirmed: 50 }];
    await s.settle('after-card');
    expect(s.shown()).toEqual([
      {
        words:
          "14 sats · PAID. Paid and kept in this phone's wallet. Written to the card, not confirmed yet: 50 sats. " +
          nowPaidWords(0),
        tone: 'bad',
      },
    ]);
  });

  it('kept across a launch: the next launch makes it again from the record and tells nothing twice', async () => {
    const ev = memoryEvents();
    let rec: Payment[] = [];
    const first = settlerOver(eventBook(ev), () => rec, [[owed13]]);
    await first.settle('asked');
    expect(first.shown()).toEqual([{ words: OWED13, tone: 'normal' }]);
    // the app is killed; the card's next paying tap is made in the next launch, before its settle
    rec = [written13];
    const next = settlerOver(eventBook(ev), () => rec, []);
    await next.settle('launch');
    expect(next.shown()).toEqual([{ words: WRITTEN13, tone: 'normal' }]);
    next.seen();
    await flushAll();
    const third = settlerOver(eventBook(ev), () => rec, []);
    await third.settle('launch');
    expect(third.shown()).toEqual([]);
    expect(JSON.stringify(ev.all)).not.toContain('cashu');
  });

  it('a later launch that sees the money written tells it once, even when the first notice was seen', async () => {
    const ev = memoryEvents();
    let rec: Payment[] = [];
    const first = settlerOver(eventBook(ev), () => rec, [[owed13]]);
    await first.settle('asked');
    first.seen();
    await flushAll();
    rec = [written13];
    const next = settlerOver(eventBook(ev), () => rec, []);
    await next.settle('launch');
    expect(next.shown()).toEqual([{ words: WRITTEN13, tone: 'normal' }]);
    const third = settlerOver(eventBook(ev), () => rec, []);
    await third.settle('launch');
    expect(third.shown()).toEqual([{ words: WRITTEN13, tone: 'normal' }]);
    third.seen();
    await flushAll();
    const fourth = settlerOver(eventBook(ev), () => rec, []);
    await fourth.settle('launch');
    expect(fourth.shown()).toEqual([]);
  });
});

function allWords(shown: Array<{ words: string }>): string {
  return shown.map((n) => n.words).join(' ');
}

describe('how a notice reads', () => {
  it('leads with the sum it is about', () => {
    expect(noticeLead(owed13)).toBe(13);
    expect(noticeLead(written13)).toBe(13);
    expect(noticeLead({ ...written13, givenBack: 0, unconfirmed: 0 })).toBe(14);
    expect(noticeLead({ ...heldPayment('s1'), owedToCard: 50 })).toBe(14);
    expect(writtenWords(50, { ...heldPayment('s1'), state: 'delivered', givenBack: 50 })).toBe(
      '50 sats · WRITTEN TO THE CARD. The change owed to the card was written to it.',
    );
    expect(writtenWords(13, written13)).toBe(WRITTEN13);
  });

  it('is bad for a risk or a loss, and normal otherwise; never good', () => {
    const p = (o: Partial<Payment>): Payment => ({ ...heldPayment('s1'), ...o });
    expect(noticeToneOf('taking', p({ state: 'gone' }))).toBe('bad');
    expect(noticeToneOf('taking', p({ state: 'lost' }))).toBe('bad');
    expect(noticeToneOf('taking', p({ state: 'spent-not-restored' }))).toBe('bad');
    expect(noticeToneOf('held', p({ state: 'held', extra: 'paid-twice' }))).toBe('bad');
    expect(noticeToneOf('taking', p({ state: 'held', extra: 'late' }))).toBe('bad');
    expect(noticeToneOf('taking', p({ state: 'held', extra: 'late', why: 'date-too-near' }))).toBe('normal');
    expect(noticeToneOf('taking', p({ state: 'delivered' }))).toBe('bad');
    expect(noticeToneOf('spent-not-restored', p({ state: 'held' }))).toBe('bad');
    expect(noticeToneOf('held', p({ state: 'delivered' }))).toBe('normal');
    expect(noticeToneOf('returning', p({ state: 'returned', extra: 'late', owedToCard: 13 }))).toBe('normal');
  });

  it("Home shows each notice in its tone and keeps the previous takings secondary to the new sale", async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <TillNotices
          mints={[]}
          note={null}
          onOpenOwed={() => undefined}
          kept={2100}
          notices={['a.', 'b.']}
          noticeTones={['bad', 'normal']}
        />,
      );
    });
    expect(nodes(tree, 'home-notice-0')[0].props.tone).toBe('bad');
    expect(nodes(tree, 'home-notice-1')[0].props.tone).toBe('normal');
    expect(textOf(tree, 'home-kept')).toBe('Kept in this phone: 2,100 sats');
    expect(nodes(tree, 'home-kept')[0].props.tone).toBe('muted');
    await act(async () => {
      tree.unmount();
    });
    await act(async () => {
      tree = renderer.create(<TillNotices mints={[]} note={null} onOpenOwed={() => undefined} notices={['a.']} />);
    });
    expect(nodes(tree, 'home-notice-0')[0].props.tone).toBe('normal');
    await act(async () => {
      tree.unmount();
    });
  });

  it('an opening shows its amount, also while it waits behind a settle', async () => {
    for (const queued of [true, false]) {
      let tree!: ReactTestRenderer;
      await act(async () => {
        tree = renderer.create(<OpeningPanel sats={2100} queued={queued} send={() => undefined} />);
      });
      expect(textOf(tree, 'opening-amount')).toBe('2,100 sats');
      const amount = tree.root.findAllByType(Text).find(node => node.props.testID === 'opening-amount')!;
      expect(StyleSheet.flatten(amount.props.style).fontSize).toBeGreaterThan(TYPE.body);
      expect(has(tree, 'opening-cancel')).toBe(true);
      await act(async () => {
        tree.unmount();
      });
    }
  });
});

// ------------------------------------------------------------------------------------------- the whole app

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
type Script = (t: CardTransport, l: CardListener, id: string) => Promise<Payment>;

/** The whole app over the store `f`: the real library, its settle answering `steps`, its payments() `record()`, and
 * each sale's card the next of `scripts`. */
function make(f: FakeStore, mint: FakeMint, record: () => Payment[]) {
  const steps: Step[] = [];
  const scripts: Script[] = [];
  const x = source();
  const service = createTillService({
    store: f.deps,
    names: TILL_NAMES,
    settingsNames: TILL_SETTINGS,
    http: mint.http,
    now: () => 1000,
    random: () => 0.25,
    log: () => undefined,
    openLibrary: async (c) => {
      const k = await open(c);
      k.settle = async () => {
        const next = steps.shift();
        return next === undefined ? [] : next(k);
      };
      k.payments = async () => record();
      const realSale = k.sale.bind(k);
      k.sale = async (id) => {
        const s = await realSale(id);
        s.card = async (t, l) => {
          const next = scripts.shift();
          if (next === undefined) {
            throw new Error('no card script left');
          }
          return next(t, l, id);
        };
        return s;
      };
      return k;
    },
  });
  const wiring: AppWiring = {
    mode: 'development',
    service,
    gate: benchGate('allow'),
    reader: { kind: 'card simulator', available: async () => true, transport: () => fakeTransport() },
    report: () => undefined,
    devMintPreset: 'https://mint.test',
    now: () => 1000,
    schedule: x.src,
  };
  return { service, steps, scripts, x, wiring };
}

let last: ReactTestRenderer | null = null;

async function mount(w: AppWiring): Promise<ReactTestRenderer> {
  const was = last;
  if (was !== null) {
    await act(async () => {
      was.unmount();
    });
  }
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<AppRoot wiring={w} />);
  });
  last = tree;
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

it('owed to the card, then written at its next paying tap: Home says it went back, once, across a relaunch', async () => {
  const f = fakeStoreDeps();
  const mint = fakeMint();
  let rec: Payment[] = [];
  const t = make(f, mint, () => rec);
  const tree = await mount(t.wiring);
  await until(tree, 'firstrun-title');
  await press(tree, 'firstrun-dev-mint');
  await until(tree, 'addmint-title');
  await press(tree, 'addmint-check');
  await untilText(tree, 'addmint-result', 'This mint can be used.');
  await press(tree, 'addmint-add');
  await until(tree, 'home-title');
  // the withdrawn sale's payment is made back for its card: 13 sats owed to it
  rec = [owed13];
  t.steps.push(async () => [owed13]);
  t.x.fire();
  await untilText(tree, 'home-notice-0', OWED13);
  // the card pays a new sale; that tap writes the 13 sats onto it (the library's giveBackOthers, in the card job)
  t.scripts.push(async (tr, _l, id) => {
    await tr.begin?.('1');
    rec = [written13];
    return { ...heldPayment(id), paymentId: 'pay:20' };
  });
  await press(tree, 'home-sale');
  await press(tree, 'key-1');
  await press(tree, 'key-4');
  await press(tree, 'sale-charge');
  await untilText(tree, 'result-title', 'PAID');
  await flush();
  await press(tree, 'result-new');
  await untilText(tree, 'home-notice-0', WRITTEN13);
  expect(has(tree, 'home-notice-1')).toBe(false);
  expect(allText(tree).join(' ')).not.toContain('not written yet');

  // a relaunch over the same store: the notice is told again until Seen, as it now reads
  const u = make(f, mint, () => rec);
  const again = await mount(u.wiring);
  await until(again, 'home-title');
  await untilText(again, 'home-notice-0', WRITTEN13);
  expect(has(again, 'home-notice-1')).toBe(false);
  await press(again, 'home-notice-ok');
  await flush();
  expect(has(again, 'home-notice-0')).toBe(false);

  const v = make(f, mint, () => rec);
  const third = await mount(v.wiring);
  await until(third, 'home-title');
  await flush();
  await flush();
  expect(has(third, 'home-notice-0')).toBe(false);
});

it('Home shows a loss in the bad tone, and money owed to a card in the plain one', async () => {
  const f = fakeStoreDeps();
  const mint = fakeMint();
  let rec: Payment[] = [];
  const t = make(f, mint, () => rec);
  const tree = await mount(t.wiring);
  await until(tree, 'firstrun-title');
  await press(tree, 'firstrun-dev-mint');
  await until(tree, 'addmint-title');
  await press(tree, 'addmint-check');
  await untilText(tree, 'addmint-result', 'This mint can be used.');
  await press(tree, 'addmint-add');
  await until(tree, 'home-title');
  rec = [owed13];
  t.steps.push(async () => [{ ...heldPayment('s9'), paymentId: 'pay:30', state: 'gone' }, owed13]);
  t.x.fire();
  await untilText(tree, 'home-notice-1', OWED13);
  expect(textOf(tree, 'home-notice-0').startsWith('14 sats · LOST.')).toBe(true);
  expect(nodes(tree, 'home-notice-0')[0].props.tone).toBe('bad');
  expect(nodes(tree, 'home-notice-1')[0].props.tone).toBe('normal');
});
