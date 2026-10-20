/**
 * Notificações in-app (entities.md §2 e §4 `Notification` · events.md §6 · US-111): o registro
 * `NotificationType` — `varchar(60)` validado aqui, extensível sem migração —, os enums do módulo
 * `notification` e a regra pura do agrupamento de 5 minutos. Tipo novo entra primeiro em
 * events.md §6, depois aqui e nas regras do `NotificationDispatcher` (`apps/worker/src/notifications`).
 */

export const NOTIFICATION_TYPES = [
  'PROCESS_RECEIVED',
  'PROCESS_RETURNED',
  'PROCESS_ASSIGNED',
  'PROCESS_STATUS_CHANGED',
  'APPROVAL_REQUESTED',
  'APPROVAL_DECIDED',
  'APPROVAL_REASSIGNED',
  'MENTIONED',
  'COMMENT_REPLY',
  'STAGE_DUE_SOON',
  'STAGE_OVERDUE',
  'PARTICIPANT_ADDED',
  'ATTACHMENT_REJECTED',
  'DOCUMENT_RENDER_FAILED',
  'ROLE_CHANGED',
  'AI_GENERATION_READY',
  'AI_GENERATION_FAILED',
  'AI_USAGE_LIMIT_WARNING',
] as const satisfies readonly string[];

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/** Story que gera o tipo: os lembretes de prazo são do job `deadlines` (US-114). */
export type NotificationDispatchOwner = 'US-111' | 'US-114';

export interface NotificationTypeDefinition {
  /** Eventos de origem (`eventType` do envelope — events.md §4). */
  readonly sourceEvents: readonly string[];
  /** Coluna "E-mail padrão" de events.md §6 (vale quando o usuário não tem preferência — US-113). */
  readonly emailByDefault: boolean;
  /** Coluna "Obrigatória": o canal in-app não pode ser desativado (US-113). */
  readonly mandatory: boolean;
  readonly dispatchedBy: NotificationDispatchOwner;
}

/** Registro `NotificationType` (events.md §6) — um teste o compara com a tabela do documento. */
export const NOTIFICATION_REGISTRY: Readonly<Record<NotificationType, NotificationTypeDefinition>> =
  Object.freeze({
    PROCESS_RECEIVED: {
      sourceEvents: ['ProcessStageChanged'],
      emailByDefault: true,
      mandatory: false,
      dispatchedBy: 'US-111',
    },
    PROCESS_RETURNED: {
      sourceEvents: ['ProcessStageChanged'],
      emailByDefault: true,
      mandatory: false,
      dispatchedBy: 'US-111',
    },
    PROCESS_ASSIGNED: {
      sourceEvents: ['ProcessAssigned'],
      emailByDefault: true,
      mandatory: false,
      dispatchedBy: 'US-111',
    },
    PROCESS_STATUS_CHANGED: {
      sourceEvents: ['ProcessStatusChanged'],
      emailByDefault: false,
      mandatory: false,
      dispatchedBy: 'US-111',
    },
    APPROVAL_REQUESTED: {
      sourceEvents: ['ApprovalRequested'],
      emailByDefault: true,
      mandatory: true,
      dispatchedBy: 'US-111',
    },
    APPROVAL_DECIDED: {
      sourceEvents: ['ApprovalCompleted', 'ApprovalReturned', 'ApprovalRejected'],
      emailByDefault: true,
      mandatory: false,
      dispatchedBy: 'US-111',
    },
    APPROVAL_REASSIGNED: {
      sourceEvents: ['ApprovalReassigned'],
      emailByDefault: true,
      mandatory: false,
      dispatchedBy: 'US-111',
    },
    MENTIONED: {
      sourceEvents: ['UserMentioned'],
      emailByDefault: true,
      mandatory: false,
      dispatchedBy: 'US-111',
    },
    COMMENT_REPLY: {
      sourceEvents: ['CommentCreated'],
      emailByDefault: false,
      mandatory: false,
      dispatchedBy: 'US-111',
    },
    STAGE_DUE_SOON: {
      sourceEvents: ['ProcessStageDueSoon'],
      emailByDefault: false,
      mandatory: false,
      dispatchedBy: 'US-114',
    },
    STAGE_OVERDUE: {
      sourceEvents: ['ProcessStageOverdue'],
      emailByDefault: true,
      mandatory: false,
      dispatchedBy: 'US-114',
    },
    PARTICIPANT_ADDED: {
      sourceEvents: ['ProcessParticipantAdded'],
      emailByDefault: true,
      mandatory: false,
      dispatchedBy: 'US-111',
    },
    ATTACHMENT_REJECTED: {
      sourceEvents: ['AttachmentRejected'],
      emailByDefault: false,
      mandatory: true,
      dispatchedBy: 'US-111',
    },
    DOCUMENT_RENDER_FAILED: {
      sourceEvents: ['DocumentRenditionFailed'],
      emailByDefault: false,
      mandatory: false,
      dispatchedBy: 'US-111',
    },
    ROLE_CHANGED: {
      sourceEvents: ['RoleAssigned', 'RoleRevoked'],
      emailByDefault: true,
      mandatory: true,
      dispatchedBy: 'US-111',
    },
    // US-115: avisam o próprio solicitante do trabalho assíncrono que ele pediu (events.md §6).
    AI_GENERATION_READY: {
      sourceEvents: ['AiGenerationCompleted'],
      emailByDefault: false,
      mandatory: false,
      dispatchedBy: 'US-111',
    },
    AI_GENERATION_FAILED: {
      sourceEvents: ['AiGenerationFailed'],
      emailByDefault: false,
      mandatory: false,
      dispatchedBy: 'US-111',
    },
    // US-116: consumo do mês cruzou 80%/100% do limite — a quem tem `SETTINGS_MANAGE` (máx. 50).
    AI_USAGE_LIMIT_WARNING: {
      sourceEvents: ['AiUsageThresholdReached'],
      emailByDefault: true,
      mandatory: false,
      dispatchedBy: 'US-111',
    },
  });

