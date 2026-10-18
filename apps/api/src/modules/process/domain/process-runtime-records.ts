import type { DayCountType } from '@contrataflow/types';
import type { MovementDocumentRef, ProcessStatus } from '@contrataflow/validation';

/*
 * Runtime da tramitação (US-001 · entities.md §4.4): a passagem pela etapa (`ProcessStage.enter`),
 * a responsabilidade (`ProcessAssignment`), o registro da tramitação (`ProcessMovement.record` —
 * imutável) e as concessões de visibilidade (`ProcessAccess` — DEC-024 · permissions.md §5). A
 * criação usa a passagem nº 1 (`STAGE_ENTRY`) e a tramitação nº 1 (`CREATE`); a US-047 reaproveita
 * as mesmas peças nas passagens seguintes.
 */

export interface ProcessStageRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly workflowStageId: string;
  readonly sequence: number;
  readonly status: 'ACTIVE';
  readonly departmentId: string;
  readonly assigneeId: string | null;
  readonly enteredAt: Date;
  readonly dueAt: Date | null;
  readonly slaDays: number | null;
  readonly slaType: DayCountType | null;
  readonly enteredViaMovementId: string | null;
}

/** `ProcessStage.enter`: passagem ATIVA pela etapa, com o SLA congelado da definição. */
export function enterStage(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly workflowStageId: string;
  readonly sequence: number;
  readonly departmentId: string;
  readonly assigneeId: string | null;
  readonly enteredAt: Date;
  readonly dueAt: Date | null;
  readonly slaDays: number | null;
  readonly slaType: DayCountType | null;
  readonly movementId: string;
}): ProcessStageRecord {
  return {
    id: input.id,
    tenantId: input.tenantId,
    processId: input.processId,
    workflowStageId: input.workflowStageId,
    sequence: input.sequence,
    status: 'ACTIVE',
    departmentId: input.departmentId,
    assigneeId: input.assigneeId,
    enteredAt: input.enteredAt,
    dueAt: input.dueAt,
    slaDays: input.slaDays,
    slaType: input.slaDays === null ? null : input.slaType,
    enteredViaMovementId: input.movementId,
  };
}

export interface ProcessAssignmentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly processStageId: string;
  readonly departmentId: string;
  readonly assigneeId: string | null;
  readonly type: 'STAGE_ENTRY' | 'CLAIM' | 'MANUAL' | 'RETURN';
  readonly assignedById: string | null;
  readonly startedAt: Date;
}

/**
 * Responsabilidade automática da entrada na etapa (`STAGE_ENTRY`; `RETURN` na devolução — US-048):
 * sem autor, salvo na atribuição direta do encaminhamento (`assignedById` = ator — RN-TRAM-14).
 */
export function stageEntryAssignment(
  id: string,
  stage: ProcessStageRecord,
  assignedById: string | null = null,
  type: Extract<ProcessAssignmentRecord['type'], 'STAGE_ENTRY' | 'RETURN'> = 'STAGE_ENTRY',
): ProcessAssignmentRecord {
  return {
    id,
    tenantId: stage.tenantId,
    processId: stage.processId,
    processStageId: stage.id,
    departmentId: stage.departmentId,
    assigneeId: stage.assigneeId,
    type,
    assignedById: stage.assigneeId === null ? null : assignedById,
    startedAt: stage.enteredAt,
  };
}

/** `MovementAction` (entities.md §2). */
export type MovementAction =
  | 'CREATE'
  | 'FORWARD'
  | 'RETURN'
  | 'CLAIM'
  | 'ASSIGN'
  | 'APPROVE'
  | 'REJECT'
  | 'COMPLETE'
  | 'CANCEL'
  | 'SUSPEND'
  | 'RESUME';

export interface ProcessMovementRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly sequence: number;
  readonly action: MovementAction;
  readonly workflowTransitionId: string | null;
  readonly fromProcessStageId: string | null;
  readonly toProcessStageId: string;
  readonly fromWorkflowStageId: string | null;
  readonly toWorkflowStageId: string;
  readonly fromDepartmentId: string | null;
  readonly toDepartmentId: string;
  readonly fromUserId: string | null;
  readonly toUserId: string | null;
  readonly statusFrom: ProcessStatus | null;
  readonly statusTo: ProcessStatus;
  readonly actorType: 'USER' | 'SYSTEM';
  readonly actorId: string | null;
  /** Unidade em nome da qual o ator agiu (a de custódia na origem — RN-TRAM-15). */
  readonly actorDepartmentId: string | null;
  readonly comment: string | null;
  readonly dueAt: Date | null;
  /** Documentos que acompanham a tramitação, com status e versão APÓS os efeitos (§5.6). */
  readonly documents: readonly MovementDocumentRef[];
  /** Aprovação decidida (US-052); a aberta pelo encaminhamento fica em `metadata`. */
  readonly approvalId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}

