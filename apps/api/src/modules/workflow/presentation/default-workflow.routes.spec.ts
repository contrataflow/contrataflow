import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { WorkflowDto, WorkflowResolutionDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runAsSystem } from '#shared/context/request-context.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { TenantSeederRegistry } from '#shared/tenancy/tenant-seeding.js';
import type { TenantSeedResult } from '#shared/tenancy/tenant-seeding.js';
import { FAKE_TENANTS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { WORKFLOW_TRANSACTIONS } from '../application/ports.js';
import type { WorkflowTransactions } from '../application/ports.js';
import {
  InMemoryWorkflowRepository,
  InMemoryWorkflowTransactions,
} from '../infrastructure/in-memory-workflow.repository.js';

/*
 * US-042 — seeder `workflow.seedWorkflows`, WF-01 (lista), WF-05 (tornar padrão) e WF-06 (resolver)
 * pelo pipeline HTTP completo com a identidade fake, os seeders reais de catálogo, perfis e tipos de
 * documento, a auditoria e o outbox em memória. Concorrência real (travas), RLS e o outbox
 * `PENDING` no PostgreSQL: `test/tenant-leak/default-workflows.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MFA = ['pwd', 'otp'];
const PREREQUISITES = ['catalog.items', 'access.defaultRoles', 'document.systemTypes'];
const DEFAULT_NAME = 'Fase preparatória — Lei 14.133/2021';
const DIRECT_NAME = 'Contratação direta — Lei 14.133/2021, art. 72';

type User = 'sub-marta' | 'sub-otavio' | 'sub-fabio' | 'sub-heitor';

/** Transações em memória que podem simular o banco fora do ar (Falha de banco). */
class FlakyTransactions implements WorkflowTransactions {
  down = false;
  private readonly inner = new InMemoryWorkflowTransactions();

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return this.inner.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return this.inner.read(work);
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

describe('Feature: Workflow padrão e seleção por aplicabilidade (US-042)', () => {
  let api: TestApi;
  let repository: InMemoryWorkflowRepository;
  const transactions = new FlakyTransactions();

  const seedStep = (tenantId: string, key: string): Promise<TenantSeedResult> => {
    const seeder = api.app
      .get(TenantSeederRegistry)
      .all()
      .find((candidate) => candidate.key === key);
    if (!seeder) throw new Error(`Seeder ${key} não registrado.`);
    return runAsSystem({ name: 'Provisionamento de tenant', tenantId }, () =>
      seeder.seed({ tenantId, slug: 'teste', now: new Date(), request: null }),
    );
  };
  /** CAT-01 do tenant (o spec de `workflow` não importa o `catalog` — DEC-041). */
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const response = await request(api.server)
      .get(`/api/v1/catalogs/${type}/items`)
      .query({ q: code, pageSize: 100 })
      .set('Authorization', api.bearer(tenantId === B ? 'sub-heitor' : 'sub-marta', { amr: MFA }))
      .set('X-Tenant-Id', tenantId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const item = (response.body as { data: { id: string; code: string }[] }).data.find(
      (candidate) => candidate.code === code,
    );
    if (!item) throw new Error(`${type}/${code} ausente`);
    return item.id;
  };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [{ token: WORKFLOW_TRANSACTIONS, value: transactions }],
    });
    repository = api.app.get(InMemoryWorkflowRepository, { strict: false });
    // Background: tenants em provisionamento com o catálogo MODALITY (DISPENSA/INEXIGIBILIDADE).
    for (const tenantId of [A, B]) {
      for (const key of PREREQUISITES) await seedStep(tenantId, key);
    }
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
  });

  const as = (test: request.Test, user: User, amr: readonly string[] = MFA) =>
    test
      .set('Authorization', api.bearer(user, { amr }))
      .set('X-Tenant-Id', user === 'sub-heitor' ? B : A);
  const list = (user: User = 'sub-marta') =>
    as(request(api.server).get('/api/v1/workflows?pageSize=100'), user);
  const setDefault = (
    id: string,
    ifMatch: number | null,
    user: User = 'sub-marta',
    amr: readonly string[] = MFA,
  ) => {
    const test = as(request(api.server).post(`/api/v1/workflows/${id}/set-default`), user, amr);
    return ifMatch === null ? test : test.set('If-Match', `"${ifMatch}"`);
  };
  const resolve = (body: object, user: User = 'sub-marta') =>
    as(request(api.server).post('/api/v1/workflows/resolve'), user).send(body);

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const eventsOf = (type: string) => api.outboxRows().filter((row) => row.eventType === type);
  const workflowsOf = async (user: User = 'sub-marta') => {
    const response = await list(user);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return data<WorkflowDto[]>(response);
  };
  const byName = async (name: string, user: User = 'sub-marta') => {
    const found = (await workflowsOf(user)).find((workflow) => workflow.name === name);
    if (!found) throw new Error(`workflow ${name} ausente`);
    return found;
  };
  const defaultsOf = async (user: User = 'sub-marta') =>
    (await workflowsOf(user)).filter((workflow) => workflow.isDefault).map((w) => w.name);
  const processBody = async (tenantId: string, modality: string | null) => ({
    contractingTypeId: await catalogId(tenantId, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
    modalityId: modality ? await catalogId(tenantId, 'MODALITY', modality) : null,
    originId: await catalogId(tenantId, 'PROCESS_ORIGIN', 'PCA'),
    estimatedValue: '15000.00',
    organizationId: '0192a000-0000-7000-8000-00000000f001',
    isPriceRegistration: false,
  });

  it('[Validação] Sem workflow publicado nem padrão, a resolução responde 422 NO_APPLICABLE_WORKFLOW', async () => {
    const response = await resolve(await processBody(B, 'PREGAO'), 'sub-heitor');
    const problem = expectProblem(response, 422, 'NO_APPLICABLE_WORKFLOW');
    expect(problem.detail).toBe('Não há fluxo configurado para este tipo de contratação.');
  });

  it('[Sucesso] Provisionamento semeia os dois workflows publicados, um padrão, com definitionHash', async () => {
    const audits = auditOf('workflow.version_publish').length;

    expect(await seedStep(A, 'workflow.seedWorkflows')).toEqual({ created: 2, skipped: 0 });
    expect(await seedStep(B, 'workflow.seedWorkflows')).toEqual({ created: 2, skipped: 0 });

    const workflows = await workflowsOf();
    // WF-01 na ordem da aplicabilidade: a direta (50) antes do padrão (100).
    expect(
      workflows.map((w) => [w.name, w.isDefault, w.applicabilityPriority, w.isActive]),
    ).toEqual([
      [DIRECT_NAME, false, 50, true],
      [DEFAULT_NAME, true, 100, true],
    ]);
    for (const workflow of workflows) {
      expect(workflow.currentPublishedVersion).toMatchObject({ versionNumber: 1 });
      expect(workflow.draftVersion).toBeNull();
      const version = repository.versions.get(workflow.currentPublishedVersion?.id ?? '');
      expect(version).toMatchObject({ status: 'PUBLISHED', versionNumber: 1 });
      expect(version?.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(workflows[0]?.applicabilityRule).toEqual({
      in: [{ var: 'process.modalityCode' }, ['DISPENSA', 'INEXIGIBILIDADE']],
    });
    // Ator SYSTEM; carga inicial não emite WorkflowDefaultChanged (RN-WF-36).
    expect(auditOf('workflow.version_publish').length).toBe(audits + 4);
    expect(auditOf('workflow.create').at(-1)).toMatchObject({
      actorType: 'SYSTEM',
      metadata: expect.objectContaining({ seeded: true }) as unknown,
    });
    expect(eventsOf('WorkflowDefaultChanged')).toHaveLength(0);
    expect(eventsOf('WorkflowVersionPublished').length).toBeGreaterThanOrEqual(4);

    const seeder = api.app
      .get(TenantSeederRegistry)
      .all()
      .find((candidate) => candidate.key === 'workflow.seedWorkflows');
    const status = await runAsSystem({ name: 'checklist', tenantId: A }, () =>
      seeder?.verify({ tenantId: A, slug: 'teste', now: new Date(), request: null }),
    );
    expect(status).toEqual({ status: 'DONE', details: { workflows: 2 } });
  });

  it('[Sucesso] Processo de DISPENSA resolve para a contratação direta, com etapa inicial ABERTURA', async () => {
    const direct = await byName(DIRECT_NAME);

    const response = await resolve(await processBody(A, 'DISPENSA'));

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(data<WorkflowResolutionDto>(response)).toEqual({
      workflowId: direct.id,
      workflowVersionId: direct.currentPublishedVersion?.id,
      name: DIRECT_NAME,
      versionNumber: 1,
      initialStage: expect.objectContaining({
        key: 'ABERTURA',
        name: 'Formalização da demanda',
      }) as unknown,
    });
    const inexigibilidade = await resolve(await processBody(A, 'INEXIGIBILIDADE'));
    expect(data<WorkflowResolutionDto>(inexigibilidade).workflowId).toBe(direct.id);
  });

  it('[Sucesso] Pregão e modalidade "A definir" (FA-04) resolvem para o padrão; quem só tem WORKFLOW_VIEW resolve', async () => {
    const standard = await byName(DEFAULT_NAME);
    for (const modality of ['PREGAO', null]) {
      const response = await resolve(await processBody(A, modality), 'sub-fabio');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<WorkflowResolutionDto>(response)).toMatchObject({
        workflowId: standard.id,
        initialStage: { key: 'ABERTURA' },
      });
    }
  });

  it('[Validação] Item de catálogo de outro tipo ou de outro tenant → 422 VALIDATION_ERROR', async () => {
    const body = await processBody(A, 'DISPENSA');
    const wrongType = await resolve({ ...body, modalityId: body.originId });
    expect(expectProblem(wrongType, 422, 'VALIDATION_ERROR').errors).toEqual([
      expect.objectContaining({ field: 'modalityId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    const foreign = await resolve({
      ...body,
      modalityId: await catalogId(B, 'MODALITY', 'DISPENSA'),
    });
    expectProblem(foreign, 422, 'VALIDATION_ERROR');
  });

  it('[Validação] Tornar padrão um workflow sem versão publicada → 422 BUSINESS_RULE_VIOLATION', async () => {
    const created = await as(request(api.server).post('/api/v1/workflows'), 'sub-marta')
      .set('Idempotency-Key', randomUUID())
      .send({ key: 'PILOTO_OBRAS', name: 'Piloto de obras' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const piloto = data<WorkflowDto>(created);

    const response = await setDefault(piloto.id, piloto.version);

    const problem = expectProblem(response, 422, 'BUSINESS_RULE_VIOLATION');
    expect(problem.violations).toEqual([
      expect.objectContaining({
        code: 'WORKFLOW_NOT_PUBLISHED',
        message: 'Publique uma versão e ative o workflow antes de torná-lo padrão.',
      }),
    ]);
    expect((await byName('Piloto de obras')).isDefault).toBe(false);
    expect(await defaultsOf()).toEqual([DEFAULT_NAME]);
  });

  it('[Permissão] Usuário só com WORKFLOW_VIEW → 403 PERMISSION_DENIED e o padrão não muda', async () => {
    const direct = await byName(DIRECT_NAME, 'sub-fabio');

    const response = await setDefault(direct.id, direct.version, 'sub-fabio');

    expectProblem(response, 403, 'PERMISSION_DENIED');
    expect(await defaultsOf()).toEqual([DEFAULT_NAME]);
    expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'WORKFLOW_PUBLISH' });
    // WORKFLOW_PUBLISH é risco H: sem segundo fator → MFA_REQUIRED (POL-14).
    const noMfa = await setDefault(direct.id, direct.version, 'sub-marta', ['pwd']);
    expectProblem(noMfa, 403, 'MFA_REQUIRED');
  });

  it('[Validação] If-Match ausente → 428 PRECONDITION_REQUIRED', async () => {
    const direct = await byName(DIRECT_NAME);
    expectProblem(await setDefault(direct.id, null), 428, 'PRECONDITION_REQUIRED');
  });

  it('[Tenant incorreto] A resolução e a troca nunca usam workflows de outro tenant', async () => {
    const ofB = await workflowsOf('sub-heitor');
    const idsOfB = new Set(ofB.map((workflow) => workflow.id));
    const ofA = await workflowsOf();
    expect(ofA.some((workflow) => idsOfB.has(workflow.id))).toBe(false);

    for (const modality of ['DISPENSA', 'PREGAO']) {
      const response = await resolve(await processBody(A, modality));
      const resolved = data<WorkflowResolutionDto>(response);
      expect(idsOfB.has(resolved.workflowId)).toBe(false);
      expect(ofA.map((workflow) => workflow.id)).toContain(resolved.workflowId);
    }
    const directOfB = ofB.find((workflow) => workflow.name === DIRECT_NAME);
    const foreign = await setDefault(directOfB?.id ?? '', directOfB?.version ?? 0);
    expectProblem(foreign, 404, 'NOT_FOUND');
    expect(await defaultsOf('sub-heitor')).toEqual([DEFAULT_NAME]);
  });

  it('[Duplicidade] Reexecução do seeder não duplica nem sobrescreve os workflows', async () => {
    const before = await workflowsOf();

    expect(await seedStep(A, 'workflow.seedWorkflows')).toEqual({ created: 0, skipped: 2 });

    const after = await workflowsOf();
    expect(after).toEqual(before);
    const keys = [...repository.workflows.values()]
      .filter((workflow) => workflow.tenantId === A)
      .map((workflow) => workflow.key);
    expect(keys.filter((key) => key === 'DEFAULT_PREPARATORY')).toHaveLength(1);
    expect(keys.filter((key) => key === 'DIRECT_CONTRACTING_ART72')).toHaveLength(1);
  });

  it('[Sucesso] Tornar padrão troca o selo, audita workflow.set_default e grava WorkflowDefaultChanged', async () => {
    const standard = await byName(DEFAULT_NAME);
    const direct = await byName(DIRECT_NAME);

    const response = await setDefault(direct.id, direct.version);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const updated = data<WorkflowDto>(response);
    expect(updated).toMatchObject({ id: direct.id, isDefault: true, version: direct.version + 1 });
    expect(response.headers.etag).toBe(`"${updated.version}"`);
    expect(await defaultsOf()).toEqual([DIRECT_NAME]);
    expect((await byName(DEFAULT_NAME)).version).toBe(standard.version + 1);
    expect(auditOf('workflow.set_default').at(-1)).toMatchObject({
      entityId: direct.id,
      changes: [
        { path: 'previousWorkflow.isDefault', old: true, new: false },
        { path: 'isDefault', old: false, new: true },
      ],
      metadata: expect.objectContaining({ previousWorkflowId: standard.id }) as unknown,
    });
    // [Falha de integração] o relay não roda aqui: o evento fica no outbox até ser publicado.
    expect(eventsOf('WorkflowDefaultChanged').at(-1)).toMatchObject({
      routingKey: 'workflow.default_changed',
      payload: { workflowId: direct.id },
    });

    // Já é o padrão: 200 sem efeito, sem auditoria nem evento.
    const audits = auditOf('workflow.set_default').length;
    const again = await setDefault(direct.id, updated.version);
    expect(data<WorkflowDto>(again)).toMatchObject({ isDefault: true, version: updated.version });
    expect(auditOf('workflow.set_default')).toHaveLength(audits);

    // RN-WF-39: o padrão é só a rede de segurança. O workflow semeado sem regra casa sempre, então
    // PREGAO continua resolvendo para ele mesmo com a direta marcada como padrão.
    const pregao = await resolve(await processBody(A, 'PREGAO'));
    expect(data<WorkflowResolutionDto>(pregao).workflowId).toBe(standard.id);
  });

  it('[Concorrência] Duas trocas a partir da mesma leitura: uma 200, a outra 412 VERSION_CONFLICT', async () => {
    const snapshot = await workflowsOf();
    const standard = snapshot.find((workflow) => workflow.name === DEFAULT_NAME);
    const piloto = snapshot.find((workflow) => workflow.name === 'Piloto de obras');
    expect(standard?.isDefault).toBe(false);

    const first = await setDefault(standard?.id ?? '', standard?.version ?? 0, 'sub-marta');
    // A outra pessoa tinha lido a lista antes: o ETag que ela envia ficou velho.
    const direct = snapshot.find((workflow) => workflow.name === DIRECT_NAME);
    const second = await setDefault(direct?.id ?? '', direct?.version ?? 0, 'sub-otavio');

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const conflict = expectProblem(second, 412, 'VERSION_CONFLICT');
    expect(conflict.detail).toBe('Este workflow foi alterado por outra pessoa. Atualize a página.');
    expect(await defaultsOf()).toEqual([DEFAULT_NAME]);
    // Mesmo um workflow que não participou da troca exige releitura (versão de todos subiu).
    expect((await byName('Piloto de obras')).version).toBe((piloto?.version ?? 0) + 1);
  });

  it('[Falha de banco] Banco indisponível ao trocar o padrão → 503 e o padrão anterior permanece', async () => {
    const direct = await byName(DIRECT_NAME);
    const audits = auditOf('workflow.set_default').length;
    const events = api.outboxRows().length;
    transactions.down = true;

    const response = await setDefault(direct.id, direct.version);

    expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
    transactions.down = false;
    expect(await defaultsOf()).toEqual([DEFAULT_NAME]);
    expect(auditOf('workflow.set_default')).toHaveLength(audits);
    expect(api.outboxRows()).toHaveLength(events);
  });
});
