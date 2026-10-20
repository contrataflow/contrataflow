import { z } from 'zod';

import { isoDateSchema, isoDateTimeSchema } from '../common/dates.js';
import { uuidV7Schema } from '../common/identifiers.js';
import { sectionAuthorSchema } from '../document/document-section.js';
import { DOCUMENT_STATUSES } from '../document/document-type.js';
import { DOCUMENT_ACTIONS } from '../document/document.js';
import { SECTION_REQUIREMENTS } from '../document/template.js';
import {
  estimatedValueSchema,
  PCA_STATUSES,
  PRIORITIES,
  PROCESS_LIMITS,
} from '../process/process.js';
import type { PcaStatus, Priority } from '../process/process.js';

/*
 * DFD — Documento de Formalização da Demanda (US-014 · entities.md §4.8 `Dfd` · api/05-dfd.md
 * DFD-01..03 · Decreto 10.947/2022, art. 8º). O cabeçalho tipado 1:1 do `Document` do tipo `DFD`;
 * seções `JUSTIFICATION`/`EXPECTED_RESULTS`/`NOTES` no rascunho do documento e itens em
 * `DocumentItem`. Os mesmos schemas servem à API (corpo, resposta, OpenAPI) e ao wizard SCR-007.
 */

/** `DfdWizardStep` (entities.md §2 · RN-DFD-21): a ordem do wizard. */
export const DFD_WIZARD_STEPS = [
  'IDENTIFICATION',
  'JUSTIFICATION',
  'PLANNING',
  'REVIEW',
  'CONCLUSION',
] as const;
export type DfdWizardStep = (typeof DFD_WIZARD_STEPS)[number];

/** Seções do template DFD semeado (RN-DFD-07); o órgão pode acrescentar outras (DEC-016). */
export const DFD_SECTION_KEYS = ['JUSTIFICATION', 'EXPECTED_RESULTS', 'NOTES'] as const;

export const DFD_LIMITS = Object.freeze({
  objectSummaryMin: PROCESS_LIMITS.objectMin,
  objectSummaryMax: PROCESS_LIMITS.objectMax,
  pcaItemCodeMax: PROCESS_LIMITS.pcaItemCodeMax,
  pcaJustificationMin: PROCESS_LIMITS.pcaJustificationMin,
  pcaJustificationMax: PROCESS_LIMITS.pcaJustificationMax,
  /** `Document.title` = "DFD — {título do processo}" truncado (RN-DFD-06). */
  titleMax: 250,
});

/** Mensagens do DFD (V-01..V-13 e RN-DFD-18) compartilhadas pela API e pelo wizard. */
export const DFD_MESSAGES = Object.freeze({
  templateInvalid: 'Selecione um modelo de DFD válido.',
  alreadyExists: (code: string | null) =>
    code === null ? 'Este processo já possui um DFD.' : `Este processo já possui o ${code}.`,
  typeNotAllowedInStage: 'O DFD não pode ser elaborado na etapa atual do processo.',
  notCustodian: 'Somente quem está com o processo pode realizar esta ação.',
  permissionDenied: 'Você não tem permissão para elaborar o DFD deste processo.',
  notFound: 'DFD não encontrado.',
  duplicateTargetInvalid: 'Selecione um processo válido.',
  duplicateTargetRequired: 'Selecione o processo que receberá o DFD.',
  duplicateTargetNotAllowed: 'Informe o processo apenas ao duplicar para um processo existente.',
  duplicateNotAllowedInStage: 'Este processo não aceita DFD na etapa atual.',
  duplicatePermissionDenied: 'Você não pode duplicar o DFD para este destino.',
  requestDateRequired: 'Informe a data do DFD.',
  requestDateFuture: 'A data do DFD não pode ser futura.',
  departmentRequired: 'Informe o setor.',
  departmentNotInSecretariat: 'O setor deve pertencer à secretaria solicitante do processo.',
  responsibleRequired: 'Informe o responsável pela demanda.',
  responsibleInactive: 'Selecione um responsável com acesso ativo ao órgão.',
  objectRequired: 'Informe o objeto.',
  objectLength: `O objeto deve ter entre ${DFD_LIMITS.objectSummaryMin} e ${DFD_LIMITS.objectSummaryMax.toLocaleString('pt-BR')} caracteres.`,
  priorityRequired: 'Informe a prioridade.',
  expectedDateRequired: 'Informe a data pretendida para a contratação.',
  expectedDateBeforeRequest: 'A previsão deve ser igual ou posterior à data do DFD.',
  expectedDatePast: 'A data pretendida para a contratação não pode ser anterior a hoje.',
  estimatedValueRequired: 'Informe a estimativa preliminar do valor.',
  estimatedValueInvalid: 'Informe um valor válido, com até 2 casas decimais.',
  pcaStatusRequired: 'Informe a situação no PCA.',
  pcaYearRequired: 'Informe o exercício do PCA.',
  pcaYearRange: 'O exercício do PCA deve ser o ano corrente ou o seguinte.',
  pcaItemCodeLength: `O item do PCA deve ter no máximo ${DFD_LIMITS.pcaItemCodeMax} caracteres.`,
  pcaJustificationRequired:
    'Justifique por que a demanda não está prevista no PCA (mín. 20 caracteres).',
  pcaJustificationTooLong: `A justificativa deve ter no máximo ${DFD_LIMITS.pcaJustificationMax.toLocaleString('pt-BR')} caracteres.`,
  itemsRequired: 'Informe ao menos um item com quantidade.',
  departmentInactive: 'O setor escolhido foi desativado. Escolha outro setor.',
  attachmentsPending: (count: number) =>
    count === 1
      ? 'Há 1 anexo em verificação de segurança.'
      : `Há ${count} anexos em verificação de segurança.`,
});

