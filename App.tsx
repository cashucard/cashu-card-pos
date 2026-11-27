import React, { useState } from 'react';
import { StatusBar } from 'react-native';
import { MotionPreference } from './src/ui/motion';
import { DARK, useTheme } from './src/ui/theme';
import { AppRoot } from './src/app/AppRoot';
import { InstalledVersionContext, type InstalledVersion } from './src/app/installed-version';
import { releaseWiring } from './src/app/release-wiring';
import { DevRoot } from './src/dev/DevRoot';
import { devAppWiring } from './src/dev/app-wiring';
import { runLab } from './src/lab/actions';
import { deviceRawFetch, fetchDevPlan, labDeps } from './src/lab/device';
import { deviceDeps } from './src/selftest/device';
import { runSelfTest } from './src/selftest/run';
import { DEV_BENCH_URL } from './src/till/dev-config';

// Slice 0.2: the app is its own self-test. The till's screens replace this in slice 1.1.
// Slice 0.3: the bench's plan picks the self-test, the self-test over the real journal, or the journal lab.
// Slice 1.1: a release build is the till; in development the bench's plan { "mode": "app" } starts it too.
export default function App(version: InstalledVersion): React.JSX.Element {
  return (
    <InstalledVersionContext.Provider value={version}>
      <MotionPreference><AppContent /></MotionPreference>
    </InstalledVersionContext.Provider>
  );
}

function AppContent(): React.JSX.Element {
  if (!__DEV__) {
    return <ReleaseApp />;
  }
  return (
    <DevRoot
      plan={() => fetchDevPlan(deviceRawFetch(), DEV_BENCH_URL)}
      selftest={(journal) => (onStep) => runSelfTest(deviceDeps(__DEV__, journal), onStep)}
      lab={(p) => (onLine) => runLab(labDeps(__DEV__), p, onLine)}
      app={(p) => devAppWiring(p, __DEV__)}
    />
  );
}

/** A release build is the till: its wiring is made once. */
function ReleaseApp(): React.JSX.Element {
  const [wiring] = useState(releaseWiring);
  const palette = useTheme();
  return (
    <>
      <StatusBar barStyle={palette === DARK ? 'light-content' : 'dark-content'} backgroundColor={palette.page} />
      <AppRoot wiring={wiring} />
    </>
  );
}
