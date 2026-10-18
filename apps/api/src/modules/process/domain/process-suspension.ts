import { SUSPENDABLE_PROCESS_STATUSES } from '@contrataflow/validation';
import type { DayCountType, ProcessStatus } from '@contrataflow/validation';

import type { ProcessMovementRecord } from './process-runtime-records.js';
import { USER_AGENT_MAX } from './process-runtime-records.js';
import type { Process } from './process.js';

/*
 * Suspender e retomar o processo (US-008 · PRC-23/24 · DEC-013 · DEC-031 · RN-PROC-93..102). A
 * suspensão guarda o status anterior, pausa a passagem ativa (`pausedAt`) e registra a tramitação
 * `SUSPEND` com o motivo; a retomada restaura o status, estende o prazo da passagem pelos dias
 * suspensos (calculados pelo calendário do tenant fora daqui), acumula `pausedTotalSeconds` e
 * registra a tramitação `RESUME`. Etapa, unidade, responsável e concessões não mudam (RN-PROC-102).
 * Puro e determinístico: leituras, calendário, autorização e gravação são dos comandos.
 */

const SUSPENDABLE: ReadonlySet<ProcessStatus> = new Set(SUSPENDABLE_PROCESS_STATUSES);

/** RN-PROC-93: suspende-se a partir de `IN_PROGRESS`, `AWAITING_APPROVAL` ou `RETURNED`. */
export function isSuspendable(status: ProcessStatus): boolean {
  return SUSPENDABLE.has(status);
}

/** Campos de suspensão do processo (`processes.status_before_suspension`… — RN-PROC-94/97). */
export interface SuspensionFields {
  readonly statusBeforeSuspension: ProcessStatus | null;
  readonly suspendedAt: Date | null;
  readonly suspendedById: string | null;
  readonly suspensionReason: string | null;
}

/** A passagem ativa do processo travado, com os campos de prazo. */
export interface SuspendedPass {
  readonly id: string;
  readonly workflowStageId: string;
  readonly dueAt: Date | null;
  readonly slaType: DayCountType | null;
  readonly pausedAt: Date | null;
  readonly overdueSince: Date | null;
}

interface MovementActor {
  readonly userId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string;
}

interface LifecycleInput {
  /** O processo travado (`SELECT … FOR UPDATE`). */
  readonly process: Process;
  readonly active: SuspendedPass;
  /** Maior `sequence` entre as tramitações do processo. */
  readonly lastMovementSequence: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly actor: MovementActor;
  readonly now: Date;
  readonly movementId: string;
}

/** Tramitação de ciclo de vida na mesma passagem (sem mudança de etapa, unidade nem responsável). */
function lifecycleMovement(
  input: LifecycleInput,
  action: 'SUSPEND' | 'RESUME',
  statusTo: ProcessStatus,
  comment: string | null,
  dueAt: Date | null,
): ProcessMovementRecord {
  const { process, active, actor } = input;
  return {
    id: input.movementId,
    tenantId: process.tenantId,
    processId: process.id,
    sequence: input.lastMovementSequence + 1,
    action,
    workflowTransitionId: null,
    fromProcessStageId: active.id,
    toProcessStageId: active.id,
    fromWorkflowStageId: active.workflowStageId,
    toWorkflowStageId: active.workflowStageId,
    fromDepartmentId: process.currentDepartmentId,
    toDepartmentId: process.currentDepartmentId,
    fromUserId: process.currentResponsibleId,
    toUserId: process.currentResponsibleId,
    statusFrom: process.status,
    statusTo,
    actorType: 'USER',
    actorId: actor.userId,
    actorDepartmentId: process.currentDepartmentId,
    comment,
    dueAt,
    documents: [],
    approvalId: null,
    ip: actor.ip === '' ? null : actor.ip,
    userAgent:
      actor.userAgent === null || actor.userAgent === ''
        ? null
        : actor.userAgent.slice(0, USER_AGENT_MAX),
    correlationId: actor.correlationId,
    metadata: input.metadata,
    occurredAt: input.now,
  };
}

export interface SuspendInput extends LifecycleInput {
  /** Motivo já validado (20–5.000, sem espaços nas pontas). */
  readonly reason: string;
}

