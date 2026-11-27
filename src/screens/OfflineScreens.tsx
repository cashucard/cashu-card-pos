import React, { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { OFFLINE_LIMITS } from 'cashucard';
import { Body, Button, Gap, Screen } from '../ui/kit';
import { sats } from '../format';
import type { OfflineStatus } from '../till/store/offline';
import { MerchantPanel, PanelLabel } from './MerchantPanel';

interface SettingsService {
  offlineStatus(mint: string): Promise<OfflineStatus>;
  prepareOffline(mint: string): Promise<void>;
  disableOffline(mint: string): Promise<void>;
}

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'The operation could not be completed.';
}

export function OfflineSettingsScreen({ service, mints, authorize, onBack }: {
  service: SettingsService; mints: string[]; authorize: () => Promise<boolean>; onBack: () => void;
}): React.JSX.Element {
  const [states, setStates] = useState<Record<string, OfflineStatus>>({});
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const active = useRef(false);
  const revision = useRef(0);
  const list = JSON.stringify(mints);
  async function refresh() {
    const run = ++revision.current;
    const entries = await Promise.all(mints.map(async m => [m, await service.offlineStatus(m)] as const));
    if (run === revision.current) setStates(Object.fromEntries(entries));
  }
  useEffect(() => { void refresh().catch(e => setMessage(errorText(e))); return () => { revision.current++; }; }, [service, list]);
  async function change(mint: string, enable: boolean) {
    if (active.current) return;
    active.current = true;
    setWorking(true);
    setMessage('');
    const route = revision.current;
    try {
      if (!await authorize() || route !== revision.current || AppState.currentState === 'background') return;
      if (enable) await service.prepareOffline(mint);
      else await service.disableOffline(mint);
      await refresh();
    } catch (e) { setMessage(errorText(e)); }
    finally { active.current = false; setWorking(false); }
  }
  return <Screen title="Offline payments" titleID="offline-settings-title" onBack={onBack}>
    <Body>Charge works offline for mints that are ready. This phone refreshes their keys while online. If a customer spends the same funds elsewhere first, the merchant can lose the sale.</Body>
    <Body tone="muted">{'Each sale can be up to ' + sats(OFFLINE_LIMITS.sale) + '. This phone can hold up to ' +
      OFFLINE_LIMITS.payments + ' unresolved offline sales or ' + sats(OFFLINE_LIMITS.sats) + '. Keys expire after 24 hours.'}</Body>
    <Gap/>
    {mints.length === 0 && <Body>Add an accepted mint first.</Body>}
    {mints.map((mint, i) => {
      const status = states[mint];
      return <MerchantPanel key={mint}><PanelLabel>{mint}</PanelLabel>
        <Body>{status ? status.ready ? 'Ready for offline payments' : status.enabled ? 'Waiting for current mint keys' : 'Off' : 'Checking…'}</Body>
        {status?.expires && status.ready ? <Body tone="muted">{'Ready until ' + new Date(status.expires).toLocaleString()}</Body> : null}
        <Button testID={'offline-prepare-' + i} disabled={working || !status} label={status?.enabled ? 'Refresh offline keys' : 'Enable offline payments'} onPress={() => void change(mint, true)} />
        {status?.enabled && <Button testID={'offline-disable-' + i} disabled={working} kind="plain" label="Turn off" onPress={() => void change(mint, false)} />}
      </MerchantPanel>;
    })}
    {states[mints[0]] && <Body>{'Unresolved on this phone: ' + states[mints[0]].pending + ' sales · ' + sats(states[mints[0]].sats)}</Body>}
    {!!message && <Body tone="bad">{message}</Body>}
  </Screen>;
}
