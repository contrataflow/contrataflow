import type { FieldErrorCode } from '@contrataflow/types';
import { z } from 'zod';

import { inspectJsonLogic } from './json-logic.js';
import { isRuleContextPath } from './rule-context.js';
import { decimalString } from '../common/decimal.js';
import { uuidV7Schema } from '../common/identifiers.js';
import { trimmedString } from '../common/text.js';
import {
  APPROVER_TYPES,
  DAY_COUNT_TYPES,
  DEPARTMENT_RESOLUTIONS,
  DOCUMENT_TYPE_CODE_PATTERN,
} from '../document/document-type.js';
import { pageQuerySchema } from '../http/pagination.js';

/*
 * Definição de workflow versionada (US-040 · DEC-014 · entities.md §4.5/§5.5 · api/10-workflow.md
 * WF-02..18). Os schemas de entrada (`workflowStageSchema`, `workflowTransitionSchema`,
 * `workflowRuleSchema` e `workflowRuleConfigSchema`) são os mesmos no editor (US-043/US-044) e na
 * API; as regras condicionais ficam em funções puras (`workflow*Issues`) para valer também sobre o
 * resultado de um PATCH parcial.
 */

export const WORKFLOW_VERSION_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type WorkflowVersionStatus = (typeof WORKFLOW_VERSION_STATUSES)[number];

export const STAGE_TYPES = ['START', 'TASK', 'APPROVAL', 'END'] as const;
export type StageType = (typeof STAGE_TYPES)[number];

/** `DepartmentResolution` completo (a etapa aceita `CHOSEN_ON_FORWARD`; o aprovador, não). */
export const STAGE_DEPARTMENT_RESOLUTIONS = [
  'FIXED',
  'REQUESTING_DEPARTMENT',
  'REQUESTING_SECRETARIAT',
  'CHOSEN_ON_FORWARD',
] as const;
export type StageDepartmentResolution = (typeof STAGE_DEPARTMENT_RESOLUTIONS)[number];

export const STAGE_ASSIGNMENT_POLICIES = [
  'UNASSIGNED',
  'CREATOR',
  'DEPARTMENT_HEAD',
  'PREVIOUS_ASSIGNEE',
] as const;
export type StageAssignmentPolicy = (typeof STAGE_ASSIGNMENT_POLICIES)[number];

export const TRANSITION_ACTIONS = ['FORWARD', 'RETURN', 'APPROVE', 'REJECT', 'COMPLETE'] as const;
export type TransitionAction = (typeof TRANSITION_ACTIONS)[number];

/** Ações de avanço (alcançabilidade e terminação — RN-WF-11/12). */
export const ADVANCE_ACTIONS: readonly TransitionAction[] = ['FORWARD', 'APPROVE', 'COMPLETE'];

export const RULE_SCOPES = ['STAGE_EXIT', 'TRANSITION'] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

export const RULE_TYPES = [
  'REQUIRED_DOCUMENT',
  'REQUIRED_FIELD',
  'REQUIRED_APPROVAL',
  'CONDITION',
] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const RULE_SEVERITIES = ['BLOCKING', 'WARNING'] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

export const REQUIRED_DOCUMENT_MIN_STATUSES = [
  'EXISTS',
  'COMPLETE',
  'SUBMITTED',
  'FINAL',
  'APPROVED',
] as const;

/** Limites por versão (RN-WF-18). */
export const WORKFLOW_LIMITS = Object.freeze({
  stages: 50,
  transitions: 200,
  rules: 200,
  instructionsLength: 5000,
  approvalDocumentTypeCodes: 20,
  documentTypeCodes: 30,
  changeNotesLength: 5000,
});

/** RN-WF-02. */
export const WORKFLOW_KEY_PATTERN = /^[A-Z][A-Z0-9_]{2,59}$/;
/** Chave de etapa e de transição (única na versão). */
export const WORKFLOW_ITEM_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,59}$/;
export const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

const KEY_MESSAGE = 'Use letras maiúsculas, números e _ (ex.: ANALISE_TECNICA).';

export const workflowKeySchema = z
  .string({ error: 'Informe a chave do workflow.' })
  .regex(WORKFLOW_KEY_PATTERN, { error: `${KEY_MESSAGE} Mínimo de 3 caracteres.` });
export const workflowItemKeySchema = z
  .string({ error: 'Informe a chave.' })
  .regex(WORKFLOW_ITEM_KEY_PATTERN, { error: KEY_MESSAGE });

