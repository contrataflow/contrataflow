import type {
  RuleType,
  StageType,
  TransitionAction,
  WorkflowRuleFields,
  WorkflowStageFields,
  WorkflowTransitionFields,
} from '@contrataflow/validation';

import type {
  WorkflowDefinition,
  WorkflowRule,
  WorkflowStage,
  WorkflowTransition,
} from '../../src/modules/workflow/domain/workflow-definition.js';
import type { WorkflowReferences } from '../../src/modules/workflow/domain/workflow-definition.validator.js';

/*
 * Construtor de definições de workflow para os testes (US-040): etapas por chave, transições e
 * regras entre chaves, ids determinísticos (ou de um gerador) e catálogos de referência abertos.
 */

const NOW = new Date('2026-10-15T12:00:00.000Z');
export const FIXTURE_TENANT = '0192c000-0000-7000-8000-00000000f0a1';
export const FIXTURE_VERSION = '0192c000-0000-7000-8000-00000000f0b1';

let counter = 0;
/** UUIDv7 sintético e único no processo de teste. */
export function fixtureId(): string {
  counter += 1;
  return `0192c000-0000-7000-8${String(counter).padStart(3, '0').slice(-3)}-${String(counter).padStart(12, '0')}`;
}

const control = (id: string, versionId: string) => ({
  id,
  tenantId: FIXTURE_TENANT,
  workflowVersionId: versionId,
  createdAt: NOW,
  updatedAt: NOW,
  createdById: null,
  updatedById: null,
  version: 1,
});

export function stageFields(
  key: string,
  type: StageType,
  overrides: Partial<WorkflowStageFields> = {},
): WorkflowStageFields {
  const approval = type === 'APPROVAL';
  return {
    key,
    name: `Etapa ${key}`,
    instructions: type === 'END' ? null : `Orientação de ${key}.`,
    type,
    groupLabel: null,
    displayOrder: 0,
    departmentResolution: 'REQUESTING_DEPARTMENT',
    fixedDepartmentId: null,
    assignmentPolicy: 'UNASSIGNED',
    approverType: approval ? 'DEPARTMENT_HEAD' : null,
    approverUserId: null,
    approverRoleId: null,
    approverDepartmentResolution: approval ? 'REQUESTING_SECRETARIAT' : null,
    approverFixedDepartmentId: null,
    allowDeputy: true,
    approvalDocumentTypeCodes: [],
    documentTypeCodes: [],
    slaDays: type === 'TASK' || approval ? 5 : null,
    slaType: 'BUSINESS',
    color: null,
    ...overrides,
  };
}

export class DefinitionBuilder {
  readonly stages: WorkflowStage[] = [];
  readonly transitions: WorkflowTransition[] = [];
  readonly rules: WorkflowRule[] = [];

  constructor(
    readonly versionId = FIXTURE_VERSION,
    private readonly newId: () => string = fixtureId,
  ) {}

  stage(key: string, type: StageType, overrides: Partial<WorkflowStageFields> = {}): this {
    this.stages.push({
      ...stageFields(key, type, { displayOrder: this.stages.length, ...overrides }),
      ...control(this.newId(), this.versionId),
    });
    return this;
  }

  stageId(key: string): string {
    const stage = this.stages.find((candidate) => candidate.key === key);
    if (!stage) throw new Error(`Etapa ${key} inexistente no construtor.`);
    return stage.id;
  }

  transition(
    from: string,
    to: string,
    action: TransitionAction,
    overrides: Partial<WorkflowTransitionFields> = {},
  ): this {
    this.transitions.push({
      key: `${from}_${action}_${to}`,
      name: `${action} ${from} → ${to}`,
      description: null,
      fromStageId: this.stageId(from),
      toStageId: this.stageId(to),
      action,
      displayOrder: this.transitions.length,
      isPrimary: false,
      requiresComment: action === 'RETURN' || action === 'REJECT',
      allowDueDateOverride: true,
      ...overrides,
      ...control(this.newId(), this.versionId),
    });
    return this;
  }

  rule(
    type: RuleType,
    config: Record<string, unknown>,
    target: { stage?: string; transition?: string } = {},
    overrides: Partial<WorkflowRuleFields> = {},
  ): this {
    const transition = target.transition
      ? this.transitions.find((candidate) => candidate.key === target.transition)
      : undefined;
    this.rules.push({
      scope: transition ? 'TRANSITION' : 'STAGE_EXIT',
      stageId: transition ? null : this.stageId(target.stage ?? this.stages[0]?.key ?? ''),
      transitionId: transition?.id ?? null,
      type,
      name: `Regra ${type}`,
      description: null,
      severity: 'BLOCKING',
      message: 'Mensagem da regra.',
      isActive: true,
      displayOrder: this.rules.length,
      ...overrides,
      config,
      ...control(this.newId(), this.versionId),
    });
    return this;
  }

  build(): WorkflowDefinition {
    return {
      stages: [...this.stages],
      transitions: [...this.transitions],
      rules: [...this.rules],
    };
  }
}

/**
 * O fluxo válido do Gherkin: ABERTURA (START) → ANALISE (TASK) → APROVACAO (APPROVAL) → FIM (END),
 * com devoluções e indeferimento — 4 etapas, 6 transições e 3 regras.
 */
export function validFourStageWorkflow(builder = new DefinitionBuilder()): DefinitionBuilder {
  return builder
    .stage('ABERTURA', 'START', { documentTypeCodes: ['DFD'] })
    .stage('ANALISE', 'TASK', { documentTypeCodes: ['ETP', 'TR'] })
    .stage('APROVACAO', 'APPROVAL', { approvalDocumentTypeCodes: ['DFD'] })
    .stage('FIM', 'END')
    .transition('ABERTURA', 'ANALISE', 'FORWARD', { isPrimary: true })
    .transition('ANALISE', 'APROVACAO', 'FORWARD', { isPrimary: true })
    .transition('ANALISE', 'ABERTURA', 'RETURN')
    .transition('APROVACAO', 'FIM', 'APPROVE')
    .transition('APROVACAO', 'ANALISE', 'RETURN')
    .transition('APROVACAO', 'ABERTURA', 'REJECT')
    .rule(
      'REQUIRED_DOCUMENT',
      { documentTypeCode: 'DFD', minStatus: 'COMPLETE' },
      { stage: 'ABERTURA' },
    )
    .rule(
      'REQUIRED_APPROVAL',
      { stageKey: 'APROVACAO' },
      { transition: 'ANALISE_FORWARD_APROVACAO' },
    )
    .rule(
      'CONDITION',
      { expression: { '>': [{ var: 'process.estimatedValue' }, 0] } },
      { stage: 'ANALISE' },
    );
}

/** Catálogos do tenant: DFD, ETP e TR ativos; sem unidades, usuários nem perfis. */
export function openReferences(overrides: Partial<WorkflowReferences> = {}): WorkflowReferences {
  return {
    activeDocumentTypeCodes: new Set(['DFD', 'ETP', 'TR']),
    departments: new Map(),
    activeUserIds: new Set(),
    roles: new Map(),
    ...overrides,
  };
}

/** Substitui o item `index` por uma cópia com `overrides` (mutações dirigidas dos testes). */
export function replaceAt<T>(list: T[], index: number, overrides: Partial<T>): void {
  const current = list[index];
  if (current === undefined) throw new Error(`Índice ${index} fora da lista.`);
  list[index] = { ...current, ...overrides };
}
