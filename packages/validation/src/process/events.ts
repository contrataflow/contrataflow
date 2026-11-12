import { z } from 'zod';

import { PROCESS_STATUSES } from './process-actions.js';
import {
  PARTICIPANT_GRANT_CHANNELS,
  PARTICIPANT_REMOVAL_REASONS,
  PARTICIPANT_ROLES,
} from './process-participants.js';
import { CREATION_CHANNELS, PRIORITIES } from './process.js';
import { defineDomainEvent } from '../events/define.js';
import { STAGE_TYPES } from '../workflow/workflow.js';

/*
 * Eventos do agregado `Process` (events.md §4.1). `ProcessCreated` (US-001): commit do PRC-02 (e,
 * na US-011, da duplicação). Consumidores: `TimelineProjector` e `ProcessAccessProjector` no mesmo
 * `tx` (DEC-161) e `BusinessMetricsCollector` (`process.*`) no worker. Sem dado sigiloso: o valor
 * estimado nunca entra no payload (events.md §1).
 */

const uuid = z.uuid();

/** Máximo de ramos de um bloco (≤ 10 esperados — story · Performance; folga para a definição). */
export const BRANCHES_MAX = 20;

export const ProcessCreated = defineDomainEvent({
  eventType: 'ProcessCreated',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    /** Nulos quando a numeração ocorre na autuação (`numbering.process.assignOn = START`). */
    code: z.string().min(1).max(40).nullable(),
    number: z.number().int().min(1).nullable(),
    year: z.number().int().min(2000).max(2100),
    title: z.string().min(1).max(200),
    organizationId: uuid,
    requestingSecretariatId: uuid,
    requestingDepartmentId: uuid,
    contractingTypeCode: z.string().min(1).max(60),
    modalityCode: z.string().min(1).max(60).nullable(),
    priority: z.enum(PRIORITIES),
    workflowId: uuid,
    workflowVersionId: uuid,
    initialStageKey: z.string().min(1).max(60),
    /** Unidade com a custódia na etapa inicial (concessão `CURRENT`). */
    initialDepartmentId: uuid,
    /** Responsável inicial (concessão `RESPONSIBLE`); `null` = fila da unidade. */
    initialResponsibleId: uuid.nullable(),
    creationChannel: z.enum(CREATION_CHANNELS),
    duplicatedFromId: uuid.nullable(),
  }),
  routingKey: 'process.created',
});

/**
 * `ProcessDuplicated` (US-011 · PRC-27): commit da duplicação, no processo de ORIGEM (envelope
 * `processId = sourceProcessId`) — o novo processo tem o próprio `ProcessCreated` com
 * `duplicatedFromId`. Consumidores: `TimelineProjector` (`PROCESS_DUPLICATED` na origem) no mesmo
 * `tx` e o `BusinessMetricsCollector` (`process.*`) no worker. Sem notificação.
 */
export const ProcessDuplicated = defineDomainEvent({
  eventType: 'ProcessDuplicated',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    sourceProcessId: uuid,
    newProcessId: uuid,
    options: z.strictObject({ copyDocuments: z.boolean(), copyAttachments: z.boolean() }),
  }),
  routingKey: 'process.duplicated',
});

/**
 * `ProcessUpdated` (US-005 · PRC-05): commit de alteração efetiva dos dados do processo. Só os
 * NOMES dos campos alterados (`changedFields`, ordem canônica de `UPDATE_PROCESS_FIELDS`) e a nova
 * versão — nunca valores (events.md §1). Consumidores: `TimelineProjector` (`PROCESS_UPDATED`) e
 * `ProcessAccessProjector` (unidade solicitante trocada — RN-PROC-62) no mesmo `tx`.
 */
export const ProcessUpdated = defineDomainEvent({
  eventType: 'ProcessUpdated',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    changedFields: z.array(z.string().min(1).max(60)).min(1).max(30),
    version: z.number().int().min(1),
  }),
  routingKey: 'process.updated',
});

