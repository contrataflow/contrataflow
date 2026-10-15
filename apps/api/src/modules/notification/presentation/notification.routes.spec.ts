import { notificationSchema, problemDetailsSchema } from '@contrataflow/validation';
import type { NotificationDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  NOTIFICATION_CLOCK,
  NOTIFICATION_TRANSACTIONS,
} from '../application/notification-ports.js';
import type { NotificationTransactions } from '../application/notification-ports.js';
import type { Notification } from '../domain/notification.js';
import { InMemoryNotificationRepository } from '../infrastructure/in-memory-notification.repository.js';

/*
 * US-111 — NTF-01..05 pelo pipeline HTTP completo (autenticação, tenant, vínculo, validação Zod,
 * filtro RFC 9457) com a identidade fake e as notificações em memória (o `seed` faz o papel do
 * `NotificationDispatcher`). Os mesmos casos contra o PostgreSQL (RLS, GRANT por coluna) estão em
 * `test/tenant-leak/notifications.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
/** Carla do Gherkin. */
const CARLA = FAKE_USERS.marta;
/** Bruno do Gherkin: outro usuário do mesmo tenant. */
const BRUNO = FAKE_USERS.otavio;
/** Vínculos ativos em A e em B (tenant incorreto). */
const FABIO = FAKE_USERS.fabio;
/** Vínculo suspenso em A. */
const SUSPENSO = FAKE_USERS.bruno;
const MFA = ['pwd', 'otp'];
const NOW = new Date('2026-10-15T12:00:00.000Z');
const PROCESS = newId();

const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

