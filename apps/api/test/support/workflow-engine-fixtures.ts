import type { ProcessStatus, RuleContextV1 } from '@contrataflow/validation';

import { runAsSystem } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { newId } from '#shared/database/ids.js';

import type { TestApi } from './api-test-app.js';
import { DefinitionBuilder } from './workflow-fixtures.js';
import type {
  ProcessDocument,
  ProcessRuntime,
  ProcessStagePass,
} from '../../src/modules/process/domain/process-runtime.js';
import type { RuleFacts, StagePassFact } from '../../src/modules/workflow/domain/rule-facts.js';
import type {
  EngineInput,
  EngineProcess,
  EngineViewer,
  ProcessActionPermission,
} from '../../src/modules/workflow/domain/workflow-engine.js';
import { buildWorkflowSnapshot } from '../../src/modules/workflow/domain/workflow-snapshot.js';
import type { WorkflowSnapshot } from '../../src/modules/workflow/domain/workflow-snapshot.js';
import { InMemoryWorkflowRepository } from '../../src/modules/workflow/infrastructure/in-memory-workflow.repository.js';

/*
 * Fixtures do motor de execução (US-041): o workflow padrão "Fase preparatória — Lei 14.133/2021"
 * (DEC-015, 7 etapas) com as regras do Background do Gherkin, o processo "0012/2026" e o runtime
 * que o módulo `process` entrega ao motor. Ids determinísticos por construtor.
 */

export const DEPARTMENTS = Object.freeze({
  secretaria: '0192c000-0000-7000-8000-00000000d001',
  setorSolicitante: '0192c000-0000-7000-8000-00000000d002',
  compras: '0192c000-0000-7000-8000-00000000d003',
  planejamento: '0192c000-0000-7000-8000-00000000d004',
});

export const PROCESS_ID = '0192c000-0000-7000-8000-00000000e012';
export const CREATOR_ID = '0192c000-0000-7000-8000-00000000c0de';

export const RISK_MAP_MESSAGE = 'Recomenda-se registrar o mapa de riscos antes de seguir.';
export const ETP_MESSAGE = 'O ETP deve estar completo.';

