import { z } from 'zod';

import {
  CONFIDENTIALITIES,
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  SYSTEM_DOCUMENT_MODULES,
} from './document-type.js';
import { SECTION_REQUIREMENTS } from './template.js';
import { isoDateTimeSchema } from '../common/dates.js';
import { uuidV7Schema } from '../common/identifiers.js';
import { violationSchema } from '../http/problem.js';

/*
 * Documento genérico do processo e o seu ciclo de vida (US-065 · DEC-017/018 · entities.md §4.7,
 * §5.3 · api/03-documents.md DOC-03/04/08..14). Schemas compartilhados pela API (corpo, resposta,
 * OpenAPI) e pela SCR-105 (`DocumentActionsBar`, `CompletenessPanel`, diálogos de justificativa).
 */

/** `VersionReason` (entities.md §2): motivo de criação de uma `DocumentVersion`. */
export const VERSION_REASONS = [
  'MANUAL',
  'SUBMISSION',
  'FINALIZATION',
  'IMPORT',
  'UPLOAD',
  'REOPEN',
  'SYSTEM',
] as const;
export type VersionReason = (typeof VERSION_REASONS)[number];

/** Estado de uma seção do rascunho (entities.md §5.3.1). */
export const SECTION_STATES = ['EMPTY', 'FILLED', 'NOT_APPLICABLE'] as const;
export type SectionState = (typeof SECTION_STATES)[number];

/**
 * Ações do documento em `meta.allowedActions` (api.md §1.5 · RN-DOC-18): calculadas pelo
 * `DocumentLifecycleService` a partir do status, da custódia/participação, de POL-02/POL-11 e da
 * permissão do tipo — a UI nunca as reimplementa (RN-FND-92). A retirada (`DOC-11`) entra com a
 * US-053.
 */
export const DOCUMENT_ACTIONS = [
  'UPDATE',
  'FINALIZE',
  'SUBMIT',
  'REOPEN',
  'CANCEL',
  'DELETE',
] as const;
export type DocumentAction = (typeof DOCUMENT_ACTIONS)[number];

export const DOCUMENT_LIMITS = {
  titleMin: 5,
  titleMax: 250,
  /** Justificativa de reabertura/cancelamento (RN-DOC-47/48 · V-03). */
  reasonMin: 20,
  reasonMax: 2000,
  /** Códigos de aviso reconhecidos por comando. */
  acknowledgedMax: 100,
} as const;

export const DOCUMENT_MESSAGES = {
  titleLength: `O título deve ter entre ${DOCUMENT_LIMITS.titleMin} e ${DOCUMENT_LIMITS.titleMax} caracteres.`,
  reasonTooShort: `Justifique com pelo menos ${DOCUMENT_LIMITS.reasonMin} caracteres.`,
  reasonTooLong: `Informe no máximo ${DOCUMENT_LIMITS.reasonMax.toLocaleString('pt-BR')} caracteres.`,
  incomplete: 'Há pendências que impedem esta ação.',
  warningsNotAcknowledged: 'Reconheça os avisos para continuar.',
  invalidState: 'Esta ação não está disponível para o status atual do documento.',
  pendingApproval: 'Este documento tem uma aprovação em andamento e não pode ser reaberto.',
  notCustodian: 'Apenas o responsável atual pelo processo pode cancelar este documento.',
  alreadySubmitted: 'Este documento já foi submetido; só pode ser cancelado.',
  alreadyExists: 'Este processo já tem um documento deste tipo.',
  notEditable: 'O documento não pode ser editado no status atual.',
  versionConflict: 'Esta informação foi atualizada por outra pessoa. Recarregue e tente novamente.',
  // DOC-27 (US-122 · V-01..V-04 · V-08)
  aiReviewSectionsRequired: 'Selecione ao menos uma seção do documento.',
  aiReviewReload: 'Recarregue o documento e tente de novo.',
  aiReviewConfirmAll: 'Confirme que leu e revisou as seções.',
  aiReviewSectionChanged: 'A seção foi alterada. Leia a versão atual antes de revisar.',
  aiReviewPending: 'Revise o conteúdo gerado por IA e resolva os itens [a confirmar].',
} as const;

