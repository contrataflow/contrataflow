// Ciclo de vida do documento sobre PostgreSQL real (US-065 · Sucesso, Tenant incorreto, Duplicidade,
// Concorrência, Falha de banco, Falha de integração): a API inteira como `cf_app` (RLS) com os
// seeders reais, o processo criado pelo PRC-02 e o documento pela fábrica única
// (`DocumentFacade.createIn`). Prova: a transição numa transação só (falha induzida no outbox desfaz
// documento, versão e auditoria); duas finalizações simultâneas → uma 200 e outra 412 com uma única
// versão; `singletonKey` sob concorrência (índice único parcial); o `contentHash` reproduzível do
// snapshot gravado; a aprovação avulsa com a versão analisada; o evento `PENDING` sem relay; a RLS,
// as FKs compostas e a imutabilidade de `document_versions`.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DOCUMENT_TRANSACTIONS } from '#modules/document/application/ports.js';
import type { DocumentTransactions } from '#modules/document/application/ports.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

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
import type { FixtureActor } from '../support/document-fixtures.js';
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c065-0000-7000-8000-00000000010a';
const B = '0192c065-0000-7000-8000-00000000010b';
const ORG_A = '0192c065-0000-7000-8000-0000000010a0';
const ORG_B = '0192c065-0000-7000-8000-0000000010b0';
const OBRAS = '0192c065-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c065-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c065-0000-7000-8000-0000000010b1';
const LUCIA = '0192c065-0000-7000-8000-0000000010c2';
const BETO = '0192c065-0000-7000-8000-0000000010c3';
const LUCIA_M = '0192c065-0000-7000-8000-0000000010d2';
const NOW = new Date('2026-10-16T13:00:00.000Z');
const MFA = ['pwd', 'otp'];
const REASON = 'Ajuste pedido pelo controle interno na revisão.';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us065', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us065', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${LUCIA}', 'sub-lucia-us065', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto-us065', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${LUCIA_M}', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c065-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
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

const LUCIA_ACTOR: FixtureActor = { tenantId: A, userId: LUCIA, membershipId: LUCIA_M };

