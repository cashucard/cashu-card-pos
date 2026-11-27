# Cashu Card POS developer guide

Cashu Card POS 1.2.0 (build 14) is a React Native app that takes Cashu card, Cashu wallet and Lightning payments. A merchant chooses which HTTPS mints to accept. The phone holds the merchant’s eCash and keeps a record of what it still owes to customers. The TypeScript SDK speaks to the card and its mint. The app owns checkout, durable storage, merchant withdrawals, and the decision about what to display on a receipt.

## Install the dependencies

Use Node 22.13 or newer and Yarn Classic 1.22.22. The test suite uses Node’s built-in SQLite module. The app pins React Native 0.77.1 and the public Cashu wallet SDK `@cashu/cashu-ts` 4.11.0. The TypeScript reader and React Native NFC transport are both version 0.4.0. The app pins their public release archives, and Yarn verifies their integrity during installation. Both have the same compiled code as the SDKs used for the build 14 phone binaries. [SDK release](https://github.com/cashucard/cashu-card-typescript/releases/tag/v0.4.0) · [Dependency pins](../package.json)

From a fresh checkout, install the dependencies and check the resolved versions.

```sh
yarn install --frozen-lockfile
yarn deps:check
```

## Run a checkout test

After installing the dependencies, run the following commands from the repository root. The checkout tests use simulated funds.

```sh
yarn typecheck
yarn test --runInBand --runTestsByPath __tests__/sale.test.ts __tests__/automatic-charge.test.ts __tests__/customer-returns.test.ts
```

The [sale tests](../__tests__/sale.test.ts) show how listener callbacks receive a quote, approve its terms and report a payment result. For the card protocol and a public simulator, see the [Cashu Card developer resources](https://cashucard.org/developers).

## Build the phone app

- **Android.** Use JDK 17 and the Android SDK, including platform 36, build tools 36.0.0 and NDK 27.1.12297006. Set `ANDROID_HOME` or point Gradle’s `local.properties` to your SDK directory. Run `(cd android && ./gradlew :app:assembleRelease)`. The release variant embeds the JavaScript and emits an unsigned APK under `android/app/build/outputs/apk/release/`. Sign it with your own development identity for a device test. Android debug builds use the development keystore Gradle creates for your user account. Use a separate application ID or a spare device if you already use POS there. [Android build configuration](../android/app/build.gradle)
- **iOS.** On a Mac with Xcode and CocoaPods 1.16.2, run `(cd ios && pod install --deployment)`. Open `ios/CashuCardPOS.xcworkspace` and choose the **CashuCardPOS** scheme. Use the Release configuration for the merchant interface. A simulator can show the screens. A physical iPhone also needs your own bundle ID, development team and provisioning profile supporting NFC Tag Reading. Keep the ISO 7816 application identifiers in Info.plist and the reader entitlement in the target. [iOS configuration](../ios/CashuCardPOS/Info.plist) · [Entitlements](../ios/CashuCardPOS/CashuCardPOS.entitlements)
- **Shared runtime.** The entry point loads the secure random-number, text and URL polyfills before the payment SDK. Keep that order when embedding it elsewhere. Release builds start the merchant interface with the physical reader and the merchant’s store. [Entry point](../index.js) · [App selection](../App.tsx) · [Production wiring](../src/app/release-wiring.ts)

## Follow an online sale

The minimum SDK sequence opens a till, creates a sale with a unique ID, takes the card through a transport, then asks the SDK to settle. The following TypeScript functions illustrate the calls. The host supplies its own durable journal, generation store, accepted mints, HTTP transport, idempotent payout handler and cashier prompts.

```ts
import {
  open, walletPayout, type CardListener, type CardTransport, type CashuCard,
  type Delivery, type GenerationStore, type HttpFetch, type Journal,
} from 'cashucard';

export function openMerchantTill(
  journal: Journal,
  generationStore: GenerationStore,
  mints: string[],
  http: HttpFetch,
  keep: (delivery: Delivery) => Promise<void>,
) {
  return open({
    journal, generationStore, payout: walletPayout({ mints, keep }), http,
    clock: null, leftoverByPin: false,
  });
}

export async function charge(
  till: CashuCard,
  saleId: string,
  sats: number,
  transport: CardTransport,
  listener: CardListener,
) {
  const sale = await till.receive({ id: saleId, sats });
  return sale.card(transport, listener);
}
```

1. **Start the sale.** Persist and reuse the same sale ID through a retry. The app checks for collisions with archived sales. For an existing sale, obtain its handle with `await till.sale(saleId)`. The sale and a particular payment each have their own ID. [Sale service](../src/till/service.ts)
2. **Approve the quote and read the card.** The listener presents the price, fee, total, and any change terms to the holder. The React Native adapter works with Android IsoDep and iOS Core NFC. POS keeps one physical contact across the read and sign phases while the terms match the holder’s approval. Keep a PIN only in memory for the current authorization. [Sale controller](../src/till/sale-controller.ts) · [Holding one contact](../src/till/continuous-sale.ts) · [Reader](../src/till/nfc-reader.ts)
3. **Resolve the outcome.** Use the returned payment’s state to choose the receipt. Keep pending payments in the journal. Serialize `await till.settle()` with other money operations and refresh the receipt from its recorded payment. The SDK can call the payout handler again after a restart. Commit each delivery once before acknowledging it. [Settlement](../src/till/settle.ts) · [Payout storage](../src/till/store/keep-store.ts) · [Work queue](../src/till/queue.ts)

## Pay from a wallet

Enter a price and press **Charge**. The PIN screen shows a Lightning invoice for that sale. A cardholder can enter their PIN and start NFC, or a customer can scan the invoice from their Lightning wallet. Selecting Cashu for the QR shows a NUT-18 request with the price in sats, the accepted mints and a unique request ID. A compatible wallet can scan it and prepare a payment. A customer can also use their wallet’s **Send** action to make a Cashu token. The customer’s notes must cover the exact price after the mint’s input fee. The cashier chooses **Scan payment** or **Paste payment** to take it. The till contacts the mint before showing **Paid**. [Phone wallet screen](../src/screens/PhonePaymentScreen.tsx)

Use `openSale(sats)` and keep its sale ID through the checkout. `phoneOffer(saleId)` returns the encoded payment request. Pass the wallet response or Cashu token to `takePhonePayment(saleId, text)`. A NUT-18 response carries the matching request ID, mint, unit and proofs. Preserve integer note amounts on the wire. A bearer token carries no request ID. POS checks its mint, unit and net amount against the open sale. The token and its proofs are spendable, so keep them out of logs and analytics. [Till service](../src/till/service.ts) · [Payment validation](../src/till/phone-payment.ts)

If POS shows **Awaiting confirmation**, retain the sale and follow its recorded result in Activity. A lost response can arrive after the mint has accepted payment. If the sale was withdrawn during that interval, settlement holds the recovered notes for the payer. In **Owed to Cards**, the cashier can open the wallet payment and share its saved return token with that customer. The [wallet payment tests](../__tests__/phone-payment.test.ts) check the accepted mint, quoted price and recovery of pending payments with simulated funds.

## Screen-to-SDK map

| Merchant action | Entry point and underlying calls |
| --- | --- |
| Set up a till and add a mint | [First run](../src/screens/FirstRunScreen.tsx) and [Add mint](../src/screens/AddMintScreen.tsx) call `checkMint` and `addMint` through the till service. Reopening the SDK with `walletPayout({ mints, keep })` applies the accepted mints. [Mint checks](../src/till/mint-check.ts) |
| Charge a card online | [Sell](../src/screens/SaleScreen.tsx) calls `openSale` and `takeCard`. These wrap `receive`, `sale` and `sale.card`. The app serializes reader access with payout, settlement and return jobs. [Service](../src/till/service.ts) |
| Receive a Lightning payment online | The PIN screen shows the BOLT11 from `lightningOffer`. The till reconciles the original mint quote with `checkLightningSale` before showing the merchant a paid receipt. An additional payment goes into customer returns. |
| Take a Cashu software wallet payment online | [Phone wallet](../src/screens/PhonePaymentScreen.tsx) displays `phoneOffer` and passes the customer’s scanned or pasted reply to `takePhonePayment`. A confirmed sale reaches the same merchant wallet and Activity as a card payment. [Service](../src/till/service.ts) |
| Charge while offline | The same Charge button chooses the offline path. The app caches keys using `prepareOfflineKit`. It calls `receive({ id, sats }, { offline: true })` and supplies the kit and previously spent input lookup to the card listener. The receipt stays pending until the mint settles the notes. [Offline settings](../src/screens/OfflineScreens.tsx) · [Key cache and spent-input checks](../src/till/store/offline.ts) |
| Check balance | [Card balance](../src/screens/CardBalanceScreen.tsx) calls `readCardBalance(transport, { signal })`. This reads card-listed amounts without a PIN or a mint request. A charge still checks whether the offered notes can pay. [Balance reader](../src/till/card-balance.ts) |
| Top up a card or resume a paid invoice | [Top up](../src/screens/TopupScreen.tsx) uses `TopupService.start`, `refresh` and `load`. They combine SDK `TopupCard`, `topupKeys` and `topupPieces` with the mint’s BOLT11 quote. The app journals the quote and its original outputs before showing the invoice. Resume with the same receipt and card. [Top-up service](../src/till/topup.ts) |
| View a receipt | [Activity](../src/screens/ActivityScreen.tsx) and [Payment detail](../src/screens/PaymentScreen.tsx) combine `payments()` and `openClaims()` with archived records. Archive moves the record and preserves its ID. CSV export contains the payment list. [Activity](../src/app/activity.ts) · [Archive](../src/till/archive.ts) |
| Withdraw eCash | [Wallet](../src/screens/WalletScreen.tsx) reserves settled deliveries before sharing a Cashu token by QR or text. Resume the same withdrawal by ID. `checkWithdrawal` queries the mint’s NUT-07 proof states to confirm redemption. [Token handling](../src/till/wallet.ts) |
| Withdraw to Lightning or configure a sweep | [Lightning withdrawals](../src/screens/LightningWalletScreen.tsx) uses the app’s `quote`, `confirm`, `refresh` and `configure` methods. It resolves the Lightning address, verifies the invoice, then uses the selected mint’s melt quote. A pending payment retains its reserved proofs. [Wallet controller](../src/till/lightning.ts) · [Mint transport](../src/till/lightning-transport.ts) |
| Return change to a card | [Owed to Cards](../src/screens/OwedScreen.tsx) reads `owedTotals`, `needsGiveBack` and open claims. `giveBackToCard` handles the original card’s return and its PIN prompt. Show amounts already written but awaiting confirmation separately from amounts still owed. [Return handling](../src/till/owed.ts) |
| Review till settings and records | [Settings](../src/screens/SettingsScreen.tsx) links to mint management, offline readiness and [Records](../src/screens/RecordsScreen.tsx). Records wraps `archive` and the payment-list export. [About](../src/screens/AboutScreen.tsx) reads the installed version supplied by the platform. |

## Backup and PIN-protected change

**Save the till.** In Settings, open **Backups and change**, choose **Save a backup** and choose a file destination. The app takes a consistent snapshot of its payment record and mint settings. It derives an encryption key from the merchant’s passphrase with scrypt and seals the snapshot with XChaCha20-Poly1305. Only the encrypted file goes to the system document picker. The device’s database key and the customer’s card PIN stay outside the file. The app reads the saved file back before marking the export complete. If the file provider needs fresh permission to read it, the merchant chooses **Verify saved file** and opens the copy. [Backup screen](../src/screens/BackupScreen.tsx) · [File picker adapter](../src/app/backup-files.ts) · [Snapshot](../src/till/store/backup-record.ts) · [Encryption](../src/till/store/backup-crypto.ts)

**Restore to a replacement phone.** Retire the previous till and choose the newest saved file. A fresh phone cannot determine whether a newer file exists elsewhere. Have recipients redeem any withdrawal or return QR shared after the backup before activating it. The mint sees an unclaimed bearer token as unspent even when someone else holds a copy. On first setup, choose **Restore a backup** before adding a mint. The restore checks the passphrase, authenticated contents, destination and generation. Imported records stay in recovery while the app checks the backed-up proofs with the mints. Spent proofs stay out of available takings. A pending or unavailable mint response keeps the affected recovery work pending. A backup records the moment of export. Save an updated file after money moves or the till records a customer obligation. [Restore actions](../src/till/recovery-actions.ts) · [Store import and activation](../src/till/store/backup.ts) · [Mint reconciliation](../src/till/recovery-reconcile.ts)

**Collect change with the card PIN.** After saving a backup, the merchant chooses a private recovery folder accessible from another device and unlocks **Collect change with a PIN** for the session using the backup passphrase. For a PIN-protected change sale, the till writes encrypted copies before asking the card to sign, after it receives the signature and after the mint swap. Failure to save before signing stops checkout. During an eligible online sale, show the holder the actual change terms before approving the SDK confirmation. The customer can return to **Owed to Cards** on this till with the original card and PIN to collect outstanding change. Respect the SDK’s distinction between a write awaiting confirmation and change still available for return. Offline checkout continues to use exact notes. [Return handling](../src/till/owed.ts) · [Checkout confirmation](../src/till/continuous-sale.ts)

## Money and storage boundaries

The payment journal tracks which sale a payment belongs to, the customer’s change and the mint’s last known response. The wallet stores the merchant’s settled eCash. A customer’s change and a paid top-up are obligations to that card and stay outside available merchant takings. Store the SDK’s generation counter separately from the journal and honor its rollback checks when opening a till. The app’s SQLCipher adapter and device-protected storage show how those pieces fit together. [Store opening](../src/till/store/open-store.ts) · [SQL layout](../src/till/store/sql.ts)

For recovery examples, run the tests for a [pending Lightning payment](../__tests__/lightning-ledger.test.ts), an [interrupted top-up](../__tests__/card-topup.test.ts) and [returns to the original card](../__tests__/customer-returns.test.ts). Use disposable test data when trying these flows.
