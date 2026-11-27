import type { CardTransport } from 'cashucard';
import type { AfterScanSheet } from './scan-sheet';
import { Platform } from 'react-native';
import { DEV_APDU_TIMEOUT_MS, DEV_CARDSIM_URL } from './dev-config';
import { cardsimTransport } from './dev-transport';
import type { RawFetch } from './http';
import { DevOnlyError } from './store/wipe';

declare const __DEV__: boolean;

/** A reader supplies one transport per sale or return. A sale may open two taps on that transport. */
export interface CardReader {
  kind: 'card simulator' | 'nfc' | 'none';
  /** Keep Android from opening the card's tag link while the sale screen is in front. */
  enterSaleScreen?(): () => void;
  /** Optional iOS visual cue. Never gates card operations or presentation of a paid receipt. */
  afterScanSheet?: AfterScanSheet;
  /** whether a card can be read now (NFC on and present; the simulator: always) */
  available(): Promise<boolean>;
  /** the transport for one sale.card or giveBackToCard call; throws NoReaderError when there is none */
  transport(): CardTransport;
}

export class NoReaderError extends Error {
  constructor() {
    super('this phone has no card reader in this version');
    this.name = 'NoReaderError';
    Object.setPrototypeOf(this, NoReaderError.prototype);
  }
}

/** No reader: available() false, transport() throws NoReaderError. */
export function noReader(): CardReader {
  return {
    kind: 'none',
    available: async () => false,
    transport: () => {
      throw new NoReaderError();
    },
  };
}

/** Load the native module only on supported mobile platforms. */
export function releaseReader(): CardReader {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return noReader();
  const { phoneReader } = require('./nfc-reader') as typeof import('./nfc-reader');
  return phoneReader(Platform.OS);
}

/** The card simulator on this Mac, over React Native's fetch (development builds only: throws DevOnlyError otherwise). */
export function cardsimReader(raw: RawFetch, dev: boolean = __DEV__): CardReader {
  if (!dev) {
    throw new DevOnlyError();
  }
  return {
    kind: 'card simulator',
    available: async () => true,
    transport: () => cardsimTransport(DEV_CARDSIM_URL, raw, DEV_APDU_TIMEOUT_MS),
  };
}

export const READER_WORDS: Readonly<Record<CardReader['kind'], string>> = {
  'card simulator': 'the card simulator (development)', nfc: 'NFC', none: 'none in this version',
};
