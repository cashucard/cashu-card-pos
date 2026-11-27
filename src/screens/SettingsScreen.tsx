import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Body, Screen } from '../ui/kit';
import { FONT, useTheme } from '../ui/theme';

export type SettingsGo = 'mints' | 'owed' | 'records' | 'backups' | 'topup-receipts' | 'offline-settings' | 'about';

export interface SettingsProps {
  gateAvailable: boolean | null;
  note: string | null;
  onGo: (where: SettingsGo) => void;
  onBack: () => void;
}

export const GATE_LINES: Readonly<{ asking: string; yes: string; no: string }> = {
  asking: 'Checking how this phone confirms it is you.',
  yes: "Changing mints, records and the wallet asks for this phone's passcode, Face ID or fingerprint.",
  no: 'Set a passcode on this phone to change mints, records and the wallet.',
};

const destinations: ReadonlyArray<{ route: SettingsGo; label: string }> = [
  { route: 'mints', label: 'Mints' },
  { route: 'owed', label: 'Owed to cards' },
  { route: 'topup-receipts', label: 'Card top-up receipts' },
  { route: 'offline-settings', label: 'Offline payments' },
  { route: 'backups', label: 'Backups and change' },
  { route: 'records', label: 'Records and reset' },
  { route: 'about', label: 'About this till' },
];

/** The settings: what it takes to change the till's own things, and the ways on. */
export function SettingsScreen(p: SettingsProps): React.JSX.Element {
  const palette = useTheme();
  return (
    <Screen title="Settings" titleID="settings-title" onBack={p.onBack}>
      {p.gateAvailable === null ? (
        <Body testID="settings-gate">{GATE_LINES.asking}</Body>
      ) : p.gateAvailable === true ? (
        <Body testID="settings-gate">{GATE_LINES.yes}</Body>
      ) : (
        <Body testID="settings-gate" tone="bad">
          {GATE_LINES.no}
        </Body>
      )}
      {p.note !== null ? (
        <Body testID="settings-note" tone="bad">
          {p.note}
        </Body>
      ) : null}
      <View style={[styles.list, {backgroundColor: palette.field, borderColor: palette.line}]}>
        {destinations.map(({route, label}, index) => (
          <Pressable key={route} testID={'settings-' + route} accessibilityRole="button" accessibilityLabel={label}
            onPress={() => p.onGo(route)} style={({pressed}) => [
              styles.row, { borderColor: palette.line, backgroundColor: pressed ? palette.plain : palette.field },
              index > 0 && styles.divider,
            ]}>
            <Text style={[styles.name, {color: palette.text}]}>{label}</Text>
            <Text accessible={false} importantForAccessibility="no" style={[styles.chevron, {color: palette.muted}]}>›</Text>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { borderRadius: 18, borderWidth: 1, overflow: 'hidden', marginVertical: 12 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 58,
    paddingHorizontal: 18, paddingVertical: 12, gap: 12 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth },
  name: { flex: 1, fontFamily: FONT.semibold, fontSize: 18 },
  chevron: { fontSize: 24 },
});
