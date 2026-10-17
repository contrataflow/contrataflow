import {
  RULE_EVALUATION_FAILED_MESSAGE,
  inspectJsonLogic,
  isRuleContextPath,
} from '@contrataflow/validation';
import type {
  ActionEntry,
  ActionReason,
  ChecklistViolation,
  LifecycleAction,
  ProcessStatus,
  RuleContextV1,
} from '@contrataflow/validation';

import { evaluateRule } from './rule-evaluator.js';
import type { EvaluationFacts, RuleOutcome } from './rule-evaluator.js';
import { ABSENT_DOCUMENT } from './rule-facts.js';
import type { RuleFacts, StagePassFact } from './rule-facts.js';
import { resolveStageDepartment } from './stage-destination.js';
import type {
  WorkflowSnapshot,
  WorkflowSnapshotRule,
  WorkflowSnapshotStage,
  WorkflowSnapshotTransition,
} from './workflow-snapshot.js';

/*
 * `WorkflowEngine` (US-041 · DEC-014/DEC-016 · ADR-005/ADR-008 · RN-WF-23..33): a partir da versão
 * PUBLICADA fixada no processo (o snapshot — RN-WF-33), da etapa ativa e dos fatos já carregados,
 * calcula o checklist da etapa (regras `STAGE_EXIT` da etapa e `TRANSITION` das saídas) e as ações
 * disponíveis com os motivos de indisponibilidade. Puro e determinístico: a mesma entrada dá a
 * mesma saída, nada é persistido e nenhuma entrada dentro do schema lança exceção.
 */

/** O processo como o motor o vê (DEC-013 · POL-01/04/05). */
export interface EngineProcess {
  readonly status: ProcessStatus;
  readonly createdById: string;
  /** Unidade com a custódia (`Process.currentDepartmentId`). */
  readonly currentDepartmentId: string;
  /** `null` = na fila da unidade. */
  readonly currentResponsibleId: string | null;
  readonly requestingDepartmentId: string;
  readonly requestingSecretariatId: string;
}

/** Permissões de ação sobre o processo (permissions.md §1.2). */
export type ProcessActionPermission =
  | 'PROCESS_FORWARD'
  | 'PROCESS_RETURN'
  | 'PROCESS_COMPLETE'
  | 'PROCESS_CLAIM'
  | 'PROCESS_ASSIGN'
  | 'PROCESS_CANCEL'
  | 'PROCESS_SUSPEND'
  | 'PROCESS_UPDATE';

/** Quem consulta: lotações, chefias e permissões que tem em algum escopo. */
export interface EngineViewer {
  readonly userId: string;
  /** Unidades de lotação (`MembershipDepartment`). */
  readonly departmentIds: readonly string[];
  /** Unidades de que é titular ou substituto (capacidade implícita — permissions.md §7). */
  readonly headOfDepartmentIds: readonly string[];
  /** Ação sem a permissão em nenhum escopo é OMITIDA (permissions.md §9). */
  readonly permissions: ReadonlySet<ProcessActionPermission>;
  /** `PROCESS_ASSIGN` com escopo `TENANT`/`ORGANIZATION` que cubra o processo (POL-05). */
  readonly canAssignAnywhere: boolean;
}

export interface EngineInput {
  readonly definition: WorkflowSnapshot;
  readonly process: EngineProcess;
  readonly facts: RuleFacts;
}

export interface RuleResult {
  readonly rule: WorkflowSnapshotRule;
  /** Transição da regra `TRANSITION` (`null` em `STAGE_EXIT`). */
  readonly transition: WorkflowSnapshotTransition | null;
  readonly outcome: RuleOutcome;
}

export interface StageEvaluation {
  /** Passagem ativa (`ProcessStage.status = ACTIVE`); `null` = processo sem etapa ativa. */
  readonly currentPass: StagePassFact | null;
  /** Etapa da passagem ativa na versão fixada; `null` se a etapa não pertence à versão. */
  readonly stage: WorkflowSnapshotStage | null;
  /** Saídas de avanço da etapa (`FORWARD`/`COMPLETE`), na ordem de exibição. */
  readonly advances: readonly WorkflowSnapshotTransition[];
  /** Cada regra ativa avaliada uma única vez, na ordem do checklist. */
  readonly results: readonly RuleResult[];
}

