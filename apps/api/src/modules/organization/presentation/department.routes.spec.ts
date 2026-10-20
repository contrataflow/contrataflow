import { problemDetailsSchema } from '@contrataflow/validation';
import type { DepartmentDto, DepartmentLookupItem } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  assignDepartment,
  seedOrganizations,
} from '../../../../test/support/structure-fixtures.js';
import { DEPARTMENT_CLOCK, DEPARTMENT_TRANSACTIONS } from '../application/department-ports.js';
import type { DepartmentTransactions } from '../application/department-ports.js';
import { createDepartment } from '../domain/department.js';
import { InMemoryDepartmentRepository } from '../infrastructure/in-memory-department.repository.js';

/*
 * US-102 — DEP-01..09 pelo pipeline HTTP completo (autenticação, tenant, vínculo, If-Match,
 * Idempotency-Key, validação Zod, filtro RFC 9457) com a identidade fake, a auditoria real do
 * `AuditService` e o outbox em memória. Os mesmos casos contra o PostgreSQL (RLS, FKs `RESTRICT`,
 * travas da movimentação, outbox `PENDING`) estão em `test/tenant-leak/departments.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
/** Carla do Gherkin: ADMIN_ORGAO com escopo TENANT. */
const CARLA = FAKE_USERS.marta;
const OTAVIO = FAKE_USERS.otavio;
/** Bruno do Gherkin: sem DEPARTMENT_MANAGE (GESTOR_CONTRATACOES, escopo TENANT). */
const BRUNO = FAKE_USERS.lucia;
/** Pedro do Gherkin: REQUISITANTE (escopo OWN_DEPARTMENTS), sem lotação na unidade. */
const PEDRO = FAKE_USERS.ana;
const SUSPENSO = FAKE_USERS.bruno;
const SO_DE_B = FAKE_USERS.heitor;
const PEDRO_MEMBERSHIP = FAKE_MEMBERSHIPS.find((m) => m.userId === PEDRO.id && m.tenantId === A);
const MFA = ['pwd', 'otp'];
const NOW = new Date('2026-10-15T12:00:00.000Z');

const PMSJ = newId();
const FUNDO = newId();
const INATIVO = newId();
const ORG_B = newId();
const SETOR_X_B = newId();
const UNIDADE_ORG_INATIVO = newId();

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
function dataOf<T = unknown>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

function expectFieldError(response: request.Response, field: string, code: string) {
  const body = expectProblem(response, 422, 'VALIDATION_ERROR');
  expect(body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field, code })]));
  return body;
}

