import { z } from 'zod';

import { DOCUMENT_KINDS, DOCUMENT_STATUSES } from './document-type.js';
import { documentSnapshotSchema, SECTION_STATES, VERSION_REASONS } from './document.js';
import { isoDateTimeSchema } from '../common/dates.js';
import { uuidV7Schema } from '../common/identifiers.js';
import { pageQuerySchema } from '../http/pagination.js';

/*
 * Versões imutáveis do documento e a comparação entre duas delas (US-066 · DEC-084 · ADR-006 ·
 * api/03-documents.md DOC-15..18). Schemas compartilhados pela API (corpo, resposta, OpenAPI) e
 * pela SCR-106 (`SaveVersionDialog`, `VersionList`, `VersionComparePicker`, `VersionDiffView`).
 */

export const DOCUMENT_VERSION_LIMITS = {
  /** RN-DOC-62 · V-03. */
  changeSummaryMax: 500,
  /** Caracteres do `contentHash` exibidos na lista (RN-DOC-59). */
  hashPrefix: 12,
} as const;

export const DOCUMENT_VERSION_MESSAGES = {
  changeSummaryTooLong: `O resumo deve ter no máximo ${DOCUMENT_VERSION_LIMITS.changeSummaryMax} caracteres.`,
  notEditable: 'Esta versão só pode ser salva enquanto o documento está em edição.',
  uploadedNotAllowed: 'Para este tipo de documento, envie um novo arquivo para criar uma versão.',
  versionsOfOtherDocument: 'Selecione duas versões deste mesmo documento.',
  sameVersion: 'Escolha duas versões diferentes para comparar.',
  noSummary: 'Sem resumo informado',
  saveUnavailable: 'Não foi possível salvar a versão agora. Tente novamente em instantes.',
  forbidden: 'Você não tem permissão para salvar uma versão deste documento.',
  notFound: 'Documento ou versão não encontrados.',
} as const;

// --- Requisições --------------------------------------------------------------------------------

/** DOC-16 (corpo): resumo opcional, texto simples (RN-DOC-62). Sem corpo = sem resumo. */
export const documentVersionCreateSchema = z
  .strictObject({
    changeSummary: z
      .string()
      .trim()
      .max(DOCUMENT_VERSION_LIMITS.changeSummaryMax, {
        error: DOCUMENT_VERSION_MESSAGES.changeSummaryTooLong,
      })
      .optional(),
  })
  .default({});
export type DocumentVersionCreate = z.output<typeof documentVersionCreateSchema>;

/** DOC-15 (query): paginação padrão; ordem fixa `versionNumber` desc (RN-DOC-59). */
export const documentVersionListQuerySchema = pageQuerySchema;
export type DocumentVersionListQuery = z.infer<typeof documentVersionListQuerySchema>;

/** DOC-17 (path). */
export const documentVersionIdParamsSchema = z.strictObject({ versionId: uuidV7Schema });

/** DOC-18 (query): duas versões diferentes do mesmo documento (V-04/V-05). */
export const documentVersionCompareQuerySchema = z
  .strictObject({ from: z.uuid(), to: z.uuid() })
  .refine((value) => value.from !== value.to, {
    error: DOCUMENT_VERSION_MESSAGES.sameVersion,
    path: ['to'],
    params: { code: 'SAME_VALUE' },
  });
export type DocumentVersionCompareQuery = z.infer<typeof documentVersionCompareQuerySchema>;

// --- Respostas ----------------------------------------------------------------------------------

/** Campos de `DocumentVersion` (entities.md §4.7) sem o snapshot — itens de DOC-15. */
export const documentVersionSummarySchema = z
  .object({
    id: z.uuid(),
    documentId: z.uuid(),
    processId: z.uuid(),
    versionNumber: z.int().min(1),
    reason: z.enum(VERSION_REASONS),
    statusAtCreation: z.enum(DOCUMENT_STATUSES),
    /** SHA-256 do snapshot canônico (RFC 8785) ou do arquivo (`UPLOADED`). */
    contentHash: z.string().length(64),
    attachmentId: z.uuid().nullable(),
    templateVersionId: z.uuid().nullable(),
    changeSummary: z.string().nullable(),
    createdById: z.uuid(),
    /** Nome de exibição do autor (nulo se o usuário não é mais membro do tenant). */
    createdByName: z.string().nullable(),
    createdAt: isoDateTimeSchema,
  })
  .meta({ id: 'DocumentVersionSummary' });
