import { describe, expect, it } from 'vitest';

import type { TenantTx } from '#shared/database/prisma.js';

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

describe('ApprovalFacade', () => {
  it('listPendingForProcess: as aprovações pendentes do processo, sem o comentário do pedido', async () => {
    const asked: string[] = [];
    const repository: ApprovalRepository = {
      insert: () => Promise.resolve(),
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
      insert: () => Promise.resolve(),
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
});
