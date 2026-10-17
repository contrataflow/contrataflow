import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import type {
  DocumentApprovalRequest,
  DocumentApprovalRequester,
} from '#shared/document/document-approval.js';
import { ApiError } from '#shared/errors/api-error.js';

import { APPROVAL_REPOSITORY, PendingApprovalExistsError } from './ports.js';
import type { ApprovalRepository } from './ports.js';
import {
  ApproverUnresolvedError,
  documentApprovalTitle,
  resolveDocumentApprover,
} from '../domain/approval.js';
import type { Approval } from '../domain/approval.js';

/**
 * Lado `approval` da porta `DocumentApprovalRegistry` (US-065 · DOC-09 · DEC-022 · RN-TRAM-43/51/52):
 * a `Approval` `PENDING` da submissão avulsa (`subjectType = DOCUMENT`, sem prazo — `dueAt` nulo),
 * com o aprovador resolvido NA SOLICITAÇÃO pela política do tipo e a versão exata analisada em
 * `approval_documents`, no `tx` da submissão (falha desfaz tudo). Aprovador irresolvível → 422
 * `APPROVER_UNRESOLVED`. A US-051 acrescenta o titular da unidade, o evento `ApprovalRequested`,
 * a timeline `APPROVAL_REQUESTED` e a concessão `APPROVER`.
 */
@Injectable()
export class DocumentApprovalRequestService implements DocumentApprovalRequester {
  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly approvals: ApprovalRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
  ) {}

  async requestForDocumentSubmission(
    tx: TenantTx,
    request: DocumentApprovalRequest,
  ): Promise<void> {
    const tenantId = requireRequestContext().tenantId;
    if (tenantId === null) throw new ApiError('UNAUTHENTICATED');
    let approver;
    try {
      approver = resolveDocumentApprover(request.policy, request);
    } catch (error) {
      if (error instanceof ApproverUnresolvedError) throw new ApiError('APPROVER_UNRESOLVED');
      throw error;
    }
    const approval: Approval = {
      id: request.approvalId,
      tenantId,
      processId: request.processId,
      subjectType: 'DOCUMENT',
      processStageId: null,
      documentId: request.documentId,
      title: documentApprovalTitle(
        request.documentTypeName,
        request.documentCode,
        request.documentTitle,
      ),
      requestedById: request.requestedById,
      requestedAt: request.requestedAt,
      requestComment: null,
      ...approver,
      dueAt: null,
      status: 'PENDING',
      createdAt: request.requestedAt,
      createdById: request.requestedById,
    };
    try {
      await this.approvals.insert(tx, approval, [
        {
          id: newId(),
          documentId: request.documentId,
          documentVersionId: request.documentVersionId,
        },
      ]);
    } catch (error) {
      if (error instanceof PendingApprovalExistsError) {
        throw new ApiError('INVALID_STATE', {
          detail: 'Este documento já tem uma aprovação em andamento.',
        });
      }
      throw error;
    }
    await this.audit.record(tx, {
      action: 'approval.request',
      entityType: 'Approval',
      entityId: approval.id,
      processId: approval.processId,
      metadata: {
        subjectType: approval.subjectType,
        documentId: request.documentId,
        documentVersionId: request.documentVersionId,
        documentCode: request.documentCode,
        approverType: approval.approverType,
        approverUserId: approval.approverUserId,
        approverRoleId: approval.approverRoleId,
        approverDepartmentId: approval.approverDepartmentId,
      },
    });
  }

  /** Selo de aprovação (US-067 · FA-02): a aprovação cobre a versão (`approval_documents`). */
  coversDocumentVersion(
    tx: TenantTx,
    approvalId: string,
    documentId: string,
    documentVersionId: string,
  ): Promise<boolean> {
    return this.approvals.coversDocumentVersion(tx, approvalId, documentId, documentVersionId);
  }
}
