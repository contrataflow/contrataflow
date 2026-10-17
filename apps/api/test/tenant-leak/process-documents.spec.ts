// Painel de documentos do processo sobre PostgreSQL real (US-062 · DOC-01 · Tenant incorreto,
// Permissão): a API inteira como `cf_app` (RLS) com os seeders reais, o processo criado pelo PRC-02
// e os documentos pela fábrica única (`DocumentFacade.createIn`). Prova: a consulta única de
// `listByProcess` traz os documentos do processo (inclusive cancelados) com o número da versão; o
// processo de outro tenant responde 404 `PROCESS_NOT_FOUND` igual ao inexistente, sem revelar nada
// de B; a RLS esconde as linhas de A para a transação de B; quem não vê o processo (DEC-024)
// recebe 404 e a negação fica auditada.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import {
  problemDetailsSchema,
  processDocumentSchema,
  processDocumentsMetaSchema,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DOCUMENT_REPOSITORY } from '#modules/document/application/document.ports.js';
import type { DocumentRepository } from '#modules/document/application/document.ports.js';
import { DOCUMENT_TRANSACTIONS } from '#modules/document/application/ports.js';
import type { DocumentTransactions } from '#modules/document/application/ports.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { documentFacadeOf, openStageForAnyType } from '../support/document-fixtures.js';
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c062-0000-7000-8000-00000000010a';
const B = '0192c062-0000-7000-8000-00000000010b';
const ORG_A = '0192c062-0000-7000-8000-0000000010a0';
const ORG_B = '0192c062-0000-7000-8000-0000000010b0';
const OBRAS = '0192c062-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c062-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c062-0000-7000-8000-0000000010b1';
const LUCIA = '0192c062-0000-7000-8000-0000000010c2';
const BETO = '0192c062-0000-7000-8000-0000000010c3';
const BRUNO = '0192c062-0000-7000-8000-0000000010c4';
const LUCIA_M = '0192c062-0000-7000-8000-0000000010d2';
const NOW = new Date('2026-10-17T13:00:00.000Z');
const MFA = ['pwd', 'otp'];

/** Bruno tem vínculo ativo em A, mas nenhum perfil: não vê o processo (DEC-024). */
const ROLES: Readonly<Record<string, readonly string[]>> = {
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us062', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us062', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${LUCIA}', 'sub-lucia-us062', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto-us062', 'beto@b.test', true, 'Beto LEAK-B'),
  ('${BRUNO}', 'sub-bruno-us062', 'bruno@a.test', true, 'Bruno Lima');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${LUCIA_M}', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c062-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE'),
  ('0192c062-0000-7000-8000-0000000010d4', '${A}', '${BRUNO}', 'INTERNAL', 'ACTIVE');
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

