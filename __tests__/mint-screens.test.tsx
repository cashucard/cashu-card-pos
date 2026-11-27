import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AddMintScreen } from '../src/screens/AddMintScreen';
import { MINTS_WORDS, MintsScreen } from '../src/screens/MintsScreen';
import { GATE_REASONS, type DeviceGate } from '../src/till/gate';
import { benchGate } from '../src/till/guarded';
import type { MintCheckId, MintCheckLine, MintCheckReport } from '../src/till/mint-check';
import { MintInUseError, type TillService } from '../src/till/service';
import type { MintEntry } from '../src/till/settings';
import { allText, has, nodes, press, textOf, typeInto, until, untilText } from './helpers/render';

const URL = 'https://mint.test';
const OTHER = 'https://mint.other';
const FEE_WORDS = 'Its fee is 5,000 ppk. This till takes at most 1,000.';

const CHECK_IDS: readonly MintCheckId[] = [
  'address',
  'reach',
  'nut07',
  'nut09',
  'nut11',
  'nut12',
  'keyset',
  'fee',
  'amounts',
  'keys',
];

function passedLines(): MintCheckLine[] {
  return CHECK_IDS.map((id) => ({ id, ok: true, words: 'W ' + id + '.' }));
}

/** A report that passed every line. */
const GOOD: MintCheckReport = {
  url: URL,
  ok: true,
  reached: true,
  lines: passedLines(),
  keysets: ['01' + 'ab'.repeat(32)],
};

/** The same report with its fee line failed. */
const BAD: MintCheckReport = {
  url: URL,
  ok: false,
  reached: true,
  lines: passedLines().map((l) => (l.id === 'fee' ? { id: 'fee', ok: false, words: FEE_WORDS } : l)),
  keysets: [],
};

/** A mint that gave no answer. */
const UNREACHED: MintCheckReport = {
  url: URL,
  ok: false,
  reached: false,
  lines: [
    { id: 'address', ok: true, words: 'The address starts with https.' },
    { id: 'reach', ok: false, words: 'The mint did not answer: no route.' },
  ],
  keysets: [],
};

type CheckMint = TillService['checkMint'];
type AddMint = TillService['addMint'];
type ListMints = TillService['mints'];
type RemoveMint = TillService['removeMint'];
type RecheckMints = TillService['recheckMints'];

interface FakeService {
  checkMint: jest.Mock<ReturnType<CheckMint>, Parameters<CheckMint>>;
  addMint: jest.Mock<ReturnType<AddMint>, Parameters<AddMint>>;
  mints: jest.Mock<ReturnType<ListMints>, Parameters<ListMints>>;
  removeMint: jest.Mock<ReturnType<RemoveMint>, Parameters<RemoveMint>>;
  recheckMints: jest.Mock<ReturnType<RecheckMints>, Parameters<RecheckMints>>;
}

function fakeService(): FakeService {
  return {
    checkMint: jest.fn<ReturnType<CheckMint>, Parameters<CheckMint>>(),
    addMint: jest.fn<ReturnType<AddMint>, Parameters<AddMint>>(),
    mints: jest.fn<ReturnType<ListMints>, Parameters<ListMints>>(() => []),
    removeMint: jest.fn<ReturnType<RemoveMint>, Parameters<RemoveMint>>(),
    recheckMints: jest.fn<ReturnType<RecheckMints>, Parameters<RecheckMints>>(),
  };
}

/** Every tree made here, for the words test at the end. */
const created: ReactTestRenderer[] = [];

function render(el: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(el);
  });
  created.push(tree);
  return tree;
}

function okMint(url: string, checkedAt = 2): MintEntry {
  return { url, addedAt: 1, checkedAt, keysets: ['01' + 'ab'.repeat(32)], status: 'ok', why: null };
}

function refusedMint(url: string, why: string, checkedAt = 2): MintEntry {
  return { url, addedAt: 1, checkedAt, keysets: [], status: 'refused', why };
}

interface AddScreen {
  tree: ReactTestRenderer;
  onDone: jest.Mock;
  onBack: jest.Mock;
}

function addScreen(svc: FakeService, gate: DeviceGate, preset: string | null = null): AddScreen {
  const onDone = jest.fn();
  const onBack = jest.fn();
  const tree = render(
    <AddMintScreen service={svc} gate={gate} preset={preset} onDone={onDone} onBack={onBack} />,
  );
  return { tree, onDone, onBack };
}

interface MintsScreenTree {
  tree: ReactTestRenderer;
  onAdd: jest.Mock;
  onBack: jest.Mock;
}

function mintsScreen(svc: FakeService, gate: DeviceGate): MintsScreenTree {
  const onAdd = jest.fn();
  const onBack = jest.fn();
  const tree = render(<MintsScreen service={svc} gate={gate} onAdd={onAdd} onBack={onBack} />);
  return { tree, onAdd, onBack };
}

