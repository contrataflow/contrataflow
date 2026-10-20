import {
  APPROVAL_WITHDRAWAL_MESSAGES,
  DocumentCanceled,
  DocumentFinalized,
  DocumentReopened,
  DocumentSubmitted,
  DocumentVersionCreated,
} from '@contrataflow/validation';
import type { DocumentAction, DocumentStatus, VersionReason } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentApprovalRegistry } from '#shared/document/document-approval.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { sha256Hex } from '#shared/integrity/canonical-json.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import type { DocumentContext, ResolvedDocumentActor } from './document-lifecycle.service.js';
import {
  documentIncomplete,
  draftRevisionConflict,
  warningsNotAcknowledged,
} from './document.errors.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentClock, DocumentTransactions } from './ports.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { gateCompleteness } from '../domain/document-completeness.js';
import { draftSectionsFromSnapshot } from '../domain/document-snapshot.js';
import type { DocumentVersionRecord } from '../domain/document-snapshot.js';
import type { DocumentType } from '../domain/document-type.js';
import {
  assertConcludable,
  cancelDocument,
  deleteDocument,
  finalizeDocument,
  reopenDocument,
  submitDocument,
  updateDocumentHeader,
} from '../domain/document.js';
import type { Document, DocumentHeaderPatch } from '../domain/document.js';

/*
 * Casos de uso do ciclo de vida (US-065 · DOC-04/09/10/12/13/14): cada um numa ÚNICA transação do
 * tenant (`TransactionalCommandHandler`) — validar → autorizar (POL-01/02/11) → `If-Match` →
 * transição pura → completude → gravar o documento condicionado à `version` → versão → auditoria →
 * outbox (timeline síncrona) → commit. Falha em qualquer passo desfaz tudo; o perdedor de duas
 * transições simultâneas recebe 412 antes de criar versão (RN-DOC-53).
 */

/** Resultado de uma transição: o documento gravado e o que a resposta precisa. */
export interface DocumentTransitionResult {
  readonly document: Document;
  readonly type: DocumentType;
  readonly allowedActions: DocumentAction[];
  /** Log `document.status_changed` e métrica `document_transition_total`. */
  readonly transition: {
    readonly action: string;
    readonly fromStatus: DocumentStatus;
    readonly toStatus: DocumentStatus | 'DELETED';
  } | null;
}

let transitionCounter: Counter | undefined;

/** `document_transition_total{fromStatus,toStatus}` (DoD da US-065). */
function recordTransition(fromStatus: string, toStatus: string, action: string): void {
  transitionCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('document_transition_total', {
      description: 'Transições de status de documento por status de origem e de destino.',
    });
  transitionCounter.add(1, { fromStatus, toStatus, action });
}

/** Texto livre na auditoria: só hash + tamanho (RN-AUD-03 · "Nunca logar" da US-065). */
function fingerprint(text: string): { readonly sha256: string; readonly length: number } {
  return { sha256: sha256Hex(text), length: text.length };
}

function statusChange(from: DocumentStatus, to: DocumentStatus): AuditChange[] {
  return [{ path: 'status', old: from, new: to }];
}

/**
 * Base das transições: nome estável `document.transition` (span `document.transition.transaction`
 * e log `error document.transition_failed` com `errorCode` e `correlationId`) e, depois do commit,
 * `info document.status_changed` + a métrica.
 */
abstract class DocumentTransitionCommand<I> extends TransactionalCommandHandler<
  I,
  undefined,
  DocumentTransitionResult
