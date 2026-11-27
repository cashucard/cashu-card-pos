import { Amount, OutputData, deserializeProofs, getEncodedToken, hashToCurve, serializeProofs, verifyDleqIfPresent } from '@cashu/cashu-ts';
import type { Proof, SerializedOutputData, Wallet } from '@cashu/cashu-ts';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import type { HttpFetch } from 'cashucard';
import { lightningJson, LightningTransportError } from './lightning-http';
import type { LightningPlan, LightningResult } from './lightning-transport';
import { checkStates } from './wallet';

export interface LightningSplit {
  /** All NUT-03 outputs in request order. The first sendCount proofs will fund the original melt. */
  outputs: SerializedOutputData[];
  sendCount: number;
}

export function planSplit(wallet: Wallet, source: Proof[], target: number, value: number): LightningSplit {
  const keys = wallet.keyChain.getCheapestKeyset();
  if (!keys.verify() || keys.fee !== 0 || !wallet.getFeesForProofs(source).isZero()) {
    throw new LightningTransportError('This mint charges for making change. Choose an amount the available notes can cover within the fee limit.');
  }
  const send = OutputData.createRandomData(target, keys);
  const keep = OutputData.createRandomData(value - target, keys);
  const outputs = [...send, ...keep];
  if (!send.length || !keep.length || OutputData.sumOutputAmounts(send).toNumber() !== target ||
      OutputData.sumOutputAmounts(outputs).toNumber() !== value) throw new Error();
  return { outputs: outputs.map(o => OutputData.serialize(o)), sendCount: send.length };
}

export function toMintInputs(proofs: Proof[]) {
  return proofs.map(p => ({
    amount: p.amount.toNumber(), id: p.id, secret: p.secret, C: p.C,
    ...(p.witness ? { witness: p.witness } : {}),
  }));
}

const blinded = (o: SerializedOutputData) => ({ ...o.blindedMessage, amount: Number(o.blindedMessage.amount) });

interface Signature { id: string; amount: number; C_: string; dleq?: { e: string; s: string } }
interface SwapReply { signatures?: Signature[] }
interface RestoreReply extends SwapReply { outputs?: Array<ReturnType<typeof blinded>> }

async function restoredSwap(http: HttpFetch, mint: string, split: LightningSplit): Promise<Signature[]> {
  const restore = await lightningJson(http, mint + '/v1/restore', { outputs: split.outputs.map(blinded) }) as RestoreReply | null;
  if (!restore || !Array.isArray(restore.outputs) || !Array.isArray(restore.signatures) ||
      restore.outputs.length !== restore.signatures.length) throw new Error();
  if (!restore.outputs.length) return [];
  if (restore.outputs.length !== split.outputs.length) throw new Error();
  const answers = new Map(restore.outputs.map((o, i) => [o.B_, { o, sig: restore.signatures![i] }]));
  return split.outputs.map(raw => {
    const original = blinded(raw);
    const answer = answers.get(original.B_);
    if (!answer || answer.o.id !== original.id || answer.o.amount !== original.amount) throw new Error();
    answers.delete(original.B_);
    return answer.sig;
  });
}

/** An interrupted swap can only recover or re-present precisely the same inputs and blinded outputs.
 * The mint's one-use inputs make that operation idempotent. A partial restore cannot restart a swap. */
