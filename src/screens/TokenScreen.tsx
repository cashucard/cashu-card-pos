import React, { useEffect, useRef, useState } from 'react';
import { AppState, Clipboard } from 'react-native';
import { CashuQr } from './CashuQr';
export { tokenQr } from './CashuQr';
import { MerchantMessage, PanelLabel } from './MerchantPanel';
import { Body, Button, Screen } from '../ui/kit';

interface TokenProps {
  title: string;
  mint?: string;
  token: string;
  share?: (title: string, text: string) => Promise<void>;
  onDone(): void;
}

/** The caller opens this only after the device-owner check and drops the token on dismissal. */
export function TokenScreen({ title, mint, token, share, onDone }: TokenProps): React.JSX.Element {
  const [showText, setShowText] = useState(false);
  const [visible, setVisible] = useState(true);
  const [message, setMessage] = useState('');
  const [sharing, setSharing] = useState(false);
  const isVisible = useRef(true);
  const openShare = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const close = () => {
      if (!isVisible.current) return;
      isVisible.current = false;
      setVisible(false);
      done.current();
    };
    const sub = AppState.addEventListener('change', s => {
      if (s === 'background' || s === 'inactive') close();
    });
    if (AppState.currentState === 'background' || AppState.currentState === 'inactive') close();
    return () => {
      isVisible.current = false;
      sub.remove();
    };
  }, []);

  async function shareToken(): Promise<void> {
    if (!share || !isVisible.current || openShare.current) return;
    openShare.current = true;
    setSharing(true);
    try {
      await share(title, token);
    } catch {
      if (isVisible.current) setMessage('The share sheet could not open. You can copy the token instead.');
    } finally {
      openShare.current = false;
      if (isVisible.current) setSharing(false);
    }
  }

  return (
    <Screen title={title} titleID="token-title">
      {visible && <>
        {mint && <>
            <PanelLabel>Issuing mint</PanelLabel>
            <Body testID="token-mint">{mint}</Body>
        </>}
        <CashuQr value={token} label="Cashu token QR code" imageID="token-qr"
          fallback={<Body testID="token-too-long">This token is too large for one QR code. Copy or share it instead.</Body>} />
        <Body>Only show or send this token to its intended recipient.</Body>
        {message !== '' && <MerchantMessage id="token-message">{message}</MerchantMessage>}
        <Button testID="token-copy" label="Copy token" disabled={sharing} onPress={() => {
          if (!isVisible.current) return;
          try {
            Clipboard.setString(token);
            setMessage('Token copied to the clipboard.');
          } catch {
            setMessage('Couldn’t copy the token. Try sharing it.');
          }
        }} />
        {share && <Button testID="token-share" label="Share token" kind="plain" disabled={sharing}
          onPress={() => { void shareToken(); }} />}
        <Button testID="token-show-text" label={showText ? 'Hide token text' : 'Show token text'} kind="plain"
          onPress={() => setShowText(!showText)} />
        {showText && <Body testID="token-text" accessibilityLabel="Token text visible. Use Copy token to copy it.">{token}</Body>}
        <Button testID="token-done" label="Done" kind="plain" onPress={onDone} />
      </>}
    </Screen>
  );
}