// --- Contratos ---------------------------------------------------------------------------------

/** DFD-02 — `POST /processes/{id}/dfds` (`Idempotency-Key` obrigatório). */
export const dfdCreateSchema = z
  .strictObject({
    /** Ativo, tipo `DFD`, com versão publicada; padrão: o template padrão do tipo (RN-DFD-03). */
    templateId: uuidV7Schema.optional(),
  })
  .meta({ id: 'DfdCreateRequest' });
export type DfdCreate = z.infer<typeof dfdCreateSchema>;

/** `targetType` da duplicação (RN-DFD-72/73). */
export const DFD_DUPLICATE_TARGETS = ['NEW_PROCESS', 'EXISTING_PROCESS'] as const;
export type DfdDuplicateTarget = (typeof DFD_DUPLICATE_TARGETS)[number];

/**
 * DFD-05 — `POST /dfds/{id}/duplicate` (US-018 · `Idempotency-Key` obrigatório): `targetProcessId`
 * obrigatório para `EXISTING_PROCESS` e proibido para `NEW_PROCESS`.
 */
export const dfdDuplicateSchema = z
  .strictObject({
    targetType: z.enum(DFD_DUPLICATE_TARGETS),
    targetProcessId: uuidV7Schema.optional(),
  })
  .superRefine((value, context) => {
    if (value.targetType === 'EXISTING_PROCESS' && value.targetProcessId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['targetProcessId'],
        message: DFD_MESSAGES.duplicateTargetRequired,
        params: { code: 'REQUIRED' },
      });
    }
    if (value.targetType === 'NEW_PROCESS' && value.targetProcessId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['targetProcessId'],
        message: DFD_MESSAGES.duplicateTargetNotAllowed,
        params: { code: 'NOT_ALLOWED' },
      });
    }
  })
  .meta({ id: 'DfdDuplicateRequest' });
export type DfdDuplicate = z.infer<typeof dfdDuplicateSchema>;

export const dfdIdParamsSchema = z.strictObject({ id: uuidV7Schema });

