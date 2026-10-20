// Dashboard operacional sobre PostgreSQL real (US-076 · DSH-01/DSH-02): a API inteira como
// `cf_app` (RLS das views `security_invoker` `v_dashboard_*`) com os seeders reais do
// provisionamento (workflow padrão DEC-015). Prova o SQL de cada indicador, a visibilidade DEC-024
// (gestora em escopo TENANT × requisitante só das lotações, em requisições simultâneas), POL-09 nos
// agregados (`confidentialExcluded`) e na atividade recente (`BUDGET_RESTRICTED`), a consistência
// de `PENDING_ITEMS` com TSK-02 (RN-DASH-03), o cache de 60 s e o isolamento por tenant (filtro com
// unidade de B → 422 igual à inexistente; processos e entradas de B fora de tudo; RLS das views com
// outro `app.tenant_id`). `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import {
  dashboardSummaryResponseSchema,
  dashboardWidgetResponseSchema,
  problemDetailsSchema,
  taskInboxCountersResponseSchema,
} from '@contrataflow/validation';
import type { DashboardWidgetKey, DashboardWidgetOf, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { InMemoryCacheStore } from '#shared/cache/cache-store.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { DASHBOARD_CLOCK } from '../../src/modules/dashboard/application/ports.js';
import { INBOX_CLOCK } from '../../src/modules/inbox/application/ports.js';
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

const A = '0192c076-0000-7000-8000-00000000010a';
const B = '0192c076-0000-7000-8000-00000000010b';
const ORG_A = '0192c076-0000-7000-8000-0000000010a0';
const ORG_B = '0192c076-0000-7000-8000-0000000010b0';
const OBRAS = '0192c076-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c076-0000-7000-8000-0000000010a2';
const SAUDE = '0192c076-0000-7000-8000-0000000010a3';
const VIGILANCIA = '0192c076-0000-7000-8000-0000000010a4';
const OBRAS_B = '0192c076-0000-7000-8000-0000000010b1';
const SETOR_Y = '0192c076-0000-7000-8000-0000000010b2';
const ANA = '0192c076-0000-7000-8000-0000000010c1';
const CARLA = '0192c076-0000-7000-8000-0000000010c2';
const LUCIA = '0192c076-0000-7000-8000-0000000010c3';
const ELI = '0192c076-0000-7000-8000-0000000010c4';
const ANA_M = '0192c076-0000-7000-8000-0000000010d1';
const CARLA_M = '0192c076-0000-7000-8000-0000000010d2';
const LUCIA_M = '0192c076-0000-7000-8000-0000000010d3';
const ELI_M = '0192c076-0000-7000-8000-0000000010d4';
const ANA_B_M = '0192c076-0000-7000-8000-0000000010d5';
// Entradas de timeline semeadas (RECENT_ACTIVITY).
const RESTRICTED = '0192c076-0000-7000-8000-0000000010f1';
const STANDARD = '0192c076-0000-7000-8000-0000000010f2';
const FOREIGN_ENTRY = '0192c076-0000-7000-8000-0000000010f3';
// Terça, 20/10/2026, 12:00 em Brasília.
const NOW = new Date('2026-10-20T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

// Ana: gestão em escopo TENANT SEM orçamento sigiloso (LICITACOES); Lúcia: GESTOR_CONTRATACOES
// (com POL-09); Carla e Eli: REQUISITANTE (PROCESS_VIEW das lotações — Obras/Manutenção).
const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['LICITACOES'],
  [CARLA]: ['REQUISITANTE'],
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [ELI]: ['REQUISITANTE'],
};

const SUBJECT: Readonly<Record<string, string>> = {
  [ANA]: 'sub-ana-us076',
  [CARLA]: 'sub-carla-us076',
  [LUCIA]: 'sub-lucia-us076',
  [ELI]: 'sub-eli-us076',
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us076', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us076', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us076', 'ana@saojose.test', true, 'Ana Souza'),
  ('${CARLA}', 'sub-carla-us076', 'carla@saojose.test', true, 'Carla Dias'),
  ('${LUCIA}', 'sub-lucia-us076', 'lucia@saojose.test', true, 'Lúcia Reis'),
  ('${ELI}', 'sub-eli-us076', 'eli@saojose.test', true, 'Eli Matos');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${SAUDE}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Saúde', '${path(SAUDE)}', 0),
  ('${VIGILANCIA}', '${A}', '${ORG_A}', '${SAUDE}', 'SECTOR', 'Vigilância Sanitária', '${path(SAUDE, VIGILANCIA)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0),
  ('${SETOR_Y}', '${B}', '${ORG_B}', '${OBRAS_B}', 'SECTOR', 'Setor Y LEAK-B', '${path(OBRAS_B, SETOR_Y)}', 1);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${CARLA_M}', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('${LUCIA_M}', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('${ELI_M}', '${A}', '${ELI}', 'INTERNAL', 'ACTIVE'),
  ('${ANA_B_M}', '${B}', '${ANA}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c076-0000-7000-8000-0000000010e1', '${A}', '${CARLA_M}', '${OBRAS}', true),
  ('0192c076-0000-7000-8000-0000000010e2', '${A}', '${ELI_M}', '${MANUTENCAO}', true),
  ('0192c076-0000-7000-8000-0000000010e3', '${A}', '${ANA_M}', '${OBRAS}', true),
  ('0192c076-0000-7000-8000-0000000010e4', '${A}', '${LUCIA_M}', '${OBRAS}', true),
  ('0192c076-0000-7000-8000-0000000010e5', '${B}', '${ANA_B_M}', '${SETOR_Y}', true);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    if (!membership) return null;
    // Em B, a Ana é REQUISITANTE (cria o processo de B).
    return { ...membership, roleKeys: tenantId === B ? ['REQUISITANTE'] : (ROLES[userId] ?? []) };
  }
}

const words = (count: number) =>
  Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

describe('Feature: Dashboard operacional sobre PostgreSQL (US-076)', () => {
  let db: TestDatabase;
  let api: TestApi;
  const catalogs = new Map<string, { contractingType: string; origin: string }>();
  const processes = {
    plain: '',
    overdue: '',
    dueSoon: '',
    confidential: '',
    draft: '',
    foreign: '',
  };
  let stageId = '';

  const auth = (call: request.Test, user: string, tenantId: string = A) =>
    call
      .set('Authorization', api.bearer(SUBJECT[user] ?? user, { amr: MFA }))
      .set('X-Tenant-Id', tenantId);
  const get = (url: string, user = ANA, tenantId: string = A) =>
    auth(request(api.server).get(`/api/v1${url}`), user, tenantId);
  const summary = async (query = '', user = ANA) => {
    const response = await get(`/dashboard/summary${query}`, user);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return dashboardSummaryResponseSchema.parse(response.body);
  };
  const widget = async <K extends DashboardWidgetKey>(key: K, query = '', user = ANA) => {
    const response = await get(`/dashboard/widgets/${key}${query}`, user);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = dashboardWidgetResponseSchema.parse(response.body);
    return { data: body.data as DashboardWidgetOf<K>, meta: body.meta };
  };

  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };

  /** PRC-02: o criador fica responsável pela ABERTURA (visão "Comigo" de TSK-02). */
  async function createProcess(user: string, tenantId: string = A): Promise<ProcessDto> {
    const catalog = catalogs.get(tenantId);
    if (!catalog) throw new Error('catálogo ausente');
    const response = await auth(request(api.server).post('/api/v1/processes'), user, tenantId)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words(2)}`,
        object: `Objeto ${words(3)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: tenantId === A ? OBRAS : OBRAS_B,
        requestingDepartmentId: tenantId === A ? MANUTENCAO : SETOR_Y,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: ProcessDto }).data;
  }

  /** Coloca o processo "em andamento" com os campos que os indicadores leem. */
  async function shape(id: string, set: string): Promise<void> {
    await db.admin(
      `UPDATE processes SET status = 'IN_PROGRESS', opened_at = '2026-10-05T12:00:00Z',
              estimated_value_source = 'MANUAL', ${set}
        WHERE id = $1`,
      [id],
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
      DATABASE_POOL_SIZE: '10',
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
        { token: INBOX_CLOCK, value: () => NOW },
        { token: DASHBOARD_CLOCK, value: () => NOW },
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
    for (const tenantId of [A, B]) {
      await runTenantSeeders(api, tenantId, [
        'catalog.items',
        'catalog.holidays',
        'access.defaultRoles',
        'document.systemTypes',
        'workflow.seedWorkflows',
      ]);
      catalogs.set(tenantId, {
        contractingType: await catalogId(tenantId, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        origin: await catalogId(tenantId, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      });
    }

    // Obras: um comum (R$ 1.000,00), um atrasado e um a vencer (quarta, 21/10); um rascunho.
    processes.plain = (await createProcess(ELI)).id;
    await shape(
      processes.plain,
      "estimated_value = 1000.00, current_stage_due_at = '2026-11-30T02:59:59Z'",
    );
    processes.overdue = (await createProcess(ELI)).id;
    await shape(
      processes.overdue,
      "estimated_value = 2000.00, overdue_since = '2026-10-15T12:00:00Z'",
    );
    processes.dueSoon = (await createProcess(ELI)).id;
    await shape(processes.dueSoon, "current_stage_due_at = '2026-10-21T20:00:00Z'");
    processes.draft = (await createProcess(ELI)).id;
    await db.admin(`UPDATE processes SET status = 'DRAFT', opened_at = NULL WHERE id = $1`, [
      processes.draft,
    ]);
    // Saúde: sigiloso de R$ 500.000,00, sem concessão às unidades de Obras.
    processes.confidential = (await createProcess(ELI)).id;
    await shape(
      processes.confidential,
      `estimated_value = 500000.00, is_budget_confidential = true,
       requesting_secretariat_id = '${SAUDE}', requesting_department_id = '${VIGILANCIA}',
       current_department_id = '${VIGILANCIA}', current_responsible_id = NULL`,
    );
    await db.admin(
      `UPDATE process_access SET revoked_at = '2026-10-05T12:00:00Z'
        WHERE process_id = $1 AND principal_type = 'DEPARTMENT'`,
      [processes.confidential],
    );
    for (const [department, reason] of [
      [SAUDE, 'REQUESTING'],
      [VIGILANCIA, 'REQUESTING'],
      [VIGILANCIA, 'CURRENT'],
    ] as const) {
      await db.admin(
        `INSERT INTO process_access (id, tenant_id, process_id, principal_type, department_id, reason)
         VALUES ($1, $2, $3, 'DEPARTMENT', $4, $5)`,
        [randomUUID(), A, processes.confidential, department, reason],
      );
    }
    // Passagem concluída de 2 dias (AVG_STAGE_DURATION) e o mesmo em B (nunca deve contar).
    const [stage] = await db.admin<{ id: string; workflow_stage_id: string }>(
      'SELECT id, workflow_stage_id FROM process_stages WHERE process_id = $1',
      [processes.plain],
    );
    stageId = stage?.workflow_stage_id ?? '';
    await db.admin(
      `UPDATE process_stages SET entered_at = '2026-10-01T12:00:00Z', exited_at = '2026-10-03T12:00:00Z'
        WHERE id = $1`,
      [stage?.id],
    );
    // B: processo atrasado, com R$ 9.999,00, entrada recente e passagem concluída.
    processes.foreign = (await createProcess(ANA, B)).id;
    await db.admin(
      `UPDATE processes SET status = 'IN_PROGRESS', opened_at = '2026-10-06T12:00:00Z',
              estimated_value = 9999.00, estimated_value_source = 'MANUAL', overdue_since = '2026-10-10T12:00:00Z' WHERE id = $1;`,
      [processes.foreign],
    );
    await db.admin(
      `UPDATE process_stages SET entered_at = '2026-10-01T12:00:00Z', exited_at = '2026-10-02T12:00:00Z'
        WHERE process_id = $1`,
      [processes.foreign],
    );
    // Atividade recente: restrita do sigiloso, comum dele e uma de B (todas mais recentes).
    const entry = (
      id: string,
      tenantId: string,
      processId: string,
      at: string,
      visibility: string,
    ) =>
      db.admin(
        `INSERT INTO process_timeline_entries (id, tenant_id, process_id, occurred_at, type,
                                               actor_type, params, visibility, source_event_id)
         VALUES ($1, $2, $3, $4, 'PROCESS_UPDATED', 'SYSTEM', '{}'::jsonb,
                 $5::timeline_visibility, $6)`,
        [id, tenantId, processId, at, visibility, randomUUID()],
      );
    await entry(RESTRICTED, A, processes.confidential, '2026-10-20T14:58:00Z', 'BUDGET_RESTRICTED');
    await entry(STANDARD, A, processes.confidential, '2026-10-20T14:57:00Z', 'STANDARD');
    await entry(FOREIGN_ENTRY, B, processes.foreign, '2026-10-20T14:59:00Z', 'STANDARD');
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    api.app.get<InMemoryCacheStore>(CACHE_STORE).entries.clear();
  });

  it('[Sucesso] resumo e indicadores calculados no SQL, só com os processos visíveis do tenant', async () => {
    const body = await summary();
    expect(body.data).toMatchObject({ overdueCount: 1, dueSoonCount: 1, openCount: 4 });
    const byStatus = (await widget('BY_STATUS')).data;
    expect(byStatus.total).toBe(5);
    expect(byStatus.series.find((item) => item.key === 'DRAFT')?.value).toBe(1);
    expect((await widget('OVERDUE')).data.series).toEqual([
      { key: OBRAS, label: 'Secretaria de Obras', value: 1 },
    ]);
    expect((await widget('DUE_SOON')).data.total).toBe(1);
    expect((await widget('BY_STAGE')).data.total).toBe(4);
    expect((await widget('AVG_STAGE_DURATION')).data.series).toEqual([
      expect.objectContaining({ key: stageId, value: 2 * 86400, sampleSize: 1 }),
    ]);
    const opened = (await widget('OPENED_BY_MONTH')).data;
    expect(opened.series.at(-1)).toEqual({ key: '2026-10', label: null, value: 4 });
    expect(opened.total).toBe(4);
  });

  it('[Permissão] POL-09 no agregado: o sigiloso fica fora da soma e marca confidentialExcluded', async () => {
    const masked = (await widget('VALUE_BY_SECRETARIAT')).data.series;
    expect(masked).toEqual([
      { key: OBRAS, label: 'Secretaria de Obras', value: '3000.00', confidentialExcluded: false },
      { key: SAUDE, label: 'Secretaria de Saúde', value: '0.00', confidentialExcluded: true },
    ]);
    const full = (await widget('VALUE_BY_SECRETARIAT', '', LUCIA)).data.series;
    expect(full.find((item) => item.key === SAUDE)).toMatchObject({
      value: '500000.00',
      confidentialExcluded: false,
    });
  });

  it('[Permissão] RECENT_ACTIVITY omite BUDGET_RESTRICTED sem POL-09 e nunca traz entrada de B', async () => {
    const plain = (await widget('RECENT_ACTIVITY', '?limit=5')).data.items.map((item) => item.id);
    expect(plain[0]).toBe(STANDARD);
    expect(plain).not.toContain(RESTRICTED);
    expect(plain).not.toContain(FOREIGN_ENTRY);
    const allowed = (await widget('RECENT_ACTIVITY', '?limit=2', LUCIA)).data.items;
    expect(allowed.map((item) => item.id)).toEqual([RESTRICTED, STANDARD]);
    expect(allowed[0]?.process.id).toBe(processes.confidential);
  });

  it('[Concorrência] escopos diferentes em requisições simultâneas não misturam dados', async () => {
    const [ana, carla] = await Promise.all([
      get('/dashboard/summary', ANA),
      get('/dashboard/summary', CARLA),
    ]);
    // Ana: o tenant inteiro; Carla (lotada em Obras): só os de Obras — o da Saúde não.
    expect(dashboardSummaryResponseSchema.parse(ana.body).data.openCount).toBe(4);
    expect(dashboardSummaryResponseSchema.parse(carla.body).data.openCount).toBe(3);
  });

  it('[Sucesso] filtro pela unidade solicitante (com subárvore) e fora do escopo = vazio', async () => {
    expect((await summary(`?secretariatId=${SAUDE}`)).data.openCount).toBe(1);
    expect((await summary(`?departmentId=${OBRAS}`)).data.openCount).toBe(3);
    // FA-03: a Carla não vê a Saúde — zeros, nunca erro.
    expect((await summary(`?secretariatId=${SAUDE}`, CARLA)).data.openCount).toBe(0);
  });

  it('RN-DASH-03: PENDING_ITEMS e pendingCount conferem com TSK-02', async () => {
    const counters = await get('/tasks/counters', ELI);
    expect(counters.status, JSON.stringify(counters.body)).toBe(200);
    const tasks = taskInboxCountersResponseSchema.parse(counters.body).data;
    expect(tasks.mine).toBeGreaterThan(0);
    const { data } = await widget('PENDING_ITEMS', '', ELI);
    expect(data.series.find((item) => item.key === 'MINE')?.value).toBe(tasks.mine);
    expect(data.series.find((item) => item.key === 'OVERDUE')?.value).toBe(tasks.overdue);
    expect(data.total).toBe(tasks.mine + tasks.pendingApprovals);
    expect((await summary('', ELI)).data.pendingCount).toBe(data.total);
  });

  it('[Duplicidade] repetição dentro de 60 s: mesmos dados e cache.hit', async () => {
    const first = await widget('BY_STATUS');
    const second = await widget('BY_STATUS');
    expect(first.meta.cache.hit).toBe(false);
    expect(second.meta.cache.hit).toBe(true);
    expect(second.data).toEqual(first.data);
  });

  it('[Tenant incorreto] unidade de B no filtro → 422 REFERENCE_NOT_FOUND, igual à inexistente', async () => {
    const foreign = await get(`/dashboard/summary?departmentId=${SETOR_Y}`);
    expect(foreign.status).toBe(422);
    const body = problemDetailsSchema.parse(foreign.body);
    expect(body.errors).toEqual([
      expect.objectContaining({ field: 'departmentId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    const missing = problemDetailsSchema.parse(
      (await get(`/dashboard/widgets/BY_STATUS?secretariatId=${randomUUID()}`)).body,
    );
    expect(missing.errors[0]?.code).toBe('REFERENCE_NOT_FOUND');
    expect(JSON.stringify(foreign.body)).not.toContain('LEAK-B');
  });

  it('[Tenant incorreto] RLS das views v_dashboard_* com outro app.tenant_id retorna vazio', async () => {
    // Em B, o processo da Ana existe e aparece no painel de B.
    const inB = await get('/dashboard/summary', ANA, B);
    expect(inB.status, JSON.stringify(inB.body)).toBe(200);
    expect(dashboardSummaryResponseSchema.parse(inB.body).data.overdueCount).toBe(1);
    const client = db.client('cf_app');
    try {
      const seen = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM v_dashboard_processes WHERE tenant_id = ${A}::uuid
              UNION ALL SELECT process_id FROM v_dashboard_stage_passages WHERE tenant_id = ${A}::uuid
              UNION ALL SELECT id FROM v_dashboard_timeline WHERE tenant_id = ${A}::uuid`,
        ),
      );
      expect(seen).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });
});
