import {
  COMMENT_MESSAGES,
  CommentCreated,
  CommentDeleted,
  CommentUpdated,
} from '@contrataflow/validation';
import type { CommentDto, ProcessStatus } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { isProcessVisible } from '#shared/auth/process-access.js';
import type { ProcessAccessTarget } from '#shared/auth/process-access.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentProcessContextRegistry } from '#shared/document/document-process-context.js';
import { ApiError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { commentNotFound, commentProcessNotFound, readOnlyProcess } from './comment.errors.js';
import { COMMENT_REPOSITORY } from './ports.js';
import type { CommentRepository } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { ProcessFacade } from '../../process/application/process.facade.js';
import { abilitiesOf, isDeleted, isModerated, processAcceptsComments } from '../domain/comment.js';
import type { Comment } from '../domain/comment.js';

/*
 * Peças comuns dos casos de uso de comentários (US-071): a guarda (visibilidade do processo —
 * DEC-024, `COMMENT_CREATE` por perfil com escopo ou participação — RN-CMT-07, status — RN-CMT-08),
 * o apresentador (`CommentPresenter`: autor, documento, ações e o mascaramento POL-09 do conteúdo
 * em documento `RESTRICTED` — RN-CMT-13) e a gravação dos efeitos na mesma transação (auditoria
 * `comment.*` e eventos `Comment*`, que projetam a timeline e alimentam o `COMMENT_REPLY`).
 */

/** O processo como os comentários o veem. */
export interface CommentProcess {
  readonly id: string;
  readonly code: string | null;
  readonly status: ProcessStatus;
  readonly isBudgetConfidential: boolean;
  readonly access: ProcessAccessTarget;
}

/** Quem lê: ações exibidas e o desmascaramento (POL-09 — avaliado só quando necessário). */
export interface CommentViewer {
  readonly userId: string;
  readonly now: Date;
  readonly process: CommentProcess;
  readonly canComment: boolean;
  readonly canModerate: boolean;
}

export const userIdOf = (): string => requireRequestContext().actor.userId ?? '';

@Injectable()
export class CommentGate {
  constructor(
    @Inject(COMMENT_REPOSITORY) private readonly comments: CommentRepository,
    private readonly processes: DocumentProcessContextRegistry,
    private readonly access: AccessFacade,
  ) {}

  /** CMT-01: processo visível ao usuário (DEC-024) ou 404 `PROCESS_NOT_FOUND`. */
  async visibleProcess(tx: TenantTx, processId: string): Promise<CommentProcess> {
    const process = await this.processes.load(tx, processId);
    const visibility = await this.access.processVisibilityScope();
    if (process === null || !isProcessVisible(visibility, process.access)) {
      throw commentProcessNotFound();
    }
    return {
      id: process.id,
      code: process.code,
      status: process.status,
      isBudgetConfidential: process.isBudgetConfidential,
      access: process.access,
    };
  }

  /** O que a tela precisa saber do usuário no processo (sem lançar nem auditar). */
  async viewer(process: CommentProcess, now: Date): Promise<CommentViewer> {
    return {
      userId: userIdOf(),
      now,
      process,
      canComment: await this.access.canOnProcess('COMMENT_CREATE', process.access),
      canModerate: await this.access.canOnProcess('COMMENT_MODERATE', process.access),
    };
  }

  /**
   * CMT-02 (RN-CMT-07/08): 404; 403 `PERMISSION_DENIED` com `access.denied` sem `COMMENT_CREATE`
   * (perfil ∪ participação `OBSERVER`/`COLLABORATOR`/`CONSULTANT`); 409 em status final.
   */
  async writableProcess(tx: TenantTx, processId: string): Promise<CommentProcess> {
    const process = await this.visibleProcess(tx, processId);
    await this.access.assertCanOnProcess(
      'COMMENT_CREATE',
      process.access,
      COMMENT_MESSAGES.permissionDenied,
    );
    if (!processAcceptsComments(process.status)) throw readOnlyProcess(process.status);
    return process;
  }

  /** CMT-03/04: o comentário (inclusive excluído) e o processo dele visível — senão 404. */
  async visibleComment(
    tx: TenantTx,
    commentId: string,
  ): Promise<{ readonly comment: Comment; readonly process: CommentProcess }> {
    const comment = await this.comments.findById(tx, commentId);
    if (comment === null) throw commentNotFound();
    try {
      return { comment, process: await this.visibleProcess(tx, comment.processId) };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'PROCESS_NOT_FOUND') throw commentNotFound();
      throw error;
    }
  }

  /** RN-CMT-11: `COMMENT_MODERATE` cobrindo o processo — 403 com `access.denied` (MFA: POL-14). */
  assertModerator(process: CommentProcess): Promise<void> {
    return this.access.assertCanOnProcess(
      'COMMENT_MODERATE',
      process.access,
      COMMENT_MESSAGES.deleteDenied,
    );
  }
}

