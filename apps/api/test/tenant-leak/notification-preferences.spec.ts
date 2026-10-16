// Preferências de notificação na API inteira sobre PostgreSQL real (US-113 · Tenant incorreto,
// Duplicidade, Concorrência, Permissão, Falha de banco): Elisa tem vínculo nos tenants A e B, Bruno
// só em A. RLS e GRANTs de `notification_preferences`, UNIQUE `(tenant, usuário, tipo, canal)` sob
// concorrência e ME-05/ME-06 nunca atravessando usuário nem tenant.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { problemDetailsSchema } from '@contrataflow/validation';
import type { NotificationPreferenceDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import pg from 'pg';
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

const A = '0192c000-0000-7000-8000-00000000114a';
const B = '0192c000-0000-7000-8000-00000000114b';
const ELISA = '0192c000-0000-7000-8000-0000000114a1';
const BRUNO = '0192c000-0000-7000-8000-0000000114a2';

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'prefeitura-a-pref', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-pref', 'Prefeitura B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ELISA}', 'sub-elisa-pref', 'elisa@a.test', true, 'Elisa'),
  ('${BRUNO}', 'sub-bruno-pref', 'bruno@a.test', true, 'Bruno');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c000-0000-7000-8000-0000000115a1', '${A}', '${ELISA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000115b1', '${B}', '${ELISA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000115a2', '${A}', '${BRUNO}', 'INTERNAL', 'ACTIVE');
`;

type Row = Readonly<Record<string, unknown>>;

describe('Feature: preferências de notificação isoladas por usuário e tenant sobre PostgreSQL (US-113)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let dbStopped = false;

  const call = (test: request.Test, subject: string, tenant: string) =>
    test.set('Authorization', api.bearer(subject, { amr: ['pwd'] })).set('X-Tenant-Id', tenant);
  const get = (subject: string, tenant: string) =>
    call(request(api.server).get('/api/v1/me/notification-preferences'), subject, tenant);
  const put = (subject: string, tenant: string, body: unknown) =>
    call(request(api.server).put('/api/v1/me/notification-preferences'), subject, tenant).send(
      body as object,
    );
  const change = (notificationType: string, channel: string, enabled: boolean | null) => ({
    preferences: [{ notificationType, channel, enabled }],
  });
  const rows = (userId: string) =>
    db.admin<Row>(
      `SELECT tenant_id, notification_type, channel, enabled FROM notification_preferences
        WHERE user_id = $1 ORDER BY tenant_id, notification_type, channel`,
      [userId],
    );
  const auditRows = () =>
    db.admin<Row>(
      `SELECT tenant_id, actor_user_id, category, changes, metadata FROM audit_logs
        WHERE action = 'notification.preferences_update' ORDER BY occurred_at`,
    );

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
  const data = <T>(response: request.Response): T => (response.body as { data: T }).data;
  const effective = (response: request.Response, type: string, channel: string) =>
    data<NotificationPreferenceDto[]>(response).find(
      (item) => item.notificationType === type && item.channel === channel,
    );
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

  it('[Sucesso] primeira visita: padrão do registro e nenhuma linha em notification_preferences (FA-03)', async () => {
    const response = await get('sub-elisa-pref', A);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(effective(response, 'PROCESS_RECEIVED', 'EMAIL')).toMatchObject({ enabled: true });
    expect(effective(response, 'COMMENT_REPLY', 'EMAIL')).toMatchObject({ enabled: false });
    expect(effective(response, 'APPROVAL_REQUESTED', 'IN_APP')).toMatchObject({
      enabled: true,
      editable: false,
    });
    expect((response.body as { meta: unknown }).meta).toEqual({ emailEnabled: true });
    expect(await rows(ELISA)).toEqual([]);
  });

  it('[Sucesso] desligar o e-mail grava a linha em A e audita só em A (RN-NTF-26)', async () => {
    const response = await put('sub-elisa-pref', A, change('COMMENT_REPLY', 'EMAIL', false));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(effective(response, 'COMMENT_REPLY', 'EMAIL')?.enabled).toBe(false);
    expect(await rows(ELISA)).toEqual([
      { tenant_id: A, notification_type: 'COMMENT_REPLY', channel: 'EMAIL', enabled: false },
    ]);
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenant_id: A,
      actor_user_id: ELISA,
      category: 'SECURITY',
      changes: [{ path: 'preferences.COMMENT_REPLY.EMAIL', old: null, new: false }],
      metadata: expect.objectContaining({ changedCount: 1 }) as unknown,
    });
  });

  it('[Tenant incorreto] a preferência de A não vale em B nem para outro usuário de A', async () => {
    expect(effective(await get('sub-elisa-pref', B), 'COMMENT_REPLY', 'EMAIL')?.enabled).toBe(
      false,
    );
    // COMMENT_REPLY/EMAIL já é falso por padrão: usa um tipo cujo padrão é ligado.
    expect(
      (await put('sub-elisa-pref', A, change('PROCESS_ASSIGNED', 'EMAIL', false))).status,
    ).toBe(200);
    expect(effective(await get('sub-elisa-pref', A), 'PROCESS_ASSIGNED', 'EMAIL')?.enabled).toBe(
      false,
    );
    expect(effective(await get('sub-elisa-pref', B), 'PROCESS_ASSIGNED', 'EMAIL')?.enabled).toBe(
      true,
    );
    expect(effective(await get('sub-bruno-pref', A), 'PROCESS_ASSIGNED', 'EMAIL')?.enabled).toBe(
      true,
    );
    expect((await rows(ELISA)).every((row) => row.tenant_id === A)).toBe(true);
    expect(await rows(BRUNO)).toEqual([]);
  });

  it('[Tenant incorreto] X-Tenant-Id de B para quem só tem vínculo em A → 403, sem gravar', async () => {
    const response = await put('sub-bruno-pref', B, change('PROCESS_ASSIGNED', 'EMAIL', false));
    expect(response.status).toBe(403);
    expect(await rows(BRUNO)).toEqual([]);
  });

  it('[Duplicidade] reenvio do mesmo PUT → 200, uma linha só e nenhuma auditoria nova', async () => {
    const before = (await auditRows()).length;
    const again = await put('sub-elisa-pref', A, change('PROCESS_ASSIGNED', 'EMAIL', false));
    expect(again.status).toBe(200);
    expect(
      (await rows(ELISA)).filter((row) => row.notification_type === 'PROCESS_ASSIGNED'),
    ).toHaveLength(1);
    expect(await auditRows()).toHaveLength(before);
  });

  it('[Concorrência] dois PUT em tipos diferentes não se perdem (RN-NTF-25)', async () => {
    const [one, two] = await Promise.all([
      put('sub-bruno-pref', A, change('MENTIONED', 'EMAIL', false)),
      put('sub-bruno-pref', A, change('STAGE_OVERDUE', 'EMAIL', false)),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect((await rows(BRUNO)).map((row) => row.notification_type)).toEqual([
      'MENTIONED',
      'STAGE_OVERDUE',
    ]);
  });

  it('[Concorrência] dois PUT da mesma combinação com valores opostos: uma linha só (UNIQUE)', async () => {
    const results = await Promise.all([
      put('sub-bruno-pref', A, change('PARTICIPANT_ADDED', 'EMAIL', false)),
      put('sub-bruno-pref', A, change('PARTICIPANT_ADDED', 'EMAIL', true)),
    ]);
    for (const response of results)
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(
      (await rows(BRUNO)).filter((row) => row.notification_type === 'PARTICIPANT_ADDED'),
    ).toHaveLength(1);
  });

  it('[Sucesso] usar padrão (enabled nulo) apaga a linha — o cf_app tem DELETE (FA-01)', async () => {
    const response = await put('sub-bruno-pref', A, change('MENTIONED', 'EMAIL', null));
    expect(response.status).toBe(200);
    expect(effective(response, 'MENTIONED', 'EMAIL')?.enabled).toBe(true);
    expect((await rows(BRUNO)).map((row) => row.notification_type)).not.toContain('MENTIONED');
  });

  it('[Permissão] desligar canal obrigatório → 422 NOT_ALLOWED, sem gravar nem auditar', async () => {
    const before = { rows: (await rows(ELISA)).length, audits: (await auditRows()).length };
    const response = await put('sub-elisa-pref', A, change('APPROVAL_REQUESTED', 'IN_APP', false));
    expect(response.status).toBe(422);
    expect(problem(response).errors[0]).toMatchObject({ code: 'NOT_ALLOWED' });
    expect(await rows(ELISA)).toHaveLength(before.rows);
    expect(await auditRows()).toHaveLength(before.audits);
  });

  it('[Validação] tipo fora do registro → 422 INVALID_ENUM', async () => {
    const response = await put('sub-elisa-pref', A, change('TIPO_INEXISTENTE', 'EMAIL', false));
    expect(response.status).toBe(422);
    expect(problem(response).errors[0]).toMatchObject({ code: 'INVALID_ENUM' });
  });

  it('[Tenant incorreto] a RLS esconde as linhas de A de uma sessão de B, barra INSERT cruzado e a identidade é imutável', async () => {
    const connection = new pg.Client({ connectionString: db.url('cf_app') });
    await connection.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SELECT set_config('app.tenant_id', $1, true)", [B]);
      const visible = await connection.query('SELECT user_id FROM notification_preferences');
      expect(visible.rows).toEqual([]);
      await expect(
        connection.query(
          `INSERT INTO notification_preferences (id, tenant_id, user_id, notification_type, channel, enabled)
           VALUES ('0192c000-0000-7000-8000-0000000116f1', $1, $2, 'MENTIONED', 'EMAIL', false)`,
          [A, ELISA],
        ),
      ).rejects.toThrow();
      await connection.query('ROLLBACK');

      // Só `enabled` muda: tenant, usuário, tipo e canal não têm UPDATE para o cf_app.
      await connection.query('BEGIN');
      await connection.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
      await expect(
        connection.query("UPDATE notification_preferences SET notification_type = 'MENTIONED'"),
      ).rejects.toThrow(/permission denied/i);
      await connection.query('ROLLBACK');
    } finally {
      await connection.end();
    }
  });

  it('[Falha de banco] banco indisponível → 503 DEPENDENCY_UNAVAILABLE', async () => {
    await db.stop();
    dbStopped = true;
    const response = await put('sub-elisa-pref', A, change('PROCESS_RECEIVED', 'EMAIL', false));
    expect(response.status).toBe(503);
    expect(problem(response).code).toBe('DEPENDENCY_UNAVAILABLE');
  });
});
