import type {
  DomainEventEnvelope,
  TimelineEntryType,
  TimelineVisibility,
} from '@contrataflow/types';
import { z } from 'zod';

import {
  BUDGET_VALUE_FIELDS,
  TimelinePayloadError,
  budgetVisibility,
  commentExcerpt,
} from './timeline-entry.js';
import type { TimelineEntryProjection, TimelineParams } from './timeline-entry.js';
import { lookupRef } from './timeline-lookups.js';
import type { TimelineLookupRef, TimelineLookups } from './timeline-lookups.js';

/*
 * Mapeamento evento → `TimelineEntryType` (US-059 · RN-TML-02 · events.md §5): uma linha por
 * evento de origem, com o discriminador do payload quando houver (FA-02) — `cause` de
 * `ProcessStageChanged`, `assignmentType` de `ProcessAssigned`, `toStatus` de
 * `ProcessStatusChanged`, `byModerator` de `CommentDeleted`. Cada linha lê do payload só o que a
 * entrada precisa (V-01: campo exigido ausente → `TimelinePayloadError`), declara as referências
 * cujos nomes serão congelados (RN-TML-04) e monta `params`, visibilidade (POL-09) e a entidade
 * referenciada (RN-TML-08). Evento sem linha é ignorado pelo projetor (RN-TML-07). Puro: as
 * leituras auxiliares ficam com o `TimelineProjector`.
 */

/** Evento de domínio gravado no outbox (envelope DEC-160). */
export type TimelineSourceEvent = DomainEventEnvelope<Record<string, unknown>>;

export interface TimelineBuildContext {
  /** Nomes e rótulos resolvidos no momento do fato. */
  readonly lookups: TimelineLookups;
  /** Nome congelado do ator (decisor de aprovação = ator do evento). */
  readonly actorName: string | null;
}

export interface TimelinePlan {
  /** Referências cujos nomes devem ser congelados. */
  readonly refs: readonly TimelineLookupRef[];
  /** Unidade em nome da qual o ator agiu (`actorDepartmentName`), quando o evento a informa. */
  readonly actorDepartmentId: string | null;
  build(context: TimelineBuildContext): readonly TimelineEntryProjection[];
}

export interface TimelineEventMapping {
  readonly eventType: string;
  /** Tipos que o evento pode gerar (cobertura da RN-TML-02). */
  readonly entryTypes: readonly TimelineEntryType[];
  /** Fato que pode não pertencer a processo (anexo de modelo, por exemplo): ignorado sem erro. */
  readonly processOptional: boolean;
  /** Plano da projeção; `null` quando o discriminador do payload não tem linha (FA-02). */
  plan(event: TimelineSourceEvent): TimelinePlan | null;
}

interface PlanSpec {
  readonly refs?: readonly TimelineLookupRef[];
  readonly actorDepartmentId?: string | null;
  build(context: TimelineBuildContext): readonly TimelineEntryProjection[];
}

interface MappingSpec<S extends z.ZodType<Record<string, unknown>>> {
  readonly eventType: string;
  readonly entryTypes: readonly TimelineEntryType[];
  readonly processOptional?: boolean;
  readonly payload: S;
  plan(payload: z.output<S>, event: TimelineSourceEvent): PlanSpec | null;
}

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

