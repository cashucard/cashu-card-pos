import type { HttpFetch } from 'cashucard';
import { normalizeUrl, sameUrl } from './http';
import {
  checkLightning, LightningFundsError, LightningTransportError, normalizeLightningAddress, prepareLightning, submitLightning,
  type LightningPlan, type LightningResult,
} from './lightning-transport';
import type { LightningStore, LightningRecord, LightningSummary } from './store/lightning';

export interface SweepPolicy {
  address: string;
  threshold: number;
  maxFee: number;
}

export interface LightningPayment {
  id: string;
  address: string;
  amount: number;
  maxFee: number;
  /** Includes the provider's quoted reserve and the selected mint input fees. */
  quotedFee?: number;
  expiresAt: number;
  automatic: boolean;
  status: 'quoted' | 'pending' | 'paid' | 'failed';
  feePaid?: number;
  description?: string;
}

export interface LightningState {
  policy: SweepPolicy | null;
  payment: LightningPayment | null;
  sweepNotice?: string;
}

export interface LightningWallet {
  state(mint: string): Promise<LightningState>;
  configure(mint: string, policy: SweepPolicy | null): Promise<void>;
  quote(mint: string, address: string, amount: number): Promise<LightningPayment>;
  confirm(mint: string, id: string): Promise<LightningPayment>;
  cancel(mint: string, id: string): Promise<void>;
  refresh(mint: string): Promise<LightningState>;
}

// Only these merchant-facing errors may be rendered. Provider replies can include private payment data.
export class LightningWalletError extends Error {}

const MAX_SATS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
function sats(n: number, minimum: number): boolean {
  return Number.isSafeInteger(n) && n >= minimum && n <= MAX_SATS;
}

function destination(input: string): string {
  try {
    return normalizeLightningAddress(input);
  } catch {
    throw new LightningWalletError('Enter a Lightning address such as name@example.com.');
  }
}

function summary(r?: LightningRecord | LightningSummary | null): LightningPayment | null {
  if (!r || r.state === 'cancelled') return null;
  const description = r.state === 'quoted' && 'plan' in r ? (JSON.parse(r.plan) as LightningPlan).description : undefined;
  return {
    id: r.id, address: r.address, amount: r.amount, automatic: r.automatic,
    maxFee: r.maxFee, quotedFee: r.quotedFee, expiresAt: r.expiresAt,
    status: r.state === 'submitted' ? 'pending' : r.state,
    ...(description ? { description } : {}),
    ...(r.fee === null ? {} : { feePaid: r.fee }),
  };
}

const protocol = { prepare: prepareLightning, submit: submitLightning, check: checkLightning };

interface LightningDeps {
  ledger: LightningStore;
  http: HttpFetch;
  now: () => number;
  newId: () => string;
  /** New sweeps require an accepted mint and the foreground till. Status checks need no authorization to spend. */
  acceptsMint: (mint: string) => boolean;
  inForeground: () => boolean;
  protocol?: typeof protocol;
}

