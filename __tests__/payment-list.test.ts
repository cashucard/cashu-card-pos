// The payment list (slice 2.3): its lines in the payment table's words, oldest first; never a token, a key or an id;
// formulas defused.
import type { Payment } from 'cashucard';
import { archivedWhat, CSV_HEADER, CSV_TITLE, csvField, csvWhen, paymentsCsv } from '../src/app/csv';
import type { ArchivedPayment } from '../src/till/store/archive';
import { heldPayment } from './helpers/fake-till';

const at = (h: number, m: number): number => new Date(2026, 10, 22, h, m).getTime();
const p = (o: Partial<Payment>): Payment => ({ ...heldPayment('s-1'), ...o });
const a = (o: Partial<ArchivedPayment>): ArchivedPayment => ({
  state: 'delivered',
  at: at(3, 0),
  amount: 21,
  fee: 1,
  mint: 'https://mint.test',
  unit: 'sat',
  ...o,
});

describe('the payment list', () => {
  it('one line per payment, oldest first, archived ones first at the same time, in the payment table words', () => {
    const text = paymentsCsv(
      [
        p({ at: at(4, 10), paymentId: 'pay:1' }),
        p({ at: at(5, 0), state: 'taking', paymentId: 'pay:2' }),
        p({ at: at(5, 30), extra: 'paid-twice', paymentId: 'pay:3' }),
      ],
      [
        a({}),
        a({ state: 'exported', at: at(4, 10), amount: 7, fee: 0, mint: 'https://Other.Mint:3338/x' }),
        a({ state: 'gone', at: at(6, 0), amount: 5 }),
      ],
    );
    expect(text).toBe(
      'date,time,sats,what,takings,fee_sats,mint,archived\r\n' +
        '2026-11-22,03:00,21,PAID,yes,1,mint.test,yes\r\n' +
        '2026-11-22,04:10,7,TAKEN OUT,yes,0,other.mint:3338,yes\r\n' +
        '2026-11-22,04:10,14,PAID,yes,1,mint.test,no\r\n' +
        '2026-11-22,05:00,14,CHECKING,no,1,mint.test,no\r\n' +
        '2026-11-22,05:30,14,PAID TWICE,no,1,mint.test,no\r\n' +
        '2026-11-22,06:00,5,LOST,no,1,mint.test,yes\r\n',
    );
    expect(CSV_HEADER).toBe('date,time,sats,what,takings,fee_sats,mint,archived');
    expect(CSV_TITLE).toBe('Cashu Card POS payments');
  });

  it('an empty record is the header alone', () => {
    expect(paymentsCsv([], [])).toBe('date,time,sats,what,takings,fee_sats,mint,archived\r\n');
  });

  it('the list never holds a token, a key, a card key or an id', () => {
    const text = paymentsCsv(
      [
        p({
          id: 's-secret-sale',
          paymentId: 'pay:' + 'd'.repeat(32),
          change: 'cashuB' + 'x'.repeat(60),
          cardKey: '02' + 'c'.repeat(64),
          delivery: { id: 'fx-' + 'e'.repeat(26), ref: 'r-' + 'f'.repeat(20) },
        }),
      ],
      [a({})],
    );
    for (const bad of ['cashu', 'pay:', 'cccc', 'dddd', 'eeee', 'ffff', 'fx-', 's-secret', 'xxxx']) {
      expect(text).not.toContain(bad);
    }
  });

  it('a field a spreadsheet would run is defused, and one with a comma, a quote or a line break is quoted', () => {
    expect(csvField('mint.test')).toBe('mint.test');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvField('+1')).toBe("'+1");
    expect(csvField('-1')).toBe("'-1");
    expect(csvField('@x')).toBe("'@x");
    expect(csvField('=a,b')).toBe('"\'=a,b"');
    expect(csvField('')).toBe('');
    const text = paymentsCsv([], [a({ mint: 'https://=evil.test' })]);
    expect(text).toContain(",'=evil.test,");
  });

  it('dates and times are the phone local ones', () => {
    expect(csvWhen(new Date(2026, 0, 5, 9, 7).getTime())).toEqual(['2026-01-05', '09:07']);
    expect(csvWhen(new Date(2026, 11, 31, 23, 59).getTime())).toEqual(['2026-12-31', '23:59']);
  });

  it('an archived payment is named as the payment table names it', () => {
    expect(archivedWhat('delivered')).toBe('PAID');
    expect(archivedWhat('exported')).toBe('TAKEN OUT');
    expect(archivedWhat('gone')).toBe('LOST');
  });
});

it('exports received Lightning money once with returns and pending receipts excluded from takings', () => {
  const shared = { saleId:'example', paymentId:'ln-example', mint:'https://example.org',
    amount:14, invoice:'PRIVATE-INVOICE', createdAt:1000, expiresAt:2000 };
  const result = paymentsCsv([], [], [
    {...shared, state:'unpaid'}, {...shared, state:'expired'}, {...shared, state:'paid'},
    {...shared, state:'extra'}, {...shared, state:'processing'},
  ]);
  expect(result.trim().split('\r\n')).toHaveLength(4);
  expect(result).toContain('14,PAID · Lightning,yes,,example.org,no');
  expect(result).toContain('14,CUSTOMER RETURN · Lightning,no,,example.org,no');
  expect(result).toContain('14,CONFIRMING · Lightning,no,,example.org,no');
  expect(result).not.toContain('PRIVATE-INVOICE');
});