/** Ações de avanço que partem da etapa atual (RN-WF-23). */
const ADVANCE: ReadonlySet<string> = new Set(['FORWARD', 'COMPLETE']);

/** POL-01: status em que a custódia permite tramitar. */
const CUSTODY_STATUSES: ReadonlySet<ProcessStatus> = new Set(['DRAFT', 'IN_PROGRESS', 'RETURNED']);
/** POL-07: suspender a partir destes. */
const SUSPENDABLE: ReadonlySet<ProcessStatus> = new Set([
  'IN_PROGRESS',
  'AWAITING_APPROVAL',
  'RETURNED',
]);
/** POL-06: status finais (não cancela). */
const FINAL_STATUSES: ReadonlySet<ProcessStatus> = new Set(['CANCELED', 'COMPLETED', 'PUBLISHED']);

const STATUS_LABELS: Readonly<Record<ProcessStatus, string>> = {
  DRAFT: 'em rascunho',
  IN_PROGRESS: 'em andamento',
  AWAITING_APPROVAL: 'aguardando aprovação',
  RETURNED: 'devolvido',
  SUSPENDED: 'suspenso',
  CANCELED: 'cancelado',
  COMPLETED: 'concluído',
  PUBLISHED: 'publicado',
};

const LIFECYCLE_LABELS: Readonly<Record<LifecycleAction, string>> = {
  CLAIM: 'Assumir processo',
  ASSIGN: 'Atribuir responsável',
  SUSPEND: 'Suspender processo',
  RESUME: 'Retomar processo',
  CANCEL: 'Cancelar processo',
};

/** V-03 da US-004: "Somente quem está com o processo pode {ação}." */
export function notCustodianMessage(action: 'FORWARD' | 'COMPLETE' | 'RETURN'): string {
  const verb = { FORWARD: 'encaminhá-lo', COMPLETE: 'concluí-lo', RETURN: 'devolvê-lo' }[action];
  return `Somente quem está com o processo pode ${verb}.`;
}

const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Ordem de exibição das transições: principal primeiro, depois `displayOrder` e chave. */
function byDisplay(left: WorkflowSnapshotTransition, right: WorkflowSnapshotTransition): number {
  if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
  return left.displayOrder - right.displayOrder || compare(left.key, right.key);
}

function byRuleOrder(left: WorkflowSnapshotRule, right: WorkflowSnapshotRule): number {
  return left.displayOrder - right.displayOrder || compare(left.id, right.id);
}

/** A passagem ativa (a de maior `sequence`, se a base trouxer mais de uma). */
export function activePassOf(passes: readonly StagePassFact[]): StagePassFact | null {
  return passes.reduce<StagePassFact | null>(
    (latest, pass) =>
      pass.status === 'ACTIVE' && (latest === null || pass.sequence > latest.sequence)
        ? pass
        : latest,
    null,
  );
}

/** O que basta de uma regra para saber quais caminhos ela lê. */
type ReadingRule = Pick<WorkflowSnapshotRule, 'type' | 'config'>;

/** Códigos de tipo citados em `documents.<CÓDIGO>.*` pelas regras `REQUIRED_FIELD`/`CONDITION`. */
function referencedDocumentCodes(rules: readonly ReadingRule[]): Set<string> {
  const paths: string[] = [];
  for (const rule of rules) {
    if (rule.type === 'REQUIRED_FIELD' && typeof rule.config.field === 'string') {
      paths.push(rule.config.field);
    } else if (rule.type === 'CONDITION') {
      paths.push(
        ...inspectJsonLogic(rule.config.expression, { isPathAllowed: isRuleContextPath }).paths,
      );
    }
  }
  const codes = new Set<string>();
  for (const path of paths) {
    const [section, code] = path.split('.');
    if (section === 'documents' && code !== undefined && isRuleContextPath(path)) codes.add(code);
  }
  return codes;
}

/**
 * Tipo sem documento no processo = `documents.<CÓDIGO>` "ausente" (`exists: false`, `count: 0`…),
 * para que `REQUIRED_FIELD`/`CONDITION` leiam um valor definido em vez de um caminho inexistente.
 */
