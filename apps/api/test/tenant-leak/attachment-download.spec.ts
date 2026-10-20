// Anexos visíveis e baixáveis sobre PostgreSQL real (US-069 · Sucesso, Duplicidade, Tenant
// incorreto): a API inteira como `cf_app` (RLS) com os seeders reais, o processo pelo PRC-02 e o
// documento pelo DOC-02. O anexo é gravado pelo `PrismaAttachmentRepository` e levado a `AVAILABLE`
// pelas transições do gatilho `attachments_guard` (o `file-scan` real está em `attachments.spec.ts`).
// Prova: ATT-01 lista só o que o processo tem (sem chaves de storage nem URL) e pagina na ordem
// `-createdAt`; ATT-05 grava `attachment.download` a cada pedido e só assina `AVAILABLE`; um usuário
// do tenant B recebe 404 em ATT-01/04/05 sobre ids de A, sem trilha de download gravada, e a consulta
// do repositório sob a RLS de B não enxerga o processo de A. A herança de POL-09 (alvo RESTRICTED)
// tem a matriz de perfis em `src/modules/files/presentation/attachment-download.routes.spec.ts`.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAttachment } from '#modules/files/domain/attachment.js';
import { PrismaAttachmentRepository } from '#modules/files/infrastructure/prisma-attachment.repository.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';

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
import { openStageForAnyType } from '../support/document-fixtures.js';
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c069-0000-7000-8000-00000000010a';
const B = '0192c069-0000-7000-8000-00000000010b';
const ORG_A = '0192c069-0000-7000-8000-0000000010a0';
const ORG_B = '0192c069-0000-7000-8000-0000000010b0';
const OBRAS = '0192c069-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c069-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c069-0000-7000-8000-0000000010b1';
const LUCIA = '0192c069-0000-7000-8000-0000000010c2';
const BETO = '0192c069-0000-7000-8000-0000000010c3';
const LUCIA_M = '0192c069-0000-7000-8000-0000000010d2';
const NOW = new Date('2026-10-17T13:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us069', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us069', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${LUCIA}', 'sub-lucia-us069', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto-us069', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${LUCIA_M}', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c069-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

describe('Feature: Visualizar e baixar anexos sobre PostgreSQL (US-069)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let client: TenantPrismaClient;
  let openStages: Set<string>;
  let despacho: string;
  const attachments = new PrismaAttachmentRepository();

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  const call = (url: string, options: { subject?: string; tenant?: string } = {}) =>
    request(api.server)
      .get(`/api/v1${url}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia-us069', { amr: MFA }))
      .set('X-Tenant-Id', options.tenant ?? A);
  const asBeto = { subject: 'sub-beto-us069', tenant: B };

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
      .set('Authorization', api.bearer('sub-lucia-us069', { amr: MFA }))
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

  async function newDocument(processId: string): Promise<string> {
    const response = await request(api.server)
      .post(`/api/v1/processes/${processId}/documents`)
      .set('Authorization', api.bearer('sub-lucia-us069', { amr: MFA }))
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', randomUUID())
      .send({ documentTypeId: despacho, title: 'ETP 0003/2026' });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: { id: string } }).data.id;
  }

  /**
   * Anexo do documento gravado pelo repositório real (`PENDING_UPLOAD`) e levado pelas transições do
   * gatilho até `status` (AVAILABLE com hash, MIME e data da varredura — CHECK do banco).
   */
  async function attachmentOf(
    processId: string,
    documentId: string,
    status: 'SCANNING' | 'AVAILABLE',
    fileName = 'parecer.pdf',
  ): Promise<string> {
    const id = randomUUID();
    const row = createAttachment({
      id,
      tenantId: A,
      processId,
      targetType: 'DOCUMENT',
      targetId: documentId,
      categoryId: null,
      fileName,
      extension: 'pdf',
      declaredMimeType: 'application/pdf',
      sizeBytes: 2048,
      storageKey: `tenants/${A}/documents/${id}/parecer.pdf`,
      quarantineKey: `tenants/${A}/uploads/${id}`,
      description: null,
      uploadedById: LUCIA,
      now: new Date(NOW.getTime() + attachmentSequence++ * 1000),
    });
    await asTenant(A, () => client.$tenantTransaction((tx) => attachments.insert(tx, row)));
    await db.admin(`UPDATE attachments SET status = 'UPLOADED' WHERE id = $1`, [id]);
    await db.admin(`UPDATE attachments SET status = 'SCANNING' WHERE id = $1`, [id]);
    if (status === 'AVAILABLE') {
      await db.admin(
        `UPDATE attachments SET status = 'AVAILABLE', sha256 = $2, scanned_at = now(),
                detected_mime_type = 'application/pdf' WHERE id = $1`,
        [id, randomUUID().replaceAll('-', '').repeat(2)],
      );
    }
    return id;
  }
  let attachmentSequence = 0;

  const downloadAudits = async (id: string) =>
    Number(
      (
        await db.admin<{ count: string }>(
          "SELECT count(*) FROM audit_logs WHERE action = 'attachment.download' AND entity_id = $1",
          [id],
        )
      )[0]?.count ?? 0,
    );

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    client = db.client('cf_app');
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
    const [type] = await db.admin<{ id: string }>(
      "SELECT id FROM document_types WHERE tenant_id = $1 AND code = 'DESPACHO'",
      [A],
    );
    despacho = type?.id ?? '';
    expect(despacho).not.toBe('');
  }, 240_000);

  afterAll(async () => {
    await client.$disconnect();
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] ATT-01 lista por -createdAt e filtra pelo alvo; ATT-05 só assina AVAILABLE e audita a cada pedido', async () => {
    const processId = await newProcess();
    const documentId = await newDocument(processId);
    const first = await attachmentOf(processId, documentId, 'AVAILABLE', 'primeiro.pdf');
    const second = await attachmentOf(processId, documentId, 'AVAILABLE', 'segundo.pdf');
    const scanning = await attachmentOf(processId, documentId, 'SCANNING', 'planilha.pdf');

    const listed = await call(`/processes/${processId}/attachments`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const body = listed.body as {
      data: { id: string; status: string }[];
      meta: { totalItems: number };
    };
    expect(body.data.map((item) => item.id)).toEqual([scanning, second, first]);
    expect(body.meta.totalItems).toBe(3);
    expect(JSON.stringify(listed.body)).not.toMatch(/storageKey|quarantineKey|X-Amz-/);
    const filtered = await call(
      `/processes/${processId}/attachments?targetType=DOCUMENT&targetId=${documentId}&page=2&pageSize=2`,
    );
    expect((filtered.body as { data: unknown[] }).data).toHaveLength(1);

    expect((await call(`/attachments/${first}`)).status).toBe(200);
    expect((await call(`/attachments/${first}/download`)).status).toBe(200);
    expect((await call(`/attachments/${first}/download`)).status).toBe(200);
    expect(await downloadAudits(first)).toBe(2);

    const blocked = await call(`/attachments/${scanning}/download`);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(problemDetailsSchema.parse(blocked.body).code).toBe('ATTACHMENT_NOT_AVAILABLE');
    expect(await downloadAudits(scanning)).toBe(0);
  });

  it('[Tenant incorreto] usuário do tenant B: 404 em ATT-01/04/05 sobre ids de A, sem trilha de download', async () => {
    const processId = await newProcess();
    const documentId = await newDocument(processId);
    const id = await attachmentOf(processId, documentId, 'AVAILABLE', 'orcamento-LEAK-A.pdf');

    for (const url of [
      `/processes/${processId}/attachments`,
      `/attachments/${id}`,
      `/attachments/${id}/download`,
    ]) {
      const response = await call(url, asBeto);
      expect(response.status, `${url} ${JSON.stringify(response.body)}`).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('LEAK-A');
      expect(JSON.stringify(response.body)).not.toContain(id);
    }
    expect(await downloadAudits(id)).toBe(0);

    // Sob a RLS de B o repositório não enxerga o processo nem o anexo de A.
    await expect(
      asTenant(B, () =>
        client.$tenantTransaction((tx) =>
          attachments.listByProcess(tx, { processId }, { skip: 0, take: 20 }),
        ),
      ),
    ).resolves.toEqual({ items: [], total: 0 });
    await expect(
      asTenant(B, () => client.$tenantTransaction((tx) => attachments.findById(tx, id))),
    ).resolves.toBeNull();
  });
});
