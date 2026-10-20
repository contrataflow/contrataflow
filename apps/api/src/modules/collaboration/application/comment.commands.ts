import { COMMENT_MESSAGES } from '@contrataflow/validation';
import type {
  CommentBody,
  CommentDto,
  CreateComment,
  DeleteComment,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@nestjs/common';

import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';

import {
  commentInvalidState,
  commentNotFound,
  commentVersionConflict,
  contentError,
  countCommentCreated,
  editWindowExpired,
  logRichTextRejected,
  moderationReasonRequired,
  notTheAuthor,
  readOnlyProcess,
  recordCommentDuration,
  referenceNotFound,
  sectionNotInTemplate,
  targetMismatch,
} from './comment.errors.js';
import { CommentGate, CommentPresenter, CommentRecorder, userIdOf } from './comment.support.js';
import type { CommentProcess } from './comment.support.js';
import { MentionWriter, NO_MENTIONS } from './mention.support.js';
import type { MentionOutcome } from './mention.support.js';
import { COMMENT_CLOCK, COMMENT_REPOSITORY, COMMENT_TRANSACTIONS } from './ports.js';
import type { CommentClock, CommentRepository, CommentTransactions } from './ports.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import {
  authorRefusal,
  commentContentOf,
  createComment,
  deleteByAuthor,
  editComment,
  inheritedTarget,
  isDeleted,
  moderateComment,
  parentRefusal,
} from '../domain/comment.js';
import type { AuthorRefusal, Comment, CommentTarget } from '../domain/comment.js';
import { mentionTargetsOf, newMentionTargets } from '../domain/mention.js';

/*
 * Comandos de comentários (US-071 · CMT-02..04): o padrão `TransactionalCommandHandler` — o
 * conteúdo restrito é conferido FORA da transação (RN-CMT-03..05, barato e sem banco); dentro, a
 * guarda (visibilidade 404 → `COMMENT_CREATE`/`COMMENT_MODERATE` 403 → status 409) → alvo e pai
 * (RN-CMT-01/02) → `If-Match` → domínio puro → gravação versionada → auditoria `comment.*` e
 * eventos `Comment*` (timeline e outbox no mesmo `tx`). Comentários não mexem no processo nem nos
 * documentos (RN-CMT-20). Logs de negócio só depois do commit e nunca com o texto.
 */

interface Prepared {
  readonly now: Date;
  readonly content: { readonly body: CommentBody; readonly bodyText: string } | null;
}

function logContext() {
  const context = requireRequestContext();
  return {
    tenantId: context.tenantId,
    userId: context.actor.userId,
    correlationId: context.correlationId,
  };
}

/**
 * Logs das menções depois do commit (US-072 · "Logs"): só ids e o tipo do alvo — nunca nome,
 * e-mail ou texto.
 */
function logMentions(logger: Logger, comment: Comment, outcome: MentionOutcome): void {
  for (const mention of outcome.created) {
    logger.log(
      {
        event: 'mention.created',
        mentionId: mention.id,
        commentId: comment.id,
        targetKind: mention.mentionedUserId === null ? 'DEPARTMENT' : 'USER',
        processId: comment.processId,
        ...logContext(),
      },
      'mention.created',
    );
  }
  for (const target of outcome.discarded) {
    logger.warn(
      {
        event: 'mention.target_unavailable',
        targetKind: target.kind,
        commentId: comment.id,
        processId: comment.processId,
        ...logContext(),
      },
      'mention.target_unavailable',
    );
  }
}

abstract class CommentCommand<I, O> extends TransactionalCommandHandler<I, Prepared, O> {
  protected constructor(
    name: string,
    transactions: CommentTransactions,
    private readonly clock: CommentClock,
  ) {
    super(name, transactions);
  }

  protected abstract bodyOf(input: I): CommentBody | null;

