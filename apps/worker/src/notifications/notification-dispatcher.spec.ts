import type { JobMeta } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import type { Counter } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { NotificationDispatcher } from './notification-dispatcher.js';
import type { NotificationInstruments } from './notification-telemetry.js';
import type { NotificationPreferences, ProcessVisibility } from './recipient-resolver.js';
import {
  ACTOR,
  FakeDirectory,
  MemoryNotificationStore,
  NO_SQL,
  TENANT,
  envelope,
  testId,
} from './testing.js';
import { PermanentJobError } from '../queues/job-errors.js';
import type { JobHandlerContext } from '../queues/run-job.js';

const CARLA = testId();
const BRUNO = testId();
const DEPARTMENT = testId();
const T0 = new Date('2026-10-15T12:00:00Z');

class RecordingCounter {
  readonly calls: { value: number; attributes: unknown }[] = [];

  add(value: number, attributes?: unknown): void {
    this.calls.push({ value, attributes });
  }
}

function setup(
  options: {
    readonly visibility?: ProcessVisibility;
    readonly preferences?: NotificationPreferences;
    readonly emailEnabled?: boolean;
    readonly failTransaction?: Error;
  } = {},
) {
  const directory = new FakeDirectory();
  for (const userId of [CARLA, BRUNO, ACTOR]) directory.active.add(userId);
  directory.members.set(DEPARTMENT, [CARLA, BRUNO]);
  directory.emailEnabled = options.emailEnabled ?? true;
  const store = new MemoryNotificationStore();
  const emails: string[] = [];
  const dispatched = new RecordingCounter();
  const emailSkipped = new RecordingCounter();
  let now = T0;
  const dispatcher = new NotificationDispatcher({
    directory,
    store,
    visibility: options.visibility ?? {
      visibleTo: (_client, _processId, userIds) => Promise.resolve(new Set(userIds)),
    },
    ...(options.preferences ? { preferences: options.preferences } : {}),
    email: {
      enqueue: (notificationId) => {
        emails.push(notificationId);
        return Promise.resolve();
      },
    },
    now: () => now,
    metrics: {
      dispatched: dispatched as unknown as Counter,
      emailSkipped: emailSkipped as unknown as Counter,
    } satisfies NotificationInstruments,
  });
  const logger = new Logger('test');
  const logs = {
    log: vi.spyOn(logger, 'log').mockImplementation(() => undefined),
    warn: vi.spyOn(logger, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(logger, 'error').mockImplementation(() => undefined),
  };
  const meta: JobMeta = {
    schemaVersion: 1,
    tenantId: TENANT,
    actor: { type: 'USER', userId: ACTOR, membershipId: null },
    correlationId: 'corr-ntf-1',
    causationId: null,
    enqueuedAt: T0.toISOString(),
  };
  const context = {
    meta,
    logger,
    tenantTransaction: <T>(work: (client: SqlClient) => Promise<T>): Promise<T> =>
      options.failTransaction ? Promise.reject(options.failTransaction) : work(NO_SQL),
  } as unknown as JobHandlerContext;
  return {
    dispatcher,
    store,
    emails,
    logs,
    context,
    dispatched,
    emailSkipped,
    directory,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

/** "O processo 0012/2026 foi devolvido para Carla" (Background + Sucesso do Gherkin). */
const devolvido = (toUserId: string | null = CARLA) =>
  envelope('ProcessStageChanged', {
    cause: 'RETURN',
    toUserId,
    toDepartmentId: DEPARTMENT,
    toStage: { type: 'TASK' },
  });

describe('NotificationDispatcher (US-111)', () => {
  it('[Sucesso] ProcessStageChanged (RETURN) cria PROCESS_RETURNED para Carla e enfileira o e-mail', async () => {
    const { dispatcher, store, emails, context, logs, dispatched } = setup();
    await expect(dispatcher.handle({ envelope: devolvido() }, context)).resolves.toBe('completed');
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      recipientId: CARLA,
      type: 'PROCESS_RETURNED',
      title: 'Processo devolvido',
      emailStatus: 'PENDING',
    });
    expect(emails).toEqual([store.rows[0]?.id]);
    expect(dispatched.calls).toEqual([
      { value: 1, attributes: { type: 'PROCESS_RETURNED', outcome: 'inserted' } },
    ]);
    expect(logs.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'notification.dispatched',
        eventType: 'ProcessStageChanged',
        notificationType: 'PROCESS_RETURNED',
        recipientCount: 1,
        groupedCount: 0,
        correlationId: 'corr-ntf-1',
      }),
    );
    // Nunca loga título/corpo (DEC-138).
    expect(JSON.stringify(logs.log.mock.calls)).not.toContain('Processo devolvido');
  });

  it('[Duplicidade] reentrega do mesmo evento não cria outra notificação', async () => {
    const { dispatcher, store, emails, context, dispatched } = setup();
    const event = devolvido();
    await dispatcher.handle({ envelope: event }, context);
    await dispatcher.handle({ envelope: event }, context);
    expect(store.rows).toHaveLength(1);
    // O e-mail ainda PENDING é reenfileirado (o `jobId = notificationId` deduplica na fila).
    expect(emails).toEqual([store.rows[0]?.id, store.rows[0]?.id]);
    expect(dispatched.calls).toHaveLength(1);
  });

  it('[Concorrência] COMMENT_REPLY no mesmo processo em 2 min agrega na mesma notificação', async () => {
    const { dispatcher, store, context, advance, dispatched } = setup();
    const reply = () =>
      envelope('CommentCreated', {
        commentId: testId(),
        parentId: testId(),
        parentAuthorId: CARLA,
      });
    const first = reply();
    const second = reply();
    await dispatcher.handle({ envelope: first }, context);
    advance(2 * 60_000);
    await dispatcher.handle({ envelope: second }, context);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      sourceEventId: first.eventId,
      groupedEventIds: [second.eventId],
      body: 'Há 2 novas respostas a comentários seus neste processo.',
      emailStatus: 'NOT_APPLICABLE',
    });
    expect(dispatched.calls.map((call) => call.attributes)).toEqual([
      { type: 'COMMENT_REPLY', outcome: 'inserted' },
      { type: 'COMMENT_REPLY', outcome: 'grouped' },
    ]);
  });

  it('[RN-NTF-05] e-mail desejado com o tenant desligado → SKIPPED, sem fila de e-mail', async () => {
    const { dispatcher, store, emails, context, emailSkipped } = setup({ emailEnabled: false });
    await dispatcher.handle({ envelope: devolvido() }, context);
    expect(store.rows[0]?.emailStatus).toBe('SKIPPED');
    expect(emails).toEqual([]);
    expect(emailSkipped.calls).toEqual([{ value: 1, attributes: { type: 'PROCESS_RETURNED' } }]);
  });

  it('[RN-NTF-05] a preferência do usuário (US-113) prevalece sobre o padrão do registro', async () => {
    const preferences: NotificationPreferences = {
      preferences: () => Promise.resolve(new Map([[CARLA, { email: false }]])),
    };
    const { dispatcher, store, emails, context } = setup({ preferences });
    await dispatcher.handle({ envelope: devolvido() }, context);
    expect(store.rows[0]?.emailStatus).toBe('NOT_APPLICABLE');
    expect(emails).toEqual([]);
  });

  it('[US-113] in-app desligado com e-mail por enviar: grava arquivada só para portar o e-mail', async () => {
    const preferences: NotificationPreferences = {
      preferences: () => Promise.resolve(new Map([[CARLA, { inApp: false }]])),
    };
    const { dispatcher, store, emails, context } = setup({ preferences });
    await dispatcher.handle({ envelope: devolvido() }, context);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ archived: true, emailStatus: 'PENDING' });
    expect(emails).toEqual([store.rows[0]?.id]);
  });

  it('[US-113] in-app e e-mail desligados: nada é gravado nem enfileirado', async () => {
    const preferences: NotificationPreferences = {
      preferences: () => Promise.resolve(new Map([[CARLA, { inApp: false, email: false }]])),
    };
    const { dispatcher, store, emails, context } = setup({ preferences });
    await dispatcher.handle({ envelope: devolvido() }, context);
    expect(store.rows).toEqual([]);
    expect(emails).toEqual([]);
  });

  it('[US-113] in-app desligado com o e-mail do tenant desligado: nada a entregar, nada é gravado', async () => {
    const preferences: NotificationPreferences = {
      preferences: () => Promise.resolve(new Map([[CARLA, { inApp: false }]])),
    };
    const { dispatcher, store, context } = setup({ preferences, emailEnabled: false });
    await dispatcher.handle({ envelope: devolvido() }, context);
    expect(store.rows).toEqual([]);
  });

  it('[US-113 · RN-NTF-23] tipo obrigatório ignora in-app desligado (linha antiga ou chamada direta)', async () => {
    const MEMBERSHIP = testId();
    const preferences: NotificationPreferences = {
      preferences: () => Promise.resolve(new Map([[CARLA, { inApp: false, email: false }]])),
    };
    const { dispatcher, store, directory, context } = setup({ preferences });
    directory.memberships.set(MEMBERSHIP, CARLA);
    await dispatcher.handle(
      {
        envelope: envelope(
          'RoleAssigned',
          { membershipId: MEMBERSHIP, roleAssignmentId: testId() },
          { processId: null },
        ),
      },
      context,
    );
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ type: 'ROLE_CHANGED', archived: false });
  });

  it('[FA-01] sem responsável, avisa os membros da unidade (exceto o ator)', async () => {
    const { dispatcher, store, context } = setup();
    await dispatcher.handle({ envelope: devolvido(null) }, context);
    expect(store.rows.map((row) => row.recipientId).sort()).toEqual([CARLA, BRUNO].sort());
  });

  it('[RN-NTF-01 · V-03] evento sem regra: log warn e job concluído sem efeito', async () => {
    const { dispatcher, store, context, logs } = setup();
    await expect(
      dispatcher.handle({ envelope: envelope('ProcessCreated', {}) }, context),
    ).resolves.toBe('skipped');
    expect(store.rows).toEqual([]);
    expect(logs.warn).toHaveBeenCalledWith({
      event: 'notification.type_unmapped',
      eventType: 'ProcessCreated',
    });
  });

  it('variante que não notifica e tipo da US-114: concluem sem efeito', async () => {
    const { dispatcher, store, context, logs } = setup();
    await expect(
      dispatcher.handle({ envelope: envelope('CommentCreated', { commentId: testId() }) }, context),
    ).resolves.toBe('skipped');
    await expect(
      dispatcher.handle({ envelope: envelope('ProcessStageOverdue', {}) }, context),
    ).resolves.toBe('skipped');
    expect(store.rows).toEqual([]);
    expect(logs.log).toHaveBeenCalledWith(
      expect.objectContaining({ notificationType: 'STAGE_OVERDUE', owner: 'US-114' }),
    );
  });

  it('[FA-03] sem destinatário com visibilidade: warn recipient_unresolved, nada gravado', async () => {
    const { dispatcher, store, context, logs } = setup({
      visibility: { visibleTo: () => Promise.resolve(new Set()) },
    });
    await expect(dispatcher.handle({ envelope: devolvido() }, context)).resolves.toBe('skipped');
    expect(store.rows).toEqual([]);
    expect(logs.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'notification.recipient_unresolved',
        reasons: ['NO_RECIPIENT'],
      }),
    );
  });

  it('[Falha de banco] a transação falha: log error, erro relançado (retry da fila) e nada enfileirado', async () => {
    const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const { dispatcher, store, emails, context, logs } = setup({ failTransaction: down });
    await expect(dispatcher.handle({ envelope: devolvido() }, context)).rejects.toBe(down);
    expect(store.rows).toEqual([]);
    expect(emails).toEqual([]);
    expect(logs.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'notification.dispatch_failed',
        errorCode: 'ECONNREFUSED',
        correlationId: 'corr-ntf-1',
      }),
    );
    // Erro sem código: cai no nome; nada reconhecível: UNKNOWN.
    const plain = setup({ failTransaction: new TypeError('x') });
    await expect(
      plain.dispatcher.handle({ envelope: devolvido() }, plain.context),
    ).rejects.toThrow();
    expect(plain.logs.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'TypeError' }),
    );
  });

  it('tenant do evento diferente do tenant do job → erro permanente', async () => {
    const { dispatcher, context } = setup();
    await expect(
      dispatcher.handle({ envelope: { ...devolvido(), tenantId: testId() } }, context),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it('é o handler de notifications/event, com payload `{ envelope }` validado', () => {
    const { dispatcher } = setup();
    expect([dispatcher.queue, dispatcher.name]).toEqual(['notifications', 'event']);
    expect(dispatcher.payloadSchema.safeParse({ envelope: devolvido() }).success).toBe(true);
    expect(dispatcher.payloadSchema.safeParse({ envelope: {} }).success).toBe(false);
  });
});
