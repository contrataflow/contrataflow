// Duplicar DFD sobre PostgreSQL real (US-018 · Sucesso, Tenant incorreto, Duplicidade, Concorrência,
// Falha de banco, Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais, o
// processo criado pelo PRC-02, o DFD pelo DFD-02 e os itens pelo DOC-07. Prova a duplicação numa
// transação só — falha induzida no `dfds` DEPOIS de criar o processo, os itens e o documento não
// deixa processo, item, documento, evento, auditoria nem número consumido —, o índice único do DFD
// ativo sob 10 duplicações paralelas para o mesmo processo existente (1 × 201, 9 × 409, um só
// conjunto de itens clonados), o isolamento de tenant (origem e destino de B) e os eventos
// `PENDING`. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { DfdDto, ProcessDto, ProcessItemDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { DFD_CLOCK } from '../../src/modules/dfd/application/ports.js';
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

const A = '0192c018-0000-7000-8000-00000000010a';
const B = '0192c018-0000-7000-8000-00000000010b';
const ORG_A = '0192c018-0000-7000-8000-0000000010a0';
const ORG_B = '0192c018-0000-7000-8000-0000000010b0';
const SAUDE = '0192c018-0000-7000-8000-0000000010a1';
const ATENCAO = '0192c018-0000-7000-8000-0000000010a2';
const SAUDE_B = '0192c018-0000-7000-8000-0000000010b1';
const ATENCAO_B = '0192c018-0000-7000-8000-0000000010b2';
const ANA = '0192c018-0000-7000-8000-0000000010c1';
const BETO = '0192c018-0000-7000-8000-0000000010c3';
const ANA_M = '0192c018-0000-7000-8000-0000000010d1';
const BETO_M = '0192c018-0000-7000-8000-0000000010d3';
const NOW = new Date('2026-10-17T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const SUBJECTS = { ana: 'sub-ana-us018', beto: 'sub-beto-us018' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us018', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us018', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura de Santa Luzia LEAK-B', 'PMSL', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${SAUDE}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Saúde', '${path(SAUDE)}', 0),
  ('${ATENCAO}', '${A}', '${ORG_A}', '${SAUDE}', 'SECTOR', 'Setor de Atenção Básica', '${path(SAUDE, ATENCAO)}', 1),
  ('${SAUDE_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Saúde LEAK-B', '${path(SAUDE_B)}', 0),
  ('${ATENCAO_B}', '${B}', '${ORG_B}', '${SAUDE_B}', 'SECTOR', 'Atenção LEAK-B', '${path(SAUDE_B, ATENCAO_B)}', 1);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana@a.test', true, 'Ana Souza'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${BETO_M}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c018-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${ATENCAO}', true),
  ('0192c018-0000-7000-8000-0000000010e3', '${B}', '${BETO_M}', '${ATENCAO_B}', true);
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

interface Counts {
  readonly processes: number;
  readonly process_items: number;
  readonly documents: number;
  readonly dfds: number;
  readonly document_items: number;
  readonly events: number;
  readonly audit: number;
}

const words = (count: number) =>
  Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

