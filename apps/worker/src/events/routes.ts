import type { QueueName } from '@contrataflow/types';
import { matchesAnyRoutingKey } from '@contrataflow/validation';

/*
 * Rotas do fan-out de `domain-events` (queues.md §7.2 · events.md §3/§6 · RN-FND-58): estáticas,
 * revisadas como contrato. Filtros por assinante rodam no consumidor, nunca aqui (§7.4).
 */

/** Filas consumidoras alimentadas pelo fan-out (o `email` segue em cadeia pelo `notifications`). */
export type FanOutQueue = Extract<QueueName, 'notifications'>;

/** Handlers leves executados no próprio job do `domain-events` (events.md §3). */
export type InlineHandlerName =
  | 'PermissionCacheInvalidator'
  | 'BusinessMetricsCollector'
  | 'SessionTerminationHandler'
  | 'ConfigCacheInvalidator'
  | 'InvitationEmailEnqueuer';

export interface DomainEventRoutes {
  readonly queues: readonly { readonly match: readonly string[]; readonly queue: FanOutQueue }[];
  readonly inline: readonly {
    readonly match: readonly string[];
    readonly handler: InlineHandlerName;
  }[];
}

export const DOMAIN_EVENT_ROUTES: DomainEventRoutes = {
  queues: [
    {
      // events.md §6 — eventos que geram notificação (NotificationDispatcher).
      match: [
        'process.stage_changed.*',
        'process.assigned',
        'process.status_changed.*',
        'process.stage_due_soon',
        'process.stage_overdue',
        'process.participant_added',
        'approval.requested',
        'approval.completed',
        'approval.returned',
        'approval.rejected',
        'approval.reassigned',
        'comment.created',
        'comment.user_mentioned',
        'attachment.rejected',
        'document.rendition_failed',
        'role.assigned',
        'role.revoked',
        // US-115: aviso ao solicitante do trabalho assíncrono de IA (AI_GENERATION_READY/FAILED).
        'ai.generation_completed',
        'ai.generation_failed',
        // US-116: aviso de 80%/100% do limite mensal a quem tem SETTINGS_MANAGE.
        'ai.usage_threshold_reached',
      ],
      queue: 'notifications',
    },
  ],
  inline: [
    {
      // US-102: titular/substituto (`department.updated`) e unidade inativa também mudam escopos.
      match: [
        'role.*',
        'membership.*',
        'department.moved',
        'department.updated',
        'department.deactivated',
      ],
      handler: 'PermissionCacheInvalidator',
    },
    {
      match: ['process.*', 'document.*', 'approval.*', 'ai.*'],
      handler: 'BusinessMetricsCollector',
    },
    {
      // events.md §3 (legenda C) — invalidadores de cache de configuração. Entram aqui os eventos
      // de configuração à medida que as stories donas os publicam (US-061: document_type.changed;
      // US-104: catalog.item_changed; US-106: catalog.holiday_changed; US-040: workflow.version_*;
      // US-042: workflow.default_changed).
      match: [
        'document_type.changed',
        'catalog.item_changed',
        'catalog.holiday_changed',
        'workflow.version_published',
        'workflow.version_retired',
        'workflow.default_changed',
      ],
      handler: 'ConfigCacheInvalidator',
    },
    {
      // RN-IAM-27 — encerra as sessões da instituição do evento. Por routing key (sem
      // `membership.*`): `membership.activated` etc. não encerram nada.
      match: ['membership.suspended', 'membership.revoked', 'membership.expired'],
      handler: 'SessionTerminationHandler',
    },
    {
      // US-091 — convite (USR-03), reenvio (USR-04) e convite do primeiro administrador: enfileira
      // o e-mail do convite na fila `email`; o `EmailSender` gera o link no envio (queues.md §4.3).
      match: ['membership.invited'],
      handler: 'InvitationEmailEnqueuer',
    },
  ],
};

export interface RouteTargets {
  /** Conjunto de filas-destino: no máximo um job por fila, mesmo com várias rotas casando. */
  readonly queues: readonly FanOutQueue[];
  readonly inline: readonly InlineHandlerName[];
}

export function resolveRoutes(
  routingKey: string,
  routes: DomainEventRoutes = DOMAIN_EVENT_ROUTES,
): RouteTargets {
  const queues = new Set<FanOutQueue>();
  const inline = new Set<InlineHandlerName>();
  for (const route of routes.queues) {
    if (matchesAnyRoutingKey(route.match, routingKey)) queues.add(route.queue);
  }
  for (const route of routes.inline) {
    if (matchesAnyRoutingKey(route.match, routingKey)) inline.add(route.handler);
  }
  return { queues: [...queues], inline: [...inline] };
}

/**
 * Decisão de roteamento explícita de cada evento registrado (V-03 · queues.md §7.4): as routing
 * keys que ele usa (cobertas pelas rotas acima) ou `NO_ASYNC_CONSUMER` (ex.: `DepartmentCreated`,
 * que nenhum consumidor assíncrono lê). Preenchido junto com `DOMAIN_EVENT_NAMES` pelas
 * stories donas; um teste reprova evento sem decisão e rota que não casa nenhuma routing key.
 */
