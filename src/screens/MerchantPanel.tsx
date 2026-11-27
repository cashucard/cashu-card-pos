import React, { useEffect } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';
import { FONT, SPACE, useTheme } from '../ui/theme';
import { Body } from '../ui/kit';

/** Group the amount, mint and actions that belong to a single balance or receipt. */
export function MerchantPanel({ children }: { children: React.ReactNode }): React.JSX.Element {
  const p = useTheme();
  return <View style={[styles.panel, { backgroundColor: p.field, borderColor: p.line }]}>{children}</View>;
}

export function PanelLabel({ children }: { children: string }): React.JSX.Element {
  const p = useTheme();
  return <Text style={[styles.label, { color: p.muted }]}>{children}</Text>;
}

/** Messages describe the current action. Bearer tokens, PINs and saved receipts stay out of announcements. */
export function MerchantMessage({ id, children }: { id: 'wallet-message' | 'owed-message' | 'token-message' | 'phone-message'; children: string }): React.JSX.Element {
  useEffect(() => {
    if (Platform.OS !== 'ios' || !children) return;
    let current = true;
    void AccessibilityInfo.isScreenReaderEnabled().then(enabled => {
      if (enabled && current) AccessibilityInfo.announceForAccessibilityWithOptions(children, { queue: true });
    }).catch(() => undefined);
    return () => { current = false; };
  }, [children]);
  return <View accessibilityLiveRegion="polite"><Body testID={id}>{children}</Body></View>;
}

const styles = StyleSheet.create({
  panel: { padding: SPACE.m, borderWidth: 1, borderRadius: 20, marginBottom: SPACE.m },
  label: { fontFamily: FONT.semibold, fontSize: 14, marginBottom: SPACE.s },
});
