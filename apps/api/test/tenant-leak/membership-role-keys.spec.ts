// Chaves de perfil do vínculo com login real sobre PostgreSQL (spec-531 · permissions.md §1.3):
// perfis atribuídos pela ROL-11 chegam em `roleKeys` pelo repositório Prisma e os seis pontos que
// leem as chaves se comportam como no modo fake com as mesmas chaves — leitura em `OFFBOARDING`
// (pipeline e ME-04 · DEC-132), política de aprovação (RN-DOC-07), titular sem lotação (RN-TEN-48),
// aprovador por perfil no painel (contexto da requisição) e o job de geração de IA. As chaves nunca
// vêm de outro tenant: a mesma pessoa é ADMIN_ORGAO em B e só AUDITOR em A.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import type { ApprovalPolicy } from '@contrataflow/validation';
import { problemDetailsSchema } from '@contrataflow/validation';
import { Controller, Get, Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AccessFacade } from '#modules/access/application/access.facade.js';
import { AiGenerationJob } from '#modules/ai/application/ai-generation.job.js';
import type { AiGenerationProcessor } from '#modules/ai/application/ai-generation.processor.js';
import { ApprovalPolicyValidator } from '#modules/document/application/approval-policy.validator.js';
import { IdentityFacade } from '#modules/identity/application/identity.facade.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { DepartmentReferences } from '#modules/organization/application/department-references.js';
import { isDesignatedApprover } from '#modules/process/domain/process-summary.js';
import { TenantStatusCache } from '#modules/tenancy/infrastructure/tenant-status.cache.js';
import { ImplicitAccess } from '#shared/auth/authorization.js';
import { MEMBERSHIP_PORT, TENANT_STATUS_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, TenantStatusPort } from '#shared/auth/ports.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';

import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192d531-0000-7000-8000-00000000000a';
const B = '0192d531-0000-7000-8000-00000000000b';
const ANA = '0192d531-0000-7000-8000-0000000000a1';
const AUDREY = '0192d531-0000-7000-8000-0000000000a2';
const CICERO = '0192d531-0000-7000-8000-0000000000a3';
const GIL = '0192d531-0000-7000-8000-0000000000a4';
const DIEGO = '0192d531-0000-7000-8000-0000000000a5';
const M_ANA = '0192d531-0000-7000-8000-0000000001a1';
const M_AUDREY = '0192d531-0000-7000-8000-0000000001a2';
const M_CICERO = '0192d531-0000-7000-8000-0000000001a3';
const M_GIL = '0192d531-0000-7000-8000-0000000001a4';
const M_DIEGO = '0192d531-0000-7000-8000-0000000001a5';
const M_AUDREY_B = '0192d531-0000-7000-8000-0000000001b2';
const ORG_A = '0192d531-0000-7000-8000-0000000002a1';
const ORG_B = '0192d531-0000-7000-8000-0000000002b1';
const OBRAS = '0192d531-0000-7000-8000-0000000003a1';
const ADMIN_A = '0192d531-0000-7000-8000-0000000004a1';
const AUDITOR_A = '0192d531-0000-7000-8000-0000000004a2';
const CI_A = '0192d531-0000-7000-8000-0000000004a3';
const GESTOR_A = '0192d531-0000-7000-8000-0000000004a4';
const ADMIN_B = '0192d531-0000-7000-8000-0000000004b1';
const MFA = ['pwd', 'otp'];
const NOW = () => new Date();

const ADMIN_PERMISSIONS = ['ROLE_ASSIGN', 'ROLE_VIEW', 'USER_VIEW', 'USER_MANAGE', 'PROCESS_VIEW'];

