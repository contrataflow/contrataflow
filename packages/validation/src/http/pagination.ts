import { z } from 'zod';

/** Tamanho máximo de página e de feed (DEC-106 · api.md §1.2). */
export const MAX_PAGE_SIZE = 100;

const positiveInt = (field: string, max?: number) => {
  const base = z.coerce
    .number({ error: `Informe um número inteiro em "${field}".` })
    .int({ error: `Informe um número inteiro em "${field}".` })
    .min(1, { error: `"${field}" deve ser maior ou igual a 1.` });
  return max === undefined
    ? base
    : base.max(max, { error: `"${field}" deve ser no máximo ${max}.` });
};

/**
 * Listas paginadas por página: `?page=1&pageSize=20` (máx. 100). Estrito: estenda com
 * `.extend({ … })` para os filtros e a ordenação de cada endpoint.
 */
export const pageQuerySchema = z
  .strictObject({
    page: positiveInt('page').default(1),
    pageSize: positiveInt('pageSize', MAX_PAGE_SIZE).default(20),
  })
  .meta({ id: 'PageQuery' });

export type PageQuery = z.infer<typeof pageQuerySchema>;

/** Feeds por cursor opaco: `?cursor=<opaco>&limit=50` (máx. 100). */
export const cursorQuerySchema = z
  .strictObject({
    cursor: z
      .string()
      .min(1, { error: 'Cursor inválido.' })
      .max(512, { error: 'Cursor inválido.' })
      .regex(/^[A-Za-z0-9_-]+$/, { error: 'Cursor inválido.' })
      .optional(),
    limit: positiveInt('limit', MAX_PAGE_SIZE).default(50),
  })
  .meta({ id: 'CursorQuery' });

export type CursorQuery = z.infer<typeof cursorQuerySchema>;

/** `meta` das listas paginadas por página. */
export const pageMetaSchema = z
  .object({
    page: z.int().min(1),
    pageSize: z.int().min(1).max(MAX_PAGE_SIZE),
    totalItems: z.int().min(0),
    totalPages: z.int().min(0),
  })
  .meta({ id: 'PageMeta' });

export type PageMeta = z.infer<typeof pageMetaSchema>;

/** `meta` dos feeds por cursor. */
export const cursorMetaSchema = z
  .object({
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .meta({ id: 'CursorMeta' });

export type CursorMeta = z.infer<typeof cursorMetaSchema>;
