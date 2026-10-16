import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  DocumentTypeDto,
  TemplateDto,
  TemplateVersionDto,
  TemplateVersionHistoryItem,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { ApiError } from '#shared/errors/api-error.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from '../application/ports.js';
import type { DocumentTransactions } from '../application/ports.js';
import { templateContentHash } from '../domain/document-template.js';
import { buildSystemDocumentTypes } from '../domain/system-document-types.js';
import { InMemoryDocumentTypeRepository } from '../infrastructure/in-memory-document-type.repository.js';
import { InMemoryTemplateRepository } from '../infrastructure/in-memory-template.repository.js';

/*
 * US-108 — TPL-05/06/10/11 e DTY-04 pelo pipeline HTTP completo (autenticação, tenant, vínculo, MFA,
 * If-Match, idempotência, validação Zod, filtro RFC 9457) com a identidade fake, a auditoria real
 * do `AuditService` e o outbox em memória. Os mesmos casos contra o PostgreSQL (gatilho de
 * imutabilidade, índice de rascunho único, FKs e RLS) estão em `test/tenant-leak/templates.spec.ts`.
 *
 * Personagens: Marta e Otávio (ADMIN_ORGAO — "Diego" da story, com TEMPLATE_PUBLISH), Ana
 * (REQUISITANTE, só TEMPLATE_VIEW) e Heitor (GESTOR_CONTRATACOES da Prefeitura B). "Carla, só com
 * TEMPLATE_MANAGE" é a Marta com TEMPLATE_PUBLISH negado pela `AccessFacade` durante o cenário
 * (nenhum perfil padrão separa as duas permissões; perfis do tenant chegam com a US-097).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MARTA = FAKE_USERS.marta;
const OTAVIO = FAKE_USERS.otavio;
const ANA = FAKE_USERS.ana;
const HEITOR = FAKE_USERS.heitor;
const NOW = new Date('2026-10-15T12:00:00.000Z');
const MFA = ['pwd', 'otp'];

interface User {
  subject: string;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- leitura tipada do envelope
const dataOf = <T>(response: request.Response): T => (response.body as { data: T }).data;

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

const section = (key: string, order: number, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Seção ${key}`,
  order,
  requirement: 'REQUIRED',
  ...extra,
});

describe('Feature: Publicar versão de template e definir padrão do tipo (US-108)', () => {
  let api: TestApi;
  let types: InMemoryDocumentTypeRepository;
  let templates: InMemoryTemplateRepository;

  beforeAll(async () => {
    api = await createTestApi({ providers: [{ token: DOCUMENT_CLOCK, value: () => NOW }] });
    types = api.app.get(InMemoryDocumentTypeRepository, { strict: false });
    templates = api.app.get(InMemoryTemplateRepository, { strict: false });
    // Background: tenants A ("Prefeitura de São José") e B ativos com os tipos de sistema.
    await types.insertMissing({} as never, buildSystemDocumentTypes(A, NOW, newId));
    await types.insertMissing({} as never, buildSystemDocumentTypes(B, NOW, newId));
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

  const withAuth = (test: request.Test, user: User, tenant: string = A) =>
    test.set('Authorization', api.bearer(user.subject, { amr: MFA })).set('X-Tenant-Id', tenant);

  const typeOf = (code: string, tenantId: string = A) => {
    const type = types.snapshot().find((row) => row.code === code && row.tenantId === tenantId);
    if (!type) throw new Error(`tipo ${code} inexistente`);
    return type;
  };

  const publish = (
    versionId: string,
    ifMatch: string | null,
    options: { user?: User; key?: string; tenant?: string } = {},
  ) => {
    const test = withAuth(
      request(api.server).post(`/api/v1/template-versions/${versionId}/publish`),
      options.user ?? MARTA,
      options.tenant,
    ).set('Idempotency-Key', options.key ?? randomUUID());
    return (ifMatch === null ? test : test.set('If-Match', ifMatch)).send();
  };
  const retire = (versionId: string, ifMatch: string, user: User = MARTA, tenant: string = A) =>
    withAuth(
      request(api.server).post(`/api/v1/template-versions/${versionId}/retire`),
      user,
      tenant,
    )
      .set('If-Match', ifMatch)
      .send();
  const newVersion = (templateId: string, user: User = MARTA, tenant: string = A) =>
    withAuth(request(api.server).post(`/api/v1/templates/${templateId}/versions`), user, tenant)
      .set('Idempotency-Key', randomUUID())
      .send();
  const history = (templateId: string, query = '', user: User = MARTA, tenant: string = A) =>
    withAuth(
      request(api.server).get(`/api/v1/templates/${templateId}/versions${query}`),
      user,
      tenant,
    );
  const getVersion = (versionId: string) =>
    withAuth(request(api.server).get(`/api/v1/template-versions/${versionId}`), MARTA);
  const getTemplate = (templateId: string) =>
    withAuth(request(api.server).get(`/api/v1/templates/${templateId}`), MARTA);
  const setDefault = (
    typeId: string,
    templateId: string,
    ifMatch: string | null,
    user: User = MARTA,
    tenant: string = A,
  ) => {
    const test = withAuth(
      request(api.server).put(`/api/v1/document-types/${typeId}/default-template`),
      user,
      tenant,
    );
    return (ifMatch === null ? test : test.set('If-Match', ifMatch)).send({ templateId });
  };

  /** Template com a versão 1 (rascunho) com seções; devolve o template e o rascunho. */
  const draftTemplate = async (
    name: string,
    code = 'OFICIO',
    user: User = MARTA,
    tenant: string = A,
  ) => {
    const created = await withAuth(request(api.server).post('/api/v1/templates'), user, tenant)
      .set('Idempotency-Key', randomUUID())
      .send({ name, documentTypeId: typeOf(code, tenant).id });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const template = dataOf<TemplateDto>(created);
    const v1 = template.draftVersion?.id ?? '';
    const patched = await withAuth(
      request(api.server).patch(`/api/v1/template-versions/${v1}`),
      user,
      tenant,
    )
      .set('If-Match', '"1"')
      .send({ sections: [section('OBJETO', 1), section('FUNDAMENTACAO', 2)] });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    return { template, v1 };
  };

  /** Background: "Ofício padrão" com a versão 1 publicada e a versão 2 em DRAFT, válida. */
  const background = async (name: string, user: User = MARTA, tenant: string = A) => {
    const { template, v1 } = await draftTemplate(name, 'OFICIO', user, tenant);
    expect((await publish(v1, '"2"', { user, tenant })).status).toBe(200);
    const created = await newVersion(template.id, user, tenant);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const v2 = dataOf<TemplateVersionDto>(created);
    const patched = await withAuth(
      request(api.server).patch(`/api/v1/template-versions/${v2.id}`),
      user,
      tenant,
    )
      .set('If-Match', '"1"')
      .send({ sections: [...v2.sections, section('CONCLUSAO', 3)], changeNotes: 'Conclusão' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    return { template, v1, v2: v2.id };
  };

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const eventsOf = (type: string) => api.outboxRows().filter((row) => row.eventType === type);
  const versionRow = (id: string) => templates.snapshot().versions.find((v) => v.id === id);

  describe('[Sucesso]', () => {
    it('publicar a versão em rascunho: PUBLISHED com hash, corrente do template, 200 com novo ETag, auditoria e evento', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { template, v1, v2 } = await background('Ofício padrão');
      const audits = auditOf('template.version_publish').length;
      const events = eventsOf('TemplateVersionPublished').length;
      const key = randomUUID();

      const response = await publish(v2, '"2"', { key });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"3"');
      const published = dataOf<TemplateVersionDto>(response);
      const stored = versionRow(v2);
      expect(published).toMatchObject({
        id: v2,
        versionNumber: 2,
        status: 'PUBLISHED',
        publishedAt: NOW.toISOString(),
        retiredAt: null,
        version: 3,
      });
      expect(published.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored && templateContentHash(stored)).toBe(published.contentHash);
      expect(stored?.publishedById).toBe(MARTA.id);

      const detail = dataOf<TemplateDto>(await getTemplate(template.id));
      expect(detail.currentPublishedVersion).toMatchObject({ id: v2, versionNumber: 2 });
      expect(detail.draftVersion).toBeNull();
      // RN-TPL-16: a versão 1 segue publicada e intacta (documentos antigos não mudam).
      expect(versionRow(v1)?.status).toBe('PUBLISHED');

      const records = auditOf('template.version_publish');
      expect(records).toHaveLength(audits + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        category: 'CONFIGURATION',
        result: 'SUCCESS',
        actorUserId: MARTA.id,
        entityType: 'DocumentTemplate',
        entityId: template.id,
        metadata: {
          templateVersionId: v2,
          versionNumber: 2,
          contentHash: published.contentHash,
          idempotencyKey: key,
        },
      });
      expect(records.at(-1)?.changes).toEqual([
        { path: 'currentPublishedVersionId', old: v1, new: v2 },
      ]);
      expect(eventsOf('TemplateVersionPublished')).toHaveLength(events + 1);
      expect(eventsOf('TemplateVersionPublished').at(-1)).toMatchObject({
        tenantId: A,
        routingKey: 'template.version_published',
        aggregateType: 'DocumentTemplate',
        aggregateId: template.id,
        payload: {
          templateId: template.id,
          templateVersionId: v2,
          versionNumber: 2,
          documentTypeCode: 'OFICIO',
          contentHash: published.contentHash,
        },
      });
      // Log com IDs e contagens, nunca o conteúdo das seções.
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'template_version.published',
          templateVersionId: v2,
          versionNumber: 2,
          contentHash: published.contentHash,
          durationMs: expect.any(Number) as number,
        }),
        'template_version.published',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('Seção OBJETO');
    });

    it('FA-01: publicar a primeira versão de um template novo', async () => {
      silence();
      const { template, v1 } = await draftTemplate('Ofício novo');
      const response = await publish(v1, '"2"');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(dataOf<TemplateDto>(await getTemplate(template.id)).currentPublishedVersion?.id).toBe(
        v1,
      );
    });

    it('TPL-05: histórico do mais recente ao mais antigo, com hash, notas, corrente e filtro por status', async () => {
      silence();
      const { template, v1, v2 } = await background('Ofício histórico');
      await publish(v2, '"2"');

      const response = await history(template.id, '', ANA);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const items = dataOf<TemplateVersionHistoryItem[]>(response);
      expect(items.map((item) => [item.versionNumber, item.status, item.isCurrent])).toEqual([
        [2, 'PUBLISHED', true],
        [1, 'PUBLISHED', false],
      ]);
      expect(items[0]).toMatchObject({ id: v2, changeNotes: 'Conclusão', sectionCount: 3 });
      expect(items[1]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect((response.body as { meta: { totalItems: number } }).meta.totalItems).toBe(2);
      expect(response.body).not.toHaveProperty('data.0.sections');

      await retire(v1, '"3"');
      const retired = dataOf<TemplateVersionHistoryItem[]>(
        await history(template.id, '?status=RETIRED'),
      );
      expect(retired.map((item) => item.id)).toEqual([v1]);
    });

    it('definir o template como padrão do tipo: defaultTemplateId, auditoria document_type.update e DocumentTypeChanged', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { template, v1 } = await draftTemplate('Despacho padrão', 'DESPACHO');
      await publish(v1, '"2"');
      const despacho = typeOf('DESPACHO');
      const audits = auditOf('document_type.update').length;
      const events = eventsOf('DocumentTypeChanged').length;

      const response = await setDefault(despacho.id, template.id, `"${despacho.version}"`);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe(`"${despacho.version + 1}"`);
      expect(dataOf<DocumentTypeDto>(response).defaultTemplate).toEqual({
        id: template.id,
        name: 'Despacho padrão',
        versionNumber: 1,
      });
      expect(typeOf('DESPACHO').defaultTemplateId).toBe(template.id);
      expect(auditOf('document_type.update')).toHaveLength(audits + 1);
      expect(auditOf('document_type.update').at(-1)).toMatchObject({
        category: 'CONFIGURATION',
        entityType: 'DocumentType',
        entityId: despacho.id,
        changes: [{ path: 'defaultTemplateId', old: null, new: template.id }],
      });
      expect(eventsOf('DocumentTypeChanged')).toHaveLength(events + 1);
      expect(eventsOf('DocumentTypeChanged').at(-1)?.payload).toEqual({
        documentTypeId: despacho.id,
        code: 'DESPACHO',
        changedFields: ['defaultTemplateId'],
      });
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'document_type.default_template_changed',
          documentTypeId: despacho.id,
          previousTemplateId: null,
          templateId: template.id,
        }),
        'document_type.default_template_changed',
      );

      // DTY-01 (cache invalidado) e TPL-03 refletem o padrão.
      const list = dataOf<DocumentTypeDto[]>(
        await withAuth(request(api.server).get('/api/v1/document-types'), MARTA),
      );
      expect(list.find((type) => type.id === despacho.id)?.defaultTemplate?.id).toBe(template.id);
      expect(dataOf<TemplateDto>(await getTemplate(template.id)).isDefault).toBe(true);
    });

    it('FA-04: trocar o padrão mantém o anterior disponível; reenviar o mesmo não gera nova versão', async () => {
      silence();
      const first = await draftTemplate('Nota técnica A', 'NOTA_TECNICA');
      const second = await draftTemplate('Nota técnica B', 'NOTA_TECNICA');
      await publish(first.v1, '"2"');
      await publish(second.v1, '"2"');
      const nota = typeOf('NOTA_TECNICA');
      expect((await setDefault(nota.id, first.template.id, `"${nota.version}"`)).status).toBe(200);
      const swapped = await setDefault(nota.id, second.template.id, `"${nota.version + 1}"`);
      expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
      expect(auditOf('document_type.update').at(-1)?.changes).toEqual([
        { path: 'defaultTemplateId', old: first.template.id, new: second.template.id },
      ]);
      const former = dataOf<TemplateDto>(await getTemplate(first.template.id));
      expect(former).toMatchObject({ isActive: true, isDefault: false });

      const events = eventsOf('DocumentTypeChanged').length;
      const same = await setDefault(nota.id, second.template.id, `"${nota.version + 2}"`);
      expect(same.status).toBe(200);
      expect(same.headers.etag).toBe(`"${nota.version + 2}"`);
      expect(eventsOf('DocumentTypeChanged')).toHaveLength(events);
      // O anterior pode voltar a ser o padrão (RN-TPL-20).
      expect((await setDefault(nota.id, first.template.id, `"${nota.version + 2}"`)).status).toBe(
        200,
      );
    });

    it('TPL-06: nova versão clona a mais recente (201, Location, ETag "1") e grava template.version_create', async () => {
      silence();
      const { template, v1 } = await draftTemplate('Ofício clonado');
      await publish(v1, '"2"');
      const audits = auditOf('template.version_create').length;

      const response = await newVersion(template.id);

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const draft = dataOf<TemplateVersionDto>(response);
      expect(response.headers.location).toBe(`/api/v1/template-versions/${draft.id}`);
      expect(response.headers.etag).toBe('"1"');
      expect(draft).toMatchObject({
        templateId: template.id,
        versionNumber: 2,
        status: 'DRAFT',
        contentHash: null,
        publishedAt: null,
      });
      expect(draft.sections.map((item) => item.key)).toEqual(['OBJETO', 'FUNDAMENTACAO']);
      expect(auditOf('template.version_create')).toHaveLength(audits + 1);
      expect(auditOf('template.version_create').at(-1)).toMatchObject({
        entityId: template.id,
        metadata: { templateVersionId: draft.id, versionNumber: 2, clonedFromVersionId: v1 },
      });
      // Nenhum evento de domínio na criação de rascunho.
      expect(
        eventsOf('TemplateVersionPublished').some((e) => e.payload.templateVersionId === draft.id),
      ).toBe(false);
    });

    it('aposentar: RETIRED com retiredAt, auditoria e TemplateVersionRetired; sendo a corrente, a outra publicada assume', async () => {
      silence();
      const { template, v1, v2 } = await background('Ofício aposentado');
      await publish(v2, '"2"');
      const events = eventsOf('TemplateVersionRetired').length;

      const response = await retire(v2, '"3"');

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"4"');
      expect(dataOf<TemplateVersionDto>(response)).toMatchObject({
        status: 'RETIRED',
        retiredAt: NOW.toISOString(),
      });
      expect(versionRow(v2)?.retiredById).toBe(MARTA.id);
      expect(dataOf<TemplateDto>(await getTemplate(template.id)).currentPublishedVersion?.id).toBe(
        v1,
      );
      expect(auditOf('template.version_retire').at(-1)).toMatchObject({
        category: 'CONFIGURATION',
        entityId: template.id,
        metadata: { templateVersionId: v2 },
        changes: [{ path: 'currentPublishedVersionId', old: v2, new: v1 }],
      });
      expect(eventsOf('TemplateVersionRetired')).toHaveLength(events + 1);
      expect(eventsOf('TemplateVersionRetired').at(-1)).toMatchObject({
        routingKey: 'template.version_retired',
        payload: { templateId: template.id, templateVersionId: v2 },
      });
      // Consulta e impressão continuam (a versão aposentada segue legível).
      expect(dataOf<TemplateVersionDto>(await getVersion(v2)).sections).toHaveLength(3);
    });

    it('FA-02: sem publicada nem rascunho, a nova versão clona a aposentada mais recente', async () => {
      silence();
      const { template, v1 } = await draftTemplate('Ofício só aposentado');
      await publish(v1, '"2"');
      expect((await retire(v1, '"3"')).status).toBe(200);
      expect(
        dataOf<TemplateDto>(await getTemplate(template.id)).currentPublishedVersion,
      ).toBeNull();

      const response = await newVersion(template.id);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(dataOf<TemplateVersionDto>(response)).toMatchObject({
        versionNumber: 2,
        status: 'DRAFT',
      });
    });

    it('RN-TPL-15: versão publicada é imutável (TPL-08 → 409) e o hash não muda', async () => {
      silence();
      const { v1 } = await draftTemplate('Ofício imutável');
      const published = dataOf<TemplateVersionDto>(await publish(v1, '"2"'));
      expectProblem(
        await withAuth(request(api.server).patch(`/api/v1/template-versions/${v1}`), MARTA)
          .set('If-Match', '"3"')
          .send({ sections: [section('OUTRA', 1)] }),
        409,
        'TEMPLATE_VERSION_NOT_DRAFT',
      );
      const after = dataOf<TemplateVersionDto>(await getVersion(v1));
      expect(after.contentHash).toBe(published.contentHash);
      expect(after.sections.map((item) => item.key)).toEqual(['OBJETO', 'FUNDAMENTACAO']);
    });
  });

  describe('[Validação]', () => {
    it('publicar versão com variável desconhecida: 422 TEMPLATE_INVALID na seção e a versão permanece DRAFT', async () => {
      silence();
      const { v1 } = await draftTemplate('Ofício inválido');
      const draft = versionRow(v1);
      const first = draft?.sections[0];
      if (!draft || !first) throw new Error('rascunho ausente');
      // Conteúdo gravado antes de uma regra mais estrita (o editor recusaria hoje).
      templates.seed([], [{ ...draft, sections: [{ ...first, helpText: 'Veja {{processo.x}}' }] }]);
      const audits = auditOf('template.version_publish').length;
      const events = eventsOf('TemplateVersionPublished').length;

      const problem = expectProblem(await publish(v1, '"2"'), 422, 'TEMPLATE_INVALID');

      expect(problem.violations).toEqual([
        expect.objectContaining({
          code: 'TEMPLATE_VARIABLE_UNKNOWN',
          severity: 'BLOCKING',
          sectionKey: 'OBJETO',
        }),
      ]);
      expect(versionRow(v1)).toMatchObject({ status: 'DRAFT', contentHash: null, version: 2 });
      expect(auditOf('template.version_publish')).toHaveLength(audits);
      expect(eventsOf('TemplateVersionPublished')).toHaveLength(events);
    });

    it('estado da versão: publicar publicada → 409 TEMPLATE_VERSION_NOT_DRAFT; aposentar rascunho/aposentada → 409 INVALID_STATE', async () => {
      silence();
      const { v1, v2 } = await background('Ofício estados');
      expectProblem(await publish(v1, '"2"'), 409, 'TEMPLATE_VERSION_NOT_DRAFT');
      const draftRetire = expectProblem(await retire(v2, '"2"'), 409, 'INVALID_STATE');
      expect(draftRetire.detail).toBe('Só é possível aposentar uma versão publicada.');
      await retire(v1, '"3"');
      expectProblem(await retire(v1, '"4"'), 409, 'INVALID_STATE');
    });

    it('RN-TPL-14: template inativo não publica (409 INVALID_STATE)', async () => {
      silence();
      const { template, v1 } = await draftTemplate('Ofício inativo');
      await withAuth(request(api.server).patch(`/api/v1/templates/${template.id}`), MARTA)
        .set('If-Match', '"1"')
        .send({ isActive: false });
      expectProblem(await publish(v1, '"2"'), 409, 'INVALID_STATE');
      expect(versionRow(v1)?.status).toBe('DRAFT');
    });

    it('FA-03/V-04: aposentar a versão corrente sem substituta, sendo padrão do tipo → 409 TEMPLATE_IN_USE', async () => {
      silence();
      const { template, v1 } = await draftTemplate('Autorização padrão', 'AUTORIZACAO');
      await publish(v1, '"2"');
      const autorizacao = typeOf('AUTORIZACAO');
      await setDefault(autorizacao.id, template.id, `"${autorizacao.version}"`);
      const events = eventsOf('TemplateVersionRetired').length;

      const problem = expectProblem(await retire(v1, '"3"'), 409, 'TEMPLATE_IN_USE');

      expect(problem.detail).toBe(
        `Publique outra versão antes de aposentar esta, pois ela é a padrão de "${autorizacao.name}".`,
      );
      expect(versionRow(v1)?.status).toBe('PUBLISHED');
      expect(eventsOf('TemplateVersionRetired')).toHaveLength(events);
    });

    it('V-05/V-06: padrão sem versão publicada → 422 TEMPLATE_NOT_PUBLISHED; template de outro tipo → 422 VALIDATION_ERROR', async () => {
      silence();
      const { template } = await draftTemplate('Ofício sem publicação');
      const oficio = typeOf('OFICIO');
      const problem = expectProblem(
        await setDefault(oficio.id, template.id, `"${oficio.version}"`),
        422,
        'BUSINESS_RULE_VIOLATION',
      );
      expect(problem.violations).toEqual([
        expect.objectContaining({
          code: 'TEMPLATE_NOT_PUBLISHED',
          field: 'templateId',
          message: 'Este template ainda não tem uma versão publicada.',
        }),
      ]);

      const despacho = typeOf('DESPACHO');
      const other = expectProblem(
        await setDefault(despacho.id, template.id, `"${despacho.version}"`),
        422,
        'VALIDATION_ERROR',
      );
      expect(other.errors).toEqual([
        {
          field: 'templateId',
          code: 'NOT_ALLOWED',
          message: 'Este template não pertence ao tipo selecionado.',
        },
      ]);
      expect(typeOf('OFICIO').defaultTemplateId).toBe(oficio.defaultTemplateId);
    });

    it('DTY-04 sem If-Match → 428; corpo inválido → 422 VALIDATION_ERROR; publicar sem If-Match → 428', async () => {
      silence();
      const { template, v1 } = await draftTemplate('Ofício cabeçalhos');
      const oficio = typeOf('OFICIO');
      expectProblem(await setDefault(oficio.id, template.id, null), 428, 'PRECONDITION_REQUIRED');
      expectProblem(
        await setDefault(oficio.id, 'não-é-uuid', `"${oficio.version}"`),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(await publish(v1, null), 428, 'PRECONDITION_REQUIRED');
    });

    it('V-07: nova versão com rascunho existente → 409 TEMPLATE_DRAFT_EXISTS com o id do rascunho', async () => {
      silence();
      const { template, v2 } = await background('Ofício com rascunho');
      const problem = expectProblem(await newVersion(template.id), 409, 'TEMPLATE_DRAFT_EXISTS');
      expect(problem.meta).toEqual({ draftVersionId: v2 });
    });
  });

  describe('[Permissão]', () => {
    /** Perfil do tenant com TEMPLATE_MANAGE, sem TEMPLATE_PUBLISH, durante `work`. */
    const withoutPublish = async (work: () => Promise<void>) => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- chamado com o `this` da instância
      const original = AccessFacade.prototype.assertCan;
      const spy = vi.spyOn(AccessFacade.prototype, 'assertCan').mockImplementation(function (
        this: AccessFacade,
        permission,
        options,
      ) {
        if (permission === 'TEMPLATE_PUBLISH') {
          throw new ApiError('PERMISSION_DENIED', { auditReasonCode: permission });
        }
        original.call(this, permission, options);
      });
      try {
        await work();
      } finally {
        spy.mockRestore();
      }
    };

    it('usuário só com TEMPLATE_MANAGE tenta publicar: 403 PERMISSION_DENIED com access.denied TEMPLATE_PUBLISH', async () => {
      silence();
      const { template, v1, v2 } = await background('Ofício restrito');
      await withoutPublish(async () => {
        const denials = auditOf('access.denied').length;
        expectProblem(await publish(v2, '"2"'), 403, 'PERMISSION_DENIED');
        expect(auditOf('access.denied')).toHaveLength(denials + 1);
        expect(auditOf('access.denied').at(-1)).toMatchObject({
          tenantId: A,
          actorUserId: MARTA.id,
          reasonCode: 'TEMPLATE_PUBLISH',
          result: 'DENIED',
        });
        expectProblem(await retire(v1, '"2"'), 403, 'PERMISSION_DENIED');
        const oficio = typeOf('OFICIO');
        expectProblem(
          await setDefault(oficio.id, template.id, `"${oficio.version}"`),
          403,
          'PERMISSION_DENIED',
        );
        // TEMPLATE_MANAGE basta para consultar o histórico.
        expect((await history(template.id)).status).toBe(200);
      });
      expect(versionRow(v2)?.status).toBe('DRAFT');
    });

    it('TEMPLATE_MANAGE (sem PUBLISH) inicia nova versão; só TEMPLATE_VIEW consulta mas não cria (FA-05)', async () => {
      silence();
      const { template, v1 } = await draftTemplate('Ofício de leitura');
      await publish(v1, '"2"');
      expect((await history(template.id, '', ANA)).status).toBe(200);
      expectProblem(await newVersion(template.id, ANA), 403, 'PERMISSION_DENIED');
      expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'TEMPLATE_MANAGE' });
      await withoutPublish(async () => {
        expect((await newVersion(template.id)).status).toBe(201);
      });
    });

    it('publicar sem MFA na sessão: 403 MFA_REQUIRED (POL-14) e nada muda', async () => {
      silence();
      const { v1 } = await draftTemplate('Ofício sem MFA');
      const response = await request(api.server)
        .post(`/api/v1/template-versions/${v1}/publish`)
        .set('Authorization', api.bearer(MARTA.subject, { amr: ['pwd'] }))
        .set('X-Tenant-Id', A)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '"2"')
        .send();
      expectProblem(response, 403, 'MFA_REQUIRED');
      expect(versionRow(v1)?.status).toBe('DRAFT');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('versão, template e tipo de outro tenant → 404 NOT_FOUND, sem efeito', async () => {
      silence();
      const other = await background('Ofício da B', HEITOR, B);
      expectProblem(await publish(other.v2, '"2"'), 404, 'NOT_FOUND');
      expectProblem(await retire(other.v1, '"2"'), 404, 'NOT_FOUND');
      expectProblem(await history(other.template.id), 404, 'NOT_FOUND');
      expectProblem(await newVersion(other.template.id), 404, 'NOT_FOUND');
      const oficioA = typeOf('OFICIO');
      expectProblem(
        await setDefault(oficioA.id, other.template.id, `"${oficioA.version}"`),
        404,
        'NOT_FOUND',
      );
      const oficioB = typeOf('OFICIO', B);
      expectProblem(await setDefault(oficioB.id, other.template.id, '"1"'), 404, 'NOT_FOUND');
      expect(versionRow(other.v2)?.status).toBe('DRAFT');
      expect(versionRow(other.v1)?.status).toBe('PUBLISHED');
    });
  });

  describe('[Duplicidade]', () => {
    it('reenvio da publicação com a mesma chave: 200 com o mesmo contentHash e Idempotent-Replayed, sem segunda publicação', async () => {
      silence();
      const { v2 } = await background('Ofício idempotente');
      const audits = auditOf('template.version_publish').length;
      const events = eventsOf('TemplateVersionPublished').length;

      const k9 = randomUUID();
      const first = await publish(v2, '"2"', { key: k9 });
      const second = await publish(v2, '"2"', { key: k9 });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(dataOf<TemplateVersionDto>(second).contentHash).toBe(
        dataOf<TemplateVersionDto>(first).contentHash,
      );
      expect(auditOf('template.version_publish')).toHaveLength(audits + 1);
      expect(eventsOf('TemplateVersionPublished')).toHaveLength(events + 1);
    });
  });

  describe('[Concorrência]', () => {
    it('duas solicitações simultâneas de nova versão: uma 201 (versão 3) e outra 409 TEMPLATE_DRAFT_EXISTS', async () => {
      silence();
      const { template, v2 } = await background('Ofício concorrido');
      await publish(v2, '"2"');

      const [one, two] = await Promise.all([
        newVersion(template.id),
        newVersion(template.id, OTAVIO),
      ]);

      expect([one.status, two.status].sort()).toEqual([201, 409]);
      const created = [one, two].find((response) => response.status === 201);
      const conflict = [one, two].find((response) => response.status === 409);
      expect(created && dataOf<TemplateVersionDto>(created).versionNumber).toBe(3);
      expect(conflict && problemDetailsSchema.parse(conflict.body).code).toBe(
        'TEMPLATE_DRAFT_EXISTS',
      );
      const drafts = templates
        .snapshot()
        .versions.filter((v) => v.templateId === template.id && v.status === 'DRAFT');
      expect(drafts).toHaveLength(1);
    });

    it('V-08: If-Match divergente em publicar, aposentar e definir padrão → 412 VERSION_CONFLICT', async () => {
      silence();
      const { template, v1, v2 } = await background('Ofício em conflito');
      const stale = expectProblem(await publish(v2, '"1"'), 412, 'VERSION_CONFLICT');
      expect(stale.currentVersion).toBe(2);
      expectProblem(await retire(v1, '"1"'), 412, 'VERSION_CONFLICT');
      const oficio = typeOf('OFICIO');
      expectProblem(
        await setDefault(oficio.id, template.id, `"${oficio.version + 5}"`),
        412,
        'VERSION_CONFLICT',
      );
      expect(versionRow(v2)?.status).toBe('DRAFT');
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível ao publicar: 503 DEPENDENCY_UNAVAILABLE, log de falha e nada gravado', async () => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const failing: DocumentTransactions = {
        run: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
        read: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
      };
      const down = await createTestApi({
        providers: [
          { token: DOCUMENT_TRANSACTIONS, value: failing },
          { token: DOCUMENT_CLOCK, value: () => NOW },
        ],
      });
      try {
        const audits = down.auditRecords().length;
        const response = await request(down.server)
          .post(`/api/v1/template-versions/${newId()}/publish`)
          .set('Authorization', down.bearer(MARTA.subject, { amr: MFA }))
          .set('X-Tenant-Id', A)
          .set('Idempotency-Key', randomUUID())
          .set('If-Match', '"2"')
          .send();
        expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
        expect(response.headers['retry-after']).toBe('5');
        expect(down.auditRecords()).toHaveLength(audits);
        expect(down.outboxRows()).toHaveLength(0);
        expect(error).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'template_version.publish_failed',
            errorCode: 'DEPENDENCY_UNAVAILABLE',
          }),
          'template_version.publish_failed',
        );
      } finally {
        await down.close();
      }
    });
  });

  describe('[Falha de integração]', () => {
    it('relay do outbox indisponível: a publicação conclui (200) e o evento fica gravado no outbox para o relay', async () => {
      // O outbox em memória não tem relay (equivale ao relay parado): o evento só existe como
      // linha gravada na transação. A publicação única pelo relay é coberta em
      // test/tenant-leak/templates.spec.ts (linha PENDING no PostgreSQL) e test/outbox.
      silence();
      const { v2 } = await background('Ofício sem relay');
      const response = await publish(v2, '"2"');
      expect(response.status).toBe(200);
      expect(versionRow(v2)?.status).toBe('PUBLISHED');
      const rows = eventsOf('TemplateVersionPublished').filter(
        (row) => row.payload.templateVersionId === v2,
      );
      expect(rows).toHaveLength(1);
    });
  });
});
