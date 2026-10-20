import { z } from 'zod';

import { isoDateTimeSchema } from '../common/dates.js';
import { uuidV7Schema } from '../common/identifiers.js';
import { DAY_COUNT_TYPES, DOCUMENT_STATUSES } from '../document/document-type.js';
import { DOCUMENT_ACTIONS, DOCUMENT_LIMITS, draftContentSchema } from '../document/document.js';
import { SECTION_RENDERS, SECTION_REQUIREMENTS } from '../document/template.js';
import type { FieldError } from '../http/problem.js';

/*
 * Termo de Referência (US-036 · entities.md §4.8 `TermOfReference` · api/09-term-of-reference.md
 * TRM-01..04 · Lei 14.133/2021, art. 6º, XXIII). O cabeçalho tipado 1:1 do `Document` do tipo `TR`
 * (mesmo id — como DFD, ETP e pesquisa de preços); as seções narrativas ficam no rascunho do
 * documento (DOC-05) e os itens em `DocumentItem` (US-038). Os mesmos schemas servem à API (corpo,
 * resposta, OpenAPI) e às telas SCR-006 (diálogo "Criar Termo de Referência") e SCR-012 (editor).
 */

/** Origem do valor estimado do TR (RN-TR-08 — subconjunto de `EstimatedValueSource`). */
export const TERM_ESTIMATED_VALUE_SOURCES = ['PRICE_RESEARCH', 'ETP', 'MANUAL'] as const;
export type TermEstimatedValueSource = (typeof TERM_ESTIMATED_VALUE_SOURCES)[number];

/** `AwardType` (entities.md §2): tipo de adjudicação. */
export const AWARD_TYPES = ['BY_ITEM', 'BY_LOT', 'GLOBAL'] as const;
export type AwardType = (typeof AWARD_TYPES)[number];

/** Status da pesquisa de preços que a tornam "concluída" para o TR (RN-TR-07). */
export const TERM_COMPLETED_PRICE_RESEARCH_STATUSES = ['FINALIZED', 'APPROVED'] as const;

export const TERM_LIMITS = Object.freeze({
  titleMin: DOCUMENT_LIMITS.titleMin,
  titleMax: DOCUMENT_LIMITS.titleMax,
  /** RN-TR-14. */
  objectMin: 10,
  objectMax: 2000,
});

/**
 * Condições contratuais do TR (US-038 · RN-TR-28..32 · entities.md §4.8). `executionDeadlineMax` é
 * só um teto técnico (100 anos em dias — a regra é "> 0"); `deliveryLocationMax` segue o padrão do
 * `fieldConfig` (RN-TR-06).
 */
export const TERM_CONDITION_LIMITS = Object.freeze({
  contractDurationMin: 1,
  contractDurationMax: 120,
  executionDeadlineMin: 1,
  executionDeadlineMax: 36_500,
  paymentTermMin: 1,
  paymentTermMax: 90,
  productWarrantyMin: 0,
  productWarrantyMax: 120,
  contractGuaranteeMax: 10,
  deliveryLocationMax: 2000,
});

/** Campos do painel "Condições contratuais" (TRM-04 — US-038). */
export const TERM_CONDITION_FIELDS = [
  'contractDurationMonths',
  'executionDeadline',
  'executionDeadlineType',
  'deliveryLocation',
  'paymentTermDays',
  'productWarrantyMonths',
  'contractGuaranteePercent',
  'allowsSubcontracting',
  'selectionCriterionId',
  'awardType',
] as const;
export type TermConditionField = (typeof TERM_CONDITION_FIELDS)[number];

/** Mensagens da US-038 (Validações V-05..V-09 e V-12). */
export const TERM_CONDITION_MESSAGES = Object.freeze({
  deadlineTypeRequired: 'Informe o tipo de contagem do prazo.',
  deadlineRequired: 'Informe o prazo de execução/entrega.',
  deadlineRange: 'Informe um prazo de execução/entrega maior que zero.',
  durationRange: 'A vigência deve estar entre 1 e 120 meses.',
  paymentRange: 'O prazo de pagamento deve estar entre 1 e 90 dias.',
  warrantyRange: 'A garantia do objeto deve estar entre 0 e 120 meses.',
  guaranteeRange: 'A garantia contratual não pode superar 10% (arts. 96–98).',
  guaranteeInvalid: 'Informe um percentual com até 4 casas decimais.',
  deliveryLocationLength: `O local de entrega deve ter no máximo ${TERM_CONDITION_LIMITS.deliveryLocationMax.toLocaleString('pt-BR')} caracteres.`,
  criterionInvalid: 'Selecione um critério de julgamento válido.',
  catalogUnavailable: 'Não foi possível carregar as opções. Tentar novamente.',
  versionConflict: 'O TR foi alterado por outra pessoa. Recarregue para continuar.',
});

