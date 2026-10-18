import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { DocumentTypeDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { InMemoryCacheStore } from '#shared/cache/cache-store.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { DocumentTypeUsageRegistry } from '#shared/document/document-type-usage.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import type { DepartmentForApproval } from '../../organization/application/organization.facade.js';
import { DOCUMENT_CLOCK, DOCUMENT_COUNTER, DOCUMENT_TRANSACTIONS } from '../application/ports.js';
import type { DocumentTransactions } from '../application/ports.js';
import { buildSystemDocumentTypes } from '../domain/system-document-types.js';
import { InMemoryDocumentTypeRepository } from '../infrastructure/in-memory-document-type.repository.js';

/*
 * US-061 — DTY-01..03 pelo pipeline HTTP completo (autenticação, tenant, vínculo, If-Match,
 * idempotência, validação Zod, filtro RFC 9457) com a identidade fake, a auditoria real do
 * `AuditService` e o outbox em memória. Os mesmos casos contra o PostgreSQL (RLS, trigger de
 * imutabilidade) estão em `test/document`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MARTA = FAKE_USERS.marta;
const OTAVIO = FAKE_USERS.otavio;
const LUCIA = FAKE_USERS.lucia;
const MFA = ['pwd', 'otp'];
const NOW = new Date('2026-10-15T12:00:00.000Z');
const GABINETE = newId();
const SECRETARIA_COM_TITULAR = newId();
const DOCS_DO_TIPO_COM_USO = new Map<string, number>();

const departments = new Map<string, DepartmentForApproval>([
  [GABINETE, { id: GABINETE, isActive: true, headUserId: null, deputyUserId: null }],
  [
    SECRETARIA_COM_TITULAR,
    { id: SECRETARIA_COM_TITULAR, isActive: true, headUserId: LUCIA.id, deputyUserId: null },
  ],
]);

const organization = {
  findDepartmentForApproval: (_tx: unknown, id: string) =>
    Promise.resolve(departments.get(id) ?? null),
} as unknown as OrganizationFacade;

const counter = {
  countByType: (_tx: unknown, id: string) => Promise.resolve(DOCS_DO_TIPO_COM_USO.get(id) ?? 0),
};

function dataOf(response: request.Response): unknown {
  return (response.body as { data: unknown }).data;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Gerenciar tipos de documento (US-061)', () => {
  let api: TestApi;
  let repository: InMemoryDocumentTypeRepository;
  let cache: InMemoryCacheStore;

  beforeAll(async () => {
    api = await createTestApi({
      providers: [
        { token: OrganizationFacade, value: organization },
        { token: DOCUMENT_COUNTER, value: counter },
        { token: DOCUMENT_CLOCK, value: () => NOW },
      ],
    });
    repository = api.app.get(InMemoryDocumentTypeRepository, { strict: false });
    cache = api.app.get<InMemoryCacheStore>(CACHE_STORE, { strict: false });
    // Background: tenants A e B ativos com os tipos semeados.
    await repository.insertMissing({} as never, buildSystemDocumentTypes(A, NOW, newId));
    await repository.insertMissing({} as never, buildSystemDocumentTypes(B, NOW, newId));
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
  };

  const withAuth = (
    test: request.Test,
    user: { subject: string },
    options: { amr?: readonly string[]; tenant?: string } = {},
  ) =>
    test
      .set('Authorization', api.bearer(user.subject, { amr: options.amr ?? MFA }))
      .set('X-Tenant-Id', options.tenant ?? A);

  const list = (
    user: { subject: string } = MARTA,
    query = 'includeInactive=true',
    amr: readonly string[] = MFA,
  ) => withAuth(request(api.server).get(`/api/v1/document-types?${query}`), user, { amr });

  const create = (
    body: Record<string, unknown>,
    options: { user?: { subject: string }; key?: string; amr?: readonly string[] } = {},
  ) =>
    withAuth(request(api.server).post('/api/v1/document-types'), options.user ?? MARTA, {
      amr: options.amr ?? MFA,
    })
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);

  const patch = (
    id: string,
    body: Record<string, unknown>,
    ifMatch: string | null,
    options: { user?: { subject: string }; amr?: readonly string[]; tenant?: string } = {},
  ) => {
    const test = withAuth(
      request(api.server).patch(`/api/v1/document-types/${id}`),
      options.user ?? MARTA,
      { amr: options.amr ?? MFA, ...(options.tenant ? { tenant: options.tenant } : {}) },
    );
    return (ifMatch === null ? test : test.set('If-Match', ifMatch)).send(body);
  };

  const typeOf = (code: string, tenantId: string = A): { id: string; version: number } => {
    const type = repository
      .snapshot()
      .find((row) => row.code === code && row.tenantId === tenantId);
    if (!type) throw new Error(`tipo ${code} inexistente`);
    return { id: type.id, version: type.version };
  };

  const customBody = (overrides: Record<string, unknown> = {}) => ({
    kind: 'FREE_TEXT',
    code: 'PARECER_TECNICO',
    name: 'Parecer técnico',
    allowMultiplePerProcess: true,
    numberingEnabled: true,
    numberingMask: 'PT {seq:3}/{year}',
    requiresApproval: false,
    defaultConfidentiality: 'INTERNAL',
    ...overrides,
  });

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);

  describe('[Sucesso]', () => {
    it('criar tipo personalizado: 201, ETag "1", prévia, auditoria CONFIGURATION e evento', async () => {
      silence();
      const key = randomUUID();
      const audits = auditOf('document_type.create').length;
      const events = api.outboxRows().length;

      const response = await create(customBody(), { key });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.headers.etag).toBe('"1"');
      const data = dataOf(response) as DocumentTypeDto;
      expect(response.headers.location).toBe(`/api/v1/document-types/${data.id}`);
      expect(data).toMatchObject({
        code: 'PARECER_TECNICO',
        name: 'Parecer técnico',
        kind: 'FREE_TEXT',
        isSystem: false,
        isActive: true,
        systemModule: null,
        version: 1,
        numberingMask: 'PT {seq:3}/{year}',
        nextNumberPreview: 'PT 001/2026',
        defaultTemplate: null,
      });
      expect(data.editableFields).toHaveLength(10);

      const records = auditOf('document_type.create');
      expect(records).toHaveLength(audits + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        category: 'CONFIGURATION',
        result: 'SUCCESS',
        actorUserId: MARTA.id,
        entityType: 'DocumentType',
        entityId: data.id,
        metadata: { code: 'PARECER_TECNICO', kind: 'FREE_TEXT', idempotencyKey: key },
      });
      expect(api.outboxRows()).toHaveLength(events + 1);
      expect(api.outboxRows().at(-1)).toMatchObject({
        tenantId: A,
        eventType: 'DocumentTypeChanged',
        routingKey: 'document_type.changed',
        aggregateType: 'DocumentType',
        aggregateId: data.id,
        payload: { documentTypeId: data.id, code: 'PARECER_TECNICO' },
      });
      const changed = (api.outboxRows().at(-1)?.payload.changedFields ?? []) as string[];
      expect(changed).toContain('numberingMask');
    });

    it('listar (DTY-01): ordem de exibição, natureza e busca sem acento', async () => {
      const all = await list();
      expect(all.status).toBe(200);
      const data = dataOf(all) as DocumentTypeDto[];
      // Ordem de exibição (sortOrder, nome): os personalizados nascem com 0, antes dos de sistema.
      expect(data.map((type) => type.code).slice(0, 4)).toEqual([
        'PARECER_TECNICO',
        'DFD',
        'ETP',
        'TR',
      ]);
      expect(data.find((type) => type.code === 'DFD')).toMatchObject({
        isSystem: true,
        kind: 'STRUCTURED',
        systemModule: 'DFD',
        nextNumberPreview: 'DFD 0001/2026',
      });
      expect(data.find((type) => type.code === 'DOCUMENTO_EXTERNO')?.nextNumberPreview).toBeNull();

      const byKind = await list(MARTA, 'kind=UPLOADED,FREE_TEXT');
      expect((dataOf(byKind) as DocumentTypeDto[]).every((t) => t.kind !== 'STRUCTURED')).toBe(
        true,
      );
      const search = await list(MARTA, `q=${encodeURIComponent('autorizacao')}`);
      expect((dataOf(search) as DocumentTypeDto[]).map((t) => t.code)).toEqual(['AUTORIZACAO']);
      expectProblem(await list(MARTA, 'kind=OUTRA'), 422, 'VALIDATION_ERROR');
    });

    it('ligar aprovação avulsa em tipo de sistema (titular da secretaria solicitante, substituto, 3 dias úteis)', async () => {
      silence();
      const target = typeOf('NOTA_TECNICA');
      const events = api.outboxRows().length;

      const response = await patch(
        target.id,
        {
          requiresApproval: true,
          approvalPolicy: {
            approverType: 'DEPARTMENT_HEAD',
            approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
            allowDeputy: true,
            slaDays: 3,
            slaType: 'BUSINESS',
          },
        },
        '"1"',
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      expect(dataOf(response)).toMatchObject({
        code: 'NOTA_TECNICA',
        requiresApproval: true,
        version: 2,
        approvalPolicy: {
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
          allowDeputy: true,
          slaDays: 3,
          slaType: 'BUSINESS',
        },
      });
      const update = auditOf('document_type.update').at(-1);
      expect(update).toMatchObject({
        category: 'CONFIGURATION',
        metadata: { code: 'NOTA_TECNICA', isSystem: true, impact: { documentsCount: 0 } },
      });
      expect(
        ((update?.changes ?? []) as { path: string }[]).map((change) => change.path),
      ).toContain('approvalPolicy.slaDays');
      expect(api.outboxRows()).toHaveLength(events + 1);
      expect(api.outboxRows().at(-1)?.payload).toMatchObject({
        code: 'NOTA_TECNICA',
        changedFields: ['requiresApproval', 'approvalPolicy'],
      });
    });

    it('aprovador designado por usuário: vínculo ativo com APPROVAL_DECIDE (Lúcia)', async () => {
      silence();
      const target = typeOf('AUTORIZACAO');
      const response = await patch(
        target.id,
        {
          requiresApproval: true,
          approvalPolicy: { approverType: 'USER', approverUserId: LUCIA.id, allowDeputy: false },
        },
        '"1"',
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    });

    it('desativar tipo personalizado sem regra que o exija: documentos existentes continuam, some da lista padrão', async () => {
      silence();
      const created = await create(
        customBody({ code: 'PORTARIA_DESIGNACAO', name: 'Portaria de designação' }),
      );
      const target = dataOf(created) as DocumentTypeDto;
      DOCS_DO_TIPO_COM_USO.set(target.id, 4);

      const response = await patch(target.id, { isActive: false }, '"1"');

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(dataOf(response)).toMatchObject({ isActive: false, version: 2 });
      expect(auditOf('document_type.update').at(-1)?.metadata).toMatchObject({
        impact: { documentsCount: 4 },
      });
      const visible = await list(LUCIA, '', MFA);
      expect((dataOf(visible) as DocumentTypeDto[]).map((type) => type.code)).not.toContain(
        'PORTARIA_DESIGNACAO',
      );
      const admin = await list();
      expect((dataOf(admin) as DocumentTypeDto[]).map((type) => type.code)).toContain(
        'PORTARIA_DESIGNACAO',
      );

      const reactivated = await patch(target.id, { isActive: true }, '"2"');
      expect(reactivated.status).toBe(200);
      expect(dataOf(reactivated)).toMatchObject({ isActive: true, version: 3 });
    });

    it('patch sem alteração real não grava versão, auditoria nem evento', async () => {
      const target = typeOf('DESPACHO');
      const audits = auditOf('document_type.update').length;
      const events = api.outboxRows().length;
      const response = await patch(target.id, { sortOrder: 60 }, '"1"');
      expect(response.status).toBe(200);
      expect(dataOf(response)).toMatchObject({ version: 1 });
      expect(auditOf('document_type.update')).toHaveLength(audits);
      expect(api.outboxRows()).toHaveLength(events);
    });
  });

  describe('[Validação]', () => {
    it('código e campos restritos de tipo de sistema: NOT_ALLOWED', async () => {
      const oficio = typeOf('OFICIO');
      const code = expectProblem(
        await patch(oficio.id, { code: 'OFICIO_EXTERNO' }, '"1"'),
        422,
        'VALIDATION_ERROR',
      );
      expect(code.errors).toEqual([
        expect.objectContaining({ field: 'code', code: 'NOT_ALLOWED' }),
      ]);

      const dfd = typeOf('DFD');
      const inactive = expectProblem(
        await patch(dfd.id, { isActive: false }, '"1"'),
        422,
        'VALIDATION_ERROR',
      );
      expect(inactive.errors).toEqual([
        expect.objectContaining({ field: 'isActive', code: 'NOT_ALLOWED' }),
      ]);
      const kind = await patch(oficio.id, { kind: 'STRUCTURED' }, '"1"');
      expect(expectProblem(kind, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({ field: 'kind', code: 'NOT_ALLOWED' }),
      ]);
    });

    it('kind STRUCTURED na criação e formato do código', async () => {
      const structured = expectProblem(
        await create(customBody({ kind: 'STRUCTURED', code: 'NOVO_TIPO' })),
        422,
        'VALIDATION_ERROR',
      );
      expect(structured.errors).toEqual([
        expect.objectContaining({ field: 'kind', code: 'INVALID_ENUM' }),
      ]);
      const format = expectProblem(
        await create(customBody({ code: 'parecer-tecnico' })),
        422,
        'VALIDATION_ERROR',
      );
      expect(format.errors).toEqual([
        expect.objectContaining({ field: 'code', code: 'INVALID_FORMAT' }),
      ]);
    });

    it('política com unidade fixa sem titular: APPROVER_UNRESOLVED; aprovação sem política: CONDITIONAL_REQUIRED', async () => {
      const unresolved = await create(
        customBody({
          code: 'CERTIDAO_GABINETE',
          requiresApproval: true,
          approvalPolicy: {
            approverType: 'DEPARTMENT_HEAD',
            approverDepartmentResolution: 'FIXED',
            approverFixedDepartmentId: GABINETE,
            allowDeputy: true,
          },
        }),
      );
      expectProblem(unresolved, 422, 'APPROVER_UNRESOLVED');

      const missing = expectProblem(
        await create(customBody({ code: 'CERTIDAO_SEM_POLITICA', requiresApproval: true })),
        422,
        'VALIDATION_ERROR',
      );
      expect(missing.errors).toEqual([
        expect.objectContaining({ field: 'approvalPolicy', code: 'CONDITIONAL_REQUIRED' }),
      ]);

      const ok = await create(
        customBody({
          code: 'CERTIDAO_SECRETARIA',
          requiresApproval: true,
          approvalPolicy: {
            approverType: 'DEPARTMENT_HEAD',
            approverDepartmentResolution: 'FIXED',
            approverFixedDepartmentId: SECRETARIA_COM_TITULAR,
            allowDeputy: true,
          },
        }),
      );
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    });

    it('máscara de numeração inválida: NUMBERING_MASK_INVALID com o campo marcado', async () => {
      const problem = expectProblem(
        await create(customBody({ code: 'TIPO_MASCARA', numberingMask: 'PT {seq:3}' })),
        422,
        'NUMBERING_MASK_INVALID',
      );
      expect(problem.detail).toBe(
        'A máscara deve conter {seq:N} e {year} e usar apenas os campos permitidos.',
      );
      expect(problem.errors).toEqual([expect.objectContaining({ field: 'numberingMask' })]);
      const target = typeOf('DECLARACAO');
      expectProblem(
        await patch(target.id, { numberingMask: 'DECL {seq:3}/{ano}' }, '"1"'),
        422,
        'NUMBERING_MASK_INVALID',
      );
    });

    it('desativação bloqueada por regra REQUIRED_DOCUMENT BLOCKING de fluxo publicado: 409 citando fluxo e etapa', async () => {
      silence();
      const created = await create(
        customBody({ code: 'PARECER_EXIGIDO', name: 'Parecer exigido' }),
      );
      const target = dataOf(created) as DocumentTypeDto;
      api.app.get(DocumentTypeUsageRegistry, { strict: false }).register({
        usageOf: (_tx, code) =>
          Promise.resolve(
            code === 'PARECER_EXIGIDO'
              ? {
                  blockingRules: [
                    {
                      workflowName: 'Fase preparatória — Lei 14.133/2021',
                      stageName: 'Termo de Referência',
                    },
                  ],
                  referencingWorkflows: 1,
                }
              : { blockingRules: [], referencingWorkflows: 0 },
          ),
      });

      const response = await patch(target.id, { isActive: false }, '"1"');

      const problem = expectProblem(response, 409, 'CONFLICT');
      expect(problem.detail).toContain('Fase preparatória — Lei 14.133/2021');
      expect(problem.detail).toContain('Termo de Referência');
      const still = await list();
      expect(
        (dataOf(still) as DocumentTypeDto[]).find((type) => type.code === 'PARECER_EXIGIDO'),
      ).toMatchObject({ isActive: true, version: 1 });
      // Outras alterações do tipo seguem permitidas.
      expect((await patch(target.id, { name: 'Parecer exigido (v2)' }, '"1"')).status).toBe(200);
    });

    it('allowMultiplePerProcess com documentos existentes: NOT_ALLOWED (V-14)', async () => {
      const created = await create(customBody({ code: 'TIPO_COM_USO', name: 'Tipo com uso' }));
      const target = dataOf(created) as DocumentTypeDto;
      DOCS_DO_TIPO_COM_USO.set(target.id, 2);
      const problem = expectProblem(
        await patch(target.id, { allowMultiplePerProcess: false }, '"1"'),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'allowMultiplePerProcess', code: 'NOT_ALLOWED' }),
      ]);
    });

    it('patch vazio é uma alteração nula e prazo fora de 1–365 é recusado', async () => {
      const target = typeOf('DESPACHO');
      const empty = await patch(target.id, {}, '"1"');
      expect(empty.status).toBe(200);
      expect(dataOf(empty)).toMatchObject({ version: 1 });
      const sla = expectProblem(
        await patch(
          target.id,
          {
            requiresApproval: true,
            approvalPolicy: {
              approverType: 'USER',
              approverUserId: LUCIA.id,
              allowDeputy: true,
              slaDays: 400,
            },
          },
          '"1"',
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(sla.errors).toEqual([
        expect.objectContaining({ field: 'approvalPolicy.slaDays', code: 'OUT_OF_RANGE' }),
      ]);
    });
  });

  describe('[Permissão]', () => {
    it('usuário sem DOCUMENT_TYPE_MANAGE: 403 PERMISSION_DENIED e access.denied com o motivo', async () => {
      silence();
      const denials = auditOf('access.denied').length;

      const response = await create(customBody({ code: 'PROIBIDO' }), { user: LUCIA });

      expectProblem(response, 403, 'PERMISSION_DENIED');
      const records = auditOf('access.denied');
      expect(records).toHaveLength(denials + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        actorUserId: LUCIA.id,
        reasonCode: 'DOCUMENT_TYPE_MANAGE',
        result: 'DENIED',
      });
      expect(repository.snapshot().some((type) => type.code === 'PROIBIDO')).toBe(false);
    });

    it('DTY-01 padrão é capacidade implícita; includeInactive exige a permissão', async () => {
      silence();
      const open = await list(LUCIA, '');
      expect(open.status).toBe(200);
      expect((dataOf(open) as DocumentTypeDto[]).every((type) => type.isActive)).toBe(true);
      expectProblem(await list(LUCIA, 'includeInactive=true'), 403, 'PERMISSION_DENIED');
    });

    it('PATCH e prévia seguem a mesma regra; sem permissão nada é gravado', async () => {
      silence();
      const target = typeOf('OFICIO');
      expectProblem(
        await patch(target.id, { name: 'Ofício' }, '"1"', { user: LUCIA }),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('administradora sem MFA na sessão: 403 MFA_REQUIRED e nada persistido', async () => {
      silence();
      const target = typeOf('OFICIO');
      const audits = auditOf('document_type.update').length;
      const events = api.outboxRows().length;

      const response = await patch(target.id, { name: 'Ofício sem MFA' }, '"1"', { amr: ['pwd'] });

      expectProblem(response, 403, 'MFA_REQUIRED');
      expect(repository.snapshot().find((type) => type.id === target.id)).toMatchObject({
        name: 'Ofício',
        version: 1,
      });
      expect(auditOf('document_type.update')).toHaveLength(audits);
      expect(api.outboxRows()).toHaveLength(events);
      expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'MFA_REQUIRED' });
      expectProblem(
        await create(customBody({ code: 'SEM_MFA' }), { amr: ['pwd'] }),
        403,
        'MFA_REQUIRED',
      );
    });
  });

  describe('[Tenant incorreto]', () => {
    it('tipo de outro tenant: 404 NOT_FOUND (indistinguível de inexistente)', async () => {
      const other = typeOf('OFICIO', B);
      expectProblem(await patch(other.id, { name: 'Ofício da B' }, '"1"'), 404, 'NOT_FOUND');
      expectProblem(await patch(newId(), { name: 'Inexistente' }, '"1"'), 404, 'NOT_FOUND');
      expect(repository.snapshot().find((type) => type.id === other.id)?.name).toBe('Ofício');
    });

    it('aprovador de outro tenant: 422 REFERENCE_NOT_FOUND em approvalPolicy.approverUserId', async () => {
      const target = typeOf('DECLARACAO');
      const problem = expectProblem(
        await patch(
          target.id,
          {
            requiresApproval: true,
            approvalPolicy: {
              approverType: 'USER',
              approverUserId: FAKE_USERS.heitor.id,
              allowDeputy: true,
            },
          },
          '"1"',
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({
          field: 'approvalPolicy.approverUserId',
          code: 'REFERENCE_NOT_FOUND',
        }),
      ]);
    });

    it('aprovador inativo ou sem APPROVAL_DECIDE: 422 REFERENCE_INACTIVE; perfil e unidade inexistentes: REFERENCE_NOT_FOUND', async () => {
      const target = typeOf('DECLARACAO');
      const attempt = (approvalPolicy: Record<string, unknown>) =>
        patch(target.id, { requiresApproval: true, approvalPolicy }, '"1"');
      const suspended = expectProblem(
        await attempt({
          approverType: 'USER',
          approverUserId: FAKE_USERS.bruno.id,
          allowDeputy: true,
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(suspended.errors[0]).toMatchObject({ code: 'REFERENCE_INACTIVE' });
      const noPermission = expectProblem(
        await attempt({ approverType: 'USER', approverUserId: MARTA.id, allowDeputy: true }),
        422,
        'VALIDATION_ERROR',
      );
      expect(noPermission.errors[0]).toMatchObject({ code: 'REFERENCE_INACTIVE' });
      const role = expectProblem(
        await attempt({ approverType: 'ROLE', approverRoleId: newId(), allowDeputy: true }),
        422,
        'VALIDATION_ERROR',
      );
      expect(role.errors[0]).toMatchObject({
        field: 'approvalPolicy.approverRoleId',
        code: 'REFERENCE_NOT_FOUND',
      });
      const department = expectProblem(
        await attempt({
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentResolution: 'FIXED',
          approverFixedDepartmentId: newId(),
          allowDeputy: true,
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(department.errors[0]).toMatchObject({
        field: 'approvalPolicy.approverFixedDepartmentId',
        code: 'REFERENCE_NOT_FOUND',
      });
    });

    it('a lista de cada tenant mostra só os seus tipos', async () => {
      const [a, b] = await Promise.all([list(), list(MARTA, 'includeInactive=true')]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const crossTenant = await withAuth(
        request(api.server).get('/api/v1/document-types?includeInactive=true'),
        MARTA,
        { tenant: B },
      );
      // Marta não tem vínculo na Prefeitura B.
      expectProblem(crossTenant, 403, 'MEMBERSHIP_INACTIVE');
    });
  });

  describe('[Duplicidade]', () => {
    it('código repetido: 409 CONFLICT; reenvio com a mesma Idempotency-Key reproduz a resposta', async () => {
      silence();
      const key = randomUUID();
      const first = await create(
        customBody({ code: 'CERTIDAO_NEGATIVA', name: 'Certidão negativa' }),
        { key },
      );
      expect(first.status).toBe(201);

      const duplicate = expectProblem(
        await create(customBody({ code: 'CERTIDAO_NEGATIVA', name: 'Outra certidão' })),
        409,
        'CONFLICT',
      );
      expect(duplicate.detail).toBe('Já existe um tipo com o código CERTIDAO_NEGATIVA.');

      const events = api.outboxRows().length;
      const replay = await create(
        customBody({ code: 'CERTIDAO_NEGATIVA', name: 'Certidão negativa' }),
        { key },
      );
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(dataOf(replay)).toEqual(dataOf(first));
      expect(api.outboxRows()).toHaveLength(events);
      expect(repository.snapshot().filter((t) => t.code === 'CERTIDAO_NEGATIVA')).toHaveLength(1);
    });

    it('criação concorrente do mesmo código: uma 201 e outra 409', async () => {
      silence();
      const body = customBody({ code: 'TIPO_CONCORRENTE', name: 'Tipo concorrente' });
      const [one, two] = await Promise.all([create(body), create(body)]);
      expect([one.status, two.status].sort()).toEqual([201, 409]);
    });

    it('chave de idempotência reutilizada com outro corpo: 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const key = randomUUID();
      expect(
        (await create(customBody({ code: 'TIPO_CHAVE', name: 'Tipo chave' }), { key })).status,
      ).toBe(201);
      expectProblem(
        await create(customBody({ code: 'TIPO_CHAVE_2', name: 'Tipo chave 2' }), { key }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });
  });

  describe('[Concorrência]', () => {
    it('edições simultâneas: versão desatualizada → 412 VERSION_CONFLICT; If-Match ausente → 428', async () => {
      silence();
      const target = typeOf('AUTORIZACAO');
      const current = repository.snapshot().find((type) => type.id === target.id);
      const version = current?.version ?? 1;

      const otavio = await patch(target.id, { name: 'Autorização (Otávio)' }, `"${version}"`, {
        user: OTAVIO,
      });
      expect(otavio.status).toBe(200);
      expect(otavio.headers.etag).toBe(`"${version + 1}"`);

      const marta = await patch(
        target.id,
        { numberingMask: 'AUTZ {seq:4}/{year}' },
        `"${version}"`,
      );
      expectProblem(marta, 412, 'VERSION_CONFLICT');
      expectProblem(
        await patch(target.id, { name: 'Sem If-Match' }, null),
        428,
        'PRECONDITION_REQUIRED',
      );
      expect(repository.snapshot().find((type) => type.id === target.id)?.numberingMask).toBe(
        'AUT {seq:4}/{year}',
      );
    });

    it('duas edições com o mesmo If-Match disparadas juntas: uma 200 e outra 412', async () => {
      silence();
      const target = typeOf('AUTORIZACAO');
      const version = repository.snapshot().find((type) => type.id === target.id)?.version ?? 1;
      const [one, two] = await Promise.all([
        patch(target.id, { sortOrder: 91 }, `"${version}"`),
        patch(target.id, { sortOrder: 92 }, `"${version}"`, { user: OTAVIO }),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 412]);
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível ao salvar: 503 DEPENDENCY_UNAVAILABLE com Retry-After e nada persistido', async () => {
      silence();
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
          .post('/api/v1/document-types')
          .set('Authorization', down.bearer(MARTA.subject, { amr: MFA }))
          .set('X-Tenant-Id', A)
          .set('Idempotency-Key', randomUUID())
          .send(customBody({ code: 'SEM_BANCO' }));
        expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
        expect(response.headers['retry-after']).toBe('5');
        expect(down.auditRecords()).toHaveLength(audits);
        const events = down.outboxRows();
        expect(events).toHaveLength(0);
      } finally {
        await down.close();
      }
    });
  });

  describe('[Falha de integração]', () => {
    it('Redis indisponível na invalidação: alteração persistida (200), evento no outbox e o cache expira pelo TTL', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const target = typeOf('OFICIO');
      const version = repository.snapshot().find((type) => type.id === target.id)?.version ?? 1;
      // Aquece o cache com o nome atual.
      await list();
      const events = api.outboxRows().length;
      vi.spyOn(cache, 'delete').mockRejectedValue(new Error('redis indisponível'));

      const response = await patch(target.id, { name: 'Ofício externo' }, `"${version}"`);

      expect(response.status).toBe(200);
      expect(dataOf(response)).toMatchObject({ name: 'Ofício externo' });
      expect(api.outboxRows()).toHaveLength(events + 1);
      expect(api.outboxRows().at(-1)).toMatchObject({ eventType: 'DocumentTypeChanged' });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'document_type.cache_invalidation_failed' }),
        'document_type.cache_invalidation_failed',
      );
      // Sem a invalidação, a lista em cache ainda traz o nome antigo até o TTL de 10 min…
      const stale = await list();
      expect(
        (dataOf(stale) as DocumentTypeDto[]).find((type) => type.code === 'OFICIO')?.name,
      ).toBe('Ofício');
      const key = [...cache.entries.keys()].find((entry) => entry.endsWith(`${A}:document:types`));
      expect(key).toBeDefined();
      const ttlSeconds = ((cache.entries.get(key ?? '')?.expiresAt ?? 0) - Date.now()) / 1000;
      expect(ttlSeconds).toBeGreaterThan(590);
      expect(ttlSeconds).toBeLessThanOrEqual(600);
      // …e reflete o novo nome quando o evento chega ao worker (DEL da chave) ou o TTL vence.
      cache.entries.delete(key ?? '');
      const fresh = await list();
      expect(
        (dataOf(fresh) as DocumentTypeDto[]).find((type) => type.code === 'OFICIO')?.name,
      ).toBe('Ofício externo');
    });

    it('cache fora do ar na leitura: a lista vem do banco (CA-T-07)', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(cache, 'get').mockRejectedValue(new Error('redis indisponível'));
      const response = await list();
      expect(response.status).toBe(200);
      expect((dataOf(response) as DocumentTypeDto[]).length).toBeGreaterThan(11);
    });
  });
});
