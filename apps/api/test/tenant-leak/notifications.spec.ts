// Central de notificações na API inteira sobre PostgreSQL real (US-111 · Tenant incorreto,
// Permissão, Validação, Falha de banco): destinatários nos tenants A e B (Fábio tem vínculo nos
// dois), RLS de `notifications`, GRANT só de `UPDATE (read_at, archived_at)` para o `cf_app` e
// NTF-01..05 nunca atravessando destinatário nem tenant. As linhas são semeadas pelo superusuário
// (no produto, quem grava é o `NotificationDispatcher` do worker).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { problemDetailsSchema } from '@contrataflow/validation';
import type { NotificationDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { TOKEN_VERIFIER } from '#shared/auth/ports.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c000-0000-7000-8000-00000000111a';
const B = '0192c000-0000-7000-8000-00000000111b';
const CARLA = '0192c000-0000-7000-8000-0000000111a1';
const BRUNO = '0192c000-0000-7000-8000-0000000111a2';
const FABIO = '0192c000-0000-7000-8000-0000000111a3';
const PROCESSO = '0192c000-0000-7000-8000-0000000111f1';

const N_CARLA_1 = '0192c000-0000-7000-8000-0000000112a1';
const N_CARLA_2 = '0192c000-0000-7000-8000-0000000112a2';
const N_CARLA_ARQ = '0192c000-0000-7000-8000-0000000112a3';
const N_BRUNO = '0192c000-0000-7000-8000-0000000112a4';
const N_FABIO_A = '0192c000-0000-7000-8000-0000000112a5';
const N_FABIO_B = '0192c000-0000-7000-8000-0000000112b1';

const notificationRow = (
  id: string,
  tenant: string,
  recipient: string,
  minutesAgo: number,
  extra = 'NULL',
) =>
  `('${id}', '${tenant}', '${recipient}', 'PROCESS_RETURNED', 'Processo devolvido',
    'O processo voltou para ajustes.', '/processos/${PROCESSO}', '${PROCESSO}',
    '${id.slice(0, -4)}e${id.slice(-3)}', 'PROCESS_RETURNED:${PROCESSO}', 'PENDING',
    now() - interval '${String(minutesAgo)} minutes', ${extra})`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'prefeitura-a-ntf', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-ntf', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${CARLA}', 'sub-carla-ntf', 'carla@a.test', true, 'Carla'),
  ('${BRUNO}', 'sub-bruno-ntf', 'bruno@a.test', true, 'Bruno'),
  ('${FABIO}', 'sub-fabio-ntf', 'fabio@a.test', true, 'Fábio');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c000-0000-7000-8000-0000000113a1', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000113a2', '${A}', '${BRUNO}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000113a3', '${A}', '${FABIO}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000113b3', '${B}', '${FABIO}', 'INTERNAL', 'ACTIVE');
INSERT INTO notifications (id, tenant_id, recipient_id, type, title, body, link, process_id,
                           source_event_id, group_key, email_status, created_at, archived_at) VALUES
  ${notificationRow(N_CARLA_1, A, CARLA, 1)},
  ${notificationRow(N_CARLA_2, A, CARLA, 3)},
  ${notificationRow(N_CARLA_ARQ, A, CARLA, 5, 'now()')},
  ${notificationRow(N_BRUNO, A, BRUNO, 2)},
  ${notificationRow(N_FABIO_A, A, FABIO, 2)},
  ${notificationRow(N_FABIO_B, B, FABIO, 2)};
