import React from 'react';
import { Alert, Linking } from 'react-native';
import { Button } from '../ui/kit';

const policyUrl = 'https://cashucard.org/privacy#pos';

export function PrivacyPolicyLink(): React.JSX.Element {
  const openPolicy = async () => {
    try {
      await Linking.openURL(policyUrl);
    } catch {
      Alert.alert('Privacy policy', 'You can read the Cashu Card POS privacy policy at ' + policyUrl);
    }
  };
  return <Button kind="plain" testID="privacy-policy" label="Privacy policy" onPress={() => void openPolicy()} />;
}
