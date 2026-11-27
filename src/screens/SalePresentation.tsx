import React, { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  findNodeHandle,
  Image,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import type { AfterScanSheet } from '../till/scan-sheet';
import { PaidCelebration } from './PaidCelebration';
import { FONT, TYPE, useTheme } from '../ui/theme';

export function SaleSurface({ children }: { children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme();
  return <View style={[styles.surface, { backgroundColor: theme.field, borderColor: theme.line }]}>{children}</View>;
}

export function SaleAmount({
  children,
  testID,
  receipt,
  keypadLimitHint,
}: {
  children: string;
  testID: string;
  receipt?: boolean;
  keypadLimitHint?: string;
}): React.JSX.Element {
  const theme = useTheme();
  const { width, height, fontScale } = useWindowDimensions();
  const preferred = keypadLimitHint && height < 700 ? 38 : receipt || width < 355 ? TYPE.amount : 52;
  // The long numeric part must fit one line even at 200%. The unit can wrap.
  // Both amount surfaces use at most 38 points of inset on each side.
  const [amount, unit] = children.split(' ');
  const digits = amount.length;
  const available = Math.min(560, width || 360) - 76;
  const size = Math.min(preferred, Math.max(16, Math.floor(available / (digits * 0.68 * (fontScale || 1)))));
  return (
    <Text
      testID={testID}
      accessible
      accessibilityLabel={children}
      accessibilityHint={keypadLimitHint}
      accessibilityLiveRegion="polite"
      style={[styles.amount, { fontSize: size, color: theme.text }]}
    >
      {keypadLimitHint ? (
        <>
          {amount}
          <Text style={{ fontSize: Math.max(15, Math.round(size * 0.52)), color: theme.muted, letterSpacing: 0 }}>
            {' ' + unit}
          </Text>
        </>
      ) : (
        children
      )}
    </Text>
  );
}

type Signal = 'card' | 'busy' | 'paid' | 'saved' | 'attention' | 'declined' | 'cancelled';
interface StageProps {
  title: string;
  titleID: string;
  signal: Signal;
  receiptKey?: string;
  afterScanSheet?: AfterScanSheet;
  resultTone?: 'normal' | 'good' | 'bad';
  amount: string;
  amountID: string;
  /** A scan countdown can change the title without moving the user's reading position each second. */
  focusKey?: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
}

/** Center the instructions, leaving the actions within thumb reach. Larger type and short windows scroll as one page. */
export function SaleStage(p: StageProps): React.JSX.Element {
  const theme = useTheme();
  const { height, fontScale } = useWindowDimensions();
  const heading = useRef<React.ElementRef<typeof Text>>(null);
  const focusKey = p.focusKey ?? p.title;
  useEffect(() => {
    if (Platform.OS !== 'ios') return; // Android uses the title's polite live region.
    let active = true;
    void AccessibilityInfo.isScreenReaderEnabled()
      .then((enabled) => {
        if (!enabled || !active || !heading.current) return;
        const target = findNodeHandle(heading.current);
        if (target !== null) AccessibilityInfo.setAccessibilityFocus(target);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [focusKey]);
  const compact = height < 650 || fontScale > 1.4;
  const accent = p.signal === 'declined' ? theme.bad : theme.muted;
  const titleColor = p.resultTone === 'bad' ? theme.bad : p.resultTone === 'good' ? theme.good : theme.text;
  const glyph = p.signal === 'declined' ? '×' : p.signal === 'saved' ? '✓' : p.signal === 'attention' ? '!' : '−';
  return (
    <SafeAreaView style={[styles.page, { backgroundColor: theme.page }]}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.column}>
          <View style={styles.stage}>
            {p.signal === 'card' ? (
              <Image
                accessible={false}
                accessibilityIgnoresInvertColors
                importantForAccessibility="no"
                source={require('./assets/cashu-card.png')}
                resizeMode="contain"
                style={[styles.cardArt, compact && styles.smallCard]}
              />
            ) : p.signal === 'paid' ? (
              <PaidCelebration key={p.receiptKey} afterScanSheet={p.afterScanSheet} />
            ) : (
              <View
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[styles.signal, { borderColor: accent, backgroundColor: theme.field }]}
              >
                {p.signal === 'busy' ? (
                  <ActivityIndicator size="small" color={accent} />
                ) : (
                  <Text allowFontScaling={false} style={[styles.glyph, { color: accent }]}>
                    {glyph}
                  </Text>
                )}
              </View>
            )}
            <Text
              ref={heading}
              accessible
              testID={p.titleID}
              accessibilityRole="header"
              accessibilityLiveRegion="polite"
              style={[styles.stageTitle, { color: titleColor }, p.resultTone && { fontSize: TYPE.headline }]}
            >
              {p.title}
            </Text>
            <SaleAmount testID={p.amountID} receipt={p.resultTone !== undefined}>
              {p.amount}
            </SaleAmount>
            {p.description}
          </View>
          {p.children}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  scroll: { flexGrow: 1 },
  column: { flexGrow: 1, width: '100%', maxWidth: 560, alignSelf: 'center', padding: 20, gap: 8 },
  stage: { flexGrow: 1, flexShrink: 0, alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 24 },
  stageTitle: { fontFamily: FONT.bold, fontSize: 31, letterSpacing: -0.8, textAlign: 'center' },
  amount: { fontFamily: FONT.semibold, fontVariant: ['tabular-nums'], letterSpacing: -1.2 },
  cardArt: {
    width: '60%',
    maxWidth: 208,
    aspectRatio: 1048 / 663,
    height: undefined,
    transform: [{ rotate: '-5deg' }],
    marginVertical: 12,
    borderRadius: 14,
  },
  smallCard: { maxWidth: 130 },
  signal: { width: 66, height: 66, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderRadius: 33 },
  glyph: { fontSize: 34, fontWeight: '600', textAlign: 'center' },
  surface: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 12, marginBottom: 8, gap: 3 },
});
