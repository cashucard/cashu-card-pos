import React from 'react';
import {AppState} from 'react-native';
import renderer, {act, type ReactTestRenderer} from 'react-test-renderer';
import {BackupScreen} from '../src/screens/BackupScreen';
import {RecoveryActionError, type TillRecoveryStatus} from '../src/till/recovery-actions';
import {benchGate} from '../src/till/guarded';
import {allText, has, isDisabled, press, textOf, typeInto} from './helpers/render';

const phrase = 'cherry stair coral ocean';
const ciphertext = 'CASHU-POS-BACKUP-1\nopaque-test-bytes';
beforeEach(() => {AppState.currentState = 'active';});

async function show(opts: {status?:Partial<TillRecoveryStatus>; deny?:boolean; restore?:boolean} = {}) {
  const status: TillRecoveryStatus = {lastBackupAt:null, canRestore:true, changeEnabled:false, changeUnlocked:false, restoring:false, ...opts.status};
  const recovery = {
    status:jest.fn(async () => ({...status})),
    exportFile:jest.fn(async (_phrase:string) => ciphertext),
    confirmSaved:jest.fn(async (_file:string) => {status.lastBackupAt = 1000;}),
    importFile:jest.fn(async (_file:string, _phrase:string) => {status.restoring = true; status.canRestore = false;}),
    finishRestore:jest.fn(async () => {status.restoring = false;}),
    setChangeEnabled:jest.fn(async (enabled:boolean, _phrase?:string) => {status.changeEnabled = enabled; status.changeUnlocked = enabled;}),
  };
  const files = {chooseRecoveryFolder:jest.fn(async () => true),
    open:jest.fn(async ():Promise<string|null> => ciphertext),
    save:jest.fn(async (_contents:string):Promise<true|'verify'|null> => true)};
  const gate=benchGate(opts.deny?'deny':'allow');
  const onRestored=jest.fn();
  let tree!: ReactTestRenderer;
  await act(async () => {tree=renderer.create(<BackupScreen recovery={recovery} gate={gate}
    files={files} startRestore={opts.restore} onRestored={onRestored} onBack={jest.fn()}/>);});
  return {tree,recovery,files,gate,onRestored};
}

async function inputExport(tree:ReactTestRenderer) {
  await press(tree,'backup-export');
  await typeInto(tree,'backup-password',phrase);
  await typeInto(tree,'backup-repeat',phrase);
}

test('saves encrypted bytes after owner authentication and records only confirmed provider writes', async () => {
  const {tree, recovery,files,gate} = await show();
  expect(isDisabled(tree,'backup-change')).toBe(true);
  await inputExport(tree);
  await press(tree,'backup-save');
  expect(gate.asked).toHaveLength(1);
  expect(files.save).toHaveBeenCalledWith(ciphertext);
  expect(recovery.confirmSaved).toHaveBeenCalledWith(ciphertext);
  expect(allText(tree).join(' ')).not.toContain(phrase);
  expect(isDisabled(tree,'backup-change')).toBe(false);
});

test('canceling the picker leaves the change setting disabled; refusing the OS owner check exposes no file', async () => {
  const first=await show();
  await inputExport(first.tree);
  first.files.save.mockResolvedValueOnce(null);
  await press(first.tree,'backup-save');
  expect(first.recovery.confirmSaved).not.toHaveBeenCalled();
  expect(isDisabled(first.tree,'backup-save')).toBe(true);
  expect(textOf(first.tree,'backup-result')).toMatch(/canceled/i);
  const denied=await show({deny:true});
  await inputExport(denied.tree);
  await press(denied.tree,'backup-save');
  expect(denied.recovery.exportFile).not.toHaveBeenCalled();
  expect(denied.files.save).not.toHaveBeenCalled();
});

