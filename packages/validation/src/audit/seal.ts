import { z } from 'zod';

import { isoDateTimeSchema } from '../common/dates.js';
import { pageMetaSchema, pageQuerySchema } from '../http/pagination.js';

/*
 * Selagem de integridade da trilha de auditoria (US-074 · AUD-04/AUD-05 · SCR-037 aba "Selos"):
 * cada `AuditSeal` cobre uma hora cheia (UTC) do tenant; a verificação recalcula `digest` e
 * `chainHash` de cada selo do intervalo. O mesmo schema valida a API (422) e o painel do front.
 */

/** Mensagens da tabela "Validações" e "Casos de erro" da US-074, compartilhadas com a tela. */
export const AUDIT_SEAL_MESSAGES = Object.freeze({
  periodRange: 'O período final deve ser posterior ao inicial.',
  tooManyPeriods: (max: number) =>
    `Reduza o intervalo para verificar a integridade (máximo de ${String(max)} selos).`,
  notFound: 'Selo não encontrado.',
  unavailable: 'Não foi possível verificar a integridade agora. Tente novamente em instantes.',
});

/** Padrão de `audit.sealVerification.maxPeriods` (plataforma — ≈ 30 dias de selos horários). */
export const AUDIT_SEAL_VERIFICATION_MAX_PERIODS = 720;

const HOUR_MS = 3_600_000;

/**
 * Quantos períodos horários o intervalo `[periodStart, periodEnd]` alcança (horas cheias UTC
 * tocadas): é o teto de selos que a verificação pode recalcular — o limite de FA-04 conta por ele.
 */
export function sealPeriodsIn(periodStart: string | Date, periodEnd: string | Date): number {
  const start = Math.floor(new Date(periodStart).getTime() / HOUR_MS);
  const end = Math.floor(new Date(periodEnd).getTime() / HOUR_MS);
  return Math.max(0, end - start + 1);
}

function checkRange(
  range: { periodStart?: string | undefined; periodEnd?: string | undefined },
  context: z.RefinementCtx,
  path: 'periodEnd' | 'periodTo',
): void {
  const start = range.periodStart;
  const end = range.periodEnd;
  if (start === undefined || end === undefined) return;
  if (Date.parse(end) < Date.parse(start)) {
    context.addIssue({
      code: 'custom',
      path: [path],
      message: AUDIT_SEAL_MESSAGES.periodRange,
      params: { code: 'OUT_OF_RANGE' },
    });
  }
}

/** AUD-04 (query): paginação por página + período opcional (`periodStart` dentro do intervalo). */
export const auditSealListQuerySchema = pageQuerySchema
  .extend({
    periodFrom: isoDateTimeSchema.optional(),
    periodTo: isoDateTimeSchema.optional(),
  })
  .superRefine((query, context) => {
    checkRange({ periodStart: query.periodFrom, periodEnd: query.periodTo }, context, 'periodTo');
  })
  .meta({ id: 'AuditSealListQuery' });
export type AuditSealListQuery = z.output<typeof auditSealListQuerySchema>;

/** `AuditSeal` de AUD-04 (entities.md §4 `audit_seals`). */
export const auditSealSchema = z
  .object({
    id: z.uuid(),
    periodStart: isoDateTimeSchema,
    periodEnd: isoDateTimeSchema,
    recordCount: z.int().min(1),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    chainHash: z.string().regex(/^[0-9a-f]{64}$/),
    sealedAt: isoDateTimeSchema,
  })
  .meta({ id: 'AuditSeal' });
export type AuditSealDto = z.infer<typeof auditSealSchema>;

export const auditSealListResponseSchema = z.object({
  data: z.array(auditSealSchema),
  meta: pageMetaSchema,
});
export type AuditSealListResponse = z.infer<typeof auditSealListResponseSchema>;

/**
 * AUD-05 (corpo): intervalo a verificar. O teto de períodos (`maxPeriods`) é da plataforma e
 * conferido na API (V-01); aqui só a ordem das datas (V-02).
 */
export const verifyAuditSealsSchema = z
  .strictObject({
    periodStart: isoDateTimeSchema,
    periodEnd: isoDateTimeSchema,
  })
  .superRefine((body, context) => {
    checkRange(body, context, 'periodEnd');
  })
  .meta({ id: 'VerifyAuditSeals' });
export type VerifyAuditSeals = z.output<typeof verifyAuditSealsSchema>;

export const AUDIT_SEAL_STATUSES = ['VALID', 'INVALID'] as const;
export type AuditSealStatus = (typeof AUDIT_SEAL_STATUSES)[number];

/** Onde a cadeia quebrou (RN-AUD-15): linha alterada/removida/inserida ou selo anterior. */
export const AUDIT_SEAL_BREAKS = ['digest', 'chain'] as const;
export type AuditSealBreak = (typeof AUDIT_SEAL_BREAKS)[number];

export const auditSealVerificationItemSchema = z
  .object({
    periodStart: isoDateTimeSchema,
    periodEnd: isoDateTimeSchema,
    recordCount: z.int().min(0),
    status: z.enum(AUDIT_SEAL_STATUSES),
    brokenAt: z.enum(AUDIT_SEAL_BREAKS).optional(),
  })
  .meta({ id: 'AuditSealVerificationItem' });
export type AuditSealVerificationItem = z.infer<typeof auditSealVerificationItemSchema>;

export const auditSealVerificationSchema = z
  .object({
    /** Primeira quebra da cadeia no intervalo (RN-AUD-16); `null` = tudo íntegro. */
    brokenAtPeriodStart: isoDateTimeSchema.nullable(),
    results: z.array(auditSealVerificationItemSchema),
  })
  .meta({ id: 'AuditSealVerification' });
export type AuditSealVerification = z.infer<typeof auditSealVerificationSchema>;

export const auditSealVerificationResponseSchema = z.object({
  data: auditSealVerificationSchema,
});
export type AuditSealVerificationResponse = z.infer<typeof auditSealVerificationResponseSchema>;
