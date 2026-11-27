import type { Delivery, Payment } from 'cashucard';
import { CONFIRMATION, fakeTill, fakeTransport, heldPayment } from './helpers/fake-till';
import { checkSale, settleAndCheck, takeSale, type SaleFacts } from '../src/selftest/sale';

/** The facts of a good take over the fakes. */
function goodFacts(over: Partial<SaleFacts> = {}): SaleFacts {
  return {
    payment: heldPayment('s1'),
    confirmation: CONFIRMATION,
    stages: ['reading', 'paid'],
    pinAsks: 0,
    taps: 2,
    ms: 900,
    ...over,
  };
}

describe('the self-test sale', () => {
  it('takeSale opens the sale, answers the confirmation with the PIN, and collects the stages', async () => {
    const till = fakeTill();
    const t = fakeTransport();
    const f = await takeSale(till.cashuCard, t, { id: 's1', sats: 14, pin: '1234', now: () => 0 });
    expect(till.received).toEqual([{ id: 's1', sats: 14 }]);
    expect(f.confirmation).toBe(CONFIRMATION);
    expect(f.stages).toEqual(['paid']);
    expect(f.taps).toBe(2);
  });

  it('the PIN goes back at the confirmation and at every ask', async () => {
    const answers: { confirm: { pay: boolean; pin?: string } | null; pin: string | null } = {
      confirm: null,
      pin: null,
    };
    const till = fakeTill({
      card: async (_t, l) => {
        answers.confirm = await l.confirm(CONFIRMATION);
        answers.pin = await l.askPin!({ wrong: false, tries: 3, why: 'allowance' });
        return heldPayment('s1');
      },
    });
    const f = await takeSale(till.cashuCard, fakeTransport(), { id: 's1', sats: 14, pin: '1234', now: () => 0 });
    expect(answers.confirm).toEqual({ pay: true, pin: '1234' });
    expect(answers.pin).toBe('1234');
    expect(f.pinAsks).toBe(1);
  });

  it('checkSale passes a held exact payment', () => {
    const detail = checkSale(goodFacts(), { sats: 14 });
    expect(detail).toContain('held 14 sats + fee 1');
    expect(detail).toContain('the card paid 15 of 15');
    expect(detail).toContain('reading>paid');
  });

  it('checkSale refuses a payment that is not held', () => {
    const payment: Payment = { ...heldPayment('s1'), state: 'taking', why: 'swap-waiting' };
    expect(() => checkSale(goodFacts({ payment }), { sats: 14 })).toThrow(/taking \(swap-waiting\), not held/);
  });

  it('checkSale refuses a total that does not add up', () => {
    expect(() => checkSale(goodFacts({ confirmation: { ...CONFIRMATION, total: 16 } }), { sats: 14 })).toThrow(
      /the card paid 16, not 15/,
    );
  });

  it('checkSale refuses change on an exact sale', () => {
    expect(() => checkSale(goodFacts({ confirmation: { ...CONFIRMATION, change: 'card-change' } }), { sats: 14 })).toThrow(
      /change \(card-change\)/,
    );
  });

  it('checkSale refuses one tap', () => {
    expect(() => checkSale(goodFacts({ taps: 1 }), { sats: 14 })).toThrow(/only 1 taps/);
  });

  it('checkSale refuses a missing confirmation', () => {
    expect(() => checkSale(goodFacts({ confirmation: null }), { sats: 14 })).toThrow(/no confirmation/);
  });

  it('settleAndCheck passes one delivery of the price at the mint', async () => {
    const till = fakeTill();
    await takeSale(till.cashuCard, fakeTransport(), { id: 's1', sats: 14, pin: '1234', now: () => 0 });
    const detail = await settleAndCheck(till.cashuCard, till.keep, {
      id: 's1',
      sats: 14,
      mint: 'https://mint.test',
    });
    expect(detail).toContain('delivered 14 sats at https://mint.test');
  });

  it('settleAndCheck refuses no delivery', async () => {
    const till = fakeTill({ deliveries: [] });
    await expect(
      settleAndCheck(till.cashuCard, till.keep, { id: 's1', sats: 14, mint: 'https://mint.test' }),
    ).rejects.toThrow(/0 deliveries to keep, not 1/);
  });

  it('settleAndCheck refuses a delivery at another mint', async () => {
    const other: Delivery = {
      id: 'fx-bbbbbbbbbbbbbbbbbbbbbbbbbb',
      mint: 'https://other.test',
      unit: 'sat',
      amount: 14,
      token: 'cashuB' + 'z'.repeat(60),
    };
    const till = fakeTill({ deliveries: [other] });
    await expect(
      settleAndCheck(till.cashuCard, till.keep, { id: 's1', sats: 14, mint: 'https://mint.test' }),
    ).rejects.toThrow(/names https:\/\/other.test/);
  });

  it('settle fails when the payment is not delivered', async () => {
    const till = fakeTill({ paymentState: 'held' });
    await takeSale(till.cashuCard, fakeTransport(), { id: 's1', sats: 14, pin: '1234', now: () => 0 });
    await expect(
      settleAndCheck(till.cashuCard, till.keep, { id: 's1', sats: 14, mint: 'https://mint.test' }),
    ).rejects.toThrow(/the payment is held, not delivered/);
  });

  it('settle fails when the kept token is not a cashuB token', async () => {
    const notCashuB: Delivery = {
      id: 'fx-cccccccccccccccccccccccccc',
      mint: 'https://mint.test',
      unit: 'sat',
      amount: 14,
      token: 'cashuA' + 'q'.repeat(60),
    };
    const till = fakeTill({ deliveries: [notCashuB] });
    await takeSale(till.cashuCard, fakeTransport(), { id: 's1', sats: 14, pin: '1234', now: () => 0 });
    await expect(
      settleAndCheck(till.cashuCard, till.keep, { id: 's1', sats: 14, mint: 'https://mint.test' }),
    ).rejects.toThrow(/not a cashuB token/);
  });
});