> {
  protected constructor(
    transactions: DocumentTransactions,
    protected readonly lifecycle: DocumentLifecycleService,
    protected readonly clock: DocumentClock,
    protected readonly audit: AuditTrailPort,
    protected readonly outbox: OutboxWriterPort,
  ) {
    super('document.transition', transactions);
  }

  protected prepare(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  protected override committed(result: DocumentTransitionResult, durationMs: number): void {
    if (result.transition === null) return;
    const { action, fromStatus, toStatus } = result.transition;
    recordTransition(fromStatus, toStatus, action);
    this.logger.log(
      {
        event: 'document.status_changed',
        documentId: result.document.id,
        fromStatus,
        toStatus,
        reason: action,
        durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'document.status_changed',
    );
  }

  protected actorId(): string {
    const userId = requireRequestContext().actor.userId;
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    return userId;
  }

  protected result(
    context: DocumentContext,
    actor: ResolvedDocumentActor,
    document: Document,
    transition: DocumentTransitionResult['transition'],
  ): DocumentTransitionResult {
    return {
      document,
      type: context.type,
      allowedActions: this.lifecycle.allowedActions({ ...context, document }, actor),
      transition,
    };
  }

  /** `document.version_create` + `DocumentVersionCreated` (RN-DOC-53). */
  protected recordVersion(
    tx: TenantTx,
    context: DocumentContext,
    version: DocumentVersionRecord,
  ): Promise<void> {
    return recordDocumentVersion(this.audit, this.outbox, tx, context, version);
  }
}

/**
 * Auditoria `document.version_create` + evento `DocumentVersionCreated` no `tx` do caso de uso —
 * toda versão criada (transições da US-065 e "Salvar versão" da US-066) passa por aqui. O resumo
 * da alteração nunca entra (texto livre — "Nunca logar" da US-066).
 */
export async function recordDocumentVersion(
  audit: AuditTrailPort,
  outbox: OutboxWriterPort,
  tx: TenantTx,
  context: DocumentContext,
  version: DocumentVersionRecord,
): Promise<void> {
  await audit.record(tx, {
    action: 'document.version_create',
    entityType: 'Document',
    entityId: version.documentId,
    processId: version.processId,
    metadata: {
      documentVersionId: version.id,
      versionNumber: version.versionNumber,
      reason: version.reason,
      contentHash: version.contentHash,
      documentCode: context.document.code,
      // US-064: a versão do documento externo aponta o arquivo varrido (hash = SHA-256 dele).
      ...(version.reason === 'UPLOAD' && version.attachmentId !== null
        ? { attachmentId: version.attachmentId, sha256: version.contentHash }
        : {}),
    },
  });
  await outbox.record(
    tx,
    DocumentVersionCreated.of({
      aggregateId: version.documentId,
      processId: version.processId,
      payload: {
        documentId: version.documentId,
        documentTypeCode: context.type.code,
        documentVersionId: version.id,
        versionNumber: version.versionNumber,
        reason: version.reason,
        contentHash: version.contentHash,
      },
    }),
  );
}

// --- Finalizar e submeter (DOC-10 · DOC-09) ----------------------------------------------------

export interface ConcludeDocumentInput {
  readonly documentId: string;
  /** `If-Match` (versão do documento). */
  readonly expectedVersion: number;
  readonly acknowledgedWarnings: readonly string[];
  /** `draftRevision` revisado no DOC-08 (RN-DFD-43); `null` = sem conferência. */
  readonly expectedDraftRevision?: number | null;
  readonly idempotencyKey: string | null;
  /**
   * PRS-23 (US-032): a confirmação na tela do módulo tipado já reconhece os avisos (alertas não
   * bloqueiam — FA-03); os avisos ficam registrados em `warningsAcknowledged` da auditoria.
   */
  readonly acknowledgeAllWarnings?: boolean;
}

/** Validação de completude + versão + transição, comum a finalizar e a submeter. */
abstract class ConcludeDocumentCommand extends DocumentTransitionCommand<ConcludeDocumentInput> {
  protected abstract readonly action: 'FINALIZE' | 'SUBMIT';

  protected abstract conclude(
    tx: TenantTx,
    context: DocumentContext,
    stamp: {
      readonly actorId: string;
      readonly now: Date;
      readonly versionId: string;
      readonly versionNumber: number;
    },
  ): Promise<{ readonly next: Document; readonly approvalId: string | null }>;

  protected async handle(
    tx: TenantTx,
    input: ConcludeDocumentInput,
  ): Promise<DocumentTransitionResult> {
    const context = await this.lifecycle.load(tx, input.documentId);
    const actor = await this.lifecycle.actorOf(context);
    await this.lifecycle.authorizePol02(context, actor, 'submit');
    this.lifecycle.assertVersion(context, input.expectedVersion);
    const { document, type } = context;
    const expectedDraft = input.expectedDraftRevision ?? null;
    if (expectedDraft !== null && expectedDraft !== document.draftRevision) {
      throw draftRevisionConflict(document.version, document.draftRevision);
    }
    this.lifecycle.transition(() => {
      assertConcludable(document, type, this.action);
    });

    // Defesa em profundidade (passo 4): a completude é reavaliada dentro da transação.
    const completeness = await this.lifecycle.evaluate(tx, context);
    const acknowledgedCodes =
      input.acknowledgeAllWarnings === true
        ? completeness.violations
            .filter((item) => item.severity === 'WARNING')
            .map((item) => item.code)
        : input.acknowledgedWarnings;
    const gate = gateCompleteness(completeness.violations, acknowledgedCodes);
    if (gate.kind === 'INCOMPLETE') {
      this.lifecycle.logCompletenessBlocked(document.id, gate.violations);
      throw documentIncomplete(gate.violations);
    }
    if (gate.kind === 'WARNINGS_NOT_ACKNOWLEDGED') throw warningsNotAcknowledged(gate.violations);

    const actorId = this.actorId();
    const now = this.clock();
    const versionNumber = await this.lifecycle.nextVersionNumber(tx, document.id);
    const versionId = newId();
    const { next, approvalId } = await this.conclude(tx, context, {
      actorId,
      now,
      versionId,
      versionNumber,
    });
    // O documento primeiro (condicionado à `version`): o perdedor de uma corrida para aqui.
    const saved = await this.lifecycle.save(tx, next, input.expectedVersion);
    const reason: VersionReason = this.action === 'FINALIZE' ? 'FINALIZATION' : 'SUBMISSION';
    const version = await this.lifecycle.createVersion(tx, context, {
      document: saved,
      versionId,
      versionNumber,
      reason,
      actorId,
      now,
    });
    await this.requestApproval(tx, context, saved, version, approvalId, now);
    await this.recordVersion(tx, context, version);

    const acknowledged = gate.acknowledged.map((item) => ({
      code: item.code,
      message: item.message,
    }));
    if (this.action === 'FINALIZE') {
      const typedSummary = await this.lifecycle.typedSummary(tx, context);
      await this.audit.record(tx, {
        action: 'document.finalize',
        entityType: 'Document',
        entityId: saved.id,
        processId: saved.processId,
        changes: statusChange(document.status, saved.status),
        metadata: {
          documentVersionId: version.id,
          documentCode: saved.code,
          documentTypeCode: type.code,
          ...(typedSummary === null ? {} : { typedSummary }),
          warningsAcknowledged: acknowledged,
          idempotencyKey: input.idempotencyKey,
        },
      });
      await this.outbox.record(
        tx,
        DocumentFinalized.of({
          aggregateId: saved.id,
          processId: saved.processId,
          payload: {
            documentId: saved.id,
            documentTypeCode: type.code,
            documentVersionId: version.id,
            ...(typedSummary === null ? {} : { typedSummary: { ...typedSummary } }),
          },
        }),
      );
      // US-032: efeitos do módulo tipado na mesma transação (pesquisa → processo).
      await this.lifecycle.finalized(
        tx,
        { ...context, document: saved },
        {
          documentVersionId: version.id,
          actorId,
          now,
          idempotencyKey: input.idempotencyKey,
        },
      );
    } else {
      await this.audit.record(tx, {
        action: 'document.submit',
        entityType: 'Document',
        entityId: saved.id,
        processId: saved.processId,
        changes: statusChange(document.status, saved.status),
        metadata: {
          documentVersionId: version.id,
          approvalId,
          documentCode: saved.code,
          documentTypeCode: type.code,
          warningsAcknowledged: acknowledged,
          idempotencyKey: input.idempotencyKey,
        },
      });
      await this.outbox.record(
        tx,
        DocumentSubmitted.of({
          aggregateId: saved.id,
          processId: saved.processId,
          payload: {
            documentId: saved.id,
            documentTypeCode: type.code,
            documentVersionId: version.id,
            approvalId,
          },
        }),
      );
    }
    return this.result(context, actor, saved, {
      action: this.action,
      fromStatus: document.status,
      toStatus: saved.status,
    });
  }

  /** Só a submissão avulsa abre aprovação (padrão: nada). */
  protected requestApproval(
    _tx: TenantTx,
    _context: DocumentContext,
    _document: Document,
    _version: DocumentVersionRecord,
    _approvalId: string | null,
    _now: Date,
  ): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * `FinalizeDocumentCommand` — DOC-10 (RN-DOC-42 · fluxo principal): tipo sem aprovação formal;
 * `DRAFT`/`RETURNED` → `FINALIZED` com a versão `FINALIZATION`, `document.finalize` e
 * `DocumentFinalized` (com `typedSummary` dos tipos estruturados — RN-DOC-52).
 */
@Injectable()
export class FinalizeDocumentCommand extends ConcludeDocumentCommand {
  protected readonly action = 'FINALIZE';

  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    lifecycle: DocumentLifecycleService,
    @Inject(DOCUMENT_CLOCK) clock: DocumentClock,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
  ) {
    super(transactions, lifecycle, clock, audit, outbox);
  }

  /**
   * PRS-23 (US-032): a MESMA finalização no `tx` do módulo tipado, que já autorizou e travou o
   * documento. O log e a métrica da transição vêm por `transitionCommitted`, depois do commit.
   */
  finalizeIn(tx: TenantTx, input: ConcludeDocumentInput): Promise<DocumentTransitionResult> {
    return this.handle(tx, input);
  }

  /** `document.status_changed` + `document_transition_total` da finalização feita por `finalizeIn`. */
  transitionCommitted(result: DocumentTransitionResult, durationMs: number): void {
    this.committed(result, durationMs);
  }

  protected conclude(
    _tx: TenantTx,
    context: DocumentContext,
    stamp: { actorId: string; now: Date; versionId: string; versionNumber: number },
  ): Promise<{ next: Document; approvalId: null }> {
    const next = this.lifecycle.transition(() =>
      finalizeDocument(context.document, context.type, stamp),
    );
    return Promise.resolve({ next, approvalId: null });
  }
}

/**
 * `SubmitDocumentCommand` — DOC-09 (RN-DOC-43 · FA-01): tipo com `requiresApproval`;
 * `DRAFT`/`RETURNED` → `IN_REVIEW` com a versão `SUBMISSION` e a `Approval` avulsa
 * (`subjectType = DOCUMENT`) aberta no mesmo `tx` pela porta do módulo `approval`.
 */
@Injectable()
export class SubmitDocumentCommand extends ConcludeDocumentCommand {
  protected readonly action = 'SUBMIT';

  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    lifecycle: DocumentLifecycleService,
    @Inject(DOCUMENT_CLOCK) clock: DocumentClock,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
    private readonly approvals: DocumentApprovalRegistry,
  ) {
    super(transactions, lifecycle, clock, audit, outbox);
  }

  protected conclude(
    _tx: TenantTx,
    context: DocumentContext,
    stamp: { actorId: string; now: Date; versionId: string; versionNumber: number },
  ): Promise<{ next: Document; approvalId: string }> {
    const approvalId = newId();
    const next = this.lifecycle.transition(() =>
      submitDocument(context.document, context.type, { ...stamp, approvalId }),
    );
    return Promise.resolve({ next, approvalId });
  }

  protected override async requestApproval(
    tx: TenantTx,
    context: DocumentContext,
    document: Document,
    version: DocumentVersionRecord,
    approvalId: string | null,
    now: Date,
  ): Promise<void> {
    const policy = context.type.approvalPolicy;
    if (approvalId === null || policy === null) throw new ApiError('APPROVER_UNRESOLVED');
    await this.approvals.requestForDocumentSubmission(tx, {
      approvalId,
      processId: document.processId,
      documentId: document.id,
      documentVersionId: version.id,
      documentCode: document.code,
      documentTitle: document.title,
      documentTypeName: context.type.name,
      policy,
      requestedById: version.createdById,
      requestedAt: now,
      organizationId: context.process.organizationId,
      requestingSecretariatId: context.process.requestingSecretariatId,
      requestingDepartmentId: context.process.requestingDepartmentId,
    });
  }
}

// --- Reabrir (DOC-12) ---------------------------------------------------------------------------

export interface ReopenDocumentInput {
  readonly documentId: string;
  readonly expectedVersion: number;
  readonly reason: string;
}

/**
 * `ReopenDocumentCommand` — DOC-12 (RN-DOC-47 · POL-11 · FA-05): `APPROVED`/`FINALIZED`/`REJECTED`
 * → `DRAFT` com justificativa; o rascunho de trabalho nasce das seções da versão corrente; sem
 * versão nova. Aprovação pendente → 409 `INVALID_STATE` (V-04).
 */
@Injectable()
export class ReopenDocumentCommand extends DocumentTransitionCommand<ReopenDocumentInput> {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    lifecycle: DocumentLifecycleService,
    @Inject(DOCUMENT_CLOCK) clock: DocumentClock,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
  ) {
    super(transactions, lifecycle, clock, audit, outbox);
  }

  protected async handle(
    tx: TenantTx,
    input: ReopenDocumentInput,
  ): Promise<DocumentTransitionResult> {
    const context = await this.lifecycle.load(tx, input.documentId);
    const actor = await this.lifecycle.actorOf(context);
    await this.lifecycle.authorizeReopen(context, actor);
    this.lifecycle.assertVersion(context, input.expectedVersion);
    const { document, type } = context;
    const actorId = this.actorId();
    const now = this.clock();
    const base =
      document.currentVersionId === null
        ? null
        : await this.lifecycle.findVersion(tx, document.currentVersionId);
    const baseContent = base?.content ?? null;
    const baseSections =
      baseContent === null
        ? null
        : draftSectionsFromSnapshot(baseContent, { actorId, now }, document.draftContent.sections);
    const next = this.lifecycle.transition(() =>
      reopenDocument(document, { actorId, now, reason: input.reason, baseSections }),
    );
    const saved = await this.lifecycle.save(tx, next, input.expectedVersion);
    // US-017 (RN-DFD-69): efeitos do módulo tipado na reabertura (o DFD volta à revisão).
    await this.lifecycle.reopened(
      tx,
      { ...context, document: saved },
      { fromStatus: document.status, actorId, now },
    );
    await this.audit.record(tx, {
      action: 'document.reopen',
      entityType: 'Document',
      entityId: saved.id,
      processId: saved.processId,
      changes: statusChange(document.status, saved.status),
      metadata: {
        fromStatus: document.status,
        baseVersionId: document.currentVersionId,
        documentCode: saved.code,
        documentTypeCode: type.code,
        reopenReason: fingerprint(input.reason),
      },
    });
    await this.outbox.record(
      tx,
      DocumentReopened.of({
        aggregateId: saved.id,
        processId: saved.processId,
        payload: {
          documentId: saved.id,
          documentTypeCode: type.code,
          fromStatus: document.status,
          baseVersionId: document.currentVersionId,
        },
      }),
    );
    return this.result(context, actor, saved, {
      action: 'REOPEN',
      fromStatus: document.status,
      toStatus: saved.status,
    });
  }
}