  protected prepare(input: I): Promise<Prepared> {
    const body = this.bodyOf(input);
    if (body === null) return Promise.resolve({ now: this.clock(), content: null });
    const content = commentContentOf(body);
    if (!content.ok) {
      logRichTextRejected(this.logger, content.issue, requireRequestContext().correlationId);
      return Promise.reject(contentError(content.issue));
    }
    return Promise.resolve({ now: this.clock(), content });
  }
}

/** 412 se o `If-Match` não é a versão atual (V-12). */
function assertVersion(comment: Comment, expectedVersion: number): void {
  if (comment.version !== expectedVersion) throw commentVersionConflict(comment.version);
}

/** Recusa do autor → erro da API (RN-CMT-08..10). */
function refusalError(refusal: AuthorRefusal, process: CommentProcess, deniedDetail: string) {
  switch (refusal) {
    case 'NOT_AUTHOR':
      return notTheAuthor(deniedDetail);
    case 'DELETED':
      return commentInvalidState(COMMENT_MESSAGES.alreadyDeleted);
    case 'INVALID_PROCESS_STATUS':
      return readOnlyProcess(process.status);
    case 'EDIT_WINDOW_EXPIRED':
      return editWindowExpired();
  }
}

/** Grava com a versão do `If-Match`; corrida com outra transação vira 412 com a vencedora. */
async function saveVersioned(
  comments: CommentRepository,
  tx: TenantTx,
  next: Comment,
  expectedVersion: number,
): Promise<void> {
  try {
    await comments.save(tx, next, expectedVersion);
  } catch (error) {
    if (error instanceof VersionConflictError) {
      const latest = await comments.findById(tx, next.id);
      if (latest === null) throw commentNotFound();
      throw commentVersionConflict(latest.version);
    }
    throw error;
  }
}

export interface CreateCommentInput {
  readonly processId: string;
  readonly body: CreateComment;
  readonly idempotencyKey: string | null;
}

export interface CommentResult {
  readonly dto: CommentDto;
  readonly comment: Comment;
  readonly mentions: MentionOutcome;
}

/** `CreateCommentCommand` — CMT-02 (fluxo principal, passo 4 · FA-01). */
@Injectable()
export class CreateCommentCommand extends CommentCommand<CreateCommentInput, CommentResult> {
  constructor(
    @Inject(COMMENT_TRANSACTIONS) transactions: CommentTransactions,
    @Inject(COMMENT_CLOCK) clock: CommentClock,
    @Inject(COMMENT_REPOSITORY) private readonly comments: CommentRepository,
    private readonly gate: CommentGate,
    private readonly documents: DocumentFacade,
    private readonly presenter: CommentPresenter,
    private readonly recorder: CommentRecorder,
    private readonly mentionWriter: MentionWriter,
  ) {
    super('comment.create', transactions, clock);
  }

  protected bodyOf({ body }: CreateCommentInput): CommentBody {
    return body.body;
  }

