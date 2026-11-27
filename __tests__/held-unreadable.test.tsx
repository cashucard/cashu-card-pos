/* A payment held because its sale's record does not read (cashucard 0.3.0: why `sale-unreadable`, slice 2.3b). The
 * library never delivers it, marks it extra or makes it back until the row reads again, and then it goes on by itself.
 * The Activity lists it as not finished, with words of its own, and still counts it in the takings; Home says how
 * many there are, from the record. */

jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/__mocks__/BackHandler'),
);

import { open, type Payment } from 'cashucard';
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { activityView, isDone, isTakings, isUnfinished } from '../src/app/activity';
import { AppRoot } from '../src/app/AppRoot';
import type { AppWiring } from '../src/app/wiring';
import { TillNotices } from '../src/screens/HomeScreen';
import { benchGate } from '../src/till/guarded';
import { heldUnreadable, heldUnreadableWords, isPaid, paymentWords, SALE_UNREADABLE } from '../src/till/payment-words';
import { noReader } from '../src/till/reader';
import { createTillService } from '../src/till/service';
import type { ScheduleSource } from '../src/till/settle';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';
import { heldPayment } from './helpers/fake-till';
import { has, press, textOf, until, untilText } from './helpers/render';

const waiting = (id: string): Payment => ({ ...heldPayment(id), paymentId: 'pay:' + id, why: SALE_UNREADABLE });

describe("a payment held because its sale's record does not read", () => {
  it('has words of its own, is not finished, and still counts in the takings', () => {
    const p = waiting('s1');
    expect(SALE_UNREADABLE).toBe('sale-unreadable');
    expect(paymentWords(p).headline).toBe("PAID, HELD: ITS SALE'S RECORD DOES NOT READ");
    expect(paymentWords(p).sentence).toBe(
      "The payment is confirmed, but this sale's record cannot be read on this phone, so the money waits in the record and is not kept in the wallet yet. It goes on by itself once the record reads. Records says more.",
    );
    expect(isPaid(p)).toBe(true);
    expect(isDone(p)).toBe(false);
    expect(isUnfinished(p)).toBe(true);
    expect(isTakings(p)).toBe(true);
    const v = activityView(
      { payments: [p, { ...heldPayment('s2'), paymentId: 'pay:s2' }], claims: [], older: [], damaged: [], twice: [], ms: 0 },
      1,
      p.at,
    );
    expect(v.unfinished.map((x) => x.paymentId)).toEqual(['pay:s1']);
    expect(v.done.map((x) => x.paymentId)).toEqual(['pay:s2']);
    expect(v.all.count).toBe(2);
  });

  it('Home says how many there are, plainly', async () => {
    expect(heldUnreadable([waiting('s1'), { ...heldPayment('s2'), paymentId: 'pay:s2' }])).toBe(1);
    expect(heldUnreadable([{ ...waiting('s3'), extra: 'late' }])).toBe(0);
    expect(heldUnreadableWords(1)).toBe(
      "1 payment is held: its sale's record cannot be read on this phone. Nothing is lost. Records says more.",
    );
    expect(heldUnreadableWords(2)).toBe(
      "2 payments are held: their sales' records cannot be read on this phone. Nothing is lost. Records says more.",
    );
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<TillNotices mints={[]} note={null} onOpenOwed={() => undefined} unreadable={2} />);
    });
    expect(textOf(tree, 'home-unreadable')).toBe(heldUnreadableWords(2));
    await act(async () => {
      tree.update(<TillNotices mints={[]} note={null} onOpenOwed={() => undefined} unreadable={0} />);
    });
    expect(has(tree, 'home-unreadable')).toBe(false);
    await act(async () => {
      tree.unmount();
    });
  });

  it("Home's line comes from the record", async () => {
    const f = fakeStoreDeps();
    const mint = fakeMint();
    const src: ScheduleSource = {
      active: () => true,
      onActive: () => () => undefined,
      timers: { set: () => ({}), clear: () => undefined },
    };
    const service = createTillService({
      store: f.deps,
      names: TILL_NAMES,
      settingsNames: TILL_SETTINGS,
      http: mint.http,
      now: () => 1000,
      log: () => undefined,
      openLibrary: async (c) => {
        const k = await open(c);
        k.payments = async () => [waiting('s1')];
        return k;
      },
    });
    const w: AppWiring = {
      mode: 'development',
      service,
      gate: benchGate('allow'),
      reader: noReader(),
      report: () => undefined,
      devMintPreset: 'https://mint.test',
      now: () => 1000,
      schedule: src,
    };
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<AppRoot wiring={w} />);
    });
    await until(tree, 'firstrun-title');
    await press(tree, 'firstrun-dev-mint');
    await until(tree, 'addmint-title');
    await press(tree, 'addmint-check');
    await untilText(tree, 'addmint-result', 'This mint can be used.');
    await press(tree, 'addmint-add');
    await until(tree, 'home-title');
    await untilText(tree, 'home-unreadable', heldUnreadableWords(1));
    await act(async () => {
      tree.unmount();
    });
  });
});
