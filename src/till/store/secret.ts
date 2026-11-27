import type { GenerationStore } from 'cashucard';
import { toHex } from '../hex';
import type { SecureStore, StoreNames } from './types';

/** A secure-store item holds something this store never writes. */
export class SecretUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretUnreadableError';
    Object.setPrototypeOf(this, SecretUnreadableError.prototype);
  }
}

/** A new key read back differently from what was written. */
export class KeyNotKeptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyNotKeptError';
    Object.setPrototypeOf(this, KeyNotKeptError.prototype);
  }
}

/** A generation as this store writes it, or null for no item. */
export function parseGeneration(name: string, v: string | null): number | null {
  if (v === null) {
    return null;
  }
  const n = Number(v);
  if (!/^(0|[1-9][0-9]{0,15})$/.test(v) || !Number.isSafeInteger(n)) {
    throw new SecretUnreadableError('the item ' + name + ' does not hold a generation');
  }
  return n;
}

/** The database key: 64 lower-case hex characters, or null when there is no item. */
export async function readKey(secure: SecureStore, names: StoreNames): Promise<string | null> {
  const v = await secure.get(names.key);
  if (v === null) {
    return null;
  }
  if (!/^[0-9a-f]{64}$/.test(v)) {
    throw new SecretUnreadableError('the key item does not hold a key');
  }
  return v;
}

/** Make a new key from 32 random bytes, store it, and read it back. */
export async function createKey(
  secure: SecureStore,
  names: StoreNames,
  randomBytes: (n: number) => Uint8Array,
): Promise<string> {
  const b = randomBytes(32);
  if (b.length !== 32) {
    throw new Error('the random source gave ' + b.length + ' bytes, not 32');
  }
  let zeros = true;
  for (let i = 0; i < b.length; i += 1) {
    if (b[i] !== 0) {
      zeros = false;
      break;
    }
  }
  if (zeros) {
    throw new Error('the random source gave zeros');
  }
  const hex = toHex(b);
  await secure.set(names.key, hex);
  const back = await secure.get(names.key);
  if (back !== hex) {
    throw new KeyNotKeptError('the new key read back differently; no file is made with it');
  }
  return hex;
}

export interface TwoSlotGenerationStore extends GenerationStore {
  /** both slots as they are (the lab and the tests) */
  slots(): Promise<{ a: number | null; b: number | null }>;
}

/** The library's GenerationStore over two items, names.genA and names.genB. Each set writes the slot that does not hold
 * the higher number (slot a when they are equal or both absent), so a set cut off inside the secure store never takes
 * the higher number with it. */
export function generationStore(secure: SecureStore, names: StoreNames): TwoSlotGenerationStore {
  /** both slots as last read or written by this object; null when not known (before the first read, after a failed set) */
  let known: { a: number | null; b: number | null } | null = null;
  const slots = async (): Promise<{ a: number | null; b: number | null }> => {
    const a = parseGeneration(names.genA, await secure.get(names.genA));
    const b = parseGeneration(names.genB, await secure.get(names.genB));
    known = { a, b };
    return { a, b };
  };
  return {
    slots,
    async get(): Promise<number | null> {
      const { a, b } = await slots();
      if (a === null && b === null) {
        return null;
      }
      if (a === null) {
        return b;
      }
      if (b === null) {
        return a;
      }
      return Math.max(a, b);
    },
    async set(g: number): Promise<void> {
      if (!Number.isSafeInteger(g) || g < 0) {
        throw new Error('a generation is a whole number of 0 or more');
      }
      const s = known ?? (await slots());
      const toB = s.a !== null && (s.b === null || s.b < s.a);
      known = null;
      await secure.set(toB ? names.genB : names.genA, String(g));
      known = toB ? { a: s.a, b: g } : { a: g, b: s.b };
    },
  };
}

