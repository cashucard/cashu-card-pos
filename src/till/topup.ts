import { Amount, createRandomSecretKey, getPubKeyFromPrivKey, hashToCurve, signMintQuote } from '@cashu/cashu-ts';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  TopupCard,
  topupKeys,
  topupPieces,
  type HttpFetch,
  type CardTransport,
  type TopupKeys,
} from 'cashucard';
import { sameUrl } from './http';
import { verifyMintInvoice } from './lightning-address';
import { lightningJson } from './lightning-http';
import { normalizeMintInput } from './mint-check';
import type { CardReader } from './reader';
import { createSerial, type Serial } from './store/db';
import { TopupStore, topupReceipt, type TopupRecord, type TopupReceipt } from './store/topups';

import { mintObject as object, readMintQuote as quote, requireMinting } from './mint-quote';

function mintUrl(raw: string): string {
  const m = normalizeMintInput(raw);
  if (!m.ok || !sameUrl(m.url, raw)) throw new Error('Use a card from an accepted HTTPS mint.');
  return m.url;
}
function wire(r: TopupRecord, keys: TopupKeys = r.keys) {
  return r.outputs.map(({ amount, B_ }) => ({ id: keys.id, amount, B_ }));
}
type Signature = Parameters<typeof topupPieces>[1][number];

async function restoreSet(
  http: HttpFetch,
  base: string,
  r: TopupRecord,
  keys: TopupKeys,
): Promise<Signature[] | null> {
  const outputs = wire(r, keys);
  const raw = object(await lightningJson(http, base + '/v1/restore', { outputs }));
  const sigs = raw.signatures ?? raw.promises;
  const found = raw.outputs;
  if (!Array.isArray(found) || !Array.isArray(sigs) || sigs.length !== found.length) {
    throw new Error('The original notes could not be recovered yet.');
  }
  if (!sigs.length) return null;
  if (sigs.length !== r.outputs.length) throw new Error('The mint has returned only part of this paid top-up.');
  return outputs.map((x) => {
    const index = found.findIndex((value, i) => {
      const y = object(value);
      // Some mints echo the requested keyset and others return the issued keyset.
      // Verify the signed keyset and amount against the saved outputs and genuine DLEQs below.
      return y.B_ === x.B_ && y.amount === x.amount && (y.id === x.id || y.id === object(sigs[i]).id);
    });
    if (index < 0) throw new Error('The mint returned a different top-up note.');
    return sigs[index];
  });
}

async function readQuote(http: HttpFetch, base: string, r: TopupRecord) {
  const q = quote(await lightningJson(http, base + '/v1/mint/quote/bolt11/' + r.quote), r.pubkey, r.amount);
  if (q.quote !== r.quote || q.request !== r.invoice)
    throw new Error('The mint returned a different invoice. The original is saved.');
  return q;
}

function keepSignatures(r: TopupRecord, keys: TopupKeys, signatures: Signature[]) {
  const outputs = r.outputs.map((o) => ({ ...o, id: keys.id }));
  const pieces = topupPieces(outputs, signatures, keys);
  r.keys = keys;
  r.outputs = outputs;
  r.pieces = pieces;
  delete r.earlierKeys;
  r.state = 'ready';
}

async function recoverIssued(http: HttpFetch, base: string, r: TopupRecord): Promise<boolean> {
  const saved = [r.keys, ...(r.earlierKeys ?? [])];
  for (const keys of saved) {
    const signatures = await restoreSet(http, base, r, keys);
    if (!signatures) continue;
    const issued = saved.find((k) => k.id === signatures[0]?.id);
    if (!issued) throw new Error('The mint returned notes from a different top-up.');
    keepSignatures(r, issued, signatures);
    return true;
  }
  return false;
}

export type TopupTapState = 'waiting' | 'holding' | 'closed';
type TapNotice = (state: TopupTapState) => void;

/** Each row belongs to the holder. It never enters merchant takings or the automatic sweep. */
export class TopupService {
  private readonly serial = createSerial();
  private viewGeneration = 0;
  private closed = false;
  async close(): Promise<void> {
    this.closed = true;
    this.cancelTap();
    await this.serial(async () => {});
  }
  private ensureOpen(): void {
    if (this.closed) throw new Error('The till is closed.');
  }
  get afterScanSheet() {
    return this.reader.afterScanSheet;
  }
  private closeTap: (() => void) | null = null;
  cancelTap(): void {
    this.viewGeneration++;
    this.closeTap?.();
  }
  private checkView(generation: number): void {
    this.ensureOpen();
    if (generation !== this.viewGeneration)
      throw new Error('Card tap cancelled. Your saved top-ups remain available.');
  }
  constructor(
    private store: TopupStore,
    private reader: CardReader,
    private http: HttpFetch,
    private accepts: (mint: string) => boolean,
    private withReader: Serial = createSerial(),
  ) {}

