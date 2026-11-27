import React from 'react';
import { Animated, Image, Platform, Pressable, SafeAreaView, StyleSheet, Text, useWindowDimensions, View, type ImageSourcePropType, type ViewStyle } from 'react-native';
import { ShellInsets } from '../ui/kit';
import { DARK, FONT, useTheme } from '../ui/theme';
import type { MerchantTab } from './nav';

const destinations: ReadonlyArray<{ tab: MerchantTab; label: string; icon: ImageSourcePropType }> = [
  { tab: 'sale', label: 'Sell', icon: require('../ui/assets/pos-tab-sell.png') }, { tab: 'activity', label: 'Activity', icon: require('../ui/assets/pos-tab-activity.png') },
  { tab: 'wallet', label: 'Wallet', icon: require('../ui/assets/pos-tab-wallet.png') }, { tab: 'owed', label: 'Owed', icon: require('../ui/assets/pos-tab-owed.png') },
];

interface Props {
  current: MerchantTab;
  arrival?: Animated.WithAnimatedValue<ViewStyle>;
  onTab: (tab: MerchantTab) => void;
  onSettings: () => void;
  message?: string | null;
  children: React.ReactNode;
}

export function MerchantShell({ arrival, current, onTab, onSettings, message, children }: Props): React.JSX.Element {
  const p = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const largeText = width / fontScale < 245;
  return (
    <SafeAreaView style={[s.page, { backgroundColor: p.page }]}>
      <View style={[s.header, { borderColor: p.line }]}>
        <View style={s.brand} testID={current === 'sale' ? 'home-title' : undefined} accessible accessibilityLabel="Cashu Card POS">
          <Image accessible={false} resizeMode="contain" style={s.logo}
            source={p === DARK ? require('../ui/assets/cashu-wordmark.png') : require('../ui/assets/cashu-wordmark-light.png')} />
          <Text style={[s.pos, { color: p.muted }]}>POS</Text>
        </View>
        <Pressable testID="home-settings" accessibilityRole="button" accessibilityLabel="Settings" onPress={onSettings}
          style={({ pressed }) => [s.settings, { opacity: pressed ? 0.65 : 1 }]}>
          <Image accessible={false} source={require('../ui/assets/pos-settings.png')} style={[s.gear, { tintColor: p.muted }]} />
        </Pressable>
      </View>
      {!!message && <Text accessibilityRole="alert" testID="nav-message" style={[s.feedback, { color: p.bad }]}>{message}</Text>}
      <Animated.View style={[s.content, arrival]}><ShellInsets.Provider value={true}>{children}</ShellInsets.Provider></Animated.View>
      <View accessibilityRole="tablist" style={[s.bar, { borderColor: p.line }]}>
        {destinations.map(({ tab, label, icon }) => {
          const selected = tab === current;
          return (
            <Pressable key={tab} accessibilityRole={Platform.OS === 'ios' ? 'button' : 'tab'} testID={'home-' + tab}
              accessibilityLabel={tab === 'owed' ? 'Owed to cards' : label}
              accessibilityState={{ selected }} onPress={() => onTab(tab)}
              style={({ pressed }) => [s.tab, largeText ? s.twoColumns : s.fourColumns,
                { backgroundColor: selected ? p.plain : pressed ? p.field : p.page }]}>
              <Image accessible={false} source={icon} style={[s.icon, { tintColor: selected ? p.primary : p.muted }]} />
              <Text style={[s.tabText, { color: selected ? p.primary : p.muted }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1 }, content: { flex: 1, minHeight: 0 },
  header: { minHeight: 49, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth },
  brand: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', columnGap: 7 },
  logo: { width: 84, height: 27 }, pos: { fontSize: 12, fontFamily: FONT.semibold, letterSpacing: 1.5 },
  settings: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  gear: { height: 24, width: 24 }, icon: { height: 20, width: 20 },
  feedback: { paddingHorizontal: 18, paddingVertical: 5, fontFamily: FONT.semibold, fontSize: 15 },
  bar: { flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8, paddingVertical: 4, rowGap: 2 },
  tab: { minHeight: 50, rowGap: 2, alignItems: 'center', justifyContent: 'center', borderRadius: 14, paddingVertical: 5 },
  fourColumns: { width: '25%' }, twoColumns: { width: '50%', flexDirection: 'row', columnGap: 5 },
  tabText: { fontSize: 14, fontFamily: FONT.semibold, textAlign: 'center' },
});
