/**
 * Cashu Card POS (slice 0.2: the shell).
 *
 * The polyfills come first, in this order, before anything loads cashucard or @cashu/cashu-ts:
 *  1. crypto.getRandomValues, from a native module: the library throws without it.
 *  2. a whole URL: React Native's own leaves hostname and protocol unimplemented, and the library parses mint URLs.
 *  3. TextDecoder (and TextEncoder where Hermes lacks it): cashu-ts builds a TextDecoder when it loads, and the
 *     library decodes with { fatal: true }.
 * App is required after them, never imported, so that no import is hoisted above them.
 */
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import './src/polyfills';
import { AppRegistry } from 'react-native';
import { name as appName } from './app.json';

const App = require('./App').default;

AppRegistry.registerComponent(appName, () => App);
