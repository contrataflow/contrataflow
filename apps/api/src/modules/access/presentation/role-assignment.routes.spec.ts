import type { PermissionCode } from '@contrataflow/types';
import {
  problemDetailsSchema,
  roleAssignmentListMetaSchema,
  roleAssignmentSchema,
} from '@contrataflow/validation';
import type { RoleAssignmentDto, RoleAssignmentListMeta } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { CacheStore } from '#shared/cache/cache-store.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  assignRole,
  roleAssignmentsOf,
  seedDefaultRolesOf,
  seedDepartment,
  seedOrganizations,
} from '../../../../test/support/structure-fixtures.js';
import { ACCESS_CLOCK } from '../application/ports.js';
import { createRole } from '../domain/role-management.js';
import { grantPermission } from '../domain/role.js';
import type { Role } from '../domain/role.js';
import { InMemoryRoleRepository } from '../infrastructure/in-memory-role.repository.js';
import { InMemoryRoleAssignmentRepository } from '../infrastructure/role-assignment.repository.js';

/*
 * US-096 — ROL-09..12 pelo pipeline HTTP completo (autenticação, tenant, vínculo, MFA, If-Match,
 * Idempotency-Key, validação Zod, filtro RFC 9457) com a identidade fake, a auditoria real do
 * `AuditService`, o outbox e o cache em memória. Os mesmos fluxos contra o PostgreSQL (RLS, índice
 * único parcial sob concorrência, transação atômica) estão em
 * `test/tenant-leak/role-assignments.spec.ts`.
 *
 * Elenco do Gherkin no diretório fake (tenant A = "Prefeitura A"): Carla = Marta (`ADMIN_ORGAO`
 * gravado em `role_assignments`); Bruno = Eva (vínculo `ACTIVE`, sem perfil); Otávio
 * (`ADMIN_ORGAO` só nas chaves do contexto); Lúcia ("gestora de acessos": perfil personalizado com
 * `ROLE_ASSIGN` atribuído no escopo do órgão); Heitor (só no tenant B); a externa é a "Carla" do
 * diretório (`EXTERNAL`, validade 2026-01-01).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const CARLA = FAKE_USERS.marta;
const BRUNO = FAKE_USERS.eva;
const OTAVIO = FAKE_USERS.otavio;
const LUCIA = FAKE_USERS.lucia;
const ANA = FAKE_USERS.ana;
const FABIO = FAKE_USERS.fabio;
const HEITOR = FAKE_USERS.heitor;
const EXTERNA = FAKE_USERS.carla;
const SUSPENSO = FAKE_USERS.bruno;
const MFA = ['pwd', 'otp'];
const NO_MFA = ['pwd'];
const NOW = new Date('2026-10-16T12:00:00.000Z');
const DAY = 86_400_000;

const PMA = newId();
const ORG_INATIVO = newId();
const ORG_B = newId();
const OBRAS = newId();
const SETOR_INATIVO = newId();
const OUTRA_SECRETARIA = newId();

const membershipOf = (userId: string, tenantId: string = A): string => {
  const membership = FAKE_MEMBERSHIPS.find(
    (candidate) => candidate.userId === userId && candidate.tenantId === tenantId,
  );
  if (!membership) throw new Error('vínculo do diretório fake não encontrado');
  return membership.id;
};

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

const dataOf = (response: request.Response): RoleAssignmentDto =>
  roleAssignmentSchema.parse((response.body as { data: unknown }).data);

describe('Feature: Atribuir perfis com escopo e vigência (US-096)', () => {
  let api: TestApi;
  let cache: CacheStore;
  let assignments: InMemoryRoleAssignmentRepository;
  let roles: Map<string, Role>;
  let rolesOfB: Map<string, Role>;
  let accessManager: Role;
  let clock = NOW;

  const role = (key: string, from = roles): Role => {
    const found = from.get(key);
    if (!found) throw new Error(`perfil ${key} não semeado`);
    return found;
  };

  /** Perfil personalizado com as permissões informadas, no tenant A. */
  const customRole = (name: string, permissions: readonly PermissionCode[]): Role => {
    const repository = api.app.get(InMemoryRoleRepository, { strict: false });
    const created = createRole({ name }, { id: newId(), tenantId: A, now: NOW, userId: null });
    repository.seed(
      [created],
      permissions.map((code) =>
        grantPermission(created, code, { id: newId(), now: NOW, userId: null }),
      ),
    );
    return created;
  };

  beforeAll(async () => {
    api = await createTestApi({ providers: [{ token: ACCESS_CLOCK, value: () => clock }] });
    cache = api.app.get<CacheStore>(CACHE_STORE, { strict: false });
    assignments = api.app.get(InMemoryRoleAssignmentRepository, { strict: false });
    seedOrganizations(
      api,
      { tenantId: A, id: PMA, shortName: 'PMA', cnpj: '11222333000181' },
      { tenantId: A, id: ORG_INATIVO, shortName: 'INAT', cnpj: '19131243000197', isActive: false },
      { tenantId: B, id: ORG_B, shortName: 'PMB', cnpj: '33000167000101' },
    );
    seedDepartment(api, {
      tenantId: A,
      id: OBRAS,
      organizationId: PMA,
      name: 'Secretaria de Obras',
    });
    seedDepartment(api, {
      tenantId: A,
      id: SETOR_INATIVO,
      organizationId: PMA,
      name: 'Setor desativado',
      isActive: false,
    });
    seedDepartment(api, {
      tenantId: A,
      id: OUTRA_SECRETARIA,
      organizationId: ORG_INATIVO,
      name: 'Outra secretaria',
    });
    roles = seedDefaultRolesOf(api, A);
    rolesOfB = seedDefaultRolesOf(api, B);
    accessManager = customRole('Gestor de acessos', [
      'ROLE_ASSIGN',
      'USER_VIEW',
      'ROLE_VIEW',
      'PROCESS_VIEW',
      'INBOX_VIEW',
    ]);
  });
  afterAll(async () => {
    await api.close();
  });
  beforeEach(() => {
    clock = NOW;
    // Background: Carla é a administradora do tenant (`ADMIN_ORGAO`/`TENANT` vigente).
    assignments.assignments.length = 0;
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(CARLA.id),
      roleId: role('ADMIN_ORGAO').id,
    });
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    vi.restoreAllMocks();
  });

  const silence = () => ({
    log: vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
    warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
  });

  interface As {
    readonly user?: { readonly subject: string | null };
    readonly tenant?: string;
    readonly amr?: readonly string[];
  }

  const as = (test: request.Test, options: As = {}) =>
    test
      .set(
        'Authorization',
        api.bearer(options.user?.subject ?? CARLA.subject, { amr: options.amr ?? MFA }),
      )
      .set('X-Tenant-Id', options.tenant ?? A);
  const assign = (userId: string, body: Record<string, unknown>, options: As = {}) =>
    as(request(api.server).post(`/api/v1/users/${userId}/role-assignments`), options).send(body);
  const listOf = (userId: string, options: As = {}) =>
    as(request(api.server).get(`/api/v1/users/${userId}/role-assignments`), options);
  const revoke = (
    id: string,
    version: number | null,
    body: Record<string, unknown> = {},
    options: As = {},
  ) => {
    const test = as(request(api.server).post(`/api/v1/role-assignments/${id}/revoke`), options);
    return (version === null ? test : test.set('If-Match', `"${String(version)}"`)).send(body);
  };

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const eventsOf = (eventType: string) => api.outboxRows().filter((r) => r.eventType === eventType);

  describe('[Sucesso] Atribuir perfil com escopo de unidade', () => {
    it('cria com validFrom = agora, RoleAssigned, role.assign e cache invalidado já no commit', async () => {
      const logger = silence();
      const deleted = vi.spyOn(cache, 'delete');
      const requisitante = role('REQUISITANTE');
      const response = await assign(BRUNO.id, {
        roleId: requisitante.id,
        scopeType: 'DEPARTMENT',
        scopeDepartmentId: OBRAS,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const created = dataOf(response);
      expect(created).toMatchObject({
        membershipId: membershipOf(BRUNO.id),
        userId: BRUNO.id,
        userName: BRUNO.name,
        roleId: requisitante.id,
        roleKey: 'REQUISITANTE',
        roleName: requisitante.name,
        isAdministrative: false,
        scopeType: 'DEPARTMENT',
        scopeDepartmentId: OBRAS,
        scopeOrganizationId: null,
        scopeName: 'Secretaria de Obras',
        includeSubtree: true,
        validFrom: NOW.toISOString(),
        validUntil: null,
        status: 'ACTIVE',
        grantedBy: { id: CARLA.id },
        grantedAt: NOW.toISOString(),
        revokedAt: null,
        version: 1,
      });
      expect(response.headers.etag).toBe('"1"');
      expect(response.headers.location).toBe(`/api/v1/role-assignments/${created.id}`);

      expect(eventsOf('RoleAssigned').at(-1)).toMatchObject({
        routingKey: 'role.assigned',
        aggregateId: created.id,
        payload: {
          roleAssignmentId: created.id,
          membershipId: created.membershipId,
          roleId: requisitante.id,
          scopeType: 'DEPARTMENT',
          scopeId: OBRAS,
        },
      });
      expect(auditOf('role.assign').at(-1)).toMatchObject({
        tenantId: A,
        entityType: 'RoleAssignment',
        entityId: created.id,
        actorUserId: CARLA.id,
        metadata: {
          roleId: requisitante.id,
          scopeType: 'DEPARTMENT',
          scopeDepartmentId: OBRAS,
          validFrom: NOW.toISOString(),
        },
      });
      expect(deleted).toHaveBeenCalledWith(
        expect.stringContaining(`:t:${A}:access:eff:${created.membershipId}`),
      );
      expect(logger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'role.assignment_created',
          roleAssignmentId: created.id,
          scopeType: 'DEPARTMENT',
        }),
        'role.assignment_created',
      );

      // ROL-10: aparece na aba "Perfis e acessos"; ROL-09: na lista do perfil.
      const listed = await listOf(BRUNO.id);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      const body = listed.body as { data: RoleAssignmentDto[]; meta: RoleAssignmentListMeta };
      expect(body.data.map((item) => item.id)).toEqual([created.id]);
      expect(roleAssignmentListMetaSchema.parse(body.meta)).toEqual({
        canAssign: true,
        isSelf: false,
      });
      const byRole = await as(
        request(api.server).get(`/api/v1/roles/${requisitante.id}/assignments`),
      );
      expect(byRole.status, JSON.stringify(byRole.body)).toBe(200);
      expect((byRole.body as { data: RoleAssignmentDto[] }).data).toEqual([
        expect.objectContaining({ id: created.id, userId: BRUNO.id }),
      ]);
    });

    it('escopos TENANT, ORGANIZATION e OWN_DEPARTMENTS (FA-01) e vigência futura (FA-02)', async () => {
      silence();
      const tenantWide = await assign(BRUNO.id, {
        roleId: role('SOMENTE_LEITURA').id,
        scopeType: 'TENANT',
        validUntil: new Date(NOW.getTime() + 30 * DAY).toISOString(),
      });
      expect(tenantWide.status, JSON.stringify(tenantWide.body)).toBe(201);
      expect(dataOf(tenantWide)).toMatchObject({
        scopeName: null,
        validUntil: new Date(NOW.getTime() + 30 * DAY).toISOString(),
      });
      expect(eventsOf('RoleAssigned').at(-1)?.payload).toEqual({
        roleAssignmentId: dataOf(tenantWide).id,
        membershipId: membershipOf(BRUNO.id),
        roleId: role('SOMENTE_LEITURA').id,
        scopeType: 'TENANT',
        validUntil: new Date(NOW.getTime() + 30 * DAY).toISOString(),
      });

      const byOrganization = await assign(BRUNO.id, {
        roleId: role('PLANEJAMENTO').id,
        scopeType: 'ORGANIZATION',
        scopeOrganizationId: PMA,
      });
      expect(byOrganization.status, JSON.stringify(byOrganization.body)).toBe(201);
      expect(dataOf(byOrganization)).toMatchObject({ scopeOrganizationId: PMA });
      expect(dataOf(byOrganization).scopeName).not.toBeNull();

      const future = new Date(NOW.getTime() + 7 * DAY).toISOString();
      const own = await assign(BRUNO.id, {
        roleId: role('REQUISITANTE').id,
        scopeType: 'OWN_DEPARTMENTS',
        includeSubtree: false,
        validFrom: future,
      });
      expect(own.status, JSON.stringify(own.body)).toBe(201);
      expect(dataOf(own)).toMatchObject({
        includeSubtree: false,
        validFrom: future,
        status: 'ACTIVE',
      });
    });

    it('Idempotency-Key repetida devolve a mesma resposta sem duplicar', async () => {
      silence();
      const key = newId();
      const body = { roleId: role('COMPRAS').id, scopeType: 'TENANT' };
      const first = await assign(BRUNO.id, body).set('Idempotency-Key', key);
      const replay = await assign(BRUNO.id, body).set('Idempotency-Key', key);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(dataOf(replay).id).toBe(dataOf(first).id);
      expect(roleAssignmentsOf(api).filter((item) => item.roleId === body.roleId)).toHaveLength(1);
    });
  });

  describe('[Validação] Escopo e referências', () => {
    it('ORGANIZATION sem órgão → 422 CONDITIONAL_REQUIRED em scopeOrganizationId', async () => {
      silence();
      const response = await assign(BRUNO.id, {
        roleId: role('REQUISITANTE').id,
        scopeType: 'ORGANIZATION',
      });
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'scopeOrganizationId', code: 'CONDITIONAL_REQUIRED' }),
      ]);
      expect(roleAssignmentsOf(api)).toHaveLength(1);
    });

    it('perfil e escopo obrigatórios; vigência invertida → OUT_OF_RANGE', async () => {
      silence();
      const missing = expectProblem(await assign(BRUNO.id, {}), 422, 'VALIDATION_ERROR');
      expect(missing.errors.map((error) => [error.field, error.code])).toEqual(
        expect.arrayContaining([
          ['roleId', 'REQUIRED'],
          ['scopeType', 'REQUIRED'],
        ]),
      );
      const inverted = expectProblem(
        await assign(BRUNO.id, {
          roleId: role('REQUISITANTE').id,
          scopeType: 'TENANT',
          validFrom: NOW.toISOString(),
          validUntil: NOW.toISOString(),
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(inverted.errors).toEqual([
        expect.objectContaining({ field: 'validUntil', code: 'OUT_OF_RANGE' }),
      ]);
      // Só `validUntil` no passado: a API compara com "agora".
      const past = expectProblem(
        await assign(BRUNO.id, {
          roleId: role('REQUISITANTE').id,
          scopeType: 'TENANT',
          validUntil: new Date(NOW.getTime() - DAY).toISOString(),
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(past.errors).toEqual([
        expect.objectContaining({ field: 'validUntil', code: 'OUT_OF_RANGE' }),
      ]);
    });

    it('V-03: perfil inexistente/inativo e órgão/unidade inativos ou de outro tenant', async () => {
      silence();
      const unknownRole = expectProblem(
        await assign(BRUNO.id, { roleId: role('REQUISITANTE', rolesOfB).id, scopeType: 'TENANT' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(unknownRole.errors).toEqual([
        expect.objectContaining({ field: 'roleId', code: 'REFERENCE_NOT_FOUND' }),
      ]);
      const inactive = customRole('Perfil desativado', ['PROCESS_VIEW']);
      api.app
        .get(InMemoryRoleRepository, { strict: false })
        .seed([{ ...inactive, isActive: false }], []);
      const inactiveRole = expectProblem(
        await assign(BRUNO.id, { roleId: inactive.id, scopeType: 'TENANT' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(inactiveRole.errors).toEqual([
        expect.objectContaining({ field: 'roleId', code: 'REFERENCE_INACTIVE' }),
      ]);
      const scopes = [
        [
          { scopeType: 'ORGANIZATION', scopeOrganizationId: ORG_INATIVO },
          'scopeOrganizationId',
          'REFERENCE_INACTIVE',
        ],
        [
          { scopeType: 'ORGANIZATION', scopeOrganizationId: ORG_B },
          'scopeOrganizationId',
          'REFERENCE_NOT_FOUND',
        ],
        [
          { scopeType: 'DEPARTMENT', scopeDepartmentId: SETOR_INATIVO },
          'scopeDepartmentId',
          'REFERENCE_INACTIVE',
        ],
        // Unidade ativa sob órgão inativo também não serve.
        [
          { scopeType: 'DEPARTMENT', scopeDepartmentId: OUTRA_SECRETARIA },
          'scopeDepartmentId',
          'REFERENCE_INACTIVE',
        ],
        [
          { scopeType: 'DEPARTMENT', scopeDepartmentId: newId() },
          'scopeDepartmentId',
          'REFERENCE_NOT_FOUND',
        ],
      ] as const;
      for (const [scope, field, code] of scopes) {
        const problem = expectProblem(
          await assign(BRUNO.id, { roleId: role('REQUISITANTE').id, ...scope }),
          422,
          'VALIDATION_ERROR',
        );
        expect(problem.errors).toEqual([expect.objectContaining({ field, code })]);
      }
      expect(roleAssignmentsOf(api)).toHaveLength(1);
    });
  });

  describe('[Permissão] Autorização, anti-escalonamento e MFA', () => {
    it('Anti-escalonamento: sem AUTORIDADE_COMPETENTE → 403 PRIVILEGE_ESCALATION_FORBIDDEN auditado', async () => {
      silence();
      assignRole(api, {
        tenantId: A,
        membershipId: membershipOf(LUCIA.id),
        roleId: accessManager.id,
        scopeType: 'ORGANIZATION',
        scopeOrganizationId: PMA,
      });
      const events = eventsOf('RoleAssigned').length;
      const response = await assign(
        BRUNO.id,
        { roleId: role('AUTORIDADE_COMPETENTE').id, scopeType: 'TENANT' },
        { user: LUCIA },
      );
      const problem = expectProblem(response, 403, 'PRIVILEGE_ESCALATION_FORBIDDEN');
      expect((problem as { permissions?: string[] }).permissions).toContain('APPROVAL_DECIDE');
      expect(auditOf('access.denied').at(-1)).toMatchObject({
        result: 'DENIED',
        reasonCode: 'POL-13',
        actorUserId: LUCIA.id,
      });
      expect(eventsOf('RoleAssigned')).toHaveLength(events);
    });

    it('POL-13 por escopo: só atribui o que tem, no escopo dela ou dentro dele', async () => {
      silence();
      assignRole(api, {
        tenantId: A,
        membershipId: membershipOf(LUCIA.id),
        roleId: accessManager.id,
        scopeType: 'ORGANIZATION',
        scopeOrganizationId: PMA,
      });
      const subset = customRole('Leitor de processos', ['PROCESS_VIEW', 'INBOX_VIEW']);
      const inDepartment = await assign(
        BRUNO.id,
        { roleId: subset.id, scopeType: 'DEPARTMENT', scopeDepartmentId: OBRAS },
        { user: LUCIA },
      );
      expect(inDepartment.status, JSON.stringify(inDepartment.body)).toBe(201);
      expectProblem(
        await assign(BRUNO.id, { roleId: subset.id, scopeType: 'TENANT' }, { user: LUCIA }),
        403,
        'PRIVILEGE_ESCALATION_FORBIDDEN',
      );
    });

    it('sem ROLE_ASSIGN → 403 PERMISSION_DENIED auditado; sem MFA → 403 MFA_REQUIRED', async () => {
      silence();
      const denied = expectProblem(
        await assign(
          BRUNO.id,
          { roleId: role('REQUISITANTE').id, scopeType: 'TENANT' },
          { user: ANA },
        ),
        403,
        'PERMISSION_DENIED',
      );
      expect(denied.detail).toBe('Você não tem permissão para atribuir perfis.');
      expect(auditOf('access.denied').at(-1)).toMatchObject({
        reasonCode: 'ROLE_ASSIGN',
        actorUserId: ANA.id,
      });
      expectProblem(
        await assign(
          BRUNO.id,
          { roleId: role('REQUISITANTE').id, scopeType: 'TENANT' },
          { amr: NO_MFA },
        ),
        403,
        'MFA_REQUIRED',
      );
      expectProblem(await revoke(newId(), 1, {}, { amr: NO_MFA }), 403, 'MFA_REQUIRED');
      expect(roleAssignmentsOf(api)).toHaveLength(1);
    });

    it('ROL-10 exige USER_VIEW ou ROLE_VIEW; ROL-09 exige ROLE_VIEW', async () => {
      silence();
      expectProblem(await listOf(BRUNO.id, { user: FABIO }), 403, 'PERMISSION_DENIED');
      // Lúcia (GESTOR_CONTRATACOES) tem `USER_VIEW`, mas não `ROLE_VIEW` nem `ROLE_ASSIGN`.
      const byLucia = await listOf(CARLA.id, { user: LUCIA });
      expect(byLucia.status, JSON.stringify(byLucia.body)).toBe(200);
      expect((byLucia.body as { meta: RoleAssignmentListMeta }).meta).toEqual({
        canAssign: false,
        isSelf: false,
      });
      expectProblem(
        await as(request(api.server).get(`/api/v1/roles/${role('REQUISITANTE').id}/assignments`), {
          user: LUCIA,
        }),
        403,
        'PERMISSION_DENIED',
      );
      const own = await listOf(CARLA.id);
      expect((own.body as { meta: RoleAssignmentListMeta }).meta).toEqual({
        canAssign: true,
        isSelf: true,
      });
      expect((own.body as { data: RoleAssignmentDto[] }).data).toEqual([
        expect.objectContaining({ roleKey: 'ADMIN_ORGAO', isAdministrative: true }),
      ]);
    });

    it('POL-15: externo só recebe perfil com allowExternalAssignment → 422 EXTERNAL_HIGH_RISK_ROLE', async () => {
      silence();
      // Antes do vencimento do vínculo externo (2026-01-01).
      clock = new Date('2025-12-01T12:00:00.000Z');
      const denied = await assign(EXTERNA.id, {
        roleId: role('AUTORIDADE_COMPETENTE').id,
        scopeType: 'TENANT',
      });
      expectProblem(denied, 422, 'EXTERNAL_HIGH_RISK_ROLE');
      expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'POL-15' });
      // RN-IAM-93: a vigência não passa da validade do vínculo.
      const tooLong = expectProblem(
        await assign(EXTERNA.id, {
          roleId: role('AUDITOR').id,
          scopeType: 'TENANT',
          validUntil: '2026-02-01T00:00:00.000Z',
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(tooLong.errors).toEqual([
        expect.objectContaining({ field: 'validUntil', code: 'OUT_OF_RANGE' }),
      ]);
      const auditor = await assign(EXTERNA.id, {
        roleId: role('AUDITOR').id,
        scopeType: 'TENANT',
        validUntil: '2026-01-01T00:00:00.000Z',
      });
      expect(auditor.status, JSON.stringify(auditor.body)).toBe(201);
    });

    it('vínculo vencido ou suspenso → 403 MEMBERSHIP_INACTIVE', async () => {
      silence();
      for (const target of [EXTERNA, SUSPENSO]) {
        const problem = expectProblem(
          await assign(target.id, { roleId: role('AUDITOR').id, scopeType: 'TENANT' }),
          403,
          'MEMBERSHIP_INACTIVE',
        );
        expect(problem.detail).toBe('Este vínculo não está ativo.');
      }
    });
  });

  describe('[Tenant incorreto] Vínculo de outro tenant', () => {
    it('userId cujo único vínculo é da Prefeitura B → 404 USER_NOT_FOUND sem revelar nada', async () => {
      silence();
      const response = await assign(HEITOR.id, {
        roleId: role('REQUISITANTE').id,
        scopeType: 'TENANT',
      });
      const problem = expectProblem(response, 404, 'USER_NOT_FOUND');
      expect(JSON.stringify(problem)).not.toContain(membershipOf(HEITOR.id, B));
      expect(JSON.stringify(problem)).not.toContain(B);
      expectProblem(await listOf(HEITOR.id), 404, 'USER_NOT_FOUND');
      // Atribuição e perfil do tenant B não existem para o A.
      const ofB = assignRole(api, {
        tenantId: B,
        membershipId: membershipOf(HEITOR.id, B),
        roleId: role('GESTOR_CONTRATACOES', rolesOfB).id,
      });
      expectProblem(await revoke(ofB.id, 1), 404, 'ROLE_ASSIGNMENT_NOT_FOUND');
      expectProblem(
        await as(
          request(api.server).get(`/api/v1/roles/${role('ADMIN_ORGAO', rolesOfB).id}/assignments`),
        ),
        404,
        'ROLE_NOT_FOUND',
      );
      expect(assignments.assignments.find((item) => item.id === ofB.id)?.revokedAt).toBeNull();
    });
  });

  describe('[Duplicidade] Atribuição já existente', () => {
    it('REQUISITANTE/TENANT de novo → 409 ROLE_ASSIGNMENT_ALREADY_EXISTS; outro escopo é permitido', async () => {
      silence();
      const body = { roleId: role('REQUISITANTE').id, scopeType: 'TENANT' };
      expect((await assign(BRUNO.id, body)).status).toBe(201);
      const duplicate = expectProblem(
        await assign(BRUNO.id, body),
        409,
        'ROLE_ASSIGNMENT_ALREADY_EXISTS',
      );
      expect(duplicate.detail).toBe('Este perfil já está atribuído neste escopo.');
      const otherScope = await assign(BRUNO.id, {
        roleId: role('REQUISITANTE').id,
        scopeType: 'DEPARTMENT',
        scopeDepartmentId: OBRAS,
      });
      expect(otherScope.status, JSON.stringify(otherScope.body)).toBe(201);
      // Revogada não conta mais (RN-IAM-95): pode ser atribuída de novo.
      const first = (await listOf(BRUNO.id)).body as { data: RoleAssignmentDto[] };
      const tenantWide = first.data.find((item) => item.scopeType === 'TENANT');
      expect((await revoke(tenantWide?.id ?? '', 1)).status).toBe(200);
      expect((await assign(BRUNO.id, body)).status).toBe(201);
    });
  });

  describe('[Concorrência] Duas atribuições idênticas simultâneas', () => {
    it('uma responde 201 e a outra 409 ROLE_ASSIGNMENT_ALREADY_EXISTS', async () => {
      silence();
      const body = { roleId: role('LICITACOES').id, scopeType: 'TENANT' };
      const [first, second] = await Promise.all([assign(BRUNO.id, body), assign(BRUNO.id, body)]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      expectProblem(first.status === 409 ? first : second, 409, 'ROLE_ASSIGNMENT_ALREADY_EXISTS');
      expect(roleAssignmentsOf(api).filter((item) => item.roleId === body.roleId)).toHaveLength(1);
    });
  });

  describe('[Falha de banco] Banco indisponível na atribuição', () => {
    it('503 DEPENDENCY_UNAVAILABLE e nenhuma atribuição, auditoria ou evento', async () => {
      const logger = silence();
      vi.spyOn(InMemoryRoleAssignmentRepository.prototype, 'insert').mockRejectedValue(
        new DatabaseUnavailableError(new Error('ECONNREFUSED')),
      );
      const audits = auditOf('role.assign').length;
      const events = eventsOf('RoleAssigned').length;
      const response = await assign(BRUNO.id, { roleId: role('JURIDICO').id, scopeType: 'TENANT' });
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(roleAssignmentsOf(api)).toHaveLength(1);
      expect(auditOf('role.assign')).toHaveLength(audits);
      expect(eventsOf('RoleAssigned')).toHaveLength(events);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'role.assignment_failed',
          errorCode: 'DEPENDENCY_UNAVAILABLE',
        }),
        'role.assignment_failed',
      );
    });
  });

  describe('[Falha de integração] Redis indisponível na invalidação de cache', () => {
    it('revoga, responde 200, registra warn cache.invalidation_unavailable e a lista já reflete', async () => {
      const logger = silence();
      const created = dataOf(
        await assign(BRUNO.id, { roleId: role('CONTABILIDADE').id, scopeType: 'TENANT' }),
      );
      vi.spyOn(cache, 'delete').mockRejectedValue(new Error('ECONNREFUSED'));
      const response = await revoke(created.id, created.version, { reason: 'Mudou de setor' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const revoked = dataOf(response);
      expect(revoked).toMatchObject({
        status: 'REVOKED',
        revokedAt: NOW.toISOString(),
        version: 2,
      });
      expect(response.headers.etag).toBe('"2"');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'cache.invalidation_unavailable',
          membershipId: created.membershipId,
        }),
        'cache.invalidation_unavailable',
      );
      expect(eventsOf('RoleRevoked').at(-1)).toMatchObject({
        routingKey: 'role.revoked',
        payload: {
          roleAssignmentId: created.id,
          membershipId: created.membershipId,
          roleId: created.roleId,
        },
      });
      // O motivo fica só na atribuição: nem a auditoria nem o evento nem o log o carregam.
      const audit = auditOf('role.revoke').at(-1);
      expect(audit).toMatchObject({ entityId: created.id, metadata: { hasReason: true } });
      expect(JSON.stringify(audit)).not.toContain('Mudou de setor');
      expect(JSON.stringify(logger.log.mock.calls)).not.toContain('Mudou de setor');
      expect(assignments.assignments.find((item) => item.id === created.id)).toMatchObject({
        revokedById: CARLA.id,
        revocationReason: 'Mudou de setor',
      });
      // Próxima leitura recalcula do banco: a atribuição revogada não aparece mais.
      const listed = (await listOf(BRUNO.id)).body as { data: RoleAssignmentDto[] };
      expect(listed.data.map((item) => item.id)).not.toContain(created.id);
    });
  });

  describe('Revogação — POL-12, POL-16, If-Match e estados', () => {
    it('POL-12: revogar a última ADMIN_ORGAO/TENANT → 409 LAST_ADMIN_REQUIRED; com outra, revoga', async () => {
      silence();
      const [carlaAdmin] = roleAssignmentsOf(api);
      const blocked = expectProblem(
        await revoke(carlaAdmin?.id ?? '', 1, {}, { user: OTAVIO }),
        409,
        'LAST_ADMIN_REQUIRED',
      );
      expect(blocked.detail).toBe('É preciso manter ao menos um administrador ativo.');
      expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'POL-12' });

      // FA-04: atribuir outro administrador antes.
      const bruno = await assign(BRUNO.id, { roleId: role('ADMIN_ORGAO').id, scopeType: 'TENANT' });
      expect(bruno.status, JSON.stringify(bruno.body)).toBe(201);
      expect(dataOf(bruno).isAdministrative).toBe(true);
      const revoked = await revoke(carlaAdmin?.id ?? '', 1, {}, { user: OTAVIO });
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      expect(auditOf('role.revoke').at(-1)).toMatchObject({ metadata: { hasReason: false } });
    });

    it('POL-12 não trava atribuição futura nem de escopo restrito', async () => {
      silence();
      const future = assignRole(api, {
        tenantId: A,
        membershipId: membershipOf(BRUNO.id),
        roleId: role('ADMIN_ORGAO').id,
        validFrom: new Date(NOW.getTime() + DAY),
      });
      expect((await revoke(future.id, 1, {}, { user: OTAVIO })).status).toBe(200);
    });

    it('POL-16: Carla não remove o próprio último perfil administrativo (403, reasonCode POL-16)', async () => {
      silence();
      const [carlaAdmin] = roleAssignmentsOf(api);
      const problem = expectProblem(
        await revoke(carlaAdmin?.id ?? '', 1),
        403,
        'PERMISSION_DENIED',
      );
      expect(problem.detail).toBe(
        'Você não pode remover seu próprio último perfil administrativo.',
      );
      expect(auditOf('access.denied').at(-1)).toMatchObject({
        reasonCode: 'POL-16',
        actorUserId: CARLA.id,
      });

      // Com outro perfil administrativo vigente, POL-16 passa — e POL-12 ainda protege o tenant.
      assignRole(api, {
        tenantId: A,
        membershipId: membershipOf(CARLA.id),
        roleId: accessManager.id,
      });
      expectProblem(await revoke(carlaAdmin?.id ?? '', 1), 409, 'LAST_ADMIN_REQUIRED');
      // Perfil não administrativo da própria Carla sai sem restrição.
      const reader = assignRole(api, {
        tenantId: A,
        membershipId: membershipOf(CARLA.id),
        roleId: role('SOMENTE_LEITURA').id,
      });
      expect((await revoke(reader.id, 1)).status).toBe(200);
    });

    it('If-Match: ausente → 428, divergente → 412; já revogada → 409 INVALID_STATE; inexistente → 404', async () => {
      silence();
      const created = dataOf(
        await assign(BRUNO.id, { roleId: role('JURIDICO').id, scopeType: 'TENANT' }),
      );
      expectProblem(await revoke(created.id, null), 428, 'PRECONDITION_REQUIRED');
      expectProblem(await revoke(created.id, 7), 412, 'VERSION_CONFLICT');
      expect((await revoke(created.id, 1)).status).toBe(200);
      expectProblem(await revoke(created.id, 2), 409, 'INVALID_STATE');
      expectProblem(await revoke(newId(), 1), 404, 'ROLE_ASSIGNMENT_NOT_FOUND');
      const tooLong = expectProblem(
        await revoke(created.id, 2, { reason: 'x'.repeat(501) }),
        422,
        'VALIDATION_ERROR',
      );
      expect(tooLong.errors).toEqual([expect.objectContaining({ field: 'reason' })]);
    });

    it('FA-06: a atribuição gravada pelo convite aparece na lista', async () => {
      silence();
      const [background] = roleAssignmentsOf(api);
      if (!background) throw new Error('atribuição do Background ausente');
      assignments.assignments.push({
        ...background,
        id: newId(),
        membershipId: membershipOf(BRUNO.id),
        roleId: role('COMPRAS').id,
        reason: 'Perfil inicial do convite',
      });
      const listed = (await listOf(BRUNO.id)).body as { data: RoleAssignmentDto[] };
      expect(listed.data).toEqual([
        expect.objectContaining({ roleKey: 'COMPRAS', status: 'ACTIVE' }),
      ]);
    });
  });
});
