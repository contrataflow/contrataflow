import { CONTEXTUAL_POLICIES } from '@contrataflow/types';
import { myPermissionsSchema, problemDetailsSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { CacheStore, InMemoryCacheStore } from '#shared/cache/cache-store.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi, testConfig } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  AuthorizationProbeController,
  ProbePolicy,
} from '../../../../test/support/authorization-probe.controller.js';
import {
  assignDepartment,
  assignRole,
  processRuntimeStore,
  seedDefaultRolesOf,
  seedDepartment,
} from '../../../../test/support/structure-fixtures.js';
import { processRuntime } from '../../../../test/support/workflow-engine-fixtures.js';
import { ACCESS_TRANSACTIONS } from '../application/ports.js';
import type { AccessTransactions } from '../application/ports.js';
import { InMemoryRoleAssignmentRepository } from '../infrastructure/role-assignment.repository.js';

/*
 * US-097 — Autorização na API pelo pipeline HTTP completo (identidade fake, armazenamentos em
 * memória): os cenários do Gherkin (o de [Validação] é o meta-teste
 * `src/openapi/authorization-coverage.spec.ts`; a [Duplicidade] do invalidador, também em
 * `apps/worker`), FA-01..05, ME-03 e as políticas POL-01..17 auditadas. "Diego" é a Ana do diretório
 * fake: REQUISITANTE com escopo OWN_DEPARTMENTS (com subárvore), lotada na Secretaria de Obras.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const DIEGO = FAKE_USERS.ana;
const MARTA = FAKE_USERS.marta;
const LUCIA = FAKE_USERS.lucia;
const BRUNO = FAKE_USERS.bruno;
const MFA = ['pwd', 'otp'];
const PASSWORD_ONLY = ['pwd'];
const ORG = newId();

const membershipOf = (userId: string, tenantId = A): string => {
  const found = FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId);
  if (!found) throw new Error('vínculo do diretório fake não encontrado');
  return found.id;
};
const DIEGO_MEMBERSHIP = membershipOf(DIEGO.id);

// Estrutura: Secretaria de Obras > Setor de Projetos; Secretaria de Saúde à parte.
const OBRAS = newId();
const PROJETOS = newId();
const SAUDE = newId();

// Processos: visível pela subárvore, de outra secretaria, de B, com participação ativa e vencida.
const P_PROJETOS = newId();
const P_SAUDE = newId();
const P_B = newId();
const P_PARTICIPANTE = newId();
const P_PARTICIPACAO_VENCIDA = newId();

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

const silence = () => ({
  log: vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
  warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  error: vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
});

interface As {
  readonly subject?: string;
  readonly amr?: readonly string[];
  readonly tenant?: string;
}

function client(api: TestApi) {
  const as = (test: request.Test, options: As = {}) =>
    test
      .set(
        'Authorization',
        api.bearer(options.subject ?? DIEGO.subject, { amr: options.amr ?? MFA }),
      )
      .set('X-Tenant-Id', options.tenant ?? A);
  return {
    create: (requestingDepartmentId: string, options?: As) =>
      as(request(api.server).post('/api/v1/_test/authz/processes'), options).send({
        requestingDepartmentId,
      }),
    view: (id: string, options?: As) =>
      as(request(api.server).get(`/api/v1/_test/authz/processes/${id}`), options),
    cancel: (id: string, options?: As) =>
      as(request(api.server).post(`/api/v1/_test/authz/processes/${id}/cancel`), options).send({}),
    comment: (id: string, options?: As) =>
      as(request(api.server).post(`/api/v1/_test/authz/processes/${id}/comments`), options).send(
        {},
      ),
    guarded: (id: string, options?: As) =>
      as(request(api.server).post(`/api/v1/_test/authz/processes/${id}/policy`), options).send({}),
    myPermissions: (options?: As) => as(request(api.server).get('/api/v1/me/permissions'), options),
    revoke: (id: string, version: number) =>
      as(request(api.server).post(`/api/v1/role-assignments/${id}/revoke`), {
        subject: MARTA.subject,
      })
        .set('If-Match', `"${String(version)}"`)
        .send({ reason: 'Mudou de área' }),
  };
}

/** Estrutura, perfis e processos do Background em uma API de teste. */
function seedBackground(api: TestApi) {
  const roles = seedDefaultRolesOf(api, A);
  seedDefaultRolesOf(api, B);
  const obras = seedDepartment(api, {
    tenantId: A,
    id: OBRAS,
    organizationId: ORG,
    name: 'Secretaria de Obras',
  });
  seedDepartment(api, {
    tenantId: A,
    id: PROJETOS,
    organizationId: ORG,
    name: 'Setor de Projetos',
    parent: obras,
  });
  seedDepartment(api, { tenantId: A, id: SAUDE, organizationId: ORG, name: 'Secretaria de Saúde' });
  assignDepartment(api, DIEGO_MEMBERSHIP, OBRAS);
  const requisitante = roles.get('REQUISITANTE');
  if (!requisitante) throw new Error('REQUISITANTE não semeado');
  const assignment = assignRole(api, {
    tenantId: A,
    membershipId: DIEGO_MEMBERSHIP,
    roleId: requisitante.id,
    scopeType: 'OWN_DEPARTMENTS',
    includeSubtree: true,
  });

  const store = processRuntimeStore(api);
  const base = { workflowVersionId: newId(), passes: [] } as const;
  store.save(
    processRuntime({ ...base, id: P_PROJETOS, tenantId: A, accessDepartmentIds: [PROJETOS] }),
  );
  store.save(processRuntime({ ...base, id: P_SAUDE, tenantId: A, accessDepartmentIds: [SAUDE] }));
  store.save(processRuntime({ ...base, id: P_B, tenantId: B, accessDepartmentIds: [] }));
  const withParticipation = (id: string, expiresAt: Date | null) => {
    const runtime = processRuntime({
      ...base,
      id,
      tenantId: A,
      accessDepartmentIds: [SAUDE],
      accessUserIds: [DIEGO.id],
    });
    store.save({
      ...runtime,
      access: {
        ...runtime.access,
        participations: [{ userId: DIEGO.id, role: 'OBSERVER', expiresAt }],
      },
    });
  };
  withParticipation(P_PARTICIPANTE, null);
  withParticipation(P_PARTICIPACAO_VENCIDA, new Date('2026-01-01T00:00:00.000Z'));
  return { assignment };
}