const grants = (tenant: string, role: string, codes: readonly string[], prefix: string) =>
  codes
    .map(
      (code, index) =>
        `('0192d531-0000-7000-8000-${prefix}${String(index).padStart(4, '0')}', '${tenant}', '${role}', '${code}')`,
    )
    .join(',\n  ');

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-a-keys', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-keys', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana', 'ana@a.test', true, 'Ana Admin'),
  ('${AUDREY}', 'sub-audrey', 'audrey@a.test', true, 'Audrey Auditora'),
  ('${CICERO}', 'sub-cicero', 'cicero@a.test', true, 'Cícero Controle'),
  ('${GIL}', 'sub-gil', 'gil@a.test', true, 'Gil Gestor'),
  ('${DIEGO}', 'sub-diego', 'diego@a.test', true, 'Diego Sem Perfil');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${M_ANA}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${M_AUDREY}', '${A}', '${AUDREY}', 'INTERNAL', 'ACTIVE'),
  ('${M_CICERO}', '${A}', '${CICERO}', 'INTERNAL', 'ACTIVE'),
  ('${M_GIL}', '${A}', '${GIL}', 'INTERNAL', 'ACTIVE'),
  ('${M_DIEGO}', '${A}', '${DIEGO}', 'INTERNAL', 'ACTIVE'),
  ('${M_AUDREY_B}', '${B}', '${AUDREY}', 'INTERNAL', 'ACTIVE');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal', 'PMA', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', 'SECRETARIAT', 'Secretaria de Obras', '/${OBRAS}/', 0);
INSERT INTO roles (id, tenant_id, key, name, is_system) VALUES
  ('${ADMIN_A}', '${A}', 'ADMIN_ORGAO', 'Administrador do órgão', true),
  ('${AUDITOR_A}', '${A}', 'AUDITOR', 'Auditor', true),
  ('${CI_A}', '${A}', 'CONTROLE_INTERNO', 'Controle interno', true),
  ('${GESTOR_A}', '${A}', 'GESTOR_CONTRATACOES', 'Gestor de contratações', true),
  ('${ADMIN_B}', '${B}', 'ADMIN_ORGAO', 'Administrador LEAK-B', true);
INSERT INTO role_permissions (id, tenant_id, role_id, permission_code) VALUES
  ${grants(A, ADMIN_A, ADMIN_PERMISSIONS, '00005a00')},
  ${grants(A, AUDITOR_A, ['PROCESS_VIEW', 'AUDIT_VIEW'], '00005a01')},
  ${grants(A, CI_A, ['PROCESS_VIEW'], '00005a02')},
  ${grants(A, GESTOR_A, ['PROCESS_VIEW', 'APPROVAL_DECIDE', 'AI_GENERATE'], '00005a03')},
  ${grants(B, ADMIN_B, [...ADMIN_PERMISSIONS, 'APPROVAL_DECIDE', 'AI_GENERATE'], '00005b00')};
-- Só a administradora de A e o vínculo de Audrey em B nascem com atribuição; os perfis de A
-- chegam pela ROL-11 no primeiro cenário.
INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type, granted_by_id, valid_from) VALUES
  ('0192d531-0000-7000-8000-0000000006a1', '${A}', '${M_ANA}', '${ADMIN_A}', 'TENANT', '${ANA}', now() - interval '1 day'),
  ('0192d531-0000-7000-8000-0000000006b1', '${B}', '${M_AUDREY_B}', '${ADMIN_B}', 'TENANT', '${AUDREY}', now() - interval '1 day');
