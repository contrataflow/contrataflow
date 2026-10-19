import type { ApprovalDecisionOption, ApprovalDocumentDto } from '@contrataflow/validation';
import { decisionRequiresComment } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import type {
  ApprovalSubjectHandler,
  DecisionCoverage,
  DecisionSubject,
  DecisionSubjectFacts,
  DecisionSubjectView,
  SubjectDecisionInput,
  SubjectDecisionResult,
} from '#shared/approval/approval-subject.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { JOB_QUEUE } from '#shared/jobs/job-queue.js';
import type { JobQueuePort } from '#shared/jobs/job-queue.js';

import { DocumentApprovalTransitions } from './document-approval.transitions.js';
import { DocumentLifecycleService } from './document-lifecycle.service.js';
import { DOCUMENT_REPOSITORY } from './document.ports.js';
import type { DocumentRepository } from './document.ports.js';
import { DOCUMENT_CLOCK } from './ports.js';
import type { DocumentClock } from './ports.js';
import {
  DOCUMENT_RENDER_JOB,
  DOCUMENT_RENDER_QUEUE,
  RENDER_PRIORITY,
  renderJobPayload,
} from './render-document.job.js';
import { RenditionAccess } from './rendition-access.js';
import { DOCUMENT_RENDITION_REPOSITORY, RENDITION_SETTINGS } from './rendition.ports.js';
import type { DocumentRenditionRepository, RenditionSettings } from './rendition.ports.js';
import { isReusable, requestVersionRendition } from '../domain/document-rendition.js';
import type { ApprovalOutcome, Document } from '../domain/document.js';

/*
 * Efeitos da decisão de aprovação nos documentos cobertos (US-052 · DEC-018 · RN-TRAM-57/58) e o
 * dono do sujeito `DOCUMENT` (submissão avulsa — FA-01), no `tx` de quem decide:
 *
 * - `apply`: o status do documento (`IN_REVIEW`/`FINALIZED`/`APPROVED` → `APPROVED`/`RETURNED`/
 *   `REJECTED`, `pendingApprovalId` limpo — `DocumentApprovalTransitions`) e, quando passa a
 *   `APPROVED`, a `DocumentRendition` `APPROVAL_STAMPED` `PENDING` e o gancho interno
 *   `onDocumentApproved`. A fila `document-render` só recebe o job DEPOIS do commit (padrão B):
 *   fila fora deixa a linha `PENDING` para o reconciliador e nunca bloqueia a decisão.
 * - `coverage`: os documentos cobertos (código, tipo, versão analisada) e os autores — o criador do
 *   documento e o da versão analisada (segregação de funções — RN-TRAM-62).
 */

/** Documento aprovado — gancho interno para integrações futuras (sem ouvinte no MVP 1). */
export interface DocumentApprovedHookEvent {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly approvalId: string;
}

export type DocumentApprovedListener = (
  tx: TenantTx,
  event: DocumentApprovedHookEvent,
) => Promise<void>;

export interface ApprovalOutcomeInput {
  readonly documentId: string;
  readonly approvalId: string;
  readonly outcome: ApprovalOutcome;
  /** Versão exata analisada (`ApprovalDocument.documentVersionId`). */
  readonly analyzedVersionId: string;
}

export interface ApprovalOutcomeResult {
  readonly document: Document;
  /** Enfileira o selo depois do commit (`null` = nada a enfileirar). */
  readonly afterCommit: (() => Promise<void>) | null;
}

export interface CoverageFacts {
  readonly documents: ApprovalDocumentDto[];
  readonly authorIds: string[];
}

const OUTCOME_OF: Readonly<Record<SubjectDecisionInput['decision'], ApprovalOutcome>> = {
  APPROVE: 'APPROVED',
  RETURN: 'RETURNED',
  REJECT: 'REJECTED',
};

/** Rótulos das decisões da avulsa (sem transição de workflow). */
const STANDALONE_LABELS: Readonly<Record<SubjectDecisionInput['decision'], string>> = {
  APPROVE: 'Aprovar',
  RETURN: 'Devolver para ajuste',
  REJECT: 'Indeferir',
};

