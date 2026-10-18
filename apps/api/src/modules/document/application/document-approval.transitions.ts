import {
  DocumentApproved,
  DocumentRejected,
  DocumentReturned,
  DocumentSubmitted,
  DocumentVersionCreated,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import {
  documentIncomplete,
  documentNotFound,
  warningsNotAcknowledged,
} from './document.errors.js';
import { DOCUMENT_REPOSITORY } from './document.ports.js';
import type { DocumentRepository } from './document.ports.js';
import { DOCUMENT_CLOCK } from './ports.js';
import type { DocumentClock } from './ports.js';
import { gateCompleteness } from '../domain/document-completeness.js';
import { applyApprovalDecision, enterApprovalStage } from '../domain/document.js';
import type { ApprovalOutcome, Document } from '../domain/document.js';

/*
 * Transições acionadas pela tramitação e pelas aprovações (US-065 · FA-02/FA-03 · RN-DOC-44/45),
 * expostas pela `DocumentFacade` para a US-047/US-051 (entrada em etapa `APPROVAL`) e a US-052
 * (decisão). Rodam no `tx` do caso de uso de quem chama — sem transação própria — e com as mesmas
 * peças das ações do usuário: completude, versão (snapshot + hash), auditoria e outbox.
 */

export interface StageEntryInput {
  readonly documentId: string;
  /** `Approval` de etapa (`subjectType = PROCESS_STAGE`) que passa a cobrir o documento. */
  readonly approvalId: string;
  /**
   * Códigos dos avisos reconhecidos no encaminhamento (DEC-016 · RN-DFD-41). Rascunho com aviso
   * fora da lista → 422 `WARNINGS_NOT_ACKNOWLEDGED`, desfazendo a tramitação. Ausente = nenhum.
   */
  readonly acknowledgedWarnings?: readonly string[];
}

export interface StageEntryResult {
  /** Versão analisada: a recém-criada (rascunho) ou a corrente (finalizado/aprovado). */
  readonly documentVersionId: string;
  readonly document: Document;
  /** Avisos do rascunho reconhecidos (código + mensagem exibida) — vazio no finalizado. */
  readonly acknowledgedWarnings: readonly { readonly code: string; readonly message: string }[];
}

export interface ApprovalDecisionInput {
  readonly documentId: string;
  readonly approvalId: string;
  readonly outcome: ApprovalOutcome;
  /** Versão exata analisada (`ApprovalDocument.documentVersionId`). */
  readonly analyzedVersionId: string;
}

@Injectable()
export class DocumentApprovalTransitions {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly lifecycle: DocumentLifecycleService,
  ) {}

  private actorId(): string {
    const userId = requireRequestContext().actor.userId;
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    return userId;
  }

  /**
   * RN-DOC-44: documento em rascunho é validado (bloqueante → `DOCUMENT_INCOMPLETE`, desfazendo a
   * tramitação), ganha a versão `SUBMISSION` e vai a `IN_REVIEW`; `FINALIZED`/`APPROVED` só recebe
   * `pendingApprovalId` (sem nova versão — RN-DFD-39). Avisos do rascunho precisam estar em
   * `acknowledgedWarnings` (DEC-016 · RN-DFD-41 — `WARNINGS_NOT_ACKNOWLEDGED`).
   */
  async enterApprovalStage(tx: TenantTx, input: StageEntryInput): Promise<StageEntryResult> {
    const document = await this.documents.findById(tx, input.documentId);
    if (document === null) throw documentNotFound();
    const context = await this.lifecycle.loadFor(tx, document);
    const actorId = this.actorId();
    const now = this.clock();
    const draft = document.status === 'DRAFT' || document.status === 'RETURNED';
    let acknowledged: StageEntryResult['acknowledgedWarnings'] = [];
    if (draft) {
      const { violations } = await this.lifecycle.evaluate(tx, context);
      const gate = gateCompleteness(violations, input.acknowledgedWarnings ?? []);
      if (gate.kind === 'INCOMPLETE') throw documentIncomplete(gate.violations);
      if (gate.kind === 'WARNINGS_NOT_ACKNOWLEDGED') throw warningsNotAcknowledged(gate.violations);
      acknowledged = gate.acknowledged.map((item) => ({ code: item.code, message: item.message }));
    }
    const draftVersion = draft
      ? { id: newId(), versionNumber: await this.lifecycle.nextVersionNumber(tx, document.id) }
      : null;
    const outcome = this.lifecycle.transition(() =>
      enterApprovalStage(document, { actorId, now, approvalId: input.approvalId, draftVersion }),
    );
    const saved = await this.lifecycle.save(tx, outcome.document, document.version);
    if (!outcome.createdVersion || draftVersion === null) {
      return {
        document: saved,
        documentVersionId: document.currentVersionId ?? '',
        acknowledgedWarnings: [],
      };
    }
    const version = await this.lifecycle.createVersion(tx, context, {
      document: saved,
      versionId: draftVersion.id,
      versionNumber: draftVersion.versionNumber,
      reason: 'SUBMISSION',
      actorId,
      now,
    });
    await this.audit.record(tx, {
      action: 'document.version_create',
      entityType: 'Document',
      entityId: saved.id,
      processId: saved.processId,
      metadata: {
        documentVersionId: version.id,
        versionNumber: version.versionNumber,
        reason: version.reason,
        contentHash: version.contentHash,
        documentCode: saved.code,
      },
    });
    await this.audit.record(tx, {
      action: 'document.submit',
      entityType: 'Document',
      entityId: saved.id,
      processId: saved.processId,
      changes: [{ path: 'status', old: document.status, new: saved.status }],
      metadata: {
        documentVersionId: version.id,
        approvalId: input.approvalId,
        documentCode: saved.code,
        documentTypeCode: context.type.code,
        warningsAcknowledged: acknowledged,
      },
    });
    await this.outbox.record(
      tx,
      DocumentVersionCreated.of({
        aggregateId: saved.id,
        processId: saved.processId,
        payload: {
          documentId: saved.id,
          documentTypeCode: context.type.code,
          documentVersionId: version.id,
          versionNumber: version.versionNumber,
          reason: version.reason,
          contentHash: version.contentHash,
        },
      }),
    );
    await this.outbox.record(
      tx,
      DocumentSubmitted.of({
        aggregateId: saved.id,
        processId: saved.processId,
        payload: {
          documentId: saved.id,
          documentTypeCode: context.type.code,
          documentVersionId: version.id,
          approvalId: input.approvalId,
        },
      }),
    );
    return { document: saved, documentVersionId: version.id, acknowledgedWarnings: acknowledged };
  }

  /**
   * RN-DOC-45: `APPROVED` (com `approvedVersionId` = versão analisada), `RETURNED` ou `REJECTED`,
   * limpando `pendingApprovalId`; publica `DocumentApproved`/`DocumentReturned`/`DocumentRejected`
   * (timeline). A auditoria da decisão é a `approval.decide` da US-052.
   */
  async applyApprovalDecision(tx: TenantTx, input: ApprovalDecisionInput): Promise<Document> {
    const document = await this.documents.findById(tx, input.documentId);
    if (document === null) throw documentNotFound();
    const type = (await this.lifecycle.loadFor(tx, document)).type;
    const next = this.lifecycle.transition(() =>
      applyApprovalDecision(document, {
        actorId: this.actorId(),
        now: this.clock(),
        approvalId: input.approvalId,
        outcome: input.outcome,
        analyzedVersionId: input.analyzedVersionId,
      }),
    );
    const saved = await this.lifecycle.save(tx, next, document.version);
    const base = { aggregateId: saved.id, processId: saved.processId };
    const common = {
      documentId: saved.id,
      documentTypeCode: type.code,
      approvalId: input.approvalId,
    };
    if (input.outcome === 'APPROVED') {
      await this.outbox.record(
        tx,
        DocumentApproved.of({
          ...base,
          payload: { ...common, documentVersionId: input.analyzedVersionId },
        }),
      );
    } else if (input.outcome === 'RETURNED') {
      await this.outbox.record(tx, DocumentReturned.of({ ...base, payload: common }));
    } else {
      await this.outbox.record(tx, DocumentRejected.of({ ...base, payload: common }));
    }
    return saved;
  }
}