/** DEC-015: ABERTURA → APROVACAO_DFD → ESTUDOS_PRELIMINARES → PESQUISA_PRECOS → TERMO_REFERENCIA → APROVACAO_AUTORIDADE → CONCLUSAO. */
export function dec015Workflow(builder = new DefinitionBuilder()): DefinitionBuilder {
  return builder
    .stage('ABERTURA', 'START', { name: 'Formalização da demanda', documentTypeCodes: ['DFD'] })
    .stage('APROVACAO_DFD', 'APPROVAL', {
      name: 'Aprovação da demanda',
      approvalDocumentTypeCodes: ['DFD'],
    })
    .stage('ESTUDOS_PRELIMINARES', 'TASK', {
      name: 'Estudos preliminares e mapa de riscos',
      departmentResolution: 'CHOSEN_ON_FORWARD',
      documentTypeCodes: ['ETP', 'RISK_MAP'],
    })
    .stage('PESQUISA_PRECOS', 'TASK', {
      name: 'Pesquisa de preços',
      departmentResolution: 'FIXED',
      fixedDepartmentId: DEPARTMENTS.compras,
      assignmentPolicy: 'DEPARTMENT_HEAD',
    })
    .stage('TERMO_REFERENCIA', 'TASK', {
      name: 'Termo de Referência',
      departmentResolution: 'CHOSEN_ON_FORWARD',
      assignmentPolicy: 'PREVIOUS_ASSIGNEE',
    })
    .stage('APROVACAO_AUTORIDADE', 'APPROVAL', {
      name: 'Aprovação da autoridade competente',
      approvalDocumentTypeCodes: ['ETP', 'TR'],
    })
    .stage('CONCLUSAO', 'END', { name: 'Planejamento da contratação concluído' })
    .transition('ABERTURA', 'APROVACAO_DFD', 'FORWARD', {
      name: 'Enviar para aprovação da demanda',
      isPrimary: true,
    })
    .transition('APROVACAO_DFD', 'ESTUDOS_PRELIMINARES', 'APPROVE', { name: 'Aprovar demanda' })
    .transition('APROVACAO_DFD', 'ABERTURA', 'RETURN', { name: 'Devolver para ajustes no DFD' })
    .transition('ESTUDOS_PRELIMINARES', 'PESQUISA_PRECOS', 'FORWARD', {
      name: 'Encaminhar para pesquisa de preços',
      isPrimary: true,
    })
    .transition('ESTUDOS_PRELIMINARES', 'ABERTURA', 'RETURN', {
      name: 'Devolver para a formalização da demanda',
    })
    .transition('PESQUISA_PRECOS', 'TERMO_REFERENCIA', 'FORWARD', {
      name: 'Encaminhar para o Termo de Referência',
      isPrimary: true,
    })
    .transition('PESQUISA_PRECOS', 'ESTUDOS_PRELIMINARES', 'RETURN', {
      name: 'Devolver para os estudos preliminares',
    })
    .transition('PESQUISA_PRECOS', 'ABERTURA', 'RETURN', {
      name: 'Devolver para a formalização da demanda',
    })
    .transition('TERMO_REFERENCIA', 'APROVACAO_AUTORIDADE', 'FORWARD', {
      name: 'Enviar para a autoridade competente',
      isPrimary: true,
    })
    .transition('TERMO_REFERENCIA', 'PESQUISA_PRECOS', 'RETURN', {
      name: 'Devolver para a pesquisa de preços',
    })
    .transition('APROVACAO_AUTORIDADE', 'CONCLUSAO', 'APPROVE', { name: 'Aprovar planejamento' })
    .transition('APROVACAO_AUTORIDADE', 'TERMO_REFERENCIA', 'RETURN', {
      name: 'Devolver para o Termo de Referência',
    })
    .rule(
      'REQUIRED_DOCUMENT',
      { documentTypeCode: 'DFD', minStatus: 'COMPLETE' },
      { stage: 'ABERTURA' },
      { name: 'DFD completo', message: 'O DFD deve estar completo.' },
    )
    .rule(
      'REQUIRED_DOCUMENT',
      { documentTypeCode: 'ETP', minStatus: 'COMPLETE' },
      { stage: 'ESTUDOS_PRELIMINARES' },
      { name: 'ETP completo', message: ETP_MESSAGE, displayOrder: 0 },
    )
    .rule(
      'REQUIRED_DOCUMENT',
      { documentTypeCode: 'RISK_MAP', minStatus: 'EXISTS' },
      { stage: 'ESTUDOS_PRELIMINARES' },
      { name: 'Mapa de riscos', message: RISK_MAP_MESSAGE, severity: 'WARNING', displayOrder: 1 },
    )
    .rule(
      'CONDITION',
      { expression: { '==': [{ var: 'priceResearch.completed' }, true] } },
      { stage: 'PESQUISA_PRECOS' },
      { name: 'Pesquisa concluída', message: 'Conclua a pesquisa de preços.' },
    )
    .rule(
      'REQUIRED_DOCUMENT',
      { documentTypeCode: 'TR', minStatus: 'COMPLETE' },
      { stage: 'TERMO_REFERENCIA' },
      { name: 'TR completo', message: 'O TR deve estar completo.' },
    );
}

export function snapshotOf(builder: DefinitionBuilder): WorkflowSnapshot {
  return buildWorkflowSnapshot(builder.build());
}

/** `process.*` do RuleContext v1 do processo 0012/2026. */
export function ruleProcess(
  overrides: Partial<RuleContextV1['process']> = {},
): RuleContextV1['process'] {
  return {
    status: 'IN_PROGRESS',
    priority: 'MEDIUM',
    estimatedValue: 150000,
    contractingTypeCode: 'SERVICOS',
    modalityCode: 'PREGAO',
    originCode: 'DEMANDA_INTERNA',
    isPriceRegistration: false,
    isBudgetConfidential: false,
    pcaStatus: 'PLANNED',
    organizationId: '0192c000-0000-7000-8000-00000000a0a0',
    requestingSecretariatId: DEPARTMENTS.secretaria,
    requestingDepartmentId: DEPARTMENTS.setorSolicitante,
    tags: [],
    targetDate: null,
    year: 2026,
    itemsCount: 3,
    hasLots: false,
    ...overrides,
  };
}

