import type { DeviceGate } from './gate';
import { foregroundWalletAction } from './foreground-wallet-action';

export function revealToken(
  gate: DeviceGate,
  lifetime: AbortSignal,
  read: () => Promise<string>,
  show: (token: string) => void,
): Promise<string> {
  const interrupted = 'Return to the till and verify again to open the token.';
  return foregroundWalletAction(gate, 'wallet-export', lifetime, interrupted, async stillInFront => {
    const token = await read();
    if (!stillInFront()) return interrupted;
    show(token);
    return '';
  });
}
