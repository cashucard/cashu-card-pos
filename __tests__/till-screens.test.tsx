import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { InstalledVersionContext } from '../src/app/installed-version';
import { AboutScreen } from '../src/screens/AboutScreen';
import { FirstRunScreen } from '../src/screens/FirstRunScreen';
import { TillNotices, homeStatus } from '../src/screens/HomeScreen';
import { GATE_LINES, SettingsScreen } from '../src/screens/SettingsScreen';
import type { MintEntry } from '../src/till/settings';
import { allText, has, press, textOf } from './helpers/render';

/** A mint that is taking cards. */
function ok(url: string): MintEntry {
  return { url, addedAt: 1, checkedAt: 2, keysets: ['00aa'], status: 'ok', why: null };
}

/** A mint whose last check failed, with its words. */
function refused(url: string): MintEntry {
  return { url, addedAt: 1, checkedAt: 2, keysets: [], status: 'refused', why: 'W.' };
}

const A = 'https://mint.a';
const B = 'https://mint.b';
const C = 'https://mint.c';

function render(el: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(el);
  });
  return tree;
}

it("the till's status counts the mints taking cards", () => {
  expect(homeStatus([])).toBe('No mint yet. Add one in Settings.');
  expect(homeStatus([ok(A)])).toBe('Ready to take cards from 1 mint.');
  expect(homeStatus([ok(A), ok(B), refused(C)])).toBe('Ready to take cards from 2 mints.');
  expect(homeStatus([refused(A)])).toBe('No mint is taking cards. Check your mints in Settings.');
});

it("opens the customer returns from a stranded mint notice", async () => {
  const onOpenOwed = jest.fn();
  const tree = render(<TillNotices mints={[]} note={null} owed={['6 sats owed']} onOpenOwed={onOpenOwed} />);
  await press(tree, 'home-owed-open');
  expect(onOpenOwed).toHaveBeenCalledTimes(1);
});

it('a note shows on the till', () => {
  const withNote = render(<TillNotices mints={[ok(A)]} note="N." onOpenOwed={jest.fn()} />);
  expect(textOf(withNote, 'home-note')).toBe('N.');
  const without = render(<TillNotices mints={[ok(A)]} note={null} onOpenOwed={jest.fn()} />);
  expect(has(without, 'home-note')).toBe(false);
});

it('the Welcome offers to add a mint, and the test mint in development', async () => {
  const onAdd = jest.fn();
  const plain = render(<FirstRunScreen preset={null} onAdd={onAdd} />);
  expect(has(plain, 'firstrun-add')).toBe(true);
  expect(has(plain, 'firstrun-dev-mint')).toBe(false);
  await press(plain, 'firstrun-add');
  expect(onAdd).toHaveBeenCalledTimes(1);
  expect(onAdd).toHaveBeenCalledWith(null);

  const dev = render(<FirstRunScreen preset="https://mint.test" onAdd={onAdd} />);
  expect(textOf(dev, 'firstrun-dev')).toBe('Development build: a test mint is ready to add.');
  await press(dev, 'firstrun-dev-mint');
  expect(onAdd).toHaveBeenLastCalledWith('https://mint.test');
});

it('settings says how the phone confirms it is you', () => {
  const asking = render(
    <SettingsScreen gateAvailable={null} note={null} onGo={jest.fn()} onBack={jest.fn()} />,
  );
  expect(textOf(asking, 'settings-gate')).toBe(GATE_LINES.asking);
  const yes = render(
    <SettingsScreen gateAvailable={true} note={null} onGo={jest.fn()} onBack={jest.fn()} />,
  );
  expect(textOf(yes, 'settings-gate')).toBe(GATE_LINES.yes);
  const no = render(
    <SettingsScreen gateAvailable={false} note={null} onGo={jest.fn()} onBack={jest.fn()} />,
  );
  expect(textOf(no, 'settings-gate')).toBe(GATE_LINES.no);
});