let passCounter = 0;

/** Passagem pela etapa `key` (ids determinísticos). */
export function pass(
  builder: DefinitionBuilder,
  key: string,
  sequence: number,
  overrides: Partial<StagePassFact> = {},
): ProcessStagePass {
  passCounter += 1;
  return {
    processStageId: `0192c000-0000-7000-8000-0000000${String(70000 + passCounter).padStart(5, '0')}`,
    workflowStageId: builder.stageId(key),
    sequence,
    status: 'COMPLETED',
    departmentId: DEPARTMENTS.setorSolicitante,
    assigneeId: null,
    enteredAt: `2026-10-0${Math.min(sequence, 9)}T12:00:00.000Z`,
    exitedAt: `2026-10-0${Math.min(sequence + 1, 9)}T12:00:00.000Z`,
    ...overrides,
  };
}

/** Histórico até ESTUDOS_PRELIMINARES (ativa): ABERTURA e APROVACAO_DFD concluídas. */
export function passesUntilStudies(
  builder: DefinitionBuilder,
  options: { readonly assigneeId?: string | null; readonly departmentId?: string } = {},
): ProcessStagePass[] {
  return [
    pass(builder, 'ABERTURA', 1, { assigneeId: CREATOR_ID }),
    pass(builder, 'APROVACAO_DFD', 2, { departmentId: DEPARTMENTS.secretaria }),
    pass(builder, 'ESTUDOS_PRELIMINARES', 3, {
      status: 'ACTIVE',
      exitedAt: null,
      assigneeId: options.assigneeId ?? null,
      departmentId: options.departmentId ?? DEPARTMENTS.planejamento,
    }),
  ];
}

export const etp = (status: ProcessDocument['status'], isComplete: boolean): ProcessDocument => ({
  documentTypeCode: 'ETP',
  status,
  isComplete,
  versionNumber: null,
  approvedAt: null,
});

export interface RuntimeOptions {
  readonly id?: string;
  readonly tenantId: string;
  readonly workflowVersionId: string;
  readonly status?: ProcessStatus;
  readonly currentDepartmentId?: string;
  readonly currentResponsibleId?: string | null;
  readonly passes: readonly ProcessStagePass[];
  readonly documents?: readonly ProcessDocument[];
  readonly accessDepartmentIds?: readonly string[];
  readonly accessUserIds?: readonly string[];
}

/** Runtime do processo 0012/2026 como o leitor (US-001) o entregará. */
export function processRuntime(options: RuntimeOptions): ProcessRuntime {
  const status = options.status ?? 'IN_PROGRESS';
  return {
    id: options.id ?? PROCESS_ID,
    tenantId: options.tenantId,
    workflowVersionId: options.workflowVersionId,
    status,
    createdById: CREATOR_ID,
    currentDepartmentId: options.currentDepartmentId ?? DEPARTMENTS.planejamento,
    currentResponsibleId: options.currentResponsibleId ?? null,
    ruleProcess: ruleProcess({ status }),
    passes: options.passes,
    approvals: [],
    documents: options.documents ?? [],
    access: {
      departmentIds: options.accessDepartmentIds ?? [
        DEPARTMENTS.setorSolicitante,
        DEPARTMENTS.planejamento,
      ],
      userIds: options.accessUserIds ?? [CREATOR_ID],
    },
  };
}

const ALL_PERMISSIONS: readonly ProcessActionPermission[] = [
  'PROCESS_FORWARD',
  'PROCESS_RETURN',
  'PROCESS_COMPLETE',
  'PROCESS_CLAIM',
  'PROCESS_ASSIGN',
  'PROCESS_CANCEL',
  'PROCESS_SUSPEND',
];

