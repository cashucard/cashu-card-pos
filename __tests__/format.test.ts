import { dateTime, groupDigits, hostOf, plural, sats } from '../src/format';

describe('format', () => {
  it('groupDigits puts a comma every three digits', () => {
    expect(groupDigits('0')).toBe('0');
    expect(groupDigits('999')).toBe('999');
    expect(groupDigits('1000')).toBe('1,000');
    expect(groupDigits('1048576')).toBe('1,048,576');
    expect(groupDigits('9223372036854775808')).toBe('9,223,372,036,854,775,808');
    expect(groupDigits('')).toBe('');
    expect(groupDigits('12a4')).toBe('12a4');
  });

  it('sats writes a whole number of sats', () => {
    expect(sats(0)).toBe('0 sats');
    expect(sats(1)).toBe('1 sat');
    expect(sats(2)).toBe('2 sats');
    expect(sats(1000)).toBe('1,000 sats');
    expect(sats(2101)).toBe('2,101 sats');
    expect(sats(-5)).toBe('-5 sats');
    expect(sats(-1)).toBe('-1 sat');
  });

  it('plural counts', () => {
    expect(plural(1, 'mint', 'mints')).toBe('1 mint');
    expect(plural(2, 'mint', 'mints')).toBe('2 mints');
    expect(plural(1200, 'piece', 'pieces')).toBe('1,200 pieces');
  });

  it('dateTime writes local time', () => {
    expect(dateTime(new Date(2026, 10, 22, 4, 10).getTime())).toBe('22 Nov 2026, 04:10');
    expect(dateTime(new Date(2026, 0, 5, 23, 59).getTime())).toBe('5 Jan 2026, 23:59');
  });

  it('hostOf gives the host', () => {
    expect(hostOf('https://Mint.Test:3338/x')).toBe('mint.test:3338');
    expect(hostOf('https://mint.test')).toBe('mint.test');
    expect(hostOf('http://127.0.0.1:13338/v1')).toBe('127.0.0.1:13338');
    expect(hostOf('nonsense')).toBe('nonsense');
  });
});
