import { randomUUID } from 'node:crypto';

import {
  etpAlternativeListMetaSchema,
  etpAlternativeSchema,
  etpDetailSchema,
  etpSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type { EtpAlternativeDto, EtpDto, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { z } from 'zod';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  DOCUMENT_CLOCK,
  DOCUMENT_TRANSACTIONS,
  documentRepositoryOf,
} from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedParticipant,
  seedProcessStructure,
  timelineRowsOf,
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { ETP_CLOCK, ETP_TRANSACTIONS } from '../application/ports.js';

/*
 * US-021 — Gerenciar alternativas de solução, pelo pipeline HTTP completo (autenticação, tenant,
 * vínculo, autorização, `If-Match`, filtro RFC 9457) com a identidade fake, os seeders reais e o
 * ETP criado pelo ETP-02 no processo levado aos estudos preliminares. ETP-05..09 nas 8 categorias
 * do Gherkin + FA-01..05, V-01..V-09, auditoria `etp.alternative_*`, `EtpAlternativeRecommended` e a
 * timeline. Lúcia (PLANEJAMENTO, custódia) é a "Carla"; Otávio (SOMENTE_LEITURA) é o "Bruno"; Ana
 * (REQUISITANTE, com ETP_UPDATE) é a colaboradora. Os índices únicos parciais, o CHECK da
 * justificativa e a RLS no PostgreSQL: `test/tenant-leak/etp-alternatives.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-18T15:00:00.000Z');
const CARLA = 'sub-lucia';
const BRUNO = 'sub-otavio';
const ANA = 'sub-ana';
const JUSTIFICATION_40 = 'A locação reduz o custo total do período.';
const SECRET_TEXT = 'Locação mensal com manutenção preventiva inclusa';

const UNITS_A = {
  organizationId: '0192d021-0000-7000-8000-0000000000a0',
  obras: '0192d021-0000-7000-8000-0000000000a1',
  manutencao: '0192d021-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d021-0000-7000-8000-0000000000a3',
  saude: '0192d021-0000-7000-8000-0000000000a4',
  posto: '0192d021-0000-7000-8000-0000000000a5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações que podem simular o banco fora do ar (documento e ETP). */
class FlakyTransactions {
  down = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
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

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

const LIST_RESPONSE = z.object({
  data: z.array(etpAlternativeSchema),
  meta: etpAlternativeListMetaSchema,
});

describe('Feature: Gerenciar alternativas de solução (US-021)', () => {
  let api: TestApi;
  const documents = new FlakyTransactions();
  const etps = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string };
  let log: MockInstance<Logger['log']>;
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = CARLA, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const list = (etpId: string, subject = CARLA, tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/etps/${etpId}/alternatives`), subject, tenant);
  const create = (
    etpId: string,
    body: Record<string, unknown>,
    subject = CARLA,
    tenant: string = A,
  ) =>
    auth(request(api.server).post(`/api/v1/etps/${etpId}/alternatives`), subject, tenant).send(
      body,
    );
  const patch = (
    id: string,
    body: Record<string, unknown>,
    options: { ifMatch: number | string; subject?: string; tenant?: string },
  ) =>
    auth(
      request(api.server).patch(`/api/v1/etp-alternatives/${id}`),
      options.subject,
      options.tenant,
    )
      .set('If-Match', `"${String(options.ifMatch)}"`)
      .send(body);
  const remove = (id: string, options: { ifMatch: number; subject?: string; tenant?: string }) =>
    auth(
      request(api.server).delete(`/api/v1/etp-alternatives/${id}`),
      options.subject,
      options.tenant,
    ).set('If-Match', `"${String(options.ifMatch)}"`);
  const decide = (
    id: string,
    body: Record<string, unknown>,
    options: { ifMatch: number; subject?: string; tenant?: string },
  ) =>
    auth(
      request(api.server).post(`/api/v1/etp-alternatives/${id}/decide`),
      options.subject,
      options.tenant,
    )
      .set('If-Match', `"${String(options.ifMatch)}"`)
      .send(body);

  const alternative = (name = 'Locação de equipamentos', extra: Record<string, unknown> = {}) => ({
    name,
    description: paragraph(SECRET_TEXT),
    ...extra,
  });

  async function createOk(etpId: string, body = alternative(), subject = CARLA) {
    const response = await create(etpId, body, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return etpAlternativeSchema.parse(data(response));
  }

  async function listOf(etpId: string, subject = CARLA) {
    const response = await list(etpId, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return LIST_RESPONSE.parse(response.body);
  }

  async function etpHeader(etpId: string) {
    const response = await auth(request(api.server).get(`/api/v1/etps/${etpId}`));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return etpDetailSchema.parse(data(response));
  }

  const auditOf = (processId: string, action?: string) =>
    api
      .auditRecords()
      .filter(
        (row) =>
          row.processId === processId &&
          row.action.startsWith('etp.alternative_') &&
          (action === undefined || row.action === action),
      );
  const eventsOf = (processId: string) =>
    api
      .outboxRows()
      .filter(
        (row) => row.processId === processId && row.eventType === 'EtpAlternativeRecommended',
      );
  const stageId = (process: Process, key: string) =>
    workflowStagesOf(api, A).find(
      (candidate) =>
        candidate.key === key && candidate.workflowVersionId === process.workflowVersionId,
    )?.id ?? null;
  const documentOf = (documentId: string) => {
    const found = documentRepositoryOf(api)
      .allDocuments()
      .find((candidate) => candidate.id === documentId);
    if (!found) throw new Error('documento ausente');
    return found;
  };

  /** Processo (PRC-02, Ana) nos estudos preliminares sob custódia da Carla + o ETP (ETP-02). */
  async function background(options: { confidential?: boolean } = {}) {
    const response = await auth(request(api.server).post('/api/v1/processes'), ANA)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Locação de equipamentos ${words(2)}`,
        object: `Contratação de equipamentos de manutenção predial ${words(2)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalog.origin,
        priority: 'MEDIUM',
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === data<ProcessDto>(response).id);
    if (!created) throw new Error('processo ausente');
    const process = {
      ...created,
      status: 'IN_PROGRESS' as const,
      currentWorkflowStageId: stageId(created, 'ESTUDOS_PRELIMINARES'),
      currentResponsibleId: FAKE_USERS.lucia.id,
      isBudgetConfidential: options.confidential === true,
    };
    processRepositoryOf(api).replace(process);
    const etpResponse = await auth(request(api.server).post(`/api/v1/processes/${process.id}/etps`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(etpResponse.status, JSON.stringify(etpResponse.body)).toBe(201);
    return { process, etp: etpSchema.parse(data<EtpDto>(etpResponse)) };
  }

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: DOCUMENT_TRANSACTIONS, value: documents },
        { token: ETP_TRANSACTIONS, value: etps },
        { token: ETP_CLOCK, value: () => NOW },
        { token: DOCUMENT_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A, [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
    ]);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    const roles = seedDefaultRolesOf(api, A);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.lucia.id),
      roleId: roles.get('PLANEJAMENTO')?.id ?? '',
    });
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: roles.get('SOMENTE_LEITURA')?.id ?? '',
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
    documents.down = false;
    etps.down = false;
    log.mockClear();
  });

  describe('[Sucesso]', () => {
    it('Criar e recomendar: RECOMMENDED, recommendedAlternativeId no ETP, EtpAlternativeRecommended, etp.alternative_decide e timeline', async () => {
      const { process, etp } = await background();
      const response = await create(
        etp.id,
        alternative('Locação de equipamentos', { estimatedCost: '15000.00', riskLevel: 'LOW' }),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.headers.etag).toBe('"1"');
      const created = etpAlternativeSchema.parse(data(response));
      expect(response.headers.location).toBe(`/api/v1/etp-alternatives/${created.id}`);
      expect(created).toMatchObject({
        etpId: etp.id,
        processId: process.id,
        decision: 'UNDER_ANALYSIS',
        decisionJustification: null,
        estimatedCost: '15000.00',
        estimatedCostMasked: false,
        riskLevel: 'LOW',
        sortOrder: 0,
        version: 1,
      });
      const [createAudit] = auditOf(process.id, 'etp.alternative_create');
      expect(createAudit?.changes).toEqual(
        expect.arrayContaining([
          { path: 'name', old: null, new: 'Locação de equipamentos' },
          { path: 'riskLevel', old: null, new: 'LOW' },
          {
            path: 'description',
            old: null,
            new: { sha256: expect.any(String) as string, length: SECRET_TEXT.length },
          },
          { path: 'estimatedCost', old: null, new: '[sigiloso]' },
        ]),
      );
      // Sem evento na criação (api/06-etp.md ETP-06).
      expect(eventsOf(process.id)).toEqual([]);

      const decided = await decide(
        created.id,
        { decision: 'RECOMMENDED', decisionJustification: JUSTIFICATION_40 },
        { ifMatch: created.version },
      );
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      expect(decided.headers.etag).toBe('"2"');
      expect(etpAlternativeSchema.parse(data(decided))).toMatchObject({
        decision: 'RECOMMENDED',
        decisionJustification: JUSTIFICATION_40,
        version: 2,
      });
      expect((await etpHeader(etp.id)).recommendedAlternativeId).toBe(created.id);
      expect(eventsOf(process.id)).toMatchObject([
        {
          aggregateType: 'Etp',
          aggregateId: etp.id,
          routingKey: 'etp.alternative_recommended',
          payload: { etpId: etp.id, alternativeId: created.id },
        },
      ]);
      expect(eventsOf(process.id)[0]?.payload).not.toHaveProperty('previousAlternativeId');
      expect(auditOf(process.id, 'etp.alternative_decide')).toMatchObject([
        { metadata: { decision: 'RECOMMENDED', replaceRecommended: false } },
      ]);
      expect(
        timelineRowsOf(api).filter(
          (row) => row.processId === process.id && row.type === 'ETP_ALTERNATIVE_RECOMMENDED',
        ),
      ).toEqual([expect.objectContaining({ params: { name: 'Locação de equipamentos' } })]);
      // Logs sem textos, justificativa nem custo (story · "Logs").
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).toContain('etp.alternative_decided');
      expect(logged).not.toContain(JUSTIFICATION_40);
      expect(logged).not.toContain(SECRET_TEXT);
      expect(logged).not.toContain('15000');

      const listed = await listOf(etp.id);
      expect(listed.meta).toEqual({
        canManage: true,
        recommendedAlternativeId: created.id,
        estimatedCostMasked: false,
      });
      expect(listed.data.map((row) => row.id)).toEqual([created.id]);
    });

    it('Quadro comparativo: ordem por sortOrder, reordenação (ETP-07) e edição com auditoria dos campos alterados', async () => {
      const { process, etp } = await background();
      const first = await createOk(etp.id, alternative('Locação de equipamentos'));
      const second = await createOk(etp.id, alternative('Aquisição direta'));
      const third = await createOk(etp.id, alternative('Comodato'));
      expect([first.sortOrder, second.sortOrder, third.sortOrder]).toEqual([0, 1, 2]);
      const moved = await patch(third.id, { sortOrder: 0 }, { ifMatch: third.version });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      await patch(first.id, { sortOrder: 1 }, { ifMatch: first.version });
      await patch(second.id, { sortOrder: 2 }, { ifMatch: second.version });
      expect((await listOf(etp.id)).data.map((row) => row.name)).toEqual([
        'Comodato',
        'Locação de equipamentos',
        'Aquisição direta',
      ]);

      const edited = await patch(
        second.id,
        { estimatedCost: '9800.5', riskLevel: 'MEDIUM', observations: 'Prazo de entrega longo.' },
        { ifMatch: 2 },
      );
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.headers.etag).toBe('"3"');
      expect(etpAlternativeSchema.parse(data(edited))).toMatchObject({
        estimatedCost: '9800.50',
        riskLevel: 'MEDIUM',
        observations: 'Prazo de entrega longo.',
      });
      const updates = auditOf(process.id, 'etp.alternative_update');
      expect(
        (updates.at(-1)?.changes as unknown as readonly { path: string }[]).map(
          (change) => change.path,
        ),
      ).toEqual(['estimatedCost', 'riskLevel', 'observations']);
      expect(JSON.stringify(updates.at(-1))).not.toContain('Prazo de entrega');
      expect(JSON.stringify(updates.at(-1))).not.toContain('9800');

      // Sem mudança: 200 com a mesma versão e sem auditoria.
      const same = await patch(second.id, { riskLevel: 'MEDIUM' }, { ifMatch: 3 });
      expect(same.status, JSON.stringify(same.body)).toBe(200);
      expect(same.headers.etag).toBe('"3"');
      expect(auditOf(process.id, 'etp.alternative_update')).toHaveLength(updates.length);
    });

    it('FA-01: substituir a recomendada numa operação só — a antiga volta a UNDER_ANALYSIS, previousAlternativeId no evento', async () => {
      const { process, etp } = await background();
      const first = await createOk(etp.id, alternative('Locação de equipamentos'));
      const second = await createOk(etp.id, alternative('Aquisição direta'));
      const recommended = await decide(
        first.id,
        { decision: 'RECOMMENDED', decisionJustification: JUSTIFICATION_40 },
        { ifMatch: 1 },
      );
      expect(recommended.status, JSON.stringify(recommended.body)).toBe(200);

      const blocked = await decide(
        second.id,
        { decision: 'RECOMMENDED', decisionJustification: 'Melhor custo-benefício levantado.' },
        { ifMatch: 1 },
      );
      const problem = expectProblem(blocked, 409, 'RECOMMENDED_ALTERNATIVE_EXISTS');
      expect(problem.detail).toBe('Já existe uma alternativa recomendada. Substituir pela atual?');
      expect((problem as { meta?: unknown }).meta).toEqual({ recommendedAlternativeId: first.id });

      const replaced = await decide(
        second.id,
        {
          decision: 'RECOMMENDED',
          decisionJustification: 'Melhor custo-benefício levantado.',
          replaceRecommended: true,
        },
        { ifMatch: 1 },
      );
      expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
      const rows = (await listOf(etp.id)).data;
      expect(rows.find((row) => row.id === first.id)).toMatchObject({
        decision: 'UNDER_ANALYSIS',
        // O histórico da decisão anterior fica preservado.
        decisionJustification: JUSTIFICATION_40,
        version: 3,
      });
      expect(rows.find((row) => row.id === second.id)?.decision).toBe('RECOMMENDED');
      expect(rows.filter((row) => row.decision === 'RECOMMENDED')).toHaveLength(1);
      expect((await etpHeader(etp.id)).recommendedAlternativeId).toBe(second.id);
      expect(eventsOf(process.id).at(-1)?.payload).toEqual({
        etpId: etp.id,
        alternativeId: second.id,
        previousAlternativeId: first.id,
      });
      expect(auditOf(process.id, 'etp.alternative_decide').at(-1)?.metadata).toMatchObject({
        decision: 'RECOMMENDED',
        replaceRecommended: true,
        previousAlternativeId: first.id,
      });
    });

    it('FA-02: uma única alternativa pode ser recomendada; FA-03: excluir a recomendada exige mudar a decisão', async () => {
      const { process, etp } = await background();
      const only = await createOk(etp.id);
      const ok = await decide(
        only.id,
        { decision: 'RECOMMENDED', decisionJustification: JUSTIFICATION_40 },
        { ifMatch: 1 },
      );
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);

      const blocked = expectProblem(await remove(only.id, { ifMatch: 2 }), 409, 'INVALID_STATE');
      expect(blocked.detail).toBe('Altere a decisão desta alternativa antes de excluí-la.');

      const back = await decide(only.id, { decision: 'UNDER_ANALYSIS' }, { ifMatch: 2 });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      expect((await etpHeader(etp.id)).recommendedAlternativeId).toBeNull();
      const removed = await remove(only.id, { ifMatch: 3 });
      expect(removed.status, JSON.stringify(removed.body)).toBe(204);
      expect((await listOf(etp.id)).data).toEqual([]);
      expect(auditOf(process.id, 'etp.alternative_delete')).toMatchObject([
        { entityId: only.id, metadata: { alternativeId: only.id } },
      ]);
      // A excluída some das rotas (404) e o nome volta a ficar livre.
      expectProblem(await patch(only.id, { name: 'X' }, { ifMatch: 4 }), 404, 'NOT_FOUND');
      await createOk(etp.id);
    });

    it('Descartar com justificativa: DISCARDED sem evento', async () => {
      const { process, etp } = await background();
      const created = await createOk(etp.id);
      const response = await decide(
        created.id,
        { decision: 'DISCARDED', decisionJustification: 'Custo de manutenção alto demais.' },
        { ifMatch: 1 },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<EtpAlternativeDto>(response).decision).toBe('DISCARDED');
      expect(eventsOf(process.id)).toEqual([]);
      expect(auditOf(process.id, 'etp.alternative_decide')).toHaveLength(1);
    });

    it('Colaboradora convidada (participação COLLABORATOR) com ETP_UPDATE cria sem custódia', async () => {
      const { process, etp } = await background();
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      await createOk(etp.id, alternative(), ANA);
    });
  });

  describe('[Validação]', () => {
    it('Decidir sem justificativa: 422 com a mensagem da story e a decisão permanece UNDER_ANALYSIS', async () => {
      const { process, etp } = await background();
      const created = await createOk(etp.id, alternative('Aquisição direta'));
      const problem = expectProblem(
        await decide(created.id, { decision: 'DISCARDED' }, { ifMatch: 1 }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({
          field: 'decisionJustification',
          code: 'CONDITIONAL_REQUIRED',
          message: 'Justifique a decisão (mín. 20 caracteres).',
        }),
      ]);
      const short = expectProblem(
        await decide(
          created.id,
          { decision: 'RECOMMENDED', decisionJustification: 'curta' },
          { ifMatch: 1 },
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(short.errors[0]?.code).toBe('TOO_SHORT');
      expect((await listOf(etp.id)).data[0]).toMatchObject({
        decision: 'UNDER_ANALYSIS',
        version: 1,
      });
      expect(auditOf(process.id, 'etp.alternative_decide')).toEqual([]);
    });

    it('V-01/V-02/V-07: nome, descrição e custo inválidos → 422 com as mensagens da story', async () => {
      const { etp } = await background();
      const invalid = expectProblem(
        await create(etp.id, {
          name: 'x'.repeat(151),
          description: { type: 'doc', content: [] },
          estimatedCost: '-10.555',
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(invalid.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'name',
            message: 'Informe um nome de até 150 caracteres para a alternativa.',
          }),
          expect.objectContaining({
            field: 'description',
            code: 'REQUIRED',
            message: 'Descreva a alternativa.',
          }),
          expect.objectContaining({
            field: 'estimatedCost',
            code: 'INVALID_DECIMAL',
            message: 'Informe um valor válido, com até 2 casas decimais.',
          }),
        ]),
      );
      expectProblem(
        await create(etp.id, { ...alternative(), decision: 'RECOMMENDED' }),
        422,
        'VALIDATION_ERROR',
      );
      expect((await listOf(etp.id)).data).toEqual([]);
    });
  });

  describe('[Permissão]', () => {
    it('Bruno (SOMENTE_LEITURA): lê em modo somente leitura (canManage false) e a criação responde 403 PERMISSION_DENIED com access.denied', async () => {
      const { process, etp } = await background();
      const listed = await listOf(etp.id, BRUNO);
      expect(listed.meta.canManage).toBe(false);
      const problem = expectProblem(
        await create(etp.id, alternative(), BRUNO),
        403,
        'PERMISSION_DENIED',
      );
      expect(problem.detail).toBe('Você não pode editar as alternativas deste ETP.');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'ETP_UPDATE',
      });
      expect(auditOf(process.id)).toEqual([]);
    });

    it('Com ETP_UPDATE mas sem custódia nem participação: 403 com access.denied POL-02', async () => {
      const { etp } = await background();
      expect(await create(etp.id, alternative(), ANA).then((r) => r.status)).toBe(403);
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'POL-02',
      });
    });

    it('FA-05: ETP em revisão abre somente leitura e as mutações respondem 409 DOCUMENT_NOT_EDITABLE', async () => {
      const { etp } = await background();
      const created = await createOk(etp.id);
      documentRepositoryOf(api).seed({ ...documentOf(etp.documentId), status: 'IN_REVIEW' });
      expect((await listOf(etp.id)).meta.canManage).toBe(false);
      const problem = expectProblem(
        await create(etp.id, alternative('Outra')),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      expect(problem.detail).toBe('Este ETP não pode ser editado no status atual.');
      expectProblem(
        await patch(created.id, { name: 'Y' }, { ifMatch: 1 }),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      expectProblem(await remove(created.id, { ifMatch: 1 }), 409, 'DOCUMENT_NOT_EDITABLE');
      expectProblem(
        await decide(
          created.id,
          { decision: 'RECOMMENDED', decisionJustification: JUSTIFICATION_40 },
          { ifMatch: 1 },
        ),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
    });

    it('FA-04 (POL-09): processo sigiloso mascara o custo para a colaboradora, que também não o altera', async () => {
      const { process, etp } = await background({ confidential: true });
      const created = await createOk(
        etp.id,
        alternative('Locação de equipamentos', { estimatedCost: '15000.00' }),
      );
      // A custodiante vê o valor.
      expect(created).toMatchObject({ estimatedCost: '15000.00', estimatedCostMasked: false });
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      const masked = await listOf(etp.id, ANA);
      expect(masked.data[0]).toMatchObject({ estimatedCost: null, estimatedCostMasked: true });
      expect(masked.meta.estimatedCostMasked).toBe(true);
      expect(JSON.stringify(masked)).not.toContain('15000');
      expectProblem(
        await patch(created.id, { estimatedCost: '1.00' }, { ifMatch: 1, subject: ANA }),
        403,
        'PERMISSION_DENIED',
      );
      const renamed = await patch(created.id, { name: 'Locação' }, { ifMatch: 1, subject: ANA });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      expect(data<EtpAlternativeDto>(renamed)).toMatchObject({
        estimatedCost: null,
        estimatedCostMasked: true,
      });
      expect((await listOf(etp.id)).data[0]?.estimatedCost).toBe('15000.00');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Alternativa de outro tenant: ETP-05..09 → 404 NOT_FOUND sem revelar nem alterar nada', async () => {
      const { process, etp } = await background();
      const created = await createOk(etp.id);
      // Fábio tem vínculo na Prefeitura B (CONSULTOR_EXTERNO).
      const options = { ifMatch: 1, subject: 'sub-fabio', tenant: B };
      const updated = expectProblem(
        await patch(created.id, { name: 'X' }, options),
        404,
        'NOT_FOUND',
      );
      expect(updated.detail).toBe('Alternativa não encontrada.');
      expect(JSON.stringify(updated)).not.toContain('Locação');
      expectProblem(await remove(created.id, options), 404, 'NOT_FOUND');
      expectProblem(
        await decide(
          created.id,
          { decision: 'DISCARDED', decisionJustification: JUSTIFICATION_40 },
          options,
        ),
        404,
        'NOT_FOUND',
      );
      expectProblem(await list(etp.id, 'sub-fabio', B), 404, 'NOT_FOUND');
      expectProblem(await create(etp.id, alternative('Y'), 'sub-fabio', B), 404, 'NOT_FOUND');
      expectProblem(await list(newId()), 404, 'NOT_FOUND');
      expect((await listOf(etp.id)).data[0]).toMatchObject({ name: created.name, version: 1 });
      expect(auditOf(process.id)).toHaveLength(1);
    });
  });

  describe('[Duplicidade]', () => {
    it('Nome repetido no mesmo ETP sem diferenciar maiúsculas: 422 DUPLICATE_IN_LIST em name e nada criado', async () => {
      const { process, etp } = await background();
      const first = await createOk(etp.id, alternative('Locação de equipamentos'));
      const other = await createOk(etp.id, alternative('Aquisição direta'));
      const problem = expectProblem(
        await create(etp.id, alternative('locação de equipamentos')),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        {
          field: 'name',
          code: 'DUPLICATE_IN_LIST',
          message: 'Já existe uma alternativa com este nome neste ETP.',
        },
      ]);
      expect((await listOf(etp.id)).data).toHaveLength(2);
      expect(auditOf(process.id, 'etp.alternative_create')).toHaveLength(2);
      // Renomear para o nome de outra também é recusado; a própria grafia nova não.
      expectProblem(
        await patch(other.id, { name: 'LOCAÇÃO DE EQUIPAMENTOS' }, { ifMatch: 1 }),
        422,
        'VALIDATION_ERROR',
      );
      const recased = await patch(first.id, { name: 'Locação de Equipamentos' }, { ifMatch: 1 });
      expect(recased.status, JSON.stringify(recased.body)).toBe(200);
    });
  });

  describe('[Concorrência]', () => {
    it('Duas recomendações simultâneas em alternativas diferentes: exatamente uma 200 e a outra 409 RECOMMENDED_ALTERNATIVE_EXISTS', async () => {
      const { process, etp } = await background();
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      const first = await createOk(etp.id, alternative('Locação de equipamentos'));
      const second = await createOk(etp.id, alternative('Aquisição direta'));
      const responses = await Promise.all([
        decide(
          first.id,
          { decision: 'RECOMMENDED', decisionJustification: JUSTIFICATION_40 },
          { ifMatch: 1 },
        ),
        decide(
          second.id,
          { decision: 'RECOMMENDED', decisionJustification: JUSTIFICATION_40 },
          { ifMatch: 1, subject: ANA },
        ),
      ]);
      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
      const conflicts = responses.filter((response) => response.status === 409);
      expect(conflicts).toHaveLength(1);
      expectProblem(conflicts[0] as request.Response, 409, 'RECOMMENDED_ALTERNATIVE_EXISTS');
      const rows = (await listOf(etp.id)).data;
      expect(rows.filter((row) => row.decision === 'RECOMMENDED')).toHaveLength(1);
      expect(eventsOf(process.id)).toHaveLength(1);
    });

    it('V-09: If-Match divergente em editar, excluir e decidir → 412 VERSION_CONFLICT com currentVersion', async () => {
      const { etp } = await background();
      const created = await createOk(etp.id);
      await patch(created.id, { riskLevel: 'HIGH' }, { ifMatch: 1 });
      for (const response of [
        await patch(created.id, { riskLevel: 'LOW' }, { ifMatch: 1 }),
        await remove(created.id, { ifMatch: 1 }),
        await decide(
          created.id,
          { decision: 'DISCARDED', decisionJustification: JUSTIFICATION_40 },
          { ifMatch: 1 },
        ),
      ]) {
        const problem = expectProblem(response, 412, 'VERSION_CONFLICT');
        expect(problem.detail).toBe(
          'Alguém alterou esta alternativa. Recarregue para ver as mudanças.',
        );
        expect((problem as { currentVersion?: number }).currentVersion).toBe(2);
      }
      // Sem If-Match: 428.
      const missing = await auth(
        request(api.server).delete(`/api/v1/etp-alternatives/${created.id}`),
      );
      expect(missing.status).toBe(428);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao decidir: 503 DEPENDENCY_UNAVAILABLE e a decisão anterior permanece', async () => {
      const { process, etp } = await background();
      const created = await createOk(etp.id);
      etps.down = true;
      expectProblem(
        await decide(
          created.id,
          { decision: 'RECOMMENDED', decisionJustification: JUSTIFICATION_40 },
          { ifMatch: 1 },
        ),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      expectProblem(await list(etp.id), 503, 'DEPENDENCY_UNAVAILABLE');
      etps.down = false;
      expect((await listOf(etp.id)).data[0]).toMatchObject({
        decision: 'UNDER_ANALYSIS',
        version: 1,
      });
      expect(eventsOf(process.id)).toEqual([]);
      expect(auditOf(process.id, 'etp.alternative_decide')).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: 200 e EtpAlternativeRecommended fica no outbox para publicação', async () => {
      // Sem relay no teste: a linha permanece para publicar (PENDING no PostgreSQL — tenant-leak).
      const { process, etp } = await background();
      const created = await createOk(etp.id);
      const response = await decide(
        created.id,
        { decision: 'RECOMMENDED', decisionJustification: JUSTIFICATION_40 },
        { ifMatch: 1 },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(eventsOf(process.id)).toMatchObject([
        { aggregateId: etp.id, payload: { alternativeId: created.id } },
      ]);
    });
  });
});
