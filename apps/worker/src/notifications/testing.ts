import { decideNotificationGrouping } from '@contrataflow/types';
import type { DomainEventEnvelope, EmailDeliveryStatus, PermissionCode } from '@contrataflow/types';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type {
  NotificationStore,
  NotificationWrite,
  NotificationWriteOutcome,
} from './notification-store.js';
import type { NotificationDirectory } from './recipient-resolver.js';

/* Fakes do dispatcher de notificações para testes unitários (sem PostgreSQL). */

export const TENANT = '0192f111-0000-7000-8000-00000000000a';
export const PROCESS = '0192f111-0000-7000-8000-0000000000c1';
export const ACTOR = '0192f111-0000-7000-8000-0000000000a0';

let sequence = 0;

/** UUIDv7 determinístico para os testes. */
export function testId(): string {
  sequence += 1;
  return `0192f111-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

export function envelope(
  eventType: string,
  payload: Record<string, unknown>,
  overrides: Partial<DomainEventEnvelope<Record<string, unknown>>> = {},
): DomainEventEnvelope<Record<string, unknown>> {
  return {
    eventId: testId(),
    eventType,
    routingKey: 'process.stage_changed.return',
    eventVersion: 1,
    occurredAt: '2026-10-15T12:00:00.000Z',
    tenantId: TENANT,
    aggregateType: 'Process',
    aggregateId: PROCESS,
    processId: PROCESS,
    actor: { type: 'USER', userId: ACTOR, membershipId: null },
    correlationId: 'corr-ntf-1',
    causationId: null,
    payload,
    ...overrides,
  };
}

/** `SqlClient` que não deve ser usado (as portas fake não fazem SQL). */
export const NO_SQL: SqlClient = {
  query: () => Promise.reject(new Error('SQL inesperado no teste unitário')),
};

/** Diretório em memória: vínculos ativos, lotações e titulares por unidade. */
export class FakeDirectory implements NotificationDirectory {
  readonly active = new Set<string>();
  readonly members = new Map<string, string[]>();
  readonly heads = new Map<string, { headUserId: string | null; deputyUserId: string | null }>();
  readonly memberships = new Map<string, string>();
  /** Quem tem cada permissão em algum escopo do tenant (ordem de inserção). */
  readonly holders = new Map<PermissionCode, string[]>();
  emailEnabled = true;

  activeMembers(_client: SqlClient, userIds: readonly string[]): Promise<Set<string>> {
    return Promise.resolve(new Set(userIds.filter((userId) => this.active.has(userId))));
  }

  departmentMembers(_client: SqlClient, departmentId: string, limit: number): Promise<string[]> {
    return Promise.resolve((this.members.get(departmentId) ?? []).slice(0, limit));
  }

  departmentHeads(
    _client: SqlClient,
    departmentId: string,
  ): Promise<{ headUserId: string | null; deputyUserId: string | null } | null> {
    return Promise.resolve(this.heads.get(departmentId) ?? null);
  }

  tenantPermissionHolders(
    _client: SqlClient,
    permission: PermissionCode,
    limit: number,
  ): Promise<string[]> {
    return Promise.resolve((this.holders.get(permission) ?? []).slice(0, limit));
  }

  membershipUser(_client: SqlClient, membershipId: string): Promise<string | null> {
    return Promise.resolve(this.memberships.get(membershipId) ?? null);
  }

  tenantEmailEnabled(): Promise<boolean> {
    return Promise.resolve(this.emailEnabled);
  }
}

export interface StoredNotification {
  readonly id: string;
  readonly recipientId: string;
  readonly type: string;
  readonly groupKey: string | null;
  readonly sourceEventId: string;
  readonly groupedEventIds: string[];
  readonly title: string;
  readonly body: string;
  readonly emailStatus: EmailDeliveryStatus;
  /** Preferência in-app desligada: a notificação existe só como portadora do e-mail. */
  readonly archived: boolean;
  readonly createdAt: Date;
}

/** Mesmo contrato do `NotificationStore` (reentrega, agrupamento de 5 min), em memória. */
export class MemoryNotificationStore implements Pick<NotificationStore, 'upsertGrouped'> {
  readonly rows: StoredNotification[] = [];

  upsertGrouped(_client: SqlClient, write: NotificationWrite): Promise<NotificationWriteOutcome> {
    const delivered = this.rows.find(
      (row) =>
        row.recipientId === write.recipientId &&
        row.type === write.type &&
        (row.sourceEventId === write.sourceEventId ||
          row.groupedEventIds.includes(write.sourceEventId)),
    );
    if (delivered) {
      return Promise.resolve({
        notificationId: delivered.id,
        kind: 'duplicate',
        emailStatus: delivered.emailStatus,
      });
    }
    const candidate =
      write.groupKey === null || write.hiddenInApp
        ? undefined
        : this.rows
            .filter(
              (row) => row.recipientId === write.recipientId && row.groupKey === write.groupKey,
            )
            .at(-1);
    const decision = decideNotificationGrouping(
      candidate
        ? {
            id: candidate.id,
            sourceEventId: candidate.sourceEventId,
            groupedEventIds: candidate.groupedEventIds,
            createdAt: candidate.createdAt,
            archivedAt: null,
          }
        : null,
      write.sourceEventId,
      write.now,
    );
    if (decision.kind === 'group' && candidate) {
      candidate.groupedEventIds.push(write.sourceEventId);
      Object.assign(candidate, write.content(candidate.groupedEventIds.length + 1));
      return Promise.resolve({
        notificationId: candidate.id,
        kind: 'grouped',
        emailStatus: candidate.emailStatus,
      });
    }
    const row: StoredNotification = {
      id: testId(),
      recipientId: write.recipientId,
      type: write.type,
      groupKey: write.groupKey,
      sourceEventId: write.sourceEventId,
      groupedEventIds: [],
      ...write.content(1),
      emailStatus: write.emailStatus,
      archived: write.hiddenInApp,
      createdAt: write.now,
    };
    this.rows.push(row);
    return Promise.resolve({
      notificationId: row.id,
      kind: 'inserted',
      emailStatus: row.emailStatus,
    });
  }
}
