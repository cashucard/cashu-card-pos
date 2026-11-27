import { useColorScheme } from 'react-native';

export interface Palette {
  page: string; text: string; muted: string;
  primary: string; primaryText: string;
  plain: string; plainText: string;
  danger: string; dangerText: string;
  good: string; bad: string; line: string; field: string;
}
export const LIGHT: Palette = {
  page: '#f1f5ec', text: '#10271e', muted: '#486051',
  primary: '#254b36', primaryText: '#edfacf',
  plain: '#e0eadb', plainText: '#183c28',
  danger: '#923e36', dangerText: '#ffffff',
  good: '#295b2b', bad: '#8b342d', line: '#bdccbc', field: '#fbfcf7',
};
export const DARK: Palette = {
  page: '#10271e', text: '#edf3e7', muted: '#becfc0',
  primary: '#d3f39a', primaryText: '#10271e',
  plain: '#1b3d32', plainText: '#edf3e7',
  danger: '#f39489', dangerText: '#301811',
  good: '#d3f39a', bad: '#f39489', line: '#3d5b4c', field: '#15332a',
};
export const FONT = {
  regular: 'Figtree-Regular',
  semibold: 'Figtree-SemiBold',
  bold: 'Figtree-Bold',
} as const;
export const SPACE = { xs: 4, s: 8, m: 16, l: 24, xl: 32 } as const;
export const TYPE = { small: 14, body: 17, button: 18, title: 35, amount: 44, headline: 48 } as const;
/** The least height, in points, of anything the merchant presses: large, for a counter. */
export const TOUCH = 56;

const HEX = /^#[0-9a-fA-F]{6}$/;

/** One channel's value, 0 to 1, in the WCAG relative luminance. */
function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** The relative luminance of a '#rrggbb' colour, 0 to 1. */
function luminance(colour: string): number {
  if (!HEX.test(colour)) {
    throw new Error('not a colour: ' + colour);
  }
  const r = parseInt(colour.slice(1, 3), 16);
  const g = parseInt(colour.slice(3, 5), 16);
  const b = parseInt(colour.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2 contrast ratio of two '#rrggbb' colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

/** DARK for 'dark'; LIGHT for anything else (null and undefined too). */
export function paletteFor(scheme: string | null | undefined): Palette {
  return scheme === 'dark' ? DARK : LIGHT;
}

/** The palette for the system's current light or dark setting. */
export function useTheme(): Palette {
  return paletteFor(useColorScheme());
}
