import {
  AI_GENERATION_ERROR_CODES,
  AI_GENERATION_KINDS,
  AI_GENERATION_STATUSES,
  AI_SECTION_ACTIONS,
  AI_TARGET_MODULES,
} from '@contrataflow/types';
import { z } from 'zod';

import { uuidV7Schema } from '../common/identifiers.js';
import { cursorQuerySchema } from '../http/pagination.js';
import { RISK_LIMITS, RISK_PHASES } from '../risk/risk.js';
import { TREATMENT_LIMITS, TREATMENT_TYPES } from '../risk/treatment.js';

/*
 * Geração com IA (US-115 · DEC-079 · entities.md §4.11/§5.10 · api/16-ai.md AI-01..04): o pedido,
 * a representação `AiGeneration` e as estruturas JSON `AiInputRef`/`AiGenerationOutput`. O texto do
 * pedido (`needSummary`, `instruction`) nunca volta nas respostas nem vai para logs e eventos.
 */

export const aiTargetModuleSchema = z.enum(AI_TARGET_MODULES);
export const aiGenerationKindSchema = z.enum(AI_GENERATION_KINDS);
export const aiSectionActionSchema = z.enum(AI_SECTION_ACTIONS);
export const aiGenerationStatusSchema = z.enum(AI_GENERATION_STATUSES);
export const aiGenerationErrorCodeSchema = z.enum(AI_GENERATION_ERROR_CODES);

/** V-03: resumo da necessidade (quando informado) e V-04: orientações. */
export const AI_NEED_SUMMARY_MIN = 20;
export const AI_NEED_SUMMARY_MAX = 2_000;
export const AI_INSTRUCTION_MAX = 500;

export const AI_MESSAGES = {
  needSummary: 'Descreva a necessidade com 20 a 2.000 caracteres.',
  instruction: 'As orientações aceitam até 500 caracteres.',
  sectionRequired: 'Revise os dados do pedido.',
  draftNotAllowed: 'Revise os dados do pedido.',
} as const;

/** Chave de seção do template (`SectionDefinition.key` — SCREAMING_SNAKE). */
const sectionKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Z][A-Z0-9_]*$/, { error: 'Seção inválida.' });

/**
 * AI-01 (V-01..V-04): `SECTION` exige `action`, `sectionKey` e `documentId`; `DRAFT` não aceita
 * `action` nem `sectionKey`. Resumo vazio conta como ausente (o gerador decide se é obrigatório).
 */
export const requestAiGenerationSchema = z
  .strictObject({
    targetModule: aiTargetModuleSchema,
    documentId: z.uuid().optional(),
    kind: aiGenerationKindSchema,
    action: aiSectionActionSchema.optional(),
    sectionKey: sectionKeySchema.optional(),
    needSummary: z
      .string()
      .trim()
      .max(AI_NEED_SUMMARY_MAX, { error: AI_MESSAGES.needSummary })
      .refine((value) => value === '' || value.length >= AI_NEED_SUMMARY_MIN, {
        error: AI_MESSAGES.needSummary,
        params: { code: 'TOO_SHORT' },
      })
      .transform((value) => (value === '' ? undefined : value))
      .optional(),
    instruction: z
      .string()
      .trim()
      .max(AI_INSTRUCTION_MAX, { error: AI_MESSAGES.instruction })
      .transform((value) => (value === '' ? undefined : value))
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'SECTION') {
      for (const field of ['action', 'sectionKey', 'documentId'] as const) {
        if (value[field] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: AI_MESSAGES.sectionRequired,
            params: { code: 'CONDITIONAL_REQUIRED' },
          });
        }
      }
      return;
    }
    for (const field of ['action', 'sectionKey'] as const) {
      if (value[field] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: AI_MESSAGES.draftNotAllowed,
          params: { code: 'NOT_ALLOWED' },
        });
      }
    }
  })
  .meta({ id: 'RequestAiGeneration' });
export type RequestAiGeneration = z.output<typeof requestAiGenerationSchema>;

export const aiGenerationIdParamsSchema = z.strictObject({ generationId: uuidV7Schema });
export const aiProcessIdParamsSchema = z.strictObject({ id: uuidV7Schema });

