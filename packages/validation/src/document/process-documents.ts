import { z } from 'zod';

import { DOCUMENT_STATUSES } from './document-type.js';
import type { DocumentStatus } from './document-type.js';
import { documentMetaSchema, documentSchema } from './document.js';

/*
 * Painel de documentos do processo (US-062 · SCR-006, aba "Documentos" · api/03-documents.md
 * DOC-01). Filtros sobre a lista do processo (RN-DOC-20: sem paginação), o item com
 * `meta.allowedActions` (RN-DOC-18) e o resumo dos tipos que a etapa atual admite (RN-DOC-13/16) —
 * calculado no servidor, sem endpoint novo.
 */

export const PROCESS_DOCUMENTS_LIMITS = {
  /** V-02: busca com menos caracteres é ignorada pelo front (a API recusa). */
  queryMin: 2,
  queryMax: 120,
  /** Valores por filtro multivalorado. */
  maxValues: 50,
} as const;

export const PROCESS_DOCUMENTS_MESSAGES = {
  invalidFilter: 'Filtro inválido.',
  queryTooShort: 'Digite ao menos 2 caracteres para buscar.',
  loadFailed: 'Não foi possível carregar os documentos agora.',
} as const;

const M = PROCESS_DOCUMENTS_MESSAGES;

/**
 * Valor de query string: texto ou repetição (`?status=A&status=B`), achatado em uma lista (OU). O
 * erro aponta o parâmetro inteiro (`field = status`), não a posição do valor (V-01).
 */
function multi<T extends string>(
  isValid: (value: string) => value is T,
  code: 'INVALID_ENUM' | 'INVALID_FORMAT',
) {
  return z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      (Array.isArray(value) ? value.join(',') : value)
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    )
    .superRefine((values, context) => {
      if (
        values.length > PROCESS_DOCUMENTS_LIMITS.maxValues ||
        values.some((value) => !isValid(value))
      ) {
        context.addIssue({ code: 'custom', message: M.invalidFilter, params: { code } });
      }
    })
    .transform((values) => (values.length === 0 ? undefined : [...new Set(values as T[])]))
    .optional();
}

const isDocumentStatus = (value: string): value is DocumentStatus =>
  (DOCUMENT_STATUSES as readonly string[]).includes(value);
const isUuid = (value: string): value is string => z.uuid().safeParse(value).success;

/** DOC-01 (query): `type` (ids de `DocumentType`), `status`, `responsibleId`, `q` — combinados por E. */
export const processDocumentsQuerySchema = z
  .strictObject({
    type: multi(isUuid, 'INVALID_FORMAT'),
    status: multi(isDocumentStatus, 'INVALID_ENUM'),
    responsibleId: z.uuid({ error: M.invalidFilter }).optional(),
    q: z
      .string()
      .trim()
      .min(PROCESS_DOCUMENTS_LIMITS.queryMin, { error: M.queryTooShort })
      .max(PROCESS_DOCUMENTS_LIMITS.queryMax, { error: M.invalidFilter })
      .optional(),
  })
  .meta({ id: 'ProcessDocumentsQuery' });
export type ProcessDocumentsQuery = z.output<typeof processDocumentsQuerySchema>;

/**
 * Item do painel: o `Document` sem o rascunho de trabalho (`draftContent` fica no DOC-03 — o painel
 * nunca abre o conteúdo) + `meta.allowedActions` e o resumo tipado (POL-09 aplicada: campo
 * monetário `null` + `<campo>Masked: true` — RN-DOC-17).
 */
export const processDocumentSchema = documentSchema
  .omit({ draftContent: true })
  .extend({
    /** Nome exibido do responsável (vínculo no tenant); `null` sem responsável. */
    responsibleName: z.string().nullable(),
    /** Resumo do módulo tipado (ex.: valor total); `null` sem resumo (documentos livres/externos). */
    summary: z.record(z.string(), z.unknown()).nullable(),
    meta: documentMetaSchema,
  })
  .meta({ id: 'ProcessDocument' });
export type ProcessDocumentDto = z.infer<typeof processDocumentSchema>;

/**
 * Tipos da etapa atual (RN-DOC-13/14/16): `creatableTypeIds` alimenta o menu "Criar documento"
 * (tipo ativo, permitido na etapa, com a permissão de criação do usuário e — se singular — ainda
 * sem documento não cancelado); `pendingTypeIds` são os tipos singulares permitidos na etapa ainda
 * "Não iniciado". Ambos independem dos filtros.
 */
export const processDocumentsMetaSchema = z
  .object({
    currentStage: z
      .object({ key: z.string(), name: z.string(), documentTypeCodes: z.array(z.string()) })
      .nullable(),
    creatableTypeIds: z.array(z.uuid()),
    pendingTypeIds: z.array(z.uuid()),
  })
  .meta({ id: 'ProcessDocumentsMeta' });
export type ProcessDocumentsMeta = z.infer<typeof processDocumentsMetaSchema>;
