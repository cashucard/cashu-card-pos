import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AddMintScreen } from '../src/screens/AddMintScreen';
import { CLOSED_WORDS, ClosedScreen, StoreProblemScreen } from '../src/screens/BootScreens';
import { FIRSTRUN_LOST, FIRSTRUN_USED, FirstRunScreen } from '../src/screens/FirstRunScreen';
import { MintsScreen, recheckWords } from '../src/screens/MintsScreen';
import { benchGate } from '../src/till/guarded';
import type { MintCheckReport } from '../src/till/mint-check';
import type { RecheckNote, TillService } from '../src/till/service';
import type { MintEntry } from '../src/till/settings';
import { storeMessage } from '../src/till/store/messages';
import { allText, has, press, textOf, until, untilText } from './helpers/render';

const A = 'https://mint.test';
const B = 'https://other.test';
const AT = new Date(2026, 10, 22, 4, 10).getTime();
const created: ReactTestRenderer[] = [];

function render(el: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(el);
  });
  created.push(tree);
  return tree;
}

function ok(url: string, checkedAt = 2): MintEntry {
  return { url, addedAt: 1, checkedAt, keysets: ['01' + 'ab'.repeat(32)], status: 'ok', why: null };
}

function refused(url: string, why: string): MintEntry {
  return { url, addedAt: 1, checkedAt: 3, keysets: [], status: 'refused', why };
}

type MintsService = Pick<TillService, 'mints' | 'removeMint' | 'recheckMints'>;

function mintsService(list: MintEntry[]): MintsService & { removeMint: jest.Mock; recheckMints: jest.Mock } {
  return {
    mints: jest.fn(() => list),
    removeMint: jest.fn(async () => undefined),
    recheckMints: jest.fn(async () => list),
  };
}

const GOOD: MintCheckReport = {
  url: A,
  ok: true,
  reached: true,
  lines: [
    'address', 'reach', 'nut07', 'nut09', 'nut11', 'nut12', 'keyset', 'fee', 'amounts', 'keys',
  ].map((id) => ({ id: id as MintCheckReport['lines'][number]['id'], ok: true, words: 'W.' })),
  keysets: ['01' + 'ab'.repeat(32)],
};

it('the Welcome tells a lost list of mints', () => {
  const tree = render(<FirstRunScreen preset={null} listLost onAdd={jest.fn()} />);
  expect(textOf(tree, 'firstrun-note')).toBe(FIRSTRUN_LOST);
  expect(FIRSTRUN_LOST).toBe(
    "The till's list of mints could not be read. Add your mints again. The payment record has not been changed.",
  );
  const plain = render(<FirstRunScreen preset={null} onAdd={jest.fn()} />);
  expect(has(plain, 'firstrun-note')).toBe(false);
  const notLost = render(<FirstRunScreen preset={null} listLost={false} onAdd={jest.fn()} />);
  expect(has(notLost, 'firstrun-note')).toBe(false);
});

it('the Welcome of a used till with no mint says so', () => {
  const tree = render(<FirstRunScreen preset={null} used onAdd={jest.fn()} />);
  expect(textOf(tree, 'firstrun-note')).toBe(FIRSTRUN_USED);
});

it('a lost list outranks the used-till note', () => {
  const tree = render(<FirstRunScreen preset={null} used listLost onAdd={jest.fn()} />);
  expect(textOf(tree, 'firstrun-note')).toBe(FIRSTRUN_LOST);
});

it('a first run shows no note', () => {
  const tree = render(<FirstRunScreen preset={null} used={false} listLost={false} onAdd={jest.fn()} />);
  expect(has(tree, 'firstrun-note')).toBe(false);
});

it('the Mints screen follows the list it is given', () => {
  const svc = mintsService([ok(A)]);
  const tree = render(
    <MintsScreen service={svc} gate={benchGate('allow')} mints={[ok(A)]} onAdd={jest.fn()} onBack={jest.fn()} />,
  );
  expect(textOf(tree, 'mint-status-0').startsWith('Taking cards from this mint.')).toBe(true);
  act(() => {
    tree.update(
      <MintsScreen
        service={svc}
        gate={benchGate('allow')}
        mints={[refused(A, 'Its fee is 5,000 ppk. This till takes at most 1,000.')]}
        onAdd={jest.fn()}
        onBack={jest.fn()}
      />,
    );
  });
  expect(textOf(tree, 'mint-status-0')).toBe(
    'Not taking cards from this mint: Its fee is 5,000 ppk. This till takes at most 1,000. Check it again once the mint has fixed it.',
  );
});

