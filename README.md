# Cashu Card POS

Cashu Card POS turns an iPhone or Android phone into a till. This repository contains the merchant app source for version **1.2.0 (build 14)**. The phone communicates directly with a mint the merchant chooses. A customer can pay with a physical Cashu Card, a Cashu wallet or Lightning.

Cashiers can also check a card’s balance, top it up and return change through **Owed to Cards**. Merchants can collect their takings as eCash or withdraw to a Lightning address.

## Build and integrate

The developer guide follows a sale from the keypad through the card tap and settlement. A clean checkout installs the public TypeScript reader and React Native NFC transport from the versioned GitHub release using the repository’s frozen lockfile. [Developer guide](docs/developer-guide.md)

For the NFC protocol and simulator, see the [Cashu Card developer resources](https://cashucard.org/developers). To prepare a compatible blank card, use [Cashu Card Setup](https://cashucard.org/#install).

## Taking a payment

Enter the price and press **Charge**. Online, the customer can scan the Lightning invoice straight from the PIN screen. To use a Cashu card, enter the card PIN, choose the card payment button and tap. To use a Cashu software wallet, switch the QR to Cashu. The cashier scans the wallet’s reply or pastes its eCash token. The mint’s input fee is paid by the customer. The till shows **Paid** when the mint confirms the merchant has the sale amount. For a payment awaiting confirmation, check Activity before asking the customer to pay again.

## Collecting takings and returning change

Open **Wallet**, choose the mint and unlock the phone when prompted to share the token. Receive the token in a separate Cashu wallet. Return to Wallet and check the withdrawal to confirm that the mint has marked the funds spent. An interrupted handoff can be reopened.

Open **Owed to Cards** to see outstanding customer change, including change from a mint the till no longer accepts. Use the original card to collect a card return. Where a payment has a separate eCash return, check the payment reference before handing the token to its customer.

## Lightning withdrawals

In **Wallet**, choose a mint and open **Lightning withdrawals**. For a manual withdrawal, enter the recipient’s Lightning address and the amount they should receive. Review the maximum fee and confirm with the phone’s owner check. Wallet shows the actual fee when the mint confirms payment.

To sweep takings automatically, set a Lightning address for that mint, the **balance to keep**, and the **maximum fees per sweep**. For example, with 2,500 sats available, 1,000 sats to keep and a 10-sat fee limit, POS requests 1,490 sats for the recipient. Any unused fee allowance stays in Wallet. Sweeps start only after you enable them and run while the till is open and online. Change or turn off the settings in the same screen.

A withdrawal showing **Pending** can be checked after reconnecting or reopening the app. POS keeps those funds reserved until the mint resolves the original payment. Cashu token withdrawals remain available for other takings.

## Check a balance or top up a card

On **Sell**, tap **Check balance** below **Charge** and hold the card to the phone. POS shows the mint and the amount listed on the card. A balance read works offline and can be done before a sale.

For a sat card from a mint this till accepts, choose **Top up card**. Enter the amount on the keypad, press **Continue**, enter the card PIN and tap the card to prepare its invoice. Review the amount to load, the fee and the invoice total before paying. The mint issues notes for this card. The merchant can start with an empty wallet. POS checks the invoice while it is open. When it shows **Ready to load**, enter the PIN and tap the same card. To resume, check the same card’s balance and choose **Top up card**, or open the original request in **Settings → Card top-up receipts**. Anyone helping a customer resume a paid top-up should use its saved receipt.

## Take a payment offline

On **Sell**, enter the price and tap **Charge**. When the phone is offline, POS requests the card PIN, then accepts an eligible payment in one tap. The receipt says **Saved offline** until the mint confirms the sale.

POS prepares offline payments for a newly added mint while online and refreshes its keys before they expire. You can see readiness or turn acceptance off in **Settings → Offline payments**. An existing mint that shows **Off** after upgrading from build 12 needs enabling once while online. Keys are valid for 24 hours. The card must have suitable notes for the price and mint fee. This version accepts offline sales of up to 100 sats each and limits outstanding exposure across the till to 10 payments or 500 sats, whichever comes first.

An offline receipt stays pending until the mint confirms it. Keep the app open when connectivity returns. Check **Activity** for the result and **Wallet** for settled takings. Another copy of the notes might reach the mint first, in which case the merchant can lose the sale amount. Turning off offline acceptance stops future offline sales for that mint. Existing receipts continue to reconcile.

## Backups and change

In **Settings → Backups and change**, choose **Save a backup** and keep the file and its passphrase somewhere you can reach if the phone is lost. A backup captures the till at the time of export. On a replacement phone, choose **Restore a backup** at first setup, use your newest file, and finish the mint checks before taking payments. Retire the original till before restoring. If you shared a withdrawal or return QR after that backup, have the recipient redeem it first. An unclaimed QR still controls those sats.

After saving a backup, choose a recovery folder that you can access from another device. Unlock **Collect change with a PIN** using your backup passphrase. The till writes encrypted recovery copies there when it holds change. When an online sale leaves change for the card, the customer can collect it through **Owed to Cards** with the original card and PIN. Save a new backup after such a sale.

## Licence

The app and this guide are [MIT licensed](LICENSE). Animated payment QR decoding includes [MIT-licensed Foxy code](assets/licenses/Foxy-MIT.txt). The Android camera scanner uses [ZXing under Apache 2.0](android/app/src/main/assets/licenses/ZXing-Apache-2.0.txt). Figtree is distributed under the [SIL Open Font License](assets/fonts/OFL.txt).