/** Mensagens da US-036 (Validações V-01..V-13 e "Casos de erro"). */
export const TERM_MESSAGES = Object.freeze({
  titleLength: `O título deve ter entre ${String(TERM_LIMITS.titleMin)} e ${String(TERM_LIMITS.titleMax)} caracteres.`,
  objectLength: `O objeto deve ter entre ${String(TERM_LIMITS.objectMin)} e ${TERM_LIMITS.objectMax.toLocaleString('pt-BR')} caracteres.`,
  templateInvalid: 'Selecione um modelo de TR válido.',
  noTemplate: 'Não há modelo de TR publicado. Fale com o administrador do órgão.',
  alreadyExists: 'Este processo já tem um Termo de Referência.',
  typeNotAllowedInStage: 'O Termo de Referência não pode ser elaborado nesta etapa.',
  notCustodian: 'Somente quem está com o processo pode criar o TR.',
  processNotEditable: 'O processo não permite alterações no status atual.',
  notApplicableNotAllowed: "Esta seção é obrigatória e não pode ser marcada como 'não se aplica'.",
  justificationTooShort: 'Justifique com pelo menos 20 caracteres.',
  sectionSaveFailed: 'Não foi possível salvar esta seção. Recarregue o documento.',
  valueInvalid: 'Informe um valor válido, com até 2 casas decimais.',
  priceResearchInvalid: 'Selecione a pesquisa de preços deste processo.',
  priceResearchNotCompleted: 'A pesquisa de preços ainda não foi concluída.',
  manualValueRequired: 'Informe o valor estimado.',
  valueReadOnly: 'O valor vem da pesquisa de preços vinculada. Escolha "Informar manualmente".',
  etpSourceNotAllowed: 'A origem "ETP" é definida pela importação do ETP.',
  notEditable: 'O TR está concluído. Reabra-o para editar.',
  versionConflict: 'Os dados do TR foram alterados por outra pessoa.',
  permissionDenied: 'Você não pode criar ou editar o TR deste processo agora.',
  confidentialValue: 'Valor sigiloso',
  manualWithCompletedResearch: (code: string) =>
    `Existe pesquisa de preços concluída (${code}). O valor manual tem precedência menor e exige justificativa.`,
  previewUnavailable:
    'Não foi possível gerar a pré-visualização agora. Tente novamente em instantes.',
  unavailable: 'Não foi possível salvar agora. Suas alterações estão guardadas neste navegador.',
  notFound: 'Documento não encontrado.',
});

/** Título padrão do TR (Campos: "Termo de Referência — {process.title}", até 250 caracteres). */
export function termDocumentTitle(processTitle: string): string {
  const base = 'Termo de Referência';
  const title = processTitle.trim();
  if (title === '') return base;
  const full = `${base} — ${title}`;
  return Array.from(full).length <= TERM_LIMITS.titleMax
    ? full
    : `${Array.from(full)
        .slice(0, TERM_LIMITS.titleMax - 1)
        .join('')
        .trimEnd()}…`;
}

const MONEY_PATTERN = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;

/** V-11: decimal ≥ 0 com até 2 casas, como string (DEC-003). */
export const termMoneySchema = z
  .string({ error: TERM_MESSAGES.valueInvalid })
  .refine((value) => MONEY_PATTERN.test(value), {
    error: TERM_MESSAGES.valueInvalid,
    params: { code: 'INVALID_DECIMAL' },
  })
  .meta({ description: 'Decimal ≥ 0 com até 2 casas, ponto como separador (ex.: "98000.00").' });

/** `true` quando o texto é um valor monetário válido para o TR (V-11 — mesma regra do schema). */
export function isTermMoney(value: string): boolean {
  return MONEY_PATTERN.test(value.trim());
}

const PERCENT_PATTERN = /^\d{1,3}(?:\.\d{1,4})?$/;

