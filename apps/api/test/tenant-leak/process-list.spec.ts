// Lista de processos sobre PostgreSQL real (US-002 · PRC-01): a API inteira como `cf_app` (RLS)
// com os seeders do provisionamento e processos inseridos pelo superusuário. Prova o SQL do
// `ProcessListQueryBuilder`: predicado de visibilidade único (matriz: gestor TENANT, requisitante
// OWN_DEPARTMENTS, HISTORICAL com `access.historicalDepartmentsCanView` verdadeiro e falso,
// concessão USER revogada, consultor externo), POL-09 por linha no valor, no filtro e na ordenação,
// FTS sem acento e trigram por código, datas no fuso do tenant, valores reservados, página + total
// num único snapshot, processo descartado fora, RLS com outro `app.tenant_id` e filtros com ids de
// outro tenant sem revelar nada. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema, processListResponseSchema } from '@contrataflow/validation';
import type { ProcessListResponse } from '@contrataflow/validation';
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

const id = (suffix: string) => `0192c002-0000-7000-8000-${suffix.padStart(12, '0')}`;
const A = id('a');
const B = id('b');
const ORG_A = id('a0');
const ORG_B = id('b0');
const OBRAS = id('a1');
const MANUTENCAO = id('a2');
const COTACOES = id('a3');
const SAUDE = id('a4');
const FARMACIA = id('a5');
const OBRAS_B = id('b1');
const SETOR_X = id('b2');
const ANA = id('c1');
const LUCIA = id('c2');
const BRUNO = id('c3');
const CARLOS = id('c4');
const BETO = id('c5');
const P12 = id('12');
const P31 = id('31');
const P45 = id('45');
const P77 = id('77');
const P88 = id('88');
const P_DELETED = id('99');
const P_B = id('bf');
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BRUNO]: ['CONSULTOR_EXTERNO'],
  [CARLOS]: [],
  [BETO]: ['GESTOR_CONTRATACOES'],
};
const SUBJECTS = {
  ana: 'sub-ana-us002',
  lucia: 'sub-lucia-us002',
  bruno: 'sub-bruno-us002',
  carlos: 'sub-carlos-us002',
  beto: 'sub-beto-us002',
} as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us002', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us002', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${COTACOES}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Cotações', '${path(OBRAS, COTACOES)}', 1),
  ('${SAUDE}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Saúde', '${path(SAUDE)}', 0),
  ('${FARMACIA}', '${A}', '${ORG_A}', '${SAUDE}', 'SECTOR', 'Farmácia Básica', '${path(SAUDE, FARMACIA)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0),
  ('${SETOR_X}', '${B}', '${ORG_B}', '${OBRAS_B}', 'SECTOR', 'Setor X LEAK-B', '${path(OBRAS_B, SETOR_X)}', 1);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana@us002.test', true, 'Ana Souza'),
  ('${LUCIA}', '${SUBJECTS.lucia}', 'patricia@us002.test', true, 'Patrícia Alves'),
  ('${BRUNO}', '${SUBJECTS.bruno}', 'bruno@us002.test', true, 'Bruno Consultor'),
  ('${CARLOS}', '${SUBJECTS.carlos}', 'carlos@us002.test', true, 'Carlos Sem Acesso'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status, expires_at) VALUES
  ('${id('d1')}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE', NULL),
  ('${id('d2')}', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE', NULL),
  ('${id('d3')}', '${A}', '${BRUNO}', 'EXTERNAL', 'ACTIVE', '2099-12-31T00:00:00Z'),
  ('${id('d4')}', '${A}', '${CARLOS}', 'INTERNAL', 'ACTIVE', NULL),
  ('${id('d5')}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE', NULL);
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('${id('e1')}', '${A}', '${id('d1')}', '${MANUTENCAO}', true);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

interface SeedProcess {
  readonly id: string;
  readonly tenantId?: string;
  readonly organizationId?: string;
  readonly number: number;
  readonly title: string;
  readonly object?: string;
  readonly status: string;
  readonly priority: string;
  readonly stageKey: string;
  readonly secretariat?: string;
  readonly department?: string;
  readonly current: string;
  readonly responsible?: string | null;
  readonly confidential?: boolean;
  readonly value?: string | null;
  readonly dueAt?: string | null;
  readonly updatedAt: string;
  readonly createdAt?: string;
  readonly deleted?: boolean;
}

describe('Feature: Listar processos sobre PostgreSQL (US-002)', () => {
  let db: TestDatabase;
  let api: TestApi;

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const get = (query: string, subject: string = SUBJECTS.lucia, tenantId = tenantOf(subject)) =>
    request(api.server)
      .get(`/api/v1/processes${query}`)
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantId);
  const list = async (
    query: string,
    subject: string = SUBJECTS.lucia,
  ): Promise<ProcessListResponse> => {
    const response = await get(query, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return processListResponseSchema.parse(response.body);
  };
  const codes = (body: ProcessListResponse) => body.data.map((item) => item.code);
  const expectProblem = (response: request.Response, status: number, code: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    expect(problemDetailsSchema.parse(response.body).code).toBe(code);
  };

  async function insertProcess(process: SeedProcess): Promise<void> {
    const tenantId = process.tenantId ?? A;
    await db.admin(
      `INSERT INTO processes (
         id, tenant_id, organization_id, number, year, code, title, object, contracting_type_id,
         requesting_secretariat_id, requesting_department_id, current_department_id,
         current_responsible_id, priority, status, status_before_suspension, workflow_version_id,
         current_workflow_stage_id, current_stage_due_at, estimated_value, estimated_value_source,
         is_budget_confidential, origin_id, pca_status, created_by_id, created_at, updated_at,
         deleted_at)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::int, 2026, lpad($4::int::text, 4, '0') || '/2026', $5, $6,
              (SELECT id FROM catalog_items WHERE tenant_id = $2 AND catalog_type = 'CONTRACTING_TYPE' AND code = 'AQUISICAO_BENS'),
              $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::text::priority, $12::text::process_status,
              CASE WHEN $12::text = 'SUSPENDED' THEN 'IN_PROGRESS'::process_status END,
              s.workflow_version_id, s.id, $13::timestamptz, $14::numeric,
              CASE WHEN $14::numeric IS NULL THEN NULL ELSE 'MANUAL'::estimated_value_source END,
              $15::boolean,
              (SELECT id FROM catalog_items WHERE tenant_id = $2 AND catalog_type = 'PROCESS_ORIGIN' AND code = 'DEMANDA_NAO_PREVISTA'),
              'NOT_APPLICABLE', $16::uuid, $17::timestamptz, $18::timestamptz, $19::timestamptz
         FROM workflow_stages s
         JOIN workflow_versions v ON v.id = s.workflow_version_id AND v.status = 'PUBLISHED'
        WHERE s.tenant_id = $2::uuid AND s.key = $20::text
        LIMIT 1`,
      [
        process.id,
        tenantId,
        process.organizationId ?? ORG_A,
        process.number,
        process.title,
        process.object ?? `Objeto do processo ${process.title}.`,
        process.secretariat ?? OBRAS,
        process.department ?? MANUTENCAO,
        process.current,
        process.responsible ?? null,
        process.priority,
        process.status,
        process.dueAt ?? null,
        process.value ?? null,
        process.confidential ?? false,
        ANA,
        process.createdAt ?? '2026-09-14T13:02:11Z',
        process.updatedAt,
        process.deleted === true ? '2026-10-04T10:00:00Z' : null,
        process.stageKey,
      ],
    );
  }

  async function grant(
    processId: string,
    principal: { department: string } | { user: string },
    reason: string,
    options: { tenantId?: string; revoked?: boolean } = {},
  ): Promise<void> {
    const department = 'department' in principal ? principal.department : null;
    const user = 'user' in principal ? principal.user : null;
    await db.admin(
      `INSERT INTO process_access (id, tenant_id, process_id, principal_type, department_id, user_id, reason, revoked_at)
       VALUES ($1, $2, $3, $4::principal_type, $5, $6, $7::process_access_reason, $8)`,
      [
        randomUUID(),
        options.tenantId ?? A,
        processId,
        department === null ? 'USER' : 'DEPARTMENT',
        department,
        user,
        reason,
        options.revoked === true ? '2026-10-01T00:00:00Z' : null,
      ],
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

    // Background do Gherkin.
    await insertProcess({
      id: P12,
      number: 12,
      title: 'Aquisição de cimento para manutenção de vias',
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      stageKey: 'PESQUISA_PRECOS',
      current: COTACOES,
      value: '85000.00',
      updatedAt: '2026-10-02T18:40:00Z',
      // 2026-10-04 23:30 em São Paulo (RN-PROC-31).
      createdAt: '2026-10-05T02:30:00Z',
    });
    await insertProcess({
      id: P31,
      number: 31,
      title: 'Contratação de limpeza hospitalar',
      status: 'RETURNED',
      priority: 'MEDIUM',
      stageKey: 'ESTUDOS_PRELIMINARES',
      current: MANUTENCAO,
      responsible: ANA,
      confidential: true,
      value: '1200000.00',
      updatedAt: '2026-10-03T10:00:00Z',
    });
    await insertProcess({
      id: P45,
      number: 45,
      title: 'Aquisição de medicamentos da farmácia básica',
      status: 'AWAITING_APPROVAL',
      priority: 'URGENT',
      stageKey: 'APROVACAO_DFD',
      secretariat: SAUDE,
      department: FARMACIA,
      current: SAUDE,
      dueAt: '2026-10-01T02:59:59.999Z',
      updatedAt: '2026-10-01T10:00:00Z',
    });
    // Sigiloso visível a Ana pela unidade solicitante, sem custódia: valor mascarado para ela.
    await insertProcess({
      id: P77,
      number: 77,
      title: 'Reforma da sede da secretaria',
      status: 'IN_PROGRESS',
      priority: 'LOW',
      stageKey: 'TERMO_REFERENCIA',
      current: COTACOES,
      responsible: LUCIA,
      confidential: true,
      value: '9000000.00',
      updatedAt: '2026-09-20T10:00:00Z',
    });
    // Ana só o vê como unidade HISTORICAL (passou pelo Setor de Manutenção).
    await insertProcess({
      id: P88,
      number: 88,
      title: 'Pavimentação de vias rurais',
      status: 'IN_PROGRESS',
      priority: 'MEDIUM',
      stageKey: 'ABERTURA',
      secretariat: SAUDE,
      department: FARMACIA,
      current: SAUDE,
      updatedAt: '2026-09-10T10:00:00Z',
    });
    await insertProcess({
      id: P_DELETED,
      number: 99,
      title: 'Processo descartado de manutenção',
      status: 'DRAFT',
      priority: 'LOW',
      stageKey: 'ABERTURA',
      current: MANUTENCAO,
      updatedAt: '2026-10-04T09:00:00Z',
      deleted: true,
    });
    await insertProcess({
      id: P_B,
      tenantId: B,
      organizationId: ORG_B,
      number: 12,
      title: 'Aquisição de cimento LEAK-B',
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      stageKey: 'PESQUISA_PRECOS',
      secretariat: OBRAS_B,
      department: SETOR_X,
      current: SETOR_X,
      updatedAt: '2026-10-04T09:00:00Z',
    });
    for (const processId of [P12, P31, P77, P_DELETED]) {
      await grant(processId, { department: MANUTENCAO }, 'REQUESTING');
      await grant(processId, { department: OBRAS }, 'REQUESTING');
    }
    await grant(P12, { department: COTACOES }, 'CURRENT');
    // Duplicidade: várias concessões de Ana no 0012 (unidade + HISTORICAL + CREATOR).
    await grant(P12, { department: MANUTENCAO }, 'HISTORICAL');
    await grant(P12, { user: ANA }, 'CREATOR');
    await grant(P31, { department: MANUTENCAO }, 'CURRENT');
    await grant(P31, { user: ANA }, 'RESPONSIBLE');
    await grant(P31, { user: BRUNO }, 'PARTICIPANT');
    // Participação revogada não dá visibilidade.
    await grant(P45, { user: BRUNO }, 'PARTICIPANT', { revoked: true });
    await grant(P45, { department: FARMACIA }, 'REQUESTING');
    await grant(P45, { department: SAUDE }, 'CURRENT');
    await grant(P77, { department: COTACOES }, 'CURRENT');
    await grant(P88, { department: MANUTENCAO }, 'HISTORICAL');
    await grant(P88, { department: SAUDE }, 'CURRENT');
    await grant(P_B, { department: SETOR_X }, 'CURRENT', { tenantId: B });
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] gestor: filtros E/OU, ordenação por prioridade, nomes e valor sigiloso visível', async () => {
    const body = await list('?status=IN_PROGRESS%2CRETURNED&sort=-priority');
    // Empate de prioridade (0031 × 0088): desempate por id decrescente.
    expect(codes(body)).toEqual(['0012/2026', '0088/2026', '0031/2026', '0077/2026']);
    expect(body.meta).toMatchObject({ totalItems: 4, totalPages: 1 });
    expect(body.data[0]).toMatchObject({
      currentStage: { key: 'PESQUISA_PRECOS' },
      currentDepartment: { id: COTACOES, name: 'Setor de Cotações' },
      requestingSecretariat: { id: OBRAS, name: 'Secretaria de Obras' },
      organization: { shortName: 'PMSJ' },
      contractingType: { code: 'AQUISICAO_BENS' },
      estimatedValue: '85000.00',
    });
    expect(body.data.find((item) => item.id === P31)).toMatchObject({
      estimatedValue: '1200000.00',
      estimatedValueMasked: false,
      currentResponsible: { id: ANA, name: 'Ana Souza' },
    });
  });

  it('[Sucesso] atrasados (RN-PROC-23) com deadline de 3 dias úteis; prazo e sem responsável', async () => {
    const overdue = await list('?overdue=true');
    expect(codes(overdue)).toEqual(['0045/2026']);
    expect(overdue.data[0]?.deadline).toMatchObject({ isOverdue: true, overdueDays: 3 });
    expect(codes(await list('?currentResponsibleId=none&sort=code'))).toEqual([
      '0012/2026',
      '0045/2026',
      '0088/2026',
    ]);
    expect(codes(await list(`?currentResponsibleId=me,${LUCIA}`, SUBJECTS.ana))).toEqual([
      '0031/2026',
      '0077/2026',
    ]);
    expect(codes(await list('?currentDepartmentId=mine', SUBJECTS.ana))).toEqual(['0031/2026']);
    expect(codes(await list('?stageKey=PESQUISA_PRECOS,APROVACAO_DFD&sort=code'))).toEqual([
      '0012/2026',
      '0045/2026',
    ]);
  });

  it('[Sucesso] busca: código parcial por trigram primeiro, FTS sem acento, datas no fuso do tenant', async () => {
    const byCode = await list('?q=12%2F2026', SUBJECTS.ana);
    expect(byCode.data[0]?.code).toBe('0012/2026');
    expect(codes(await list('?q=manutencao&sort=code'))).toEqual(['0012/2026']);
    expect(codes(await list('?q=farmacia'))).toEqual(['0045/2026']);
    expect(codes(await list('?createdFrom=2026-10-04&createdTo=2026-10-04'))).toEqual([
      '0012/2026',
    ]);
    expect(codes(await list('?createdFrom=2026-10-05'))).toEqual([]);
  });

  it('[Validação] injeção em sort é recusada antes do banco; q com SQL é só parâmetro', async () => {
    expectProblem(await get('?sort=updatedAt;DROP%20TABLE%20processes'), 422, 'VALIDATION_ERROR');
    expect((await list(`?q=${encodeURIComponent("'; DROP TABLE processes; --")}`)).data).toEqual(
      [],
    );
    const [row] = await db.admin<{ count: string }>('SELECT count(*) FROM processes');
    expect(Number(row?.count)).toBe(7);
  });

  it('[Permissão] matriz de visibilidade: requisitante, HISTORICAL ligado/desligado, descartado fora', async () => {
    expect(codes(await list('?sort=code', SUBJECTS.ana))).toEqual([
      '0012/2026',
      '0031/2026',
      '0077/2026',
      '0088/2026',
    ]);
    // 0045 (Farmácia Básica) não é visível a Ana; 0088 só pela unidade HISTORICAL.
    const farmacia = await list(`?requestingDepartmentId=${FARMACIA}`, SUBJECTS.ana);
    expect(codes(farmacia)).toEqual(['0088/2026']);
    await db.admin(
      `INSERT INTO tenant_settings (id, tenant_id, key, value)
       VALUES ($1, $2, 'access.historicalDepartmentsCanView', 'false'::jsonb)`,
      [randomUUID(), A],
    );
    try {
      expect(codes(await list('?sort=code', SUBJECTS.ana))).toEqual([
        '0012/2026',
        '0031/2026',
        '0077/2026',
      ]);
    } finally {
      await db.admin(
        "DELETE FROM tenant_settings WHERE key = 'access.historicalDepartmentsCanView'",
      );
    }
    const all = await list('?pageSize=100');
    expect(all.meta.totalItems).toBe(5);
    expect(all.data.map((item) => item.id)).not.toContain(P_DELETED);
  });

  it('[Permissão] POL-09 por linha: mascarado, fora do filtro de valor e ao final da ordenação', async () => {
    const all = await list('?sort=code', SUBJECTS.ana);
    expect(all.data.find((item) => item.id === P31)).toMatchObject({
      estimatedValue: '1200000.00',
    });
    expect(all.data.find((item) => item.id === P77)).toMatchObject({
      estimatedValue: null,
      estimatedValueMasked: true,
      isBudgetConfidential: true,
    });
    const byValue = await list('?estimatedValueMin=1000000.00', SUBJECTS.ana);
    expect(codes(byValue)).toEqual(['0031/2026']);
    expect(byValue.meta.valueFilterExcludesConfidential).toBe(true);
    const sorted = await list('?sort=-estimatedValue', SUBJECTS.ana);
    expect(codes(sorted)).toEqual(['0031/2026', '0012/2026', '0088/2026', '0077/2026']);
    // O gestor (POL-09 TENANT) filtra e ordena pelo valor real.
    expect(codes(await list('?estimatedValueMin=1000000.00&sort=-estimatedValue'))).toEqual([
      '0077/2026',
      '0031/2026',
    ]);
  });

  it('[Permissão] consultor externo: só a participação ativa; sem PROCESS_VIEW nem concessão → 403', async () => {
    const consultant = await list('', SUBJECTS.bruno);
    expect(codes(consultant)).toEqual(['0031/2026']);
    expect(consultant.data[0]).toMatchObject({ estimatedValue: null, estimatedValueMasked: true });
    expectProblem(await get('', SUBJECTS.carlos), 403, 'PERMISSION_DENIED');
    const [audit] = await db.admin<{ reason_code: string }>(
      "SELECT reason_code FROM audit_logs WHERE tenant_id = $1 AND action = 'access.denied' AND actor_user_id = $2",
      [A, CARLOS],
    );
    expect(audit?.reason_code).toBe('PROCESS_VIEW');
  });

  it('[Tenant incorreto] ids de B não casam nem revelam; RLS com app.tenant_id de B não vê A', async () => {
    for (const query of [
      `?currentDepartmentId=${SETOR_X}`,
      `?organizationId=${ORG_B}`,
      `?requestingSecretariatId=${OBRAS_B}`,
    ]) {
      const response = await get(query);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        data: [],
        meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      });
    }
    expect(JSON.stringify((await list('?pageSize=100')).data)).not.toContain('LEAK-B');
    expect(codes(await list('', SUBJECTS.beto))).toEqual(['0012/2026']);
    expectProblem(await get('', SUBJECTS.lucia, B), 403, 'MEMBERSHIP_INACTIVE');
    const client = db.client('cf_app');
    try {
      const seen = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$queryRaw<{ id: string }[]>`SELECT id FROM processes WHERE tenant_id = ${A}::uuid`,
        ),
      );
      expect(seen).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });

  it('[Duplicidade] várias concessões: aparece uma vez e conta uma vez', async () => {
    const body = await list(`?q=cimento`, SUBJECTS.ana);
    expect(body.data.map((item) => item.id)).toEqual([P12]);
    expect(body.meta.totalItems).toBe(1);
  });

  it('[Concorrência] tramitação concluída: etapa e unidade novas juntas; paginação estável com empates', async () => {
    await db.admin(
      `UPDATE processes p SET current_workflow_stage_id = s.id, current_department_id = $2
         FROM workflow_stages s
        WHERE p.id = $1 AND s.workflow_version_id = p.workflow_version_id AND s.key = 'TERMO_REFERENCIA'`,
      [P12, MANUTENCAO],
    );
    try {
      const [moved] = (await list('?q=cimento')).data;
      expect(moved).toMatchObject({
        currentStage: { key: 'TERMO_REFERENCIA' },
        currentDepartment: { id: MANUTENCAO, name: 'Setor de Manutenção' },
      });
    } finally {
      await db.admin(
        `UPDATE processes p SET current_workflow_stage_id = s.id, current_department_id = $2
           FROM workflow_stages s
          WHERE p.id = $1 AND s.workflow_version_id = p.workflow_version_id AND s.key = 'PESQUISA_PRECOS'`,
        [P12, COTACOES],
      );
    }
    await db.admin(
      "UPDATE processes SET updated_at = '2026-10-01T00:00:00Z' WHERE tenant_id = $1",
      [A],
    );
    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      seen.push(...(await list(`?pageSize=2&page=${page}`)).data.map((item) => item.id));
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...seen].sort().reverse());
  });
});
