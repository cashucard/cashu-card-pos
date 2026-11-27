import React, { useMemo, useState } from 'react';
import { PixelRatio, StyleSheet, useWindowDimensions, View } from 'react-native';
import qrcode from 'qrcode-generator';
import Svg, { Path, Rect } from 'react-native-svg';

/** Cashu tokens are ASCII. A single QR symbol holds at most 2,953 bytes. */
export function tokenQr(token: string): { side: number; path: string } | null {
  if (!token || token.length > 2953) return null;
  const code = qrcode(0, token.length <= 2331 ? 'M' : 'L');
  code.addData(token, 'Byte');
  code.make();

  const modules = code.getModuleCount();
  const margin = 4;
  const runs: string[] = [];
  for (let y = 0; y < modules; y++) {
    let x = 0;
    while (x < modules) {
      if (!code.isDark(y, x)) {
        x++;
        continue;
      }
      const start = x++;
      while (x < modules && code.isDark(y, x)) x++;
      const length = x - start;
      runs.push(`M${start + margin} ${y + margin}h${length}v1h-${length}z`);
    }
  }
  return { side: modules + 2 * margin, path: runs.join('') };
}

export function CashuQr({ value, label, imageID, fallback, maxWidth = 340 }: {
  value: string;
  label: string;
  imageID: string;
  fallback: React.JSX.Element;
  maxWidth?: number;
}): React.JSX.Element {
  const window = useWindowDimensions();
  const [columnWidth, setColumnWidth] = useState(0);
  const qr = useMemo(() => tokenQr(value), [value]);
  if (!qr) return fallback;
  const side = Math.min(maxWidth, columnWidth || Math.max(1, window.width - 40));
  const scale = PixelRatio.get();
  const modulePixels = Math.floor(side * scale / qr.side);
  const qrSize = modulePixels > 0 ? qr.side * modulePixels / scale : '100%';
  return (
    <View style={styles.column} onLayout={e => setColumnWidth(e.nativeEvent.layout.width)}>
      <View style={[styles.qrFrame, { width: side, height: side }]}
        accessible accessibilityRole="image" accessibilityLabel={label} testID={imageID}>
        <Svg width={qrSize} height={qrSize} viewBox={`0 0 ${qr.side} ${qr.side}`}>
          <Rect width={qr.side} height={qr.side} fill="#ffffff" />
          <Path d={qr.path} fill="#000000" />
        </Svg>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { width: '100%', alignItems: 'center', marginVertical: 12 },
  qrFrame: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#ffffff' },
});
