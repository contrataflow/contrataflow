import {
  AUDIT_LOG_MESSAGES,
  auditLogResponseSchema,
  auditLogSearchResponseSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TENANT_STATUS_PORT } from '#shared/auth/ports.js';
import type { TenantStatus, TenantStatusPort } from '#shared/auth/ports.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi, testConfig } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { runTenantSeeders } from '../../../../test/support/process-fixtures.js';
import { assignRole, seedDefaultRolesOf } from '../../../../test/support/structure-fixtures.js';
import { AUDIT_CLOCK, AUDIT_LOG_STORE, AUDIT_TRANSACTIONS } from '../application/ports.js';
import type { AuditTransactions } from '../application/ports.js';
import { seal as sealRecord } from '../domain/audit-record.js';
import type { AuditRecord, SealedAuditRecord } from '../domain/audit-record.js';
import type { InMemoryAuditLogStore } from '../infrastructure/in-memory-audit.store.js';

/*
 * US-075 — AUD-01/AUD-02/AUD-03 pelo pipeline HTTP completo (autenticação, tenant e `OFFBOARDING`,
 * autorização com MFA — POL-14 —, limite de requisições, filtro RFC 9457) com a identidade fake e a
 * trilha em memória: as 8 categorias do Gherkin do lado da API. O isolamento e a consulta sobre
 * PostgreSQL (RLS, poda de partições, exportação em lotes) em `test/tenant-leak/audit-logs.spec.ts`.
 * Personas: "Clara" = Otávio com AUDITOR; "Bruno" = Ana com CONTROLE_INTERNO (AUDIT_VIEW sem
 * AUDIT_EXPORT); Lúcia sem AUDIT_VIEW; Marta (ADMIN_ORGAO) e Fábio (AUDITOR) exportam em paralelo.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const ENCERRANDO = FAKE_TENANTS.prefeituraEncerrando.id;
const CLARA = 'sub-otavio';
const BRUNO = 'sub-ana';
const LUCIA = 'sub-lucia';
const MARTA = 'sub-marta';
const FABIO = 'sub-fabio';
const PAULO = 'sub-paulo';
const MFA = ['pwd', 'otp'];
/** Relógio da API nos testes: o fim de setembro; os registros semeados são de 1 a 7/set. */
const NOW = new Date('2026-09-30T12:00:00.000Z');
const WEEK = { occurredFrom: '2026-09-01T00:00:00Z', occurredTo: '2026-09-07T23:59:59Z' };
const EXPORT_MAX_ROWS = 20;

const membershipOf = (userId: string, tenantId: string = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações do módulo que podem simular o banco fora do ar na leitura. */
class FlakyTransactions implements AuditTransactions {
  failure: Error | null = null;

  inTenant<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  inPlatform<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.failure ? Promise.reject(this.failure) : runSimulatedTransaction(work);
  }
}

/** Status dos tenants fake, com a troca para `OFFBOARDING` (DEC-132) num teste. */
class SwitchableTenantStatus implements TenantStatusPort {
  readonly overrides = new Map<string, TenantStatus>();

  findStatus(tenantId: string): Promise<TenantStatus | null> {
    const fake = Object.values(FAKE_TENANTS).find((tenant) => tenant.id === tenantId);
    return Promise.resolve(this.overrides.get(tenantId) ?? fake?.status ?? null);
  }
}

let sequence = 0;

function record(
  tenantId: string,
  occurredAt: string,
  overrides: Partial<AuditRecord> = {},
): SealedAuditRecord {
  sequence += 1;
  return sealRecord({
    id: `0192d075-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`,
    occurredAt: new Date(occurredAt),
    tenantId,
    actorType: 'USER',
    actorUserId: FAKE_USERS.ana.id,
    actorName: 'Ana Souza',
    actorMembershipId: membershipOf(FAKE_USERS.ana.id),
    onBehalfOfUserId: null,
    action: 'process.update',
    category: 'DATA_CHANGE',
    result: 'SUCCESS',
    entityType: 'Process',
    entityId: '0192d075-0000-7000-8000-0000000000f0',
    processId: '0192d075-0000-7000-8000-0000000000f0',
    changes: [{ path: 'title', old: 'Antigo', new: `Novo ${String(sequence)}` }],
    metadata: { processCode: '0012/2026' },
    reasonCode: null,
    ip: '10.0.0.1',
    userAgent: 'vitest',
    correlationId: 'corr-us075',
    requestId: null,
    sessionIdHash: null,
    ...overrides,
  });
}

