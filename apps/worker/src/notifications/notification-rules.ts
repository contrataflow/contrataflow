import { NOTIFICATION_REGISTRY } from '@contrataflow/types';
import type {
  DomainEventEnvelope,
  NotificationPriority,
  NotificationType,
  PermissionCode,
} from '@contrataflow/types';

import { notificationContent } from './notification-templates.js';
import type { NotificationContent } from './notification-templates.js';

/*
 * Regras do registro `NotificationType` (events.md §6 · US-111): de cada evento de domínio, o tipo
 * de notificação, a especificação dos destinatários (coluna "Destinatários"), o conteúdo e o link.
 * Puro — a resolução das especificações em pessoas (banco, fontes dos módulos donos) é do
 * `RecipientResolver`. Evento sem regra é descartado pelo dispatcher (RN-NTF-01).
 */

/** Fontes de destinatários dos módulos donos (registradas quando a story deles existir). */
export type RecipientLookup =
  /** Criador, responsável atual e participantes com `notify` (US-001/US-012). */
  | 'PROCESS_STAKEHOLDERS'
  /** Solicitante e responsáveis (`responsibleId`) dos documentos cobertos (US-051/US-052). */
  | 'APPROVAL_STAKEHOLDERS'
  /** Detentores do perfil aprovador com escopo sobre o processo, máx. 50 (US-096/US-051). */
  | 'ROLE_HOLDERS'
  /** Quem enviou o anexo (US-068). */
  | 'ATTACHMENT_UPLOADER'
  /** Quem solicitou a renderização (US-067). */
  | 'RENDITION_REQUESTER';

export type RecipientSpec =
  /** Usuário do payload (`toUserId`, `approverUserId`…); nulo = nada. */
  | { readonly kind: 'USER'; readonly userId: string | null }
  /** Membros ativos lotados na unidade (máx. 50, senão titular e substituto — FA-01). */
  | {
      readonly kind: 'DEPARTMENT_MEMBERS';
      readonly departmentId: string | null;
      readonly permission?: PermissionCode;
    }
  /** Titular da unidade e, se pedido, o substituto. */
  | {
      readonly kind: 'DEPARTMENT_HEADS';
      readonly departmentId: string | null;
      readonly includeDeputy: boolean;
    }
  /** Dono do vínculo (`membershipId` do payload). */
  | { readonly kind: 'MEMBERSHIP_USER'; readonly membershipId: string | null }
  | { readonly kind: 'LOOKUP'; readonly lookup: RecipientLookup }
  /** A primeira especificação que resolver alguém ("`toUserId`; se nulo, membros da unidade"). */
  | { readonly kind: 'FIRST_OF'; readonly specs: readonly RecipientSpec[] };

export interface NotificationPlan {
  readonly kind: 'notify';
  readonly type: NotificationType;
  readonly priority: NotificationPriority;
  /** União das especificações (a resolução remove repetidos, o ator e quem não vê o processo). */
  readonly recipients: readonly RecipientSpec[];
  readonly processId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly link: string | null;
  /** Conteúdo para `groupCount` eventos agregados (o agrupamento reescreve título e corpo). */
  readonly content: (groupCount: number) => NotificationContent;
  /**
   * Exceção à RN-NTF-02 (events.md §6): avisos de trabalho assíncrono pedido pelo próprio ator
   * (`AI_GENERATION_READY`/`AI_GENERATION_FAILED`) vão a ele.
   */
  readonly includeActor?: boolean;
}

export type PlanOutcome =
  | NotificationPlan
  /** `eventType` fora do registro (RN-NTF-01 · V-03): log `warn`, nunca erro do job. */
  | { readonly kind: 'unmapped' }
  /** Tipo do registro gerado por outra story (lembretes de prazo — US-114). */
  | { readonly kind: 'deferred'; readonly type: NotificationType }
  /** Evento mapeado cuja variante não notifica (ex.: encaminhamento para etapa de aprovação). */
  | { readonly kind: 'ignored'; readonly reason: string };

