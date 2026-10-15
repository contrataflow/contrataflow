import { z } from 'zod';

import { DOCUMENT_TYPE_CODE_PATTERN } from '../document/document-type.js';
import { dataEnvelope } from '../http/envelope.js';

/*
 * Numeração configurável (US-105 · DEC-028 · api/14-tenant-administration.md SET-04): contrato da
 * prévia de máscara. A máscara é validada pela API (`NUMBERING_MASK_INVALID`), não pelo schema —
 * aqui só a forma e um teto de tamanho do corpo.
 */

/** `numbering.process.scope` (entities.md §6). */
export const NUMBERING_SCOPES = ['TENANT', 'ORGANIZATION'] as const;
export type NumberingScope = (typeof NUMBERING_SCOPES)[number];

/** `numbering.process.assignOn` (DEC-028 · RN-TEN-71). */
export const NUMBERING_ASSIGN_ON = ['CREATE', 'START'] as const;
export type NumberingAssignOn = (typeof NUMBERING_ASSIGN_ON)[number];

/**
 * SET-04: máscara ainda não salva (FA-04). Sem `documentTypeCode`, é a máscara do processo
 * (`{type}` recusado; `scope` padrão = o gravado); com ele, a de documento daquele tipo.
 */
export const numberingPreviewSchema = z.strictObject({
  mask: z.string().max(200),
  scope: z.enum(NUMBERING_SCOPES).optional(),
  documentTypeCode: z.string().regex(DOCUMENT_TYPE_CODE_PATTERN).optional(),
});
export type NumberingPreview = z.infer<typeof numberingPreviewSchema>;

/** Exemplo formatado com o próximo valor hipotético (`lastValue + 1`, sem incrementar). */
export const numberingPreviewResultSchema = z.object({
  example: z.string(),
  nextValue: z.string(),
});
export type NumberingPreviewResult = z.infer<typeof numberingPreviewResultSchema>;

export const numberingPreviewResponseSchema = dataEnvelope(numberingPreviewResultSchema);
