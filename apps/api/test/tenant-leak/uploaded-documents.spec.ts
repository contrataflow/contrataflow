// Documento externo sobre PostgreSQL real (US-064 · Sucesso, Concorrência, Falha de banco, Falha
// de integração, Tenant incorreto): a API inteira como `cf_app` (RLS) com os seeders reais, o
// processo pelo PRC-02 e a casca `UPLOADED` pelo DOC-02. O anexo é gravado pelo
// `PrismaAttachmentRepository` e levado a `AVAILABLE` pelas transições do gatilho
// `attachments_guard` (o `file-scan` real está em `attachments.spec.ts`). Prova: DOC-19 grava a
// versão `UPLOAD` (conteúdo nulo, `attachment_id`, hash do arquivo), aponta o documento, audita e
// deixa o evento `PENDING` num commit; dois envios simultâneos serializam pelo `FOR UPDATE` (um
// vence, o outro recebe 412) sem colisão de número; falha induzida no outbox não deixa versão;
// anexo em varredura nunca vira versão nem tem URL; o anexo de B é invisível em A (RLS → 422) e os
// ids de A chamados de B → 404. `pnpm --filter @contrataflow/api test:tenant-leak`.
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

const A = '0192c064-0000-7000-8000-00000000010a';
const B = '0192c064-0000-7000-8000-00000000010b';
const ORG_A = '0192c064-0000-7000-8000-0000000010a0';
const ORG_B = '0192c064-0000-7000-8000-0000000010b0';
const OBRAS = '0192c064-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c064-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c064-0000-7000-8000-0000000010b1';
const LUCIA = '0192c064-0000-7000-8000-0000000010c2';
const BETO = '0192c064-0000-7000-8000-0000000010c3';
const LUCIA_M = '0192c064-0000-7000-8000-0000000010d2';
const NOW = new Date('2026-10-17T13:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us064', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us064', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${LUCIA}', 'sub-lucia-us064', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto-us064', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${LUCIA_M}', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c064-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

describe('Feature: Documento externo (upload) sobre PostgreSQL (US-064)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let client: TenantPrismaClient;
  let openStages: Set<string>;
  let externo: string;
  const attachments = new PrismaAttachmentRepository();

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  const call = (
    method: 'get' | 'post',
    url: string,
    options: { subject?: string; tenant?: string; body?: object; ifMatch?: string } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${url}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia-us064', { amr: MFA }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (method === 'post') pending = pending.set('Idempotency-Key', randomUUID());
    if (options.ifMatch !== undefined) pending = pending.set('If-Match', options.ifMatch);
    return options.body === undefined ? pending : pending.send(options.body);
  };

  async function newProcess(): Promise<string> {
    const catalog = async (type: string, code: string) => {
      const [row] = await db.admin<{ id: string }>(
        'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
        [A, type, code],
      );
      return row?.id ?? '';
    };
    const response = await call('post', '/processes', {
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

  /** DOC-02: a casca `UPLOADED` em `DRAFT`, sem versão. */
  async function newDocument(): Promise<{ id: string; processId: string }> {
    const processId = await newProcess();
    const response = await call('post', `/processes/${processId}/documents`, {
      body: { documentTypeId: externo, title: 'Parecer jurídico sobre a minuta' },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return { id: (response.body as { data: { id: string } }).data.id, processId };
  }

  /**
   * Anexo do documento gravado pelo repositório real (`PENDING_UPLOAD`) e levado pelas transições do
   * gatilho até `status` (AVAILABLE com hash, MIME e data da varredura — CHECK do banco).
   */
  async function attachmentOf(
    document: { id: string; processId: string },
    status: 'SCANNING' | 'AVAILABLE',
    sha256 = randomUUID().replaceAll('-', '').repeat(2),
  ): Promise<{ id: string; sha256: string }> {
    const id = randomUUID();
    const row = createAttachment({
      id,
      tenantId: A,
      processId: document.processId,
      targetType: 'DOCUMENT',
      targetId: document.id,
      categoryId: null,
      fileName: 'parecer.pdf',
      extension: 'pdf',
      declaredMimeType: 'application/pdf',
      sizeBytes: 2048,
      storageKey: `tenants/${A}/documents/${id}/parecer.pdf`,
      quarantineKey: `tenants/${A}/uploads/${id}`,
      description: null,
      uploadedById: LUCIA,
      now: NOW,
    });
    await asTenant(A, () => client.$tenantTransaction((tx) => attachments.insert(tx, row)));
    await db.admin(`UPDATE attachments SET status = 'UPLOADED' WHERE id = $1`, [id]);
    await db.admin(`UPDATE attachments SET status = 'SCANNING' WHERE id = $1`, [id]);
    if (status === 'AVAILABLE') {
      await db.admin(
        `UPDATE attachments SET status = 'AVAILABLE', sha256 = $2, scanned_at = now(),
                detected_mime_type = 'application/pdf' WHERE id = $1`,
        [id, sha256],
      );
    }
    return { id, sha256 };
  }

  const uploadVersion = (
    documentId: string,
    attachmentId: string,
    options: { subject?: string; tenant?: string; ifMatch?: string } = {},
  ) =>
    call('post', `/documents/${documentId}/upload-version`, {
      ifMatch: options.ifMatch ?? '"1"',
      body: { attachmentId },
      ...(options.subject === undefined ? {} : { subject: options.subject }),
      ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
    });

  const count = async (sql: string, params: unknown[]) =>
    Number((await db.admin<{ count: string }>(sql, params))[0]?.count ?? 0);

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
      "SELECT id FROM document_types WHERE tenant_id = $1 AND code = 'DOCUMENTO_EXTERNO'",
      [A],
    );
    externo = type?.id ?? '';
    expect(externo).not.toBe('');
  }, 240_000);

  afterAll(async () => {
    await client.$disconnect();
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] DOC-02 cria a casca sem versão; DOC-19 grava a versão UPLOAD com o hash do arquivo, aponta o documento, audita e deixa o evento PENDING', async () => {
    const document = await newDocument();
    const [shell] = await db.admin<{ status: string; current_version_id: string | null }>(
      'SELECT status, current_version_id FROM documents WHERE id = $1',
      [document.id],
    );
    expect(shell).toEqual({ status: 'DRAFT', current_version_id: null });

    const file = await attachmentOf(document, 'AVAILABLE');
    const response = await uploadVersion(document.id, file.id);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = (response.body as { data: { id: string } }).data;

    const [version] = await db.admin<{
      id: string;
      version_number: number;
      reason: string;
      status_at_creation: string;
      content: unknown;
      content_hash: string;
      attachment_id: string;
    }>(
      'SELECT id, version_number, reason, status_at_creation, content, content_hash, attachment_id FROM document_versions WHERE document_id = $1',
      [document.id],
    );
    expect(version).toEqual({
      id: created.id,
      version_number: 1,
      reason: 'UPLOAD',
      status_at_creation: 'DRAFT',
      content: null,
      content_hash: file.sha256,
      attachment_id: file.id,
    });
    const [row] = await db.admin<{ status: string; version: number; current_version_id: string }>(
      'SELECT status, version, current_version_id FROM documents WHERE id = $1',
      [document.id],
    );
    expect(row).toEqual({ status: 'DRAFT', version: 2, current_version_id: created.id });
    const events = await db.admin<{ status: string; routing_key: string }>(
      "SELECT status, routing_key FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'DocumentVersionCreated'",
      [document.id],
    );
    expect(events).toEqual([
      { status: 'PENDING', routing_key: 'document.version_created.documento_externo' },
    ]);
    expect(
      await count(
        "SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 AND action = 'document.version_create'",
        [A, document.id],
      ),
    ).toBe(1);
  });

  it('[Concorrência] dois DOC-19 simultâneos na mesma versão: FOR UPDATE serializa, um vence e o outro recebe 412; sem colisão de número', async () => {
    const document = await newDocument();
    const first = await attachmentOf(document, 'AVAILABLE');
    expect((await uploadVersion(document.id, first.id)).status).toBe(201);
    const ana = await attachmentOf(document, 'AVAILABLE');
    const carla = await attachmentOf(document, 'AVAILABLE');
    const responses = await Promise.all([
      uploadVersion(document.id, ana.id, { ifMatch: '"2"' }),
      uploadVersion(document.id, carla.id, { ifMatch: '"2"' }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 412]);
    const loser = responses[0].status === 412 ? ana : carla;
    expect((await uploadVersion(document.id, loser.id, { ifMatch: '"3"' })).status).toBe(201);

    const rows = await db.admin<{ version_number: number }>(
      'SELECT version_number FROM document_versions WHERE document_id = $1 ORDER BY version_number',
      [document.id],
    );
    expect(rows.map((item) => item.version_number)).toEqual([1, 2, 3]);
    const [current] = await db.admin<{ version_number: number; attachment_id: string }>(
      'SELECT v.version_number, v.attachment_id FROM documents d JOIN document_versions v ON v.id = d.current_version_id WHERE d.id = $1',
      [document.id],
    );
    expect(current).toEqual({ version_number: 3, attachment_id: loser.id });
  });

  it('[Falha de banco] falha induzida no outbox não deixa versão, auditoria nem mudança no documento', async () => {
    const document = await newDocument();
    const file = await attachmentOf(document, 'AVAILABLE');
    await db.admin(`
      CREATE FUNCTION test_fail_upload_version() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.event_type = 'DocumentVersionCreated' AND NEW.aggregate_id = '${document.id}' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_upload_version BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_upload_version();
    `);
    try {
      expect((await uploadVersion(document.id, file.id)).status).toBeGreaterThanOrEqual(500);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_upload_version ON outbox_events; DROP FUNCTION test_fail_upload_version();',
      );
    }
    expect(
      await count('SELECT count(*) FROM document_versions WHERE document_id = $1', [document.id]),
    ).toBe(0);
    const [row] = await db.admin<{ version: number; current_version_id: string | null }>(
      'SELECT version, current_version_id FROM documents WHERE id = $1',
      [document.id],
    );
    expect(row).toEqual({ version: 1, current_version_id: null });
    expect(
      await count(
        "SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 AND action = 'document.version_create'",
        [A, document.id],
      ),
    ).toBe(0);
  });

  it('[Falha de integração] anexo ainda em SCANNING: DOC-19 e ATT-05 → 409 ATTACHMENT_NOT_AVAILABLE, sem versão nem trilha de download', async () => {
    const document = await newDocument();
    const file = await attachmentOf(document, 'SCANNING');
    for (const response of [
      await uploadVersion(document.id, file.id),
      await call('get', `/attachments/${file.id}/download`),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(problemDetailsSchema.parse(response.body).code).toBe('ATTACHMENT_NOT_AVAILABLE');
    }
    expect(
      await count('SELECT count(*) FROM document_versions WHERE document_id = $1', [document.id]),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 AND action = 'attachment.download'",
        [A, file.id],
      ),
    ).toBe(0);
  });

  it('[Tenant incorreto] anexo AVAILABLE de B é invisível em A (RLS → 422); ids de A chamados de B → 404', async () => {
    const document = await newDocument();
    const foreignId = randomUUID();
    const foreign = createAttachment({
      id: foreignId,
      tenantId: B,
      processId: null,
      targetType: 'TENANT_ASSET',
      targetId: B,
      categoryId: null,
      fileName: 'parecer.pdf',
      extension: 'pdf',
      declaredMimeType: 'application/pdf',
      sizeBytes: 2048,
      storageKey: `tenants/${B}/assets/${foreignId}/parecer.pdf`,
      quarantineKey: `tenants/${B}/uploads/${foreignId}`,
      description: null,
      uploadedById: BETO,
      now: NOW,
    });
    await asTenant(B, () => client.$tenantTransaction((tx) => attachments.insert(tx, foreign)));
    await db.admin(`UPDATE attachments SET status = 'UPLOADED' WHERE id = $1`, [foreignId]);
    await db.admin(`UPDATE attachments SET status = 'SCANNING' WHERE id = $1`, [foreignId]);
    await db.admin(
      `UPDATE attachments SET status = 'AVAILABLE', sha256 = $2, scanned_at = now(),
              detected_mime_type = 'application/pdf' WHERE id = $1`,
      [foreignId, 'cd'.repeat(32)],
    );

    const crossed = await uploadVersion(document.id, foreignId);
    expect(crossed.status, JSON.stringify(crossed.body)).toBe(422);
    const problem = problemDetailsSchema.parse(crossed.body);
    expect(problem.code).toBe('VALIDATION_ERROR');
    expect(problem.errors[0]).toMatchObject({
      field: 'attachmentId',
      code: 'REFERENCE_NOT_FOUND',
    });

    const own = await attachmentOf(document, 'AVAILABLE');
    const asBeto = { subject: 'sub-beto-us064', tenant: B };
    for (const response of [
      await call('post', `/processes/${document.processId}/documents`, {
        ...asBeto,
        body: { documentTypeId: externo, title: 'Parecer jurídico sobre a minuta' },
      }),
      await uploadVersion(document.id, own.id, asBeto),
      await call('get', `/attachments/${own.id}/download`, asBeto),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('Parecer jurídico');
    }
    expect(
      await count('SELECT count(*) FROM document_versions WHERE document_id = $1', [document.id]),
    ).toBe(0);
  });
});
