/* The till's own settings: the mints the merchant added, each with when it was checked and whether it passed, kept in
 * the secure store beside the journal's key. The secure store's write deletes an item and then adds it, so a process
 * killed in between leaves no item; the list is therefore kept in two slots, each save writes the slot the newest is
 * not in, and a read takes the higher sequence number. */

import { sameUrl } from './http';
import type { SecureStore } from './store/types';

export interface SettingsNames {
  a: string;
  b: string;
}

/** The till's own two items. */
export const TILL_SETTINGS: SettingsNames = {
  a: 'org.cashucard.pos.till.settings.a',
  b: 'org.cashucard.pos.till.settings.b',
};

export type MintStatus = 'ok' | 'refused';

export interface MintEntry {
  /** normalized, as normalizeMintInput writes it */
  url: string;
  addedAt: number;
  checkedAt: number;
  /** the active keysets in sats that passed the last full check, sorted */
  keysets: string[];
  /** 'ok': the till takes its cards; 'refused': its last full check failed */
  status: MintStatus;
  /** the first failed check's words when refused; null when ok */
  why: string | null;
}

export interface TillSettings {
  v: 1;
  seq: number;
  mints: MintEntry[];
}

/** A slot holds something this app never writes. */
export class SettingsUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsUnreadableError';
    Object.setPrototypeOf(this, SettingsUnreadableError.prototype);
  }
}

/** A save did not read back as written. */
export class SettingsNotKeptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsNotKeptError';
    Object.setPrototypeOf(this, SettingsNotKeptError.prototype);
  }
}

/** An address the store keeps: https, no space, query, fragment or user. */
export const URL_WORDS = /^https:\/\/[^\s?#@]+$/;
/** A keyset id the store keeps: 16 to 66 hex digits. */
export const KEYSET_WORDS = /^[0-9a-fA-F]{16,66}$/;
/** The most mints the store keeps. */
export const MAX_MINTS = 20;
/** The most keysets the store keeps for one mint. */
export const MAX_KEYSETS = 16;
/** The longest address the store keeps, in characters. */
export const MAX_URL = 300;
/** The longest reason the store keeps for a refused mint, in characters. */
export const MAX_WHY = 400;

function unreadable(): SettingsUnreadableError {
  return new SettingsUnreadableError("a settings item does not hold the till's settings");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyEntry(e: MintEntry): MintEntry {
  return {
    url: e.url,
    addedAt: e.addedAt,
    checkedAt: e.checkedAt,
    keysets: e.keysets.slice(),
    status: e.status,
    why: e.why,
  };
}

function copyList(mints: readonly MintEntry[]): MintEntry[] {
  return mints.map(copyEntry);
}

function copySettings(s: TillSettings): TillSettings {
  return { v: 1, seq: s.seq, mints: copyList(s.mints) };
}

function readMint(value: unknown): MintEntry {
  if (!isRecord(value)) {
    throw unreadable();
  }
  const url = value.url;
  if (typeof url !== 'string' || url.length > MAX_URL || !URL_WORDS.test(url)) {
    throw unreadable();
  }
  const addedAt = value.addedAt;
  if (typeof addedAt !== 'number' || !Number.isSafeInteger(addedAt) || addedAt < 0) {
    throw unreadable();
  }
  const checkedAt = value.checkedAt;
  if (typeof checkedAt !== 'number' || !Number.isSafeInteger(checkedAt) || checkedAt < 0) {
    throw unreadable();
  }
  const listed = value.keysets;
  if (!Array.isArray(listed) || listed.length > MAX_KEYSETS) {
    throw unreadable();
  }
  const keysets: string[] = [];
  for (const item of listed) {
    if (typeof item !== 'string' || !KEYSET_WORDS.test(item)) {
      throw unreadable();
    }
    keysets.push(item);
  }
  const status = value.status;
  if (status !== 'ok' && status !== 'refused') {
    throw unreadable();
  }
  const why = value.why;
  if (why !== null && (typeof why !== 'string' || why.length > MAX_WHY)) {
    throw unreadable();
  }
  return { url, addedAt, checkedAt, keysets, status, why };
}

/** A new { v: 1, seq: 0, mints: [] } each call. */
export function emptySettings(): TillSettings {
  return { v: 1, seq: 0, mints: [] };
}

/** The settings a slot holds, checked field by field; anything else throws SettingsUnreadableError. */
export function parseSettings(text: string): TillSettings {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw unreadable();
  }
  if (!isRecord(value) || value.v !== 1) {
    throw unreadable();
  }
  const seq = value.seq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
    throw unreadable();
  }
  const listed = value.mints;
  if (!Array.isArray(listed) || listed.length > MAX_MINTS) {
    throw unreadable();
  }
  const mints: MintEntry[] = [];
  for (const item of listed) {
    mints.push(readMint(item));
  }
  return { v: 1, seq, mints };
}