/** Corpo da resposta como texto (CSV ou NDJSON), qualquer que seja o `Content-Type`. */
function asText(response: request.Response): string {
  return typeof response.body === 'string' ? response.body : response.text;
}

describe('Feature: Consultar e exportar a trilha de auditoria (US-075)', () => {
  let api: TestApi;
  let logs: InMemoryAuditLogStore;
  const transactions = new FlakyTransactions();
  const tenantStatus = new SwitchableTenantStatus();
  let creates: SealedAuditRecord[] = [];
  let recordOfB: SealedAuditRecord;
  let masked: SealedAuditRecord;

  const call = (path: string, subject = CLARA, tenantId: string = A, amr = MFA) =>
    request(api.server)
      .get(`/api/v1/audit${path}`)
      .set('Authorization', api.bearer(subject, { amr }))
      .set('X-Tenant-Id', tenantId)
      .buffer(true)
      .parse((response, callback) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => {
          callback(null, text);
        });
      });
  const json = (response: request.Response): unknown => JSON.parse(asText(response));
  const query = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`;
  const expectProblem = (response: request.Response, status: number, code: string) => {
    expect(response.status, asText(response)).toBe(status);
    const body = problemDetailsSchema.parse(json(response));
    expect(body.code).toBe(code);
    return body;
  };
  const search = async (params: Record<string, string>, subject = CLARA) => {
    const response = await call(query(params), subject);
    expect(response.status, asText(response)).toBe(200);
    return auditLogSearchResponseSchema.parse(json(response));
  };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      config: testConfig({ AUDIT_EXPORT_MAX_ROWS: String(EXPORT_MAX_ROWS) }),
      providers: [
        { token: AUDIT_TRANSACTIONS, value: transactions },
        { token: AUDIT_CLOCK, value: () => new Date(NOW) },
        { token: TENANT_STATUS_PORT, value: tenantStatus },
      ],
    });
    for (const tenantId of [A, ENCERRANDO]) await runTenantSeeders(api, tenantId);
    const roles = seedDefaultRolesOf(api, A);
    const role = (key: string) => roles.get(key)?.id ?? '';
    const grant = (userId: string, key: string, tenantId: string = A, roleId = role(key)) =>
      assignRole(api, { tenantId, membershipId: membershipOf(userId, tenantId), roleId });
    grant(FAKE_USERS.otavio.id, 'AUDITOR');
    grant(FAKE_USERS.ana.id, 'CONTROLE_INTERNO');
    grant(FAKE_USERS.marta.id, 'ADMIN_ORGAO');
    grant(FAKE_USERS.fabio.id, 'AUDITOR');
    const offboarding = seedDefaultRolesOf(api, ENCERRANDO);
    grant(FAKE_USERS.paulo.id, 'AUDITOR', ENCERRANDO, offboarding.get('AUDITOR')?.id ?? '');
    logs = api.app.get<InMemoryAuditLogStore>(AUDIT_LOG_STORE);

    creates = [
      record(A, '2026-09-02T10:00:00.000Z', { action: 'process.create', changes: null }),
      record(A, '2026-09-03T11:00:00.000Z', { action: 'process.create', changes: null }),
      record(A, '2026-09-05T09:30:00.000Z', { action: 'process.create', changes: null }),
    ];
    recordOfB = record(B, '2026-09-04T10:00:00.000Z', {
      action: 'process.create',
      actorName: 'Operador LEAK-B',
    });
    logs.records.push(
      ...creates,
      record(A, '2026-09-04T08:00:00.000Z'),
      record(A, '2026-09-06T15:00:00.000Z', {
        action: 'access.denied',
        category: 'ACCESS',
        result: 'DENIED',
        reasonCode: 'PROCESS_CREATE',
        changes: null,
        actorUserId: FAKE_USERS.lucia.id,
        actorName: 'Lúcia',
      }),
      record(A, '2026-09-06T16:00:00.000Z', {
        action: 'document.items_update',
        actorName: '=SOMA(1;2)',
        changes: null,
        metadata: { note: '+cmd|calc', list: ['-x'] },
      }),
      record(A, '2026-08-20T10:00:00.000Z', { action: 'process.create', changes: null }),
      recordOfB,
    );
    // Registro gravado pelo AuditService real: CPF mascarado e conteúdo longo resumido (US-073).
    const audit = api.app.get<AuditTrailPort>(AUDIT_TRAIL);
    const before = logs.records.length;
    await runAsSystem({ name: 'Teste US-075', tenantId: A }, () =>
      audit.recordStandalone({
        action: 'supplier.update',
        occurredAt: new Date('2026-09-07T10:00:00.000Z'),
        entityType: 'Supplier',
        entityId: '0192d075-0000-7000-8000-0000000000e1',
        changes: [
          { path: 'contactCpf', old: '123.456.789-09', new: '987.654.321-00' },
          { path: 'notes', old: null, new: 'x'.repeat(800) },
        ],
        metadata: { supplierName: 'Cimentos do Sul' },
      }),
    );
    const [written] = logs.records.slice(before);
    if (!written) throw new Error('AuditService não gravou o registro mascarado');
    masked = written;
  });

  afterAll(async () => {
    await api.close();
  });

  afterEach(() => {
    transactions.failure = null;
    tenantStatus.overrides.clear();
  });

  it('[Sucesso] pesquisar por período e ação: só process.create do período, mais recentes primeiro, e audit.search com os filtros', async () => {
    const before = api.auditRecords().length;
    const body = await search({ ...WEEK, action: 'process.create' });
    expect(body.data.map((item) => item.id)).toEqual(creates.map((item) => item.id).reverse());
    expect(body.data.every((item) => item.action === 'process.create')).toBe(true);
    expect(body.meta).toEqual({ nextCursor: null, hasMore: false });
    // Registro de B com a mesma ação no período nunca aparece.
    expect(JSON.stringify(body)).not.toContain('LEAK-B');
    expect(api.auditRecords().slice(before)).toEqual([
      expect.objectContaining({
        action: 'audit.search',
        category: 'ACCESS',
        tenantId: A,
        actorUserId: FAKE_USERS.otavio.id,
        metadata: expect.objectContaining({
          target: 'logs',
          occurredFrom: WEEK.occurredFrom,
          occurredTo: WEEK.occurredTo,
          action: ['process.create'],
        }) as unknown,
      }),
    ]);
  });

  it('[Sucesso] ao abrir um registro, o diff de changes vem mascarado como gravado (nunca desmascarado)', async () => {
    const before = api.auditRecords().length;
    const response = await call(`/${masked.id}`);
    expect(response.status, asText(response)).toBe(200);
    const { data } = auditLogResponseSchema.parse(json(response));
    expect(data).toMatchObject({
      id: masked.id,
      action: 'supplier.update',
      category: 'DATA_CHANGE',
      entityType: 'Supplier',
      rowHash: masked.rowHash,
      metadata: { supplierName: 'Cimentos do Sul' },
    });
    const [cpf, notes] = data.changes ?? [];
    expect(cpf).toEqual({ path: 'contactCpf', old: '***.456.789-**', new: '***.654.321-**' });
    expect(notes?.path).toBe('notes');
    expect(notes?.new).toEqual({
      hash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      length: 800,
    });
    expect(asText(response)).not.toContain('123.456.789-09');
    expect(asText(response)).not.toContain('x'.repeat(50));
    expect(api.auditRecords().slice(before)).toEqual([
      expect.objectContaining({
        action: 'audit.search',
        metadata: { target: 'record', auditLogId: masked.id },
      }),
    ]);
  });

  it('filtros combinados (E) e valores por vírgula (OU); período fora da semana não entra', async () => {
    const denied = await search({ ...WEEK, result: 'DENIED', category: 'ACCESS' });
    expect(denied.data.map((item) => [item.action, item.reasonCode])).toEqual([
      ['access.denied', 'PROCESS_CREATE'],
    ]);
    const byActor = await search({ ...WEEK, actorUserId: FAKE_USERS.lucia.id });
    expect(byActor.data.map((item) => item.actorName)).toEqual(['Lúcia']);
    const either = await search({ ...WEEK, action: 'process.create,process.update' });
    expect(either.data).toHaveLength(4);
    const august = await search({
      occurredFrom: '2026-08-01T00:00:00Z',
      occurredTo: '2026-08-31T23:59:59Z',
      action: 'process.create',
    });
    expect(august.data).toHaveLength(1);
    const byEntity = await search({
      ...WEEK,
      entityType: 'Supplier',
      entityId: masked.entityId ?? '',
    });
    expect(byEntity.data.map((item) => item.id)).toEqual([masked.id]);
  });

  it('paginação por cursor sem repetir nem pular; limit acima de 100 é ajustado (V-03)', async () => {
    const all = await search({ ...WEEK, limit: '500' });
    expect(all.data.length).toBe(7);
    const first = await search({ ...WEEK, limit: '3' });
    expect(first.meta.hasMore).toBe(true);
    const ids = first.data.map((item) => item.id);
    let cursor = first.meta.nextCursor;
    while (cursor !== null) {
      const page = await search({ ...WEEK, limit: '3', cursor });
      ids.push(...page.data.map((item) => item.id));
      cursor = page.meta.nextCursor;
    }
    expect(ids).toEqual(all.data.map((item) => item.id));
    expectProblem(await call(query({ ...WEEK, cursor: 'bm9wZQ' })), 422, 'VALIDATION_ERROR');
  });

  it('[Validação] período de 120 dias → 422 VALIDATION_ERROR pedindo até 90 dias', async () => {
    const response = await call(
      query({ occurredFrom: '2026-05-01T00:00:00Z', occurredTo: '2026-08-29T00:00:00Z' }),
    );
    const body = expectProblem(response, 422, 'VALIDATION_ERROR');
    expect(body.errors).toEqual([
      { field: 'occurredTo', code: 'OUT_OF_RANGE', message: AUDIT_LOG_MESSAGES.period },
    ]);
    const missing = expectProblem(await call(''), 422, 'VALIDATION_ERROR');
    expect(missing.errors.map((error) => error.message)).toEqual([
      AUDIT_LOG_MESSAGES.period,
      AUDIT_LOG_MESSAGES.period,
    ]);
    const inverted = expectProblem(
      await call(query({ occurredFrom: WEEK.occurredTo, occurredTo: WEEK.occurredFrom })),
      422,
      'VALIDATION_ERROR',
    );
    expect(inverted.errors[0]?.message).toBe(AUDIT_LOG_MESSAGES.periodRange);
    const format = expectProblem(
      await call(`/export${query({ ...WEEK, format: 'xlsx' })}`),
      422,
      'VALIDATION_ERROR',
    );
    expect(format.errors[0]).toMatchObject({
      field: 'format',
      code: 'INVALID_ENUM',
      message: AUDIT_LOG_MESSAGES.invalidFormat,
    });
  });

  it('[Permissão] Bruno com AUDIT_VIEW e sem AUDIT_EXPORT: consulta, mas exportar → 403 e access.denied AUDIT_EXPORT', async () => {
    expect((await call(query(WEEK), BRUNO)).status).toBe(200);
    const before = api.auditRecords().length;
    expectProblem(await call(`/export${query(WEEK)}`, BRUNO), 403, 'PERMISSION_DENIED');
    expect(api.auditRecords().slice(before)).toEqual([
      expect.objectContaining({
        action: 'access.denied',
        result: 'DENIED',
        reasonCode: 'AUDIT_EXPORT',
        actorUserId: FAKE_USERS.ana.id,
      }),
    ]);
  });

  it('[Permissão] sem AUDIT_VIEW → 403 com access.denied AUDIT_VIEW; sem MFA → 403 MFA_REQUIRED', async () => {
    const before = api.auditRecords().length;
    expectProblem(await call(query(WEEK), LUCIA), 403, 'PERMISSION_DENIED');
    expectProblem(await call(`/${creates[0]?.id ?? ''}`, LUCIA), 403, 'PERMISSION_DENIED');
    expect(api.auditRecords().slice(before)[0]).toMatchObject({
      action: 'access.denied',
      reasonCode: 'AUDIT_VIEW',
    });
    expectProblem(await call(query(WEEK), CLARA, A, ['pwd']), 403, 'MFA_REQUIRED');
    expectProblem(await call(`/export${query(WEEK)}`, CLARA, A, ['pwd']), 403, 'MFA_REQUIRED');
  });

  it('[Tenant incorreto] registro da Prefeitura B → 404 NOT_FOUND idêntico ao inexistente', async () => {
    const leaked = expectProblem(await call(`/${recordOfB.id}`), 404, 'NOT_FOUND');
    const missing = expectProblem(
      await call('/0192d075-0000-7000-8000-00000000dead'),
      404,
      'NOT_FOUND',
    );
    expect(leaked.detail).toBe(AUDIT_LOG_MESSAGES.notFound);
    expect({ ...leaked, instance: null, correlationId: null }).toEqual({
      ...missing,
      instance: null,
      correlationId: null,
    });
    expect(asText(await call(`/export${query(WEEK)}`))).not.toContain('LEAK-B');
  });

  it('[Sucesso] exportação CSV: anexo com BOM, cabeçalho, linhas na ordem da consulta e fórmulas neutralizadas', async () => {
    const response = await call(`/export${query(WEEK)}`);
    expect(response.status, asText(response)).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="auditoria-20260901-20260907.csv"',
    );
    const text = asText(response);
    expect(
      text.startsWith(
        `${String.fromCharCode(0xfeff)}id,occurredAt,actorType,actorUserId,actorName,`,
      ),
    ).toBe(true);
    const lines = text
      .slice(1)
      .split('\r\n')
      .filter((line) => line !== '');
    expect(lines).toHaveLength(1 + 7);
    const formula = lines.find((line) => line.includes('SOMA'));
    expect(formula).toContain(",'=SOMA(1;2),");
    // Também dentro do JSON achatado de metadata: a célula começa com `{`, não é fórmula.
    expect(formula).toContain('"{""note"":""+cmd|calc"",""list"":[""-x""]}"');
    expect(text).not.toMatch(/,=SOMA/);
  });

  it('[Sucesso] exportação NDJSON: um AuditLog por linha', async () => {
    const response = await call(
      `/export${query({ ...WEEK, format: 'ndjson', action: 'process.create' })}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    const rows = asText(response)
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { id: string; actorName: string });
    expect(rows.map((row) => row.id)).toEqual(creates.map((item) => item.id).reverse());
  });

  it('[Duplicidade] exportar duas vezes os mesmos filtros: mesmo conteúdo e dois audit.export distintos', async () => {
    const before = api.auditRecords().length;
    const first = asText(await call(`/export${query(WEEK)}`));
    const second = asText(await call(`/export${query(WEEK)}`));
    expect(second).toBe(first);
    const exports = api.auditRecords().slice(before);
    expect(exports).toHaveLength(2);
    expect(exports.map((item) => item.action)).toEqual(['audit.export', 'audit.export']);
    expect(exports[0]?.id).not.toBe(exports[1]?.id);
    expect(exports[0]).toMatchObject({
      category: 'EXPORT',
      metadata: expect.objectContaining({ format: 'csv', rowCount: 7, ...WEEK }) as unknown,
    });
  });

  it('[Concorrência] três auditores exportam ao mesmo tempo com filtros diferentes, sem misturar linhas', async () => {
    const [clara, marta, fabio] = await Promise.all([
      call(`/export${query({ ...WEEK, format: 'ndjson', action: 'process.create' })}`, CLARA),
      call(`/export${query({ ...WEEK, format: 'ndjson', result: 'DENIED' })}`, MARTA),
      call(`/export${query({ ...WEEK, format: 'ndjson', entityType: 'Supplier' })}`, FABIO),
    ]);
    const actions = (response: request.Response) =>
      asText(response)
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => (JSON.parse(line) as { action: string }).action);
    expect(actions(clara)).toEqual(['process.create', 'process.create', 'process.create']);
    expect(actions(marta)).toEqual(['access.denied']);
    expect(actions(fabio)).toEqual(['supplier.update']);
  });

  it('a exportação não inclui a própria auditoria gravada durante o pedido (período fixado no instante)', async () => {
    const around = { occurredFrom: '2026-09-25T00:00:00Z', occurredTo: '2026-10-05T00:00:00Z' };
    const first = asText(await call(`/export${query({ ...around, format: 'ndjson' })}`));
    const second = asText(await call(`/export${query({ ...around, format: 'ndjson' })}`));
    // As consultas e exportações anteriores (gravadas "agora") entram; as deste pedido, não.
    expect(second).toBe(first);
  });

  it('[Falha de integração] filtros com mais linhas que o teto → 422 EXPORT_TOO_LARGE antes de gerar o arquivo', async () => {
    logs.records.push(
      ...Array.from({ length: EXPORT_MAX_ROWS + 10 }, (_, index) =>
        record(A, `2026-07-${String(1 + (index % 28)).padStart(2, '0')}T12:00:00.000Z`),
      ),
    );
    const before = api.auditRecords().length;
    const body = expectProblem(
      await call(
        `/export${query({ occurredFrom: '2026-07-01T00:00:00Z', occurredTo: '2026-07-31T00:00:00Z' })}`,
      ),
      422,
      'EXPORT_TOO_LARGE',
    );
    expect(body.detail).toBe(AUDIT_LOG_MESSAGES.exportTooLarge(EXPORT_MAX_ROWS + 10));
    // Nada exportado: nenhum audit.export.
    expect(
      api
        .auditRecords()
        .slice(before)
        .map((item) => item.action),
    ).not.toContain('audit.export');
  });

  it('[Falha de banco] banco indisponível na pesquisa → 503 DEPENDENCY_UNAVAILABLE com Retry-After', async () => {
    transactions.failure = new DatabaseUnavailableError(new Error('connect ECONNREFUSED'));
    const response = await call(query(WEEK));
    const body = expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
    expect(response.headers['retry-after']).toBeDefined();
    expect(body.correlationId).toEqual(expect.any(String));
    transactions.failure = Object.assign(new Error('Connection terminated unexpectedly'), {
      code: 'P1001',
    });
    expectProblem(await call(`/export${query(WEEK)}`), 503, 'DEPENDENCY_UNAVAILABLE');
    expectProblem(await call(`/${creates[0]?.id ?? ''}`), 503, 'DEPENDENCY_UNAVAILABLE');
  });

  it('[Tenant incorreto] OFFBOARDING (DEC-132): AUDITOR consulta e exporta; demais perfis → 403 TENANT_SUSPENDED', async () => {
    expect((await call(query(WEEK), PAULO, ENCERRANDO)).status).toBe(200);
    expect((await call(`/export${query(WEEK)}`, PAULO, ENCERRANDO)).status).toBe(200);
    tenantStatus.overrides.set(A, 'OFFBOARDING');
    expect((await call(query(WEEK), CLARA)).status).toBe(200);
    expectProblem(await call(query(WEEK), BRUNO), 403, 'TENANT_SUSPENDED');
    expectProblem(await call(`/${creates[0]?.id ?? ''}`, BRUNO), 403, 'TENANT_SUSPENDED');
  });

  it('/audit/seals continua com o AuditSealsController (rota fixa antes de /audit/:id)', async () => {
    const response = await call('/seals');
    expect(response.status, asText(response)).toBe(200);
  });
});
