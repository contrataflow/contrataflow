import { randomUUID } from 'node:crypto';

import {
  problemDetailsSchema,
  processParticipantSchema,
  processParticipantsMetaSchema,
  userLookupItemSchema,
} from '@contrataflow/validation';
import type { ProcessDto, ProcessParticipantDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedProcessStructure,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { PROCESS_CLOCK, PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';
import { InMemoryProcessParticipantRepository } from '../infrastructure/process-participant.repositories.js';

/*
 * US-012 — PRC-28..32 (participantes do processo) e USR-02 (busca de pessoas) pelo pipeline HTTP
 * completo (autenticação, tenant, vínculo, autorização com escopo do processo, `Idempotency-Key`,
 * filtro RFC 9457) com a identidade fake, os seeders reais e o processo criado pelo PRC-02, com
 * auditoria, outbox e timeline em memória. As 8 categorias do Gherkin. Papéis do Gherkin → fake:
 * Carla (gestora, `PROCESS_MANAGE_PARTICIPANTS` no tenant) = Lúcia (GESTOR_CONTRATACOES); Diego
 * (vínculo EXTERNAL) = Carla Dias (EXTERNAL até 2026-01-01 — o relógio do processo é 2025-11-20);
 * Fábio (sem a permissão de gerenciar) = Fábio (COMPRAS, PROCESS_VIEW/FOLLOW no tenant); Elisa =
 * Otávio (INTERNAL, só CONSULTOR_EXTERNO: PROCESS_FOLLOW sem PROCESS_VIEW); Grace (só no outro tenant) = Heitor; Hugo = Marta. Índice único sob
 * concorrência real, RLS, gatilho e rollback no PostgreSQL: `test/tenant-leak/process-participants.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2025-11-20T15:00:00.000Z');
const TOMORROW = '2025-11-21T15:00:00.000Z';

const UNITS_A = {
  organizationId: '0192d012-0000-7000-8000-0000000000a0',
  obras: '0192d012-0000-7000-8000-0000000000a1',
  manutencao: '0192d012-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d012-0000-7000-8000-0000000000a3',
  saude: '0192d012-0000-7000-8000-0000000000a4',
  posto: '0192d012-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d012-0000-7000-8000-0000000000b0',
  obras: '0192d012-0000-7000-8000-0000000000b1',
  manutencao: '0192d012-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d012-0000-7000-8000-0000000000b3',
  saude: '0192d012-0000-7000-8000-0000000000b4',
  posto: '0192d012-0000-7000-8000-0000000000b5',
};

const SUB = {
  ana: 'sub-ana',
  lucia: 'sub-lucia',
  fabio: 'sub-fabio',
  otavio: 'sub-otavio',
  marta: 'sub-marta',
  heitor: 'sub-heitor',
} as const;

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações que podem simular o banco fora do ar (Falha de banco). */
class FlakyTransactions implements ProcessTransactions {
  down = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }

  snapshot<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
function data<T>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

const fieldErrors = (response: request.Response) =>
  problemDetailsSchema.parse(response.body).errors.map((error) => [error.field, error.code]);

describe('Feature: Gerenciar participantes do processo (US-012)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject: string = SUB.lucia, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const list = (processId: string, subject: string = SUB.lucia, tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/processes/${processId}/participants`), subject, tenant);
  const add = (
    processId: string,
    body: Record<string, unknown>,
    options: { subject?: string; key?: string; tenant?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${processId}/participants`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);
  const remove = (participantId: string, subject: string = SUB.lucia, tenant: string = A) =>
    auth(
      request(api.server).delete(`/api/v1/process-participants/${participantId}`),
      subject,
      tenant,
    );
  const follow = (processId: string, subject: string) =>
    auth(request(api.server).post(`/api/v1/processes/${processId}/follow`), subject);
  const unfollow = (processId: string, subject: string) =>
    auth(request(api.server).delete(`/api/v1/processes/${processId}/follow`), subject);

  const store = () => api.app.get(InMemoryProcessParticipantRepository);
  const activeOf = (processId: string) => store().activeOf(processId);
  const accessOf = (processId: string) =>
    processRepositoryOf(api)
      .accessOf(processId)
      .filter((row) => row.reason === 'PARTICIPANT');
  const eventsOf = (processId: string, type: string) =>
    api.outboxRows().filter((row) => row.aggregateId === processId && row.eventType === type);
  const auditOf = (action: string) => api.auditRecords().filter((row) => row.action === action);
  const timelineOf = (processId: string, type: string) =>
    timelineRowsOf(api).filter((row) => row.processId === processId && row.type === type);

  /** Processo criado pelo PRC-02 (Ana, requisitante lotada em Manutenção). */
  async function newProcess(): Promise<ProcessDto> {
    const response = await auth(request(api.server).post('/api/v1/processes'), SUB.ana)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Aquisição ${words(2)}`,
        object: `Objeto da contratação ${words(3)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return data<ProcessDto>(response);
  }

  async function addOk(processId: string, body: Record<string, unknown>, subject?: string) {
    const response = await add(processId, body, subject === undefined ? {} : { subject });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return processParticipantSchema.parse(data<ProcessParticipantDto>(response));
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: PROCESS_TRANSACTIONS, value: transactions },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B, ['catalog.items', 'access.defaultRoles']);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    // Otávio só segue: sem PROCESS_VIEW, vê o processo apenas como participante.
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: seedDefaultRolesOf(api, A).get('CONSULTOR_EXTERNO')?.id ?? '',
    });
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
    };
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
  });

  describe('[Sucesso]', () => {
    it('Adicionar colaboradora interna: participante ativo, ProcessAccess PARTICIPANT, evento com notify, auditoria e timeline', async () => {
      const process = await newProcess();
      const response = await add(process.id, {
        userId: FAKE_USERS.otavio.id,
        role: 'COLLABORATOR',
        notify: true,
        reason: 'Parecer técnico pontual',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const elisa = processParticipantSchema.parse(data<ProcessParticipantDto>(response));
      expect(response.headers.location).toBe(`/api/v1/process-participants/${elisa.id}`);
      expect(elisa).toMatchObject({
        processId: process.id,
        principalType: 'USER',
        userId: FAKE_USERS.otavio.id,
        departmentId: null,
        principal: { id: FAKE_USERS.otavio.id, name: 'Otávio Campos', isExternal: false },
        role: 'COLLABORATOR',
        notify: true,
        expiresAt: null,
        grantedAt: NOW.toISOString(),
        grantedBy: { id: FAKE_USERS.lucia.id, name: 'Lúcia Matos' },
        reason: 'Parecer técnico pontual',
      });

      expect(activeOf(process.id)).toMatchObject([
        { id: elisa.id, userId: FAKE_USERS.otavio.id, role: 'COLLABORATOR' },
      ]);
      expect(accessOf(process.id)).toMatchObject([
        { principalType: 'USER', userId: FAKE_USERS.otavio.id, sourceId: elisa.id },
      ]);
      // A notificação PARTICIPANT_ADDED sai do evento (worker) — com `notify`.
      const [event] = eventsOf(process.id, 'ProcessParticipantAdded');
      expect(event).toMatchObject({
        routingKey: 'process.participant_added',
        payload: {
          participantId: elisa.id,
          userId: FAKE_USERS.otavio.id,
          departmentId: null,
          role: 'COLLABORATOR',
          expiresAt: null,
          notify: true,
          grantedVia: 'MANAGE',
        },
      });
      expect(auditOf('process.participant_add').at(-1)).toMatchObject({
        category: 'DATA_CHANGE',
        entityId: elisa.id,
        processId: process.id,
        metadata: { role: 'COLLABORATOR', grantedVia: 'MANAGE', hasExpiresAt: false },
      });
      // Nunca o nome nem o motivo na auditoria (story · "Logs"/"Auditoria").
      expect(JSON.stringify(auditOf('process.participant_add').at(-1))).not.toContain('Parecer');
      expect(timelineOf(process.id, 'PARTICIPANT_ADDED')).toMatchObject([
        { params: { name: 'Otávio Campos', principalType: 'USER', role: 'COLLABORATOR' } },
      ]);

      // A participação dá visibilidade e entra na contagem do painel (RN-PROC-57).
      const panel = await auth(
        request(api.server).get(`/api/v1/processes/${process.id}/summary`),
        SUB.otavio,
      );
      expect(panel.status, JSON.stringify(panel.body)).toBe(200);
      expect(data<{ counts: { participants: number } }>(panel).counts.participants).toBe(1);

      const listed = await list(process.id);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(z.array(processParticipantSchema).parse(data(listed))).toEqual([elisa]);
      expect(processParticipantsMetaSchema.parse((listed.body as { meta: unknown }).meta)).toEqual({
        canManage: true,
        me: null,
      });
    });

    it('Seguir o processo: OBSERVER com notify, "Seguindo" pelo meta.me; deixar de seguir revoga e é idempotente', async () => {
      const process = await newProcess();
      const followed = await follow(process.id, SUB.fabio);
      expect(followed.status, JSON.stringify(followed.body)).toBe(200);
      const fabio = processParticipantSchema.parse(data<ProcessParticipantDto>(followed));
      expect(fabio).toMatchObject({ userId: FAKE_USERS.fabio.id, role: 'OBSERVER', notify: true });
      expect(eventsOf(process.id, 'ProcessParticipantAdded').at(-1)?.payload).toMatchObject({
        participantId: fabio.id,
        grantedVia: 'FOLLOW',
        notify: true,
      });
      expect(auditOf('process.participant_add').at(-1)).toMatchObject({
        metadata: { grantedVia: 'FOLLOW', role: 'OBSERVER' },
      });
      const listed = await list(process.id, SUB.fabio);
      expect((listed.body as { meta: unknown }).meta).toEqual({
        canManage: false,
        me: { participantId: fabio.id, role: 'OBSERVER' },
      });

      const left = await unfollow(process.id, SUB.fabio);
      expect(left.status, JSON.stringify(left.body)).toBe(204);
      expect(activeOf(process.id)).toEqual([]);
      expect(accessOf(process.id)).toEqual([]);
      expect(eventsOf(process.id, 'ProcessParticipantRemoved').at(-1)?.payload).toEqual({
        participantId: fabio.id,
        reason: 'REVOKED',
      });
      // Sem participação: 204 sem efeito.
      const again = await unfollow(process.id, SUB.fabio);
      expect(again.status).toBe(204);
      expect(eventsOf(process.id, 'ProcessParticipantRemoved')).toHaveLength(1);
    });

    it('Consultor externo com validade dentro do vínculo; vencido sai da lista e da contagem antes do job (RN-PROC-135)', async () => {
      const process = await newProcess();
      const diego = await addOk(process.id, {
        userId: FAKE_USERS.carla.id,
        role: 'CONSULTANT',
        expiresAt: TOMORROW,
      });
      expect(diego).toMatchObject({
        role: 'CONSULTANT',
        expiresAt: TOMORROW,
        principal: { name: 'Carla Dias', isExternal: true },
      });
      expect(auditOf('process.participant_add').at(-1)).toMatchObject({
        metadata: { role: 'CONSULTANT', hasExpiresAt: true },
      });

      // A validade passou (o job ainda não rodou).
      const stored = activeOf(process.id)[0];
      if (!stored) throw new Error('consultor ausente');
      store().put({ ...stored, expiresAt: new Date(NOW.getTime() - 86_400_000) });
      const listed = await list(process.id);
      expect(data<ProcessParticipantDto[]>(listed)).toEqual([]);
      const panel = await auth(request(api.server).get(`/api/v1/processes/${process.id}/summary`));
      expect(data<{ counts: { participants: number } }>(panel).counts.participants).toBe(0);
    });

    it('Remover participante: revoga o ProcessAccess, timeline com o nome congelado, auditoria REVOKED; de novo = 404', async () => {
      const process = await newProcess();
      const elisa = await addOk(process.id, { userId: FAKE_USERS.otavio.id, role: 'OBSERVER' });
      const removed = await remove(elisa.id).send({ revocationReason: 'Parecer entregue' });
      expect(removed.status, JSON.stringify(removed.body)).toBe(204);
      expect(activeOf(process.id)).toEqual([]);
      expect(
        store()
          .all()
          .find((row) => row.id === elisa.id),
      ).toMatchObject({
        revokedAt: NOW,
        revokedById: FAKE_USERS.lucia.id,
        revocationReason: 'Parecer entregue',
      });
      expect(accessOf(process.id)).toEqual([]);
      expect(
        processRepositoryOf(api)
          .revokedAccessOf(process.id)
          .filter((row) => row.sourceId === elisa.id),
      ).toHaveLength(1);
      expect(timelineOf(process.id, 'PARTICIPANT_REMOVED')).toMatchObject([
        { params: { name: 'Otávio Campos', role: 'OBSERVER', reason: 'REVOKED' } },
      ]);
      expect(auditOf('process.participant_remove').at(-1)).toMatchObject({
        entityId: elisa.id,
        metadata: { reason: 'REVOKED' },
      });
      // A participação não dá mais visibilidade.
      const panel = await auth(
        request(api.server).get(`/api/v1/processes/${process.id}/summary`),
        SUB.otavio,
      );
      expectProblem(panel, 404, 'PROCESS_NOT_FOUND');

      expectProblem(await remove(elisa.id), 404, 'PARTICIPANT_NOT_FOUND');
    });

    it('Unidade participante: concessão DEPARTMENT/PARTICIPANT; para Consultor, não elegível', async () => {
      const process = await newProcess();
      const unit = await addOk(process.id, { departmentId: UNITS_A.saude, role: 'OBSERVER' });
      expect(unit).toMatchObject({
        principalType: 'DEPARTMENT',
        departmentId: UNITS_A.saude,
        principal: { id: UNITS_A.saude, isExternal: false },
      });
      expect(accessOf(process.id)).toMatchObject([
        { principalType: 'DEPARTMENT', departmentId: UNITS_A.saude, sourceId: unit.id },
      ]);
      const consultant = await add(process.id, {
        departmentId: UNITS_A.posto,
        role: 'CONSULTANT',
        expiresAt: TOMORROW,
      });
      const problem = expectProblem(consultant, 422, 'PARTICIPANT_NOT_ELIGIBLE');
      expect(problem.detail).toBe('Este usuário não pode receber o papel de Consultor.');
    });

    it('USR-02: pessoas ativas do tenant por nome, com o tipo de vínculo', async () => {
      const found = await auth(request(api.server).get('/api/v1/users/lookup?q=campos'), SUB.fabio);
      expect(found.status, JSON.stringify(found.body)).toBe(200);
      expect(z.array(userLookupItemSchema).parse(data(found))).toEqual([
        {
          id: FAKE_USERS.otavio.id,
          name: 'Otávio Campos',
          email: expect.any(String) as string,
          membershipType: 'INTERNAL',
          membershipExpiresAt: null,
        },
      ]);
      expectProblem(
        await auth(request(api.server).get('/api/v1/users/lookup?q=e'), SUB.fabio),
        422,
        'VALIDATION_ERROR',
      );
    });
  });

  describe('[Validação]', () => {
    it('Consultor sem validade: 422 CONDITIONAL_REQUIRED em expiresAt e nenhum participante criado', async () => {
      const process = await newProcess();
      const response = await add(process.id, { userId: FAKE_USERS.carla.id, role: 'CONSULTANT' });
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toEqual([['expiresAt', 'CONDITIONAL_REQUIRED']]);
      expect(activeOf(process.id)).toEqual([]);
      expect(eventsOf(process.id, 'ProcessParticipantAdded')).toEqual([]);
    });

    it('V-01/V-02 e validade: papel fora do enum, alvo ausente ou duplo, validade no passado ou em outro papel', async () => {
      const process = await newProcess();
      expect(
        fieldErrors(await add(process.id, { userId: FAKE_USERS.otavio.id, role: 'OWNER' })),
      ).toEqual([['role', 'INVALID_ENUM']]);
      expect(fieldErrors(await add(process.id, { role: 'OBSERVER' }))).toEqual([
        ['userId', 'REQUIRED'],
      ]);
      expect(
        fieldErrors(
          await add(process.id, {
            userId: FAKE_USERS.otavio.id,
            departmentId: UNITS_A.saude,
            role: 'OBSERVER',
          }),
        ),
      ).toEqual([['departmentId', 'NOT_ALLOWED']]);
      expect(
        fieldErrors(
          await add(process.id, {
            userId: FAKE_USERS.carla.id,
            role: 'CONSULTANT',
            expiresAt: '2025-11-19T00:00:00.000Z',
          }),
        ),
      ).toEqual([['expiresAt', 'DATE_IN_PAST']]);
      expect(
        fieldErrors(
          await add(process.id, {
            userId: FAKE_USERS.otavio.id,
            role: 'OBSERVER',
            expiresAt: TOMORROW,
          }),
        ),
      ).toEqual([['expiresAt', 'NOT_ALLOWED']]);
      expect(activeOf(process.id)).toEqual([]);
    });

    it('V-04/V-05: consultor sem vínculo EXTERNAL ou além da validade do vínculo, e autoinclusão como colaboradora', async () => {
      const process = await newProcess();
      const internal = expectProblem(
        await add(process.id, {
          userId: FAKE_USERS.otavio.id,
          role: 'CONSULTANT',
          expiresAt: TOMORROW,
        }),
        422,
        'PARTICIPANT_NOT_ELIGIBLE',
      );
      expect(internal.detail).toBe('Este usuário não pode receber o papel de Consultor.');
      expectProblem(
        await add(process.id, {
          userId: FAKE_USERS.carla.id,
          role: 'CONSULTANT',
          expiresAt: '2026-02-01T00:00:00.000Z',
        }),
        422,
        'PARTICIPANT_NOT_ELIGIBLE',
      );
      const self = expectProblem(
        await add(process.id, { userId: FAKE_USERS.lucia.id, role: 'COLLABORATOR' }),
        422,
        'PARTICIPANT_NOT_ELIGIBLE',
      );
      expect(self.detail).toBe('Você não pode se adicionar com este papel.');
      // Usuário suspenso: referência inativa.
      expect(
        fieldErrors(await add(process.id, { userId: FAKE_USERS.bruno.id, role: 'OBSERVER' })),
      ).toEqual([['userId', 'REFERENCE_INACTIVE']]);
      expect(activeOf(process.id)).toEqual([]);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem PROCESS_MANAGE_PARTICIPANTS: 403 PERMISSION_DENIED e access.denied PROCESS_MANAGE_PARTICIPANTS', async () => {
      const process = await newProcess();
      const response = await add(
        process.id,
        { userId: FAKE_USERS.otavio.id, role: 'OBSERVER' },
        { subject: SUB.fabio },
      );
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(auditOf('access.denied').at(-1)).toMatchObject({
        reasonCode: 'PROCESS_MANAGE_PARTICIPANTS',
      });
      expect(activeOf(process.id)).toEqual([]);

      const elisa = await addOk(process.id, { userId: FAKE_USERS.otavio.id, role: 'COLLABORATOR' });
      expectProblem(await remove(elisa.id, SUB.fabio), 403, 'PERMISSION_DENIED');
      expect(auditOf('access.denied').at(-1)).toMatchObject({
        reasonCode: 'PROCESS_MANAGE_PARTICIPANTS',
      });
      // Colaboradora não sai por "deixar de seguir" (RN-PROC-133) nem gerencia os demais.
      const unfollowed = expectProblem(
        await unfollow(process.id, SUB.otavio),
        403,
        'PERMISSION_DENIED',
      );
      expect(unfollowed.detail).toMatch(/outro papel/);
      expect(activeOf(process.id)).toHaveLength(1);
      // A lista (PROCESS_VIEW) segue visível em modo leitura.
      const listed = await list(process.id, SUB.fabio);
      expect(listed.status).toBe(200);
      expect((listed.body as { meta: { canManage: boolean } }).meta.canManage).toBe(false);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Usuária de outro tenant: 422 REFERENCE_NOT_FOUND em userId sem revelar que existe lá; unidade de B idem', async () => {
      const process = await newProcess();
      const grace = await add(process.id, { userId: FAKE_USERS.heitor.id, role: 'OBSERVER' });
      const problem = expectProblem(grace, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(grace)).toEqual([['userId', 'REFERENCE_NOT_FOUND']]);
      expect(JSON.stringify(problem)).not.toMatch(/Heitor|Prefeitura B/);
      expect(
        fieldErrors(await add(process.id, { departmentId: UNITS_B.saude, role: 'OBSERVER' })),
      ).toEqual([['departmentId', 'REFERENCE_NOT_FOUND']]);
      // Busca de pessoas: quem só existe em B não aparece em A.
      const lookup = await auth(request(api.server).get('/api/v1/users/lookup?q=heitor'));
      expect(data(lookup)).toEqual([]);
    });

    it('Gestor de B não lista, não adiciona, não segue nem remove participante de processo de A', async () => {
      const process = await newProcess();
      const elisa = await addOk(process.id, { userId: FAKE_USERS.otavio.id, role: 'OBSERVER' });
      expectProblem(await list(process.id, SUB.heitor, B), 404, 'PROCESS_NOT_FOUND');
      expectProblem(
        await add(
          process.id,
          { userId: FAKE_USERS.heitor.id, role: 'OBSERVER' },
          { subject: SUB.heitor, tenant: B },
        ),
        404,
        'PROCESS_NOT_FOUND',
      );
      expectProblem(await remove(elisa.id, SUB.heitor, B), 404, 'PARTICIPANT_NOT_FOUND');
      expect(activeOf(process.id)).toHaveLength(1);
    });
  });

  describe('[Duplicidade]', () => {
    it('Participante já ativo, mesmo com outro papel: 409 PARTICIPANT_ALREADY_EXISTS com o papel atual, sem alterar', async () => {
      const process = await newProcess();
      const elisa = await addOk(process.id, { userId: FAKE_USERS.otavio.id, role: 'COLLABORATOR' });
      const again = await add(process.id, { userId: FAKE_USERS.otavio.id, role: 'OBSERVER' });
      const problem = expectProblem(again, 409, 'PARTICIPANT_ALREADY_EXISTS');
      expect(problem.meta).toEqual({ currentRole: 'COLLABORATOR' });
      expect(activeOf(process.id)).toMatchObject([{ id: elisa.id, role: 'COLLABORATOR' }]);
    });

    it('Seguir quem já participa: 200 com o participante existente, sem novo evento', async () => {
      const process = await newProcess();
      const elisa = await addOk(process.id, { userId: FAKE_USERS.otavio.id, role: 'COLLABORATOR' });
      const events = eventsOf(process.id, 'ProcessParticipantAdded').length;
      const followed = await follow(process.id, SUB.otavio);
      expect(followed.status, JSON.stringify(followed.body)).toBe(200);
      expect(data<ProcessParticipantDto>(followed)).toMatchObject({
        id: elisa.id,
        role: 'COLLABORATOR',
      });
      expect(eventsOf(process.id, 'ProcessParticipantAdded')).toHaveLength(events);
      expect(activeOf(process.id)).toHaveLength(1);
    });

    it('Mesma Idempotency-Key: a repetição devolve a resposta original sem duplicar', async () => {
      const process = await newProcess();
      const key = randomUUID();
      const body = { userId: FAKE_USERS.otavio.id, role: 'OBSERVER' };
      const first = await add(process.id, body, { key });
      const second = await add(process.id, body, { key });
      expect([first.status, second.status]).toEqual([201, 201]);
      expect(data<ProcessParticipantDto>(second).id).toBe(data<ProcessParticipantDto>(first).id);
      expect(activeOf(process.id)).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Duas concessões simultâneas para o mesmo usuário por gestores distintos: uma 201, outra 409, um único ativo', async () => {
      const process = await newProcess();
      const body = { userId: FAKE_USERS.marta.id, role: 'OBSERVER' };
      const responses = await Promise.all([
        add(process.id, body, { subject: SUB.lucia }).then((response) => response),
        add(process.id, body, { subject: SUB.ana }).then((response) => response),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const conflict = responses.find((response) => response.status === 409);
      expect(problemDetailsSchema.parse(conflict?.body).code).toBe('PARTICIPANT_ALREADY_EXISTS');
      expect(activeOf(process.id).filter((row) => row.userId === FAKE_USERS.marta.id)).toHaveLength(
        1,
      );
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao adicionar: 503 DEPENDENCY_UNAVAILABLE e nada persistido', async () => {
      const process = await newProcess();
      transactions.down = true;
      const response = await add(process.id, { userId: FAKE_USERS.otavio.id, role: 'OBSERVER' });
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(activeOf(process.id)).toEqual([]);
      expect(accessOf(process.id)).toEqual([]);
      expect(eventsOf(process.id, 'ProcessParticipantAdded')).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: 201 e o evento fica no outbox até o relay voltar', async () => {
      const process = await newProcess();
      const elisa = await addOk(process.id, { userId: FAKE_USERS.otavio.id, role: 'OBSERVER' });
      // O caso de uso só grava no outbox (sem relay em memória); a publicação é assíncrona.
      expect(eventsOf(process.id, 'ProcessParticipantAdded')).toMatchObject([
        { payload: { participantId: elisa.id } },
      ]);
    });
  });
});