describe('Feature: Autorização na API e no frontend (US-097)', () => {
  let api: TestApi;
  let http: ReturnType<typeof client>;
  let cache: InMemoryCacheStore;
  let assignmentId: string;

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const snapshotKey = (membershipId: string) => `cf:test:t:${A}:access:eff:${membershipId}`;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    api = await createTestApi({
      controllers: [AuthorizationProbeController],
      // As políticas POL-01..17 negam 17 vezes seguidas: sem amostragem de `access.denied` aqui.
      config: testConfig({ AUDIT_ACCESS_DENIED_SAMPLING_MAX_PER_WINDOW: '1000' }),
    });
    http = client(api);
    cache = api.app.get<InMemoryCacheStore>(CACHE_STORE, { strict: false });
    assignmentId = seedBackground(api).assignment.id;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    ProbePolicy.deny = false;
    ProbePolicy.policyId = 'POL-01';
  });

  describe('[Sucesso] Permissão concedida e cacheada', () => {
    it('a segunda chamada em até 5 minutos é autorizada pelo cache, sem consultar o banco', async () => {
      cache.entries.clear();
      const assignments = api.app.get(InMemoryRoleAssignmentRepository, { strict: false });
      const reads = vi.spyOn(assignments, 'listByMembership');
      const logs = silence();

      const first = await http.create(PROJETOS);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(reads).toHaveBeenCalledTimes(1);
      const entry = cache.entries.get(snapshotKey(DIEGO_MEMBERSHIP));
      expect(entry).toBeDefined();
      expect((entry?.expiresAt ?? 0) - Date.now()).toBeGreaterThan(295_000);
      expect((entry?.expiresAt ?? 0) - Date.now()).toBeLessThanOrEqual(300_000);
      expect(logs.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'authorization.cache_rebuilt',
          membershipId: DIEGO_MEMBERSHIP,
          durationMs: expect.any(Number) as unknown,
        }),
        'authorization.cache_rebuilt',
      );

      const second = await http.create(OBRAS);
      expect(second.status).toBe(201);
      // Servida do cache de permissões efetivas: nenhuma nova leitura das atribuições.
      expect(reads).toHaveBeenCalledTimes(1);
      reads.mockRestore();
    });

    it('unidade fora da lotação (e da subárvore) → 403 PERMISSION_DENIED com PROCESS_CREATE', async () => {
      silence();
      expectProblem(await http.create(SAUDE), 403, 'PERMISSION_DENIED');
      expect(auditOf('access.denied').at(-1)).toMatchObject({
        reasonCode: 'PROCESS_CREATE',
        actorUserId: DIEGO.id,
      });
    });

    it('rota de capacidade implícita só exige o vínculo ativo', async () => {
      const response = await request(api.server)
        .post('/api/v1/_test/authz/implicit')
        .set('Authorization', api.bearer(DIEGO.subject, { amr: MFA }))
        .set('X-Tenant-Id', A)
        .send({});
      expect(response.status).toBe(200);
    });
  });

  describe('[Permissão] Ação sem a permissão necessária', () => {
    it('Diego (sem PROCESS_CANCEL) cancela processo visível → 403 e access.denied PROCESS_CANCEL', async () => {
      silence();
      expect((await http.view(P_PROJETOS)).status).toBe(200);
      const body = expectProblem(await http.cancel(P_PROJETOS), 403, 'PERMISSION_DENIED');
      expect(body.detail).toBe('Você não tem permissão para esta ação.');
      expect(auditOf('access.denied').at(-1)).toMatchObject({
        result: 'DENIED',
        reasonCode: 'PROCESS_CANCEL',
        actorUserId: DIEGO.id,
      });
    });

    it('FA-03: permissão HIGH sem MFA → 403 MFA_REQUIRED e auth.mfa_required; com MFA → 200', async () => {
      silence();
      // Lúcia (GESTOR_CONTRATACOES, escopo TENANT) tem PROCESS_CANCEL (risco HIGH).
      expectProblem(
        await http.cancel(P_SAUDE, { subject: LUCIA.subject, amr: PASSWORD_ONLY }),
        403,
        'MFA_REQUIRED',
      );
      expect(auditOf('auth.mfa_required').at(-1)).toMatchObject({
        actorUserId: LUCIA.id,
        metadata: expect.objectContaining({ permissionCode: 'PROCESS_CANCEL' }) as unknown,
      });
      expect((await http.cancel(P_SAUDE, { subject: LUCIA.subject })).status).toBe(200);
    });
  });

  describe('[Tenant incorreto] Recurso de outro tenant', () => {
    it('processo da Prefeitura B consultado na A → 404 PROCESS_NOT_FOUND, igual ao inexistente', async () => {
      const ofB = expectProblem(await http.view(P_B), 404, 'PROCESS_NOT_FOUND');
      const missing = expectProblem(await http.view(newId()), 404, 'PROCESS_NOT_FOUND');
      expect(ofB.detail).toBe(missing.detail);
      expect(ofB.title).toBe(missing.title);
      expect(JSON.stringify(ofB)).not.toContain(B);
    });

    it('FA-05: existente mas não visível (outra secretaria) → 404, nunca 403', async () => {
      expectProblem(await http.view(P_SAUDE), 404, 'PROCESS_NOT_FOUND');
      expectProblem(await http.cancel(P_SAUDE), 404, 'PROCESS_NOT_FOUND');
    });

    it('id malformado → 400 MALFORMED_REQUEST', async () => {
      expectProblem(await http.view('nao-e-uuid'), 400, 'MALFORMED_REQUEST');
    });
  });

  describe('FA-02 — Permissão por participação', () => {
    it('OBSERVER comenta no processo, mesmo sem perfil que o cubra, mas nunca cancela', async () => {
      silence();
      expect((await http.comment(P_PARTICIPANTE)).status).toBe(201);
      expectProblem(await http.cancel(P_PARTICIPANTE), 403, 'PERMISSION_DENIED');
    });

    it('participação vencida não concede nada (a concessão de usuário só mantém a visibilidade)', async () => {
      silence();
      expectProblem(await http.comment(P_PARTICIPACAO_VENCIDA), 403, 'PERMISSION_DENIED');
    });
  });

  describe('Políticas contextuais (POL-01..17) — toda recusa é auditada', () => {
    it('a política recebe o processo e o usuário da requisição e, permitindo, a rota segue', async () => {
      const response = await http.guarded(P_PROJETOS);
      expect(response.status).toBe(200);
      expect(ProbePolicy.lastContext).toMatchObject({
        userId: DIEGO.id,
        membershipId: DIEGO_MEMBERSHIP,
        params: { id: P_PROJETOS },
        process: { processId: P_PROJETOS, departmentIds: [PROJETOS] },
      });
      expect(ProbePolicy.lastContext?.has('PROCESS_CREATE')).toBe(true);
      expect(ProbePolicy.lastContext?.has('PROCESS_CANCEL')).toBe(false);
    });

    it.each(CONTEXTUAL_POLICIES.map((policy) => [policy.id, policy] as const))(
      '%s negada → código da política e access.denied com o ID em reasonCode',
      async (id, policy) => {
        silence();
        ProbePolicy.policyId = id;
        ProbePolicy.deny = true;
        expectProblem(await http.guarded(P_PROJETOS), policy.denialStatus, policy.denialCode);
        expect(auditOf('access.denied').at(-1)).toMatchObject({
          result: 'DENIED',
          reasonCode: id,
          actorUserId: DIEGO.id,
        });
      },
    );
  });

  describe('ME-03 — GET /me/permissions', () => {
    it('devolve as permissões efetivas por escopo e as capacidades implícitas', async () => {
      const response = await http.myPermissions();
      expect(response.status).toBe(200);
      const body = myPermissionsSchema.parse((response.body as { data: unknown }).data);
      expect(body.permissions.find((permission) => permission.code === 'PROCESS_CREATE')).toEqual({
        code: 'PROCESS_CREATE',
        scopes: [{ type: 'OWN_DEPARTMENTS', includeSubtree: true }],
      });
      expect(body.permissions.map((permission) => permission.code)).not.toContain('PROCESS_CANCEL');
      // US-001: as lotações do vínculo (escopo OWN_DEPARTMENTS) para o wizard de criação.
      expect(body.implicit).toEqual({
        headOfDepartmentIds: [],
        ownDepartmentIds: [expect.any(String)],
      });
      const codes = body.permissions.map((permission) => permission.code);
      expect(codes).toEqual([...codes].sort());
    });

    it('perfil do vínculo sem atribuição gravada (ponte por chave) vem no escopo padrão do perfil', async () => {
      const response = await http.myPermissions({ subject: LUCIA.subject });
      const body = myPermissionsSchema.parse((response.body as { data: unknown }).data);
      expect(body.permissions.find((permission) => permission.code === 'PROCESS_CANCEL')).toEqual({
        code: 'PROCESS_CANCEL',
        scopes: [{ type: 'TENANT', includeSubtree: false }],
      });
    });

    it('401 sem token; 403 MEMBERSHIP_INACTIVE com vínculo suspenso ou em outro tenant', async () => {
      const anonymous = await request(api.server)
        .get('/api/v1/me/permissions')
        .set('X-Tenant-Id', A);
      expectProblem(anonymous, 401, 'UNAUTHENTICATED');
      silence();
      expectProblem(
        await http.myPermissions({ subject: BRUNO.subject }),
        403,
        'MEMBERSHIP_INACTIVE',
      );
      expectProblem(await http.myPermissions({ tenant: B }), 403, 'MEMBERSHIP_INACTIVE');
    });
  });

  describe('[Concorrência] Revogação de perfil durante requisições simultâneas', () => {
    it('nenhuma requisição posterior à revogação usa o retrato calculado antes dela', async () => {
      silence();
      cache.entries.clear();
      const assignments = api.app.get(InMemoryRoleAssignmentRepository, { strict: false });
      const original = assignments.listByMembership.bind(assignments);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let paused = false;
      const reads = vi
        .spyOn(assignments, 'listByMembership')
        .mockImplementation(async (tx, membershipId) => {
          const rows = await original(tx, membershipId);
          if (membershipId === DIEGO_MEMBERSHIP && !paused) {
            paused = true;
            // R1 leu o banco ANTES da revogação e só grava o retrato DEPOIS do DEL.
            await gate;
          }
          return rows;
        });

      // O supertest só envia ao ser consumido: `then` dispara R1 já.
      const r1 = http.create(PROJETOS).then((response) => response);
      await vi.waitFor(() => {
        expect(paused).toBe(true);
      });
      const revoked = await http.revoke(assignmentId, 1);
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

      // R2, simultânea a R1 e já depois do commit da revogação: recalcula e nega.
      expectProblem(await http.create(PROJETOS), 403, 'PERMISSION_DENIED');
      release();
      expect([201, 403]).toContain((await r1).status);

      // O retrato que R1 gravou carrega o token de geração anterior à revogação: descartado.
      expectProblem(await http.create(PROJETOS), 403, 'PERMISSION_DENIED');
      expectProblem(await http.view(P_PROJETOS), 404, 'PROCESS_NOT_FOUND');
      reads.mockRestore();
    });
  });
});