/** AI-03: filtros + cursor (ordem `createdAt desc`); `status` aceita lista separada por vírgula. */
export const aiGenerationListQuerySchema = cursorQuerySchema.extend({
  limit: cursorQuerySchema.shape.limit.default(20),
  documentId: z.uuid().optional(),
  targetModule: aiTargetModuleSchema.optional(),
  kind: aiGenerationKindSchema.optional(),
  status: z
    .string()
    .transform((value) => value.split(',').map((item) => item.trim()))
    .pipe(z.array(aiGenerationStatusSchema).min(1).max(AI_GENERATION_STATUSES.length))
    .optional(),
  requestedById: z.uuid().optional(),
});
export type AiGenerationListQuery = z.output<typeof aiGenerationListQuerySchema>;

// --- Estruturas JSON (entities.md §5.10) ---------------------------------------------------------

export const AI_INPUT_REF_KINDS = [
  'USER_SUMMARY',
  'USER_INSTRUCTION',
  'PROCESS',
  'PROCESS_ITEMS',
  'ORGANIZATION',
  'TEMPLATE_VERSION',
  'DOCUMENT_VERSION',
  'DOCUMENT_DRAFT',
  'SECTION',
  'ETP_ALTERNATIVES',
  'PRICE_RESEARCH',
  'RISKS',
  'TERM_CONDITIONS',
  'CATALOG',
] as const;
export type AiInputRefKind = (typeof AI_INPUT_REF_KINDS)[number];

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** Entrada usada na geração — só ids, versões e hashes, nunca conteúdo. */
export const aiInputRefSchema = z
  .strictObject({
    kind: z.enum(AI_INPUT_REF_KINDS),
    id: z.string().max(100).nullable(),
    documentTypeCode: z.string().max(40).optional(),
    versionNumber: z.int().min(1).optional(),
    revision: z.int().min(0).optional(),
    contentHash: sha256Hex,
  })
  .meta({ id: 'AiInputRef' });
export type AiInputRef = z.infer<typeof aiInputRefSchema>;

export const AI_OUTPUT_WARNING_CODES = [
  'USED_DRAFT_INPUTS',
  'MISSING_PRICE_RESEARCH',
  'BUDGET_CONFIDENTIAL_VALUES_OMITTED',
  'MISSING_OPTIONAL_INPUT',
  'CONTEXT_TRUNCATED',
] as const;
export type AiOutputWarningCode = (typeof AI_OUTPUT_WARNING_CODES)[number];

export const aiOutputWarningSchema = z.strictObject({
  code: z.enum(AI_OUTPUT_WARNING_CODES),
  params: z.record(z.string(), z.string()).optional(),
});
export type AiOutputWarning = z.infer<typeof aiOutputWarningSchema>;

/** Documento TipTap da proposta (nós permitidos conferidos pelo `OutputConverter` da API). */
const tipTapDocSchema = z.looseObject({ type: z.literal('doc'), content: z.array(z.unknown()) });

export const aiOutputSectionSchema = z.strictObject({
  sectionKey: z.string().min(1).max(60),
  title: z.string().max(250),
  content: tipTapDocSchema,
  placeholdersCount: z.int().min(0),
  groundingReplacements: z.int().min(0),
});
export type AiOutputSection = z.infer<typeof aiOutputSectionSchema>;

/**
 * Limites da proposta do mapa de riscos (US-119 · RN-AI-39): até 15 riscos, de 1 a 3 tratamentos
 * cada; os textos respeitam os limites de `Risk`/`RiskTreatment` (o RSK-11 grava como veio).
 */
export const AI_RISK_PROPOSAL_LIMITS = Object.freeze({
  maxRisks: 15,
  minTreatments: 1,
  maxTreatments: 3,
  rationaleMax: 500,
  proposalKeyMax: 20,
});

const proposalKeySchema = z.string().min(1).max(AI_RISK_PROPOSAL_LIMITS.proposalKeyMax);

/** Tratamento proposto (`PREVENTIVE`/`CONTINGENCY` + descrição): nunca responsável, prazo nem valor. */
export const aiProposedTreatmentSchema = z
  .strictObject({
    proposalKey: proposalKeySchema,
    type: z.enum(TREATMENT_TYPES),
    description: z
      .string()
      .min(TREATMENT_LIMITS.descriptionMin)
      .max(TREATMENT_LIMITS.descriptionMax),
  })
  .meta({ id: 'AiProposedTreatment' });