describe('Feature: Duplicar DFD sobre PostgreSQL (US-018)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; cx: string; un: string };
  let catalogB: { contractingType: string; origin: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.ana) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  /** Processo pelo PRC-02, em rascunho na etapa ABERTURA (Ana, tenant A; Beto, tenant B). */
  const createProcess = async (subject: string = SUBJECTS.ana): Promise<ProcessDto> => {
    const foreign = subject === SUBJECTS.beto;
    const response = await call(request(api.server).post('/api/v1/processes'), subject)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Aquisição de insumos ${words(2)}`,
        object: `Aquisição de insumos para a UBS Centro ${words(2)}`,
        contractingTypeId: foreign ? catalogB.contractingType : catalog.contractingType,
        requestingSecretariatId: foreign ? SAUDE_B : SAUDE,
        requestingDepartmentId: foreign ? ATENCAO_B : ATENCAO,
        originId: foreign ? catalogB.origin : catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: ProcessDto }).data;
  };
  const createDfd = (processId: string, subject: string = SUBJECTS.ana) =>
    call(request(api.server).post(`/api/v1/processes/${processId}/dfds`), subject)
      .set('Idempotency-Key', randomUUID())
      .send({});
  const createItem = async (processId: string, description: string, unitOfMeasureId: string) => {
    const response = await call(request(api.server).post(`/api/v1/processes/${processId}/items`))
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', description, unitOfMeasureId });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: ProcessItemDto }).data;
  };
  const putItems = (documentId: string, items: unknown[], ifMatch: string) =>
    call(request(api.server).put(`/api/v1/documents/${documentId}/items`))
      .set('If-Match', ifMatch)
      .send({ items });
  const duplicate = (
    dfdId: string,
    body: Record<string, unknown>,
    options: { key?: string; subject?: string } = {},
  ) =>
    call(request(api.server).post(`/api/v1/dfds/${dfdId}/duplicate`), options.subject)
      .set('Idempotency-Key', options.key ?? randomUUID())
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
      "SELECT last_value FROM number_sequences WHERE tenant_id = $1 AND sequence_key = 'DOCUMENT:DFD:*:2026'",
      [A],
    );
    return row?.last_value ?? 0;
  };
  const counts = async (tenantId: string = A): Promise<Counts> => {
    const [row] = await db.admin<Counts>(
      `SELECT (SELECT count(*) FROM processes WHERE tenant_id = $1)::int AS processes,
              (SELECT count(*) FROM process_items WHERE tenant_id = $1)::int AS process_items,
              (SELECT count(*) FROM documents WHERE tenant_id = $1)::int AS documents,
              (SELECT count(*) FROM dfds WHERE tenant_id = $1)::int AS dfds,
              (SELECT count(*) FROM document_items WHERE tenant_id = $1)::int AS document_items,
              (SELECT count(*) FROM outbox_events WHERE tenant_id = $1)::int AS events,
              (SELECT count(*) FROM audit_logs WHERE tenant_id = $1)::int AS audit`,
      [tenantId],
    );
    if (!row) throw new Error('contagem ausente');
    return row;
  };

  /** DFD de origem: processo com 2 itens (luvas × 120, seringas × 5000) já no DFD. */
  const sourceDfd = async () => {
    const process = await createProcess();
    const dfd = ((await createDfd(process.id)).body as { data: DfdDto }).data;
    const gloves = await createItem(process.id, 'Luva de procedimento, tamanho M', catalog.cx);
    const syringes = await createItem(process.id, 'Seringa descartável 5 ml', catalog.un);
    const saved = await putItems(
      dfd.documentId,
      [
        { processItemId: gloves.id, quantity: '120' },
        { processItemId: syringes.id, quantity: '5000' },
      ],
      '"1"',
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    return { process, dfd };
  };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
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
        { token: DFD_CLOCK, value: () => NOW },
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
    const seeders = [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
    ];
    await runTenantSeeders(api, A, seeders);
    await runTenantSeeders(api, B, seeders);
    catalog = {
      contractingType: await catalogId(A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: await catalogId(A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      cx: await catalogId(A, 'UNIT_OF_MEASURE', 'CX'),
      un: await catalogId(A, 'UNIT_OF_MEASURE', 'UN'),
    };
    catalogB = {
      contractingType: await catalogId(B, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: await catalogId(B, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] novo processo numa transação: processo, itens, documento com sourceDocumentId, DFD, itens do DFD remapeados, auditoria e eventos PENDING', async () => {
    const source = await sourceDfd();
    const numberBefore = await lastNumber();
    const before = await counts();

    const response = await duplicate(source.dfd.id, { targetType: 'NEW_PROCESS' });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = (response.body as { data: DfdDto }).data;
    expect(created).toMatchObject({
      status: 'DRAFT',
      documentId: created.id,
      requestDate: '2026-10-17',
      wizardStep: 'IDENTIFICATION',
      completedSteps: [],
      code: `DFD ${String(numberBefore + 1).padStart(4, '0')}/2026`,
    });
    expect(created.processId).not.toBe(source.process.id);
    expect(await lastNumber()).toBe(numberBefore + 1);

    const after = await counts();
    expect(after).toMatchObject({
      processes: before.processes + 1,
      process_items: before.process_items + 2,
      documents: before.documents + 1,
      dfds: before.dfds + 1,
      document_items: before.document_items + 2,
    });
    expect(
      await db.admin<Row>(
        `SELECT source_document_id, status::text, process_id FROM documents WHERE id = $1`,
        [created.documentId],
      ),
    ).toEqual([
      {
        source_document_id: source.dfd.documentId,
        status: 'DRAFT',
        process_id: created.processId,
      },
    ]);
    expect(
      await db.admin<Row>(
        `SELECT pi.sequence, di.quantity::text
           FROM document_items di
           JOIN process_items pi ON pi.id = di.process_item_id AND pi.tenant_id = di.tenant_id
          WHERE di.document_id = $1
          ORDER BY di.sort_order`,
        [created.documentId],
      ),
    ).toEqual([
      { sequence: 1, quantity: '120.0000' },
      { sequence: 2, quantity: '5000.0000' },
    ]);
    // O novo processo aponta para os seus próprios itens, nunca para os da origem.
    expect(
      await db.admin<Row>(
        `SELECT count(*)::int AS count FROM document_items di
           JOIN process_items pi ON pi.id = di.process_item_id AND pi.tenant_id = di.tenant_id
          WHERE di.document_id = $1 AND pi.process_id <> $2`,
        [created.documentId, created.processId],
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await db.admin<Row>(
        "SELECT action, metadata->>'targetType' AS target_type FROM audit_logs WHERE process_id = $1 AND action = 'document.duplicate'",
        [created.processId],
      ),
    ).toEqual([{ action: 'document.duplicate', target_type: 'NEW_PROCESS' }]);
    // [Falha de integração] relay fora: os eventos ficam PENDING para publicação.
    expect(
      await db.admin<Row>(
        "SELECT event_type, status::text FROM outbox_events WHERE process_id = $1 AND event_type IN ('ProcessCreated', 'DocumentCreated') ORDER BY event_type",
        [created.processId],
      ),
    ).toEqual([
      { event_type: 'DocumentCreated', status: 'PENDING' },
      { event_type: 'ProcessCreated', status: 'PENDING' },
    ]);
  });

  it('[Sucesso] processo existente: itens do DFD clonados como ProcessItem a partir do próximo número e ProcessItemsChanged PENDING', async () => {
    const source = await sourceDfd();
    const target = await createProcess();
    await createItem(target.id, 'Álcool em gel 500 ml', catalog.un);

    const response = await duplicate(source.dfd.id, {
      targetType: 'EXISTING_PROCESS',
      targetProcessId: target.id,
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = (response.body as { data: DfdDto }).data;
    expect(created.processId).toBe(target.id);
    expect(
      await db.admin<Row>(
        'SELECT sequence, description FROM process_items WHERE process_id = $1 AND deleted_at IS NULL ORDER BY sequence',
        [target.id],
      ),
    ).toEqual([
      { sequence: 1, description: 'Álcool em gel 500 ml' },
      { sequence: 2, description: 'Luva de procedimento, tamanho M' },
      { sequence: 3, description: 'Seringa descartável 5 ml' },
    ]);
    expect(
      await db.admin<Row>(
        "SELECT status::text FROM outbox_events WHERE process_id = $1 AND event_type = 'ProcessItemsChanged' ORDER BY occurred_at DESC, id DESC LIMIT 1",
        [target.id],
      ),
    ).toEqual([{ status: 'PENDING' }]);
  });

  it('[Concorrência] 10 duplicações simultâneas para o mesmo processo existente: 1 × 201 e 9 × 409; um só DFD, um só conjunto de itens e número sem lacuna', async () => {
    const source = await sourceDfd();
    const target = await createProcess();
    const numberBefore = await lastNumber();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        duplicate(source.dfd.id, { targetType: 'EXISTING_PROCESS', targetProcessId: target.id }),
      ),
    );

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(9);
    for (const response of responses.filter((item) => item.status === 409)) {
      expect(problemDetailsSchema.parse(response.body).code).toBe('DOCUMENT_ALREADY_EXISTS');
    }
    expect(
      await db.admin<Row>('SELECT count(*)::int AS count FROM dfds WHERE process_id = $1', [
        target.id,
      ]),
    ).toEqual([{ count: 1 }]);
    expect(
      await db.admin<Row>(
        'SELECT count(*)::int AS count FROM process_items WHERE process_id = $1 AND deleted_at IS NULL',
        [target.id],
      ),
    ).toEqual([{ count: 2 }]);
    expect(await lastNumber()).toBe(numberBefore + 1);
  });

  it('[Duplicidade] reenvio com a mesma chave: mesmo DFD, Idempotent-Replayed e um só processo/DFD criado', async () => {
    const source = await sourceDfd();
    const before = await counts();
    const key = randomUUID();

    const first = await duplicate(source.dfd.id, { targetType: 'NEW_PROCESS' }, { key });
    const replay = await duplicate(source.dfd.id, { targetType: 'NEW_PROCESS' }, { key });

    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((replay.body as { data: DfdDto }).data.id).toBe(
      (first.body as { data: DfdDto }).data.id,
    );
    const after = await counts();
    expect(after.processes).toBe(before.processes + 1);
    expect(after.dfds).toBe(before.dfds + 1);
  });

  it('[Falha de banco] falha induzida ao gravar o Dfd DEPOIS de criar processo, itens e documento desfaz tudo, inclusive o número', async () => {
    const source = await sourceDfd();
    const numberBefore = await lastNumber();
    const before = await counts();
    await db.admin(`
      CREATE FUNCTION test_fail_dfd_duplicate() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'falha induzida no teste';
      END $fn$;
      CREATE TRIGGER test_fail_dfd_duplicate BEFORE INSERT ON dfds
        FOR EACH ROW EXECUTE FUNCTION test_fail_dfd_duplicate();`);
    try {
      const failed = await duplicate(source.dfd.id, { targetType: 'NEW_PROCESS' });
      expect(failed.status).toBe(500);
      // Nada órfão: nenhum processo, item, documento, DFD, evento nem auditoria; número intacto.
      expect(await counts()).toEqual(before);
      expect(await lastNumber()).toBe(numberBefore);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_dfd_duplicate ON dfds; DROP FUNCTION test_fail_dfd_duplicate();',
      );
    }
    // Sem a falha, a mesma duplicação recebe o próximo número (nenhum foi consumido).
    const created = await duplicate(source.dfd.id, { targetType: 'NEW_PROCESS' });
    expect((created.body as { data: DfdDto }).data.code).toBe(
      `DFD ${String(numberBefore + 1).padStart(4, '0')}/2026`,
    );
  });

  it('[Tenant incorreto] DFD de A pelo tenant B: 404; processo de B como destino: 422 REFERENCE_NOT_FOUND; nada de B é lido nem alterado', async () => {
    const source = await sourceDfd();
    const foreign = await createProcess(SUBJECTS.beto);
    const beforeA = await counts(A);
    const beforeB = await counts(B);

    const notFound = await duplicate(
      source.dfd.id,
      { targetType: 'NEW_PROCESS' },
      { subject: SUBJECTS.beto },
    );
    expect(notFound.status).toBe(404);
    expect(problemDetailsSchema.parse(notFound.body).code).toBe('DFD_NOT_FOUND');
    expect(JSON.stringify(notFound.body)).not.toContain(source.dfd.code ?? '#');

    for (const targetProcessId of [foreign.id, randomUUID()]) {
      const refused = await duplicate(source.dfd.id, {
        targetType: 'EXISTING_PROCESS',
        targetProcessId,
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      const problem = problemDetailsSchema.parse(refused.body);
      expect(problem.code).toBe('VALIDATION_ERROR');
      expect(problem.errors.map((error) => [error.field, error.code])).toEqual([
        ['targetProcessId', 'REFERENCE_NOT_FOUND'],
      ]);
      expect(JSON.stringify(refused.body)).not.toContain(foreign.id);
    }

    expect(await counts(A)).toEqual(beforeA);
    expect(await counts(B)).toEqual(beforeB);
    expect(
      await db.admin<Row>('SELECT count(*)::int AS count FROM documents WHERE process_id = $1', [
        foreign.id,
      ]),
    ).toEqual([{ count: 0 }]);
  });
});