  protected async handle(
    tx: TenantTx,
    { processId, body, idempotencyKey }: CreateCommentInput,
    { now, content }: Prepared,
  ): Promise<CommentResult> {
    if (content === null) throw new Error('Comentário sem conteúdo conferido.');
    const process = await this.gate.writableProcess(tx, processId);

    // RN-CMT-02: a resposta é a um comentário raiz do mesmo processo e herda o alvo dele.
    let parent: Comment | null = null;
    let target: CommentTarget = {
      targetType: body.targetType,
      documentId: body.documentId ?? null,
      sectionKey: body.sectionKey ?? null,
    };
    if (body.parentId) {
      parent = await this.comments.findById(tx, body.parentId);
      if (parentRefusal(parent, processId) !== null || parent === null) {
        throw referenceNotFound('parentId', COMMENT_MESSAGES.parentNotFound);
      }
      const inherited = inheritedTarget(parent, body);
      if (inherited === null) throw targetMismatch();
      target = inherited;
    }

    // RN-CMT-01: documento do processo, não cancelado, e seção do template (externo não tem).
    let documentCode: string | null = null;
    if (target.targetType === 'DOCUMENT' && target.documentId !== null) {
      const document = await this.documents.commentTargetIn(tx, processId, target.documentId);
      if (document === null) {
        throw referenceNotFound('documentId', COMMENT_MESSAGES.documentNotFound);
      }
      if (document.status === 'CANCELED') {
        throw commentInvalidState(COMMENT_MESSAGES.documentCanceled);
      }
      if (target.sectionKey !== null && !document.sectionKeys?.includes(target.sectionKey)) {
        throw sectionNotInTemplate();
      }
      documentCode = document.code;
    }

    const userId = userIdOf();
    const comment = createComment({
      id: newId(),
      tenantId: requireRequestContext().tenantId ?? '',
      processId,
      target,
      parentId: parent?.id ?? null,
      authorId: userId,
      body: content.body,
      bodyText: content.bodyText,
      now,
    });
    await this.comments.insert(tx, comment);
    // US-072 (passo 4): menções válidas gravadas na mesma transação do comentário (RN-CMT-22/23).
    const mentions = await this.mentionWriter.record(
      tx,
      comment,
      mentionTargetsOf(comment.body),
      process.access,
      now,
    );
    await this.recorder.created(tx, comment, {
      processCode: process.code,
      documentCode,
      parentAuthorId: parent?.authorId ?? null,
      idempotencyKey,
      mentions: mentions.created,
    });
    const viewer = await this.gate.viewer(process, now);
    const [dto] = await this.presenter.present(tx, [comment], viewer);
    if (!dto) throw new Error('Comentário recém-criado sem DTO.');
    return { dto, comment, mentions };
  }

  protected override committed({ comment, mentions }: CommentResult, durationMs: number): void {
    logMentions(this.logger, comment, mentions);
    countCommentCreated(comment.targetType, comment.parentId !== null);
    recordCommentDuration('create', durationMs);
    this.logger.log(
      {
        event: 'comment.created',
        commentId: comment.id,
        processId: comment.processId,
        targetType: comment.targetType,
        isReply: comment.parentId !== null,
        bodyLength: Array.from(comment.bodyText).length,
        durationMs,
        ...logContext(),
      },
      'comment.created',
    );
  }
}

export interface UpdateCommentInput {
  readonly commentId: string;
  readonly body: CommentBody;
  /** Versão do `If-Match` (DEC-104). */
  readonly expectedVersion: number;
}

/** `UpdateCommentCommand` — CMT-03 (FA-02 · RN-CMT-09). */
@Injectable()
export class UpdateCommentCommand extends CommentCommand<UpdateCommentInput, CommentResult> {
  constructor(
    @Inject(COMMENT_TRANSACTIONS) transactions: CommentTransactions,
    @Inject(COMMENT_CLOCK) clock: CommentClock,
    @Inject(COMMENT_REPOSITORY) private readonly comments: CommentRepository,
    private readonly gate: CommentGate,
    private readonly presenter: CommentPresenter,
    private readonly recorder: CommentRecorder,
    private readonly mentionWriter: MentionWriter,
  ) {
    super('comment.update', transactions, clock);
  }

  protected bodyOf({ body }: UpdateCommentInput): CommentBody {
    return body;
  }

  protected async handle(
    tx: TenantTx,
    { commentId, expectedVersion }: UpdateCommentInput,
    { now, content }: Prepared,
  ): Promise<CommentResult> {
    if (content === null) throw new Error('Edição sem conteúdo conferido.');
    const { comment, process } = await this.gate.visibleComment(tx, commentId);
    const userId = userIdOf();
    if (comment.authorId !== userId) throw notTheAuthor(COMMENT_MESSAGES.editDenied);
    // Concorrência: a versão vem antes do estado (a moderação concorrente responde 412).
    assertVersion(comment, expectedVersion);
    const refusal = authorRefusal(comment, {
      userId,
      now,
      processStatus: process.status,
      action: 'edit',
    });
    if (refusal !== null) throw refusalError(refusal, process, COMMENT_MESSAGES.editDenied);

    const next = editComment(comment, content, now);
    await saveVersioned(this.comments, tx, next, expectedVersion);
    // FA-06 · RN-CMT-24: só os alvos novos frente ao corpo anterior.
    const targets = newMentionTargets(comment.body, next.body);
    const mentions =
      targets.length === 0
        ? NO_MENTIONS
        : await this.mentionWriter.record(tx, next, targets, process.access, now);
    await this.recorder.updated(tx, comment, next, mentions.created);
    const viewer = await this.gate.viewer(process, now);
    const [dto] = await this.presenter.present(tx, [next], viewer);
    if (!dto) throw new Error('Comentário sem DTO.');
    return { dto, comment: next, mentions };
  }

