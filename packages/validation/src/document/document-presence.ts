import { z } from 'zod';

import { SECTION_KEY_MAX_LENGTH } from './template.js';
import { isoDateTimeSchema } from '../common/dates.js';

/*
 * DOC-24/25 — indicador de edição concorrente (US-070 · DEC-055 · RN-DOC-87..94 ·
 * api/03-documents.md). O editor de seções envia um heartbeat a cada 20 s enquanto está em foco; a
 * API guarda a presença no Redis com TTL de 60 s e devolve os DEMAIS editores ativos. Puramente
 * informativo: a prevenção de conflito continua sendo a revisão por seção (DOC-05).
 */

/** Intervalo do heartbeat no cliente (DEC-055 · RN-DOC-88) — fixo, sem configuração por tenant. */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 20_000;

/** Sem heartbeat por este tempo (três ciclos perdidos), a presença expira (RN-DOC-89). */
export const PRESENCE_TTL_MS = 60_000;

/** Corpo do DOC-24: a seção em foco no editor (opcional — ausente mantém a anterior). */
export const documentPresenceUpdateSchema = z
  .strictObject({
    sectionKey: z.string().trim().min(1).max(SECTION_KEY_MAX_LENGTH).optional(),
  })
  .meta({ id: 'DocumentPresenceUpdateRequest' });
export type DocumentPresenceUpdate = z.infer<typeof documentPresenceUpdateSchema>;

/** Outro editor com presença ativa no documento (RN-DOC-90). */
export const documentPresenceEditorSchema = z
  .object({
    userId: z.uuid(),
    name: z.string().nullable(),
    /** Seção em foco no editor dessa pessoa (`null` = nenhuma informada). */
    sectionKey: z.string().nullable(),
    /** Desde quando está nessa seção (ou no documento, sem seção). */
    since: isoDateTimeSchema,
  })
  .meta({ id: 'DocumentPresenceEditor' });
export type DocumentPresenceEditorDto = z.infer<typeof documentPresenceEditorSchema>;

/** Resposta 200 do DOC-24: os demais editores ativos, sem o próprio chamador. */
export const documentPresenceSchema = z
  .object({ editors: z.array(documentPresenceEditorSchema) })
  .meta({ id: 'DocumentPresence' });
export type DocumentPresenceDto = z.infer<typeof documentPresenceSchema>;
