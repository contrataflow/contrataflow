import {
  ADVANCE_ACTIONS,
  isParallelStageType,
  ruleConfigProblems,
  WORKFLOW_LIMITS,
} from '@contrataflow/validation';
import type {
  WfParallelInvalidReason,
  WorkflowValidationErrorCode,
  WorkflowValidationIssue,
  WorkflowValidationResult,
  WorkflowValidationWarningCode,
} from '@contrataflow/validation';

import { analyzeParallelStructure, parallelIssues } from './parallel-graph.js';
import type { ParallelStructure } from './parallel-graph.js';
import { approversOf, decisionConfigurationProblems } from './stage-approvers.js';
import type { DecisionConfigurationProblem, WorkflowStageApprover } from './stage-approvers.js';
import {
  actionAllowedFrom,
  actionAllowedTo,
  BACKWARD_ACTIONS,
  RULE_TRANSITION_ACTIONS,
  stageTypeLabel,
} from './workflow-definition.js';
import type {
  WorkflowDefinition,
  WorkflowRule,
  WorkflowStage,
  WorkflowTransition,
} from './workflow-definition.js';

/*
 * Validador completo do grafo (US-040 · RN-WF-07..19 · V-11): puro, recebe a definição e os
 * catálogos de referência já lidos e devolve TODOS os problemas numa única execução — `errors[]`
 * bloqueiam a publicação, `warnings[]` não. Alcançabilidade por BFS a partir da `START` e
 * terminação por BFS reversa a partir das `END` sobre as arestas de avanço (O(V + E)); "anterior"
 * (RN-WF-10) = existe caminho de avanço do destino até a origem.
 */

/** Unidade vista pelo validador (US-102 — `OrganizationFacade`). */
export interface DepartmentReference {
  readonly isActive: boolean;
  readonly headUserId: string | null;
}

/** Perfil visto pelo validador (US-094/095 — `AccessFacade`). */
export interface RoleReference {
  readonly isActive: boolean;
  readonly canDecideApprovals: boolean;
}

/** Catálogos do tenant usados pela validação (lidos na transação do chamador). */
export interface WorkflowReferences {
  readonly activeDocumentTypeCodes: ReadonlySet<string>;
  readonly departments: ReadonlyMap<string, DepartmentReference>;
  /** Usuários com vínculo `ACTIVE` (e não expirado) no tenant. */
  readonly activeUserIds: ReadonlySet<string>;
  readonly roles: ReadonlyMap<string, RoleReference>;
}

type IssueCode = WorkflowValidationErrorCode | WorkflowValidationWarningCode;

interface IssueTarget {
  readonly stageKey?: string | null;
  readonly transitionKey?: string | null;
  readonly ruleId?: string | null;
  /** `params` estruturado (US-132: `sequence` da linha, `reason`). */
  readonly params?: Readonly<Record<string, string | number>>;
  /** Motivo de `WF_PARALLEL_INVALID` (US-123). */
  readonly reason?: WfParallelInvalidReason;
}

function issue(
  code: IssueCode,
  message: string,
  target: IssueTarget = {},
): WorkflowValidationIssue {
  return {
    code,
    message,
    stageKey: target.stageKey ?? null,
    transitionKey: target.transitionKey ?? null,
    ruleId: target.ruleId ?? null,
    ...(target.params ? { params: { ...target.params } } : {}),
    ...(target.reason ? { reason: target.reason } : {}),
  };
}

/** Mensagens de `WF_APPROVERS_INVALID` por `params.reason` (US-132 · V-12). */
function approversInvalidMessage(stageName: string, problem: DecisionConfigurationProblem): string {
  switch (problem.reason) {
    case 'MIN_LINES':
      return `A etapa ${stageName} precisa de ao menos dois aprovadores distintos.`;
    case 'DUPLICATE_APPROVER':
      return `O aprovador da linha ${String(problem.sequence ?? '')} da etapa ${stageName} já aparece na lista.`;
    case 'TOO_MANY_LINES':
      return `A etapa ${stageName} tem mais de 20 aprovadores.`;
    default:
      return `Só etapas de aprovação têm política de decisão (etapa ${stageName}).`;
  }
}

