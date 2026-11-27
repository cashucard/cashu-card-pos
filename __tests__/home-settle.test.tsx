import React from 'react';
import { Text } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { HOME_WORDS, TillNotices, type HomeProps } from '../src/screens/HomeScreen';
import { noticeOf } from '../src/till/settle';
import type { MintEntry } from '../src/till/settings';
import { heldPayment } from './helpers/fake-till';
import { allText, has, nodes, press, textOf } from './helpers/render';

/** A mint that is taking cards. */
const OK: MintEntry = {
  url: 'https://mint.test',
  addedAt: 1,
  checkedAt: 1,
  keysets: ['00'],
  status: 'ok',
  why: null,
};

/** Every tree this file makes, for the words check at the end. */
const created: ReactTestRenderer[] = [];

function render(props: Partial<HomeProps>): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(<TillNotices mints={[OK]} note={null} onOpenOwed={jest.fn()} {...props} />);
  });
  created.push(tree);
  return tree;
}

/** the words a button shows, joined into one string */
function shownOf(tree: ReactTestRenderer, id: string): string {
  const found = nodes(tree, id);
  if (found.length === 0) {
    throw new Error('no node ' + id);
  }
  const parts: string[] = [];
  for (const n of found[0].findAll((x) => x.type === Text)) {
    if (typeof n.props.children === 'string') {
      parts.push(n.props.children);
    }
  }
  return parts.join('');
}

it('the kept line is shown only above nothing', () => {
  expect(textOf(render({ kept: 2100 }), 'home-kept')).toBe('Kept in this phone: 2,100 sats');
  const none: Array<Partial<HomeProps>> = [{ kept: 0 }, { kept: null }, {}];
  for (const props of none) {
    expect(has(render(props), 'home-kept')).toBe(false);
  }
});

it('each notice is told on its own line until it is seen', async () => {
  const onNoticesSeen = jest.fn();
  const tree = render({ notices: ['a.', 'b.'], onNoticesSeen });
  expect(textOf(tree, 'home-notice-0')).toBe('a.');
  expect(textOf(tree, 'home-notice-1')).toBe('b.');
  expect(shownOf(tree, 'home-notice-ok')).toBe('Seen');
  await press(tree, 'home-notice-ok');
  expect(onNoticesSeen).toHaveBeenCalledTimes(1);

  const empty: Array<Partial<HomeProps>> = [{ notices: [] }, {}];
  for (const props of empty) {
    const noNotices = render(props);
    expect(has(noNotices, 'home-notice-0')).toBe(false);
    expect(has(noNotices, 'home-notice-ok')).toBe(false);
  }
});

it('a settle that failed is told', () => {
  expect(textOf(render({ settleNote: 'x.' }), 'home-settle')).toBe('x.');
  expect(has(render({ settleNote: null }), 'home-settle')).toBe(false);
});

it('a sale left as CHECKING or NOT PAID YET that is now paid is told plainly, with its amount and time', async () => {
  const at = new Date(2026, 10, 22, 4, 10).getTime();
  const W =
    "14 sats · PAID. Paid and kept in this phone's wallet. The payment of 22 Nov 2026, 04:10 was not finished when its sale ended. It is paid now. If the customer paid that sale another way too, it is paid twice.";
  const befores = ['taking', 'spent-not-restored'] as const;
  for (const b of befores) {
    const n = noticeOf(b, { ...heldPayment('s1'), state: 'delivered', at });
    expect(n).toBe(W);
    const onNoticesSeen = jest.fn();
    const tree = render({ notices: [n as string], onNoticesSeen });
    expect(textOf(tree, 'home-notice-0')).toBe(W);
    expect(has(tree, 'home-notice-ok')).toBe(true);
    await press(tree, 'home-notice-ok');
    expect(onNoticesSeen).toHaveBeenCalledTimes(1);
  }
});

it('keeps the healthy keypad quiet and explains a till that needs a mint', () => {
  const tree = render({});
  expect(has(tree, 'home-status')).toBe(false);
  expect(textOf(render({ mints: [] }), 'home-status')).toBe('No mint yet. Add one in Settings.');
  const added = ['home-kept', 'home-settle', 'home-notice-0', 'home-notice-ok'];
  for (const id of added) {
    expect(has(tree, id)).toBe(false);
  }
});

it('the money words are plain', () => {
  expect(created.length).toBeGreaterThan(0);
  expect(HOME_WORDS.seen).toBe('Seen');
  for (const tree of created) {
    for (const s of allText(tree)) {
      expect(s).not.toContain('—');
      expect(s).not.toContain('–');
      expect(s).not.toMatch(/crypto|paid back/i);
      expect(s).not.toBe('Settled');
    }
  }
});
