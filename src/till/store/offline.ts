import { currentOfflineKit, offlineExposure, OFFLINE_LIMITS, type Journal, type OfflineKit } from 'cashucard';
import { normalizeMintInput } from '../mint-check';
import type { MintEntry } from '../settings';
import { ENABLE_OFFLINE_MINT } from './offline-schema';
import { backfillArchiveBatch } from './offline-archive';
import type { Serial } from './db';
import type { SqlDriver } from './types';

function mintId(mint: string): string {
  const check = normalizeMintInput(mint);
  if (!check.ok) throw new Error('Invalid offline mint.');
  return check.url;
}

export class OfflineSettingsStore {
  constructor(private readonly driver: SqlDriver, private readonly serial: Serial) {}

  private archiveReady = false;

  async prepareArchive(): Promise<void> {
    if (this.archiveReady) return;
    while (!await this.serial(() => backfillArchiveBatch(this.driver))) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    this.archiveReady = true;
  }

  async spentInputs(mint: string, digests: readonly string[]): Promise<string[]> {
    if (!digests.length) return [];
    await this.prepareArchive();
    return this.serial(async () => {
      const {rows} = await this.driver.run(
        'SELECT digest FROM offline_spent_inputs WHERE mint=? AND digest IN (' + digests.map(() => '?').join(',') + ')',
        [mintId(mint), ...digests],
      );
      return rows.map(r => String(r.digest));
    });
  }

  /** Missing means off; null means enabled and waiting for its first keys. */
  cached(mint: string): Promise<OfflineKit | null | undefined> {
    return this.serial(async () => {
      const row = (await this.driver.run('SELECT body FROM offline_kits WHERE mint=?', [mintId(mint)])).rows[0];
      return row ? JSON.parse(String(row.body)) as OfflineKit | null : undefined;
    });
  }

  async readyForAny(mints: readonly MintEntry[], now: number): Promise<boolean> {
    for (const mint of mints) {
      if (mint.status === 'ok' && usableKit(await this.cached(mint.url), mint, now)) return true;
    }
    return false;
  }

  enable(mint: string): Promise<void> {
    return this.serial(async () => { await this.driver.run(ENABLE_OFFLINE_MINT, [mintId(mint)]); });
  }

  /** A background refresh cannot re-arm a disabled/restored mint or overwrite a more recent refresh. */
  refresh(kit: OfflineKit, previous: OfflineKit | null): Promise<void> {
    return this.serial(async () => {
      await this.driver.run('UPDATE offline_kits SET body=? WHERE mint=? AND body=?',
        [JSON.stringify(kit), mintId(kit.mint), JSON.stringify(previous)]);
    });
  }

  save(kit: OfflineKit): Promise<void> {
    return this.serial(async () => {
      await this.driver.run('INSERT OR REPLACE INTO offline_kits (mint, body) VALUES (?,?)', [mintId(kit.mint), JSON.stringify(kit)]);
    });
  }

  disable(mint: string): Promise<void> {
    return this.serial(async () => { await this.driver.run('DELETE FROM offline_kits WHERE mint=?', [mintId(mint)]); });
  }

  disableAll(): Promise<void> {
    return this.serial(async () => { await this.driver.run('DELETE FROM offline_kits'); });
  }
}

export interface OfflineStatus {
  enabled: boolean;
  ready: boolean;
  expires: number | null;
  pending: number;
  sats: number;
}

export function usableKit(kit: OfflineKit | null | undefined, mint: MintEntry, now: number): OfflineKit | null {
  if (!kit || mint.status !== 'ok') return null;
  try {
    currentOfflineKit(kit, mintId(mint.url), now);
    // An observed key rotation invalidates an older kit even inside its normal lifetime.
    const expected = new Set(mint.keysets);
    return expected.size === mint.keysets.length && expected.size === kit.keysets.length &&
      kit.keysets.every(keyset => expected.has(keyset.id)) ? kit : null;
  } catch {
    return null;
  }
}

export async function readOfflineStatus(store: OfflineSettingsStore, journal: Journal, mint: string, accepted: MintEntry | null, now: number): Promise<OfflineStatus> {
  const [kit, rows] = await Promise.all([store.cached(mint), journal.list()]);
  const ready = !!(accepted && usableKit(kit, accepted, now));
  const exposure = offlineExposure(rows);
  return { enabled: kit !== undefined, ready, expires: kit ? kit.prepared + OFFLINE_LIMITS.maxAgeMs : null, pending: exposure.payments, sats: exposure.sats };
}
