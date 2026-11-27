#!/bin/sh
# Offline. The till refuses HTTP redirects in native code (slice 2.5, ENG-905): ios/CashuCardPOS/CCPOSNoRedirects.m
# and MainApplication.kt. Both lean on how React Native makes its HTTP session and client. This check reads React
# Native's sources in node_modules and fails when what they lean on has changed, so that an upgrade of React Native
# cannot pass the checks until a person has read the networking code again and run the self-test's redirect step on
# both platforms. Then, and only then, change RN_CHECKED and the lists below.
# Every build runs it and stops when it fails: Gradle before preBuild (android/app/build.gradle, task redirectCheck),
# Xcode as the app target's first build phase ("Redirect check"), and scripts/bundle-check.sh. Plain sh, grep and sed
# only, no Node: Xcode's build phases run with a bare PATH. What it cannot hold is said at its JavaScript part.
set -eu
LC_ALL=C
export LC_ALL
cd "$(dirname "$0")/.."
RN=node_modules/react-native
RN_CHECKED=0.77.1
fail() { echo "REDIRECT CHECK FAILED: $1"; exit 1; }

V=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$RN/package.json" | head -1)
[ "$V" = "$RN_CHECKED" ] || fail "React Native is $V; the native redirect refusal was checked against $RN_CHECKED. Read the notes in this script."

# iOS: one session for fetch, made by RCTHTTPRequestHandler with itself as the delegate; our file replaces its answer.
H=$RN/Libraries/Network/RCTHTTPRequestHandler
grep -q '@interface RCTHTTPRequestHandler' "$H.h" || fail "RCTHTTPRequestHandler is not declared in $H.h"
grep -q 'sessionWithConfiguration:configuration delegate:self' "$H.mm" || fail "$H.mm no longer makes its session with itself as the delegate"
if grep -q 'willPerformHTTPRedirection' "$H.mm"; then
  echo "iOS: React Native $V defines the redirect delegate method itself; CCPOSNoRedirects.m replaces it at load"
else
  echo "iOS: React Native $V does not define the redirect delegate method; CCPOSNoRedirects.m adds it at load"
fi
IOS_SESSIONS='Libraries/Network/RCTHTTPRequestHandler.mm
React/Base/RCTBundleURLProvider.mm
React/Base/RCTMultipartDataTask.m
React/CoreModules/RCTRedBox.mm
React/CoreModules/RCTWebSocketExecutor.mm
React/DevSupport/RCTInspectorDevServerHelper.mm
React/DevSupport/RCTInspectorNetworkHelper.mm
React/Profiler/RCTProfile.m'
GOT=$(cd $RN && grep -rlE 'sessionWithConfiguration|sharedSession\]' --include='*.m' --include='*.mm' Libraries React ReactCommon | LC_ALL=C sort)
[ "$GOT" = "$(printf '%s\n' "$IOS_SESSIONS" | LC_ALL=C sort)" ] || fail "the files of React Native that make a URL session on iOS have changed:
$GOT"
grep -q 'class_replaceMethod(\[RCTHTTPRequestHandler class\]' ios/CashuCardPOS/CCPOSNoRedirects.m || fail "CCPOSNoRedirects.m no longer replaces the method"
grep -q 'class_getMethodImplementation(\[RCTHTTPRequestHandler class\], sel) != (IMP)CCPOSRefuseRedirect' ios/CashuCardPOS/CCPOSNoRedirects.m || fail "CCPOSNoRedirects.m no longer checks at launch that its replacement took"
[ "$(grep -c 'CCPOSNoRedirects.m in Sources' ios/CashuCardPOS.xcodeproj/project.pbxproj)" = 2 ] || fail "CCPOSNoRedirects.m is not compiled into the iOS app"