/** RN-TR-31: garantia contratual de 0 a 10 %, até 4 casas, como string (DEC-003). */
export const termGuaranteePercentSchema = z
  .string({ error: TERM_CONDITION_MESSAGES.guaranteeInvalid })
  .trim()
  .refine((value) => PERCENT_PATTERN.test(value), {
    error: TERM_CONDITION_MESSAGES.guaranteeInvalid,
    params: { code: 'INVALID_DECIMAL' },
    abort: true,
  })
  .refine((value) => Number(value) <= TERM_CONDITION_LIMITS.contractGuaranteeMax, {
    error: TERM_CONDITION_MESSAGES.guaranteeRange,
    params: { code: 'OUT_OF_RANGE' },
  })
  .meta({ description: 'Percentual de 0 a 10 com até 4 casas, ponto como separador (ex.: "5").' });

/** Problema do par prazo × tipo de contagem (RN-TR-29 · V-05) — um exige o outro. */
export function termDeadlineIssue(
  executionDeadline: number | null,
  executionDeadlineType: string | null,
): FieldError | null {
  if (executionDeadline !== null && executionDeadlineType === null) {
    return {
      field: 'executionDeadlineType',
      code: 'CONDITIONAL_REQUIRED',
      message: TERM_CONDITION_MESSAGES.deadlineTypeRequired,
    };
  }
  if (executionDeadline === null && executionDeadlineType !== null) {
    return {
      field: 'executionDeadline',
      code: 'CONDITIONAL_REQUIRED',
      message: TERM_CONDITION_MESSAGES.deadlineRequired,
    };
  }
  return null;
}

const intRange = (min: number, max: number, message: string) =>
  z.int({ error: message }).min(min, { error: message }).max(max, { error: message });

// --- Contratos ---------------------------------------------------------------------------------

export const termIdParamsSchema = z.strictObject({ id: uuidV7Schema });
export type TermIdParams = z.infer<typeof termIdParamsSchema>;

/** TRM-02 — `POST /processes/{id}/terms` (`Idempotency-Key` obrigatório). */
export const termCreateSchema = z
  .strictObject({
    /** Template ativo do tipo `TR` com versão publicada; ausente = o padrão do tipo (RN-TR-03). */
    templateId: z.uuid({ error: TERM_MESSAGES.templateInvalid }).optional(),
    /** V-01: 5–250; ausente = "Termo de Referência — {process.title}". */
    title: z
      .string()
      .trim()
      .min(TERM_LIMITS.titleMin, { error: TERM_MESSAGES.titleLength })
      .max(TERM_LIMITS.titleMax, { error: TERM_MESSAGES.titleLength })
      .optional(),
  })
  .meta({ id: 'TermCreateRequest' });
export type TermCreate = z.infer<typeof termCreateSchema>;

/**
 * TRM-04 — `PATCH /terms/{id}` (`If-Match: "<version>"`): objeto e valor estimado (US-036) e as
 * condições contratuais tipadas (US-038 · RN-TR-28..32). Campo ausente = sem mudança; `null` limpa
 * a condição. O par prazo × tipo de contagem (RN-TR-29) e o critério de julgamento ativo do tenant
 * são conferidos no caso de uso, sobre o estado resultante.
 */
