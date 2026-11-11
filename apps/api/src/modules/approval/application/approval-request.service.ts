import { withSpan } from '@contrataflow/observability';
import {
  ApprovalRequested,
  composeApproverLabel,
  MULTI_APPROVAL_MESSAGES,
} from '@contrataflow/validation';
import type { ApprovalDecisionPolicy, OpenedApprovalDto } from '@contrataflow/validation';
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

import { ApprovalDecisionPolicy as ApprovalDecisionPolicyService } from './approval-decision.policy.js';
import { recordApprovalRequested, recordApprovalRequestFailed } from './approval-telemetry.js';
import { ApproverResolver } from './approver-resolver.js';
import type { ResolvedApprovalLines } from './approver-resolver.js';
import { APPROVAL_REPOSITORY, PendingApprovalExistsError } from './ports.js';
import type { ApprovalRepository } from './ports.js';
import {
  ApprovalConfigInvalidError,
  approvalConfigOf,
  assertDistinctApprovers,
  DuplicatedApproverError,
  guardSelfApproval,
  mirroredLineOf,
  mirrorOf,
  openApprovalLines,
  SelfApprovalAtRequestError,
  segregationAppliesAtRequest,
} from '../domain/approval-lines.js';
import type {
  ApprovalApprover,
  ApprovalConfigSource,
  ApprovalRequestConfig,
  GuardedApprovalLine,
} from '../domain/approval-lines.js';
import { documentApprovalTitle, stageApprovalTitle } from '../domain/approval.js';
import type {
  Approval,
  ApprovalCoverage,
  ApprovalSubjectType,
  RequestingUnitsOf,
} from '../domain/approval.js';

/** V-03 da US-051: a corrida perdida no índice de pendência única (RN-TRAM-43). */
const APPROVAL_NOT_PENDING_MESSAGE = 'Já existe uma aprovação em andamento para este item.';

/** Documento coberto e a versão exata em análise (RN-TRAM-46). */
export interface StageCoverage {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly documentCode: string | null;
}

/**
 * A configuração copiada e as linhas resolvidas ANTES de qualquer escrita da ação de origem
 * (`ApprovalFacade.resolveStageApprovalIn` — RN-APV-16/19).
 */
export interface ApprovalPlan {
  readonly config: ApprovalRequestConfig;
  readonly resolved: ResolvedApprovalLines;
}

export interface StageApprovalRequest {
  /** Id gerado por quem encaminha (vai em `pendingApprovalId` dos documentos no mesmo `tx`). */
  readonly approvalId: string;
  readonly processId: string;
  /** Passagem recém-aberta pela etapa `APPROVAL` (gravada antes — FK). */
  readonly processStageId: string;
  readonly stageName: string;
  /** Resolvido ANTES de qualquer escrita do encaminhamento (`ApprovalFacade.resolveStageApprovalIn`). */
  readonly plan: ApprovalPlan;
  readonly coverage: readonly StageCoverage[];
  /**
   * Autores dos documentos cobertos (criador do documento e da versão analisada — RN-TRAM-62),
   * lidos só quando a segregação vale na solicitação (RN-APV-20).
   */
  readonly authorIds: () => Promise<readonly string[]>;
  readonly requestedById: string;
  readonly requestedAt: Date;
  readonly requestComment: string | null;
  /** RN-TRAM-51: o prazo da passagem. */
  readonly dueAt: Date | null;
}

/** A aprovação aberta como as respostas de PRC-19/DOC-09 a mostram (US-133 · aditivo). */
export type OpenedApproval = OpenedApprovalDto;

/** Linha aberta com o rótulo (resposta, timeline) e a marca de desvio (auditoria). */
interface LabeledLine {
  readonly line: ApprovalApprover;
  readonly label: string;
  readonly selfApprovalAvoided: boolean;
}

