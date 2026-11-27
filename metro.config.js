const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Metro for Cashu Card POS (slice 0.2).
 *
 * unstable_enablePackageExports: `cashucard` names its entry only in an `exports` map, under the `import`
 * condition, and @cashu/cashu-ts 4 has no `main` at all. React Native's defaults already assert `require`,
 * `import` and `react-native`, and Metro adds `default`, so no condition list is set here.
 *
 * blockList: `harness/` is the separate Node package of slice 0.1, with its own node_modules (and a second copy of
 * cashucard). The app never imports from it; Metro must neither crawl it nor resolve into it.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    unstable_enablePackageExports: true,
    blockList: [new RegExp('^' + escape(path.join(__dirname, 'harness')) + '/.*$')],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
