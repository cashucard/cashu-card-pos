/* The sale's controller: it runs the machine's effects through the till service, turns the library's callbacks into the
 * machine's events, and holds what the machine must not: the pending answers to confirm and askPin, the take's
 * AbortController, the one running wait, and the PIN's digits from the first key until they are handed to the library.
 * The digits live in one variable here and in the answer to the library: never in a state, an event, a report or a log.
 * This file logs nothing. */

import { CardError, OFFLINE_LIMITS, type CardConfirmation, type CardListener, type CardTransport, type Payment } from 'cashucard';
import { isPaid } from './payment-words';
import { LightningPaymentReceived, LightningStatusUnknown } from './lightning-sale';
import type { DeviceNetworkStatus } from './device-network';
import type { CardReader } from './reader';
import type { TillQueue } from './queue';
import { continuousSale, withinApprovedTotal } from './continuous-sale';
import { PIN_LEAST, PIN_MOST, PIN_WAIT_MS, SALE_START, saleStep, timerFor, type SaleEffect, type SaleEvent, type SaleState, type SaleStep } from './sale-machine';
import type { TillService } from './service';
import { cancelledError, tapSession, type TapSession } from './tap-session';

export const NO_READER_MESSAGE = 'This phone cannot read a card now. Nothing was taken.';
export const STILL_TAKING_MESSAGE = 'A card payment is still running. Nothing was withdrawn.';

/** What the screen sends. The PIN pad's digits go only here (pin-digit), never into the machine. */
export type SaleInput =
  | { type: 'digit'; d: string } | { type: 'key-back' } | { type: 'key-clear' } | { type: 'charge' }
  | { type: 'pay' } | { type: 'decline' } | { type: 'review-first' }
  | { type: 'pin-digit'; d: string } | { type: 'pin-back' } | { type: 'pin-ok' } | { type: 'pin-cancel' }
  | { type: 'cancel' } | { type: 'retry' } | { type: 'other-way' } | { type: 'withdraw-yes' } | { type: 'withdraw-no' }
  | { type: 'new' };

export interface Timers {
  set(f: () => void, ms: number): unknown;
  clear(h: unknown): void;
}
export interface SaleControllerDeps {
  /** `leaveSale` (slice 2.3b): told when the screen lets its sale go (New sale, or the screen left); absent: not told.
   * `salesStopped` (slice 2.4): asked at every Try again and Hold the card again; absent: never stopped */
  service: Pick<TillService, 'openSale' | 'takeCard' | 'withdrawSale'> &
    Partial<Pick<TillService, 'lightningOffer' | 'leaveSale' | 'salesStopped' | 'hasReadyOfflineMint' | 'takeOfflineCard'>>;
  /** the till's queue, read to tell the merchant when a card job waits behind other work; absent: never told */
  queue?: Pick<TillQueue, 'running' | 'waiting'>;
  reader: CardReader;
  initialDigits?: string;
  networkStatus?: () => Promise<DeviceNetworkStatus>;
  /** called with every new state (not at once) */
  onState: (s: SaleState) => void;
  /** default: setTimeout and clearTimeout */
  timers?: Timers;
  /** the sale machine; default saleStep. Only tests pass their own, to reach the controller's own guards. */
  step?: (s: SaleState, e: SaleEvent) => SaleStep;
}
export interface SaleController {
  state(): SaleState;
  holdWallet(saleId: string): boolean;
  releaseWallet(saleId: string): void;
  walletPaid(saleId: string, rail: 'Lightning' | 'Cashu'): void;
  walletExtra(saleId: string): void;
  invoiceUnpaid(saleId: string): void;
  walletProcessing(saleId: string): void;
  input(i: SaleInput): void;
  /** a payment the till now holds (slice 1.3's settle calls this) */
  settled(p: Payment): void;
  /** the screen has gone: stop the wait, answer what is asked with no, abort a tap that has no card */
  dispose(): void;
  /** whether a take is running now */
  taking(): boolean;
  /** Drop local PIN entry and unused advance approval when the app leaves the foreground. */
  background(): void;
  foreground(): void;
  /** whether any digit of a PIN is held now (never how many) */
  pinHeld(): boolean;
}

