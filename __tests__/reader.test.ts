import type { RawFetch } from '../src/till/http';
import { cardsimReader, NoReaderError, noReader, READER_WORDS } from '../src/till/reader';
import { DevOnlyError } from '../src/till/store/wipe';

const raw = jest.fn() as unknown as RawFetch;

describe('the card reader seam', () => {
  it('no reader reads no card', async () => {
    const r = noReader();
    expect(r.kind).toBe('none');
    await expect(r.available()).resolves.toBe(false);
    expect(() => r.transport()).toThrow(NoReaderError);
  });

  it('the card simulator is for development only', async () => {
    expect(() => cardsimReader(raw, false)).toThrow(DevOnlyError);
    const r = cardsimReader(raw, true);
    expect(r.kind).toBe('card simulator');
    await expect(r.available()).resolves.toBe(true);
    const first = r.transport();
    const second = r.transport();
    expect(typeof first.transceive).toBe('function');
    expect(typeof second.transceive).toBe('function');
    expect(first).not.toBe(second);
    expect(raw).not.toHaveBeenCalled();
  });

  it('each reader has its words', () => {
    expect(READER_WORDS).toEqual({
      'card simulator': 'the card simulator (development)',
      nfc: 'NFC',
      none: 'none in this version',
    });
  });
});
