import {
  acceptedMints,
  emptySettings,
  findMint,
  loadSettings,
  parseSettings,
  saveSettings,
  SettingsNotKeptError,
  SettingsUnreadableError,
  TILL_SETTINGS,
  withMint,
  withoutMint,
  type MintEntry,
  type SettingsNames,
} from '../src/till/settings';
import type { SecureStore } from '../src/till/store/types';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeSecure } from './helpers/fake-secure';

const N: SettingsNames = { a: 'test.settings.a', b: 'test.settings.b' };
const KS = '01' + 'ab'.repeat(32);

function entry(url: string, over: Partial<MintEntry> = {}): MintEntry {
  return { url, addedAt: 5, checkedAt: 6, keysets: [KS], status: 'ok', why: null, ...over };
}

/** A valid stored item, with one field of its mint or of the settings changed. */
function text(mintOver: Record<string, unknown> = {}, topOver: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, seq: 1, mints: [{ ...entry('https://mint.test'), ...mintOver }], ...topOver });
}

describe('the till settings in the secure store', () => {
  it('nothing stored reads as no mints, not damaged', async () => {
    const loaded = await loadSettings(fakeSecure(), N);
    expect(loaded.settings).toEqual({ v: 1, seq: 0, mints: [] });
    expect(loaded.damaged).toBe(false);
  });

  it('a saved list reads back', async () => {
    const fs = fakeSecure();
    const s1 = await saveSettings(fs, N, emptySettings(), [entry('https://mint.test')]);
    expect(s1.seq).toBe(1);
    expect(fs.items.has(N.b)).toBe(true);
    expect(fs.items.has(N.a)).toBe(false);
    expect(await loadSettings(fs, N)).toEqual({ settings: s1, damaged: false });
  });

  it('each save writes the other slot, and the newer wins', async () => {
    const fs = fakeSecure();
    const s1 = await saveSettings(fs, N, emptySettings(), [entry('https://one.test')]);
    const s2 = await saveSettings(fs, N, s1, [entry('https://one.test'), entry('https://two.test')]);
    expect(parseSettings(fs.items.get(N.a)!).seq).toBe(2);
    expect(parseSettings(fs.items.get(N.b)!).seq).toBe(1);
    const loaded = await loadSettings(fs, N);
    expect(loaded.damaged).toBe(false);
    expect(loaded.settings.seq).toBe(2);
    expect(loaded.settings.mints).toEqual(s2.mints);
  });

  it('a save cut off inside the secure store leaves the list before it', async () => {
    const fs = fakeSecure();
    const s1 = await saveSettings(fs, N, emptySettings(), [entry('https://one.test')]);
    const s2 = await saveSettings(fs, N, s1, [entry('https://one.test'), entry('https://two.test')]);
    fs.dieInSet.add(N.b);
    await expect(saveSettings(fs, N, s2, [])).rejects.toThrow(/killed inside set/);
    const loaded = await loadSettings(fs, N);
    expect(loaded.settings.seq).toBe(2);
    expect(loaded.settings.mints).toHaveLength(2);
    expect(loaded.damaged).toBe(false);
  });

  it('a damaged slot is passed over for the other', async () => {
    const fs = fakeSecure();
    await saveSettings(fs, N, emptySettings(), [entry('https://mint.test')]);
    fs.items.set(N.a, 'not json');
    const loaded = await loadSettings(fs, N);
    expect(loaded.settings.seq).toBe(1);
    expect(loaded.damaged).toBe(false);
  });

  it('both slots damaged read as no mints, and say so', async () => {
    const fs = fakeSecure();
    fs.items.set(N.a, '{}');
    fs.items.set(N.b, 'x');
    const loaded = await loadSettings(fs, N);
    expect(loaded.settings.mints).toEqual([]);
    expect(loaded.settings.seq).toBe(0);
    expect(loaded.damaged).toBe(true);
  });

  it('a secure store that cannot be read rejects, never no mints', async () => {
    const fs = fakeSecure();
    fs.failGet.add('*');
    await expect(loadSettings(fs, N)).rejects.toThrow(/cannot be read/);
  });

  it('a save that does not read back is refused', async () => {
    const keepingNothing: SecureStore = {
      async get(): Promise<string | null> {
        return null;
      },
      async set(): Promise<void> {
        return undefined;
      },
      async remove(): Promise<void> {
        return undefined;
      },
    };
    await expect(saveSettings(keepingNothing, N, emptySettings(), [entry('https://mint.test')])).rejects.toBeInstanceOf(
      SettingsNotKeptError,
    );
  });

  it('parseSettings refuses what this app never writes', () => {
    const unrelated = Array.from({ length: 21 }, () => entry('https://mint.test'));
    const bad = [
      'x',
      'null',
      '{}',
      text({}, { v: 2 }),
      text({}, { seq: 0 }),
      text({}, { seq: 1.5 }),
      JSON.stringify({ v: 1, seq: 1, mints: 'x' }),
      JSON.stringify({ v: 1, seq: 1, mints: unrelated }),
      text({ url: 'http://mint.test' }),
      text({ url: 'https://a@b.test' }),
      text({ keysets: ['zz'] }),
      text({ status: 'maybe' }),
      text({ why: 5 }),
      text({ addedAt: -1 }),
    ];
    for (const item of bad) {
      expect(() => parseSettings(item)).toThrow(SettingsUnreadableError);
    }
    expect(() => parseSettings('{}')).toThrow("a settings item does not hold the till's settings");
  });

  it('parseSettings keeps only the fields it knows', () => {
    const parsed = parseSettings(
      JSON.stringify({ v: 1, seq: 3, x: 1, mints: [{ ...entry('https://mint.test'), y: 2 }] }),
    );
    expect(parsed).toEqual({ v: 1, seq: 3, mints: [entry('https://mint.test')] });
    expect(parsed).not.toHaveProperty('x');
    expect(parsed.mints[0]).not.toHaveProperty('y');
  });

  it('withMint replaces a mint by its address and keeps when it was added', () => {
    const before = [entry('https://mint.test', { addedAt: 5 })];
    const after = withMint(before, entry('https://MINT.test', { addedAt: 9, checkedAt: 10 }));
    expect(after).toHaveLength(1);
    expect(after[0].addedAt).toBe(5);
    expect(after[0].checkedAt).toBe(10);
    expect(withMint(after, entry('https://other.test')).map((m) => m.url)).toEqual([
      'https://MINT.test',
      'https://other.test',
    ]);
    expect(before).toEqual([entry('https://mint.test', { addedAt: 5 })]);
  });

  it('withoutMint, findMint and acceptedMints', () => {
    const list = [entry('https://a.test'), entry('https://b.test', { status: 'refused', why: 'w.' })];
    expect(acceptedMints(list)).toEqual(['https://a.test']);
    expect(findMint(list, 'https://B.test')?.status).toBe('refused');
    expect(findMint(list, 'https://c.test')).toBeNull();
    expect(withoutMint(list, 'https://a.test').map((m) => m.url)).toEqual(['https://b.test']);
    expect(list).toHaveLength(2);
  });

  it("the till's settings items are its own", () => {
    expect(TILL_SETTINGS).toEqual({
      a: 'org.cashucard.pos.till.settings.a',
      b: 'org.cashucard.pos.till.settings.b',
    });
    const others = [TILL_NAMES.key, TILL_NAMES.genA, TILL_NAMES.genB];
    expect(others).not.toContain(TILL_SETTINGS.a);
    expect(others).not.toContain(TILL_SETTINGS.b);
  });
});
