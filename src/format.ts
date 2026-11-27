/** A string of digits with a comma every three from the right: '1048576' -> '1,048,576'. Anything that is not only
 * digits (the empty string too) is returned as given. */
export function groupDigits(s: string): string {
  if (!/^[0-9]+$/.test(s)) {
    return s;
  }
  let out = '';
  for (let end = s.length; end > 0; end -= 3) {
    const start = Math.max(0, end - 3);
    const part = s.slice(start, end);
    out = out === '' ? part : part + ',' + out;
  }
  return out;
}

/** A whole number of sats: '0 sats', '1 sat', '2 sats', '1,000 sats', '-5 sats' (the sign kept, the digits grouped). */
export function sats(n: number): string {
  const sign = n < 0 ? '-' : '';
  const digits = groupDigits(String(Math.abs(n)));
  return sign + digits + (Math.abs(n) === 1 ? ' sat' : ' sats');
}

/** A count and its noun: plural(1, 'mint', 'mints') -> '1 mint'; plural(1200, 'piece', 'pieces') -> '1,200 pieces'. */
export function plural(n: number, one: string, many: string): string {
  const sign = n < 0 ? '-' : '';
  const digits = groupDigits(String(Math.abs(n)));
  return sign + digits + ' ' + (Math.abs(n) === 1 ? one : many);
}

// Cashu's usd unit is one US cent, including in stored balances and withdrawals.
export function cashuAmount(n: number, unit: string): string {
  if (unit === 'sat') return sats(n);
  if (unit === 'usd') return plural(n, 'US cent', 'US cents');
  return groupDigits(String(n)) + ' ' + unit;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const pad2 = (n: number): string => (n < 10 ? '0' + n : String(n));

/** Local time as 'D Mon YYYY, HH:MM': '22 Nov 2026, 04:10'. Months Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec;
 * the day without a leading zero; hours 00 to 23 and minutes with two digits. */
export function dateTime(ms: number): string {
  const d = new Date(ms);
  return (
    String(d.getDate()) +
    ' ' +
    MONTHS[d.getMonth()] +
    ' ' +
    String(d.getFullYear()) +
    ', ' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes())
  );
}

/** The host (and port, when one is written) of an http or https URL, in lower case: 'https://Mint.Test:3338/x' ->
 * 'mint.test:3338'. Text that is not such a URL is returned as given. */
export function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]*)/i.exec(url);
  if (m === null) {
    return url;
  }
  const authority = m[1];
  const at = authority.lastIndexOf('@');
  const host = at >= 0 ? authority.slice(at + 1) : authority;
  if (host === '') {
    return url;
  }
  return host.toLowerCase();
}