/** `Dfd` (DFD-02/03): cabeçalho tipado + resumo do documento (`ETag: "<version>"`). */
export const dfdSchema = z
  .object({
    id: z.uuid(),
    documentId: z.uuid(),
    processId: z.uuid(),
    code: z.string().nullable(),
    title: z.string(),
    status: z.enum(DOCUMENT_STATUSES),
    templateVersionId: z.uuid().nullable(),
    /** `Document.version` — o `If-Match` do DOC-07 (itens). */
    documentVersion: z.int(),
    draftRevision: z.int(),
    requestDate: isoDateSchema,
    requestingDepartmentId: z.uuid(),
    responsibleId: z.uuid(),
    objectSummary: z.string(),
    priority: z.enum(PRIORITIES),
    expectedDate: isoDateSchema.nullable(),
    /** Decimal(18,2) como string; `null` quando vazio ou mascarado (POL-09 · RN-DFD-16). */
    estimatedValue: z.string().nullable(),
    estimatedValueMasked: z.boolean(),
    pcaStatus: z.enum(PCA_STATUSES),
    pcaYear: z.int().nullable(),
    pcaItemCode: z.string().nullable(),
    pcaJustification: z.string().nullable(),
    wizardStep: z.enum(DFD_WIZARD_STEPS),
    completedSteps: z.array(z.enum(DFD_WIZARD_STEPS)),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    version: z.int(),
  })
  .meta({ id: 'Dfd' });
export type DfdDto = z.infer<typeof dfdSchema>;

/** Seção da versão do template como o wizard a exibe (orientação e base legal — SCR-007). */
export const dfdTemplateSectionSchema = z.object({
  key: z.string(),
  title: z.string(),
  order: z.int(),
  requirement: z.enum(SECTION_REQUIREMENTS),
  helpText: z.string().nullable(),
  legalBasis: z.string().nullable(),
  minChars: z.int().nullable(),
  maxChars: z.int(),
});
export type DfdTemplateSectionDto = z.infer<typeof dfdTemplateSectionSchema>;

/**
 * `meta` do DFD-02/03: as ações do documento (RN-DOC-18 — a mesma função do painel) e a versão do
 * template FIXADA no documento (seções, `helpText`, `legalBasis` e `fieldConfig`). Vem aqui porque o
 * TPL-07 exige `TEMPLATE_VIEW`, que a área requisitante não tem.
 */
/** Desfechos da decisão de aprovação que o DFD exibe (US-017 · `DecisionBanner`). */
export const DFD_DECISION_OUTCOMES = ['APPROVED', 'RETURNED', 'REJECTED'] as const;
export type DfdDecisionOutcome = (typeof DFD_DECISION_OUTCOMES)[number];

/**
 * DFD-03 `meta.decision` (US-017): a decisão mais recente de uma aprovação que cobriu o DFD — o
 * desfecho, o motivo informado pelo aprovador e quem decidiu. `null` = nunca decidido.
 */
export const dfdDecisionSchema = z
  .object({
    approvalId: z.uuid(),
    outcome: z.enum(DFD_DECISION_OUTCOMES),
    comment: z.string().nullable(),
    decidedAt: isoDateTimeSchema,
    decidedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  })
  .meta({ id: 'DfdDecision' });
export type DfdDecisionDto = z.infer<typeof dfdDecisionSchema>;

export const dfdMetaSchema = z
  .object({
    allowedActions: z.array(z.enum(DOCUMENT_ACTIONS)),
    /** Só no DFD-03 (US-017); as demais respostas omitem. */
    decision: dfdDecisionSchema.nullable().optional(),
    template: z
      .object({
        versionId: z.uuid(),
        versionNumber: z.int(),
        sections: z.array(dfdTemplateSectionSchema),
        fieldConfig: z.record(
          z.string(),
          z.object({ label: z.string().optional(), required: z.boolean().optional() }),
        ),
      })
      .nullable(),
  })
  .meta({ id: 'DfdMeta' });
export type DfdMeta = z.infer<typeof dfdMetaSchema>;

/** DFD-01: resumo (0 ou 1 ativo + cancelados). */
export const dfdSummarySchema = z
  .object({
    id: z.uuid(),
    documentId: z.uuid(),
    code: z.string().nullable(),
    status: z.enum(DOCUMENT_STATUSES),
    requestDate: isoDateSchema,
    priority: z.enum(PRIORITIES),
    version: z.int(),
  })
  .meta({ id: 'DfdSummary' });
export type DfdSummaryDto = z.infer<typeof dfdSummarySchema>;

// --- Cabeçalho (validação por passo no wizard — V-05/V-06/V-08/V-12/V-13) -------------------

