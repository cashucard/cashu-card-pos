import { open, type Config } from 'cashucard';
import { createTillService } from '../src/till/service';
import { TILL_SETTINGS } from '../src/till/settings';
import { TILL_NAMES } from '../src/till/store/types';
import { fakeMint } from './helpers/fake-mint';
import { fakeStoreDeps } from './helpers/fake-store';

const PATH = '/app/till/till.db';

it("the service's and the store's log lines carry nothing the till holds", async () => {
  const f = fakeStoreDeps();
  const m = fakeMint();
  const serviceLogs: string[] = [];
  const make = () =>
    createTillService({
      store: f.deps,
      names: TILL_NAMES,
      settingsNames: TILL_SETTINGS,
      http: m.http,
      now: () => 1000,
      log: (l) => serviceLogs.push(l),
      openLibrary: (c: Config) => open(c),
    });

  const s = make();
  await s.open();
  f.secure.failSet.add(TILL_NAMES.genA);
  f.secure.failSet.add(TILL_NAMES.genB);

  await s.addMint(await s.checkMint('mint.test'));
  m.set({ generation: 1 });
  await s.recheckMints();
  m.set({ generation: 2, fee: 5000 });
  await s.recheckMints();
  m.set({ down: true });
  await s.recheckMints();
  await s.close();

  f.secure.failSet.clear();
  f.disk.files.delete(PATH);
  const s2 = make();
  await s2.open();
  s2.notNow();
  await s2.open('start-new');
  await s2.close();

  const all = [...serviceLogs, ...f.logs].join('\n');
  expect(f.logs.some((l) => l.includes('could not be stored outside it'))).toBe(true);
  for (const line of serviceLogs) {
    expect(line).toMatch(/^till: (opening|ready|failed|problem [a-z-]+|closed [a-z-]+|new sales stopped|new sales taken again)$/);
  }
  expect(all).not.toMatch(/[0-9a-fA-F]{64}/);
  expect(all).not.toMatch(/cashu[AB][A-Za-z0-9_-]{8,}/);
  for (const v of f.secure.items.values()) {
    if (v.length >= 8) {
      expect(all.includes(v)).toBe(false);
    }
  }
  expect(all.includes('"secret"')).toBe(false);
  expect(all.includes('"C"')).toBe(false);
});
