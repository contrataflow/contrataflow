import { describe, expect, it } from 'vitest';

import { uuidV7Schema } from './identifiers.js';

describe('uuidV7Schema', () => {
  it('aceita UUIDv7', () => {
    expect(uuidV7Schema.safeParse('01928c3e-7b5a-7cde-8f12-3456789abcde').success).toBe(true);
  });

  it('rejeita outras versões e textos livres com mensagem em pt-BR', () => {
    expect(uuidV7Schema.safeParse('550e8400-e29b-41d4-a716-446655440000').success).toBe(false);
    const result = uuidV7Schema.safeParse('processo-1');
    expect(result.error?.issues[0]?.message).toBe('Informe um identificador UUIDv7 válido.');
  });
});
