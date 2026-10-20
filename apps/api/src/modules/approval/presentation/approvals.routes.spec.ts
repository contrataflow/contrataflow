import { randomUUID } from 'node:crypto';

import { approvalListResponseSchema, problemDetailsSchema } from '@contrataflow/validation';
import type { ApprovalListResponse } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { CATALOG_CLOCK, runTenantSeeders } from '../../../../test/support/process-fixtures.js';
import {
  assignRole,
  seedCustomRole,
  seedDepartment,
  unassignRole,
} from '../../../../test/support/structure-fixtures.js';
import {
  APPROVAL_CLOCK,
  APPROVAL_LIST_READER,
  APPROVAL_TRANSACTIONS,
} from '../application/ports.js';
import type { ApprovalTransactions } from '../application/ports.js';
import type { ApprovalListRow } from '../domain/approval-list.js';
import { InMemoryApprovalListReader } from '../infrastructure/approval-list.readers.js';

/*
 * US-057 — APV-01 pelo pipeline HTTP completo (autenticação, tenant, vínculo, validação Zod, filtro
 * RFC 9457) com a identidade fake e o leitor em memória (os predicados puros do domínio — a
 * cobertura POL-03 como filtro). Personas: Ana no papel de "Beatriz" (titular da Secretaria de
 * Obras e, num cenário, detentora de um perfil aprovador com escopo na secretaria); Fábio (vínculo
 * nos tenants A e B); Lúcia com um perfil sem `APPROVAL_VIEW` e sem cobertura (lista vazia, nunca
 * 403). O SQL, a RLS e a decisão concorrente de ponta a ponta estão em
 * `test/tenant-leak/approvals-list.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-19T15:00:00.000Z');
const ORG = '0192e057-0000-7000-8000-0000000000a0';
const OBRAS = '0192e057-0000-7000-8000-0000000000a1';
const SAUDE = '0192e057-0000-7000-8000-0000000000a2';
const SETOR = '0192e057-0000-7000-8000-0000000000a3';
const ANA = FAKE_USERS.ana.id;
const FABIO = FAKE_USERS.fabio.id;
const LUCIA = FAKE_USERS.lucia.id;

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';
const aid = (n: number) => `0192e057-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** Aprovação de etapa pendente para o titular de Obras, solicitada por Lúcia. */
function approval(
  n: number,
  patch: Partial<ApprovalListRow> = {},
  process: Partial<ApprovalListRow['process']> = {},
): ApprovalListRow {
  return {
    tenantId: A,
    id: aid(n),
    processId: aid(1000 + n),
    subjectType: 'PROCESS_STAGE',
    title: 'Aprovação do DFD',
    documentId: null,
    status: 'PENDING',
    requestedById: LUCIA,
    requestedAt: new Date(`2026-10-${String(10 + n).padStart(2, '0')}T15:00:00.000Z`),
    dueAt: null,
    approverType: 'DEPARTMENT_HEAD',
    approverUserId: ANA,
    approverRoleId: null,
    approverDepartmentId: OBRAS,
    allowDeputy: false,
    decidedById: null,
    process: {
      code: `${String(n).padStart(4, '0')}/2026`,
      number: n,
      year: 2026,
      title: `Processo sigiloso de teste ${String(n)}`,
      organizationId: ORG,
      requestingSecretariatId: OBRAS,
      requestingDepartmentId: SETOR,
      isBudgetConfidential: false,
      ...process,
    },
    ...patch,
  };
}

class FlakyTransactions implements ApprovalTransactions {
  failure: Error | null = null;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.read(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.failure ? Promise.reject(this.failure) : runSimulatedTransaction(work);
  }
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Lista de aprovações (US-057)', () => {
  let api: TestApi;
  let approverRoleId = '';
  const reader = new InMemoryApprovalListReader();
  const transactions = new FlakyTransactions();

