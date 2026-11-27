import React, { useEffect, useRef, useState } from 'react';
import { Animated, AppState, BackHandler } from 'react-native';
import { CardBalanceScreen } from '../screens/CardBalanceScreen';
import { TopupScreen } from '../screens/TopupScreen';
import { OfflineSettingsScreen } from '../screens/OfflineScreens';
import { BackupScreen } from '../screens/BackupScreen';
import { AboutScreen } from '../screens/AboutScreen';
import { ActivityScreen } from '../screens/ActivityScreen';
import { AddMintScreen } from '../screens/AddMintScreen';
import {
  ClosedScreen,
  ConfirmScreen,
  FailedScreen,
  GateWaitScreen,
  OpeningScreen,
  StoreProblemScreen,
} from '../screens/BootScreens';
import { FIRSTRUN_LOST, FIRSTRUN_USED, FirstRunScreen } from '../screens/FirstRunScreen';
import { TillNotices } from '../screens/HomeScreen';
import { MintsScreen } from '../screens/MintsScreen';
import { PaymentScreen } from '../screens/PaymentScreen';
import { RecordsScreen } from '../screens/RecordsScreen';
import { OwedScreen } from '../screens/OwedScreen';
import type { CredentialSheetEvent } from '../till/foreground-wallet-action';
import { WalletScreen } from '../screens/WalletScreen';
import { SaleScreen } from '../screens/SaleScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { MerchantShell } from './MerchantShell';
import { isDetailWithArrival, useRouteArrival } from './route-arrival';
import { gateResultOf, guarded } from '../till/guarded';
import { READER_WORDS } from '../till/reader';
import type { SaleReport } from '../till/sale-machine';
import type { ActivityReport } from './activity';
import {
  keptOf,
  NOTICES_MOST,
  settleProblem,
  settleSchedule,
  tillReport,
  type NoticeTone,
  type SettleSchedule,
} from '../till/settle';
import { strandedOf, strandedWords } from '../till/stranded';
import { heldUnreadable } from '../till/payment-words';
import { SETTINGS_LOST, type TillPhase } from '../till/service';
import type { MintEntry } from '../till/settings';
import { BOOT_START, bootStep, type BootEffect, type BootEvent, type BootState } from './boot';
import {
  GATED,
  canGoBack,
  current,
  navReducer,
  navStart,
  type MerchantTab,
  type NavAction,
  type NavState,
  type Route,
  type RouteName,
} from './nav';
import { LIBRARY_VERSION, type AppReport, type AppWiring } from './wiring';

export interface AppRootProps {
  wiring: AppWiring;
}

/** The store's state while the till is not open, for the report; null when it is open or still opening. */
function storeStateOf(b: BootState): string | null {
  switch (b.kind) {
    case 'problem':
    case 'confirm':
    case 'gate':
    case 'closed':
      return b.message.state;
    case 'opening':
    case 'ready':
    case 'failed':
      return null;
  }
}

