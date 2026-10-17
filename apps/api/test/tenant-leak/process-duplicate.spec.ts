// Duplicar processo sobre PostgreSQL real (US-011 · Sucesso, Concorrência, Falha de banco, Falha
// de integração, Tenant incorreto): a API inteira como `cf_app` (RLS) com os seeders reais do
// provisionamento, a origem criada pelo PRC-02 e os itens pelo PRC-14. Prova o que a DEC-033 copia
// (itens com sequência própria, DFD aprovado como novo rascunho sem versão nem aprovação, anexo por
// cópia lógica — mesmo objeto de armazenamento), a transação única por falha induzida NO ÚLTIMO
// passo (nada persiste: processo, itens, documentos, anexos, número, auditoria e outbox), os eventos
// `PENDING`, duas duplicações simultâneas com números distintos e sem lacunas e o isolamento (origem
// e unidade de outro tenant, RLS). `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

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
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c011-0000-7000-8000-00000000010a';
const B = '0192c011-0000-7000-8000-00000000010b';
const ORG_A = '0192c011-0000-7000-8000-0000000010a0';
const ORG_B = '0192c011-0000-7000-8000-0000000010b0';
const OBRAS = '0192c011-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c011-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c011-0000-7000-8000-0000000010b1';
const MANUTENCAO_B = '0192c011-0000-7000-8000-0000000010b2';
const ANA = '0192c011-0000-7000-8000-0000000010c1';
const CARLA = '0192c011-0000-7000-8000-0000000010c2';
const BETO = '0192c011-0000-7000-8000-0000000010c3';
const ANA_M = '0192c011-0000-7000-8000-0000000010d1';
const CARLA_M = '0192c011-0000-7000-8000-0000000010d2';
const NOW = new Date('2026-10-17T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [CARLA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const SUBJECTS = {
  ana: 'sub-ana-us011',
  carla: 'sub-carla-us011',
  beto: 'sub-beto-us011',
} as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us011', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us011', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0),
  ('${MANUTENCAO_B}', '${B}', '${ORG_B}', '${OBRAS_B}', 'SECTOR', 'Manutenção LEAK-B', '${path(OBRAS_B, MANUTENCAO_B)}', 1);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana@a.test', true, 'Ana Souza'),
  ('${CARLA}', '${SUBJECTS.carla}', 'carla@a.test', true, 'Carla Dias'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${CARLA_M}', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c011-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c011-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c011-0000-7000-8000-0000000010e2', '${A}', '${CARLA_M}', '${MANUTENCAO}', true);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

const words = (count: number) =>
  Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