  const get = (query: string, subject = 'sub-ana', tenantId: string = A) =>
    request(api.server)
      .get(`/api/v1/approvals${query}`)
      .set('Authorization', api.bearer(subject))
      .set('X-Tenant-Id', tenantId);
  const list = async (
    query = '',
    subject = 'sub-ana',
    tenantId: string = A,
  ): Promise<ApprovalListResponse> => {
    const response = await get(query, subject, tenantId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return approvalListResponseSchema.parse(response.body);
  };
  const ids = (body: ApprovalListResponse) => body.data.map((item) => item.id);
  const unassign = (record: ReturnType<typeof assignRole>) => {
    unassignRole(api, record);
  };

  beforeAll(async () => {
    api = await createTestApi({
      providers: [
        { token: APPROVAL_LIST_READER, value: reader },
        { token: APPROVAL_TRANSACTIONS, value: transactions },
        { token: APPROVAL_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A, ['catalog.items', 'access.defaultRoles']);
    seedDepartment(api, {
      tenantId: A,
      id: OBRAS,
      organizationId: ORG,
      name: 'Secretaria de Obras',
      headUserId: ANA,
    });
    seedDepartment(api, {
      tenantId: A,
      id: SAUDE,
      organizationId: ORG,
      name: 'Secretaria de Saúde',
      headUserId: FABIO,
    });
    seedDepartment(api, { tenantId: A, id: SETOR, organizationId: ORG, name: 'Setor de Projetos' });
    // Perfil aprovador com escopo só na Secretaria de Obras (POL-03 por perfil).
    const approver = seedCustomRole(api, A, 'Aprovador de Obras', ['APPROVAL_VIEW']);
    approverRoleId = approver.id;
    // Lúcia: só consulta processos — sem APPROVAL_VIEW e sem cobertura.
    const viewOnly = seedCustomRole(api, A, 'Somente consulta', ['PROCESS_VIEW']);
    assignRole(api, { tenantId: A, membershipId: membershipOf(LUCIA), roleId: viewOnly.id });
  });

  afterAll(async () => {
    await api.close();
  });

  beforeEach(() => {
    reader.clear();
    transactions.failure = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('[Sucesso]', () => {
    it('Ver aprovações pendentes da minha cobertura (titular da secretaria, DEPARTMENT_HEAD)', async () => {
      reader.seed([
        approval(
          1,
          { dueAt: new Date('2026-10-18T02:59:59.999Z') },
          { isBudgetConfidential: true },
        ),
      ]);
      const body = await list();
      expect(body.meta).toEqual({ page: 1, pageSize: 20, totalItems: 1, totalPages: 1 });
      expect(body.data[0]).toEqual({
        id: aid(1),
        subjectType: 'PROCESS_STAGE',
        title: 'Aprovação do DFD',
        status: 'PENDING',
        process: { id: aid(1001), code: '0001/2026', title: 'Processo sigiloso de teste 1' },
        document: null,
        requestingDepartment: { id: SETOR, name: 'Setor de Projetos' },
        requestedBy: { id: LUCIA, name: FAKE_USERS.lucia.name },
        requestedAt: '2026-10-11T15:00:00.000Z',
        dueAt: '2026-10-18T02:59:59.999Z',
        // RN-INBOX-16: `dueAt` vencido enquanto pendente.
        isOverdue: true,
        approver: {
          type: 'DEPARTMENT_HEAD',
          label: `${FAKE_USERS.ana.name} (titular da Secretaria de Obras)`,
        },
        isBudgetConfidential: true,
      });
      // FA-04: nenhum valor monetário na linha.
      expect(JSON.stringify(body)).not.toMatch(/estimatedValue/);
    });

    it('FA-02: aprovação por perfil mostra "Aguardando: qualquer titular de {perfil}"', async () => {
      const assignment = assignRole(api, {
        tenantId: A,
        membershipId: membershipOf(ANA),
        roleId: approverRoleId,
        scopeType: 'DEPARTMENT',
        scopeDepartmentId: OBRAS,
      });
      try {
        reader.seed([
          approval(2, {
            approverType: 'ROLE',
            approverRoleId,
            approverUserId: null,
            approverDepartmentId: null,
          }),
          // Mesmo perfil, mas o processo é da Saúde: o escopo da atribuição não cobre.
          approval(
            3,
            {
              approverType: 'ROLE',
              approverRoleId,
              approverUserId: null,
              approverDepartmentId: null,
            },
            { requestingSecretariatId: SAUDE, requestingDepartmentId: SAUDE },
          ),
        ]);
        const body = await list();
        expect(ids(body)).toEqual([aid(2)]);
        expect(body.data[0]?.approver).toEqual({
          type: 'ROLE',
          label: 'Aguardando: qualquer titular de Aprovador de Obras',
        });
      } finally {
        unassign(assignment);
      }
    });

    it('filtros: status múltiplo, tipo, unidade solicitante, período e busca; ordena e pagina', async () => {
      reader.seed([
        approval(1),
        approval(2, { status: 'APPROVED', decidedById: ANA }),
        approval(3, { status: 'REJECTED', decidedById: ANA }),
        approval(4, { subjectType: 'DOCUMENT', documentId: aid(4000), title: 'ETP avulso' }),
        approval(5, {}, { requestingDepartmentId: OBRAS, title: 'Pavimentação da avenida' }),
        approval(6, { status: 'CANCELED' }),
      ]);
      // Padrão: PENDING, -requestedAt.
      expect(ids(await list())).toEqual([aid(5), aid(4), aid(1)]);
      expect(ids(await list('?status=APPROVED,REJECTED'))).toEqual([aid(3), aid(2)]);
      expect(ids(await list('?status=APPROVED&status=CANCELED'))).toEqual([aid(6), aid(2)]);
      const documents = await list('?subjectType=DOCUMENT');
      expect(documents.data[0]?.document).toEqual({ id: aid(4000) });
      expect(ids(documents)).toEqual([aid(4)]);
      expect(ids(await list(`?requestingDepartmentId=${OBRAS}`))).toEqual([aid(5), aid(4), aid(1)]);
      expect(ids(await list(`?requestingDepartmentId=${SETOR}`))).toEqual([aid(4), aid(1)]);
      expect(ids(await list('?requestedFrom=2026-10-14&requestedTo=2026-10-15'))).toEqual([
        aid(5),
        aid(4),
      ]);
      expect(ids(await list('?q=pavimentacao'))).toEqual([aid(5)]);
      expect(ids(await list('?q=0004'))).toEqual([aid(4)]);
      expect(ids(await list('?sort=code'))).toEqual([aid(1), aid(4), aid(5)]);
      const page2 = await list('?sort=requestedAt&page=2&pageSize=2');
      expect(ids(page2)).toEqual([aid(5)]);
      expect(page2.meta).toEqual({ page: 2, pageSize: 2, totalItems: 3, totalPages: 2 });
    });

    it('FA-01: sem pendências responde data [] (a UI mostra o estado vazio)', async () => {
      const body = await list();
      expect(body.data).toEqual([]);
      expect(body.meta.totalItems).toBe(0);
    });

    it('registra info approvals.query sem título do processo nem a busca', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      reader.seed([approval(1)]);
      await list('?q=sigiloso');
      const entry = log.mock.calls.find(([message]) => {
        const record = message as { event?: string };
        return record.event === 'approvals.query';
      })?.[0] as Record<string, unknown> | undefined;
      expect(entry).toMatchObject({
        resultCount: 1,
        tenantId: A,
        userId: ANA,
      });
      expect(entry?.filters).toMatchObject({ statuses: ['PENDING'], hasSearch: true });
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/sigiloso/i);
    });
  });

  describe('[Validação]', () => {
    it('período invertido → 422 "O período informado é inválido."', async () => {
      const body = expectProblem(
        await get('?requestedFrom=2026-10-20&requestedTo=2026-10-01'),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors).toEqual([
        expect.objectContaining({
          field: 'requestedTo',
          message: 'O período informado é inválido.',
        }),
      ]);
    });

    it('status/subjectType fora do enum → INVALID_ENUM; pageSize acima de 100; sort fora da lista', async () => {
      const status = expectProblem(await get('?status=DONE'), 422, 'VALIDATION_ERROR');
      expect(status.errors[0]).toMatchObject({ code: 'INVALID_ENUM' });
      expect(status.errors[0]?.field).toMatch(/^status/);
      const subject = expectProblem(await get('?subjectType=PROCESS'), 422, 'VALIDATION_ERROR');
      expect(subject.errors[0]).toMatchObject({ field: 'subjectType', code: 'INVALID_ENUM' });
      const size = expectProblem(await get('?pageSize=101'), 422, 'VALIDATION_ERROR');
      expect(size.errors[0]).toMatchObject({ field: 'pageSize', code: 'OUT_OF_RANGE' });
      const sort = expectProblem(await get('?sort=title'), 422, 'VALIDATION_ERROR');
      expect(sort.errors[0]).toMatchObject({ field: 'sort', code: 'INVALID_ENUM' });
    });

    it('unidade inexistente ou de outro tenant → 422 REFERENCE_NOT_FOUND', async () => {
      const body = expectProblem(
        await get(`?requestingDepartmentId=${aid(999)}`),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors).toEqual([
        expect.objectContaining({
          field: 'requestingDepartmentId',
          code: 'REFERENCE_NOT_FOUND',
          message: 'Selecione uma unidade válida.',
        }),
      ]);
    });
  });

  describe('[Permissão]', () => {
    it('aprovação cujo approverDepartmentId é outra secretaria não aparece', async () => {
      reader.seed([
        approval(1),
        approval(2, { approverDepartmentId: SAUDE, approverUserId: FABIO }),
      ]);
      expect(ids(await list())).toEqual([aid(1)]);
      // Para o titular da Saúde, só a dele.
      expect(ids(await list('', 'sub-fabio'))).toEqual([aid(2)]);
    });

    it('substituto só vê com allowDeputy; aprovação direta só para o aprovador', async () => {
      seedDepartment(api, {
        tenantId: A,
        id: aid(500),
        organizationId: ORG,
        name: 'Secretaria de Educação',
        headUserId: LUCIA,
        deputyUserId: ANA,
      });
      reader.seed([
        approval(1, { approverDepartmentId: aid(500), approverUserId: LUCIA }),
        approval(2, { approverDepartmentId: aid(500), approverUserId: LUCIA, allowDeputy: true }),
        approval(3, { approverType: 'USER', approverUserId: ANA, approverDepartmentId: null }),
        approval(4, { approverType: 'USER', approverUserId: FABIO, approverDepartmentId: null }),
      ]);
      expect(ids(await list())).toEqual([aid(3), aid(2)]);
    });

    it('sem APPROVAL_VIEW e sem cobertura: 200 com lista vazia (nunca 403)', async () => {
      reader.seed([approval(1)]);
      const body = await list('', 'sub-lucia');
      expect(body.data).toEqual([]);
    });

    it('sem autenticação → 401', async () => {
      const response = await request(api.server).get('/api/v1/approvals').set('X-Tenant-Id', A);
      expectProblem(response, 401, 'UNAUTHENTICATED');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('aprovação de outro tenant para o mesmo usuário nunca aparece', async () => {
      const direct = {
        approverType: 'USER',
        approverUserId: FABIO,
        approverDepartmentId: null,
      } as const;
      reader.seed([approval(1, direct), { ...approval(2, direct), tenantId: B }]);
      expect(ids(await list('', 'sub-fabio'))).toEqual([aid(1)]);
      expect(ids(await list('', 'sub-fabio', B))).toEqual([aid(2)]);
      // Sem vínculo no tenant B, a consulta nem chega à lista.
      expect((await get('', 'sub-ana', B)).status).toBe(403);
    });
  });

  describe('[Duplicidade]', () => {
    it('titular e detentor do perfil (duas atribuições) — a aprovação aparece exatamente uma vez', async () => {
      const assignments = [
        assignRole(api, {
          tenantId: A,
          membershipId: membershipOf(ANA),
          roleId: approverRoleId,
          scopeType: 'DEPARTMENT',
          scopeDepartmentId: OBRAS,
        }),
        assignRole(api, { tenantId: A, membershipId: membershipOf(ANA), roleId: approverRoleId }),
      ];
      try {
        reader.seed([
          approval(1, {
            approverType: 'ROLE',
            approverRoleId,
            approverUserId: null,
            approverDepartmentId: OBRAS,
          }),
          approval(2),
        ]);
        const body = await list();
        expect(ids(body)).toEqual([aid(2), aid(1)]);
        expect(body.meta.totalItems).toBe(2);
      } finally {
        for (const assignment of assignments) {
          unassign(assignment);
        }
      }
    });
  });

  describe('[Concorrência]', () => {
    it('decidida por outra pessoa enquanto a lista está aberta: some de PENDING na atualização', async () => {
      const pending = approval(1, { allowDeputy: true });
      reader.seed([pending, approval(2)]);
      expect(ids(await list())).toEqual([aid(2), aid(1)]);
      // O substituto decidiu por titularidade.
      reader.replace({ ...pending, status: 'APPROVED', decidedById: FABIO });
      expect(ids(await list())).toEqual([aid(2)]);
      // Ainda é da cobertura de Ana (titular): aparece filtrando por APPROVED.
      expect(ids(await list('?status=APPROVED'))).toEqual([aid(1)]);
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível → 503 DEPENDENCY_UNAVAILABLE com Retry-After e error approvals.query_failed', async () => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      transactions.failure = new DatabaseUnavailableError(new Error('ECONNREFUSED'));
      const response = await get('');
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'approvals.query_failed',
          errorCode: 'DEPENDENCY_UNAVAILABLE',
        }),
        'approvals.query_failed',
      );
    });

    it('statement_timeout vira 503 (consulta acima do teto)', async () => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      transactions.failure = Object.assign(
        new Error('canceling statement due to statement timeout'),
        { code: 'P2010', meta: { code: '57014' } },
      );
      expectProblem(await get(''), 503, 'DEPENDENCY_UNAVAILABLE');
    });
  });

  describe('[Falha de integração]', () => {
    it('Redis indisponível: APV-01 responde 200 direto do banco e o APV-03 registra warn idempotency.store_unavailable', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const degradedReader = new InMemoryApprovalListReader();
      const degraded = await createTestApi({
        stores: 'redis',
        providers: [
          { token: APPROVAL_LIST_READER, value: degradedReader },
          { token: APPROVAL_CLOCK, value: () => NOW },
          { token: CATALOG_CLOCK, value: () => NOW },
        ],
      });
      try {
        await runTenantSeeders(degraded, A, ['catalog.items', 'access.defaultRoles']);
        seedDepartment(degraded, {
          tenantId: A,
          id: OBRAS,
          organizationId: ORG,
          name: 'Secretaria de Obras',
          headUserId: ANA,
        });
        degradedReader.seed([approval(1), approval(2)]);
        const auth = (call: request.Test) =>
          call
            .set('Authorization', degraded.bearer('sub-ana', { amr: ['pwd', 'otp'] }))
            .set('X-Tenant-Id', A);
        const listed = await auth(request(degraded.server).get('/api/v1/approvals'));
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        expect(approvalListResponseSchema.parse(listed.body).meta.totalItems).toBe(2);
        // Decisão com chave: sem Redis, segue sem idempotência (a aprovação inexiste aqui → 404).
        const decided = await auth(
          request(degraded.server).post(`/api/v1/approvals/${aid(1)}/decide`),
        )
          .set('If-Match', '"1"')
          .set('Idempotency-Key', randomUUID())
          .send({ decision: 'APPROVE' });
        expect(decided.status, JSON.stringify(decided.body)).toBe(404);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^idempotency\.store_unavailable/));
      } finally {
        await degraded.close();
      }
    });
  });
});