export const termPatchSchema = z
  .strictObject({
    /** RN-TR-14: 10–2.000; não altera `Process.object`. */
    objectDefinition: z
      .string()
      .trim()
      .min(TERM_LIMITS.objectMin, { error: TERM_MESSAGES.objectLength })
      .max(TERM_LIMITS.objectMax, { error: TERM_MESSAGES.objectLength })
      .optional(),
    /** V-12: pesquisa do mesmo processo, concluída; implica `estimatedValueSource = PRICE_RESEARCH`. */
    priceResearchId: z.uuid({ error: TERM_MESSAGES.priceResearchInvalid }).optional(),
    /** Só com origem `MANUAL` (RN-TR-08); POL-09. */
    estimatedTotalValue: termMoneySchema.optional(),
    estimatedValueSource: z.enum(TERM_ESTIMATED_VALUE_SOURCES).optional(),
    /** RN-TR-28: vigência de 1 a 120 meses. */
    contractDurationMonths: intRange(
      TERM_CONDITION_LIMITS.contractDurationMin,
      TERM_CONDITION_LIMITS.contractDurationMax,
      TERM_CONDITION_MESSAGES.durationRange,
    )
      .nullable()
      .optional(),
    /** RN-TR-29: > 0; exige `executionDeadlineType`. */
    executionDeadline: intRange(
      TERM_CONDITION_LIMITS.executionDeadlineMin,
      TERM_CONDITION_LIMITS.executionDeadlineMax,
      TERM_CONDITION_MESSAGES.deadlineRange,
    )
      .nullable()
      .optional(),
    executionDeadlineType: z.enum(DAY_COUNT_TYPES).nullable().optional(),
    deliveryLocation: z
      .string()
      .trim()
      .max(TERM_CONDITION_LIMITS.deliveryLocationMax, {
        error: TERM_CONDITION_MESSAGES.deliveryLocationLength,
      })
      .nullable()
      .optional(),
    /** RN-TR-30: 1 a 90 dias. */
    paymentTermDays: intRange(
      TERM_CONDITION_LIMITS.paymentTermMin,
      TERM_CONDITION_LIMITS.paymentTermMax,
      TERM_CONDITION_MESSAGES.paymentRange,
    )
      .nullable()
      .optional(),
    /** RN-TR-31: 0 a 120 meses. */
    productWarrantyMonths: intRange(
      TERM_CONDITION_LIMITS.productWarrantyMin,
      TERM_CONDITION_LIMITS.productWarrantyMax,
      TERM_CONDITION_MESSAGES.warrantyRange,
    )
      .nullable()
      .optional(),
    /** RN-TR-31: 0 a 10 % (arts. 96–98). */
    contractGuaranteePercent: termGuaranteePercentSchema.nullable().optional(),
    allowsSubcontracting: z.boolean().optional(),
    /** RN-TR-32: item ativo do catálogo `JUDGMENT_CRITERION` do tenant (art. 33). */
    selectionCriterionId: z
      .uuid({ error: TERM_CONDITION_MESSAGES.criterionInvalid })
      .nullable()
      .optional(),
    awardType: z.enum(AWARD_TYPES).nullable().optional(),
  })
  .meta({ id: 'TermPatchRequest' });
export type TermPatch = z.infer<typeof termPatchSchema>;

/** Pesquisa de preços como o TR a mostra (origem do valor — "Pesquisa de preços {code}"). */
export const termPriceResearchRefSchema = z
  .object({
    id: z.uuid(),
    code: z.string().nullable(),
    status: z.enum(DOCUMENT_STATUSES),
    /** Total da pesquisa; `null` se mascarado (POL-09) ou ainda não calculado. */
    totalEstimatedValue: z.string().nullable(),
    completed: z.boolean(),
  })
  .meta({ id: 'TermPriceResearchRef' });
export type TermPriceResearchRefDto = z.infer<typeof termPriceResearchRefSchema>;