  protected override committed({ comment, mentions }: CommentResult, durationMs: number): void {
    logMentions(this.logger, comment, mentions);
    recordCommentDuration('update', durationMs);
    this.logger.log(
      {
        event: 'comment.updated',
        commentId: comment.id,
        processId: comment.processId,
        targetType: comment.targetType,
        isReply: comment.parentId !== null,
        bodyLength: Array.from(comment.bodyText).length,
        durationMs,
        ...logContext(),
      },
      'comment.updated',
    );
  }
}

export interface DeleteCommentInput {
  readonly commentId: string;
  readonly body: DeleteComment;
  readonly expectedVersion: number;
}

interface DeleteCommentResult {
  readonly comment: Comment;
  readonly byModerator: boolean;
}

/** `DeleteCommentCommand` — CMT-04: exclusão pelo autor (FA-03) ou moderação (FA-04). */
@Injectable()
export class DeleteCommentCommand extends CommentCommand<DeleteCommentInput, DeleteCommentResult> {
  constructor(
    @Inject(COMMENT_TRANSACTIONS) transactions: CommentTransactions,
    @Inject(COMMENT_CLOCK) clock: CommentClock,
    @Inject(COMMENT_REPOSITORY) private readonly comments: CommentRepository,
    private readonly gate: CommentGate,
    private readonly recorder: CommentRecorder,
  ) {
    super('comment.delete', transactions, clock);
  }

  protected bodyOf(): null {
    return null;
  }

  protected async handle(
    tx: TenantTx,
    { commentId, body, expectedVersion }: DeleteCommentInput,
    { now }: Prepared,
  ): Promise<DeleteCommentResult> {
    const { comment, process } = await this.gate.visibleComment(tx, commentId);
    const userId = userIdOf();
    // RN-CMT-11: o moderador que exclui o próprio comentário age como autor (sem motivo).
    const byModerator = comment.authorId !== userId;
    let next: Comment;
    if (byModerator) {
      await this.gate.assertModerator(process);
      if (body.reason === undefined) throw moderationReasonRequired();
      assertVersion(comment, expectedVersion);
      if (isDeleted(comment)) throw commentInvalidState(COMMENT_MESSAGES.alreadyDeleted);
      next = moderateComment(comment, { moderatorId: userId, reason: body.reason, now });
    } else {
      assertVersion(comment, expectedVersion);
      const refusal = authorRefusal(comment, {
        userId,
        now,
        processStatus: process.status,
        action: 'delete',
      });
      if (refusal !== null) throw refusalError(refusal, process, COMMENT_MESSAGES.deleteDenied);
      next = deleteByAuthor(comment, now);
    }
    await saveVersioned(this.comments, tx, next, expectedVersion);
    const hadReplies = byModerator ? false : (await this.comments.countReplies(tx, comment.id)) > 0;
    await this.recorder.deleted(tx, next, { processCode: process.code, byModerator, hadReplies });
    return { comment: next, byModerator };
  }

  protected override committed(
    { comment, byModerator }: DeleteCommentResult,
    durationMs: number,
  ): void {
    recordCommentDuration('delete', durationMs);
    this.logger.log(
      {
        event: 'comment.deleted',
        commentId: comment.id,
        processId: comment.processId,
        targetType: comment.targetType,
        isReply: comment.parentId !== null,
        byModerator,
        durationMs,
        ...logContext(),
      },
      'comment.deleted',
    );
  }
}
