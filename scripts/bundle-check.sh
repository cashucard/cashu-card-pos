#!/bin/sh
# Offline, before any Xcode or Gradle build: Metro bundles index.js for each platform as a release build would
# (cashucard's exports map resolved, every module transformed), and Hermes's compiler turns each bundle into bytecode.
# Writes only under .bundle-check/ (git-ignored). Needs no network, no simulator, no watchman.
set -eu
cd "$(dirname "$0")/.."
sh scripts/redirect-check.sh   # slice 2.5: what the native redirect refusal leans on (every Gradle and Xcode build runs it too)
OUT=.bundle-check
rm -rf "$OUT"
mkdir -p "$OUT/tmp"
export TMPDIR="$PWD/$OUT/tmp"
HERMESC=node_modules/react-native/sdks/hermesc/osx-bin/hermesc
for P in ios android; do
  node node_modules/react-native/cli.js bundle --platform "$P" --dev false --minify false \
    --entry-file index.js --bundle-output "$OUT/$P.jsbundle" --assets-dest "$OUT/$P-assets" --reset-cache
  grep -q 'F043415348554341524401' "$OUT/$P.jsbundle"
  "$HERMESC" -emit-binary -max-diagnostic-width=80 -O -out "$OUT/$P.hbc" "$OUT/$P.jsbundle"   # the flags react-native-xcode.sh uses
done
echo "BUNDLE CHECK OK"