it('the preset fills the address', () => {
  const svc = fakeService();
  const { tree } = addScreen(svc, benchGate('allow'), URL);
  expect(nodes(tree, 'addmint-url')[0].props.value).toBe(URL);
});

it('an empty address asks for one, and nothing is asked of the mint', async () => {
  const svc = fakeService();
  const { tree } = addScreen(svc, benchGate('allow'), null);
  await press(tree, 'addmint-check');
  expect(textOf(tree, 'addmint-note')).toBe("Type the mint's address first.");
  expect(svc.checkMint).not.toHaveBeenCalled();
});

it('a mint that passes is added after the device check', async () => {
  const svc = fakeService();
  svc.checkMint.mockResolvedValue(GOOD);
  svc.addMint.mockResolvedValue(undefined);
  const gate = benchGate('allow');
  const { tree, onDone } = addScreen(svc, gate, URL);
  await press(tree, 'addmint-check');
  await untilText(tree, 'addmint-result', 'This mint can be used.');
  expect(textOf(tree, 'addmint-line-fee')).toBe('Passed: W fee.');
  await press(tree, 'addmint-add');
  await until(tree, 'addmint-added');
  expect(gate.asked).toEqual([GATE_REASONS.mints]);
  expect(svc.addMint).toHaveBeenCalledTimes(1);
  expect(svc.addMint).toHaveBeenCalledWith(GOOD);
  expect(onDone).toHaveBeenCalledTimes(1);
});

it('a mint that fails cannot be added, and says which check failed', async () => {
  const svc = fakeService();
  svc.checkMint.mockResolvedValue(BAD);
  const { tree } = addScreen(svc, benchGate('allow'), URL);
  await press(tree, 'addmint-check');
  await untilText(tree, 'addmint-result', 'This mint cannot be used.');
  expect(textOf(tree, 'addmint-line-fee')).toBe('Failed: ' + FEE_WORDS);
  expect(has(tree, 'addmint-add')).toBe(false);
});

it('a mint that did not answer says so', async () => {
  const svc = fakeService();
  svc.checkMint.mockResolvedValue(UNREACHED);
  const { tree } = addScreen(svc, benchGate('allow'), URL);
  await press(tree, 'addmint-check');
  await untilText(tree, 'addmint-result', 'The mint did not answer. Check the address, then try again.');
  expect(has(tree, 'addmint-add')).toBe(false);
});

it('a refused device check adds nothing', async () => {
  const svc = fakeService();
  svc.checkMint.mockResolvedValue(GOOD);
  svc.addMint.mockResolvedValue(undefined);
  const { tree, onDone } = addScreen(svc, benchGate('deny'), URL);
  await press(tree, 'addmint-check');
  await until(tree, 'addmint-add');
  await press(tree, 'addmint-add');
  await untilText(tree, 'addmint-note', 'Not confirmed. Nothing was changed.');
  expect(svc.addMint).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
});

it('a phone with no passcode adds nothing, and is told why', async () => {
  const svc = fakeService();
  svc.checkMint.mockResolvedValue(GOOD);
  svc.addMint.mockResolvedValue(undefined);
  const noPasscode = { available: async () => false, check: jest.fn() };
  const { tree, onDone } = addScreen(svc, noPasscode, URL);
  await press(tree, 'addmint-check');
  await until(tree, 'addmint-add');
  await press(tree, 'addmint-add');
  await untilText(tree, 'addmint-note', 'Set a passcode on this phone first. Then try again.');
  expect(noPasscode.check).not.toHaveBeenCalled();
  expect(svc.addMint).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
});

it('a failed add is shown', async () => {
  const svc = fakeService();
  svc.checkMint.mockResolvedValue(GOOD);
  svc.addMint.mockRejectedValue(new Error('x'));
  const { tree } = addScreen(svc, benchGate('allow'), URL);
  await press(tree, 'addmint-check');
  await until(tree, 'addmint-add');
  await press(tree, 'addmint-add');
  await untilText(tree, 'addmint-note', 'The mint was not added: x');
  expect(has(tree, 'addmint-added')).toBe(false);
});

it('typing after a check starts over', async () => {
  const svc = fakeService();
  svc.checkMint.mockResolvedValue(GOOD);
  const { tree } = addScreen(svc, benchGate('allow'), URL);
  await press(tree, 'addmint-check');
  await untilText(tree, 'addmint-result', 'This mint can be used.');
  await typeInto(tree, 'addmint-url', 'other.test');
  expect(has(tree, 'addmint-result')).toBe(false);
  expect(nodes(tree, 'addmint-url')[0].props.value).toBe('other.test');
});

