import { z } from 'zod';

import { isoDateTimeSchema } from '../common/dates.js';
import { uuidV7Schema } from '../common/identifiers.js';
import { DOCUMENT_STATUSES } from '../document/document-type.js';
import { DOCUMENT_ACTIONS, draftContentSchema } from '../document/document.js';
import { SECTION_RENDERS, SECTION_REQUIREMENTS } from '../document/template.js';
import { PCA_STATUSES } from '../process/process.js';

/*
 * ETP — Estudo Técnico Preliminar (US-019 · entities.md §4.8 `Etp` · api/06-etp.md ETP-01/02 ·
 * Lei 14.133/2021, art. 18, §1º). O cabeçalho tipado 1:1 do `Document` do tipo `ETP` (mesmo id —
 * como o DFD e a pesquisa de preços); as 16 seções ficam no rascunho do documento e os itens em
 * `DocumentItem` (DEC-019). Os mesmos schemas servem à API (corpo, resposta, OpenAPI) e ao
 * diálogo "Criar ETP" do SCR-006.
 */

/** `EtpConclusion` (entities.md §2). */
export const ETP_CONCLUSIONS = ['PENDING', 'VIABLE', 'NOT_VIABLE'] as const;
export type EtpConclusion = (typeof ETP_CONCLUSIONS)[number];

/** `ParcelingDecision` (entities.md §2). */
export const PARCELING_DECISIONS = ['PARCELED', 'NOT_PARCELED', 'NOT_APPLICABLE'] as const;
export type ParcelingDecision = (typeof PARCELING_DECISIONS)[number];

/** Origem do valor estimado do ETP (entities.md §4.8 — subconjunto de `EstimatedValueSource`). */
export const ETP_ESTIMATED_VALUE_SOURCES = ['MANUAL', 'PRICE_RESEARCH'] as const;
export type EtpEstimatedValueSource = (typeof ETP_ESTIMATED_VALUE_SOURCES)[number];

/** Status do DFD que permitem a importação (RN-ETP-04). */
export const ETP_IMPORTABLE_DFD_STATUSES = ['FINALIZED', 'APPROVED'] as const;

/** Mensagens da US-019 (Validações V-01..V-04 e "Casos de erro"). */
export const ETP_MESSAGES = Object.freeze({
  alreadyExists: 'Este processo já tem um ETP. Abra o estudo existente.',
  permissionDenied: 'Você não pode criar o ETP neste processo.',
  typeNotAllowedInStage: 'Este documento não é permitido na etapa atual.',
  processNotEditable: 'O processo não está em um status que permita criar documentos.',
  noEligibleDfd: 'Não há um DFD finalizado neste processo para importar.',
  templateInvalid: 'O modelo de ETP do órgão não está publicado. Procure o administrador.',
  notCustodian: 'Você não pode criar o ETP neste processo.',
  idempotencyReused: 'Esta solicitação já foi enviada com outros dados. Recarregue a página.',
  unavailable: 'Não foi possível criar o ETP agora. Tente novamente em instantes.',
  /** ETP-03 (US-020): inexistente, de outro tenant ou não visível — indistinguíveis. */
  notFound: 'Documento não encontrado.',
});

/** Título do documento ETP a partir do código do processo. */
export function etpDocumentTitle(processCode: string | null): string {
  return processCode === null || processCode === ''
    ? 'Estudo Técnico Preliminar'
    : `Estudo Técnico Preliminar — ${processCode}`;
}

// --- Contratos ---------------------------------------------------------------------------------

/** ETP-02 — `POST /processes/{id}/etps` (`Idempotency-Key` obrigatório). */
export const etpCreateSchema = z
  .strictObject({
    /** `true` somente com DFD finalizado/aprovado no processo (RN-ETP-04 · V-04). */
    importFromDfd: z.boolean().optional(),
  })
  .meta({ id: 'EtpCreateRequest' });
export type EtpCreate = z.infer<typeof etpCreateSchema>;

/** ETP como o ETP-02 o devolve (api/06-etp.md `Etp`). */
export const etpSchema = z
  .object({
    /** = `documentId` (CHECK `etps_id_is_document`). */
    id: z.uuid(),
    documentId: z.uuid(),
    processId: z.uuid(),
    code: z.string().nullable(),
    title: z.string(),
    status: z.enum(DOCUMENT_STATUSES),
    conclusion: z.enum(ETP_CONCLUSIONS),
    /** Versão do DFD de origem da importação (RN-ETP-04/05); `null` sem importação. */
    importedFromDfdVersionId: z.uuid().nullable(),
    /** RN-ETP-08: o criador. */
    responsibleId: z.uuid().nullable(),
    templateVersionId: z.uuid().nullable(),
    /** `version` do documento (o `If-Match` de DOC-07). */
    documentVersion: z.int(),
    itemsCount: z.int().min(0),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    /** `version` do ETP (o `ETag`). */
    version: z.int(),
  })
  .meta({ id: 'Etp' });