// --- Conteúdo (entities.md §5.3) ----------------------------------------------------------------

/** Proveniência de IA da seção (US-122); ausente/`null` = sem IA. */
export const sectionAiProvenanceSchema = z
  .object({
    generationId: z.uuid(),
    appliedAt: isoDateTimeSchema,
    appliedById: z.uuid(),
    reviewedAt: isoDateTimeSchema.nullable(),
    reviewedById: z.uuid().nullable(),
  })
  .nullable();

/** Seção do rascunho (`DraftContent.sections[k]`). O conteúdo TipTap é conferido no DOC-05. */
export const draftSectionSchema = z.object({
  state: z.enum(SECTION_STATES),
  content: z.looseObject({ type: z.literal('doc') }).nullable(),
  justification: z.string().nullable(),
  revision: z.int().min(0),
  updatedAt: isoDateTimeSchema,
  updatedById: z.uuid(),
  ai: sectionAiProvenanceSchema.optional(),
});
export type DraftSection = z.infer<typeof draftSectionSchema>;

/** `DraftContent` (entities.md §5.3.1): rascunho de trabalho por `sectionKey`. */
export const draftContentSchema = z
  .object({ sections: z.record(z.string(), draftSectionSchema) })
  .meta({ id: 'DraftContent' });
export type DraftContent = z.infer<typeof draftContentSchema>;

export const EMPTY_DRAFT_CONTENT: DraftContent = Object.freeze({ sections: {} });

/** Seção no snapshot da versão: sem `revision`/`updatedBy*` (entities.md §5.3.2). */
export const snapshotSectionSchema = draftSectionSchema.omit({
  revision: true,
  updatedAt: true,
  updatedById: true,
});

/**
 * Snapshot imutável de `DocumentVersion.content` (entities.md §5.3.2 · DEC-017/084): cabeçalho,
 * seções e coleções; o `contentHash` é o SHA-256 do JSON canonicalizado (RFC 8785).
 */
export const documentSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    document: z.object({
      id: z.uuid(),
      code: z.string().nullable(),
      title: z.string(),
      typeCode: z.string(),
      kind: z.enum(DOCUMENT_KINDS),
      confidentiality: z.enum(CONFIDENTIALITIES),
      versionNumber: z.int().min(1),
    }),
    template: z
      .object({ templateId: z.uuid(), versionId: z.uuid(), versionNumber: z.int().min(1) })
      .nullable(),
    process: z.object({
      id: z.uuid(),
      code: z.string().nullable(),
      title: z.string(),
      object: z.string(),
      organizationName: z.string().nullable(),
      organizationCnpj: z.string().nullable(),
      requestingSecretariatName: z.string().nullable(),
      requestingDepartmentName: z.string().nullable(),
      isBudgetConfidential: z.boolean(),
    }),
    header: z.record(z.string(), z.unknown()),
    sections: z.record(z.string(), snapshotSectionSchema),
    collections: z.record(z.string(), z.array(z.unknown())),
    generatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'DocumentSnapshot' });
export type DocumentSnapshot = z.infer<typeof documentSnapshotSchema>;

// --- Requisições --------------------------------------------------------------------------------

export const documentIdParamsSchema = z.strictObject({ id: uuidV7Schema });

const documentTitleSchema = z
  .string({ error: DOCUMENT_MESSAGES.titleLength })
  .trim()
  .min(DOCUMENT_LIMITS.titleMin, { error: DOCUMENT_MESSAGES.titleLength })
  .max(DOCUMENT_LIMITS.titleMax, { error: DOCUMENT_MESSAGES.titleLength });

/** Justificativa de reabertura/cancelamento (RN-DOC-47/48 · V-03: `TOO_SHORT`). */
export const documentReasonSchema = z
  .string({ error: DOCUMENT_MESSAGES.reasonTooShort })
  .trim()
  .min(DOCUMENT_LIMITS.reasonMin, { error: DOCUMENT_MESSAGES.reasonTooShort })
  .max(DOCUMENT_LIMITS.reasonMax, { error: DOCUMENT_MESSAGES.reasonTooLong });