function withReferencedDocuments(
  context: RuleContextV1,
  rules: readonly ReadingRule[],
): RuleContextV1 {
  const missing = [...referencedDocumentCodes(rules)].filter(
    (code) => !Object.hasOwn(context.documents, code),
  );
  if (missing.length === 0) return context;
  return {
    ...context,
    documents: {
      ...context.documents,
      ...Object.fromEntries(missing.map((code) => [code, ABSENT_DOCUMENT])),
    },
  };
}

/**
 * Fatos que o `RuleEvaluator` lê: documentos citados pelas regras e ausentes no processo viram
 * `documents.<CÓDIGO>` "ausente"; as passagens de `REQUIRED_APPROVAL` são resolvidas pela chave da
 * etapa nas etapas da versão FIXADA no processo (os `workflowStageId` das passagens são dela).
 */
export function evaluationFactsOf(
  definition: Pick<WorkflowSnapshot, 'stages'>,
  facts: RuleFacts,
  rules: readonly ReadingRule[],
): EvaluationFacts {
  const stageIdsByKey = new Map<string, string[]>();
  for (const candidate of definition.stages) {
    stageIdsByKey.set(candidate.key, [...(stageIdsByKey.get(candidate.key) ?? []), candidate.id]);
  }
  return {
    ...facts,
    context: withReferencedDocuments(facts.context, rules),
    passesOf: (stageKey) => {
      const ids = stageIdsByKey.get(stageKey) ?? [];
      return facts.passes.filter((pass) => ids.includes(pass.workflowStageId));
    },
  };
}

/**
 * RN-WF-24..29: avalia, uma vez cada, as regras ativas `STAGE_EXIT` da etapa atual e `TRANSITION`
 * das saídas `FORWARD`/`COMPLETE`. Etapa `END` (sem saídas) ou processo sem etapa ativa = nada.
 */
export function evaluateStage(input: EngineInput): StageEvaluation {
  const { definition, facts } = input;
  const currentPass = activePassOf(facts.passes);
  const stage =
    currentPass === null
      ? null
      : (definition.stages.find((candidate) => candidate.id === currentPass.workflowStageId) ??
        null);
  if (stage === null) return { currentPass, stage, advances: [], results: [] };

  const advances = definition.transitions
    .filter((transition) => transition.fromStageId === stage.id && ADVANCE.has(transition.action))
    .sort(byDisplay);
  const exitRules = definition.rules
    .filter((rule) => rule.isActive && rule.scope === 'STAGE_EXIT' && rule.stageId === stage.id)
    .sort(byRuleOrder)
    .map((rule) => ({ rule, transition: null }));
  const transitionRules = advances.flatMap((transition) =>
    definition.rules
      .filter(
        (rule) =>
          rule.isActive && rule.scope === 'TRANSITION' && rule.transitionId === transition.id,
      )
      .sort(byRuleOrder)
      .map((rule) => ({ rule, transition })),
  );
  const selected = [...exitRules, ...transitionRules];

  const evaluationFacts = evaluationFactsOf(
    definition,
    facts,
    selected.map(({ rule }) => rule),
  );
  const results = selected.map(({ rule, transition }) => ({
    rule,
    transition,
    outcome: evaluateRule(rule, evaluationFacts),
  }));
  return { currentPass, stage, advances, results };
}

/** `params` da pendência: o que a UI usa para o atalho (tipo de documento, etapa da aprovação). */
function violationParams(rule: WorkflowSnapshotRule): Record<string, unknown> {
  const { config } = rule;
  if (rule.type === 'REQUIRED_DOCUMENT') {
    return {
      documentTypeCode: config.documentTypeCode,
      minStatus: config.minStatus,
      ...(config.minCount === undefined ? {} : { minCount: config.minCount }),
    };
  }
  if (rule.type === 'REQUIRED_APPROVAL') return { stageKey: config.stageKey };
  return {};
}

/**
 * Checklist (PRC-09 · api.md §2.1.2): uma `violation` `WORKFLOW_RULE` por regra NÃO satisfeita, com
 * a `message` configurada — bloqueantes antes dos avisos (RN-WF-25: aviso só aparece aqui).
 */
