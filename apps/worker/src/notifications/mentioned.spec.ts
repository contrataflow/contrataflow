import type { JobMeta } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { MentionNotifiedEffect } from './mention-notified.effect.js';
import { NotificationDispatcher } from './notification-dispatcher.js';
import type { NotificationWrite } from './notification-store.js';
import { notificationContent } from './notification-templates.js';
import type { ProcessVisibility } from './recipient-resolver.js';
import {
  ACTOR,
  FakeDirectory,
  MemoryNotificationStore,
  PROCESS,
  TENANT,
  envelope,
  testId,
} from './testing.js';
import type { JobHandlerContext } from '../queues/run-job.js';

/*
 * US-072 — `MENTIONED` pelo `NotificationDispatcher`: ao usuário mencionado (in-app + e-mail), a
 * cada membro ativo da unidade mencionada que vê o processo, nunca ao autor (RN-CMT-26), uma única
 * vez por evento (reentrega da fila que voltou — Falha de integração) e com `Mention.notifiedAt`
 * marcado na mesma transação. Conteúdo sem valores nem nomes (RN-CMT-28 · POL-09).
 */

const CLAUDIA = testId();
const SEM_ACESSO = testId();
const SETOR = testId();
const MEMBROS = Array.from({ length: 12 }, () => testId());
const T0 = new Date('2026-10-18T12:00:00Z');

function setup(options: { readonly visibility?: ProcessVisibility } = {}) {
  const directory = new FakeDirectory();
  for (const userId of [CLAUDIA, SEM_ACESSO, ACTOR, ...MEMBROS]) directory.active.add(userId);
  // O autor é membro da unidade mencionada (RN-CMT-26: não recebe por essa menção).
  directory.members.set(SETOR, [...MEMBROS, ACTOR]);
  const store = new MemoryNotificationStore();
  const writes: NotificationWrite[] = [];
  const emails: string[] = [];
  const queries: { text: string; values: readonly unknown[] }[] = [];
  const client: SqlClient = {
    query: (text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values });
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  };
  const dispatcher = new NotificationDispatcher({
    directory,
    store: {
      upsertGrouped: (sql, write) => {
        writes.push(write);
        return store.upsertGrouped(sql, write);
      },
    },
    visibility: options.visibility ?? {
      visibleTo: (_client, _processId, userIds) =>
        Promise.resolve(new Set(userIds.filter((userId) => userId !== SEM_ACESSO))),
    },
    email: {
      enqueue: (notificationId) => {
        emails.push(notificationId);
        return Promise.resolve();
      },
    },
    now: () => T0,
    effects: [new MentionNotifiedEffect()],
  });
  const logger = new Logger('test');
  const logs = { log: vi.spyOn(logger, 'log').mockImplementation(() => undefined) };
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const meta: JobMeta = {
    schemaVersion: 1,
    tenantId: TENANT,
    actor: { type: 'USER', userId: ACTOR, membershipId: null },
    correlationId: 'corr-mention-1',
    causationId: null,
    enqueuedAt: T0.toISOString(),
  };
  const context = {
    meta,
    logger,
    tenantTransaction: <T>(work: (sql: SqlClient) => Promise<T>): Promise<T> => work(client),
  } as unknown as JobHandlerContext;
  return { dispatcher, store, writes, emails, queries, context, logs };
}

const mentioned = (target: { userId?: string; departmentId?: string }) =>
  envelope(
    'UserMentioned',
    {
      commentId: testId(),
      mentionId: testId(),
      mentionedUserId: target.userId ?? null,
      mentionedDepartmentId: target.departmentId ?? null,
    },
    { routingKey: 'comment.user_mentioned', aggregateType: 'Comment' },
  );

describe('MENTIONED (US-072)', () => {
  it('[Sucesso] Cláudia recebe in-app e e-mail; link destaca o comentário; notifiedAt marcado', async () => {
    const { dispatcher, store, writes, emails, queries, context, logs } = setup();
    const event = mentioned({ userId: CLAUDIA });
    await expect(dispatcher.handle({ envelope: event }, context)).resolves.toBe('completed');
    expect(store.rows).toEqual([
      expect.objectContaining({
        recipientId: CLAUDIA,
        type: 'MENTIONED',
        title: 'Você foi mencionado',
        emailStatus: 'PENDING',
      }),
    ]);
    expect(writes[0]).toMatchObject({
      entityType: 'Comment',
      entityId: event.payload.commentId,
      link: `/processos/${PROCESS}?aba=comentarios&comentario=${String(event.payload.commentId)}`,
    });
    expect(emails).toEqual([store.rows[0]?.id]);
    expect(queries).toEqual([
      {
        text: 'UPDATE mentions SET notified_at = $2 WHERE id = $1 AND notified_at IS NULL',
        values: [event.payload.mentionId, T0],
      },
    ]);
    expect(logs.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'mention.notification_sent',
        mentionId: event.payload.mentionId,
        notificationType: 'MENTIONED',
        channels: ['IN_APP', 'EMAIL'],
        recipientCount: 1,
      }),
    );
  });

  it('[Sucesso] unidade com 12 membros: cada um recebe; o autor (membro) não', async () => {
    const { dispatcher, store, context } = setup();
    await dispatcher.handle({ envelope: mentioned({ departmentId: SETOR }) }, context);
    expect(store.rows.map((row) => row.recipientId).sort()).toEqual([...MEMBROS].sort());
    expect(store.rows.every((row) => row.title === 'Sua unidade foi mencionada')).toBe(true);
  });

  it('FA-03/RN-CMT-26: menção ao próprio autor não gera notificação nem marca notifiedAt', async () => {
    const { dispatcher, store, queries, context } = setup();
    await expect(
      dispatcher.handle({ envelope: mentioned({ userId: ACTOR }) }, context),
    ).resolves.toBe('skipped');
    expect(store.rows).toEqual([]);
    expect(queries).toEqual([]);
  });

  it('RN-CMT-27: quem perdeu a visibilidade do processo depois do commit não é notificado', async () => {
    const { dispatcher, store, context } = setup();
    await dispatcher.handle({ envelope: mentioned({ userId: SEM_ACESSO }) }, context);
    expect(store.rows).toEqual([]);
  });

  it('[Falha de integração] a fila volta e reentrega o evento: MENTIONED entregue uma única vez', async () => {
    const { dispatcher, store, queries, context } = setup();
    const event = mentioned({ userId: CLAUDIA });
    await dispatcher.handle({ envelope: event }, context);
    await dispatcher.handle({ envelope: event }, context);
    expect(store.rows).toHaveLength(1);
    // A reentrega não repete o efeito (nenhuma notificação nova).
    expect(queries).toHaveLength(1);
  });

  it('RN-CMT-28: o conteúdo nunca traz valores nem nomes', () => {
    for (const variant of ['user', 'department']) {
      const { title, body } = notificationContent('MENTIONED', { groupCount: 1, variant });
      expect(`${title} ${body}`).not.toMatch(/R\$|\d/);
    }
  });
});