/**
 * `ProcessItemsChanged` (US-006 · PRC-14..17): commit de inclusão, edição, exclusão ou
 * reordenação de itens. Só ids (`added`/`updated`/`removed` — a reordenação lista os renumerados
 * em `updated`; a troca de nome de lote, os demais itens do lote) e o total de itens ativos —
 * nunca descrições nem preços (events.md §1). Consumidores: `TimelineProjector` (`ITEMS_CHANGED`)
 * no mesmo `tx` e o `BusinessMetricsCollector` (`process.*`) no worker.
 */
export const ProcessItemsChanged = defineDomainEvent({
  eventType: 'ProcessItemsChanged',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    added: z.array(uuid),
    updated: z.array(uuid),
    removed: z.array(uuid),
    itemsCount: z.int().min(0),
  }),
  routingKey: 'process.items_changed',
});

/**
 * `ProcessParticipantAdded` (US-012 · PRC-29/PRC-31): commit da concessão a um usuário ou unidade
 * que ainda não participava. Só ids, papel, validade e as flags `notify`/`grantedVia` — nunca nomes
 * nem o motivo (texto livre). Consumidores: `TimelineProjector` (`PARTICIPANT_ADDED`) no mesmo `tx`;
 * no worker, `PARTICIPANT_ADDED` ao participante quando `notify` (o ator que segue não recebe —
 * RN-NTF-02) e o `BusinessMetricsCollector` (`process.*`).
 */
export const ProcessParticipantAdded = defineDomainEvent({
  eventType: 'ProcessParticipantAdded',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z
    .strictObject({
      participantId: uuid,
      userId: uuid.nullable(),
      departmentId: uuid.nullable(),
      role: z.enum(PARTICIPANT_ROLES),
      expiresAt: z.iso.datetime({ offset: true }).nullable(),
      notify: z.boolean(),
      grantedVia: z.enum(PARTICIPANT_GRANT_CHANNELS),
    })
    .refine((payload) => (payload.userId === null) !== (payload.departmentId === null), {
      message: 'participante é um usuário ou uma unidade',
      path: ['userId'],
    }),
  routingKey: 'process.participant_added',
});

/**
 * `ProcessParticipantRemoved` (US-012 · PRC-30/PRC-32 e job `participants-expire`): revogação
 * (`REVOKED`) ou expiração do consultor (`EXPIRED`). Consumidores: `TimelineProjector`
 * (`PARTICIPANT_REMOVED`, nome e papel lidos do participante no mesmo `tx`) e métricas. Sem
 * notificação (story · "Notificações").
 */
export const ProcessParticipantRemoved = defineDomainEvent({
  eventType: 'ProcessParticipantRemoved',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    participantId: uuid,
    reason: z.enum(PARTICIPANT_REMOVAL_REASONS),
  }),
  routingKey: 'process.participant_removed',
});

/**
 * `ProcessConfidentialityChanged` (US-013 · PRC-33): commit da ativação ou desativação do sigilo do
 * orçamento estimado (RN-PROC-137). Só a flag — nunca o valor. Consumidores: `TimelineProjector`
 * (`CONFIDENTIALITY_CHANGED`, `STANDARD`) no mesmo `tx` e métricas. Sem notificação (RN-PROC-145).
 */
export const ProcessConfidentialityChanged = defineDomainEvent({
  eventType: 'ProcessConfidentialityChanged',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({ isBudgetConfidential: z.boolean() }),
  routingKey: 'process.confidentiality_changed',
});

/* US-047 — tramitação (events.md §4.1): encaminhar e, depois, devolver, decidir e concluir. */

/** Causa da mudança de etapa (`ProcessStageChanged.cause` — DEC-162: especializa a routing key). */
export const STAGE_CHANGE_CAUSES = [
  'FORWARD',
  'RETURN',
  'APPROVAL_APPROVED',
  'APPROVAL_RETURNED',
  'APPROVAL_REJECTED',
  'COMPLETE',
] as const;
export type StageChangeCause = (typeof STAGE_CHANGE_CAUSES)[number];

const stageRef = z.strictObject({ processStageId: uuid, key: z.string().min(1).max(60) });