it('the list shows each mint and how it stands', () => {
  const svc = fakeService();
  const checkedAt = new Date(2026, 10, 22, 4, 10).getTime();
  svc.mints.mockReturnValue([okMint(URL, checkedAt), refusedMint(OTHER, FEE_WORDS, checkedAt)]);
  const { tree } = mintsScreen(svc, benchGate('allow'));
  expect(textOf(tree, 'mint-row-0')).toBe(URL);
  expect(textOf(tree, 'mint-status-0')).toBe(
    'Taking cards from this mint. Checked 22 Nov 2026, 04:10.',
  );
  expect(textOf(tree, 'mint-status-1')).toBe(
    'Not taking cards from this mint: ' + FEE_WORDS + ' Check it again once the mint has fixed it.',
  );
});

it('an empty list says so', () => {
  const svc = fakeService();
  svc.mints.mockReturnValue([]);
  const { tree } = mintsScreen(svc, benchGate('allow'));
  expect(has(tree, 'mints-empty')).toBe(true);
});

it('removing asks first, then the device, then removes', async () => {
  const svc = fakeService();
  svc.mints.mockReturnValueOnce([okMint(URL)]).mockReturnValue([]);
  svc.removeMint.mockResolvedValue(undefined);
  const gate = benchGate('allow');
  const { tree } = mintsScreen(svc, gate);
  await press(tree, 'mint-remove-0');
  expect(textOf(tree, 'mint-remove-warning')).toBe(
    'Stop taking cards from https://mint.test? Payments already taken from it stay in the record.',
  );
  await press(tree, 'mint-remove-yes');
  await until(tree, 'mints-empty');
  expect(svc.removeMint).toHaveBeenCalledWith(URL);
  expect(gate.asked).toEqual([GATE_REASONS.mints]);
});

it('keeping it removes nothing', async () => {
  const svc = fakeService();
  svc.mints.mockReturnValue([okMint(URL)]);
  const { tree } = mintsScreen(svc, benchGate('allow'));
  await press(tree, 'mint-remove-0');
  expect(has(tree, 'mint-remove-warning')).toBe(true);
  await press(tree, 'mint-remove-no');
  expect(has(tree, 'mint-remove-warning')).toBe(false);
  expect(svc.removeMint).not.toHaveBeenCalled();
});

it('a refused device check removes nothing', async () => {
  const svc = fakeService();
  svc.mints.mockReturnValue([okMint(URL)]);
  svc.removeMint.mockResolvedValue(undefined);
  const { tree } = mintsScreen(svc, benchGate('deny'));
  await press(tree, 'mint-remove-0');
  await press(tree, 'mint-remove-yes');
  await untilText(tree, 'mints-note', 'Not confirmed. Nothing was changed.');
  expect(svc.removeMint).not.toHaveBeenCalled();
  expect(has(tree, 'mint-row-0')).toBe(true);
});

it('a mint still in use is not removed, and the merchant is told why', async () => {
  const svc = fakeService();
  svc.mints.mockReturnValue([okMint(URL)]);
  svc.removeMint.mockRejectedValue(new MintInUseError(URL));
  const { tree } = mintsScreen(svc, benchGate('allow'));
  await press(tree, 'mint-remove-0');
  await press(tree, 'mint-remove-yes');
  await untilText(tree, 'mints-note', MINTS_WORDS.inUse);
  expect(has(tree, 'mint-row-0')).toBe(true);
});

it('check all again shows the new standing', async () => {
  const svc = fakeService();
  const checkedAt = new Date(2026, 10, 22, 4, 10).getTime();
  svc.mints.mockReturnValue([okMint(URL, checkedAt)]);
  svc.recheckMints.mockResolvedValue([refusedMint(URL, FEE_WORDS, checkedAt)]);
  const { tree } = mintsScreen(svc, benchGate('allow'));
  await press(tree, 'mints-recheck');
  await untilText(
    tree,
    'mint-status-0',
    'Not taking cards from this mint: ' + FEE_WORDS + ' Check it again once the mint has fixed it.',
  );
  expect(svc.recheckMints).toHaveBeenCalledTimes(1);
});

it('add goes to the add screen', async () => {
  const svc = fakeService();
  const { tree, onAdd, onBack } = mintsScreen(svc, benchGate('allow'));
  await press(tree, 'mints-add');
  expect(onAdd).toHaveBeenCalledTimes(1);
  await press(tree, 'nav-back');
  expect(onBack).toHaveBeenCalledTimes(1);
});

it('no text here uses a long dash, the word crypto, or paid back', () => {
  const read: string[] = [];
  for (const tree of created) {
    for (const text of allText(tree)) {
      read.push(text);
      expect(text).not.toContain('—');
      expect(text).not.toContain('–');
      expect(/crypto|paid back/i.test(text)).toBe(false);
    }
  }
  expect(read).toContain('Add a mint');
  expect(read).toContain('The mint was added.');
  expect(read).toContain('Mints');
  expect(read).toContain(MINTS_WORDS.inUse);
});

