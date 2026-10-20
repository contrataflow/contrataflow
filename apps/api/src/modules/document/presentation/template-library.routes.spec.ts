import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { DocumentTypeDto, TemplateDto, TemplateVersionDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runAsSystem } from '#shared/context/request-context.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { TenantSeederRegistry } from '#shared/tenancy/tenant-seeding.js';
import type { TenantSeeder } from '#shared/tenancy/tenant-seeding.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { DocumentTypeFacade } from '../application/document-type.facade.js';
import { DOCUMENT_TRANSACTIONS, DOCUMENT_TYPE_REPOSITORY } from '../application/ports.js';
import type { DocumentTransactions, DocumentTypeRepository } from '../application/ports.js';
import { TemplateLibrarySeeder } from '../application/template-library.seeder.js';
import { TEMPLATE_REPOSITORY } from '../application/template.ports.js';
import type { TemplateRepository } from '../application/template.ports.js';
import { TEMPLATE_LIBRARY, TemplateLibraryInvalidError } from '../domain/template-library.js';
import { InMemoryDocumentTypeRepository } from '../infrastructure/in-memory-document-type.repository.js';
import { InMemoryTemplateRepository } from '../infrastructure/in-memory-template.repository.js';

/*
 * US-110 — biblioteca padrão semeada pelo seeder `document.templateLibrary` (registrado no
 * checklist de US-099) e consumida pelo pipeline HTTP completo (TPL-01/03/06, DTY-01) com a
 * identidade fake e os repositórios em memória. A atomicidade real por transação e a RLS estão em
 * `test/tenant-leak/template-library.spec.ts` (PostgreSQL).
 *
 * Personagens: Marta e Otávio (ADMIN_ORGAO, `TEMPLATE_MANAGE`/`TEMPLATE_PUBLISH`), Ana
 * (REQUISITANTE — o "Bruno" da story, só `TEMPLATE_VIEW`) e Heitor (Prefeitura B).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MARTA = FAKE_USERS.marta;
const OTAVIO = FAKE_USERS.otavio;
const ANA = FAKE_USERS.ana;
const HEITOR = FAKE_USERS.heitor;
const MFA = ['pwd', 'otp'];
const SEEDED_CODES = [
  'DFD',
  'ETP',
  'TR',
  'RISK_MAP',
  'PRICE_RESEARCH',
  'DESPACHO',
  'OFICIO',
  'NOTA_TECNICA',
  'AUTORIZACAO',
  'DECLARACAO',
];

interface User {
  subject: string;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- leitura tipada do envelope
const dataOf = <T>(response: request.Response): T => (response.body as { data: T }).data;

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(problemDetailsSchema.parse(response.body).code).toBe(code);
}

describe('Feature: Biblioteca de templates padrão (US-110)', () => {
  let api: TestApi;
  let templates: InMemoryTemplateRepository;
  let types: InMemoryDocumentTypeRepository;

  const seederOf = (key: string): TenantSeeder => {
    const seeder = api.app
      .get(TenantSeederRegistry)
      .all()
      .find((candidate) => candidate.key === key);
    if (!seeder) throw new Error(`Seeder ${key} não registrado.`);
    return seeder;
  };
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    runAsSystem({ name: 'Provisionamento de tenant', tenantId }, fn);
  const ctxOf = (tenantId: string) => ({
    tenantId,
    slug: 'teste',
    now: new Date('2026-10-17T12:00:00.000Z'),
    request: null,
  });
  const runStep = (tenantId: string, seeder: TenantSeeder = seederOf('document.templateLibrary')) =>
    inTenant(tenantId, () => seeder.seed(ctxOf(tenantId)));
  const verifyStep = (tenantId: string) =>
    inTenant(tenantId, () => seederOf('document.templateLibrary').verify(ctxOf(tenantId)));

  const withAuth = (test: request.Test, user: User, tenant: string = A) =>
    test.set('Authorization', api.bearer(user.subject, { amr: MFA })).set('X-Tenant-Id', tenant);
  const listTemplates = async (user: User = MARTA, tenant: string = A) => {
    const response = await withAuth(
      request(api.server).get('/api/v1/templates?pageSize=100'),
      user,
      tenant,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return dataOf<TemplateDto[]>(response);
  };
  const templateNamed = async (name: string, user: User = MARTA, tenant: string = A) => {
    const found = (await listTemplates(user, tenant)).find((template) => template.name === name);
    if (!found) throw new Error(`template ${name} ausente`);
    return found;
  };
  const newVersion = (templateId: string, user: User = MARTA) =>
    withAuth(request(api.server).post(`/api/v1/templates/${templateId}/versions`), user)
      .set('Idempotency-Key', randomUUID())
      .send();
  const systemTemplatesOf = (tenantId: string) =>
    inTenant(tenantId, async () =>
      (await templates.list({} as never, { skip: 0, take: 100 })).items.filter((t) => t.isSystem),
    );
  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const silence = () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  };

  beforeAll(async () => {
    api = await createTestApi();
    templates = api.app.get(InMemoryTemplateRepository, { strict: false });
    types = api.app.get(InMemoryDocumentTypeRepository, { strict: false });
    // Background: tenants em provisionamento com os tipos de sistema (US-061).
    for (const tenantId of [A, B]) await runStep(tenantId, seederOf('document.systemTypes'));
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    vi.restoreAllMocks();
  });

  it('a etapa fica no checklist entre document.systemTypes e workflow.seedWorkflows', () => {
    const seeder = seederOf('document.templateLibrary');
    expect(seeder).toBeInstanceOf(TemplateLibrarySeeder);
    expect(seeder.dependsOn).toEqual(['document.systemTypes']);
    expect(seeder.module).toBe('document');
  });

  describe('[Falha de integração] fixture ausente ou corrompida', () => {
    it('a etapa falha com o tipo que não carregou, fica PENDING e não escreve nada', async () => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const corrupted = TEMPLATE_LIBRARY.map((entry) =>
        entry.documentTypeCode === 'ETP' ? { ...entry, sections: [{ key: 'NEED' }] } : entry,
      );
      const seeder = new TemplateLibrarySeeder(
        corrupted,
        api.app.get<TemplateRepository>(TEMPLATE_REPOSITORY, { strict: false }),
        api.app.get<DocumentTypeRepository>(DOCUMENT_TYPE_REPOSITORY, { strict: false }),
        api.app.get<DocumentTransactions>(DOCUMENT_TRANSACTIONS, { strict: false }),
        api.app.get(DocumentTypeFacade, { strict: false }),
      );

      const failure = await runStep(A, seeder).catch((caught: unknown) => caught);

      expect(failure).toBeInstanceOf(TemplateLibraryInvalidError);
      expect(failure).toMatchObject({ code: 'TEMPLATE_INVALID', documentTypeCode: 'ETP' });
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'template_library.seed_failed',
          documentTypeCode: 'ETP',
          code: 'TEMPLATE_INVALID',
        }),
        'template_library.seed_failed',
      );
      expect(await systemTemplatesOf(A)).toEqual([]);
      expect((await verifyStep(A)).status).toBe('PENDING');
      // A etapa anterior do checklist segue concluída.
      expect(
        (await inTenant(A, () => seederOf('document.systemTypes').verify(ctxOf(A)))).status,
      ).toBe('DONE');
    });
  });

  describe('[Duplicidade] e [Falha de banco] falha a meio e reexecução', () => {
    it('o banco cai no 7º tipo: 6 ficam semeados, nenhum parcial; a reexecução semeia só os 4 pendentes', async () => {
      silence();
      const original = templates.insert.bind(templates);
      let calls = 0;
      const failing = vi.spyOn(templates, 'insert').mockImplementation(async (tx, t, d) => {
        calls += 1;
        if (calls === 7) throw new DatabaseUnavailableError(new Error('conexão perdida'));
        return original(tx, t, d);
      });

      await expect(runStep(A)).rejects.toBeInstanceOf(DatabaseUnavailableError);
      failing.mockRestore();

      expect((await systemTemplatesOf(A)).length).toBe(6);
      expect(await verifyStep(A)).toEqual({ status: 'PENDING', details: { templates: 6 } });

      expect(await runStep(A)).toEqual({ created: 4, skipped: 6 });
      expect(await verifyStep(A)).toEqual({ status: 'DONE', details: { templates: 10 } });
      // Reexecutar de novo não cria nada nem duplica.
      expect(await runStep(A)).toEqual({ created: 0, skipped: 10 });
      const seeded = await systemTemplatesOf(A);
      expect(seeded).toHaveLength(10);
      expect(new Set(seeded.map((template) => template.documentTypeId)).size).toBe(10);
    });
  });

  describe('[Sucesso] provisionamento semeia a biblioteca padrão', () => {
    it('10 templates isSystem com a v1 PUBLISHED, contentHash e padrão de cada tipo', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      expect(await runStep(B)).toEqual({ created: 10, skipped: 0 });
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'template_library.seeded', tenantId: B, created: 10 }),
        'template_library.seeded',
      );
      // Logs sem conteúdo de seções (só chaves e contagens).
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/Descreva a necessidade/);

      const seeded = await systemTemplatesOf(B);
      const typesOfB = types.snapshot().filter((type) => type.tenantId === B);
      for (const code of SEEDED_CODES) {
        const type = typesOfB.find((row) => row.code === code);
        const template = seeded.find((row) => row.documentTypeId === type?.id);
        expect(template, code).toBeDefined();
        expect(type?.defaultTemplateId, code).toBe(template?.id);
        const version = await inTenant(B, () =>
          templates.findVersionById({} as never, template?.currentPublishedVersionId ?? ''),
        );
        expect(version, code).toMatchObject({ versionNumber: 1, status: 'PUBLISHED' });
        expect(version?.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(version?.publishedById).toBeNull();
      }
      expect(typesOfB.find((type) => type.code === 'DOCUMENTO_EXTERNO')?.defaultTemplateId).toBe(
        null,
      );
      // Sem evento de domínio próprio nem auditoria por item (RN: integra `tenant.provision`).
      expect(api.outboxRows().filter((row) => row.tenantId === B)).toEqual([]);
      expect(auditOf('template.create').filter((r) => r.tenantId === B)).toEqual([]);
    });

    it('Marta vê os 10 modelos com o selo de sistema e abre o TR com as seções canônicas', async () => {
      const list = await listTemplates();
      const system = list.filter((template) => template.isSystem);
      expect(system).toHaveLength(10);
      expect(system.every((template) => template.isDefault && template.isActive)).toBe(true);

      const tr = await templateNamed('Termo de Referência — Modelo padrão');
      const detail = await withAuth(request(api.server).get(`/api/v1/templates/${tr.id}`), MARTA);
      expect(detail.status).toBe(200);
      const versionId = dataOf<TemplateDto>(detail).currentPublishedVersion?.id ?? '';
      const version = await withAuth(
        request(api.server).get(`/api/v1/template-versions/${versionId}`),
        MARTA,
      );
      expect(version.status, JSON.stringify(version.body)).toBe(200);
      const dto = dataOf<TemplateVersionDto>(version);
      expect(dto.status).toBe('PUBLISHED');
      expect(dto.sections.map((section) => section.key)).toEqual(
        expect.arrayContaining(['OBJECT', 'JUSTIFICATION', 'SPECIFICATIONS']),
      );
      expect(dto.importMappings?.fromDocumentType).toBe('ETP');

      // DTY-01 mostra o template padrão do tipo.
      const typesResponse = await withAuth(
        request(api.server).get('/api/v1/document-types'),
        MARTA,
      );
      const trType = dataOf<DocumentTypeDto[]>(typesResponse).find((type) => type.code === 'TR');
      expect(trType?.defaultTemplate).toEqual({ id: tr.id, name: tr.name, versionNumber: 1 });
    });

    it('o template semeado é editável como qualquer outro (RN-TPL-32): nova versão clona a v1', async () => {
      const despacho = await templateNamed('Despacho — Modelo padrão');
      const created = await newVersion(despacho.id);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const draft = dataOf<TemplateVersionDto>(created);
      expect(draft).toMatchObject({ versionNumber: 2, status: 'DRAFT' });
      expect(draft.sections.map((section) => section.key)).toEqual(['CONTENT']);
    });
  });

  describe('[Validação] nome reservado do modelo padrão', () => {
    it('criar manualmente "ETP — Modelo padrão" no mesmo tipo → 409 TEMPLATE_NAME_TAKEN', async () => {
      const etp = types.snapshot().find((type) => type.tenantId === A && type.code === 'ETP');
      const response = await withAuth(request(api.server).post('/api/v1/templates'), MARTA)
        .set('Idempotency-Key', randomUUID())
        .send({ name: 'etp — modelo padrão', documentTypeId: etp?.id });
      expectProblem(response, 409, 'TEMPLATE_NAME_TAKEN');
    });
  });

  describe('[Permissão] só TEMPLATE_VIEW não inicia a adoção manual', () => {
    it('Ana vê os modelos, mas TPL-06 é 403 PERMISSION_DENIED com access.denied', async () => {
      silence();
      expect((await listTemplates(ANA)).filter((template) => template.isSystem)).toHaveLength(10);
      const tr = await templateNamed('Termo de Referência — Modelo padrão', ANA);
      const denials = auditOf('access.denied').length;

      expectProblem(await newVersion(tr.id, ANA), 403, 'PERMISSION_DENIED');

      const records = auditOf('access.denied');
      expect(records).toHaveLength(denials + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        actorUserId: ANA.id,
        reasonCode: 'TEMPLATE_MANAGE',
        result: 'DENIED',
      });
    });
  });

  describe('[Tenant incorreto] isolamento da biblioteca entre tenants', () => {
    it('o ETP padrão de B por id → 404; ids, tenantId e conteúdo independentes', async () => {
      const etpOfA = await templateNamed('ETP — Modelo padrão');
      const etpOfB = await templateNamed('ETP — Modelo padrão', HEITOR, B);
      expect(etpOfA.id).not.toBe(etpOfB.id);

      const crossed = await withAuth(
        request(api.server).get(`/api/v1/templates/${etpOfB.id}`),
        MARTA,
      );
      expectProblem(crossed, 404, 'NOT_FOUND');
      expectProblem(await newVersion(etpOfB.id), 404, 'NOT_FOUND');

      const [rowOfA] = (await systemTemplatesOf(A)).filter((t) => t.id === etpOfA.id);
      const [rowOfB] = (await systemTemplatesOf(B)).filter((t) => t.id === etpOfB.id);
      expect(rowOfA?.tenantId).toBe(A);
      expect(rowOfB?.tenantId).toBe(B);
      expect(rowOfA?.currentPublishedVersionId).not.toBe(rowOfB?.currentPublishedVersionId);
    });
  });

  describe('[Concorrência] duas adoções simultâneas da mesma atualização', () => {
    it('duas TPL-06 para o TR sem rascunho: uma 201 DRAFT e outra 409 TEMPLATE_DRAFT_EXISTS', async () => {
      silence();
      const tr = await templateNamed('Termo de Referência — Modelo padrão');
      expect(tr.draftVersion).toBeNull();

      const responses = await Promise.all([newVersion(tr.id, MARTA), newVersion(tr.id, OTAVIO)]);

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const winner = responses.find((response) => response.status === 201);
      expect(winner && dataOf<TemplateVersionDto>(winner).status).toBe('DRAFT');
      const loser = responses.find((response) => response.status === 409);
      if (loser) expectProblem(loser, 409, 'TEMPLATE_DRAFT_EXISTS');
      // FA-05: a versão vigente continua a publicada.
      expect(
        (await templateNamed('Termo de Referência — Modelo padrão')).currentPublishedVersion,
      ).toMatchObject({ versionNumber: 1 });
    });
  });
});
