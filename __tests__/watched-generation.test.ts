/* The generation store, watched (slice 2.4, ENG-909 b): the till is told whether each generation the library hands
 * over was kept by the phone's secure store, over the real two-slot store and a secure store that refuses some sets. */

import { generationStore, watchedGeneration } from '../src/till/store/secret';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeSecure, type FakeSecure } from './helpers/fake-secure';

function refuse(s: FakeSecure): void {
  s.failSet.add(TILL_NAMES.genA);
  s.failSet.add(TILL_NAMES.genB);
}

function watched(): { s: FakeSecure; told: boolean[]; w: ReturnType<typeof watchedGeneration> } {
  const s = fakeSecure();
  const told: boolean[] = [];
  const w = watchedGeneration(generationStore(s, TILL_NAMES), (kept) => told.push(kept));
  return { s, told, w };
}

describe('the generation store, watched', () => {
  it('a generation the store keeps is told as kept, and is stored', async () => {
    const { told, w } = watched();
    await w.set(4);
    expect(told).toEqual([true]);
    expect(await w.get()).toBe(4);
    expect(w.owed()).toBeNull();
  });

  it("a generation the store refuses is told as not kept, and the store's own error is thrown on", async () => {
    const { s, told, w } = watched();
    await w.set(4);
    refuse(s);
    await expect(w.set(5)).rejects.toThrow('the secure store did not keep it');
    await expect(w.set(6)).rejects.toThrow('the secure store did not keep it');
    expect(told).toEqual([true, false, false]);
    expect(w.owed()).toBe(6);
    expect(await w.get()).toBe(4);
  });

  it('the next generation the store keeps is told as kept, and nothing is owed', async () => {
    const { s, told, w } = watched();
    refuse(s);
    await expect(w.set(5)).rejects.toThrow();
    s.failSet.clear();
    await w.set(6);
    expect(told).toEqual([false, true]);
    expect(w.owed()).toBeNull();
    expect(await w.get()).toBe(6);
  });

  it('again stores the generation owed and tells it; while the store still refuses it answers false and tells nothing', async () => {
    const { s, told, w } = watched();
    expect(await w.again()).toBe(true);
    expect(s.sets).toEqual([]);
    refuse(s);
    await expect(w.set(7)).rejects.toThrow();
    expect(await w.again()).toBe(false);
    expect(told).toEqual([false]);
    expect(w.owed()).toBe(7);
    s.failSet.clear();
    expect(await w.again()).toBe(true);
    expect(told).toEqual([false, true]);
    expect(w.owed()).toBeNull();
    expect(await w.get()).toBe(7);
  });

  it('a lower generation kept while a higher one is owed tells nothing', async () => {
    const { s, told, w } = watched();
    refuse(s);
    await expect(w.set(9)).rejects.toThrow();
    s.failSet.clear();
    await w.set(8);
    expect(told).toEqual([false]);
    expect(w.owed()).toBe(9);
  });

  it('a listener that throws never changes what a set answers', async () => {
    const s = fakeSecure();
    const w = watchedGeneration(generationStore(s, TILL_NAMES), () => {
      throw new Error('listener');
    });
    await expect(w.set(3)).resolves.toBeUndefined();
    refuse(s);
    await expect(w.set(4)).rejects.toThrow('the secure store did not keep it');
  });
});