// --- Cancelar (DOC-13) --------------------------------------------------------------------------

export interface CancelDocumentInput {
  readonly documentId: string;
  readonly expectedVersion: number;
  readonly reason: string;
}

/**
 * `CancelDocumentCommand` — DOC-13 (RN-DOC-48 · FA-06): `DRAFT`/`RETURNED` → `CANCELED` (final), com
 * justificativa e custódia atual do processo (sem custódia → 403 `NOT_PROCESS_CUSTODIAN`). Libera a
 * vaga do tipo singular (o índice parcial ignora cancelados).
 */
@Injectable()
export class CancelDocumentCommand extends DocumentTransitionCommand<CancelDocumentInput> {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    lifecycle: DocumentLifecycleService,
    @Inject(DOCUMENT_CLOCK) clock: DocumentClock,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
  ) {
    super(transactions, lifecycle, clock, audit, outbox);
  }

  protected async handle(
    tx: TenantTx,
    input: CancelDocumentInput,
  ): Promise<DocumentTransitionResult> {
    const context = await this.lifecycle.load(tx, input.documentId);
    const actor = await this.lifecycle.actorOf(context);
    await this.lifecycle.authorizeCancel(context, actor);
    this.lifecycle.assertVersion(context, input.expectedVersion);
    const { document, type } = context;
    const next = this.lifecycle.transition(() =>
      cancelDocument(document, {
        actorId: this.actorId(),
        now: this.clock(),
        reason: input.reason,
      }),
    );
    const saved = await this.lifecycle.save(tx, next, input.expectedVersion);
    await this.audit.record(tx, {
      action: 'document.cancel',
      entityType: 'Document',
      entityId: saved.id,
      processId: saved.processId,
      changes: statusChange(document.status, saved.status),
      metadata: {
        fromStatus: document.status,
        documentCode: saved.code,
        documentTypeCode: type.code,
        cancellationReason: fingerprint(input.reason),
      },
    });
    await this.outbox.record(
      tx,
      DocumentCanceled.of({
        aggregateId: saved.id,
        processId: saved.processId,
        payload: { documentId: saved.id, documentTypeCode: type.code, fromStatus: document.status },
      }),
    );
    return this.result(context, actor, saved, {
      action: 'CANCEL',
      fromStatus: document.status,
      toStatus: saved.status,
    });
  }
}

