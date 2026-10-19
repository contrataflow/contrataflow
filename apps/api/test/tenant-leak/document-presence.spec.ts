// Indicador de edição concorrente sobre PostgreSQL e Redis reais (US-070 · RN-DOC-91 · Tenant
// incorreto): a API inteira como `cf_app` (RLS) com os seeders reais (o DESPACHO nasce com o modelo
// padrão publicado), o processo pelo PRC-02, o documento pelo DOC-02 e a presença pelo DOC-24/25 no
// Redis do Testcontainers. Prova: o heartbeat de A grava a presença só sob o prefixo do tenant A
// (`cf:{env}:t:{A}:presence:document:{id}`); o heartbeat e a saída de um usuário de B sobre o
// documento de A respondem 404 (RLS → documento invisível) sem criar chave de presença em nenhum
// tenant nem apagar a presença de A. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { GenericContainer } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { RedisClient } from '#modules/platform/infrastructure/redis/redis.client.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { openStageForAnyType } from '../support/document-fixtures.js';
import { PROCESS_PREREQUISITE_SEEDERS, runTenantSeeders } from '../support/process-fixtures.js';

/** Mesma imagem do Compose local (infra/docker-compose.yml). */
const REDIS_IMAGE =
  'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';

const A = '0192c070-0000-7000-8000-00000000010a';
const B = '0192c070-0000-7000-8000-00000000010b';
const ORG_A = '0192c070-0000-7000-8000-0000000010a0';
const ORG_B = '0192c070-0000-7000-8000-0000000010b0';
const OBRAS = '0192c070-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c070-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c070-0000-7000-8000-0000000010b1';
const LUCIA = '0192c070-0000-7000-8000-0000000010c2';
const BETO = '0192c070-0000-7000-8000-0000000010c3';
const NOW = new Date('2026-10-19T13:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us070', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us070', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${LUCIA}', 'sub-lucia-us070', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto-us070', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c070-0000-7000-8000-0000000010d2', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c070-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

describe('Feature: Indicador de edição concorrente sobre PostgreSQL e Redis (US-070)', () => {
  let db: TestDatabase;
  let redis: StartedTestContainer;
  let api: TestApi;
  let openStages: Set<string>;
  let despacho: string;

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);
  const raw = () => api.app.get(RedisClient, { strict: false }).redis;

  const call = (
    method: 'post' | 'put' | 'delete',
    url: string,
    options: { subject?: string; tenant?: string; body?: object } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${url}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia-us070', { amr: MFA }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (method === 'post') pending = pending.set('Idempotency-Key', randomUUID());
    return options.body === undefined ? pending : pending.send(options.body);
  };

  async function newDocument(): Promise<string> {
    const catalog = async (type: string, code: string) => {
      const [row] = await db.admin<{ id: string }>(
        'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
        [A, type, code],
      );
      return row?.id ?? '';
    };
    const process = await call('post', '/processes', {
      body: {
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: await catalog('CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: await catalog('PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      },
    });
    expect(process.status, JSON.stringify(process.body)).toBe(201);
    const processId = (process.body as { data: { id: string } }).data.id;
    openStages.add(processId);
    const document = await call('post', `/processes/${processId}/documents`, {
      body: { documentTypeId: despacho, title: 'ETP 0003/2026 — despacho de apoio' },
    });
    expect(document.status, JSON.stringify(document.body)).toBe(201);
    return (document.body as { data: { id: string } }).data.id;
  }

  const presenceKeys = (pattern: string) => raw().keys(`cf:test:t:${pattern}:presence:*`);

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    [db, redis] = await Promise.all([
      startTestDatabase(),
      new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start(),
    ]);
    await db.admin(FIXTURE_SQL);
    const membership = new RoleInjectingMembershipPort();
    const config = testConfig({
      OIDC_FAKE_SIGNING_KEY: '',
      DATABASE_URL: db.url('cf_app'),
      DATABASE_URL_PLATFORM: db.url('cf_platform'),
      DATABASE_POOL_SIZE: '20',
      REDIS_CACHE_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    });
    api = await createTestApi({
      config,
      stores: 'redis',
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
        { token: CATALOG_CLOCK, value: () => NOW },
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
    await vi.waitFor(
      async () => {
        expect(await raw().ping()).toBe('PONG');
      },
      {
        timeout: 10_000,
        interval: 100,
      },
    );
    await runTenantSeeders(api, A, [...PROCESS_PREREQUISITE_SEEDERS, 'document.templateLibrary']);
    openStages = openStageForAnyType(api);
    const [row] = await db.admin<{ id: string }>(
      "SELECT id FROM document_types WHERE tenant_id = $1 AND code = 'DESPACHO'",
      [A],
    );
    despacho = row?.id ?? '';
    expect(despacho).not.toBe('');
  }, 240_000);

  afterAll(async () => {
    await api.close();
    await Promise.all([db.stop(), redis.stop()]);
    vi.restoreAllMocks();
  });

  it('[Tenant incorreto] heartbeat e saída de B sobre o documento de A → 404, sem chave de presença em B nem perda da presença de A', async () => {
    const documentId = await newDocument();

    const own = await call('put', `/documents/${documentId}/presence`, {
      body: { sectionKey: 'CONTENT' },
    });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const keyA = `cf:test:t:${A}:presence:document:${documentId}`;
    expect(await raw().zrange(keyA, 0, -1)).toEqual([LUCIA]);
    expect(await raw().pttl(keyA)).toBeGreaterThan(55_000);

    const asBeto = { subject: 'sub-beto-us070', tenant: B };
    for (const response of [
      await call('put', `/documents/${documentId}/presence`, {
        ...asBeto,
        body: { sectionKey: 'CONTENT' },
      }),
      await call('delete', `/documents/${documentId}/presence`, asBeto),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemDetailsSchema.parse(response.body).code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain(LUCIA);
    }
    expect(await presenceKeys(B)).toEqual([]);
    expect((await presenceKeys('*')).filter((key) => key.includes(documentId)).sort()).toEqual([
      keyA,
      `${keyA}:sections`,
    ]);
    expect(await raw().zrange(keyA, 0, -1)).toEqual([LUCIA]);

    // Sem evento nem auditoria (RN-DOC-93): nada de presença no outbox nem na trilha.
    const [audit] = await db.admin<{ count: string }>(
      "SELECT count(*) FROM audit_logs WHERE entity_id = $1 AND action LIKE '%presence%'",
      [documentId],
    );
    expect(Number(audit?.count ?? 0)).toBe(0);
  });
});
