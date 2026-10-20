import { describe, expect, it } from 'vitest';

import {
  AUDIT_SEAL_MESSAGES,
  auditSealListQuerySchema,
  auditSealSchema,
  sealPeriodsIn,
  verifyAuditSealsSchema,
} from './seal.js';

describe('selos de auditoria (US-074)', () => {
  it('conta as horas cheias tocadas pelo intervalo (teto de selos — FA-04)', () => {
    expect(sealPeriodsIn('2026-10-05T14:00:00Z', '2026-10-05T14:59:59.999Z')).toBe(1);
    expect(sealPeriodsIn('2026-10-05T14:30:00Z', '2026-10-05T15:00:00Z')).toBe(2);
    expect(sealPeriodsIn('2026-10-01T00:00:00Z', '2026-10-30T23:59:59Z')).toBe(720);
    expect(sealPeriodsIn('2026-10-05T15:00:00Z', '2026-10-05T14:00:00Z')).toBe(0);
  });

  it('V-02: período final anterior ao inicial é recusado com a mensagem da story', () => {
    const parsed = verifyAuditSealsSchema.safeParse({
      periodStart: '2026-10-05T15:00:00Z',
      periodEnd: '2026-10-05T14:00:00Z',
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(AUDIT_SEAL_MESSAGES.periodRange);
    expect(parsed.error?.issues[0]?.path).toEqual(['periodEnd']);
  });

  it('AUD-05 exige as duas datas e recusa campos extras', () => {
    expect(verifyAuditSealsSchema.safeParse({ periodStart: '2026-10-05T15:00:00Z' }).success).toBe(
      false,
    );
    expect(
      verifyAuditSealsSchema.safeParse({
        periodStart: '2026-10-05T14:00:00Z',
        periodEnd: '2026-10-05T15:00:00Z',
        sealId: 'x',
      }).success,
    ).toBe(false);
  });

  it('AUD-04 aceita período opcional e pagina com os padrões', () => {
    expect(auditSealListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(
      auditSealListQuerySchema.safeParse({
        periodFrom: '2026-10-05T15:00:00Z',
        periodTo: '2026-10-05T14:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('o selo devolvido tem hashes hex de 64 caracteres e ao menos um registro (RN-AUD-12)', () => {
    const seal = {
      id: '0192d074-0000-7000-8000-000000000001',
      periodStart: '2026-10-05T14:00:00.000Z',
      periodEnd: '2026-10-05T14:59:59.999Z',
      recordCount: 1,
      digest: 'a'.repeat(64),
      chainHash: 'b'.repeat(64),
      sealedAt: '2026-10-05T15:05:00.000Z',
    };
    expect(auditSealSchema.safeParse(seal).success).toBe(true);
    expect(auditSealSchema.safeParse({ ...seal, recordCount: 0 }).success).toBe(false);
    expect(auditSealSchema.safeParse({ ...seal, digest: 'XYZ' }).success).toBe(false);
  });

  it('a mensagem de intervalo longo traz o máximo configurado', () => {
    expect(AUDIT_SEAL_MESSAGES.tooManyPeriods(720)).toBe(
      'Reduza o intervalo para verificar a integridade (máximo de 720 selos).',
    );
  });
});
