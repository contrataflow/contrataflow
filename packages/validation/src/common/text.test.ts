import { describe, expect, it } from 'vitest';

import { trimmedString } from './text.js';

describe('trimmedString', () => {
  it('remove espaços das extremidades', () => {
    expect(trimmedString({ max: 10 }).parse('  DFD  ')).toBe('DFD');
  });

  it('trata texto vazio como campo obrigatório', () => {
    const result = trimmedString({ max: 10 }).safeParse('   ');
    expect(result.error?.issues[0]?.message).toBe('Campo obrigatório.');
  });

  it('aplica mínimo e máximo personalizados', () => {
    const schema = trimmedString({ min: 3, max: 5 });
    expect(schema.safeParse('ab').error?.issues[0]?.message).toBe('Informe ao menos 3 caracteres.');
    expect(schema.safeParse('abcdef').error?.issues[0]?.message).toBe(
      'Informe no máximo 5 caracteres.',
    );
    expect(schema.safeParse('abcd').success).toBe(true);
  });
});
