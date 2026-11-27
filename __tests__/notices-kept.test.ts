/* Notices kept across launches (review of slice 1.3, F2 and F6): each is written before it is shown, read back at the
 * next launch until Seen is pressed, never told twice, never dropped, and Seen drops only those shown. */

import { open, type CashuCard, type Payment } from 'cashucard';
import { createTillQueue } from '../src/till/queue';
import { createTillService } from '../src/till/service';
import { createSettler, eventBook, nowPaidWords, type NoticeBook, type NoticeRow } from '../src/till/settle';
import { TILL_SETTINGS } from '../src/till/settings';
import type { TillEvent, TillEventKind } from '../src/till/store/events';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint, type FakeMint } from './helpers/fake-mint';
import { fakeStoreDeps, type FakeStore } from './helpers/fake-store';
import { heldPayment } from './helpers/fake-till';

type Step = (k: CashuCard) => Promise<Payment[]>;

/** The till service over the store `f`, with the library's settle answering the next of `steps` and its payments()
 * answering `payments()`. */
function make(f: FakeStore, mint: FakeMint, steps: Step[], payments: () => Payment[]) {
  return createTillService({
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
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

const WORDS = "14 sats · PAID. Paid and kept in this phone's wallet. " + nowPaidWords(0);
const paidNow: Step = async () => [{ ...heldPayment('s1'), state: 'delivered' }];

/** A settler over one queue whose library's settle answers `changed`, with `book` as its book. */
function settlerWith(book: NoticeBook, changed: Payment[][]) {
  const queue = createTillQueue();
  const card = {
    settle: async (): Promise<Payment[]> => changed.shift() ?? [],
    payments: async (): Promise<Payment[]> => [],
  } as unknown as CashuCard;
  return createSettler({
    job: (f) => queue.run('settle', () => f(card)),
    wait: async () => undefined,
    now: () => 1,
    book: () => book,
  });
}

const gone = (id: string): Payment => ({ ...heldPayment('s1'), paymentId: id, state: 'gone' });

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

describe('notices kept across launches', () => {
  it('a notice not seen is told again at the next launch, until Seen is pressed', async () => {
    const f = fakeStoreDeps();
    const mint = fakeMint();
    let pays: Payment[] = [{ ...heldPayment('s1'), state: 'taking' }];
    const t = make(f, mint, [paidNow], () => pays);
    await t.open();
    await t.addMint(await t.checkMint('mint.test'));
    await t.settleNow('asked');
    expect(t.notices()).toEqual([{ paymentId: 'pay:00', words: WORDS }]);

    // the app is killed before Seen: the next launch, over the same store
    pays = [{ ...heldPayment('s1'), state: 'delivered' }];
    const u = make(f, mint, [], () => pays);
    expect((await u.open()).kind).toBe('ready');
    expect(u.notices()).toEqual([]);
    await u.settleNow('launch');
    expect(u.notices()).toEqual([{ paymentId: 'pay:00', words: WORDS }]);
    u.noticesSeen(1);
    expect(u.notices()).toEqual([]);
    await flush();

    const v = make(f, mint, [], () => pays);
    expect((await v.open()).kind).toBe('ready');
    await v.settleNow('launch');
    expect(v.notices()).toEqual([]);
  });

  it('a notice told is not told again at a later launch', async () => {
    const f = fakeStoreDeps();
    const mint = fakeMint();
    const pays: Payment[] = [{ ...heldPayment('s1'), state: 'taking' }];
    const t = make(f, mint, [paidNow], () => pays);
    await t.open();
    await t.addMint(await t.checkMint('mint.test'));
    await t.settleNow('asked');
    t.noticesSeen();
    await flush();

    // the record says the same change again: told once already, so nothing is told
    const u = make(f, mint, [paidNow], () => pays);
    expect((await u.open()).kind).toBe('ready');
    await u.settleNow('launch');
    expect(u.notices()).toEqual([]);
  });

  it('each notice is written before it is shown, and Seen writes only the keys shown', async () => {
    const rows: NoticeRow[] = [];
    const seen: string[][] = [];
    const book: NoticeBook = {
      load: async () => ({ unseen: [], told: [] }),
      told: async (n) => {
        rows.push(n);
      },
      seen: async (keys) => {
        seen.push(keys.slice());
      },
    };
    const s = settlerWith(book, [[gone('pay:1'), gone('pay:2')]]);
    await s.settle('asked');
    expect(rows.map((r) => r.key)).toEqual(['pay:1|gone|', 'pay:2|gone|']);
    expect(s.notices().map((n) => n.paymentId)).toEqual(['pay:1', 'pay:2']);
    s.seen(1);
    await flush();
    expect(seen).toEqual([['pay:1|gone|']]);
    expect(s.notices().map((n) => n.paymentId)).toEqual(['pay:2']);
    s.seen(0);
    await flush();
    expect(seen).toEqual([['pay:1|gone|']]);
  });

  it('notices an earlier launch kept come first, and none of the keys it told is told again', async () => {
    const rows: NoticeRow[] = [];
    const book: NoticeBook = {
      load: async () => ({
        unseen: [{ key: 'pay:9|gone|', paymentId: 'pay:9', words: 'old.' }],
        told: ['pay:9|gone|', 'pay:1|gone|'],
      }),
      told: async (n) => {
        rows.push(n);
      },
      seen: async () => undefined,
    };
    const s = settlerWith(book, [[gone('pay:1'), gone('pay:2')]]);
    await s.settle('asked');
    expect(s.notices().map((n) => n.paymentId)).toEqual(['pay:9', 'pay:2']);
    expect(rows.map((r) => r.key)).toEqual(['pay:2|gone|']);
  });

  it('the book in the events holds words and keys, never a token, and reads back only what is not seen', async () => {
    const ev = memoryEvents();
    const book = eventBook(ev);
    await book.told({ key: 'pay:1|gone|', paymentId: 'pay:1', words: 'a.' });
    await book.told({ key: 'pay:2|gone|', paymentId: 'pay:2', words: 'b.' });
    await book.told({ key: 'pay:1|gone|', paymentId: 'pay:1', words: 'a again.' });
    await ev.add('notice', 'not a notice');
    await book.seen(['pay:1|gone|']);
    expect(await book.load()).toEqual({
      unseen: [{ key: 'pay:2|gone|', paymentId: 'pay:2', words: 'b.' }],
      told: ['pay:1|gone|', 'pay:2|gone|'],
      owed: [],
    });
    expect(ev.all.map((e) => e.kind)).toEqual(['notice', 'notice', 'notice', 'notice', 'notice-seen']);
    const s = settlerWith(eventBook(ev), [[{ ...gone('pay:3'), change: 'cashuB' + 'x'.repeat(60) }]]);
    await s.settle('asked');
    expect(JSON.stringify(ev.all)).not.toContain('cashu');
  });
});
