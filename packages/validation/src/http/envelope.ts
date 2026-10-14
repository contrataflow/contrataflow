import { z } from 'zod';

import { cursorMetaSchema, pageMetaSchema } from './pagination.js';

/** Recurso único: `{ "data": { … } }` (DEC-106). */
export function dataEnvelope<T extends z.ZodType>(data: T) {
  return z.object({ data });
}

/** Lista paginada: `{ "data": [...], "meta": { page, pageSize, totalItems, totalPages } }`. */
export function pageEnvelope<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), meta: pageMetaSchema });
}

/** Feed por cursor: `{ "data": [...], "meta": { nextCursor, hasMore } }`. */
export function cursorEnvelope<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), meta: cursorMetaSchema });
}