describe('Feature: Duplicar processo sobre PostgreSQL (US-011)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; un: string; dfd: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.carla) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const create = async (): Promise<ProcessDto> => {
    const response = await call(request(api.server).post('/api/v1/processes'))
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Merenda ${words(2)}`,
        object: `Objeto ${words(3)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
        estimatedValue: '1000.00',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: ProcessDto }).data;
  };
  const addItem = async (processId: string) => {
    const response = await call(request(api.server).post(`/api/v1/processes/${processId}/items`))
      .set('Idempotency-Key', randomUUID())
      .send({ description: `Item ${words(1)}`, kind: 'GOOD', unitOfMeasureId: catalog.un });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  };
  const duplicate = (
    processId: string,
    body: Record<string, unknown> = {},
    subject: string = SUBJECTS.carla,
  ) =>
    call(request(api.server).post(`/api/v1/processes/${processId}/duplicate`), subject)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };
  const lastNumber = async () => {
    const [row] = await db.admin<{ last_value: number }>(
      "SELECT last_value FROM number_sequences WHERE tenant_id = $1 AND sequence_key LIKE 'PROCESS:%:2026'",
      [A],
    );
    return row?.last_value ?? 0;
  };

  /** DFD APROVADO na origem: documento + versão 1 (aprovada) + anexo do documento e do processo. */
  async function seedApprovedDfd(processId: string) {
    const documentId = randomUUID();
    const versionId = randomUUID();
    const processAttachment = randomUUID();
    const documentAttachment = randomUUID();
    const content = JSON.stringify({
      sections: {
        NECESSIDADE: {
          state: 'FILLED',
          content: { type: 'doc', content: [{ type: 'paragraph' }] },
          justification: null,
          revision: 3,
          updatedAt: NOW.toISOString(),
          updatedById: CARLA,
        },
      },
    });
    const attachment = (id: string, targetType: string, targetId: string) => `
      INSERT INTO attachments (id, tenant_id, process_id, target_type, target_id, file_name,
        extension, declared_mime_type, detected_mime_type, size_bytes, sha256, storage_key, status,
        scanned_at, uploaded_by_id, uploaded_at)
      VALUES ('${id}', '${A}', '${processId}', '${targetType}', '${targetId}', 'planilha.pdf',
        'pdf', 'application/pdf', 'application/pdf', 2048, '${'c'.repeat(64)}',
        'tenants/${A}/processes/${processId}/attachments/${id}/planilha.pdf', 'AVAILABLE',
        now(), '${CARLA}', now());`;
    await db.admin(`
      BEGIN;
      INSERT INTO documents (id, tenant_id, process_id, document_type_id, title, status,
        draft_content, singleton_key, current_version_id, approved_version_id, approved_at,
        submitted_at, submitted_by_id, created_by_id)
      VALUES ('${documentId}', '${A}', '${processId}', '${catalog.dfd}', 'DFD da merenda', 'APPROVED',
        '${content}'::jsonb, '${catalog.dfd}', '${versionId}', '${versionId}', now(), now(),
        '${CARLA}', '${CARLA}');
      INSERT INTO document_versions (id, tenant_id, document_id, process_id, version_number,
        reason, status_at_creation, content, content_hash, created_by_id)
      VALUES ('${versionId}', '${A}', '${documentId}', '${processId}', 1, 'SUBMISSION', 'IN_REVIEW',
        '{}'::jsonb, '${'d'.repeat(64)}', '${CARLA}');
      ${attachment(processAttachment, 'PROCESS', processId)}
      ${attachment(documentAttachment, 'DOCUMENT', documentId)}
      COMMIT;`);
    return { documentId, processAttachment, documentAttachment };
  }

  /** Tudo que a duplicação grava a partir da origem (para provar o rollback). */
  const effects = async (sourceId: string) => ({
    processes: await db.admin<Row>(
      'SELECT id FROM processes WHERE duplicated_from_id = $1 ORDER BY number',
      [sourceId],
    ),
    items: await db.admin<Row>(
      'SELECT i.id FROM process_items i JOIN processes p ON p.id = i.process_id WHERE p.duplicated_from_id = $1',
      [sourceId],
    ),
    documents: await db.admin<Row>(
      'SELECT id FROM documents WHERE source_document_id IN (SELECT id FROM documents WHERE process_id = $1)',
      [sourceId],
    ),
    attachments: await db.admin<Row>(
      'SELECT id FROM attachments WHERE source_attachment_id IN (SELECT id FROM attachments WHERE process_id = $1)',
      [sourceId],
    ),
    audit: await db.admin<Row>(
      "SELECT id FROM audit_logs WHERE entity_id = $1 AND action = 'process.duplicate'",
      [sourceId],
    ),
    events: await db.admin<Row>(
      "SELECT id FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'ProcessDuplicated'",
      [sourceId],
    ),
    number: await lastNumber(),
  });

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
      DATABASE_POOL_SIZE: '10',
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
    const [dfd] = await db.admin<{ id: string }>(
      "SELECT id FROM document_types WHERE tenant_id = $1 AND code = 'DFD'",
      [A],
    );
    catalog = {
      contractingType: await catalogId(A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: await catalogId(A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      un: await catalogId(A, 'UNIT_OF_MEASURE', 'UN'),
      dfd: dfd?.id ?? '',
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] copia itens, DFD aprovado como rascunho sem versão nem aprovação e anexos por cópia lógica; eventos PENDING', async () => {
    const source = await create();
    await addItem(source.id);
    await addItem(source.id);
    const seeded = await seedApprovedDfd(source.id);

    const response = await duplicate(source.id, { copyDocuments: true, copyAttachments: true });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = (response.body as { data: ProcessDto }).data;
    expect(created).toMatchObject({ duplicatedFromId: source.id, estimatedValue: null });
    expect(created.number).toBe((source.number ?? 0) + 1);

    const [process] = await db.admin<Row>(
      'SELECT duplicated_from_id, creation_channel::text, estimated_value, internal_code FROM processes WHERE id = $1',
      [created.id],
    );
    expect(process).toEqual({
      duplicated_from_id: source.id,
      creation_channel: 'DUPLICATION',
      estimated_value: null,
      internal_code: null,
    });
    const items = await db.admin<Row>(
      'SELECT sequence, reference_unit_price FROM process_items WHERE process_id = $1 ORDER BY sequence',
      [created.id],
    );
    expect(items).toEqual([
      { sequence: 1, reference_unit_price: null },
      { sequence: 2, reference_unit_price: null },
    ]);

    const documents = await db.admin<Row>(
      `SELECT id, status::text, source_document_id, current_version_id, approved_version_id,
              pending_approval_id, draft_content -> 'sections' -> 'NECESSIDADE' -> 'content' AS content
         FROM documents WHERE process_id = $1`,
      [created.id],
    );
    expect(documents).toEqual([
      {
        id: expect.any(String) as unknown,
        status: 'DRAFT',
        source_document_id: seeded.documentId,
        current_version_id: null,
        approved_version_id: null,
        pending_approval_id: null,
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
      },
    ]);
    const copyId = documents[0]?.id as string;
    expect(
      await db.admin('SELECT id FROM document_versions WHERE document_id = $1', [copyId]),
    ).toEqual([]);
    expect(await db.admin('SELECT id FROM approvals WHERE process_id = $1', [created.id])).toEqual(
      [],
    );

    const attachments = await db.admin<Row>(
      `SELECT target_type::text, target_id, source_attachment_id, storage_key, status::text
         FROM attachments WHERE process_id = $1 ORDER BY target_type`,
      [created.id],
    );
    const storageOf = (id: string) =>
      `tenants/${A}/processes/${source.id}/attachments/${id}/planilha.pdf`;
    expect(attachments).toEqual([
      {
        target_type: 'PROCESS',
        target_id: created.id,
        source_attachment_id: seeded.processAttachment,
        storage_key: storageOf(seeded.processAttachment),
        status: 'AVAILABLE',
      },
      {
        target_type: 'DOCUMENT',
        target_id: copyId,
        source_attachment_id: seeded.documentAttachment,
        storage_key: storageOf(seeded.documentAttachment),
        status: 'AVAILABLE',
      },
    ]);

    // [Falha de integração] relay fora: os eventos ficam PENDING.
    const events = await db.admin<Row>(
      `SELECT event_type, status::text FROM outbox_events
        WHERE aggregate_id IN ($1, $2, $3) AND event_type IN ('ProcessCreated', 'ProcessDuplicated', 'DocumentCreated')
        ORDER BY event_type`,
      [created.id, source.id, copyId],
    );
    expect(events).toEqual([
      { event_type: 'DocumentCreated', status: 'PENDING' },
      { event_type: 'ProcessCreated', status: 'PENDING' },
      { event_type: 'ProcessDuplicated', status: 'PENDING' },
    ]);
    expect(
      await db.admin<Row>(
        "SELECT params ->> 'newProcessId' AS new_process_id FROM process_timeline_entries WHERE process_id = $1 AND type = 'PROCESS_DUPLICATED'",
        [source.id],
      ),
    ).toEqual([{ new_process_id: created.id }]);
    expect(
      await db.admin<Row>(
        "SELECT entity_id FROM audit_logs WHERE action = 'process.duplicate' AND process_id = $1",
        [source.id],
      ),
    ).toEqual([{ entity_id: source.id }]);
  });

  it('[Concorrência] duas duplicações simultâneas da mesma origem: números distintos e sem lacunas', async () => {
    const source = await create();
    const before = await lastNumber();
    const responses = await Promise.all([
      duplicate(source.id),
      duplicate(source.id, {}, SUBJECTS.ana),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const numbers = responses
      .map((response) => (response.body as { data: ProcessDto }).data.number ?? 0)
      .sort((a, b) => a - b);
    expect(numbers).toEqual([before + 1, before + 2]);
    expect((await effects(source.id)).processes).toHaveLength(2);
  });

  it('[Falha de banco] falha induzida no último passo desfaz processo, itens, documento, anexos, número, auditoria e evento', async () => {
    const source = await create();
    await addItem(source.id);
    await seedApprovedDfd(source.id);
    await db.admin(`
      CREATE FUNCTION test_fail_duplicate_timeline() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.type = 'PROCESS_DUPLICATED' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_duplicate_timeline BEFORE INSERT ON process_timeline_entries
        FOR EACH ROW EXECUTE FUNCTION test_fail_duplicate_timeline();`);
    try {
      const before = await effects(source.id);
      const failed = await duplicate(source.id, { copyDocuments: true, copyAttachments: true });
      expect(failed.status).toBe(500);
      expect(await effects(source.id)).toEqual(before);
      expect(before.processes).toEqual([]);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_duplicate_timeline ON process_timeline_entries; DROP FUNCTION test_fail_duplicate_timeline();',
      );
    }
  });

  it('[Tenant incorreto] origem de A pelo tenant B: 404; unidade de B no corpo: 422; RLS esconde a cópia', async () => {
    const source = await create();
    const before = await effects(source.id);
    const foreign = await duplicate(source.id, {}, SUBJECTS.beto);
    expect(foreign.status).toBe(404);
    expect(problemDetailsSchema.parse(foreign.body).code).toBe('PROCESS_NOT_FOUND');
    expect(await effects(source.id)).toEqual(before);
    expect(await db.admin('SELECT id FROM processes WHERE tenant_id = $1', [B])).toEqual([]);

    const foreignUnit = await duplicate(source.id, {
      requestingSecretariatId: OBRAS_B,
      requestingDepartmentId: MANUTENCAO_B,
    });
    expect(foreignUnit.status).toBe(422);
    expect(
      problemDetailsSchema.parse(foreignUnit.body).errors.map((error) => [error.field, error.code]),
    ).toEqual([
      ['requestingSecretariatId', 'REFERENCE_NOT_FOUND'],
      ['requestingDepartmentId', 'REFERENCE_NOT_FOUND'],
    ]);
    expect(JSON.stringify(foreignUnit.body)).not.toContain('LEAK-B');

    const copied = await duplicate(source.id);
    expect(copied.status, JSON.stringify(copied.body)).toBe(201);
    const copyId = (copied.body as { data: ProcessDto }).data.id;
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count FROM processes WHERE id = ${copyId}::uuid`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
    } finally {
      await client.$disconnect();
    }
  });
});