export function createLightningWallet(d: LightningDeps): LightningWallet & { tick(): Promise<void>; close(): Promise<void> } {
  const ledger = d.ledger;
  const wire = d.protocol ?? protocol;
  const notices = new Map<string, string>();
  const running = new Set<Promise<unknown>>();
  let pass: Promise<void> | null = null;
  let closed = false;

  function mintKey(value: string): string {
    const key = normalizeUrl(value);
    if (!key || !key.startsWith('https://')) throw new LightningWalletError('Choose a wallet mint.');
    return key;
  }

  function operation<T>(work: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new LightningWalletError('Reopen Wallet to continue.'));
    const promise = Promise.resolve().then(work);
    running.add(promise);
    const done = () => { running.delete(promise); };
    promise.then(done, done);
    return promise;
  }

  async function state(mint: string): Promise<LightningState> {
    await ledger.expireQuotes();
    const policy = (await ledger.policies()).find(p => p.mint === mint);
    const [last] = await ledger.recent(mint);
    const detail = last?.state === 'quoted' ? await ledger.get(last.id) : last;
    return {
      policy: policy ? { address: policy.address, maxFee: policy.maxFee, threshold: policy.threshold } : null,
      payment: summary(detail), sweepNotice: notices.get(mint),
    };
  }

  async function record(mint: string, id: string): Promise<LightningRecord> {
    const row = await ledger.get(id);
    if (!row || row.mint !== mint) throw new LightningWalletError('This withdrawal is no longer available.');
    return row;
  }

  async function currentPayment(mint: string, id: string): Promise<LightningPayment> {
    const payment = summary(await record(mint, id));
    if (!payment) throw new LightningWalletError('This quote has closed. Request a new quote.');
    return payment;
  }

  async function prepare(mint: string, address: string, amount: number, policy?: SweepPolicy) {
    if (!sats(amount, 1)) throw new LightningWalletError('Enter a positive amount in whole sats.');
    await ledger.expireQuotes();
    const existing = (await ledger.active()).find(p => p.mint === mint);
    if (existing) {
      if (!policy && !existing.automatic && existing.state === 'quoted' &&
          existing.address === address && existing.amount === amount) return summary(existing)!;
      throw new LightningWalletError('Finish or cancel the current withdrawal at this mint first.');
    }
    const rows = await ledger.available(mint);
    if (amount > rows.reduce((n, row) => n + row.amount, 0)) {
      throw new LightningWalletError('There are not enough available sats at this mint.');
    }
    let plan: LightningPlan;
    try {
      plan = await wire.prepare(d.http, { mint, address, amount, rows, now: d.now, feeCap: policy?.maxFee });
    } catch (e) {
      if (e instanceof LightningFundsError) throw new LightningWalletError('The available takings cannot cover this amount and its fees.');
      if (e instanceof LightningTransportError) throw new LightningWalletError(e.message);
      throw new LightningWalletError('Could not get a payable quote. Check the address, amount and mint.');
    }
    if (!sameUrl(plan.mint, mint) || plan.address !== address || plan.amount !== amount ||
        !sats(plan.maxFee, 0) || plan.expiresAt <= d.now()) {
      throw new LightningWalletError('The quote changed or expired. Request a fresh quote.');
    }
    if (policy && plan.maxFee > policy.maxFee) throw new LightningWalletError('The quoted fees exceed your sweep fee limit.');
    if (closed || (policy && !d.inForeground())) throw new LightningWalletError('Open the till to continue.');
    const id = d.newId();
    await ledger.reserve({
      id, mint, address, amount, maxFee: plan.maxFee, expiresAt: plan.expiresAt,
      quotedFee: plan.quoteReserve === undefined ? plan.maxFee : plan.quoteReserve + plan.inputFee,
      automatic: !!policy, inputIds: plan.inputIds, plan: JSON.stringify(plan), paymentHash: plan.paymentHash,
    });
    return currentPayment(mint, id);
  }

  async function apply(row: LightningRecord, result: LightningResult): Promise<boolean> {
    const id = row.id;
    if (result.state === 'reshaped') return ledger.finishSplit(id, row.plan, result.plan, result.replacement);
    if (result.state === 'paid') await ledger.paid(id, result.change, result.verifiedOverage);
    if (result.state === 'failed') await ledger.failed(id);
    return false;
  }

  async function reconcile(row: LightningRecord): Promise<void> {
    if (row.state !== 'submitted') return;
    try {
      await apply(row, await wire.check(d.http, JSON.parse(row.plan), d.now));
    } catch {
      // A lost response, unavailable mint, or incomplete change leaves all inputs reserved.
    }
  }

  async function send(mint: string, id: string, automatic: boolean): Promise<LightningPayment> {
    const row = await record(mint, id);
    if (row.state !== 'quoted') return currentPayment(mint, id);
    if (row.automatic !== automatic) throw new LightningWalletError('Check the existing withdrawal in Wallet.');
    const maySend = () => !closed && d.inForeground() && (!automatic || d.acceptsMint(mint));
    if (!maySend()) {
      throw new LightningWalletError('Open the till to continue.');
    }
    const plan: LightningPlan = JSON.parse(row.plan);
    // Only the winner of the durable transition may POST. All later callers only read status.
    if (await ledger.start(id, row.plan)) {
      if (!maySend()) {
        await ledger.abandonBeforePost(id);
        throw new LightningWalletError('Open the till and request a fresh quote.');
      }
      try {
        const reshaped = await apply(row, await wire.submit(d.http, plan, d.now));
        // Both authorizations run again after accounting for the swap. The new plan uses the
        // original quote and contains only proofs whose face value fits the approved cap.
        if (reshaped && maySend()) return send(mint, id, automatic);
      }
      catch { /* The original quote will be checked after reconnecting. */ }
    }
    return currentPayment(mint, id);
  }

  async function sweep(mint: string, policy: SweepPolicy) {
    if (!d.inForeground() || !d.acceptsMint(mint) || closed) return;
    const available = (await ledger.available(mint)).reduce((n, row) => n + row.amount, 0);
    const excess = available - policy.threshold;
    if (excess <= 0) { notices.delete(mint); return; }
    // Reserve the approved fee budget above the floor too. Unused fees stay on the phone.
    const amount = excess - policy.maxFee;
    if (amount <= 0) {
      notices.set(mint, 'Waiting for takings above the amount to keep and the sweep fee allowance.');
      return;
    }
    const pay = await prepare(mint, policy.address, amount, policy);
    await send(mint, pay.id, true);
    notices.delete(mint);
  }

  async function sweepPass(): Promise<void> {
    if (!d.inForeground()) return;
    await ledger.expireQuotes();
    const active = await ledger.active();
    const occupied = new Set(active.map(p => p.mint));
    for (const row of active) {
      if (closed || !d.inForeground()) return;
      try {
        if (row.state === 'submitted') await reconcile(row);
        else if (row.automatic && d.acceptsMint(row.mint)) await send(row.mint, row.id, true);
      } catch {
        notices.set(row.mint, 'Check this withdrawal in Wallet.');
      }
    }
    for (const policy of await ledger.policies()) {
      if (occupied.has(policy.mint)) continue;
      try { await sweep(policy.mint, policy); }
      catch (e) {
        notices.set(policy.mint, e instanceof LightningWalletError ? e.message : 'Automatic sweep is waiting. Check the wallet again shortly.');
      }
    }
  }

  function tick(): Promise<void> {
    if (pass) return pass;
    const started = operation(sweepPass);
    pass = started;
    const done = () => { pass = null; };
    started.then(done, done);
    return started;
  }

  return {
    state: mint => operation(() => state(mintKey(mint))),
    quote: (mint, address, amount) => operation(() => prepare(mintKey(mint), destination(address), amount)),
    confirm: (mint, id) => operation(() => send(mintKey(mint), id, false)),
    cancel: (mint, id) => operation(async () => {
      const row = await record(mintKey(mint), id);
      if (row.state === 'cancelled') return;
      if (row.state !== 'quoted') throw new LightningWalletError('This withdrawal was already sent. Check its status.');
      await ledger.cancel(id);
    }),
    refresh: mint => operation(async () => {
      const key = mintKey(mint);
      const active = (await ledger.active()).find(row => row.mint === key);
      if (active) await reconcile(active);
      return state(key);
    }),
    configure: (mint, policy) => operation(async () => {
      const key = mintKey(mint);
      if (policy) {
        if (!d.acceptsMint(key)) throw new LightningWalletError('Add and check this mint before enabling automatic sweeps.');
        if (!sats(policy.threshold, 0) || !sats(policy.maxFee, 0)) throw new LightningWalletError('Use whole sats for the amount to keep and the fee limit.');
        await ledger.setPolicy(key, destination(policy.address), policy.threshold, policy.maxFee);
      } else {
        await ledger.disablePolicy(key);
      }
      notices.delete(key);
      if (policy) void tick().catch(() => undefined);
    }),
    tick,
    async close() {
      closed = true;
      await Promise.allSettled([...running]);
    },
  };
}