/** A present slot's settings, or null when it holds something this app never writes. */
function readSlot(text: string): TillSettings | null {
  try {
    return parseSettings(text);
  } catch (e) {
    if (e instanceof SettingsUnreadableError) {
      return null;
    }
    throw e;
  }
}

/** Whether the store would keep this entry: readMint accepts it as JSON writes it. Never throws. */
export function keepable(e: MintEntry): boolean {
  try {
    readMint(JSON.parse(JSON.stringify(e)));
    return true;
  } catch {
    return false;
  }
}

/** What one slot's read gave: its text (null when absent), or the error its read threw. */
type SlotRead = { ok: true; text: string | null } | { ok: false; error: unknown };

async function readSlotText(secure: SecureStore, name: string): Promise<SlotRead> {
  try {
    return { ok: true, text: await secure.get(name) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/** Both slots read; the parsed one with the higher seq. Neither present: empty, damaged false. Neither parses but one or
 * both are present: empty, damaged true. A read the store refuses rejects (never "no settings"), unless the other slot
 * holds the settings: that slot is then read, as a damaged slot is passed over. */
export async function loadSettings(
  secure: SecureStore,
  names: SettingsNames,
): Promise<{ settings: TillSettings; damaged: boolean }> {
  const ra = await readSlotText(secure, names.a);
  const rb = await readSlotText(secure, names.b);
  if (!ra.ok || !rb.ok) {
    const failed = !ra.ok ? ra : rb;
    const other = !ra.ok ? rb : ra;
    const kept = other.ok && other.text !== null ? readSlot(other.text) : null;
    if (kept === null) {
      throw (failed as { ok: false; error: unknown }).error;
    }
    return { settings: copySettings(kept), damaged: false };
  }
  const a = ra.text;
  const b = rb.text;
  const present = a !== null || b !== null;
  const fromA = a === null ? null : readSlot(a);
  const fromB = b === null ? null : readSlot(b);
  let chosen: TillSettings | null;
  if (fromA !== null && fromB !== null) {
    chosen = fromA.seq >= fromB.seq ? fromA : fromB;
  } else {
    chosen = fromA !== null ? fromA : fromB;
  }
  if (chosen === null) {
    return { settings: emptySettings(), damaged: present };
  }
  return { settings: copySettings(chosen), damaged: false };
}

/** Writes { v: 1, seq: current.seq + 1, mints } to slot a when that seq is even, b when odd; reads it back. */
export async function saveSettings(
  secure: SecureStore,
  names: SettingsNames,
  current: TillSettings,
  mints: readonly MintEntry[],
): Promise<TillSettings> {
  const next: TillSettings = { v: 1, seq: current.seq + 1, mints: copyList(mints) };
  const text = JSON.stringify(next);
  parseSettings(text);
  const slot = next.seq % 2 === 0 ? names.a : names.b;
  await secure.set(slot, text);
  const back = await secure.get(slot);
  if (back !== text) {
    throw new SettingsNotKeptError('the settings did not read back as written');
  }
  return parseSettings(text);
}

/** The mint by address (sameUrl), or null. */
export function findMint(mints: readonly MintEntry[], url: string): MintEntry | null {
  for (const m of mints) {
    if (sameUrl(m.url, url)) {
      return m;
    }
  }
  return null;
}

/** The list with `e` in place of the mint of the same address (its addedAt kept), or with `e` added at the end. */
export function withMint(mints: readonly MintEntry[], e: MintEntry): MintEntry[] {
  let replaced = false;
  const out = mints.map((m) => {
    if (!replaced && sameUrl(m.url, e.url)) {
      replaced = true;
      const copy = copyEntry(e);
      copy.addedAt = m.addedAt;
      return copy;
    }
    return copyEntry(m);
  });
  if (!replaced) {
    out.push(copyEntry(e));
  }
  return out;
}

/** The list without the mint of that address. */
export function withoutMint(mints: readonly MintEntry[], url: string): MintEntry[] {
  return mints.filter((m) => !sameUrl(m.url, url)).map(copyEntry);
}

/** The addresses of the mints whose status is 'ok', in list order. */
export function acceptedMints(mints: readonly MintEntry[]): string[] {
  const out: string[] = [];
  for (const m of mints) {
    if (m.status === 'ok') {
      out.push(m.url);
    }
  }
  return out;
}