  async list(card?: string): Promise<TopupReceipt[]> {
    this.ensureOpen();
    return this.store.list(card);
  }
  async older(card: string | undefined, before: Pick<TopupReceipt, 'createdAt' | 'id'>): Promise<TopupReceipt[]> {
    this.ensureOpen();
    return this.store.older(card, before);
  }
  enterScreen(): () => void {
    return this.reader.enterSaleScreen?.() ?? (() => {});
  }

  private async tap<T>(
    pin: string,
    expected: { key?: string; mint?: string; group?: string },
    generation: number,
    notify: TapNotice | undefined,
    operation: (card: TopupCard) => Promise<T>,
  ): Promise<T> {
    if (!/^\d{4,8}$/.test(pin)) throw new Error('Enter the card’s four to eight digit PIN.');
    return this.withReader(async () => {
      this.checkView(generation);
      if (!(await this.reader.available())) throw new Error('Turn on NFC to tap this card.');
      const t = this.reader.transport();
      this.checkView(generation);
      const guard: CardTransport = {
        transceive: async (command) => {
          this.checkView(generation);
          const answer = await t.transceive(command);
          this.checkView(generation);
          return answer;
        },
      };
      const cancel = () => {
        void t.end?.().catch(() => undefined);
      };
      this.closeTap = cancel;
      try {
        notify?.('waiting');
        await t.begin?.('Hold the card here for its top-up.');
        notify?.('holding');
        this.checkView(generation);
        const card = await TopupCard.open(
          guard,
          pin,
          (mint) => (expected.mint ? sameUrl(mint, expected.mint) : this.accepts(mint)),
          expected,
        );
        return await operation(card);
      } finally {
        if (this.closeTap === cancel) this.closeTap = null;
        await t.end?.().catch(() => undefined);
        notify?.('closed');
      }
    });
  }