@Injectable()
export class DocumentApprovalOutcomes {
  private readonly logger = new Logger('DocumentApprovalOutcomes');
  private readonly approvedListeners: DocumentApprovedListener[] = [];

  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_RENDITION_REPOSITORY) private readonly renditions: DocumentRenditionRepository,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(RENDITION_SETTINGS) private readonly settings: RenditionSettings,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueuePort,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly transitions: DocumentApprovalTransitions,
    private readonly access: RenditionAccess,
  ) {}

  /** Gancho interno `onDocumentApproved` (US-052 · "Impacto técnico"): roda no `tx` da decisão. */
  onDocumentApproved(listener: DocumentApprovedListener): void {
    this.approvedListeners.push(listener);
  }

  /** RN-TRAM-57/58: a decisão no documento e, se aprovado, o selo `PENDING` e o gancho. */
  async apply(tx: TenantTx, input: ApprovalOutcomeInput): Promise<ApprovalOutcomeResult> {
    const document = await this.transitions.applyApprovalDecision(tx, input);
    if (input.outcome !== 'APPROVED') return { document, afterCommit: null };
    const afterCommit = await this.scheduleStamp(tx, document, input);
    const event = {
      documentId: document.id,
      documentVersionId: input.analyzedVersionId,
      approvalId: input.approvalId,
    };
    for (const listener of this.approvedListeners) await listener(tx, event);
    return { document, afterCommit };
  }

  /** Documentos cobertos (na ordem da cobertura) e os autores; documento de fora do tenant some. */
  async coverage(tx: TenantTx, coverage: readonly DecisionCoverage[]): Promise<CoverageFacts> {
    const documents: ApprovalDocumentDto[] = [];
    const authors = new Set<string>();
    for (const item of coverage) {
      const document = await this.documents.findById(tx, item.documentId);
      if (document === null) continue;
      const { type } = await this.lifecycle.loadFor(tx, document);
      const version = await this.lifecycle.findVersion(tx, item.documentVersionId);
      authors.add(document.createdById);
      if (version !== null) authors.add(version.createdById);
      documents.push({
        documentId: document.id,
        documentVersionId: item.documentVersionId,
        versionNumber: version?.versionNumber ?? null,
        code: document.code,
        title: document.title,
        typeCode: type.code,
        typeName: type.name,
        status: document.status,
      });
    }
    return { documents, authorIds: [...authors] };
  }

  /**
   * RN-TRAM-58: `DocumentRendition` `APPROVAL_STAMPED` `PENDING` da versão analisada (POL-09 de
   * quem decide); equivalente já em andamento ou pronta é reaproveitada.
   */
  private async scheduleStamp(
    tx: TenantTx,
    document: Document,
    input: ApprovalOutcomeInput,
  ): Promise<(() => Promise<void>) | null> {
    // `UPLOADED`: o arquivo é a versão — não há PDF a selar (DOC-21 recusa igual).
    const context = await this.lifecycle.loadFor(tx, document);
    if (context.type.kind === 'UPLOADED') return null;
    const version = await this.lifecycle.findVersion(tx, input.analyzedVersionId);
    if (version === null) return null;
    const masked = await this.access.maskRequired(context, version);
    const existing = await this.renditions.findEquivalent(tx, {
      documentVersionId: version.id,
      kind: 'APPROVAL_STAMPED',
      approvalId: input.approvalId,
      masked,
    });
    if (existing !== null && isReusable(existing)) return null;
    const userId = requireRequestContext().actor.userId ?? document.createdById;
    const rendition = requestVersionRendition({
      id: newId(),
      tenantId: document.tenantId,
      processId: document.processId,
      documentId: document.id,
      documentVersionId: version.id,
      kind: 'APPROVAL_STAMPED',
      approvalId: input.approvalId,
      masked,
      requestedById: userId,
      now: this.clock(),
    });
    await this.renditions.insert(tx, rendition);
    return async () => {
      try {
        await this.jobs.enqueue(
          DOCUMENT_RENDER_QUEUE,
          DOCUMENT_RENDER_JOB,
          renderJobPayload(rendition),
          {
            jobId: rendition.id,
            attempts: this.settings.attempts,
            backoffMs: this.settings.backoffMs,
            priority: RENDER_PRIORITY.VERSION,
          },
        );
      } catch (error) {
        // RN-TRAM-58: a linha fica `PENDING` para o reconciliador; a decisão já foi confirmada.
        this.logger.warn(
          {
            event: 'rendition.enqueue_failed',
            renditionId: rendition.id,
            documentId: rendition.documentId,
            approvalId: input.approvalId,
            cause: error instanceof Error ? error.name : 'unknown',
            correlationId: requireRequestContext().correlationId,
          },
          'rendition.enqueue_failed',
        );
      }
    };
  }
}

