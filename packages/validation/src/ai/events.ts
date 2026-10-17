import { AI_GENERATION_ERROR_CODES, AI_USAGE_THRESHOLDS } from '@contrataflow/types';
import { z } from 'zod';

import { aiGenerationKindSchema, aiSectionActionSchema, aiTargetModuleSchema } from './ai.js';
import { defineDomainEvent } from '../events/define.js';

/*
 * Eventos do agregado `AiGeneration` (events.md §4 · US-115). Payload só com ids, códigos e
 * contagens — nunca resumo, instrução, contexto, saída ou valores (events.md §1 · DEC-138). O ator
 * do envelope é o solicitante (o job carrega o ator — DEC-164). Descartes e cancelamentos não
 * geram evento (só auditoria).
 */

const uuid = z.uuid();

const target = {
  generationId: uuid,
  processId: uuid,
  documentId: uuid.nullable(),
  targetModule: aiTargetModuleSchema,
  kind: aiGenerationKindSchema,
  action: aiSectionActionSchema.nullable(),
  sectionKey: z.string().min(1).max(60).nullable(),
};

/** Commit de AI-01 (`QUEUED`). Consumidor: métricas. */
export const AiGenerationRequested = defineDomainEvent({
  eventType: 'AiGenerationRequested',
  eventVersion: 1,
  aggregateType: 'AiGeneration',
  payload: z.strictObject(target),
  routingKey: 'ai.generation_requested',
});

/**
 * Commit do `SUCCEEDED` no job `ai-generation`. Projeta `AI_CONTENT_GENERATED` (timeline, no mesmo
 * `tx`) e dispara `AI_GENERATION_READY` ao solicitante.
 */
export const AiGenerationCompleted = defineDomainEvent({
  eventType: 'AiGenerationCompleted',
  eventVersion: 1,
  aggregateType: 'AiGeneration',
  payload: z.strictObject({
    ...target,
    requestedById: uuid,
    model: z.string().min(1).max(100),
    promptKey: z.string().min(1).max(60),
    promptVersion: z.string().min(1).max(20),
    totalTokens: z.int().min(0),
    sectionsCount: z.int().min(0),
    risksCount: z.int().min(0),
    placeholdersCount: z.int().min(0),
  }),
  routingKey: 'ai.generation_completed',
});

/** Commit do `FAILED`. Dispara `AI_GENERATION_FAILED` ao solicitante. */
export const AiGenerationFailed = defineDomainEvent({
  eventType: 'AiGenerationFailed',
  eventVersion: 1,
  aggregateType: 'AiGeneration',
  payload: z.strictObject({
    generationId: uuid,
    processId: uuid,
    documentId: uuid.nullable(),
    targetModule: aiTargetModuleSchema,
    kind: aiGenerationKindSchema,
    requestedById: uuid,
    errorCode: z.enum(AI_GENERATION_ERROR_CODES),
    attempts: z.int().min(0),
  }),
  routingKey: 'ai.generation_failed',
});

/**
 * O consumo real do mês cruzou 80% ou 100% do limite do órgão (US-116 · RN-AI-20): gravado na
 * transação do término da geração, uma vez por `(tenant, mês, faixa)` — `eventId` determinístico
 * (UUID v5) sob a trava do tenant. Agregado = o tenant; fora de processo. Dispara
 * `AI_USAGE_LIMIT_WARNING` a quem tem `SETTINGS_MANAGE`. Sem dados pessoais.
 */
export const AiUsageThresholdReached = defineDomainEvent({
  eventType: 'AiUsageThresholdReached',
  eventVersion: 1,
  aggregateType: 'Tenant',
  payload: z.strictObject({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    threshold: z.union(AI_USAGE_THRESHOLDS.map((value) => z.literal(value))),
    usedTokens: z.int().min(0),
    limitTokens: z.int().min(1),
  }),
  routingKey: 'ai.usage_threshold_reached',
});