  start(amount: number, pin: string, cardKey?: string, notify?: TapNotice): Promise<TopupReceipt> {
    const generation = this.viewGeneration;
    return this.serial(async () => {
      this.ensureOpen();
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 0xffffffff)
        throw new Error('Enter a positive whole amount the card can hold.');
      const prepared = await this.tap(pin, { key: cardKey }, generation, notify, async (card) => {
        const existing = (await this.store.list(card.key)).find(
          (r) => r.state !== 'expired' && r.state !== 'loaded',
        );
        if (existing) return { existing } as const;
        const mint = mintUrl(card.mint);
        const [keys] = await Promise.all([
          topupKeys(mint, this.http).catch(() => {
            throw new Error('The mint’s active sat keyset could not be verified.');
          }),
          requireMinting(this.http, mint, amount, true),
        ]);
        const outputs = await card.prepare(amount, keys);
        return { mint, key: card.key, rawMint: card.mint, group: card.group, keys, outputs } as const;
      });
      if (prepared.existing) return prepared.existing;
      this.checkView(generation);
      const { mint, keys, outputs } = prepared;
      const privateKey = createRandomSecretKey();
      const pubkey = bytesToHex(getPubKeyFromPrivKey(privateKey));
      const q = quote(
        await lightningJson(this.http, mint + '/v1/mint/quote/bolt11', { amount, unit: 'sat', pubkey }),
        pubkey,
        amount,
      );
      if (q.state !== 'UNPAID') throw new Error('The mint did not issue a fresh unpaid invoice.');
      const checked = verifyMintInvoice(q.request, Date.now());
      const expiresAt = Math.min(checked.expiresAt, q.expiresAt);
      if (
        expiresAt <= Date.now() ||
        checked.sats < amount ||
        (q.paymentHash != null && q.paymentHash !== checked.paymentHash)
      ) {
        throw new Error('The mint returned an expired or mismatched invoice.');
      }
      const r: TopupRecord = {
        id: pubkey,
        cardKey: prepared.key,
        mint: prepared.rawMint,
        group: prepared.group,
        lock: bytesToHex(privateKey),
        pubkey,
        amount,
        total: checked.sats,
        keys,
        outputs,
        quote: q.quote,
        invoice: q.request,
        expiresAt,
        state: 'invoice',
        createdAt: Date.now(),
        attempts: {},
        delivered: [],
        revision: 0,
      };
      // Mint removal and reset use this same app queue. Recheck eligibility and save
      // atomically with respect to those actions before handing out a payable invoice.
      await this.withReader(async () => {
        this.checkView(generation);
        if (!this.accepts(r.mint)) throw new Error('The till no longer accepts this mint.');
        await this.store.insert(r);
      });
      return topupReceipt(r);
    });
  }

  refresh(id: string): Promise<TopupReceipt> {
    return this.serial(async () => {
      this.ensureOpen();
      const r = await this.store.get(id);
      if (r.state === 'loaded' || r.state === 'ready') return topupReceipt(r);
      const base = mintUrl(r.mint);
      let q = await readQuote(this.http, base, r);
      if (q.state === 'UNPAID') {
        if (r.state === 'invoice' && r.expiresAt < Date.now()) {
          r.state = 'expired';
          await this.store.save(r);
        }
        return topupReceipt(r);
      }
      const previouslySubmitted = r.state === 'issuing' || q.state === 'ISSUED';
      if (r.state !== 'issuing') {
        r.state = 'issuing';
        await this.store.save(r);
      }
      if (previouslySubmitted) {
        if (await recoverIssued(this.http, base, r)) {
          await this.store.save(r);
          return topupReceipt(r);
        }
        if (q.state !== 'PAID')
          throw new Error('The mint has issued this top-up. Check again to recover the original notes.');
        // A lost issue response can become visible during restore. Only an explicitly
        // still-paid quote may be retried, always for the same blinded card secrets.
        q = await readQuote(this.http, base, r);
        if (q.state !== 'PAID')
          throw new Error('The mint is updating this top-up. Check again to recover the original notes.');
      }

      const active = await topupKeys(base, this.http);
      if (active.id !== r.keys.id) {
        if (r.outputs.some((o) => !active.keys[String(o.amount)]))
          throw new Error(
            'The mint’s new keys cannot issue the saved note amounts. Your paid top-up is saved.',
          );
        const history = [r.keys, ...(r.earlierKeys ?? [])];
        r.earlierKeys = history.filter((k) => k.id !== active.id);
        r.outputs = r.outputs.map((o) => ({ ...o, id: active.id }));
        r.keys = active;
        await this.store.save(r);
      }
      const outputs = wire(r);
      const signature = signMintQuote(
        r.lock,
        r.quote,
        outputs.map((o) => ({ ...o, amount: Amount.from(o.amount) })),
      );
      const issued = object(
        await lightningJson(this.http, base + '/v1/mint/bolt11', { quote: r.quote, outputs, signature }),
      );
      if (!Array.isArray(issued.signatures)) throw new Error('The original notes are still being recovered.');
      keepSignatures(r, active, issued.signatures);
      await this.store.save(r);
      return topupReceipt(r);
    });
  }

  load(id: string, pin: string, notify?: TapNotice): Promise<TopupReceipt> {
    const generation = this.viewGeneration;
    return this.serial(async () => {
      this.ensureOpen();
      const r = await this.store.get(id);
      if (r.state === 'loaded') return topupReceipt(r);
      if (r.state !== 'ready' || !r.pieces)
        throw new Error('Check the Lightning payment before tapping the card.');
      const pieces = r.pieces;
      const Ys = r.outputs.map((o) => hashToCurve(utf8ToBytes(o.secret)).toHex(true));
      const response = object(await lightningJson(this.http, mintUrl(r.mint) + '/v1/checkstate', { Ys }));
      const states = response.states;
      if (
        !Array.isArray(states) ||
        states.length !== Ys.length ||
        Ys.some((Y) => states.filter((s) => s.Y === Y).length !== 1)
      ) {
        throw new Error('The mint could not verify the original notes. Check again when online.');
      }
      return this.tap(pin, { key: r.cardKey, mint: r.mint, group: r.group }, generation, notify, async (card) => {
        await card.teach(r.keys);
        for (const [i, p] of pieces.entries()) {
          if (r.delivered.includes(p.nonce)) continue;
          const prior = r.attempts[p.nonce];
          const state = states.find((s) => s.Y === Ys[i]).state;
          // Only the card can authorize spending this note. A spent note with a prior write
          // intent has already reached the customer, even if the NFC response was lost.
          const alreadySpent = state === 'SPENT' && !!prior;
          if (!alreadySpent && state !== 'UNSPENT') {
            throw new Error('One of the original notes is pending or unavailable. The top-up is saved.');
          }
          if (!alreadySpent && !(await card.hasPiece(p))) {
            const checkpoint = await card.checkpoint();
            if (prior && (checkpoint.clock !== prior.clock || checkpoint.remaining !== prior.remaining)) {
              throw new Error('An earlier card write is still unresolved. Keep this receipt and check again.');
            }
            r.attempts[p.nonce] = checkpoint;
            await this.store.save(r);
            await card.write(p);
          }
          r.delivered.push(p.nonce);
          await this.store.save(r);
        }
        r.state = 'loaded';
        // Finished receipts have no need for the quote signing secret or the note blinding factors.
        r.lock = '';
        r.outputs = [];
        r.attempts = {};
        r.delivered = [];
        delete r.pieces;
        await this.store.save(r);
        return topupReceipt(r);
      });
    });
  }
}