/**
 * `ProcessStageChanged` (US-047 · `ProcessForwarded` = `cause FORWARD`): a passagem anterior foi
 * encerrada e a nova aberta, com a tramitação `movementId`. Só ids, chaves, prazo e a presença do
 * comentário — nunca o texto nem valores (events.md §1). Consumidores: `TimelineProjector`
 * (`PROCESS_FORWARDED`…) e `ProcessAccessProjector` no mesmo `tx`; no worker, `PROCESS_RECEIVED`
 * (destino `START`/`TASK`) e métricas.
 */
export const ProcessStageChanged = defineDomainEvent({
  eventType: 'ProcessStageChanged',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    cause: z.enum(STAGE_CHANGE_CAUSES),
    movementId: uuid,
    fromStage: stageRef,
    toStage: stageRef.extend({ type: z.enum(STAGE_TYPES) }),
    fromDepartmentId: uuid,
    toDepartmentId: uuid,
    /** Responsável da nova passagem; `null` = fila da unidade de destino. */
    toUserId: uuid.nullable(),
    dueAt: z.iso.datetime({ offset: true }).nullable(),
    documentIds: z.array(uuid).max(100),
    hasComment: z.boolean(),
    /** Aprovação aberta pela entrada em etapa `APPROVAL` (US-051). */
    approvalId: uuid.nullable(),
    /** US-124 (aditivo · DEC-194): ramo da passagem de destino; ausente/nulo fora do paralelismo. */
    branchKey: z.string().min(1).max(60).nullable().optional(),
    /** US-124: a `ProcessStage` do `PARALLEL_SPLIT` que abriu o ramo. */
    splitProcessStageId: uuid.nullable().optional(),
    /** US-124: etapas ativas `TASK`/`APPROVAL` do processo DEPOIS do fato (events.md MVP 2 §2). */
    activeStageIds: z.array(uuid).max(BRANCHES_MAX).optional(),
    /**
     * US-124 (RN-WF2-27): unidades que continuam com etapa ativa depois do fato — o
     * `ProcessAccessProjector` não lhes retira o `CURRENT` (outro ramo segue na mesma unidade).
     */
    activeDepartmentIds: z.array(uuid).max(BRANCHES_MAX).optional(),
  }),
  routingKey: (payload) => `process.stage_changed.${payload.cause.toLowerCase()}`,
});

/* US-124 — ramos paralelos (events.md MVP 2 §4.1 · DEC-194 · ADR-005). Só ids, chaves e prazos. */

const branchKeySchema = z.string().min(1).max(60);

/**
 * `ProcessBranchesOpened` (US-124 · RN-WF2-13): o processo entrou no `PARALLEL_SPLIT` — uma
 * `ProcessStage` ativa e um `ProcessBranch` `OPEN` por ramo, gravados com o movimento único
 * `movementId` (etapa anterior → split). Consumidores: `TimelineProjector` (`BRANCHES_OPENED`) e
 * `ProcessAccessProjector` (`CURRENT` por ramo, `RESPONSIBLE` por responsável) no mesmo `tx`; no
 * worker, `PARALLEL_BRANCH_RECEIVED` por ramo.
 */
export const ProcessBranchesOpened = defineDomainEvent({
  eventType: 'ProcessBranchesOpened',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    movementId: uuid,
    splitProcessStageId: uuid,
    splitStageKey: z.string().min(1).max(60),
    branches: z
      .array(
        z.strictObject({
          branchKey: branchKeySchema,
          processStageId: uuid,
          stageKey: z.string().min(1).max(60),
          departmentId: uuid,
          toUserId: uuid.nullable().optional(),
          dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
        }),
      )
      .min(1)
      .max(BRANCHES_MAX),
  }),
  routingKey: 'process.branches_opened',
});

/**
 * `ProcessBranchArrived` (US-124 · RN-WF2-20): a última etapa do ramo foi concluída rumo ao
 * `PARALLEL_JOIN` (`openBranchesLeft` = ramos ainda `OPEN`). Consumidor: `TimelineProjector`
 * (`BRANCH_ARRIVED`).
 */