/** TR como o TRM-02/04 o devolve (api/09-term-of-reference.md `Term`). */
export const termSchema = z
  .object({
    /** = `documentId` (CHECK `terms_of_reference_id_is_document`). */
    id: z.uuid(),
    documentId: z.uuid(),
    processId: z.uuid(),
    code: z.string().nullable(),
    title: z.string(),
    status: z.enum(DOCUMENT_STATUSES),
    /** Selo "Em aprovação" (DEC-018). */
    inApproval: z.boolean(),
    templateVersion: z.object({ id: z.uuid(), versionNumber: z.int() }).nullable(),
    responsibleId: z.uuid().nullable(),
    objectDefinition: z.string(),
    contractDurationMonths: z.int().nullable(),
    executionDeadline: z.int().nullable(),
    executionDeadlineType: z.enum(DAY_COUNT_TYPES).nullable(),
    deliveryLocation: z.string().nullable(),
    paymentTermDays: z.int().nullable(),
    productWarrantyMonths: z.int().nullable(),
    contractGuaranteePercent: z.string().nullable(),
    allowsSubcontracting: z.boolean().nullable(),
    selectionCriterionId: z.uuid().nullable(),
    awardType: z.enum(AWARD_TYPES).nullable(),
    /** Decimal(18,2) como string; `null` se não informado ou mascarado (POL-09). */
    estimatedTotalValue: z.string().nullable(),
    estimatedTotalValueMasked: z.boolean(),
    estimatedValueSource: z.enum(TERM_ESTIMATED_VALUE_SOURCES).nullable(),
    priceResearchId: z.uuid().nullable(),
    importedFromEtpId: z.uuid().nullable(),
    importedFromEtpVersionId: z.uuid().nullable(),
    importedAt: isoDateTimeSchema.nullable(),
    importedById: z.uuid().nullable(),
    /** `version` do documento (o `If-Match` de DOC-07). */
    documentVersion: z.int(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    /** `version` do TR (o `ETag` e o `If-Match` do TRM-04). */
    version: z.int(),
  })
  .meta({ id: 'Term' });
export type TermDto = z.infer<typeof termSchema>;

export const termMetaSchema = z
  .object({ allowedActions: z.array(z.enum(DOCUMENT_ACTIONS)) })
  .meta({ id: 'TermMeta' });
export type TermMeta = z.infer<typeof termMetaSchema>;

/** TRM-01 — uma linha por TR do processo (0 ou 1 ativo + os cancelados). */
export const termSummarySchema = z
  .object({
    id: z.uuid(),
    documentId: z.uuid(),
    code: z.string().nullable(),
    status: z.enum(DOCUMENT_STATUSES),
    title: z.string(),
    version: z.int(),
  })
  .meta({ id: 'TermSummary' });
export type TermSummaryDto = z.infer<typeof termSummarySchema>;

/** Modelo de TR publicado para o diálogo de criação (FA-01). */
export const termTemplateOptionSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    isDefault: z.boolean(),
    versionId: z.uuid(),
    versionNumber: z.int(),
  })
  .meta({ id: 'TermTemplateOption' });
export type TermTemplateOptionDto = z.infer<typeof termTemplateOptionSchema>;

/** `meta` do TRM-01: modelos publicados (o padrão primeiro) e o título padrão do diálogo. */
export const termListMetaSchema = z
  .object({
    templates: z.array(termTemplateOptionSchema),
    defaultTitle: z.string(),
  })
  .meta({ id: 'TermListMeta' });
export type TermListMeta = z.infer<typeof termListMetaSchema>;

/** Completude exibida (RN-TR-13): exigidas satisfeitas ÷ exigidas — a mesma avaliação do DOC-08. */
export const termCompletenessSchema = z
  .object({
    required: z.int().min(0),
    satisfied: z.int().min(0),
    /** 0–100, arredondado para baixo. */
    percent: z.int().min(0).max(100),
    sections: z.array(z.object({ key: z.string(), complete: z.boolean() })),
  })
  .meta({ id: 'TermCompleteness' });
export type TermCompletenessDto = z.infer<typeof termCompletenessSchema>;

/**
 * TRM-03: o `Term` + o rascunho por seção (`draftContent.sections[key]` com `content`, `state`,
 * `justification` e `revision` — o `If-Match: "s<revision>"` do DOC-05), a completude e as
 * pesquisas (a vinculada e a concluída do processo — o aviso de FA-04), com POL-09.
 */
export const termDetailSchema = termSchema
  .extend({
    draftRevision: z.int().min(0),
    draftContent: draftContentSchema,
    completeness: termCompletenessSchema,
    priceResearch: termPriceResearchRefSchema.nullable(),
    completedPriceResearch: termPriceResearchRefSchema.nullable(),
    /** Calculado (RN-TR-24 — US-037): a versão vigente do ETP é outra que a importada. */
    etpChangedSinceImport: z.boolean(),
  })
  .meta({ id: 'TermDetail' });
export type TermDetailDto = z.infer<typeof termDetailSchema>;

/** Seção da versão do template FIXADA no TR, como a SCR-012 a usa (navegação e editor). */
export const termTemplateSectionSchema = z
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
  .meta({ id: 'TermTemplateSection' });
export type TermTemplateSectionDto = z.infer<typeof termTemplateSectionSchema>;

export const termDetailMetaSchema = z
  .object({
    allowedActions: z.array(z.enum(DOCUMENT_ACTIONS)),
    template: z
      .object({
        versionId: z.uuid(),
        versionNumber: z.int(),
        sections: z.array(termTemplateSectionSchema),
      })
      .nullable(),
  })
  .meta({ id: 'TermDetailMeta' });
export type TermDetailMeta = z.infer<typeof termDetailMetaSchema>;
