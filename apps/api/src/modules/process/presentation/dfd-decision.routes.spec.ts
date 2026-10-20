import { randomUUID } from 'node:crypto';

import { dfdMetaSchema, problemDetailsSchema, processSchema } from '@contrataflow/validation';
import type {
  ApprovalDecisionOption,
  DfdDto,
  DfdMeta,
  ForwardedProcessDto,
  ProcessDto,
  ProcessItemDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { dfdRepositoryOf } from '../../../../test/support/ai-fixtures.js';
import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { APPROVAL_TRANSACTIONS } from '../../../../test/support/approval-fixtures.js';
import type { ApprovalTransactions } from '../../../../test/support/approval-fixtures.js';
import { documentRepositoryOf, runAsUser } from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedParticipant,
  seedProcessStructure,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import {
  fillDfdDraft,
  setDepartmentHead,
} from '../../../../test/support/process-forward-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedCustomRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { PROCESS_CLOCK } from '../application/ports.js';
import type { Process } from '../domain/process.js';

/*
 * US-017 — efeitos da decisão sobre o DFD (APV-03 de `APROVACAO_DFD`) pelo pipeline HTTP completo
 * com a identidade fake, os seeders reais (workflow padrão DEC-015, templates e tipos) e
 * repositórios em memória — as 8 categorias do Gherkin. Ana = a requisitante (com
 * `DOCUMENT_REOPEN` por perfil), Marta = a titular da Secretaria de Obras (aprovadora), Fábio = a
 * "Carla" do Gherkin (SOMENTE_LEITURA, consultora do processo, sem custódia nem POL-09). Rollback real, RLS e outbox no PostgreSQL:
 * `test/tenant-leak/dfd-decision-effects.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T15:00:00.000Z');
const REJECT_REASON = 'Demanda já atendida por contrato vigente';

const ORG_A = '0192d017-0000-7000-8000-0000000000a0';
const ORG_B = '0192d017-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d017-0000-7000-8000-0000000000a1',
  manutencao: '0192d017-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d017-0000-7000-8000-0000000000a3',
  saude: '0192d017-0000-7000-8000-0000000000a4',
  posto: '0192d017-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d017-0000-7000-8000-0000000000b1',
  manutencao: '0192d017-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d017-0000-7000-8000-0000000000b3',
  saude: '0192d017-0000-7000-8000-0000000000b4',
  posto: '0192d017-0000-7000-8000-0000000000b5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações do `approval` com o banco que pode cair (Falha de banco). */
class FlakyApprovalTransactions implements ApprovalTransactions {
  down = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
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

describe('Feature: Tratar decisão sobre o DFD e propagar dados ao processo (US-017)', () => {
  let api: TestApi;
  const transactions = new FlakyApprovalTransactions();
  let catalog: { contractingType: string; origin: string; unit: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = 'sub-ana', tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const stored = (id: string): Process => {
    const process = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === id);
    if (!process) throw new Error(`processo ${id} ausente`);
    return process;
  };
  const storedDocument = (id: string) => {
    const document = documentRepositoryOf(api)
      .allDocuments()
      .find((candidate) => candidate.id === id);
    if (!document) throw new Error(`documento ${id} ausente`);
    return document;
  };
  const storedDfd = (id: string) => {
    const dfd = dfdRepositoryOf(api)
      .snapshot()
      .find((candidate) => candidate.id === id);
    if (!dfd) throw new Error(`DFD ${id} ausente`);
    return dfd;
  };
  const eventsOf = (processId: string, eventType: string) =>
    api.outboxRows().filter((row) => row.processId === processId && row.eventType === eventType);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const timelineOf = (processId: string, type: string) =>
    timelineRowsOf(api).filter((row) => row.processId === processId && row.type === type);
  const itemsOf = async (processId: string) => {
    const response = await auth(request(api.server).get(`/api/v1/processes/${processId}/items`));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return data<ProcessItemDto[]>(response);
  };
  const processView = async (processId: string, subject = 'sub-ana') => {
    const response = await auth(request(api.server).get(`/api/v1/processes/${processId}`), subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return processSchema.parse(data<ProcessDto>(response));
  };
  const dfdView = async (dfdId: string, subject = 'sub-ana') => {
    const response = await auth(request(api.server).get(`/api/v1/dfds/${dfdId}`), subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body as { data: DfdDto; meta: DfdMeta };
    return { dfd: body.data, meta: dfdMetaSchema.parse(body.meta) };
  };
  /** O processo como o teste o prepara (fonte de valor, sigilo) — direto no repositório. */
  const patchProcess = (processId: string, changes: Partial<Process>) =>
    runAsUser(
      { tenantId: A, userId: FAKE_USERS.ana.id, membershipId: membershipOf(FAKE_USERS.ana.id) },
      async (tx) => {
        const current = stored(processId);
        const saved = await processRepositoryOf(api).updateProcess(
          tx,
          { ...current, ...changes, version: current.version + 1 },
          current.version,
        );
        if (!saved) throw new Error('processo não atualizado');
      },
    );

  const decisionOption = async (approvalId: string, decision: string) => {
    const response = await auth(
      request(api.server).get(`/api/v1/approvals/${approvalId}`),
      'sub-marta',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const options = (response.body as { meta: { decisionOptions: ApprovalDecisionOption[] } }).meta
      .decisionOptions;
    const option = options.find((candidate) => candidate.decision === decision);
    if (!option) throw new Error(`decisão ${decision} indisponível`);
    return option;
  };
  const decide = async (
    approvalId: string,
    decision: 'APPROVE' | 'RETURN' | 'REJECT',
    options: {
      comment?: string;
      key?: string;
      tenant?: string;
      subject?: string;
      transitionId?: string | null;
    } = {},
  ) => {
    const option =
      options.tenant !== undefined || options.transitionId !== undefined
        ? null
        : await decisionOption(approvalId, decision);
    const transitionId = options.transitionId ?? option?.transitionId;
    return auth(
      request(api.server).post(`/api/v1/approvals/${approvalId}/decide`),
      options.subject ?? 'sub-marta',
      options.tenant,
    )
      .set('If-Match', '"1"')
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send({
        decision,
        ...(transitionId ? { transitionId } : {}),
        ...(options.comment === undefined ? {} : { comment: options.comment }),
      });
  };

  /**
   * Background: processo "em APROVACAO_DFD" com o DFD em IN_REVIEW e a aprovação pendente — DFD de
   * valor 15000.00, PCA PLANNED, prioridade HIGH e um item com quantidade 10.
   */
  async function inApproval(
    header: Readonly<Record<string, unknown>> = {},
  ): Promise<{ process: Process; dfd: DfdDto; item: ProcessItemDto; approvalId: string }> {
    const created = await auth(request(api.server).post('/api/v1/processes'))
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
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const processId = data<ProcessDto>(created).id;
    const itemResponse = await auth(
      request(api.server).post(`/api/v1/processes/${processId}/items`),
    )
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', description: 'Cimento CP II 50 kg', unitOfMeasureId: catalog.unit });
    expect(itemResponse.status, JSON.stringify(itemResponse.body)).toBe(201);
    const item = data<ProcessItemDto>(itemResponse);
    const dfdResponse = await auth(request(api.server).post(`/api/v1/processes/${processId}/dfds`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(dfdResponse.status, JSON.stringify(dfdResponse.body)).toBe(201);
    const dfd = data<DfdDto>(dfdResponse);
    const saved = await auth(request(api.server).put(`/api/v1/documents/${dfd.documentId}/items`))
      .set('If-Match', '"1"')
      .send({ items: [{ processItemId: item.id, quantity: '10' }] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    fillDfdDraft(
      api,
      dfd,
      {
        JUSTIFICATION: 'x'.repeat(380),
        EXPECTED_RESULTS: 'Manutenção contínua das vias do bairro Centro.',
      },
      {
        expectedDate: '2026-12-15',
        pcaStatus: 'PLANNED',
        pcaYear: 2026,
        pcaItemCode: 'PCA-2026-017',
        priority: 'HIGH',
        estimatedValue: '15000.00',
        wizardStep: 'CONCLUSION',
        completedSteps: ['IDENTIFICATION', 'JUSTIFICATION', 'PLANNING', 'REVIEW'],
        ...header,
      },
    );
    const process = stored(processId);
    const actions = await auth(
      request(api.server).get(`/api/v1/processes/${processId}/available-actions`),
    );
    const entry = data<{ action: string; toStageKey: string; transitionId: string }[]>(
      actions,
    ).find((action) => action.action === 'FORWARD' && action.toStageKey === 'APROVACAO_DFD');
    if (!entry) throw new Error('transição ENVIAR_APROVACAO_DFD ausente');
    const forwarded = await auth(request(api.server).post(`/api/v1/processes/${processId}/forward`))
      .set('If-Match', `"${String(process.version)}"`)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedStageId: process.currentStageId,
        acknowledgedWarnings: [],
        transitionId: entry.transitionId,
        documentIds: [dfd.documentId],
      });
    expect(forwarded.status, JSON.stringify(forwarded.body)).toBe(200);
    const approvalId = data<ForwardedProcessDto>(forwarded).approval?.id ?? '';
    expect(storedDocument(dfd.documentId).status).toBe('IN_REVIEW');
    return { process: stored(processId), dfd, item, approvalId };
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: APPROVAL_TRANSACTIONS, value: transactions },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A, [
      'catalog.items',
      'catalog.holidays',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
    ]);
    await runTenantSeeders(api, B, ['catalog.items', 'access.defaultRoles']);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    // Marta decide como titular: APPROVAL_DECIDE pelo perfil AUTORIDADE_COMPETENTE.
    const roles = seedDefaultRolesOf(api, A);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.marta.id),
      roleId: roles.get('AUTORIDADE_COMPETENTE')?.id ?? '',
    });
    // Ana: REQUISITANTE + DOCUMENT_REOPEN (a matriz padrão não dá a reabertura à requisitante —
    // POL-11; o tenant concede por perfil). O perfil gravado substitui a ponte por chave.
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.ana.id),
      roleId: roles.get('REQUISITANTE')?.id ?? '',
    });
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.ana.id),
      roleId: seedCustomRole(api, A, 'Reabertura de documentos', ['DOCUMENT_REOPEN']).id,
    });
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.fabio.id),
      roleId: roles.get('SOMENTE_LEITURA')?.id ?? '',
    });
    setDepartmentHead(api, UNITS_A.obras, FAKE_USERS.marta.id, FAKE_USERS.fabio.id);
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      unit: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'UN'),
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
    it('APPROVE propaga valor, quantidade, PCA e prioridade, com auditoria de propagação e DFDApproved', async () => {
      const { process, dfd, item, approvalId } = await inApproval();
      expect(process).toMatchObject({ estimatedValue: null, pcaStatus: 'NOT_APPLICABLE' });

      const response = await decide(approvalId, 'APPROVE');

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(storedDocument(dfd.documentId).status).toBe('APPROVED');
      expect(stored(process.id)).toMatchObject({
        estimatedValue: '15000.00',
        estimatedValueSource: 'DFD',
        pcaStatus: 'PLANNED',
        pcaYear: 2026,
        pcaItemCode: 'PCA-2026-017',
        priority: 'HIGH',
      });
      const [propagated] = await itemsOf(process.id);
      expect(propagated).toMatchObject({
        id: item.id,
        referenceQuantity: '10.0000',
        referenceQuantitySourceDocumentId: dfd.documentId,
      });

      // RN-DFD-71: uma entrada por destino, distinta de `approval.decide`/`document.approve`.
      const [update, ...moreUpdates] = auditOf(process.id, 'process.update');
      expect(moreUpdates).toEqual([]);
      expect(update?.metadata).toMatchObject({
        source: 'DFD_APPROVAL',
        decisionApprovalId: approvalId,
        estimatedValueSkipped: false,
      });
      expect(update?.changes).toEqual(
        expect.arrayContaining([
          { path: 'estimatedValue', old: null, new: '15000.00' },
          { path: 'estimatedValueSource', old: null, new: 'DFD' },
          { path: 'pcaStatus', old: 'NOT_APPLICABLE', new: 'PLANNED' },
          { path: 'pcaYear', old: null, new: 2026 },
          { path: 'priority', old: process.priority, new: 'HIGH' },
        ]),
      );
      const itemAudits = auditOf(process.id, 'process.items_update');
      expect(itemAudits.at(-1)?.metadata).toMatchObject({
        source: 'DFD_APPROVAL',
        sourceDocumentId: dfd.documentId,
        operation: 'UPDATE',
      });
      expect(itemAudits.at(-1)?.changes).toContainEqual({
        path: `items[${item.id}].referenceQuantity`,
        old: null,
        new: '10.0000',
      });
      expect(auditOf(process.id, 'approval.decide')).toHaveLength(1);

      // Eventos: DFDApproved (`document.approved.dfd`), ProcessUpdated e ProcessItemsChanged.
      expect(eventsOf(process.id, 'DocumentApproved').map((row) => row.routingKey)).toEqual([
        'document.approved.dfd',
      ]);
      const [updated] = eventsOf(process.id, 'ProcessUpdated');
      expect(updated?.payload).toMatchObject({
        changedFields: expect.arrayContaining([
          'estimatedValue',
          'pcaStatus',
          'priority',
        ]) as unknown,
      });
      // Sem valores no payload (events.md §1).
      expect(JSON.stringify(updated?.payload)).not.toContain('15000');
      expect(eventsOf(process.id, 'ProcessItemsChanged').at(-1)?.payload).toMatchObject({
        updated: [item.id],
        itemsCount: 1,
      });
      expect(timelineOf(process.id, 'PROCESS_UPDATED')).toHaveLength(1);

      // DFD-03 reflete a decisão; o processo (PRC-04) mostra a origem DFD.
      const view = await dfdView(dfd.id);
      expect(view.dfd.status).toBe('APPROVED');
      expect(view.meta.decision).toMatchObject({
        approvalId,
        outcome: 'APPROVED',
        comment: null,
        decidedBy: { id: FAKE_USERS.marta.id },
      });
      const panel = await processView(process.id, 'sub-marta');
      expect(panel).toMatchObject({ estimatedValue: '15000.00', estimatedValueSource: 'DFD' });
    });

    it('REJECT devolve o processo à ABERTURA (RETURNED), não propaga nada e guarda o motivo; reabrir volta o wizard à revisão', async () => {
      const { process, dfd, approvalId } = await inApproval();

      const response = await decide(approvalId, 'REJECT', { comment: REJECT_REASON });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(storedDocument(dfd.documentId).status).toBe('REJECTED');
      const after = stored(process.id);
      expect(after).toMatchObject({
        status: 'RETURNED',
        estimatedValue: null,
        estimatedValueSource: null,
        pcaStatus: 'NOT_APPLICABLE',
        priority: process.priority,
      });
      const [panel] = [await processView(process.id)];
      expect(panel.currentStage?.key).toBe('ABERTURA');
      const [item] = await itemsOf(process.id);
      expect(item?.referenceQuantity).toBeNull();
      expect(auditOf(process.id, 'process.update')).toEqual([]);
      expect(eventsOf(process.id, 'ProcessUpdated')).toEqual([]);
      expect(eventsOf(process.id, 'DocumentRejected').map((row) => row.routingKey)).toEqual([
        'document.rejected.dfd',
      ]);

      // SCR-007: o motivo do aprovador no banner e "Reabrir DFD" para quem tem a custódia.
      const view = await dfdView(dfd.id);
      expect(view.meta.decision).toMatchObject({ outcome: 'REJECTED', comment: REJECT_REASON });
      expect(view.meta.allowedActions).toContain('REOPEN');
      expect(storedDfd(dfd.id).wizardStep).toBe('CONCLUSION');

      // FA-01 · RN-DFD-69: reabre em DRAFT, o wizard volta à revisão, passos concluídos ficam.
      const reopened = await auth(
        request(api.server).post(`/api/v1/documents/${dfd.documentId}/reopen`),
      )
        .set('If-Match', `"${String(storedDocument(dfd.documentId).version)}"`)
        .set('Idempotency-Key', randomUUID())
        .send({ reopenReason: 'Ajuste da demanda após o indeferimento do titular.' });
      expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
      expect(storedDocument(dfd.documentId).status).toBe('DRAFT');
      expect(storedDfd(dfd.id)).toMatchObject({
        wizardStep: 'REVIEW',
        completedSteps: ['IDENTIFICATION', 'JUSTIFICATION', 'PLANNING', 'REVIEW'],
      });
    });

    it('RETURN: nada vai ao processo; o DFD fica RETURNED, editável, já na revisão do wizard', async () => {
      const { process, dfd, approvalId } = await inApproval();

      const response = await decide(approvalId, 'RETURN', {
        comment: 'Detalhar a justificativa da quantidade.',
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(storedDocument(dfd.documentId).status).toBe('RETURNED');
      expect(stored(process.id)).toMatchObject({ status: 'RETURNED', estimatedValue: null });
      expect(storedDfd(dfd.id)).toMatchObject({
        wizardStep: 'REVIEW',
        completedSteps: ['IDENTIFICATION', 'JUSTIFICATION', 'PLANNING', 'REVIEW'],
      });
      const view = await dfdView(dfd.id);
      expect(view.meta.decision).toMatchObject({
        outcome: 'RETURNED',
        comment: 'Detalhar a justificativa da quantidade.',
      });
      expect(eventsOf(process.id, 'DocumentReturned').map((row) => row.routingKey)).toEqual([
        'document.returned.dfd',
      ]);
    });
  });

  describe('[Validação]', () => {
    it('origem TERM: o valor estimado do processo não muda; quantidade, PCA e prioridade são aplicados', async () => {
      const { process, item, approvalId } = await inApproval({ estimatedValue: '9000.00' });
      await patchProcess(process.id, { estimatedValue: '12345.67', estimatedValueSource: 'TERM' });

      const response = await decide(approvalId, 'APPROVE');

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(stored(process.id)).toMatchObject({
        estimatedValue: '12345.67',
        estimatedValueSource: 'TERM',
        pcaStatus: 'PLANNED',
        priority: 'HIGH',
      });
      const [propagated] = await itemsOf(process.id);
      expect(propagated).toMatchObject({ id: item.id, referenceQuantity: '10.0000' });
      const [update] = auditOf(process.id, 'process.update');
      expect(update?.metadata).toMatchObject({ estimatedValueSkipped: true });
      expect(update?.changes).not.toContainEqual(
        expect.objectContaining({ path: 'estimatedValue' }),
      );
    });

    it('origem MANUAL: o valor do DFD substitui o manual (RN-DFD-63)', async () => {
      const { process, approvalId } = await inApproval();
      await patchProcess(process.id, { estimatedValue: '500.00', estimatedValueSource: 'MANUAL' });

      expect((await decide(approvalId, 'APPROVE')).status).toBe(200);

      expect(stored(process.id)).toMatchObject({
        estimatedValue: '15000.00',
        estimatedValueSource: 'DFD',
      });
    });

    it('DFD sem valor estimado: o valor do processo fica, os demais efeitos ocorrem', async () => {
      const { process, approvalId } = await inApproval({ estimatedValue: null });
      await patchProcess(process.id, { estimatedValue: '500.00', estimatedValueSource: 'MANUAL' });

      expect((await decide(approvalId, 'APPROVE')).status).toBe(200);

      expect(stored(process.id)).toMatchObject({
        estimatedValue: '500.00',
        estimatedValueSource: 'MANUAL',
        pcaStatus: 'PLANNED',
      });
    });
  });

  describe('[Permissão]', () => {
    it('orçamento sigiloso: o valor propagado sai nulo e mascarado para quem não vê o orçamento', async () => {
      const { process, approvalId } = await inApproval();
      await patchProcess(process.id, { isBudgetConfidential: true });

      expect((await decide(approvalId, 'APPROVE')).status).toBe(200);

      // Gravado normalmente (FA-02); a auditoria guarda só o hash do valor sigiloso.
      expect(stored(process.id)).toMatchObject({
        estimatedValue: '15000.00',
        estimatedValueSource: 'DFD',
      });
      const [update] = auditOf(process.id, 'process.update');
      expect(update?.changes).toContainEqual({
        path: 'estimatedValue',
        old: null,
        new: { masked: true, sha256: expect.any(String) as string },
      });
      // "Carla" (Fábio, SOMENTE_LEITURA): consultora do processo, sem custódia nem POL-09.
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.fabio.id,
        role: 'CONSULTANT',
      });
      const masked = await processView(process.id, 'sub-fabio');
      expect(masked).toMatchObject({ estimatedValue: null, estimatedValueMasked: true });
    });
  });

  describe('[Permissão] Reabrir DFD (V-02/V-03)', () => {
    it('com a aprovação pendente, "Reabrir DFD" não é oferecido e a API recusa sem mudar nada', async () => {
      const { dfd } = await inApproval();

      const view = await dfdView(dfd.id);
      expect(view.meta.allowedActions).not.toContain('REOPEN');
      expect(view.meta.decision).toBeNull();
      const response = await auth(
        request(api.server).post(`/api/v1/documents/${dfd.documentId}/reopen`),
      )
        .set('If-Match', `"${String(storedDocument(dfd.documentId).version)}"`)
        .set('Idempotency-Key', randomUUID())
        .send({ reopenReason: 'Tentativa de reabrir durante a aprovação.' });

      // A requisitante não tem a custódia durante a aprovação (POL-11 barra antes do estado).
      expectProblem(response, 403, 'NOT_PROCESS_CUSTODIAN');
      expect(storedDocument(dfd.documentId).status).toBe('IN_REVIEW');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('a decisão e o DFD de outro tenant não existem para quem está no tenant B', async () => {
      const { process, dfd, approvalId } = await inApproval();

      expectProblem(
        await decide(approvalId, 'APPROVE', { tenant: B, subject: 'sub-heitor' }),
        404,
        'APPROVAL_NOT_FOUND',
      );
      expectProblem(
        await auth(request(api.server).get(`/api/v1/dfds/${dfd.id}`), 'sub-heitor', B),
        404,
        'DFD_NOT_FOUND',
      );
      expect(storedDocument(dfd.documentId).status).toBe('IN_REVIEW');
      expect(stored(process.id).estimatedValue).toBeNull();
    });
  });

  describe('[Duplicidade]', () => {
    it('reenvio com a mesma Idempotency-Key devolve a mesma resposta e não reaplica a propagação', async () => {
      const { process, approvalId } = await inApproval();
      const key = randomUUID();
      const { transitionId } = await decisionOption(approvalId, 'APPROVE');

      const first = await decide(approvalId, 'APPROVE', { key, transitionId });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const version = stored(process.id).version;
      const audits = api.auditRecords().length;

      const replay = await decide(approvalId, 'APPROVE', { key, transitionId });

      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(stored(process.id).version).toBe(version);
      expect(api.auditRecords()).toHaveLength(audits);
      expect(auditOf(process.id, 'process.update')).toHaveLength(1);
      expect(auditOf(process.id, 'process.items_update').at(-1)?.metadata).toMatchObject({
        source: 'DFD_APPROVAL',
      });
    });
  });

  describe('[Concorrência]', () => {
    it('editar o DFD enquanto a decisão está pendente falha com 409 e não muda nada; a decisão conclui', async () => {
      const { process, dfd, approvalId } = await inApproval();
      // A requisitante como colaboradora (POL-02 passa): quem barra é o estado do processo/DFD.
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      const before = storedDfd(dfd.id);

      const edit = await auth(request(api.server).patch(`/api/v1/dfds/${dfd.id}`))
        .set('If-Match', `"${String(before.version)}"`)
        .send({ objectSummary: `Objeto revisto durante a decisão ${words(2)}` });
      // Ordem de checagens da US-065 (como na US-016): o processo em AWAITING_APPROVAL vem antes do
      // documento IN_REVIEW — 409 `INVALID_PROCESS_STATUS` (story · "Concorrência", ajustada).
      expectProblem(edit, 409, 'INVALID_PROCESS_STATUS');
      expect(storedDfd(dfd.id).objectSummary).toBe(before.objectSummary);

      const response = await decide(approvalId, 'APPROVE');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(stored(process.id).estimatedValueSource).toBe('DFD');
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível: 503 DEPENDENCY_UNAVAILABLE e nada muda (DFD IN_REVIEW, processo intacto)', async () => {
      const { process, dfd, approvalId } = await inApproval();
      const option = await decisionOption(approvalId, 'APPROVE');
      transactions.down = true;

      const response = await auth(
        request(api.server).post(`/api/v1/approvals/${approvalId}/decide`),
        'sub-marta',
      )
        .set('If-Match', '"1"')
        .set('Idempotency-Key', randomUUID())
        .send({ decision: 'APPROVE', transitionId: option.transitionId });

      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(storedDocument(dfd.documentId).status).toBe('IN_REVIEW');
      expect(stored(process.id)).toMatchObject({
        estimatedValue: null,
        version: process.version,
      });
    });
  });

  describe('[Falha de integração]', () => {
    it('sem relay: DFD e processo atualizados; DFDApproved fica gravado no outbox à espera do relay', async () => {
      const { process, dfd, approvalId } = await inApproval();

      expect((await decide(approvalId, 'APPROVE')).status).toBe(200);

      expect(storedDocument(dfd.documentId).status).toBe('APPROVED');
      expect(stored(process.id).estimatedValueSource).toBe('DFD');
      // O outbox em memória não tem relay: a linha fica para ele (o `PENDING` real está na suíte
      // `test/tenant-leak/dfd-decision-effects.spec.ts`).
      expect(eventsOf(process.id, 'DocumentApproved').map((row) => row.routingKey)).toEqual([
        'document.approved.dfd',
      ]);
    });
  });
});
