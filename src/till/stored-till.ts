import { open } from 'cashucard';
import type { Durability } from './store/db';
import { openStore, type StoreChoice, type StoreOutcome } from './store/open-store';
import type { StoreDeps, StoreNames } from './store/types';
import { tillConfig, type OpenTill, type TillOptions } from './open';

export interface StoredTillOptions extends TillOptions {
  names: StoreNames;
  /** the merchant's choice for this one open (open-store.ts) */
  choice?: StoreChoice;
  durability?: Durability;
}

/** Open the till over the store: the journal, the generation store and the keep-store of one SQLCipher file. */
export async function openStoredTill(deps: StoreDeps, o: StoredTillOptions): Promise<StoreOutcome<OpenTill>> {
  return openStore<OpenTill>(deps, o.names, {
    choice: o.choice,
    durability: o.durability,
    start: async (s, acceptRollback) => {
      const cashuCard = await open(
        tillConfig({ ...o, log: o.log ?? deps.log }, s.journal, s.keep, { generationStore: s.generation, acceptRollback }),
      );
      return { cashuCard, journal: s.journal, keep: s.keep };
    },
  });
}
