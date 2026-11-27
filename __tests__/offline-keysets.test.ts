import { prepareOfflineKit } from 'cashucard';
import { usableKit } from '../src/till/store/offline';
import type { MintEntry } from '../src/till/settings';
import { fakeMint } from './helpers/fake-mint';

it('requires the same distinct set of verified keys that the merchant mint check accepted', async () => {
  const url = 'https://mint.test';
  const now = 2000;
  const mint = fakeMint({ keysets: 2 });
  const kit = await prepareOfflineKit(url, mint.http, () => now);
  const entry: MintEntry = { url, addedAt: now, checkedAt: now, status: 'ok', why: null, keysets: [...mint.ids].reverse() };
  expect(usableKit(kit, entry, now)).toBe(kit);
  expect(usableKit(kit, { ...entry, keysets: [mint.ids[0], mint.ids[0]] }, now)).toBeNull();
});
