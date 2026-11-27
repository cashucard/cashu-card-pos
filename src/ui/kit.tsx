import React from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { FONT, SPACE, TOUCH, TYPE, useTheme, type Palette } from './theme';

/** The tab shell already provides the device safe area to its content. */
export const ShellInsets = React.createContext(false);

export interface ScreenProps {
  title: string;
  titleID: string;
  titleAction?: React.ReactNode;
  onBack?: () => void;
  children?: React.ReactNode;
  adjustForKeyboard?: boolean;
  keypad?: boolean;
  /** the title as the screen's headline: larger than any amount on it */
  headline?: boolean;
  /** the title's colour, as a Body's tone; normal when not given */
  titleTone?: 'normal' | 'muted' | 'good' | 'bad';
  /** a muted line above the title that names what the page is about, and its testID */
  overline?: string;
  overlineID?: string;
}

/** A page: the safe area, a scrolling column, a Back button when there is somewhere to go, and the title. */
export function Screen(p: ScreenProps): React.JSX.Element {
  const palette = useTheme();
  const { height } = useWindowDimensions();
  const compactKeypad = p.keypad && height < 780;
  const Container = React.useContext(ShellInsets) ? View : SafeAreaView;
  const title = (
    <Text testID={p.titleID} accessibilityRole="header"
      style={[
        styles.title,
        compactKeypad && styles.compactKeypadTitle,
        p.titleAction ? styles.titleWithAction : null,
        p.headline ? styles.headline : null,
        { color: toneColour(palette, p.titleTone ?? 'normal') },
      ]}>
      {p.title}
    </Text>
  );
  return (
    <Container style={[styles.screen, { backgroundColor: palette.page }]}>
      <ScrollView contentContainerStyle={[styles.scroll, compactKeypad && styles.compactKeypadScroll]} keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets={p.adjustForKeyboard} keyboardDismissMode={p.adjustForKeyboard ? 'on-drag' : undefined}>
        {p.onBack !== undefined ? (
          <Pressable testID="nav-back" accessibilityRole="button" accessibilityLabel="Back"
            onPress={p.onBack} style={({pressed}) => [styles.back, {opacity: pressed ? 0.65 : 1}]}>
            <Text style={[styles.backText, {color: palette.good}]}>‹  Back</Text>
          </Pressable>
        ) : null}
        {p.overline !== undefined ? (
          <Text testID={p.overlineID} style={[styles.overline, { color: palette.muted }]}>
            {p.overline}
          </Text>
        ) : null}
        {p.titleAction ? <View style={styles.titleRow}>{title}{p.titleAction}</View> : title}
        {p.children}
      </ScrollView>
    </Container>
  );
}

export interface BodyProps {
  testID?: string;
  accessibilityLabel?: string;
  children: string;
  tone?: 'normal' | 'muted' | 'good' | 'bad';
  big?: boolean;
}

function toneColour(palette: Palette, tone: 'normal' | 'muted' | 'good' | 'bad'): string {
  switch (tone) {
    case 'muted':
      return palette.muted;
    case 'good':
      return palette.good;
    case 'bad':
      return palette.bad;
    case 'normal':
      return palette.text;
  }
}

/** A line of body text, at reading size or at the amount's size when big. */
export function Body(p: BodyProps): React.JSX.Element {
  const palette = useTheme();
  const big = p.big === true;
  const colour = toneColour(palette, p.tone ?? 'normal');
  return (
    <Text
      testID={p.testID}
      accessibilityLabel={p.accessibilityLabel}
      style={[styles.body, big ? styles.big : styles.normal, { color: colour }]}
    >
      {p.children}
    </Text>
  );
}

export interface ButtonProps {
  testID: string;
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: 'primary' | 'plain' | 'danger';
}

