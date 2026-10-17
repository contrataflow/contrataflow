import { describe, expect, it } from 'vitest';

import {
  AUDIT_LOG_MESSAGES,
  auditLogExportQuerySchema,
  auditLogSchema,
  auditLogSearchQuerySchema,
  isAuditPeriodWithinLimit,
} from './log.js';

const PERIOD = { occurredFrom: '2026-09-01T00:00:00Z', occurredTo: '2026-09-07T23:59:59Z' };

describe('consulta da trilha de auditoria (US-075)', () => {
  it('RN-AUD-17: aceita até 90 dias exatos e recusa além disso', () => {
    expect(isAuditPeriodWithinLimit('2026-07-01T00:00:00Z', '2026-09-29T00:00:00Z')).toBe(true);
    expect(isAuditPeriodWithinLimit('2026-07-01T00:00:00Z', '2026-09-29T00:00:01Z')).toBe(false);
  });

  it('V-01: período de 120 dias → OUT_OF_RANGE com a mensagem da story', () => {
    const parsed = auditLogSearchQuerySchema.safeParse({
      occurredFrom: '2026-05-01T00:00:00Z',
      occurredTo: '2026-08-29T00:00:00Z',
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({
      path: ['occurredTo'],
      message: AUDIT_LOG_MESSAGES.period,
      params: { code: 'OUT_OF_RANGE' },
    });
  });

  it('V-01: período ausente → mensagem pedindo o período', () => {
    const parsed = auditLogSearchQuerySchema.safeParse({});
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      AUDIT_LOG_MESSAGES.period,
      AUDIT_LOG_MESSAGES.period,
    ]);
  });

  it('V-02: data final anterior à inicial', () => {
    const parsed = auditLogSearchQuerySchema.safeParse({
      occurredFrom: PERIOD.occurredTo,
      occurredTo: PERIOD.occurredFrom,
    });
    expect(parsed.error?.issues[0]?.message).toBe(AUDIT_LOG_MESSAGES.periodRange);
  });

  it('V-03: limit acima de 100 é ajustado para 100; padrão 50', () => {
    expect(auditLogSearchQuerySchema.parse({ ...PERIOD, limit: '500' }).limit).toBe(100);
    expect(auditLogSearchQuerySchema.parse(PERIOD).limit).toBe(50);
    expect(auditLogSearchQuerySchema.safeParse({ ...PERIOD, limit: '0' }).success).toBe(false);
  });

  it('filtros: OU por vírgula ou repetição, sem duplicados; valor fora do catálogo recusado', () => {
    const parsed = auditLogSearchQuerySchema.parse({
      ...PERIOD,
      action: ['process.create,process.update', 'process.create'],
      category: 'DATA_CHANGE',
      result: 'SUCCESS,DENIED',
      entityType: 'Process',
    });
    expect(parsed.action).toEqual(['process.create', 'process.update']);
    expect(parsed.category).toEqual(['DATA_CHANGE']);
    expect(parsed.result).toEqual(['SUCCESS', 'DENIED']);
    expect(parsed.actorUserId).toBeUndefined();
    const invalid = auditLogSearchQuerySchema.safeParse({ ...PERIOD, action: 'process.explode' });
    expect(invalid.error?.issues[0]).toMatchObject({ params: { code: 'INVALID_ENUM' } });
    expect(auditLogSearchQuerySchema.safeParse({ ...PERIOD, actorUserId: 'x' }).success).toBe(
      false,
    );
  });

  it('AUD-03: formato padrão csv; fora de csv/ndjson → INVALID_ENUM com a mensagem; sem cursor', () => {
    expect(auditLogExportQuerySchema.parse(PERIOD).format).toBe('csv');
    expect(auditLogExportQuerySchema.parse({ ...PERIOD, format: 'ndjson' }).format).toBe('ndjson');
    const invalid = auditLogExportQuerySchema.safeParse({ ...PERIOD, format: 'xlsx' });
    expect(invalid.error?.issues[0]?.message).toBe(AUDIT_LOG_MESSAGES.invalidFormat);
    expect(auditLogExportQuerySchema.safeParse({ ...PERIOD, cursor: 'abc' }).success).toBe(false);
  });

  it('a mensagem de exportação grande traz a contagem formatada em pt-BR', () => {
    expect(AUDIT_LOG_MESSAGES.exportTooLarge(150_000)).toBe(
      'Muitos registros para exportar (150.000). Refine o período ou os filtros.',
    );
  });

  it('o AuditLog devolvido aceita changes mascarado (hash + tamanho) e nulos', () => {
    const log = {
      id: '0192d075-0000-7000-8000-000000000001',
      occurredAt: '2026-09-02T10:00:00.000Z',
      actorType: 'USER',
      actorUserId: '0192d075-0000-7000-8000-0000000000a1',
      actorName: 'Ana',
      actorMembershipId: null,
      onBehalfOfUserId: null,
      action: 'process.create',
      category: 'DATA_CHANGE',
      result: 'SUCCESS',
      entityType: 'Process',
      entityId: null,
      processId: null,
      changes: [{ path: 'content', old: null, new: { hash: 'ab', length: 900 } }],
      metadata: {},
      reasonCode: null,
      ip: null,
      userAgent: null,
      correlationId: null,
      requestId: null,
      sessionIdHash: null,
      rowHash: 'f'.repeat(64),
    };
    expect(auditLogSchema.safeParse(log).success).toBe(true);
    expect(auditLogSchema.safeParse({ ...log, category: 'OTHER' }).success).toBe(false);
  });
});