const ADVANCE = new Set(ADVANCE_ACTIONS);

/** Conjunto alcançável a partir de `starts` seguindo `edges` (BFS). */
function reachable(starts: Iterable<string>, edges: ReadonlyMap<string, readonly string[]>) {
  const seen = new Set<string>();
  const queue = [...starts];
  for (const start of queue) seen.add(start);
  // O iterador do array enxerga os itens acrescentados durante o laço (BFS).
  for (const current of queue) {
    for (const next of edges.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function adjacency(pairs: Iterable<readonly [string, string]>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [from, to] of pairs) {
    const list = map.get(from);
    if (list) list.push(to);
    else map.set(from, [to]);
  }
  return map;
}

export class WorkflowDefinitionValidator {
  /**
   * @param parallel estrutura de ramos já calculada (o serviço a reaproveita no log); ausente, é
   *   calculada aqui.
   */
  validate(
    definition: WorkflowDefinition,
    references: WorkflowReferences,
    parallel: ParallelStructure = analyzeParallelStructure(definition),
  ): WorkflowValidationResult {
    const errors: WorkflowValidationIssue[] = [];
    const warnings: WorkflowValidationIssue[] = [];
    const { stages, transitions, rules } = definition;
    const stagesById = new Map(stages.map((stage) => [stage.id, stage]));

    this.checkLimits(definition, errors);

    const starts = stages.filter((stage) => stage.type === 'START');
    const ends = stages.filter((stage) => stage.type === 'END');
    if (starts.length !== 1) {
      errors.push(issue('WF_START_STAGE_COUNT', 'O fluxo deve ter exatamente uma etapa inicial.'));
    }
    if (ends.length === 0) {
      errors.push(issue('WF_END_STAGE_MISSING', 'O fluxo deve ter ao menos uma etapa final.'));
    }

    const advance = transitions.filter((transition) => ADVANCE.has(transition.action));
    const forward = adjacency(advance.map((t) => [t.fromStageId, t.toStageId] as const));
    const backward = adjacency(advance.map((t) => [t.toStageId, t.fromStageId] as const));

    this.checkTransitions(transitions, stagesById, forward, errors);

    if (starts.length > 0) {
      const fromStart = reachable(
        starts.map((stage) => stage.id),
        forward,
      );
      for (const stage of stages) {
        if (fromStart.has(stage.id)) continue;
        errors.push(
          issue(
            'WF_STAGE_UNREACHABLE',
            `A etapa ${stage.name} não pode ser alcançada a partir da etapa inicial.`,
            { stageKey: stage.key },
          ),
        );
      }
    }
    if (ends.length > 0) {
      const toEnd = reachable(
        ends.map((stage) => stage.id),
        backward,
      );
      for (const stage of stages) {
        if (toEnd.has(stage.id)) continue;
        errors.push(
          issue(
            'WF_END_UNREACHABLE',
            `A partir da etapa ${stage.name} não é possível chegar ao fim do fluxo.`,
            { stageKey: stage.key },
          ),
        );
      }
    }

    for (const stage of stages) {
      const outgoing = transitions.filter((transition) => transition.fromStageId === stage.id);
      this.checkStage(stage, outgoing, references, errors, warnings);
    }
    for (const rule of rules) {
      this.checkRule(rule, definition, stagesById, references, errors, warnings);
    }
    // US-123 (RN-WF2-02..06 · RN-WF2-09): todos os problemas de paralelismo de uma vez.
    for (const problem of parallelIssues(parallel)) {
      errors.push(
        issue('WF_PARALLEL_INVALID', problem.message, {
          stageKey: problem.stageKey,
          transitionKey: problem.transitionKey,
          reason: problem.reason,
        }),
      );
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  private checkLimits(definition: WorkflowDefinition, errors: WorkflowValidationIssue[]): void {
    const limits = [
      [definition.stages.length, WORKFLOW_LIMITS.stages, 'etapas'],
      [definition.transitions.length, WORKFLOW_LIMITS.transitions, 'transições'],
      [definition.rules.length, WORKFLOW_LIMITS.rules, 'regras'],
    ] as const;
    for (const [count, limit, items] of limits) {
      if (count > limit) {
        errors.push(issue('WF_LIMIT_EXCEEDED', `O fluxo excede o limite de ${limit} ${items}.`));
      }
    }
  }

  private checkTransitions(
    transitions: readonly WorkflowTransition[],
    stagesById: ReadonlyMap<string, WorkflowStage>,
    forward: ReadonlyMap<string, readonly string[]>,
    errors: WorkflowValidationIssue[],
  ): void {
    for (const transition of transitions) {
      const from = stagesById.get(transition.fromStageId);
      const to = stagesById.get(transition.toStageId);
      const target = { transitionKey: transition.key };
      if (!from || !to) {
        errors.push(
          issue(
            'WF_TRANSITION_TARGET_INVALID',
            `O destino da transição ${transition.name} é inválido para a ação escolhida.`,
            target,
          ),
        );
        continue;
      }
      if (!actionAllowedFrom(transition.action, from.type)) {
        errors.push(
          issue(
            'WF_ACTION_NOT_ALLOWED_FROM_STAGE',
            `A transição ${transition.name} não é permitida a partir de uma etapa ${stageTypeLabel(from.type)}.`,
            target,
          ),
        );
      }
      const backwardOk =
        !BACKWARD_ACTIONS.includes(transition.action) || reachable([to.id], forward).has(from.id);
      if (!actionAllowedTo(transition.action, to.type) || !backwardOk) {
        errors.push(
          issue(
            'WF_TRANSITION_TARGET_INVALID',
            `O destino da transição ${transition.name} é inválido para a ação escolhida.`,
            target,
          ),
        );
      }
    }
  }

  private checkStage(
    stage: WorkflowStage,
    outgoing: readonly WorkflowTransition[],
    references: WorkflowReferences,
    errors: WorkflowValidationIssue[],
    warnings: WorkflowValidationIssue[],
  ): void {
    const target = { stageKey: stage.key };
    const count = (action: WorkflowTransition['action']) =>
      outgoing.filter((transition) => transition.action === action).length;

    if (
      stage.type === 'APPROVAL' &&
      (count('APPROVE') !== 1 || count('RETURN') < 1 || count('REJECT') !== 1)
    ) {
      errors.push(
        issue(
          'WF_APPROVAL_TRANSITIONS',
          `A etapa de aprovação ${stage.name} precisa de uma saída de aprovação, ao menos uma de devolução e uma de indeferimento.`,
          target,
        ),
      );
    }
    const primaries = outgoing.filter(
      (transition) =>
        transition.isPrimary &&
        (transition.action === 'FORWARD' || transition.action === 'COMPLETE'),
    );
    if (primaries.length > 1) {
      errors.push(
        issue(
          'WF_PRIMARY_DUPLICATED',
          `A etapa ${stage.name} tem mais de uma ação principal.`,
          target,
        ),
      );
    }

    const codes = new Set([...stage.documentTypeCodes, ...stage.approvalDocumentTypeCodes]);
    for (const code of codes) {
      if (references.activeDocumentTypeCodes.has(code)) continue;
      errors.push(
        issue(
          'WF_DOCUMENT_TYPE_UNKNOWN',
          `O tipo de documento ${code} não existe ou está inativo.`,
          target,
        ),
      );
    }

    if (stage.departmentResolution === 'FIXED') {
      const department = stage.fixedDepartmentId
        ? references.departments.get(stage.fixedDepartmentId)
        : undefined;
      if (!department?.isActive) {
        errors.push(
          issue(
            'WF_DEPARTMENT_INVALID',
            `A unidade configurada para a etapa ${stage.name} é inválida ou está inativa.`,
            target,
          ),
        );
      }
    }

    for (const problem of decisionConfigurationProblems(stage)) {
      errors.push(
        issue('WF_APPROVERS_INVALID', approversInvalidMessage(stage.name, problem), {
          ...target,
          params: {
            reason: problem.reason,
            ...(problem.sequence === undefined ? {} : { sequence: problem.sequence }),
          },
        }),
      );
    }
    if (stage.type === 'APPROVAL') {
      const lines = approversOf(stage);
      if (lines.length === 0) this.checkApprover(stage, references, errors, warnings);
      else {
        for (const line of lines) this.checkApproverLine(stage, line, references, errors, warnings);
      }
    }

    if ((stage.type === 'TASK' || stage.type === 'APPROVAL') && stage.slaDays === null) {
      warnings.push(issue('WF_STAGE_NO_SLA', `A etapa ${stage.name} não tem prazo.`, target));
    }
    if (stage.type !== 'END' && !isParallelStageType(stage.type) && !stage.instructions?.trim()) {
      warnings.push(
        issue(
          'WF_STAGE_NO_INSTRUCTIONS',
          `A etapa ${stage.name} não tem orientação para o responsável.`,
          target,
        ),
      );
    }
  }

  /**
   * RN-APV-06 (US-132 · FA-04): cada linha da lista resolvível como o aprovador único (RN-WF-16),
   * com `params.sequence` para o painel apontar a linha. A cobertura de `ROLE` sobre a unidade
   * solicitante é verificada em execução (DEC-022).
   */
  private checkApproverLine(
    stage: WorkflowStage,
    line: WorkflowStageApprover,
    references: WorkflowReferences,
    errors: WorkflowValidationIssue[],
    warnings: WorkflowValidationIssue[],
  ): void {
    const target = { stageKey: stage.key, params: { sequence: line.sequence } };
    const unresolvable = () =>
      errors.push(
        issue(
          'WF_APPROVER_UNRESOLVABLE',
          `O aprovador da linha ${String(line.sequence)} da etapa ${stage.name} não pode ser determinado.`,
          target,
        ),
      );
    switch (line.approverType) {
      case 'USER':
        if (!line.approverUserId || !references.activeUserIds.has(line.approverUserId)) {
          unresolvable();
        }
        return;
      case 'ROLE': {
        const role = line.approverRoleId ? references.roles.get(line.approverRoleId) : undefined;
        if (!role?.isActive || !role.canDecideApprovals) unresolvable();
        return;
      }
      default: {
        if (!line.approverDepartmentResolution) {
          unresolvable();
          return;
        }
        if (line.approverDepartmentResolution !== 'FIXED') return;
        const department = line.approverFixedDepartmentId
          ? references.departments.get(line.approverFixedDepartmentId)
          : undefined;
        if (!department?.isActive) {
          unresolvable();
          return;
        }
        if (department.headUserId === null) {
          warnings.push(
            issue(
              'WF_APPROVER_HEAD_MISSING',
              `A unidade aprovadora da linha ${String(line.sequence)} da etapa ${stage.name} não tem titular cadastrado.`,
              target,
            ),
          );
        }
      }
    }
  }

  /** RN-WF-16: aprovador resolvível no momento da publicação. */
  private checkApprover(
    stage: WorkflowStage,
    references: WorkflowReferences,
    errors: WorkflowValidationIssue[],
    warnings: WorkflowValidationIssue[],
  ): void {
    const target = { stageKey: stage.key };
    const unresolvable = () =>
      errors.push(
        issue(
          'WF_APPROVER_UNRESOLVABLE',
          `O aprovador da etapa ${stage.name} não pode ser determinado.`,
          target,
        ),
      );
    switch (stage.approverType) {
      case 'USER':
        if (!stage.approverUserId || !references.activeUserIds.has(stage.approverUserId)) {
          unresolvable();
        }
        return;
      case 'ROLE': {
        const role = stage.approverRoleId ? references.roles.get(stage.approverRoleId) : undefined;
        if (!role?.isActive || !role.canDecideApprovals) unresolvable();
        return;
      }
      case 'DEPARTMENT_HEAD': {
        if (!stage.approverDepartmentResolution) {
          unresolvable();
          return;
        }
        if (stage.approverDepartmentResolution !== 'FIXED') return;
        const department = stage.approverFixedDepartmentId
          ? references.departments.get(stage.approverFixedDepartmentId)
          : undefined;
        if (!department?.isActive) {
          unresolvable();
          return;
        }
        if (department.headUserId === null) {
          warnings.push(
            issue(
              'WF_APPROVER_HEAD_MISSING',
              `A unidade aprovadora da etapa ${stage.name} não tem titular cadastrado.`,
              target,
            ),
          );
        }
        return;
      }
      default:
        unresolvable();
    }
  }

  private checkRule(
    rule: WorkflowRule,
    definition: WorkflowDefinition,
    stagesById: ReadonlyMap<string, WorkflowStage>,
    references: WorkflowReferences,
    errors: WorkflowValidationIssue[],
    warnings: WorkflowValidationIssue[],
  ): void {
    const target = { ruleId: rule.id };
    const invalid = (code: WorkflowValidationErrorCode, detail: string) =>
      errors.push(issue(code, `A regra ${rule.name} está inválida: ${detail}.`, target));

    for (const problem of ruleConfigProblems(rule.type, rule.config)) {
      invalid(problem.code, problem.detail);
    }

    if (rule.scope === 'STAGE_EXIT') {
      const stage = rule.stageId ? stagesById.get(rule.stageId) : undefined;
      if (!stage) invalid('WF_RULE_SCOPE_INVALID', 'a etapa da regra não existe na versão');
      else if (stage.type === 'END') {
        invalid('WF_RULE_SCOPE_INVALID', 'a etapa final não tem regra de saída');
      } else if (stage.type === 'PARALLEL_SPLIT') {
        // RN-WF2-08 (V-12): a junção aceita `STAGE_EXIT` (avalia o processo inteiro — US-124).
        errors.push(
          issue(
            'WF_RULE_SCOPE_INVALID',
            `A ramificação não tem saída própria; configure a regra ${rule.name} na etapa anterior ou na junção.`,
            target,
          ),
        );
      }
    } else {
      const transition = rule.transitionId
        ? definition.transitions.find((candidate) => candidate.id === rule.transitionId)
        : undefined;
      if (!transition)
        invalid('WF_RULE_SCOPE_INVALID', 'a transição da regra não existe na versão');
      else if (!RULE_TRANSITION_ACTIONS.includes(transition.action)) {
        invalid(
          'WF_RULE_SCOPE_INVALID',
          'regras de transição só valem para encaminhar, concluir ou aprovar',
        );
      }
    }

    const config = rule.config;
    if (rule.type === 'REQUIRED_DOCUMENT' && typeof config.documentTypeCode === 'string') {
      if (!references.activeDocumentTypeCodes.has(config.documentTypeCode)) {
        errors.push(
          issue(
            'WF_DOCUMENT_TYPE_UNKNOWN',
            `O tipo de documento ${config.documentTypeCode} não existe ou está inativo.`,
            target,
          ),
        );
      }
    }
    if (rule.type === 'REQUIRED_APPROVAL' && typeof config.stageKey === 'string') {
      const approval = definition.stages.find(
        (stage) => stage.key === config.stageKey && stage.type === 'APPROVAL',
      );
      if (!approval) {
        invalid(
          'WF_RULE_SCOPE_INVALID',
          `a etapa de aprovação ${config.stageKey} não existe na versão`,
        );
      }
    }
    if (!rule.isActive) {
      warnings.push(issue('WF_RULE_INACTIVE', `A regra ${rule.name} está inativa.`, target));
    }
  }
}