/**
 * Solicitação de aprovação (US-051 · US-133 · DEC-022 · DEC-193 · RN-TRAM-43..53 · RN-APV-16..32),
 * sem comando nem transação própria: roda no `tx` da ação de origem e qualquer falha a desfaz
 * inteira (RN-APV-29).
 *
 * - **Disparo A — etapa** (`requestForStageEntry`): o encaminhamento (PRC-19) — ou a decisão que
 *   encadeia (US-052) — entra numa etapa `APPROVAL`; as linhas já foram resolvidas e os documentos
 *   cobertos já foram submetidos por quem encaminha (`DocumentFacade.enterApprovalStageIn`).
 * - **Disparo B — avulso** (`requestForDocumentSubmission`, porta `DocumentApprovalRegistry`): a
 *   submissão (DOC-09) de um tipo com `requiresApproval`; política e linhas da `approvalPolicy`,
 *   cobertura = o próprio documento (versão `SUBMISSION`), sem prazo (US-137).
 *
 * Nos dois: segregação por linha (RN-APV-20 — 403 `SELF_APPROVAL_FORBIDDEN`), pessoa única
 * (RN-APV-21 — 422 `APPROVER_DUPLICATED`), `Approval` `PENDING` com a política e o espelho da linha
 * corrente, as `ApprovalApprover` no estado inicial da política, `ApprovalDocument` (índices de
 * pendência única → 409 `APPROVAL_NOT_PENDING`), `approval.request` e um `ApprovalRequested` no
 * outbox — cujos handlers síncronos gravam a timeline e as concessões `APPROVER` no mesmo `tx`.
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
    private readonly policy: ApprovalDecisionPolicyService,
  ) {}

  /**
   * RN-APV-16..19: copia a política e as linhas (etapa ou tipo de documento) e resolve cada linha.
   * @throws ApiError 422 `APPROVER_UNRESOLVED` (linha sem aprovador ou configuração inconsistente)
   */
  async plan(
    tx: TenantTx,
    source: ApprovalConfigSource,
    process: RequestingUnitsOf,
    now: Date,
    subjectType: ApprovalSubjectType,
  ): Promise<ApprovalPlan> {
    let config: ApprovalRequestConfig;
    try {
      config = approvalConfigOf(source);
    } catch (error) {
      if (!(error instanceof ApprovalConfigInvalidError)) throw error;
      this.rejected(subjectType, 'APPROVER_UNRESOLVED', null, error.reason);
      throw new ApiError('APPROVER_UNRESOLVED', {
        detail: MULTI_APPROVAL_MESSAGES.misconfigured(subjectType),
        extensions: { meta: { reason: error.reason } },
      });
    }
    return {
      config,
      resolved: await this.resolver.resolveLines(tx, config, process, now, subjectType),
    };
  }

  async requestForStageEntry(tx: TenantTx, request: StageApprovalRequest): Promise<OpenedApproval> {
    const startedAt = performance.now();
    if (request.coverage.length === 0) {
      // FA-02 (US-051): etapa alcançada sem documento coberto — a decisão recai só sobre a etapa.
      this.logger.warn(
        {
          event: 'approval.no_covered_documents',
          approvalId: request.approvalId,
          processId: request.processId,
          correlationId: requireRequestContext().correlationId,
        },
        'approval.no_covered_documents',
      );
    }
    return withSpan('approval.request', { 'approval.subject_type': 'PROCESS_STAGE' }, async () => {
      const lines = await this.labeledLines(tx, request.approvalId, request.plan, {
        subjectType: 'PROCESS_STAGE',
        authorIds: request.authorIds,
        requestedAt: request.requestedAt,
        requestedById: request.requestedById,
      });
      return this.open(
        tx,
        {
          ...this.base(request.approvalId, request.processId, request),
          subjectType: 'PROCESS_STAGE',
          processStageId: request.processStageId,
          documentId: null,
          title: stageApprovalTitle(request.stageName, request.coverage[0]?.documentCode ?? null),
          requestComment: request.requestComment,
          dueAt: request.dueAt,
        },
        request.plan.config.decisionPolicy,
        lines,
        request.coverage,
        startedAt,
      );
    });
  }

  requestForDocumentSubmission(tx: TenantTx, request: DocumentApprovalRequest): Promise<void> {
    const startedAt = performance.now();
    return withSpan('approval.request', { 'approval.subject_type': 'DOCUMENT' }, async () => {
      const plan = await this.plan(tx, request.policy, request, request.requestedAt, 'DOCUMENT');
      const lines = await this.labeledLines(tx, request.approvalId, plan, {
        subjectType: 'DOCUMENT',
        authorIds: () => Promise.resolve(request.authorIds ?? [request.requestedById]),
        requestedAt: request.requestedAt,
        requestedById: request.requestedById,
      });
      await this.open(
        tx,
        {
          ...this.base(request.approvalId, request.processId, request),
          subjectType: 'DOCUMENT',
          processStageId: null,
          documentId: request.documentId,
          title: documentApprovalTitle(
            request.documentTypeName,
            request.documentCode,
            request.documentTitle,
          ),
          // DOC-09 não tem comentário; FA-06/RN-APV-22: sem etapa, sem prazo (até a US-137).
          requestComment: null,
          dueAt: null,
        },
        plan.config.decisionPolicy,
        lines,
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

  private base(
    id: string,
    processId: string,
    request: { readonly requestedById: string; readonly requestedAt: Date },
  ) {
    const tenantId = requireRequestContext().tenantId;
    if (tenantId === null) throw new ApiError('UNAUTHENTICATED');
    return {
      id,
      tenantId,
      processId,
      requestedById: request.requestedById,
      requestedAt: request.requestedAt,
      status: 'PENDING' as const,
      createdAt: request.requestedAt,
      createdById: request.requestedById,
    };
  }

  /**
   * RN-APV-18/20/21: segregação por linha (substituto ou recusa), pessoa única e as linhas no
   * estado inicial da política, com os rótulos (resposta e timeline — nunca no evento).
   */
  private async labeledLines(
    tx: TenantTx,
    approvalId: string,
    plan: ApprovalPlan,
    input: {
      readonly subjectType: ApprovalSubjectType;
      readonly authorIds: () => Promise<readonly string[]>;
      readonly requestedAt: Date;
      readonly requestedById: string;
    },
  ): Promise<LabeledLine[]> {
    const policy = plan.config.decisionPolicy;
    const resolved = plan.resolved.lines;
    const segregation = segregationAppliesAtRequest(policy, resolved.length);
    const preventSelfApproval = segregation && (await this.policy.preventsSelfApprovalIn(tx));
    let guarded: GuardedApprovalLine[];
    try {
      guarded = guardSelfApproval(policy, resolved, {
        preventSelfApproval,
        authorIds: new Set(preventSelfApproval ? await input.authorIds() : []),
        deputies: plan.resolved.deputies,
      });
      assertDistinctApprovers(guarded);
    } catch (error) {
      if (error instanceof SelfApprovalAtRequestError) {
        this.rejected(input.subjectType, 'SELF_APPROVAL_FORBIDDEN', error.sequence, null);
        throw new ApiError('SELF_APPROVAL_FORBIDDEN', {
          detail: MULTI_APPROVAL_MESSAGES.selfApproval(error.sequence),
          extensions: { meta: { sequence: error.sequence } },
          auditReasonCode: 'APPROVAL_REQUEST',
        });
      }
      if (error instanceof DuplicatedApproverError) {
        this.rejected(input.subjectType, 'APPROVER_DUPLICATED', error.second, null);
        throw new ApiError('APPROVER_DUPLICATED', {
          detail: MULTI_APPROVAL_MESSAGES.duplicated(error.first, error.second),
          extensions: { meta: { sequences: [error.first, error.second] } },
        });
      }
      throw error;
    }
    const opened = openApprovalLines(approvalId, policy, guarded, {
      requestedAt: input.requestedAt,
      requestedById: input.requestedById,
      newId,
    });
    const avoided = new Set(
      guarded.filter((line) => line.selfApprovalAvoided).map((line) => line.sequence),
    );
    const labeled: LabeledLine[] = [];
    for (const line of opened) {
      labeled.push({
        line,
        label: await this.resolver.labelOf(tx, line),
        selfApprovalAvoided: avoided.has(line.sequence),
      });
    }
    return labeled;
  }

  /** `warn approval.request_rejected` (story · Logs) e a métrica de falha — nunca nomes. */
  private rejected(
    subjectType: ApprovalSubjectType,
    reason: string,
    sequence: number | null,
    configProblem: string | null,
  ): void {
    this.logger.warn(
      {
        event: 'approval.request_rejected',
        reason,
        subjectType,
        sequence,
        ...(configProblem === null ? {} : { configProblem }),
        correlationId: requireRequestContext().correlationId,
      },
      'approval.request_rejected',
    );
    recordApprovalRequestFailed(subjectType, reason);
  }

  /**
   * RN-APV-17..32: aprovação (com a política e o espelho da linha corrente — RN-APV-24), linhas,
   * cobertura, auditoria e evento — falha desfaz a ação de origem.
   */
  private async open(
    tx: TenantTx,
    base: Omit<
      Approval,
      | 'decisionPolicy'
      | 'approverType'
      | 'approverUserId'
      | 'approverRoleId'
      | 'approverDepartmentId'
      | 'allowDeputy'
    >,
    decisionPolicy: ApprovalDecisionPolicy,
    labeled: readonly LabeledLine[],
    coverage: readonly StageCoverage[],
    startedAt: number,
  ): Promise<OpenedApproval> {
    const { correlationId } = requireRequestContext();
    const lines = labeled.map((item) => item.line);
    const mirrored = mirroredLineOf(decisionPolicy, lines);
    if (mirrored === null) throw new Error('Aprovação sem linha resolvida (RN-APV-17).');
    const approval: Approval = { ...base, decisionPolicy, ...mirrorOf(mirrored) };
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
        lines,
      );
      await this.audit.record(tx, {
        action: 'approval.request',
        entityType: 'Approval',
        entityId: approval.id,
        processId: approval.processId,
        changes: [{ path: 'status', old: null, new: approval.status }],
        metadata: {
          approvalId: approval.id,
          subjectType: approval.subjectType,
          processStageId: approval.processStageId,
          documentId: approval.documentId,
          documentIds,
          documentVersionIds,
          decisionPolicy,
          approversCount: lines.length,
          lines: labeled.map((item) => ({
            sequence: item.line.sequence,
            approverType: item.line.approverType,
            status: item.line.status,
            ...(item.selfApprovalAvoided ? { selfApprovalAvoided: true } : {}),
          })),
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
            decisionPolicy,
            approvers: lines.map((line) => ({
              approvalApproverId: line.id,
              sequence: line.sequence,
              approverType: line.approverType,
              approverUserId: line.approverUserId,
              approverRoleId: line.approverRoleId,
              approverDepartmentId: line.approverDepartmentId,
              allowDeputy: line.allowDeputy,
              status: line.status,
            })),
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
        decisionPolicy,
        linesCount: lines.length,
        approverType: approval.approverType,
        resolvedVia: approval.approverType,
        durationMs,
        correlationId,
      },
      'approval.requested',
    );
    recordApprovalRequested(approval.subjectType, approval.approverType, durationMs);
    return {
      id: approval.id,
      approverLabel: composeApproverLabel(
        decisionPolicy,
        labeled.map((item) => item.label),
      ),
      decisionPolicy,
      approvers: labeled.map((item) => ({
        id: item.line.id,
        sequence: item.line.sequence,
        status: item.line.status,
        approverType: item.line.approverType,
        label: item.label,
      })),
    };
  }
}