/** Valores do cabeçalho como o wizard os edita (strings vazias = não informado). */
export interface DfdHeaderValues {
  readonly requestDate: string | null;
  readonly requestingDepartmentId: string | null;
  readonly responsibleId: string | null;
  readonly objectSummary: string | null;
  readonly priority: Priority | null;
  readonly expectedDate: string | null;
  readonly estimatedValue: string | null;
  /** POL-09: o valor não é visível ao usuário (não é conferido nem editável). */
  readonly estimatedValueMasked?: boolean;
  readonly pcaStatus: PcaStatus | null;
  readonly pcaYear: number | null;
  readonly pcaItemCode: string | null;
  readonly pcaJustification: string | null;
}

export type DfdHeaderField = Exclude<keyof DfdHeaderValues, 'estimatedValueMasked'>;

/** Campos do cabeçalho por passo do wizard (os demais passos não têm campos tipados). */
export const DFD_STEP_FIELDS: Readonly<Record<DfdWizardStep, readonly DfdHeaderField[]>> = {
  IDENTIFICATION: [
    'requestDate',
    'requestingDepartmentId',
    'responsibleId',
    'objectSummary',
    'priority',
  ],
  JUSTIFICATION: [],
  PLANNING: [
    'expectedDate',
    'estimatedValue',
    'pcaStatus',
    'pcaYear',
    'pcaItemCode',
    'pcaJustification',
  ],
  REVIEW: [],
  CONCLUSION: [],
};

/** RN-DFD-08: sempre obrigatórios (os demais seguem o `fieldConfig` do template). */
export const DFD_ALWAYS_REQUIRED_FIELDS: readonly DfdHeaderField[] = [
  'requestDate',
  'requestingDepartmentId',
  'responsibleId',
  'objectSummary',
  'priority',
  'pcaStatus',
];

const REQUIRED_MESSAGES: Readonly<Partial<Record<DfdHeaderField, string>>> = {
  requestDate: DFD_MESSAGES.requestDateRequired,
  requestingDepartmentId: DFD_MESSAGES.departmentRequired,
  responsibleId: DFD_MESSAGES.responsibleRequired,
  objectSummary: DFD_MESSAGES.objectRequired,
  priority: DFD_MESSAGES.priorityRequired,
  expectedDate: DFD_MESSAGES.expectedDateRequired,
  estimatedValue: DFD_MESSAGES.estimatedValueRequired,
  pcaStatus: DFD_MESSAGES.pcaStatusRequired,
};

/** Mensagem de "Informe o …" do campo obrigatório vazio (V-05). */
export function dfdRequiredMessage(field: string): string {
  return REQUIRED_MESSAGES[field as DfdHeaderField] ?? 'Preencha este campo.';
}

/** `fieldConfig` do template, como a validação o lê (lacuna 1 da US-014). */
export type DfdFieldConfig = Readonly<
  Record<string, { readonly required?: boolean | undefined; readonly label?: string | undefined }>
>;

/**
 * Padrão do módulo para os campos configuráveis (RN-DFD-08): previsão obrigatória e estimativa
 * opcional. O template semeado traz `fieldConfig = {}` (RN-TPL-31 — "os padrões do módulo até o
 * tenant personalizar"); o órgão muda a obrigatoriedade em nova versão do template.
 */
export const DFD_CONFIGURABLE_REQUIRED_DEFAULTS = Object.freeze({
  expectedDate: true,
  estimatedValue: false,
});

/** Campos obrigatórios do DFD: os de RN-DFD-08 + os configuráveis (`fieldConfig` ou padrão). */
export function dfdRequiredFields(fieldConfig: DfdFieldConfig): DfdHeaderField[] {
  const required = new Set<DfdHeaderField>(DFD_ALWAYS_REQUIRED_FIELDS);
  for (const field of ['expectedDate', 'estimatedValue'] as const) {
    if (fieldConfig[field]?.required ?? DFD_CONFIGURABLE_REQUIRED_DEFAULTS[field]) {
      required.add(field);
    }
  }
  return [...required];
}

const isBlank = (value: unknown) =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

/** Ano de uma data ISO (`AAAA-MM-DD`). */
const yearOf = (date: string) => Number(date.slice(0, 4));

