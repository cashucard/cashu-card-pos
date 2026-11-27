import { CardError, type CardListener, type CardTransport, type Payment } from 'cashucard';
import type { DeviceNetworkStatus } from '../src/till/device-network';
import { createSaleController } from '../src/till/sale-controller';
import { CONFIRMATION, heldPayment } from './helpers/fake-till';

const pin = '4352';
const pending = { ...heldPayment('sale'), offline: true, state: 'taking' } as const;

function setup(getNetwork: () => Promise<DeviceNetworkStatus>, ready = true) {
  const transport = { begin: jest.fn(async () => {}), end: jest.fn(async () => {}), transceive: jest.fn() };
  async function offline(id: string, t: CardTransport, l: CardListener): Promise<Payment> {
    await t.begin!('Read'); await t.end!({ message: 'Read' });
    const decision = await l.confirm({ ...CONFIRMATION, pinNeeded: false, pinFor: null });
    expect(decision).toEqual({ pay: true, pin });
    await t.begin!('Sign'); await t.end!({ message: 'Signed' });
    return { ...pending, id };
  }
  const service = {
    hasReadyOfflineMint: jest.fn(async () => ready), openSale: jest.fn(async () => 'sale'),
    takeCard: jest.fn(async () => heldPayment('sale')),
    takeOfflineCard: jest.fn(offline),
    withdrawSale: jest.fn(), leaveSale: jest.fn(),
  };
  const ctl = createSaleController({ service, networkStatus: getNetwork, onState: jest.fn(),
    reader: { kind: 'nfc', available: async () => true, transport: () => transport } });
  function charge(amount = '14') {
    for (const d of amount) ctl.input({type:'digit', d});
    ctl.input({type:'charge'});
  }
  function approve(p = '') {
    for (const d of p) ctl.input({type:'pin-digit', d});
    ctl.input({type:'pin-ok'});
  }
  return { ctl, service, transport, charge, approve };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
it('uses the ordinary Charge, one contact and the original PIN to save exactly one offline receipt', async () => {
  const status = jest.fn(async (): Promise<DeviceNetworkStatus> => 'offline');
  const { ctl, service, transport, charge, approve } = setup(status);
  try {
    charge(); ctl.input({type:'charge'}); await flush();
    expect(ctl.state()).toMatchObject({kind:'preflight', mode:'offline'});
    ctl.input({type:'review-first'}); approve();
    expect(service.openSale).not.toHaveBeenCalled();
    approve(pin); await flush();
    expect(service.openSale.mock.calls).toEqual([[14,true]]);
    expect(transport.begin).toHaveBeenCalledTimes(1);
    expect(service.takeCard).not.toHaveBeenCalled();
    expect(ctl.state()).toMatchObject({kind:'result',outcome:{kind:'saved-offline'}});
    expect(ctl.pinHeld()).toBe(false);
    ctl.input({type:'retry'}); ctl.input({type:'other-way'});
    expect(service.takeOfflineCard).toHaveBeenCalledTimes(1);
    expect(ctl.state()).toMatchObject({kind:'result',outcome:{kind:'saved-offline'}});
    ctl.settled({...heldPayment('other'),paymentId:'another'});
    expect(ctl.state()).toMatchObject({outcome:{kind:'saved-offline'}});
    ctl.settled(heldPayment('sale'));
    expect(ctl.state()).toMatchObject({outcome:{kind:'paid'}});
    expect(status).toHaveBeenCalledTimes(1);
  } finally { ctl.dispose(); }
});

it.each(['online','unknown','rejected'] as const)('keeps %s connectivity on normal checkout even if the mint fails', async value => {
  const {ctl,service,charge,approve} = setup(async () => {
    if (value === 'rejected') throw Error('unavailable');
    return value;
  });
  service.takeCard.mockRejectedValue(new CardError('mint','Mint unavailable'));
  try {
    charge(); await flush(); approve(); await flush();
    ctl.input({type:'retry'}); await flush();
    expect(service.openSale.mock.calls).toEqual([[14]]);
    expect(service.takeCard).toHaveBeenCalledTimes(2);
    expect(service.hasReadyOfflineMint).not.toHaveBeenCalled();
    expect(service.takeOfflineCard).not.toHaveBeenCalled();
  } finally { ctl.dispose(); }
});

it.each([['101',true],['14',false]] as const)('refuses an ineligible offline sale before any card read (%s, %s)', async (amount,ready) => {
  const {ctl,service,charge,transport} = setup(async () => 'offline', ready);
  try {
    charge(amount); await flush();
    expect(ctl.state()).toMatchObject({kind:'result',outcome:{kind:'not-paid'}});
    expect(service.openSale).not.toHaveBeenCalled();
    expect(transport.begin).not.toHaveBeenCalled();
  } finally { ctl.dispose(); }
});

it('ignores a late offline answer from a cancelled attempt and checks again at the next Charge', async () => {
  let resolve!: (s: DeviceNetworkStatus) => void;
  const status = jest.fn(async ():Promise<DeviceNetworkStatus> => 'online')
    .mockImplementationOnce(() => new Promise(ok => {resolve = ok;}));
  const {ctl,service,charge,approve} = setup(status);
  try {
    charge(); approve(pin); ctl.input({type:'review-first'});
    expect(service.openSale).not.toHaveBeenCalled();
    ctl.input({type:'pin-cancel'}); ctl.input({type:'charge'});
    resolve('offline'); await flush(); approve(); await flush();
    expect(service.openSale.mock.calls).toEqual([[14]]);
    expect(service.hasReadyOfflineMint).not.toHaveBeenCalled();
  } finally { ctl.dispose(); }
});

it.each(['delivered','gone'] as const)('reflects %s from the mint even when settlement beats the offline receipt', async state => {
  const { ctl, service, charge, approve } = setup(async () => 'offline');
  service.takeOfflineCard.mockImplementationOnce(async () => {
    ctl.settled({ ...pending, state });
    return pending;
  });
  try {
    charge(); await flush(); approve(pin); await flush();
    expect(ctl.state()).toMatchObject({kind:'result', outcome:{kind:state === 'gone' ? 'offline-loss' : 'paid'}});
    ctl.input({type:'retry'});
    expect(service.takeOfflineCard).toHaveBeenCalledTimes(1);
  } finally { ctl.dispose(); }
});

it('retries a refused offline read with a fresh PIN and the original sale even after reconnection', async () => {
  const status = jest.fn(async (): Promise<DeviceNetworkStatus> => 'offline');
  const { ctl, service, charge, approve } = setup(status);
  service.takeOfflineCard.mockRejectedValueOnce(new CardError('gone', 'Card moved.'));
  try {
    charge(); await flush(); approve(pin); await flush();
    expect(ctl.state()).toMatchObject({outcome:{kind:'not-paid'}});
    status.mockResolvedValue('online');
    ctl.input({type:'retry'}); await flush();
    expect(ctl.state()).toMatchObject({kind:'preflight',mode:'offline',count:0});
    approve(pin); await flush();
    expect(ctl.state()).toMatchObject({outcome:{kind:'saved-offline'}});
    expect(service.openSale.mock.calls).toEqual([[14,true]]);
    expect(service.takeCard).not.toHaveBeenCalled();
  } finally { ctl.dispose(); }
});