export function checklistOf(evaluation: StageEvaluation): ChecklistViolation[] {
  const violations = evaluation.results
    .filter(({ outcome }) => !outcome.satisfied)
    .map(({ rule, transition, outcome }): ChecklistViolation => ({
      code: 'WORKFLOW_RULE',
      severity: rule.severity,
      // FA-10 (US-004): regra não avaliável mostra a mensagem padrão, nunca a configurada.
      message: outcome.problem === undefined ? rule.message : RULE_EVALUATION_FAILED_MESSAGE,
      ruleId: rule.id,
      sectionKey: null,
      field:
        rule.type === 'REQUIRED_FIELD' && typeof rule.config.field === 'string'
          ? rule.config.field
          : null,
      itemId: null,
      params: violationParams(rule),
      name: rule.name,
      type: rule.type,
      satisfied: false,
      scope: rule.scope,
      ...(outcome.problem === undefined ? {} : { evaluationFailed: true }),
      ...(transition === null
        ? {}
        : { transitionId: transition.id, transitionKey: transition.key }),
    }));
  return [
    ...violations.filter((violation) => violation.severity === 'BLOCKING'),
    ...violations.filter((violation) => violation.severity === 'WARNING'),
  ];
}

/** POL-01: responsável atual ou, na fila, lotado na unidade atual. */
export function isCustodian(process: EngineProcess, viewer: EngineViewer): boolean {
  return process.currentResponsibleId === null
    ? viewer.departmentIds.includes(process.currentDepartmentId)
    : process.currentResponsibleId === viewer.userId;
}

const statusReason = (status: ProcessStatus): ActionReason => ({
  code: 'INVALID_PROCESS_STATUS',
  message: `Ação indisponível: o processo está ${STATUS_LABELS[status]}.`,
});

/** Motivos comuns às ações de tramitação: status (POL-01) e custódia. */
function custodyReasons(
  process: EngineProcess,
  viewer: EngineViewer,
  action: 'FORWARD' | 'COMPLETE' | 'RETURN',
): ActionReason[] {
  const reasons: ActionReason[] = [];
  if (!CUSTODY_STATUSES.has(process.status)) reasons.push(statusReason(process.status));
  if (!isCustodian(process, viewer)) {
    reasons.push({ code: 'NOT_PROCESS_CUSTODIAN', message: notCustodianMessage(action) });
  }
  return reasons;
}

/** RN-WF-24: regras `BLOCKING` não satisfeitas da etapa e da própria transição. */
function blockingReasons(
  evaluation: StageEvaluation,
  transition: WorkflowSnapshotTransition,
): ActionReason[] {
  return evaluation.results
    .filter(
      ({ rule, outcome, transition: owner }) =>
        rule.severity === 'BLOCKING' &&
        !outcome.satisfied &&
        (owner === null || owner.id === transition.id),
    )
    .map(({ rule }) => ({ code: 'TRANSITION_BLOCKED', message: rule.message, ruleId: rule.id }));
}

const entry = (
  action: ActionEntry['action'],
  label: string,
  reasons: ActionReason[],
  extra: Partial<ActionEntry> = {},
): ActionEntry => ({ action, label, enabled: reasons.length === 0, reasons, ...extra });

function advanceEntries(
  input: EngineInput,
  viewer: EngineViewer,
  evaluation: StageEvaluation,
): ActionEntry[] {
  const { definition, process } = input;
  const entries: ActionEntry[] = [];
  for (const transition of evaluation.advances) {
    const permission = transition.action === 'COMPLETE' ? 'PROCESS_COMPLETE' : 'PROCESS_FORWARD';
    if (!viewer.permissions.has(permission)) continue;
    const target = definition.stages.find((stage) => stage.id === transition.toStageId);
    const department = target === undefined ? null : resolveStageDepartment(target, process);
    entries.push(
      entry(
        transition.action === 'COMPLETE' ? 'COMPLETE' : 'FORWARD',
        transition.name,
        [
          ...custodyReasons(
            process,
            viewer,
            transition.action === 'COMPLETE' ? 'COMPLETE' : 'FORWARD',
          ),
          ...blockingReasons(evaluation, transition),
        ],
        {
          transitionKey: transition.key,
          toStageKey: transition.toStageKey,
          primary: transition.isPrimary,
          requiresComment: transition.requiresComment,
          allowDueDateOverride: transition.allowDueDateOverride,
          ...(department === null
            ? {}
            : {
                departmentResolution: {
                  mode: department.mode,
                  ...(department.departmentId === null
                    ? {}
                    : { departmentId: department.departmentId }),
                },
              }),
        },
      ),
    );
  }
  return entries;
}