// --- Retirar a submissão (DOC-11) ---------------------------------------------------------------

export interface WithdrawDocumentInput {
  readonly documentId: string;
  /** `If-Match` (versão do documento). */
  readonly expectedVersion: number;
  /** Motivo opcional (nunca vai a log nem a payload). */
  readonly reason: string | null;
  readonly idempotencyKey: string | null;
}

/** 409 `APPROVAL_NOT_PENDING` (DOC-11 · V-03): o documento não está em análise. */
function documentNotUnderReview(): ApiError {
  return new ApiError('APPROVAL_NOT_PENDING', {
    detail: APPROVAL_WITHDRAWAL_MESSAGES.notPending,
  });
}

/**
 * `WithdrawDocumentCommand` — DOC-11 (US-053 · FA-01 · RN-DOC-46 · DEC-018): retira a aprovação
 * pendente que cobre o documento em `IN_REVIEW`. Não `IN_REVIEW` (já decidido ou retirado) = 409
 * `APPROVAL_NOT_PENDING` antes do `If-Match` do documento (412). A retirada é a do `approval`
 * (porta `DocumentApprovalRegistry` — mesmas regras do APV-04): POL-17 (avulsa: permissão de
 * submissão do tipo cobrindo o processo; etapa: custódia anterior), `ApprovalCanceled`
 * (`WITHDRAWN`), `approval.withdraw`, o documento de volta a `DRAFT` (`document.withdraw`,
 * `DocumentWithdrawn`) e, na etapa, a devolução do processo.
 */