@Injectable()
export class CommentPresenter {
  constructor(
    private readonly documents: DocumentFacade,
    private readonly processes: ProcessFacade,
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
  ) {}

  /**
   * DTOs de CMT-01..03: autor (nome e unidade de lotação), documento-alvo, ações e conteúdo —
   * `null` se excluído (RN-CMT-12) ou em documento `RESTRICTED` para quem não atende POL-09
   * (RN-CMT-13 · `bodyMasked`). Leituras por lote: uma por fonte, nunca por comentário.
   */
  async present(
    tx: TenantTx,
    comments: readonly Comment[],
    viewer: CommentViewer,
  ): Promise<CommentDto[]> {
    if (comments.length === 0) return [];
    const authorIds = [...new Set(comments.map((comment) => comment.authorId))];
    const documentIds = [
      ...new Set(comments.flatMap((comment) => (comment.documentId ? [comment.documentId] : []))),
    ];
    const names = await this.identity.userDisplayNames(tx, authorIds);
    const departments = await this.authorDepartments(tx, authorIds);
    const labels =
      documentIds.length > 0
        ? await this.documents.commentDocumentLabels(tx, documentIds)
        : new Map<string, never>();
    const restricted = (comment: Comment) =>
      comment.documentId !== null &&
      labels.get(comment.documentId)?.confidentiality === 'RESTRICTED';
    const needsBudget = comments.some((comment) => !isDeleted(comment) && restricted(comment));
    const canViewBudget = needsBudget
      ? await this.processes.canViewConfidentialBudget(tx, viewer.process.id)
      : true;

    return comments.map((comment) => {
      const deleted = isDeleted(comment);
      const moderated = isModerated(comment);
      const masked = !deleted && restricted(comment) && !canViewBudget;
      const abilities = abilitiesOf(comment, {
        userId: viewer.userId,
        now: viewer.now,
        processStatus: viewer.process.status,
        canModerate: viewer.canModerate,
      });
      const label = comment.documentId === null ? undefined : labels.get(comment.documentId);
      const showsReason = moderated && (comment.authorId === viewer.userId || viewer.canModerate);
      return {
        id: comment.id,
        processId: comment.processId,
        targetType: comment.targetType,
        document:
          comment.documentId === null
            ? null
            : { id: comment.documentId, code: label?.code ?? null, title: label?.title ?? '' },
        sectionKey: comment.sectionKey,
        parentId: comment.parentId,
        author: {
          id: comment.authorId,
          name: names.get(comment.authorId) ?? '',
          departmentName: departments.get(comment.authorId) ?? null,
        },
        body: deleted || masked ? null : { ...comment.body },
        bodyMasked: masked,
        createdAt: comment.createdAt.toISOString(),
        editedAt: comment.editedAt?.toISOString() ?? null,
        isDeleted: deleted,
        deletedByModerator: moderated,
        deletionReason: showsReason ? comment.deletionReason : null,
        canEdit: abilities.canEdit,
        editableUntil: abilities.editableUntil?.toISOString() ?? null,
        canDelete: abilities.canDelete,
        canModerate: abilities.canModerate,
        version: comment.version,
      };
    });
  }