/** `actorDepartmentId` opcional no payload de qualquer evento (unidade de atuação do ator). */
const actorDepartmentSchema = z.looseObject({ actorDepartmentId: uuid.nullish() });

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.code}`);
}

function defineMapping<S extends z.ZodType<Record<string, unknown>>>(
  spec: MappingSpec<S>,
): TimelineEventMapping {
  return {
    eventType: spec.eventType,
    entryTypes: spec.entryTypes,
    processOptional: spec.processOptional ?? false,
    plan(event) {
      const parsed = spec.payload.safeParse(event.payload);
      if (!parsed.success) throw new TimelinePayloadError(spec.eventType, issuesOf(parsed.error));
      const planned = spec.plan(parsed.data, event);
      if (planned === null) return null;
      const generic = actorDepartmentSchema.safeParse(event.payload);
      return {
        refs: planned.refs ?? [],
        actorDepartmentId:
          planned.actorDepartmentId ??
          (generic.success ? (generic.data.actorDepartmentId ?? null) : null),
        build: (context) => planned.build(context),
      };
    },
  };
}

interface EntryOptions {
  readonly visibility?: TimelineVisibility;
  /** Entidade referenciada (RN-TML-08): `[entityType, entityId]`. */
  readonly entity?: readonly [string, string] | null;
  readonly movementId?: string | null;
}

function entry(
  type: TimelineEntryType,
  params: TimelineParams,
  options: EntryOptions = {},
): TimelineEntryProjection {
  return {
    type,
    params,
    visibility: options.visibility ?? 'STANDARD',
    entityType: options.entity?.[0] ?? null,
    entityId: options.entity?.[1] ?? null,
    movementId: options.movementId ?? null,
  };
}

/** Entrada sobre o próprio processo (agregado do evento). */
function processEntity(event: TimelineSourceEvent): readonly [string, string] {
  return ['Process', event.processId ?? event.aggregateId];
}

/** `{documentLabel}` congelado: código, título e nome do tipo do documento. */
function documentParams(lookups: TimelineLookups, documentId: string): TimelineParams {
  const document = lookups.get('DOCUMENT', documentId);
  return {
    documentId,
    documentCode: document?.code ?? null,
    documentTitle: document?.title ?? null,
    typeName: document?.typeName ?? null,
  };
}

// --- Processo (events.md §4.1) -----------------------------------------------------------------

const processCreated = defineMapping({
  eventType: 'ProcessCreated',
  entryTypes: ['PROCESS_CREATED', 'PROCESS_DUPLICATED_FROM'],
  payload: z.looseObject({
    code: z.string().min(1).nullish(),
    title: z.string().min(1),
    requestingDepartmentId: uuid,
    duplicatedFromId: uuid.nullish(),
  }),
  plan: (payload, event) => ({
    refs: [
      ...lookupRef('DEPARTMENT', payload.requestingDepartmentId),
      ...lookupRef('PROCESS', payload.duplicatedFromId),
    ],
    build: ({ lookups }) => [
      entry(
        'PROCESS_CREATED',
        {
          code: payload.code ?? null,
          title: payload.title,
          requestingDepartmentName:
            lookups.get('DEPARTMENT', payload.requestingDepartmentId)?.name ?? null,
        },
        { entity: processEntity(event) },
      ),
      ...(payload.duplicatedFromId
        ? [
            entry(
              'PROCESS_DUPLICATED_FROM',
              {
                sourceProcessId: payload.duplicatedFromId,
                sourceCode: lookups.get('PROCESS', payload.duplicatedFromId)?.code ?? null,
              },
              { entity: processEntity(event) },
            ),
          ]
        : []),
    ],
  }),
});

const processUpdated = defineMapping({
  eventType: 'ProcessUpdated',
  entryTypes: ['PROCESS_UPDATED'],
  payload: z.looseObject({ changedFields: z.array(z.string().min(1)).min(1) }),
  plan: (payload, event) => {
    const revealsBudget = payload.changedFields.some((field) => BUDGET_VALUE_FIELDS.has(field));
    return {
      refs: revealsBudget ? lookupRef('PROCESS', event.processId) : [],
      build: ({ lookups }) => [
        entry(
          'PROCESS_UPDATED',
          { fields: payload.changedFields },
          {
            entity: processEntity(event),
            visibility: budgetVisibility(revealsBudget, lookups.get('PROCESS', event.processId)),
          },
        ),
      ],
    };
  },
});

const processNumberAssigned = defineMapping({
  eventType: 'ProcessNumberAssigned',
  entryTypes: ['PROCESS_NUMBER_ASSIGNED'],
  payload: z.looseObject({ code: z.string().min(1) }),
  plan: (payload, event) => ({
    build: () => [
      entry('PROCESS_NUMBER_ASSIGNED', { code: payload.code }, { entity: processEntity(event) }),
    ],
  }),
});

const processItemsChanged = defineMapping({
  eventType: 'ProcessItemsChanged',
  entryTypes: ['ITEMS_CHANGED'],
  payload: z.looseObject({
    added: z.array(uuid),
    updated: z.array(uuid),
    removed: z.array(uuid),
    itemsCount: z.int().min(0),
  }),
  plan: (payload, event) => ({
    build: () => [
      entry(
        'ITEMS_CHANGED',
        {
          itemsCount: payload.itemsCount,
          addedCount: payload.added.length,
          updatedCount: payload.updated.length,
          removedCount: payload.removed.length,
        },
        { entity: processEntity(event) },
      ),
    ],
  }),
});

const STAGE_CHANGE_TYPES = {
  FORWARD: 'PROCESS_FORWARDED',
  RETURN: 'PROCESS_RETURNED',
  APPROVAL_APPROVED: 'PROCESS_STAGE_CHANGED',
  APPROVAL_RETURNED: 'PROCESS_STAGE_CHANGED',
  APPROVAL_REJECTED: 'PROCESS_STAGE_CHANGED',
  COMPLETE: 'PROCESS_STAGE_CHANGED',
} as const satisfies Record<string, TimelineEntryType>;

/** `decision` de `PROCESS_STAGE_CHANGED` (decisão de aprovação ou conclusão). */
const STAGE_CHANGE_DECISIONS: Readonly<Record<string, string>> = {
  APPROVAL_APPROVED: 'APPROVED',
  APPROVAL_RETURNED: 'RETURNED',
  APPROVAL_REJECTED: 'REJECTED',
  COMPLETE: 'COMPLETED',
};

const stageRef = z.looseObject({ processStageId: uuid, key: z.string().min(1) });

const processStageChanged = defineMapping({
  eventType: 'ProcessStageChanged',
  entryTypes: ['PROCESS_FORWARDED', 'PROCESS_RETURNED', 'PROCESS_STAGE_CHANGED'],
  payload: z.looseObject({
    cause: z.enum([
      'FORWARD',
      'RETURN',
      'APPROVAL_APPROVED',
      'APPROVAL_RETURNED',
      'APPROVAL_REJECTED',
      'COMPLETE',
    ]),
    movementId: uuid,
    fromStage: stageRef,
    toStage: stageRef,
    fromDepartmentId: uuid,
    toDepartmentId: uuid,
    toUserId: uuid.nullish(),
    dueAt: isoDateTime.nullish(),
    documentIds: z.array(uuid),
    hasComment: z.boolean().optional(),
  }),
  plan: (payload, event) => ({
    refs: [
      ...lookupRef('PROCESS_STAGE', payload.fromStage.processStageId),
      ...lookupRef('PROCESS_STAGE', payload.toStage.processStageId),
      ...lookupRef('DEPARTMENT', payload.toDepartmentId),
      ...lookupRef('USER', payload.toUserId),
      ...payload.documentIds.flatMap((id) => lookupRef('DOCUMENT', id)),
    ],
    // A tramitação é feita em nome da unidade de custódia (origem).
    actorDepartmentId: payload.fromDepartmentId,
    build: ({ lookups }) => {
      const decision = STAGE_CHANGE_DECISIONS[payload.cause];
      return [
        entry(
          STAGE_CHANGE_TYPES[payload.cause],
          {
            fromStageName:
              lookups.get('PROCESS_STAGE', payload.fromStage.processStageId)?.name ?? null,
            toStageName: lookups.get('PROCESS_STAGE', payload.toStage.processStageId)?.name ?? null,
            toDepartmentName: lookups.get('DEPARTMENT', payload.toDepartmentId)?.name ?? null,
            toUserName: lookups.get('USER', payload.toUserId)?.name ?? null,
            dueAt: payload.dueAt ?? null,
            documents: payload.documentIds.map((id) => documentParams(lookups, id)),
            hasComment: payload.hasComment ?? false,
            ...(decision ? { decision } : {}),
          },
          { entity: processEntity(event), movementId: payload.movementId },
        ),
      ];
    },
  }),
});

const processAssigned = defineMapping({
  eventType: 'ProcessAssigned',
  entryTypes: ['PROCESS_CLAIMED', 'PROCESS_ASSIGNED'],
  payload: z.looseObject({
    assignmentType: z.enum(['STAGE_ENTRY', 'CLAIM', 'MANUAL', 'RETURN']),
    departmentId: uuid,
    fromUserId: uuid.nullish(),
    toUserId: uuid.nullish(),
  }),
  plan: (payload, event) => {
    // Atribuição pela entrada em etapa ou devolução já aparece na entrada da tramitação.
    if (payload.assignmentType === 'CLAIM') {
      return {
        actorDepartmentId: payload.departmentId,
        build: () => [entry('PROCESS_CLAIMED', {}, { entity: processEntity(event) })],
      };
    }
    if (payload.assignmentType !== 'MANUAL') return null;
    return {
      refs: [...lookupRef('USER', payload.toUserId), ...lookupRef('USER', payload.fromUserId)],
      actorDepartmentId: payload.departmentId,
      build: ({ lookups }) => [
        entry(
          'PROCESS_ASSIGNED',
          {
            toUserName: lookups.get('USER', payload.toUserId)?.name ?? null,
            fromUserName: lookups.get('USER', payload.fromUserId)?.name ?? null,
          },
          { entity: processEntity(event) },
        ),
      ],
    };
  },
});

const processStatusChanged = defineMapping({
  eventType: 'ProcessStatusChanged',
  entryTypes: ['PROCESS_SUSPENDED', 'PROCESS_RESUMED', 'PROCESS_CANCELED', 'PROCESS_COMPLETED'],
  payload: z.looseObject({
    fromStatus: z.string().min(1),
    toStatus: z.string().min(1),
    reasonProvided: z.boolean().optional(),
    reason: z.string().nullish(),
  }),
  plan: (payload, event) => {
    const type = statusChangeType(payload.fromStatus, payload.toStatus);
    if (type === null) return null;
    const params =
      type === 'PROCESS_COMPLETED'
        ? {}
        : { reason: payload.reason ?? null, reasonProvided: payload.reasonProvided ?? false };
    return { build: () => [entry(type, params, { entity: processEntity(event) })] };
  },
});

/** Ciclo de vida exibido na timeline; as demais mudanças de status vêm com a tramitação. */
function statusChangeType(from: string, to: string): TimelineEntryType | null {
  if (to === 'SUSPENDED') return 'PROCESS_SUSPENDED';
  if (to === 'CANCELED') return 'PROCESS_CANCELED';
  if (to === 'COMPLETED') return 'PROCESS_COMPLETED';
  if (from === 'SUSPENDED') return 'PROCESS_RESUMED';
  return null;
}

const participantRole = z.enum(['OBSERVER', 'COLLABORATOR', 'CONSULTANT']);

const processParticipantAdded = defineMapping({
  eventType: 'ProcessParticipantAdded',
  entryTypes: ['PARTICIPANT_ADDED'],
  payload: z
    .looseObject({
      participantId: uuid,
      userId: uuid.nullish(),
      departmentId: uuid.nullish(),
      role: participantRole,
      expiresAt: isoDateTime.nullish(),
    })
    .refine((payload) => Boolean(payload.userId) !== Boolean(payload.departmentId), {
      message: 'participante é um usuário ou uma unidade',
      path: ['userId'],
    }),
  plan: (payload) => ({
    refs: [...lookupRef('USER', payload.userId), ...lookupRef('DEPARTMENT', payload.departmentId)],
    build: ({ lookups }) => [
      entry(
        'PARTICIPANT_ADDED',
        {
          name:
            (payload.userId
              ? lookups.get('USER', payload.userId)?.name
              : lookups.get('DEPARTMENT', payload.departmentId)?.name) ?? null,
          principalType: payload.userId ? 'USER' : 'DEPARTMENT',
          role: payload.role,
          expiresAt: payload.expiresAt ?? null,
        },
        { entity: ['ProcessParticipant', payload.participantId] },
      ),
    ],
  }),
});

const processParticipantRemoved = defineMapping({
  eventType: 'ProcessParticipantRemoved',
  entryTypes: ['PARTICIPANT_REMOVED'],
  payload: z.looseObject({ participantId: uuid, reason: z.enum(['REVOKED', 'EXPIRED']) }),
  plan: (payload) => ({
    refs: lookupRef('PROCESS_PARTICIPANT', payload.participantId),
    build: ({ lookups }) => {
      const participant = lookups.get('PROCESS_PARTICIPANT', payload.participantId);
      return [
        entry(
          'PARTICIPANT_REMOVED',
          {
            name: participant?.name ?? null,
            role: participant?.role ?? null,
            reason: payload.reason,
          },
          { entity: ['ProcessParticipant', payload.participantId] },
        ),
      ];
    },
  }),
});

const processConfidentialityChanged = defineMapping({
  eventType: 'ProcessConfidentialityChanged',
  entryTypes: ['CONFIDENTIALITY_CHANGED'],
  payload: z.looseObject({ isBudgetConfidential: z.boolean() }),
  // O próprio fato de o orçamento ser sigiloso não é segredo (US-013): STANDARD.
  plan: (payload, event) => ({
    build: () => [
      entry(
        'CONFIDENTIALITY_CHANGED',
        { isBudgetConfidential: payload.isBudgetConfidential },
        { entity: processEntity(event) },
      ),
    ],
  }),
});

const processStageOverdue = defineMapping({
  eventType: 'ProcessStageOverdue',
  entryTypes: ['STAGE_OVERDUE'],
  payload: z.looseObject({ processStageId: uuid, stageKey: z.string().min(1), dueAt: isoDateTime }),
  plan: (payload) => ({
    refs: lookupRef('PROCESS_STAGE', payload.processStageId),
    build: ({ lookups }) => [
      entry(
        'STAGE_OVERDUE',
        {
          stageName: lookups.get('PROCESS_STAGE', payload.processStageId)?.name ?? null,
          stageKey: payload.stageKey,
          dueAt: payload.dueAt,
        },
        { entity: ['ProcessStage', payload.processStageId] },
      ),
    ],
  }),
});

// --- Documentos (events.md §4.3) ---------------------------------------------------------------

const documentCreated = defineMapping({
  eventType: 'DocumentCreated',
  entryTypes: ['DOCUMENT_CREATED'],
  payload: z.looseObject({
    documentId: uuid,
    documentTypeCode: z.string().min(1),
    code: z.string().min(1).nullish(),
    title: z.string().min(1),
  }),
  plan: (payload) => ({
    refs: lookupRef('DOCUMENT', payload.documentId),
    build: ({ lookups }) => [
      entry(
        'DOCUMENT_CREATED',
        {
          documentId: payload.documentId,
          documentCode: payload.code ?? lookups.get('DOCUMENT', payload.documentId)?.code ?? null,
          documentTitle: payload.title,
          typeCode: payload.documentTypeCode,
          typeName: lookups.get('DOCUMENT', payload.documentId)?.typeName ?? null,
        },
        { entity: ['Document', payload.documentId] },
      ),
    ],
  }),
});

const documentVersionCreated = defineMapping({
  eventType: 'DocumentVersionCreated',
  entryTypes: ['DOCUMENT_VERSION_CREATED'],
  payload: z.looseObject({
    documentId: uuid,
    documentVersionId: uuid,
    versionNumber: z.int().min(1),
    reason: z.string().min(1),
  }),
  plan: (payload) => ({
    refs: lookupRef('DOCUMENT', payload.documentId),
    build: ({ lookups }) => [
      entry(
        'DOCUMENT_VERSION_CREATED',
        {
          ...documentParams(lookups, payload.documentId),
          documentVersionId: payload.documentVersionId,
          versionNumber: payload.versionNumber,
          reason: payload.reason,
        },
        { entity: ['Document', payload.documentId] },
      ),
    ],
  }),
});

const documentSubmitted = defineMapping({
  eventType: 'DocumentSubmitted',
  entryTypes: ['DOCUMENT_SUBMITTED'],
  payload: z.looseObject({ documentId: uuid }),
  plan: (payload) => ({
    refs: lookupRef('DOCUMENT', payload.documentId),
    build: ({ lookups }) => [
      entry('DOCUMENT_SUBMITTED', documentParams(lookups, payload.documentId), {
        entity: ['Document', payload.documentId],
      }),
    ],
  }),
});

const documentFinalized = defineMapping({
  eventType: 'DocumentFinalized',
  entryTypes: ['DOCUMENT_FINALIZED'],
  payload: z.looseObject({
    documentId: uuid,
    typedSummary: z.record(z.string(), z.unknown()).nullish(),
  }),
  plan: (payload, event) => {
    // Resumo tipado (ex.: pesquisa de preços concluída) resume valores: POL-09.
    const revealsBudget = payload.typedSummary !== null && payload.typedSummary !== undefined;
    return {
      refs: [
        ...lookupRef('DOCUMENT', payload.documentId),
        ...(revealsBudget ? lookupRef('PROCESS', event.processId) : []),
      ],
      build: ({ lookups }) => [
        entry(
          'DOCUMENT_FINALIZED',
          {
            ...documentParams(lookups, payload.documentId),
            ...(payload.typedSummary ? { summary: payload.typedSummary } : {}),
          },
          {
            entity: ['Document', payload.documentId],
            visibility: budgetVisibility(revealsBudget, lookups.get('PROCESS', event.processId)),
          },
        ),
      ],
    };
  },
});

/** Decisão sobre o documento pela aprovação (US-052): o decisor é o ator do evento. */
function documentDecision(eventType: string, type: TimelineEntryType): TimelineEventMapping {
  return defineMapping({
    eventType,
    entryTypes: [type],
    payload: z.looseObject({ documentId: uuid, approvalId: uuid }),
    plan: (payload) => ({
      refs: lookupRef('DOCUMENT', payload.documentId),
      build: ({ lookups, actorName }) => [
        entry(
          type,
          {
            ...documentParams(lookups, payload.documentId),
            approvalId: payload.approvalId,
            approverName: actorName,
          },
          { entity: ['Document', payload.documentId] },
        ),
      ],
    }),
  });
}

/** Reabertura, cancelamento e retirada do documento (motivo opcional). */
function documentLifecycle(eventType: string, type: TimelineEntryType): TimelineEventMapping {
  return defineMapping({
    eventType,
    entryTypes: [type],
    payload: z.looseObject({ documentId: uuid, reason: z.string().nullish() }),
    plan: (payload) => ({
      refs: lookupRef('DOCUMENT', payload.documentId),
      build: ({ lookups }) => [
        entry(
          type,
          { ...documentParams(lookups, payload.documentId), reason: payload.reason ?? null },
          { entity: ['Document', payload.documentId] },
        ),
      ],
    }),
  });
}

// --- Aprovações (events.md §4.2) ---------------------------------------------------------------

const approvalRequested = defineMapping({
  eventType: 'ApprovalRequested',
  entryTypes: ['APPROVAL_REQUESTED'],
  payload: z.looseObject({
    approvalId: uuid,
    subjectType: z.enum(['PROCESS_STAGE', 'DOCUMENT']),
    approverType: z.enum(['USER', 'ROLE', 'DEPARTMENT_HEAD']),
    approverUserId: uuid.nullish(),
    approverRoleId: uuid.nullish(),
    approverDepartmentId: uuid.nullish(),
    dueAt: isoDateTime.nullish(),
  }),
  plan: (payload) => ({
    refs: [
      ...lookupRef('USER', payload.approverUserId),
      ...lookupRef('ROLE', payload.approverRoleId),
      ...lookupRef('DEPARTMENT', payload.approverDepartmentId),
    ],
    build: ({ lookups }) => [
      entry(
        'APPROVAL_REQUESTED',
        {
          subjectType: payload.subjectType,
          approverType: payload.approverType,
          approverLabel: approverLabel(lookups, payload),
          dueAt: payload.dueAt ?? null,
        },
        { entity: ['Approval', payload.approvalId] },
      ),
    ],
  }),
});

/** Quem aprova: o usuário, o perfil ou a chefia da unidade (`ApproverType`). */
function approverLabel(
  lookups: TimelineLookups,
  approver: {
    readonly approverType: 'USER' | 'ROLE' | 'DEPARTMENT_HEAD';
    readonly approverUserId?: string | null | undefined;
    readonly approverRoleId?: string | null | undefined;
    readonly approverDepartmentId?: string | null | undefined;
  },
): string | null {
  switch (approver.approverType) {
    case 'USER':
      return lookups.get('USER', approver.approverUserId)?.name ?? null;
    case 'ROLE':
      return lookups.get('ROLE', approver.approverRoleId)?.name ?? null;
    case 'DEPARTMENT_HEAD':
      return lookups.get('DEPARTMENT', approver.approverDepartmentId)?.name ?? null;
  }
}

/** Decisão da aprovação (US-052) → `APPROVAL_DECIDED` com `decision`. */
function approvalDecided(eventType: string, decision: string): TimelineEventMapping {
  return defineMapping({
    eventType,
    entryTypes: ['APPROVAL_DECIDED'],
    payload: z.looseObject({
      approvalId: uuid,
      decidedAsDeputy: z.boolean(),
      hasComment: z.boolean().optional(),
    }),
    plan: (payload) => ({
      refs: lookupRef('APPROVAL', payload.approvalId),
      build: ({ lookups }) => [
        entry(
          'APPROVAL_DECIDED',
          {
            decision,
            title: lookups.get('APPROVAL', payload.approvalId)?.title ?? null,
            asDeputy: payload.decidedAsDeputy,
            // Devolução sempre exige comentário (US-052).
            hasComment: decision === 'RETURNED' ? true : (payload.hasComment ?? false),
          },
          { entity: ['Approval', payload.approvalId] },
        ),
      ],
    }),
  });
}

const approvalCanceled = defineMapping({
  eventType: 'ApprovalCanceled',
  entryTypes: ['APPROVAL_CANCELED'],
  payload: z.looseObject({
    approvalId: uuid,
    reason: z.enum(['WITHDRAWN', 'PROCESS_CANCELED', 'REASSIGNED']),
  }),
  plan: (payload) => ({
    refs: lookupRef('APPROVAL', payload.approvalId),
    build: ({ lookups }) => [
      entry(
        'APPROVAL_CANCELED',
        {
          title: lookups.get('APPROVAL', payload.approvalId)?.title ?? null,
          reason: payload.reason,
        },
        { entity: ['Approval', payload.approvalId] },
      ),
    ],
  }),
});

const approvalReassigned = defineMapping({
  eventType: 'ApprovalReassigned',
  entryTypes: ['APPROVAL_REASSIGNED'],
  payload: z.looseObject({
    approvalId: uuid,
    toApproverUserId: uuid.nullish(),
    toApproverRoleId: uuid.nullish(),
    reason: z.string().nullish(),
  }),
  plan: (payload) => ({
    refs: [
      ...lookupRef('APPROVAL', payload.approvalId),
      ...lookupRef('USER', payload.toApproverUserId),
      ...lookupRef('ROLE', payload.toApproverRoleId),
    ],
    build: ({ lookups }) => [
      entry(
        'APPROVAL_REASSIGNED',
        {
          title: lookups.get('APPROVAL', payload.approvalId)?.title ?? null,
          toApproverLabel:
            (payload.toApproverUserId
              ? lookups.get('USER', payload.toApproverUserId)?.name
              : lookups.get('ROLE', payload.toApproverRoleId)?.name) ?? null,
          reason: payload.reason ?? null,
        },
        { entity: ['Approval', payload.approvalId] },
      ),
    ],
  }),
});

// --- Colaboração e arquivos (events.md §4.4) ---------------------------------------------------

const commentCreated = defineMapping({
  eventType: 'CommentCreated',
  entryTypes: ['COMMENT_ADDED'],
  payload: z.looseObject({
    commentId: uuid,
    targetType: z.enum(['PROCESS', 'DOCUMENT']),
    documentId: uuid.nullish(),
  }),
  plan: (payload) => ({
    refs: [
      ...lookupRef('COMMENT', payload.commentId),
      ...lookupRef('DOCUMENT', payload.documentId),
    ],
    build: ({ lookups }) => [
      entry(
        'COMMENT_ADDED',
        {
          excerpt: commentExcerpt(lookups.get('COMMENT', payload.commentId)?.excerpt ?? null),
          targetType: payload.targetType,
          ...(payload.documentId ? documentParams(lookups, payload.documentId) : {}),
        },
        { entity: ['Comment', payload.commentId] },
      ),
    ],
  }),
});

const commentDeleted = defineMapping({
  eventType: 'CommentDeleted',
  entryTypes: ['COMMENT_REMOVED'],
  payload: z.looseObject({ commentId: uuid, byModerator: z.boolean() }),
  // Só a remoção por moderação aparece; o autor apagando o próprio comentário não.
  plan: (payload) =>
    payload.byModerator
      ? { build: () => [entry('COMMENT_REMOVED', {}, { entity: ['Comment', payload.commentId] })] }
      : null,
});

const attachmentUploaded = defineMapping({
  eventType: 'AttachmentUploaded',
  entryTypes: ['ATTACHMENT_ADDED'],
  processOptional: true,
  payload: z.looseObject({
    attachmentId: uuid,
    targetType: z.string().min(1),
    targetId: uuid.nullish(),
    fileName: z.string().min(1),
  }),
  plan: (payload) => {
    const documentId = payload.targetType === 'DOCUMENT' ? (payload.targetId ?? null) : null;
    return {
      refs: lookupRef('DOCUMENT', documentId),
      build: ({ lookups }) => [
        entry(
          'ATTACHMENT_ADDED',
          {
            fileName: payload.fileName,
            targetType: payload.targetType,
            ...(documentId ? documentParams(lookups, documentId) : {}),
          },
          { entity: ['Attachment', payload.attachmentId] },
        ),
      ],
    };
  },
});

const attachmentDeleted = defineMapping({
  eventType: 'AttachmentDeleted',
  entryTypes: ['ATTACHMENT_REMOVED'],
  processOptional: true,
  payload: z.looseObject({ attachmentId: uuid }),
  plan: (payload) => ({
    refs: lookupRef('ATTACHMENT', payload.attachmentId),
    build: ({ lookups }) => {
      const attachment = lookups.get('ATTACHMENT', payload.attachmentId);
      return [
        entry(
          'ATTACHMENT_REMOVED',
          { fileName: attachment?.fileName ?? null, targetType: attachment?.targetType ?? null },
          { entity: ['Attachment', payload.attachmentId] },
        ),
      ];
    },
  }),
});

// --- Artefatos tipados (events.md §4.3) --------------------------------------------------------

const etpAlternativeRecommended = defineMapping({
  eventType: 'EtpAlternativeRecommended',
  entryTypes: ['ETP_ALTERNATIVE_RECOMMENDED'],
  payload: z.looseObject({ etpId: uuid, alternativeId: uuid }),
  plan: (payload) => ({
    refs: lookupRef('ETP_ALTERNATIVE', payload.alternativeId),
    build: ({ lookups }) => [
      entry(
        'ETP_ALTERNATIVE_RECOMMENDED',
        { name: lookups.get('ETP_ALTERNATIVE', payload.alternativeId)?.name ?? null },
        { entity: ['EtpAlternative', payload.alternativeId] },
      ),
    ],
  }),
});

/** Cotação desconsiderada ou restaurada (US-027): restrita em pesquisa sigilosa (POL-09). */
function quotationChange(eventType: string, type: TimelineEntryType): TimelineEventMapping {
  return defineMapping({
    eventType,
    entryTypes: [type],
    payload: z.looseObject({
      quotationId: uuid,
      priceItemId: uuid,
      reason: z.string().min(1).nullish(),
    }),
    plan: (payload, event) => ({
      refs: [
        ...lookupRef('PRICE_ITEM', payload.priceItemId),
        ...lookupRef('QUOTATION', payload.quotationId),
        ...lookupRef('PROCESS', event.processId),
      ],
      build: ({ lookups }) => [
        entry(
          type,
          {
            itemSequence: lookups.get('PRICE_ITEM', payload.priceItemId)?.sequence ?? null,
            sourceLabel: lookups.get('QUOTATION', payload.quotationId)?.sourceLabel ?? null,
            ...(payload.reason ? { reason: payload.reason } : {}),
          },
          {
            entity: ['Quotation', payload.quotationId],
            visibility: budgetVisibility(true, lookups.get('PROCESS', event.processId)),
          },
        ),
      ],
    }),
  });
}

const riskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH', 'EXTREME']);

const riskCreated = defineMapping({
  eventType: 'RiskCreated',
  entryTypes: ['RISK_ADDED'],
  payload: z.looseObject({ riskId: uuid, code: z.string().min(1), level: riskLevel }),
  plan: (payload) => ({
    refs: lookupRef('RISK', payload.riskId),
    build: ({ lookups }) => [
      entry(
        'RISK_ADDED',
        {
          code: payload.code,
          title: lookups.get('RISK', payload.riskId)?.title ?? null,
          level: payload.level,
        },
        { entity: ['Risk', payload.riskId] },
      ),
    ],
  }),
});

const riskAssessed = defineMapping({
  eventType: 'RiskAssessed',
  entryTypes: ['RISK_LEVEL_CHANGED'],
  payload: z.looseObject({ riskId: uuid, fromLevel: riskLevel, toLevel: riskLevel }),
  plan: (payload) => ({
    refs: lookupRef('RISK', payload.riskId),
    build: ({ lookups }) => {
      const risk = lookups.get('RISK', payload.riskId);
      return [
        entry(
          'RISK_LEVEL_CHANGED',
          {
            code: risk?.code ?? null,
            title: risk?.title ?? null,
            level: payload.toLevel,
            fromLevel: payload.fromLevel,
          },
          { entity: ['Risk', payload.riskId] },
        ),
      ];
    },
  }),
});

const riskDeleted = defineMapping({
  eventType: 'RiskDeleted',
  entryTypes: ['RISK_REMOVED'],
  payload: z.looseObject({ riskId: uuid, code: z.string().min(1) }),
  plan: (payload) => ({
    refs: lookupRef('RISK', payload.riskId),
    build: ({ lookups }) => [
      entry(
        'RISK_REMOVED',
        { code: payload.code, title: lookups.get('RISK', payload.riskId)?.title ?? null },
        { entity: ['Risk', payload.riskId] },
      ),
    ],
  }),
});

const termImportedFromEtp = defineMapping({
  eventType: 'TermImportedFromEtp',
  entryTypes: ['TERM_IMPORTED_FROM_ETP'],
  payload: z.looseObject({
    termId: uuid,
    etpVersionId: uuid,
    sectionsImported: z.array(z.string()),
    itemsImported: z.int().min(0),
  }),
  plan: (payload) => ({
    refs: lookupRef('DOCUMENT_VERSION', payload.etpVersionId),
    build: ({ lookups }) => [
      entry(
        'TERM_IMPORTED_FROM_ETP',
        {
          etpVersion: lookups.get('DOCUMENT_VERSION', payload.etpVersionId)?.versionNumber ?? null,
          sectionsCount: payload.sectionsImported.length,
          itemsImported: payload.itemsImported,
        },
        { entity: ['TermOfReference', payload.termId] },
      ),
    ],
  }),
});

/**
 * `AiGenerationCompleted` (US-115 · events.md §5): "{actor} gerou com IA {generationLabel} de
 * {documentLabel}". O ator é o solicitante (o job carrega o ator — DEC-164). Sem texto gerado: só
 * o tipo da geração, o alvo, o modelo e a versão do prompt.
 */
const aiGenerationCompleted = defineMapping({
  eventType: 'AiGenerationCompleted',
  entryTypes: ['AI_CONTENT_GENERATED'],
  payload: z.looseObject({
    generationId: uuid,
    documentId: uuid.nullable(),
    targetModule: z.string().min(1),
    kind: z.string().min(1),
    action: z.string().nullable(),
    sectionKey: z.string().nullable(),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
  }),
  plan: (payload) => ({
    refs: lookupRef('DOCUMENT', payload.documentId),
    build: ({ lookups }) => [
      entry(
        'AI_CONTENT_GENERATED',
        {
          ...(payload.documentId === null
            ? { documentId: null, documentCode: null, documentTitle: null, typeName: null }
            : documentParams(lookups, payload.documentId)),
          generationId: payload.generationId,
          targetModule: payload.targetModule,
          kind: payload.kind,
          action: payload.action,
          sectionKey: payload.sectionKey,
          model: payload.model,
          promptVersion: payload.promptVersion,
        },
        { entity: ['AiGeneration', payload.generationId] },
      ),
    ],
  }),
});

/**
 * `AiContentReviewed` (US-122 DOC-27 · US-119 RSK-12 · events.md §5): "{actor} revisou o conteúdo
 * gerado por IA em {documentLabel}" + contagens. Só chaves e ids — nunca o texto revisado.
 */
const aiContentReviewed = defineMapping({
  eventType: 'AiContentReviewed',
  entryTypes: ['AI_CONTENT_REVIEWED'],
  payload: z.looseObject({
    documentId: uuid.nullable(),
    targetModule: z.string().min(1).nullable(),
    sectionKeys: z.array(z.string()),
    riskIds: z.array(z.string()),
    generationIds: z.array(z.string()),
  }),
  plan: (payload, event) => ({
    refs: lookupRef('DOCUMENT', payload.documentId),
    build: ({ lookups }) => [
      entry(
        'AI_CONTENT_REVIEWED',
        {
          ...(payload.documentId === null
            ? { documentId: null, documentCode: null, documentTitle: null, typeName: null }
            : documentParams(lookups, payload.documentId)),
          targetModule: payload.targetModule,
          sectionKeys: payload.sectionKeys,
          sectionsCount: payload.sectionKeys.length,
          risksCount: payload.riskIds.length,
          generationIds: payload.generationIds,
        },
        { entity: ['Document', payload.documentId ?? event.aggregateId] },
      ),
    ],
  }),
});

const MAPPINGS: readonly TimelineEventMapping[] = [
  processCreated,
  processUpdated,
  processNumberAssigned,
  processItemsChanged,
  processStageChanged,
  processAssigned,
  processStatusChanged,
  processParticipantAdded,
  processParticipantRemoved,
  processConfidentialityChanged,
  processStageOverdue,
  documentCreated,
  documentVersionCreated,
  documentSubmitted,
  documentFinalized,
  documentDecision('DocumentApproved', 'DOCUMENT_APPROVED'),
  documentDecision('DocumentReturned', 'DOCUMENT_RETURNED'),
  documentDecision('DocumentRejected', 'DOCUMENT_REJECTED'),
  documentLifecycle('DocumentReopened', 'DOCUMENT_REOPENED'),
  documentLifecycle('DocumentCanceled', 'DOCUMENT_CANCELED'),
  documentLifecycle('DocumentWithdrawn', 'DOCUMENT_WITHDRAWN'),
  approvalRequested,
  approvalDecided('ApprovalCompleted', 'APPROVED'),
  approvalDecided('ApprovalReturned', 'RETURNED'),
  approvalDecided('ApprovalRejected', 'REJECTED'),
  approvalCanceled,
  approvalReassigned,
  commentCreated,
  commentDeleted,
  attachmentUploaded,
  attachmentDeleted,
  etpAlternativeRecommended,
  quotationChange('QuotationExcluded', 'QUOTATION_EXCLUDED'),
  quotationChange('QuotationRestored', 'QUOTATION_RESTORED'),
  riskCreated,
  riskAssessed,
  riskDeleted,
  termImportedFromEtp,
  aiGenerationCompleted,
  aiContentReviewed,
];

/** Registro por `eventType` (RN-TML-02); evento ausente é ignorado (RN-TML-07). */
export const TIMELINE_MAPPINGS: ReadonlyMap<string, TimelineEventMapping> = new Map(
  MAPPINGS.map((mapping) => [mapping.eventType, mapping]),
);

/**
 * Prefixos de routing key assinados pelo projetor (queues.md §7.1): os agregados dos eventos da
 * RN-TML-02. O filtro fino é o `eventType` do registro acima.
 */
export const TIMELINE_ROUTING_KEYS: readonly string[] = [
  'process.*',
  'document.*',
  'approval.*',
  'comment.*',
  'attachment.*',
  'etp.*',
  'price_research.*',
  'risk.*',
  'term.*',
  'ai.*',
];
