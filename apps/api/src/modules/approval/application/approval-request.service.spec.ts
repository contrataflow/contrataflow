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

import { ApprovalRequestService } from './approval-request.service.js';
import type { StageApprovalRequest } from './approval-request.service.js';
import type { ApproverResolver, StageApprover } from './approver-resolver.js';
import { PendingApprovalExistsError } from './ports.js';
import type { ApprovalRepository } from './ports.js';
import { InMemoryApprovalRepository } from '../infrastructure/approval.repositories.js';

/*
 * US-051 — a solicitação de aprovação dentro da transação de origem: aprovação + cobertura,
 * `approval.request`, `ApprovalRequested`, o conflito da pendência única e os logs/métricas.
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

const head: StageApprover = {
  approverType: 'DEPARTMENT_HEAD',
  approverUserId: HEAD,
  approverRoleId: null,
  approverDepartmentId: UNIT,
  allowDeputy: true,
  label: 'Marta (titular da Secretaria de Obras)',
};

const stageRequest = (overrides: Partial<StageApprovalRequest> = {}): StageApprovalRequest => ({
  approvalId: id(20),
  processId: PROCESS,
  processStageId: STAGE,
  stageName: 'Aprovação da autoridade competente',
  approver: head,
  coverage: [{ documentId: DOCUMENT, documentVersionId: VERSION, documentCode: 'TR 0004/2026' }],
  requestedById: ACTOR,
  requestedAt: NOW,
  requestComment: SECRET_COMMENT,
  dueAt: DUE,
  ...overrides,
});

function setup(repository: ApprovalRepository = new InMemoryApprovalRepository()) {
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
    resolve: (...args: unknown[]) => {
      resolved.push(args.slice(1));
      return Promise.resolve(head);
    },
  } as unknown as ApproverResolver;
  return {
    service: new ApprovalRequestService(repository, audit, outbox, resolver),
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
      title: 'Aprovação de Aprovação da autoridade competente — TR 0004/2026',
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
        expect.objectContaining({
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
        }),
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
