import React, { useLayoutEffect, useState } from 'react';
import { Animated, Easing, SafeAreaView, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useMotionEnvironment } from '../ui/motion';
import { FONT, useTheme } from '../ui/theme';

type Gesture = 'tap' | 'hold' | 'remove' | 'stopping';

function ContactGuide({ gesture, compact }: { gesture: Gesture; compact: boolean }): React.JSX.Element {
  const p = useTheme();
  const { reduced, visibility } = useMotionEnvironment();
  const allowed = reduced === false && (visibility === 'active' || visibility === 'inactive');
  const [progress] = useState(() => new Animated.Value(1));
  useLayoutEffect(() => {
    if (!allowed || gesture === 'stopping') return;
    progress.setValue(0);
    const step = Animated.timing(progress, {
      toValue: 1, duration: gesture === 'remove' ? 420 : 1450,
      easing: Easing.inOut(Easing.quad), useNativeDriver: true, isInteraction: false,
    });
    const animation = gesture === 'remove' ? step : Animated.loop(step);
    animation.start();
    return () => { animation.stop(); progress.setValue(1); };
  }, [allowed, gesture, progress]);

  const width = compact ? 72 : 136;
  const height = compact ? 46 : 86;
  const slide = progress.interpolate({
    inputRange: [0, .52, .84, 1],
    outputRange: gesture === 'tap' ? [0, -8, -8, 0] : gesture === 'remove' ? [0, 7, 10, 10] : [0, 0, 0, 0],
  });
  const waves = progress.interpolate({ inputRange: [0, .45, .75, 1], outputRange: [.45, 1, 1, .45] });
  return (
    <View testID="nfc-contact-guide" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      pointerEvents="none" style={{ width, height }}>
      <Svg width={width} height={height} viewBox="0 0 82 52" fill="none">
        <Rect x="9" y="9" width="29" height="40" rx="5" stroke={p.muted} strokeWidth="2.2" />
        <Path d="M19 12h9m-8 33h7" stroke={p.muted} strokeWidth="1.8" strokeLinecap="round" />
      </Svg>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: waves }]}>
        <Svg width={width} height={height} viewBox="0 0 82 52">
          <Path d="M31 20q5 2 6 7m-7-11q8 2 11 11" fill="none" stroke={p.good} strokeWidth="1.8" strokeLinecap="round" />
        </Svg>
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX: slide }] }]}>
        <Svg width={width} height={height} viewBox="0 0 82 52">
          <Rect x="35" y="4" width="38" height="23" rx="4" fill={p.primary} transform="rotate(-8 35 4)" />
          <Circle cx="43.5" cy="11.5" r="2.6" fill={p.primaryText} />
          <Path d="m44 20 12-1.7" stroke={p.primaryText} strokeWidth="1.6" strokeLinecap="round" />
        </Svg>
      </Animated.View>
    </View>
  );
}

interface NfcStageProps {
  gesture: Gesture;
  title: string;
  titleID: string;
  value: string;
  valueID?: string;
  detail?: string;
  detailID?: string;
  children?: React.ReactNode;
}

/** Core NFC owns the bottom of the display. Keep one safe area inside the top half of the window. */
export function NfcStage(p: NfcStageProps): React.JSX.Element {
  const theme = useTheme();
  const { width, height, fontScale } = useWindowDimensions();
  const compact = height < 700 || width / fontScale < 265;
  return (
    <View style={[styles.page, { backgroundColor: theme.page }]}>
      <SafeAreaView testID="nfc-top-half" style={styles.half}>
        <ScrollView contentInsetAdjustmentBehavior="never" automaticallyAdjustContentInsets={false}
          contentContainerStyle={[styles.content, compact && styles.compact]}>
          <View style={styles.firstRow}>
            <Text testID={p.valueID} style={[styles.value, { color: theme.good, fontSize: compact ? 25 : 36 }]}
              accessibilityLabel={p.value} adjustsFontSizeToFit numberOfLines={1}>{p.value}</Text>
            <ContactGuide gesture={p.gesture} compact={compact} />
          </View>
          <Text testID={p.titleID} accessibilityRole="header" accessibilityLabel={p.title}
            adjustsFontSizeToFit={compact} numberOfLines={compact ? 2 : undefined}
            style={[styles.title, { color: theme.text, fontSize: compact ? 22 : 30 }]}>{p.title}</Text>
          {p.detail && <Text testID={p.detailID}
            style={[styles.detail, { color: theme.muted, fontSize: compact ? 16 : 18 }]}>{p.detail}</Text>}
        </ScrollView>
      </SafeAreaView>
      <SafeAreaView style={styles.actionsArea}>
        <View style={styles.actions}>{p.children}</View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  half: { height: '50%', overflow: 'hidden' },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 24, paddingVertical: 12, gap: 8 },
  compact: { paddingHorizontal: 16, paddingVertical: 3, gap: 3 },
  firstRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  value: { flexShrink: 1, fontFamily: FONT.bold, fontVariant: ['tabular-nums'], letterSpacing: -.6 },
  title: { fontFamily: FONT.bold, letterSpacing: -.6 },
  detail: { fontFamily: FONT.regular },
  actionsArea: { flex: 1, justifyContent: 'flex-end' },
  actions: { width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 20, paddingBottom: 12 },
});