it('the removal warning stays on the mint it was opened for', async () => {
  const svc = mintsService([ok(A), ok(B)]);
  const tree = render(
    <MintsScreen service={svc} gate={benchGate('allow')} mints={[ok(A), ok(B)]} onAdd={jest.fn()} onBack={jest.fn()} />,
  );
  await press(tree, 'mint-remove-1');
  expect(textOf(tree, 'mint-remove-warning')).toBe(
    'Stop taking cards from https://other.test? Payments already taken from it stay in the record.',
  );
  act(() => {
    tree.update(
      <MintsScreen service={svc} gate={benchGate('allow')} mints={[ok(B)]} onAdd={jest.fn()} onBack={jest.fn()} />,
    );
  });
  expect(textOf(tree, 'mint-remove-warning')).toBe(
    'Stop taking cards from https://other.test? Payments already taken from it stay in the record.',
  );
  await press(tree, 'mint-remove-yes');
  await until(tree, 'mints-title');
  await act(async () => {
    await new Promise<void>((r) => {
      setTimeout(() => r(), 0);
    });
  });
  expect(svc.removeMint).toHaveBeenCalledTimes(1);
  expect(svc.removeMint).toHaveBeenCalledWith(B);
});

it("a removal's owner check is told, passed or refused", async () => {
  const svc = mintsService([ok(A)]);
  const onGate = jest.fn();
  const tree = render(
    <MintsScreen service={svc} gate={benchGate('allow')} onGate={onGate} onAdd={jest.fn()} onBack={jest.fn()} />,
  );
  await press(tree, 'mint-remove-0');
  await press(tree, 'mint-remove-yes');
  await until(tree, 'mints-title');
  await act(async () => {
    await new Promise<void>((r) => {
      setTimeout(() => r(), 0);
    });
  });
  expect(onGate).toHaveBeenCalledTimes(1);
  expect(onGate).toHaveBeenCalledWith('passed');
  expect(svc.removeMint).toHaveBeenCalledTimes(1);
  expect(svc.removeMint).toHaveBeenCalledWith(A);

  const denied = mintsService([ok(A)]);
  const onGateDenied = jest.fn();
  const refusedTree = render(
    <MintsScreen service={denied} gate={benchGate('deny')} onGate={onGateDenied} onAdd={jest.fn()} onBack={jest.fn()} />,
  );
  await press(refusedTree, 'mint-remove-0');
  await press(refusedTree, 'mint-remove-yes');
  await untilText(refusedTree, 'mints-note', 'Not confirmed. Nothing was changed.');
  expect(onGateDenied).toHaveBeenCalledTimes(1);
  expect(onGateDenied).toHaveBeenCalledWith('refused');
  expect(denied.removeMint).not.toHaveBeenCalled();
});

it("an add's owner check is told, passed or refused", async () => {
  const svc = { checkMint: jest.fn(async () => GOOD), addMint: jest.fn(async () => undefined) };
  const onGate = jest.fn();
  const tree = render(
    <AddMintScreen
      service={svc}
      gate={benchGate('allow')}
      onGate={onGate}
      preset={A}
      onDone={jest.fn()}
      onBack={jest.fn()}
    />,
  );
  await press(tree, 'addmint-check');
  await untilText(tree, 'addmint-result', 'This mint can be used.');
  await press(tree, 'addmint-add');
  await until(tree, 'addmint-added');
  expect(onGate).toHaveBeenCalledTimes(1);
  expect(onGate).toHaveBeenCalledWith('passed');

  const denied = { checkMint: jest.fn(async () => GOOD), addMint: jest.fn(async () => undefined) };
  const onGateDenied = jest.fn();
  const refusedTree = render(
    <AddMintScreen
      service={denied}
      gate={benchGate('deny')}
      onGate={onGateDenied}
      preset={A}
      onDone={jest.fn()}
      onBack={jest.fn()}
    />,
  );
  await press(refusedTree, 'addmint-check');
  await untilText(refusedTree, 'addmint-result', 'This mint can be used.');
  await press(refusedTree, 'addmint-add');
  await untilText(refusedTree, 'addmint-note', 'Not confirmed. Nothing was changed.');
  expect(onGateDenied).toHaveBeenCalledTimes(1);
  expect(onGateDenied).toHaveBeenCalledWith('refused');
  expect(denied.addMint).not.toHaveBeenCalled();
});

it('a check-again that changed nothing says so, with when it ran', async () => {
  const svc = mintsService([ok(A)]);
  const last = jest.fn((): RecheckNote | null => ({ at: AT, unreached: [] }));
  const tree = render(
    <MintsScreen
      service={svc}
      gate={benchGate('allow')}
      mints={[ok(A)]}
      lastRecheck={last}
      onAdd={jest.fn()}
      onBack={jest.fn()}
    />,
  );
  expect(has(tree, 'mints-checked')).toBe(false);
  await press(tree, 'mints-recheck');
  await untilText(tree, 'mints-checked', 'Checked all again on 22 Nov 2026, 04:10. Nothing has changed.');
});