it('settings goes where it says, and back', async () => {
  const onGo = jest.fn();
  const onBack = jest.fn();
  const tree = render(
    <SettingsScreen gateAvailable={true} note="N." onGo={onGo} onBack={onBack} />,
  );
  await press(tree, 'settings-mints');
  expect(onGo).toHaveBeenLastCalledWith('mints');
  await press(tree, 'settings-owed');
  expect(onGo).toHaveBeenLastCalledWith('owed');
  await press(tree, 'settings-records');
  expect(onGo).toHaveBeenLastCalledWith('records');
  await press(tree, 'settings-about');
  expect(onGo).toHaveBeenLastCalledWith('about');
  expect(onGo).toHaveBeenCalledTimes(4);
  await press(tree, 'nav-back');
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(textOf(tree, 'settings-note')).toBe('N.');
});

it('about tells what this till is', async () => {
  const onBack = jest.fn();
  const dev = render(
    <InstalledVersionContext.Provider value={{ versionName: '2.3.4-beta', buildNumber: '105' }}>
      <AboutScreen
        mode="development"
        libraryVersion="0.1.0"
        reader="the card simulator (development)"
        onBack={onBack}
      />
    </InstalledVersionContext.Provider>,
  );
  expect(textOf(dev, 'about-app')).toBe('Cashu Card POS 2.3.4-beta (105) (development build)');
  expect(textOf(dev, 'about-library')).toBe('Card library: cashucard 0.1.0');
  expect(textOf(dev, 'about-reader')).toBe('Card reader: the card simulator (development)');
  expect(textOf(dev, 'about-takes')).toBe('Takes Cashu Cards with card software 3.0 or 3.1, in sats.');
  expect(textOf(dev, 'about-record')).toBe(
    'The till keeps its payment record encrypted on this phone. Save a passphrase-protected copy in Settings → Backups and change.',
  );
  expect(textOf(dev, 'about-checkout')).toBe(
    'Sell can check a balance, top up a card and accept eligible payments offline.',
  );
  expect(textOf(dev, 'about-privacy')).toBe(
    'The till contacts your mints. For a Lightning withdrawal, it also asks your Lightning address provider for an invoice. It has no analytics and no crash reporter.',
  );
  await press(dev, 'nav-back');
  expect(onBack).toHaveBeenCalledTimes(1);

  const release = render(
    <InstalledVersionContext.Provider value={{ versionName: '3.0', buildNumber: '19.2.1' }}>
      <AboutScreen
        mode="release"
        libraryVersion="0.1.0"
        reader="the card simulator (development)"
        onBack={jest.fn()}
      />
    </InstalledVersionContext.Provider>,
  );
  expect(textOf(release, 'about-app')).toBe('Cashu Card POS 3.0 (19.2.1)');
});

it('no screen here uses a long dash, the word crypto, or paid back', () => {
  const trees: ReactTestRenderer[] = [
    render(<TillNotices mints={[]} note={null} onOpenOwed={jest.fn()} />),
    render(<TillNotices mints={[ok(A), refused(B)]} note="Not confirmed. Nothing was changed." onOpenOwed={jest.fn()} />),
    render(<FirstRunScreen preset={null} onAdd={jest.fn()} />),
    render(<FirstRunScreen preset="https://mint.test" onAdd={jest.fn()} />),
    render(<SettingsScreen gateAvailable={null} note={null} onGo={jest.fn()} onBack={jest.fn()} />),
    render(<SettingsScreen gateAvailable={true} note={null} onGo={jest.fn()} onBack={jest.fn()} />),
    render(
      <SettingsScreen
        gateAvailable={false}
        note="Not confirmed. Nothing was changed."
        onGo={jest.fn()}
        onBack={jest.fn()}
      />,
    ),
    render(
      <AboutScreen
        mode="development"
        libraryVersion="0.1.0"
        reader="the card simulator (development)"
        onBack={jest.fn()}
      />,
    ),
    render(
      <AboutScreen
        mode="release"
        libraryVersion="0.1.0"
        reader="the card simulator (development)"
        onBack={jest.fn()}
      />,
    ),
  ];
  const read: string[] = [];
  for (const tree of trees) {
    for (const text of allText(tree)) {
      read.push(text);
      expect(text).not.toContain('—');
      expect(text).not.toContain('–');
      expect(/crypto|paid back/i.test(text)).toBe(false);
    }
  }
  expect(read).toContain('No mint yet. Add one in Settings.');
});
