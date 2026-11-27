import { deserializeProofs, type Proof } from '@cashu/cashu-ts';
import type { HttpFetch } from 'cashucard';
import { sameUrl } from './http';
import { checkLightning, type LightningPlan } from './lightning-transport';
import { normalizeMintInput } from './mint-check';
import { RecoveryActionError } from './recovery-actions';
import type { LightningRecord } from './store/lightning';
import type { OpenStore } from './store/open-store';
import { deliveryProofs } from './wallet';

function unresolved() {
  return new RecoveryActionError('The mint has not confirmed this withdrawal and its remaining takings. Keep the backup and check again.');
}

function observer(http: HttpFetch, mint: string, quote: string): HttpFetch {
  const publicReads = /^\/v1\/(info|keysets|keys(?:\/[a-fA-F0-9]+)?)$/;
  return (url, init) => {
    if (!url.startsWith(mint + '/')) throw unresolved();
    const path = url.slice(mint.length);
    if ((init.method === 'GET' && (path === '/v1/melt/quote/bolt11/' + quote || publicReads.test(path))) ||
        (init.method === 'POST' && (path === '/v1/checkstate' || path === '/v1/restore'))) return http(url, init);
    throw unresolved();
  };
}

/** Bind the encrypted reservation to the exact proofs the transport will ask about. The v4
 * bearer token stores short keyset IDs even where this mint uses full v2 IDs in its plans. */
async function checkedPlan(s: OpenStore, row: LightningRecord): Promise<LightningPlan> {
  const p = JSON.parse(row.plan) as LightningPlan;
  const mint = normalizeMintInput(p.mint);
  if (row.state !== 'submitted' || !mint.ok || !sameUrl(row.mint, mint.url) || !/^[a-zA-Z0-9_-]{1,256}$/.test(p.quoteId) ||
      p.address !== row.address || p.amount !== row.amount || p.inputAmount !== row.inputAmount || p.maxFee !== row.maxFee ||
      p.expiresAt !== row.expiresAt || !Number.isSafeInteger(p.releaseAfter) || p.releaseAfter < p.expiresAt ||
      !Number.isSafeInteger(p.inputFee) || p.inputFee < 0 || typeof p.invoice !== 'string' || !p.invoice ||
      !/^[0-9a-f]{64}$/.test(p.paymentHash) || !Array.isArray(p.inputIds) || !Array.isArray(p.outputs) ||
      !Array.isArray(p.inputs) || !p.inputs.length || !Array.isArray(p.retained)) throw unresolved();
  const metadata = (await s.driver.run('SELECT payment_hash,input_count FROM lightning_payouts WHERE id=?', [row.id])).rows[0];
  const held = (await s.driver.run('SELECT id,mint_norm,unit,amount,token FROM kept WHERE withdrawal=?', ['lightning:' + row.id])).rows;
  const ids = new Set(p.inputIds);
  if (metadata?.payment_hash !== p.paymentHash || !ids.size || ids.size !== p.inputIds.length ||
      ids.size !== held.length || metadata.input_count !== held.length) throw unresolved();
  const fingerprint = (proof: Proof) => JSON.stringify([proof.secret, proof.id.slice(0, 16), proof.C, proof.amount.toString()]);
  const planned = deserializeProofs([...p.inputs, ...p.retained]);
  const proofs = new Set(planned.map(fingerprint));
  if (proofs.size !== planned.length || new Set(planned.map(proof => proof.secret)).size !== planned.length) throw unresolved();
  let amount = 0;
  for (const entry of held) {
    if (!ids.delete(String(entry.id)) || !sameUrl(String(entry.mint_norm), mint.url) || entry.unit !== 'sat') throw unresolved();
    const delivery = { amount: Number(entry.amount), token: String(entry.token) };
    for (const proof of deliveryProofs(delivery, mint.url, 'sat')) if (!proofs.delete(fingerprint(proof))) throw unresolved();
    amount += delivery.amount;
  }
  if (proofs.size || amount !== row.inputAmount) throw unresolved();
  return { ...p, mint: mint.url, reconcileOnly: true };
}

/** Only run in the quarantined restore workflow, before reconcileSnapshot and its atomic activation.
 * The latter checks every newly released input and returned change proof against the mint.
 * No operation here can ask a mint to swap, send money or create a new quote. */
export async function checkRestoredWithdrawals(s: OpenStore, http: HttpFetch, now: () => number): Promise<void> {
  try {
    if ((await s.backups.status()).recovery?.phase !== 'quarantined') throw unresolved();
    for (const original of await s.lightning.active()) {
      let row = original;
      let plan = await checkedPlan(s, row);
      const read = observer(http, plan.mint, plan.quoteId);
      let result = await checkLightning(read, plan, now, true);
      if (result.state === 'reshaped') {
        if (!await s.lightning.finishSplit(row.id, row.plan, result.plan, result.replacement)) throw unresolved();
        const next = await s.lightning.get(row.id);
        if (!next) throw unresolved();
        row = next;
        plan = await checkedPlan(s, row);
        result = await checkLightning(read, plan, now, true);
      }
      if (result.state === 'paid') await s.lightning.paid(row.id, result.change, result.verifiedOverage);
      else if (result.state === 'failed') await s.lightning.failed(row.id);
      else throw unresolved();
    }
  } catch {
    throw unresolved();
  }
}
