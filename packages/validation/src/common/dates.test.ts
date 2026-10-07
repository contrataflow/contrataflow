import { describe, expect, it } from 'vitest';

import { isoDateSchema, isoDateTimeSchema } from './dates.js';

describe('datas (DEC-003)', () => {
  it('aceita data e hora em UTC', () => {
    expect(isoDateTimeSchema.safeParse('2026-10-05T14:30:00Z').success).toBe(true);
  });

  it('rejeita data e hora sem fuso UTC', () => {
    expect(isoDateTimeSchema.safeParse('2026-10-05T14:30:00-03:00').success).toBe(false);
    expect(isoDateTimeSchema.safeParse('05/10/2026').success).toBe(false);
  });

  it('aceita somente datas AAAA-MM-DD válidas', () => {
    expect(isoDateSchema.safeParse('2026-10-05').success).toBe(true);
    expect(isoDateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-10-05T00:00:00Z').error?.issues[0]?.message).toBe(
      'Informe a data no formato AAAA-MM-DD.',
    );
  });
});
