import { randomUUID } from 'node:crypto';

import {
  dfdConflictCurrentSchema,
  dfdSchema,
  documentSectionSavedSchema,
  problemDetailsSchema,
  sectionConflictCurrentSchema,
} from '@contrataflow/validation';
import type {
  DfdDto,
  DocumentSectionSavedDto,
  DraftSection,
  ProcessDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
  filledSection,
} from '../../../../test/support/document-fixtures.js';
import type { DocumentTransactions } from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedParticipant,
  seedProcessStructure,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { DFD_CLOCK } from '../application/ports.js';
import { InMemoryDfdRepository } from '../infrastructure/dfd.repositories.js';

/*
 * US-015 — autosave, retomada e conflito do DFD pelo pipeline HTTP completo (autenticação, tenant,
 * vínculo, autorização, `If-Match`, limite `autosave`, filtro RFC 9457) com a identidade fake, os
 * seeders reais e o DFD criado pelo DFD-02. DOC-05 (seções) e DFD-04 (cabeçalho) nas 8 categorias
 * do Gherkin + FA-02/05/06/09/10 e RN-DFD-26/29/34/35/36. Ana (REQUISITANTE, responsável) é a
 * "Cláudia"; Otávio, participante CONSULTANT, é o "Bruno"; Lúcia (PLANEJAMENTO, sem custódia) é a
 * "Patrícia". A atualização condicional atômica sob 50 gravações paralelas, o `Document.version`
 * intacto e a RLS no PostgreSQL: `test/tenant-leak/dfd-autosave.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-17T15:00:00.000Z');

const UNITS_A = {
  organizationId: '0192d015-0000-7000-8000-0000000000a0',
  obras: '0192d015-0000-7000-8000-0000000000a1',
  manutencao: '0192d015-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d015-0000-7000-8000-0000000000a3',
  saude: '0192d015-0000-7000-8000-0000000000a4',
  posto: '0192d015-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d015-0000-7000-8000-0000000000b0',
  obras: '0192d015-0000-7000-8000-0000000000b1',
  manutencao: '0192d015-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d015-0000-7000-8000-0000000000b3',
  saude: '0192d015-0000-7000-8000-0000000000b4',
  posto: '0192d015-0000-7000-8000-0000000000b5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações de documento que podem simular o banco fora do ar (FA-03). */
class FlakyDocumentTransactions implements DocumentTransactions {
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

/** Janela da coalescência com relógio simulado e Redis que pode cair. */
class SwitchableWindowStore extends InMemoryDraftAuditWindowStore {
  down = false;

  override open(key: string, windowMs: number) {
    if (this.down) return Promise.reject(new Error('ECONNREFUSED'));
    return super.open(key, windowMs);
  }

  override markAudited(key: string, revision: number) {
    if (this.down) return Promise.reject(new Error('ECONNREFUSED'));
    return super.markAudited(key, revision);
  }