/**
 * Problemas de formato e de obrigatoriedade dos campos do passo, por campo (V-05/V-08/V-12/V-13 —
 * "Continuar" do wizard). Datas comparadas como `AAAA-MM-DD` com `today` no fuso do tenant.
 * Os mesmos limites que a API aplica no DFD-04 (US-015).
 */
export function dfdStepIssues(
  step: DfdWizardStep,
  header: DfdHeaderValues,
  context: { readonly fieldConfig: DfdFieldConfig; readonly today: string },
): Partial<Record<DfdHeaderField, string>> {
  const fields = new Set(DFD_STEP_FIELDS[step]);
  const required = new Set(dfdRequiredFields(context.fieldConfig));
  const issues: Partial<Record<DfdHeaderField, string>> = {};
  for (const field of fields) {
    if (field === 'estimatedValue' && header.estimatedValueMasked === true) continue;
    if (required.has(field) && isBlank(header[field])) issues[field] = dfdRequiredMessage(field);
  }
  const has = (field: DfdHeaderField) => fields.has(field) && issues[field] === undefined;
  if (has('requestDate') && header.requestDate && header.requestDate > context.today) {
    issues.requestDate = DFD_MESSAGES.requestDateFuture;
  }
  const summary = header.objectSummary?.trim() ?? '';
  if (
    has('objectSummary') &&
    summary !== '' &&
    (summary.length < DFD_LIMITS.objectSummaryMin || summary.length > DFD_LIMITS.objectSummaryMax)
  ) {
    issues.objectSummary = DFD_MESSAGES.objectLength;
  }
  if (has('expectedDate') && header.expectedDate) {
    if (header.requestDate && header.expectedDate < header.requestDate) {
      issues.expectedDate = DFD_MESSAGES.expectedDateBeforeRequest;
    }
  }
  if (
    has('estimatedValue') &&
    header.estimatedValueMasked !== true &&
    !isBlank(header.estimatedValue) &&
    !estimatedValueSchema.safeParse(header.estimatedValue?.trim()).success
  ) {
    issues.estimatedValue = DFD_MESSAGES.estimatedValueInvalid;
  }
  if (has('pcaItemCode') && (header.pcaItemCode?.trim().length ?? 0) > DFD_LIMITS.pcaItemCodeMax) {
    issues.pcaItemCode = DFD_MESSAGES.pcaItemCodeLength;
  }
  if (fields.has('pcaYear') && header.pcaStatus === 'PLANNED') {
    const currentYear = yearOf(context.today);
    if (header.pcaYear === null) issues.pcaYear = DFD_MESSAGES.pcaYearRequired;
    else if (header.pcaYear !== currentYear && header.pcaYear !== currentYear + 1) {
      issues.pcaYear = DFD_MESSAGES.pcaYearRange;
    }
  }
  if (fields.has('pcaJustification') && header.pcaStatus === 'NOT_PLANNED') {
    if ((header.pcaJustification?.trim().length ?? 0) < DFD_LIMITS.pcaJustificationMin) {
      issues.pcaJustification = DFD_MESSAGES.pcaJustificationRequired;
    }
  }
  return issues;
}

/**
 * RN-DFD-06: `Document.title` = "DFD — {título do processo}", truncado em 250 caracteres (com
 * reticências quando corta).
 */
export function dfdDocumentTitle(processTitle: string): string {
  const title = `DFD — ${processTitle.trim()}`;
  return title.length <= DFD_LIMITS.titleMax
    ? title
    : `${title.slice(0, DFD_LIMITS.titleMax - 1)}…`;
}

/** Ordem de gravidade da prioridade (dica "elevará a prioridade do processo" — US-017). */
export const PRIORITY_RANK: Readonly<Record<Priority, number>> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  URGENT: 3,
};

// --- DFD-04: gravação parcial do cabeçalho (US-015 · RN-DFD-27/28) ----------------------------

/** Campos editáveis do cabeçalho pelo `PATCH` (RN-DFD-27); `processId`/`documentId` → `NOT_ALLOWED`. */
export const DFD_PATCH_FIELDS = [
  'requestDate',
  'requestingDepartmentId',
  'responsibleId',
  'objectSummary',
  'priority',
  'expectedDate',
  'estimatedValue',
  'pcaStatus',
  'pcaYear',
  'pcaItemCode',
  'pcaJustification',
  'wizardStep',
  'completedSteps',
] as const;
export type DfdPatchField = (typeof DFD_PATCH_FIELDS)[number];

