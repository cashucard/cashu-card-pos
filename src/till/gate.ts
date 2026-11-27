/* The phone's owner check in front of what risks money or changes the till (slice 1.1): the store's three choices, the
 * mints, the records and the wallet. The real check is keychainGate() in store/native.ts; guarded() in guarded.ts runs
 * an action only once it passed. A gate in the app's path, not encryption: see PHASE-1, "The device-authentication gate". */

export type GateResult = { ok: true } | { ok: false; why: 'unavailable' | 'cancelled' | 'failed'; words: string };

export interface DeviceGate {
  /** a passcode or biometrics is set on this phone */
  available(): Promise<boolean>;
  /** asks the person at the phone to confirm, now, with the passcode, Face ID or fingerprint; never throws */
  check(reason: string): Promise<GateResult>;
}

/** The system prompt's title, for each action behind the check. */
export const GATE_REASONS = {
  'start-new': 'Confirm it is you to start a new payment record.',
  'use-older': 'Confirm it is you to use the older payment record.',
  'set-aside': 'Confirm it is you to set the payment record aside.',
  mints: "Confirm it is you to change the till's mints.",
  records: "Confirm it is you to open the till's records.",
  wallet: "Confirm it is you to open the till's wallet.",
  'offline-acceptance': 'Confirm the offline payment settings for this mint.',
  'lightning-send': 'Confirm this Lightning withdrawal.',
  'lightning-sweep': 'Confirm this change to automatic withdrawals.',
  'backup-save': "Confirm it is you to save this till's backup.",
  'backup-restore': 'Confirm it is you to restore this till.',
  'change-by-pin': 'Confirm the change collection setting.',
  'wallet-export': 'Confirm it is you to show this Cashu token.',
} as const;
export type GateReason = keyof typeof GATE_REASONS;

/** What the merchant is told when the check did not pass. */
export const GATE_WORDS = {
  unavailable: 'Set a passcode on this phone first. Then try again.',
  cancelled: 'Not confirmed. Nothing was changed.',
  failed: 'This phone could not confirm it was you.',
} as const;