export const ROUTING_DECISIONS: Readonly<Record<string, readonly string[] | 'NO_ASYNC_CONSUMER'>> =
  {
    DocumentTypeChanged: ['document_type.changed'],
    // US-104: o catálogo é lido a cada seleção; o invalidador de cache de configuração cobre o resto.
    CatalogItemChanged: ['catalog.item_changed'],
    // US-106: o calendário é lido a cada cálculo de prazo; o invalidador de cache por ano cobre o resto.
    HolidayChanged: ['catalog.holiday_changed'],
    // US-102: criar unidade não muda escopo de ninguém (ninguém está lotado nela ainda); mover,
    // editar (titular/substituto) e desativar invalidam o cache de permissões efetivas do tenant.
    DepartmentCreated: 'NO_ASYNC_CONSUMER',
    DepartmentUpdated: ['department.updated'],
    DepartmentMoved: ['department.moved'],
    DepartmentDeactivated: ['department.deactivated'],
    // US-101: cadastro de baixa frequência; nenhum consumidor assíncrono no MVP 1.
    OrganizationCreated: 'NO_ASYNC_CONSUMER',
    OrganizationUpdated: 'NO_ASYNC_CONSUMER',
    // US-095: perfil alterado → `PermissionCacheInvalidator` apaga o cache de permissões efetivas
    // do tenant (o payload não traz `membershipId`); até lá vale o TTL de 5 min (DEC-134).
    RoleCreated: ['role.created'],
    RoleUpdated: ['role.updated'],
    // US-096: cache do vínculo (`PermissionCacheInvalidator`) e aviso `ROLE_CHANGED` (notificações).
    RoleAssigned: ['role.assigned'],
    RoleRevoked: ['role.revoked'],
    // US-099: o caso de uso remove o status do cache logo após o commit (TTL de 30 s como rede de
    // segurança). Sessões não são encerradas: cada requisição é recusada pelo guard (RN-TEN-11).
    TenantProvisioned: 'NO_ASYNC_CONSUMER',
    TenantActivated: 'NO_ASYNC_CONSUMER',
    TenantSuspended: 'NO_ASYNC_CONSUMER',
    TenantOffboarded: 'NO_ASYNC_CONSUMER',
    TenantDeactivated: 'NO_ASYNC_CONSUMER',
    // US-103: os consumidores (FeatureFlagService, NumberingFacade…) invalidam o cache em processo
    // pela leitura da versão da chave; nenhum consumidor assíncrono no MVP 1.
    TenantSettingsChanged: 'NO_ASYNC_CONSUMER',
    // US-040: criar workflow não muda definição publicada (nada em cache a invalidar).
    WorkflowCreated: 'NO_ASYNC_CONSUMER',
    // US-040: a definição publicada é imutável por versão; o evento invalida a lista de versões
    // aplicáveis do tenant (`workflow:applicable` — US-042).
    WorkflowVersionPublished: ['workflow.version_published'],
    WorkflowVersionRetired: ['workflow.version_retired'],
    // US-042: a troca do padrão muda o conjunto aplicável do tenant (mesmo prefixo de cache).
    WorkflowDefaultChanged: ['workflow.default_changed'],
    // US-108: templates não têm cache (cada leitura vai ao banco) e a versão publicada é imutável;
    // o padrão do tipo muda por `DocumentTypeChanged`, que invalida o cache de tipos.
    TemplateVersionPublished: 'NO_ASYNC_CONSUMER',
    TemplateVersionRetired: 'NO_ASYNC_CONSUMER',
    // US-091: `membership.invited` enfileira o e-mail do convite (`InvitationEmailEnqueuer`) e,
    // como `membership.*`, invalida o cache de permissões; `membership.activated` só o segundo.
    UserInvited: ['membership.invited'],
    MembershipActivated: ['membership.activated'],
    // US-092: todos invalidam o cache de permissões do vínculo (`membership.*`); suspensão e
    // revogação também encerram as sessões da instituição (`SessionTerminationHandler`).
    MembershipUpdated: ['membership.updated'],
    MembershipSuspended: ['membership.suspended'],
    MembershipReactivated: ['membership.reactivated'],
    MembershipRevoked: ['membership.revoked'],
    // US-001: timeline e `ProcessAccess` são projetados no mesmo `tx` (síncronos); no worker só o
    // `BusinessMetricsCollector` (`process.*`). Sem notificação na criação (RN-PROC-17).
    ProcessCreated: ['process.created'],
    // US-065: timeline projetada no mesmo `tx` (síncrona); no worker só o `BusinessMetricsCollector`
    // (`document.*`). Sem notificação própria — a decisão de etapa usa `APPROVAL_DECIDED`.
    DocumentCreated: ['document.created.despacho'],
    DocumentVersionCreated: ['document.version_created.despacho'],
    DocumentSubmitted: ['document.submitted.despacho'],
    DocumentFinalized: ['document.finalized.etp'],
    DocumentApproved: ['document.approved.etp'],
    DocumentReturned: ['document.returned.etp'],
    DocumentRejected: ['document.rejected.etp'],
    DocumentReopened: ['document.reopened.etp'],
    DocumentCanceled: ['document.canceled.etp'],
    // US-115: timeline projetada no mesmo `tx` (síncrona); no worker, métricas (`ai.*`) e os avisos
    // ao solicitante (`AI_GENERATION_READY`/`AI_GENERATION_FAILED`). O pedido só conta nas métricas.
    AiGenerationRequested: ['ai.generation_requested'],
    AiGenerationCompleted: ['ai.generation_completed'],
    AiGenerationFailed: ['ai.generation_failed'],
    // US-116: `AI_USAGE_LIMIT_WARNING` a quem tem SETTINGS_MANAGE (máx. 50) e métricas (`ai.*`).
    AiUsageThresholdReached: ['ai.usage_threshold_reached'],
  };
