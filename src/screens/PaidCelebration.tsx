import React, { useLayoutEffect, useRef, useState } from 'react';
import { Animated, AppState, Easing, StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Path } from 'react-native-svg';
import type { AfterScanSheet } from '../till/scan-sheet';
import { useMotionEnvironment } from '../ui/motion';
import { useTheme } from '../ui/theme';

// The small mint mark pressed into the rim uses the Cashu Card cashew silhouette.
const CASHEW = 'M58 7C76 7 90 18 90 33C90 46 78 50 66 52C58 53 55 60 59 68C62 74 70 77 70 85C70 92 63 96 54 96C30 96 10 77 10 52C10 27 31 7 58 7Z';
const CHECK_WIDTH = 47;

/** Mounted only for the current, newly confirmed sale. The receipt and its actions are available throughout. */
export function PaidCelebration({ afterScanSheet }: { afterScanSheet?: AfterScanSheet }): React.JSX.Element {
  const theme = useTheme();
  const { reduced, visibility, backgroundEpoch } = useMotionEnvironment();
  const [progress] = useState(() => new Animated.Value(afterScanSheet && reduced === false && visibility !== 'background' ? 0 : 1));
  const receipt = useRef({ epoch: backgroundEpoch, enteredAt: Date.now(), consumed: false }).current;

  useLayoutEffect(() => {
    // A disabled setting or a real app switch retires the effect. Core NFC can instead temporarily mark iOS inactive.
    if (reduced || visibility === 'background' || backgroundEpoch !== receipt.epoch ||
        (visibility === 'inactive' && !afterScanSheet)) receipt.consumed = true;
    if (receipt.consumed || reduced !== false) {
      progress.setValue(1);
      return;
    }
    // Keep the check undrawn until iOS really exposes the receipt. Reduced Motion always sees the finished coin.
    if (afterScanSheet) progress.setValue(0);
    if (visibility !== 'active') return;
    let mounted = true;
    let animation: Animated.CompositeAnimation | undefined;
    function play() {
      if (!mounted || receipt.consumed) return;
      if (AppState.currentState === 'background' || AppState.currentState === 'inactive') return;
      receipt.consumed = true;
      // A late preference query or an extended system interruption must not celebrate an old receipt.
      if (Date.now() - receipt.enteredAt > 8000) { progress.setValue(1); return; }
      progress.setValue(0);
      animation = Animated.timing(progress, {
        toValue: 1, duration: 680, easing: Easing.linear,
        useNativeDriver: true, isInteraction: false,
      });
      animation.start();
    }
    // Only the physical iOS reader supplies a dismissal signal. Android and the simulator can play immediately.
    let cancel: (() => void) | undefined;
    if (afterScanSheet) cancel = afterScanSheet(play);
    else play();
    return () => {
      mounted = false;
      cancel?.();
      animation?.stop();
      progress.setValue(1);
    };
  }, [reduced, visibility, backgroundEpoch, receipt, progress, afterScanSheet]);

  const stamp = progress.interpolate({ inputRange: [0, 0.30, 0.51, 1], outputRange: [0.85, 1.05, 1, 1] });
  const tilt = progress.interpolate({ inputRange: [0, 0.36, 0.54, 1], outputRange: ['-8deg', '2deg', '0deg', '0deg'] });
  const spray = progress.interpolate({ inputRange: [0, 0.12, 0.55, 1], outputRange: [0.59, 0.59, 0.95, 1.07] });
  const ink = progress.interpolate({ inputRange: [0, 0.12, 0.24, 0.57, 1], outputRange: [0, 0, 1, 1, 0] });
  // Move the two layers in opposite directions. The window uncovers the check while the vector stays on the coin.
  const reveal = progress.interpolate({ inputRange: [0, 0.16, 0.58, 1], outputRange: [-CHECK_WIDTH, -CHECK_WIDTH, 0, 0] });
  const counter = Animated.multiply(reveal, -1);

  return (
    <View testID="result-celebration" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={styles.art}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: ink, transform: [{ scale: spray }] }]}>
        <Svg width={132} height={110} viewBox="0 0 132 110">
          <Path d="M19 47l-8-2m23-24-4-6m68 6 5-6m9 45 9 1M28 83l-5 5" fill="none" stroke={theme.good} strokeWidth={3.2} strokeLinecap="round" />
          <Path d="M109 30c1 4 2 5 6 6-4 1-5 2-6 6-1-4-2-5-6-6 4-1 5-2 6-6Z" fill={theme.primary} />
          <Circle cx={19} cy={67} r={2.3} fill={theme.good} />
          <Circle cx={98} cy={92} r={2} fill={theme.good} />
        </Svg>
      </Animated.View>
      <Animated.View style={[styles.coin, { transform: [{ rotate: tilt }, { scale: stamp }] }]}>
        <Svg width={80} height={80} viewBox="0 0 80 80">
          <Circle cx={40} cy={40} r={37} fill={theme.primary} />
          <Circle cx={40} cy={40} r={32.5} fill="none" stroke={theme.primaryText} strokeWidth={1} opacity={0.5} />
          <G transform="translate(34.75 55) scale(.105) rotate(-14 50 50)">
            <Path d={CASHEW} fill={theme.primaryText} />
          </G>
          <Path d="M27 59.5l4 1.3m18 0 4-1.3" fill="none" stroke={theme.primaryText} strokeWidth={1.3} strokeLinecap="round" opacity={0.8} />
        </Svg>
        <Animated.View style={[styles.checkWindow, { transform: [{ translateX: reveal }] }]}>
          <Animated.View style={{ transform: [{ translateX: counter }] }}>
            <Svg width={CHECK_WIDTH} height={36} viewBox="0 0 47 36">
              <Path d="m5 18 12 11L42 5" fill="none" stroke={theme.primaryText} strokeWidth={6.4} strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  art: { width: 132, height: 110, alignItems: 'center', justifyContent: 'center' },
  coin: { width: 80, height: 80 },
  checkWindow: { position: 'absolute', left: 16.5, top: 18, width: CHECK_WIDTH, height: 36, overflow: 'hidden' },
});