/** A target the merchant presses: never shorter than TOUCH, disabled with its own faded look. */
export function Button(p: ButtonProps): React.JSX.Element {
  const palette = useTheme();
  const disabled = p.disabled === true;
  const kind = p.kind ?? 'primary';
  let background = palette.primary;
  let colour = palette.primaryText;
  if (kind === 'plain') {
    background = palette.plain;
    colour = palette.plainText;
  } else if (kind === 'danger') {
    background = palette.danger;
    colour = palette.dangerText;
  }
  return (
    <Pressable
      testID={p.testID}
      accessibilityRole="button"
      accessibilityLabel={p.accessibilityLabel ?? p.label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={p.onPress}
      style={({pressed}) => [
        styles.button,
        { backgroundColor: background, borderColor: kind === 'plain' ? palette.line : background,
          opacity: disabled ? 0.48 : pressed ? 0.76 : 1 },
      ]}
    >
      <Text style={[styles.buttonText, { color: colour }]}>{p.label}</Text>
    </Pressable>
  );
}

export interface FieldProps {
  testID: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  url?: boolean;
  accessibilityLabel?: string;
  keyboardType?: 'email-address' | 'number-pad';
  editable?: boolean;
  secure?: boolean;
}

/** A text field in the palette's field colours. */
export function Field(p: FieldProps): React.JSX.Element {
  const palette = useTheme();
  return (
    <TextInput
      testID={p.testID}
      value={p.value}
      onChangeText={p.onChangeText}
      placeholder={p.placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      selectionColor={palette.good}
      accessibilityLabel={p.accessibilityLabel ?? p.placeholder}
      editable={p.editable}
      secureTextEntry={p.secure}
      autoComplete={p.secure ? 'off' : undefined}
      importantForAutofill={p.secure ? 'no' : undefined}
      spellCheck={p.secure ? false : undefined}
      maxLength={p.secure ? 256 : undefined}
      keyboardType={p.keyboardType ?? (p.url === true ? 'url' : 'default')}
      returnKeyType={p.keyboardType ? 'done' : undefined}
      placeholderTextColor={palette.muted}
      style={[
        styles.field,
        { borderColor: palette.line, backgroundColor: palette.field, color: palette.text },
      ]}
    />
  );
}

/** A blank space one step larger than the gap between body lines. */
export function Gap(): React.JSX.Element {
  return <View style={styles.gap} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  titleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8 },
  titleWithAction: { flexShrink: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 20, paddingTop: SPACE.s, paddingBottom: SPACE.l },
  compactKeypadScroll: { paddingVertical: SPACE.xs, paddingBottom: SPACE.s },
  compactKeypadTitle: { fontSize: 28, marginVertical: SPACE.xs },
  back: { minHeight: 44, minWidth: 56, alignSelf: 'flex-start', justifyContent: 'center' },
  backText: { fontFamily: FONT.semibold, fontSize: TYPE.body },
  title: { fontSize: TYPE.title, fontFamily: FONT.bold, letterSpacing: -1.4, marginVertical: SPACE.s },
  overline: { fontFamily: FONT.semibold, fontSize: TYPE.small, marginTop: SPACE.m },
  headline: { fontSize: TYPE.headline, letterSpacing: -1.8 },
  body: { marginBottom: SPACE.s, fontFamily: FONT.regular },
  normal: { fontSize: TYPE.body },
  big: { fontSize: TYPE.amount, fontFamily: FONT.semibold, letterSpacing: -1.4, fontVariant: ['tabular-nums'] },
  button: {
    minHeight: TOUCH, borderRadius: 16, borderWidth: 1, paddingVertical: 12,
    paddingHorizontal: SPACE.m, justifyContent: 'center', marginVertical: SPACE.xs,
  },
  buttonText: { fontSize: TYPE.button, fontFamily: FONT.bold, textAlign: 'center' },
  field: {
    minHeight: TOUCH, borderWidth: 1, borderRadius: 12,
    fontFamily: FONT.regular, fontSize: TYPE.body, paddingHorizontal: SPACE.m, marginVertical: SPACE.s,
  },
  gap: { height: SPACE.m },
});
