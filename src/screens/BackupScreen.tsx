import {utf8ToBytes} from '@noble/hashes/utils.js';
import React, {useEffect, useRef, useState} from 'react';
import {AppState, Keyboard, Pressable, StyleSheet, Text} from 'react-native';
import {backupFiles, type BackupFiles} from '../app/backup-files';
import {foregroundWalletAction} from '../till/foreground-wallet-action';
import type {DeviceGate, GateReason} from '../till/gate';
import {RecoveryActionError, type TillRecoveryActions, type TillRecoveryStatus} from '../till/recovery-actions';
import {Body, Button, Field, Gap, Screen} from '../ui/kit';
import {FONT, useTheme} from '../ui/theme';

type Mode = 'home' | 'save' | 'restore' | 'change' | 'verify';
type Result = {tone: 'good' | 'muted' | 'bad'; words: string};

export interface BackupProps {
  recovery: TillRecoveryActions;
  gate: DeviceGate;
  files?: BackupFiles;
  startRestore?: boolean;
  restoring?: boolean;
  onBack(): void;
  onRestored(): void;
}

const interrupted = 'Return to Backups and change and confirm the action again.';
const minPassphrase = 12;
function validPassphrase(value: string) {
  if (Array.from(value.trim()).length < minPassphrase) return false;
  const bytes = utf8ToBytes(value);
  const fits = bytes.length <= 256;
  bytes.fill(0);
  return fits;
}