export const VIEWER_ID = '0192c000-0000-7000-8000-00000000beef';

/** Quem consulta (padrão: custodiante — lotado na unidade atual, com todas as permissões). */
export function viewer(overrides: Partial<EngineViewer> = {}): EngineViewer {
  return {
    userId: VIEWER_ID,
    departmentIds: [DEPARTMENTS.planejamento],
    headOfDepartmentIds: [],
    permissions: new Set(ALL_PERMISSIONS),
    canAssignAnywhere: true,
    ...overrides,
  };
}

export function engineProcess(overrides: Partial<EngineProcess> = {}): EngineProcess {
  return {
    status: 'IN_PROGRESS',
    createdById: CREATOR_ID,
    currentDepartmentId: DEPARTMENTS.planejamento,
    currentResponsibleId: null,
    requestingDepartmentId: DEPARTMENTS.setorSolicitante,
    requestingSecretariatId: DEPARTMENTS.secretaria,
    ...overrides,
  };
}

/** RuleContext v1 vazio (sem documentos, pesquisa nem riscos) na etapa `stageKey`. */
export function ruleContext(
  stageKey: string,
  overrides: Partial<RuleContextV1> = {},
): RuleContextV1 {
  return {
    version: 1,
    now: '2026-10-15T12:00:00.000Z',
    process: ruleProcess(),
    documents: {},
    priceResearch: {
      exists: false,
      completed: false,
      totalEstimatedValue: null,
      itemsBelowMinimum: 0,
      itemsWithOutliers: 0,
      itemsWithoutValidQuotes: 0,
    },
    risks: { count: 0, highOrExtremeCount: 0, withoutTreatmentCount: 0 },
    stage: { key: stageKey, enteredAt: '2026-10-10T12:00:00.000Z', businessDaysInStage: 3 },
    ...overrides,
  };
}

/** Entrada do motor puro. */
export function engineInput(
  builder: DefinitionBuilder,
  facts: Partial<RuleFacts> & Pick<RuleFacts, 'passes'>,
  process: Partial<EngineProcess> = {},
): EngineInput {
  return {
    definition: snapshotOf(builder),
    process: engineProcess(process),
    facts: {
      context: facts.context ?? ruleContext('ESTUDOS_PRELIMINARES'),
      documents: facts.documents ?? [],
      passes: facts.passes,
      approvals: facts.approvals ?? [],
    },
  };
}

/**
 * Grava a versão do construtor como PUBLICADA (com o snapshot) no repositório em memória da API de
 * teste — o caminho de publicação validado é da US-040/US-045; aqui só interessa o que o motor lê.
 */
export async function seedPublishedInMemory(
  api: TestApi,
  tenantId: string,
  builder: DefinitionBuilder,
  key: string,
): Promise<void> {
  const workflows = api.app.get(InMemoryWorkflowRepository, { strict: false });
  const now = new Date('2026-10-01T12:00:00.000Z');
  const base = {
    tenantId,
    createdAt: now,
    updatedAt: now,
    createdById: null,
    updatedById: null,
    version: 1,
  };
  const workflowId = newId();
  const snapshot = snapshotOf(builder);
  await runAsSystem({ name: 'test.seed', tenantId }, () =>
    runSimulatedTransaction(async (tx) => {
      await workflows.insertWorkflow(tx, {
        ...base,
        id: workflowId,
        key,
        name: 'Fase preparatória — Lei 14.133/2021',
        description: null,
        isActive: true,
        isDefault: true,
        applicabilityRule: null,
        applicabilityPriority: 0,
        currentPublishedVersionId: builder.versionId,
      });
      await workflows.insertVersion(tx, {
        ...base,
        id: builder.versionId,
        workflowId,
        versionNumber: 1,
        status: 'PUBLISHED',
        initialStageId: snapshot.initialStageId,
        changeNotes: null,
        publishedAt: now,
        publishedById: null,
        retiredAt: null,
        retiredById: null,
        definitionSnapshot: snapshot,
        definitionHash: 'a'.repeat(64),
      });
    }),
  );
}
