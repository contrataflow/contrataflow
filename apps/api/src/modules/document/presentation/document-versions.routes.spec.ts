import { randomUUID } from 'node:crypto';

import {
  DOCUMENT_VERSION_MESSAGES,
  documentVersionComparisonSchema,
  documentVersionSchema,
  documentVersionSummarySchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type {
  DocumentVersionComparisonDto,
  DocumentVersionDto,
  DocumentVersionSummaryDto,
  PageMeta,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  buildDocument,
  buildVersion,
  createDocumentAs,
  documentRepositoryOf,
  documentTypeRepositoryOf,
  openStageForAnyType,
} from '../../../../test/support/document-fixtures.js';
import type { FixtureActor } from '../../../../test/support/document-fixtures.js';
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
import { DocumentValidatorRegistry } from '../application/document.ports.js';
import type { DocumentValidator, TypedSnapshotParts } from '../application/document.ports.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from '../application/ports.js';
import type { DocumentTransactions } from '../application/ports.js';
import { snapshotHash } from '../domain/document-snapshot.js';

/*
 * US-066 — DOC-15/16/17/18 pelo pipeline HTTP completo (autenticação, tenant, vínculo, autorização,
 * idempotência, filtro RFC 9457) com a identidade fake, os seeders reais e os adaptadores em
 * memória. Os 8 cenários do Gherkin, a listagem, a consulta e a comparação com POL-09. Gatilho
 * só-INSERT, RLS e concorrência no PostgreSQL: `test/tenant-leak/document-versions.spec.ts`.
 *
 * Personas: o redator custodiante do Gherkin = Lúcia (GESTOR_CONTRATACOES, cria o processo e é a
 * responsável); "Carlos" sem a permissão de edição do tipo = Ana (REQUISITANTE: sem
 * `PRICE_RESEARCH_UPDATE`), feita responsável do processo; leitora sem POL-09 = Ana lotada no setor
 * solicitante (vê o processo, sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` nem custódia).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-17T13:00:00.000Z');

const ORG_A = '0192d066-0000-7000-8000-0000000000a0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d066-0000-7000-8000-0000000000a1',
  manutencao: '0192d066-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d066-0000-7000-8000-0000000000a3',
  saude: '0192d066-0000-7000-8000-0000000000a4',
  posto: '0192d066-0000-7000-8000-0000000000a5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

const LUCIA: FixtureActor = {
  tenantId: A,
  userId: FAKE_USERS.lucia.id,
  membershipId: membershipOf(FAKE_USERS.lucia.id),
};

/** Transações do módulo que podem simular o banco fora do ar (Falha de banco). */
class FlakyTransactions implements DocumentTransactions {
  down = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }
}

/** Módulo tipado DFD simulado: cabeçalho e itens congelados na versão (com valor monetário). */
class FakeDfdValidator implements DocumentValidator {
  readonly module = 'DFD' as const;
  parts: TypedSnapshotParts = { header: {}, collections: {} };

  validate() {
    return Promise.resolve([]);
  }

