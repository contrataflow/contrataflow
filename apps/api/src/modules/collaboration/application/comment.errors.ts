import { COMMENT_MESSAGES } from '@contrataflow/validation';
import type { CommentContentIssue } from '@contrataflow/validation';
import type { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

import { ApiError, validationError } from '#shared/errors/api-error.js';

/*
 * Erros e telemetria dos comentários (US-071 · "Validações" V-01..V-12 · "Casos de erro" ·
 * "Logs"). Nunca texto do comentário, `bodyText`, URL de link nem motivo da moderação no log.
 */

/** 404 de comentário inexistente, de outro tenant ou de processo não visível (indistinguíveis). */
export function commentNotFound(): ApiError {
  return new ApiError('COMMENT_NOT_FOUND', { status: 404, detail: COMMENT_MESSAGES.notFound });
}

/** 404 de processo inexistente, de outro tenant ou não visível (DEC-024). */
export function commentProcessNotFound(): ApiError {
  return new ApiError('PROCESS_NOT_FOUND', { detail: 'Processo não encontrado.' });
}

/** V-09 (RN-CMT-08): processo em status final — comentários somente leitura. */
export function readOnlyProcess(status: string): ApiError {
  return new ApiError('INVALID_PROCESS_STATUS', {
    status: 409,
    detail: COMMENT_MESSAGES.readOnly,
    extensions: { status },
  });
}

/** V-10 (RN-CMT-09): 15 min depois de `createdAt`. */
export function editWindowExpired(): ApiError {
  return new ApiError('COMMENT_EDIT_WINDOW_EXPIRED', {
    status: 409,
    detail: COMMENT_MESSAGES.editWindowExpired,
  });
}

/** 409 `INVALID_STATE`: comentário já excluído (V-10) ou documento cancelado (V-05). */
export function commentInvalidState(detail: string): ApiError {
  return new ApiError('INVALID_STATE', { status: 409, detail });
}

/** V-12: `If-Match` divergente — 412 com a versão atual. */
export function commentVersionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: COMMENT_MESSAGES.versionConflict,
    extensions: { currentVersion },
  });
}

/** 403 sem auditoria de política: edição/exclusão de comentário de outra pessoa. */
export function notTheAuthor(detail: string): ApiError {
  return new ApiError('PERMISSION_DENIED', { detail });
}

/** V-06: seção fora do template ou em documento externo. */
export function sectionNotInTemplate(): ApiError {
  return new ApiError('SECTION_NOT_IN_TEMPLATE', {
    status: 422,
    detail: COMMENT_MESSAGES.sectionNotInTemplate,
    errors: [
      {
        field: 'sectionKey',
        code: 'REFERENCE_NOT_FOUND',
        message: COMMENT_MESSAGES.sectionNotInTemplate,
      },
    ],
  });
}

/** V-04/V-07: documento ou comentário pai inexistente, excluído ou de outro processo/tenant. */
export function referenceNotFound(field: 'documentId' | 'parentId', message: string): ApiError {
  return validationError([{ field, code: 'REFERENCE_NOT_FOUND', message }]);
}

/** V-08: alvo da resposta divergente do pai. */
export function targetMismatch(): ApiError {
  return validationError([
    { field: 'targetType', code: 'NOT_ALLOWED', message: COMMENT_MESSAGES.targetMismatch },
  ]);
}

/** V-11: motivo obrigatório (10–1.000) na moderação. */
export function moderationReasonRequired(): ApiError {
  return validationError([
    { field: 'reason', code: 'REQUIRED', message: COMMENT_MESSAGES.reasonLength },
  ]);
}

/** V-01/V-02/V-03: conteúdo fora do schema (422 `RICH_TEXT_INVALID`) ou vazio/longo demais. */
export function contentError(issue: CommentContentIssue): ApiError {
  if (issue.code === 'VALIDATION_ERROR') {
    return validationError([
      {
        field: 'body',
        code: issue.reason === 'EMPTY' ? 'REQUIRED' : 'TOO_LONG',
        message: issue.message,
      },
    ]);
  }
  return new ApiError('RICH_TEXT_INVALID', {
    status: 422,
    detail: issue.message,
    errors: [{ field: 'body', code: 'INVALID_FORMAT', message: issue.message }],
  });
}

/** `warn` `comment.rich_text_rejected`: só o motivo e o NOME do nó/marca (nunca o conteúdo). */
export function logRichTextRejected(
  logger: Logger,
  issue: CommentContentIssue,
  correlationId: string,
): void {
  if (issue.code !== 'RICH_TEXT_INVALID') return;
  logger.warn(
    {
      event: 'comment.rich_text_rejected',
      reason: issue.reason,
      element: issue.element,
      correlationId,
    },
    'comment.rich_text_rejected',
  );
}

let commentsCreated: Counter | undefined;
let commandDuration: Histogram | undefined;

/** `cf_comments_created_total{targetType,isReply}` (US-071 · DoD "métricas"). */
export function countCommentCreated(targetType: string, isReply: boolean): void {
  commentsCreated ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('cf_comments_created_total', {
      description: 'Comentários e respostas publicados, por alvo.',
    });
  commentsCreated.add(1, { targetType, isReply: String(isReply) });
}

/** `cf_comment_command_duration_ms{command}` — latência dos comandos de comentário. */
export function recordCommentDuration(command: string, durationMs: number): void {
  commandDuration ??= metrics
    .getMeter('contrataflow-api')
    .createHistogram('cf_comment_command_duration_ms', {
      description: 'Duração dos comandos de comentário (criação, edição, exclusão).',
      unit: 'ms',
    });
  commandDuration.record(durationMs, { command });
}