it('a check-again that changed the list says so', async () => {
  const svc = mintsService([ok(A)]);
  svc.recheckMints.mockResolvedValue([refused(A, 'x.')]);
  const last = jest.fn((): RecheckNote | null => ({ at: AT, unreached: [] }));
  const tree = render(
    <MintsScreen
      service={svc}
      gate={benchGate('allow')}
      mints={[ok(A)]}
      lastRecheck={last}
      onAdd={jest.fn()}
      onBack={jest.fn()}
    />,
  );
  await press(tree, 'mints-recheck');
  await untilText(
    tree,
    'mints-checked',
    'Checked all again on 22 Nov 2026, 04:10. The list shows what it found.',
  );
});

it('a mint that did not answer is named', async () => {
  const svc = mintsService([ok(A), ok(B)]);
  const last = jest.fn((): RecheckNote | null => ({ at: AT, unreached: [A, B] }));
  const tree = render(
    <MintsScreen
      service={svc}
      gate={benchGate('allow')}
      lastRecheck={last}
      onAdd={jest.fn()}
      onBack={jest.fn()}
    />,
  );
  await press(tree, 'mints-recheck');
  await untilText(
    tree,
    'mints-checked',
    'Checked all again on 22 Nov 2026, 04:10. mint.test did not answer, so it is left as it was. other.test did not answer, so it is left as it was.',
  );
});

it('with no note of the pass, no line is shown', async () => {
  const svc = mintsService([ok(A)]);
  const tree = render(
    <MintsScreen service={svc} gate={benchGate('allow')} onAdd={jest.fn()} onBack={jest.fn()} />,
  );
  await press(tree, 'mints-recheck');
  await until(tree, 'mints-title');
  await act(async () => {
    await new Promise<void>((r) => {
      setTimeout(() => r(), 0);
    });
  });
  expect(has(tree, 'mints-checked')).toBe(false);
});

it('recheckWords', () => {
  expect(recheckWords([ok(A)], [ok(A)], { at: AT, unreached: [] })).toBe(
    'Checked all again on 22 Nov 2026, 04:10. Nothing has changed.',
  );
  expect(recheckWords([ok(A)], [ok(A, 9)], { at: AT, unreached: [] }).endsWith(' The list shows what it found.')).toBe(
    true,
  );
});

it('each item not offered has its own line', () => {
  const m = storeMessage({ kind: 'journal-missing', storedGeneration: 3 })!;
  const tree = render(<StoreProblemScreen message={m} note={null} onOffer={jest.fn()} />);
  expect(textOf(tree, 'store-not-offered')).toBe('Not offered: ' + m.notOffered[0]);
  expect(textOf(tree, 'store-not-offered-1')).toBe(m.notOffered[1]);
  expect(m.notOffered).toHaveLength(2);
  expect(has(tree, 'store-not-offered-2')).toBe(false);
});

it('the Closed screen has words of its own where nothing is chosen', async () => {
  const onAgain = jest.fn();
  const newer = render(<ClosedScreen state="newer-format" onAgain={onAgain} />);
  expect(textOf(newer, 'closed-body')).toBe(CLOSED_WORDS['newer-format'].body);
  expect(newer.root.findAll((n) => n.props.testID === 'closed-again')[0].props.label).toBe('Check again');

  const storage = render(<ClosedScreen state="store-refused" onAgain={onAgain} />);
  expect(textOf(storage, 'closed-body')).toBe(CLOSED_WORDS['store-refused'].body);
  expect(storage.root.findAll((n) => n.props.testID === 'closed-again')[0].props.label).toBe('Check again');

  const missing = render(<ClosedScreen state="journal-missing" onAgain={onAgain} />);
  expect(textOf(missing, 'closed-body')).toBe(CLOSED_WORDS.choose.body);
  expect(missing.root.findAll((n) => n.props.testID === 'closed-again')[0].props.label).toBe('Choose now');

  const plain = render(<ClosedScreen onAgain={onAgain} />);
  expect(textOf(plain, 'closed-body')).toBe(CLOSED_WORDS.choose.body);
  expect(plain.root.findAll((n) => n.props.testID === 'closed-again')[0].props.label).toBe('Choose now');

  await press(plain, 'closed-again');
  expect(onAgain).toHaveBeenCalledTimes(1);
});

it('the words of this order use no long dash, crypto or paid back', () => {
  const read: string[] = [];
  for (const tree of created) {
    for (const text of allText(tree)) {
      read.push(text);
      expect(text).not.toContain('—');
      expect(text).not.toContain('–');
      expect(/crypto|paid back/i.test(text)).toBe(false);
    }
  }
  expect(read).toContain(FIRSTRUN_LOST);
  expect(read).toContain(CLOSED_WORDS['store-refused'].body);
});
