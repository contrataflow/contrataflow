import {
  ACTOR_TYPES,
  TIMELINE_GROUPS,
  TIMELINE_VISIBILITIES,
  isTimelineGroup,
} from '@contrataflow/types';
import type { TimelineGroup } from '@contrataflow/types';
import { z } from 'zod';

import { isoDateTimeSchema } from '../common/dates.js';
import { cursorMetaSchema, cursorQuerySchema } from '../http/pagination.js';

/*
 * Timeline do processo (US-060 · PRC-12 · SCR-006 aba "Timeline"): filtros por grupo (RN-TML-12),
 * autor (RN-TML-11) e período (RN-TML-10), paginação por cursor opaco (RN-TML-09) e a entrada
 * devolvida — sempre `type` + `params`, nunca mensagem pronta (RN-TML-14). O mesmo schema valida a
 * query na API (422 `VALIDATION_ERROR`) e os filtros no front (V-01).
 */

/** Mensagens da tabela "Validações" da US-060 (V-01..V-04), compartilhadas com a tela. */
export const TIMELINE_MESSAGES = Object.freeze({
  periodRange: 'O período final deve ser igual ou posterior ao inicial.',
  invalidCursor: 'Não foi possível continuar a listagem. Role novamente desde o início.',
  invalidGroup: 'Filtro de grupo inválido.',
  invalidActor: 'Autor inválido.',
  tooManyValues: 'Selecione no máximo 50 opções por filtro.',
});

/** Máximo de valores por filtro multivalorado (mesmo limite da lista de processos). */
export const TIMELINE_MAX_FILTER_VALUES = 50;

/** Valor de query string: texto com vírgulas ou repetição (`?group=A&group=B`), achatado. */
const rawValues = z.union([z.string(), z.array(z.string())]).transform((value) =>
  (Array.isArray(value) ? value.join(',') : value)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== ''),
);

const groupFilter = rawValues
  .superRefine((values, context) => {
    if (values.some((value) => !isTimelineGroup(value))) {
      context.addIssue({
        code: 'custom',
        message: TIMELINE_MESSAGES.invalidGroup,
        params: { code: 'INVALID_ENUM' },
      });
    }
    if (values.length > TIMELINE_MAX_FILTER_VALUES) {
      context.addIssue({
        code: 'custom',
        message: TIMELINE_MESSAGES.tooManyValues,
        params: { code: 'OUT_OF_RANGE' },
      });
    }
  })
  .transform((values) =>
    values.length === 0 ? undefined : [...new Set(values)].map((value) => value as TimelineGroup),
  )
  .optional();

const actorFilter = rawValues
  .pipe(
    z
      .array(z.uuid({ error: TIMELINE_MESSAGES.invalidActor }))
      .max(TIMELINE_MAX_FILTER_VALUES, { error: TIMELINE_MESSAGES.tooManyValues }),
  )
  .transform((values) => (values.length === 0 ? undefined : [...new Set(values)]))
  .optional();

/** PRC-12 (query): cursor, limite (1–100, padrão 50), grupo, autor e período (UTC, inclusivo). */
export const processTimelineQuerySchema = cursorQuerySchema
  .extend({
    group: groupFilter,
    actorId: actorFilter,
    occurredFrom: isoDateTimeSchema.optional(),
    occurredTo: isoDateTimeSchema.optional(),
  })
  .superRefine((query, context) => {
    if (
      query.occurredFrom !== undefined &&
      query.occurredTo !== undefined &&
      Date.parse(query.occurredFrom) > Date.parse(query.occurredTo)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['occurredTo'],
        message: TIMELINE_MESSAGES.periodRange,
        params: { code: 'OUT_OF_RANGE' },
      });
    }
  })
  .meta({ id: 'ProcessTimelineQuery' });
export type ProcessTimelineQuery = z.output<typeof processTimelineQuerySchema>;

export const timelineGroupSchema = z.enum(TIMELINE_GROUPS);

/** `TimelineEntry` de PRC-12 (api/02-processes.md): nomes congelados no momento do fato. */
export const timelineEntrySchema = z
  .object({
    id: z.uuid(),
    occurredAt: isoDateTimeSchema,
    /** Registro `TimelineEntryType` (events.md §5) — `varchar(60)`, extensível sem migração. */
    type: z.string(),
    actorType: z.enum(ACTOR_TYPES),
    actorId: z.uuid().nullable(),
    /** Nome congelado do ator; `null` para `SYSTEM` (o front exibe "Sistema"). */
    actorName: z.string().nullable(),
    actorDepartmentName: z.string().nullable(),
    entityType: z.string().nullable(),
    entityId: z.uuid().nullable(),
    movementId: z.uuid().nullable(),
    /** Parâmetros da mensagem (RN-TML-14), por tipo — catálogo em events.md §5. */
    params: z.record(z.string(), z.unknown()),
    visibility: z.enum(TIMELINE_VISIBILITIES),
  })
  .meta({ id: 'TimelineEntry' });
export type TimelineEntryDto = z.infer<typeof timelineEntrySchema>;

export const processTimelineResponseSchema = z.object({
  data: z.array(timelineEntrySchema),
  meta: cursorMetaSchema,
});
export type ProcessTimelineResponse = z.infer<typeof processTimelineResponseSchema>;