  snapshotParts(): Promise<TypedSnapshotParts> {
    return Promise.resolve(this.parts);
  }
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

function versionOf(response: request.Response, status = 201): DocumentVersionDto {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return documentVersionSchema.parse((response.body as { data: unknown }).data);
}

function comparisonOf(response: request.Response): DocumentVersionComparisonDto {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return documentVersionComparisonSchema.parse((response.body as { data: unknown }).data);
}

describe('Feature: Versionamento imutável e comparação de versões (US-066)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  const dfdValidator = new FakeDfdValidator();
  let types: { despacho: string; dfd: string; priceResearch: string; externo: string };

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  /** Processo novo (PRC-02) criado por Lúcia, que fica responsável (custódia — POL-01). */
  async function newProcess(): Promise<string> {
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-lucia', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const id = (response.body as { data: { id: string } }).data.id;
    openStages.add(id);
    return id;
  }
  let openStages: Set<string>;

  const newDocument = (
    processId: string,
    typeId = types.despacho,
    title = 'ETP 0003/2026 — rascunho',
  ) =>
    createDocumentAs(api, LUCIA, {
      processId,
      documentTypeId: typeId,
      title,
      templateVersionId: null,
    });

  /** Altera o processo em memória (sigilo do orçamento, responsável). */
  function patchProcess(processId: string, patch: Record<string, unknown>) {
    const repository = processRepositoryOf(api);
    const process = repository.allProcesses().find((row) => row.id === processId);
    if (process === undefined) throw new Error('processo não encontrado');
    repository.seed({ ...process, ...patch });
  }

  const call = (
    method: 'get' | 'post',
    path: string,
    options: { subject?: string; tenant?: string; key?: string | null; body?: object } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${path}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (options.key !== undefined && options.key !== null)
      pending = pending.set('Idempotency-Key', options.key);
    return options.body === undefined ? pending : pending.send(options.body);
  };

  const save = (
    documentId: string,
    options: { summary?: string; key?: string; subject?: string } = {},
  ) =>
    call('post', `/documents/${documentId}/versions`, {
      key: options.key ?? randomUUID(),
      ...(options.subject === undefined ? {} : { subject: options.subject }),
      body: options.summary === undefined ? {} : { changeSummary: options.summary },
    });

  const compare = (documentId: string, from: string, to: string, subject?: string) =>
    call('get', `/documents/${documentId}/versions/compare?from=${from}&to=${to}`, {
      ...(subject === undefined ? {} : { subject }),
    });

  const stored = (id: string) => {
    const row = documentRepositoryOf(api)
      .allDocuments()
      .find((candidate) => candidate.id === id);
    if (!row) throw new Error(`documento ${id} não gravado`);
    return row;
  };
  const versionsOf = (id: string) => documentRepositoryOf(api).versionsOf(id);
  const auditOf = (action: string, entityId?: string) =>
    api
      .auditRecords()
      .filter(
        (row) => row.action === action && (entityId === undefined || row.entityId === entityId),
      );
  const eventsOf = (aggregateId: string) =>
    api.outboxRows().filter((row) => row.aggregateId === aggregateId);

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: DOCUMENT_TRANSACTIONS, value: transactions },
        { token: DOCUMENT_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B, [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
    ]);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: seedDefaultRolesOf(api, A).get('CONSULTOR_EXTERNO')?.id ?? '',
    });
    openStages = openStageForAnyType(api);
    api.app.get(DocumentValidatorRegistry).register(dfdValidator);
    const seeded = documentTypeRepositoryOf(api)
      .snapshot()
      .filter((type) => type.tenantId === A);
    const idOf = (code: string) => seeded.find((type) => type.code === code)?.id ?? '';
    types = {
      despacho: idOf('DESPACHO'),
      dfd: idOf('DFD'),
      priceResearch: idOf('PRICE_RESEARCH'),
      externo: idOf('DOCUMENTO_EXTERNO'),
    };
    expect(Object.values(types).every((id) => id !== '')).toBe(true);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
    dfdValidator.parts = { header: {}, collections: {} };
  });

  describe('[Sucesso]', () => {
    it('Salvar uma versão manual: v1 MANUAL, hash do snapshot canônico, evento, auditoria e 201', async () => {
      const processId = await newProcess();
      const document = await newDocument(processId);

      const response = await save(document.id, { summary: 'Ajuste na justificativa' });
      const version = versionOf(response);
      expect(response.headers.location).toBe(`/api/v1/document-versions/${version.id}`);
      expect(version).toMatchObject({
        documentId: document.id,
        processId,
        versionNumber: 1,
        reason: 'MANUAL',
        statusAtCreation: 'DRAFT',
        changeSummary: 'Ajuste na justificativa',
        createdById: FAKE_USERS.lucia.id,
        createdByName: expect.any(String) as unknown,
        createdAt: NOW.toISOString(),
        kind: 'FREE_TEXT',
      });
      expect(version.content).not.toBeNull();
      expect(version.contentHash).toBe(version.content ? snapshotHash(version.content) : null);

      // O status não muda; o documento aponta a versão nova (e o ETag avança).
      expect(stored(document.id)).toMatchObject({
        status: 'DRAFT',
        currentVersionId: version.id,
        version: 2,
      });
      expect(versionsOf(document.id)).toHaveLength(1);

      const [event] = eventsOf(document.id).filter(
        (row) => row.eventType === 'DocumentVersionCreated',
      );
      expect(event).toMatchObject({ routingKey: 'document.version_created.despacho' });
      expect(event?.payload).toEqual({
        documentId: document.id,
        documentTypeCode: 'DESPACHO',
        documentVersionId: version.id,
        versionNumber: 1,
        reason: 'MANUAL',
        contentHash: version.contentHash,
      });
      const [audit] = auditOf('document.version_create', document.id);
      expect(audit).toMatchObject({
        category: 'DATA_CHANGE',
        processId,
        metadata: expect.objectContaining({
          versionNumber: 1,
          reason: 'MANUAL',
          contentHash: version.contentHash,
        }) as unknown,
      });
      // "Nunca logar" o resumo: nem na auditoria, nem no evento.
      expect(JSON.stringify(audit)).not.toContain('Ajuste na justificativa');
      expect(JSON.stringify(event)).not.toContain('Ajuste na justificativa');
      expect(
        timelineRowsOf(api)
          .filter((row) => row.processId === processId)
          .map((row) => row.type),
      ).toContain('DOCUMENT_VERSION_CREATED');
    });

    it('Listar (DOC-15) desc com resumo vazio = null; consultar (DOC-17) com o snapshot', async () => {
      const document = await newDocument(await newProcess());
      versionOf(await save(document.id, { summary: 'Primeira' }));
      versionOf(await save(document.id, { summary: '   ' }));
      const third = versionOf(await save(document.id));

      const list = await call('get', `/documents/${document.id}/versions?pageSize=2`);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const body = list.body as { data: DocumentVersionSummaryDto[]; meta: PageMeta };
      const items = body.data.map((item) => documentVersionSummarySchema.parse(item));
      expect(items.map((item) => item.versionNumber)).toEqual([3, 2]);
      expect(items.map((item) => item.changeSummary)).toEqual([null, null]);
      expect(body.meta).toEqual({ page: 1, pageSize: 2, totalItems: 3, totalPages: 2 });
      expect('content' in (body.data[0] ?? {})).toBe(false);

      const detail = versionOf(await call('get', `/document-versions/${third.id}`), 200);
      expect(detail).toMatchObject({ id: third.id, versionNumber: 3, kind: 'FREE_TEXT' });
      expect(detail.content?.document).toMatchObject({ id: document.id, versionNumber: 3 });
    });

    it('Comparar (DOC-18) com a anterior: título alterado no cabeçalho, itens adicionados', async () => {
      const document = await newDocument(await newProcess(), types.dfd);
      dfdValidator.parts = {
        header: { objective: 'Pavimentar' },
        collections: { items: [{ processItemId: 'i1', description: 'Cimento', quantity: '10' }] },
      };
      const v1 = versionOf(await save(document.id));
      dfdValidator.parts = {
        header: { objective: 'Pavimentar ruas do centro' },
        collections: {
          items: [
            { processItemId: 'i1', description: 'Cimento', quantity: '12' },
            { processItemId: 'i2', description: 'Areia', quantity: '3' },
          ],
        },
      };
      const v2 = versionOf(await save(document.id));

      const diff = comparisonOf(await compare(document.id, v1.id, v2.id));
      expect(diff).toMatchObject({
        documentId: document.id,
        kind: 'STRUCTURED',
        from: { id: v1.id, versionNumber: 1 },
        to: { id: v2.id, versionNumber: 2 },
      });
      expect(diff.header.find((entry) => entry.field === 'objective')).toEqual({
        field: 'objective',
        changeType: 'CHANGED',
        from: 'Pavimentar',
        to: 'Pavimentar ruas do centro',
      });
      expect(diff.collections.map((entry) => `${entry.itemId}:${entry.changeType}`)).toEqual([
        'i1:CHANGED',
        'i2:ADDED',
      ]);
      expect(diff.collections[0]?.changedFields).toEqual(['quantity']);
      // Leitura não audita nem publica eventos.
      expect(auditOf('document.versions_compared')).toEqual([]);
    });

    it('Documento externo (FA-02): "Salvar versão" recusado com NOT_ALLOWED; comparação só de metadados', async () => {
      const document = await newDocument(
        await newProcess(),
        types.externo,
        'Ofício recebido do TCE',
      );
      const problem = expectProblem(await save(document.id), 422, 'VALIDATION_ERROR');
      expect(problem.errors[0]).toMatchObject({
        field: 'kind',
        code: 'NOT_ALLOWED',
        message: DOCUMENT_VERSION_MESSAGES.uploadedNotAllowed,
      });
      expect(versionsOf(document.id)).toEqual([]);

      const v1 = buildVersion(document, {
        reason: 'UPLOAD',
        attachmentId: newId(),
        contentHash: 'a'.repeat(64),
      });
      const v2 = buildVersion(document, {
        versionNumber: 2,
        reason: 'UPLOAD',
        attachmentId: newId(),
        contentHash: 'b'.repeat(64),
      });
      documentRepositoryOf(api).seedVersion(v1, v2);
      const diff = comparisonOf(await compare(document.id, v1.id, v2.id));
      expect(diff).toMatchObject({ kind: 'UPLOADED', sections: [], collections: [] });
      expect(diff.header.map((entry) => `${entry.field}:${entry.changeType}`)).toEqual([
        'file.attachmentId:CHANGED',
        'file.sha256:CHANGED',
      ]);
    });
  });

  describe('[Validação]', () => {
    it('Resumo da alteração acima do limite: 422 VALIDATION_ERROR TOO_LONG e nenhuma versão', async () => {
      const document = await newDocument(await newProcess());
      const problem = expectProblem(
        await save(document.id, { summary: 'x'.repeat(600) }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors[0]).toMatchObject({
        field: 'changeSummary',
        code: 'TOO_LONG',
        message: 'O resumo deve ter no máximo 500 caracteres.',
      });
      expect(versionsOf(document.id)).toEqual([]);
    });

    it('Documento fora de edição: 409 DOCUMENT_NOT_EDITABLE com a mensagem da story (V-01)', async () => {
      const document = await newDocument(await newProcess());
      documentRepositoryOf(api).seed({ ...stored(document.id), status: 'FINALIZED' });
      const problem = expectProblem(await save(document.id), 409, 'DOCUMENT_NOT_EDITABLE');
      expect(problem.detail).toBe(DOCUMENT_VERSION_MESSAGES.notEditable);
      expect(versionsOf(document.id)).toEqual([]);
    });

    it('Comparar: versões iguais, de outro documento ou inexistentes → 422 (V-04/V-05)', async () => {
      const processId = await newProcess();
      const one = await newDocument(processId);
      const other = await newDocument(processId);
      const a1 = versionOf(await save(one.id));
      const a2 = versionOf(await save(one.id));
      const b1 = versionOf(await save(other.id));

      const same = expectProblem(await compare(one.id, a1.id, a1.id), 422, 'VALIDATION_ERROR');
      expect(same.errors[0]).toMatchObject({
        field: 'to',
        message: DOCUMENT_VERSION_MESSAGES.sameVersion,
      });
      for (const [from, to, field] of [
        [a1.id, b1.id, 'to'],
        [b1.id, a2.id, 'from'],
        [a1.id, newId(), 'to'],
      ] as const) {
        const problem = expectProblem(await compare(one.id, from, to), 422, 'VALIDATION_ERROR');
        expect(problem.errors[0]).toMatchObject({
          field,
          code: 'REFERENCE_NOT_FOUND',
          message: DOCUMENT_VERSION_MESSAGES.versionsOfOtherDocument,
        });
      }
      expectProblem(await compare(one.id, 'x', a1.id), 422, 'VALIDATION_ERROR');
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem permissão de edição do tipo: 403 PERMISSION_DENIED e nenhuma versão', async () => {
      const processId = await newProcess();
      const document = await newDocument(
        processId,
        types.priceResearch,
        'Pesquisa de preços do cimento',
      );
      // "Carlos" = Ana, responsável pelo processo, mas sem PRICE_RESEARCH_UPDATE.
      patchProcess(processId, { currentResponsibleId: FAKE_USERS.ana.id });
      expectProblem(await save(document.id, { subject: 'sub-ana' }), 403, 'PERMISSION_DENIED');
      expect(versionsOf(document.id)).toEqual([]);
      expect(auditOf('access.denied').at(-1)).toMatchObject({
        reasonCode: 'PRICE_RESEARCH_UPDATE',
      });
    });

    it('Sem custódia nem participação (POL-02): 403; leitura segue liberada a quem vê o processo', async () => {
      const document = await newDocument(await newProcess());
      const v1 = versionOf(await save(document.id));
      expectProblem(await save(document.id, { subject: 'sub-ana' }), 403, 'PERMISSION_DENIED');
      expect(versionsOf(document.id)).toHaveLength(1);
      expect(
        (await call('get', `/documents/${document.id}/versions`, { subject: 'sub-ana' })).status,
      ).toBe(200);
      versionOf(await call('get', `/document-versions/${v1.id}`, { subject: 'sub-ana' }), 200);
    });

    it('Sem PROCESS_VIEW: 403 na listagem, na consulta e na comparação', async () => {
      const document = await newDocument(await newProcess());
      const v1 = versionOf(await save(document.id));
      const v2 = versionOf(await save(document.id));
      // Otávio só com CONSULTOR_EXTERNO e sem participação: nenhum PROCESS_VIEW (permissions.md §3.2).
      for (const path of [
        `/documents/${document.id}/versions`,
        `/document-versions/${v1.id}`,
        `/documents/${document.id}/versions/compare?from=${v1.id}&to=${v2.id}`,
      ]) {
        expectProblem(await call('get', path, { subject: 'sub-otavio' }), 403, 'PERMISSION_DENIED');
      }
    });

    it('POL-09: quem não vê o orçamento sigiloso recebe MASKED nas duas versões (FA-03); a custodiante vê', async () => {
      const processId = await newProcess();
      const document = await newDocument(processId, types.dfd, 'DFD sigiloso do cimento');
      patchProcess(processId, { isBudgetConfidential: true });
      dfdValidator.parts = {
        header: { objective: 'Pavimentar', estimatedValue: '1000.00' },
        collections: {
          items: [{ processItemId: 'i1', description: 'Cimento', unitPrice: '10.00' }],
        },
      };
      const v1 = versionOf(await save(document.id));
      // A custodiante (POL-09 por custódia) recebe os valores na resposta.
      expect(v1.content?.header).toMatchObject({ estimatedValue: '1000.00' });
      dfdValidator.parts = {
        header: { objective: 'Pavimentar', estimatedValue: '1500.00' },
        collections: {
          items: [{ processItemId: 'i1', description: 'Cimento', unitPrice: '15.00' }],
        },
      };
      const v2 = versionOf(await save(document.id));

      const masked = comparisonOf(await compare(document.id, v1.id, v2.id, 'sub-ana'));
      expect(masked.header.find((entry) => entry.field === 'estimatedValue')).toEqual({
        field: 'estimatedValue',
        changeType: 'MASKED',
        from: null,
        to: null,
      });
      expect(masked.collections[0]).toMatchObject({
        changeType: 'UNCHANGED',
        changedFields: [],
        maskedFields: ['unitPrice'],
        from: { unitPrice: null, unitPriceMasked: true },
        to: { unitPrice: null, unitPriceMasked: true },
      });
      expect(JSON.stringify(masked)).not.toMatch(/1000\.00|1500\.00|10\.00|15\.00/);

      const detail = versionOf(
        await call('get', `/document-versions/${v2.id}`, { subject: 'sub-ana' }),
        200,
      );
      expect(detail.content?.header).toEqual({
        objective: 'Pavimentar',
        estimatedValue: null,
        estimatedValueMasked: true,
      });

      const clear = comparisonOf(await compare(document.id, v1.id, v2.id));
      expect(clear.header.find((entry) => entry.field === 'estimatedValue')).toMatchObject({
        changeType: 'CHANGED',
        from: '1000.00',
        to: '1500.00',
      });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Comparar/listar/consultar versões de documento de outro tenant: 404 sem revelar nada', async () => {
      const foreign = buildDocument({ tenantId: B, processId: newId(), documentTypeId: newId() });
      documentRepositoryOf(api).seed(foreign);
      const v1 = buildVersion(foreign, { content: null });
      const v2 = buildVersion(foreign, { versionNumber: 2, content: null });
      documentRepositoryOf(api).seedVersion(v1, v2);

      for (const response of [
        await compare(foreign.id, v1.id, v2.id),
        await call('get', `/documents/${foreign.id}/versions`),
        await call('get', `/document-versions/${v2.id}`),
        await save(foreign.id),
      ]) {
        const problem = expectProblem(response, 404, 'NOT_FOUND');
        expect(JSON.stringify(problem)).not.toContain(v2.contentHash);
      }
      expect(versionsOf(foreign.id)).toHaveLength(2);

      // Versão de B referenciada num documento de A: igual a inexistente (422, nada revelado).
      const mine = await newDocument(await newProcess());
      const own = versionOf(await save(mine.id));
      const problem = expectProblem(await compare(mine.id, own.id, v2.id), 422, 'VALIDATION_ERROR');
      expect(problem.errors[0]).toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave de idempotência: 201 replay da mesma versão 2 e uma única criada', async () => {
      const document = await newDocument(await newProcess());
      versionOf(await save(document.id));
      const key = randomUUID(); // "K1"
      const first = await save(document.id, { key, summary: 'Revisão' });
      expect(versionOf(first).versionNumber).toBe(2);
      const replay = await save(document.id, { key, summary: 'Revisão' });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(versionsOf(document.id).map((version) => version.versionNumber)).toEqual([1, 2]);
      expect(auditOf('document.version_create', document.id)).toHaveLength(2);
    });
  });

  describe('[Concorrência]', () => {
    it('Dois "Salvar versão" simultâneos na versão 3: um cria a 4 e o outro a 5, sem lacuna nem repetição', async () => {
      const document = await newDocument(await newProcess());
      for (let index = 0; index < 3; index += 1) versionOf(await save(document.id));
      const [one, two] = await Promise.all([save(document.id), save(document.id)]);
      const numbers = [versionOf(one).versionNumber, versionOf(two).versionNumber].sort();
      expect(numbers).toEqual([4, 5]);
      expect(versionsOf(document.id).map((version) => version.versionNumber)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(stored(document.id)).toMatchObject({ status: 'DRAFT', currentVersionNumber: 5 });
      expect(documentRepositoryOf(api).versionsOf(document.id).at(-1)?.id).toBe(
        stored(document.id).currentVersionId,
      );
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao salvar versão: 503 DEPENDENCY_UNAVAILABLE com Retry-After e nada persistido', async () => {
      const document = await newDocument(await newProcess());
      transactions.down = true;
      const response = await save(document.id);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      transactions.down = false;
      expect(versionsOf(document.id)).toEqual([]);
      expect(stored(document.id)).toMatchObject({ version: 1, currentVersionId: null });
      expect(auditOf('document.version_create', document.id)).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: 201 e o DocumentVersionCreated fica no outbox para publicação posterior', async () => {
      const document = await newDocument(await newProcess());
      const version = versionOf(await save(document.id));
      // Sem relay no teste: o evento fica gravado (PENDING no PostgreSQL — tenant-leak/document-versions).
      expect(
        eventsOf(document.id).filter(
          (row) =>
            row.eventType === 'DocumentVersionCreated' &&
            (row.payload as { documentVersionId: string }).documentVersionId === version.id,
        ),
      ).toHaveLength(1);
    });
  });
});