/**
 * Campos de texto livre do cabeçalho: auditoria coalescida (`document.draft_update`, RN-DFD-35) e
 * só como hash + tamanho. Os demais campos de dados (datas, prioridade, setor, responsável, PCA,
 * estimativa) são auditados de imediato com `changes`; o passo do wizard não é auditado.
 */
export const DFD_TEXT_FIELDS: readonly DfdPatchField[] = ['objectSummary', 'pcaJustification'];
export const DFD_WIZARD_FIELDS: readonly DfdPatchField[] = ['wizardStep', 'completedSteps'];

/**
 * DFD-04 — `PATCH /dfds/{id}` com `If-Match: "<version>"` e APENAS os campos alterados (o
 * `useAutosave` agrupa os campos do passo). Forma e enumerações aqui; regras de campo em
 * `dfdPatchIssues` e as de referência (setor da secretaria, responsável ativo) no caso de uso.
 * Os campos sempre obrigatórios (RN-DFD-08) não aceitam `null`.
 */
export const dfdPatchSchema = z
  .strictObject({
    requestDate: isoDateSchema.optional(),
    requestingDepartmentId: z.uuid().optional(),
    responsibleId: z.uuid().optional(),
    objectSummary: z.string().optional(),
    priority: z.enum(PRIORITIES).optional(),
    expectedDate: isoDateSchema.nullable().optional(),
    estimatedValue: estimatedValueSchema.nullable().optional(),
    pcaStatus: z.enum(PCA_STATUSES).optional(),
    pcaYear: z.int().nullable().optional(),
    pcaItemCode: z.string().nullable().optional(),
    pcaJustification: z.string().nullable().optional(),
    wizardStep: z.enum(DFD_WIZARD_STEPS).optional(),
    completedSteps: z.array(z.enum(DFD_WIZARD_STEPS)).max(DFD_WIZARD_STEPS.length).optional(),
  })
  .meta({ id: 'DfdPatchRequest' });
export type DfdPatch = z.infer<typeof dfdPatchSchema>;

/**
 * `meta.current` do 412 `VERSION_CONFLICT` do DFD-04 (FA-02): o DFD como está no servidor e quem o
 * gravou por último ("Alteração de {nome} às HH:mm"). O cliente compara com a sua base para saber
 * quais campos o servidor alterou (merge automático — RN-DFD-28).
 */
export const dfdConflictCurrentSchema = dfdSchema
  .extend({ updatedBy: sectionAuthorSchema.nullable() })
  .meta({ id: 'DfdConflictCurrent' });
export type DfdConflictCurrent = z.infer<typeof dfdConflictCurrentSchema>;

/** Erro de campo do DFD-04 (`errors[]` do `VALIDATION_ERROR` — api.md §2.1.1). */
export interface DfdFieldIssue {
  readonly field: DfdPatchField;
  readonly code:
    | 'REQUIRED'
    | 'TOO_SHORT'
    | 'TOO_LONG'
    | 'OUT_OF_RANGE'
    | 'DATE_IN_PAST'
    | 'CONDITIONAL_REQUIRED';
  readonly message: string;
}

/**
 * Grupos de campos que o banco confere juntos (CHECKs de `dfds`): o autosave grava o grupo inteiro
 * ou nada — previsão ≥ data do DFD; exercício com `PLANNED`; justificativa com `NOT_PLANNED`.
 */
export const DFD_FIELD_GROUPS: readonly (readonly DfdPatchField[])[] = [
  ['requestDate', 'expectedDate'],
  ['pcaStatus', 'pcaYear', 'pcaItemCode', 'pcaJustification'],
];

const isBlankText = (value: string | null | undefined) =>
  value === null || value === undefined || value.trim() === '';

