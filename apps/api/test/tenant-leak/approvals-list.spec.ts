// Lista de aprovações sobre PostgreSQL real (US-057 · APV-01): a API inteira como `cf_app` (RLS de
// `approvals` e da view `security_invoker` `v_inbox_processes`) com os seeders reais do
// provisionamento. Prova a cobertura POL-03 como predicado SQL (direto, titular, substituto só com
// `allowDeputy`, perfil com escopo da secretaria solicitante; fora da cobertura nunca aparece), os
// filtros combinados (status + período + unidade), a aprovação coberta duas vezes aparecendo uma só,
// a decisão concorrente tirando o item de `PENDING` e o isolamento por tenant (mesma usuária com
// aprovação em outro tenant; a consulta com outro `app.tenant_id` não enxerga A).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { approvalListResponseSchema, problemDetailsSchema } from '@contrataflow/validation';
import type { ApprovalListResponse, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { APPROVAL_CLOCK } from '../../src/modules/approval/application/ports.js';
import { buildApprovalListPageSql } from '../../src/modules/approval/infrastructure/approval-list.sql.js';
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

const A = '0192c057-0000-7000-8000-00000000010a';
const B = '0192c057-0000-7000-8000-00000000010b';
const ORG_A = '0192c057-0000-7000-8000-0000000010a0';
const ORG_B = '0192c057-0000-7000-8000-0000000010b0';
const OBRAS = '0192c057-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c057-0000-7000-8000-0000000010a2';
const SAUDE = '0192c057-0000-7000-8000-0000000010a3';
const OBRAS_B = '0192c057-0000-7000-8000-0000000010b1';
const MANUTENCAO_B = '0192c057-0000-7000-8000-0000000010b2';
const BIA = '0192c057-0000-7000-8000-0000000010c1';
const DIEGO = '0192c057-0000-7000-8000-0000000010c2';
const ELI = '0192c057-0000-7000-8000-0000000010c3';
const RUI = '0192c057-0000-7000-8000-0000000010c4';
const CARLOS = '0192c057-0000-7000-8000-0000000010c5';
const BIA_M = '0192c057-0000-7000-8000-0000000010d1';
const RUI_M = '0192c057-0000-7000-8000-0000000010d4';
const BIA_B_M = '0192c057-0000-7000-8000-0000000010d6';
const NOW = new Date('2026-10-19T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [BIA]: ['REQUISITANTE'],
  [DIEGO]: ['REQUISITANTE'],
  [ELI]: ['REQUISITANTE'],
  [RUI]: ['REQUISITANTE'],
  [CARLOS]: ['REQUISITANTE'],
};

const SUBJECT: Readonly<Record<string, string>> = {
  [BIA]: 'sub-bia-us057',
  [DIEGO]: 'sub-diego-us057',
  [ELI]: 'sub-eli-us057',
  [RUI]: 'sub-rui-us057',
  [CARLOS]: 'sub-carlos-us057',
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

// Beatriz é titular de Obras (Diego, substituto); Carlos é titular da Saúde; Eli, lotado na
// Manutenção e na Saúde, solicita.
const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us057', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us057', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${BIA}', 'sub-bia-us057', 'bia@saojose.test', true, 'Beatriz Lima'),
  ('${DIEGO}', 'sub-diego-us057', 'diego@saojose.test', true, 'Diego Substituto'),
  ('${ELI}', 'sub-eli-us057', 'eli@saojose.test', true, 'Eli Matos'),
  ('${RUI}', 'sub-rui-us057', 'rui@saojose.test', true, 'Rui Prado'),
  ('${CARLOS}', 'sub-carlos-us057', 'carlos@saojose.test', true, 'Carlos Saúde');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id, deputy_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, '${BIA}', '${DIEGO}'),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL, NULL),
  ('${SAUDE}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Saúde', '${path(SAUDE)}', 0, '${CARLOS}', NULL),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0, NULL, NULL),
  ('${MANUTENCAO_B}', '${B}', '${ORG_B}', '${OBRAS_B}', 'SECTOR', 'Manutenção LEAK-B', '${path(OBRAS_B, MANUTENCAO_B)}', 1, NULL, NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${BIA_M}', '${A}', '${BIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c057-0000-7000-8000-0000000010d2', '${A}', '${DIEGO}', 'INTERNAL', 'ACTIVE'),
  ('0192c057-0000-7000-8000-0000000010d3', '${A}', '${ELI}', 'INTERNAL', 'ACTIVE'),
  ('${RUI_M}', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c057-0000-7000-8000-0000000010d5', '${A}', '${CARLOS}', 'INTERNAL', 'ACTIVE'),
  ('${BIA_B_M}', '${B}', '${BIA}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c057-0000-7000-8000-0000000010e1', '${A}', '0192c057-0000-7000-8000-0000000010d3', '${MANUTENCAO}', true),
  ('0192c057-0000-7000-8000-0000000010e3', '${A}', '0192c057-0000-7000-8000-0000000010d3', '${SAUDE}', false),
  ('0192c057-0000-7000-8000-0000000010e2', '${B}', '${BIA_B_M}', '${MANUTENCAO_B}', true);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

const words = (count: number) =>
  Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

interface Approver {
  readonly type: 'USER' | 'ROLE' | 'DEPARTMENT_HEAD';
  readonly userId?: string;
  readonly roleId?: string;
  readonly departmentId?: string;
  readonly allowDeputy?: boolean;
}

describe('Feature: Lista de aprovações sobre PostgreSQL (US-057)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let authorityRoleId = '';
  const catalogs = new Map<string, { contractingType: string; origin: string }>();

  const auth = (call: request.Test, user: string, tenantId: string = A) =>
    call
      .set('Authorization', api.bearer(SUBJECT[user] ?? user, { amr: MFA }))
      .set('X-Tenant-Id', tenantId);
  const get = (query: string, user = BIA, tenantId: string = A) =>
    auth(request(api.server).get(`/api/v1/approvals${query}`), user, tenantId);
  const list = async (
    query = '',
    user = BIA,
    tenantId: string = A,
  ): Promise<ApprovalListResponse> => {
    const response = await get(query, user, tenantId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return approvalListResponseSchema.parse(response.body);
  };
  const ids = (body: ApprovalListResponse) => body.data.map((item) => item.id);

  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };

  /** PRC-02 (Eli em A, Beatriz em B): processo na ABERTURA com a passagem ativa. */
  async function createProcess(
    user: string,
    tenantId: string = A,
    secretariatId: string = OBRAS,
    departmentId: string = MANUTENCAO,
  ): Promise<ProcessDto> {
    const catalog = catalogs.get(tenantId);
    if (!catalog) throw new Error('catálogo ausente');
    const response = await auth(request(api.server).post('/api/v1/processes'), user, tenantId)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words(2)}`,
        object: `Objeto ${words(3)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: secretariatId,
        requestingDepartmentId: departmentId,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: ProcessDto }).data;
  }

  /**
   * Aprovação da passagem ativa de um processo novo (como a US-051 grava); uma pendente por
   * passagem (`approvals_pending_stage_key`), então um processo por aprovação.
   */
  async function approvalOn(
    approver: Approver,
    options: {
      readonly secretariatId?: string;
      readonly requestedAt?: string;
      readonly tenantId?: string;
      readonly requester?: string;
    } = {},
  ): Promise<{ readonly id: string; readonly process: ProcessDto }> {
    const tenantId = options.tenantId ?? A;
    const process =
      tenantId === A
        ? await createProcess(
            options.requester ?? ELI,
            A,
            options.secretariatId ?? OBRAS,
            options.secretariatId === SAUDE ? SAUDE : MANUTENCAO,
          )
        : await createProcess(BIA, B, OBRAS_B, MANUTENCAO_B);
    const id = randomUUID();
    await db.admin(
      `INSERT INTO approvals (id, tenant_id, process_id, subject_type, process_stage_id, title,
                              requested_by_id, requested_at, approver_type, approver_user_id,
                              approver_role_id, approver_department_id, allow_deputy, due_at)
       VALUES ($1, $2, $3, 'PROCESS_STAGE', $4, 'Aprovação do DFD', $5, $6::timestamptz,
               $7::approver_type, $8, $9, $10, $11, '2026-10-18T02:59:59Z')`,
      [
        id,
        tenantId,
        process.id,
        process.currentStage?.id,
        tenantId === A ? ELI : BIA,
        options.requestedAt ?? '2026-10-12T12:00:00Z',
        approver.type,
        approver.userId ?? null,
        approver.roleId ?? null,
        approver.departmentId ?? null,
        approver.allowDeputy ?? false,
      ],
    );
    return { id, process };
  }

  const decideBySql = (approvalId: string, status: 'APPROVED' | 'REJECTED', by: string) =>
    db.admin(
      `UPDATE approvals SET status = $2::approval_status, decision = $3::approval_decision,
              decided_by_id = $4, decided_at = '2026-10-19T14:00:00Z', version = version + 1
        WHERE id = $1`,
      [approvalId, status, status === 'APPROVED' ? 'APPROVE' : 'REJECT', by],
    );

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
        { token: APPROVAL_CLOCK, value: () => NOW },
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
    // Rui decide por perfil: AUTORIDADE_COMPETENTE com escopo só na Secretaria de Obras (US-096).
    const [authority] = await db.admin<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND key = 'AUTORIDADE_COMPETENTE'",
      [A],
    );
    if (!authority) throw new Error('perfil AUTORIDADE_COMPETENTE ausente');
    authorityRoleId = authority.id;
    await db.admin(
      `INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type,
                                     scope_department_id, include_subtree, valid_from, granted_by_id)
       VALUES ($1, $2, $3, $4, 'DEPARTMENT', $5, true, '2026-01-01T00:00:00Z', $6)`,
      [randomUUID(), A, RUI_M, authorityRoleId, OBRAS, BIA],
    );
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso]/[Permissão] cobertura POL-03 como filtro: titular, substituto com allowDeputy, direto e perfil com escopo', async () => {
    const asHead = await approvalOn({ type: 'DEPARTMENT_HEAD', departmentId: OBRAS });
    const deputyAllowed = await approvalOn({
      type: 'DEPARTMENT_HEAD',
      departmentId: OBRAS,
      allowDeputy: true,
    });
    const otherSecretariat = await approvalOn(
      { type: 'DEPARTMENT_HEAD', departmentId: SAUDE },
      { secretariatId: SAUDE },
    );
    const direct = await approvalOn({ type: 'USER', userId: BIA });
    const directOther = await approvalOn({ type: 'USER', userId: CARLOS });
    const byRole = await approvalOn({ type: 'ROLE', roleId: authorityRoleId });
    const byRoleOutOfScope = await approvalOn(
      { type: 'ROLE', roleId: authorityRoleId },
      { secretariatId: SAUDE },
    );

    const bia = await list('?pageSize=100');
    expect(ids(bia).sort()).toEqual([asHead.id, deputyAllowed.id, direct.id].sort());
    expect(ids(bia)).not.toContain(otherSecretariat.id);
    expect(bia.data.find((item) => item.id === asHead.id)).toMatchObject({
      subjectType: 'PROCESS_STAGE',
      title: 'Aprovação do DFD',
      status: 'PENDING',
      process: { id: asHead.process.id, code: asHead.process.code },
      document: null,
      requestingDepartment: { id: MANUTENCAO, name: 'Setor de Manutenção' },
      requestedBy: { id: ELI, name: 'Eli Matos' },
      requestedAt: '2026-10-12T12:00:00.000Z',
      dueAt: '2026-10-18T02:59:59.000Z',
      isOverdue: true,
      approver: { type: 'DEPARTMENT_HEAD', label: 'Titular da Secretaria de Obras' },
    });
    // Diego (substituto) só vê a que permite substituto.
    expect(ids(await list('?pageSize=100', DIEGO))).toEqual([deputyAllowed.id]);
    const rui = await list('?pageSize=100', RUI);
    expect(ids(rui)).toEqual([byRole.id]);
    expect(rui.data[0]?.approver).toEqual({
      type: 'ROLE',
      label: 'Aguardando: qualquer titular de Autoridade competente',
    });
    const carlos = ids(await list('?pageSize=100', CARLOS));
    expect(carlos.sort()).toEqual([otherSecretariat.id, directOther.id].sort());
    expect(carlos).not.toContain(byRoleOutOfScope.id);
    // Eli (solicitante, sem cobertura): lista vazia, nunca 403.
    expect((await list('?pageSize=100', ELI)).data).toEqual([]);
  });

  it('[Sucesso] filtros combinados (status + período + unidade) e ordenação por código', async () => {
    const early = await approvalOn(
      { type: 'USER', userId: BIA },
      { requestedAt: '2026-09-02T12:00:00Z' },
    );
    const late = await approvalOn(
      { type: 'USER', userId: BIA },
      { requestedAt: '2026-09-20T12:00:00Z' },
    );
    const decided = await approvalOn(
      { type: 'USER', userId: BIA },
      { requestedAt: '2026-09-05T12:00:00Z' },
    );
    await decideBySql(decided.id, 'APPROVED', BIA);
    const saude = await approvalOn(
      { type: 'USER', userId: BIA },
      { requestedAt: '2026-09-06T12:00:00Z', secretariatId: SAUDE },
    );
    const period = 'requestedFrom=2026-09-01&requestedTo=2026-09-10';
    expect(ids(await list(`?${period}`)).sort()).toEqual([early.id, saude.id].sort());
    expect(
      ids(await list(`?${period}&status=PENDING,APPROVED&requestingDepartmentId=${OBRAS}`)).sort(),
    ).toEqual([early.id, decided.id].sort());
    expect(ids(await list(`?${period}&requestingDepartmentId=${SAUDE}`))).toEqual([saude.id]);
    expect(ids(await list(`?status=APPROVED&${period}`))).toEqual([decided.id]);
    expect(ids(await list('?requestedFrom=2026-09-15&requestedTo=2026-09-30'))).toEqual([late.id]);
    // Busca pelo código do processo.
    const code = late.process.code ?? '';
    expect(ids(await list(`?q=${encodeURIComponent(code)}`))).toEqual([late.id]);
    const sorted = (
      await list('?requestedFrom=2026-09-01&requestedTo=2026-09-30&sort=code')
    ).data.map((item) => item.process.code);
    expect(sorted).toEqual([...sorted].sort());
  });

  it('[Validação] unidade de outro tenant → 422 REFERENCE_NOT_FOUND; período invertido → 422', async () => {
    const foreign = await get(`?requestingDepartmentId=${OBRAS_B}`);
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(422);
    expect(problemDetailsSchema.parse(foreign.body).errors[0]).toMatchObject({
      field: 'requestingDepartmentId',
      code: 'REFERENCE_NOT_FOUND',
    });
    const inverted = await get('?requestedFrom=2026-10-10&requestedTo=2026-10-01');
    expect(inverted.status).toBe(422);
  });

  it('[Duplicidade] coberta por titularidade e por duas atribuições de perfil: aparece uma vez', async () => {
    for (const scope of [
      { type: 'ORGANIZATION', org: ORG_A, department: null },
      { type: 'DEPARTMENT', org: null, department: OBRAS },
    ]) {
      await db.admin(
        `INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type,
                                       scope_organization_id, scope_department_id, include_subtree,
                                       valid_from, granted_by_id)
         VALUES ($1, $2, $3, $4, $5::scope_type, $6, $7, true, '2026-01-01T00:00:00Z', $8)`,
        [randomUUID(), A, BIA_M, authorityRoleId, scope.type, scope.org, scope.department, RUI],
      );
    }
    try {
      const byRole = await approvalOn(
        { type: 'ROLE', roleId: authorityRoleId },
        { requestedAt: '2026-08-10T12:00:00Z' },
      );
      const body = await list('?requestedFrom=2026-08-01&requestedTo=2026-08-31');
      expect(ids(body)).toEqual([byRole.id]);
      expect(body.meta.totalItems).toBe(1);
    } finally {
      await db.admin('DELETE FROM role_assignments WHERE membership_id = $1', [BIA_M]);
    }
  });

  it('[Concorrência] decidida pelo substituto enquanto a lista está aberta: some de PENDING', async () => {
    const pending = await approvalOn(
      { type: 'DEPARTMENT_HEAD', departmentId: OBRAS, allowDeputy: true },
      { requestedAt: '2026-07-10T12:00:00Z' },
    );
    const july = 'requestedFrom=2026-07-01&requestedTo=2026-07-31';
    expect(ids(await list(`?${july}`))).toEqual([pending.id]);
    await decideBySql(pending.id, 'APPROVED', DIEGO);
    expect(ids(await list(`?${july}`))).toEqual([]);
    expect(ids(await list(`?${july}&status=APPROVED`))).toEqual([pending.id]);
    expect(ids(await list(`?${july}&status=APPROVED`, DIEGO))).toEqual([pending.id]);
  });

  it('[Tenant incorreto] aprovação da mesma usuária em outro tenant nunca aparece; RLS isola a consulta', async () => {
    const foreign = await approvalOn({ type: 'USER', userId: BIA }, { tenantId: B });
    // Em B, a aprovação é da Beatriz (prova que a linha existe).
    expect(ids(await list('?pageSize=100', BIA, B))).toEqual([foreign.id]);
    const inA = await list('?pageSize=100&status=PENDING,APPROVED,RETURNED,REJECTED,CANCELED');
    expect(ids(inA)).not.toContain(foreign.id);
    expect(JSON.stringify(inA)).not.toContain('LEAK-B');
    // A consulta da APV-01 com a cobertura de A, mas com `app.tenant_id` = B: nada de A.
    const client = db.client('cf_app');
    try {
      const seen = await asTenant(B, () =>
        client.$tenantTransaction((tx) =>
          tx.$queryRaw<{ id: string | null; tenant_id: string | null }[]>(
            buildApprovalListPageSql({
              coverage: { userId: BIA, headOf: [OBRAS], deputyOf: [], roles: [] },
              criteria: {
                statuses: ['PENDING', 'APPROVED'],
                subjectType: null,
                requestingDepartmentId: null,
                requestedFrom: null,
                requestedTo: null,
                q: null,
                timezone: 'America/Sao_Paulo',
              },
              sort: { field: 'requestedAt', direction: 'desc' },
              page: 1,
              pageSize: 100,
            }),
          ),
        ),
      );
      expect(seen.filter((row) => row.id !== null).map((row) => row.tenant_id)).toEqual([B]);
    } finally {
      await client.$disconnect();
    }
  });
});