/** DOC-04 (corpo): ajuste do cabeçalho do rascunho — ao menos um campo. */
export const documentUpdateSchema = z
  .strictObject({
    title: documentTitleSchema.optional(),
    responsibleId: z.uuid({ error: 'Informe um responsável válido.' }).optional(),
  })
  .refine((value) => value.title !== undefined || value.responsibleId !== undefined, {
    error: 'Informe o título ou o responsável.',
    path: ['title'],
    params: { code: 'REQUIRED' },
  });
export type DocumentUpdate = z.infer<typeof documentUpdateSchema>;

/**
 * DOC-02 (corpo — US-063/US-064 · RN-DOC-31): tipo ativo do tenant (`FREE_TEXT`/`UPLOADED`,
 * permitido na etapa — conferido pela API) e título de 5 a 250 caracteres. `responsibleId` vale para
 * os dois tipos (padrão: o criador).
 */
export const documentCreateSchema = z
  .strictObject({
    documentTypeId: z.uuid({ error: 'Selecione um tipo de documento válido.' }),
    title: documentTitleSchema,
    responsibleId: z.uuid({ error: 'Informe um responsável válido.' }).optional(),
  })
  .meta({ id: 'DocumentCreateRequest' });
export type DocumentCreate = z.infer<typeof documentCreateSchema>;

/** DOC-09/DOC-10 (corpo): avisos de DOC-08 reconhecidos (V-02). Sem corpo = nenhum. */
export const documentTransitionSchema = z
  .strictObject({
    acknowledgedWarnings: z
      .array(z.string().min(1).max(80))
      .max(DOCUMENT_LIMITS.acknowledgedMax)
      .optional(),
  })
  .default({});
export type DocumentTransition = z.output<typeof documentTransitionSchema>;

/** Seções de um lote de revisão (DOC-27): no máximo as de um template (60 por documento). */
export const AI_REVIEW_MAX_SECTIONS = 60;

/**
 * DOC-27 (corpo — US-122 · RN-AI-56): revisão humana das seções geradas por IA. `expectedRevisions`
 * traz a `revision` lida de cada seção (V-02); lote de 2+ seções exige `confirmAll: true` — a
 * confirmação "Li e revisei as N seções" (V-03). Chave fora do documento é conferida pela API.
 */
export const documentAiReviewSchema = z
  .strictObject({
    sectionKeys: z
      .array(z.string().min(1).max(60), { error: DOCUMENT_MESSAGES.aiReviewSectionsRequired })
      .min(1, { error: DOCUMENT_MESSAGES.aiReviewSectionsRequired })
      .max(AI_REVIEW_MAX_SECTIONS),
    expectedRevisions: z.record(z.string().min(1).max(60), z.int().min(0), {
      error: DOCUMENT_MESSAGES.aiReviewReload,
    }),
    confirmAll: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const keys = new Set(value.sectionKeys);
    if (keys.size !== value.sectionKeys.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['sectionKeys'],
        message: DOCUMENT_MESSAGES.aiReviewSectionsRequired,
        params: { code: 'DUPLICATED' },
      });
    }
    if ([...keys].some((key) => value.expectedRevisions[key] === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['expectedRevisions'],
        message: DOCUMENT_MESSAGES.aiReviewReload,
        params: { code: 'REQUIRED' },
      });
    }
    if (keys.size >= 2 && value.confirmAll !== true) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmAll'],
        message: DOCUMENT_MESSAGES.aiReviewConfirmAll,
        params: { code: 'CONDITIONAL_REQUIRED' },
      });
    }
  })
  .meta({ id: 'DocumentAiReviewRequest' });
export type DocumentAiReview = z.infer<typeof documentAiReviewSchema>;

/** DOC-12 (corpo). */
export const documentReopenSchema = z.strictObject({ reopenReason: documentReasonSchema });
export type DocumentReopen = z.infer<typeof documentReopenSchema>;

