/* Development only (slice 0.2): where the self-test finds the bench on this Mac. The iOS simulator reaches the Mac at
 * 127.0.0.1. Nothing here is used by a release build's payment path. */

/** The card simulator the self-test pays from (this slice's own instance, not the harness's 19876). */
export const DEV_CARDSIM_URL = 'http://127.0.0.1:19886';
/** The local Nutshell test mint. */
export const DEV_MINT_URL = 'http://127.0.0.1:13338';
/** The https name the simulated card gives its mint; the library refuses a mint named without https. */
export const DEV_MINT_NAME = 'https://mint.test';
/** Host of DEV_MINT_NAME to local base: the route the development fetch takes. */
export const DEV_ROUTES: Readonly<Record<string, string>> = { 'mint.test': DEV_MINT_URL };
/** The bench server: the redirect probe's target and the report sink (dev/bench-server.mjs). */
export const DEV_BENCH_URL = 'http://127.0.0.1:19887';
/** The simulated card's PIN (the harness's test PIN). Never a real card's. */
export const DEV_PIN = '1234';
/** The self-test's price in sats: the card holds 8, 4, 2 and 1, so 14 and the mint's fee of 1 pay exactly. */
export const DEV_SALE_SATS = 14;
/** One card command's limit over the simulator's HTTP bridge, ms. */
export const DEV_APDU_TIMEOUT_MS = 15000;
