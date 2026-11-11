import type { DomainEventDraft } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import type { AuditEntry, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import type { DocumentApprovalRequest } from '#shared/document/document-approval.js';
import { ApiError } from '#shared/errors/api-error.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import type { ApprovalDecisionPolicy } from './approval-decision.policy.js';
import { ApprovalRequestService } from './approval-request.service.js';
import type { ApprovalPlan, StageApprovalRequest } from './approval-request.service.js';
import type { ApproverResolver } from './approver-resolver.js';
import { PendingApprovalExistsError } from './ports.js';
import type { ApprovalRepository } from './ports.js';
import type { ResolvedApprovalLine } from '../domain/approval-lines.js';
import { InMemoryApprovalRepository } from '../infrastructure/approval.repositories.js';

/*
 * US-051/US-133 — a solicitação de aprovação dentro da transação de origem: aprovação + linhas +
 * cobertura, `approval.request`, `ApprovalRequested`, o conflito da pendência única, a segregação
 * por linha, a pessoa única e os logs/métricas.
 */

const id = (n: number) => `0192f051-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANT = id(1);
const PROCESS = id(2);
const STAGE = id(3);
const DOCUMENT = id(4);
const VERSION = id(5);
const ACTOR = id(6);
const HEAD = id(7);
const UNIT = id(8);
const NOW = new Date('2026-10-18T12:00:00.000Z');
const DUE = new Date('2026-10-25T02:59:59.999Z');
const TX = {} as TenantTx;
const SECRET_COMMENT = 'comentário que nunca vai para o log';

const DEPUTY = id(9);
const MARCOS = id(10);
const ROLE = id(11);

const headLine: ResolvedApprovalLine = {
  sequence: 1,
  approverType: 'DEPARTMENT_HEAD',
  approverUserId: HEAD,
  approverRoleId: null,
  approverDepartmentId: UNIT,
  allowDeputy: true,
  configuredLabel: null,
};
const userLine = (sequence: number, userId: string): ResolvedApprovalLine => ({
  sequence,
  approverType: 'USER',
  approverUserId: userId,
  approverRoleId: null,
  approverDepartmentId: null,
  allowDeputy: false,
  configuredLabel: null,
});
const roleLine = (sequence: number): ResolvedApprovalLine => ({
  sequence,
  approverType: 'ROLE',
  approverUserId: null,
  approverRoleId: ROLE,
  approverDepartmentId: null,
  allowDeputy: false,
  configuredLabel: null,
});

/** Plano já resolvido (a resolução por linha é do `ApproverResolver`). */
const planOf = (
  decisionPolicy: ApprovalPlan['config']['decisionPolicy'],
  lines: readonly ResolvedApprovalLine[],
  deputies: ReadonlyMap<string, string | null> = new Map([[UNIT, DEPUTY]]),
): ApprovalPlan => ({
  config: {
    decisionPolicy,
    listed: lines.length > 1,
    lines: lines.map((line) => ({
      sequence: line.sequence,
      approverType: line.approverType,
      approverUserId: line.approverUserId,
      approverRoleId: line.approverRoleId,
      approverDepartmentResolution: line.approverType === 'DEPARTMENT_HEAD' ? 'FIXED' : null,
      approverFixedDepartmentId: line.approverDepartmentId,
      label: null,
    })),
  },
  resolved: { lines, deputies },
});

const LABELS: Readonly<Record<string, string>> = {
  [HEAD]: 'Marta (titular da Secretaria de Obras)',
  [DEPUTY]: 'Fábio (em substituição ao titular da Secretaria de Obras)',
  [MARCOS]: 'Marcos',
};

const stageRequest = (overrides: Partial<StageApprovalRequest> = {}): StageApprovalRequest => ({
  approvalId: id(20),
  processId: PROCESS,
  processStageId: STAGE,
  stageName: 'Aprovação da autoridade competente',
  plan: planOf('ANY', [headLine]),
  coverage: [{ documentId: DOCUMENT, documentVersionId: VERSION, documentCode: 'TR 0004/2026' }],
  authorIds: () => Promise.resolve([]),
  requestedById: ACTOR,
  requestedAt: NOW,
  requestComment: SECRET_COMMENT,
  dueAt: DUE,
  ...overrides,
});

function setup(
  repository: ApprovalRepository = new InMemoryApprovalRepository(),
  preventSelfApproval = true,
) {
  const audits: AuditEntry[] = [];
  const events: DomainEventDraft[] = [];
  const audit = {
    record: (_tx: TenantTx, entry: AuditEntry) => {
      audits.push(entry);
      return Promise.resolve('recorded');
    },
  } as unknown as AuditTrailPort;
  const outbox = {
    record: (_tx: TenantTx, event: DomainEventDraft) => {
      events.push(event);
      return Promise.resolve(event);
    },
  } as unknown as OutboxWriterPort;
  const resolved: unknown[] = [];
  const resolver = {
    resolveLines: (...args: unknown[]) => {
      resolved.push(args.slice(1));
      return Promise.resolve(planOf('ANY', [headLine]).resolved);
    },
    labelOf: (_tx: TenantTx, line: { approverUserId: string | null }) =>
      Promise.resolve(LABELS[line.approverUserId ?? ''] ?? 'Autoridade competente'),
  } as unknown as ApproverResolver;
  const policy = {
    preventsSelfApprovalIn: () => Promise.resolve(preventSelfApproval),
  } as unknown as ApprovalDecisionPolicy;
  return {
    service: new ApprovalRequestService(repository, audit, outbox, resolver, policy),
    audits,
    events,
    resolved,
    repository,
  };
}

const inContext = <T>(work: () => Promise<T>) =>
  runWithRequestContext({ correlationId: 'corr-051', ip: '', userAgent: '' }, () => {
    updateRequestContext({ tenantId: TENANT });
    return work();
  });

describe('ApprovalRequestService', () => {
  let log: MockInstance<Logger['log']>;
  let error: MockInstance<Logger['error']>;

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disparo A: Approval PENDING com a cobertura, auditoria approval.request e ApprovalRequested', async () => {
    const { service, audits, events, repository } = setup();
    await inContext(() => service.requestForStageEntry(TX, stageRequest()));

    const memory = repository as InMemoryApprovalRepository;
    const [approval] = memory.approvals();
    expect(approval).toMatchObject({
      id: id(20),
      tenantId: TENANT,
      subjectType: 'PROCESS_STAGE',
      processStageId: STAGE,
      title: 'Aprovação da autoridade competente — TR 0004/2026',
      requestComment: SECRET_COMMENT,
      approverUserId: HEAD,
      allowDeputy: true,
      dueAt: DUE,
      status: 'PENDING',
    });
    expect(memory.coverageOf(id(20))).toEqual([
      expect.objectContaining({ documentId: DOCUMENT, documentVersionId: VERSION }),
    ]);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'approval.request',
        entityId: id(20),
        changes: [{ path: 'status', old: null, new: 'PENDING' }],
        metadata: expect.objectContaining({
          documentIds: [DOCUMENT],
          approverUserId: HEAD,
        }) as unknown,
      }),
    ]);
    expect(events.map((event) => event.definition.eventType)).toEqual(['ApprovalRequested']);
    expect(events).toEqual([
      expect.objectContaining({
        aggregateId: id(20),
        processId: PROCESS,
        payload: expect.objectContaining({
          approvalId: id(20),
          documentVersionIds: [VERSION],
          dueAt: DUE.toISOString(),
        }) as unknown,
      }),
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'approval.requested', resolvedVia: 'DEPARTMENT_HEAD' }),
      'approval.requested',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET_COMMENT);
  });

  it('disparo B: resolve pela política e abre a avulsa sem prazo nem comentário', async () => {
    const { service, events, resolved, repository } = setup();
    const request: DocumentApprovalRequest = {
      approvalId: id(21),
      processId: PROCESS,
      documentId: DOCUMENT,
      documentVersionId: VERSION,
      documentCode: null,
      documentTitle: 'Despacho nº 7',
      documentTypeName: 'Despacho',
      policy: {
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
        allowDeputy: false,
      },
      requestedById: ACTOR,
      requestedAt: NOW,
      organizationId: id(30),
      requestingSecretariatId: id(31),
      requestingDepartmentId: id(32),
    };
    await inContext(() => service.requestForDocumentSubmission(TX, request));
    expect(resolved).toEqual([
      [
        {
          decisionPolicy: 'ANY',
          listed: false,
          lines: [
            expect.objectContaining({
              sequence: 1,
              approverType: 'DEPARTMENT_HEAD',
              approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
            }),
          ],
        },
        request,
        NOW,
        'DOCUMENT',
      ],
    ]);
    expect((repository as InMemoryApprovalRepository).approvals()).toEqual([
      expect.objectContaining({
        subjectType: 'DOCUMENT',
        documentId: DOCUMENT,
        processStageId: null,
        title: 'Aprovação avulsa — Despacho "Despacho nº 7"',
        requestComment: null,
        dueAt: null,
        allowDeputy: true,
      }),
    ]);
    expect(events[0]?.payload).toMatchObject({ documentId: DOCUMENT, dueAt: null });
  });

  it('pendência única violada (corrida perdida) → 409 APPROVAL_NOT_PENDING, sem auditoria nem evento', async () => {
    const repository = {
      insert: () => Promise.reject(new PendingApprovalExistsError(STAGE)),
    } as unknown as ApprovalRepository;
    const { service, audits, events } = setup(repository);
    let failure: unknown;
    try {
      await inContext(() => service.requestForStageEntry(TX, stageRequest()));
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      code: 'APPROVAL_NOT_PENDING',
      status: 409,
      detail: 'Já existe uma aprovação em andamento para este item.',
    });
    expect(audits).toEqual([]);
    expect(events).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'approval.request_failed',
        errorCode: 'APPROVAL_NOT_PENDING',
        cause: 'PendingApprovalExistsError',
      }),
      'approval.request_failed',
    );
  });

  it('banco fora no meio da solicitação: loga DEPENDENCY_UNAVAILABLE e propaga o erro original', async () => {
    const lost = Object.assign(new Error('Connection terminated unexpectedly'), {
      code: 'ECONNRESET',
    });
    const repository = { insert: () => Promise.reject(lost) } as unknown as ApprovalRepository;
    const { service } = setup(repository);
    await expect(inContext(() => service.requestForStageEntry(TX, stageRequest()))).rejects.toBe(
      lost,
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'DEPENDENCY_UNAVAILABLE' }),
      'approval.request_failed',
    );
  });

  it('US-133 FA-01: ANY com aprovador único — uma linha sequence 1 PENDING, espelho e evento com a linha', async () => {
    const { service, events, repository } = setup();
    const opened = await inContext(() => service.requestForStageEntry(TX, stageRequest()));
    const memory = repository as InMemoryApprovalRepository;
    expect(memory.linesOf(id(20))).toEqual([
      expect.objectContaining({
        sequence: 1,
        status: 'PENDING',
        activatedAt: NOW,
        dueAt: null,
        approverUserId: HEAD,
        allowDeputy: true,
        createdById: ACTOR,
      }),
    ]);
    expect(memory.approvals()[0]).toMatchObject({ decisionPolicy: 'ANY', approverUserId: HEAD });
    expect(opened).toEqual({
      id: id(20),
      approverLabel: LABELS[HEAD],
      decisionPolicy: 'ANY',
      approvers: [
        {
          id: memory.linesOf(id(20))[0]?.id,
          sequence: 1,
          status: 'PENDING',
          approverType: 'DEPARTMENT_HEAD',
          label: LABELS[HEAD],
        },
      ],
    });
    expect(events[0]?.payload).toMatchObject({
      decisionPolicy: 'ANY',
      approvers: [{ sequence: 1, status: 'PENDING', approverUserId: HEAD, allowDeputy: true }],
    });
  });

  it('US-133 SEQUENTIAL: só a linha 1 PENDING (as demais WAITING, sem activatedAt); auditoria com approversCount e sem nomes', async () => {
    const { service, audits, events, repository } = setup();
    const opened = await inContext(() =>
      service.requestForStageEntry(
        TX,
        stageRequest({ plan: planOf('SEQUENTIAL', [headLine, userLine(2, MARCOS)]) }),
      ),
    );
    const lines = (repository as InMemoryApprovalRepository).linesOf(id(20));
    expect(lines.map((line) => [line.sequence, line.status, line.activatedAt])).toEqual([
      [1, 'PENDING', NOW],
      [2, 'WAITING', null],
    ]);
    expect(opened.approverLabel).toBe(`${LABELS[HEAD] ?? ''}, depois Marcos`);
    expect(audits[0]?.metadata).toMatchObject({
      decisionPolicy: 'SEQUENTIAL',
      approversCount: 2,
      lines: [
        { sequence: 1, approverType: 'DEPARTMENT_HEAD', status: 'PENDING' },
        { sequence: 2, approverType: 'USER', status: 'WAITING' },
      ],
    });
    expect(JSON.stringify(audits)).not.toContain('Marcos');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      decisionPolicy: 'SEQUENTIAL',
      approvers: [
        { sequence: 1, status: 'PENDING' },
        { sequence: 2, status: 'WAITING', approverUserId: MARCOS },
      ],
    });
    expect(JSON.stringify(events)).not.toContain('Marcos');
  });

  it('US-133 ALL: todas PENDING com activatedAt = requestedAt; rótulo "A e B"', async () => {
    const { service, repository } = setup();
    const opened = await inContext(() =>
      service.requestForStageEntry(
        TX,
        stageRequest({ plan: planOf('ALL', [headLine, userLine(2, MARCOS), roleLine(3)]) }),
      ),
    );
    expect(
      (repository as InMemoryApprovalRepository)
        .linesOf(id(20))
        .map((line) => [line.status, line.activatedAt]),
    ).toEqual([
      ['PENDING', NOW],
      ['PENDING', NOW],
      ['PENDING', NOW],
    ]);
    expect(opened.approverLabel).toBe(`${LABELS[HEAD] ?? ''}, Marcos e Autoridade competente`);
  });

  it('US-133 FA-03: titular autor de documento coberto → linha desviada ao substituto (allowDeputy falso) e selfApprovalAvoided na auditoria', async () => {
    const { service, audits, repository } = setup();
    const opened = await inContext(() =>
      service.requestForStageEntry(
        TX,
        stageRequest({
          plan: planOf('ALL', [headLine, userLine(2, MARCOS)]),
          authorIds: () => Promise.resolve([HEAD, ACTOR]),
        }),
      ),
    );
    const memory = repository as InMemoryApprovalRepository;
    expect(memory.linesOf(id(20))[0]).toMatchObject({
      approverType: 'DEPARTMENT_HEAD',
      approverUserId: DEPUTY,
      approverDepartmentId: UNIT,
      allowDeputy: false,
    });
    expect(memory.approvals()[0]).toMatchObject({ approverUserId: DEPUTY, allowDeputy: false });
    expect(audits[0]?.metadata).toMatchObject({
      lines: [{ sequence: 1, selfApprovalAvoided: true }, { sequence: 2 }],
    });
    expect(opened.approvers[0]?.label).toBe(LABELS[DEPUTY]);
  });

  it('US-133 V-03: autor sem substituto elegível (USER, ou titular sem substituto) → 403 SELF_APPROVAL_FORBIDDEN com meta.sequence, nada gravado', async () => {
    const { service, audits, events, repository } = setup();
    const userAuthor = inContext(() =>
      service.requestForStageEntry(
        TX,
        stageRequest({
          plan: planOf('SEQUENTIAL', [headLine, userLine(2, MARCOS)]),
          authorIds: () => Promise.resolve([MARCOS]),
        }),
      ),
    );
    await expect(userAuthor).rejects.toMatchObject({
      code: 'SELF_APPROVAL_FORBIDDEN',
      status: 403,
      detail:
        'O aprovador da linha 2 é autor de um dos documentos e não tem substituto. Fale com o administrador do órgão.',
      extensions: { meta: { sequence: 2 } },
    });
    const noDeputy = inContext(() =>
      service.requestForStageEntry(
        TX,
        stageRequest({
          plan: planOf('ALL', [headLine, userLine(2, MARCOS)], new Map([[UNIT, null]])),
          authorIds: () => Promise.resolve([HEAD]),
        }),
      ),
    );
    await expect(noDeputy).rejects.toMatchObject({
      code: 'SELF_APPROVAL_FORBIDDEN',
      extensions: { meta: { sequence: 1 } },
    });
    const deputyAuthor = inContext(() =>
      service.requestForStageEntry(
        TX,
        stageRequest({
          plan: planOf('ALL', [headLine, userLine(2, MARCOS)]),
          authorIds: () => Promise.resolve([HEAD, DEPUTY]),
        }),
      ),
    );
    await expect(deputyAuthor).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
    expect((repository as InMemoryApprovalRepository).approvals()).toEqual([]);
    expect(audits).toEqual([]);
    expect(events).toEqual([]);
  });

  it('US-133 RN-APV-20: ANY com linha única não avalia a segregação na solicitação (nem lê os autores); sem preventSelfApproval, também não', async () => {
    const authorIds = vi.fn(() => Promise.resolve([HEAD]));
    const { service } = setup();
    await inContext(() => service.requestForStageEntry(TX, stageRequest({ authorIds })));
    expect(authorIds).not.toHaveBeenCalled();

    const relaxed = setup(new InMemoryApprovalRepository(), false);
    await inContext(() =>
      relaxed.service.requestForStageEntry(
        TX,
        stageRequest({
          plan: planOf('ALL', [headLine, userLine(2, MARCOS)]),
          authorIds,
        }),
      ),
    );
    expect(authorIds).not.toHaveBeenCalled();
    expect(
      (relaxed.repository as InMemoryApprovalRepository).linesOf(id(20))[0]?.approverUserId,
    ).toBe(HEAD);
  });

  it('US-133 V-04: a mesma pessoa em duas linhas (inclusive o substituto que repete outra linha) → 422 APPROVER_DUPLICATED', async () => {
    const { service, repository } = setup();
    await expect(
      inContext(() =>
        service.requestForStageEntry(
          TX,
          stageRequest({ plan: planOf('ALL', [headLine, userLine(2, HEAD)]) }),
        ),
      ),
    ).rejects.toMatchObject({
      code: 'APPROVER_DUPLICATED',
      status: 422,
      detail:
        'A mesma pessoa não pode aprovar em duas linhas (1 e 2). Fale com o administrador do órgão.',
      extensions: { meta: { sequences: [1, 2] } },
    });
    await expect(
      inContext(() =>
        service.requestForStageEntry(
          TX,
          stageRequest({
            plan: planOf('ALL', [headLine, userLine(2, DEPUTY)]),
            authorIds: () => Promise.resolve([HEAD]),
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'APPROVER_DUPLICATED' });
    // Perfis repetidos não entram na comparação (RN-APV-21).
    await inContext(() =>
      service.requestForStageEntry(
        TX,
        stageRequest({
          plan: planOf('ANY', [roleLine(1), { ...roleLine(2), approverRoleId: id(12) }]),
        }),
      ),
    );
    expect((repository as InMemoryApprovalRepository).linesOf(id(20))).toHaveLength(2);
  });

  it('US-133 V-06/V-07: configuração inconsistente no runtime → 422 APPROVER_UNRESOLVED com meta.reason', async () => {
    const { service } = setup();
    await expect(
      inContext(() =>
        service.plan(
          TX,
          { decisionPolicy: 'ALL', approvers: [], approverType: 'USER', approverUserId: MARCOS },
          {
            organizationId: id(30),
            requestingSecretariatId: id(31),
            requestingDepartmentId: id(32),
          },
          NOW,
          'PROCESS_STAGE',
        ),
      ),
    ).rejects.toMatchObject({
      code: 'APPROVER_UNRESOLVED',
      detail: 'A aprovação desta etapa está mal configurada. Fale com o administrador do órgão.',
      extensions: { meta: { reason: 'POLICY_INVALID' } },
    });
    const many = Array.from({ length: 21 }, (_, index) => ({
      approverType: 'USER' as const,
      approverUserId: id(100 + index),
    }));
    await expect(
      inContext(() =>
        service.plan(
          TX,
          { decisionPolicy: 'ANY', approvers: many, approverType: 'USER' },
          {
            organizationId: id(30),
            requestingSecretariatId: id(31),
            requestingDepartmentId: id(32),
          },
          NOW,
          'DOCUMENT',
        ),
      ),
    ).rejects.toMatchObject({
      code: 'APPROVER_UNRESOLVED',
      extensions: { meta: { reason: 'LIMIT_EXCEEDED' } },
    });
  });

  it('coversDocumentVersion delega à cobertura gravada', async () => {
    const { service } = setup();
    await inContext(() => service.requestForStageEntry(TX, stageRequest()));
    await expect(
      inContext(() => service.coversDocumentVersion(TX, id(20), DOCUMENT, VERSION)),
    ).resolves.toBe(true);
    await expect(
      inContext(() => service.coversDocumentVersion(TX, id(20), DOCUMENT, id(99))),
    ).resolves.toBe(false);
  });
});