export const ProcessBranchArrived = defineDomainEvent({
  eventType: 'ProcessBranchArrived',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    splitProcessStageId: uuid,
    branchKey: branchKeySchema,
    /** A passagem do ramo que chegou (nome congelado na timeline). */
    processStageId: uuid,
    movementId: uuid,
    openBranchesLeft: z.number().int().min(0).max(BRANCHES_MAX),
  }),
  routingKey: 'process.branch_arrived',
});

/**
 * `ProcessBranchesJoined` (US-124 · RN-WF2-21): o último ramo chegou e a junção foi feita NA MESMA
 * transação — o processo seguiu para `nextStage`. Consumidores: `TimelineProjector`
 * (`BRANCHES_JOINED`) e `ProcessAccessProjector` (os `CURRENT` dos ramos viram `HISTORICAL`) no
 * mesmo `tx`; no worker, `PARALLEL_BRANCHES_JOINED`.
 */
export const ProcessBranchesJoined = defineDomainEvent({
  eventType: 'ProcessBranchesJoined',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    splitProcessStageId: uuid,
    joinProcessStageId: uuid,
    nextStage: z.strictObject({
      processStageId: uuid,
      key: z.string().min(1).max(60),
      type: z.enum(STAGE_TYPES),
    }),
    toDepartmentId: uuid,
    /** Responsável da etapa seguinte; `null` = fila da unidade. */
    toUserId: uuid.nullable().optional(),
    /** Unidades dos ramos encerrados (perdem o `CURRENT`, ganham o `HISTORICAL` — RN-WF2-27). */
    branchDepartmentIds: z.array(uuid).max(BRANCHES_MAX).optional(),
  }),
  routingKey: 'process.branches_joined',
});

/**
 * `ProcessBranchesCanceled` (US-124 · RN-WF2-23): a devolução para antes da ramificação cancelou os
 * ramos `OPEN` e as aprovações pendentes deles. Consumidores: `TimelineProjector`
 * (`BRANCHES_CANCELED`) e `ProcessAccessProjector` (os `CURRENT` dos ramos viram `HISTORICAL`).
 */
export const ProcessBranchesCanceled = defineDomainEvent({
  eventType: 'ProcessBranchesCanceled',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    splitProcessStageId: uuid,
    canceledBranchKeys: z.array(branchKeySchema).max(BRANCHES_MAX),
    canceledApprovalIds: z.array(uuid).max(BRANCHES_MAX * 5),
    movementId: uuid,
    /** A passagem reaberta pela devolução (nome congelado na timeline). */
    toProcessStageId: uuid,
    /** Unidades dos ramos cancelados (perdem o `CURRENT` — RN-WF2-27). */
    branchDepartmentIds: z.array(uuid).max(BRANCHES_MAX).optional(),
  }),
  routingKey: 'process.branches_canceled',
});

/* US-055 — prazos da etapa (events.md §4.1): emitidos só pelo job `deadlines` (ator `SYSTEM`). */

const stageDeadlineFields = {
  processStageId: uuid,
  stageKey: z.string().min(1).max(60),
  dueAt: z.iso.datetime({ offset: true }),
  /** Responsável da passagem; ausente/nulo = fila da unidade. */
  assigneeId: uuid.nullable().optional(),
  departmentId: uuid,
  /** US-125 (aditivo · RN-WF2-35): ramo da passagem; ausente/nulo fora do paralelismo. */
  branchKey: z.string().min(1).max(60).nullable().optional(),
};

/**
 * `ProcessStageDueSoon` (US-055 · RN-TRAM-82): a passagem ativa está a
 * `deadlines.warnBeforeBusinessDays` dias úteis (ou menos) do vencimento — uma única vez por
 * passagem (`dueSoonNotifiedAt`). Consumidor: aviso `STAGE_DUE_SOON` (US-114).
 */
export const ProcessStageDueSoon = defineDomainEvent({
  eventType: 'ProcessStageDueSoon',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    ...stageDeadlineFields,
    businessDaysLeft: z.int().min(0),
  }),
  routingKey: 'process.stage_due_soon',
});