@Injectable()
export class WithdrawDocumentCommand extends DocumentTransitionCommand<WithdrawDocumentInput> {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    lifecycle: DocumentLifecycleService,
    @Inject(DOCUMENT_CLOCK) clock: DocumentClock,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
    private readonly approvals: DocumentApprovalRegistry,
  ) {
    super(transactions, lifecycle, clock, audit, outbox);
  }

  protected async handle(
    tx: TenantTx,
    input: WithdrawDocumentInput,
  ): Promise<DocumentTransitionResult> {
    const context = await this.lifecycle.load(tx, input.documentId);
    const { document } = context;
    if (document.status !== 'IN_REVIEW' || document.pendingApprovalId === null) {
      throw documentNotUnderReview();
    }
    this.lifecycle.assertVersion(context, input.expectedVersion);
    await this.approvals.withdrawForDocument(tx, {
      approvalId: document.pendingApprovalId,
      documentId: document.id,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    const fresh = await this.lifecycle.load(tx, input.documentId);
    const actor = await this.lifecycle.actorOf(fresh);
    return this.result(fresh, actor, fresh.document, {
      action: 'WITHDRAW',
      fromStatus: document.status,
      toStatus: fresh.document.status,
    });
  }
}

// --- Excluir (DOC-14) ---------------------------------------------------------------------------

export interface DeleteDocumentInput {
  readonly documentId: string;
  readonly expectedVersion: number;
}

/**
 * `DeleteDocumentCommand` — DOC-14 (RN-DOC-49 · FA-07 · DEC-034): exclusão lógica do rascunho que
 * nunca saiu de `DRAFT` (permissão de edição do tipo + POL-02); já submetido → 409 `INVALID_STATE`
 * (V-07: só cancelar). Sem evento de domínio; auditoria `document.delete`.
 */
@Injectable()
export class DeleteDocumentCommand extends DocumentTransitionCommand<DeleteDocumentInput> {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    lifecycle: DocumentLifecycleService,
    @Inject(DOCUMENT_CLOCK) clock: DocumentClock,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
  ) {
    super(transactions, lifecycle, clock, audit, outbox);
  }

  protected async handle(
    tx: TenantTx,
    input: DeleteDocumentInput,
  ): Promise<DocumentTransitionResult> {
    const context = await this.lifecycle.load(tx, input.documentId);
    const actor = await this.lifecycle.actorOf(context);
    await this.lifecycle.authorizePol02(context, actor, 'edit');
    this.lifecycle.assertVersion(context, input.expectedVersion);
    const { document, type } = context;
    const next = this.lifecycle.transition(() =>
      deleteDocument(document, { actorId: this.actorId(), now: this.clock() }),
    );
    const saved = await this.lifecycle.save(tx, next, input.expectedVersion);
    await this.audit.record(tx, {
      action: 'document.delete',
      entityType: 'Document',
      entityId: saved.id,
      processId: saved.processId,
      metadata: { documentTypeCode: type.code, documentCode: saved.code },
    });
    return {
      document: saved,
      type,
      allowedActions: [],
      transition: { action: 'DELETE', fromStatus: document.status, toStatus: 'DELETED' },
    };
  }
}

