import type { CursorMeta, CursorQuery, PageMeta, PageQuery } from '@contrataflow/validation';
import type { z } from 'zod';

import { validationError } from '../errors/api-error.js';

export type PageQueryDto = PageQuery;
export type CursorQueryDto = CursorQuery;

/** Lista paginada por página; o `EnvelopeInterceptor` a serializa como `{ data, meta }`. */
export class PageResult<T> {
  constructor(
    readonly items: readonly T[],
    readonly meta: PageMeta,
  ) {}
}

/** Feed por cursor; serializado como `{ data, meta: { nextCursor, hasMore } }`. */
export class CursorResult<T> {
  constructor(
    readonly items: readonly T[],
    readonly meta: CursorMeta,
  ) {}
}

/** Janela de consulta (`skip`/`take`) a partir da query, respeitando `PAGINATION_MAX_PAGE_SIZE`. */
export function pageWindow(query: PageQueryDto, maxPageSize: number) {
  const pageSize = Math.min(query.pageSize, maxPageSize);
  return { page: query.page, pageSize, skip: (query.page - 1) * pageSize, take: pageSize };
}

/** Monta o resultado de uma lista por página (DEC-106). */
export function pageResult<T>(
  items: readonly T[],
  window: { page: number; pageSize: number },
  totalItems: number,
): PageResult<T> {
  return new PageResult(items, {
    page: window.page,
    pageSize: window.pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / window.pageSize),
  });
}

/** Cursor opaco: JSON em base64url (o cliente nunca interpreta o conteúdo). */
export function encodeCursor(position: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

/**
 * Decodifica e valida o cursor com o schema da posição (o conteúdo vem do cliente); inválido →
 * 422 `VALIDATION_ERROR` no campo `cursor`.
 */
export function decodeCursor<T extends z.ZodType>(cursor: string, position: T): z.output<T> {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const parsed = position.safeParse(value);
    if (parsed.success) return parsed.data;
  } catch {
    // cai no erro de validação abaixo
  }
  throw validationError([{ field: 'cursor', code: 'INVALID_FORMAT', message: 'Cursor inválido.' }]);
}

/**
 * Resultado de um feed: busque `limit + 1` itens; o excedente indica `hasMore` e o último item
 * devolvido gera o próximo cursor.
 */
export function cursorResult<T>(
  fetched: readonly T[],
  limit: number,
  positionOf: (item: T) => Readonly<Record<string, unknown>>,
): CursorResult<T> {
  const items = fetched.slice(0, limit);
  const hasMore = fetched.length > limit;
  const last = items.at(-1);
  return new CursorResult(items, {
    nextCursor: hasMore && last !== undefined ? encodeCursor(positionOf(last)) : null,
    hasMore,
  });
}
