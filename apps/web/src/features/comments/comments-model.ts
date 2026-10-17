import { COMMENT_LIMITS, validateCommentContent } from '@contrataflow/validation';
import type { CommentBody } from '@contrataflow/validation';

import { ApiError } from '@/lib/api/api-error';

import { textToCommentBody } from './comment-markup';

/*
 * Regras de tela dos comentários (US-071): validação no front (V-01/V-03 — a API confere de novo),
 * a tradução dos erros da API para a mensagem do compositor ("Casos de erro"), o rascunho por
 * processo/alvo em `sessionStorage` (FA-08) e a data relativa ("há 5 min").
 */

export type ComposerProblemKey =
  | 'length'
  | 'formatting'
  | 'link'
  | 'section'
  | 'documentCanceled'
  | 'readOnly'
  | 'permission'
  | 'editWindow'
  | 'stale'
  | 'notFound'
  | 'duplicate'
  | 'rateLimited'
  | 'unavailable'
  | 'invalid';

export interface ComposerProblem {
  readonly key: ComposerProblemKey;
  readonly correlationId: string;
}

/** V-01/V-03 no front: `body` pronto para enviar ou o motivo da recusa. */
export function prepareCommentBody(
  text: string,
):
  | { readonly ok: true; readonly body: CommentBody }
  | { readonly ok: false; readonly key: ComposerProblemKey } {
  const body = textToCommentBody(text);
  const result = validateCommentContent(body);
  if (result.ok) return { ok: true, body };
  if (result.issue.code === 'VALIDATION_ERROR') return { ok: false, key: 'length' };
  return { ok: false, key: result.issue.reason === 'LINK' ? 'link' : 'formatting' };
}

/** Código da API → mensagem do compositor (o texto permanece — FA-08). */
export function composerProblemOf(error: unknown): ComposerProblem {
  const correlationId = error instanceof ApiError ? (error.correlationId ?? '—') : '—';
  const key = ((): ComposerProblemKey => {
    if (!(error instanceof ApiError)) return 'unavailable';
    switch (error.code) {
      case 'RICH_TEXT_INVALID':
        return error.problem?.detail.includes('links') ? 'link' : 'formatting';
      case 'SECTION_NOT_IN_TEMPLATE':
        return 'section';
      case 'INVALID_PROCESS_STATUS':
        return 'readOnly';
      case 'COMMENT_EDIT_WINDOW_EXPIRED':
        return 'editWindow';
      case 'INVALID_STATE':
        return 'documentCanceled';
      case 'PERMISSION_DENIED':
        return 'permission';
      case 'VERSION_CONFLICT':
      case 'PRECONDITION_REQUIRED':
        return 'stale';
      case 'COMMENT_NOT_FOUND':
      case 'PROCESS_NOT_FOUND':
      case 'NOT_FOUND':
        return 'notFound';
      case 'IDEMPOTENCY_KEY_REUSED':
      case 'IDEMPOTENCY_IN_PROGRESS':
        return 'duplicate';
      case 'RATE_LIMITED':
        return 'rateLimited';
      case 'VALIDATION_ERROR':
        return error.errors.some((item) => item.field === 'body') ? 'length' : 'invalid';
      default:
        return 'unavailable';
    }
  })();
  return { key, correlationId };
}

/** Quantos caracteres o texto do compositor tem (o limite conta pontos de código). */
export const textLength = (text: string) => Array.from(text.trim()).length;

export const TEXT_MAX = COMMENT_LIMITS.textMax;

/** Chave do rascunho (FA-08): por processo e alvo. */
export function draftKeyOf(
  processId: string,
  target: { readonly documentId?: string | undefined; readonly parentId?: string | undefined },
): string {
  return ['cf.comment-draft', processId, target.documentId ?? '-', target.parentId ?? '-'].join(
    ':',
  );
}

export function readDraft(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function writeDraft(key: string, text: string): void {
  try {
    if (text === '') window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, text);
  } catch {
    // Armazenamento bloqueado: o texto continua no compositor.
  }
}

export type RelativeTime =
  | { readonly unit: 'now' }
  | { readonly unit: 'minutes' | 'hours' | 'days'; readonly count: number };

/** "agora", "há 5 min", "há 3 h", "há 2 dias" (a data absoluta vai no `title`). */
export function relativeTimeOf(iso: string, now: Date): RelativeTime {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return { unit: 'now' };
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hours', count: hours };
  return { unit: 'days', count: Math.floor(hours / 24) };
}

/** Envolve a seleção com a marcação (`**`, `*`) ou insere o prefixo de lista na linha. */
export function applyFormat(
  text: string,
  selection: { readonly start: number; readonly end: number },
  format: 'bold' | 'italic' | 'list' | 'link',
): { readonly text: string; readonly start: number; readonly end: number } {
  const before = text.slice(0, selection.start);
  const selected = text.slice(selection.start, selection.end);
  const after = text.slice(selection.end);
  if (format === 'list') {
    const lineStart = before.lastIndexOf('\n') + 1;
    const next = `${text.slice(0, lineStart)}- ${text.slice(lineStart)}`;
    return { text: next, start: selection.start + 2, end: selection.end + 2 };
  }
  if (format === 'link') {
    const label = selected === '' ? 'texto' : selected;
    const inserted = `[${label}](https://)`;
    const urlStart = before.length + label.length + 3;
    return { text: `${before}${inserted}${after}`, start: urlStart, end: urlStart + 8 };
  }
  const marker = format === 'bold' ? '**' : '*';
  return {
    text: `${before}${marker}${selected}${marker}${after}`,
    start: selection.start + marker.length,
    end: selection.end + marker.length,
  };
}
