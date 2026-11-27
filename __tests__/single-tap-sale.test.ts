import { CardError, type CardConfirmation, type CardListener, type CardTransport } from 'cashucard';
import { createSaleController } from '../src/till/sale-controller';
import type { SaleState } from '../src/till/sale-machine';
import { CONFIRMATION, heldPayment } from './helpers/fake-till';

const PIN = '5938';
type CardJob = (t: CardTransport, l: CardListener) => Promise<void>;
function harness(script: CardJob) {
  const reader = { begin: jest.fn(async () => {}), end: jest.fn(async () => {}), transceive: jest.fn() };
  const states: SaleState[] = [];
  const ctl = createSaleController({
    service: {
      openSale: async () => 'only-sale',
      takeCard: async (id, t, l) => { await script(t, l); return heldPayment(id); },
      withdrawSale: jest.fn(),
    },
    reader: { kind: 'nfc', available: async () => true, transport: () => reader },
    onState: state => states.push(state),
  });
  ctl.input({ type: 'digit', d: '1' });
  ctl.input({ type: 'digit', d: '4' });
  ctl.input({ type: 'charge' });
  expect(ctl.state().kind).toBe('preflight');
  function approve(pin = '') {
    for (const d of pin) ctl.input({ type: 'pin-digit', d });
    ctl.input({ type: 'pin-ok' });
  }
  return { ctl, states, reader, approve };
}