test('a restore requires both the chosen file and retirement confirmation, then stays in mint recovery until verified', async () => {
  const {tree,recovery,onRestored}=await show({restore:true});
  await press(tree,'backup-choose');
  await typeInto(tree,'backup-password',phrase);
  expect(isDisabled(tree,'backup-restore')).toBe(true);
  await press(tree,'backup-confirm');
  await press(tree,'backup-restore');
  expect(recovery.importFile).toHaveBeenCalledWith(ciphertext,phrase);
  expect(has(tree,'backup-finish')).toBe(true);
  expect(has(tree,'backup-change')).toBe(false);
  recovery.finishRestore.mockRejectedValueOnce(new RecoveryActionError('Waiting for the mint to confirm these notes.'));
  await press(tree,'backup-finish');
  expect(textOf(tree,'backup-result')).toMatch(/Waiting for the mint/);
  expect(onRestored).not.toHaveBeenCalled();
  await press(tree,'backup-finish');
  expect(onRestored).toHaveBeenCalledTimes(1);
});

test('used tills refuse restore, and unexpected errors never show raw wallet data', async () => {
  const used=await show({status:{canRestore:false},restore:true});
  expect(has(used.tree,'backup-choose')).toBe(false);
  const {tree,recovery}=await show();
  recovery.exportFile.mockRejectedValueOnce(new Error('private-test-value'));
  await inputExport(tree);
  await press(tree,'backup-save');
  expect(allText(tree).join(' ')).not.toContain('private-test-value');
});

test('new PIN change requires a saved backup, recovery folder, passphrase and explicit confirmation', async () => {
  const {tree,recovery,files}=await show({status:{lastBackupAt:1000}});
  await press(tree,'backup-change');
  await typeInto(tree,'backup-password',phrase);
  await press(tree,'backup-confirm');
  expect(isDisabled(tree,'backup-enable')).toBe(true);
  files.chooseRecoveryFolder.mockResolvedValueOnce(false);
  await press(tree,'backup-folder');
  expect(isDisabled(tree,'backup-enable')).toBe(true);
  await press(tree,'backup-folder');
  expect(isDisabled(tree,'backup-enable')).toBe(false);
  await press(tree,'backup-enable');
  expect(recovery.setChangeEnabled).toHaveBeenCalledWith(true,phrase);
  await press(tree,'backup-change-off');
  expect(recovery.setChangeEnabled).toHaveBeenLastCalledWith(false);
});

test('an already enabled till can unlock the retained folder without choosing it again', async () => {
  const {tree,recovery,files}=await show({status:{lastBackupAt:1000,changeEnabled:true}});
  await press(tree,'backup-change');
  await typeInto(tree,'backup-password',phrase);
  await press(tree,'backup-confirm');
  await press(tree,'backup-enable');
  expect(files.chooseRecoveryFolder).not.toHaveBeenCalled();
  expect(recovery.setChangeEnabled).toHaveBeenCalledWith(true,phrase);
});


test('a provider that cannot read its export must return byte-for-byte matching content before approval', async () => {
  const {tree,recovery,files} = await show();
  files.save.mockResolvedValueOnce('verify');
  await inputExport(tree);
  await press(tree,'backup-save');
  expect(recovery.confirmSaved).not.toHaveBeenCalled();
  files.open.mockResolvedValueOnce('a different file');
  await press(tree,'backup-verify');
  expect(recovery.confirmSaved).not.toHaveBeenCalled();
  await press(tree,'backup-verify');
  expect(recovery.confirmSaved).toHaveBeenCalledWith(ciphertext);
});

test('leaving the screen during encryption prevents opening the native save picker later', async () => {
  const {tree,recovery,files}=await show();
  let complete!: (file:string) => void;
  recovery.exportFile.mockImplementationOnce(() => new Promise<string>(resolve => {complete=resolve;}));
  await inputExport(tree);
  await press(tree,'backup-save');
  await act(async () => {tree.unmount(); complete(ciphertext);});
  expect(files.save).not.toHaveBeenCalled();
  expect(recovery.confirmSaved).not.toHaveBeenCalled();
});
