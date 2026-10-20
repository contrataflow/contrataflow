// Timeline do processo sobre PostgreSQL real (US-060 · PRC-12): a API inteira como `cf_app` (RLS)
// com os seeders do provisionamento e processos/entradas inseridos pelo superusuário. Prova o SQL
// de `PrismaTimelineEntryStore.list`: ordem `occurred_at DESC, id DESC` (empates), filtros por
// grupo, autor e período combinados, POL-09 no WHERE (paginação só do visível; permissão e
// custódia), cursor estável sob inserções concorrentes, processo de outro tenant → 404 sem revelar
// nada, cursor forjado com posição de B sem efeito e RLS de process_timeline_entries com outro
// `app.tenant_id`. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { problemDetailsSchema, processTimelineResponseSchema } from '@contrataflow/validation';
import type { ProcessTimelineResponse } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
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

const id = (suffix: string) => `0192c060-0000-7000-8000-${suffix.padStart(12, '0')}`;
const A = id('a');
const B = id('b');
const ORG_A = id('a0');
const ORG_B = id('b0');
const OBRAS = id('a1');
const MANUTENCAO = id('a2');
const COTACOES = id('a3');
const OBRAS_B = id('b1');
const SETOR_X = id('b2');
const ANA = id('c1');
const LUCIA = id('c2');
const CARLOS = id('c3');
const BETO = id('c4');
/** 0012: sigiloso, na fila do Setor de Cotações — Ana vê pela unidade solicitante, sem custódia. */
const P12 = id('12');
/** 0031: sigiloso, Ana é a responsável atual (custódia). */
const P31 = id('31');
/** 0040: processo das inserções concorrentes. */
const P40 = id('40');
const P_B = id('bf');
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [CARLOS]: [],
  [BETO]: ['GESTOR_CONTRATACOES'],
};
const SUBJECTS = {
  ana: 'sub-ana-us060',
  lucia: 'sub-lucia-us060',
  carlos: 'sub-carlos-us060',
  beto: 'sub-beto-us060',
} as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us060', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us060', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${COTACOES}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Cotações', '${path(OBRAS, COTACOES)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0),
  ('${SETOR_X}', '${B}', '${ORG_B}', '${OBRAS_B}', 'SECTOR', 'Setor X LEAK-B', '${path(OBRAS_B, SETOR_X)}', 1);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana@us060.test', true, 'Ana Souza'),
  ('${LUCIA}', '${SUBJECTS.lucia}', 'lucia@us060.test', true, 'Lúcia Matos'),
  ('${CARLOS}', '${SUBJECTS.carlos}', 'carlos@us060.test', true, 'Carlos Lima'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status, expires_at) VALUES
  ('${id('d1')}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE', NULL),
  ('${id('d2')}', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE', NULL),
  ('${id('d3')}', '${A}', '${CARLOS}', 'INTERNAL', 'ACTIVE', NULL),
  ('${id('d4')}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE', NULL);
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

interface SeedEntry {
  readonly processId: string;
  readonly occurredAt: string;
  readonly type: string;
  readonly actorId?: string | null;
  readonly actorName?: string | null;
  readonly visibility?: 'STANDARD' | 'BUDGET_RESTRICTED';
  readonly params?: Record<string, unknown>;
  readonly tenantId?: string;
}

describe('Feature: Visualizar timeline com filtros sobre PostgreSQL (US-060)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let counter = 0;
  /** Ids das entradas do 0012, por rótulo. */
  const P12_ENTRIES = new Map<string, string>();

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const get = (processId: string, query = '', subject: string = SUBJECTS.ana) =>
    request(api.server)
      .get(`/api/v1/processes/${processId}/timeline${query}`)
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const list = async (
    processId: string,
    query = '',
    subject: string = SUBJECTS.ana,
  ): Promise<ProcessTimelineResponse> => {
    const response = await get(processId, query, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return processTimelineResponseSchema.parse(response.body);
  };
  const ids = (body: ProcessTimelineResponse) => body.data.map((entry) => entry.id);
  const expectProblem = (response: request.Response, status: number, code: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    expect(problemDetailsSchema.parse(response.body).code).toBe(code);
  };
  /** Todas as páginas, seguindo o cursor. */
  const allPages = async (processId: string, query: string, subject?: string) => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ProcessTimelineResponse = await list(
        processId,
        `${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        subject,
      );
      seen.push(...ids(page));
      cursor = page.meta.nextCursor;
    } while (cursor !== null);
    return seen;
  };

  async function insertProcess(process: {
    readonly id: string;
    readonly number: number;
    readonly current: string;
    readonly responsible?: string | null;
    readonly tenantId?: string;
    readonly organizationId?: string;
    readonly secretariat?: string;
    readonly department?: string;
    readonly title?: string;
  }): Promise<void> {
    const tenantId = process.tenantId ?? A;
    await db.admin(
      `INSERT INTO processes (
         id, tenant_id, organization_id, number, year, code, title, object, contracting_type_id,
         requesting_secretariat_id, requesting_department_id, current_department_id,
         current_responsible_id, priority, status, workflow_version_id, current_workflow_stage_id,
         estimated_value, estimated_value_source, is_budget_confidential, origin_id, pca_status,
         created_by_id, created_at, updated_at)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::int, 2026, lpad($4::int::text, 4, '0') || '/2026', $5,
              'Objeto do processo de teste.',
              (SELECT id FROM catalog_items WHERE tenant_id = $2 AND catalog_type = 'CONTRACTING_TYPE' AND code = 'AQUISICAO_BENS'),
              $6::uuid, $7::uuid, $8::uuid, $9::uuid, 'HIGH'::priority, 'IN_PROGRESS'::process_status,
              s.workflow_version_id, s.id, 85000.00, 'MANUAL'::estimated_value_source, true,
              (SELECT id FROM catalog_items WHERE tenant_id = $2 AND catalog_type = 'PROCESS_ORIGIN' AND code = 'DEMANDA_NAO_PREVISTA'),
              'NOT_APPLICABLE', $10::uuid, '2026-09-14T13:02:11Z', '2026-10-02T18:40:00Z'
         FROM workflow_stages s
         JOIN workflow_versions v ON v.id = s.workflow_version_id AND v.status = 'PUBLISHED'
        WHERE s.tenant_id = $2::uuid AND s.key = 'ABERTURA'
        LIMIT 1`,
      [
        process.id,
        tenantId,
        process.organizationId ?? ORG_A,
        process.number,
        process.title ?? `Processo ${process.number}`,
        process.secretariat ?? OBRAS,
        process.department ?? MANUTENCAO,
        process.current,
        process.responsible ?? null,
        tenantId === A ? ANA : BETO,
      ],
    );
  }

  async function grant(processId: string, department: string, reason: string, tenantId = A) {
    counter += 1;
    await db.admin(
      `INSERT INTO process_access (id, tenant_id, process_id, principal_type, department_id, reason)
       VALUES ($1, $2, $3, 'DEPARTMENT', $4, $5::process_access_reason)`,
      [id(`ac${counter}`), tenantId, processId, department, reason],
    );
  }

  /** Entrada como o projetor (US-059) grava; id crescente na ordem de inserção. */
  async function insertEntry(entry: SeedEntry): Promise<string> {
    counter += 1;
    const entryId = id(`e${counter.toString(16).padStart(6, '0')}`);
    const system = entry.actorId === null;
    await db.admin(
      `INSERT INTO process_timeline_entries (
         id, tenant_id, process_id, occurred_at, type, actor_type, actor_id, actor_name,
         entity_type, entity_id, params, visibility, source_event_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5, $6::actor_type, $7::uuid, $8,
               'Process', $3::uuid, $9::jsonb, $10::timeline_visibility, gen_random_uuid())`,
      [
        entryId,
        entry.tenantId ?? A,
        entry.processId,
        entry.occurredAt,
        entry.type,
        system ? 'SYSTEM' : 'USER',
        system ? null : (entry.actorId ?? CARLOS),
        system ? null : (entry.actorName ?? 'Carlos Lima'),
        JSON.stringify(entry.params ?? {}),
        entry.visibility ?? 'STANDARD',
      ],
    );
    return entryId;
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

    await insertProcess({ id: P12, number: 12, current: COTACOES });
    await grant(P12, MANUTENCAO, 'REQUESTING');
    await grant(P12, COTACOES, 'CURRENT');
    await insertProcess({ id: P31, number: 31, current: MANUTENCAO, responsible: ANA });
    await grant(P31, MANUTENCAO, 'REQUESTING');
    await insertProcess({ id: P40, number: 40, current: MANUTENCAO });
    await grant(P40, MANUTENCAO, 'REQUESTING');
    await insertProcess({
      id: P_B,
      number: 7,
      current: SETOR_X,
      tenantId: B,
      organizationId: ORG_B,
      secretariat: OBRAS_B,
      department: SETOR_X,
      title: 'Processo LEAK-B',
    });
    await grant(P_B, SETOR_X, 'CURRENT', B);

    const seed: [string, SeedEntry][] = [
      [
        'created',
        {
          processId: P12,
          occurredAt: '2026-09-14T13:02:11Z',
          type: 'PROCESS_CREATED',
          actorId: ANA,
          actorName: 'Ana Souza',
          params: { code: '0012/2026' },
        },
      ],
      [
        'approvalOld',
        {
          processId: P12,
          occurredAt: '2026-09-20T10:00:00Z',
          type: 'APPROVAL_DECIDED',
          params: { decision: 'APPROVED', title: 'DFD' },
        },
      ],
      [
        'requested',
        {
          processId: P12,
          occurredAt: '2026-09-30T11:00:00Z',
          type: 'APPROVAL_REQUESTED',
          actorId: null,
        },
      ],
      [
        'approvalA',
        {
          processId: P12,
          occurredAt: '2026-10-01T09:00:00Z',
          type: 'APPROVAL_DECIDED',
          params: { decision: 'RETURNED', title: 'ETP' },
        },
      ],
      [
        'forwarded',
        { processId: P12, occurredAt: '2026-10-03T08:00:00Z', type: 'PROCESS_FORWARDED' },
      ],
      [
        'restricted',
        {
          processId: P12,
          occurredAt: '2026-10-04T12:00:00Z',
          type: 'PROCESS_UPDATED',
          visibility: 'BUDGET_RESTRICTED',
          params: { fields: ['estimatedValue'] },
        },
      ],
      [
        'tie1',
        {
          processId: P12,
          occurredAt: '2026-10-05T14:00:00Z',
          type: 'COMMENT_ADDED',
          params: { excerpt: 'Conferir.' },
        },
      ],
      [
        'tie2',
        {
          processId: P12,
          occurredAt: '2026-10-05T14:00:00Z',
          type: 'APPROVAL_DECIDED',
          params: { decision: 'APPROVED', title: 'TR' },
        },
      ],
      [
        'custody',
        {
          processId: P31,
          occurredAt: '2026-10-04T12:00:00Z',
          type: 'PROCESS_UPDATED',
          visibility: 'BUDGET_RESTRICTED',
        },
      ],
      [
        'leak',
        {
          processId: P_B,
          occurredAt: '2026-10-04T12:00:00Z',
          type: 'PROCESS_CREATED',
          tenantId: B,
          actorId: BETO,
          actorName: 'Beto LEAK-B',
          params: { code: '0007/2026' },
        },
      ],
    ];
    for (const [label, entry] of seed) P12_ENTRIES.set(label, await insertEntry(entry));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
    await db.stop();
  });

  const entry = (label: string) => P12_ENTRIES.get(label) ?? '';

  it('[Sucesso] ordem occurred_at DESC, id DESC (empate pelo id) e sem a entrada restrita para Ana', async () => {
    const body = await list(P12);
    expect(ids(body)).toEqual([
      entry('tie2'),
      entry('tie1'),
      entry('forwarded'),
      entry('approvalA'),
      entry('requested'),
      entry('approvalOld'),
      entry('created'),
    ]);
    expect(body.meta).toEqual({ nextCursor: null, hasMore: false });
    expect(body.data.find((item) => item.type === 'APPROVAL_REQUESTED')).toMatchObject({
      actorType: 'SYSTEM',
      actorId: null,
      actorName: null,
    });
  });

  it('[Sucesso] grupo + autor + período combinados por E; o cursor continua no mesmo filtro', async () => {
    const filter = `?group=APROVACOES&actorId=${CARLOS}&occurredFrom=2026-09-28T15:00:00Z&occurredTo=2026-10-05T15:00:00Z`;
    expect(ids(await list(P12, filter))).toEqual([entry('tie2'), entry('approvalA')]);
    expect(await allPages(P12, `${filter}&limit=1`)).toEqual([entry('tie2'), entry('approvalA')]);
    expect(ids(await list(P12, '?group=TRAMITACAO,COMENTARIOS'))).toEqual([
      entry('tie1'),
      entry('forwarded'),
    ]);
    expect(
      ids(await list(P12, '?occurredFrom=2026-10-03T08:00:00Z&occurredTo=2026-10-03T08:00:00Z')),
    ).toEqual([entry('forwarded')]);
  });

  it('[Validação] período invertido → 422 OUT_OF_RANGE em occurredTo', async () => {
    const response = await get(
      P12,
      '?occurredFrom=2026-10-05T00:00:00Z&occurredTo=2026-10-01T00:00:00Z',
    );
    expectProblem(response, 422, 'VALIDATION_ERROR');
    expect(problemDetailsSchema.parse(response.body).errors).toEqual([
      expect.objectContaining({ field: 'occurredTo', code: 'OUT_OF_RANGE' }),
    ]);
  });

  it('[Permissão] POL-09 no WHERE: paginação só do visível; permissão e custódia veem a restrita', async () => {
    const visible = await allPages(P12, '?limit=2');
    expect(visible).toHaveLength(7);
    expect(visible).not.toContain(entry('restricted'));
    const exact = await list(P12, '?limit=7');
    expect(exact.meta).toEqual({ nextCursor: null, hasMore: false });

    const withPolicy = await allPages(P12, '?limit=3', SUBJECTS.lucia);
    expect(withPolicy).toHaveLength(8);
    expect(withPolicy).toContain(entry('restricted'));

    expect(ids(await list(P31))).toEqual([entry('custody')]);
  });

  it('[Permissão] sem PROCESS_VIEW → 404 PROCESS_NOT_FOUND e access.denied auditado', async () => {
    expectProblem(await get(P12, '', SUBJECTS.carlos), 404, 'PROCESS_NOT_FOUND');
    const audits = await db.admin<{ reason_code: string | null; result: string }>(
      "SELECT reason_code, result FROM audit_logs WHERE tenant_id = $1 AND action = 'access.denied' AND actor_user_id = $2",
      [A, CARLOS],
    );
    expect(audits.length).toBeGreaterThan(0);
  });

  it('[Tenant incorreto] processo de B → 404 sem revelar; cursor forjado com posição de B não vaza; RLS isola', async () => {
    const response = await get(P_B);
    expectProblem(response, 404, 'PROCESS_NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain('LEAK-B');

    // Cursor com a posição da entrada de B: só filtra o processo de A, nada de B aparece.
    const forged = Buffer.from(
      JSON.stringify({ o: '2026-10-04T12:00:00.000Z', i: entry('leak') }),
    ).toString('base64url');
    const page = await list(P12, `?cursor=${forged}`);
    expect(JSON.stringify(page)).not.toContain('LEAK-B');
    expect(ids(page)).not.toContain(entry('leak'));

    // B só vê o próprio processo.
    expect(ids(await list(P_B, '', SUBJECTS.beto))).toEqual([entry('leak')]);

    const client = db.client('cf_app');
    try {
      const seen = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM process_timeline_entries WHERE process_id = ${P12}::uuid`,
        ),
      );
      expect(seen).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });

  it('[Duplicidade] a mesma página repetida devolve o mesmo resultado e o mesmo nextCursor', async () => {
    const first = await list(P12, '?limit=3');
    expect(await list(P12, '?limit=3')).toEqual(first);
    const next = await list(
      P12,
      `?limit=3&cursor=${encodeURIComponent(first.meta.nextCursor ?? '')}`,
    );
    expect(ids(next).filter((item) => ids(first).includes(item))).toEqual([]);
  });

  it('[Concorrência] inserções do projetor durante a rolagem não repetem nem perdem entradas', async () => {
    const original: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const minute = String(index).padStart(2, '0');
      original.unshift(
        await insertEntry({
          processId: P40,
          occurredAt: `2026-10-04T10:${minute}:00Z`,
          type: 'PROCESS_FORWARDED',
        }),
      );
    }
    const first = await list(P40, '?limit=5');
    const seen = [...ids(first)];
    let cursor = first.meta.nextCursor;
    const fresh: string[] = [];
    while (cursor !== null) {
      // Nova entrada projetada (mais recente) concorrendo com a leitura da próxima página.
      const [page, inserted] = await Promise.all([
        list(P40, `?limit=5&cursor=${encodeURIComponent(cursor)}`),
        insertEntry({
          processId: P40,
          occurredAt: '2026-10-05T14:30:00Z',
          type: 'PROCESS_CLAIMED',
        }),
      ]);
      fresh.push(inserted);
      seen.push(...ids(page));
      cursor = page.meta.nextCursor;
    }
    expect(seen).toEqual(original);
    const restart = ids(await list(P40, '?limit=50'));
    expect(restart.slice(0, fresh.length).sort()).toEqual([...fresh].sort());
    expect(restart.slice(fresh.length)).toEqual(original);
  });
});