/** Tudo o que a suspensão grava de uma vez. */
export interface SuspendPlan {
  /** O processo suspenso (`version + 1`). */
  readonly process: Process;
  /** Versão lida sob a trava (`WHERE version` é a rede de segurança). */
  readonly expectedVersion: number;
  readonly suspension: SuspensionFields;
  /** RN-PROC-95: a passagem ativa recebe `pausedAt`. */
  readonly stageId: string;
  readonly pausedAt: Date;
  readonly movement: ProcessMovementRecord;
}

/** RN-PROC-94/95: o plano da suspensão (status anterior guardado, pausa e tramitação `SUSPEND`). */
export function planSuspension(input: SuspendInput): SuspendPlan {
  const { process, actor, now } = input;
  return {
    process: {
      ...process,
      status: 'SUSPENDED',
      updatedAt: now,
      updatedById: actor.userId,
      version: process.version + 1,
    },
    expectedVersion: process.version,
    suspension: {
      statusBeforeSuspension: process.status,
      suspendedAt: now,
      suspendedById: actor.userId,
      suspensionReason: input.reason,
    },
    stageId: input.active.id,
    pausedAt: input.active.pausedAt ?? now,
    movement: lifecycleMovement(
      input,
      'SUSPEND',
      'SUSPENDED',
      input.reason,
      process.currentStageDueAt,
    ),
  };
}

/** Extensão do prazo calculada pelo calendário do tenant (RN-PROC-98). */
export interface DeadlineExtension {
  /** Dias úteis (ou corridos) em [data local da pausa, data local da retomada). */
  readonly days: number;
  readonly slaType: DayCountType;
  /** `dueAt` acrescido de `days` (fim do dia no fuso do tenant); `null` = etapa sem prazo. */
  readonly newDueAt: Date | null;
}

export interface ResumeInput extends LifecycleInput {
  /** `statusBeforeSuspension` lido sob a trava. */
  readonly restoreTo: ProcessStatus;
  readonly extension: DeadlineExtension;
  /** Comentário opcional (até 5.000), `null` sem comentário. */
  readonly comment: string | null;
}

/** A passagem depois da retomada. */
export interface ResumedPass {
  readonly id: string;
  readonly dueAt: Date | null;
  /** Segundos somados a `pausedTotalSeconds` (retomada − `pausedAt`). */
  readonly pausedSeconds: number;
  /**
   * RN-PROC-99: o novo prazo ainda não venceu — limpa `overdueSince` (passagem e processo) e zera
   * `dueSoonNotifiedAt`/`overdueNotifiedAt`. `false` com o atraso persistente ou o prazo intacto.
   */
  readonly clearOverdue: boolean;
}

/** Tudo o que a retomada grava de uma vez. */
export interface ResumePlan {
  /** O processo retomado (status restaurado, `currentStageDueAt` estendido, `version + 1`). */
  readonly process: Process;
  readonly expectedVersion: number;
  readonly stage: ResumedPass;
  readonly movement: ProcessMovementRecord;
}

/**
 * RN-PROC-97..99: restaura o status, estende o prazo da passagem, acumula a pausa e decide se o
 * atraso persiste (`now > novo dueAt`) ou é desfeito. Etapa sem prazo só acumula a pausa (FA-02).
 */
export function planResume(input: ResumeInput): ResumePlan {
  const { process, active, actor, now, extension } = input;
  const pausedAt = active.pausedAt ?? now;
  const pausedSeconds = Math.max(0, Math.floor((now.getTime() - pausedAt.getTime()) / 1_000));
  const dueAt = active.dueAt === null ? null : (extension.newDueAt ?? active.dueAt);
  // Prazo estendido e de novo no futuro: o atraso (se havia) acaba e os avisos podem voltar.
  const clearOverdue =
    dueAt !== null &&
    dueAt.getTime() !== active.dueAt?.getTime() &&
    now.getTime() <= dueAt.getTime();
  return {
    process: {
      ...process,
      status: input.restoreTo,
      currentStageDueAt: dueAt,
      updatedAt: now,
      updatedById: actor.userId,
      version: process.version + 1,
    },
    expectedVersion: process.version,
    stage: { id: active.id, dueAt, pausedSeconds, clearOverdue },
    movement: lifecycleMovement(input, 'RESUME', input.restoreTo, input.comment, dueAt),
  };
}
