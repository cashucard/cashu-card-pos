import React, { useContext } from 'react';
import { InstalledVersionContext } from '../app/installed-version';
import { PrivacyPolicyLink } from './PrivacyPolicyLink';
import { Body, Screen } from '../ui/kit';

export interface AboutProps {
  mode: 'development' | 'release';
  libraryVersion: string;
  reader: string;
  onBack: () => void;
}

/** What this till is, in its own words. */
export function AboutScreen(p: AboutProps): React.JSX.Element {
  const { versionName, buildNumber } = useContext(InstalledVersionContext);
  const version = versionName || 'Version unavailable';
  const build = buildNumber ? ` (${buildNumber})` : '';
  const development = p.mode === 'development' ? ' (development build)' : '';
  return (
    <Screen title="About this till" titleID="about-title" onBack={p.onBack}>
      <Body testID="about-app">
        {`Cashu Card POS ${version}${build}${development}`}
      </Body>
      <Body testID="about-library">{'Card library: cashucard ' + p.libraryVersion}</Body>
      <Body testID="about-takes">{'Takes Cashu Cards with card software 3.0 or 3.1, in sats.'}</Body>
      <Body testID="about-reader">{'Card reader: ' + p.reader}</Body>
      <Body testID="about-record">
        {
          'The till keeps its payment record encrypted on this phone. Save a passphrase-protected copy in Settings → Backups and change.'
        }
      </Body>
      <Body testID="about-checkout">
        {
          'Sell can check a balance, top up a card and accept eligible payments offline.'
        }
      </Body>
      <Body testID="about-privacy">
        {
          'The till contacts your mints. For a Lightning withdrawal, it also asks your Lightning address provider for an invoice. It has no analytics and no crash reporter.'
        }
      </Body>
      <PrivacyPolicyLink />
    </Screen>
  );
}
