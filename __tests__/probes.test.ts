import {
  H2C_ZERO32,
  POINT_2G,
  SHA256_ABC,
  checkCurve,
  checkEngine,
  checkHash,
  checkLibrary,
  checkNfc,
  checkPolyfills,
  checkRandom,
} from '../src/selftest/probes';
import { STEP_IDS, type PolyfillGlobal } from '../src/selftest/types';

const real = globalThis as unknown as PolyfillGlobal;

/** A global whose text classes and URL are Node's own and whose random source is a counter. */
function goodGlobal(): PolyfillGlobal {
  let n = 1;
  const counter = (array: Uint8Array): Uint8Array => {
    for (let i = 0; i < array.length; i += 1) {
      array[i] = (n + i) & 255;
    }
    n += 1;
    return array;
  };
  return {
    crypto: { getRandomValues: counter },
    TextEncoder: real.TextEncoder,
    TextDecoder: real.TextDecoder,
    URL: real.URL,
    __ccposPolyfills: { textEncoder: 'native', textDecoder: 'polyfill' },
  };
}

/** A decoder that looks like TextDecoder but reads every byte and ignores every option. */
class LaxDecoder {
  decode(b: Uint8Array): string {
    return String.fromCharCode(...Array.from(b));
  }
}

/** A URL class whose parts are not the ones asked of it. */
class BrokenPartsUrl {
  protocol = 'https:';
  hostname = '';
  port = '';
  pathname = '/';
  search = '';
  constructor(_u: string) {}
}

describe('the self-test probes', () => {
  it('checkEngine passes on Hermes and says whether the new architecture is on', () => {
    expect(checkEngine(true, true)).toContain('new architecture on');
    expect(checkEngine(true, false)).toContain('off');
  });

  it('checkEngine fails off Hermes', () => {
    expect(() => checkEngine(false, true)).toThrow(/not running on Hermes/);
  });

  it('checkPolyfills passes with whole text classes and URL, and names the marks', () => {
    const detail = checkPolyfills(goodGlobal());
    expect(detail).toContain('TextEncoder native');
    expect(detail).toContain('TextDecoder polyfill');
    expect(detail).toContain('fatal honoured');
  });

  it('checkPolyfills says unmarked when the polyfill file did not run', () => {
    const g = goodGlobal();
    delete g.__ccposPolyfills;
    expect(checkPolyfills(g)).toContain('unmarked');
  });

  it('checkPolyfills fails a TextDecoder that ignores fatal', () => {
    const g = goodGlobal();
    g.TextDecoder = LaxDecoder;
    expect(() => checkPolyfills(g)).toThrow(/ignores fatal/);
  });

  it('checkPolyfills fails without a TextDecoder', () => {
    const g = goodGlobal();
    delete g.TextDecoder;
    expect(() => checkPolyfills(g)).toThrow(/no TextDecoder/);
  });

  it('checkPolyfills fails a URL that cannot read its parts', () => {
    const g = goodGlobal();
    g.URL = BrokenPartsUrl;
    expect(() => checkPolyfills(g)).toThrow(/URL parts wrong/);
  });

  it('checkRandom passes with distinct bytes and the native module', () => {
    expect(checkRandom(goodGlobal(), true)).toContain('distinct');
  });

  it('checkRandom fails bytes left at zero', () => {
    const g: PolyfillGlobal = { crypto: { getRandomValues: (a) => a } };
    expect(() => checkRandom(g, true)).toThrow(/at zero/);
  });

  it('checkRandom fails the same bytes twice', () => {
    const g: PolyfillGlobal = {
      crypto: {
        getRandomValues: (a) => {
          a.fill(7);
          return a;
        },
      },
    };
    expect(() => checkRandom(g, true)).toThrow(/same 32 bytes/);
  });

  it('checkRandom fails without the native module', () => {
    expect(() => checkRandom(goodGlobal(), false)).toThrow(/Math.random/);
  });

  it('checkRandom fails without getRandomValues', () => {
    expect(() => checkRandom({}, true)).toThrow(/no crypto.getRandomValues/);
  });

  it('checkHash matches the sha256 vector', () => {
    expect(checkHash()).toContain(SHA256_ABC.slice(0, 16));
  });

  it('checkHash fails when its expected constant is wrong', () => {
    expect(() => checkHash('00'.repeat(32))).toThrow(/sha256\(abc\)/);
  });

  it('checkCurve matches hashToCurve and 2G', () => {
    const detail = checkCurve();
    expect(detail).toContain(H2C_ZERO32.slice(0, 16));
    expect(detail).toContain(POINT_2G.slice(0, 16));
  });

  it('checkCurve fails when its expected constant is wrong', () => {
    expect(() => checkCurve('00'.repeat(33))).toThrow(/hashToCurve/);
  });

  it('checkLibrary loads the library', async () => {
    await expect(checkLibrary()).resolves.toContain('F043415348554341524401');
  });

  it('checkLibrary fails when its expected constant is wrong', async () => {
    await expect(checkLibrary('00')).rejects.toThrow(/CARD_AID/);
  });

  it('checkNfc passes a linked module that says no NFC', async () => {
    await expect(checkNfc(true, async () => false)).resolves.toContain('isSupported false');
  });

  it('checkNfc fails a module that is not linked', async () => {
    await expect(checkNfc(false, async () => true)).rejects.toThrow(/not linked/);
  });

  it('checkNfc fails when isSupported throws', async () => {
    await expect(
      checkNfc(true, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow(/isSupported threw: boom/);
  });

  it('the step list is the one the screen expects', () => {
    expect(STEP_IDS.length).toBe(11);
    expect(STEP_IDS[0]).toBe('engine');
    expect(STEP_IDS[STEP_IDS.length - 1]).toBe('settle');
  });
});