/**
 * `ProcessStageOverdue` (US-055 · RN-TRAM-83): `now > dueAt` — uma única vez por passagem
 * (`overdueSince`/`overdueNotifiedAt`). Consumidores: timeline `STAGE_OVERDUE` (gravada pelo
 * próprio job, na mesma transação), aviso `STAGE_OVERDUE` (US-114) e métricas.
 */
export const ProcessStageOverdue = defineDomainEvent({
  eventType: 'ProcessStageOverdue',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    ...stageDeadlineFields,
    overdueSince: z.iso.datetime({ offset: true }),
  }),
  routingKey: 'process.stage_overdue',
});

/** Causa da mudança de status (`ProcessStatusChanged.cause`). */
export const STATUS_CHANGE_CAUSES = [
  'FORWARD',
  'RETURN',
  'APPROVAL_DECISION',
  'SUSPEND',
  'RESUME',
  'CANCEL',
  'COMPLETE',
] as const;
export type StatusChangeCause = (typeof STATUS_CHANGE_CAUSES)[number];

/**
 * `ProcessStatusChanged` (DEC-013): só quando o status muda (RN-TRAM-13). Routing key especializada
 * pelo status de destino (`process.status_changed.in_progress`…). Consumidores: timeline (ciclo de
 * vida), aviso `PROCESS_STATUS_CHANGED` (suspenso, retomado, cancelado, concluído) e métricas.
 */
export const ProcessStatusChanged = defineDomainEvent({
  eventType: 'ProcessStatusChanged',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    fromStatus: z.enum(PROCESS_STATUSES),
    toStatus: z.enum(PROCESS_STATUSES),
    cause: z.enum(STATUS_CHANGE_CAUSES),
    reasonProvided: z.boolean(),
    /** Motivo da suspensão/cancelamento (US-008/US-009): `params.reason` da timeline. */
    reason: z.string().min(1).max(5000).nullish(),
  }),
  // A retomada (US-008 · RN-PROC-101) restaura o status anterior: a chave é `resumed`, não o status.
  routingKey: (payload) =>
    `process.status_changed.${payload.cause === 'RESUME' ? 'resumed' : payload.toStatus.toLowerCase()}`,
});

/**
 * `ProcessDraftDiscarded` (US-009 · PRC-06 · DEC-034): o rascunho sem número foi descartado
 * (exclusão lógica). Sem timeline (o processo deixa de ser visível) e sem notificação; no worker só
 * métricas. O motivo opcional fica só na auditoria.
 */
export const ProcessDraftDiscarded = defineDomainEvent({
  eventType: 'ProcessDraftDiscarded',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({ reasonProvided: z.boolean() }),
  routingKey: 'process.draft_discarded',
});

/** `ProcessAssignment.type` (entities.md §4.4). */
export const ASSIGNMENT_TYPES = ['STAGE_ENTRY', 'CLAIM', 'MANUAL', 'RETURN'] as const;

/**
 * `ProcessAssigned`: a passagem ganhou responsável (entrada em etapa com responsável — US-047,
 * assumir — US-049, atribuir — US-050). A entrada em etapa não gera linha própria na timeline
 * (já aparece na tramitação) nem aviso `PROCESS_ASSIGNED` (o destinatário recebe `PROCESS_RECEIVED`).
 */
export const ProcessAssigned = defineDomainEvent({
  eventType: 'ProcessAssigned',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    processStageId: uuid,
    departmentId: uuid,
    fromUserId: uuid.nullable(),
    toUserId: uuid.nullable(),
    assignmentType: z.enum(ASSIGNMENT_TYPES),
    hasReason: z.boolean(),
  }),
  routingKey: 'process.assigned',
});

/**
 * `ProcessNumberAssigned` (US-047 · RN-TRAM-18 · DEC-028): autuação no 1º encaminhamento com
 * `numbering.process.assignOn = START`. Consumidor: timeline (`PROCESS_NUMBER_ASSIGNED`).
 */
export const ProcessNumberAssigned = defineDomainEvent({
  eventType: 'ProcessNumberAssigned',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    number: z.number().int().min(1),
    year: z.number().int().min(2000).max(2100),
    code: z.string().min(1).max(40),
  }),
  routingKey: 'process.number_assigned',
});