/** Tamanho máximo do `user_agent` gravado (entities.md §4.4). */
export const USER_AGENT_MAX = 512;

/** `ProcessMovement.record` da abertura (nº 1, `CREATE`): destino = etapa inicial (RN-PROC-07). */
export function openingMovement(input: {
  readonly id: string;
  readonly stage: ProcessStageRecord;
  readonly actorId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string;
  readonly channel: string;
}): ProcessMovementRecord {
  const { stage } = input;
  return {
    id: input.id,
    tenantId: stage.tenantId,
    processId: stage.processId,
    sequence: 1,
    action: 'CREATE',
    workflowTransitionId: null,
    fromProcessStageId: null,
    toProcessStageId: stage.id,
    fromWorkflowStageId: null,
    toWorkflowStageId: stage.workflowStageId,
    fromDepartmentId: null,
    toDepartmentId: stage.departmentId,
    fromUserId: null,
    toUserId: stage.assigneeId,
    statusFrom: null,
    statusTo: 'DRAFT',
    actorType: 'USER',
    actorId: input.actorId,
    actorDepartmentId: null,
    comment: null,
    dueAt: stage.dueAt,
    documents: [],
    approvalId: null,
    ip: input.ip === '' ? null : input.ip,
    userAgent: input.userAgent === null ? null : input.userAgent.slice(0, USER_AGENT_MAX),
    correlationId: input.correlationId,
    metadata: {
      channel: input.channel,
      calculatedDueAt: stage.dueAt?.toISOString() ?? null,
      dueDateOverridden: false,
    },
    occurredAt: stage.enteredAt,
  };
}

export type ProcessAccessReason =
  'REQUESTING' | 'CURRENT' | 'HISTORICAL' | 'CREATOR' | 'RESPONSIBLE' | 'PARTICIPANT' | 'APPROVER';

export type AccessGrant = (
  | {
      readonly principalType: 'DEPARTMENT';
      readonly departmentId: string;
      readonly reason: Extract<
        ProcessAccessReason,
        'REQUESTING' | 'CURRENT' | 'HISTORICAL' | 'PARTICIPANT'
      >;
    }
  | {
      readonly principalType: 'USER';
      readonly userId: string;
      readonly reason: Extract<
        ProcessAccessReason,
        'CREATOR' | 'RESPONSIBLE' | 'PARTICIPANT' | 'APPROVER'
      >;
    }
) & {
  /** Origem da concessão (`PARTICIPANT`: o participante — US-012). */
  readonly sourceId?: string;
};

/**
 * permissions.md §5 · RN-PROC-14 — concessões da criação: `REQUESTING` para secretaria e setor
 * solicitantes, `CURRENT` para a unidade da etapa inicial, `CREATOR` para quem criou e
 * `RESPONSIBLE` para o responsável inicial. Uma concessão por (principal, motivo).
 */
export function creationGrants(input: {
  readonly requestingSecretariatId: string;
  readonly requestingDepartmentId: string;
  readonly currentDepartmentId: string;
  readonly creatorId: string | null;
  readonly responsibleId: string | null;
}): AccessGrant[] {
  const grants: AccessGrant[] = [];
  const seen = new Set<string>();
  const add = (grant: AccessGrant) => {
    const principal = grant.principalType === 'DEPARTMENT' ? grant.departmentId : grant.userId;
    const key = `${grant.principalType}:${principal}:${grant.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    grants.push(grant);
  };
  add({
    principalType: 'DEPARTMENT',
    departmentId: input.requestingSecretariatId,
    reason: 'REQUESTING',
  });
  add({
    principalType: 'DEPARTMENT',
    departmentId: input.requestingDepartmentId,
    reason: 'REQUESTING',
  });
  add({ principalType: 'DEPARTMENT', departmentId: input.currentDepartmentId, reason: 'CURRENT' });
  if (input.creatorId !== null) {
    add({ principalType: 'USER', userId: input.creatorId, reason: 'CREATOR' });
  }
  if (input.responsibleId !== null) {
    add({ principalType: 'USER', userId: input.responsibleId, reason: 'RESPONSIBLE' });
  }
  return grants;
}
