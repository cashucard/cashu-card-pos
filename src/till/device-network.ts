import { NativeModules } from 'react-native';

export type DeviceNetworkStatus = 'online' | 'offline' | 'unknown';

/** Read the phone's current default route. Only a definite offline answer permits choosing an offline sale. */
export async function deviceNetworkStatus(): Promise<DeviceNetworkStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bridge = NativeModules.CCPOSNetwork;
    if (typeof bridge?.status !== 'function') return 'unknown';
    const answer: unknown = await Promise.race([
      bridge.status(),
      new Promise(resolve => { timer = setTimeout(() => resolve('unknown'), 1000); }),
    ]);
    return answer === 'online' || answer === 'offline' ? answer : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