`;

type Row = Readonly<Record<string, unknown>>;

describe('Feature: central de notificações isolada por destinatário e tenant sobre PostgreSQL (US-111)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let dbStopped = false;

  const as = (subject: string) => api.bearer(subject, { amr: ['pwd'] });
  const call = (test: request.Test, subject: string, tenant: string) =>
    test.set('Authorization', as(subject)).set('X-Tenant-Id', tenant);
  const list = (subject: string, tenant: string, query = '') =>
    call(request(api.server).get(`/api/v1/notifications?${query}`), subject, tenant);
  const count = async (subject: string, tenant: string) =>
    data<{ count: number }>(
      await call(request(api.server).get('/api/v1/notifications/unread-count'), subject, tenant),
    ).count;
  const read = (subject: string, tenant: string, id: string) =>
    call(request(api.server).post(`/api/v1/notifications/${id}/read`), subject, tenant);
  const readAll = (subject: string, tenant: string) =>
    call(request(api.server).post('/api/v1/notifications/read-all'), subject, tenant);
  const archive = (subject: string, tenant: string, id: string) =>
    call(request(api.server).post(`/api/v1/notifications/${id}/archive`), subject, tenant);
  const rowOf = async (id: string) =>
    (
      await db.admin<Row>(
        'SELECT tenant_id, recipient_id, read_at, archived_at FROM notifications WHERE id = $1',
        [id],
      )
    )[0];

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
  const data = <T>(response: request.Response): T => (response.body as { data: T }).data;
  const problem = (response: request.Response) => problemDetailsSchema.parse(response.body);

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    const config = testConfig({
      OIDC_FAKE_SIGNING_KEY: '',
      DATABASE_URL: db.url('cf_app'),
      DATABASE_URL_PLATFORM: db.url('cf_platform'),
    });
    api = await createTestApi({
      config,
      providers: [
        {
          token: TOKEN_VERIFIER,
          value: new FakeJwksProvider({
            signingKey: TEST_SIGNING_KEY,
            issuer: TEST_ISSUER,
            audiences: config.oidc.audiences,
            clockToleranceSeconds: 30,
          }),
        },
      ],
    });
  });

  afterAll(async () => {
    await api.close();
    if (!dbStopped) await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] NTF-01/02: Carla vê só as próprias do tenant ativo, sem as arquivadas', async () => {
    const response = await list('sub-carla-ntf', A);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(data<NotificationDto[]>(response).map((n) => n.id)).toEqual([N_CARLA_1, N_CARLA_2]);
    expect(await count('sub-carla-ntf', A)).toBe(2);

    const page = await list('sub-carla-ntf', A, 'limit=1');
    const { nextCursor } = (page.body as { meta: { nextCursor: string } }).meta;
    const rest = await list('sub-carla-ntf', A, `limit=1&cursor=${nextCursor}`);
    expect(data<NotificationDto[]>(rest).map((n) => n.id)).toEqual([N_CARLA_2]);
  });

  it('[Validação] limit=abc → 422 VALIDATION_ERROR', async () => {
    const response = await list('sub-carla-ntf', A, 'limit=abc');
    expect(response.status).toBe(422);
    expect(problem(response).code).toBe('VALIDATION_ERROR');
  });

  it('[Permissão] Carla marca como lida a notificação de Bruno → 404, sem alterá-la', async () => {
    const response = await read('sub-carla-ntf', A, N_BRUNO);
    expect(response.status).toBe(404);
    expect(problem(response).code).toBe('NOTIFICATION_NOT_FOUND');
    expect((await rowOf(N_BRUNO))?.read_at).toBeNull();
    expect((await archive('sub-carla-ntf', A, N_BRUNO)).status).toBe(404);
    expect((await rowOf(N_BRUNO))?.archived_at).toBeNull();
  });

  it('[Tenant incorreto] notificação de B pedida no tenant A → 404, mesmo pelo próprio destinatário', async () => {
    for (const subject of ['sub-carla-ntf', 'sub-fabio-ntf']) {
      const response = await read(subject, A, N_FABIO_B);
      expect(response.status).toBe(404);
      expect(problem(response).code).toBe('NOTIFICATION_NOT_FOUND');
    }
    expect((await rowOf(N_FABIO_B))?.read_at).toBeNull();
    const inA = data<NotificationDto[]>(await list('sub-fabio-ntf', A));
    expect(inA.map((n) => n.id)).toEqual([N_FABIO_A]);
  });

  it('[Sucesso] NTF-03 grava readAt; repetir é idempotente', async () => {
    const first = await read('sub-carla-ntf', A, N_CARLA_2);
    expect(first.status).toBe(200);
    const readAt = data<NotificationDto>(first).readAt;
    expect(readAt).not.toBeNull();
    const again = await read('sub-carla-ntf', A, N_CARLA_2);
    expect(data<NotificationDto>(again).readAt).toBe(readAt);
    expect(await count('sub-carla-ntf', A)).toBe(1);
  });

  it('NTF-04 marca só as do usuário no tenant ativo (RN-NTF-12)', async () => {
    const response = await readAll('sub-fabio-ntf', A);
    expect(data(response)).toEqual({ updated: 1 });
    expect((await rowOf(N_FABIO_A))?.read_at).not.toBeNull();
    expect((await rowOf(N_FABIO_B))?.read_at).toBeNull();
    expect((await rowOf(N_BRUNO))?.read_at).toBeNull();
    expect(await count('sub-fabio-ntf', B)).toBe(1);
  });

  it('NTF-05 arquiva a própria e ela sai da lista e do contador', async () => {
    const response = await archive('sub-carla-ntf', A, N_CARLA_1);
    expect(response.status).toBe(200);
    expect(data<NotificationDto>(response).archivedAt).not.toBeNull();
    expect(data<NotificationDto[]>(await list('sub-carla-ntf', A)).map((n) => n.id)).toEqual([
      N_CARLA_2,
    ]);
    expect(await count('sub-carla-ntf', A)).toBe(0);
  });

  it('[Falha de banco] banco indisponível → 503 DEPENDENCY_UNAVAILABLE', async () => {
    await db.stop();
    dbStopped = true;
    const response = await call(
      request(api.server).get('/api/v1/notifications/unread-count'),
      'sub-carla-ntf',
      A,
    );
    expect(response.status).toBe(503);
    expect(problem(response).code).toBe('DEPENDENCY_UNAVAILABLE');
  });
});
