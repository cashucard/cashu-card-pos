import { SIDECARS, type StoreDeps, type StoreNames } from './types';
import { checkpointItem } from './lightning-checkpoint';

/** The development-only wipe was asked for outside a development build. */
export class DevOnlyError extends Error {
  constructor() {
    super('the journal lab is for development builds only');
    this.name = 'DevOnlyError';
    Object.setPrototypeOf(this, DevOnlyError.prototype);
  }
}

/** Development only: remove a lab store's files (the database and its sidecars) and its three secure-store items. */
export async function wipeLabStore(deps: StoreDeps, names: StoreNames, dev: boolean = __DEV__): Promise<void> {
  if (!dev) {
    throw new DevOnlyError();
  }
  if (names.dir !== 'lab' || !names.file.startsWith('lab-')) {
    throw new Error('only a lab store may be wiped');
  }
  for (const n of [names.key, names.genA, names.genB]) {
    if (!n.startsWith('org.cashucard.pos.lab.')) {
      throw new Error('only a lab store may be wiped');
    }
  }
  const dir = await deps.files.dir(names.dir);
  for (const s of ['', ...SIDECARS]) {
    await deps.files.removeLab(dir + '/' + names.file + s);
  }
  for (const n of [names.key, names.genA, names.genB, checkpointItem(names)]) {
    await deps.secure.remove(n);
  }
}
