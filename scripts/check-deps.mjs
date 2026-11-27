// The app's lockfile holds the pins the library needs (slice 0.2). Offline; exits 1 on any miss.
import { readFileSync } from 'node:fs';

const lock = readFileSync(new URL('../yarn.lock', import.meta.url), 'utf8');
const entries = lock.split(/\n(?=[^\s#])/).map((block) => ({
  key: block.split('\n')[0],
  version: (block.match(/\n {2}version "([^"]+)"/) || [])[1],
}));
const named = (name) => entries.filter((e) => e.key.replace(/^"/, '').startsWith(name + '@'));
const bad = [];
const want = (name, version, count) => {
  const found = named(name);
  if (found.length === 0 || (count !== undefined && found.length !== count) || found.some((e) => e.version !== version)) {
    bad.push(name + ': want ' + version + (count ? ' in ' + count + ' entry' : '') + ', found ' + JSON.stringify(found));
  }
};
for (const n of ['@noble/curves', '@noble/hashes', '@scure/base', '@scure/bip32']) want(n, '2.4.0');
want('@cashu/cashu-ts', '4.11.0', 1);
want('cashucard', '0.3.0+pos.11', 1);
want('cashucard-react-native', '0.3.0', 1);
want('react-native-nfc-manager', '3.17.5', 1);
want('react-native', '0.77.1', 1);
want('react', '18.3.1', 1);
want('@op-engineering/op-sqlite', '14.1.4', 1);
want('react-native-keychain', '10.0.0', 1);
const cc = named('cashucard')[0];
if (cc && !cc.key.includes('harness/vendor/cashucard-0.3.0+pos.11.tgz')) bad.push('cashucard is not the vendored tarball: ' + cc.key);
const nfc = named('cashucard-react-native')[0];
if (nfc && !nfc.key.includes('harness/vendor/cashucard-react-native-0.3.0.tgz')) bad.push('cashucard-react-native must resolve to the vendored tarball');
if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.log('DEPS OK');