# Android: fetch's client comes from OkHttpClientProvider's factory; MainApplication sets one that follows nothing.
A=$RN/ReactAndroid/src/main/java/com/facebook/react
grep -q 'public static void setOkHttpClientFactory' "$A/modules/network/OkHttpClientProvider.java" || fail "OkHttpClientProvider has no setOkHttpClientFactory"
[ "$(grep -c 'return sFactory.createNewNetworkModuleClient();' "$A/modules/network/OkHttpClientProvider.java")" = 2 ] || fail "OkHttpClientProvider.createClient no longer asks the factory"
[ "$(grep -c 'OkHttpClientProvider.createClient(context)' "$A/modules/network/NetworkingModule.java")" = 3 ] || fail "NetworkingModule no longer takes its client from OkHttpClientProvider"
AND_CLIENTS='devsupport/CxxInspectorPackagerConnection.java
devsupport/DevServerHelper.java
devsupport/InspectorPackagerConnection.java
devsupport/JSDebuggerWebSocketClient.java
devsupport/PackagerStatusCheck.java
devsupport/RedBoxContentView.java
devsupport/inspector/InspectorNetworkHelper.java
modules/network/OkHttpClientProvider.java
modules/websocket/WebSocketModule.java
packagerconnection/ReconnectingWebSocket.java'
GOT=$(cd "$A" && grep -rlE 'new OkHttpClient|OkHttpClient\(\)|OkHttpClient\.Builder\(\)' --include='*.java' --include='*.kt' . | sed 's|^\./||' | LC_ALL=C sort)
[ "$GOT" = "$(printf '%s\n' "$AND_CLIENTS" | LC_ALL=C sort)" ] || fail "the files of React Native that make an HTTP client on Android have changed:
$GOT"
M=android/app/src/main/java/org/cashucard/pos/MainApplication.kt
grep -q 'OkHttpClientProvider.setOkHttpClientFactory' "$M" || fail "MainApplication no longer sets the client factory"
grep -q '\.followRedirects(false)' "$M" || fail "MainApplication's client may follow redirects"
grep -q '\.followSslRedirects(false)' "$M" || fail "MainApplication's client may follow redirects between http and https"
echo "Android: React Native $V builds fetch's client from the factory MainApplication sets"
# Android's WebSocket client is built apart from the factory (WebSocketModule.connect: its own builder, then the
# custom builder if one is set). MainApplication sets one that turns both switches off.
W=$A/modules/websocket/WebSocketModule.java
grep -q 'public static void setCustomClientBuilder(CustomClientBuilder ccb)' "$W" || fail "WebSocketModule has no setCustomClientBuilder"
[ "$(grep -c 'applyCustomBuilder(okHttpBuilder);' "$W")" = 1 ] || fail "WebSocketModule.connect no longer applies the custom builder to its client"
[ "$(grep -c 'new OkHttpClient' "$W")" = 1 ] || fail "WebSocketModule builds more than one client"
[ "$(grep -cE 'WebSocketModule\.setCustomClientBuilder \{ it\.followRedirects\(false\)\.followSslRedirects\(false\) \}' "$M")" = 1 ] || fail "MainApplication no longer turns redirects off for React Native's WebSocket client"
echo "Android: React Native $V builds its WebSocket client through the builder MainApplication sets"

# Second line, in JavaScript: a grep, so it holds names, not behaviour. It fails when
#   - src, App.tsx or index.js (all the JavaScript of ours that ships; src/dev is inside src, dev/ runs on the Mac
#     only) or the card library's dist names WebSocket, XMLHttpRequest, EventSource or one of the Cashu library's
#     socket and subscription names in CASHU_SOCKETS, or the card library calls fetch itself;
#   - a name in CASHU_SOCKETS is not in the installed Cashu library's types (a list of dead names checks nothing);
#   - the Cashu library's version, the names the app or the card library imports from it, or the packages the card
#     library imports, are not the ones read here. None of the pinned names opens a socket; the card library gives
#     its Mint the till's guarded fetch as customRequest.
# It does not catch a socket reached without one of these names (const W = globalThis.WebSocket; new W(url)), and
# CASHU_SOCKETS is the list read in CASHU_CHECKED, not a proof that the library has no other way. The native refusal
# is the line that holds for HTTP. For a WebSocket: Android's client has redirects off (above); on iPhone it is
# SocketRocket's, outside CCPOSNoRedirects.m, and SocketRocket has no redirect handling (SRWebSocket.m never reads
# Location). A change in any of these lists means: read the new code, then change the list.
CASHU=node_modules/@cashu/cashu-ts
CASHU_CHECKED=4.11.0
CV=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$CASHU/package.json" | head -1)
[ "$CV" = "$CASHU_CHECKED" ] || fail "the Cashu library is $CV; its socket names and what the till takes from it were read in $CASHU_CHECKED. Read the notes in this script."
CASHU_SOCKETS='WSConnection createSubscription connectWebSocket webSocketConnection injectWebSocketImpl mintQuoteUpdates mintQuotePaid meltQuoteUpdates meltQuotePaid proofStateUpdates proofStatesStream onceMintPaid onceAnyMintPaid onceMeltPaid'
for n in $CASHU_SOCKETS; do
  grep -qw "$n" "$CASHU/lib/types/index.d.ts" || fail "$n is in this check's list of the Cashu library's socket names but not in the installed library ($CV)"