async function readFirst(t: CardTransport) {
  await t.begin!('Read card');
  await t.end!({ message: 'Read complete' });
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

it.each([
  ['allowance', true, PIN, 'none', 0],
  [null, false, '', 'none', 0],
  [null, false, PIN, 'card-change', 2],
] as const)('settles %s in a single physical encounter', async (pinFor, pinNeeded, entry, change, returned) => {
  let answer: unknown;
  const h = harness(async (t, l) => {
    await readFirst(t);
    answer = await l.confirm({ ...CONFIRMATION, pinNeeded, pinFor, change, changeAmount: returned,
      cardChange: change === 'card-change' ? returned : 0, leftover: 0 });
    await t.begin!('Recheck card and sign');
    await t.end!({ message: 'Paid' });
  });
  h.approve(entry);
  await flush();
  expect(answer).toEqual(pinNeeded ? { pay: true, pin: PIN } : { pay: true });
  expect(h.reader.begin).toHaveBeenCalledTimes(1);
  expect(h.reader.end).toHaveBeenCalledTimes(1);
  expect(h.ctl.state()).toMatchObject({ kind: 'result', outcome: { kind: 'paid' } });
  expect(h.ctl.pinHeld()).toBe(false);
  expect(JSON.stringify(h.states)).not.toContain(PIN);
  h.ctl.dispose();
});

it.each<Partial<CardConfirmation>>([
  { inputFees: 2, total: 16 }, { kept: 1, total: 15 }, { total: 16 },
  { price: 13, total: 14 }, { unit: 'usd' }, { change: 'leftover', leftover: 150, changeAmount: 150, pinFor: 'leftover' },
])('releases NFC for a fresh itemized decision when the quote changes: %p', async change => {
  let answer: unknown;
  const h = harness(async (t, l) => {
    await readFirst(t);
    answer = await l.confirm({ ...CONFIRMATION, ...change });
    throw new CardError('declined', 'Payer declined.');
  });
  h.approve(PIN);
  await flush();
  expect(h.ctl.state().kind).toBe('confirm');
  expect(h.reader.end).toHaveBeenCalledTimes(1);
  expect(h.ctl.pinHeld()).toBe(false);
  h.ctl.input({ type: 'decline' });
  await flush();
  expect(answer).toEqual({ pay: false });
  expect(h.reader.begin).toHaveBeenCalledTimes(1);
  h.ctl.dispose();
});

it('requires a fresh PIN after a wrong one and after skipping a required PIN', async () => {
  const h = harness(async (t, l) => {
    await readFirst(t);
    expect(await l.confirm(CONFIRMATION)).toEqual({ pay: true, pin: PIN });
    await t.begin!('Sign on the reviewed card');
    await t.end!({ message: 'Wrong PIN' });
    expect(await l.askPin!({ wrong: true, tries: 2, why: 'allowance' })).toBeNull();
    throw new CardError('wrong-pin', 'Wrong PIN.');
  });
  h.approve();
  await flush();
  expect(h.reader.end).toHaveBeenCalledTimes(1);
  expect(h.ctl.state().kind).toBe('confirm');
  h.ctl.input({ type: 'pay' });
  h.approve(PIN);
  await flush();
  expect(h.reader.begin).toHaveBeenCalledTimes(2);
  expect(h.ctl.state()).toMatchObject({ kind: 'pin', count: 0, wrong: true, tries: 2 });
  h.ctl.input({ type: 'pin-cancel' });
  await flush();
  expect(h.ctl.pinHeld()).toBe(false);
  h.ctl.dispose();
});

it('closes a retained contact on quote failure and keeps the original error', async () => {
  const h = harness(async t => {
    await readFirst(t);
    throw new CardError('mint-not-accepted', 'Mint is not accepted.');
  });
  h.reader.end.mockRejectedValueOnce(new Error('Reader already gone.'));
  h.approve(PIN);
  await flush();
  expect(h.reader.end).toHaveBeenCalledTimes(1);
  expect(h.ctl.state()).toMatchObject({ kind: 'result', outcome: { errorKind: 'mint-not-accepted' } });
  expect(h.ctl.pinHeld()).toBe(false);
  h.ctl.dispose();
});

it.each(['background', 'dispose', 'expire'] as const)('discards unused PIN and approval on %s', async event => {
  jest.useFakeTimers();
  let proceed!: () => void;
  const wait = new Promise<void>(res => { proceed = res; });
  let answer: unknown;
  const h = harness(async (t, l) => {
    await readFirst(t);
    expect(await l.askPin!({ wrong: false, tries: 3, why: 'recover' })).toBeNull();
    await wait;
    answer = await l.confirm(CONFIRMATION);
    throw new CardError('declined', 'Payer declined.');
  });
  try {
    h.approve(PIN);
    await flush();
    if (event === 'expire') jest.advanceTimersByTime(60001);
    else h.ctl[event]();
    expect(h.ctl.pinHeld()).toBe(false);
    proceed();
    await flush();
    expect(answer).toEqual({ pay: false });
    expect(h.reader.begin).toHaveBeenCalledTimes(1);
    expect(h.reader.end).toHaveBeenCalledTimes(1);
  } finally {
    h.ctl.dispose();
    jest.useRealTimers();
  }
});

it('can choose itemized review before NFC, even after starting PIN entry', async () => {
  const h = harness(async (t, l) => {
    await readFirst(t);
    expect(await l.confirm(CONFIRMATION)).toEqual({ pay: false });
    throw new CardError('declined', 'Payer declined.');
  });
  h.ctl.input({ type: 'pin-digit', d: '5' });
  h.ctl.input({ type: 'review-first' });
  await flush();
  expect(h.reader.end).toHaveBeenCalledTimes(1);
  expect(h.ctl.pinHeld()).toBe(false);
  expect(h.ctl.state().kind).toBe('confirm');
  h.ctl.input({ type: 'decline' });
  await flush();
  h.ctl.dispose();
});


it.each(['expire', 'background', 'dispose'] as const)('never arms the reader after %s during a queued opening', async event => {
  jest.useFakeTimers();
  let opened!: (id: string) => void;
  const open = new Promise<string>(resolve => { opened = resolve; });
  const service = { openSale: () => open, takeCard: jest.fn(), withdrawSale: jest.fn(), leaveSale: jest.fn() };
  const reader = { kind: 'nfc' as const, available: jest.fn(async () => true), transport: jest.fn() };
  const ctl = createSaleController({ service, reader, onState: () => {} });
  try {
    ctl.input({ type: 'digit', d: '3' });
    ctl.input({ type: 'charge' });
    for (const d of PIN) ctl.input({ type: 'pin-digit', d });
    ctl.input({ type: 'pin-ok' });
    expect(ctl.state().kind).toBe('opening');
    if (event === 'expire') jest.advanceTimersByTime(60001);
    else ctl[event]();
    expect(ctl.pinHeld()).toBe(false);
    opened('delayed-sale');
    await flush();
    expect(service.leaveSale).toHaveBeenCalledWith('delayed-sale');
    expect(service.takeCard).not.toHaveBeenCalled();
    expect(reader.available).not.toHaveBeenCalled();
  } finally {
    ctl.dispose();
    jest.useRealTimers();
  }
});

it('refuses an unprompted third SDK begin after an approved card has left the field', async () => {
  const h = harness(async (t, l) => {
    await readFirst(t);
    expect(await l.confirm(CONFIRMATION)).toEqual({ pay: true, pin: PIN });
    await t.begin!('Recheck card and sign');
    await t.end!({ error: 'Card signature refused' });
    await t.begin!('Retry signing');
  });
  h.approve(PIN);
  await flush();
  expect(h.reader.begin).toHaveBeenCalledTimes(1);
  expect(h.ctl.state()).toMatchObject({ kind: 'result', outcome: { errorKind: 'stopped' } });
  h.ctl.dispose();
});

it('permits a second physical scan only after the holder supplies a fresh PIN on retry', async () => {
  const h = harness(async (t, l) => {
    await readFirst(t);
    expect(await l.confirm(CONFIRMATION)).toEqual({ pay: true, pin: PIN });
    await t.begin!('Sign');
    await t.end!({ message: 'Wrong PIN' });
    expect(await l.askPin!({ wrong: true, tries: 2, why: 'allowance' })).toBe('3958');
    await t.begin!('Retry signing');
    await t.end!({ message: 'Paid' });
  });
  h.approve(PIN);
  await flush();
  expect(h.ctl.state()).toMatchObject({ kind: 'pin', count: 0, wrong: true });
  h.approve('3958');
  await flush();
  expect(h.reader.begin).toHaveBeenCalledTimes(2);
  expect(h.ctl.state()).toMatchObject({ kind: 'result', outcome: { kind: 'paid' } });
  h.ctl.dispose();
});
