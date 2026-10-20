// Painel situacional sobre PostgreSQL real (US-004 · RN-PROC-47/56): PRC-04/07/10 leem o processo
// criado pelo PRC-02 (agregado, passagens, concessões e a definição publicada do workflow padrão
// DEC-015) numa transação `REPEATABLE READ READ ONLY` sob a RLS do tenant. Processo de outro tenant
// responde 404 `PROCESS_NOT_FOUND` com o mesmo corpo do inexistente, sem `access.denied` (a
// existência não é revelada); as consultas não gravam auditoria nem outbox.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import {
  problemDetailsSchema,
  processDetailMetaSchema,
  processSchema,
  processStageEntrySchema,
  processSummarySchema,
} from '@contrataflow/validation';
import type { ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c000-0000-7000-8000-00000000040a';
const B = '0192c000-0000-7000-8000-00000000040b';
const ORG_A = '0192c000-0000-7000-8000-0000000040a0';
const ORG_B = '0192c000-0000-7000-8000-0000000040b0';
const OBRAS = '0192c000-0000-7000-8000-0000000040a1';
const MANUTENCAO = '0192c000-0000-7000-8000-0000000040a2';
const OBRAS_B = '0192c000-0000-7000-8000-0000000040b1';
const SETOR_X = '0192c000-0000-7000-8000-0000000040b2';
const ANA = '0192c000-0000-7000-8000-0000000040c1';
const BETO = '0192c000-0000-7000-8000-0000000040c3';
const ANA_M = '0192c000-0000-7000-8000-0000000040d1';
const BETO_M = '0192c000-0000-7000-8000-0000000040d3';
const MISSING = '0192c000-0000-7000-8000-0000000040ee';
const NOW = new Date('2026-10-16T13:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us004', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us004', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0),
  ('${SETOR_X}', '${B}', '${ORG_B}', '${OBRAS_B}', 'SECTOR', 'Setor X LEAK-B', '${path(OBRAS_B, SETOR_X)}', 1);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us004', 'ana@a.test', true, 'Ana Souza'),
  ('${BETO}', 'sub-beto-us004', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${BETO_M}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c000-0000-7000-8000-0000000040e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c000-0000-7000-8000-0000000040e2', '${B}', '${BETO_M}', '${SETOR_X}', true);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

describe('Feature: Painel situacional do processo sobre PostgreSQL (US-004)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let processA: ProcessDto;
  let processB: ProcessDto;

  const tenantOf = (subject: string) => (subject === 'sub-beto-us004' ? B : A);
  const get = (url: string, subject = 'sub-ana-us004') =>
    request(api.server)
      .get(`/api/v1${url}`)
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const create = async (subject: string, units: { secretariat: string; department: string }) => {
    const tenantId = tenantOf(subject);
    const catalogId = async (type: string, code: string) => {
      const [row] = await db.admin<{ id: string }>(
        'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
        [tenantId, type, code],
      );
      if (!row) throw new Error(`${type}/${code} ausente`);
      return row.id;
    };
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantId)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Aquisição LEAK ${randomUUID().slice(0, 8)}`,
        object: `Objeto ${randomUUID()}`,
        contractingTypeId: await catalogId('CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: units.secretariat,
        requestingDepartmentId: units.department,
        originId: await catalogId('PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: ProcessDto }).data;
  };
  const countRows = async (table: string, where = '') => {
    const [row] = await db.admin<{ count: string }>(`SELECT count(*) FROM ${table} ${where}`);
    return Number(row?.count ?? 0);
  };

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
        { token: PROCESS_CLOCK, value: () => NOW },
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
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B);
    processA = await create('sub-ana-us004', { secretariat: OBRAS, department: MANUTENCAO });
    processB = await create('sub-beto-us004', { secretariat: OBRAS_B, department: SETOR_X });
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] resumo, stepper e detail do próprio tenant num instante único, sem escrita', async () => {
    const audit = await countRows('audit_logs');
    const outbox = await countRows('outbox_events');

    const summary = await get(`/processes/${processA.id}/summary`);
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    const body = processSummarySchema.parse((summary.body as { data: unknown }).data);
    expect(body.where).toMatchObject({
      stage: { key: 'ABERTURA', type: 'START' },
      department: { id: MANUTENCAO, name: 'Setor de Manutenção' },
      status: 'DRAFT',
    });
    expect(body.responsible.user).toMatchObject({ id: ANA, name: 'Ana Souza' });
    expect(body.responsible.since).not.toBeNull();
    expect(body.header).toMatchObject({ code: processA.code, organization: { id: ORG_A } });
    expect(body.version).toBe(processA.version);

    const stages = await get(`/processes/${processA.id}/stages`);
    expect(stages.status, JSON.stringify(stages.body)).toBe(200);
    const entries = z.array(processStageEntrySchema).parse((stages.body as { data: unknown }).data);
    expect(entries).toHaveLength(7);
    expect(entries[0]).toMatchObject({
      key: 'ABERTURA',
      isCurrent: true,
      lastPassStatus: 'ACTIVE',
    });
    expect(entries.slice(1).every((entry) => entry.passes.length === 0)).toBe(true);

    const detail = await get(`/processes/${processA.id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const parsed = z
      .object({ data: processSchema, meta: processDetailMetaSchema })
      .parse(detail.body);
    const actions = await get(`/processes/${processA.id}/available-actions`);
    const enabled = (actions.body as { data: { action: string; enabled: boolean }[] }).data
      .filter((entry) => entry.enabled)
      .map((entry) => entry.action);
    expect(parsed.meta.allowedActions).toEqual([...new Set(enabled)]);

    expect(await countRows('audit_logs')).toBe(audit);
    expect(await countRows('outbox_events')).toBe(outbox);
  });

  it('[Tenant incorreto] processo de B: 404 PROCESS_NOT_FOUND idêntico ao inexistente, sem access.denied', async () => {
    const denied = await countRows('audit_logs', "WHERE action = 'access.denied'");
    const strip = (body: unknown) => {
      const {
        instance: _instance,
        correlationId: _correlation,
        ...rest
      } = problemDetailsSchema.parse(body);
      return rest;
    };
    for (const suffix of ['', '/summary', '/stages']) {
      const other = await get(`/processes/${processB.id}${suffix}`);
      const missing = await get(`/processes/${MISSING}${suffix}`);
      expect(other.status, JSON.stringify(other.body)).toBe(404);
      expect(missing.status).toBe(404);
      expect(strip(other.body)).toEqual(strip(missing.body));
      expect(strip(other.body).code).toBe('PROCESS_NOT_FOUND');
      expect(JSON.stringify(other.body)).not.toContain('LEAK');
    }
    // E o contrário: Beto (B) não vê o processo de A.
    const reverse = await get(`/processes/${processA.id}/summary`, 'sub-beto-us004');
    expect(reverse.status).toBe(404);
    expect(await countRows('audit_logs', "WHERE action = 'access.denied'")).toBe(denied);
  });
});
