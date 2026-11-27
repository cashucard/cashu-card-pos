import React, { useLayoutEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useMotionAllowed } from '../ui/motion';
import { FONT, SPACE, TYPE, useTheme } from '../ui/theme';

/** A short scan over the wallet after the merchant reads its balance. */
export function WalletRefreshed(): React.JSX.Element {
  const theme = useTheme();
  const allowed = useMotionAllowed();
  const [progress] = useState(() => new Animated.Value(1));
  const seen = useRef(false);
  useLayoutEffect(() => {
    const play = allowed && !seen.current;
    seen.current = true;
    if (!play) return;
    progress.setValue(0);
    const scan = Animated.timing(progress, {
      toValue: 1, duration: 380, easing: Easing.out(Easing.quad),
      useNativeDriver: true, isInteraction: false,
    });
    scan.start();
    return () => { scan.stop(); progress.setValue(1); };
  }, [allowed, progress]);

  return (
    <View style={styles.row} accessibilityLiveRegion="polite">
      <View style={styles.wallet} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Svg width={30} height={30} viewBox="0 0 30 30" fill="none">
          <Path d="M5 10.5v-2a2 2 0 0 1 2-2l13-2 .5 4M5 10.5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" stroke={theme.good} strokeWidth={1.5} strokeLinejoin="round" />
          <Path d="M25 14h-6a2.5 2.5 0 0 0 0 5h6" stroke={theme.good} strokeWidth={1.5} />
          <Circle cx={19} cy={16.5} r={1} fill={theme.good} />
        </Svg>
        {allowed && <Animated.View style={[styles.scan, {
          opacity: progress.interpolate({ inputRange: [0, .22, .7, 1], outputRange: [0, .85, .85, 0] }),
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [5, 23] }) }],
        }]}>
          <Svg width={30} height={3}><Path d="M4 1.5h22" stroke={theme.good} strokeWidth={2} strokeLinecap="round" /></Svg>
        </Animated.View>}
      </View>
      <Text testID="wallet-refreshed" style={[styles.status, { color: theme.good }]}>Wallet refreshed</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.s, marginTop: SPACE.s },
  wallet: { width: 30, height: 30 },
  scan: { position: 'absolute', top: 0, left: 0 },
  status: { fontFamily: FONT.semibold, fontSize: TYPE.small, flexShrink: 1 },
});
