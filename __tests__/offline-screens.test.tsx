import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { OfflineSettingsScreen } from '../src/screens/OfflineScreens';
import { allText, press } from './helpers/render';

const onBack = jest.fn();
const mint = 'https://example.test';
const off = { enabled:false, ready:false, expires:null, pending:0, sats:0 };

it('requires current owner authentication to enable offline sales and ignores an answer after navigation', async () => {
  const service = { offlineStatus: jest.fn(async()=>off), prepareOffline: jest.fn(), disableOffline: jest.fn() };
  let answer!: (ok:boolean)=>void;
  const authorize = () => new Promise<boolean>(resolve => { answer = resolve; });
  let t!:ReactTestRenderer;
  await act(async()=>{ t=renderer.create(<OfflineSettingsScreen service={service} mints={[mint]} authorize={authorize} onBack={onBack} />); });
  expect(allText(t).join(' ')).toContain('merchant can lose the sale');
  await press(t,'offline-prepare-0');
  expect(service.prepareOffline).not.toHaveBeenCalled();
  await act(async()=>{ t.unmount(); });
  await act(async()=>{ answer(true); });
  expect(service.prepareOffline).not.toHaveBeenCalled();
});
