import { AI_AVAILABILITY_REASONS, AI_GENERATION_STATUSES } from '@contrataflow/types';
import { z } from 'zod';

import { aiGenerationKindSchema, aiSectionActionSchema, aiTargetModuleSchema } from './ai.js';
import { dataEnvelope } from '../http/envelope.js';

/*
 * Disponibilidade e consumo da IA no órgão (US-116 · api/16-ai.md AI-05/AI-06 · RN-AI-23).
 * AI-05 é indicativo (sem trava) — AI-01 decide; tokens absolutos só para `SETTINGS_MANAGE`.
 */

export const AI_USAGE_MESSAGES = {
  month: 'Escolha um mês válido.',
} as const;

/** AI-05: sem parâmetros, responde só sobre o órgão e o usuário. */
export const aiAvailabilityQuerySchema = z.strictObject({
  processId: z.uuid().optional(),
  documentId: z.uuid().optional(),
});
export type AiAvailabilityQuery = z.infer<typeof aiAvailabilityQuerySchema>;

export const aiAvailabilityReasonSchema = z.enum(AI_AVAILABILITY_REASONS);

export const aiAvailabilitySchema = z.object({
  enabled: z.boolean(),
  providerAvailable: z.boolean(),
  canGenerate: z.boolean(),
  reasons: z.array(aiAvailabilityReasonSchema),
  monthly: z.object({
    percentUsed: z.number().min(0),
    usedTokens: z.number().int().min(0).optional(),
    limitTokens: z.number().int().min(0).optional(),
  }),
  userDaily: z.object({ used: z.number().int().min(0), limit: z.number().int().min(0) }),
});
export type AiAvailabilityDto = z.infer<typeof aiAvailabilitySchema>;
export const aiAvailabilityResponseSchema = dataEnvelope(aiAvailabilitySchema);

/** `YYYY-MM` (V-04); "não futuro" depende do fuso do tenant — conferido pela API. */
export const AI_USAGE_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const aiUsageQuerySchema = z.strictObject({
  month: z.string().regex(AI_USAGE_MONTH_PATTERN, { error: AI_USAGE_MESSAGES.month }).optional(),
});
export type AiUsageQuery = z.infer<typeof aiUsageQuerySchema>;

/** Decimal em string (DEC-003); `null` quando algum modelo do recorte não tem preço. */
const costSchema = z.string().nullable();

export const aiUsageSchema = z.object({
  month: z.string(),
  limitTokens: z.number().int().min(0),
  usedTokens: z.number().int().min(0),
  reservedTokens: z.number().int().min(0),
  costUsd: costSchema,
  generations: z.object({
    total: z.number().int().min(0),
    byStatus: z.record(z.enum(AI_GENERATION_STATUSES), z.number().int().min(0)),
  }),
  byDocumentType: z.array(
    z.object({
      targetModule: aiTargetModuleSchema,
      generations: z.number().int().min(0),
      totalTokens: z.number().int().min(0),
      costUsd: costSchema,
    }),
  ),
  byKind: z.array(
    z.object({
      kind: aiGenerationKindSchema,
      action: aiSectionActionSchema.nullable(),
      generations: z.number().int().min(0),
      totalTokens: z.number().int().min(0),
    }),
  ),
  byUser: z.array(
    z.object({
      userId: z.uuid(),
      name: z.string(),
      generations: z.number().int().min(0),
      totalTokens: z.number().int().min(0),
    }),
  ),
});
export type AiUsageDto = z.infer<typeof aiUsageSchema>;
export const aiUsageResponseSchema = dataEnvelope(aiUsageSchema);
