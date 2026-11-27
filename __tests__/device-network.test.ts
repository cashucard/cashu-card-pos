import { NativeModules } from 'react-native';
import { deviceNetworkStatus } from '../src/till/device-network';

const original = NativeModules.CCPOSNetwork;
afterEach(() => {
  NativeModules.CCPOSNetwork = original;
  jest.useRealTimers();
});

it('reads the current phone route for each charge, including a change after the last sale', async () => {
  const status = jest.fn().mockResolvedValueOnce('online').mockResolvedValueOnce('offline');
  NativeModules.CCPOSNetwork = { status };
  expect(await deviceNetworkStatus()).toBe('online');
  expect(await deviceNetworkStatus()).toBe('offline');
  expect(status).toHaveBeenCalledTimes(2);
});

it('treats missing, failed, and unrecognised system readings as unknown', async () => {
  NativeModules.CCPOSNetwork = undefined;
  expect(await deviceNetworkStatus()).toBe('unknown');
  NativeModules.CCPOSNetwork = { status: jest.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce(false) };
  expect(await deviceNetworkStatus()).toBe('unknown');
  expect(await deviceNetworkStatus()).toBe('unknown');
});

it('bounds the wait for a native answer and ignores a late indication of offline', async () => {
  jest.useFakeTimers();
  let finish!: (state: string) => void;
  NativeModules.CCPOSNetwork = { status: () => new Promise(resolve => { finish = resolve; }) };
  const pending = deviceNetworkStatus();
  jest.advanceTimersByTime(1000);
  expect(await pending).toBe('unknown');
  finish('offline');
  expect(await pending).toBe('unknown');
});
