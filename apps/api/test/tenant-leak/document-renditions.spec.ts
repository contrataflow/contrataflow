// PDFs dos documentos sobre PostgreSQL real (US-067 · Tenant incorreto, Duplicidade, Concorrência,
// Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais, o processo pelo
// PRC-02 e as versões pelo DOC-16. Prova: DOC-21 grava `document_renditions` `PENDING` + auditoria
// num commit; o `document-render` (processador real, Gotenberg falso, storage em memória) leva a
// `READY` e deixa `DocumentRenditionReady` `PENDING` no outbox; a RLS esconde a rendition de A para
// B (DOC-22/23 → 404); dois DOC-21 simultâneos viram UMA linha (índice único parcial — o perdedor
// reaproveita); a falha não ocupa o lugar ("Tentar novamente"); e o gatilho
// `document_renditions_guard` + CHECKs barram transição inválida, PDF pronto sem hash, chave fora do
// prefixo do tenant e alteração da origem. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DOCUMENT_TRANSACTIONS } from '#modules/document/application/ports.js';
import type { DocumentTransactions } from '#modules/document/application/ports.js';
import { RenderDocumentProcessor } from '#modules/document/application/render-document.processor.js';
import { PDF_RENDERER } from '#modules/document/application/rendition.ports.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { InMemoryObjectStorage } from '#shared/storage/in-memory-object-storage.js';
import { OBJECT_STORAGE } from '#shared/storage/storage.service.js';

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
import { FakePdfRenderer } from '../support/rendition-fixtures.js';