type Payload = Readonly<Record<string, unknown>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function id(payload: Payload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function text(payload: Payload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function nested(payload: Payload, key: string): Payload {
  const value = payload[key];
  return typeof value === 'object' && value !== null ? (value as Payload) : {};
}

const processLink = (processId: string | null) =>
  processId === null ? null : `/processos/${processId}`;

/** Último segmento da routing key (`process.status_changed.suspended` → `suspended`). */
const routingSuffix = (routingKey: string) => routingKey.slice(routingKey.lastIndexOf('.') + 1);

function plan(
  type: NotificationType,
  event: DomainEventEnvelope<Payload>,
  fields: {
    readonly recipients: readonly RecipientSpec[];
    readonly entityType: string | null;
    readonly entityId: string | null;
    readonly link: string | null;
    readonly variant?: string;
    readonly includeActor?: boolean;
  },
): NotificationPlan {
  return {
    ...(fields.includeActor ? { includeActor: true } : {}),
    kind: 'notify',
    type,
    priority: NOTIFICATION_REGISTRY[type].mandatory ? 'HIGH' : 'NORMAL',
    recipients: fields.recipients,
    processId: event.processId,
    entityType: fields.entityType,
    entityId: fields.entityId,
    link: fields.link,
    content: (groupCount) => notificationContent(type, { groupCount, variant: fields.variant }),
  };
}

const RETURN_CAUSES: ReadonlySet<string> = new Set([
  'RETURN',
  'APPROVAL_RETURNED',
  'APPROVAL_REJECTED',
]);
const RECEIVING_STAGES: ReadonlySet<string> = new Set(['START', 'TASK']);
const NOTIFIED_ASSIGNMENTS: ReadonlySet<string> = new Set(['MANUAL', 'RETURN']);
const NOTIFIED_STATUSES: ReadonlySet<string> = new Set([
  'suspended',
  'resumed',
  'canceled',
  'completed',
]);

type Rule = (event: DomainEventEnvelope<Payload>) => PlanOutcome;

/** Regras por `eventType` — uma linha de events.md §6 pode ter vários eventos de origem. */
const RULES: Readonly<Record<string, Rule>> = {
  ProcessStageChanged: (event) => {
    const { payload, processId } = event;
    const cause = text(payload, 'cause') ?? '';
    const toUserId = id(payload, 'toUserId');
    const toDepartmentId = id(payload, 'toDepartmentId');
    const common = { entityType: 'Process', entityId: processId, link: processLink(processId) };
    if (RETURN_CAUSES.has(cause)) {
      // Responsável de destino (o produtor já resolve `PREVIOUS_ASSIGNEE` em `toUserId`).
      return plan('PROCESS_RETURNED', event, {
        ...common,
        recipients: [
          {
            kind: 'FIRST_OF',
            specs: [
              { kind: 'USER', userId: toUserId },
              { kind: 'DEPARTMENT_MEMBERS', departmentId: toDepartmentId },
            ],
          },
        ],
      });
    }
    const stageType = text(nested(payload, 'toStage'), 'type') ?? '';
    if (!RECEIVING_STAGES.has(stageType)) {
      return { kind: 'ignored', reason: `stage_${stageType || 'unknown'}` };
    }
    return plan('PROCESS_RECEIVED', event, {
      ...common,
      recipients: [
        {
          kind: 'FIRST_OF',
          specs: [
            { kind: 'USER', userId: toUserId },
            {
              kind: 'DEPARTMENT_MEMBERS',
              departmentId: toDepartmentId,
              permission: 'PROCESS_CLAIM',
            },
          ],
        },
      ],
    });
  },
  ProcessAssigned: (event) => {
    const assignmentType = text(event.payload, 'assignmentType') ?? '';
    if (!NOTIFIED_ASSIGNMENTS.has(assignmentType)) {
      return { kind: 'ignored', reason: `assignment_${assignmentType || 'unknown'}` };
    }
    return plan('PROCESS_ASSIGNED', event, {
      recipients: [{ kind: 'USER', userId: id(event.payload, 'toUserId') }],
      entityType: 'Process',
      entityId: event.processId,
      link: processLink(event.processId),
    });
  },
  ProcessStatusChanged: (event) => {
    const status = routingSuffix(event.routingKey);
    if (!NOTIFIED_STATUSES.has(status)) return { kind: 'ignored', reason: `status_${status}` };
    return plan('PROCESS_STATUS_CHANGED', event, {
      recipients: [{ kind: 'LOOKUP', lookup: 'PROCESS_STAKEHOLDERS' }],
      entityType: 'Process',
      entityId: event.processId,
      link: processLink(event.processId),
      variant: status,
    });
  },
  ApprovalRequested: (event) => {
    const { payload } = event;
    const approverType = text(payload, 'approverType');
    const recipients: RecipientSpec[] =
      approverType === 'ROLE'
        ? [{ kind: 'LOOKUP', lookup: 'ROLE_HOLDERS' }]
        : approverType === 'DEPARTMENT_HEAD'
          ? [
              {
                kind: 'DEPARTMENT_HEADS',
                departmentId: id(payload, 'approverDepartmentId'),
                includeDeputy: payload.allowDeputy === true,
              },
            ]
          : [{ kind: 'USER', userId: id(payload, 'approverUserId') }];
    const approvalId = id(payload, 'approvalId');
    return plan('APPROVAL_REQUESTED', event, {
      recipients,
      entityType: 'Approval',
      entityId: approvalId,
      link: approvalId === null ? processLink(event.processId) : `/aprovacoes/${approvalId}`,
    });
  },
  ApprovalCompleted: (event) => approvalDecided(event, 'approved'),
  ApprovalReturned: (event) => approvalDecided(event, 'returned'),
  ApprovalRejected: (event) => approvalDecided(event, 'rejected'),
  ApprovalReassigned: (event) => {
    const { payload } = event;
    const approvalId = id(payload, 'approvalId');
    const recipients: RecipientSpec[] = [
      { kind: 'USER', userId: id(payload, 'toApproverUserId') },
      { kind: 'USER', userId: id(payload, 'fromApproverUserId') },
    ];
    if (id(payload, 'toApproverRoleId') !== null) {
      recipients.push({ kind: 'LOOKUP', lookup: 'ROLE_HOLDERS' });
    }
    return plan('APPROVAL_REASSIGNED', event, {
      recipients,
      entityType: 'Approval',
      entityId: approvalId,
      link: approvalId === null ? processLink(event.processId) : `/aprovacoes/${approvalId}`,
    });
  },
  UserMentioned: (event) =>
    plan('MENTIONED', event, {
      recipients: [
        {
          kind: 'FIRST_OF',
          specs: [
            { kind: 'USER', userId: id(event.payload, 'mentionedUserId') },
            {
              kind: 'DEPARTMENT_MEMBERS',
              departmentId: id(event.payload, 'mentionedDepartmentId'),
            },
          ],
        },
      ],
      entityType: 'Comment',
      entityId: id(event.payload, 'commentId'),
      link: processLink(event.processId),
    }),
  CommentCreated: (event) => {
    const parentAuthorId = id(event.payload, 'parentAuthorId');
    if (id(event.payload, 'parentId') === null || parentAuthorId === null) {
      return { kind: 'ignored', reason: 'not_a_reply' };
    }
    return plan('COMMENT_REPLY', event, {
      recipients: [{ kind: 'USER', userId: parentAuthorId }],
      entityType: 'Comment',
      entityId: id(event.payload, 'commentId'),
      link: processLink(event.processId),
    });
  },
  ProcessStageDueSoon: () => ({ kind: 'deferred', type: 'STAGE_DUE_SOON' }),
  ProcessStageOverdue: () => ({ kind: 'deferred', type: 'STAGE_OVERDUE' }),
  ProcessParticipantAdded: (event) =>
    plan('PARTICIPANT_ADDED', event, {
      recipients: [
        {
          kind: 'FIRST_OF',
          specs: [
            { kind: 'USER', userId: id(event.payload, 'userId') },
            { kind: 'DEPARTMENT_MEMBERS', departmentId: id(event.payload, 'departmentId') },
          ],
        },
      ],
      entityType: 'Process',
      entityId: event.processId,
      link: processLink(event.processId),
    }),
  AttachmentRejected: (event) =>
    plan('ATTACHMENT_REJECTED', event, {
      recipients: [{ kind: 'LOOKUP', lookup: 'ATTACHMENT_UPLOADER' }],
      entityType: 'Attachment',
      entityId: id(event.payload, 'attachmentId'),
      link: processLink(event.processId),
      variant: text(event.payload, 'status') === 'INFECTED' ? 'infected' : 'rejected',
    }),
  DocumentRenditionFailed: (event) =>
    plan('DOCUMENT_RENDER_FAILED', event, {
      recipients: [{ kind: 'LOOKUP', lookup: 'RENDITION_REQUESTER' }],
      entityType: 'Document',
      entityId: id(event.payload, 'documentId'),
      link: processLink(event.processId),
    }),
  RoleAssigned: (event) => roleChanged(event, 'assigned'),
  RoleRevoked: (event) => roleChanged(event, 'revoked'),
  AiGenerationCompleted: (event) => aiGeneration('AI_GENERATION_READY', event),
  AiGenerationFailed: (event) => aiGeneration('AI_GENERATION_FAILED', event),
};

/**
 * US-115: o solicitante (`requestedById`, o próprio ator do envelope) recebe o aviso; o link abre o
 * editor do documento com o painel de IA na geração (`?ia=<generationId>`).
 */
function aiGeneration(
  type: 'AI_GENERATION_READY' | 'AI_GENERATION_FAILED',
  event: DomainEventEnvelope<Payload>,
): PlanOutcome {
  const generationId = id(event.payload, 'generationId');
  const documentId = id(event.payload, 'documentId');
  const base =
    event.processId === null
      ? null
      : documentId === null
        ? `/processos/${event.processId}`
        : `/processos/${event.processId}/documentos/${documentId}`;
  return plan(type, event, {
    recipients: [{ kind: 'USER', userId: id(event.payload, 'requestedById') }],
    entityType: 'AiGeneration',
    entityId: generationId,
    link: base === null || generationId === null ? base : `${base}?ia=${generationId}`,
    includeActor: true,
  });
}

function approvalDecided(event: DomainEventEnvelope<Payload>, decision: string): PlanOutcome {
  const approvalId = id(event.payload, 'approvalId');
  return plan('APPROVAL_DECIDED', event, {
    recipients: [{ kind: 'LOOKUP', lookup: 'APPROVAL_STAKEHOLDERS' }],
    entityType: 'Approval',
    entityId: approvalId,
    link: approvalId === null ? processLink(event.processId) : `/aprovacoes/${approvalId}`,
    variant: decision,
  });
}

function roleChanged(event: DomainEventEnvelope<Payload>, change: string): PlanOutcome {
  return plan('ROLE_CHANGED', event, {
    recipients: [{ kind: 'MEMBERSHIP_USER', membershipId: id(event.payload, 'membershipId') }],
    entityType: 'RoleAssignment',
    entityId: id(event.payload, 'roleAssignmentId'),
    link: '/perfil',
    variant: change,
  });
}

/** `eventType`s com regra — um teste confere que cobrem os eventos de origem do registro. */
export const NOTIFICATION_RULE_EVENTS: readonly string[] = Object.keys(RULES);

export function planNotification(event: DomainEventEnvelope<Payload>): PlanOutcome {
  const rule = Object.hasOwn(RULES, event.eventType) ? RULES[event.eventType] : undefined;
  return rule ? rule(event) : { kind: 'unmapped' };
}