describe('Falhas de dependência ao calcular as permissões efetivas (US-097)', () => {
  let logs: ReturnType<typeof silence>;
  beforeEach(() => {
    logs = silence();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[Falha de banco] banco indisponível com o cache expirado → 503 DEPENDENCY_UNAVAILABLE', async () => {
    const failing: AccessTransactions = {
      run: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
      read: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
    };
    const down = await createTestApi({
      controllers: [AuthorizationProbeController],
      providers: [{ token: ACCESS_TRANSACTIONS, value: failing }],
    });
    try {
      const response = await client(down).create(PROJETOS);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBe('5');
      expect(logs.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'authorization.decision_failed',
          errorCode: 'DEPENDENCY_UNAVAILABLE',
        }),
        'authorization.decision_failed',
      );
    } finally {
      await down.close();
    }
  });

  it('[Falha de integração] Redis indisponível → decide sem cache, corretamente, e loga warn', async () => {
    const unavailable = (): Promise<never> => Promise.reject(new Error('ECONNREFUSED'));
    const downStore: CacheStore = {
      get: unavailable,
      set: unavailable,
      delete: unavailable,
      getMany: unavailable,
    };
    const noRedis = await createTestApi({
      controllers: [AuthorizationProbeController],
      providers: [{ token: CACHE_STORE, value: downStore }],
    });
    try {
      seedBackground(noRedis);
      const http = client(noRedis);
      expect((await http.create(PROJETOS)).status).toBe(201);
      expectProblem(await http.create(SAUDE), 403, 'PERMISSION_DENIED');
      expectProblem(await http.cancel(P_PROJETOS), 403, 'PERMISSION_DENIED');
      expect(logs.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'authorization.cache_unavailable',
          membershipId: DIEGO_MEMBERSHIP,
        }),
        'authorization.cache_unavailable',
      );
    } finally {
      await noRedis.close();
    }
  });
});