const nameSchema = trimmedString({ min: 3, max: 150 });
const longText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Informe no máximo ${max.toLocaleString('pt-BR')} caracteres.` });
const displayOrderSchema = z
  .number()
  .int()
  .min(0, { error: 'A ordem deve ser maior ou igual a 0.' })
  .max(9999, { error: 'A ordem deve ser no máximo 9999.' });
const documentTypeCodeSchema = z
  .string()
  .regex(DOCUMENT_TYPE_CODE_PATTERN, { error: 'Código de tipo de documento inválido.' });
const SLA_MESSAGE = 'O prazo deve estar entre 1 e 365 dias.';
const slaDaysSchema = z
  .number()
  .int({ error: SLA_MESSAGE })
  .min(1, { error: SLA_MESSAGE })
  .max(365, { error: SLA_MESSAGE });
const colorSchema = z.string().regex(COLOR_PATTERN, { error: 'Use uma cor no formato #RRGGBB.' });

const MARKDOWN_LINK = /\]\(\s*<?([^)\s>]*)/g;
// Destino sem `<` (como no CommonMark): com `[^>\s]*`, cada `<a:` sem `>` relia o resto do texto.
const AUTOLINK = /<([a-z][a-z0-9+.-]*:[^<>\s]*)>/gi;
const BARE_URL = /\b(?:https?|ftp|javascript|data|vbscript|file):[^\s)>\]]*/gi;
const HTML_TAG_START = /<\/?[a-z][a-z0-9-]*(?=[\s>])/i;

/**
 * `<tag>` ou `<tag atributos…>` no texto. Basta a primeira abertura: se não houver `>` depois dela,
 * não há depois de nenhuma outra. Sem o `[^>]*` da regex única, que relia o resto do texto a cada
 * `<a ` sem fechamento (CodeQL `js/polynomial-redos`).
 */
function hasHtmlTag(text: string): boolean {
  const start = HTML_TAG_START.exec(text);
  return start !== null && text.includes('>', start.index + start[0].length);
}

/**
 * Markdown restrito das orientações (RN-WF-18): sem HTML bruto e com links somente `https`.
 * Devolve a mensagem do problema ou `null`.
 */
export function restrictedMarkdownProblem(text: string): string | null {
  if (hasHtmlTag(text)) return 'As orientações não podem conter HTML.';
  const targets = [
    ...[...text.matchAll(MARKDOWN_LINK)].map((match) => match[1] ?? ''),
    ...[...text.matchAll(AUTOLINK)].map((match) => match[1] ?? ''),
    ...[...text.matchAll(BARE_URL)].map((match) => match[0]),
  ];
  for (const target of targets) {
    if (target === '' || target.startsWith('#')) continue;
    if (!/^https:\/\/[^\s]+$/i.test(target)) return 'Use somente links https nas orientações.';
  }
  return null;
}

const instructionsSchema = longText(WORKFLOW_LIMITS.instructionsLength).superRefine((text, ctx) => {
  const problem = restrictedMarkdownProblem(text);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

/** Problema de campo das regras condicionais (vira `errors[]` do `VALIDATION_ERROR`). */
export interface WorkflowFieldIssue {
  readonly field: string;
  readonly code: FieldErrorCode;
  readonly message: string;
}

function addIssues(ctx: z.RefinementCtx, issues: readonly WorkflowFieldIssue[]): void {
  for (const issue of issues) {
    ctx.addIssue({
      code: 'custom',
      path: [issue.field],
      message: issue.message,
      params: { code: issue.code },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Workflow (WF-02/03/04)
// ---------------------------------------------------------------------------------------------

export const workflowCreateSchema = z.strictObject({
  key: workflowKeySchema,
  name: nameSchema,
  description: longText(2000).nullish(),
  copyFromVersionId: uuidV7Schema.nullish(),
});
export type WorkflowCreate = z.infer<typeof workflowCreateSchema>;

/** WF-04: só metadados (aplicabilidade e ativação chegam com a US-042/US-045). */
export const workflowUpdateSchema = z
  .strictObject({ name: nameSchema, description: longText(2000).nullable() })
  .partial();
export type WorkflowUpdate = z.infer<typeof workflowUpdateSchema>;

export const workflowIdParamsSchema = z.strictObject({ id: uuidV7Schema });
export const workflowVersionIdParamsSchema = z.strictObject({ versionId: uuidV7Schema });
export const workflowStageIdParamsSchema = z.strictObject({ stageId: uuidV7Schema });
export const workflowTransitionIdParamsSchema = z.strictObject({ transitionId: uuidV7Schema });
export const workflowRuleIdParamsSchema = z.strictObject({ ruleId: uuidV7Schema });

/**
 * WF-08: versão de origem (padrão: a publicada corrente; sem publicada e sem origem informada →
 * 422 `BUSINESS_RULE_VIOLATION` — RN-WF-47).
 */
export const workflowVersionCreateSchema = z
  .strictObject({ sourceVersionId: uuidV7Schema.nullish() })
  .default({});
export type WorkflowVersionCreate = z.infer<typeof workflowVersionCreateSchema>;

/** Primeira versão em que as notas são obrigatórias para publicar (RN-WF-63 · US-045). */
export const CHANGE_NOTES_REQUIRED_FROM_VERSION = 2;
export const CHANGE_NOTES_REQUIRED_MESSAGE = 'Descreva o que mudou nesta versão.';

/** WF-21 (corpo): notas da versão — obrigatórias a partir da v2 (RN-WF-63, conferido na API). */
export const workflowPublishSchema = z
  .strictObject({ changeNotes: longText(WORKFLOW_LIMITS.changeNotesLength).nullish() })
  .default({});
export type WorkflowPublish = z.infer<typeof workflowPublishSchema>;

/**
 * RN-WF-63 (V-02): problema de campo das notas ao publicar a versão `versionNumber` — o mesmo
 * cálculo no diálogo "Publicar" (SCR-034) e no WF-21.
 */
export function workflowPublishIssues(
  versionNumber: number,
  changeNotes: string | null | undefined,
): WorkflowFieldIssue[] {
  if (versionNumber < CHANGE_NOTES_REQUIRED_FROM_VERSION) return [];
  return (changeNotes ?? '').trim() === ''
    ? [
        {
          field: 'changeNotes',
          code: 'CONDITIONAL_REQUIRED',
          message: CHANGE_NOTES_REQUIRED_MESSAGE,
        },
      ]
    : [];
}

// ---------------------------------------------------------------------------------------------
// Etapa (WF-10/11/12)
// ---------------------------------------------------------------------------------------------

/** Campos de definição da etapa (sem identificadores nem colunas de controle). */
export interface WorkflowStageFields {
  readonly key: string;
  readonly name: string;
  readonly instructions: string | null;
  readonly type: StageType;
  readonly groupLabel: string | null;
  readonly displayOrder: number;
  readonly departmentResolution: StageDepartmentResolution;
  readonly fixedDepartmentId: string | null;
  readonly assignmentPolicy: StageAssignmentPolicy;
  readonly approverType: (typeof APPROVER_TYPES)[number] | null;
  readonly approverUserId: string | null;
  readonly approverRoleId: string | null;
  readonly approverDepartmentResolution: (typeof DEPARTMENT_RESOLUTIONS)[number] | null;
  readonly approverFixedDepartmentId: string | null;
  readonly allowDeputy: boolean;
  readonly approvalDocumentTypeCodes: readonly string[];
  readonly documentTypeCodes: readonly string[];
  readonly slaDays: number | null;
  readonly slaType: (typeof DAY_COUNT_TYPES)[number];
  readonly color: string | null;
}

const required = (field: string, message: string): WorkflowFieldIssue => ({
  field,
  code: 'CONDITIONAL_REQUIRED',
  message,
});
const notAllowed = (field: string, message: string): WorkflowFieldIssue => ({
  field,
  code: 'NOT_ALLOWED',
  message,
});

/** RN-WF-08: campos condicionais por tipo de etapa, de unidade e de aprovador. */
export function workflowStageIssues(stage: WorkflowStageFields): WorkflowFieldIssue[] {
  const issues: WorkflowFieldIssue[] = [];
  if (stage.departmentResolution === 'FIXED' && !stage.fixedDepartmentId) {
    issues.push(required('fixedDepartmentId', 'Selecione a unidade responsável.'));
  }
  if (stage.departmentResolution !== 'FIXED' && stage.fixedDepartmentId) {
    issues.push(notAllowed('fixedDepartmentId', 'A unidade fixa só vale para a resolução FIXED.'));
  }
  if (stage.type === 'START' && stage.departmentResolution === 'CHOSEN_ON_FORWARD') {
    issues.push(
      notAllowed(
        'departmentResolution',
        'A etapa inicial não pode ter unidade escolhida no envio.',
      ),
    );
  }
  if (stage.type === 'END' && stage.slaDays !== null) {
    issues.push(notAllowed('slaDays', 'A etapa final não tem prazo.'));
  }
  if (stage.type !== 'APPROVAL') {
    const approverFields = [
      'approverType',
      'approverUserId',
      'approverRoleId',
      'approverDepartmentResolution',
      'approverFixedDepartmentId',
    ] as const;
    for (const field of approverFields) {
      if (stage[field])
        issues.push(notAllowed(field, 'Aprovador só existe em etapa de aprovação.'));
    }
    if (stage.approvalDocumentTypeCodes.length > 0) {
      issues.push(
        notAllowed(
          'approvalDocumentTypeCodes',
          'Documentos cobertos pela aprovação só existem em etapa de aprovação.',
        ),
      );
    }
    return issues;
  }
  if (!stage.approverType) {
    issues.push(required('approverType', 'Selecione quem aprova esta etapa.'));
    return issues;
  }
  const expectsUser = stage.approverType === 'USER';
  const expectsRole = stage.approverType === 'ROLE';
  const expectsHead = stage.approverType === 'DEPARTMENT_HEAD';
  if (expectsUser && !stage.approverUserId) {
    issues.push(required('approverUserId', 'Informe o usuário aprovador.'));
  }
  if (!expectsUser && stage.approverUserId) {
    issues.push(notAllowed('approverUserId', 'O usuário só vale para aprovador USER.'));
  }
  if (expectsRole && !stage.approverRoleId) {
    issues.push(required('approverRoleId', 'Informe o perfil aprovador.'));
  }
  if (!expectsRole && stage.approverRoleId) {
    issues.push(notAllowed('approverRoleId', 'O perfil só vale para aprovador ROLE.'));
  }
  if (expectsHead && !stage.approverDepartmentResolution) {
    issues.push(
      required('approverDepartmentResolution', 'Informe de qual unidade é o titular aprovador.'),
    );
  }
  if (!expectsHead && stage.approverDepartmentResolution) {
    issues.push(
      notAllowed('approverDepartmentResolution', 'A unidade só vale para aprovador titular.'),
    );
  }
  const fixedHead = expectsHead && stage.approverDepartmentResolution === 'FIXED';
  if (fixedHead && !stage.approverFixedDepartmentId) {
    issues.push(required('approverFixedDepartmentId', 'Informe a unidade do titular aprovador.'));
  }
  if (!fixedHead && stage.approverFixedDepartmentId) {
    issues.push(
      notAllowed('approverFixedDepartmentId', 'A unidade fixa só vale para a resolução FIXED.'),
    );
  }
  return issues;
}

const stageBaseShape = {
  name: nameSchema,
  instructions: instructionsSchema.nullable(),
  type: z.enum(STAGE_TYPES),
  groupLabel: longText(60).nullable(),
  displayOrder: displayOrderSchema,
  departmentResolution: z.enum(STAGE_DEPARTMENT_RESOLUTIONS),
  fixedDepartmentId: uuidV7Schema.nullable(),
  assignmentPolicy: z.enum(STAGE_ASSIGNMENT_POLICIES),
  approverType: z.enum(APPROVER_TYPES).nullable(),
  approverUserId: uuidV7Schema.nullable(),
  approverRoleId: uuidV7Schema.nullable(),
  approverDepartmentResolution: z.enum(DEPARTMENT_RESOLUTIONS).nullable(),
  approverFixedDepartmentId: uuidV7Schema.nullable(),
  allowDeputy: z.boolean(),
  approvalDocumentTypeCodes: z
    .array(documentTypeCodeSchema)
    .max(WORKFLOW_LIMITS.approvalDocumentTypeCodes, { error: 'Informe no máximo 20 tipos.' }),
  documentTypeCodes: z
    .array(documentTypeCodeSchema)
    .max(WORKFLOW_LIMITS.documentTypeCodes, { error: 'Informe no máximo 30 tipos.' }),
  slaDays: slaDaysSchema.nullable(),
  slaType: z.enum(DAY_COUNT_TYPES),
  color: colorSchema.nullable(),
};

/** Corpo do WF-10 (com os padrões de entities.md §4.5). `displayOrder` ausente = próximo. */
export const workflowStageSchema = z
  .strictObject({
    key: workflowItemKeySchema,
    name: nameSchema,
    type: z.enum(STAGE_TYPES),
    instructions: stageBaseShape.instructions.optional(),
    groupLabel: stageBaseShape.groupLabel.optional(),
    displayOrder: displayOrderSchema.optional(),
    departmentResolution: stageBaseShape.departmentResolution.default('REQUESTING_DEPARTMENT'),
    fixedDepartmentId: stageBaseShape.fixedDepartmentId.default(null),
    assignmentPolicy: stageBaseShape.assignmentPolicy.default('UNASSIGNED'),
    approverType: stageBaseShape.approverType.default(null),
    approverUserId: stageBaseShape.approverUserId.default(null),
    approverRoleId: stageBaseShape.approverRoleId.default(null),
    approverDepartmentResolution: stageBaseShape.approverDepartmentResolution.default(null),
    approverFixedDepartmentId: stageBaseShape.approverFixedDepartmentId.default(null),
    allowDeputy: z.boolean().default(true),
    approvalDocumentTypeCodes: stageBaseShape.approvalDocumentTypeCodes.default([]),
    documentTypeCodes: stageBaseShape.documentTypeCodes.default([]),
    slaDays: stageBaseShape.slaDays.default(null),
    slaType: stageBaseShape.slaType.default('BUSINESS'),
    color: stageBaseShape.color.default(null),
  })
  .superRefine((stage, ctx) => {
    addIssues(
      ctx,
      workflowStageIssues({
        ...stage,
        instructions: stage.instructions ?? null,
        groupLabel: stage.groupLabel ?? null,
        displayOrder: stage.displayOrder ?? 0,
      }),
    );
  });
export type WorkflowStageCreate = z.infer<typeof workflowStageSchema>;

/** Corpo do WF-11: todos opcionais, exceto `key` (imutável). */
export const workflowStageUpdateSchema = z.strictObject(stageBaseShape).partial();
export type WorkflowStageUpdate = z.infer<typeof workflowStageUpdateSchema>;

// ---------------------------------------------------------------------------------------------
// Transição (WF-13/14/15)
// ---------------------------------------------------------------------------------------------

export interface WorkflowTransitionFields {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly fromStageId: string;
  readonly toStageId: string;
  readonly action: TransitionAction;
  readonly displayOrder: number;
  readonly isPrimary: boolean;
  readonly requiresComment: boolean;
  readonly allowDueDateOverride: boolean;
}

/** RN-WF-09 (parte local): origem diferente do destino. */
export function workflowTransitionIssues(
  transition: Pick<WorkflowTransitionFields, 'fromStageId' | 'toStageId'>,
): WorkflowFieldIssue[] {
  return transition.fromStageId === transition.toStageId
    ? [notAllowed('toStageId', 'A etapa de destino deve ser diferente da etapa de origem.')]
    : [];
}

const transitionBaseShape = {
  name: nameSchema,
  description: longText(1000).nullable(),
  fromStageId: uuidV7Schema,
  toStageId: uuidV7Schema,
  action: z.enum(TRANSITION_ACTIONS),
  displayOrder: displayOrderSchema,
  isPrimary: z.boolean(),
  requiresComment: z.boolean(),
  allowDueDateOverride: z.boolean(),
};

/** Corpo do WF-13. `requiresComment` é forçado `true` em `RETURN`/`REJECT` (RN-WF-09). */
export const workflowTransitionSchema = z
  .strictObject({
    key: workflowItemKeySchema,
    name: nameSchema,
    description: transitionBaseShape.description.optional(),
    fromStageId: uuidV7Schema,
    toStageId: uuidV7Schema,
    action: transitionBaseShape.action,
    displayOrder: displayOrderSchema.default(0),
    isPrimary: z.boolean().default(false),
    requiresComment: z.boolean().default(false),
    allowDueDateOverride: z.boolean().default(true),
  })
  .superRefine((transition, ctx) => {
    addIssues(ctx, workflowTransitionIssues(transition));
  });
export type WorkflowTransitionCreate = z.infer<typeof workflowTransitionSchema>;

export const workflowTransitionUpdateSchema = z.strictObject(transitionBaseShape).partial();
export type WorkflowTransitionUpdate = z.infer<typeof workflowTransitionUpdateSchema>;

// ---------------------------------------------------------------------------------------------
// Regra (WF-16/17/18) e `config` por tipo (entities.md §5.5)
// ---------------------------------------------------------------------------------------------

export const requiredDocumentConfigSchema = z.strictObject({
  documentTypeCode: documentTypeCodeSchema,
  minStatus: z.enum(REQUIRED_DOCUMENT_MIN_STATUSES),
  minCount: z.number().int().min(1).max(99).optional(),
});
export const requiredFieldConfigSchema = z.strictObject({
  field: z.string().min(1).max(200),
});
export const requiredApprovalConfigSchema = z.strictObject({ stageKey: workflowItemKeySchema });
export const conditionConfigSchema = z.strictObject({ expression: z.json() });

/** `WorkflowRule.config` por `type` (entities.md §5.5). */
export const WORKFLOW_RULE_CONFIG_SCHEMAS = {
  REQUIRED_DOCUMENT: requiredDocumentConfigSchema,
  REQUIRED_FIELD: requiredFieldConfigSchema,
  REQUIRED_APPROVAL: requiredApprovalConfigSchema,
  CONDITION: conditionConfigSchema,
} as const satisfies Record<RuleType, z.ZodType>;

/** `config` com o `type` ao lado — a forma que o editor monta (US-044). */
export const workflowRuleConfigSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('REQUIRED_DOCUMENT'), config: requiredDocumentConfigSchema }),
  z.strictObject({ type: z.literal('REQUIRED_FIELD'), config: requiredFieldConfigSchema }),
  z.strictObject({ type: z.literal('REQUIRED_APPROVAL'), config: requiredApprovalConfigSchema }),
  z.strictObject({ type: z.literal('CONDITION'), config: conditionConfigSchema }),
]);
export type WorkflowRuleConfig = z.infer<typeof workflowRuleConfigSchema>;

/** Código `WF_RULE_*` de um problema de `config` (o validador o reaproveita). */
export type RuleConfigProblemCode =
  'WF_RULE_CONFIG_INVALID' | 'WF_RULE_PATH_UNKNOWN' | 'WF_RULE_OPERATOR_FORBIDDEN';

export interface RuleConfigProblem {
  readonly code: RuleConfigProblemCode;
  readonly detail: string;
}

/**
 * RN-WF-17 (sintaxe e contexto): `config` válido pelo schema do tipo, `REQUIRED_FIELD.field` e as
 * variáveis da `CONDITION` restritos ao RuleContext v1, `CONDITION` só com operações da whitelist,
 * profundidade ≤ 20 e tamanho ≤ 10 KB. Devolve todos os problemas.
 */
export function ruleConfigProblems(type: RuleType, config: unknown): RuleConfigProblem[] {
  const parsed = WORKFLOW_RULE_CONFIG_SCHEMAS[type].safeParse(config);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      code: 'WF_RULE_CONFIG_INVALID',
      detail: `configuração inválida${issue.path.length > 0 ? ` em ${issue.path.join('.')}` : ''}`,
    }));
  }
  if (type === 'REQUIRED_FIELD') {
    const { field } = parsed.data as z.infer<typeof requiredFieldConfigSchema>;
    return isRuleContextPath(field)
      ? []
      : [
          {
            code: 'WF_RULE_PATH_UNKNOWN',
            detail: `o campo ${field} não pertence ao contexto de regras (RuleContext v1)`,
          },
        ];
  }
  if (type === 'CONDITION') {
    const { expression } = parsed.data as z.infer<typeof conditionConfigSchema>;
    return inspectJsonLogic(expression, { isPathAllowed: isRuleContextPath }).issues.map(
      (issue) => ({
        code:
          issue.kind === 'OPERATOR_FORBIDDEN'
            ? 'WF_RULE_OPERATOR_FORBIDDEN'
            : issue.kind === 'PATH_UNKNOWN'
              ? 'WF_RULE_PATH_UNKNOWN'
              : 'WF_RULE_CONFIG_INVALID',
        detail: issue.detail,
      }),
    );
  }
  return [];
}

export interface WorkflowRuleFields {
  readonly scope: RuleScope;
  readonly stageId: string | null;
  readonly transitionId: string | null;
  readonly type: RuleType;
  readonly name: string;
  readonly description: string | null;
  readonly severity: RuleSeverity;
  readonly config: unknown;
  readonly message: string;
  readonly isActive: boolean;
  readonly displayOrder: number;
}

const CONFIG_MESSAGE = 'A condição usa um campo ou operação não permitidos.';

/**
 * RN-WF-17 (parte local) e o check de escopo de entities.md §4.5. RN-WF-56 (US-044 · FA-04): o
 * caminho de `REQUIRED_FIELD` fora do RuleContext v1 é aceito no rascunho — só a publicação o
 * barra (`WF_RULE_PATH_UNKNOWN`, US-045).
 */
export function workflowRuleIssues(
  rule: Pick<WorkflowRuleFields, 'scope' | 'stageId' | 'transitionId' | 'type' | 'config'>,
): WorkflowFieldIssue[] {
  const issues: WorkflowFieldIssue[] = [];
  if (rule.scope === 'STAGE_EXIT') {
    if (!rule.stageId) issues.push(required('stageId', 'Informe a etapa da regra.'));
    if (rule.transitionId) {
      issues.push(notAllowed('transitionId', 'Regra de saída de etapa não tem transição.'));
    }
  } else {
    if (!rule.transitionId) issues.push(required('transitionId', 'Informe a transição da regra.'));
    if (rule.stageId) issues.push(notAllowed('stageId', 'Regra de transição não tem etapa.'));
  }
  const problems = ruleConfigProblems(rule.type, rule.config).filter(
    (problem) => rule.type !== 'REQUIRED_FIELD' || problem.code !== 'WF_RULE_PATH_UNKNOWN',
  );
  if (problems.length > 0) {
    issues.push({
      field: 'config',
      code: problems.some((problem) => problem.code === 'WF_RULE_CONFIG_INVALID')
        ? 'INVALID_FORMAT'
        : 'NOT_ALLOWED',
      message: CONFIG_MESSAGE,
    });
  }
  return issues;
}

const ruleBaseShape = {
  scope: z.enum(RULE_SCOPES),
  stageId: uuidV7Schema.nullable(),
  transitionId: uuidV7Schema.nullable(),
  type: z.enum(RULE_TYPES),
  name: nameSchema,
  description: longText(2000).nullable(),
  severity: z.enum(RULE_SEVERITIES),
  config: z.record(z.string(), z.unknown()),
  message: trimmedString({ min: 5, max: 500 }),
  isActive: z.boolean(),
  displayOrder: displayOrderSchema,
};

/** Corpo do WF-16. */
export const workflowRuleSchema = z
  .strictObject({
    scope: ruleBaseShape.scope,
    stageId: ruleBaseShape.stageId.default(null),
    transitionId: ruleBaseShape.transitionId.default(null),
    type: ruleBaseShape.type,
    name: nameSchema,
    description: ruleBaseShape.description.optional(),
    severity: ruleBaseShape.severity.default('BLOCKING'),
    config: ruleBaseShape.config,
    message: ruleBaseShape.message,
    isActive: z.boolean().default(true),
    displayOrder: displayOrderSchema.default(0),
  })
  .superRefine((rule, ctx) => {
    addIssues(ctx, workflowRuleIssues(rule));
  });
export type WorkflowRuleCreate = z.infer<typeof workflowRuleSchema>;

export const workflowRuleUpdateSchema = z.strictObject(ruleBaseShape).partial();
export type WorkflowRuleUpdate = z.infer<typeof workflowRuleUpdateSchema>;

/**
 * Corpo do WF-23 ("Testar regra" — US-044 · RN-WF-59): a `config` do formulário (salva ou não),
 * sem `ruleId`. A forma do `config` é conferida pela API com o mesmo schema do tipo; `message` é a
 * mensagem do formulário, devolvida quando a regra não é satisfeita.
 */
export const workflowRuleTestSchema = z.strictObject({
  type: z.enum(RULE_TYPES),
  config: z.record(z.string(), z.unknown()),
  severity: z.enum(RULE_SEVERITIES).default('BLOCKING'),
  message: z.string().trim().max(500).optional(),
  processId: z.uuid({ error: 'Selecione um processo válido.' }),
});
export type WorkflowRuleTest = z.infer<typeof workflowRuleTestSchema>;

/** Por que o teste não pôde avaliar normalmente (a regra conta como não satisfeita). */
export const RULE_TEST_WARNING_CODES = [
  'PATH_UNKNOWN',
  'MISSING_PATH',
  'CONFIG_INVALID',
  'EVALUATION_FAILED',
] as const;
export type RuleTestWarningCode = (typeof RULE_TEST_WARNING_CODES)[number];

/** Resposta do WF-23. */
export const workflowRuleTestResultSchema = z
  .object({
    satisfied: z.boolean(),
    severity: z.enum(RULE_SEVERITIES),
    message: z.string(),
    /** Valores do RuleContext usados na avaliação (caminho → valor; orçamento sigiloso mascarado). */
    contextUsed: z.record(z.string(), z.unknown()),
    warnings: z.array(z.object({ code: z.enum(RULE_TEST_WARNING_CODES), message: z.string() })),
  })
  .meta({ id: 'WorkflowRuleTestResult' });
export type WorkflowRuleTestResult = z.infer<typeof workflowRuleTestResultSchema>;

// ---------------------------------------------------------------------------------------------
// Respostas
// ---------------------------------------------------------------------------------------------

const iso = z.iso.datetime({ offset: true });

export const workflowStageDtoSchema = z
  .object({
    id: z.uuid(),
    workflowVersionId: z.uuid(),
    key: z.string(),
    name: z.string(),
    instructions: z.string().nullable(),
    type: z.enum(STAGE_TYPES),
    groupLabel: z.string().nullable(),
    displayOrder: z.number().int(),
    departmentResolution: z.enum(STAGE_DEPARTMENT_RESOLUTIONS),
    fixedDepartmentId: z.uuid().nullable(),
    assignmentPolicy: z.enum(STAGE_ASSIGNMENT_POLICIES),
    approverType: z.enum(APPROVER_TYPES).nullable(),
    approverUserId: z.uuid().nullable(),
    approverRoleId: z.uuid().nullable(),
    approverDepartmentResolution: z.enum(DEPARTMENT_RESOLUTIONS).nullable(),
    approverFixedDepartmentId: z.uuid().nullable(),
    allowDeputy: z.boolean(),
    approvalDocumentTypeCodes: z.array(z.string()),
    documentTypeCodes: z.array(z.string()),
    slaDays: z.number().int().nullable(),
    slaType: z.enum(DAY_COUNT_TYPES),
    color: z.string().nullable(),
    /** `ETag` da linha (rascunho); ausente na leitura do snapshot publicado. */
    version: z.number().int().optional(),
  })
  .meta({ id: 'WorkflowStage' });
export type WorkflowStageDto = z.infer<typeof workflowStageDtoSchema>;

export const workflowTransitionDtoSchema = z
  .object({
    id: z.uuid(),
    workflowVersionId: z.uuid(),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    fromStageId: z.uuid(),
    toStageId: z.uuid(),
    action: z.enum(TRANSITION_ACTIONS),
    displayOrder: z.number().int(),
    isPrimary: z.boolean(),
    requiresComment: z.boolean(),
    allowDueDateOverride: z.boolean(),
    version: z.number().int().optional(),
  })
  .meta({ id: 'WorkflowTransition' });
export type WorkflowTransitionDto = z.infer<typeof workflowTransitionDtoSchema>;

export const workflowRuleDtoSchema = z
  .object({
    id: z.uuid(),
    workflowVersionId: z.uuid(),
    scope: z.enum(RULE_SCOPES),
    stageId: z.uuid().nullable(),
    transitionId: z.uuid().nullable(),
    type: z.enum(RULE_TYPES),
    name: z.string(),
    description: z.string().nullable(),
    severity: z.enum(RULE_SEVERITIES),
    config: z.record(z.string(), z.unknown()),
    message: z.string(),
    isActive: z.boolean(),
    displayOrder: z.number().int(),
    version: z.number().int().optional(),
  })
  .meta({ id: 'WorkflowRule' });
export type WorkflowRuleDto = z.infer<typeof workflowRuleDtoSchema>;

export const workflowVersionSummarySchema = z
  .object({
    id: z.uuid(),
    workflowId: z.uuid(),
    versionNumber: z.number().int(),
    status: z.enum(WORKFLOW_VERSION_STATUSES),
    changeNotes: z.string().nullable(),
    publishedAt: iso.nullable(),
    publishedById: z.uuid().nullable(),
    retiredAt: iso.nullable(),
    retiredById: z.uuid().nullable(),
    /** Nome de quem publicou/aposentou — só no histórico (WF-07 · US-045). */
    publishedByName: z.string().nullable().optional(),
    retiredByName: z.string().nullable().optional(),
    definitionHash: z.string().nullable(),
    createdAt: iso,
    createdById: z.uuid().nullable(),
    /** `ETag` da versão: incrementado a cada escrita no rascunho (RN-WF-06). */
    version: z.number().int(),
  })
  .meta({ id: 'WorkflowVersionSummary' });
export type WorkflowVersionSummaryDto = z.infer<typeof workflowVersionSummarySchema>;

export const workflowVersionDetailSchema = workflowVersionSummarySchema
  .extend({
    initialStageId: z.uuid().nullable(),
    stages: z.array(workflowStageDtoSchema),
    transitions: z.array(workflowTransitionDtoSchema),
    rules: z.array(workflowRuleDtoSchema),
  })
  .meta({ id: 'WorkflowVersion' });
export type WorkflowVersionDetailDto = z.infer<typeof workflowVersionDetailSchema>;

export const workflowSchema = z
  .object({
    id: z.uuid(),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    isActive: z.boolean(),
    isDefault: z.boolean(),
    applicabilityRule: z.unknown().nullable(),
    applicabilityPriority: z.number().int(),
    currentPublishedVersion: z
      .object({ id: z.uuid(), versionNumber: z.number().int(), publishedAt: iso.nullable() })
      .nullable(),
    draftVersion: z.object({ id: z.uuid(), versionNumber: z.number().int() }).nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'Workflow' });
export type WorkflowDto = z.infer<typeof workflowSchema>;

// ---------------------------------------------------------------------------------------------
// Lista, padrão e aplicabilidade (WF-01/05/06 · US-042)
// ---------------------------------------------------------------------------------------------

export const WORKFLOW_LIST_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

/** WF-01 (query): `q` (≥ 2 caracteres) no nome ou na chave; `status` = situação (US-043). */
export const workflowListQuerySchema = pageQuerySchema.extend({
  status: z.enum(WORKFLOW_LIST_STATUSES).optional(),
  q: z
    .string()
    .trim()
    .min(2, { error: 'Informe ao menos 2 caracteres para buscar.' })
    .max(150, { error: 'Informe no máximo 150 caracteres.' })
    .optional(),
});
export type WorkflowListQuery = z.infer<typeof workflowListQuerySchema>;

/**
 * WF-06 (corpo): os dados do processo que a aplicabilidade lê (RN-WF-39). Os ids de catálogo
 * viram `contractingTypeCode`/`modalityCode`/`originCode` do `RuleContext.process`; `modalityId`
 * ausente = "A definir" (FA-04).
 */
export const workflowResolveSchema = z.strictObject({
  contractingTypeId: uuidV7Schema,
  modalityId: uuidV7Schema.nullish(),
  originId: uuidV7Schema,
  estimatedValue: decimalString({ precision: 18, scale: 2 }).nullish(),
  organizationId: uuidV7Schema,
  isPriceRegistration: z.boolean(),
});
export type WorkflowResolve = z.infer<typeof workflowResolveSchema>;

/** WF-06 (resposta): workflow, versão publicada fixada e etapa inicial. */
export const workflowResolutionSchema = z
  .object({
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    name: z.string(),
    versionNumber: z.number().int(),
    initialStage: z.object({ id: z.uuid(), key: z.string(), name: z.string() }),
  })
  .meta({ id: 'WorkflowResolution' });
export type WorkflowResolutionDto = z.infer<typeof workflowResolutionSchema>;

// ---------------------------------------------------------------------------------------------
// Validação completa do grafo (`WORKFLOW_INVALID` — api.md §2.3)
// ---------------------------------------------------------------------------------------------

export const WORKFLOW_VALIDATION_ERROR_CODES = [
  'WF_START_STAGE_COUNT',
  'WF_END_STAGE_MISSING',
  'WF_STAGE_UNREACHABLE',
  'WF_END_UNREACHABLE',
  'WF_APPROVAL_TRANSITIONS',
  'WF_ACTION_NOT_ALLOWED_FROM_STAGE',
  'WF_TRANSITION_TARGET_INVALID',
  'WF_PRIMARY_DUPLICATED',
  'WF_DOCUMENT_TYPE_UNKNOWN',
  'WF_APPROVER_UNRESOLVABLE',
  'WF_DEPARTMENT_INVALID',
  'WF_RULE_CONFIG_INVALID',
  'WF_RULE_PATH_UNKNOWN',
  'WF_RULE_OPERATOR_FORBIDDEN',
  'WF_RULE_SCOPE_INVALID',
  'WF_LIMIT_EXCEEDED',
] as const;
export type WorkflowValidationErrorCode = (typeof WORKFLOW_VALIDATION_ERROR_CODES)[number];

export const WORKFLOW_VALIDATION_WARNING_CODES = [
  'WF_STAGE_NO_SLA',
  'WF_APPROVER_HEAD_MISSING',
  'WF_STAGE_NO_INSTRUCTIONS',
  'WF_RULE_INACTIVE',
] as const;
export type WorkflowValidationWarningCode = (typeof WORKFLOW_VALIDATION_WARNING_CODES)[number];

export const workflowValidationIssueSchema = z
  .object({
    code: z.enum([...WORKFLOW_VALIDATION_ERROR_CODES, ...WORKFLOW_VALIDATION_WARNING_CODES]),
    message: z.string(),
    stageKey: z.string().nullable(),
    transitionKey: z.string().nullable(),
    ruleId: z.string().nullable(),
  })
  .meta({ id: 'WorkflowValidationIssue' });
export type WorkflowValidationIssue = z.infer<typeof workflowValidationIssueSchema>;

export const workflowValidationResultSchema = z
  .object({
    valid: z.boolean(),
    errors: z.array(workflowValidationIssueSchema),
    warnings: z.array(workflowValidationIssueSchema),
  })
  .meta({ id: 'WorkflowValidationResult' });
export type WorkflowValidationResult = z.infer<typeof workflowValidationResultSchema>;
