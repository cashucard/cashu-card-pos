import React, { useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text } from 'react-native';
import type { StoreOutcome } from '../till/store/open-store';
import { storeMessage, type StoreMessage } from '../till/store/messages';
import type { LabResult } from './actions';
import type { LabPlan } from './plan';

export interface LabScreenProps {
  plan: LabPlan;
  run: (onLine: (line: string) => void) => Promise<LabResult>;
}

const STORE_STATES = [
  'journal-missing',
  'rolled-back',
  'unreadable',
  'key-missing',
  'secure-store-unavailable',
  'files-unavailable',
  'newer-format',
  'store-refused',
  'open-failed',
] as const;

/** One lab action on the screen: each line as it arrives, the result's state, and what the merchant would be told. */
export function LabScreen(props: LabScreenProps): React.JSX.Element {
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState<LabResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    props
      .run((line) => {
        if (live) {
          setLines((l) => [...l, line]);
        }
      })
      .then((r) => {
        if (live) {
          setResult(r);
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

  let m: StoreMessage | null = null;
  if (result !== null && (STORE_STATES as readonly string[]).includes(result.state)) {
    m = storeMessage({ ...result, kind: result.state } as unknown as StoreOutcome<unknown>);
  }

  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.list}>
        <Text testID="lab-title" style={styles.title}>
          {'Cashu Card POS: journal lab'}
        </Text>
        <Text testID="lab-plan" style={styles.plan}>
          {props.plan.action + ' ' + props.plan.run + ' on lab-' + props.plan.name}
        </Text>
        {lines.map((line, i) => (
          <Text key={i} testID={'lab-line-' + i} style={styles.line}>
            {line}
          </Text>
        ))}
        {result !== null ? (
          <Text testID="lab-state" style={styles.state}>
            {'LAB ' + result.action + ' ' + result.state}
          </Text>
        ) : null}
        {m !== null ? (
          <Text testID="lab-message" style={styles.message}>
            {m.title + ': ' + m.offers.map((o) => o.label).join(' / ')}
          </Text>
        ) : null}
        {error !== null ? (
          <Text testID="lab-state" style={styles.fail}>
            {'LAB FAIL: ' + error}
          </Text>
        ) : null}
        {result !== null || error !== null ? (
          <Text testID="lab-done" style={styles.done}>
            {'DONE'}
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
  plan: { fontSize: 14, fontWeight: '700', marginBottom: 12 },
  line: { fontSize: 12, color: '#1b5e20', marginBottom: 6 },
  state: { fontSize: 16, fontWeight: '700', marginTop: 12, marginBottom: 8 },
  message: { fontSize: 12, color: '#b71c1c', marginBottom: 6 },
  fail: { fontSize: 12, color: '#b71c1c', marginBottom: 6 },
  done: { fontSize: 12, marginTop: 12 },
});
