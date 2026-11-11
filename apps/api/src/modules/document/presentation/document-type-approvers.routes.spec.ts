import { randomUUID } from 'node:crypto';

import { documentTypeSchema, problemDetailsSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { newId } from '#shared/database/ids.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import type { RoleForApproval } from '../../access/application/access.facade.js';
import { DOCUMENT_CLOCK, DOCUMENT_COUNTER } from '../application/ports.js';
import { buildSystemDocumentTypes } from '../domain/system-document-types.js';
import { InMemoryDocumentTypeRepository } from '../infrastructure/in-memory-document-type.repository.js';

/*
 * US-132 (RN-APV-11 · FA-06 · V-14) — política de decisão e aprovadores ordenados na
 * `approvalPolicy` do tipo de documento (DTY-01/02/03, SCR-108) pelo pipeline HTTP completo:
 * `ALL` com usuário e perfil, espelho da linha 1, mínimo de duas linhas no salvamento
 * (`DOCUMENT_APPROVAL_POLICY_INVALID`), unicidade, referência de outro tenant, no-op e a política
 * do MVP 1 devolvida com `decisionPolicy = ANY` e `approvers = []` (aditivo). "Carla" = Marta
 * (ADMIN_ORGAO); "Marcos" = Lúcia (vínculo ativo com `APPROVAL_DECIDE`).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MARTA = FAKE_USERS.marta;
const MARCOS = FAKE_USERS.lucia.id;
const HEITOR = FAKE_USERS.heitor.id;
const MFA = ['pwd', 'otp'];
const NOW = new Date('2026-11-11T12:00:00.000Z');
const AUTORIDADE_COMPETENTE = newId();

const roles = new Map<string, RoleForApproval>([
  [AUTORIDADE_COMPETENTE, { id: AUTORIDADE_COMPETENTE, isActive: true, canDecideApprovals: true }],
]);

function dataOf(response: request.Response) {
  return documentTypeSchema.parse((response.body as { data: unknown }).data);
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Política de decisão e aprovadores no tipo de documento (US-132)', () => {
  let api: TestApi;
  let repository: InMemoryDocumentTypeRepository;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(AccessFacade.prototype, 'findRoleForApproval').mockImplementation((_tx, id) =>
      Promise.resolve(roles.get(id) ?? null),
    );
    api = await createTestApi({
      providers: [
        { token: DOCUMENT_COUNTER, value: { countByType: () => Promise.resolve(0) } },
        { token: DOCUMENT_CLOCK, value: () => NOW },
      ],
    });
    repository = api.app.get(InMemoryDocumentTypeRepository, { strict: false });
    await repository.insertMissing({} as never, buildSystemDocumentTypes(A, NOW, newId));
    await repository.insertMissing({} as never, buildSystemDocumentTypes(B, NOW, newId));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
  });

  const withAuth = (test: request.Test) =>
    test.set('Authorization', api.bearer(MARTA.subject, { amr: MFA })).set('X-Tenant-Id', A);
  const patch = (id: string, body: Record<string, unknown>, ifMatch: number) =>
    withAuth(request(api.server).patch(`/api/v1/document-types/${id}`))
      .set('If-Match', `"${String(ifMatch)}"`)
      .send(body);
  const create = (body: Record<string, unknown>) =>
    withAuth(request(api.server).post('/api/v1/document-types'))
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const typeOf = (code: string) => {
    const type = repository.snapshot().find((row) => row.code === code && row.tenantId === A);
    if (!type) throw new Error(`tipo ${code} inexistente`);
    return type;
  };
  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);

  const marcos = { approverType: 'USER', approverUserId: MARCOS };
  const autoridade = { approverType: 'ROLE', approverRoleId: AUTORIDADE_COMPETENTE };

  it('[Sucesso] ALL em NOTA_TECNICA com Marcos e o perfil AUTORIDADE_COMPETENTE: 200, duas linhas e auditoria', async () => {
    const target = typeOf('NOTA_TECNICA');
    const events = api.outboxRows().length;
    const response = await patch(
      target.id,
      {
        requiresApproval: true,
        approvalPolicy: {
          decisionPolicy: 'ALL',
          approvers: [marcos, { ...autoridade, label: 'Autoridade competente' }],
          // O aprovador único enviado é sobrescrito pelo espelho da linha 1 (RN-APV-11).
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
          allowDeputy: true,
          slaDays: 3,
        },
      },
      target.version,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(dataOf(response).approvalPolicy).toEqual({
      decisionPolicy: 'ALL',
      approvers: [
        { approverType: 'USER', approverUserId: MARCOS, allowDeputy: true },
        {
          approverType: 'ROLE',
          approverRoleId: AUTORIDADE_COMPETENTE,
          allowDeputy: true,
          label: 'Autoridade competente',
        },
      ],
      approverType: 'USER',
      approverUserId: MARCOS,
      allowDeputy: true,
      slaDays: 3,
      slaType: 'BUSINESS',
    });
    const audit = auditOf('document_type.update').at(-1);
    expect(audit).toMatchObject({ metadata: { code: 'NOTA_TECNICA', isSystem: true } });
    const paths = ((audit?.changes ?? []) as { path: string }[]).map((change) => change.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'approvalPolicy.decisionPolicy',
        'approvalPolicy.approvers',
        'approvalPolicy.approverType',
      ]),
    );
    // Só `DocumentTypeChanged`: nenhuma aprovação existente é tocada (RN-APV-12).
    expect(
      api
        .outboxRows()
        .slice(events)
        .map((row) => row.eventType),
    ).toEqual(['DocumentTypeChanged']);
  });

  it('[Duplicidade] reenviar a mesma política é no-op (sem versão nova nem auditoria)', async () => {
    const target = typeOf('NOTA_TECNICA');
    const audits = auditOf('document_type.update').length;
    const response = await patch(
      target.id,
      {
        approvalPolicy: {
          decisionPolicy: 'ALL',
          approvers: [marcos, { ...autoridade, label: 'Autoridade competente' }],
          approverType: 'USER',
          approverUserId: MARCOS,
          allowDeputy: true,
          slaDays: 3,
          slaType: 'BUSINESS',
        },
      },
      target.version,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers.etag).toBe(`"${String(target.version)}"`);
    expect(auditOf('document_type.update')).toHaveLength(audits);
  });

  it('[Validação] V-14: SEQUENTIAL com uma linha → 422 DOCUMENT_APPROVAL_POLICY_INVALID', async () => {
    const target = typeOf('OFICIO');
    const response = await patch(
      target.id,
      {
        requiresApproval: true,
        approvalPolicy: {
          decisionPolicy: 'SEQUENTIAL',
          approvers: [marcos],
          approverType: 'USER',
          allowDeputy: false,
        },
      },
      target.version,
    );
    const problem = expectProblem(response, 422, 'DOCUMENT_APPROVAL_POLICY_INVALID');
    expect(problem.errors).toEqual([
      {
        field: 'approvalPolicy.approvers',
        code: 'CONDITIONAL_REQUIRED',
        message: 'Informe ao menos dois aprovadores para esta política.',
      },
    ]);
    expect(typeOf('OFICIO').version).toBe(target.version);
  });

  it('[Validação] aprovador repetido → DUPLICATE_IN_LIST; usuário de outro tenant → REFERENCE_NOT_FOUND na linha', async () => {
    const target = typeOf('OFICIO');
    const duplicated = await patch(
      target.id,
      {
        requiresApproval: true,
        approvalPolicy: {
          decisionPolicy: 'ALL',
          approvers: [marcos, marcos],
          approverType: 'USER',
          allowDeputy: false,
        },
      },
      target.version,
    );
    expect(expectProblem(duplicated, 422, 'VALIDATION_ERROR').errors).toContainEqual(
      expect.objectContaining({ field: 'approvalPolicy.approvers[1]', code: 'DUPLICATE_IN_LIST' }),
    );
    const foreign = await patch(
      target.id,
      {
        requiresApproval: true,
        approvalPolicy: {
          decisionPolicy: 'ALL',
          approvers: [{ approverType: 'USER', approverUserId: HEITOR }, autoridade],
          approverType: 'USER',
          allowDeputy: false,
        },
      },
      target.version,
    );
    expect(expectProblem(foreign, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({
        field: 'approvalPolicy.approvers[0].approverUserId',
        code: 'REFERENCE_NOT_FOUND',
      }),
    ]);
  });

  it('[Sucesso] DTY-02 com SEQUENTIAL e duas linhas; DTY-01 devolve ANY e [] para as políticas do MVP 1', async () => {
    const created = await create({
      kind: 'FREE_TEXT',
      code: 'PARECER_REFERENCIAL',
      name: 'Parecer referencial',
      allowMultiplePerProcess: true,
      numberingEnabled: false,
      requiresApproval: true,
      defaultConfidentiality: 'INTERNAL',
      approvalPolicy: {
        decisionPolicy: 'SEQUENTIAL',
        approvers: [autoridade, marcos],
        approverType: 'ROLE',
        approverRoleId: AUTORIDADE_COMPETENTE,
        allowDeputy: false,
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(dataOf(created).approvalPolicy).toMatchObject({
      decisionPolicy: 'SEQUENTIAL',
      approvers: [
        { approverType: 'ROLE', approverRoleId: AUTORIDADE_COMPETENTE },
        { approverType: 'USER', approverUserId: MARCOS },
      ],
      approverType: 'ROLE',
    });

    const target = typeOf('AUTORIZACAO');
    const single = await patch(
      target.id,
      {
        requiresApproval: true,
        approvalPolicy: {
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
          allowDeputy: true,
        },
      },
      target.version,
    );
    expect(single.status, JSON.stringify(single.body)).toBe(200);
    // Gravada sem as chaves novas (política do MVP 1 idêntica); a resposta traz o padrão.
    expect(typeOf('AUTORIZACAO').approvalPolicy).not.toHaveProperty('decisionPolicy');
    const list = await withAuth(request(api.server).get('/api/v1/document-types'));
    expect(list.status).toBe(200);
    const autorizacao = (
      list.body as { data: { code: string; approvalPolicy: unknown }[] }
    ).data.find((type) => type.code === 'AUTORIZACAO');
    expect(autorizacao?.approvalPolicy).toMatchObject({ decisionPolicy: 'ANY', approvers: [] });
  });

  it('[Sucesso] FA-06: desligar a aprovação mantém a política só para auditoria', async () => {
    const target = typeOf('NOTA_TECNICA');
    const response = await patch(target.id, { requiresApproval: false }, target.version);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(dataOf(response)).toMatchObject({
      requiresApproval: false,
      approvalPolicy: { decisionPolicy: 'ALL' },
    });
  });
});
