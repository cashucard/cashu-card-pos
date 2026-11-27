import {
  canGoBack,
  current,
  GATED,
  MAX_DEPTH,
  navReducer,
  navStart,
  startRoute,
  type NavState,
} from '../src/app/nav';

describe('nav', () => {
  it('the till starts at the Welcome with no mint, and at the till with one', () => {
    expect(startRoute(0)).toEqual({ name: 'first-run' });
    expect(startRoute(1)).toEqual({ name: 'sale' });
    expect(startRoute(3)).toEqual({ name: 'sale' });
    expect(navStart(0).stack).toHaveLength(1);
  });

  it('push adds a route and back takes it off', () => {
    let s: NavState = navStart(1);
    s = navReducer(s, { type: 'push', route: { name: 'settings' } });
    s = navReducer(s, { type: 'push', route: { name: 'mints' } });
    expect(current(s)).toEqual({ name: 'mints' });
    expect(s.stack).toHaveLength(3);
    expect(canGoBack(s)).toBe(true);
    s = navReducer(s, { type: 'back' });
    expect(current(s)).toEqual({ name: 'settings' });
    s = navReducer(s, { type: 'back' });
    expect(current(s)).toEqual({ name: 'sale' });
    expect(canGoBack(s)).toBe(false);
  });

  it('back at the root changes nothing', () => {
    const s = navStart(1);
    expect(navReducer(s, { type: 'back' })).toBe(s);
  });

  it('a push of the route on top changes nothing', () => {
    const s: NavState = { stack: [{ name: 'sale' }, { name: 'settings' }] };
    expect(navReducer(s, { type: 'push', route: { name: 'settings' } })).toBe(s);

    const withPreset: NavState = { stack: [{ name: 'sale' }, { name: 'add-mint', preset: 'https://mint.test' }] };
    const next = navReducer(withPreset, { type: 'push', route: { name: 'add-mint', preset: null } });
    expect(next).not.toBe(withPreset);
    expect(next.stack).toEqual([
      { name: 'sale' },
      { name: 'add-mint', preset: 'https://mint.test' },
      { name: 'add-mint', preset: null },
    ]);
  });

  it('the stack stops at its depth', () => {
    let s: NavState = navStart(1);
    for (let id = 1; id <= 16; id += 1) {
      s = navReducer(s, { type: 'push', route: { name: 'payment', id: String(id) } });
    }
    expect(s.stack).toHaveLength(MAX_DEPTH);
    expect(navReducer(s, { type: 'push', route: { name: 'payment', id: '17' } })).toBe(s);
  });

  it('reset and replace', () => {
    const s = navStart(1);
    expect(navReducer(s, { type: 'reset', route: { name: 'sale' } }).stack).toEqual([{ name: 'sale' }]);

    const two: NavState = { stack: [{ name: 'sale' }, { name: 'settings' }] };
    expect(navReducer(two, { type: 'replace', route: { name: 'about' } }).stack).toEqual([
      { name: 'sale' },
      { name: 'about' },
    ]);
  });

  it('the state given is never changed', () => {
    const s = navStart(1);
    const before = JSON.stringify(s);
    navReducer(s, { type: 'push', route: { name: 'settings' } });
    navReducer(s, { type: 'push', route: { name: 'sale' } });
    navReducer(s, { type: 'back' });
    navReducer(s, { type: 'reset', route: { name: 'sale' } });
    navReducer(s, { type: 'replace', route: { name: 'about' } });
    expect(JSON.stringify(s)).toBe(before);
  });

  it('tab switches return to Sell in one Back and never restore a protected tab underneath', () => {
    let s = navStart(1);
    for (const tab of ['owed', 'wallet', 'activity', 'wallet', 'owed'] as const) {
      s = navReducer(s, { type: 'tab', tab });
      expect(s.stack).toEqual([{ name: 'sale' }, { name: tab }]);
      expect(navReducer(s, { type: 'tab', tab })).toBe(s);
    }
    expect(navReducer(s, { type: 'back' }).stack).toEqual([{ name: 'sale' }]);
    const sell = navReducer(s, { type: 'tab', tab: 'sale' });
    expect(canGoBack(sell)).toBe(false);
  });

  it('gates mints, top-up receipts, records and the wallet', () => {
    expect(GATED).toEqual({ mints: 'mints', records: 'records', 'topup-receipts': 'records', wallet: 'wallet' });
  });

});
