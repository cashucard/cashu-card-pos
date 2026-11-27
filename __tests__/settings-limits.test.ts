import {
  emptySettings,
  keepable,
  loadSettings,
  saveSettings,
  KEYSET_WORDS,
  MAX_KEYSETS,
  MAX_MINTS,
  MAX_URL,
  MAX_WHY,
  type MintEntry,
  type SettingsNames,
} from '../src/till/settings';
import { fakeSecure } from './helpers/fake-secure';

const N: SettingsNames = { a: 'test.settings.a', b: 'test.settings.b' };
const KS = '01' + 'ab'.repeat(32);
function entry(url: string, over: Partial<MintEntry> = {}): MintEntry {
  return { url, addedAt: 5, checkedAt: 6, keysets: [KS], status: 'ok', why: null, ...over };
}

/** A keyset id the store keeps, made distinct by `i`. */
function keyset(i: number): string {
  return '01' + i.toString(16).padStart(64, '0');
}

describe('what the settings store can keep', () => {
  it("the limits are the store's own", () => {
    expect(MAX_MINTS).toBe(20);
    expect(MAX_KEYSETS).toBe(16);
    expect(MAX_URL).toBe(300);
    expect(MAX_WHY).toBe(400);
    expect(KEYSET_WORDS.test(KS)).toBe(true);
    expect(KEYSET_WORDS.test('I2yN+iRYfkzT')).toBe(false);
    expect(KEYSET_WORDS.test('00ab')).toBe(false);
  });

  it('a plain entry is keepable', () => {
    expect(keepable(entry('https://mint.test'))).toBe(true);
    expect(keepable(entry('https://mint.test', { status: 'refused', why: 'x' }))).toBe(true);
  });

  it('an entry the store would refuse is not keepable', () => {
    const refused = [
      entry('https://user@mint.test'),
      entry('http://mint.test'),
      entry('https://mint.test/' + 'a'.repeat(300)),
      entry('https://mint.test', { keysets: Array.from({ length: 17 }, (_, i) => keyset(i)) }),
      entry('https://mint.test', { keysets: ['I2yN+iRYfkzT'] }),
      entry('https://mint.test', { status: 'refused', why: 'w'.repeat(401) }),
      entry('https://mint.test', { addedAt: -1 }),
    ];
    for (const e of refused) {
      expect(keepable(e)).toBe(false);
    }
    expect(
      keepable(entry('https://mint.test', { keysets: Array.from({ length: 16 }, (_, i) => keyset(i)) })),
    ).toBe(true);
  });

  it('keepable answers as a save would', async () => {
    const tooMany = entry('https://mint.test', { keysets: Array.from({ length: 17 }, (_, i) => keyset(i)) });
    await expect(saveSettings(fakeSecure(), N, emptySettings(), [tooMany])).rejects.toThrow();
    await expect(saveSettings(fakeSecure(), N, emptySettings(), [entry('https://mint.test')])).resolves.toBeDefined();
  });

  it('a slot whose read throws is passed over for the other', async () => {
    const fs = fakeSecure();
    const s1 = await saveSettings(fs, N, emptySettings(), [entry('https://one.test')]);
    expect(fs.items.has(N.b)).toBe(true);
    fs.failGet.add(N.a);
    expect(await loadSettings(fs, N)).toEqual({ settings: s1, damaged: false });

    fs.failGet.clear();
    const s2 = await saveSettings(fs, N, s1, [entry('https://one.test'), entry('https://two.test')]);
    expect(fs.items.has(N.a)).toBe(true);
    fs.failGet.add(N.b);
    expect((await loadSettings(fs, N)).settings).toEqual(s2);
  });

  it('a slot whose read throws, with nothing good in the other, still rejects', async () => {
    const absentA = fakeSecure();
    absentA.failGet.add(N.a);
    await expect(loadSettings(absentA, N)).rejects.toThrow(/cannot be read/);

    const damagedB = fakeSecure();
    damagedB.failGet.add(N.a);
    damagedB.items.set(N.b, 'x');
    await expect(loadSettings(damagedB, N)).rejects.toThrow(/cannot be read/);

    const absentB = fakeSecure();
    absentB.failGet.add(N.b);
    await expect(loadSettings(absentB, N)).rejects.toThrow(/cannot be read/);
  });
});