/** The app once the device is wired: the launch screens, then the till's screens, and the report to the host. */
export function AppRoot(props: AppRootProps): React.JSX.Element {
  const w = useRef(props.wiring).current;
  const live = useRef(true);
  const started = useRef<boolean>(false);
  const sent = useRef<string | null>(null);
  const bootRef = useRef<BootState>(BOOT_START);

  const [boot, setBoot] = useState<BootState>(BOOT_START);
  const [phase, setPhase] = useState<TillPhase>(() => w.service.phase());
  const [nav, setNav] = useState<NavState | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [gate, setGate] = useState<'passed' | 'refused' | null>(null);
  const [gateAvailable, setGateAvailable] = useState<boolean | null>(null);
  const [saleReport, setSaleReport] = useState<SaleReport | null>(null);
  /** the navigation as last rendered, for Android's back (its handler is added once) */
  const navRef = useRef<NavState | null>(null);
  navRef.current = nav;
  // Stale biometric results cannot open a tab after the cashier moves on.
  const navigationVersion = useRef(0);
  const saleReturnDigits = useRef('');
  const walletCredential = useRef<'none' | 'open' | 'covered'>('none');
  const animateNavigation = useRef(false);
  /** what settle left for Home (slice 1.3): sats kept in the phone, notices not seen, a failed settle's words */
  const [kept, setKept] = useState<number | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [noticeTones, setNoticeTones] = useState<NoticeTone[]>([]);
  const [settleNote, setSettleNote] = useState<string | null>(null);
  /** Home's lines for money owed to cards of mints the till does not take now, from the record */
  const [stranded, setStranded] = useState<string[]>([]);
  /** payments held because their sale's record does not read (slice 2.3b), from the record */
  const [unreadable, setUnreadable] = useState(0);
  /** new sales are stopped (slice 2.4): told by the till at every change */
  const [stopped, setStopped] = useState<boolean>(() => w.service.salesStopped());
  const schedule = useRef<SettleSchedule | null>(null);
  const offPayments = useRef<(() => void) | null>(null);
  /** how many pages of finished payments the Activity shows: kept while the Activity is on the stack (slice 1.4) */
  const [activityPages, setActivityPages] = useState<number>(1);

  function dispatchBoot(e: BootEvent): void {
    const step = bootStep(bootRef.current, e);
    bootRef.current = step.state;
    setBoot(step.state);
    if (step.effect !== null) {
      runEffect(step.effect);
    }
  }

  function runEffect(effect: BootEffect): void {
    if (effect.kind === 'open') {
      void w.service.open(effect.choice).then(
        (p) => {
          if (live.current) {
            receive(p);
          }
        },
        () => undefined,
      );
      return;
    }
    if (effect.kind === 'not-now') {
      w.service.notNow();
      receive(w.service.phase());
      return;
    }
    void guarded(w.gate, effect.reason, async () => undefined).then((g) => {
      if (!live.current) {
        return;
      }
      setGate(g.ok ? 'passed' : 'refused');
      dispatchBoot({ type: 'gate', result: gateResultOf(g) });
    });
  }

  /** A phase from the service: the launch machine steps, and the first ready phase starts the navigation. */
  function receive(p: TillPhase): void {
    setPhase(p);
    dispatchBoot({ type: 'phase', phase: p });
    if (p.kind === 'ready' && !started.current) {
      started.current = true;
      setNav(navStart(p.mints.length));
      startTill();
    } else if (p.kind === 'ready') {
      // the mints changed (added, removed, checked again): what is owed to whose cards is read again
      void refreshTill();
    }
  }

  function navigate(a: NavAction): void {
    navigationVersion.current++;
    animateNavigation.current = a.type === 'push' || a.type === 'tab' || a.type === 'back';
    const leaving = navRef.current && current(navRef.current).name;
    if (leaving === 'wallet' || leaving === 'owed') void refreshTill();
    setNote(null);
    setNav((n) => (n === null ? null : navReducer(n, a)));
  }

  function push(r: Route): void {
    navigate({ type: 'push', route: r });
  }

  function back(): void {
    const stack = navRef.current?.stack;
    if (stack && stack[stack.length - 2]?.name === 'wallet') {
      go({ name: 'wallet' }, { type: 'back' });
      return;
    }
    navigate({ type: 'back' });
  }

  function walletCredentialChanged(event: CredentialSheetEvent): void {
    const covered = walletCredential.current === 'covered';
    walletCredential.current = event === 'open' ? 'open' : 'none';
    if (covered && event === 'dismissed' && navRef.current && current(navRef.current).name === 'wallet') {
      navigate({ type: 'reset', route: { name: 'sale' } });
    }
  }

  /** A screen's own owner check, told to the report as the navigation's are. */
  function reportGate(outcome: 'passed' | 'refused'): void {
    if (live.current) {
      setGate(outcome);
    }
  }

  function go(r: Route, action: NavAction = { type: 'push', route: r }): void {
    const reason = GATED[r.name];
    if (reason === undefined) {
      navigate(action);
      return;
    }
    const version = ++navigationVersion.current;
    void guarded(w.gate, reason, async () => undefined).then((g) => {
      if (!live.current || version !== navigationVersion.current) return;
      setGate(g.ok ? 'passed' : 'refused');
      if (g.ok) {
        navigate(action);
      } else {
        if (action.type === 'back') navigate({ type: 'tab', tab: 'sale' });
        setNote(g.words);
      }
    });
  }

  function tab(tabName: MerchantTab): void {
    if (navRef.current && current(navRef.current).name === tabName) {
      navigationVersion.current++;
      return;
    }
    go({ name: tabName }, { type: 'tab', tab: tabName });
  }

  function shell(selected: MerchantTab, page: React.JSX.Element): React.JSX.Element {
    return <MerchantShell arrival={arrival} current={selected} onTab={tab} onSettings={() => go({ name: 'settings' })}
      message={selected === 'sale' ? undefined : note}>{page}</MerchantShell>;
  }

  function mintAdded(): void {
    if (nav !== null && nav.stack[0].name === 'first-run') {
      navigate({ type: 'reset', route: { name: 'sale' } });
    } else {
      back();
    }
  }

  /** What the keep-store and the record hold now, for Home and (development) the bench. */
  async function refreshTill(): Promise<void> {
    try {
      const [totals, pays] = await Promise.all([w.service.kept(), w.service.payments()]);
      if (!live.current) {
        return;
      }
      const k = keptOf(totals);
      const told = w.service.notices();
      const last = w.service.lastSettle();
      setKept(k.sats);
      const shownNow = w.service.shownNotices();
      setNotices(shownNow.map((n) => n.words));
      setNoticeTones(shownNow.map((n) => n.tone));
      setSettleNote(settleProblem(last));
      setStranded(strandedOf(pays, w.service.mints()).map(strandedWords));
      setUnreadable(heldUnreadable(pays));
      if (w.reportTill !== undefined) {
        try {
          w.reportTill(tillReport(w.now(), k, pays, last, told));
        } catch {
          // the host's report is not the till's business
        }
      }
    } catch {
      // the till is closing: nothing to show
    }
  }

  /** At the first ready phase: hear every settle, then start the schedule (the launch's check again and settle). */
  function startTill(): void {
    offPayments.current = w.service.onPayments(() => {
      void refreshTill();
    });
    const s = settleSchedule({
      settle: (why) => w.service.settleNow(why),
      recheck: () => w.service.recheckMints(),
      now: w.now,
      source: w.schedule ?? null,
    });
    schedule.current = s;
    s.start();
    void refreshTill();
  }

  /** The merchant has seen the notices shown (the oldest NOTICES_MOST): those are dropped, never told again. */
  function seeNotices(): void {
    const shown = Math.min(notices.length, NOTICES_MOST);
    w.service.noticesSeen(shown);
    setNotices(notices.slice(shown));
    setNoticeTones(noticeTones.slice(shown));
    void refreshTill();
  }

  /** What the Activity read, for the host (development only). */
  function reportActivity(r: ActivityReport): void {
    if (w.reportActivity === undefined) {
      return;
    }
    try {
      w.reportActivity(r);
    } catch {
      // the host's report is not the till's business
    }
  }

  // 1. the service: each phase steps the launch machine, and the first ready phase starts the navigation
  useEffect(() => {
    live.current = true;
    const stop = w.service.subscribe((p) => {
      if (live.current) {
        receive(p);
      }
    });
    // heard from before the open: the open's own save of the generation may already be refused (slice 2.4)
    const offStopped = w.service.onSalesStopped((s) => {
      if (live.current) {
        setStopped(s);
      }
    });
    void w.service.open().then(
      (p) => {
        if (live.current) {
          receive(p);
        }
      },
      () => undefined,
    );
    return () => {
      live.current = false;
      stop();
      offStopped();
      schedule.current?.stop();
      schedule.current = null;
      offPayments.current?.();
      offPayments.current = null;
    };
  }, []);

  const readyPhase = phase.kind === 'ready' ? phase : null;
  const shownRoute: Route | null = nav === null ? null : current(nav);
  const arrival = useRouteArrival(boot.kind === 'ready' ? shownRoute?.name ?? null : null, animateNavigation.current);
  const routeName: RouteName | null = shownRoute === null ? null : shownRoute.name;

  // 1b. the sale's summary is kept only while the sale is shown
  useEffect(() => {
    if (routeName !== 'sale') {
      setSaleReport(null);
    }
  }, [routeName]);

  // 1c. the Activity's pages are kept while the Activity is on the stack (a payment opened from it comes back to them)
  const activityOnStack = nav !== null && nav.stack.some((s) => s.name === 'activity');
  useEffect(() => {
    if (!activityOnStack) {
      setActivityPages(1);
    }
  }, [activityOnStack]);

  // 2. how this phone confirms it is you, asked each time Settings is shown
  useEffect(() => {
    if (routeName !== 'settings') {
      setGateAvailable(null);
      return;
    }
    let alive = true;
    setGateAvailable(null);
    void w.gate.available().then(
      (yes) => {
        if (alive && live.current) {
          setGateAvailable(yes);
        }
      },
      () => {
        if (alive && live.current) {
          setGateAvailable(false);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [routeName]);

  // 3. what the host is told, whenever what the screen shows changes
  let screenName: RouteName | null = null;
  let firstRun: boolean | null = null;
  let reportMints: Array<{ url: string; status: 'ok' | 'refused' }> = [];
  let reportSale: SaleReport | null = null;
  if (boot.kind === 'ready' && readyPhase !== null) {
    screenName = shownRoute === null ? null : shownRoute.name;
    firstRun = readyPhase.firstRun;
    reportMints = readyPhase.mints.map((m) => ({ url: m.url, status: m.status }));
    reportSale = screenName === 'sale' ? saleReport : null;
  }
  const shownNote = noteShown();
  const reportSig = JSON.stringify({
    boot: boot.kind,
    store: storeStateOf(boot),
    screen: screenName,
    firstRun,
    mints: reportMints,
    gate,
    note: shownNote,
    sale: reportSale,
  });
  useEffect(() => {
    if (sent.current === reportSig) {
      return;
    }
    sent.current = reportSig;
    const r: AppReport = {
      at: w.now(),
      boot: boot.kind,
      store: storeStateOf(boot),
      screen: screenName,
      firstRun,
      mints: reportMints,
      gate,
      note: shownNote,
      sale: reportSale,
    };
    try {
      w.report(r);
    } catch {
      // the host's report is not the till's business
    }
  }, [reportSig]);

  // A real background dismisses a protected wallet and voids an outstanding navigation check.
  // Native biometric sheets can briefly make iOS inactive while the app remains in front.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'background') return;
      navigationVersion.current++;
      if (navRef.current && current(navRef.current).name === 'wallet') {
        // The Android system credential Activity temporarily covers this protected screen.
        if (walletCredential.current !== 'none') {
          walletCredential.current = 'covered';
          return;
        }
        navigate({ type: 'reset', route: { name: 'sale' } });
      }
    });
    return () => subscription.remove();
  }, []);

  // 4. Android's back: the confirm screen, then the navigation, then the phone's own answer
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (bootRef.current.kind === 'confirm') {
        dispatchBoot({ type: 'back' });
        return true;
      }
      if (bootRef.current.kind === 'ready' && navRef.current !== null && canGoBack(navRef.current)) {
        back();
        return true;
      }
      return false;
    });
    return () => {
      sub.remove();
    };
  }, []);

  /** The note the current screen shows. */
  function noteShown(): string | null {
    switch (boot.kind) {
      case 'problem':
      case 'confirm':
        return boot.note;
      case 'opening':
      case 'gate':
      case 'closed':
      case 'failed':
        return null;
      case 'ready':
        break;
    }
    if (shownRoute === null) {
      return null;
    }
    if (shownRoute.name === 'sale') {
      return note !== null ? note : readyPhase === null ? null : readyPhase.note;
    }
    if (shownRoute.name === 'settings' || shownRoute.name === 'activity' || shownRoute.name === 'owed' || shownRoute.name === 'wallet') {
      return note;
    }
    if (shownRoute.name === 'first-run') {
      if (readyPhase === null) {
        return null;
      }
      if (readyPhase.note === SETTINGS_LOST) {
        return FIRSTRUN_LOST;
      }
      return readyPhase.firstRun === false ? FIRSTRUN_USED : null;
    }
    return null;
  }

  function launchView(b: BootState): React.JSX.Element {
    switch (b.kind) {
      case 'opening':
        return <OpeningScreen />;
      case 'problem':
        return (
          <StoreProblemScreen
            message={b.message}
            note={b.note}
            onOffer={(id) => dispatchBoot({ type: 'offer', id })}
          />
        );
      case 'confirm':
        return (
          <ConfirmScreen
            offer={b.offer}
            typed={b.typed}
            note={b.note}
            onType={(t) => dispatchBoot({ type: 'type', text: t })}
            onGo={() => dispatchBoot({ type: 'go' })}
            onBack={() => dispatchBoot({ type: 'back' })}
          />
        );
      case 'gate':
        return <GateWaitScreen offer={b.offer} />;
      case 'closed':
        return <ClosedScreen state={b.message.state} onAgain={() => dispatchBoot({ type: 'again' })} />;
      case 'failed':
        return <FailedScreen why={b.why} onAgain={() => dispatchBoot({ type: 'again' })} />;
      case 'ready':
        return <OpeningScreen />;
    }
  }

  function tillView(r: Route, mints: MintEntry[], phaseNote: string | null): React.JSX.Element {
    if (readyPhase?.restoring || r.name === 'backups') {
      return <BackupScreen recovery={w.service.recovery} gate={w.gate}
        startRestore={r.name === 'backups' && r.restore} restoring={readyPhase?.restoring}
        onBack={back} onRestored={() => navigate({ type: 'reset', route: navStart(w.service.mints().length).stack[0] })} />;
    }
    switch (r.name) {
      case 'first-run':
        return (
          <FirstRunScreen
            preset={w.devMintPreset}
            listLost={phaseNote === SETTINGS_LOST}
            used={readyPhase !== null && readyPhase.firstRun === false}
            onRestore={() => push({ name: 'backups', restore: true })}
            onOpenTill={() => navigate({ type: 'replace', route: { name: 'sale' } })}
            onAdd={(preset) => push({ name: 'add-mint', preset })}
          />
        );
      case 'settings':
        return (
          <SettingsScreen
            gateAvailable={gateAvailable}
            note={note}
            onGo={(where) => go({ name: where })}
            onBack={back}
          />
        );
      case 'mints':
        return (
          <MintsScreen
            service={w.service}
            gate={w.gate}
            mints={mints}
            onGate={reportGate}
            lastRecheck={() => w.service.lastRecheck()}
            onAdd={() => push({ name: 'add-mint', preset: null })}
            onBack={back}
          />
        );
      case 'add-mint':
        return (
          <AddMintScreen
            service={w.service}
            gate={w.gate}
            onGate={reportGate}
            preset={r.preset}
            onDone={mintAdded}
            onBack={back}
          />
        );
      case 'about':
        return (
          <AboutScreen
            mode={w.mode}
            libraryVersion={LIBRARY_VERSION}
            reader={READER_WORDS[w.reader.kind]}
            onBack={back}
          />
        );
      case 'card-balance':
        return <CardBalanceScreen reader={w.reader} service={w.service} onBack={back}
          onCharge={() => tab('sale')} onTopUp={card => navigate({ type: 'replace', route: { name: 'card-top-up', cardKey: card.cardKey } })} />;
      case 'card-top-up':
        return <TopupScreen service={w.service.cardTopups(w.reader)} cardKey={r.cardKey} onBack={() => tab('sale')} onDone={() => { saleReturnDigits.current = ''; tab('sale'); }} />;
      case 'offline-settings':
        return <OfflineSettingsScreen service={w.service} mints={mints.filter(m => m.status === 'ok').map(m => m.url)}
          authorize={async () => (await guarded(w.gate, 'offline-acceptance', async () => undefined)).ok} onBack={back} />;
      case 'topup-receipts':
        return <TopupScreen service={w.service.cardTopups(w.reader)} historyOnly onBack={back} />;
      case 'sale':
        return (
          <SaleScreen
            service={w.service}
            reader={w.reader}
            mints={mints.filter((m) => m.status === 'ok').map((m) => m.url)}
            initialDigits={saleReturnDigits.current}
            onReturn={() => { saleReturnDigits.current = ''; tab('owed'); }}
            onBalance={digits => { saleReturnDigits.current = digits; push({ name: 'card-balance' }); }}
            renderKeypad={(page) => shell('sale', page)}
            canSell={!stopped && mints.some((m) => m.status === 'ok')}
            notices={(
              <TillNotices
                mints={mints}
                note={note !== null ? note : phaseNote}
                onOpenOwed={() => tab('owed')}
                kept={kept}
                notices={notices.slice(0, NOTICES_MOST)}
                noticeTones={noticeTones.slice(0, NOTICES_MOST)}
                noticesMore={Math.max(0, notices.length - NOTICES_MOST)}
                owed={stranded}
                unreadable={unreadable}
                stopped={stopped}
                settleNote={settleNote}
                onNoticesSeen={seeNotices}
              />
            )}
            onActivity={() => tab('activity')}
            onReport={(report) => {
              saleReturnDigits.current = '';
              if (report.step !== 'keypad') navigationVersion.current++;
              setSaleReport(report);
            }}
            queue={w.service.queue}
            onPayments={(l) => w.service.onPayments(l)}
          />
        );
      case 'activity':
        return shell('activity', (
          <ActivityScreen
            reader={w.service}
            now={w.now}
            pages={activityPages}
            onPages={setActivityPages}
            onOpen={(paymentId) => push({ name: 'payment', id: paymentId })}
            onPayments={(l) => w.service.onPayments(l)}
            onRead={reportActivity}
          />
        ));
      case 'payment':
        return (
          <PaymentScreen
            paymentId={r.id}
            reader={w.service}
            onPayments={(l) => w.service.onPayments(l)}
            onBack={back}
          />
        );
      case 'records':
        return <RecordsScreen reader={w.service} share={w.share} onBack={back} />;
      case 'wallet':
        return <WalletScreen onCredentialSheet={walletCredentialChanged} renderOverview={(page) => shell('wallet', page)} service={w.service} gate={w.gate} share={w.share} onBack={back} />;
      case 'owed':
        return <OwedScreen renderOverview={nav?.stack[nav.stack.length - 2]?.name === 'settings' ? undefined : (page) => shell('owed', page)} service={w.service} reader={w.reader} gate={w.gate} share={w.share} onBack={back} />;
    }
  }

  if (boot.kind !== 'ready') {
    return launchView(boot);
  }
  if (shownRoute === null || readyPhase === null) {
    return <OpeningScreen />;
  }
  const page = tillView(shownRoute, readyPhase.mints, readyPhase.note);
  return isDetailWithArrival(shownRoute.name)
    ? <Animated.View style={[{ flex: 1 }, arrival]}>{page}</Animated.View>
    : page;
}
