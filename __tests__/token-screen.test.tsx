import React from 'react';
import { AccessibilityInfo, Clipboard, Platform, Text } from 'react-native';
import jsQR from 'jsqr';
import Svg, { Path, Rect } from 'react-native-svg';
import { PUBLIC_TESTNUT_QR } from './helpers/public-testnut-token';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { TokenScreen, tokenQr } from '../src/screens/TokenScreen';
import { has, press, textOf } from './helpers/render';

test('a token too large for one QR can be copied in full only on request', async () => {
  const token = 'cashuB' + 'A'.repeat(2948);
  expect(tokenQr('')).toBeNull();
  expect(tokenQr(token)).toBeNull();
  const copy = jest.spyOn(Clipboard, 'setString').mockImplementation(() => {});
  const os = jest.replaceProperty(Platform, 'OS', 'ios');
  const enabled = jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
  const speak = jest.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions').mockImplementation(() => {});
  let tree!: ReactTestRenderer;
  try {
    await act(async () => {
      tree = renderer.create(<TokenScreen title="Customer return" token={token} onDone={() => {}} />);
    });
    expect(has(tree, 'token-qr')).toBe(false);
    expect(has(tree, 'token-too-long')).toBe(true);
    expect(has(tree, 'token-text')).toBe(false);
    expect(copy).not.toHaveBeenCalled();
    await press(tree, 'token-copy');
    expect(copy).toHaveBeenCalledWith(token);
    await press(tree, 'token-show-text');
    expect(textOf(tree, 'token-text')).toBe(token);
    const revealed = tree.root.findAllByType(Text).find(n => n.props.testID === 'token-text');
    expect(revealed!.props.accessibilityLabel).toBe('Token text visible. Use Copy token to copy it.');
    await press(tree, 'token-show-text');
    expect(has(tree, 'token-text')).toBe(false);
    expect(speak.mock.calls).toEqual([['Token copied to the clipboard.', { queue: true }]]);
  } finally {
    act(() => tree?.unmount());
    copy.mockRestore();
    speak.mockRestore();
    enabled.mockRestore();
    os.restore();
  }
});

// Paint the literal path from the rendered component. There is no second encoder in this test.
function rasterizeRuns(side: number, path: string) {
  const scale = 4;
  const pixels = side * scale;
  const image = new Uint8ClampedArray(pixels * pixels * 4).fill(255);
  const runs = /M(\d+) (\d+)h(\d+)v1h-\3z/g;
  let consumed = 0;
  for (const match of path.matchAll(runs)) {
    if (match.index !== consumed) throw new Error('Invalid QR subpath');
    consumed += match[0].length;
    const [x, y, length] = match.slice(1).map(Number);
    if (x < 4 || y < 4 || x + length > side - 4 || y >= side - 4) throw new Error('QR quiet zone was drawn over');
    for (let row = y * scale; row < (y + 1) * scale; row++) {
      for (let col = x * scale; col < (x + length) * scale; col++) {
        const index = 4 * (row * pixels + col);
        image.fill(0, index, index + 3);
      }
    }
  }
  expect(consumed).toBe(path.length);
  return { image, pixels };
}

test.each([
  ['public Testnut fixture', PUBLIC_TESTNUT_QR],
  ['largest medium-correction token', 'cashuB' + 'X7'.repeat(1162) + 'Z'],
  ['switch to low correction', 'cashuB' + '7X'.repeat(1163)],
  ['largest single symbol', 'cashuB' + 'Qa'.repeat(1473) + '0'],
])('decodes the displayed QR for %s', (_description, token) => {
  let tree!: ReactTestRenderer;
  try {
    act(() => { tree = renderer.create(<TokenScreen title="Test fixture" token={token} onDone={() => {}} />); });
    const svg = tree.root.findByType(Svg);
    const white = svg.findByType(Rect).props;
    const black = svg.findByType(Path).props;
    expect(white.width).toBe(white.height);
    expect(svg.props.viewBox).toBe(`0 0 ${white.width} ${white.height}`);
    expect(white.fill).toBe('#ffffff');
    expect(black.fill).toBe('#000000');
    const { image, pixels } = rasterizeRuns(white.width, black.d);
    expect(jsQR(image, pixels, pixels, { inversionAttempts: 'dontInvert' })?.data).toBe(token);
    expect(has(tree, 'token-text')).toBe(false);
  } finally {
    act(() => tree?.unmount());
  }
});