describe('Feature: Painel de documentos do processo sobre PostgreSQL (US-062)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let openStages: Set<string>;
  let typeIds: { despacho: string; etp: string };

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  const panel = (processId: string, subject = 'sub-lucia-us062', tenant = A) =>
    request(api.server)
      .get(`/api/v1/processes/${processId}/documents`)
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenant);

  async function newProcess(): Promise<string> {
    const catalog = async (type: string, code: string) => {
      const [row] = await db.admin<{ id: string }>(
        'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
        [A, type, code],
      );
      return row?.id ?? '';
    };
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-lucia-us062', { amr: MFA }))
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: await catalog('CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: await catalog('PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const id = (response.body as { data: { id: string } }).data.id;
    openStages.add(id);
    return id;
  }

  /** Cria o documento na transação real do módulo, no contexto de Lúcia. */
  function createDocument(processId: string, documentTypeId: string, title: string) {
    const transactions = api.app.get<DocumentTransactions>(DOCUMENT_TRANSACTIONS);
    return runWithRequestContext(
      { correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'vitest' },
      () => {
        updateRequestContext({
          tenantId: A,
          actor: { type: 'USER', userId: LUCIA, membershipId: LUCIA_M },
          amr: MFA,
        });
        return transactions.run((tx) =>
          documentFacadeOf(api).createIn(tx, {
            processId,
            documentTypeId,
            title,
            templateVersionId: null,
          }),
        );
      },
    );
  }

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
      DATABASE_POOL_SIZE: '20',
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
    openStages = openStageForAnyType(api);
    const typeId = async (code: string) =>
      (
        await db.admin<{ id: string }>(
          'SELECT id FROM document_types WHERE tenant_id = $1 AND code = $2',
          [A, code],
        )
      )[0]?.id ?? '';
    typeIds = { despacho: await typeId('DESPACHO'), etp: await typeId('ETP') };
  }, 240_000);

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] lista do processo numa consulta: cancelados visíveis, ordem por tipo e menu da etapa', async () => {
    const processId = await newProcess();
    const despacho = await createDocument(processId, typeIds.despacho, 'Despacho de abertura');
    const etp = await createDocument(processId, typeIds.etp, 'Estudo Técnico Preliminar');
    await db.admin(
      `UPDATE documents SET status = 'CANCELED', canceled_at = now(), cancellation_reason = $2
        WHERE id = $1`,
      [despacho.id, 'Substituído por outro despacho do setor.'],
    );

    const response = await panel(processId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body as { data: unknown[]; meta: unknown };
    const data = body.data.map((item) => processDocumentSchema.parse(item));
    const meta = processDocumentsMetaSchema.parse(body.meta);
    expect(data.map((item) => [item.id, item.status])).toEqual([
      [etp.id, 'DRAFT'],
      [despacho.id, 'CANCELED'],
    ]);
    // ETP singular já existe: fora do menu; despacho cancelado não ocupa vaga (tipo múltiplo).
    expect(meta.creatableTypeIds).not.toContain(typeIds.etp);
    expect(meta.creatableTypeIds).toContain(typeIds.despacho);
  });

  it('[Tenant incorreto] processo de A pedido por B → 404 PROCESS_NOT_FOUND igual ao inexistente; RLS esconde as linhas', async () => {
    const processId = await newProcess();
    await createDocument(processId, typeIds.despacho, 'Despacho LEAK-A');

    const foreign = await panel(processId, 'sub-beto-us062', B);
    expect(foreign.status).toBe(404);
    const leaked = problemDetailsSchema.parse(foreign.body);
    expect(leaked.code).toBe('PROCESS_NOT_FOUND');
    expect(JSON.stringify(foreign.body)).not.toContain('LEAK-A');
    const missing = problemDetailsSchema.parse(
      (await panel(randomUUID(), 'sub-beto-us062', B)).body,
    );
    expect(missing).toMatchObject({ code: 'PROCESS_NOT_FOUND', detail: leaked.detail });

    // A consulta do painel na transação de B não enxerga os documentos de A (RLS).
    const repository = api.app.get<DocumentRepository>(DOCUMENT_REPOSITORY);
    const client = db.client('cf_app');
    try {
      const [asB, asA] = await Promise.all([
        asTenant(B, () =>
          client.$tenantTransaction((tx) => repository.listByProcess(tx, processId)),
        ),
        asTenant(A, () =>
          client.$tenantTransaction((tx) => repository.listByProcess(tx, processId)),
        ),
      ]);
      expect(asB).toEqual([]);
      expect(asA.map((document) => document.title)).toEqual(['Despacho LEAK-A']);
    } finally {
      await client.$disconnect();
    }
  });

  it('[Permissão] vínculo ativo sem PROCESS_VIEW nem participação → 404 e access.denied gravado', async () => {
    const processId = await newProcess();
    await createDocument(processId, typeIds.despacho, 'Despacho de encaminhamento');
    const response = await panel(processId, 'sub-bruno-us062');
    expect(response.status).toBe(404);
    expect(problemDetailsSchema.parse(response.body).code).toBe('PROCESS_NOT_FOUND');
    const [denied] = await db.admin<{ count: string }>(
      `SELECT count(*) FROM audit_logs
        WHERE tenant_id = $1 AND action = 'access.denied' AND actor_user_id = $2
          AND reason_code = 'PROCESS_VIEW'`,
      [A, BRUNO],
    );
    expect(Number(denied?.count ?? 0)).toBeGreaterThan(0);
  });
});