const A = '0192c067-0000-7000-8000-00000000010a';
const B = '0192c067-0000-7000-8000-00000000010b';
const ORG_A = '0192c067-0000-7000-8000-0000000010a0';
const ORG_B = '0192c067-0000-7000-8000-0000000010b0';
const OBRAS = '0192c067-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c067-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c067-0000-7000-8000-0000000010b1';
const LUCIA = '0192c067-0000-7000-8000-0000000010c2';
const BETO = '0192c067-0000-7000-8000-0000000010c3';
const LUCIA_M = '0192c067-0000-7000-8000-0000000010d2';
const NOW = new Date('2026-10-17T13:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us067', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us067', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${LUCIA}', 'sub-lucia-us067', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto-us067', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${LUCIA_M}', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c067-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
`;

class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

describe('Feature: PDFs dos documentos sobre PostgreSQL (US-067)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let openStages: Set<string>;
  let despacho: string;
  const renderer = new FakePdfRenderer();

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  const call = (
    method: 'get' | 'post',
    url: string,
    options: { subject?: string; tenant?: string; body?: object; key?: boolean } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${url}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia-us067', { amr: MFA }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (options.key === true) pending = pending.set('Idempotency-Key', randomUUID());
    return options.body === undefined ? pending : pending.send(options.body);
  };

  /** No contexto de Lúcia (tenant A), como o job restauraria. */
  const asLucia = <T>(work: () => Promise<T>) =>
    runWithRequestContext(
      { correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'vitest' },
      () => {
        updateRequestContext({
          tenantId: A,
          actor: { type: 'USER', userId: LUCIA, membershipId: LUCIA_M },
          amr: MFA,
        });
        return work();
      },
    );

  async function newProcess(): Promise<string> {
    const catalog = async (type: string, code: string) => {
      const [row] = await db.admin<{ id: string }>(
        'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
        [A, type, code],
      );
      return row?.id ?? '';
    };
    const response = await call('post', '/processes', {
      key: true,
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
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const id = (response.body as { data: { id: string } }).data.id;
    openStages.add(id);
    return id;
  }

  /** Documento com a versão 2 (DOC-16 duas vezes). */
  async function versioned(): Promise<{ documentId: string; versionId: string }> {
    const processId = await newProcess();
    const transactions = api.app.get<DocumentTransactions>(DOCUMENT_TRANSACTIONS);
    const document = await asLucia(() =>
      transactions.run((tx) =>
        documentFacadeOf(api).createIn(tx, {
          processId,
          documentTypeId: despacho,
          title: 'ETP 0003/2026',
          templateVersionId: null,
        }),
      ),
    );
    let versionId = '';
    for (let index = 0; index < 2; index += 1) {
      const response = await call('post', `/documents/${document.id}/versions`, {
        key: true,
        body: {},
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      versionId = (response.body as { data: { id: string } }).data.id;
    }
    return { documentId: document.id, versionId };
  }

  const requestContent = (versionId: string, options: { subject?: string; tenant?: string } = {}) =>
    call('post', `/document-versions/${versionId}/renditions`, {
      body: { kind: 'CONTENT' },
      ...options,
    });

  const idOf = (response: request.Response) => (response.body as { data: { id: string } }).data.id;

  const count = async (sql: string, params: unknown[]) =>
    Number((await db.admin<{ count: string }>(sql, params))[0]?.count ?? 0);

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
        { token: OBJECT_STORAGE, value: new InMemoryObjectStorage() },
        { token: PDF_RENDERER, value: renderer },
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
    const [type] = await db.admin<{ id: string }>(
      "SELECT id FROM document_types WHERE tenant_id = $1 AND code = 'DESPACHO'",
      [A],
    );
    despacho = type?.id ?? '';
  }, 240_000);

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] DOC-21 grava PENDING + auditoria; o render leva a READY e deixa o evento PENDING', async () => {
    const { versionId } = await versioned();
    const response = await requestContent(versionId);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const id = idOf(response);
    const [pending] = await db.admin<{ status: string; kind: string; masked: boolean }>(
      'SELECT status, kind, masked FROM document_renditions WHERE id = $1',
      [id],
    );
    expect(pending).toEqual({ status: 'PENDING', kind: 'CONTENT', masked: false });
    expect(
      await count(
        "SELECT count(*) FROM audit_logs WHERE entity_id = $1 AND action = 'document.render_request'",
        [id],
      ),
    ).toBe(1);

    await asLucia(() =>
      api.app.get(RenderDocumentProcessor).process({ renditionId: id, attempt: 1 }),
    );
    const [ready] = await db.admin<{
      status: string;
      sha256: string;
      page_count: number;
      storage_key: string;
    }>('SELECT status, sha256, page_count, storage_key FROM document_renditions WHERE id = $1', [
      id,
    ]);
    expect(ready).toMatchObject({ status: 'READY', page_count: 2 });
    expect(ready?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ready?.storage_key.startsWith(`tenants/${A}/`)).toBe(true);
    const events = await db.admin<{ status: string; routing_key: string }>(
      "SELECT status, routing_key FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'DocumentRenditionReady'",
      [id],
    );
    expect(events).toEqual([{ status: 'PENDING', routing_key: 'document.rendition_ready' }]);
  });

  it('[Tenant incorreto] a rendition de A não existe para B: DOC-21/22/23 → 404 e a RLS esconde a linha', async () => {
    const { versionId } = await versioned();
    const id = idOf(await requestContent(versionId));
    const asBeto = { subject: 'sub-beto-us067', tenant: B };
    for (const response of [
      await call('get', `/document-renditions/${id}`, asBeto),
      await call('get', `/document-renditions/${id}/download`, asBeto),
      await requestContent(versionId, asBeto),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      // `instance` ecoa o caminho pedido (o ID que o próprio B enviou); o resto não traz nada de A.
      const { instance, ...rest } = response.body as { instance?: string };
      expect(instance).toBe(new URL(response.request.url).pathname);
      expect(JSON.stringify(rest)).not.toContain(versionId);
      expect(JSON.stringify(rest)).not.toContain(id);
    }
    const client = db.client('cf_app');
    const visible = await asTenant(B, () =>
      client.$tenantTransaction((tx) => tx.documentRendition.findMany({ where: { id } })),
    );
    expect(visible).toEqual([]);
    expect(await count('SELECT count(*) FROM document_renditions WHERE tenant_id = $1', [B])).toBe(
      0,
    );
  });

  it('[Concorrência] dois DOC-21 simultâneos para a mesma versão: uma linha (200 + 202)', async () => {
    const { versionId } = await versioned();
    const responses = await Promise.all([requestContent(versionId), requestContent(versionId)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
    expect(new Set(responses.map(idOf)).size).toBe(1);
    expect(
      await count(
        "SELECT count(*) FROM document_renditions WHERE document_version_id = $1 AND kind = 'CONTENT'",
        [versionId],
      ),
    ).toBe(1);
  });

  it('[Duplicidade] a falha não ocupa o lugar: depois de FAILED, um novo CONTENT é aceito', async () => {
    const { versionId } = await versioned();
    const first = idOf(await requestContent(versionId));
    renderer.failing = 'rejected';
    await expect(
      asLucia(() =>
        api.app.get(RenderDocumentProcessor).process({ renditionId: first, attempt: 1 }),
      ),
    ).rejects.toThrow(/Renderização falhou/);
    renderer.failing = null;
    const retry = await requestContent(versionId);
    expect(retry.status).toBe(202);
    expect(idOf(retry)).not.toBe(first);
    const rows = await db.admin<{ status: string }>(
      'SELECT status FROM document_renditions WHERE document_version_id = $1 ORDER BY created_at',
      [versionId],
    );
    expect(rows.map((row) => row.status)).toEqual(['FAILED', 'PENDING']);
    // O índice único parcial: duas CONTENT vivas para a mesma versão e forma de POL-09 são recusadas.
    await expect(
      db.admin(
        `INSERT INTO document_renditions (id, tenant_id, process_id, document_id, document_version_id, kind)
         SELECT gen_random_uuid(), tenant_id, process_id, document_id, document_version_id, kind
           FROM document_renditions WHERE id = $1`,
        [idOf(retry)],
      ),
    ).rejects.toThrow(/document_renditions_content_key/);
  });

  it('[Falha de integração] gatilho e CHECKs: transição inválida, PDF sem hash, chave de outro tenant, origem imutável', async () => {
    const { versionId } = await versioned();
    const id = idOf(await requestContent(versionId));
    await expect(
      db.admin(`UPDATE document_renditions SET status = 'READY' WHERE id = $1`, [id]),
    ).rejects.toThrow(/transição de status inválida/);
    await expect(
      db.admin(`UPDATE document_renditions SET status = 'EXPIRED' WHERE id = $1`, [id]),
    ).rejects.toThrow(/só a prévia expira/);
    await db.admin(`UPDATE document_renditions SET status = 'PROCESSING' WHERE id = $1`, [id]);
    await expect(
      db.admin(`UPDATE document_renditions SET status = 'READY', ready_at = now() WHERE id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/document_renditions_ready_complete/);
    await expect(
      db.admin(`UPDATE document_renditions SET storage_key = $2 WHERE id = $1`, [
        id,
        `tenants/${B}/previews/x.pdf`,
      ]),
    ).rejects.toThrow(/document_renditions_storage_key_tenant/);
    await expect(
      db.admin(`UPDATE document_renditions SET masked = true WHERE id = $1`, [id]),
    ).rejects.toThrow(/imutáveis/);
    await expect(
      db.admin(`UPDATE document_renditions SET approval_id = gen_random_uuid() WHERE id = $1`, [
        id,
      ]),
    ).rejects.toThrow();
    // O papel da aplicação não apaga (sem DELETE — prévias vencidas viram EXPIRED).
    const client = db.client('cf_app');
    await expect(
      asTenant(A, () =>
        client.$tenantTransaction((tx) => tx.documentRendition.deleteMany({ where: { id } })),
      ),
    ).rejects.toThrow();
    expect(await count('SELECT count(*) FROM document_renditions WHERE id = $1', [id])).toBe(1);
  });
});