  override release(key: string) {
    if (this.down) return Promise.reject(new Error('ECONNREFUSED'));
    return super.release(key);
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

describe('Feature: Autosave, retomada e conflito na edição do DFD (US-015)', () => {
  let api: TestApi;
  let clockMs = NOW.getTime();
  const transactions = new FlakyDocumentTransactions();
  const windows = new SwitchableWindowStore(() => clockMs);
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = 'sub-ana', tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const putSection = (
    documentId: string,
    sectionKey: string,
    body: Record<string, unknown>,
    options: { ifMatch?: string | null; subject?: string; tenant?: string } = {},
  ) => {
    const call = auth(
      request(api.server).put(`/api/v1/documents/${documentId}/sections/${sectionKey}`),
      options.subject,
      options.tenant,
    );
    const ifMatch = options.ifMatch === undefined ? '"s1"' : options.ifMatch;
    return (ifMatch === null ? call : call.set('If-Match', ifMatch)).send({
      notApplicable: false,
      justification: null,
      ...body,
    });
  };
  const patchDfd = (
    dfdId: string,
    body: Record<string, unknown>,
    options: { ifMatch?: string | null; subject?: string; tenant?: string } = {},
  ) => {
    const call = auth(
      request(api.server).patch(`/api/v1/dfds/${dfdId}`),
      options.subject,
      options.tenant,
    );
    const ifMatch = options.ifMatch === undefined ? '"1"' : options.ifMatch;
    return (ifMatch === null ? call : call.set('If-Match', ifMatch)).send(body);
  };
  const getDfd = (dfdId: string, subject = 'sub-ana') =>
    auth(request(api.server).get(`/api/v1/dfds/${dfdId}`), subject);

  const documentOf = (documentId: string) => {
    const found = documentRepositoryOf(api)
      .allDocuments()
      .find((candidate) => candidate.id === documentId);
    if (!found) throw new Error('documento ausente');
    return found;
  };
  const dfdStore = () => api.app.get(InMemoryDfdRepository, { strict: false });
  const draftAudits = (documentId: string) =>
    api
      .auditRecords()
      .filter((row) => row.action === 'document.draft_update' && row.entityId === documentId);

  async function newProcess(fields: Partial<Process> = {}): Promise<Process> {
    const response = await auth(request(api.server).post('/api/v1/processes'))
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Aquisição de insumos ${words(2)}`,
        object: `Aquisição de insumos para a UBS Centro ${words(2)}`,
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
    const process: Process = { ...created, ...fields };
    processRepositoryOf(api).replace(process);
    return process;
  }

  async function createDfd(processId: string, subject = 'sub-ana', tenant: string = A) {
    const response = await auth(
      request(api.server).post(`/api/v1/processes/${processId}/dfds`),
      subject,
      tenant,
    )
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return dfdSchema.parse(data<DfdDto>(response));
  }

  /** Seção do rascunho numa revisão do cenário (Background: JUSTIFICATION na revisão 3). */
  function seedSection(documentId: string, key: string, section: DraftSection) {
    const document = documentOf(documentId);
    documentRepositoryOf(api).seed({
      ...document,
      draftContent: { sections: { ...document.draftContent.sections, [key]: section } },
    });
  }

  /** Background: DFD em DRAFT com JUSTIFICATION na revisão 3; Otávio ("Bruno") CONSULTANT. */
  async function background() {
    const process = await newProcess();
    const dfd = await createDfd(process.id);
    seedSection(
      dfd.documentId,
      'JUSTIFICATION',
      filledSection('Texto anterior da justificativa', { revision: 3 }),
    );
    seedParticipant(api, {
      tenantId: A,
      processId: process.id,
      userId: FAKE_USERS.otavio.id,
      role: 'CONSULTANT',
      expiresAt: new Date('2026-12-31T23:59:59Z'),
    });
    return { process, dfd };
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: DOCUMENT_TRANSACTIONS, value: transactions },
        { token: DRAFT_AUDIT_WINDOW_STORE, value: windows },
        { token: DFD_CLOCK, value: () => NOW },
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
    await runTenantSeeders(api, B, [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
    ]);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    const roles = seedDefaultRolesOf(api, A);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: roles.get('SOMENTE_LEITURA')?.id ?? '',
    });
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.lucia.id),
      roleId: roles.get('PLANEJAMENTO')?.id ?? '',
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
    windows.down = false;
    clockMs = NOW.getTime();
  });

  describe('[Sucesso]', () => {
    it('Salvar a seção após uma pausa: If-Match "s3" → 200 revisão 4, ETag "s4", sem versão nova e auditoria coalescida 4..4', async () => {
      const { dfd } = await background();
      const before = documentOf(dfd.documentId);
      const response = await putSection(
        dfd.documentId,
        'JUSTIFICATION',
        { content: paragraph('A UBS Centro atende 12 mil pessoas e está sem estoque de luvas.') },
        { ifMatch: '"s3"' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"s4"');
      const saved = documentSectionSavedSchema.parse(data<DocumentSectionSavedDto>(response));
      expect(saved).toMatchObject({
        sectionKey: 'JUSTIFICATION',
        state: 'FILLED',
        revision: 4,
        draftRevision: before.draftRevision + 1,
        updatedBy: { id: FAKE_USERS.ana.id, name: FAKE_USERS.ana.name },
      });

      const after = documentOf(dfd.documentId);
      // RN-DFD-24/26: nenhuma versão; `Document.version` intacta (o If-Match dos itens não muda).
      expect(after.version).toBe(before.version);
      expect(after.currentVersionId).toBeNull();
      expect(after.draftContent.sections.JUSTIFICATION).toMatchObject({ revision: 4 });
      const [audit] = draftAudits(dfd.documentId);
      expect(audit).toMatchObject({
        category: 'DATA_CHANGE',
        metadata: expect.objectContaining({
          target: 'SECTION:JUSTIFICATION',
          fromRevision: 4,
          toRevision: 4,
          windowMinutes: 10,
          sizeBytesAfter: expect.any(Number) as unknown,
          contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        }) as unknown,
      });
      // Nunca o texto na auditoria.
      expect(JSON.stringify(audit)).not.toContain('12 mil pessoas');
    });

    it('RN-DFD-35: no máximo 1 registro por seção/usuário em 10 min; o seguinte cobre a faixa desde o último auditado', async () => {
      const { dfd } = await background();
      for (const [index, revision] of [3, 4, 5].entries()) {
        clockMs = NOW.getTime() + index * 60_000;
        const response = await putSection(
          dfd.documentId,
          'JUSTIFICATION',
          { content: paragraph(`Versão ${String(index)} da justificativa da necessidade`) },
          { ifMatch: `"s${String(revision)}"` },
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      }
      expect(draftAudits(dfd.documentId)).toHaveLength(1);
      clockMs = NOW.getTime() + 11 * 60_000;
      const later = await putSection(
        dfd.documentId,
        'JUSTIFICATION',
        { content: paragraph('Versão final da justificativa da necessidade') },
        { ifMatch: '"s6"' },
      );
      expect(later.status, JSON.stringify(later.body)).toBe(200);
      const audits = draftAudits(dfd.documentId);
      expect(audits).toHaveLength(2);
      expect(audits[1]?.metadata).toMatchObject({ fromRevision: 5, toRevision: 7 });
    });

    it('Retomar no passo em que parou: wizardStep gravado pelo DFD-04 abre o DFD-03 no passo (outro computador)', async () => {
      const { dfd } = await background();
      const saved = await patchDfd(dfd.id, {
        wizardStep: 'PLANNING',
        completedSteps: ['JUSTIFICATION', 'IDENTIFICATION'],
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.headers.etag).toBe('"2"');
      // O passo do wizard não é auditado (não é dado do documento).
      expect(draftAudits(dfd.documentId)).toEqual([]);
      const reopened = dfdSchema.parse(data<DfdDto>(await getDfd(dfd.id)));
      expect(reopened).toMatchObject({
        wizardStep: 'PLANNING',
        completedSteps: ['IDENTIFICATION', 'JUSTIFICATION'],
        version: 2,
      });
    });

    it('Edição simultânea em seções diferentes não gera conflito', async () => {
      const { dfd } = await background();
      const [claudia, bruno] = await Promise.all([
        putSection(
          dfd.documentId,
          'JUSTIFICATION',
          { content: paragraph('Justificativa da Cláudia com detalhes da necessidade') },
          { ifMatch: '"s3"' },
        ),
        putSection(
          dfd.documentId,
          'EXPECTED_RESULTS',
          { content: paragraph('Resultados esperados escritos pelo consultor') },
          { ifMatch: '"s1"', subject: 'sub-otavio' },
        ),
      ]);
      expect(claudia.status, JSON.stringify(claudia.body)).toBe(200);
      expect(bruno.status, JSON.stringify(bruno.body)).toBe(200);
      const sections = documentOf(dfd.documentId).draftContent.sections;
      expect(sections.JUSTIFICATION?.revision).toBe(4);
      expect(sections.EXPECTED_RESULTS).toMatchObject({
        revision: 2,
        updatedById: FAKE_USERS.otavio.id,
      });
    });

    it('DFD-04 grava só os campos enviados, com auditoria imediata dos campos de dados', async () => {
      const { dfd } = await background();
      const response = await patchDfd(dfd.id, { priority: 'HIGH' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(dfdSchema.parse(data<DfdDto>(response))).toMatchObject({
        priority: 'HIGH',
        objectSummary: dfd.objectSummary,
        version: 2,
      });
      expect(draftAudits(dfd.documentId).at(-1)).toMatchObject({
        changes: [{ path: 'priority', old: 'MEDIUM', new: 'HIGH' }],
        metadata: expect.objectContaining({ target: 'HEADER', fields: ['priority'] }) as unknown,
      });
      // Patch igual ao atual: 200 sem versão nova.
      const same = await patchDfd(dfd.id, { priority: 'HIGH' }, { ifMatch: '"2"' });
      expect(same.status).toBe(200);
      expect(same.headers.etag).toBe('"2"');
    });

    it('Textos do cabeçalho: auditoria coalescida com hash + tamanho, nunca o texto', async () => {
      const { dfd } = await background();
      const summary = 'Aquisição de luvas e seringas para a UBS Centro em 2027';
      const response = await patchDfd(dfd.id, { objectSummary: summary });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const [audit] = draftAudits(dfd.documentId);
      expect(audit?.metadata).toMatchObject({ target: 'HEADER', fromRevision: 2, toRevision: 2 });
      expect(JSON.stringify(audit)).not.toContain(summary);
      const second = await patchDfd(
        dfd.id,
        { objectSummary: `${summary} — revisado` },
        { ifMatch: '"2"' },
      );
      expect(second.status).toBe(200);
      expect(draftAudits(dfd.documentId)).toHaveLength(1);
    });
  });

  describe('[Validação]', () => {
    it('Texto acima do limite da seção: 422 VALIDATION_ERROR TOO_LONG "O texto excede 50.000 caracteres."', async () => {
      const { dfd } = await background();
      const response = await putSection(
        dfd.documentId,
        'JUSTIFICATION',
        { content: paragraph('a'.repeat(50_001)) },
        { ifMatch: '"s3"' },
      );
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        expect.objectContaining({
          field: 'content',
          code: 'TOO_LONG',
          message: 'O texto excede 50.000 caracteres.',
        }),
      ]);
      expect(documentOf(dfd.documentId).draftContent.sections.JUSTIFICATION?.revision).toBe(3);
    });

    it('Gravação sem pré-condição: 428 PRECONDITION_REQUIRED (seção e cabeçalho)', async () => {
      const { dfd } = await background();
      expectProblem(
        await putSection(dfd.documentId, 'JUSTIFICATION', { content: null }, { ifMatch: null }),
        428,
        'PRECONDITION_REQUIRED',
      );
      expectProblem(
        await patchDfd(dfd.id, { priority: 'LOW' }, { ifMatch: null }),
        428,
        'PRECONDITION_REQUIRED',
      );
    });

    it('V-04/V-05/V-06: chave fora do template (422), formatação não permitida (422) e seção acima de 1 MB (413)', async () => {
      const { dfd } = await background();
      expectProblem(
        await putSection(dfd.documentId, 'INEXISTENTE', { content: null }, { ifMatch: '"s0"' }),
        422,
        'SECTION_NOT_IN_TEMPLATE',
      );
      const invalid = expectProblem(
        await putSection(
          dfd.documentId,
          'JUSTIFICATION',
          { content: { type: 'doc', content: [{ type: 'iframe' }] } },
          { ifMatch: '"s3"' },
        ),
        422,
        'RICH_TEXT_INVALID',
      );
      expect(invalid.detail).toBe(
        'O texto contém formatação não permitida. Cole como texto simples.',
      );
      const huge = {
        type: 'doc',
        content: Array.from({ length: 1100 }, () => ({
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }] }],
          attrs: { padding: 'p'.repeat(1000) },
        })),
      };
      expectProblem(
        await putSection(dfd.documentId, 'JUSTIFICATION', { content: huge }, { ifMatch: '"s3"' }),
        413,
        'PAYLOAD_TOO_LARGE',
      );
    });

    it('Seção esvaziada fica EMPTY (estado derivado no servidor — RN-DFD-31)', async () => {
      const { dfd } = await background();
      const response = await putSection(
        dfd.documentId,
        'JUSTIFICATION',
        { content: paragraph('   ') },
        { ifMatch: '"s3"' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<DocumentSectionSavedDto>(response).state).toBe('EMPTY');
      expect(documentOf(dfd.documentId).draftContent.sections.JUSTIFICATION?.content).toBeNull();
    });

    it('V-12/V-13: campo do cabeçalho inválido (422 por campo) e campo não editável (NOT_ALLOWED)', async () => {
      const { dfd } = await background();
      const invalid = expectProblem(
        await patchDfd(dfd.id, { objectSummary: 'curto', requestDate: '2026-10-18' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(invalid.errors.map((error) => [error.field, error.code])).toEqual([
        ['requestDate', 'OUT_OF_RANGE'],
        ['objectSummary', 'TOO_SHORT'],
      ]);
      const notAllowed = expectProblem(
        await patchDfd(dfd.id, { processId: randomUUID() }),
        422,
        'VALIDATION_ERROR',
      );
      expect(notAllowed.errors).toEqual([expect.objectContaining({ code: 'NOT_ALLOWED' })]);
      const outside = expectProblem(
        await patchDfd(dfd.id, { requestingDepartmentId: UNITS_A.posto }),
        422,
        'VALIDATION_ERROR',
      );
      expect(outside.errors).toEqual([
        expect.objectContaining({
          field: 'requestingDepartmentId',
          code: 'DEPARTMENT_NOT_IN_SECRETARIAT',
        }),
      ]);
      const pca = expectProblem(
        await patchDfd(dfd.id, { pcaStatus: 'NOT_PLANNED' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(pca.errors).toEqual([
        expect.objectContaining({ field: 'pcaJustification', code: 'CONDITIONAL_REQUIRED' }),
      ]);
      expect(
        dfdStore()
          .snapshot()
          .find((row) => row.id === dfd.id)?.version,
      ).toBe(1);
      const both = await patchDfd(dfd.id, {
        pcaStatus: 'NOT_PLANNED',
        pcaJustification: 'Demanda emergencial surgida após a aprovação do plano anual.',
        expectedDate: '2026-12-01',
      });
      expect(both.status, JSON.stringify(both.body)).toBe(200);
    });
  });

  describe('[Permissão]', () => {
    it('Usuária que perdeu a custódia: 403 NOT_PROCESS_CUSTODIAN com access.denied POL-02', async () => {
      const { process, dfd } = await background();
      processRepositoryOf(api).replace({
        ...(processRepositoryOf(api)
          .allProcesses()
          .find((candidate) => candidate.id === process.id) ?? process),
        currentResponsibleId: FAKE_USERS.lucia.id,
      });
      const problem = expectProblem(
        await putSection(
          dfd.documentId,
          'JUSTIFICATION',
          { content: paragraph('Alteração feita depois da troca de responsável') },
          { ifMatch: '"s3"' },
        ),
        403,
        'NOT_PROCESS_CUSTODIAN',
      );
      expect(problem.detail).toBe(
        'Somente quem está com o processo (ou colaboradores) pode editar.',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'POL-02',
      });
      expectProblem(await patchDfd(dfd.id, { priority: 'LOW' }), 403, 'NOT_PROCESS_CUSTODIAN');
      expect(documentOf(dfd.documentId).draftContent.sections.JUSTIFICATION?.revision).toBe(3);
    });

    it('DFD enviado para aprovação em outra aba: 409 DOCUMENT_NOT_EDITABLE com o status e desde quando', async () => {
      const { dfd } = await background();
      const submittedAt = new Date('2026-10-17T17:40:00.000Z');
      documentRepositoryOf(api).seed({
        ...documentOf(dfd.documentId),
        status: 'IN_REVIEW',
        submittedAt,
      });
      const response = await putSection(
        dfd.documentId,
        'JUSTIFICATION',
        { content: paragraph('Alteração pendente enviada depois da submissão') },
        { ifMatch: '"s3"' },
      );
      expectProblem(response, 409, 'DOCUMENT_NOT_EDITABLE');
      expect(response.body).toMatchObject({
        meta: { status: 'IN_REVIEW', statusSince: submittedAt.toISOString() },
      });
      expectProblem(await patchDfd(dfd.id, { priority: 'LOW' }), 409, 'DOCUMENT_NOT_EDITABLE');
    });

    it('Somente leitura (sem custódia nem participação): 403 PERMISSION_DENIED; FA-06 processo suspenso: 409 INVALID_PROCESS_STATUS', async () => {
      const { process, dfd } = await background();
      const outsider = await newProcess();
      const outsiderDfd = await createDfd(outsider.id);
      expectProblem(
        await putSection(
          outsiderDfd.documentId,
          'JUSTIFICATION',
          { content: paragraph('Tentativa sem permissão de edição alguma') },
          { ifMatch: '"s1"', subject: 'sub-otavio' },
        ),
        403,
        'PERMISSION_DENIED',
      );
      processRepositoryOf(api).replace({
        ...(processRepositoryOf(api)
          .allProcesses()
          .find((candidate) => candidate.id === process.id) ?? process),
        status: 'SUSPENDED',
      });
      expectProblem(
        await putSection(
          dfd.documentId,
          'JUSTIFICATION',
          { content: paragraph('Tentativa com o processo suspenso por decisão') },
          { ifMatch: '"s3"' },
        ),
        409,
        'INVALID_PROCESS_STATUS',
      );
    });

    it('POL-09: estimativa em processo sigiloso sem a política → 403 PERMISSION_DENIED (consultor)', async () => {
      const { process, dfd } = await background();
      processRepositoryOf(api).replace({
        ...(processRepositoryOf(api)
          .allProcesses()
          .find((candidate) => candidate.id === process.id) ?? process),
        isBudgetConfidential: true,
      });
      expectProblem(
        await patchDfd(dfd.id, { estimatedValue: '1000.00' }, { subject: 'sub-otavio' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'POL-09',
      });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Seção de documento de outro tenant: 404 NOT_FOUND e nada alterado em nenhum tenant', async () => {
      const { dfd } = await background();
      const before = documentOf(dfd.documentId);
      // Documento da "Prefeitura de Santa Luzia" (tenant B) visto pela Cláudia no tenant A.
      const foreign = { ...before, id: newId(), tenantId: B, processId: newId() };
      documentRepositoryOf(api).seed(foreign);
      expectProblem(
        await putSection(
          foreign.id,
          'JUSTIFICATION',
          { content: paragraph('Tentativa sobre um documento de outro órgão') },
          { ifMatch: '"s3"' },
        ),
        404,
        'NOT_FOUND',
      );
      // O documento e o DFD de A vistos por quem só tem vínculo em B.
      expectProblem(
        await putSection(
          dfd.documentId,
          'JUSTIFICATION',
          { content: paragraph('Tentativa a partir da Prefeitura de Santa Luzia') },
          { ifMatch: '"s3"', subject: 'sub-heitor', tenant: B },
        ),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await patchDfd(dfd.id, { priority: 'LOW' }, { subject: 'sub-heitor', tenant: B }),
        404,
        'DFD_NOT_FOUND',
      );
      expect(documentOf(dfd.documentId)).toEqual(before);
      expect(
        documentRepositoryOf(api)
          .allDocuments()
          .find((candidate) => candidate.id === foreign.id),
      ).toEqual(foreign);
      expect(draftAudits(dfd.documentId)).toEqual([]);
      expect(draftAudits(foreign.id)).toEqual([]);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio idêntico após tempo esgotado: 200 com a revisão 4, sem revisão 5, sem conflito nem auditoria nova', async () => {
      const { dfd } = await background();
      const body = { content: paragraph('Justificativa enviada duas vezes pela rede instável') };
      const first = await putSection(dfd.documentId, 'JUSTIFICATION', body, { ifMatch: '"s3"' });
      expect(first.status).toBe(200);
      const audits = draftAudits(dfd.documentId).length;
      const replay = await putSection(dfd.documentId, 'JUSTIFICATION', body, { ifMatch: '"s3"' });
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.headers.etag).toBe('"s4"');
      expect(data<DocumentSectionSavedDto>(replay).revision).toBe(4);
      expect(documentOf(dfd.documentId).draftContent.sections.JUSTIFICATION?.revision).toBe(4);
      expect(draftAudits(dfd.documentId)).toHaveLength(audits);
    });
  });

  describe('[Concorrência]', () => {
    it('Duas pessoas editam a mesma seção: 412 com meta.current e "Manter a minha versão" gera a revisão 7 com KEEP_MINE', async () => {
      const { dfd } = await background();
      seedSection(dfd.documentId, 'JUSTIFICATION', filledSection('Base comum', { revision: 5 }));
      const bruno = await putSection(
        dfd.documentId,
        'JUSTIFICATION',
        { content: paragraph('Texto do Bruno, salvo primeiro') },
        { ifMatch: '"s5"', subject: 'sub-otavio' },
      );
      expect(bruno.status, JSON.stringify(bruno.body)).toBe(200);
      const mine = { content: paragraph('Texto da Cláudia, salvo em seguida') };
      const conflict = await putSection(dfd.documentId, 'JUSTIFICATION', mine, { ifMatch: '"s5"' });
      const problem = expectProblem(conflict, 412, 'SECTION_REVISION_CONFLICT');
      expect(problem.detail).toBe(
        `Esta seção foi alterada por ${FAKE_USERS.otavio.name} às 12:00.`,
      );
      const current = sectionConflictCurrentSchema.parse(
        (conflict.body as { meta: { current: unknown } }).meta.current,
      );
      expect(current).toMatchObject({
        revision: 6,
        state: 'FILLED',
        content: paragraph('Texto do Bruno, salvo primeiro'),
        updatedBy: { id: FAKE_USERS.otavio.id, name: FAKE_USERS.otavio.name },
      });

      const kept = await putSection(
        dfd.documentId,
        'JUSTIFICATION',
        { ...mine, overwrittenRevision: 6 },
        { ifMatch: '"s6"' },
      );
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      expect(kept.headers.etag).toBe('"s7"');
      expect(documentOf(dfd.documentId).draftContent.sections.JUSTIFICATION).toMatchObject({
        revision: 7,
        content: mine.content,
      });
      expect(draftAudits(dfd.documentId).at(-1)).toMatchObject({
        metadata: expect.objectContaining({
          conflictResolution: 'KEEP_MINE',
          overwrittenRevision: 6,
          overwrittenAuthorId: FAKE_USERS.otavio.id,
          toRevision: 7,
        }) as unknown,
      });
    });

    it('FA-10: a mesma pessoa em duas abas recebe 412 identificando ela mesma', async () => {
      const { dfd } = await background();
      const first = await putSection(
        dfd.documentId,
        'JUSTIFICATION',
        { content: paragraph('Aba um da mesma pessoa') },
        { ifMatch: '"s3"' },
      );
      expect(first.status).toBe(200);
      const second = await putSection(
        dfd.documentId,
        'JUSTIFICATION',
        { content: paragraph('Aba dois da mesma pessoa') },
        { ifMatch: '"s3"' },
      );
      expectProblem(second, 412, 'SECTION_REVISION_CONFLICT');
      expect(
        (second.body as { meta: { current: { updatedBy: { id: string } } } }).meta.current.updatedBy
          .id,
      ).toBe(FAKE_USERS.ana.id);
    });

    it('Gravações paralelas na mesma seção: exatamente uma por revisão, as demais 412', async () => {
      const { dfd } = await background();
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          putSection(
            dfd.documentId,
            'JUSTIFICATION',
            { content: paragraph(`Texto concorrente número ${String(index)}`) },
            { ifMatch: '"s3"' },
          ),
        ),
      );
      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
      expect(responses.filter((response) => response.status === 412)).toHaveLength(9);
      expect(documentOf(dfd.documentId).draftContent.sections.JUSTIFICATION?.revision).toBe(4);
    });

    it('Conflito de cabeçalho em campos diferentes: 412 VERSION_CONFLICT com meta.current; o reenvio com "9" termina na versão 10', async () => {
      const { dfd } = await background();
      dfdStore().seed({
        ...(dfdStore()
          .snapshot()
          .find((row) => row.id === dfd.id) ??
          (() => {
            throw new Error('DFD ausente');
          })()),
        version: 8,
      });
      const bruno = await patchDfd(
        dfd.id,
        { expectedDate: '2027-03-01' },
        { ifMatch: '"8"', subject: 'sub-otavio' },
      );
      expect(bruno.status, JSON.stringify(bruno.body)).toBe(200);
      const claudia = await patchDfd(dfd.id, { priority: 'URGENT' }, { ifMatch: '"8"' });
      expectProblem(claudia, 412, 'VERSION_CONFLICT');
      const current = dfdConflictCurrentSchema.parse(
        (claudia.body as { meta: { current: unknown } }).meta.current,
      );
      expect(current).toMatchObject({
        version: 9,
        expectedDate: '2027-03-01',
        priority: 'MEDIUM',
        updatedBy: { id: FAKE_USERS.otavio.id, name: FAKE_USERS.otavio.name },
      });
      // O cliente vê que o servidor alterou só a previsão e reenvia a prioridade (merge — RN-DFD-28).
      const retried = await patchDfd(
        dfd.id,
        { priority: 'URGENT' },
        { ifMatch: `"${String(current.version)}"` },
      );
      expect(retried.status, JSON.stringify(retried.body)).toBe(200);
      expect(dfdSchema.parse(data<DfdDto>(retried))).toMatchObject({
        version: 10,
        expectedDate: '2027-03-01',
        priority: 'URGENT',
      });
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível: 503 DEPENDENCY_UNAVAILABLE; quando o banco volta, a mesma gravação é aceita', async () => {
      const { dfd } = await background();
      const body = { content: paragraph('Texto guardado no navegador durante a queda do banco') };
      transactions.down = true;
      const down = await putSection(dfd.documentId, 'JUSTIFICATION', body, { ifMatch: '"s3"' });
      expectProblem(down, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(down.headers['retry-after']).toBeDefined();
      transactions.down = false;
      const retried = await putSection(dfd.documentId, 'JUSTIFICATION', body, { ifMatch: '"s3"' });
      expect(retried.status, JSON.stringify(retried.body)).toBe(200);
      expect(data<DocumentSectionSavedDto>(retried).revision).toBe(4);
      // A janela aberta pela gravação que falhou foi devolvida: a que vingou é auditada.
      expect(draftAudits(dfd.documentId)).toHaveLength(1);
    });
  });

  describe('[Falha de integração]', () => {
    it('Restauração após queda de rede: a pendência local com a revisão-base é salva na revisão seguinte', async () => {
      const { dfd } = await background();
      const base = documentOf(dfd.documentId).draftContent.sections.EXPECTED_RESULTS?.revision ?? 0;
      const restored = await putSection(
        dfd.documentId,
        'EXPECTED_RESULTS',
        { content: paragraph('Resultados digitados sem conexão e restaurados') },
        { ifMatch: `"s${String(base)}"` },
      );
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect(data<DocumentSectionSavedDto>(restored).revision).toBe(base + 1);
    });

    it('Redis indisponível: três gravações em 2 min respondem 200, geram três auditorias e o warn audit.coalesce_store_unavailable', async () => {
      const { dfd } = await background();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      warn.mockClear();
      windows.down = true;
      for (const [index, revision] of [3, 4, 5].entries()) {
        clockMs = NOW.getTime() + index * 40_000;
        const response = await putSection(
          dfd.documentId,
          'JUSTIFICATION',
          { content: paragraph(`Gravação ${String(index)} com o Redis fora do ar`) },
          { ifMatch: `"s${String(revision)}"` },
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      }
      expect(draftAudits(dfd.documentId)).toHaveLength(3);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'audit.coalesce_store_unavailable' }),
        'audit.coalesce_store_unavailable',
      );
    });

    it('Limite de gravações (429 RATE_LIMITED) por usuário e documento', async () => {
      const { dfd } = await background();
      const responses: request.Response[] = [];
      for (let attempt = 0; attempt < 61; attempt += 1) {
        const response = await putSection(
          dfd.documentId,
          'JUSTIFICATION',
          { content: paragraph('Texto repetido para medir o limite de gravações') },
          { ifMatch: '"s3"' },
        );
        responses.push(response);
      }
      const last = responses.at(-1);
      if (last === undefined) throw new Error('sem resposta');
      expectProblem(last, 429, 'RATE_LIMITED');
      expect(last.headers['retry-after']).toBeDefined();
    });
  });
});
