import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  CanonicalJsonError,
  columnText,
  sha256Hex,
  toJsonValue,
} from './canonical-json.js';

describe('JSON canônico (RFC 8785 / JCS — DEC-084)', () => {
  it('reproduz o exemplo do RFC 8785 §3.2.2 (números, strings e literais)', () => {
    // A string do exemplo, caractere a caractere: € $ U+000F LF A ' B " \ \ " /
    const string = String.fromCharCode(
      0x20ac,
      0x24,
      0x0f,
      0x0a,
      0x41,
      0x27,
      0x42,
      0x22,
      0x5c,
      0x5c,
      0x22,
      0x2f,
    );
    const input = {
      // Literal do RFC: mais dígitos do que um double guarda (é o que o exemplo testa).
      numbers: [Number('333333333.33333329'), 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string,
      literals: [null, true, false],
    };
    // Saída do RFC: {"literals":…,"string":"€$\u000f\nA'B\"\\\\\"/"}
    const bs = String.fromCharCode(0x5c);
    const euro = String.fromCharCode(0x20ac);
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        `"string":"${euro}$${bs}u000f${bs}nA'B${bs}"${bs}${bs}${bs}${bs}${bs}"/"}`,
    );
  });

  it('ordena as chaves por unidades de código UTF-16 (RFC 8785 §3.2.3)', () => {
    const keys = [0x20ac, 0x0d, 0xfb33, 0x31, 0x1f600, 0x80, 0xf6].map((code) =>
      String.fromCodePoint(code),
    );
    const output = canonicalJson(Object.fromEntries(keys.map((key) => [key, 1])));
    const expected = [0x0d, 0x31, 0x80, 0xf6, 0x20ac, 0x1f600, 0xfb33].map((code) =>
      String.fromCodePoint(code),
    );
    expect(output).toBe(`{${expected.map((key) => `${JSON.stringify(key)}:1`).join(',')}}`);
  });

  it('é determinístico e independe da ordem de inserção; -0 vira 0', () => {
    expect(canonicalJson({ b: 1, a: [{ d: -0, c: 'x' }] })).toBe('{"a":[{"c":"x","d":0}],"b":1}');
    expect(canonicalJson({ a: [{ c: 'x', d: 0 }], b: 1 })).toBe(
      canonicalJson({ b: 1, a: [{ d: 0, c: 'x' }] }),
    );
  });

  it('recusa o que não é I-JSON', () => {
    for (const value of [Number.NaN, Infinity, '\ud800', undefined, new Date(0), 1n, () => 1]) {
      expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
    }
  });

  it('toJsonValue converte valores da aplicação e limpa o que o jsonb recusa', () => {
    expect(
      toJsonValue({
        at: new Date('2026-10-14T12:00:00Z'),
        big: 10n,
        skip: undefined,
        nan: Number.NaN,
        text: 'a\u0000b\ud800',
        list: [undefined, 1],
      }),
    ).toEqual({
      at: '2026-10-14T12:00:00.000Z',
      big: '10',
      nan: null,
      text: 'a�b�',
      list: [null, 1],
    });
    expect(toJsonValue(undefined)).toBeNull();
  });

  it('columnText corta por caracteres, sem partir emoji, e trata vazio como nulo', () => {
    expect(columnText('  ', 10)).toBeNull();
    expect(columnText(undefined, 10)).toBeNull();
    expect(columnText('😀😀😀', 2)).toBe('😀😀');
    expect(columnText('abc\u0000', 10)).toBe('abc�');
  });

  it('sha256Hex', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
