import { fromHex, toHex } from '../src/till/hex';

describe('hex', () => {
  it('toHex writes two lower-case digits a byte', () => {
    expect(toHex(new Uint8Array([0, 1, 0xab, 0xff]))).toBe('0001abff');
    expect(toHex(new Uint8Array([]))).toBe('');
  });

  it('fromHex reads upper and lower case', () => {
    expect(fromHex('0001ABff')).toEqual(new Uint8Array([0, 1, 0xab, 0xff]));
    expect(fromHex('')).toHaveLength(0);
  });

  it('fromHex refuses what is not hex', () => {
    expect(() => fromHex('abc')).toThrow(/not hex/);
    expect(() => fromHex('zz')).toThrow(/not hex/);
  });
});