/** entities.md §2 — `NotificationChannel`. */
export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Valor de um canal quando o usuário não tem preferência salva (RN-NTF-22): o in-app é sempre o
 * padrão; o e-mail segue a coluna "E-mail padrão" do registro.
 */
export function defaultChannelEnabled(
  type: NotificationType,
  channel: NotificationChannel,
): boolean {
  return channel === 'IN_APP' ? true : NOTIFICATION_REGISTRY[type].emailByDefault;
}

/** RN-NTF-23: o in-app de um tipo obrigatório não pode ser desligado (`editable = false`). */
export function isNotificationChannelEditable(
  type: NotificationType,
  channel: NotificationChannel,
): boolean {
  return !(channel === 'IN_APP' && NOTIFICATION_REGISTRY[type].mandatory);
}

/** entities.md §2 — `NotificationPriority`. */
export const NOTIFICATION_PRIORITIES = ['NORMAL', 'HIGH'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

/** entities.md §2 — `EmailDeliveryStatus`. */
export const EMAIL_DELIVERY_STATUSES = [
  'NOT_APPLICABLE',
  'PENDING',
  'SENT',
  'FAILED',
  'SKIPPED',
] as const;
export type EmailDeliveryStatus = (typeof EMAIL_DELIVERY_STATUSES)[number];

/** Janela do agrupamento de notificações iguais (events.md §6 · RN-NTF-04). */
export const NOTIFICATION_GROUP_WINDOW_MS = 5 * 60_000;

/** Teto de `groupedEventIds` (entities.md): cheio, o próximo evento abre uma notificação nova. */
export const NOTIFICATION_MAX_GROUPED_EVENTS = 50;

/** Destinatários resolvidos por unidade ou perfil (events.md §6 · FA-01 da US-111). */
export const NOTIFICATION_MAX_UNIT_RECIPIENTS = 50;

/** Limites de conteúdo (entities.md · RN-NTF-07/08). */
export const NOTIFICATION_TITLE_MAX = 200;
export const NOTIFICATION_BODY_MAX = 1000;
export const NOTIFICATION_LINK_MAX = 500;

/** `groupKey` = `{type}:{processId}`; sem processo não há agrupamento (cada evento, uma linha). */
export function notificationGroupKey(
  type: NotificationType,
  processId: string | null,
): string | null {
  return processId === null ? null : `${type}:${processId}`;
}

/** Notificação candidata ao agrupamento (mesmo destinatário e `groupKey`, não arquivada). */
export interface GroupingCandidate {
  readonly id: string;
  readonly sourceEventId: string;
  readonly groupedEventIds: readonly string[];
  readonly createdAt: Date;
  readonly archivedAt: Date | null;
}

export type GroupingDecision =
  | { readonly kind: 'insert' }
  | { readonly kind: 'group'; readonly notificationId: string }
  | { readonly kind: 'duplicate'; readonly notificationId: string };

/**
 * Regra do agrupamento (RN-NTF-03/04 · `Notification.upsertGrouped`): o evento que já consta na
 * candidata é reentrega (nada muda); a candidata criada há MENOS de 5 minutos, não arquivada e com
 * espaço em `groupedEventIds` absorve o evento; senão, nova linha.
 */
export function decideNotificationGrouping(
  candidate: GroupingCandidate | null,
  eventId: string,
  now: Date,
): GroupingDecision {
  if (candidate === null) return { kind: 'insert' };
  if (candidate.sourceEventId === eventId || candidate.groupedEventIds.includes(eventId)) {
    return { kind: 'duplicate', notificationId: candidate.id };
  }
  const age = now.getTime() - candidate.createdAt.getTime();
  if (
    candidate.archivedAt === null &&
    age >= 0 &&
    age < NOTIFICATION_GROUP_WINDOW_MS &&
    candidate.groupedEventIds.length < NOTIFICATION_MAX_GROUPED_EVENTS
  ) {
    return { kind: 'group', notificationId: candidate.id };
  }
  return { kind: 'insert' };
}

/**
 * `emailStatus` da notificação criada (RN-NTF-05): sem desejo de e-mail (preferência do usuário ou,
 * na ausência dela, o padrão do registro) → `NOT_APPLICABLE`; desejado mas desligado no tenant
 * (`notifications.emailEnabled`) → `SKIPPED`; senão `PENDING` (enfileirado após o commit — US-112).
 */
export function decideEmailStatus(input: {
  readonly type: NotificationType;
  readonly emailPreference: boolean | undefined;
  readonly tenantEmailEnabled: boolean;
}): Extract<EmailDeliveryStatus, 'NOT_APPLICABLE' | 'SKIPPED' | 'PENDING'> {
  const wanted = input.emailPreference ?? NOTIFICATION_REGISTRY[input.type].emailByDefault;
  if (!wanted) return 'NOT_APPLICABLE';
  return input.tenantEmailEnabled ? 'PENDING' : 'SKIPPED';
}

/** Valor monetário (`R$ 1.234,56`, `R$1234`) — nunca vai em título ou corpo (POL-09). */
const MONEY = /R\$\s?\d[\d.\s]*(?:,\d{1,2})?/gi;

/**
 * Defesa em profundidade do conteúdo (RN-NTF-07 · `NotificationPresenter`): mascara valores
 * monetários que tenham escapado da origem e corta no limite da coluna (com reticências).
 */
export function scrubNotificationText(text: string, max: number): string {
  const masked = text.replace(MONEY, 'R$ •••').trim();
  return masked.length <= max ? masked : `${masked.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Rota web relativa (RN-NTF-08): `/…`, sem esquema, sem `//` e sem query (nada de token) — a única
 * query aceita é `?ia=<generationId>`, que abre o painel de IA na geração (US-115).
 */
export function isRelativeNotificationLink(link: string): boolean {
  return (
    link.length <= NOTIFICATION_LINK_MAX &&
    /^\/[A-Za-z0-9\-_/]*(?:\?ia=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i.test(
      link,
    ) &&
    !link.startsWith('//')
  );
}
