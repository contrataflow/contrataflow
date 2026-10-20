import { randomUUID } from 'node:crypto';

import {
  DEFAULT_TEMPLATE_LAYOUT,
  DEFAULT_TR_IMPORT_MAPPINGS,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type { TemplateDto, TemplateVersionDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { InMemoryCacheStore } from '#shared/cache/cache-store.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from '../application/ports.js';
import type { DocumentTransactions } from '../application/ports.js';
import { buildSystemDocumentTypes } from '../domain/system-document-types.js';
import { InMemoryDocumentTypeRepository } from '../infrastructure/in-memory-document-type.repository.js';
import { InMemoryTemplateRepository } from '../infrastructure/in-memory-template.repository.js';

/*
 * US-107 — TPL-01..04/07/08 pelo pipeline HTTP completo (autenticação, tenant, vínculo, If-Match,
 * idempotência, validação Zod, filtro RFC 9457) com a identidade fake e a auditoria real do
 * `AuditService`. Os mesmos casos contra o PostgreSQL (RLS, índices únicos, gatilho de
 * imutabilidade) estão em `test/document/templates.spec.ts` e `test/tenant-leak/templates.spec.ts`.
 *
 * Personagens: Marta e Otávio (ADMIN_ORGAO — "Carla" e "Diego" da story), Ana (REQUISITANTE, só
 * TEMPLATE_VIEW — "Bruno") e Heitor (GESTOR_CONTRATACOES da Prefeitura B).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MARTA = FAKE_USERS.marta;
const OTAVIO = FAKE_USERS.otavio;
const ANA = FAKE_USERS.ana;
const HEITOR = FAKE_USERS.heitor;
const NOW = new Date('2026-10-15T12:00:00.000Z');

interface User {
  subject: string;
}

function templateOf(response: request.Response): TemplateDto {
  return (response.body as { data: TemplateDto }).data;
}

function versionOf(response: request.Response): TemplateVersionDto {
  return (response.body as { data: TemplateVersionDto }).data;
}

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

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('Feature: Criar e editar template de documento (US-107)', () => {
  let api: TestApi;
  let types: InMemoryDocumentTypeRepository;
  let templates: InMemoryTemplateRepository;

  beforeAll(async () => {
    api = await createTestApi({ providers: [{ token: DOCUMENT_CLOCK, value: () => NOW }] });
    types = api.app.get(InMemoryDocumentTypeRepository, { strict: false });
    templates = api.app.get(InMemoryTemplateRepository, { strict: false });
    // Background: tenants A e B ativos com os tipos de sistema (DESPACHO FREE_TEXT, TR STRUCTURED…).
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
    test.set('Authorization', api.bearer(user.subject)).set('X-Tenant-Id', tenant);

  const typeId = (code: string, tenantId: string = A): string => {
    const type = types.snapshot().find((row) => row.code === code && row.tenantId === tenantId);
    if (!type) throw new Error(`tipo ${code} inexistente`);
    return type.id;
  };

  const create = (
    body: Record<string, unknown>,
    options: { user?: User; key?: string; tenant?: string } = {},
  ) =>
    withAuth(request(api.server).post('/api/v1/templates'), options.user ?? MARTA, options.tenant)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);

  const getVersion = (versionId: string, user: User = MARTA, tenant: string = A) =>
    withAuth(request(api.server).get(`/api/v1/template-versions/${versionId}`), user, tenant);

  const patchVersion = (
    versionId: string,
    body: Record<string, unknown>,
    ifMatch: string | null,
    user: User = MARTA,
    tenant: string = A,
  ) => {
    const test = withAuth(
      request(api.server).patch(`/api/v1/template-versions/${versionId}`),
      user,
      tenant,
    );
    return (ifMatch === null ? test : test.set('If-Match', ifMatch)).send(body);
  };

  const patchTemplate = (
    id: string,
    body: Record<string, unknown>,
    ifMatch: string | null,
    user: User = MARTA,
  ) => {
    const test = withAuth(request(api.server).patch(`/api/v1/templates/${id}`), user);
    return (ifMatch === null ? test : test.set('If-Match', ifMatch)).send(body);
  };

  /** Cria um template e devolve o template e o id do rascunho. */
  const newTemplate = async (
    name: string,
    code = 'DESPACHO',
    user: User = MARTA,
    tenant: string = A,
  ) => {
    const response = await create({ name, documentTypeId: typeId(code, tenant) }, { user, tenant });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const template = templateOf(response);
    return { template, versionId: template.draftVersion?.id ?? '' };
  };

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);

  describe('[Sucesso]', () => {
    it('criar template e a primeira versão rascunho: 201, Location, ETag "1", layout padrão e template.create', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const key = randomUUID();
      const audits = auditOf('template.create').length;

      const response = await create(
        {
          name: 'Despacho padrão',
          documentTypeId: typeId('DESPACHO'),
          description: 'Modelo geral',
        },
        { key },
      );

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.headers.etag).toBe('"1"');
      const template = templateOf(response);
      expect(response.headers.location).toBe(`/api/v1/templates/${template.id}`);
      expect(template).toMatchObject({
        name: 'Despacho padrão',
        description: 'Modelo geral',
        isActive: true,
        isSystem: false,
        documentType: { code: 'DESPACHO', kind: 'FREE_TEXT' },
        currentPublishedVersion: null,
        draftVersion: { versionNumber: 1, status: 'DRAFT', sectionCount: 0 },
        version: 1,
      });

      const version = await getVersion(template.draftVersion?.id ?? '');
      expect(version.status).toBe(200);
      expect(version.headers.etag).toBe('"1"');
      expect(versionOf(version)).toMatchObject({
        versionNumber: 1,
        status: 'DRAFT',
        sections: [],
        fieldConfig: {},
        importMappings: null,
        importSources: null,
        layout: DEFAULT_TEMPLATE_LAYOUT,
      });

      const records = auditOf('template.create');
      expect(records).toHaveLength(audits + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        category: 'CONFIGURATION',
        result: 'SUCCESS',
        actorUserId: MARTA.id,
        entityType: 'DocumentTemplate',
        entityId: template.id,
        metadata: { templateId: template.id, idempotencyKey: key },
      });
      expect(records.at(-1)?.changes).toEqual([
        { path: 'name', old: null, new: 'Despacho padrão' },
        { path: 'documentTypeId', old: null, new: typeId('DESPACHO') },
      ]);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'template.created',
          templateId: template.id,
          documentTypeId: typeId('DESPACHO'),
          durationMs: expect.any(Number) as number,
        }),
        'template.created',
      );
    });

    it('adicionar seções ao rascunho: 200, ordem informada, novo ETag e template.update sem conteúdo no log', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { template, versionId } = await newTemplate('Despacho com seções');
      const audits = auditOf('template.update').length;

      const response = await patchVersion(
        versionId,
        {
          sections: [
            section('FUNDAMENTACAO', 2, {
              requirement: 'REQUIRED_OR_JUSTIFY',
              helpText: 'Cite a base legal de {{process.object}}.',
              legalBasis: 'Lei 14.133/2021, art. 72',
            }),
            section('OBJETO', 1, { defaultContent: doc('Objeto: {{process.object}} — {{today}}') }),
          ],
          changeNotes: 'Primeira estrutura',
        },
        '"1"',
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      const version = versionOf(response);
      expect(version.sections.map((item) => item.key)).toEqual(['OBJETO', 'FUNDAMENTACAO']);
      expect(version.sections[1]).toMatchObject({
        requirement: 'REQUIRED_OR_JUSTIFY',
        maxChars: 50_000,
        render: 'TEXT',
        allowNarrative: true,
      });
      expect(version.changeNotes).toBe('Primeira estrutura');

      const records = auditOf('template.update');
      expect(records).toHaveLength(audits + 1);
      expect(records.at(-1)).toMatchObject({
        category: 'CONFIGURATION',
        entityId: template.id,
        metadata: { templateVersionId: versionId, scope: 'content' },
      });
      expect(records.at(-1)?.changes).toEqual([
        { path: 'sectionsChanged', old: null, new: ['FUNDAMENTACAO', 'OBJETO'] },
        { path: 'changeNotesChanged', old: null, new: true },
      ]);
      const contentLog = log.mock.calls.find(
        (call) => call[1] === 'template_version.content_updated',
      );
      expect(contentLog?.[0]).toMatchObject({
        templateVersionId: versionId,
        sectionCount: 2,
        fieldsChanged: ['sections', 'changeNotes'],
      });
      // Nunca logar conteúdo de seção nem base legal.
      expect(JSON.stringify(contentLog)).not.toMatch(/process\.object|art\. 72/);

      // FA-06/passo 8: recarregar traz o estado persistido.
      const reloaded = await getVersion(versionId);
      expect(versionOf(reloaded).sections).toHaveLength(2);
      expect(reloaded.headers.etag).toBe('"2"');
    });

    it('FA-01: reordenar 30 seções numa única chamada preserva a ordem', async () => {
      silence();
      const { versionId } = await newTemplate('Despacho com 30 seções');
      const keys = Array.from(
        { length: 30 },
        (_, index) => `SECAO_${String(index + 1).padStart(2, '0')}`,
      );
      expect(
        (
          await patchVersion(
            versionId,
            { sections: keys.map((key, i) => section(key, i + 1)) },
            '"1"',
          )
        ).status,
      ).toBe(200);
      const reversed = [...keys].reverse();
      const response = await patchVersion(
        versionId,
        { sections: reversed.map((key, i) => section(key, i + 1)) },
        '"2"',
      );
      expect(response.status).toBe(200);
      expect(versionOf(response).sections.map((item) => item.key)).toEqual(reversed);
    });

    it('TR: nasce com o mapeamento padrão e as fontes do ETP; fieldConfig e importMappings editáveis', async () => {
      silence();
      const { versionId } = await newTemplate('TR padrão', 'TR');
      const loaded = versionOf(await getVersion(versionId));
      expect(loaded.importMappings).toEqual(DEFAULT_TR_IMPORT_MAPPINGS);
      expect(loaded.importSources?.sectionKeys).toContain('RECOMMENDED_SOLUTION');
      expect(loaded.importSources?.fieldKeys).toContain('estimatedTotalValue');

      const response = await patchVersion(
        versionId,
        {
          sections: [
            section('OBJECT', 1),
            section('SPECIFICATIONS', 2),
            section('ITENS', 3, { render: 'ITEMS_TABLE', allowNarrative: false }),
          ],
          fieldConfig: {
            objectDefinition: { label: 'Objeto da contratação', required: true },
            paymentTermDays: { defaultValue: 30 },
          },
          importMappings: {
            ...DEFAULT_TR_IMPORT_MAPPINGS,
            sections: [
              { target: 'OBJECT', sources: ['RECOMMENDED_SOLUTION'], mode: 'REPLACE' },
              { target: 'SPECIFICATIONS', sources: ['REQUIREMENTS'], mode: 'APPEND' },
            ],
          },
        },
        '"1"',
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const version = versionOf(response);
      expect(version.fieldConfig).toEqual({
        objectDefinition: { label: 'Objeto da contratação', required: true },
        paymentTermDays: { defaultValue: 30 },
      });
      expect(version.importMappings?.sections).toHaveLength(2);
      const audit = auditOf('template.update').at(-1);
      expect(audit?.changes).toEqual(
        expect.arrayContaining([
          { path: 'fieldConfigChanged', old: null, new: true },
          { path: 'importMappingsChanged', old: null, new: true },
        ]),
      );
    });

    it('TPL-01/03: lista paginada com filtros e consulta com ETag', async () => {
      silence();
      const { template } = await newTemplate('Ofício de cobrança', 'OFICIO');
      const list = await withAuth(
        request(api.server).get(`/api/v1/templates?documentTypeId=${typeId('OFICIO')}&q=cobran`),
        MARTA,
      );
      expect(list.status).toBe(200);
      const body = list.body as {
        data: TemplateDto[];
        meta: { totalItems: number; pageSize: number };
      };
      expect(body.data.map((item) => item.id)).toEqual([template.id]);
      expect(body.meta).toMatchObject({ totalItems: 1, pageSize: 50 });

      const detail = await withAuth(
        request(api.server).get(`/api/v1/templates/${template.id}`),
        MARTA,
      );
      expect(detail.status).toBe(200);
      expect(detail.headers.etag).toBe('"1"');
      expect(templateOf(detail).draftVersion?.versionNumber).toBe(1);
    });

    it('FA-03/RN-TPL-11: metadados e isActive pelo TPL-04; inativo some do filtro de ativos e o rascunho segue editável', async () => {
      silence();
      const { template, versionId } = await newTemplate('Declaração antiga', 'DECLARACAO');
      const response = await patchTemplate(
        template.id,
        { name: 'Declaração (antiga)', description: '  ', isActive: false },
        '"1"',
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      expect(templateOf(response)).toMatchObject({
        name: 'Declaração (antiga)',
        description: null,
        isActive: false,
        version: 2,
      });
      expect(auditOf('template.update').at(-1)).toMatchObject({
        metadata: { templateId: template.id, scope: 'metadata' },
        changes: expect.arrayContaining([{ path: 'isActive', old: true, new: false }]) as unknown,
      });

      const active = await withAuth(
        request(api.server).get(
          `/api/v1/templates?isActive=true&documentTypeId=${typeId('DECLARACAO')}`,
        ),
        MARTA,
      );
      expect((active.body as { data: TemplateDto[] }).data.some((t) => t.id === template.id)).toBe(
        false,
      );
      expect(
        (await patchVersion(versionId, { sections: [section('TEXTO', 1)] }, '"1"')).status,
      ).toBe(200);
    });

    it('nada alterado: 200 com o mesmo ETag e sem auditoria', async () => {
      silence();
      const { template, versionId } = await newTemplate('Despacho sem mudança');
      const audits = auditOf('template.update').length;
      const same = await patchVersion(versionId, { sections: [] }, '"1"');
      expect(same.status).toBe(200);
      expect(same.headers.etag).toBe('"1"');
      const meta = await patchTemplate(template.id, { name: 'Despacho sem mudança' }, '"1"');
      expect(meta.headers.etag).toBe('"1"');
      expect(auditOf('template.update')).toHaveLength(audits);
    });
  });

  describe('[Validação]', () => {
    it('seção com variável desconhecida: 422 TEMPLATE_INVALID na seção e nada salvo', async () => {
      silence();
      const { versionId } = await newTemplate('Despacho com variável');
      const response = await patchVersion(
        versionId,
        {
          sections: [
            section('OBJETO', 1, { defaultContent: doc('Assina {{document.assinante}}') }),
          ],
        },
        '"1"',
      );
      const problem = expectProblem(response, 422, 'TEMPLATE_INVALID');
      expect(problem.violations).toEqual([
        {
          code: 'TEMPLATE_VARIABLE_UNKNOWN',
          severity: 'BLOCKING',
          message: 'A variável {{document.assinante}} não é reconhecida.',
          ruleId: null,
          sectionKey: 'OBJETO',
          field: 'defaultContent',
          itemId: null,
          params: { variable: 'document.assinante' },
        },
      ]);
      const stored = versionOf(await getVersion(versionId));
      expect(stored.sections).toEqual([]);
      expect(stored.version).toBe(1);
    });

    it('RN-TPL-06: variáveis de renderização (document.hash, page) não valem em seções', async () => {
      silence();
      const { versionId } = await newTemplate('Despacho com hash');
      const problem = expectProblem(
        await patchVersion(
          versionId,
          { sections: [section('OBJETO', 1, { helpText: 'Pág. {{page}} — {{document.hash}}' })] },
          '"1"',
        ),
        422,
        'TEMPLATE_INVALID',
      );
      expect(problem.violations.map((v) => v.params.variable)).toEqual(['page', 'document.hash']);
      expect(problem.violations.every((v) => v.field === 'helpText')).toBe(true);
    });

    it('chave de seção duplicada: 422 TEMPLATE_INVALID referenciando a seção OBJETO', async () => {
      silence();
      const { versionId } = await newTemplate('Despacho duplicado');
      expect(
        (await patchVersion(versionId, { sections: [section('OBJETO', 1)] }, '"1"')).status,
      ).toBe(200);
      const problem = expectProblem(
        await patchVersion(
          versionId,
          { sections: [section('OBJETO', 1), section('OBJETO', 2)] },
          '"2"',
        ),
        422,
        'TEMPLATE_INVALID',
      );
      expect(problem.violations).toEqual([
        expect.objectContaining({
          code: 'TEMPLATE_SECTION_KEY_DUPLICATE',
          sectionKey: 'OBJETO',
          message: 'A chave "OBJETO" já existe nesta versão.',
        }),
      ]);
    });

    it('chave fora do padrão, ordem com buraco e bloco incompatível com FREE_TEXT consolidam violações', async () => {
      silence();
      const { versionId } = await newTemplate('Despacho inválido');
      const problem = expectProblem(
        await patchVersion(
          versionId,
          {
            sections: [section('objeto', 1), section('ITENS', 3, { render: 'ITEMS_TABLE' })],
          },
          '"1"',
        ),
        422,
        'TEMPLATE_INVALID',
      );
      expect(problem.violations.map((v) => [v.code, v.sectionKey])).toEqual([
        ['TEMPLATE_SECTION_KEY_INVALID', 'objeto'],
        ['TEMPLATE_RENDER_NOT_ALLOWED', 'ITENS'],
        ['TEMPLATE_SECTION_ORDER_INVALID', 'ITENS'],
      ]);
      expect(problem.violations[1]?.message).toBe(
        'Este tipo de bloco não é permitido para este tipo de documento.',
      );
    });

    it('V-10: minChars maior que maxChars é 422 VALIDATION_ERROR no campo', async () => {
      silence();
      const { versionId } = await newTemplate('Despacho limites');
      const problem = expectProblem(
        await patchVersion(
          versionId,
          { sections: [section('OBJETO', 1, { minChars: 500, maxChars: 100 })] },
          '"1"',
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({
          field: 'sections[0].minChars',
          message: 'O mínimo não pode ser maior que o máximo.',
        }),
      ]);
    });

    it('conteúdo rico fora do schema (nó desconhecido) é 422 VALIDATION_ERROR', async () => {
      silence();
      const { versionId } = await newTemplate('Despacho script');
      const problem = expectProblem(
        await patchVersion(
          versionId,
          {
            sections: [
              section('OBJETO', 1, {
                defaultContent: { type: 'doc', content: [{ type: 'script' }] },
              }),
            ],
          },
          '"1"',
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors[0]?.field).toBe('sections[0].defaultContent');
    });

    it('RN-TPL-07/08: fieldConfig e importMappings fora do lugar e referências inexistentes', async () => {
      silence();
      const despacho = await newTemplate('Despacho com campos');
      const notAllowed = expectProblem(
        await patchVersion(
          despacho.versionId,
          {
            fieldConfig: { objectSummary: { label: 'Objeto' } },
            importMappings: DEFAULT_TR_IMPORT_MAPPINGS,
          },
          '"1"',
        ),
        422,
        'TEMPLATE_INVALID',
      );
      expect(notAllowed.violations.map((v) => v.code)).toEqual([
        'TEMPLATE_FIELD_CONFIG_NOT_ALLOWED',
        'TEMPLATE_IMPORT_MAPPINGS_NOT_ALLOWED',
      ]);

      const tr = await newTemplate('TR inválido', 'TR');
      const invalid = expectProblem(
        await patchVersion(
          tr.versionId,
          {
            sections: [section('OBJECT', 1)],
            fieldConfig: { campoInventado: { required: true } },
            importMappings: {
              ...DEFAULT_TR_IMPORT_MAPPINGS,
              sections: [
                { target: 'OBJECT', sources: ['SECAO_QUE_NAO_EXISTE'], mode: 'REPLACE' },
                { target: 'JUSTIFICATION', sources: ['PROBLEM'], mode: 'APPEND' },
              ],
              fields: [{ target: 'estimatedTotalValue', source: 'naoExiste' }],
            },
          },
          '"1"',
        ),
        422,
        'TEMPLATE_INVALID',
      );
      expect(invalid.violations.map((v) => [v.code, v.sectionKey])).toEqual([
        ['TEMPLATE_FIELD_UNKNOWN', null],
        ['TEMPLATE_IMPORT_SOURCE_UNKNOWN', 'OBJECT'],
        ['TEMPLATE_IMPORT_TARGET_UNKNOWN', 'JUSTIFICATION'],
        ['TEMPLATE_IMPORT_FIELD_UNKNOWN', null],
      ]);
      expect(invalid.violations[1]?.message).toBe(
        'O mapeamento referencia uma seção que não existe.',
      );
    });

    it('V-01: corpo inválido (nome curto, tipo ausente, campo extra) é 422 VALIDATION_ERROR', async () => {
      silence();
      const problem = expectProblem(await create({ name: 'Ab' }), 422, 'VALIDATION_ERROR');
      expect(problem.errors.map((error) => error.field).sort()).toEqual(['documentTypeId', 'name']);
      expectProblem(
        await create({ name: 'Válido', documentTypeId: typeId('DESPACHO'), isSystem: true }),
        422,
        'VALIDATION_ERROR',
      );
    });

    it('V-03: tipo de documento inativo → REFERENCE_INACTIVE', async () => {
      silence();
      const type = types.snapshot().find((row) => row.code === 'AUTORIZACAO' && row.tenantId === A);
      if (!type) throw new Error('tipo AUTORIZACAO ausente');
      types.seed({ ...type, isActive: false });
      api.app.get<InMemoryCacheStore>(CACHE_STORE, { strict: false }).entries.clear();
      try {
        const problem = expectProblem(
          await create({ name: 'Autorização', documentTypeId: type.id }),
          422,
          'VALIDATION_ERROR',
        );
        expect(problem.errors).toEqual([
          expect.objectContaining({ field: 'documentTypeId', code: 'REFERENCE_INACTIVE' }),
        ]);
      } finally {
        types.seed(type);
        api.app.get<InMemoryCacheStore>(CACHE_STORE, { strict: false }).entries.clear();
      }
    });

    it('FA-05/V-08: PATCH em versão publicada → 409 TEMPLATE_VERSION_NOT_DRAFT; If-Match ausente → 428', async () => {
      silence();
      const { template, versionId } = await newTemplate('Despacho publicado');
      const draft = templates.snapshot().versions.find((version) => version.id === versionId);
      if (!draft) throw new Error('rascunho ausente');
      templates.seed(
        [],
        [{ ...draft, status: 'PUBLISHED', publishedAt: NOW, contentHash: 'a'.repeat(64) }],
      );

      expectProblem(
        await patchVersion(versionId, { sections: [section('OBJETO', 1)] }, '"1"'),
        409,
        'TEMPLATE_VERSION_NOT_DRAFT',
      );
      expectProblem(
        await patchVersion(versionId, { sections: [] }, null),
        428,
        'PRECONDITION_REQUIRED',
      );
      // Consulta segue disponível (modo leitura no editor).
      expect(versionOf(await getVersion(versionId)).status).toBe('PUBLISHED');
      expect(template.id).toBeDefined();
    });
  });

  describe('[Permissão]', () => {
    it('usuário só com TEMPLATE_VIEW consulta, mas o PATCH é 403 PERMISSION_DENIED com access.denied', async () => {
      silence();
      const { versionId } = await newTemplate('Despacho para leitura');
      expect((await getVersion(versionId, ANA)).status).toBe(200);
      const denials = auditOf('access.denied').length;

      expectProblem(
        await patchVersion(versionId, { sections: [section('OBJETO', 1)] }, '"1"', ANA),
        403,
        'PERMISSION_DENIED',
      );
      const records = auditOf('access.denied');
      expect(records).toHaveLength(denials + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        actorUserId: ANA.id,
        reasonCode: 'TEMPLATE_MANAGE',
        result: 'DENIED',
      });
      expect(versionOf(await getVersion(versionId)).sections).toEqual([]);
      expectProblem(
        await create({ name: 'Proibido', documentTypeId: typeId('DESPACHO') }, { user: ANA }),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('sem vínculo ativo (Bruno suspenso) nem TEMPLATE_VIEW: leitura recusada', async () => {
      silence();
      const { versionId } = await newTemplate('Despacho restrito');
      const response = await getVersion(versionId, FAKE_USERS.bruno);
      expect(response.status).toBe(403);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('documentTypeId de outro tenant → 422 REFERENCE_NOT_FOUND sem revelar o outro tenant', async () => {
      silence();
      const problem = expectProblem(
        await create({ name: 'Ofício da B', documentTypeId: typeId('OFICIO', B) }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        {
          field: 'documentTypeId',
          code: 'REFERENCE_NOT_FOUND',
          message: 'Tipo de documento não encontrado.',
        },
      ]);
      expect(JSON.stringify(problem)).not.toMatch(/Prefeitura B|outro tenant/i);
    });

    it('template e versão de outro tenant → 404, nunca o registro', async () => {
      silence();
      const other = await newTemplate('Despacho da B', 'DESPACHO', HEITOR, B);
      expectProblem(
        await withAuth(request(api.server).get(`/api/v1/templates/${other.template.id}`), MARTA),
        404,
        'NOT_FOUND',
      );
      expectProblem(await getVersion(other.versionId), 404, 'NOT_FOUND');
      expectProblem(
        await patchVersion(other.versionId, { sections: [section('OBJETO', 1)] }, '"1"'),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await patchTemplate(other.template.id, { name: 'Invasão' }, '"1"'),
        404,
        'NOT_FOUND',
      );
      const list = await withAuth(request(api.server).get('/api/v1/templates?pageSize=100'), MARTA);
      expect(
        (list.body as { data: TemplateDto[] }).data.some((t) => t.id === other.template.id),
      ).toBe(false);
    });
  });

  describe('[Duplicidade]', () => {
    it('nome já usado no mesmo tipo (caixa diferente) → 409 TEMPLATE_NAME_TAKEN e nada criado', async () => {
      silence();
      await newTemplate('Despacho de encaminhamento');
      const before = templates.snapshot().templates.length;
      const problem = expectProblem(
        await create({ name: 'despacho de ENCAMINHAMENTO', documentTypeId: typeId('DESPACHO') }),
        409,
        'TEMPLATE_NAME_TAKEN',
      );
      expect(problem.detail).toBe(
        'Já existe um template chamado "despacho de ENCAMINHAMENTO" para este tipo de documento.',
      );
      expect(templates.snapshot().templates).toHaveLength(before);
      // Mesmo nome em outro tipo é permitido.
      expect(
        (
          await create({
            name: 'Despacho de encaminhamento',
            documentTypeId: typeId('NOTA_TECNICA'),
          })
        ).status,
      ).toBe(201);
    });

    it('TPL-04: renomear para um nome já usado no tipo → 409', async () => {
      silence();
      await newTemplate('Ofício A', 'OFICIO');
      const { template } = await newTemplate('Ofício B', 'OFICIO');
      expectProblem(
        await patchTemplate(template.id, { name: 'OFÍCIO A' }, '"1"'),
        409,
        'TEMPLATE_NAME_TAKEN',
      );
    });
  });

  describe('[Concorrência]', () => {
    it('edições simultâneas: If-Match "3" depois do salvamento de outra pessoa → 412 com currentVersion 4', async () => {
      silence();
      const { versionId } = await newTemplate('Despacho concorrido');
      await patchVersion(versionId, { sections: [section('A', 1)] }, '"1"');
      await patchVersion(versionId, { sections: [section('A', 1), section('B', 2)] }, '"2"');
      // Marta e Otávio abriram o editor com ETag "3"; Marta salva primeiro.
      const marta = await patchVersion(versionId, { sections: [section('C', 1)] }, '"3"');
      expect(marta.headers.etag).toBe('"4"');

      const otavio = await patchVersion(versionId, { sections: [section('D', 1)] }, '"3"', OTAVIO);
      const problem = expectProblem(otavio, 412, 'VERSION_CONFLICT');
      expect(problem.currentVersion).toBe(4);
      expect(problem.detail).toBe(
        'Este template foi alterado por outra pessoa. Recarregue para continuar.',
      );
      expect(versionOf(await getVersion(versionId)).sections.map((s) => s.key)).toEqual(['C']);
    });

    it('duas gravações em paralelo com o mesmo If-Match: uma 200 e outra 412', async () => {
      silence();
      const { versionId } = await newTemplate('Despacho em paralelo');
      const [one, two] = await Promise.all([
        patchVersion(versionId, { sections: [section('UM', 1)] }, '"1"'),
        patchVersion(versionId, { sections: [section('DOIS', 1)] }, '"1"', OTAVIO),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 412]);
    });

    it('TPL-04 com If-Match desatualizado → 412 com currentVersion', async () => {
      silence();
      const { template } = await newTemplate('Nota concorrida', 'NOTA_TECNICA');
      await patchTemplate(template.id, { description: 'v2' }, '"1"');
      const problem = expectProblem(
        await patchTemplate(template.id, { description: 'v3' }, '"1"'),
        412,
        'VERSION_CONFLICT',
      );
      expect(problem.currentVersion).toBe(2);
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível ao salvar o rascunho: 503 DEPENDENCY_UNAVAILABLE com Retry-After e log de falha', async () => {
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
        const versionId = newId();
        const audits = down.auditRecords().length;
        const response = await request(down.server)
          .patch(`/api/v1/template-versions/${versionId}`)
          .set('Authorization', down.bearer(MARTA.subject))
          .set('X-Tenant-Id', A)
          .set('If-Match', '"1"')
          .send({ sections: [section('OBJETO', 1)] });
        expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
        expect(response.headers['retry-after']).toBe('5');
        expect(down.auditRecords()).toHaveLength(audits);
        expect(error).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'template_version.update_failed',
            errorCode: 'DEPENDENCY_UNAVAILABLE',
          }),
          'template_version.update_failed',
        );
      } finally {
        await down.close();
      }
    });
  });

  describe('[Falha de integração]', () => {
    it('Redis indisponível ao criar o template: criado normalmente e warn idempotency.store_unavailable', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const degraded = await createTestApi({
        stores: 'redis',
        providers: [{ token: DOCUMENT_CLOCK, value: () => NOW }],
      });
      try {
        const degradedTypes = degraded.app.get(InMemoryDocumentTypeRepository, { strict: false });
        await degradedTypes.insertMissing({} as never, buildSystemDocumentTypes(A, NOW, newId));
        const despacho = degradedTypes.snapshot().find((row) => row.code === 'DESPACHO');
        const response = await request(degraded.server)
          .post('/api/v1/templates')
          .set('Authorization', degraded.bearer(MARTA.subject))
          .set('X-Tenant-Id', A)
          .set('Idempotency-Key', randomUUID())
          .send({ name: 'Despacho sem Redis', documentTypeId: despacho?.id });
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^idempotency\.store_unavailable/));
      } finally {
        await degraded.close();
      }
    });
  });
});