function notification(overrides: Partial<Notification> & { recipientId: string }): Notification {
  return {
    id: newId(),
    tenantId: A,
    type: 'PROCESS_RETURNED',
    priority: 'NORMAL',
    title: 'Processo devolvido para você',
    body: 'O processo voltou para ajustes.',
    link: `/processos/${PROCESS}`,
    processId: PROCESS,
    entityType: 'Process',
    entityId: PROCESS,
    sourceEventId: newId(),
    groupKey: `PROCESS_RETURNED:${PROCESS}`,
    groupCount: 1,
    groupedEventIds: [],
    emailStatus: 'PENDING',
    emailSentAt: null,
    readAt: null,
    archivedAt: null,
    expiresAt: null,
    createdAt: minutesAgo(10),
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
function dataOf<T = unknown>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

function metaOf(response: request.Response): { nextCursor: string | null; hasMore: boolean } {
  return (response.body as { meta: { nextCursor: string | null; hasMore: boolean } }).meta;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Central de notificações in-app (US-111)', () => {
  let api: TestApi;
  let notifications: InMemoryNotificationRepository;

  // Carla: 3 listadas (uma lida), 1 arquivada, 1 vencida. Bruno e Fábio (em B) têm as suas.
  const recente = notification({ recipientId: CARLA.id, createdAt: minutesAgo(1) });
  const lida = notification({
    recipientId: CARLA.id,
    type: 'COMMENT_REPLY',
    groupKey: `COMMENT_REPLY:${PROCESS}`,
    groupCount: 3,
    groupedEventIds: [newId(), newId()],
    emailStatus: 'NOT_APPLICABLE',
    readAt: minutesAgo(2),
    createdAt: minutesAgo(5),
  });
  const antiga = notification({
    recipientId: CARLA.id,
    type: 'ROLE_CHANGED',
    priority: 'HIGH',
    title: 'Seus perfis de acesso mudaram',
    // Valor sigiloso que escapou da origem: o presenter mascara (RN-NTF-07, defesa em profundidade).
    body: 'Detalhe com R$ 1.234,56 indevido',
    link: 'https://evil.test/roubo',
    processId: null,
    groupKey: null,
    createdAt: minutesAgo(30),
  });
  const arquivada = notification({ recipientId: CARLA.id, archivedAt: minutesAgo(3) });
  const vencida = notification({ recipientId: CARLA.id, expiresAt: minutesAgo(1) });
  const doBruno = notification({ recipientId: BRUNO.id });
  const doFabioEmB = notification({ recipientId: FABIO.id, tenantId: B });
  const doFabioEmA = notification({ recipientId: FABIO.id });

  beforeAll(async () => {
    api = await createTestApi({ providers: [{ token: NOTIFICATION_CLOCK, value: () => NOW }] });
    notifications = api.app.get(InMemoryNotificationRepository, { strict: false });
    notifications.seed(recente, lida, antiga, arquivada, vencida, doBruno, doFabioEmB, doFabioEmA);
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    vi.restoreAllMocks();
  });

  const withAuth = (
    test: request.Test,
    user: { subject: string },
    tenant: string = A,
  ): request.Test =>
    test.set('Authorization', api.bearer(user.subject, { amr: MFA })).set('X-Tenant-Id', tenant);

  const list = (query = '', user: { subject: string } = CARLA, tenant: string = A) =>
    withAuth(request(api.server).get(`/api/v1/notifications?${query}`), user, tenant);
  const unreadCount = (user: { subject: string } = CARLA, tenant: string = A) =>
    withAuth(request(api.server).get('/api/v1/notifications/unread-count'), user, tenant);
  const read = (id: string, user: { subject: string } = CARLA, tenant: string = A) =>
    withAuth(request(api.server).post(`/api/v1/notifications/${id}/read`), user, tenant);
  const readAll = (user: { subject: string } = CARLA, tenant: string = A) =>
    withAuth(request(api.server).post('/api/v1/notifications/read-all'), user, tenant);
  const archive = (id: string, user: { subject: string } = CARLA, tenant: string = A) =>
    withAuth(request(api.server).post(`/api/v1/notifications/${id}/archive`), user, tenant);

  describe('NTF-01 — listar', () => {
    it('[Sucesso] só as próprias, mais recentes primeiro, sem arquivadas nem vencidas (RN-NTF-09)', async () => {
      const response = await list();
      expect(response.status).toBe(200);
      const items = dataOf<NotificationDto[]>(response);
      expect(items.map((item) => item.id)).toEqual([recente.id, lida.id, antiga.id]);
      for (const item of items) expect(notificationSchema.safeParse(item).success).toBe(true);
      expect(metaOf(response)).toEqual({ nextCursor: null, hasMore: false });
      expect(items[1]).toMatchObject({
        type: 'COMMENT_REPLY',
        groupCount: 3,
        groupedEventIds: lida.groupedEventIds,
        readAt: lida.readAt?.toISOString(),
        emailStatus: 'NOT_APPLICABLE',
      });
    });

    it('presenter mascara valor sigiloso e descarta link absoluto (RN-NTF-07/08)', async () => {
      const items = dataOf<NotificationDto[]>(await list());
      const role = items.find((item) => item.id === antiga.id);
      expect(role).toMatchObject({
        body: 'Detalhe com R$ ••• indevido',
        link: null,
        priority: 'HIGH',
      });
    });

    it('pagina por cursor opaco sem repetir nem pular itens', async () => {
      const first = await list('limit=2');
      expect(dataOf<NotificationDto[]>(first).map((item) => item.id)).toEqual([
        recente.id,
        lida.id,
      ]);
      const { nextCursor, hasMore } = metaOf(first);
      expect(hasMore).toBe(true);
      const second = await list(`limit=2&cursor=${nextCursor ?? ''}`);
      expect(dataOf<NotificationDto[]>(second).map((item) => item.id)).toEqual([antiga.id]);
      expect(metaOf(second)).toEqual({ nextCursor: null, hasMore: false });
    });

    it('unreadOnly=true traz só as não lidas', async () => {
      const items = dataOf<NotificationDto[]>(await list('unreadOnly=true'));
      expect(items.map((item) => item.id)).toEqual([recente.id, antiga.id]);
    });

    it('[Validação] limit=abc → 422 VALIDATION_ERROR (V-01)', async () => {
      const body = expectProblem(await list('limit=abc'), 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'limit' })]),
      );
    });

    it.each([['limit=101'], ['cursor=a%20b'], ['cursor=bm9uc2Vuc2U'], ['unreadOnly=sim']])(
      '[Validação] %s → 422 VALIDATION_ERROR',
      async (query) => {
        expectProblem(await list(query), 422, 'VALIDATION_ERROR');
      },
    );

    it('[Tenant incorreto] no tenant A não aparecem as notificações do mesmo usuário em B', async () => {
      const inA = dataOf<NotificationDto[]>(await list('', FABIO, A));
      expect(inA.map((item) => item.id)).toEqual([doFabioEmA.id]);
      const inB = dataOf<NotificationDto[]>(await list('', FABIO, B));
      expect(inB.map((item) => item.id)).toEqual([doFabioEmB.id]);
    });
  });

  describe('NTF-02 — contador', () => {
    it('não arquivadas, não vencidas e não lidas (RN-NTF-10)', async () => {
      const response = await unreadCount(BRUNO);
      expect(response.status).toBe(200);
      expect(dataOf(response)).toEqual({ count: 1 });
    });
  });

  describe('NTF-03 — marcar como lida', () => {
    it('[Sucesso] preenche readAt; repetir é idempotente e não muda o instante (RN-NTF-11)', async () => {
      const own = notification({ recipientId: CARLA.id, createdAt: minutesAgo(40) });
      notifications.seed(own);
      const before = dataOf<{ count: number }>(await unreadCount()).count;

      const first = await read(own.id);
      expect(first.status).toBe(200);
      expect(dataOf<NotificationDto>(first)).toMatchObject({
        id: own.id,
        readAt: NOW.toISOString(),
      });
      expect(dataOf<{ count: number }>(await unreadCount()).count).toBe(before - 1);

      const again = await read(own.id);
      expect(again.status).toBe(200);
      expect(dataOf<NotificationDto>(again).readAt).toBe(NOW.toISOString());
    });

    it('[Permissão] notificação de outro usuário → 404 NOTIFICATION_NOT_FOUND, sem alterá-la', async () => {
      expectProblem(await read(doBruno.id), 404, 'NOTIFICATION_NOT_FOUND');
      expect(dataOf<{ count: number }>(await unreadCount(BRUNO)).count).toBe(1);
    });

    it('[Tenant incorreto] notificação de outro tenant → 404 NOTIFICATION_NOT_FOUND', async () => {
      expectProblem(await read(doFabioEmB.id), 404, 'NOTIFICATION_NOT_FOUND');
      // Nem o próprio destinatário a enxerga pelo tenant errado.
      expectProblem(await read(doFabioEmB.id, FABIO, A), 404, 'NOTIFICATION_NOT_FOUND');
    });

    it('inexistente → 404; id fora do formato → 422', async () => {
      expectProblem(await read(newId()), 404, 'NOTIFICATION_NOT_FOUND');
      expectProblem(await read('N1'), 422, 'VALIDATION_ERROR');
    });
  });

  describe('NTF-04 — marcar todas como lidas', () => {
    it('só as do usuário autenticado no tenant ativo (RN-NTF-12)', async () => {
      const response = await readAll(FABIO, A);
      expect(response.status).toBe(200);
      expect(dataOf(response)).toEqual({ updated: 1 });
      expect(dataOf<{ count: number }>(await unreadCount(FABIO, A)).count).toBe(0);
      expect(dataOf<{ count: number }>(await unreadCount(FABIO, B)).count).toBe(1);
      expect(dataOf<{ count: number }>(await unreadCount(BRUNO)).count).toBe(1);
      // Repetir não é erro: nada mais a marcar.
      expect(dataOf(await readAll(FABIO, A))).toEqual({ updated: 0 });
    });
  });

  describe('NTF-05 — arquivar', () => {
    it('[Sucesso] preenche archivedAt e tira da lista; repetir é idempotente', async () => {
      const own = notification({ recipientId: CARLA.id, createdAt: minutesAgo(50) });
      notifications.seed(own);
      const response = await archive(own.id);
      expect(response.status).toBe(200);
      expect(dataOf<NotificationDto>(response).archivedAt).toBe(NOW.toISOString());
      const items = dataOf<NotificationDto[]>(await list('limit=100'));
      expect(items.map((item) => item.id)).not.toContain(own.id);
      expect((await archive(own.id)).status).toBe(200);
    });

    it('[Permissão] de outro usuário ou de outro tenant → 404 NOTIFICATION_NOT_FOUND', async () => {
      expectProblem(await archive(doBruno.id), 404, 'NOTIFICATION_NOT_FOUND');
      expectProblem(await archive(doFabioEmB.id), 404, 'NOTIFICATION_NOT_FOUND');
    });
  });

  describe('acesso', () => {
    it('sem autenticação → 401 UNAUTHENTICATED', async () => {
      const response = await request(api.server)
        .get('/api/v1/notifications/unread-count')
        .set('X-Tenant-Id', A);
      expectProblem(response, 401, 'UNAUTHENTICATED');
    });

    it('vínculo suspenso → 403 MEMBERSHIP_INACTIVE', async () => {
      expectProblem(await list('', SUSPENSO), 403, 'MEMBERSHIP_INACTIVE');
    });
  });

  describe('[Falha de banco] banco indisponível', () => {
    it('responde 503 DEPENDENCY_UNAVAILABLE (o sininho mantém o último contador)', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const failing: NotificationTransactions = {
        run: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
        read: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
      };
      const down = await createTestApi({
        providers: [{ token: NOTIFICATION_TRANSACTIONS, value: failing }],
      });
      try {
        const response = await request(down.server)
          .get('/api/v1/notifications/unread-count')
          .set('Authorization', down.bearer(CARLA.subject, { amr: MFA }))
          .set('X-Tenant-Id', A);
        expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      } finally {
        await down.close();
      }
    });
  });
});