/**
 * RN-WF-23: uma `RETURN` por etapa DISTINTA já percorrida (passagem `COMPLETED`/`RETURNED`) entre
 * os destinos de devolução configurados na etapa atual (FA-02: primeira etapa = nenhuma).
 */
function returnEntries(
  input: EngineInput,
  viewer: EngineViewer,
  evaluation: StageEvaluation,
): ActionEntry[] {
  const { definition, process, facts } = input;
  const { stage } = evaluation;
  if (stage === null || !viewer.permissions.has('PROCESS_RETURN')) return [];
  const traversed = new Set(
    facts.passes
      .filter((pass) => pass.status === 'COMPLETED' || pass.status === 'RETURNED')
      .map((pass) => pass.workflowStageId),
  );
  const seen = new Set<string>();
  const entries: ActionEntry[] = [];
  const returns = definition.transitions
    .filter((transition) => transition.fromStageId === stage.id && transition.action === 'RETURN')
    .sort(byDisplay);
  for (const transition of returns) {
    if (!traversed.has(transition.toStageId) || seen.has(transition.toStageId)) continue;
    seen.add(transition.toStageId);
    entries.push(
      entry('RETURN', transition.name, custodyReasons(process, viewer, 'RETURN'), {
        transitionKey: transition.key,
        toStageKey: transition.toStageKey,
        requiresComment: transition.requiresComment,
        allowDueDateOverride: transition.allowDueDateOverride,
      }),
    );
  }
  return entries;
}

/** CLAIM (POL-04): lotado na unidade atual, processo na fila, status com custódia. */
function claimEntry(process: EngineProcess, viewer: EngineViewer): ActionEntry {
  const reasons: ActionReason[] = [];
  if (!CUSTODY_STATUSES.has(process.status)) reasons.push(statusReason(process.status));
  if (process.currentResponsibleId !== null) {
    reasons.push({
      code: 'PROCESS_ALREADY_ASSIGNED',
      message:
        process.currentResponsibleId === viewer.userId
          ? 'Você já é o responsável pelo processo.'
          : 'O processo já tem um responsável.',
    });
  } else if (!viewer.departmentIds.includes(process.currentDepartmentId)) {
    reasons.push({
      code: 'NOT_PROCESS_CUSTODIAN',
      message: 'O processo não está na fila de uma unidade em que você é lotado.',
    });
  }
  return entry('CLAIM', LIFECYCLE_LABELS.CLAIM, reasons);
}

/** ASSIGN (POL-05): escopo amplo de `PROCESS_ASSIGN` ou chefia da unidade atual. */
function assignEntry(process: EngineProcess, viewer: EngineViewer): ActionEntry {
  const reasons: ActionReason[] = [];
  if (!CUSTODY_STATUSES.has(process.status)) reasons.push(statusReason(process.status));
  if (
    !viewer.canAssignAnywhere &&
    !viewer.headOfDepartmentIds.includes(process.currentDepartmentId)
  ) {
    reasons.push({
      code: 'PERMISSION_DENIED',
      message:
        'Só a chefia da unidade atual (titular ou substituto) ou quem tem atribuição em todo o órgão pode atribuir o responsável.',
    });
  }
  return entry('ASSIGN', LIFECYCLE_LABELS.ASSIGN, reasons);
}

/**
 * RN-WF-32: ações de ciclo de vida pelo `ProcessStatus` (DEC-013) e pela titularidade (POL-04..07),
 * fora do grafo de regras e fora do checklist. Suspenso mostra `RESUME`; os demais, `SUSPEND`.
 */
