// Diagrama do workflow sobre PostgreSQL real (US-046 · Tenant incorreto, Concorrência): a versão de
// outro tenant não é lida pelo WF-09 nem listada pelo WF-07 (404 idêntico ao de id inexistente) e,
// com etapas sendo salvas em paralelo, toda leitura do WF-09 devolve um snapshot consistente — as
// etapas e o ETag do mesmo instante, nunca parcial (READ COMMITTED + conferência da versão).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { WorkflowDto, WorkflowVersionDetailDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c046-0000-7000-8000-00000000000a';
const B = '0192c046-0000-7000-8000-00000000000b';
const CARLA = '0192c046-0000-7000-8000-0000000000a1';
const ELISA = '0192c046-0000-7000-8000-0000000000a2';
const BETO = '0192c046-0000-7000-8000-0000000000b1';
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [CARLA]: ['ADMIN_ORGAO'],
  // Só `WORKFLOW_VIEW`: quem abre o diagrama.
  [ELISA]: ['COMPRAS'],
  [BETO]: ['ADMIN_ORGAO'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-wf-diagram', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-wf-diagram', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${CARLA}', 'sub-carla', 'carla@a.test', true, 'Carla Mendes'),
  ('${ELISA}', 'sub-elisa', 'elisa@a.test', true, 'Elisa Rocha'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c046-0000-7000-8000-0000000001a1', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c046-0000-7000-8000-0000000001a2', '${A}', '${ELISA}', 'INTERNAL', 'ACTIVE'),
  ('0192c046-0000-7000-8000-0000000001b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real. */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

describe('Feature: diagrama do workflow isolado por tenant sobre PostgreSQL (US-046)', () => {
  let db: TestDatabase;
  let api: TestApi;

  const tenantOf = (subject: string) => (subject === 'sub-beto' ? B : A);
  const as = (test: request.Test, subject: string) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const get = (subject: string, path: string) =>
    as(request(api.server).get(`/api/v1${path}`), subject);
  const post = (subject: string, path: string, body: object) =>
    as(request(api.server).post(`/api/v1${path}`), subject)
      .set('Idempotency-Key', randomUUID())
      .send(body);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
  const data = <T>(response: request.Response): T => (response.body as { data: T }).data;

  let workflow: WorkflowDto;
  let draftId: string;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    const membership = new RoleInjectingMembershipPort();
    const config = testConfig({
      OIDC_FAKE_SIGNING_KEY: '',
      DATABASE_URL: db.url('cf_app'),
      DATABASE_URL_PLATFORM: db.url('cf_platform'),
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
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
    membership.inner = api.app.get(PrismaIdentityRepository);

    const created = await post('sub-carla', '/workflows', {
      key: 'FASE_PREPARATORIA',
      name: 'Fase preparatória — Lei 14.133/2021',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    workflow = data<WorkflowDto>(created);
    draftId = workflow.draftVersion?.id ?? '';
    const abertura = await post('sub-carla', `/workflow-versions/${draftId}/stages`, {
      key: 'ABERTURA',
      name: 'Abertura',
      type: 'START',
    });
    expect(abertura.status, JSON.stringify(abertura.body)).toBe(201);
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Tenant incorreto] WF-09 e WF-07 de A pedidos por B → 404 igual ao de id inexistente', async () => {
    const own = await get('sub-elisa', `/workflow-versions/${draftId}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);

    const leaked = await get('sub-beto', `/workflow-versions/${draftId}`);
    const unknown = await get(
      'sub-beto',
      '/workflow-versions/0192c046-0000-7000-8000-000000000999',
    );
    expect(leaked.status).toBe(404);
    const leakedBody = problemDetailsSchema.parse(leaked.body);
    const unknownBody = problemDetailsSchema.parse(unknown.body);
    expect(leakedBody.code).toBe('NOT_FOUND');
    expect({ ...leakedBody, instance: '', correlationId: '' }).toEqual({
      ...unknownBody,
      instance: '',
      correlationId: '',
    });
    expect(JSON.stringify(leaked.body)).not.toContain('ABERTURA');

    const history = await get('sub-beto', `/workflows/${workflow.id}/versions`);
    expect(history.status).toBe(404);
    expect(problemDetailsSchema.parse(history.body).code).toBe('NOT_FOUND');
  });

  it('[Concorrência] etapas salvas em paralelo às leituras: cada WF-09 é um snapshot inteiro', async () => {
    const initial = data<WorkflowVersionDetailDto>(
      await get('sub-elisa', `/workflow-versions/${draftId}`),
    );
    // Cada etapa salva sobe a versão em 1 na mesma transação: etapas − versão é constante.
    const offset = initial.stages.length - initial.version;
    const writes = Array.from({ length: 6 }, (_, index) =>
      post('sub-carla', `/workflow-versions/${draftId}/stages`, {
        key: `ETAPA_${String(index)}`,
        name: `Etapa ${String(index)}`,
        type: 'TASK',
      }),
    );
    const reads = Array.from({ length: 12 }, () =>
      get('sub-elisa', `/workflow-versions/${draftId}`),
    );

    const [written, read] = await Promise.all([Promise.all(writes), Promise.all(reads)]);

    expect(written.map((response) => response.status)).toEqual(Array(6).fill(201));
    for (const response of read) {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const version = data<WorkflowVersionDetailDto>(response);
      expect(response.headers.etag).toBe(`"${String(version.version)}"`);
      expect(version.stages.length - version.version).toBe(offset);
    }
    const final = data<WorkflowVersionDetailDto>(
      await get('sub-elisa', `/workflow-versions/${draftId}`),
    );
    expect(final.stages).toHaveLength(initial.stages.length + 6);
  });
});