export function createSaleController(d: SaleControllerDeps): SaleController {
  let state: SaleState = d.initialDigits ? { kind: 'keypad', digits: d.initialDigits } : SALE_START;
  let digits = '';
  let approval: { sats: number; pin: string; expires: number } | null = null;
  let approvalTimer: unknown = null;
  let stopPreparedOnBackground = false;
  let pendingConfirm: ((a: { pay: boolean; pin?: string }) => void) | null = null;
  let pendingPin: ((pin: string | null) => void) | null = null;
  let abort: AbortController | null = null;
  let session: TapSession | null = null;
  /** takes started so far; the running take's number, 0 for none; whether it has reached the reader's begin */
  let takes = 0;
  let current = 0;
  let began = false;
  /** sales asked to open so far: only the last one's answer reaches the machine */
  let opens = 0;
  let walletHold: string | null = null;
  let issuingFor: string | null = null;
  const sharedCheckout = d.reader.kind !== 'card simulator' && typeof d.service.lightningOffer === 'function';
  let networkCheck = 0;
  let offlineSaleId: string | null = null;
  const earlySettlement = new Map<string, Payment>();
  let withdrawRunning = false;
  let timer: unknown = null;
  let timerKey: string | null = null;
  let disposed = false;
  let backgrounded = false;
  const timers: Timers = d.timers ?? {
    set: (f, ms) => setTimeout(f, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const step = d.step ?? saleStep;

  function clearApproval(): void {
    approval = null;
    if (approvalTimer !== null) timers.clear(approvalTimer);
    approvalTimer = null;
  }

  /** Answers every question the library holds: the sheet with no, the PIN pad with none. */
  function answerNo(): void {
    const c = pendingConfirm;
    pendingConfirm = null;
    c?.({ pay: false });
    const p = pendingPin;
    pendingPin = null;
    p?.(null);
  }

  /** Whether another job runs, or waits ahead of the one just asked (waiting() counts that one too). */
  function behind(): boolean {
    return d.queue !== undefined && (d.queue.running() !== null || d.queue.waiting() > 1);
  }

  /** The wait the new state runs, or none: a change of key starts it again. */
  function restartTimer(): void {
    const t = timerFor(state);
    const key = t ? t.key : null;
    if (key === timerKey) return;
    if (timer !== null) timers.clear(timer);
    timer = null;
    timerKey = key;
    if (t !== null) {
      timer = timers.set(() => {
        timer = null;
        timerKey = null;
        send({ type: 'timeout' });
      }, t.ms);
    }
  }

  /** The card's take: the reader, the session, the service, and the library's own questions. Everything it sends is
   * dropped once it is no longer the running take (`mine !== current`): a take let go before it reached the reader. */
  function startTake(saleId: string): void {
    if (current !== 0) return;
    takes += 1;
    const mine = takes;
    current = mine;
    began = false;
    earlySettlement.clear();
    const prepared = approval !== null;
    const offline = saleId === offlineSaleId;
    const price = state.kind === 'tap' ? state.sats : 0;
    stopPreparedOnBackground = prepared;
    const controller = new AbortController();
    abort = controller;
    const live = (): boolean => current === mine;
    void (async (): Promise<void> => {
      let contact: ReturnType<typeof continuousSale> | undefined;
      try {
        let there = false;
        try {
          there = await d.reader.available();
        } catch {
          there = false;
        }
        if (!live()) return;
        if (!there) throw new CardError('no-reader', NO_READER_MESSAGE);
        let inner: CardTransport;
        try {
          inner = d.reader.transport();
        } catch {
          throw new CardError('no-reader', NO_READER_MESSAGE);
        }
        const mySession = tapSession(inner, {
          signal: controller.signal,
          onWait: () => {
            if (!live()) return;
            began = true;
            send({ type: 'card-wait' });
          },
          onCard: () => {
            if (live()) send({ type: 'card-here' });
          },
        });
        session = mySession;
        contact = prepared ? continuousSale(mySession) : undefined;
        const listener: CardListener = {
          confirm: async (c: CardConfirmation): Promise<{ pay: boolean; pin?: string }> => {
            if (disposed || backgrounded || !live() || controller.signal.aborted) return { pay: false };
            if (offline && (c.change !== 'none' || !withinApprovedTotal(c, price))) {
              return { pay: false };
            }
            if (contact?.betweenReads()) {
              const approved = approval;
              clearApproval();
              if (!approved || Date.now() >= approved.expires) return { pay: false };
              if (withinApprovedTotal(c, approved.sats) && (!(offline || c.pinNeeded) || approved.pin)) {
                contact.approveCurrentContact();
                return offline || c.pinNeeded ? { pay: true, pin: approved.pin } : { pay: true };
              }
              // iOS presents a system sheet while NFC is active. Close it so the
              // holder can see and accept this actual quote or supply a required PIN.
              await contact.release('Review the payment on the phone.');
              if (disposed || backgrounded || !live() || controller.signal.aborted) return { pay: false };
            }
            clearApproval();
            return new Promise<{ pay: boolean; pin?: string }>((res) => {
              pendingConfirm = res;
              send({ type: 'confirm-asked', c: offline ? { ...c, pinNeeded: true } : c });
            });
          },
          askPin: (a): Promise<string | null> => {
            if (disposed || backgrounded || !live() || controller.signal.aborted) return Promise.resolve(null);
            // An earlier sale's recovery runs before this mint and quote are checked.
            // Leave its optional PIN recovery to the manual route.
            if (prepared && a.why === 'recover') return Promise.resolve(null);
            return new Promise<string | null>((res) => {
              if (prepared) stopPreparedOnBackground = true;
              pendingPin = entry => {
                if (entry !== null) contact?.allowFreshPinRetry();
                res(entry);
              };
              send({ type: 'pin-asked', why: a.why ?? 'allowance', wrong: a.wrong, tries: a.tries });
            });
          },
          onStage: (stage, words) => {
            if (live()) {
              // After signing starts the journal and the existing recovery flow own the outcome.
              if (stage === 'signing') stopPreparedOnBackground = false;
              send({ type: 'stage', stage, words });
            }
          },
          signal: controller.signal,
        };
        const transport = contact?.transport ?? mySession;
        const take = offline ? d.service.takeOfflineCard : d.service.takeCard;
        if (!take) throw new CardError('bad-sale', 'Offline payments are unavailable.');
        const job = take.call(d.service, saleId, transport, listener);
        // another job runs, or waits ahead of this card job: the tap waits for it, and says so
        if (live() && behind()) {
          send({ type: 'queued' });
        }
        const payment = await job.finally(async () => {
          // Closing a failed native session must not replace the SDK's payment or recovery result.
          try { await contact?.release('Card scan finished.'); } catch { /* session already gone */ }
        });
        if (finishTake(mine)) {
          send({ type: 'done', payment });
          applyEarlySettlement();
        }
      } catch (error) {
        if (finishTake(mine)) {
          const receipt = error instanceof LightningPaymentReceived ? error.receipt : null;
          if (error instanceof LightningStatusUnknown && error.saleId === saleId) {
            send({type: 'check-original-invoice', saleId});
          } else if (receipt?.saleId === saleId && (receipt.state === 'paid' || receipt.state === 'extra' || receipt.state === 'processing')) {
            send({ type: 'invoice-received', saleId, state: receipt.state });
          } else send({ type: 'failed', error });
          applyEarlySettlement();
        }
      }
    })();
  }

  // Settlement can finish while the NFC sheet is still closing. Once the card result
  // names its receipt, the state machine can match it to the settlement we heard.
  function applyEarlySettlement(): void {
    for (const payment of earlySettlement.values()) send({ type: 'settled', payment });
    earlySettlement.clear();
  }

  /** Take `mine` is over: no card is being read, and no question is left open. False when it was let go already. */
  function finishTake(mine: number): boolean {
    if (current !== mine) return false;
    current = 0;
    stopPreparedOnBackground = false;
    began = false;
    abort = null;
    session = null;
    clearApproval();
    answerNo();
    return true;
  }

  function checkNetwork(): void {
    const networkStatus = d.networkStatus;
    if (state.kind !== 'preflight' || state.mode !== 'detecting' || !networkStatus) return;
    const mine = ++networkCheck;
    const sats = state.sats;
    const currentCheck = () => mine === networkCheck && !disposed && !backgrounded &&
      state.kind === 'preflight' && state.mode === 'detecting';
    void (async () => {
      let connection: DeviceNetworkStatus = 'unknown';
      try { connection = await networkStatus(); } catch { /* keep regular checkout */ }
      if (!currentCheck()) return;
      const offline = connection === 'offline';
      if (offline) {
        if (sats > OFFLINE_LIMITS.sale) throw new CardError('bad-sale', 'Offline payments can be up to ' + OFFLINE_LIMITS.sale + ' sats. Reconnect for this amount.');
        if (!d.service.takeOfflineCard || !await d.service.hasReadyOfflineMint?.()) {
          throw new CardError('bad-sale', 'Connect to the internet and check your mint in Settings → Offline payments before charging offline.');
        }
      }
      if (currentCheck()) {
        send({ type: 'network-ready', offline });
        prepareInvoiceSale();
      }
    })().catch(error => { if (currentCheck()) send({ type: 'open-failed', error }); });
  }

  function prepareInvoiceSale(): void {
    if (state.kind !== 'preflight' || !state.shared || state.mode || state.saleId || state.resumeSaleId) return;
    const mine = ++opens;
    void d.service.openSale(state.sats).then(saleId => {
      if (mine === opens && !disposed && state.kind === 'preflight' && state.shared && !state.mode) {
        offlineSaleId = null;
        send({ type: 'checkout-ready', saleId });
      } else void d.service.leaveSale?.(saleId);
    }, error => {
      if (mine === opens && !disposed) send({ type: 'open-failed', error });
    });
  }

  function openSale(sats: number, offline = false): void {
    opens += 1;
    const mine = opens;
    const opening = offline ? d.service.openSale(sats, true) : d.service.openSale(sats);
    // another job runs, or waits ahead of this sale's opening: the opening waits for it, and says so
    if (behind()) {
      send({ type: 'queued' });
    }
    void opening.then(
      (saleId) => {
        if (mine === opens && !disposed && state.kind === 'opening') {
          offlineSaleId = offline ? saleId : null;
          send({ type: 'opened', saleId });
        } else void d.service.leaveSale?.(saleId);
      },
      (error: unknown) => {
        if (mine === opens) send({ type: 'open-failed', error });
      },
    );
  }

  /** close(false), only while no take runs. */
  function withdraw(saleId: string): void {
    if (current !== 0 || withdrawRunning) {
      send({ type: 'withdraw-failed', error: new CardError('busy', STILL_TAKING_MESSAGE) });
      return;
    }
    withdrawRunning = true;
    void (async (): Promise<void> => {
      try {
        const others = await d.service.withdrawSale(saleId);
        withdrawRunning = false;
        send({ type: 'withdrawn', others });
      } catch (error) {
        withdrawRunning = false;
        send({ type: 'withdraw-failed', error });
      }
    })();
  }

  /** The machine's effect, run here. `held` is the PIN's digits as they were before the state changed. */
  function run(effect: SaleEffect, held: string): void {
    switch (effect.kind) {
      case 'open-sale':
        openSale(effect.sats, effect.offline);
        return;
      case 'take':
        startTake(effect.saleId);
        return;
      case 'answer-confirm': {
        const r = pendingConfirm;
        pendingConfirm = null;
        r?.(effect.pay ? (effect.pin ? { pay: true, pin: held } : { pay: true }) : { pay: false });
        return;
      }
      case 'answer-pin': {
        const r = pendingPin;
        pendingPin = null;
        r?.(effect.give ? held : null);
        return;
      }
      case 'stop':
        // a card in the field is never stopped under it: the library stops only before its next command
        if (session !== null && session.cardIn()) return;
        abort?.abort();
        // a take that never reached the reader's begin has asked nothing of a card: it is let go here, so the sale stops
        // at once even while the reader or the queue does not answer; what it sends later is dropped
        if (current !== 0 && !began) {
          current = 0;
          abort = null;
          session = null;
          answerNo();
          void Promise.resolve().then(() => send({ type: 'failed', error: cancelledError() }));
        }
        return;
      case 'withdraw':
        withdraw(effect.saleId);
        return;
    }
  }

  /** The till is told that the screen let the sale of a result go (slice 2.3b). */
  function leave(s: SaleState): void {
    if (s.kind === 'preflight') {
      ++opens;
      ++networkCheck;
      const id = s.saleId ?? s.resumeSaleId;
      if (id) void d.service.leaveSale?.(id);
    }
    if (s.kind === 'result' && s.saleId !== null) {
      void d.service.leaveSale?.(s.saleId);
    }
  }

  function send(e: SaleEvent): void {
    if (disposed) return;
    const held = digits;
    const r = step(state, e);
    const changed = r.state !== state;
    // New sale pressed on a result: its sale is let go
    if (changed && r.state.kind === 'keypad') leave(state);
    state = r.state;
    if (state.kind !== 'preflight') { walletHold = null; issuingFor = null; }
    if (state.kind === 'preflight' && !state.count) digits = '';
    if (state.kind !== 'pin' && state.kind !== 'preflight') digits = '';
    if (state.kind === 'result') {
      clearApproval();
      answerNo();
    }
    if (r.effect) run(r.effect, held);
    if (changed) {
      restartTimer();
      d.onState(state);
    }
  }

  /** A key of the PIN pad that changed nothing still starts the PIN pad's wait again. */
  function renewTimer(): void {
    if (disposed) return;
    if (timer !== null) timers.clear(timer);
    timer = null;
    timerKey = null;
    restartTimer();
  }

  function input(i: SaleInput): void {
    if (disposed || backgrounded || walletHold || issuingFor || (state.kind === 'preflight' && state.verifyInvoice)) return;
    switch (i.type) {
      case 'charge':
        if (state.kind !== 'keypad') return;
        if (d.reader.kind === 'nfc' || sharedCheckout) {
          send({ type: 'prepare-tap', detect: !!d.networkStatus, shared: sharedCheckout });
          if (d.networkStatus) checkNetwork();
          else prepareInvoiceSale();
        } else send({ type: 'charge' });
        return;
      case 'pin-ok':
        if (state.kind === 'preflight' && state.shared &&
            (digits.length < PIN_LEAST || (!state.mode && !state.saleId))) return;
        if (state.kind === 'preflight' && state.mode !== 'detecting' &&
            ((digits.length === 0 && state.mode !== 'offline') || digits.length >= PIN_LEAST)) {
          clearApproval();
          approval = { sats: state.sats, pin: digits, expires: Date.now() + PIN_WAIT_MS };
          approvalTimer = timers.set(() => {
            clearApproval();
            if (state.kind === 'opening' || (state.kind === 'tap' && !state.card)) send({ type: 'cancel' });
          }, PIN_WAIT_MS);
        }
        send({ type: 'pin-ok' });
        return;
      case 'pin-digit':
        if ((state.kind !== 'pin' && state.kind !== 'preflight') || !/^[0-9]$/.test(i.d)) return;
        if (digits.length < PIN_MOST) {
          digits += i.d;
          send({ type: 'pin-key' });
        } else {
          renewTimer();
        }
        return;
      case 'pin-back':
        if (state.kind !== 'pin' && state.kind !== 'preflight') return;
        if (digits.length > 0) {
          digits = digits.slice(0, -1);
          send({ type: 'pin-back' });
        } else {
          renewTimer();
        }
        return;
      case 'digit':
        send({ type: 'digit', d: i.d });
        return;
      case 'retry':
        // whether new sales are stopped is read now, at the press (slice 2.4); the machine holds the rule
        if (state.kind !== 'result') return;
        send({ type: 'retry', stopped: d.service.salesStopped?.() === true, shared: sharedCheckout, detect: (d.reader.kind === 'nfc' || sharedCheckout) && !!d.networkStatus,
          offline: state.saleId !== null && state.saleId === offlineSaleId });
        if (d.networkStatus) checkNetwork();
        else prepareInvoiceSale();
        return;
      default:
        send({ type: i.type });
        return;
    }
  }

  function dispose(): void {
    // the screen left on a result: its sale is let go
    if (!disposed) leave(state);
    disposed = true;
    walletHold = null;
    clearApproval();
    digits = '';
    if (timer !== null) {
      timers.clear(timer);
      timer = null;
      timerKey = null;
    }
    answerNo();
    if (abort !== null && (stopPreparedOnBackground || !session?.cardIn())) abort.abort();
  }

  return {
    state: () => state,
    holdWallet(id): boolean {
      if (disposed || walletHold || issuingFor || state.kind !== 'preflight' || state.verifyInvoice || state.saleId !== id) return false;
      walletHold = id;
      digits = '';
      clearApproval();
      send({ type: 'clear-pin' });
      return true;
    },
    releaseWallet(id): void { if (walletHold === id) walletHold = null; },
    walletProcessing(id): void {
      if (disposed || state.kind !== 'preflight' || state.saleId !== id) return;
      issuingFor = id;
      digits = '';
      send({ type: 'clear-pin' });
    },
    walletPaid(saleId, rail): void { send({ type: 'checkout-paid', saleId, rail }); },
    invoiceUnpaid(saleId): void { send({type:'invoice-unpaid',saleId}); },
    walletExtra(saleId): void { send({ type: 'lightning-extra', saleId }); },
    input,
    settled(p: Payment): void {
      if (current && offlineSaleId === p.id && (isPaid(p) || p.state === 'gone')) {
        earlySettlement.set(p.paymentId, p);
      } else send({ type: 'settled', payment: p });
    },
    dispose,
    taking: () => current !== 0,
    pinHeld: () => digits.length > 0 || Boolean(approval?.pin),
    foreground(): void { backgrounded = false; },
    background(): void {
      backgrounded = true;
      clearApproval();
      if (stopPreparedOnBackground) abort?.abort();
      if (state.kind === 'opening' || (state.kind === 'tap' && !state.card)) send({ type: 'cancel' });
      else if (state.kind === 'preflight' && state.shared && !state.mode) {
        digits = '';
        send({ type: 'clear-pin' });
      } else if (state.kind === 'preflight' || state.kind === 'pin') send({ type: 'pin-cancel' });
      else if (state.kind === 'confirm') send({ type: 'decline' });
    },
  };
}
