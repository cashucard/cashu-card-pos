/*
 * The text polyfills for Hermes (slice 0.2). index.js loads this third, after react-native-get-random-values and
 * react-native-url-polyfill/auto, and before anything that imports cashucard or @cashu/cashu-ts.
 * A native class is kept; a missing one is installed from @sinonjs/text-encoding, which implements `fatal`.
 * __ccposPolyfills says which ran, for the self-test.
 */
import { TextDecoder, TextEncoder } from '@sinonjs/text-encoding';

const marks = { textEncoder: 'native', textDecoder: 'native' };
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoder;
  marks.textEncoder = 'polyfill';
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = TextDecoder;
  marks.textDecoder = 'polyfill';
}
globalThis.__ccposPolyfills = marks;