describe('Feature: Gerenciar secretarias e setores (US-102)', () => {
  let api: TestApi;
  let departments: InMemoryDepartmentRepository;

  beforeAll(async () => {
    api = await createTestApi({ providers: [{ token: DEPARTMENT_CLOCK, value: () => NOW }] });
    departments = api.app.get(InMemoryDepartmentRepository, { strict: false });
    // Background: "Prefeitura de São José" (tenant A) com o órgão "Prefeitura Municipal" ativo.
    seedOrganizations(
      api,
      { tenantId: A, id: PMSJ, shortName: 'PMSJ', cnpj: '11222333000181' },
      { tenantId: A, id: FUNDO, shortName: 'FMS', cnpj: '11444777000161' },
      { tenantId: A, id: INATIVO, shortName: 'FIB', cnpj: '45997418000153', isActive: false },
      { tenantId: B, id: ORG_B, shortName: 'PMB', cnpj: '33000167000101' },
    );
    departments.seed(
      createDepartment(
        { organizationId: ORG_B, type: 'SECTOR', name: 'Setor X LEAK-B', acronym: 'SXB' },
        { id: SETOR_X_B, tenantId: B, parent: null, now: NOW, userId: null },
      ),
      {
        ...createDepartment(
          { organizationId: INATIVO, type: 'SECRETARIAT', name: 'Unidade do órgão inativo' },
          { id: UNIDADE_ORG_INATIVO, tenantId: A, parent: null, now: NOW, userId: null },
        ),
        isActive: false,
      },
    );
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    vi.restoreAllMocks();
  });

  const silence = () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  };

  const withAuth = (
    test: request.Test,
    user: { subject: string },
    tenant: string = A,
  ): request.Test =>
    test.set('Authorization', api.bearer(user.subject, { amr: MFA })).set('X-Tenant-Id', tenant);

  const list = (query = '', user: { subject: string } = CARLA, tenant: string = A) =>
    withAuth(request(api.server).get(`/api/v1/departments?${query}`), user, tenant);
  const lookup = (query = '', user: { subject: string } = CARLA) =>
    withAuth(request(api.server).get(`/api/v1/departments/lookup?${query}`), user);
  const get = (id: string, user: { subject: string } = CARLA, tenant: string = A) =>
    withAuth(request(api.server).get(`/api/v1/departments/${id}`), user, tenant);
  const create = (body: Record<string, unknown>, user: { subject: string } = CARLA) =>
    withAuth(request(api.server).post('/api/v1/departments'), user).send(body);
  const withVersion = (test: request.Test, ifMatch: string | null) =>
    ifMatch === null ? test : test.set('If-Match', ifMatch);
  const patch = (
    id: string,
    body: Record<string, unknown>,
    ifMatch: string | null,
    user: { subject: string } = CARLA,
  ) =>
    withVersion(
      withAuth(request(api.server).patch(`/api/v1/departments/${id}`), user),
      ifMatch,
    ).send(body);
  const move = (
    id: string,
    parentId: string | null,
    ifMatch: string | null,
    user: { subject: string } = CARLA,
  ) =>
    withVersion(
      withAuth(request(api.server).post(`/api/v1/departments/${id}/move`), user),
      ifMatch,
    ).send({ parentId });
  const toggle = (
    id: string,
    action: 'activate' | 'deactivate',
    ifMatch: string | null,
    user: { subject: string } = CARLA,
  ) =>
    withVersion(
      withAuth(request(api.server).post(`/api/v1/departments/${id}/${action}`), user),
      ifMatch,
    ).send({});
  const remove = (id: string, ifMatch: string | null, user: { subject: string } = CARLA) =>
    withVersion(withAuth(request(api.server).delete(`/api/v1/departments/${id}`), user), ifMatch);

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const stored = (id: string) => departments.snapshot().find((d) => d.id === id);
  const versionOf = (id: string) => `"${stored(id)?.version ?? 0}"`;

  /** Cria uma unidade pela API e devolve a resposta (201 conferido). */
  const unit = async (
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<DepartmentDto> => {
    const response = await create({ organizationId: PMSJ, type: 'SECTOR', name, ...extra });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return dataOf<DepartmentDto>(response);
  };

  /** Tentativa de criação no órgão principal (resposta crua, para os casos de erro). */
  const unit2 = (extra: Record<string, unknown>) =>
    create({ organizationId: PMSJ, type: 'SECTOR', ...extra });

  describe('[Sucesso]', () => {
    it('criar secretaria na raiz: 201, depth 0, ativa, auditoria department.create e DepartmentCreated', async () => {
      silence();
      const audits = auditOf('department.create').length;
      const events = api.outboxRows().length;

      const response = await create({
        organizationId: PMSJ,
        type: 'SECRETARIAT',
        name: '  Secretaria de Obras  ',
        acronym: 'sob',
        email: 'Obras@SaoJose.SC.gov.br',
        path: '/forjado/',
        depth: 7,
        isActive: false,
      });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.headers.etag).toBe('"1"');
      const data = dataOf<DepartmentDto>(response);
      expect(response.headers.location).toBe(`/api/v1/departments/${data.id}`);
      expect(data).toMatchObject({
        organizationId: PMSJ,
        parentId: null,
        type: 'SECRETARIAT',
        name: 'Secretaria de Obras',
        acronym: 'SOB',
        email: 'obras@saojose.sc.gov.br',
        isActive: true,
        isSecretariat: true,
        // RN-TEN-45: calculados pela aplicação, nunca aceitos do cliente.
        path: `/${data.id}/`,
        depth: 0,
        sortOrder: 0,
        version: 1,
      });

      const records = auditOf('department.create');
      expect(records).toHaveLength(audits + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        result: 'SUCCESS',
        actorUserId: CARLA.id,
        entityType: 'Department',
        entityId: data.id,
        metadata: { organizationId: PMSJ, parentId: null },
      });
      expect(api.outboxRows()).toHaveLength(events + 1);
      expect(api.outboxRows().at(-1)).toMatchObject({
        tenantId: A,
        eventType: 'DepartmentCreated',
        routingKey: 'department.created',
        aggregateType: 'Department',
        aggregateId: data.id,
        payload: { departmentId: data.id },
      });
    });

    it('árvore de 3 níveis com titular e substituto com escopo TENANT; listagem na ordem da árvore', async () => {
      silence();
      const sec = await unit('Secretaria de Educação', { type: 'SECRETARIAT', acronym: 'SED' });
      const dep = await unit('Departamento Pedagógico', {
        type: 'DEPARTMENT',
        parentId: sec.id,
        headUserId: BRUNO.id,
        deputyUserId: CARLA.id,
      });
      const setor = await unit('Setor de Merenda', { parentId: dep.id, sortOrder: 1 });
      const outro = await unit('Setor de Alfabetização', { parentId: dep.id, sortOrder: 1 });

      expect(dep).toMatchObject({
        parentId: sec.id,
        path: `/${sec.id}/${dep.id}/`,
        depth: 1,
        headUserId: BRUNO.id,
        deputyUserId: CARLA.id,
        isSecretariat: false,
      });
      expect(setor).toMatchObject({ path: `/${sec.id}/${dep.id}/${setor.id}/`, depth: 2 });

      const listed = await list(`organizationId=${PMSJ}&q=${encodeURIComponent('Educa')}`);
      expect(dataOf<DepartmentDto[]>(listed).map((d) => d.name)).toEqual([
        'Secretaria de Educação',
      ]);
      const tree = await list(`organizationId=${PMSJ}&pageSize=100`);
      const names = dataOf<DepartmentDto[]>(tree).map((d) => d.name);
      const at = (name: string) => names.indexOf(name);
      expect(at('Secretaria de Educação')).toBeLessThan(at('Departamento Pedagógico'));
      // Irmãos com o mesmo sortOrder: por nome.
      expect(at('Departamento Pedagógico')).toBeLessThan(at(outro.name));
      expect(at(outro.name)).toBeLessThan(at(setor.name));
      expect((tree.body as { meta: { totalItems: number } }).meta.totalItems).toBe(names.length);

      // Leitura é implícita: quem não gerencia também lista, consulta e busca.
      expect((await list('', BRUNO)).status).toBe(200);
      const detail = await get(setor.id, BRUNO);
      expect(detail.status).toBe(200);
      expect(detail.headers.etag).toBe('"1"');
      const found = await lookup(`q=${encodeURIComponent('merenda')}`, BRUNO);
      expect(dataOf<DepartmentLookupItem[]>(found)).toEqual([
        { id: setor.id, name: 'Setor de Merenda', type: 'SECTOR', path: setor.path },
      ]);
    });

    it('editar (DEP-05): titular lotado na unidade, anterior/novo na auditoria e changedFields no evento', async () => {
      silence();
      const sec = await unit('Secretaria de Saúde', { type: 'SECRETARIAT' });
      assignDepartment(api, PEDRO_MEMBERSHIP?.id ?? '', sec.id);
      const events = api.outboxRows().length;

      const response = await patch(
        sec.id,
        { name: 'Secretaria Municipal de Saúde', headUserId: PEDRO.id, phone: '4833810000' },
        '"1"',
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      expect(dataOf<DepartmentDto>(response)).toMatchObject({
        name: 'Secretaria Municipal de Saúde',
        headUserId: PEDRO.id,
        version: 2,
      });
      const updated = auditOf('department.update').at(-1);
      expect(updated?.entityId).toBe(sec.id);
      expect(updated?.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'name', old: 'Secretaria de Saúde' }),
          expect.objectContaining({ path: 'headUserId', old: null, new: PEDRO.id }),
        ]),
      );
      expect(api.outboxRows()).toHaveLength(events + 1);
      expect(api.outboxRows().at(-1)).toMatchObject({
        eventType: 'DepartmentUpdated',
        payload: { departmentId: sec.id, changedFields: ['name', 'phone', 'headUserId'] },
      });

      // Corpo sem mudança: 200 sem nova versão, auditoria nem evento.
      const same = await patch(sec.id, { name: 'Secretaria Municipal de Saúde' }, '"2"');
      expect(same.status).toBe(200);
      expect(same.headers.etag).toBe('"2"');
      expect(api.outboxRows()).toHaveLength(events + 1);
    });

    it('mover (DEP-06): subárvore de 3 níveis recalculada, department.move e DepartmentMoved', async () => {
      silence();
      const origem = await unit('Secretaria de Origem', { type: 'SECRETARIAT' });
      const destino = await unit('Secretaria de Destino', { type: 'SECRETARIAT' });
      const div = await unit('Divisão Móvel', { type: 'DIVISION', parentId: origem.id });
      const setor = await unit('Setor Móvel', { parentId: div.id });
      const nucleo = await unit('Núcleo Móvel', { type: 'OTHER', parentId: setor.id });

      const response = await move(div.id, destino.id, '"1"');

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      expect(dataOf<DepartmentDto>(response)).toMatchObject({
        parentId: destino.id,
        path: `/${destino.id}/${div.id}/`,
        depth: 1,
      });
      expect(stored(setor.id)).toMatchObject({
        path: `/${destino.id}/${div.id}/${setor.id}/`,
        depth: 2,
      });
      expect(stored(nucleo.id)).toMatchObject({
        path: `/${destino.id}/${div.id}/${setor.id}/${nucleo.id}/`,
        depth: 3,
      });
      expect(auditOf('department.move').at(-1)).toMatchObject({
        entityId: div.id,
        metadata: {
          fromParentId: origem.id,
          toParentId: destino.id,
          descendantsRecalculated: 2,
        },
      });
      expect(api.outboxRows().at(-1)).toMatchObject({
        eventType: 'DepartmentMoved',
        routingKey: 'department.moved',
        payload: { departmentId: div.id, fromParentId: origem.id, toParentId: destino.id },
      });

      // Para a raiz do órgão (FA-01): depth 0 e descendentes acompanham.
      const root = await move(div.id, null, '"2"');
      expect(dataOf<DepartmentDto>(root)).toMatchObject({ parentId: null, depth: 0 });
      expect(stored(nucleo.id)).toMatchObject({
        depth: 2,
        path: `/${div.id}/${setor.id}/${nucleo.id}/`,
      });
      // Mesmo destino: 200 sem efeitos.
      const events = api.outboxRows().length;
      expect((await move(div.id, null, '"3"')).status).toBe(200);
      expect(api.outboxRows()).toHaveLength(events);
    });

    it('desativar e ativar (DEP-07/08): eventos, auditoria e some do lookup enquanto inativa', async () => {
      silence();
      const sec = await unit('Secretaria Temporária', { type: 'SECRETARIAT' });

      const off = await toggle(sec.id, 'deactivate', '"1"');
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(dataOf<DepartmentDto>(off)).toMatchObject({ isActive: false, version: 2 });
      expect(auditOf('department.deactivate').at(-1)).toMatchObject({ entityId: sec.id });
      expect(api.outboxRows().at(-1)).toMatchObject({
        eventType: 'DepartmentDeactivated',
        payload: { departmentId: sec.id },
      });
      const found = await lookup(`q=${encodeURIComponent('Temporária')}`);
      expect(dataOf<DepartmentLookupItem[]>(found)).toEqual([]);
      const inactive = await list(`isActive=false&q=${encodeURIComponent('Temporária')}`);
      expect(dataOf<DepartmentDto[]>(inactive).map((d) => d.id)).toEqual([sec.id]);
      // Unidade inativa não recebe novas sub-unidades (RN-TEN-50).
      expectFieldError(
        await create({
          organizationId: PMSJ,
          type: 'SECTOR',
          name: 'Sob inativa',
          parentId: sec.id,
        }),
        'parentId',
        'REFERENCE_INACTIVE',
      );

      const on = await toggle(sec.id, 'activate', '"2"');
      expect(dataOf<DepartmentDto>(on)).toMatchObject({ isActive: true, version: 3 });
      expect(auditOf('department.update').at(-1)).toMatchObject({
        entityId: sec.id,
        changes: [{ path: 'isActive', old: false, new: true }],
      });
      expect(api.outboxRows().at(-1)).toMatchObject({
        eventType: 'DepartmentUpdated',
        payload: { departmentId: sec.id, changedFields: ['isActive'] },
      });
      // Já ativa: 200 sem efeitos.
      expect((await toggle(sec.id, 'activate', '"3"')).headers.etag).toBe('"3"');
    });

    it('excluir unidade sem referências (DEP-09): 204, department.delete com os dados e 404 depois', async () => {
      silence();
      const errada = await unit('Setor Criado por Engano', { acronym: 'SCE' });
      const response = await remove(errada.id, '"1"');
      expect(response.status, JSON.stringify(response.body)).toBe(204);
      expect(auditOf('department.delete').at(-1)).toMatchObject({
        entityId: errada.id,
        metadata: { name: 'Setor Criado por Engano', acronym: 'SCE', organizationId: PMSJ },
      });
      expectProblem(await get(errada.id), 404, 'NOT_FOUND');
    });

    it('Idempotency-Key na criação (assistente de implantação): a repetição devolve a mesma unidade', async () => {
      silence();
      const key = newId();
      const body = { organizationId: FUNDO, type: 'SECRETARIAT', name: 'Gabinete' };
      const first = await withAuth(request(api.server).post('/api/v1/departments'), CARLA)
        .set('Idempotency-Key', key)
        .send(body);
      const again = await withAuth(request(api.server).post('/api/v1/departments'), CARLA)
        .set('Idempotency-Key', key)
        .send(body);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(dataOf<DepartmentDto>(again).id).toBe(dataOf<DepartmentDto>(first).id);
      expect(departments.snapshot().filter((d) => d.name === 'Gabinete')).toHaveLength(1);
    });
  });

  describe('[Validação]', () => {
    it('titular sem lotação nem escopo na unidade: 422 REFERENCE_NOT_FOUND em headUserId', async () => {
      silence();
      const obras = await unit('Secretaria de Obras e Serviços', { type: 'SECRETARIAT' });
      const response = await patch(obras.id, { headUserId: PEDRO.id }, '"1"');
      const body = expectFieldError(response, 'headUserId', 'REFERENCE_NOT_FOUND');
      expect(body.errors[0]?.message).toBe(
        'Esta pessoa não está lotada nem tem escopo sobre a unidade.',
      );
      expect(stored(obras.id)).toMatchObject({ headUserId: null, version: 1 });
      // Na criação também: a unidade nova ainda não tem ninguém lotado.
      expectFieldError(
        await unit2({ name: 'Setor com titular inválido', headUserId: PEDRO.id }),
        'headUserId',
        'REFERENCE_NOT_FOUND',
      );
    });

    it('campos obrigatórios, titular = substituto, vínculo suspenso e de outro tenant', async () => {
      silence();
      const missing = expectProblem(await create({}), 422, 'VALIDATION_ERROR');
      expect(missing.errors.map((error) => [error.field, error.code])).toEqual(
        expect.arrayContaining([
          ['organizationId', 'REQUIRED'],
          ['type', 'REQUIRED'],
          ['name', 'REQUIRED'],
        ]),
      );
      expectFieldError(await unit2({ name: 'AB' }), 'name', 'TOO_SHORT');
      expectFieldError(
        await unit2({ name: 'Setor Duplo', headUserId: CARLA.id, deputyUserId: CARLA.id }),
        'deputyUserId',
        'NOT_ALLOWED',
      );
      expectFieldError(
        await unit2({ name: 'Setor Suspenso', deputyUserId: SUSPENSO.id }),
        'deputyUserId',
        'REFERENCE_INACTIVE',
      );
      expectFieldError(
        await unit2({ name: 'Setor de B', headUserId: SO_DE_B.id }),
        'headUserId',
        'REFERENCE_NOT_FOUND',
      );
    });

    it('órgão inativo na criação e na ativação (V-09); edição não troca órgão nem unidade superior', async () => {
      silence();
      expectFieldError(
        await create({ organizationId: INATIVO, type: 'SECTOR', name: 'Setor do Fundo' }),
        'organizationId',
        'REFERENCE_INACTIVE',
      );
      expectFieldError(
        await toggle(UNIDADE_ORG_INATIVO, 'activate', '"1"'),
        'organizationId',
        'REFERENCE_INACTIVE',
      );
      expect(stored(UNIDADE_ORG_INATIVO)?.isActive).toBe(false);

      const sec = await unit('Secretaria Fixa', { type: 'SECRETARIAT' });
      const filho = await unit('Setor Fixo', { parentId: sec.id });
      expectFieldError(await patch(filho.id, { parentId: null }, '"1"'), 'parentId', 'NOT_ALLOWED');
      expectFieldError(
        await patch(filho.id, { organizationId: FUNDO }, '"1"'),
        'organizationId',
        'NOT_ALLOWED',
      );
      // Iguais aos atuais: aceitos (o formulário reenvia o que leu).
      expect(
        (await patch(filho.id, { organizationId: PMSJ, parentId: sec.id }, '"1"')).status,
      ).toBe(200);
    });

    it('mover para dentro dela mesma ou de uma subunidade: 422 DEPARTMENT_CYCLE (V-05)', async () => {
      silence();
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const sec = await unit('Secretaria Cíclica', { type: 'SECRETARIAT' });
      const filho = await unit('Setor Cíclico', { parentId: sec.id });

      const intoChild = expectProblem(await move(sec.id, filho.id, '"1"'), 422, 'DEPARTMENT_CYCLE');
      expect(intoChild.detail).toBe(
        'Não é possível mover uma unidade para dentro dela mesma ou de uma subunidade.',
      );
      expectProblem(await move(sec.id, sec.id, '"1"'), 422, 'DEPARTMENT_CYCLE');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'department.move_blocked_cycle', departmentId: sec.id }),
        'department.move_blocked_cycle',
      );
      expect(stored(sec.id)).toMatchObject({ parentId: null, version: 1 });
    });

    it('excluir unidade referenciada: 409 DEPARTMENT_HAS_REFERENCES (sub-unidade, lotação)', async () => {
      silence();
      const pai = await unit('Secretaria em Uso', { type: 'SECRETARIAT' });
      const filho = await unit('Setor Lotado', { parentId: pai.id });
      assignDepartment(api, PEDRO_MEMBERSHIP?.id ?? '', filho.id);

      const withChildren = expectProblem(
        await remove(pai.id, '"1"'),
        409,
        'DEPARTMENT_HAS_REFERENCES',
      );
      expect(withChildren).toMatchObject({ references: ['SUBUNITS'] });
      const withPeople = expectProblem(
        await remove(filho.id, '"1"'),
        409,
        'DEPARTMENT_HAS_REFERENCES',
      );
      expect(withPeople).toMatchObject({ references: ['ASSIGNMENTS'] });
      expect(withPeople.detail).toBe(
        'Esta unidade está em uso e não pode ser excluída. Desative-a.',
      );
      expect(stored(pai.id)).toBeDefined();
      expect(stored(filho.id)).toBeDefined();
    });

    it('nome repetido entre irmãos (sem diferenciar maiúsculas) é recusado; em outro nível, aceito', async () => {
      silence();
      const sec = await unit('Secretaria de Cultura', { type: 'SECRETARIAT' });
      expectFieldError(
        await unit2({ name: 'SECRETARIA DE CULTURA', type: 'SECRETARIAT' }),
        'name',
        'INVALID_FORMAT',
      );
      const homonimo = await unit('Secretaria de Cultura', { parentId: sec.id });
      const outro = await unit('Setor Cultural');
      expectFieldError(
        await patch(outro.id, { name: 'secretaria de cultura' }, '"1"'),
        'name',
        'INVALID_FORMAT',
      );
      // Mover para o nível onde o nome já existe também é recusado.
      expectFieldError(await move(homonimo.id, null, '"1"'), 'name', 'INVALID_FORMAT');
      expect(stored(homonimo.id)?.parentId).toBe(sec.id);
      // Mesmo nome em outro órgão: aceito.
      const dup = await unit('Secretaria de Cultura', {
        organizationId: FUNDO,
        type: 'SECRETARIAT',
      });
      expect(dup.organizationId).toBe(FUNDO);
    });
  });

  describe('[Permissão]', () => {
    it('usuário sem DEPARTMENT_MANAGE: 403 PERMISSION_DENIED e access.denied com o motivo', async () => {
      silence();
      const denials = auditOf('access.denied').length;
      const total = departments.snapshot().length;

      const response = await create(
        { organizationId: PMSJ, type: 'SECTOR', name: 'Setor Negado' },
        BRUNO,
      );

      expectProblem(response, 403, 'PERMISSION_DENIED');
      const records = auditOf('access.denied');
      expect(records).toHaveLength(denials + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        actorUserId: BRUNO.id,
        reasonCode: 'DEPARTMENT_MANAGE',
        result: 'DENIED',
      });
      expect(departments.snapshot()).toHaveLength(total);

      const target = await unit('Setor Protegido');
      for (const attempt of [
        patch(target.id, { name: 'Outro nome' }, '"1"', BRUNO),
        move(target.id, null, '"1"', BRUNO),
        toggle(target.id, 'deactivate', '"1"', BRUNO),
        remove(target.id, '"1"', BRUNO),
      ]) {
        expectProblem(await attempt, 403, 'PERMISSION_DENIED');
      }
      expect(stored(target.id)).toMatchObject({ name: 'Setor Protegido', version: 1 });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('parentId de unidade de outro tenant: 422 REFERENCE_NOT_FOUND sem revelar que ela existe', async () => {
      silence();
      const response = await create({
        organizationId: PMSJ,
        type: 'SECTOR',
        name: 'Setor sob B',
        parentId: SETOR_X_B,
      });
      expectFieldError(response, 'parentId', 'REFERENCE_NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
      expect(JSON.stringify(response.body)).not.toContain(B);
      expectFieldError(
        await create({ organizationId: ORG_B, type: 'SECTOR', name: 'No órgão de B' }),
        'organizationId',
        'REFERENCE_NOT_FOUND',
      );
    });

    it('unidade de outro tenant por id: 404 em DEP-04..09; listas e lookup sem B', async () => {
      silence();
      const before = JSON.stringify(stored(SETOR_X_B));
      expectProblem(await get(SETOR_X_B), 404, 'NOT_FOUND');
      expectProblem(await patch(SETOR_X_B, { name: 'Invadido' }, '"1"'), 404, 'NOT_FOUND');
      expectProblem(await move(SETOR_X_B, null, '"1"'), 404, 'NOT_FOUND');
      expectProblem(await toggle(SETOR_X_B, 'deactivate', '"1"'), 404, 'NOT_FOUND');
      expectProblem(await remove(SETOR_X_B, '"1"'), 404, 'NOT_FOUND');
      const mine = await unit('Setor de A para mover');
      expectFieldError(await move(mine.id, SETOR_X_B, '"1"'), 'parentId', 'REFERENCE_NOT_FOUND');
      expect(JSON.stringify((await list('pageSize=100')).body)).not.toContain('LEAK-B');
      expect(JSON.stringify((await lookup('q=LEAK')).body)).not.toContain('LEAK-B');
      expect(JSON.stringify(stored(SETOR_X_B))).toBe(before);
    });

    it('unidade superior de outro órgão do mesmo tenant: REFERENCE_NOT_FOUND (RN-TEN-44)', async () => {
      silence();
      const doFundo = await unit('Secretaria do Fundo', {
        organizationId: FUNDO,
        type: 'SECRETARIAT',
      });
      expectFieldError(
        await unit2({ name: 'Setor cruzado', parentId: doFundo.id }),
        'parentId',
        'REFERENCE_NOT_FOUND',
      );
      const daPrefeitura = await unit('Setor da Prefeitura');
      expectFieldError(
        await move(daPrefeitura.id, doFundo.id, '"1"'),
        'parentId',
        'REFERENCE_NOT_FOUND',
      );
    });
  });

  describe('[Duplicidade]', () => {
    it('sigla repetida no mesmo órgão: 422 INVALID_FORMAT em acronym; em outro órgão, aceita', async () => {
      silence();
      const total = departments.snapshot().length;
      const response = await unit2({ name: 'Secretaria de Obras Duplicada', acronym: 'sob' });
      const body = expectFieldError(response, 'acronym', 'INVALID_FORMAT');
      expect(body.errors[0]?.message).toBe('Esta sigla já está em uso no órgão.');
      expect(departments.snapshot()).toHaveLength(total);
      const other = await unit('Obras do Fundo', { organizationId: FUNDO, acronym: 'SOB' });
      expect(other.acronym).toBe('SOB');
      const renamed = await unit('Setor Sem Sigla');
      expectFieldError(
        await patch(renamed.id, { acronym: 'SOB' }, '"1"'),
        'acronym',
        'INVALID_FORMAT',
      );
    });
  });

  describe('[Concorrência]', () => {
    it('mover A para dentro de B e B para dentro de A ao mesmo tempo: só uma aplicada, árvore sem ciclo', async () => {
      silence();
      const sec = await unit('Secretaria de Obras Concorrente', { type: 'SECRETARIAT' });
      const setorA = await unit('Setor A', { parentId: sec.id });
      const setorB = await unit('Setor B', { parentId: sec.id });

      const [one, two] = await Promise.all([
        move(setorA.id, setorB.id, '"1"'),
        move(setorB.id, setorA.id, '"1"', OTAVIO),
      ]);

      const statuses = [one.status, two.status].sort();
      expect(statuses).toEqual([200, 422]);
      const failed = one.status === 200 ? two : one;
      expect(['DEPARTMENT_CYCLE', 'VERSION_CONFLICT']).toContain(
        problemDetailsSchema.parse(failed.body).code,
      );
      const a = stored(setorA.id);
      const b = stored(setorB.id);
      // Árvore sem ciclo: exatamente um é pai do outro, e nenhum caminho contém a si mesmo duas vezes.
      expect(
        [a?.parentId, b?.parentId].filter((p) => p === setorA.id || p === setorB.id),
      ).toHaveLength(1);
      for (const unitPath of [a?.path ?? '', b?.path ?? '']) {
        const ids = unitPath.split('/').filter(Boolean);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids[0]).toBe(sec.id);
      }
    });

    it('duas edições com o mesmo If-Match: uma 200 e outra 412 com currentVersion; sem If-Match → 428', async () => {
      silence();
      const target = await unit('Setor Disputado');
      const [one, two] = await Promise.all([
        patch(target.id, { code: 'UO-01' }, '"1"'),
        patch(target.id, { code: 'UO-02' }, '"1"', OTAVIO),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 412]);
      const conflict = one.status === 412 ? one : two;
      expect(problemDetailsSchema.parse(conflict.body)).toMatchObject({ currentVersion: 2 });
      expectProblem(await patch(target.id, { code: 'UO-03' }, null), 428, 'PRECONDITION_REQUIRED');
      expectProblem(await move(target.id, null, null), 428, 'PRECONDITION_REQUIRED');
      expectProblem(await remove(target.id, '"1"'), 412, 'VERSION_CONFLICT');
      expect(versionOf(target.id)).toBe('"2"');
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível ao mover: 503 DEPENDENCY_UNAVAILABLE e path/depth da subárvore intactos', async () => {
      silence();
      const sec = await unit('Secretaria Estável', { type: 'SECRETARIAT' });
      const filho = await unit('Setor Estável', { parentId: sec.id });
      const before = departments.snapshot().map((d) => [d.id, d.path, d.depth]);
      const failing: DepartmentTransactions = {
        run: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
        read: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
      };
      const down = await createTestApi({
        providers: [
          { token: DEPARTMENT_TRANSACTIONS, value: failing },
          { token: DEPARTMENT_CLOCK, value: () => NOW },
        ],
      });
      const errorLog = vi.spyOn(Logger.prototype, 'error');
      try {
        const response = await request(down.server)
          .post(`/api/v1/departments/${filho.id}/move`)
          .set('Authorization', down.bearer(CARLA.subject, { amr: MFA }))
          .set('X-Tenant-Id', A)
          .set('If-Match', '"1"')
          .send({ parentId: null });
        expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
        expect(response.headers['retry-after']).toBe('5');
        expect(down.auditRecords().filter((r) => r.action === 'department.move')).toHaveLength(0);
        expect(down.outboxRows()).toHaveLength(0);
        expect(errorLog).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'department.save_failed',
            errorCode: 'DEPENDENCY_UNAVAILABLE',
          }),
          'department.save_failed',
        );
      } finally {
        await down.close();
      }
      expect(departments.snapshot().map((d) => [d.id, d.path, d.depth])).toEqual(before);
    });
  });

  describe('[Falha de integração]', () => {
    it('relay do outbox fora do ar: unidade criada (201) e DepartmentCreated gravado no outbox', async () => {
      silence();
      const events = api.outboxRows().length;
      const created = await unit('Setor do Relay');
      // Sem relay no teste, o evento fica no outbox sem publicação; o status `PENDING` no banco é
      // conferido em `test/tenant-leak/departments.spec.ts`.
      expect(api.outboxRows()).toHaveLength(events + 1);
      expect(api.outboxRows().at(-1)).toMatchObject({
        eventType: 'DepartmentCreated',
        aggregateId: created.id,
      });
    });
  });
});