`;

/** Prova do contexto aberto pelo pipeline: o que o painel (POL-03) lê de `roleKeys`. */
@Controller('_test/membership-role-keys')
@TenantScope('TENANT')
class RoleKeysProbeController {
  @Get()
  @ImplicitAccess('Prova de teste: devolve as chaves de perfil do contexto (spec-531).')
  read() {
    return { roleKeys: requireRequestContext().roleKeys ?? [] };
  }
}

describe('Feature: chaves de perfil do vínculo com login real (spec-531)', () => {
  let db: TestDatabase;
  let api: TestApi;

  const as = (test: request.Test, subject: string, tenant: string | null = A) => {
    const authorized = test.set('Authorization', api.bearer(subject, { amr: MFA }));
    return tenant === null ? authorized : authorized.set('X-Tenant-Id', tenant);
  };
  const keysOf = async (subject: string, tenant = A) => {
    const response = await as(
      request(api.server).get('/api/v1/_test/membership-role-keys'),
      subject,
      tenant,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { data: { roleKeys: string[] } }).data.roleKeys;
  };
  const assign = (userId: string, roleId: string) =>
    as(request(api.server).post(`/api/v1/users/${userId}/role-assignments`), 'sub-ana').send({
      roleId,
      scopeType: 'TENANT',
    });
  const codeOf = (response: request.Response) => problemDetailsSchema.parse(response.body).code;
  const inTenant = <T>(tenantId: string, work: (tx: TenantTx) => Promise<T>) =>
    asTenant(tenantId, () => api.app.get(TenantTransaction, { strict: false }).read(work));
  const setTenantStatus = async (tenantId: string, status: 'ACTIVE' | 'OFFBOARDING') => {
    await db.admin(
      status === 'OFFBOARDING'
        ? `UPDATE tenants SET status = 'OFFBOARDING', offboarding_ends_at = now() + interval '90 days' WHERE id = '${tenantId}'`
        : `UPDATE tenants SET status = 'ACTIVE', offboarding_ends_at = NULL WHERE id = '${tenantId}'`,
    );
    await api.app.get(TenantStatusCache, { strict: false }).invalidate(tenantId);
  };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    const config = testConfig({
      OIDC_FAKE_SIGNING_KEY: '',
      DATABASE_URL: db.url('cf_app'),
      DATABASE_URL_PLATFORM: db.url('cf_platform'),
    });
    api = await createTestApi({
      config,
      controllers: [RoleKeysProbeController],
      providers: [
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
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] perfis atribuídos pela ROL-11 chegam no contexto da requisição (painel · POL-03)', async () => {
    expect(await keysOf('sub-gil')).toEqual([]);
    for (const [userId, roleId] of [
      [AUDREY, AUDITOR_A],
      [CICERO, CI_A],
      [GIL, GESTOR_A],
    ] as const) {
      const response = await assign(userId, roleId);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }
    expect(await keysOf('sub-audrey')).toEqual(['AUDITOR']);
    expect(await keysOf('sub-cicero')).toEqual(['CONTROLE_INTERNO']);
    const gilKeys = await keysOf('sub-gil');
    expect(gilKeys).toEqual(['GESTOR_CONTRATACOES']);

    // O painel marca o aprovador designado por perfil com as chaves do contexto.
    const approval = {
      approverType: 'ROLE' as const,
      approverUserId: null,
      approverRoleId: GESTOR_A,
      approverDepartmentId: null,
      allowDeputy: false,
    };
    const names = {
      roles: new Map([[GESTOR_A, { key: 'GESTOR_CONTRATACOES', name: 'Gestor de contratações' }]]),
    };
    const viewer = (userId: string, roleKeys: readonly string[]) => ({
      userId,
      headOfDepartmentIds: [],
      roleKeys,
    });
    expect(isDesignatedApprover(approval, viewer(GIL, gilKeys), names)).toBe(true);
    expect(isDesignatedApprover(approval, viewer(AUDREY, await keysOf('sub-audrey')), names)).toBe(
      false,
    );
  });

  it('[Tenant incorreto] as chaves nunca vêm de outro tenant: ADMIN_ORGAO em B não aparece em A', async () => {
    expect(await keysOf('sub-audrey', B)).toEqual(['ADMIN_ORGAO']);
    expect(await keysOf('sub-audrey', A)).toEqual(['AUDITOR']);
    // Fora do pipeline, a leitura dos membros no tenant da transação também só vê as de A.
    const [member] = await inTenant(A, (tx) =>
      api.app.get(IdentityFacade, { strict: false }).membersInTenant(tx, [AUDREY]),
    );
    expect(member).toMatchObject({ membershipId: M_AUDREY, roleKeys: ['AUDITOR'] });
  });

  it('[Estado inválido] OFFBOARDING: leitura só para AUDITOR atribuído; CONTROLE_INTERNO e comandos bloqueados (DEC-132)', async () => {
    await setTenantStatus(A, 'OFFBOARDING');
    try {
      const read = await as(request(api.server).get('/api/v1/me/permissions'), 'sub-audrey');
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      const command = await as(
        request(api.server).post(`/api/v1/users/${DIEGO}/role-assignments`),
        'sub-audrey',
      ).send({ roleId: AUDITOR_A, scopeType: 'TENANT' });
      expect(command.status).toBe(403);
      expect(codeOf(command)).toBe('TENANT_SUSPENDED');
      for (const subject of ['sub-cicero', 'sub-gil']) {
        const denied = await as(request(api.server).get('/api/v1/me/permissions'), subject);
        expect(denied.status, subject).toBe(403);
        expect(codeOf(denied)).toBe('TENANT_SUSPENDED');
      }

      // ME-04 (início de sessão): o mesmo veredito, sem contexto de tenant.
      const membershipsOf = async (subject: string) => {
        const response = await as(request(api.server).get('/api/v1/me/memberships'), subject, null);
        expect(response.status).toBe(200);
        return (
          response.body as {
            data: { tenant: { id: string }; usable: boolean; readOnly: boolean }[];
          }
        ).data.map((item) => [item.tenant.id, item.usable, item.readOnly]);
      };
      expect(await membershipsOf('sub-audrey')).toEqual([
        [A, true, true],
        [B, true, false],
      ]);
      expect(await membershipsOf('sub-cicero')).toEqual([[A, false, false]]);
    } finally {
      await setTenantStatus(A, 'ACTIVE');
    }
  });

  it('[Validação] política de aprovação: APPROVAL_DECIDE pela atribuição; concessões de B não contam em A', async () => {
    const validator = api.app.get(ApprovalPolicyValidator, { strict: false });
    const policyFor = (userId: string): ApprovalPolicy => ({
      approverType: 'USER',
      approverUserId: userId,
      allowDeputy: false,
    });
    await expect(
      inTenant(A, (tx) => validator.assertResolvable(tx, policyFor(GIL), NOW())),
    ).resolves.toBeUndefined();
    for (const userId of [AUDREY, DIEGO]) {
      const error = await inTenant(A, (tx) =>
        validator.assertResolvable(tx, policyFor(userId), NOW()),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).errors).toEqual([
        expect.objectContaining({
          field: 'approvalPolicy.approverUserId',
          code: 'REFERENCE_INACTIVE',
        }),
      ]);
    }
  });

  it('[Validação] titular sem lotação: aceito por perfil de escopo TENANT atribuído; sem perfil, não', async () => {
    const references = api.app.get(DepartmentReferences, { strict: false });
    const errorsOf = (userId: string) =>
      inTenant(A, (tx) =>
        references.staffErrors(tx, OBRAS, [{ field: 'headUserId', userId }], NOW()),
      );
    expect(await errorsOf(GIL)).toEqual([]);
    expect(await errorsOf(CICERO)).toEqual([]);
    expect(await errorsOf(DIEGO)).toEqual([
      expect.objectContaining({ field: 'headUserId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
  });

  it('[Sucesso] job de IA: o vínculo relido traz as chaves atribuídas e a permissão efetiva do solicitante', async () => {
    const seen: {
      roleKeys?: readonly string[] | undefined;
      requesterActive?: boolean | undefined;
      canGenerate?: boolean;
    } = {};
    const access = api.app.get(AccessFacade, { strict: false });
    const processor = {
      process: async (input: { readonly requesterActive?: boolean }) => {
        seen.roleKeys = requireRequestContext().roleKeys;
        seen.requesterActive = input.requesterActive;
        seen.canGenerate = (await access.effectivePermissions()).has('AI_GENERATE');
      },
    } as unknown as AiGenerationProcessor;
    const job = new AiGenerationJob(
      api.app.get<TenantStatusPort>(TENANT_STATUS_PORT, { strict: false }),
      api.app.get<MembershipPort>(MEMBERSHIP_PORT, { strict: false }),
      processor,
    );
    const outcome = await job.process({
      id: 'job-spec-531',
      queue: 'ai-generation',
      name: 'generate',
      attempt: 1,
      data: {
        meta: {
          schemaVersion: 1,
          tenantId: A,
          actor: { type: 'USER', userId: GIL, membershipId: M_GIL },
          correlationId: 'spec-531-ai-job',
          causationId: null,
          enqueuedAt: new Date().toISOString(),
        },
        payload: { generationId: '0192d531-0000-7000-8000-0000000007a1' },
      },
    });
    expect(outcome).toBe('completed');
    expect(seen).toEqual({
      roleKeys: ['GESTOR_CONTRATACOES'],
      requesterActive: true,
      canGenerate: true,
    });
  });
});