// --- Cabeçalho (DOC-04) -------------------------------------------------------------------------

export interface UpdateDocumentHeaderInput {
  readonly documentId: string;
  readonly expectedVersion: number;
  readonly patch: DocumentHeaderPatch;
}

/**
 * `UpdateDocumentHeaderCommand` — DOC-04 (RN-DOC-55 · POL-02): título e responsável do rascunho
 * (`DRAFT`/`RETURNED`; fora disso 409 `DOCUMENT_NOT_EDITABLE`); o responsável precisa de vínculo
 * ativo no tenant. Sem versão nova; auditoria `document.draft_update` coalescida (RN-DOC-54).
 */
@Injectable()
export class UpdateDocumentHeaderCommand extends DocumentTransitionCommand<UpdateDocumentHeaderInput> {
  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) transactions: DocumentTransactions,
    lifecycle: DocumentLifecycleService,
    @Inject(DOCUMENT_CLOCK) clock: DocumentClock,
    @Inject(AUDIT_TRAIL) audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) outbox: OutboxWriterPort,
    private readonly identity: IdentityFacade,
  ) {
    super(transactions, lifecycle, clock, audit, outbox);
  }

  protected async handle(
    tx: TenantTx,
    input: UpdateDocumentHeaderInput,
  ): Promise<DocumentTransitionResult> {
    const context = await this.lifecycle.load(tx, input.documentId);
    const actor = await this.lifecycle.actorOf(context);
    await this.lifecycle.authorizePol02(context, actor, 'edit');
    this.lifecycle.assertVersion(context, input.expectedVersion);
    const { document } = context;
    if (input.patch.responsibleId !== undefined)
      await this.assertResponsible(tx, input.patch.responsibleId);
    const now = this.clock();
    const { document: next, changes } = this.lifecycle.transition(() =>
      updateDocumentHeader(document, input.patch, { actorId: this.actorId(), now }),
    );
    if (changes.length === 0) return this.result(context, actor, document, null);
    const saved = await this.lifecycle.save(tx, next, input.expectedVersion);
    await this.audit.record(tx, {
      action: 'document.draft_update',
      entityType: 'Document',
      entityId: saved.id,
      processId: saved.processId,
      changes: changes.map((change) =>
        change.field === 'title'
          ? {
              path: 'title',
              old: change.old === null ? null : fingerprint(change.old),
              new: fingerprint(change.new),
            }
          : { path: change.field, old: change.old, new: change.new },
      ),
      metadata: { fields: changes.map((change) => change.field), documentCode: saved.code },
      coalesce: { scope: 'header', revision: saved.version, size: saved.title.length },
    });
    return this.result(context, actor, saved, null);
  }

  /** Responsável com vínculo ativo (e não vencido) no tenant — senão 422 (DOC-04). */
  private async assertResponsible(tx: TenantTx, userId: string): Promise<void> {
    const membership = await this.identity.membershipOfUser(tx, userId);
    const active =
      membership !== null &&
      membership.status === 'ACTIVE' &&
      (membership.expiresAt === null || membership.expiresAt.getTime() > this.clock().getTime());
    if (!active) {
      throw validationError([
        {
          field: 'responsibleId',
          code: membership === null ? 'REFERENCE_NOT_FOUND' : 'REFERENCE_INACTIVE',
          message: 'Escolha um responsável com acesso ativo ao órgão.',
        },
      ]);
    }
  }
}
