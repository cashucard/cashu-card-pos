import { MemoryJournal, type Delivery, type HttpFetch } from 'cashucard';
import { memoryKeep } from '../src/till/keep';
import { LEFTOVER_BY_PIN, openTill, tillConfig } from '../src/till/open';

/** A bolt11 invoice for 14 sats (14,000 msat): the sale can offer without any mint being asked. */
const INVOICE_14 = 'lnbc140n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfs7lvu5';

const DELIVERY: Delivery = {
  id: 'fx-aaaaaaaaaaaaaaaaaaaaaaaaaa',
  mint: 'https://mint.test',
  unit: 'sat',
  amount: 14,
  token: 'cashuBtest',
};

function countingHttp() {
  let fetches = 0;
  const http: HttpFetch = async () => {
    fetches += 1;
    throw new Error('no fetch expected');
  };
  return { http, fetches: () => fetches };
}

describe('the till', () => {
  it('keep stores a delivery once by its id', async () => {
    const keep = memoryKeep();
    await keep.keep(DELIVERY);
    await keep.keep(DELIVERY);
    expect(keep.calls).toHaveLength(2);
    expect(keep.stored.size).toBe(1);
    expect(keep.total()).toBe(14);
  });

  it('keep stores a copy', async () => {
    const keep = memoryKeep();
    const d: Delivery = { ...DELIVERY };
    await keep.keep(d);
    d.amount = 99;
    expect(keep.stored.get(d.id)!.amount).toBe(14);
  });

  it('the keep-store keeps the first delivery of an id', async () => {
    const keep = memoryKeep();
    const first: Delivery = { ...DELIVERY, token: 'cashuBfirst' };
    const second: Delivery = { ...DELIVERY, token: 'cashuBsecond' };
    await keep.keep(first);
    await keep.keep(second);
    expect(keep.stored.get(DELIVERY.id)!.token).toBe('cashuBfirst');
  });

  it('tillConfig turns leftovers off, gives no clock and passes the http on', () => {
    const { http } = countingHttp();
    const c = tillConfig({ http, mints: ['https://mint.test'] }, new MemoryJournal(), memoryKeep());
    expect(c.leftoverByPin).toBe(false);
    expect(c.clock).toBeNull();
    expect(c.http).toBe(http);
    expect(c.payout.kind).toBe('wallet');
    expect(c.now).toBeUndefined();
    const withClock = tillConfig(
      { http, mints: ['https://mint.test'], now: () => 5 },
      new MemoryJournal(),
      memoryKeep(),
    );
    expect(withClock.now!()).toBe(5);
    expect(LEFTOVER_BY_PIN).toBe(false);
  });

  it('openTill opens a till that takes a sale and fetches nothing', async () => {
    const { http, fetches } = countingHttp();
    // an invoice-only sale: the library opens it without asking any mint, so the http is never used
    const t = await openTill({ http, mints: [] });
    await expect(t.cashuCard.receive({ id: 't1', sats: 14, invoice: INVOICE_14 })).resolves.toBeDefined();
    expect(await t.cashuCard.payments()).toEqual([]);
    expect(fetches()).toBe(0);
  });

  it('a sale id is used once', async () => {
    const { http } = countingHttp();
    const t = await openTill({ http, mints: [] });
    await t.cashuCard.receive({ id: 't1', sats: 14, invoice: INVOICE_14 });
    await expect(t.cashuCard.receive({ id: 't1', sats: 14, invoice: INVOICE_14 })).rejects.toMatchObject({ kind: 'same-sale' });
  });
});