/**
 * Regras de campo do DFD-04 (RN-DFD-09..16 — os limites do wizard, `dfdStepIssues`): conferidas
 * nos campos enviados, para o autosave gravar campo a campo. Os pares que o banco garante (CHECKs
 * de `dfds`) são conferidos no cabeçalho mesclado (`merged` = atual + patch) quando um dos lados foi
 * enviado: previsão ≥ data do DFD, exercício presente com `PLANNED` e justificativa presente com
 * `NOT_PLANNED`. O mínimo de 20 caracteres da justificativa e os campos configuráveis vazios ficam
 * com a completude (`evaluateDfdCompleteness`) — um rascunho pode estar incompleto. `today` no fuso
 * do tenant.
 */
export function dfdPatchIssues(
  patch: DfdPatch,
  merged: Pick<
    DfdHeaderValues,
    'requestDate' | 'expectedDate' | 'pcaStatus' | 'pcaYear' | 'pcaJustification'
  >,
  context: { readonly today: string },
): DfdFieldIssue[] {
  const issues: DfdFieldIssue[] = [];
  const sent = (field: DfdPatchField) => patch[field] !== undefined;
  if (patch.requestDate !== undefined && patch.requestDate > context.today) {
    issues.push({
      field: 'requestDate',
      code: 'OUT_OF_RANGE',
      message: DFD_MESSAGES.requestDateFuture,
    });
  }
  if (patch.objectSummary !== undefined) {
    const length = patch.objectSummary.trim().length;
    if (length === 0) {
      issues.push({
        field: 'objectSummary',
        code: 'REQUIRED',
        message: DFD_MESSAGES.objectRequired,
      });
    } else if (length < DFD_LIMITS.objectSummaryMin || length > DFD_LIMITS.objectSummaryMax) {
      issues.push({
        field: 'objectSummary',
        code: length < DFD_LIMITS.objectSummaryMin ? 'TOO_SHORT' : 'TOO_LONG',
        message: DFD_MESSAGES.objectLength,
      });
    }
  }
  if (
    (sent('requestDate') || sent('expectedDate')) &&
    merged.expectedDate &&
    merged.requestDate &&
    merged.expectedDate < merged.requestDate
  ) {
    issues.push({
      field: sent('expectedDate') ? 'expectedDate' : 'requestDate',
      code: 'OUT_OF_RANGE',
      message: DFD_MESSAGES.expectedDateBeforeRequest,
    });
  } else if (patch.expectedDate && patch.expectedDate < context.today) {
    issues.push({
      field: 'expectedDate',
      code: 'DATE_IN_PAST',
      message: DFD_MESSAGES.expectedDatePast,
    });
  }
  if (patch.pcaYear !== undefined && patch.pcaYear !== null) {
    const currentYear = yearOf(context.today);
    if (patch.pcaYear !== currentYear && patch.pcaYear !== currentYear + 1) {
      issues.push({ field: 'pcaYear', code: 'OUT_OF_RANGE', message: DFD_MESSAGES.pcaYearRange });
    }
  }
  if (
    (sent('pcaStatus') || sent('pcaYear')) &&
    merged.pcaStatus === 'PLANNED' &&
    merged.pcaYear === null
  ) {
    issues.push({
      field: 'pcaYear',
      code: 'CONDITIONAL_REQUIRED',
      message: DFD_MESSAGES.pcaYearRequired,
    });
  }
  if ((patch.pcaItemCode?.trim().length ?? 0) > DFD_LIMITS.pcaItemCodeMax) {
    issues.push({
      field: 'pcaItemCode',
      code: 'TOO_LONG',
      message: DFD_MESSAGES.pcaItemCodeLength,
    });
  }
  if ((patch.pcaJustification?.trim().length ?? 0) > DFD_LIMITS.pcaJustificationMax) {
    issues.push({
      field: 'pcaJustification',
      code: 'TOO_LONG',
      message: DFD_MESSAGES.pcaJustificationTooLong,
    });
  } else if (
    (sent('pcaStatus') || sent('pcaJustification')) &&
    merged.pcaStatus === 'NOT_PLANNED' &&
    isBlankText(merged.pcaJustification)
  ) {
    issues.push({
      field: 'pcaJustification',
      code: 'CONDITIONAL_REQUIRED',
      message: DFD_MESSAGES.pcaJustificationRequired,
    });
  }
  return issues;
}
