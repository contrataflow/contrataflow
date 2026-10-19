import { describe, expect, it } from 'vitest';

import type { TenantTx } from '#shared/database/prisma.js';

import type { ApprovalCancellationService } from './approval-cancellation.service.js';
import type { ApprovalRequestService } from './approval-request.service.js';
import { ApprovalFacade } from './approval.facade.js';
import type { ApproverResolver } from './approver-resolver.js';
import type { ApprovalRepository } from './ports.js';
import type { Approval } from '../domain/approval.js';

const PROCESS = '0192d004-0000-7000-8000-000000000001';

const approval: Approval = {
  id: '0192d004-0000-7000-8000-000000000002',
  tenantId: '0192d004-0000-7000-8000-000000000003',
  processId: PROCESS,
  subjectType: 'PROCESS_STAGE',
  processStageId: '0192d004-0000-7000-8000-000000000004',
  documentId: null,
  title: 'Aprovação da autoridade',
  requestedById: '0192d004-0000-7000-8000-000000000005',
  requestedAt: new Date('2026-10-05T12:00:00.000Z'),
  requestComment: 'comentário que o painel não expõe',
  approverType: 'USER',
  approverUserId: '0192d004-0000-7000-8000-000000000006',
  approverRoleId: null,
  approverDepartmentId: null,
  allowDeputy: false,
  dueAt: null,
  status: 'PENDING',
  createdAt: new Date('2026-10-05T12:00:00.000Z'),
  createdById: '0192d004-0000-7000-8000-000000000005',
};

/** US-052: a decisão não é exercida por estes testes da fachada. */
const DECISION_STUBS = {
  findById: () => Promise.resolve(null),
  lockForUpdate: () => Promise.resolve(null),
  recordDecision: () => Promise.resolve(false),
} satisfies Pick<ApprovalRepository, 'findById' | 'lockForUpdate' | 'recordDecision'>;

describe('ApprovalFacade', () => {
  it('listPendingForProcess: as aprovações pendentes do processo, sem o comentário do pedido', async () => {
    const asked: string[] = [];
    const repository: ApprovalRepository = {
      ...DECISION_STUBS,
      insert: () => Promise.resolve(),
      cancelPendingByProcess: () => Promise.resolve([]),
      findPendingForStage: () => Promise.resolve(null),
      updatePendingDueAt: () => Promise.resolve(false),
      coversDocumentVersion: () => Promise.resolve(false),
      summariesByIds: () => Promise.resolve([]),
      listPendingByProcess: (_tx, processId) => {
        asked.push(processId);
        return Promise.resolve([approval]);
      },
    };
    const facade = new ApprovalFacade(
      repository,
      {} as ApproverResolver,
      {} as ApprovalRequestService,
      {} as ApprovalCancellationService,
    );
    const pending = await facade.listPendingForProcess({} as TenantTx, PROCESS);
    expect(asked).toEqual([PROCESS]);
    expect(pending).toEqual([
      {
        id: approval.id,
        title: 'Aprovação da autoridade',
        processStageId: approval.processStageId,
        documentId: null,
        approverType: 'USER',
        approverUserId: approval.approverUserId,
        approverRoleId: null,
        approverDepartmentId: null,
        allowDeputy: false,
        requestedAt: approval.requestedAt,
        dueAt: null,
      },
    ]);
  });

  it('approvalSummaries (US-054): uma leitura para os ids distintos; sem ids, nenhuma', async () => {
    const asked: (readonly string[])[] = [];
    const repository: ApprovalRepository = {
      ...DECISION_STUBS,
      insert: () => Promise.resolve(),
      cancelPendingByProcess: () => Promise.resolve([]),
      findPendingForStage: () => Promise.resolve(null),
      updatePendingDueAt: () => Promise.resolve(false),
      coversDocumentVersion: () => Promise.resolve(false),
      listPendingByProcess: () => Promise.resolve([]),
      summariesByIds: (_tx, ids) => {
        asked.push(ids);
        return Promise.resolve([
          { id: approval.id, title: 'Aprovação do TR', status: 'APPROVED', decision: 'APPROVE' },
        ]);
      },
    };
    const facade = new ApprovalFacade(
      repository,
      {} as ApproverResolver,
      {} as ApprovalRequestService,
      {} as ApprovalCancellationService,
    );
    await expect(facade.approvalSummaries({} as TenantTx, [])).resolves.toEqual(new Map());
    const summaries = await facade.approvalSummaries({} as TenantTx, [approval.id, approval.id]);
    expect(asked).toEqual([[approval.id]]);
    expect(summaries.get(approval.id)).toEqual({
      title: 'Aprovação do TR',
      status: 'APPROVED',
      decision: 'APPROVE',
    });
  });

  it('extendPendingStageDueAtIn (US-008): estende o prazo da aprovação pendente da passagem', async () => {
    const pending = { ...approval, dueAt: new Date('2026-10-09T02:59:59.999Z') };
    const updates: unknown[] = [];
    const repository: ApprovalRepository = {
      ...DECISION_STUBS,
      insert: () => Promise.resolve(),
      cancelPendingByProcess: () => Promise.resolve([]),
      coversDocumentVersion: () => Promise.resolve(false),
      summariesByIds: () => Promise.resolve([]),
      listPendingByProcess: () => Promise.resolve([]),
      findPendingForStage: (_tx, stageId) =>
        Promise.resolve(stageId === pending.processStageId ? pending : null),
      updatePendingDueAt: (_tx, ...args) => {
        updates.push(args);
        return Promise.resolve(true);
      },
    };
    const facade = new ApprovalFacade(
      repository,
      {} as ApproverResolver,
      {} as ApprovalRequestService,
      {} as ApprovalCancellationService,
    );
    const to = new Date('2026-10-14T02:59:59.999Z');
    const at = new Date('2026-10-08T12:00:00.000Z');
    const extended = await facade.extendPendingStageDueAtIn(
      {} as TenantTx,
      pending.processStageId ?? '',
      () => Promise.resolve(to),
      at,
      'actor',
    );
    expect(extended).toEqual({ approvalId: pending.id, from: pending.dueAt, to });
    expect(updates).toEqual([[pending.id, to, at, 'actor']]);

    // Outra passagem, prazo igual ou sem prazo: nada muda.
    await expect(
      facade.extendPendingStageDueAtIn(
        {} as TenantTx,
        'outra',
        () => Promise.resolve(to),
        at,
        null,
      ),
    ).resolves.toBeNull();
    await expect(
      facade.extendPendingStageDueAtIn(
        {} as TenantTx,
        pending.processStageId ?? '',
        (dueAt) => Promise.resolve(dueAt),
        at,
        null,
      ),
    ).resolves.toBeNull();
    expect(updates).toHaveLength(1);
  });
});
