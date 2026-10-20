import type { z } from 'zod';

import {
  aggregateTypeSchema,
  eventTypeSchema,
  isEventPayloadWithinLimit,
  routingKeySchema,
} from './envelope.js';

/*
 * Definição de um evento de domínio (DEC-160/162 · US-082): o schema Zod do payload (V-02) e a
 * routing key — fixa ou calculada do payload, para que o nome especializado (`DFDCreated` =
 * `DocumentCreated` com `document.created.dfd`) seja só a routing key, nunca outra linha
 * (RN-FND-51). Cada story dona declara o seu evento com `defineDomainEvent` e o registra em
 * `DOMAIN_EVENT_DEFINITIONS`; o caso de uso grava com `outbox.record(tx, Evento.of({...}))`.
 */

/** Payload de evento: objeto JSON com IDs e o mínimo necessário (events.md §1). */
export type EventPayloadSchema = z.ZodType<Record<string, unknown>>;

export interface DomainEventSpec<S extends EventPayloadSchema> {
  readonly eventType: string;
  /** Versão corrente (começa em 1 — events.md §8). */
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly payload: S;
  /** Routing key fixa ou calculada do payload já validado (DEC-162). */
  readonly routingKey: string | ((payload: z.output<S>) => string);
}

export interface DomainEventDraftInput<S extends EventPayloadSchema> {
  readonly aggregateId: string;
  /** Processo ao qual o fato pertence (timeline/notificações); nulo fora de processo. */
  readonly processId?: string | null;
  readonly payload: z.input<S>;
  /** `eventId` que causou este fato (caso de uso disparado por outro evento). */
  readonly causationId?: string | null;
}

/** Fato pronto para o `OutboxWriter` (ainda não validado). */
export interface DomainEventDraft {
  readonly definition: AnyDomainEventDefinition;
  readonly aggregateId: string;
  readonly processId: string | null;
  readonly payload: unknown;
  readonly causationId: string | null;
}

/** Campos do evento resolvidos a partir do rascunho já validado. */
export interface ResolvedDomainEvent {
  readonly eventType: string;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly routingKey: string;
  readonly payload: Record<string, unknown>;
}

export interface DomainEventDefinition<S extends EventPayloadSchema> {
  readonly eventType: string;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly payloadSchema: S;
  /** Monta o fato a gravar no outbox. */
  of(input: DomainEventDraftInput<S>): DomainEventDraft;
  /** Valida o payload (V-02) e calcula a routing key; inválido → `DomainEventContractError`. */
  resolve(payload: unknown): ResolvedDomainEvent;
}

export type AnyDomainEventDefinition = DomainEventDefinition<EventPayloadSchema>;

/**
 * Contrato do evento violado (RN-FND-50): payload fora do schema, acima de 16 KB ou routing key
 * inválida. É erro de programação — o caso de uso falha e a transação é desfeita. A mensagem traz
 * só caminhos e códigos dos problemas, nunca valores do payload.
 */
export class DomainEventContractError extends Error {
  constructor(
    readonly eventType: string,
    readonly issues: readonly string[],
  ) {
    super(`Evento ${eventType} fora do contrato: ${issues.join('; ')}`);
    this.name = 'DomainEventContractError';
  }
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.code}`);
}

export function defineDomainEvent<S extends EventPayloadSchema>(
  spec: DomainEventSpec<S>,
): DomainEventDefinition<S> {
  eventTypeSchema.parse(spec.eventType);
  aggregateTypeSchema.parse(spec.aggregateType);
  if (!Number.isInteger(spec.eventVersion) || spec.eventVersion < 1) {
    throw new DomainEventContractError(spec.eventType, ['eventVersion: too_small']);
  }
  if (typeof spec.routingKey === 'string') routingKeySchema.parse(spec.routingKey);

  const definition: DomainEventDefinition<S> = {
    eventType: spec.eventType,
    eventVersion: spec.eventVersion,
    aggregateType: spec.aggregateType,
    payloadSchema: spec.payload,
    of: (input) => ({
      definition,
      aggregateId: input.aggregateId,
      processId: input.processId ?? null,
      payload: input.payload,
      causationId: input.causationId ?? null,
    }),
    resolve(payload) {
      const parsed = spec.payload.safeParse(payload);
      if (!parsed.success)
        throw new DomainEventContractError(spec.eventType, issuesOf(parsed.error));
      if (!isEventPayloadWithinLimit(parsed.data)) {
        throw new DomainEventContractError(spec.eventType, ['payload: too_big (> 16 KB)']);
      }
      const routingKey =
        typeof spec.routingKey === 'string' ? spec.routingKey : spec.routingKey(parsed.data);
      const key = routingKeySchema.safeParse(routingKey);
      if (!key.success) throw new DomainEventContractError(spec.eventType, ['routingKey: invalid']);
      return {
        eventType: spec.eventType,
        eventVersion: spec.eventVersion,
        aggregateType: spec.aggregateType,
        routingKey: key.data,
        payload: parsed.data,
      };
    },
  };
  return definition;
}
