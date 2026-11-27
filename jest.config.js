/**
 * jest for the shell's plain functions (slice 0.2): Node, fakes only, no network.
 *
 * roots: the app's own code. harness/ is a separate package with its own tests (vitest) and node_modules.
 * moduleNameMapper: cashucard's exports map has the `import` condition only, and React Native's jest environment
 *   asks for `require` and `react-native` (react-native/jest/react-native-env.js), so its entry is named here.
 * transformIgnorePatterns: cashucard, @cashu/cashu-ts, @noble and @scure ship ES modules; babel-jest makes them CommonJS.
 * __tests__/helpers holds shared fakes, not tests.
 */
module.exports = {
  preset: 'react-native',
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/harness/', '<rootDir>/__tests__/helpers/'],
  modulePathIgnorePatterns: ['<rootDir>/harness/'],
  moduleNameMapper: { '^cashucard$': '<rootDir>/node_modules/cashucard/dist/index.js' },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|cashucard(-react-native)?|react-native-nfc-manager|react-native-svg|@cashu|@noble|@scure)/)',
  ],
  cacheDirectory: '<rootDir>/.jest-cache',
  watchman: false,
};
