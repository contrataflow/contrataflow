import { randomUUID } from 'node:crypto';

import {
  documentPresenceSchema,
  problemDetailsSchema,
  richTextFromPlainText,
} from '@contrataflow/validation';
import type { DocumentPresenceDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DOCUMENT_PRESENCE_STORE } from '#shared/document/document-presence.js';
import type { InMemoryDocumentPresenceStore } from '#shared/document/document-presence.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  documentTypeRepositoryOf,
  openStageForAnyType,
} from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  PROCESS_PREREQUISITE_SEEDERS,
  runTenantSeeders,
  seedParticipant,
  seedProcessStructure,
} from '../../../../test/support/process-fixtures.js';
import { assignDepartment } from '../../../../test/support/structure-fixtures.js';
import { DOCUMENT_CLOCK } from '../application/ports.js';

/*
 * US-070 — indicador de edição concorrente (DOC-24/25) pelo pipeline HTTP completo (autenticação,
 * tenant, vínculo, autorização, filtro RFC 9457) com a identidade fake, os seeders reais (o DESPACHO
 * nasce com o modelo padrão publicado, seção `CONTENT`) e a presença em memória (mesma semântica do
 * Redis — o script atômico, TTL e chaves por tenant: test/document/document-presence.spec.ts e
 * test/tenant-leak/document-presence.spec.ts). Os 8 cenários do Gherkin + V-02 e a saída (DOC-25).
 *
 * Personas: "Ana" do Gherkin (custodiante) = Lúcia (GESTOR_CONTRATACOES, cria o processo e fica
 * responsável); "Bruno" (coeditor) = Ana, REQUISITANTE feita COLLABORATOR do processo (POL-02);
 * "Carla" (só visualiza) = Marta (ADMIN_ORGAO: vê o processo, sem custódia nem participação);
 * usuário de outro tenant = Heitor (Prefeitura B).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const START = new Date('2026-10-19T13:00:00.000Z');
const KEY = 'CONTENT';

const ORG_A = '0192d070-0000-7000-8000-0000000000a0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d070-0000-7000-8000-0000000000a1',
  manutencao: '0192d070-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d070-0000-7000-8000-0000000000a3',
  saude: '0192d070-0000-7000-8000-0000000000a4',
  posto: '0192d070-0000-7000-8000-0000000000a5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

const LUCIA = 'sub-lucia';
const ANA = 'sub-ana';

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

function presenceOf(response: request.Response): DocumentPresenceDto {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return documentPresenceSchema.parse((response.body as { data: unknown }).data);
}

describe('Feature: Indicador de edição concorrente (US-070)', () => {
  let api: TestApi;
  let now = START;
  let store: InMemoryDocumentPresenceStore;
  let types: { despacho: string; externo: string };
  let openStages: Set<string>;

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };

  const call = (
    method: 'post' | 'put' | 'delete',
    path: string,
    options: { subject?: string; tenant?: string; ifMatch?: string; body?: object } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${path}`)
      .set('Authorization', api.bearer(options.subject ?? LUCIA, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (method === 'post') pending = pending.set('Idempotency-Key', randomUUID());
    if (options.ifMatch !== undefined) pending = pending.set('If-Match', options.ifMatch);
    return options.body === undefined ? pending : pending.send(options.body);
  };

  /** DOC-24. */
  const heartbeat = (
    documentId: string,
    options: { subject?: string; tenant?: string; sectionKey?: string } = {},
  ) =>
    call('put', `/documents/${documentId}/presence`, {
      ...options,
      body: options.sectionKey === undefined ? {} : { sectionKey: options.sectionKey },
    });

  /** Processo (Lúcia responsável) com Ana COLLABORATOR e um DESPACHO em DRAFT. */
  async function newDocument(documentTypeId = types.despacho): Promise<string> {
    const process = await call('post', '/processes', {
      body: {
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      },
    });
    expect(process.status, JSON.stringify(process.body)).toBe(201);
    const processId = (process.body as { data: { id: string } }).data.id;
    openStages.add(processId);
    seedParticipant(api, {
      tenantId: A,
      processId,
      userId: FAKE_USERS.ana.id,
      role: 'COLLABORATOR',
    });
    const document = await call('post', `/processes/${processId}/documents`, {
      body: { documentTypeId, title: 'ETP 0003/2026 — despacho de apoio' },
    });
    expect(document.status, JSON.stringify(document.body)).toBe(201);
    return (document.body as { data: { id: string } }).data.id;
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: DOCUMENT_CLOCK, value: () => now },
        { token: CATALOG_CLOCK, value: () => START },
      ],
    });
    store = api.app.get(DOCUMENT_PRESENCE_STORE);
    await runTenantSeeders(api, A, [...PROCESS_PREREQUISITE_SEEDERS, 'document.templateLibrary']);
    await runTenantSeeders(api, B, ['catalog.items', 'access.defaultRoles']);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    openStages = openStageForAnyType(api);
    const seeded = documentTypeRepositoryOf(api)
      .snapshot()
      .filter((type) => type.tenantId === A);
    const idOf = (code: string) => seeded.find((type) => type.code === code)?.id ?? '';
    types = { despacho: idOf('DESPACHO'), externo: idOf('DOCUMENTO_EXTERNO') };
    expect(Object.values(types).every((id) => id !== '')).toBe(true);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    store.down = false;
  });

  it('[Sucesso] Ver outro editor na mesma seção: a resposta de cada um inclui o outro, nunca o próprio chamador; sem evento nem auditoria', async () => {
    const documentId = await newDocument();
    const outboxBefore = api.outboxRows().length;
    const auditBefore = api.auditRecords().length;

    expect(presenceOf(await heartbeat(documentId, { sectionKey: KEY })).editors).toEqual([]);
    const lucia = now.toISOString();
    advance(5_000);
    const bruno = presenceOf(await heartbeat(documentId, { subject: ANA, sectionKey: KEY }));
    expect(bruno.editors).toEqual([
      { userId: FAKE_USERS.lucia.id, name: FAKE_USERS.lucia.name, sectionKey: KEY, since: lucia },
    ]);

    advance(20_000);
    const ana = presenceOf(await heartbeat(documentId, { sectionKey: KEY }));
    expect(ana.editors).toEqual([
      {
        userId: FAKE_USERS.ana.id,
        name: FAKE_USERS.ana.name,
        sectionKey: KEY,
        since: new Date(now.getTime() - 20_000).toISOString(),
      },
    ]);
    // RN-DOC-93: dado efêmero — nenhum evento de domínio nem registro de auditoria.
    expect(api.outboxRows()).toHaveLength(outboxBefore);
    expect(api.auditRecords()).toHaveLength(auditBefore);
  });

  it('[Sucesso] DOC-25: a saída remove só a própria presença (204, idempotente)', async () => {
    const documentId = await newDocument();
    await heartbeat(documentId, { sectionKey: KEY });
    await heartbeat(documentId, { subject: ANA, sectionKey: KEY });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const left = await call('delete', `/documents/${documentId}/presence`, { subject: ANA });
      expect(left.status, JSON.stringify(left.body)).toBe(204);
    }
    expect(presenceOf(await heartbeat(documentId, { sectionKey: KEY })).editors).toEqual([]);
    expect(store.usersOf({ tenantId: A, documentId })).toEqual([FAKE_USERS.lucia.id]);
  });

  it('[Validação] sectionKey inexistente no template → 422 SECTION_NOT_IN_TEMPLATE, mantendo a seção anterior válida', async () => {
    const documentId = await newDocument();
    await heartbeat(documentId, { sectionKey: KEY });
    const since = now.toISOString();
    advance(20_000);

    expectProblem(
      await heartbeat(documentId, { sectionKey: 'SECAO_INEXISTENTE' }),
      422,
      'SECTION_NOT_IN_TEMPLATE',
    );
    advance(20_000);
    // A presença foi renovada com a seção anterior (sem trocar o `since`).
    expect(presenceOf(await heartbeat(documentId, { subject: ANA })).editors).toEqual([
      { userId: FAKE_USERS.lucia.id, name: FAKE_USERS.lucia.name, sectionKey: KEY, since },
    ]);
  });

  it('[Validação] V-02: documento externo (UPLOADED, sem seções) → 422 NOT_ALLOWED, sem presença', async () => {
    const documentId = await newDocument(types.externo);
    const problem = expectProblem(await heartbeat(documentId), 422, 'VALIDATION_ERROR');
    expect(problem.errors[0]).toMatchObject({ field: 'id', code: 'NOT_ALLOWED' });
    expect(store.usersOf({ tenantId: A, documentId })).toEqual([]);
  });

  it('[Permissão] usuário sem permissão de edição (só vê o processo) → 409 DOCUMENT_NOT_EDITABLE e não aparece para ninguém', async () => {
    const documentId = await newDocument();
    expectProblem(
      await heartbeat(documentId, { subject: 'sub-marta', sectionKey: KEY }),
      409,
      'DOCUMENT_NOT_EDITABLE',
    );
    expect(presenceOf(await heartbeat(documentId, { sectionKey: KEY })).editors).toEqual([]);
    expect(store.usersOf({ tenantId: A, documentId })).toEqual([FAKE_USERS.lucia.id]);
  });

  it('[Permissão] documento fora de edição (cancelado) → 409 DOCUMENT_NOT_EDITABLE para todos', async () => {
    const documentId = await newDocument();
    const cancelled = await call('post', `/documents/${documentId}/cancel`, {
      ifMatch: '"1"',
      body: { cancellationReason: 'Documento criado por engano neste processo.' },
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expectProblem(await heartbeat(documentId, { sectionKey: KEY }), 409, 'DOCUMENT_NOT_EDITABLE');
    expect(store.usersOf({ tenantId: A, documentId })).toEqual([]);
  });

  it('[Tenant incorreto] heartbeat e saída de usuário de outro tenant → 404, sem chave de presença', async () => {
    const documentId = await newDocument();
    const asHeitor = { subject: 'sub-heitor', tenant: B };
    expectProblem(await heartbeat(documentId, { ...asHeitor, sectionKey: KEY }), 404, 'NOT_FOUND');
    expectProblem(
      await call('delete', `/documents/${documentId}/presence`, asHeitor),
      404,
      'NOT_FOUND',
    );
    expect(store.usersOf({ tenantId: B, documentId })).toEqual([]);
    expect(store.usersOf({ tenantId: A, documentId })).toEqual([]);
    // Documento inexistente no próprio tenant: o mesmo 404.
    expectProblem(await heartbeat(randomUUIDv7Like(), { sectionKey: KEY }), 404, 'NOT_FOUND');
  });

  it('[Duplicidade] heartbeats repetidos do mesmo usuário: uma única entrada, renovada, sem erro', async () => {
    const documentId = await newDocument();
    expect((await heartbeat(documentId, { sectionKey: KEY })).status).toBe(200);
    const since = now.toISOString();
    advance(5_000);
    expect((await heartbeat(documentId, { sectionKey: KEY })).status).toBe(200);
    expect(store.usersOf({ tenantId: A, documentId })).toEqual([FAKE_USERS.lucia.id]);

    // Renovado: 59 s depois do ÚLTIMO heartbeat (64 s do primeiro) ainda aparece, com o `since` original.
    advance(59_000);
    expect(presenceOf(await heartbeat(documentId, { subject: ANA })).editors).toEqual([
      { userId: FAKE_USERS.lucia.id, name: FAKE_USERS.lucia.name, sectionKey: KEY, since },
    ]);
  });

  it('[Concorrência] dois editores no mesmo instante: ambos aparecem na lista um do outro', async () => {
    const documentId = await newDocument();
    const [lucia, ana] = await Promise.all([
      heartbeat(documentId, { sectionKey: KEY }),
      heartbeat(documentId, { subject: ANA, sectionKey: KEY }),
    ]);
    expect(lucia.status).toBe(200);
    expect(ana.status).toBe(200);
    expect(
      presenceOf(await heartbeat(documentId, { sectionKey: KEY })).editors.map((e) => e.userId),
    ).toEqual([FAKE_USERS.ana.id]);
    expect(
      presenceOf(await heartbeat(documentId, { subject: ANA, sectionKey: KEY })).editors.map(
        (e) => e.userId,
      ),
    ).toEqual([FAKE_USERS.lucia.id]);
  });

  it('[Falha de banco] Redis indisponível: 200 com editors vazio, warn presence.store_unavailable e o autosave segue normal', async () => {
    const documentId = await newDocument();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    warn.mockClear();
    store.down = true;

    expect(presenceOf(await heartbeat(documentId, { sectionKey: KEY })).editors).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'presence.store_unavailable' }),
      'presence.store_unavailable',
    );
    // RN-DOC-92: autosave (US-015) e saída seguem funcionando.
    const saved = await call('put', `/documents/${documentId}/sections/${KEY}`, {
      ifMatch: '"s1"',
      body: { content: richTextFromPlainText('Encaminhem-se os autos.'), notApplicable: false },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await call('delete', `/documents/${documentId}/presence`)).status).toBe(204);
  });

  it('[Falha de integração] cliente some sem DOC-25: após 60 s sem heartbeat deixa de aparecer, sem intervenção', async () => {
    const documentId = await newDocument();
    await heartbeat(documentId, { subject: ANA, sectionKey: KEY });
    advance(40_000);
    expect(presenceOf(await heartbeat(documentId, { sectionKey: KEY })).editors).toHaveLength(1);

    advance(20_000);
    expect(presenceOf(await heartbeat(documentId, { sectionKey: KEY })).editors).toEqual([]);
    expect(store.usersOf({ tenantId: A, documentId })).toEqual([FAKE_USERS.lucia.id]);
  });
});

/** Um uuid v7 que não existe (o parâmetro exige v7). */
function randomUUIDv7Like(): string {
  return `0192d070-ffff-7fff-8fff-${randomUUID().slice(-12)}`;
}
