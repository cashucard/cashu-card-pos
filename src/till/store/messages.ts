import type { StoreChoice, StoreOutcome } from './open-store';

export type OfferId = 'not-now' | 'try-again' | StoreChoice;

export interface StoreOffer {
  id: OfferId;
  label: string;
  /** what the merchant reads and confirms before it runs; null for none */
  warning: string | null;
  /** behind device authentication (from slice 1.1) */
  guarded: boolean;
}

export interface StoreMessage {
  state: Exclude<StoreOutcome<unknown>['kind'], 'ready'>;
  title: string;
  body: string;
  offers: StoreOffer[];
  /** what is not offered, in plain words, for the README and support */
  notOffered: string[];
}

const UNCHANGED = 'Nothing has been changed.';
const NOT_NOW: StoreOffer = { id: 'not-now', label: 'Not now', warning: null, guarded: false };
const TRY_AGAIN: StoreOffer = { id: 'try-again', label: 'Try again', warning: null, guarded: false };
const SET_ASIDE: StoreOffer = {
  id: 'set-aside',
  label: 'Set it aside and start a new record',
  warning: 'The record is kept under another name, but this app cannot read the money in it. Start a new record only if you accept that.',
  guarded: true,
};

/** An offer as this call's own object, so no two messages share one. */
function copy(o: StoreOffer): StoreOffer {
  return { id: o.id, label: o.label, warning: o.warning, guarded: o.guarded };
}

/** What the merchant is told in a state the till cannot open in; null for ready. */
export function storeMessage(o: StoreOutcome<unknown>): StoreMessage | null {
  switch (o.kind) {
    case 'ready':
      return null;
    case 'journal-missing':
      return {
        state: o.kind,
        title: "This phone's payment record is missing",
        body:
          'The app was deleted and installed again, or the phone was restored from a backup. ' +
          "The record kept the money this till took and has not handed out yet, and anything it owes customers' cards. " +
          'For recovery, open your latest passphrase-protected backup on a fresh till before using another phone. ' +
          'The till takes no payments until you choose. ' +
          UNCHANGED,
        offers: [
          copy(NOT_NOW),
          {
            id: 'start-new',
            label: 'Start a new record',
            warning:
              'A new record starts empty. Any money or customer change from the missing record requires its encrypted backup.',
            guarded: true,
          },
        ],
        notOffered: [
          'Rebuilding the missing payment record from a card or the mint.',
          'Taking payments before you choose.',
        ],
      };
    case 'rolled-back':
      return {
        state: o.kind,
        title: 'This payment record is older than the one last used on this phone',
        body:
          'It was put back from a backup or copied from another phone. ' +
          'Payments taken after it was saved are not in it. ' +
          UNCHANGED,
        offers: [
          copy(NOT_NOW),
          {
            id: 'use-older',
            label: 'Use this older record',
            warning:
              'Payments taken after this record was saved are missing from it, and so is the money they brought. ' +
              'Cards may be asked again for change they already hold, and they refuse it.',
            guarded: true,
          },
        ],
        notOffered: ['Starting a new record over this one: it holds money.'],
      };
    case 'unreadable':
      return {
        state: o.kind,
        title: 'This phone cannot read its payment record',
        body:
          'It was made on another phone or by another install of the app, or it is damaged. ' +
          'It is kept as it is. ' +
          UNCHANGED,
        offers: [copy(NOT_NOW), copy(SET_ASIDE)],
        notOffered: ['Deleting the record.'],
      };
    case 'key-missing':
      return {
        state: o.kind,
        title: "The key to this phone's payment record is gone",
        body:
          "The phone's secure storage was erased, so the record can never be read again. " +
          'It is kept as it is. ' +
          UNCHANGED,
        offers: [copy(NOT_NOW), copy(SET_ASIDE)],
        notOffered: ['Deleting the record.', 'Making a new key for it: no key can open it.'],
      };
    case 'secure-store-unavailable':
      return {
        state: o.kind,
        title: 'Unlock the phone, then try again',
        body:
          "The till's key is kept in the phone's secure storage, which opens once the phone has been unlocked after it started. " +
          UNCHANGED,
        offers: [copy(TRY_AGAIN)],
        notOffered: ['Anything that writes before the key can be read.'],
      };
    case 'newer-format':
      return {
        state: o.kind,
        title: 'This record was made by a newer version of the app',
        body: 'Install the newer version to open it. ' + UNCHANGED,
        offers: [copy(NOT_NOW)],
        notOffered: ['Opening it with this version.'],
      };
    case 'store-refused':
      return {
        state: o.kind,
        title: "The till's storage did not start safely",
        body:
          'The record needs encryption, writes that last through a power cut, and exclusion from automatic device backups. ' +
          'One of them is not in force on this phone, so the till does not open.',
        offers: [copy(NOT_NOW)],
        notOffered: ['Taking payments without encryption, durable writes or the backup exclusion.'],
      };
    case 'files-unavailable':
    case 'open-failed':
      return {
        state: o.kind,
        title: "The till's record could not be opened",
        body:
          "The phone's files or the record did not answer as they should. " +
          'Try again. If it happens again, the details help support.',
        offers: [copy(TRY_AGAIN)],
        notOffered: [],
      };
  }
}