/** DOC-13 (corpo). */
export const documentCancelSchema = z.strictObject({ cancellationReason: documentReasonSchema });
export type DocumentCancel = z.infer<typeof documentCancelSchema>;

// --- Respostas ----------------------------------------------------------------------------------

export const documentTypeSummarySchema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    kind: z.enum(DOCUMENT_KINDS),
    systemModule: z.enum(SYSTEM_DOCUMENT_MODULES).nullable(),
    requiresApproval: z.boolean(),
  })
  .meta({ id: 'DocumentTypeSummary' });

/** `Document` (DOC-03/04/09/10/12/13 — `ETag: "<version>"`). */
export const documentSchema = z
  .object({
    id: z.uuid(),
    processId: z.uuid(),
    documentType: documentTypeSummarySchema,
    templateVersionId: z.uuid().nullable(),
    number: z.int().nullable(),
    year: z.int().nullable(),
    code: z.string().nullable(),
    title: z.string(),
    status: z.enum(DOCUMENT_STATUSES),
    confidentiality: z.enum(CONFIDENTIALITIES),
    draftContent: draftContentSchema,
    draftRevision: z.int(),
    currentVersionId: z.uuid().nullable(),
    currentVersionNumber: z.int().nullable(),
    approvedVersionId: z.uuid().nullable(),
    /** Selo derivado "Em aprovação" quando preenchido (DEC-018). */
    pendingApprovalId: z.uuid().nullable(),
    responsibleId: z.uuid().nullable(),
    submittedAt: isoDateTimeSchema.nullable(),
    submittedById: z.uuid().nullable(),
    finalizedAt: isoDateTimeSchema.nullable(),
    finalizedById: z.uuid().nullable(),
    approvedAt: isoDateTimeSchema.nullable(),
    returnedAt: isoDateTimeSchema.nullable(),
    rejectedAt: isoDateTimeSchema.nullable(),
    reopenedAt: isoDateTimeSchema.nullable(),
    reopenedById: z.uuid().nullable(),
    reopenReason: z.string().nullable(),
    canceledAt: isoDateTimeSchema.nullable(),
    canceledById: z.uuid().nullable(),
    cancellationReason: z.string().nullable(),
    sourceDocumentId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    createdById: z.uuid(),
    version: z.int(),
  })
  .meta({ id: 'Document' });
export type DocumentDto = z.infer<typeof documentSchema>;

export const documentMetaSchema = z
  .object({ allowedActions: z.array(z.enum(DOCUMENT_ACTIONS)) })
  .meta({ id: 'DocumentMeta' });
export type DocumentMeta = z.infer<typeof documentMetaSchema>;

/** DOC-27 (resposta): o documento e as seções efetivamente revisadas (FA-07 · idempotente). */
export const documentAiReviewResultSchema = z
  .object({ document: documentSchema, reviewedSectionKeys: z.array(z.string()) })
  .meta({ id: 'DocumentAiReviewResult' });
export type DocumentAiReviewResultDto = z.infer<typeof documentAiReviewResultSchema>;

/** Seção avaliada pela completude genérica (DOC-08). */
export const documentValidationSectionSchema = z.object({
  key: z.string(),
  requirement: z.enum(SECTION_REQUIREMENTS),
  state: z.enum(SECTION_STATES),
  complete: z.boolean(),
});

/** DOC-08 (resposta): completude genérica + regras do módulo tipado num único `violations[]`. */
export const documentValidationSchema = z
  .object({
    documentId: z.uuid(),
    isComplete: z.boolean(),
    draftRevision: z.int(),
    evaluatedAt: isoDateTimeSchema,
    summary: z.object({ blocking: z.int().min(0), warnings: z.int().min(0) }),
    sections: z.array(documentValidationSectionSchema),
    violations: z.array(violationSchema),
  })
  .meta({ id: 'DocumentValidation' });
export type DocumentValidationDto = z.infer<typeof documentValidationSchema>;
