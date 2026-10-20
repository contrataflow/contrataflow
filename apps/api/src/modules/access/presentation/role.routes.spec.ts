import {
  problemDetailsSchema,
  roleSchema,
  roleWithPermissionsSchema,
} from '@contrataflow/validation';
import type { RoleDto, RoleWithPermissionsDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import {
  ACCESS_CLOCK,
  ACCESS_TRANSACTIONS,
  ROLE_ASSIGNMENT_COUNTER,
} from '../application/ports.js';
import type { AccessTransactions } from '../application/ports.js';
import { DEFAULT_ROLES, defaultGrants, seedDefaultRoles } from '../domain/default-roles.js';
import type { Role } from '../domain/role.js';
import {
  InMemoryRoleRepository,
  StubRoleAssignmentCounter,
} from '../infrastructure/in-memory-role.repository.js';

/*
 * US-095 — ROL-02..08 pelo pipeline HTTP completo (autenticação, tenant, vínculo, If-Match,
 * validação Zod, filtro RFC 9457) com a identidade fake, a auditoria real do `AuditService` e o
 * outbox em memória. Os mesmos casos contra o PostgreSQL (RLS, índices únicos, diff em
 * `role_permissions`, eventos PENDING) estão em `test/tenant-leak/role-management.spec.ts`.
 *
 * Personagens: Marta = "Ana" do Gherkin (ADMIN_ORGAO); Ana = "Carlos" (REQUISITANTE, que ganha
 * ROLE_VIEW/ROLE_MANAGE na matriz); Lúcia (GESTOR_CONTRATACOES, sem ROLE_VIEW); Heitor (só em B).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MARTA = FAKE_USERS.marta;
const CARLOS = FAKE_USERS.ana;
const LUCIA = FAKE_USERS.lucia;
const HEITOR = FAKE_USERS.heitor;
const MFA = ['pwd', 'otp'];
const NO_MFA = ['pwd'];
const NOW = new Date('2026-10-15T12:00:00.000Z');

interface User {
  readonly subject: string;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
function dataOf<T = RoleDto>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Gerenciar perfis e matriz de permissões (US-095)', () => {
  let api: TestApi;
  let repository: InMemoryRoleRepository;
  const assignmentCounts: Record<string, number> = {};
  const rolesOfA = new Map<string, Role>();
  const rolesOfB = new Map<string, Role>();

  const seedTenant = (tenantId: string, into: Map<string, Role>) => {
    const roles = seedDefaultRoles(tenantId, NOW, newId).map((seeded) => seeded.role);
    repository.seed(roles, defaultGrants(roles, DEFAULT_ROLES, NOW, newId));
    for (const role of roles) into.set(role.key, role);
  };

  beforeAll(async () => {
    api = await createTestApi({
      providers: [
        { token: ACCESS_CLOCK, value: () => NOW },
        { token: ROLE_ASSIGNMENT_COUNTER, value: new StubRoleAssignmentCounter(assignmentCounts) },
      ],
    });
    repository = api.app.get(InMemoryRoleRepository, { strict: false });
    // Background: os 15 perfis padrão semeados nos tenants A e B.
    seedTenant(A, rolesOfA);
    seedTenant(B, rolesOfB);
  });
  afterAll(async () => {
    await api.close();
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

  interface CallOptions {
    readonly user?: User;
    readonly amr?: readonly string[];
    readonly tenant?: string;
    readonly ifMatch?: string | null;
  }

  const call = (
    method: 'get' | 'post' | 'patch' | 'put',
    path: string,
    body: object | undefined,
    options: CallOptions = {},
  ) => {
    const agent = request(api.server);
    let test = agent[method](`/api/v1/roles${path}`)
      .set(
        'Authorization',
        api.bearer((options.user ?? MARTA).subject, { amr: options.amr ?? MFA }),
      )
      .set('X-Tenant-Id', options.tenant ?? A);
    if (options.ifMatch) test = test.set('If-Match', options.ifMatch);
    return body === undefined ? test : test.send(body);
  };

  const list = (query = '', options: CallOptions = {}) =>
    call('get', `?${query}`, undefined, options);
  const get = (id: string, options: CallOptions = {}) => call('get', `/${id}`, undefined, options);
  const create = (body: object, options: CallOptions = {}) => call('post', '', body, options);
  const patch = (id: string, body: object, ifMatch: string | null, options: CallOptions = {}) =>
    call('patch', `/${id}`, body, { ...options, ifMatch });
  const putPermissions = (
    id: string,
    permissions: readonly string[],
    ifMatch: string | null,
    options: CallOptions = {},
  ) => call('put', `/${id}/permissions`, { permissions }, { ...options, ifMatch });
  const duplicate = (id: string, options: CallOptions = {}) =>
    call('post', `/${id}/duplicate`, {}, options);
  const deactivate = (
    id: string,
    ifMatch: string | null,
    body: object = {},
    options: CallOptions = {},
  ) => call('post', `/${id}/deactivate`, body, { ...options, ifMatch });

  const auditOf = (action: string, entityId?: string) =>
    api
      .auditRecords()
      .filter((r) => r.action === action && (entityId === undefined || r.entityId === entityId));
  const eventsOf = (aggregateId: string) =>
    api.outboxRows().filter((row) => row.aggregateId === aggregateId);
  const roleId = (key: string, tenant: Map<string, Role> = rolesOfA) => tenant.get(key)?.id ?? '';
  const permissionsOf = async (id: string) =>
    dataOf<RoleWithPermissionsDto>(await get(id)).permissions;

  /** Cria um perfil personalizado e devolve o corpo da resposta. */
  const createRole = async (name: string, extra: object = {}) => {
    const response = await create({ name, ...extra });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return dataOf(response);
  };

  describe('[Sucesso]', () => {
    it('Criar perfil personalizado: 201, ETag "1", isSystem falso, chave gerada, auditoria e RoleCreated', async () => {
      const spies = silence();
      const response = await create({ name: '  Fiscal de Obras ', description: 'Obras públicas' });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.headers.etag).toBe('"1"');
      const role = roleSchema.strict().parse(dataOf(response));
      expect(response.headers.location).toBe(`/api/v1/roles/${role.id}`);
      expect(role).toMatchObject({
        key: 'FISCAL_DE_OBRAS',
        name: 'Fiscal de Obras',
        description: 'Obras públicas',
        isSystem: false,
        isProtected: false,
        allowExternalAssignment: false,
        isActive: true,
        activeAssignmentsCount: 0,
        version: 1,
      });
      expect(role).not.toHaveProperty('permissions');

      const [record] = auditOf('role.create', role.id);
      expect(record).toMatchObject({
        tenantId: A,
        category: 'SECURITY',
        result: 'SUCCESS',
        metadata: { key: 'FISCAL_DE_OBRAS', permissionsGranted: [] },
      });
      expect(record?.changes).toEqual([
        { path: 'name', old: null, new: 'Fiscal de Obras' },
        { path: 'description', old: null, new: 'Obras públicas' },
        { path: 'allowExternalAssignment', old: null, new: false },
      ]);
      expect(eventsOf(role.id)).toEqual([
        expect.objectContaining({
          tenantId: A,
          eventType: 'RoleCreated',
          routingKey: 'role.created',
          payload: { roleId: role.id, key: 'FISCAL_DE_OBRAS', permissionsAdded: [] },
        }),
      ]);
      // Os logs de mudança nunca carregam a lista de permissões, só as contagens.
      expect(spies.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'role.created',
          permissionsAdded: 0,
          permissionsRemoved: 0,
        }),
        'role.created',
      );
    });

    it('Criar com permissões iniciais: concessões gravadas e informadas no evento', async () => {
      silence();
      const role = await createRole('Consulta de Fornecedores', {
        permissions: ['SUPPLIER_VIEW', 'PROCESS_VIEW', 'SUPPLIER_VIEW'],
      });
      expect(await permissionsOf(role.id)).toEqual(['PROCESS_VIEW', 'SUPPLIER_VIEW']);
      expect(eventsOf(role.id)[0]?.payload).toMatchObject({
        permissionsAdded: ['SUPPLIER_VIEW', 'PROCESS_VIEW'],
      });
    });

    it('Atualizar a matriz de permissões: 200, ETag "2", RoleUpdated com permissionsAdded e auditoria', async () => {
      silence();
      const role = await createRole('Fiscal de Contratos');

      const response = await putPermissions(role.id, ['SUPPLIER_VIEW'], '"1"');

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      const updated = roleWithPermissionsSchema.parse(dataOf(response));
      expect(updated).toMatchObject({ version: 2, permissions: ['SUPPLIER_VIEW'] });
      expect(eventsOf(role.id).at(-1)).toMatchObject({
        eventType: 'RoleUpdated',
        routingKey: 'role.updated',
        payload: {
          roleId: role.id,
          key: 'FISCAL_DE_CONTRATOS',
          permissionsAdded: ['SUPPLIER_VIEW'],
          permissionsRemoved: [],
        },
      });
      expect(auditOf('role.permissions_update', role.id)).toEqual([
        expect.objectContaining({
          category: 'SECURITY',
          metadata: expect.objectContaining({
            permissionsAdded: ['SUPPLIER_VIEW'],
            permissionsRemoved: [],
          }) as unknown,
        }),
      ]);

      // Remover e acrescentar na mesma submissão: o diff vai para o evento.
      const swapped = await putPermissions(role.id, ['PROCESS_VIEW'], '"2"');
      expect(swapped.status).toBe(200);
      expect(eventsOf(role.id).at(-1)?.payload).toMatchObject({
        permissionsAdded: ['PROCESS_VIEW'],
        permissionsRemoved: ['SUPPLIER_VIEW'],
      });
      expect(await permissionsOf(role.id)).toEqual(['PROCESS_VIEW']);
    });

    it('matriz sem mudança: 200 na mesma versão, sem auditoria nem evento', async () => {
      silence();
      const role = await createRole('Perfil Estável', { permissions: ['PROCESS_VIEW'] });
      const events = eventsOf(role.id).length;
      const response = await putPermissions(role.id, ['PROCESS_VIEW'], '"1"');
      expect(response.status).toBe(200);
      expect(response.headers.etag).toBe('"1"');
      expect(eventsOf(role.id)).toHaveLength(events);
      expect(auditOf('role.permissions_update', role.id)).toHaveLength(0);
    });

    it('listar e consultar: 15 padrão primeiro, filtros, contagem de vínculos e ETag do detalhe', async () => {
      silence();
      const role = await createRole('Almoxarifado Central');

      const all = dataOf<RoleDto[]>(await list());
      expect(all.slice(0, 15).every((item) => item.isSystem)).toBe(true);
      expect(all.map((item) => item.id)).toContain(role.id);
      for (const item of all) expect(roleSchema.strict().parse(item)).toBeTruthy();

      const found = dataOf<RoleDto[]>(await list('search=almox'));
      expect(found.map((item) => item.name)).toEqual(['Almoxarifado Central']);
      expect(dataOf<RoleDto[]>(await list('search=ADMIN_ORG')).map((item) => item.key)).toEqual([
        'ADMIN_ORGAO',
      ]);
      expect(dataOf<RoleDto[]>(await list('isActive=false'))).toEqual([]);

      const detail = await get(roleId('ADMIN_ORGAO'));
      expect(detail.status).toBe(200);
      expect(detail.headers.etag).toBe('"1"');
      expect(dataOf<RoleWithPermissionsDto>(detail)).toMatchObject({
        key: 'ADMIN_ORGAO',
        isSystem: true,
        isProtected: true,
      });
      expect(dataOf<RoleWithPermissionsDto>(detail).permissions).toContain('USER_MANAGE');
    });

    it('editar nome e descrição (ROL-05): nova versão, auditoria campo a campo e RoleUpdated sem diff', async () => {
      silence();
      const role = await createRole('Fiscal de Serviços');

      const response = await patch(
        role.id,
        { name: 'Fiscal de Serviços Gerais', description: '' },
        '"1"',
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      // A chave é imutável (RN-IAM-80).
      expect(dataOf(response)).toMatchObject({
        key: 'FISCAL_DE_SERVICOS',
        name: 'Fiscal de Serviços Gerais',
        description: null,
      });
      expect(auditOf('role.update', role.id)[0]?.changes).toEqual([
        { path: 'name', old: 'Fiscal de Serviços', new: 'Fiscal de Serviços Gerais' },
      ]);
      expect(eventsOf(role.id).at(-1)).toMatchObject({
        eventType: 'RoleUpdated',
        payload: { permissionsAdded: [], permissionsRemoved: [] },
      });

      const unchanged = await patch(role.id, { name: 'Fiscal de Serviços Gerais' }, '"2"');
      expect(unchanged.status).toBe(200);
      expect(unchanged.headers.etag).toBe('"2"');
    });

    it('perfis padrão (isSystem) são editáveis, inclusive o ADMIN_ORGAO, que pode ganhar permissões', async () => {
      silence();
      const admin = roleId('ADMIN_ORGAO');
      const current = await permissionsOf(admin);
      const response = await putPermissions(admin, [...current, 'SUPPLIER_VIEW'], '"1"');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(dataOf<RoleWithPermissionsDto>(response).permissions).toContain('SUPPLIER_VIEW');
    });

    it('Duplicar perfil (FA-06): cópia personalizada com nome "(cópia)", permissões copiadas e RoleCreated', async () => {
      silence();
      const source = await createRole('Fiscal de Frota', {
        description: 'Veículos',
        permissions: ['PROCESS_VIEW'],
      });

      const first = await duplicate(source.id);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.headers.etag).toBe('"1"');
      const copy = dataOf(first);
      expect(first.headers.location).toBe(`/api/v1/roles/${copy.id}`);
      expect(copy).toMatchObject({
        name: 'Fiscal de Frota (cópia)',
        key: 'FISCAL_DE_FROTA_COPIA',
        description: 'Veículos',
        isSystem: false,
        isProtected: false,
        allowExternalAssignment: false,
      });
      expect(await permissionsOf(copy.id)).toEqual(['PROCESS_VIEW']);
      expect(auditOf('role.create', copy.id)[0]?.metadata).toMatchObject({
        duplicatedFromRoleId: source.id,
        permissionsGranted: ['PROCESS_VIEW'],
      });
      expect(eventsOf(copy.id)[0]).toMatchObject({ eventType: 'RoleCreated' });

      const second = dataOf(await duplicate(source.id));
      expect(second.name).toBe('Fiscal de Frota (cópia 2)');

      // Perfil padrão também pode ser copiado; a cópia nunca é de sistema nem protegida.
      const adminCopy = dataOf(await duplicate(roleId('ADMIN_ORGAO')));
      expect(adminCopy).toMatchObject({
        name: 'Administrador do órgão (cópia)',
        isSystem: false,
        isProtected: false,
      });
    });

    it('Desativar perfil (ROL-08): inativo, auditoria com vínculos afetados e RoleUpdated; repetir é inócuo', async () => {
      silence();
      const role = await createRole('Perfil Temporário');

      const response = await deactivate(role.id, '"1"');

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      expect(dataOf(response)).toMatchObject({ isActive: false, version: 2 });
      expect(auditOf('role.deactivate', role.id)).toEqual([
        expect.objectContaining({
          category: 'SECURITY',
          metadata: expect.objectContaining({ activeAssignmentsAffected: 0 }) as unknown,
        }),
      ]);
      expect(eventsOf(role.id).at(-1)).toMatchObject({ eventType: 'RoleUpdated' });
      expect(dataOf<RoleDto[]>(await list('isActive=false')).map((item) => item.id)).toContain(
        role.id,
      );

      const again = await deactivate(role.id, '"2"');
      expect(again.status).toBe(200);
      expect(again.headers.etag).toBe('"2"');
      expect(auditOf('role.deactivate', role.id)).toHaveLength(1);
    });

    it('FA-04: perfil com vínculos ativos exige confirmDeactivate; confirmado, audita a contagem afetada', async () => {
      silence();
      const role = await createRole('Perfil Com Vínculos');
      assignmentCounts[role.id] = 3;

      expect(dataOf<RoleDto[]>(await list('search=Com Vínculos'))[0]?.activeAssignmentsCount).toBe(
        3,
      );
      const unconfirmed = await deactivate(role.id, '"1"');
      const problem = expectProblem(unconfirmed, 422, 'VALIDATION_ERROR');
      expect(problem.errors[0]).toMatchObject({ field: 'confirmDeactivate', code: 'REQUIRED' });
      expect(problem.errors[0]?.message).toContain('3 vínculo(s)');

      const confirmed = await deactivate(role.id, '"1"', { confirmDeactivate: true });
      expect(confirmed.status).toBe(200);
      expect(auditOf('role.deactivate', role.id)[0]?.metadata).toMatchObject({
        activeAssignmentsAffected: 3,
      });
    });
  });

  describe('[Validação]', () => {
    it('Nome fora do tamanho mínimo: 422 com a mensagem da story e nenhum perfil criado', async () => {
      const before = repository.rolesOfTenant(A).length;
      const response = await create({ name: 'Fi' });
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        { field: 'name', code: 'TOO_SHORT', message: 'Informe um nome entre 3 e 120 caracteres.' },
      ]);
      expect(repository.rolesOfTenant(A)).toHaveLength(before);

      expectProblem(await create({}), 422, 'VALIDATION_ERROR');
      expectProblem(await create({ name: 'x'.repeat(121) }), 422, 'VALIDATION_ERROR');
      expectProblem(
        await create({ name: 'Ok', description: 'd'.repeat(501) }),
        422,
        'VALIDATION_ERROR',
      );
    });

    it('nome sem letras nem dígitos (sem chave derivável) → 422 em name', async () => {
      silence();
      const problem = expectProblem(await create({ name: '!!! ---' }), 422, 'VALIDATION_ERROR');
      expect(problem.errors[0]).toMatchObject({ field: 'name', code: 'INVALID_FORMAT' });
    });

    it('código de permissão fora do catálogo → 422 REFERENCE_NOT_FOUND no item', async () => {
      const role = await createRole('Perfil Validado');
      const response = await putPermissions(role.id, ['PROCESS_VIEW', 'NAO_EXISTE'], '"1"');
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        {
          field: 'permissions[1]',
          code: 'REFERENCE_NOT_FOUND',
          message: 'Selecione permissões válidas.',
        },
      ]);
      expectProblem(
        await create({ name: 'Outro', permissions: ['XPTO_X'] }),
        422,
        'VALIDATION_ERROR',
      );
    });

    it('If-Match ausente em PATCH/PUT/desativação → 428 PRECONDITION_REQUIRED', async () => {
      const id = roleId('AUDITOR');
      expectProblem(await patch(id, { name: 'Auditoria' }, null), 428, 'PRECONDITION_REQUIRED');
      expectProblem(await putPermissions(id, [], null), 428, 'PRECONDITION_REQUIRED');
      expectProblem(await deactivate(id, null), 428, 'PRECONDITION_REQUIRED');
    });
  });

  describe('[Permissão]', () => {
    it('sem ROLE_VIEW: 403 PERMISSION_DENIED na lista e no detalhe, com access.denied', async () => {
      silence();
      const denied = auditOf('access.denied').length;
      expectProblem(await list('', { user: LUCIA }), 403, 'PERMISSION_DENIED');
      expectProblem(await get(roleId('AUDITOR'), { user: LUCIA }), 403, 'PERMISSION_DENIED');
      const records = auditOf('access.denied');
      expect(records).toHaveLength(denied + 2);
      expect(records.at(-1)).toMatchObject({ reasonCode: 'ROLE_VIEW', result: 'DENIED' });
    });

    it('sem ROLE_MANAGE: 403 PERMISSION_DENIED em criar, editar, matriz, duplicar e desativar', async () => {
      silence();
      const id = roleId('AUDITOR');
      expectProblem(await create({ name: 'Negado' }, { user: LUCIA }), 403, 'PERMISSION_DENIED');
      expectProblem(
        await patch(id, { name: 'X Y Z' }, '"1"', { user: LUCIA }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(await putPermissions(id, [], '"1"', { user: LUCIA }), 403, 'PERMISSION_DENIED');
      expectProblem(await duplicate(id, { user: LUCIA }), 403, 'PERMISSION_DENIED');
      expectProblem(await deactivate(id, '"1"', {}, { user: LUCIA }), 403, 'PERMISSION_DENIED');
      expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'ROLE_MANAGE' });
    });

    it('ROLE_MANAGE é de risco alto: sessão sem MFA → 403 MFA_REQUIRED (security.mfaPolicy = ADMINS)', async () => {
      silence();
      expectProblem(await create({ name: 'Sem MFA' }, { amr: NO_MFA }), 403, 'MFA_REQUIRED');
      expect(repository.rolesOfTenant(A).some((role) => role.name === 'Sem MFA')).toBe(false);
    });

    it('Anti-escalonamento: Carlos (REQUISITANTE com ROLE_MANAGE, sem SETTINGS_MANAGE) → 403 PRIVILEGE_ESCALATION_FORBIDDEN', async () => {
      silence();
      // Marta (ADMIN_ORGAO) dá ROLE_VIEW/ROLE_MANAGE ao perfil REQUISITANTE (o de Carlos).
      const requisitante = roleId('REQUISITANTE');
      const current = await permissionsOf(requisitante);
      const granted = await putPermissions(
        requisitante,
        [...current, 'ROLE_VIEW', 'ROLE_MANAGE'],
        '"1"',
      );
      expect(granted.status, JSON.stringify(granted.body)).toBe(200);
      const target = await createRole('Fiscal de Iluminação');
      const denied = auditOf('access.denied').length;

      const response = await putPermissions(target.id, ['SETTINGS_MANAGE'], '"1"', {
        user: CARLOS,
      });

      const problem = expectProblem(response, 403, 'PRIVILEGE_ESCALATION_FORBIDDEN');
      expect(problem.detail).toBe(
        'Você não pode conceder uma permissão que você mesmo não possui.',
      );
      expect(problem.permissions).toEqual(['SETTINGS_MANAGE']);
      expect(await permissionsOf(target.id)).toEqual([]);
      expect(dataOf(await get(target.id)).version).toBe(1);
      expect(auditOf('access.denied').at(-1)).toMatchObject({
        reasonCode: 'PRIVILEGE_ESCALATION_FORBIDDEN',
      });
      expect(auditOf('access.denied')).toHaveLength(denied + 1);

      // O que Carlos possui ele pode conceder; criação e duplicação seguem a mesma regra.
      const allowed = await putPermissions(target.id, ['PROCESS_VIEW'], '"1"', { user: CARLOS });
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      expectProblem(
        await create({ name: 'Escalado', permissions: ['SETTINGS_MANAGE'] }, { user: CARLOS }),
        403,
        'PRIVILEGE_ESCALATION_FORBIDDEN',
      );
      expectProblem(
        await duplicate(roleId('ADMIN_ORGAO'), { user: CARLOS }),
        403,
        'PRIVILEGE_ESCALATION_FORBIDDEN',
      );
      // Remover o que ele não tem não é conceder: permitido.
      const removed = await putPermissions(target.id, [], '"2"', { user: CARLOS });
      expect(removed.status).toBe(200);
    });

    it('Proteção do ADMIN_ORGAO: remover USER_MANAGE → 422 BUSINESS_RULE_VIOLATION e a matriz não perde nada', async () => {
      silence();
      const admin = roleId('ADMIN_ORGAO');
      const detail = dataOf<RoleWithPermissionsDto>(await get(admin));
      const without = detail.permissions.filter((code) => code !== 'USER_MANAGE');

      const response = await putPermissions(
        admin,
        [...without, 'AUDIT_VIEW'],
        `"${detail.version}"`,
      );

      const problem = expectProblem(response, 422, 'BUSINESS_RULE_VIOLATION');
      expect(problem.detail).toBe(
        'Esta permissão é protegida e não pode ser removida do Administrador do órgão.',
      );
      expect(problem.violations).toEqual([
        expect.objectContaining({
          code: 'ROLE_PROTECTED_PERMISSION',
          severity: 'BLOCKING',
          field: 'permissions',
          params: { permission: 'USER_MANAGE' },
        }),
      ]);
      const after = dataOf<RoleWithPermissionsDto>(await get(admin));
      expect(after.permissions).toContain('USER_MANAGE');
      expect(after.version).toBe(detail.version);
    });

    it('POL-12: desativar o ADMIN_ORGAO → 409 LAST_ADMIN_REQUIRED e o perfil continua ativo', async () => {
      silence();
      const admin = roleId('ADMIN_ORGAO');
      const { version } = dataOf(await get(admin));
      const response = await deactivate(admin, `"${version}"`, { confirmDeactivate: true });
      const problem = expectProblem(response, 409, 'LAST_ADMIN_REQUIRED');
      expect(problem.detail).toContain('mantenha ao menos um administrador ativo');
      expect(dataOf(await get(admin)).isActive).toBe(true);
      expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'LAST_ADMIN_REQUIRED' });
    });

    it('RN-IAM-83: ligar allowExternalAssignment em perfil com permissão HIGH exige MFA mesmo com mfaPolicy NONE', async () => {
      silence();
      vi.spyOn(api.app.get(IdentityFacade, { strict: false }), 'mfaPolicy').mockResolvedValue(
        'NONE',
      );
      const risky = await createRole('Gestor Externo', { permissions: ['PROCESS_CANCEL'] });
      const mild = await createRole('Leitor Externo', { permissions: ['PROCESS_VIEW'] });

      const denied = await patch(risky.id, { allowExternalAssignment: true }, '"1"', {
        amr: NO_MFA,
      });
      expectProblem(denied, 403, 'MFA_REQUIRED');
      expect(problemDetailsSchema.parse(denied.body).detail).toBe(
        'Confirme sua identidade para continuar.',
      );
      // Sem permissão HIGH, a política NONE dispensa o MFA.
      const relaxed = await patch(mild.id, { allowExternalAssignment: true }, '"1"', {
        amr: NO_MFA,
      });
      expect(relaxed.status, JSON.stringify(relaxed.body)).toBe(200);

      const confirmed = await patch(risky.id, { allowExternalAssignment: true }, '"1"');
      expect(confirmed.status).toBe(200);
      expect(dataOf(confirmed).allowExternalAssignment).toBe(true);
      expect(auditOf('role.update', risky.id)[0]).toMatchObject({
        category: 'SECURITY',
        metadata: expect.objectContaining({ externalAssignmentWithHighRisk: true }) as unknown,
      });
      // Na criação vale o mesmo (ROL-03).
      expectProblem(
        await create(
          {
            name: 'Externo Arriscado',
            allowExternalAssignment: true,
            permissions: ['PROCESS_CANCEL'],
          },
          { amr: NO_MFA },
        ),
        403,
        'MFA_REQUIRED',
      );
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Perfil de outro tenant: 404 ROLE_NOT_FOUND em todas as rotas por id; B intacto', async () => {
      const ofB = roleId('AUDITOR', rolesOfB);
      expectProblem(await get(ofB), 404, 'ROLE_NOT_FOUND');
      expectProblem(await patch(ofB, { name: 'Invadido' }, '"1"'), 404, 'ROLE_NOT_FOUND');
      expectProblem(await putPermissions(ofB, ['PROCESS_VIEW'], '"1"'), 404, 'ROLE_NOT_FOUND');
      expectProblem(await duplicate(ofB), 404, 'ROLE_NOT_FOUND');
      expectProblem(await deactivate(ofB, '"1"'), 404, 'ROLE_NOT_FOUND');
      expect(repository.rolesOfTenant(B).find((role) => role.id === ofB)).toMatchObject({
        name: 'Auditor',
        version: 1,
        isActive: true,
      });
      const listOfA = dataOf<RoleDto[]>(await list());
      expect(listOfA.some((role) => rolesOfB.get(role.key)?.id === role.id)).toBe(false);
    });

    it('vínculo só em B não lê os perfis de A (403 MEMBERSHIP_INACTIVE)', async () => {
      silence();
      expectProblem(await list('', { user: HEITOR }), 403, 'MEMBERSHIP_INACTIVE');
    });

    it('id inexistente → 404 ROLE_NOT_FOUND', async () => {
      expectProblem(await get(newId()), 404, 'ROLE_NOT_FOUND');
    });
  });

  describe('[Duplicidade]', () => {
    it('Nome de perfil já existente (sem distinção de maiúsculas) → 409 ROLE_ALREADY_EXISTS', async () => {
      silence();
      await createRole('Fiscal de Pontes');
      const before = repository.rolesOfTenant(A).length;
      expectProblem(await create({ name: 'fiscal de pontes' }), 409, 'ROLE_ALREADY_EXISTS');
      // Nome diferente, mas a chave gerada coincide com a de um perfil padrão.
      expectProblem(await create({ name: 'Admin Órgão' }), 409, 'ROLE_ALREADY_EXISTS');
      expect(repository.rolesOfTenant(A)).toHaveLength(before);

      const other = await createRole('Fiscal de Viadutos');
      expectProblem(
        await patch(other.id, { name: 'FISCAL DE PONTES' }, '"1"'),
        409,
        'ROLE_ALREADY_EXISTS',
      );
    });
  });

  describe('[Concorrência]', () => {
    it('Edição concorrente da matriz: If-Match "1" com o perfil na versão 2 → 412 VERSION_CONFLICT com currentVersion', async () => {
      silence();
      const role = await createRole('Fiscal de Praças');
      expect((await putPermissions(role.id, ['PROCESS_VIEW'], '"1"')).status).toBe(200);

      const response = await putPermissions(role.id, ['SUPPLIER_VIEW'], '"1"');

      const problem = expectProblem(response, 412, 'VERSION_CONFLICT');
      expect(problem.currentVersion).toBe(2);
      expect(await permissionsOf(role.id)).toEqual(['PROCESS_VIEW']);
      expectProblem(await patch(role.id, { name: 'Outro Nome' }, '"1"'), 412, 'VERSION_CONFLICT');
      expectProblem(await deactivate(role.id, '"1"'), 412, 'VERSION_CONFLICT');
    });

    it('duas edições simultâneas da mesma versão: uma 200 e a outra 412', async () => {
      silence();
      const role = await createRole('Fiscal de Parques');
      const results = await Promise.all([
        putPermissions(role.id, ['PROCESS_VIEW'], '"1"'),
        putPermissions(role.id, ['SUPPLIER_VIEW'], '"1"'),
      ]);
      expect(results.map((response) => response.status).sort()).toEqual([200, 412]);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao desativar perfil: 503 DEPENDENCY_UNAVAILABLE e o perfil segue ativo', async () => {
      const spies = silence();
      const role = await createRole('Fiscal de Escolas');
      // A leitura segue de pé (o guard calcula as permissões efetivas — US-097); cai a gravação.
      const failing: AccessTransactions = {
        run: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
        read: (work) => runSimulatedTransaction(work),
      };
      const down = await createTestApi({
        providers: [{ token: ACCESS_TRANSACTIONS, value: failing }],
      });
      try {
        const response = await request(down.server)
          .post(`/api/v1/roles/${role.id}/deactivate`)
          .set('Authorization', down.bearer(MARTA.subject, { amr: MFA }))
          .set('X-Tenant-Id', A)
          .set('If-Match', '"1"')
          .send({});
        expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
        expect(response.headers['retry-after']).toBe('5');
        expect(down.auditRecords().filter((r) => r.action === 'role.deactivate')).toHaveLength(0);
        expect(down.outboxRows()).toHaveLength(0);
      } finally {
        await down.close();
      }
      expect(dataOf(await get(role.id)).isActive).toBe(true);
      expect(spies.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'role.update_failed',
          errorCode: 'DEPENDENCY_UNAVAILABLE',
        }),
        'role.update_failed',
      );
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: matriz persistida (200) e RoleUpdated gravado no outbox, sem publicação', async () => {
      silence();
      const role = await createRole('Fiscal de Hospitais');
      const response = await putPermissions(role.id, ['PROCESS_VIEW'], '"1"');
      // Sem relay no teste, o evento fica no outbox; o status PENDING no banco é conferido em
      // `test/tenant-leak/role-management.spec.ts`. O cache de permissões expira pelo TTL (5 min).
      expect(response.status).toBe(200);
      expect(eventsOf(role.id).at(-1)).toMatchObject({ eventType: 'RoleUpdated' });
    });
  });

  describe('RN-IAM-84: perfil inativo não concede permissões', () => {
    it('desativar o perfil de Carlos tira dele o acesso à gestão de perfis', async () => {
      silence();
      const requisitante = roleId('REQUISITANTE');
      expect((await list('', { user: CARLOS })).status).toBe(200);
      const { version } = dataOf(await get(requisitante));
      expect((await deactivate(requisitante, `"${version}"`)).status).toBe(200);
      expectProblem(await list('', { user: CARLOS }), 403, 'PERMISSION_DENIED');
    });
  });
});