describe('Feature: Ciclo de vida do documento sobre PostgreSQL (US-065)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let openStages: Set<string>;
  let typeIds: { despacho: string; etp: string; sigiloso: string };

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  const call = (
    method: 'get' | 'post',
    url: string,
    options: {
      subject?: string;
      tenant?: string;
      ifMatch?: string;
      body?: object;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${url}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia-us065', { amr: MFA }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (options.ifMatch !== undefined) pending = pending.set('If-Match', options.ifMatch);
    for (const [name, value] of Object.entries(options.headers ?? {}))
      pending = pending.set(name, value);
    return options.body === undefined ? pending : pending.send(options.body);
  };

  const finalize = (id: string, headers: Record<string, string> = {}) =>
    call('post', `/documents/${id}/finalize`, {
      ifMatch: '"1"',
      headers: { 'Idempotency-Key': randomUUID(), ...headers },
    });

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
      .set('Authorization', api.bearer('sub-lucia-us065', { amr: MFA }))
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
  function createDocument(
    processId: string,
    documentTypeId: string,
    title = 'Despacho de encaminhamento',
  ) {
    const transactions = api.app.get<DocumentTransactions>(DOCUMENT_TRANSACTIONS);
    return runWithRequestContext(
      { correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'vitest' },
      () => {
        updateRequestContext({
          tenantId: LUCIA_ACTOR.tenantId,
          actor: {
            type: 'USER',
            userId: LUCIA_ACTOR.userId,
            membershipId: LUCIA_ACTOR.membershipId,
          },
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
    // Tipo do tenant com aprovação avulsa (DEC-018): aprovador designado é Lúcia.
    await db.admin(
      `INSERT INTO document_types (id, tenant_id, code, name, kind, requires_approval, approval_policy, numbering_enabled)
       VALUES ($1, $2, 'DESPACHO_SIGILOSO', 'Despacho sigiloso', 'FREE_TEXT', true, $3, false)`,
      [
        '0192c065-0000-7000-8000-0000000010f1',
        A,
        JSON.stringify({ approverType: 'USER', approverUserId: LUCIA, allowDeputy: false }),
      ],
    );
    typeIds = {
      despacho: await typeId('DESPACHO'),
      etp: await typeId('ETP'),
      sigiloso: '0192c065-0000-7000-8000-0000000010f1',
    };
  }, 240_000);

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] finalizar grava documento, versão com hash reproduzível, auditoria, timeline e evento PENDING num commit', async () => {
    const processId = await newProcess();
    const document = await createDocument(processId, typeIds.despacho);
    expect(document.code).toMatch(/\/2026$/);

    const response = await finalize(document.id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers.etag).toBe('"2"');

    const [row] = await db.admin<{ status: string; version: number; current_version_id: string }>(
      'SELECT status, version, current_version_id FROM documents WHERE id = $1',
      [document.id],
    );
    expect(row).toMatchObject({ status: 'FINALIZED', version: 2 });
    const [version] = await db.admin<{
      id: string;
      version_number: number;
      reason: string;
      content: unknown;
      content_hash: string;
    }>(
      'SELECT id, version_number, reason, content, content_hash FROM document_versions WHERE document_id = $1',
      [document.id],
    );
    expect(version).toMatchObject({
      id: row?.current_version_id,
      version_number: 1,
      reason: 'FINALIZATION',
    });
    // DEC-084: recalcular o hash do snapshot gravado reproduz o valor.
    expect(version?.content_hash).toBe(sha256Hex(canonicalJson(version?.content)));

    const events = await db.admin<{ event_type: string; status: string; routing_key: string }>(
      'SELECT event_type, status, routing_key FROM outbox_events WHERE aggregate_id = $1 ORDER BY occurred_at, id',
      [document.id],
    );
    expect(events.map((event) => `${event.event_type}:${event.status}`)).toEqual([
      'DocumentCreated:PENDING',
      'DocumentVersionCreated:PENDING',
      'DocumentFinalized:PENDING',
    ]);
    expect(
      await count(
        "SELECT count(*) FROM process_timeline_entries WHERE process_id = $1 AND type IN ('DOCUMENT_FINALIZED','DOCUMENT_VERSION_CREATED')",
        [processId],
      ),
    ).toBe(2);
    expect(
      await count(
        "SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 AND action IN ('document.finalize','document.version_create')",
        [A, document.id],
      ),
    ).toBe(2);
  });

  it('[Sucesso] submeter avulso abre a Approval (DOCUMENT) com a versão analisada; pendência única por documento', async () => {
    const document = await createDocument(
      await newProcess(),
      typeIds.sigiloso,
      'Despacho sigiloso nº 7',
    );
    const response = await call('post', `/documents/${document.id}/submit`, {
      ifMatch: '"1"',
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [approval] = await db.admin<{
      id: string;
      subject_type: string;
      status: string;
      approver_user_id: string;
    }>('SELECT id, subject_type, status, approver_user_id FROM approvals WHERE document_id = $1', [
      document.id,
    ]);
    expect(approval).toMatchObject({
      subject_type: 'DOCUMENT',
      status: 'PENDING',
      approver_user_id: LUCIA,
    });
    const [coverage] = await db.admin<{ document_version_id: string }>(
      'SELECT document_version_id FROM approval_documents WHERE approval_id = $1',
      [approval?.id],
    );
    const [doc] = await db.admin<{
      current_version_id: string;
      pending_approval_id: string;
      status: string;
    }>('SELECT current_version_id, pending_approval_id, status FROM documents WHERE id = $1', [
      document.id,
    ]);
    expect(doc).toMatchObject({ status: 'IN_REVIEW', pending_approval_id: approval?.id });
    expect(coverage?.document_version_id).toBe(doc?.current_version_id);
    // RN-TRAM-43: uma segunda pendência para o mesmo documento é recusada pelo índice parcial.
    await expect(
      db.admin(
        `INSERT INTO approvals (id, tenant_id, process_id, subject_type, document_id, title, requested_by_id, approver_type, approver_user_id, allow_deputy)
         SELECT $1, tenant_id, process_id, 'DOCUMENT', id, 'Duplicada', $2, 'USER', $2, false FROM documents WHERE id = $3`,
        [randomUUID(), LUCIA, document.id],
      ),
    ).rejects.toThrow(/approvals_pending_document_key/);
  });

  it('[Concorrência] duas finalizações simultâneas: uma 200, a outra 412 VERSION_CONFLICT, uma única versão', async () => {
    const document = await createDocument(await newProcess(), typeIds.despacho);
    const [one, two] = await Promise.all([finalize(document.id), finalize(document.id)]);
    expect([one.status, two.status].sort()).toEqual([200, 412]);
    const loser = one.status === 412 ? one : two;
    expect(problemDetailsSchema.parse(loser.body).code).toBe('VERSION_CONFLICT');
    expect(
      await count('SELECT count(*) FROM document_versions WHERE document_id = $1', [document.id]),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'DocumentFinalized'",
        [document.id],
      ),
    ).toBe(1);
  });

  it('[Duplicidade] singletonKey sob concorrência: duas criações simultâneas do ETP → uma criada, outra DOCUMENT_ALREADY_EXISTS', async () => {
    const processId = await newProcess();
    const results = await Promise.allSettled([
      createDocument(processId, typeIds.etp, 'ETP concorrente 1'),
      createDocument(processId, typeIds.etp, 'ETP concorrente 2'),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({
      code: 'DOCUMENT_ALREADY_EXISTS',
      status: 409,
    });
    expect(
      await count(
        "SELECT count(*) FROM documents WHERE process_id = $1 AND document_type_id = $2 AND status <> 'CANCELED'",
        [processId, typeIds.etp],
      ),
    ).toBe(1);
    // O índice parcial é a defesa definitiva: nem por SQL direto entra um segundo ativo.
    await expect(
      db.admin(
        `INSERT INTO documents (id, tenant_id, process_id, document_type_id, title, singleton_key, created_by_id)
         VALUES ($1, $2, $3, $4, 'ETP por SQL', $4, $5)`,
        [randomUUID(), A, processId, typeIds.etp, LUCIA],
      ),
    ).rejects.toThrow(/documents_singleton_key/);
  });

  it('[Falha de banco] falha induzida no outbox desfaz documento, versão e auditoria (transação única)', async () => {
    const document = await createDocument(await newProcess(), typeIds.despacho);
    await db.admin(`
      CREATE FUNCTION test_fail_document_finalized() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.event_type = 'DocumentFinalized' AND NEW.aggregate_id = '${document.id}' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_document_finalized BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_document_finalized();
    `);
    try {
      const response = await finalize(document.id);
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_document_finalized ON outbox_events; DROP FUNCTION test_fail_document_finalized();',
      );
    }
    const [row] = await db.admin<{ status: string; version: number }>(
      'SELECT status, version FROM documents WHERE id = $1',
      [document.id],
    );
    expect(row).toEqual({ status: 'DRAFT', version: 1 });
    expect(
      await count('SELECT count(*) FROM document_versions WHERE document_id = $1', [document.id]),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 AND action LIKE 'document.%' AND action <> 'document.create'",
        [A, document.id],
      ),
    ).toBe(0);
    // A próxima tentativa (sem a falha) conclui normalmente.
    expect((await finalize(document.id)).status).toBe(200);
  });

  it('[Tenant incorreto] documento de outro tenant → 404; RLS esconde as linhas; FK composta impede referência cruzada', async () => {
    const document = await createDocument(await newProcess(), typeIds.despacho);
    const foreign = await call('post', `/documents/${document.id}/finalize`, {
      subject: 'sub-beto-us065',
      tenant: B,
      ifMatch: '"1"',
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(problemDetailsSchema.parse(foreign.body).code).toBe('NOT_FOUND');
    expect(foreign.status).toBe(404);

    const client = db.client('cf_app');
    try {
      const seen = await asTenant(B, () =>
        client.$tenantTransaction(async (tx) => ({
          documents: await tx.$queryRaw<Row[]>`SELECT id FROM documents`,
          versions: await tx.$queryRaw<Row[]>`SELECT id FROM document_versions`,
          approvals: await tx.$queryRaw<Row[]>`SELECT id FROM approvals`,
          coverage: await tx.$queryRaw<Row[]>`SELECT id FROM approval_documents`,
        })),
      );
      expect(seen).toEqual({ documents: [], versions: [], approvals: [], coverage: [] });
      // O papel da aplicação não altera versões (só INSERT) nem exclui documentos (exclusão lógica).
      const tamper = asTenant(A, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$executeRaw`UPDATE document_versions SET change_summary = 'x' WHERE document_id = ${document.id}::uuid`,
        ),
      );
      await expect(tamper).rejects.toThrow(/permission denied/);
      const remove = asTenant(A, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`DELETE FROM documents WHERE id = ${document.id}::uuid`,
        ),
      );
      await expect(remove).rejects.toThrow(/permission denied/);
    } finally {
      await client.$disconnect();
    }
    const [processB] = await db.admin<{ id: string }>(
      'SELECT id FROM processes WHERE tenant_id = $1 LIMIT 1',
      [B],
    );
    if (processB) {
      await expect(
        db.admin(
          `INSERT INTO documents (id, tenant_id, process_id, document_type_id, title, created_by_id)
           VALUES ($1, $2, $3, $4, 'Cruzado', $5)`,
          [randomUUID(), B, processB.id, typeIds.despacho, BETO],
        ),
      ).rejects.toThrow(/documents_tenant_id_document_type_id_fkey/);
    }
  });

  it('[Imutabilidade] versão não muda nem é apagada; cancelado não volta; o papel da aplicação não tem UPDATE em versões', async () => {
    const document = await createDocument(await newProcess(), typeIds.despacho);
    expect((await finalize(document.id)).status).toBe(200);
    await expect(
      db.admin("UPDATE document_versions SET change_summary = 'x' WHERE document_id = $1", [
        document.id,
      ]),
    ).rejects.toThrow(/imutável/);
    await expect(
      db.admin('DELETE FROM document_versions WHERE document_id = $1', [document.id]),
    ).rejects.toThrow(/imutável/);
    const [grant] = await db.admin<{ allowed: boolean }>(
      "SELECT has_table_privilege('cf_app', 'document_versions', 'UPDATE') AS allowed",
    );
    expect(grant?.allowed).toBe(false);

    const draft = await createDocument(await newProcess(), typeIds.despacho);
    const canceled = await call('post', `/documents/${draft.id}/cancel`, {
      ifMatch: '"1"',
      body: { cancellationReason: REASON },
    });
    expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
    await expect(
      db.admin("UPDATE documents SET status = 'DRAFT' WHERE id = $1", [draft.id]),
    ).rejects.toThrow(/cancelado não volta/);
  });
});
