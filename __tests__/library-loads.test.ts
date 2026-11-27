import { CARD_AID, MemoryJournal, open } from 'cashucard';
import { hashToCurve } from '@cashu/cashu-ts';

// The set-up's check that jest reaches the vendored library and its ES-module dependencies. Orders never change it.
describe('the library under jest', () => {
  it('loads cashucard from the vendored tarball', () => {
    expect(CARD_AID).toBe('F043415348554341524401');
    expect(typeof open).toBe('function');
    expect(new MemoryJournal()).toBeDefined();
  });

  it('runs a cashu-ts curve operation', () => {
    expect(hashToCurve(new Uint8Array(32)).toHex(true)).toBe(
      '024cce997d3b518f739663b757deaec95bcd9473c30a14ac2fd04023a739d1a725',
    );
  });
});