done
SOCKETS="new WebSocket|WebSocket\(|XMLHttpRequest|EventSource|$(echo "$CASHU_SOCKETS" | tr ' ' '|')"
APP='src App.tsx index.js'
for f in $APP; do [ -e "$f" ] || fail "$f is missing, so the app's JavaScript cannot be read"; done
GOT=$(grep -rnE "$SOCKETS" $APP || true)
[ -z "$GOT" ] || fail "the app's own code names a WebSocket, a request of its own or a Cashu library socket call; read the notes in this script:
$GOT"
Q="['\"]@cashu/cashu-ts[/'\"]"
GOT=$(grep -rnE "$Q" $APP | grep -vE "^[^:]*:[0-9]+:import (type )?\{[^}]*\} from '@cashu/cashu-ts';\$" || true)
[ -z "$GOT" ] || fail "the app imports the Cashu library in a form this check cannot list (keep it one line, import { names } from '@cashu/cashu-ts';):
$GOT"
# The token codecs and Lightning proof selection, blinding and unblinding run locally. In cashu-ts 4.11.0
# Wallet.loadMint, ensureOperableKeysets and prepareMelt may fetch info or keysets using the injected Mint
# request. Neither Wallet nor Mint starts a socket on construction. The Lightning adapter accepts only
# GETs for the chosen mint's public info/keys/keysets; melt submission and status use the till's guarded HTTP.
# The top-up flow uses local key generation, public-key derivation and NUT-20 signing.
# Mint invoice and issuance requests still pass through the till's guarded HTTP client.
# Request and token decoding is local. Phone-wallet key lookup uses the enrolled mint and the guarded HTTP client.
APP_CASHU_NAMES='Amount JSONInt Keyset Mint OutputData PaymentRequest Proof RequestFn SerializedBlindedSignature SerializedOutputData Wallet createRandomSecretKey decodePaymentRequest deserializeProofs getDecodedToken getDecodedTokenBinary getEncodedToken getPubKeyFromPrivKey getTokenMetadata hashToCurve pointFromHex serializeProofs signMintQuote verifyDleqIfPresent'
GOT=$(grep -rhE "$Q" $APP | sed "s/^import type {//; s/^import {//; s/} from.*//" | tr ',' '\n' | sed 's/^ *type  *//; s/ as .*//' | tr -d ' ' | grep . | sort -u | tr '\n' ' ' | sed 's/ $//')
[ "$GOT" = "$APP_CASHU_NAMES" ] || fail "the names the app takes from the Cashu library have changed (in $(grep -rlE "$Q" $APP | tr '\n' ' ')):
$GOT"
L=src/till/lightning-transport.ts
GOT=$(grep -rhE 'new (Wallet|Mint)\(' $APP || true)
[ "$GOT" = "  const wallet = new Wallet(new Mint(mint, { customRequest: request }), { unit: 'sat' });" ] || fail "the app's Cashu Wallet/Mint construction changed; check its network injection"
GOT=$(grep -oE 'wallet\.[a-zA-Z0-9_]+\(' "$L" | sed 's/^wallet\.//; s/(.*//' | sort -u | tr '\n' ' ' | sed 's/ $//')
[ "$GOT" = 'createMeltChangeProofs decodeToken ensureOperableKeysets getFeesForProofs getMintInfo loadMint prepareMelt selectProofsToSend' ] || fail "the Lightning transport's SDK wallet methods have changed; check their network behavior"
C=node_modules/cashucard
[ -f "$C/dist/index.js" ] || fail "the card library is not installed at $C"
GOT=$(grep -rnE "$SOCKETS|[^a-zA-Z_.]fetch\(" "$C/dist" --include='*.js' || true)
[ -z "$GOT" ] || fail "the card library names a WebSocket, a request of its own or a Cashu library socket call; read the notes in this script:
$GOT"
CARD_FROM='@cashu/cashu-ts
@noble/hashes/sha2.js'
GOT=$(grep -hoE "from '[^.'][^']*'" "$C"/dist/*.js | sed "s/^from '//; s/'\$//" | sort -u)
[ "$GOT" = "$CARD_FROM" ] || fail "the packages the card library imports have changed:
$GOT"
CASHU_NAMES='Keyset Mint blindMessage createRandomSecretKey getEncodedToken getPubKeyFromPrivKey hasValidDleq hashToCurve pointFromHex schnorrVerifyDigest unblindSignature'
GOT=$(cat "$C"/dist/*.js | tr '\n' ' ' | grep -oE "import \{[^}]*\} from '@cashu/cashu-ts'" | sed "s/^import {//; s/} from.*//" | tr ',' '\n' | tr -d ' ' | grep . | sort -u | tr '\n' ' ' | sed 's/ $//')
[ "$GOT" = "$CASHU_NAMES" ] || fail "the names the card library takes from the Cashu library have changed:
$GOT"
if grep -nE "import \* as|require\(|import\(" "$C"/dist/*.js; then fail "the card library imports something this check cannot list"; fi
grep -q 'customRequest' "$C/dist/mint.js" || fail "the card library no longer gives the Cashu library's Mint the till's fetch"
echo "JavaScript: the app's code and the card library name no WebSocket, no request of their own and no socket call of Cashu library $CV (a grep of names; the native refusal is the line that holds)"
echo "REDIRECT CHECK OK"
