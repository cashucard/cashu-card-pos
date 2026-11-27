import type { GateReason } from '../till/gate';

export type Route =
  | { name: 'first-run' }
  | { name: 'sale' }
  | { name: 'card-balance' }
  | { name: 'card-top-up'; cardKey: string }
  | { name: 'topup-receipts' }
  | { name: 'offline-settings' }
  | { name: 'activity' }
  | { name: 'payment'; id: string }
  | { name: 'settings' }
  | { name: 'mints' }
  | { name: 'add-mint'; preset: string | null }
  | { name: 'about' }
  | { name: 'owed' }
  | { name: 'backups'; restore?: boolean }
  | { name: 'records' }
  | { name: 'wallet' };
export type RouteName = Route['name'];

export type MerchantTab = 'sale' | 'activity' | 'wallet' | 'owed';

export interface NavState { stack: Route[] }
export type NavAction =
  | { type: 'push'; route: Route }
  | { type: 'tab'; tab: MerchantTab }
  | { type: 'back' }
  | { type: 'reset'; route: Route }
  | { type: 'replace'; route: Route };

/** The deepest the stack goes; a push beyond it changes nothing. */
export const MAX_DEPTH = 16;
/** Routes entered only after the device check passes, with the check's reason. */
export const GATED: Readonly<Partial<Record<RouteName, GateReason>>> = { mints: 'mints', records: 'records', 'topup-receipts': 'records', wallet: 'wallet' };
/** Where the till starts once it is open: the Welcome with no mint, else the till. */
export function startRoute(mintCount: number): Route {
  return mintCount === 0 ? { name: 'first-run' } : { name: 'sale' };
}

export function navStart(mintCount: number): NavState {
  return { stack: [startRoute(mintCount)] };
}

/** The top of the stack. */
export function current(s: NavState): Route {
  return s.stack[s.stack.length - 1];
}

/** More than one route. */
export function canGoBack(s: NavState): boolean {
  return s.stack.length > 1;
}

/** The same name and the same params. */
export function sameRoute(a: Route, b: Route): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function navReducer(s: NavState, a: NavAction): NavState {
  switch (a.type) {
    case 'push':
      if (sameRoute(current(s), a.route) || s.stack.length >= MAX_DEPTH) {
        return s;
      }
      return { stack: [...s.stack, a.route] };
    case 'tab':
      if (current(s).name === a.tab) return s;
      return { stack: a.tab === 'sale' ? [{ name: 'sale' }] : [{ name: 'sale' }, { name: a.tab }] };
    case 'back':
      if (s.stack.length <= 1) {
        return s;
      }
      return { stack: s.stack.slice(0, -1) };
    case 'reset':
      return { stack: [a.route] };
    case 'replace':
      return { stack: [...s.stack.slice(0, -1), a.route] };
  }
}
