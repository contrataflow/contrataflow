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
  'PermissionCacheInvalidator' | 'BusinessMetricsCollector' | 'SessionTerminationHandler';

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
      ],
      queue: 'notifications',
    },
  ],
  inline: [
    {
      match: ['role.*', 'membership.*', 'department.moved'],
      handler: 'PermissionCacheInvalidator',
    },
    { match: ['process.*', 'document.*', 'approval.*'], handler: 'BusinessMetricsCollector' },
    {
      // RN-IAM-27 — encerra as sessões da instituição do evento. Por routing key (sem
      // `membership.*`): `membership.activated` etc. não encerram nada. Os eventos entram em
      // `DOMAIN_EVENT_NAMES` com a US-092.
      match: ['membership.suspended', 'membership.revoked', 'membership.expired'],
      handler: 'SessionTerminationHandler',
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
 * keys que ele usa (cobertas pelas rotas acima) ou `NO_ASYNC_CONSUMER` (ex.: `UserInvited`, cujo
 * e-mail é enfileirado pelo próprio caso de uso). Preenchido junto com `DOMAIN_EVENT_NAMES` pelas
 * stories donas; um teste reprova evento sem decisão e rota que não casa nenhuma routing key.
 */
export const ROUTING_DECISIONS: Readonly<Record<string, readonly string[] | 'NO_ASYNC_CONSUMER'>> =
  {};