export type EtpDto = z.infer<typeof etpSchema>;

export const etpMetaSchema = z
  .object({ allowedActions: z.array(z.enum(DOCUMENT_ACTIONS)) })
  .meta({ id: 'EtpMeta' });
export type EtpMeta = z.infer<typeof etpMetaSchema>;

/** ETP-01 — uma linha por ETP do processo (0 ou 1 ativo + os cancelados). */
export const etpSummarySchema = z
  .object({
    id: z.uuid(),
    documentId: z.uuid(),
    code: z.string().nullable(),
    status: z.enum(DOCUMENT_STATUSES),
    conclusion: z.enum(ETP_CONCLUSIONS),
    version: z.int(),
  })
  .meta({ id: 'EtpSummary' });
export type EtpSummaryDto = z.infer<typeof etpSummarySchema>;

/** DFD elegível para a importação (RN-ETP-04 — a mesma regra do ETP-02): passo 2 da US-019. */
export const importableDfdSchema = z
  .object({
    documentId: z.uuid(),
    code: z.string().nullable(),
    status: z.enum(ETP_IMPORTABLE_DFD_STATUSES),
    /** `approvedVersionId`, senão `currentVersionId`. */
    versionId: z.uuid(),
    versionNumber: z.int().min(1),
    objectSummary: z.string(),
    itemsCount: z.int().min(0),
    pcaStatus: z.enum(PCA_STATUSES).nullable(),
  })
  .meta({ id: 'ImportableDfd' });
export type ImportableDfdDto = z.infer<typeof importableDfdSchema>;

export const etpListMetaSchema = z
  .object({ importableDfd: importableDfdSchema.nullable() })
  .meta({ id: 'EtpListMeta' });
export type EtpListMeta = z.infer<typeof etpListMetaSchema>;

// --- ETP-03 — Obter ETP (US-020 · SCR-008) -----------------------------------------------------

export const etpIdParamsSchema = z.strictObject({ id: uuidV7Schema });
export type EtpIdParams = z.infer<typeof etpIdParamsSchema>;

/**
 * ETP-03: o cabeçalho (`Etp`) + o rascunho por seção (`draftContent.sections[key]` com `content`,
 * `state`, `justification` e `revision` — o `If-Match: "s<revision>"` do DOC-05) e os campos da
 * conclusão/estimativa. `estimatedTotalValue` = `null` + `estimatedTotalValueMasked: true` sem
 * POL-09 em processo sigiloso (api.md §1.4).
 */
export const etpDetailSchema = etpSchema
  .extend({
    recommendedAlternativeId: z.uuid().nullable(),
    parcelingDecision: z.enum(PARCELING_DECISIONS).nullable(),
    estimatedValueSource: z.enum(ETP_ESTIMATED_VALUE_SOURCES).nullable(),
    /** Decimal(18,2) como string; `null` se não informado ou mascarado. */
    estimatedTotalValue: z.string().nullable(),
    estimatedTotalValueMasked: z.boolean(),
    priceResearchId: z.uuid().nullable(),
    /** `draftRevision` do documento (cresce a cada gravação de seção). */
    draftRevision: z.int().min(0),
    draftContent: draftContentSchema,
  })
  .meta({ id: 'EtpDetail' });
export type EtpDetailDto = z.infer<typeof etpDetailSchema>;

/** Seção da versão do template FIXADA no ETP, como a SCR-008 a usa (navegação e editor). */
export const etpTemplateSectionSchema = z
  .object({
    key: z.string(),
    title: z.string(),
    order: z.int(),
    requirement: z.enum(SECTION_REQUIREMENTS),
    helpText: z.string().nullable(),
    legalBasis: z.string().nullable(),
    minChars: z.int().nullable(),
    maxChars: z.int(),
    render: z.enum(SECTION_RENDERS),
    allowNarrative: z.boolean(),
  })
  .meta({ id: 'EtpTemplateSection' });
export type EtpTemplateSectionDto = z.infer<typeof etpTemplateSectionSchema>;

/**
 * `meta` do ETP-03: as ações do documento (RN-DOC-18) e a versão do template fixada no documento
 * (seções com exigência, limites e `render`). Vem aqui porque o TPL-07 exige `TEMPLATE_VIEW`.
 */
export const etpDetailMetaSchema = z
  .object({
    allowedActions: z.array(z.enum(DOCUMENT_ACTIONS)),
    template: z
      .object({
        versionId: z.uuid(),
        versionNumber: z.int(),
        sections: z.array(etpTemplateSectionSchema),
      })
      .nullable(),
  })
  .meta({ id: 'EtpDetailMeta' });
export type EtpDetailMeta = z.infer<typeof etpDetailMetaSchema>;