export async function splitLightning(http: HttpFetch, mint: string, plan: LightningPlan,
  walletForMint: () => Promise<Wallet>, recover: boolean, unissued?: () => Promise<LightningResult>, quarantined = false): Promise<LightningResult> {
  const split = plan.split!;
  const old = deserializeProofs(plan.inputs);
  const retained = deserializeProofs(plan.retained);
  const wallet = await walletForMint();
  const keysetId = split.outputs[0]?.blindedMessage.id;
  if (!keysetId || !Number.isSafeInteger(split.sendCount) || split.sendCount < 1 ||
      split.sendCount >= split.outputs.length) throw new Error();
  await wallet.ensureOperableKeysets([keysetId, ...old.map(p => p.id)]);
  const keys = wallet.keyChain.getKeyset(keysetId);
  // After a rotation a retired set may still verify already-issued outputs. Never issue new outputs
  // against it, or allow a changed fee schedule to turn a free internal swap into a withdrawal fee.
  if (!keys.verify() || !wallet.getFeesForProofs(old).isZero() || keys.fee !== 0) throw new Error();
  const outputs = split.outputs.map(blinded);
  if (outputs.some(o => o.id !== keysetId || !Number.isSafeInteger(o.amount) || o.amount <= 0) ||
      new Set(outputs.map(o => o.B_)).size !== outputs.length ||
      outputs.reduce((n, o) => n + o.amount, 0) !== old.reduce((n, p) => n + p.amount.toNumber(), 0) ||
      outputs.slice(0, split.sendCount).reduce((n, o) => n + o.amount, 0) !== plan.amount + plan.maxFee) throw new Error();

  let signatures = recover ? await restoredSwap(http, mint, split) : [];
  if (!signatures.length) {
    if (recover) {
      const ys = old.map(p => hashToCurve(utf8ToBytes(p.secret)).toHex(true));
      const states = await checkStates(http, mint, ys);
      if (!ys.every(y => states.get(y) === 'UNSPENT')) return { state: 'pending' };
    }
    if (plan.reconcileOnly) return unissued ? unissued() : { state: 'pending' };
    if (!keys.isActive) return { state: 'pending' };
    const result = await lightningJson(http, mint + '/v1/swap', { inputs: toMintInputs(old), outputs }) as SwapReply | null;
    if (!result || !Array.isArray(result.signatures)) throw new Error();
    signatures = result.signatures;
  }
  if (signatures.length !== outputs.length) throw new Error();
  const proofs = split.outputs.map((o, i) => {
    const sig = signatures[i];
    if (!sig || !sig.dleq || sig.id !== keysetId || sig.amount !== outputs[i].amount) throw new Error();
    const proof = OutputData.deserialize(o).toProof({ ...sig, amount: Amount.from(sig.amount) }, keys);
    if (!proof.dleq || !verifyDleqIfPresent(proof, keys)) throw new Error();
    return proof;
  });
  const all = [...proofs, ...retained];
  if (new Set(all.map(p => p.secret)).size !== all.length ||
      all.reduce((n, proof) => n + proof.amount.toNumber(), 0) !== plan.inputAmount) throw new Error();
  // The issuance and input spend are inseparable. Independently confirm the source spend before
  // changing the ledger. A restored database might also postdate a melt of the replacement notes.
  const y = (p: Proof) => hashToCurve(utf8ToBytes(p.secret)).toHex(true);
  const oldYs = old.map(y);
  const newYs = proofs.map(y);
  // Other notes from the same original delivery did not enter the swap. A restored wallet
  // can predate spending them too. Only credit the replacement if they are still spendable.
  const retainedYs = recover ? retained.map(y) : [];
  const states = await checkStates(http, mint, [...oldYs, ...newYs, ...retainedYs]);
  // In recovery an already spent retained proof is evidence of newer activity on the retired
  // phone. Keep it quarantined until the complete receipt and remaining takings are reconciled.
  const retainedKnown = [...newYs.slice(split.sendCount), ...retainedYs].every(id => {
    const state = states.get(id);
    return state === 'UNSPENT' || (quarantined && plan.reconcileOnly && state === 'SPENT');
  });
  if (!oldYs.every(id => states.get(id) === 'SPENT') || !retainedKnown) return { state: 'pending' };
  const reconcileOnly = plan.reconcileOnly || !newYs.slice(0, split.sendCount).every(id => states.get(id) === 'UNSPENT');
  const { split: _done, ...original } = plan;
  const next: LightningPlan = {
    ...original, ...(reconcileOnly && { reconcileOnly: true }),
    inputs: serializeProofs(proofs.slice(0, split.sendCount)),
    retained: serializeProofs([...retained, ...proofs.slice(split.sendCount)]),
  };
  return { state: 'reshaped', plan: next, replacement: {
    amount: plan.inputAmount, token: getEncodedToken({ mint, unit: 'sat', proofs: all }),
  } };
}
