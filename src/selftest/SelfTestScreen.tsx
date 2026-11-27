import React, { useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text } from 'react-native';
import { formatLine, verdict } from './report';
import type { SelfTestReport, StepResult } from './types';

export interface SelfTestScreenProps {
  run: (onStep: (r: StepResult) => void) => Promise<SelfTestReport>;
}

/** The self-test on the screen: each step's line as it arrives, a verdict at the top, and the end marked. */
export function SelfTestScreen(props: SelfTestScreenProps): React.JSX.Element {
  const [steps, setSteps] = useState<StepResult[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finalReport, setFinalReport] = useState<SelfTestReport | null>(null);

  useEffect(() => {
    let live = true;
    props
      .run((r) => {
        if (live) {
          setSteps((s) => [...s, r]);
        }
      })
      .then((report) => {
        if (live) {
          setSteps(report.steps);
          setFinalReport(report);
          setDone(true);
        }
      })
      .catch((e: unknown) => {
        if (live) {
          setError(e instanceof Error ? e.message : String(e));
          setDone(true);
        }
      });
    return () => {
      live = false;
    };
  }, []);

  const verdictText = error !== null ? 'SELFTEST FAIL: ' + error : verdict(steps, done);

  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.list}>
        <Text testID="selftest-title" style={styles.title}>
          {'Cashu Card POS: shell self-test'}
        </Text>
        <Text testID="selftest-verdict" style={styles.verdict}>
          {verdictText}
        </Text>
        {steps.map((s) => (
          <Text key={s.id} testID={'step-' + s.id} style={s.ok ? styles.pass : styles.fail}>
            {formatLine(s)}
          </Text>
        ))}
        {done ? (
          <Text testID="selftest-done" style={styles.done}>
            {'DONE'}
          </Text>
        ) : null}
        {finalReport !== null && finalReport.reported === false ? (
          <Text testID="selftest-unreported" style={styles.fail}>
            {'report not delivered'}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#ffffff' },
  list: { padding: 16 },
  title: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  verdict: { fontSize: 16, fontWeight: '700', marginBottom: 12 },
  pass: { fontSize: 12, color: '#1b5e20', marginBottom: 6 },
  fail: { fontSize: 12, color: '#b71c1c', marginBottom: 6 },
  done: { fontSize: 12, marginTop: 12 },
});
