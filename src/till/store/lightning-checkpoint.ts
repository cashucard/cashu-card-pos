import { bytesToHex } from '@noble/hashes/utils.js';
import type { StoreDeps, StoreNames } from './types';

/** A device-only revision, independent of the card library's journal generation. */
export interface LightningCheckpoint {
  read(): Promise<string | null>;
  advance(): Promise<string>;
}

export function checkpointItem(names: StoreNames): string {
  return names.key + '.lightning-revision';
}

export function lightningCheckpoint(deps: StoreDeps, names: StoreNames): LightningCheckpoint {
  const name = checkpointItem(names);
  return {
    read: () => deps.secure.get(name),
    async advance() {
      const random = deps.randomBytes(32);
      if (random.length !== 32 || !random.some(byte => byte !== 0)) throw new Error('Wallet revision unavailable.');
      const mark = bytesToHex(random);
      await deps.secure.set(name, mark);
      if (await deps.secure.get(name) !== mark) throw new Error('The phone could not save its wallet revision.');
      return mark;
    },
  };
}