  /** Unidade de lotação principal (a primeira) de cada autor no tenant da transação. */
  private async authorDepartments(
    tx: TenantTx,
    authorIds: readonly string[],
  ): Promise<Map<string, string>> {
    const firstDepartment = new Map<string, string>();
    for (const authorId of authorIds) {
      const [departmentId] = await this.identity.departmentsOfUser(tx, authorId);
      if (departmentId !== undefined) firstDepartment.set(authorId, departmentId);
    }
    if (firstDepartment.size === 0) return new Map();
    const names = await this.organization.departmentNames(tx, [
      ...new Set(firstDepartment.values()),
    ]);
    const result = new Map<string, string>();
    for (const [authorId, departmentId] of firstDepartment) {
      const name = names.get(departmentId);
      if (name !== undefined) result.set(authorId, name);
    }
    return result;
  }
}

@Injectable()
export class CommentRecorder {
  constructor(
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {}

  /** `comment.create` + `CommentCreated` (timeline `COMMENT_ADDED` no mesmo `tx`; RN-CMT-15/16). */
  async created(
    tx: TenantTx,
    comment: Comment,
    context: {
      readonly processCode: string | null;
      readonly documentCode: string | null;
      readonly parentAuthorId: string | null;
      readonly idempotencyKey: string | null;
    },
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'comment.create',
      entityType: 'Comment',
      entityId: comment.id,
      processId: comment.processId,
      // O caminho `body` é resumido pela auditoria como `{ hash, length }` (DEC-138 · RL-05).
      changes: [{ path: 'body', old: null, new: comment.bodyText }],
      metadata: {
        processCode: context.processCode,
        targetType: comment.targetType,
        ...(context.documentCode === null ? {} : { documentCode: context.documentCode }),
        ...(comment.sectionKey === null ? {} : { sectionKey: comment.sectionKey }),
        ...(comment.parentId === null ? {} : { parentId: comment.parentId }),
        idempotencyKey: context.idempotencyKey,
      },
    });
    await this.outbox.record(
      tx,
      CommentCreated.of({
        aggregateId: comment.id,
        processId: comment.processId,
        payload: {
          commentId: comment.id,
          targetType: comment.targetType,
          documentId: comment.documentId,
          sectionKey: comment.sectionKey,
          parentId: comment.parentId,
          parentAuthorId: context.parentAuthorId,
        },
      }),
    );
  }

  /** `comment.update` (hash e tamanho antes/depois, pela auditoria — RN-CMT-09) + `CommentUpdated`. */
  async updated(tx: TenantTx, before: Comment, after: Comment): Promise<void> {
    await this.audit.record(tx, {
      action: 'comment.update',
      entityType: 'Comment',
      entityId: after.id,
      processId: after.processId,
      changes: [{ path: 'body', old: before.bodyText, new: after.bodyText }],
      metadata: { version: after.version },
    });
    await this.outbox.record(
      tx,
      CommentUpdated.of({
        aggregateId: after.id,
        processId: after.processId,
        payload: { commentId: after.id },
      }),
    );
  }

  /** `comment.delete` (autor) ou `comment.moderate` (motivo em `metadata`) + `CommentDeleted`. */
  async deleted(
    tx: TenantTx,
    comment: Comment,
    context: {
      readonly processCode: string | null;
      readonly byModerator: boolean;
      readonly hadReplies: boolean;
    },
  ): Promise<void> {
    await this.audit.record(tx, {
      action: context.byModerator ? 'comment.moderate' : 'comment.delete',
      entityType: 'Comment',
      entityId: comment.id,
      processId: comment.processId,
      metadata: context.byModerator
        ? {
            processCode: context.processCode,
            authorId: comment.authorId,
            reason: comment.deletionReason,
          }
        : { processCode: context.processCode, hadReplies: context.hadReplies },
    });
    await this.outbox.record(
      tx,
      CommentDeleted.of({
        aggregateId: comment.id,
        processId: comment.processId,
        payload: { commentId: comment.id, byModerator: context.byModerator },
      }),
    );
  }
}
