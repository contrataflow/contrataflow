import { withSpan } from '@contrataflow/observability';
import { ApprovalRequested } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { isTransientDatabaseError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import type {
  DocumentApprovalRequest,
  DocumentApprovalRequester,
} from '#shared/document/document-approval.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { recordApprovalRequested, recordApprovalRequestFailed } from './approval-telemetry.js';
import { ApproverResolver } from './approver-resolver.js';
import type { StageApprover } from './approver-resolver.js';
import { APPROVAL_REPOSITORY, PendingApprovalExistsError } from './ports.js';
import type { ApprovalRepository } from './ports.js';
import {
  approverConfigOfPolicy,
  documentApprovalTitle,
  stageApprovalTitle,
} from '../domain/approval.js';
import type { Approval, ApprovalCoverage } from '../domain/approval.js';

/** V-03 da US-051: a corrida perdida no índice de pendência única (RN-TRAM-43). */
const APPROVAL_NOT_PENDING_MESSAGE = 'Já existe uma aprovação em andamento para este item.';

/** Documento coberto e a versão exata em análise (RN-TRAM-46). */
export interface StageCoverage {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly documentCode: string | null;
}

export interface StageApprovalRequest {
  /** Id gerado por quem encaminha (vai em `pendingApprovalId` dos documentos no mesmo `tx`). */
  readonly approvalId: string;
  readonly processId: string;
  /** Passagem recém-aberta pela etapa `APPROVAL` (gravada antes — FK). */
  readonly processStageId: string;
  readonly stageName: string;
  /** Resolvido ANTES de qualquer escrita do encaminhamento (`ApprovalFacade.resolveStageApproverIn`). */
  readonly approver: StageApprover;
  readonly coverage: readonly StageCoverage[];
  readonly requestedById: string;
  readonly requestedAt: Date;
  readonly requestComment: string | null;
  /** RN-TRAM-51: o prazo da passagem. */
  readonly dueAt: Date | null;
}

/**
 * Solicitação de aprovação (US-051 · DEC-022 · RN-TRAM-43..53), sem comando nem transação própria:
 * roda no `tx` da ação de origem e qualquer falha a desfaz inteira.
 *
 * - **Disparo A — etapa** (`requestForStageEntry`): o encaminhamento (PRC-19) entra numa etapa
 *   `APPROVAL`; o aprovador já foi resolvido e os documentos cobertos já foram submetidos por quem
 *   encaminha (`DocumentFacade.enterApprovalStageIn` — `document` está no mesmo nível).
 * - **Disparo B — avulso** (`requestForDocumentSubmission`, porta `DocumentApprovalRegistry`): a
 *   submissão (DOC-09) de um tipo com `requiresApproval`; aprovador pela `approvalPolicy`, cobertura
 *   = o próprio documento (versão `SUBMISSION`), sem prazo.
 *
 * Nos dois: `Approval` `PENDING` + `ApprovalDocument` (índices de pendência única → 409
 * `APPROVAL_NOT_PENDING`), `approval.request` e `ApprovalRequested` no outbox — cujos handlers
 * síncronos gravam a timeline `APPROVAL_REQUESTED` e as concessões `APPROVER` no mesmo `tx`.
 */
@Injectable()
export class ApprovalRequestService implements Omit<
  DocumentApprovalRequester,
  'withdrawForDocument'
> {
  private readonly logger = new Logger('Approval');

  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly approvals: ApprovalRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly resolver: ApproverResolver,
  ) {}

  async requestForStageEntry(tx: TenantTx, request: StageApprovalRequest): Promise<void> {
    const startedAt = performance.now();
    const { approver } = request;
    const approval: Approval = {
      ...this.base(
        request.approvalId,
        request.processId,
        request.requestedById,
        request.requestedAt,
      ),
      subjectType: 'PROCESS_STAGE',
      processStageId: request.processStageId,
      documentId: null,
      title: stageApprovalTitle(request.stageName, request.coverage[0]?.documentCode ?? null),
      requestComment: request.requestComment,
      approverType: approver.approverType,
      approverUserId: approver.approverUserId,
      approverRoleId: approver.approverRoleId,
      approverDepartmentId: approver.approverDepartmentId,
      allowDeputy: approver.allowDeputy,
      dueAt: request.dueAt,
    };
    if (request.coverage.length === 0) {
      // FA-02: etapa alcançada sem documento coberto — a decisão recai só sobre a etapa.
      this.logger.warn(
        {
          event: 'approval.no_covered_documents',
          approvalId: approval.id,
          processId: approval.processId,
          correlationId: requireRequestContext().correlationId,
        },
        'approval.no_covered_documents',
      );
    }
    await withSpan('approval.request', { 'approval.subject_type': 'PROCESS_STAGE' }, () =>
      this.open(tx, approval, request.coverage, startedAt),
    );
  }

  requestForDocumentSubmission(tx: TenantTx, request: DocumentApprovalRequest): Promise<void> {
    const startedAt = performance.now();
    return withSpan('approval.request', { 'approval.subject_type': 'DOCUMENT' }, async () => {
      const approver = await this.resolver.resolve(
        tx,
        approverConfigOfPolicy(request.policy),
        request,
        request.requestedAt,
        'DOCUMENT',
      );
      const approval: Approval = {
        ...this.base(
          request.approvalId,
          request.processId,
          request.requestedById,
          request.requestedAt,
        ),
        subjectType: 'DOCUMENT',
        processStageId: null,
        documentId: request.documentId,
        title: documentApprovalTitle(
          request.documentTypeName,
          request.documentCode,
          request.documentTitle,
        ),
        // DOC-09 não tem comentário; FA-04/RN-TRAM-51: sem etapa, sem prazo.
        requestComment: null,
        approverType: approver.approverType,
        approverUserId: approver.approverUserId,
        approverRoleId: approver.approverRoleId,
        approverDepartmentId: approver.approverDepartmentId,
        allowDeputy: approver.allowDeputy,
        dueAt: null,
      };
      await this.open(
        tx,
        approval,
        [
          {
            documentId: request.documentId,
            documentVersionId: request.documentVersionId,
            documentCode: request.documentCode,
          },
        ],
        startedAt,
      );
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

  private base(id: string, processId: string, requestedById: string, requestedAt: Date) {
    const tenantId = requireRequestContext().tenantId;
    if (tenantId === null) throw new ApiError('UNAUTHENTICATED');
    return {
      id,
      tenantId,
      processId,
      requestedById,
      requestedAt,
      status: 'PENDING' as const,
      createdAt: requestedAt,
      createdById: requestedById,
    };
  }

  /** RN-TRAM-46/53: aprovação, cobertura, auditoria e evento — falha desfaz a ação de origem. */
  private async open(
    tx: TenantTx,
    approval: Approval,
    coverage: readonly StageCoverage[],
    startedAt: number,
  ): Promise<void> {
    const { correlationId } = requireRequestContext();
    const documentIds = coverage.map((item) => item.documentId);
    const documentVersionIds = coverage.map((item) => item.documentVersionId);
    try {
      await this.approvals.insert(
        tx,
        approval,
        coverage.map((item): ApprovalCoverage => ({
          id: newId(),
          documentId: item.documentId,
          documentVersionId: item.documentVersionId,
        })),
      );
      await this.audit.record(tx, {
        action: 'approval.request',
        entityType: 'Approval',
        entityId: approval.id,
        processId: approval.processId,
        changes: [{ path: 'status', old: null, new: approval.status }],
        metadata: {
          subjectType: approval.subjectType,
          processStageId: approval.processStageId,
          documentId: approval.documentId,
          documentIds,
          documentVersionIds,
          approverType: approval.approverType,
          approverUserId: approval.approverUserId,
          approverRoleId: approval.approverRoleId,
          approverDepartmentId: approval.approverDepartmentId,
          allowDeputy: approval.allowDeputy,
          dueAt: approval.dueAt?.toISOString() ?? null,
        },
      });
      await this.outbox.record(
        tx,
        ApprovalRequested.of({
          aggregateId: approval.id,
          processId: approval.processId,
          payload: {
            approvalId: approval.id,
            subjectType: approval.subjectType,
            processStageId: approval.processStageId,
            documentId: approval.documentId,
            documentVersionIds,
            approverType: approval.approverType,
            approverUserId: approval.approverUserId,
            approverRoleId: approval.approverRoleId,
            approverDepartmentId: approval.approverDepartmentId,
            allowDeputy: approval.allowDeputy,
            dueAt: approval.dueAt?.toISOString() ?? null,
          },
        }),
      );
    } catch (error) {
      const failure =
        error instanceof PendingApprovalExistsError
          ? new ApiError('APPROVAL_NOT_PENDING', { detail: APPROVAL_NOT_PENDING_MESSAGE })
          : error;
      const errorCode =
        failure instanceof ApiError
          ? failure.code
          : isTransientDatabaseError(failure)
            ? 'DEPENDENCY_UNAVAILABLE'
            : 'INTERNAL_ERROR';
      this.logger.error(
        {
          event: 'approval.request_failed',
          errorCode,
          cause: error instanceof Error ? error.name : 'unknown',
          subjectType: approval.subjectType,
          correlationId,
        },
        'approval.request_failed',
      );
      recordApprovalRequestFailed(approval.subjectType, errorCode);
      throw failure;
    }
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    this.logger.log(
      {
        event: 'approval.requested',
        approvalId: approval.id,
        subjectType: approval.subjectType,
        processStageId: approval.processStageId,
        documentId: approval.documentId,
        approverType: approval.approverType,
        resolvedVia: approval.approverType,
        durationMs,
        correlationId,
      },
      'approval.requested',
    );
    recordApprovalRequested(approval.subjectType, approval.approverType, durationMs);
  }
}
