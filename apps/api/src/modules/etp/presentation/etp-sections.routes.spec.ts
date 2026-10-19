import { randomUUID } from 'node:crypto';

import {
  documentSectionSavedSchema,
  etpDetailMetaSchema,
  etpDetailSchema,
  etpSchema,
  problemDetailsSchema,
  sectionConflictCurrentSchema,
  violationSchema,
} from '@contrataflow/validation';
import type { DocumentSectionSavedDto, EtpDetailDto, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  DRAFT_AUDIT_WINDOW_STORE,
  InMemoryDraftAuditWindowStore,
} from '#shared/audit/draft-audit.js';
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
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { ETP_CLOCK, ETP_TRANSACTIONS } from '../application/ports.js';

/*
 * US-020 — Editar seções do ETP com autosave e "não se aplica" justificado, pelo pipeline HTTP
 * completo (autenticação, tenant, vínculo, autorização, `If-Match`, filtro RFC 9457) com a
 * identidade fake, os seeders reais e o ETP criado pelo ETP-02 no processo levado aos estudos
 * preliminares. ETP-03 (leitura com o rascunho por seção e o template), DOC-05 (autosave genérico
 * da US-015, agora com "não se aplica") e DOC-08 (pendências não bloqueantes) nas 8 categorias do
 * Gherkin + FA-02/05 e V-01/V-06. Lúcia (PLANEJAMENTO, custódia) é a "Carla"; Otávio
 * (SOMENTE_LEITURA) é o "Bruno"; Ana (REQUISITANTE, com ETP_UPDATE) é a colaboradora. A
 * atualização condicional sob concorrência real e a RLS no PostgreSQL:
 * `test/tenant-leak/etp-sections.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-18T15:00:00.000Z');
const CARLA = 'sub-lucia';
const BRUNO = 'sub-otavio';
const JUSTIFICATION_30 = 'Solução única no mercado atual';

const UNITS_A = {
  organizationId: '0192d020-0000-7000-8000-0000000000a0',
  obras: '0192d020-0000-7000-8000-0000000000a1',
  manutencao: '0192d020-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d020-0000-7000-8000-0000000000a3',
  saude: '0192d020-0000-7000-8000-0000000000a4',
  posto: '0192d020-0000-7000-8000-0000000000a5',
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

const ETP_RESPONSE = z.object({ data: etpDetailSchema, meta: etpDetailMetaSchema });

describe('Feature: Editar seções do ETP com autosave e "não se aplica" justificado (US-020)', () => {
  let api: TestApi;
  let clockMs = NOW.getTime();
  const documents = new FlakyTransactions();
  const etps = new FlakyTransactions();
  const windows = new InMemoryDraftAuditWindowStore(() => clockMs);
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = CARLA, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const getEtp = (id: string, subject = CARLA, tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/etps/${id}`), subject, tenant);
  const putSection = (
    documentId: string,
    sectionKey: string,
    body: Record<string, unknown>,
    options: { ifMatch: string; subject?: string; tenant?: string },
  ) =>
    auth(
      request(api.server).put(`/api/v1/documents/${documentId}/sections/${sectionKey}`),
      options.subject,
      options.tenant,
    )
      .set('If-Match', options.ifMatch)
      .send(body);
  const validationOf = (documentId: string, subject = CARLA) =>
    auth(request(api.server).get(`/api/v1/documents/${documentId}/validation`), subject);

  const documentOf = (documentId: string) => {
    const found = documentRepositoryOf(api)
      .allDocuments()
      .find((candidate) => candidate.id === documentId);
    if (!found) throw new Error('documento ausente');
    return found;
  };
  const sectionOf = (documentId: string, key: string) =>
    documentOf(documentId).draftContent.sections[key];
  const revisionOf = (documentId: string, key: string) => sectionOf(documentId, key)?.revision ?? 0;
  const etag = (revision: number) => `"s${String(revision)}"`;
  const draftAudits = (documentId: string) =>
    api
      .auditRecords()
      .filter((row) => row.action === 'document.draft_update' && row.entityId === documentId);
  const stageId = (process: Process, key: string) =>
    workflowStagesOf(api, A).find(
      (candidate) =>
        candidate.key === key && candidate.workflowVersionId === process.workflowVersionId,
    )?.id ?? null;

  /** Processo (PRC-02, Ana) nos estudos preliminares sob custódia da Carla + o ETP (ETP-02). */
  async function background() {
    const response = await auth(request(api.server).post('/api/v1/processes'), 'sub-ana')
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Manutenção predial ${words(2)}`,
        object: `Contratação de manutenção predial preventiva ${words(2)}`,
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
    };
    processRepositoryOf(api).replace(process);
    const etpResponse = await auth(request(api.server).post(`/api/v1/processes/${process.id}/etps`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(etpResponse.status, JSON.stringify(etpResponse.body)).toBe(201);
    return { process, etp: etpSchema.parse(data(etpResponse)) };
  }

  async function detailOf(id: string, subject = CARLA) {
    const response = await getEtp(id, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return ETP_RESPONSE.parse(response.body);
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: DOCUMENT_TRANSACTIONS, value: documents },
        { token: ETP_TRANSACTIONS, value: etps },
        { token: DRAFT_AUDIT_WINDOW_STORE, value: windows },
        { token: ETP_CLOCK, value: () => NOW },
        { token: DOCUMENT_CLOCK, value: () => new Date(clockMs) },
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
    clockMs += 11 * 60_000;
  });

  describe('[Sucesso]', () => {
    it('ETP-03 abre o editor: rascunho por seção com revisão, 16 seções do template com render e UPDATE nas ações', async () => {
      const { etp } = await background();
      const response = await getEtp(etp.id);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe(`"${String(etp.version)}"`);
      expect(response.headers['cache-control']).toBe('no-store');
      const { data: detail, meta } = ETP_RESPONSE.parse(response.body);
      expect(detail).toMatchObject({
        id: etp.id,
        code: etp.code,
        status: 'DRAFT',
        conclusion: 'PENDING',
        estimatedTotalValue: null,
        estimatedTotalValueMasked: false,
        parcelingDecision: null,
      });
      expect(meta.allowedActions).toContain('UPDATE');
      expect(meta.template?.sections).toHaveLength(16);
      expect(meta.template?.sections.map((section) => section.order)).toEqual(
        Array.from({ length: 16 }, (_, index) => index + 1),
      );
      expect(meta.template?.sections.find((section) => section.key === 'ESTIMATES')).toMatchObject({
        render: 'TEXT',
        allowNarrative: true,
      });
      expect(Object.keys(detail.draftContent.sections)).toHaveLength(16);
      expect(detail.draftContent.sections.NEED_DESCRIPTION).toMatchObject({ state: 'EMPTY' });
    });

    it('Autosave da seção de texto: If-Match "s<n>" → 200 FILLED na revisão n+1, ETag, sem versão nova e auditoria coalescida', async () => {
      const { etp } = await background();
      const before = revisionOf(etp.documentId, 'NEED_DESCRIPTION');
      const documentVersion = documentOf(etp.documentId).version;
      const response = await putSection(
        etp.documentId,
        'NEED_DESCRIPTION',
        { content: paragraph('As escolas precisam de manutenção predial preventiva.') },
        { ifMatch: etag(before) },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe(etag(before + 1));
      const saved = documentSectionSavedSchema.parse(data(response));
      expect(saved).toMatchObject({ sectionKey: 'NEED_DESCRIPTION', state: 'FILLED' });
      expect(saved.revision).toBe(before + 1);
      expect(documentOf(etp.documentId).version).toBe(documentVersion);
      const audits = draftAudits(etp.documentId);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.metadata).toMatchObject({
        sectionKey: 'NEED_DESCRIPTION',
        state: 'FILLED',
        toRevision: before + 1,
      });
      // RN-ETP-17: a segunda gravação na janela de 10 min não gera outro registro.
      const again = await putSection(
        etp.documentId,
        'NEED_DESCRIPTION',
        { content: paragraph('As escolas precisam de manutenção predial preventiva e corretiva.') },
        { ifMatch: etag(before + 1) },
      );
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(draftAudits(etp.documentId)).toHaveLength(1);
      // O texto nunca vai para a auditoria (só hash e tamanho).
      expect(JSON.stringify(audits)).not.toContain('manutenção predial');
      const { data: detail } = await detailOf(etp.id);
      expect(detail.draftContent.sections.NEED_DESCRIPTION).toMatchObject({
        state: 'FILLED',
        revision: before + 2,
      });
    });

    it('Marcar "não se aplica" com justificativa de 30 caracteres → NOT_APPLICABLE; FA-02: voltar a preencher descarta a justificativa', async () => {
      const { etp } = await background();
      expect(JUSTIFICATION_30).toHaveLength(30);
      const base = revisionOf(etp.documentId, 'MARKET_SURVEY');
      const marked = await putSection(
        etp.documentId,
        'MARKET_SURVEY',
        { content: null, state: 'NOT_APPLICABLE', justification: JUSTIFICATION_30 },
        { ifMatch: etag(base) },
      );
      expect(marked.status, JSON.stringify(marked.body)).toBe(200);
      expect(data<DocumentSectionSavedDto>(marked).state).toBe('NOT_APPLICABLE');
      const { data: detail } = await detailOf(etp.id);
      expect(detail.draftContent.sections.MARKET_SURVEY).toMatchObject({
        state: 'NOT_APPLICABLE',
        justification: JUSTIFICATION_30,
      });

      const filled = await putSection(
        etp.documentId,
        'MARKET_SURVEY',
        { content: paragraph('Três fornecedores atendem a demanda.'), notApplicable: false },
        { ifMatch: etag(base + 1) },
      );
      expect(filled.status, JSON.stringify(filled.body)).toBe(200);
      expect(sectionOf(etp.documentId, 'MARKET_SURVEY')).toMatchObject({
        state: 'FILLED',
        justification: null,
      });
    });

    it('DOC-08 informa as pendências por seção sem bloquear a edição (RN-ETP-13)', async () => {
      const { etp } = await background();
      const response = await validationOf(etp.documentId);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const violations = z
        .array(violationSchema)
        .parse(data<{ violations: unknown }>(response).violations);
      expect(violations.some((violation) => violation.sectionKey === 'NEED_DESCRIPTION')).toBe(
        true,
      );
      const saved = await putSection(
        etp.documentId,
        'NEED_DESCRIPTION',
        { content: paragraph('Necessidade descrita.') },
        { ifMatch: etag(revisionOf(etp.documentId, 'NEED_DESCRIPTION')) },
      );
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    });

    it('Colaboradora convidada (participação COLLABORATOR) com ETP_UPDATE edita sem custódia', async () => {
      const { process, etp } = await background();
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      const response = await putSection(
        etp.documentId,
        'OBJECTIVE',
        { content: paragraph('Garantir a conservação dos prédios escolares.') },
        { ifMatch: etag(revisionOf(etp.documentId, 'OBJECTIVE')), subject: 'sub-ana' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    });
  });

  describe('[Validação]', () => {
    it('Justificativa de 10 caracteres: 422 VALIDATION_ERROR TOO_SHORT com a mensagem da story; a seção fica no estado anterior', async () => {
      const { etp } = await background();
      const before = sectionOf(etp.documentId, 'MARKET_SURVEY');
      const response = await putSection(
        etp.documentId,
        'MARKET_SURVEY',
        { content: null, state: 'NOT_APPLICABLE', justification: '0123456789' },
        { ifMatch: etag(before?.revision ?? 0) },
      );
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors[0]).toMatchObject({
        field: 'justification',
        code: 'TOO_SHORT',
        message: 'Explique por que esta seção não se aplica (mín. 20 caracteres).',
      });
      const missing = await putSection(
        etp.documentId,
        'MARKET_SURVEY',
        { content: null, notApplicable: true, justification: null },
        { ifMatch: etag(before?.revision ?? 0) },
      );
      expect(expectProblem(missing, 422, 'VALIDATION_ERROR').errors[0]?.code).toBe(
        'CONDITIONAL_REQUIRED',
      );
      expect(sectionOf(etp.documentId, 'MARKET_SURVEY')).toEqual(before);
      expect(draftAudits(etp.documentId)).toEqual([]);
    });

    it('V-01: seção fora do template → 422 SECTION_NOT_IN_TEMPLATE; V-06: nó não suportado → 422 RICH_TEXT_INVALID', async () => {
      const { etp } = await background();
      expectProblem(
        await putSection(
          etp.documentId,
          'NAO_EXISTE',
          { content: paragraph('Texto qualquer') },
          { ifMatch: '"s0"' },
        ),
        422,
        'SECTION_NOT_IN_TEMPLATE',
      );
      expectProblem(
        await putSection(
          etp.documentId,
          'OBJECTIVE',
          { content: { type: 'doc', content: [{ type: 'iframe', attrs: { src: 'x' } }] } },
          { ifMatch: etag(revisionOf(etp.documentId, 'OBJECTIVE')) },
        ),
        422,
        'RICH_TEXT_INVALID',
      );
    });
  });

  describe('[Permissão]', () => {
    it('Bruno (SOMENTE_LEITURA): ETP-03 abre sem UPDATE (somente leitura) e o PUT responde 403 PERMISSION_DENIED com access.denied', async () => {
      const { etp } = await background();
      const { meta } = await detailOf(etp.id, BRUNO);
      expect(meta.allowedActions).not.toContain('UPDATE');
      const response = await putSection(
        etp.documentId,
        'NEED_DESCRIPTION',
        { content: paragraph('Tentativa de quem só pode ler') },
        { ifMatch: etag(revisionOf(etp.documentId, 'NEED_DESCRIPTION')), subject: BRUNO },
      );
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().at(-1)).toMatchObject({ action: 'access.denied' });
      expect(sectionOf(etp.documentId, 'NEED_DESCRIPTION')?.state).toBe('EMPTY');
    });

    it('Com ETP_UPDATE mas sem custódia nem participação: 403 com access.denied POL-02', async () => {
      const { etp } = await background();
      const response = await putSection(
        etp.documentId,
        'OBJECTIVE',
        { content: paragraph('Sem custódia') },
        { ifMatch: etag(revisionOf(etp.documentId, 'OBJECTIVE')), subject: 'sub-ana' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'POL-02',
      });
    });

    it('FA-05: ETP em revisão abre somente leitura e o PUT responde 409 DOCUMENT_NOT_EDITABLE', async () => {
      const { etp } = await background();
      documentRepositoryOf(api).seed({ ...documentOf(etp.documentId), status: 'IN_REVIEW' });
      const { meta } = await detailOf(etp.id);
      expect(meta.allowedActions).not.toContain('UPDATE');
      const problem = expectProblem(
        await putSection(
          etp.documentId,
          'OBJECTIVE',
          { content: paragraph('Edição depois da submissão') },
          { ifMatch: etag(revisionOf(etp.documentId, 'OBJECTIVE')) },
        ),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      expect((problem as { meta?: { status?: string } }).meta?.status).toBe('IN_REVIEW');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('ETP de outro tenant: ETP-03 e DOC-05 → 404 NOT_FOUND sem revelar nem alterar nada', async () => {
      const { etp } = await background();
      const before = documentOf(etp.documentId);
      // Fábio tem vínculo na Prefeitura B (CONSULTOR_EXTERNO).
      const read = expectProblem(await getEtp(etp.id, 'sub-fabio', B), 404, 'NOT_FOUND');
      expect(JSON.stringify(read)).not.toContain(etp.code ?? '#');
      expectProblem(
        await putSection(
          etp.documentId,
          'NEED_DESCRIPTION',
          { content: paragraph('Tentativa de outro órgão') },
          { ifMatch: '"s1"', subject: 'sub-fabio', tenant: B },
        ),
        404,
        'NOT_FOUND',
      );
      expectProblem(await getEtp(newId()), 404, 'NOT_FOUND');
      expect(documentOf(etp.documentId)).toEqual(before);
      expect(draftAudits(etp.documentId)).toEqual([]);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio do mesmo autosave com If-Match "s2" após a revisão 2: 200 na revisão 2, sem conteúdo duplicado', async () => {
      const { etp } = await background();
      const body = { content: paragraph('Objetivo final esperado da contratação.') };
      const revision = revisionOf(etp.documentId, 'OBJECTIVE');
      const first = await putSection(etp.documentId, 'OBJECTIVE', body, {
        ifMatch: etag(revision),
      });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const saved = data<DocumentSectionSavedDto>(first).revision;
      const replay = await putSection(etp.documentId, 'OBJECTIVE', body, {
        ifMatch: etag(revision),
      });
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(data<DocumentSectionSavedDto>(replay).revision).toBe(saved);
      expect(sectionOf(etp.documentId, 'OBJECTIVE')).toMatchObject({
        state: 'FILLED',
        revision: saved,
        content: body.content,
      });
    });
  });

  describe('[Concorrência]', () => {
    it('Duas edições simultâneas com o mesmo If-Match: exatamente uma 200 (revisão n+1) e a outra 412 SECTION_REVISION_CONFLICT com meta.current', async () => {
      const { process, etp } = await background();
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.ana.id,
        role: 'COLLABORATOR',
      });
      const base = revisionOf(etp.documentId, 'OBJECTIVE');
      const responses = await Promise.all([
        putSection(
          etp.documentId,
          'OBJECTIVE',
          { content: paragraph('Versão da Carla') },
          { ifMatch: etag(base) },
        ),
        putSection(
          etp.documentId,
          'OBJECTIVE',
          { content: paragraph('Versão da colaboradora') },
          { ifMatch: etag(base), subject: 'sub-ana' },
        ),
      ]);
      const ok = responses.filter((response) => response.status === 200);
      const conflicts = responses.filter((response) => response.status === 412);
      expect(ok).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      expect(data<DocumentSectionSavedDto>(ok[0] as request.Response).revision).toBe(base + 1);
      const problem = expectProblem(
        conflicts[0] as request.Response,
        412,
        'SECTION_REVISION_CONFLICT',
      );
      const current = sectionConflictCurrentSchema.parse(
        (problem as { meta?: { current?: unknown } }).meta?.current,
      );
      expect(current.revision).toBe(base + 1);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível: DOC-05 e ETP-03 respondem 503 DEPENDENCY_UNAVAILABLE; quando volta, o autosave pendente é aceito', async () => {
      const { etp } = await background();
      const base = revisionOf(etp.documentId, 'REQUIREMENTS');
      const body = { content: paragraph('Requisitos guardados no navegador durante a queda.') };
      documents.down = true;
      etps.down = true;
      const down = await putSection(etp.documentId, 'REQUIREMENTS', body, { ifMatch: etag(base) });
      expectProblem(down, 503, 'DEPENDENCY_UNAVAILABLE');
      expectProblem(await getEtp(etp.id), 503, 'DEPENDENCY_UNAVAILABLE');
      documents.down = false;
      etps.down = false;
      const retried = await putSection(etp.documentId, 'REQUIREMENTS', body, {
        ifMatch: etag(base),
      });
      expect(retried.status, JSON.stringify(retried.body)).toBe(200);
      expect(data<DocumentSectionSavedDto>(retried).revision).toBe(base + 1);
      expect(draftAudits(etp.documentId)).toHaveLength(1);
    });
  });

  describe('[Falha de integração]', () => {
    it('Conexão perdida: o rascunho local reenviado ao reconectar (revisão-base) é salvo na revisão seguinte', async () => {
      const { etp } = await background();
      const base = revisionOf(etp.documentId, 'RECOMMENDED_SOLUTION');
      const restored = await putSection(
        etp.documentId,
        'RECOMMENDED_SOLUTION',
        { content: paragraph('Solução digitada sem conexão e reenviada ao reconectar.') },
        { ifMatch: etag(base) },
      );
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      const { data: detail }: { data: EtpDetailDto } = await detailOf(etp.id);
      expect(detail.draftContent.sections.RECOMMENDED_SOLUTION).toMatchObject({
        state: 'FILLED',
        revision: base + 1,
      });
    });
  });
});
