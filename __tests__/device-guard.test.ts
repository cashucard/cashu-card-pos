import { NotDevelopmentError, deviceDeps } from '../src/selftest/device';

jest.mock('react-native-nfc-manager', () => ({
  __esModule: true,
  default: { isSupported: jest.fn(async () => false) },
}));

describe('the development wiring', () => {
  it('deviceDeps refuses outside development', () => {
    expect(() => deviceDeps(false)).toThrow(NotDevelopmentError);
  });

  it('deviceDeps builds the wiring in development', () => {
    const deps = deviceDeps(true);
    expect(deps).toBeDefined();
    expect(typeof deps.platform).toBe('string');
  });

  it('deviceDeps for the real journal builds without touching the store', () => {
    expect(deviceDeps(true, 'sqlcipher').journalKind).toBe('SQLCipher journal');
    expect(deviceDeps(true).journalKind).toBe('MemoryJournal');
    expect(() => deviceDeps(false, 'sqlcipher')).toThrow(NotDevelopmentError);
  });

  it('the app hands the development wiring __DEV__, never a literal true', () => {
    const fs = require('fs') as { readFileSync(path: string, encoding: string): string };
    const src = fs.readFileSync('App.tsx', 'utf8');
    expect(src).toContain('deviceDeps(__DEV__, journal)');
    expect(src).toContain('labDeps(__DEV__)');
    expect(src).not.toMatch(/Deps\(\s*true\b/);
  });
});