export type AiProposedTreatment = z.infer<typeof aiProposedTreatmentSchema>;

/**
 * Risco proposto (entities.md §5.10 `AiGenerationOutput.risks`): `categoryCode` ativo do
 * `RISK_CATEGORY` (desconhecido → `OUTRO`), graus na escala vigente, `similarToRiskId` quando
 * parecido com risco já registrado. Só existe na proposta até o RSK-11 (`rationale` e
 * `similarToRiskId` não viram coluna — lacuna 3 da US-119).
 */
export const aiProposedRiskSchema = z
  .strictObject({
    proposalKey: proposalKeySchema,
    title: z.string().min(RISK_LIMITS.titleMin).max(RISK_LIMITS.titleMax),
    description: z.string().max(RISK_LIMITS.descriptionMax),
    categoryCode: z.string().min(1).max(60),
    phase: z.enum(RISK_PHASES),
    cause: z.string().min(RISK_LIMITS.causeMin).max(RISK_LIMITS.causeMax),
    consequence: z.string().min(RISK_LIMITS.consequenceMin).max(RISK_LIMITS.consequenceMax),
    probability: z.int().min(1).max(RISK_LIMITS.scaleMax),
    impact: z.int().min(1).max(RISK_LIMITS.scaleMax),
    rationale: z.string().max(AI_RISK_PROPOSAL_LIMITS.rationaleMax),
    similarToRiskId: z.uuid().optional(),
    treatments: z
      .array(aiProposedTreatmentSchema)
      .min(AI_RISK_PROPOSAL_LIMITS.minTreatments)
      .max(AI_RISK_PROPOSAL_LIMITS.maxTreatments),
  })
  .meta({ id: 'AiProposedRisk' });
export type AiProposedRisk = z.infer<typeof aiProposedRiskSchema>;

/** `AiGenerationOutput` (a proposta): seções, riscos (só RISK_MAP — US-119) e avisos. */
export const aiGenerationOutputSchema = z
  .strictObject({
    sections: z.array(aiOutputSectionSchema),
    risks: z.array(aiProposedRiskSchema).max(AI_RISK_PROPOSAL_LIMITS.maxRisks).optional(),
    warnings: z.array(aiOutputWarningSchema),
  })
  .meta({ id: 'AiGenerationOutput' });
export type AiGenerationOutput = z.infer<typeof aiGenerationOutputSchema>;

/** `AiGeneration` de AI-01/02/04 (api/16-ai.md): sem custo, sem resumo e sem instrução. */
export const aiGenerationSchema = z
  .object({
    id: z.uuid(),
    processId: z.uuid(),
    documentId: z.uuid().nullable(),
    targetModule: aiTargetModuleSchema,
    kind: aiGenerationKindSchema,
    action: aiSectionActionSchema.nullable(),
    sectionKey: z.string().nullable(),
    baseRevision: z.int().nullable(),
    status: aiGenerationStatusSchema,
    requestedBy: z.object({ id: z.uuid(), name: z.string() }),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    provider: z.string(),
    model: z.string().nullable(),
    promptKey: z.string(),
    promptVersion: z.string(),
    usage: z.object({
      inputTokens: z.int().nullable(),
      outputTokens: z.int().nullable(),
      totalTokens: z.int().nullable(),
    }),
    placeholdersCount: z.int().min(0),
    groundingReplacements: z.int().min(0),
    inputRefs: z.array(aiInputRefSchema),
    output: aiGenerationOutputSchema.nullable(),
    errorCode: aiGenerationErrorCodeSchema.nullable(),
    appliedAt: z.iso.datetime().nullable(),
    appliedTargets: z
      .object({ sectionKeys: z.array(z.string()), riskIds: z.array(z.uuid()) })
      .nullable(),
  })
  .meta({ id: 'AiGeneration' });
export type AiGenerationDto = z.infer<typeof aiGenerationSchema>;

/** Item de AI-03: a mesma representação, sem `output`. */
export const aiGenerationListItemSchema = aiGenerationSchema
  .omit({ output: true })
  .meta({ id: 'AiGenerationListItem' });
export type AiGenerationListItemDto = z.infer<typeof aiGenerationListItemSchema>;

/** `meta` de AI-01. */
export const aiGenerationRequestedMetaSchema = z.object({ pollAfterMs: z.int().min(0) });