function lifecycleEntries(process: EngineProcess, viewer: EngineViewer): ActionEntry[] {
  const entries: ActionEntry[] = [];
  const { permissions } = viewer;
  if (permissions.has('PROCESS_CLAIM')) entries.push(claimEntry(process, viewer));
  if (permissions.has('PROCESS_ASSIGN') || viewer.headOfDepartmentIds.length > 0) {
    entries.push(assignEntry(process, viewer));
  }
  if (permissions.has('PROCESS_SUSPEND')) {
    entries.push(
      process.status === 'SUSPENDED'
        ? entry('RESUME', LIFECYCLE_LABELS.RESUME, [])
        : entry(
            'SUSPEND',
            LIFECYCLE_LABELS.SUSPEND,
            SUSPENDABLE.has(process.status) ? [] : [statusReason(process.status)],
          ),
    );
  }
  if (permissions.has('PROCESS_CANCEL')) {
    entries.push(
      entry(
        'CANCEL',
        LIFECYCLE_LABELS.CANCEL,
        FINAL_STATUSES.has(process.status) ? [statusReason(process.status)] : [],
      ),
    );
  }
  return entries;
}

/**
 * EDIT (US-005 · RN-PROC-59 · POL-01): "Editar dados" com `PROCESS_UPDATE`; desabilitada com o
 * motivo fora de `DRAFT`/`IN_PROGRESS`/`RETURNED` ou sem custódia (a API repete as checagens).
 */
function editEntry(process: EngineProcess, viewer: EngineViewer): ActionEntry[] {
  if (!viewer.permissions.has('PROCESS_UPDATE')) return [];
  const reasons: ActionReason[] = [];
  if (!CUSTODY_STATUSES.has(process.status)) {
    reasons.push({
      code: 'INVALID_PROCESS_STATUS',
      message:
        process.status === 'AWAITING_APPROVAL'
          ? 'Não é possível editar enquanto o processo aguarda aprovação.'
          : `Não é possível editar com o processo ${STATUS_LABELS[process.status]}.`,
    });
  } else if (!isCustodian(process, viewer)) {
    reasons.push({
      code: 'NOT_PROCESS_CUSTODIAN',
      message: 'Somente quem está com o processo pode editar os dados.',
    });
  }
  return [entry('EDIT', 'Editar dados', reasons)];
}

/**
 * MANAGE_ITEMS (US-006 · RN-PROC-71 · FA-07): "Gerenciar itens" com `PROCESS_UPDATE`; desabilitada
 * com o motivo fora de `DRAFT`/`IN_PROGRESS`/`RETURNED` ou sem custódia — a aba Itens fica em modo
 * leitura com o motivo (a API repete as checagens).
 */
function manageItemsEntry(process: EngineProcess, viewer: EngineViewer): ActionEntry[] {
  if (!viewer.permissions.has('PROCESS_UPDATE')) return [];
  const reasons: ActionReason[] = [];
  if (!CUSTODY_STATUSES.has(process.status)) {
    reasons.push({
      code: 'INVALID_PROCESS_STATUS',
      message:
        process.status === 'AWAITING_APPROVAL'
          ? 'Itens não podem ser alterados com o processo aguardando aprovação.'
          : `Itens não podem ser alterados com o processo ${STATUS_LABELS[process.status]}.`,
    });
  } else if (!isCustodian(process, viewer)) {
    reasons.push({
      code: 'NOT_PROCESS_CUSTODIAN',
      message: 'Somente quem está com o processo pode alterar os itens.',
    });
  }
  return [entry('MANAGE_ITEMS', 'Gerenciar itens', reasons)];
}

/**
 * RN-WF-23/24/32: avanços (`FORWARD`/`COMPLETE` por transição, principal primeiro), devoluções
 * (`RETURN` por etapa percorrida) e ciclo de vida. `enabled` ⇔ `reasons` vazio; aviso (`WARNING`)
 * nunca entra em `reasons` (RN-WF-25).
 */
export function availableActions(
  input: EngineInput,
  viewer: EngineViewer,
  evaluation: StageEvaluation = evaluateStage(input),
): ActionEntry[] {
  return [
    ...advanceEntries(input, viewer, evaluation),
    ...returnEntries(input, viewer, evaluation),
    ...lifecycleEntries(input.process, viewer),
    ...editEntry(input.process, viewer),
    ...manageItemsEntry(input.process, viewer),
  ];
}
