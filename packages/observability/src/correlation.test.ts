import { describe, expect, it } from 'vitest';

import { isUuidV7, isValidCorrelationId, resolveCorrelationId, uuidv7 } from './correlation.js';

describe('correlationId (RN-FND-74 · V-01)', () => {
  it.each([
    'abcdefgh',
    'c-001-retry',
    '0193a1b2-7c00-7abc-8def-0123456789ab',
    'a.b:c_d-e',
    'x'.repeat(64),
  ])('aceita %s', (value) => {
    expect(isValidCorrelationId(value)).toBe(true);
    expect(resolveCorrelationId(value)).toBe(value);
  });

  it.each([
    ['com espaços', 'a b c'],
    ['curto demais', 'c-001'],
    ['longo demais', 'x'.repeat(65)],
    ['quebra de linha (log injection)', 'abcdefgh\nlevel=fatal'],
    ['caracteres de cabeçalho', 'abcdefgh;x=1'],
    ['vazio', ''],
  ])('descarta valor %s e gera UUIDv7', (_label, value) => {
    expect(isValidCorrelationId(value)).toBe(false);
    const resolved = resolveCorrelationId(value);
    expect(resolved).not.toBe(value);
    expect(isUuidV7(resolved)).toBe(true);
  });

  it('gera UUIDv7 quando o cabeçalho está ausente', () => {
    expect(isUuidV7(resolveCorrelationId(undefined))).toBe(true);
    expect(isUuidV7(resolveCorrelationId(null))).toBe(true);
  });

  it('codifica o instante nos 48 bits iniciais e varia o restante', () => {
    const now = Date.UTC(2026, 9, 14, 12, 0, 0);
    const first = uuidv7(now);
    const second = uuidv7(now);
    expect(first.replace(/-/g, '').slice(0, 12)).toBe(now.toString(16).padStart(12, '0'));
    expect(first).not.toBe(second);
    expect(isUuidV7(first)).toBe(true);
  });

  it('não confunde outras versões de UUID com v7', () => {
    expect(isUuidV7(crypto.randomUUID())).toBe(false);
  });
});