export function BackupScreen({recovery, gate, files = backupFiles, startRestore, restoring,
  onBack, onRestored}: BackupProps): React.JSX.Element {
  const palette = useTheme();
  const lifetime = useRef(new AbortController());
  const working = useRef(false);
  const encrypted = useRef<string | null>(null);
  const [mode, setMode] = useState<Mode>(startRestore ? 'restore' : 'home');
  const [selected, setSelected] = useState(false);
  const [retired, setRetired] = useState(false);
  const [folderChosen, setFolderChosen] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<TillRecoveryStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const waiting = restoring || status?.restoring;
  function clearFields() { setPassphrase(''); setRepeat(''); }
  function changeMode(next: Mode) {
    encrypted.current = null;
    setSelected(false);
    setRetired(false);
    setFolderChosen(false);
    clearFields();
    setResult(null);
    setMode(next);
  }

  async function refresh() {
    const signal = lifetime.current.signal;
    try {
      const current = await recovery.status();
      if (!signal.aborted) {
        setStatus(current);
        setLoadFailed(false);
      }
    } catch {
      if (!signal.aborted) {
        setStatus(null);
        setLoadFailed(true);
      }
    }
  }

  useEffect(() => {
    const active = new AbortController();
    lifetime.current = active;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background') clearFields();
    });
    return () => {
      active.abort();
      encrypted.current = null;
      subscription.remove();
    };
  }, [recovery]);

  useEffect(() => { void refresh(); }, [recovery, restoring]);

  async function run(action: (signal: AbortSignal) => Promise<Result>, fallback: string) {
    if (working.current) return;
    const signal = lifetime.current.signal;
    working.current = true;
    setBusy(true);
    setResult(null);
    Keyboard.dismiss();
    try {
      const message = await action(signal);
      if (!signal.aborted) setResult(message);
    } catch (e) {
      if (!signal.aborted) setResult({tone: 'bad', words: e instanceof RecoveryActionError ? e.message : fallback});
    } finally {
      working.current = false;
      if (!signal.aborted) {
        setBusy(false);
        await refresh();
      }
    }
  }

  async function authorize(signal: AbortSignal, reason: GateReason,
    action: (inFront: () => boolean) => Promise<Result>): Promise<Result> {
    let resultTone: Result['tone'] = 'bad';
    const words = await foregroundWalletAction(gate, reason, signal, interrupted, async inFront => {
      const message = await action(inFront);
      resultTone = message.tone;
      return message.words;
    });
    return {words, tone: resultTone};
  }

  function save() {
    if (!validPassphrase(passphrase) || repeat !== passphrase) return;
    const password = passphrase;
    clearFields();
    void run(signal => authorize(signal, 'backup-save', async inFront => {
      const file = await recovery.exportFile(password);
      if (!inFront()) return {tone:'bad', words:interrupted};
      const saved = await files.save(file);
      if (saved === null) return {tone:'muted', words:'Save canceled. Choose a location when you are ready.'};
      if (saved === 'verify') {
        if (!signal.aborted) { encrypted.current = file; setMode('verify'); }
        return {tone:'muted', words:'Choose the file you just saved to verify it.'};
      }
      // The document picker can cover the app. Its successful completion acknowledges only this exact file.
      await recovery.confirmSaved(file);
      if (!signal.aborted) changeMode('home');
      return {tone:'good', words:'Backup saved. Keep the file and its passphrase in separate safe places.'};
    }), 'The backup could not be saved. Choose a writable location and try again.');
  }

  function verifySaved() {
    const expected = encrypted.current;
    if (!expected) return;
    void run(signal => authorize(signal, 'backup-save', async () => {
      const selectedFile = await files.open();
      if (selectedFile === null) return {tone:'muted', words:'File selection canceled.'};
      if (selectedFile !== expected) return {tone:'bad', words:'This file differs from the one just saved. Choose the new backup.'};
      await recovery.confirmSaved(expected);
      if (!signal.aborted) changeMode('home');
      return {tone:'good', words:'Backup file verified. Keep its passphrase in a separate safe place.'};
    }), 'The saved file could not be verified. Choose the same file and try again.');
  }

  function chooseFile() {
    clearFields();
    setRetired(false);
    void run(async signal => {
      const file = await files.open();
      if (file === null) return {tone:'muted', words:'File selection canceled.'};
      if (!signal.aborted) {
        encrypted.current = file;
        setSelected(true);
        setRetired(false);
        clearFields();
      }
      return {tone:'muted', words:'Backup file selected.'};
    }, 'Choose a Cashu POS backup file of 24 MB or less.');
  }

  function restore() {
    const file = encrypted.current;
    if (!file || !retired || !passphrase.length || !status?.canRestore) return;
    const password = passphrase;
    clearFields();
    void run(signal => authorize(signal, 'backup-restore', async () => {
      await recovery.importFile(file, password);
      encrypted.current = null;
      if (!signal.aborted) setSelected(false);
      return {tone:'good', words:'Backup opened. Connect to your mints to finish recovery.'};
    }), 'Check the backup file and its passphrase, then try again.');
  }

  function finish() {
    void run(signal => authorize(signal, 'backup-restore', async () => {
      await recovery.finishRestore();
      if (!signal.aborted) onRestored();
      return {tone:'good', words:'Till restored.'};
    }), 'The check could not finish. Reconnect to your mints and try again.');
  }

  function chooseFolder() {
    void run(signal => authorize(signal, 'change-by-pin', async () => {
      const chosen = await files.chooseRecoveryFolder();
      if (!signal.aborted && chosen) setFolderChosen(true);
      return chosen ? {tone:'good', words:'Recovery folder selected.'} : {tone:'muted', words:'Folder selection canceled.'};
    }), 'The till could not keep access to this folder. Try another location.');
  }

  function enableChange() {
    const password = passphrase;
    if (!validPassphrase(password) || !retired || (!folderChosen && !status?.changeEnabled)) return;
    clearFields();
    void run(signal => authorize(signal, 'change-by-pin', async () => {
      await recovery.setChangeEnabled(true, password);
      if (!signal.aborted) changeMode('home');
      return {tone:'good', words:'Change collection is ready for this session.'};
    }), 'Check your backup passphrase and recovery folder, then try again.');
  }

  function disableChange() {
    void run(signal => authorize(signal, 'change-by-pin', async () => {
      await recovery.setChangeEnabled(false);
      return {tone:'good', words:'Change collection is off for new sales. Existing returns are still available.'};
    }), 'The change setting could not be saved. Try again.');
  }

  function confirmation(words:string) {
    return <Pressable accessibilityRole="checkbox" accessibilityLabel={words}
      accessibilityState={{checked:retired, disabled:busy}} testID="backup-confirm" disabled={busy}
      onPress={() => setRetired(v => !v)} style={[styles.confirm, {borderColor:palette.line}]}>
      <Text style={[styles.check, {color:palette.good}]} accessible={false}>{retired ? '☑' : '☐'}</Text>
      <Text style={[styles.confirmText, {color:palette.text}]}>{words}</Text>
    </Pressable>;
  }

  const message = result ? <Body testID="backup-result" tone={result.tone}>{result.words}</Body> : null;
  const back = busy || waiting ? undefined : mode === 'home' || startRestore ? onBack : () => changeMode('home');
  const title = waiting ? 'Finish restoring your till' : mode === 'save' ? 'Save a backup' :
    mode === 'restore' ? 'Restore a till' : mode === 'change' ? 'Protect customer change' : mode === 'verify' ? 'Verify your saved file' : 'Backups and change';

  return <Screen title={title} titleID="backup-title" onBack={back} adjustForKeyboard>
    {waiting ? <>
      <Body>Check the restored record with its mints before taking payments or sending takings from this phone.</Body>
      <Button testID="backup-finish" label="Check with mints" disabled={busy} onPress={finish} />
    </> : !status ? <>
      <Body>{loadFailed ? 'The till could not read its backup settings.' : 'Reading your backup settings…'}</Body>
      {loadFailed && <Button label="Try again" testID="backup-retry" onPress={() => {void refresh();}} />}
    </> : mode === 'home' ? <>
      <Body testID="backup-latest">{status.lastBackupAt === null ? 'You haven’t saved a backup yet.' :
        'Latest saved backup: ' + new Date(status.lastBackupAt).toLocaleString() + '.'}</Body>
      <Body tone="muted">Each backup captures this till at the time you save it. Save a new file after money moves or customer change is recorded.</Body>
      <Button testID="backup-export" label="Save a backup" onPress={() => changeMode('save')} disabled={busy}/>
      {status.canRestore && <Button testID="backup-import" label="Restore a backup" kind="plain" disabled={busy}
        onPress={() => changeMode('restore')}/>}
      <Gap />
      <Body big>Collect change with a PIN</Body>
      <Body>{status.changeUnlocked ? 'Ready. This till can hold online change for the original card.' : status.changeEnabled
        ? 'Locked. Unlock the recovery folder for this session to hold new change.'
        : 'Off. Enable this to hold change when an online sale cannot return it all to the card.'}</Body>
      <Body tone="muted">The customer comes back to this till with the same card and PIN. Find the return under Owed to Cards. Offline payments still require exact change.</Body>
      {status.lastBackupAt === null && !status.changeEnabled && <Body tone="muted">Save a backup to enable this setting.</Body>}
      {status.changeUnlocked ? <Body tone="muted">Turn off change collection before choosing a different recovery folder.</Body> :
        <Button testID="backup-change" label={status.changeEnabled ? 'Unlock change collection' : 'Enable change collection'}
          kind="plain" disabled={busy || status.lastBackupAt === null} onPress={() => changeMode('change')}/>}
      {status.changeEnabled && <Button testID="backup-change-off" label="Turn off change collection" kind="plain" disabled={busy} onPress={disableChange}/>}
    </> : mode === 'change' ? <>
      <Body>Choose a private folder you can open from a replacement phone. The till saves encrypted recovery files there when it holds change for a customer.</Body>
      <Button testID="backup-folder" label={folderChosen ? 'Choose another folder' : status.changeEnabled ? 'Choose a different folder' : 'Choose recovery folder'}
        kind="plain" disabled={busy} onPress={chooseFolder}/>
      <Field secure editable={!busy} testID="backup-password" value={passphrase} onChangeText={setPassphrase} placeholder="Saved backup passphrase"/>
      {confirmation('I can open this folder from another device.')}
      <Button testID="backup-enable" label="Unlock for this session" disabled={busy || !validPassphrase(passphrase) || !retired || (!folderChosen && !status.changeEnabled)}
        onPress={enableChange}/>
    </> : mode === 'verify' ? <>
      <Body>Your file provider needs permission to read the saved backup. Open your new copy to confirm it can be read back.</Body>
      <Button testID="backup-verify" label="Verify saved file" onPress={verifySaved} disabled={busy}/>
    </> : mode === 'save' ? <>
      <Body>Use four or more words for a passphrase you can keep safely. You’ll need it to open this file on a replacement phone.</Body>
      <Field secure editable={!busy} testID="backup-password" placeholder="Passphrase (12 or more characters)" value={passphrase} onChangeText={setPassphrase}/>
      <Field secure editable={!busy} testID="backup-repeat" placeholder="Repeat passphrase" value={repeat} onChangeText={setRepeat}/>
      {repeat.length > 0 && passphrase !== repeat && <Body tone="bad">The passphrases differ.</Body>}
      <Button testID="backup-save" label="Choose where to save" disabled={busy || !validPassphrase(passphrase) || passphrase !== repeat} onPress={save}/>
    </> : !status.canRestore ? <>
      <Body>This phone already has a till record. Restore on a fresh till before adding a mint or taking payments.</Body>
    </> : <>
      <Body>Use your latest backup on this replacement phone. Stop using the original till and retire any other copies before restoring.</Body>
      <Body tone="muted">If you shared a withdrawal or return QR after saving this file, have the recipient redeem it first. An unclaimed QR can still spend those sats.</Body>
      <Button testID="backup-choose" label={selected ? 'Choose another file' : 'Choose backup file'} kind={selected ? 'plain' : 'primary'}
        disabled={busy} onPress={chooseFile}/>
      {selected && <>
        <Field secure editable={!busy} testID="backup-password" value={passphrase} onChangeText={setPassphrase} placeholder="Backup passphrase"/>
        {confirmation('I chose my latest backup and retired the original till.')}
        <Button testID="backup-restore" label="Restore this backup" disabled={busy || !retired || !passphrase.length} onPress={restore}/>
      </>}
    </>}
    {busy && <Body testID="backup-working" tone="muted">Working…</Body>}
    {message}
  </Screen>;
}

const styles = StyleSheet.create({
  confirm:{minHeight:52, flexDirection:'row', alignItems:'center', gap:10, borderWidth:1, borderRadius:12, padding:12, marginVertical:8},
  check:{fontSize:24},
  confirmText:{flex:1, fontFamily:FONT.regular, fontSize:16},
});