/** The library's GenerationStore with a hold (slice 2.3 review). While held, `set` keeps the highest generation it is
 * given and answers at once; `release` ends the hold and stores that one generation with the inner store, after every
 * write it stands for has committed. Outside a hold every `set` goes to the inner store as before.
 *
 * Only an archive job holds it. Its only journal writes are the library's archived marks and the lease, which
 * cashucard 0.3.0 writes again before the first move and after the last, so that the journal's highest generation
 * stays on a row no archive moves (archive() writes nothing else; the job is a job of the till's queue, so nothing
 * else writes beside it); each still commits in full before it answers. Since 0.3.0 the hold is no longer needed for
 * safety. It is kept for time: each set is a write to the secure store (about 136 ms on an Android phone, slice 2.3),
 * and a job of 100 sales makes 102 of them. A stored generation behind the journal's is what the library's own
 * contract allows when a `set` fails ("detection is then behind until the next write"), and the next open accepts
 * it: only one ABOVE the journal's is a rollback. A kill inside the job leaves the stored generation at the job's
 * start: the next open finds the journal ahead, takes it, and stores its own. What a rollback inside that window could
 * put back is only the job's marks, its lease writes and its moves, which change no payment, no delivery and no kept
 * eCash. */
export interface HeldGeneration extends GenerationStore {
  hold(): void;
  /** ends the hold and stores the highest generation set during it, if any; a store that refuses is told to `failed` */
  release(): Promise<void>;
}

export function heldGeneration(inner: GenerationStore, failed: (e: unknown) => void): HeldGeneration {
  let held = false;
  let pending: number | null = null;
  return {
    get: () => inner.get(),
    async set(g: number): Promise<void> {
      if (held) {
        pending = pending === null ? g : Math.max(pending, g);
        return;
      }
      await inner.set(g);
    },
    hold(): void {
      held = true;
    },
    async release(): Promise<void> {
      held = false;
      const g = pending;
      pending = null;
      if (g === null) {
        return;
      }
      try {
        await inner.set(g);
      } catch (e) {
        failed(e);
      }
    },
  };
}

/** The library's GenerationStore, watched (slice 2.4, ENG-909 b). Every `set` goes to the inner store. `note` is told
 * true when the store kept it and false when the store refused it, and a refusal is thrown on as it came, so the
 * library logs it as before. The highest generation refused and not stored since is owed: `again` tries once more to
 * store it, so a till that writes nothing more still gets its generation stored once the store takes it. A set that
 * is kept while a higher generation is still owed tells nothing: the stored generation is still behind. */
export interface WatchedGeneration extends GenerationStore {
  /** the highest generation the store refused and has not kept since, or null */
  owed(): number | null;
  /** stores the generation owed, if any; answers whether nothing is owed now. Never throws. */
  again(): Promise<boolean>;
}

export function watchedGeneration(inner: GenerationStore, note: (kept: boolean) => void): WatchedGeneration {
  let owed: number | null = null;
  const tell = (kept: boolean): void => {
    try {
      note(kept);
    } catch {
      // a listener that throws never changes what a set answers
    }
  };
  return {
    get: () => inner.get(),
    async set(g: number): Promise<void> {
      try {
        await inner.set(g);
      } catch (e) {
        owed = owed === null ? g : Math.max(owed, g);
        tell(false);
        throw e;
      }
      if (owed !== null && g < owed) {
        return;
      }
      owed = null;
      tell(true);
    },
    owed: () => owed,
    async again(): Promise<boolean> {
      const g = owed;
      if (g === null) {
        return true;
      }
      try {
        await inner.set(g);
      } catch {
        return false;
      }
      if (owed === g) {
        owed = null;
        tell(true);
      }
      return owed === null;
    },
  };
}

/** At a first run, before the file is made: slot a holds 0, so "no journal was ever opened here" is written down. */
export async function markFirstRun(secure: SecureStore, names: StoreNames): Promise<void> {
  await secure.set(names.genA, '0');
}
