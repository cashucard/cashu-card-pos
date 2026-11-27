import { contrast, DARK, LIGHT, paletteFor, SPACE, TOUCH, type Palette } from '../src/ui/theme';

describe('theme', () => {
  it('paletteFor follows the system', () => {
    expect(paletteFor('dark')).toBe(DARK);
    expect(paletteFor('light')).toBe(LIGHT);
    expect(paletteFor(null)).toBe(LIGHT);
    expect(paletteFor(undefined)).toBe(LIGHT);
  });

  it('both palettes name the same colours, each as #rrggbb', () => {
    const light = Object.keys(LIGHT).sort();
    const dark = Object.keys(DARK).sort();
    expect(light).toEqual(dark);
    expect(light).toHaveLength(13);
    for (const key of light) {
      expect(LIGHT[key as keyof Palette]).toMatch(/^#[0-9a-f]{6}$/);
      expect(DARK[key as keyof Palette]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('contrast is the WCAG ratio', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrast('#ffffff', '#ffffff')).toBe(1);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
    expect(() => contrast('red', '#ffffff')).toThrow(/not a colour/);
  });

  it('every pair the screens use is legible, in light and in dark', () => {
    for (const p of [LIGHT, DARK]) {
      expect(contrast(p.text, p.page)).toBeGreaterThanOrEqual(7);
      expect(contrast(p.text, p.field)).toBeGreaterThanOrEqual(7);
      expect(contrast(p.muted, p.page)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.good, p.page)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.bad, p.page)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.primaryText, p.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.plainText, p.plain)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.dangerText, p.danger)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('a pressed thing is large', () => {
    expect(TOUCH).toBeGreaterThanOrEqual(48);
    expect(SPACE.m).toBe(16);
  });
});
