import type { SecureStore } from '../../src/till/store/types';

export interface FakeSecure extends SecureStore {
  readonly items: Map<string, string>;
  /** get rejects with new Error('the secure store cannot be read now') for these names; '*' for every name */
  readonly failGet: Set<string>;
  /** set rejects with new Error('the secure store did not keep it') for these names; '*' for every name */
  readonly failSet: Set<string>;
  /** a set of one of these names deletes the item and then rejects with new Error('killed inside set'), as a process
   * killed inside react-native-keychain's set would leave it */
  readonly dieInSet: Set<string>;
  /** the names set, in order */
  readonly sets: string[];
}

export function fakeSecure(): FakeSecure {
  const items = new Map<string, string>();
  const failGet = new Set<string>();
  const failSet = new Set<string>();
  const dieInSet = new Set<string>();
  const sets: string[] = [];
  return {
    items,
    failGet,
    failSet,
    dieInSet,
    sets,
    async get(name: string): Promise<string | null> {
      if (failGet.has(name) || failGet.has('*')) {
        throw new Error('the secure store cannot be read now');
      }
      return items.get(name) ?? null;
    },
    async set(name: string, value: string): Promise<void> {
      sets.push(name);
      if (failSet.has(name) || failSet.has('*')) {
        throw new Error('the secure store did not keep it');
      }
      if (dieInSet.has(name)) {
        items.delete(name);
        throw new Error('killed inside set');
      }
      items.set(name, value);
    },
    async remove(name: string): Promise<void> {
      items.delete(name);
    },
  };
}
