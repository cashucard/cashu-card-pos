import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, Text } from 'react-native';
import { AppRoot } from '../app/AppRoot';
import type { AppWiring } from '../app/wiring';
import { LabScreen, type LabScreenProps } from '../lab/LabScreen';
import type { AppPlan, DevPlan, LabPlan } from '../lab/plan';
import { SelfTestScreen, type SelfTestScreenProps } from '../selftest/SelfTestScreen';
import type { SelfTestJournal } from '../selftest/types';

export interface DevRootProps {
  plan: () => Promise<DevPlan>;
  selftest: (journal: SelfTestJournal) => SelfTestScreenProps['run'];
  lab: (p: LabPlan) => LabScreenProps['run'];
  /** the till's wiring for an app plan (built once per launch) */
  app?: (p: AppPlan) => AppWiring;
}

/** Development builds only: reads the plan once, then shows the till, the self-test or the lab. */
export function DevRoot(props: DevRootProps): React.JSX.Element {
  const [plan, setPlan] = useState<DevPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    props
      .plan()
      .then((p) => {
        if (live) {
          setPlan(p);
        }
      })
      .catch((e: unknown) => {
        if (live) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      live = false;
    };
  }, []);

  // made once for one plan: the till's wiring is not rebuilt on a re-render
  const wiring = useMemo(() => {
    if (plan === null || plan.mode !== 'app' || props.app === undefined) {
      return null;
    }
    return props.app(plan.app);
  }, [plan]);

  if (error !== null) {
    return (
      <SafeAreaView>
        <Text testID="dev-plan-error">{'PLAN FAIL: ' + error}</Text>
      </SafeAreaView>
    );
  }
  if (plan === null) {
    return <Text testID="dev-plan-loading">{'Reading the plan'}</Text>;
  }
  if (plan.mode === 'app') {
    if (wiring === null) {
      return (
        <SafeAreaView>
          <Text testID="dev-plan-error">{'PLAN FAIL: no app wiring'}</Text>
        </SafeAreaView>
      );
    }
    return <AppRoot wiring={wiring} />;
  }
  if (plan.mode === 'lab') {
    return <LabScreen plan={plan.lab} run={props.lab(plan.lab)} />;
  }
  return <SelfTestScreen run={props.selftest(plan.mode === 'selftest-sqlcipher' ? 'sqlcipher' : 'memory')} />;
}
