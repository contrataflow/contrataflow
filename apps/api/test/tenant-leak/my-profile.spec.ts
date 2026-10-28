// Meu perfil e preferências na API inteira sobre PostgreSQL real (US-098 · Tenant incorreto,
// Duplicidade, Concorrência, Falha de banco): `UPDATE users … WHERE version` com concorrência de
// verdade, auditoria `profile.update` gravada só no tenant do contexto (RLS de `audit_logs`) e o
// `PATCH /me` incapaz de tocar em outro usuário ou em colunas fora de RN-IAM-109.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { problemDetailsSchema } from '@contrataflow/validation';
import type { MyProfileDto } from '@contrataflow/validation';
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

const A = '0192c000-0000-7000-8000-00000000098a';
const B = '0192c000-0000-7000-8000-00000000098b';
const ELISA = '0192c000-0000-7000-8000-0000000098a1';
const OTAVIO = '0192c000-0000-7000-8000-0000000098a2';
const BETO = '0192c000-0000-7000-8000-0000000098b1';
const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-a-perfil', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-perfil', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name, social_name, phone) VALUES
  ('${ELISA}', 'sub-elisa', 'elisa@a.test', true, 'Elisa Prado', NULL, NULL),
  ('${OTAVIO}', 'sub-otavio', 'otavio@a.test', true, 'Otávio Reis', NULL, '11999990000'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B', 'Betão LEAK-B', '21988887777');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status, job_title) VALUES
  ('0192c000-0000-7000-8000-0000000198a1', '${A}', '${ELISA}', 'INTERNAL', 'ACTIVE', 'Analista de Compras'),
  ('0192c000-0000-7000-8000-0000000198a2', '${A}', '${OTAVIO}', 'INTERNAL', 'ACTIVE', NULL),
  ('0192c000-0000-7000-8000-0000000198b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE', NULL);
`;

type Row = Readonly<Record<string, unknown>>;

describe('Feature: Meu perfil sobre PostgreSQL (US-098)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let dbStopped = false;

  const bearer = (subject: string) => api.bearer(subject);
  const get = (subject: string, tenant: string) =>
    request(api.server)
      .get('/api/v1/me')
      .set('Authorization', bearer(subject))
      .set('X-Tenant-Id', tenant);
  const patch = (subject: string, tenant: string, body: Record<string, unknown>, version: number) =>
    request(api.server)
      .patch('/api/v1/me')
      .set('Authorization', bearer(subject))
      .set('X-Tenant-Id', tenant)
      .set('If-Match', `"${String(version)}"`)
      .send(body);
  const profile = (response: request.Response) => (response.body as { data: MyProfileDto }).data;
  const userRow = async (id: string) => {
    const [row] = await db.admin<Row>(
      'SELECT name, social_name, email, phone, status, preferences, version FROM users WHERE id = $1',
      [id],
    );
    return row;
  };
  const audits = (tenantId: string) =>
    db.admin<Row>(
      `SELECT tenant_id, action, category, actor_user_id, entity_type, entity_id, changes
         FROM audit_logs WHERE tenant_id = $1 AND action = 'profile.update' ORDER BY occurred_at`,
      [tenantId],
    );

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

  it('[Sucesso] Elisa lê o cargo do vínculo e grava nome social, telefone e tema: versão 2 e auditoria só em A', async () => {
    const before = await get('sub-elisa', A);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.headers.etag).toBe('"1"');
    expect(profile(before)).toMatchObject({
      name: 'Elisa Prado',
      email: 'elisa@a.test',
      membership: { jobTitle: 'Analista de Compras', departments: [] },
      preferences: { density: 'comfortable', theme: 'light' },
    });

    const response = await patch(
      'sub-elisa',
      A,
      { socialName: 'Eli', phone: '(48) 99999-1234', preferences: { theme: 'dark' } },
      1,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect(profile(response)).toMatchObject({
      socialName: 'Eli',
      phone: '(48) 99999-1234',
      preferences: { density: 'comfortable', theme: 'dark' },
      version: 2,
    });
    expect(await userRow(ELISA)).toMatchObject({
      name: 'Elisa Prado',
      social_name: 'Eli',
      email: 'elisa@a.test',
      status: 'ACTIVE',
      preferences: { theme: 'dark' },
      version: 2,
    });

    const inA = await audits(A);
    expect(inA).toHaveLength(1);
    expect(inA[0]).toMatchObject({
      tenant_id: A,
      category: 'SECURITY',
      actor_user_id: ELISA,
      entity_type: 'User',
      entity_id: ELISA,
    });
    expect(JSON.stringify(inA[0]?.changes)).not.toContain('99999-1234');
    expect(JSON.stringify(inA[0]?.changes)).toContain('***1234');
    expect(await audits(B)).toHaveLength(0);
  });

  it('[Tenant incorreto] X-Tenant-Id de B sem vínculo → 403 MEMBERSHIP_INACTIVE, sem gravar nem auditar', async () => {
    const digest = JSON.stringify(await userRow(ELISA));
    const response = await patch('sub-elisa', B, { name: 'Elisa Invasora' }, 2);
    expect(response.status).toBe(403);
    expect(problemDetailsSchema.parse(response.body).code).toBe('MEMBERSHIP_INACTIVE');
    expect(JSON.stringify(await userRow(ELISA))).toBe(digest);
    expect(await audits(B)).toHaveLength(0);
  });

  it('só o próprio User é alterado: Otávio e Beto (de B) ficam intactos', async () => {
    const otavio = JSON.stringify(await userRow(OTAVIO));
    const beto = JSON.stringify(await userRow(BETO));
    const response = await patch('sub-elisa', A, { name: 'Elisa Prado Lima' }, 2);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(JSON.stringify(await userRow(OTAVIO))).toBe(otavio);
    expect(JSON.stringify(await userRow(BETO))).toBe(beto);
    // Beto lê o próprio perfil em B sem ver nada de A.
    const betoProfile = await get('sub-beto', B);
    expect(profile(betoProfile)).toMatchObject({ name: 'Beto LEAK-B', socialName: 'Betão LEAK-B' });
    expect(JSON.stringify(betoProfile.body)).not.toContain('Elisa');
  });

  it('[Concorrência] duas abas com o mesmo ETag, em paralelo: exatamente uma grava (200) e a outra recebe 412', async () => {
    const current = (await userRow(OTAVIO))?.version as number;
    const [first, second] = await Promise.all([
      patch('sub-otavio', A, { name: 'Otávio Reis (aba 1)' }, current),
      patch('sub-otavio', A, { name: 'Otávio Reis (aba 2)' }, current),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 412]);
    const loser = first.status === 412 ? first : second;
    expect(problemDetailsSchema.parse(loser.body).code).toBe('VERSION_CONFLICT');
    expect(await userRow(OTAVIO)).toMatchObject({ version: current + 1 });
    // Uma única auditoria: a da aba vencedora.
    const audited = await audits(A);
    expect(audited.filter((row) => row.actor_user_id === OTAVIO)).toHaveLength(1);
  });

  it('[Duplicidade] o mesmo If-Match reaproveitado depois do sucesso → 412 VERSION_CONFLICT', async () => {
    const current = (await userRow(OTAVIO))?.version as number;
    expect(
      (await patch('sub-otavio', A, { preferences: { density: 'compact' } }, current)).status,
    ).toBe(200);
    const again = await patch('sub-otavio', A, { preferences: { density: 'compact' } }, current);
    expect(again.status).toBe(412);
    expect(problemDetailsSchema.parse(again.body).code).toBe('VERSION_CONFLICT');
  });

  it('[Validação] chave de preferência desconhecida → 422 SETTING_KEY_UNKNOWN e a versão não muda', async () => {
    const current = (await userRow(OTAVIO))?.version as number;
    const response = await patch('sub-otavio', A, { preferences: { cor: 'azul' } }, current);
    expect(response.status).toBe(422);
    expect(problemDetailsSchema.parse(response.body).code).toBe('SETTING_KEY_UNKNOWN');
    expect((await userRow(OTAVIO))?.version).toBe(current);
  });

  it('[Falha de banco] banco parado → 503 DEPENDENCY_UNAVAILABLE', async () => {
    await db.stop();
    dbStopped = true;
    const response = await patch('sub-elisa', A, { name: 'Elisa Sem Banco' }, 3);
    expect(response.status).toBe(503);
    expect(problemDetailsSchema.parse(response.body).code).toBe('DEPENDENCY_UNAVAILABLE');
  });
});