export type DocumentVersionSummaryDto = z.infer<typeof documentVersionSummarySchema>;

/**
 * DOC-16/17: a versão com o snapshot (`content` nulo para `UPLOADED`). Campos monetários de
 * processo sigiloso, para quem não atende POL-09, vêm `null` com `<campo>Masked: true` (api.md §1.4).
 */
export const documentVersionSchema = documentVersionSummarySchema
  .extend({
    kind: z.enum(DOCUMENT_KINDS),
    content: documentSnapshotSchema.nullable(),
  })
  .meta({ id: 'DocumentVersion' });
export type DocumentVersionDto = z.infer<typeof documentVersionSchema>;

/** Marcador de cada entrada da comparação (RN-DOC-60/61 · FA-03). */
export const VERSION_CHANGE_TYPES = ['ADDED', 'REMOVED', 'CHANGED', 'UNCHANGED', 'MASKED'] as const;
export type VersionChangeType = (typeof VERSION_CHANGE_TYPES)[number];

/** Campo de cabeçalho comparado: `document.*`, `template.*`, `file.*` ou campo do tipado. */
export const headerDiffSchema = z
  .object({
    field: z.string(),
    changeType: z.enum(VERSION_CHANGE_TYPES),
    from: z.unknown(),
    to: z.unknown(),
  })
  .meta({ id: 'VersionHeaderDiff' });
export type HeaderDiff = z.infer<typeof headerDiffSchema>;

/** Seção de um lado da comparação: estado, texto extraído do TipTap e justificativa. */
export const sectionSideSchema = z.object({
  state: z.enum(SECTION_STATES),
  text: z.string(),
  justification: z.string().nullable(),
});
export type SectionSide = z.infer<typeof sectionSideSchema>;

export const sectionDiffSchema = z
  .object({
    sectionKey: z.string(),
    changeType: z.enum(VERSION_CHANGE_TYPES),
    from: sectionSideSchema.nullable(),
    to: sectionSideSchema.nullable(),
  })
  .meta({ id: 'VersionSectionDiff' });
export type SectionDiff = z.infer<typeof sectionDiffSchema>;

/** Linha de coleção comparada pela chave natural (`processItemId` nos itens; `id` nas demais). */
export const collectionDiffSchema = z
  .object({
    collection: z.string(),
    itemId: z.string(),
    changeType: z.enum(VERSION_CHANGE_TYPES),
    /** Campos visíveis alterados (só em `CHANGED`). */
    changedFields: z.array(z.string()),
    /** Campos sigilosos mascarados na linha (POL-09): nunca entram em `changedFields`. */
    maskedFields: z.array(z.string()),
    from: z.record(z.string(), z.unknown()).nullable(),
    to: z.record(z.string(), z.unknown()).nullable(),
  })
  .meta({ id: 'VersionCollectionDiff' });
export type CollectionDiff = z.infer<typeof collectionDiffSchema>;

/** DOC-18 (resposta): os dois lados e os três blocos de diferenças. */
export const documentVersionComparisonSchema = z
  .object({
    documentId: z.uuid(),
    kind: z.enum(DOCUMENT_KINDS),
    from: documentVersionSummarySchema,
    to: documentVersionSummarySchema,
    header: z.array(headerDiffSchema),
    sections: z.array(sectionDiffSchema),
    collections: z.array(collectionDiffSchema),
  })
  .meta({ id: 'DocumentVersionComparison' });
export type DocumentVersionComparisonDto = z.infer<typeof documentVersionComparisonSchema>;