/**
 * Dono do sujeito `DOCUMENT` (submissão avulsa — US-052 · FA-01): a decisão muda só o documento
 * (DEC-018); nenhuma etapa, status de processo, transição ou nova aprovação.
 */
@Injectable()
export class DocumentApprovalSubjectHandler implements ApprovalSubjectHandler<SubjectDecisionInput> {
  readonly subjectType = 'DOCUMENT' as const;

  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly outcomes: DocumentApprovalOutcomes,
  ) {}

  async prepareDecision(
    tx: TenantTx,
    subject: DecisionSubject,
  ): Promise<DecisionSubjectFacts | null> {
    return this.describeSubject(tx, subject);
  }

  async describeSubject(
    tx: TenantTx,
    subject: DecisionSubject,
  ): Promise<DecisionSubjectView | null> {
    const document =
      subject.documentId === null ? null : await this.documents.findById(tx, subject.documentId);
    if (document === null) return null;
    const { process } = await this.lifecycle.loadFor(tx, document);
    const coverage = await this.outcomes.coverage(tx, subject.coverage);
    return {
      processCode: process.code,
      processTitle: process.title,
      processStatus: process.status,
      organizationId: process.organizationId,
      requestingSecretariatId: process.requestingSecretariatId,
      requestingDepartmentId: process.requestingDepartmentId,
      authorIds: coverage.authorIds,
      documents: coverage.documents,
    };
  }

  /** A avulsa não tem regra de workflow nem destino: o plano é a própria decisão. */
  planDecision(_tx: TenantTx, input: SubjectDecisionInput): Promise<SubjectDecisionInput> {
    return Promise.resolve(input);
  }

  async applyDecision(tx: TenantTx, input: SubjectDecisionInput): Promise<SubjectDecisionResult> {
    const afterCommit: (() => Promise<void>)[] = [];
    const approvedDocumentIds: string[] = [];
    for (const item of input.subject.coverage) {
      const result = await this.outcomes.apply(tx, {
        documentId: item.documentId,
        approvalId: input.subject.approvalId,
        outcome: OUTCOME_OF[input.decision],
        analyzedVersionId: item.documentVersionId,
      });
      if (result.document.status === 'APPROVED') approvedDocumentIds.push(result.document.id);
      if (result.afterCommit !== null) afterCommit.push(result.afterCommit);
    }
    return {
      fromStatus: null,
      toStatus: null,
      processStage: null,
      warningsAcknowledged: [],
      movementId: null,
      chainedApprovalId: null,
      approvedDocumentIds,
      afterCommit,
    };
  }

  decisionOptions(): Promise<ApprovalDecisionOption[]> {
    return Promise.resolve(
      (['APPROVE', 'RETURN', 'REJECT'] as const).map((decision) => ({
        decision,
        transitionId: null,
        label: STANDALONE_LABELS[decision],
        toStage: null,
        requiresComment: decisionRequiresComment(decision),
        enabled: true,
        violations: [],
      })),
    );
  }
}
