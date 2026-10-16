import {
  auditSealListResponseSchema,
  auditSealVerificationResponseSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { runTenantSeeders } from '../../../../test/support/process-fixtures.js';
import { assignRole, seedDefaultRolesOf } from '../../../../test/support/structure-fixtures.js';
import { AUDIT_LOG_STORE, AUDIT_SEAL_STORE, AUDIT_TRANSACTIONS } from '../application/ports.js';
import type { AuditTransactions } from '../application/ports.js';
import { seal as sealRecord } from '../domain/audit-record.js';
import type { AuditRecord, SealedAuditRecord } from '../domain/audit-record.js';
import { AuditSeal, sealPeriodOf } from '../domain/audit-seal.js';
import type {
  InMemoryAuditLogStore,
  InMemoryAuditSealStore,
} from '../infrastructure/in-memory-audit.store.js';

/*
 * US-074 — AUD-04/AUD-05 pelo pipeline HTTP completo (autenticação, tenant, vínculo, autorização
 * com MFA — POL-14 —, filtro RFC 9457) com a identidade fake e a trilha/selos em memória. As 8
 * categorias do Gherkin do lado da API; o job (sucesso, duplicidade, concorrência, falha de banco,
 * dead letter) em `apps/worker/src/audit/audit-sealer.spec.ts` e
 * `apps/worker/test/tenant-leak/audit-sealer.spec.ts`; a verificação sobre PostgreSQL (rowHash
 * relido do banco, adulteração direta, RLS) em `test/tenant-leak/audit-seals.spec.ts`.
 * Personas: "Clara" = Otávio só com AUDITOR (atribuição); "Bruno" = Ana (REQUISITANTE, sem AUDIT_VIEW).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const CLARA = 'sub-otavio';
const BRUNO = 'sub-ana';
const MFA = ['pwd', 'otp'];

const membershipOf = (userId: string, tenantId = A) =>
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

let sequence = 0;

function record(
  tenantId: string,
  occurredAt: string,
  overrides: Partial<AuditRecord> = {},
): SealedAuditRecord {
  sequence += 1;
  return sealRecord({
    id: `0192d074-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`,
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
    entityId: '0192d074-0000-7000-8000-0000000000f0',
    processId: '0192d074-0000-7000-8000-0000000000f0',
    changes: [{ path: 'title', old: 'Antigo', new: `Novo ${String(sequence)}` }],
    metadata: { processCode: '0012/2026' },
    reasonCode: null,
    ip: '10.0.0.1',
    userAgent: 'vitest',
    correlationId: 'corr-us074',
    requestId: null,
    sessionIdHash: null,
    ...overrides,
  });
}

describe('Feature: Selagem de integridade da trilha de auditoria (US-074)', () => {
  let api: TestApi;
  let logs: InMemoryAuditLogStore;
  let seals: InMemoryAuditSealStore;
  let warn: MockInstance<Logger['warn']>;
  const transactions = new FlakyTransactions();
  /** Registros do período 10:00–10:59 (alvo da adulteração). */
  let tenOClock: SealedAuditRecord[] = [];
  const chainOfA: AuditSeal[] = [];
  let sealOfB: AuditSeal;

  const get = (query = '', subject = CLARA, tenantId: string = A, amr = MFA) =>
    request(api.server)
      .get(`/api/v1/audit/seals${query}`)
      .set('Authorization', api.bearer(subject, { amr }))
      .set('X-Tenant-Id', tenantId);
  const verify = (body: object, subject = CLARA, tenantId: string = A, amr = MFA) =>
    request(api.server)
      .post('/api/v1/audit/seals/verify')
      .set('Authorization', api.bearer(subject, { amr }))
      .set('X-Tenant-Id', tenantId)
      .send(body);
  const expectProblem = (response: request.Response, status: number, code: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    const body = problemDetailsSchema.parse(response.body);
    expect(body.code).toBe(code);
    return body;
  };

  /** Sela os registros de cada hora em ordem, encadeando (como o worker). */
  function sealHours(tenantId: string, hours: readonly string[], chain: AuditSeal[]): void {
    for (const hour of hours) {
      const period = sealPeriodOf(new Date(hour));
      const rows = logs.records
        .filter(
          (row) =>
            row.tenantId === tenantId &&
            row.occurredAt >= period.start &&
            row.occurredAt <= period.end,
        )
        .sort(
          (left, right) =>
            left.occurredAt.getTime() - right.occurredAt.getTime() || (left.id < right.id ? -1 : 1),
        );
      sequence += 1;
      const created = AuditSeal.create({
        id: `0192d074-0000-7000-8000-5${sequence.toString(16).padStart(11, '0')}`,
        tenantId,
        period,
        previous: chain.at(-1) ?? null,
        records: rows,
        sealedAt: new Date(period.end.getTime() + 5 * 60_000),
      });
      if (!created) throw new Error(`hora vazia: ${hour}`);
      chain.push(created);
      seals.seed(created);
    }
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({ providers: [{ token: AUDIT_TRANSACTIONS, value: transactions }] });
    await runTenantSeeders(api, A);
    const roles = seedDefaultRolesOf(api, A);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: roles.get('AUDITOR')?.id ?? '',
    });
    logs = api.app.get<InMemoryAuditLogStore>(AUDIT_LOG_STORE);
    seals = api.app.get<InMemoryAuditSealStore>(AUDIT_SEAL_STORE);

    tenOClock = [
      record(A, '2026-10-05T10:05:00.000Z'),
      record(A, '2026-10-05T10:20:00.000Z'),
      record(A, '2026-10-05T10:20:00.000Z'),
    ];
    logs.records.push(
      ...tenOClock,
      record(A, '2026-10-05T11:15:00.000Z'),
      // 12h sem atividade (lacuna — FA-03).
      record(A, '2026-10-05T13:40:00.000Z'),
      record(A, '2026-10-05T13:41:00.000Z', {
        action: 'auth.session_start',
        category: 'SECURITY',
        changes: null,
      }),
      record(B, '2026-10-05T14:10:00.000Z', { actorName: 'Operador LEAK-B' }),
    );
    sealHours(
      A,
      ['2026-10-05T10:00:00Z', '2026-10-05T11:00:00Z', '2026-10-05T13:00:00Z'],
      chainOfA,
    );
    const chainOfB: AuditSeal[] = [];
    sealHours(B, ['2026-10-05T14:00:00Z'], chainOfB);
    const [first] = chainOfB;
    if (!first) throw new Error('B sem selo');
    sealOfB = first;
  });

  afterAll(async () => {
    await api.close();
  });

  afterEach(() => {
    transactions.failure = null;
  });

  it('[Sucesso] Clara lista os selos do tenant, mais recentes primeiro, e a consulta é auditada', async () => {
    const before = api.auditRecords().length;
    const response = await get('?pageSize=2');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = auditSealListResponseSchema.parse(response.body);
    expect(body.data.map((item) => item.periodStart)).toEqual([
      '2026-10-05T13:00:00.000Z',
      '2026-10-05T11:00:00.000Z',
    ]);
    expect(body.meta).toEqual({ page: 1, pageSize: 2, totalItems: 3, totalPages: 2 });
    expect(body.data[0]).toEqual({
      id: chainOfA[2]?.id,
      periodStart: '2026-10-05T13:00:00.000Z',
      periodEnd: '2026-10-05T13:59:59.999Z',
      recordCount: 2,
      digest: chainOfA[2]?.digest,
      chainHash: chainOfA[2]?.chainHash,
      sealedAt: '2026-10-05T14:04:59.999Z',
    });
    const searched = api.auditRecords().slice(before);
    expect(searched).toEqual([
      expect.objectContaining({
        action: 'audit.search',
        category: 'ACCESS',
        tenantId: A,
        metadata: expect.objectContaining({ target: 'seals', page: 1 }) as unknown,
      }),
    ]);
  });

  it('filtra por período de periodStart e pagina além do fim sem erro', async () => {
    const filtered = auditSealListResponseSchema.parse(
      (await get('?periodFrom=2026-10-05T10:30:00Z&periodTo=2026-10-05T13:00:00Z')).body,
    );
    expect(filtered.data.map((item) => item.periodStart)).toEqual([
      '2026-10-05T13:00:00.000Z',
      '2026-10-05T11:00:00.000Z',
    ]);
    const beyond = auditSealListResponseSchema.parse((await get('?page=9')).body);
    expect(beyond.data).toEqual([]);
    expect(beyond.meta.totalItems).toBe(3);
  });

  it('[Sucesso] verificação de um intervalo íntegro (com lacuna de período) → todos VALID', async () => {
    const response = await verify({
      periodStart: '2026-10-05T10:00:00Z',
      periodEnd: '2026-10-05T13:59:59Z',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const { data } = auditSealVerificationResponseSchema.parse(response.body);
    expect(data).toEqual({
      brokenAtPeriodStart: null,
      results: [
        {
          periodStart: '2026-10-05T10:00:00.000Z',
          periodEnd: '2026-10-05T10:59:59.999Z',
          recordCount: 3,
          status: 'VALID',
        },
        {
          periodStart: '2026-10-05T11:00:00.000Z',
          periodEnd: '2026-10-05T11:59:59.999Z',
          recordCount: 1,
          status: 'VALID',
        },
        {
          periodStart: '2026-10-05T13:00:00.000Z',
          periodEnd: '2026-10-05T13:59:59.999Z',
          recordCount: 2,
          status: 'VALID',
        },
      ],
    });
  });

  it('o intervalo no meio da cadeia usa o antecessor real e a hora parcial do início entra', async () => {
    const { data } = auditSealVerificationResponseSchema.parse(
      (await verify({ periodStart: '2026-10-05T11:30:00Z', periodEnd: '2026-10-05T13:00:00Z' }))
        .body,
    );
    expect(data.results.map((item) => [item.periodStart, item.status])).toEqual([
      ['2026-10-05T11:00:00.000Z', 'VALID'],
      ['2026-10-05T13:00:00.000Z', 'VALID'],
    ]);
  });

  it('[Validação] intervalo de 1.000 selos → 422 VALIDATION_ERROR pedindo a redução', async () => {
    const response = await verify({
      periodStart: '2026-09-01T00:00:00Z',
      periodEnd: new Date(Date.parse('2026-09-01T00:00:00Z') + 999 * 3_600_000).toISOString(),
    });
    const body = expectProblem(response, 422, 'VALIDATION_ERROR');
    expect(body.errors).toEqual([
      {
        field: 'periodEnd',
        code: 'OUT_OF_RANGE',
        message: 'Reduza o intervalo para verificar a integridade (máximo de 720 selos).',
      },
    ]);
  });

  it('[Validação] período final anterior ao inicial → 422 com a mensagem da story', async () => {
    const response = await verify({
      periodStart: '2026-10-05T13:00:00Z',
      periodEnd: '2026-10-05T10:00:00Z',
    });
    const body = expectProblem(response, 422, 'VALIDATION_ERROR');
    expect(body.errors[0]?.message).toBe('O período final deve ser posterior ao inicial.');
  });

  it('[Permissão] Bruno sem AUDIT_VIEW: 403 PERMISSION_DENIED e access.denied com reasonCode AUDIT_VIEW', async () => {
    const before = api.auditRecords().length;
    expectProblem(await get('', BRUNO), 403, 'PERMISSION_DENIED');
    expectProblem(
      await verify(
        { periodStart: '2026-10-05T10:00:00Z', periodEnd: '2026-10-05T11:00:00Z' },
        BRUNO,
      ),
      403,
      'PERMISSION_DENIED',
    );
    const denied = api.auditRecords().slice(before);
    expect(denied[0]).toMatchObject({
      action: 'access.denied',
      result: 'DENIED',
      reasonCode: 'AUDIT_VIEW',
      actorUserId: FAKE_USERS.ana.id,
    });
  });

  it('[Permissão] POL-14: AUDIT_VIEW é de risco alto — sessão sem MFA → 403 MFA_REQUIRED', async () => {
    expectProblem(await get('', CLARA, A, ['pwd']), 403, 'MFA_REQUIRED');
  });

  it('[Tenant incorreto] selo da Prefeitura B não é acessível a Clara → 404 NOT_FOUND', async () => {
    const response = await verify({
      periodStart: sealOfB.periodStart.toISOString(),
      periodEnd: sealOfB.periodEnd.toISOString(),
    });
    const body = expectProblem(response, 404, 'NOT_FOUND');
    expect(body.detail).toBe('Selo não encontrado.');
    const listed = auditSealListResponseSchema.parse((await get('?pageSize=100')).body);
    expect(listed.data.map((item) => item.id)).not.toContain(sealOfB.id);
  });

  it('[Falha de banco] banco indisponível na verificação → 503 DEPENDENCY_UNAVAILABLE', async () => {
    transactions.failure = new DatabaseUnavailableError(new Error('connect ECONNREFUSED'));
    expectProblem(
      await verify({ periodStart: '2026-10-05T10:00:00Z', periodEnd: '2026-10-05T11:00:00Z' }),
      503,
      'DEPENDENCY_UNAVAILABLE',
    );
    transactions.failure = Object.assign(new Error('Connection terminated unexpectedly'), {
      code: 'P1001',
    });
    expectProblem(await get(), 503, 'DEPENDENCY_UNAVAILABLE');
  });

  it('[Sucesso] AuditLog das 10h alterado depois da selagem → INVALID com quebra no digest', async () => {
    const index = logs.records.findIndex((row) => row.id === tenOClock[1]?.id);
    const original = logs.records[index];
    if (!original) throw new Error('registro das 10h ausente');
    // Adulteração direta: conteúdo alterado, `rowHash` gravado intacto.
    logs.records[index] = { ...original, actorName: 'Outra Pessoa' };
    try {
      const { data } = auditSealVerificationResponseSchema.parse(
        (await verify({ periodStart: '2026-10-05T10:00:00Z', periodEnd: '2026-10-05T13:59:59Z' }))
          .body,
      );
      expect(data.brokenAtPeriodStart).toBe('2026-10-05T10:00:00.000Z');
      expect(data.results.map((item) => [item.status, item.brokenAt])).toEqual([
        ['INVALID', 'digest'],
        ['VALID', undefined],
        ['VALID', undefined],
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'audit.seal_verification_broken',
          periodStart: '2026-10-05T10:00:00.000Z',
          brokenAt: 'digest',
        }),
        'audit.seal_verification_broken',
      );
    } finally {
      logs.records[index] = original;
    }
  });

  it('selo intermediário removido → o seguinte quebra no chainHash', async () => {
    const removed = seals.seals.findIndex((seal) => seal.id === chainOfA[1]?.id);
    const [gone] = seals.seals.splice(removed, 1);
    try {
      const { data } = auditSealVerificationResponseSchema.parse(
        (await verify({ periodStart: '2026-10-05T10:00:00Z', periodEnd: '2026-10-05T13:59:59Z' }))
          .body,
      );
      expect(data.results.map((item) => [item.periodStart, item.status, item.brokenAt])).toEqual([
        ['2026-10-05T10:00:00.000Z', 'VALID', undefined],
        ['2026-10-05T13:00:00.000Z', 'INVALID', 'chain'],
      ]);
      expect(data.brokenAtPeriodStart).toBe('2026-10-05T13:00:00.000Z');
    } finally {
      if (gone) seals.seals.splice(removed, 0, gone);
    }
  });
});
