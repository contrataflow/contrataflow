import { z } from 'zod';

import { SECTION_STATES } from './document.js';
import type { SectionState } from './document.js';
import { RICH_TEXT_MAX_BYTES, richTextPlainText } from './rich-text.js';
import type { RichTextDoc } from './rich-text.js';
import { DEFAULT_SECTION_MAX_CHARS, SECTION_KEY_MAX_LENGTH } from './template.js';
import { isoDateTimeSchema } from '../common/dates.js';
import { uuidV7Schema } from '../common/identifiers.js';

/*
 * DOC-05 — gravação de seção do rascunho com controle de revisão (US-015 · DEC-055/056/182 ·
 * RN-DFD-23..36 · api/03-documents.md). O mecanismo genérico de autosave: o cliente envia o
 * conteúdo com `If-Match: "s<revision>"`; revisão divergente → 412 `SECTION_REVISION_CONFLICT`
 * com a seção atual em `meta.current`. Os mesmos schemas e limites servem à API, ao OpenAPI e ao
 * `useAutosave` (ETP, TR e documentos livres reutilizam).
 */

/** Mínimo da justificativa de "não se aplica" (DOC-05 · US-020). */
export const SECTION_NOT_APPLICABLE_JUSTIFICATION_MIN = 20;
export const SECTION_NOT_APPLICABLE_JUSTIFICATION_MAX = 2000;

/** Janela fixa do debounce do autosave (DEC-182 · RN-DFD-23). */
export const AUTOSAVE_DEBOUNCE_MS = 1500;

export const DOCUMENT_SECTION_MESSAGES = Object.freeze({
  preconditionRequired: 'Recarregue a página para continuar editando.',
  conflict: (name: string, time: string) => `Esta seção foi alterada por ${name} às ${time}.`,
  conflictTitle: 'A seção foi alterada por outra pessoa',
  notInTemplate: 'Esta seção não existe no modelo do documento.',
  richTextInvalid: 'O texto contém formatação não permitida. Cole como texto simples.',
  payloadTooLarge: 'O conteúdo desta seção é grande demais.',
  tooLong: (maxChars: number) => `O texto excede ${maxChars.toLocaleString('pt-BR')} caracteres.`,
  notEditable: 'Este documento não pode mais ser editado.',
  notCustodian: 'Somente quem está com o processo (ou colaboradores) pode editar.',
  justificationRequired: `Justifique por que a seção não se aplica (mín. ${String(SECTION_NOT_APPLICABLE_JUSTIFICATION_MIN)} caracteres).`,
  justificationTooShort: `A justificativa deve ter pelo menos ${String(SECTION_NOT_APPLICABLE_JUSTIFICATION_MIN)} caracteres.`,
  justificationTooLong: `Informe no máximo ${SECTION_NOT_APPLICABLE_JUSTIFICATION_MAX.toLocaleString('pt-BR')} caracteres.`,
});

export const documentSectionParamsSchema = z.strictObject({
  id: uuidV7Schema,
  sectionKey: z.string().trim().min(1).max(SECTION_KEY_MAX_LENGTH),
});
export type DocumentSectionParams = z.infer<typeof documentSectionParamsSchema>;

/**
 * Corpo do DOC-05. `content` é conferido contra o schema do editor NO CASO DE USO (422
 * `RICH_TEXT_INVALID`, 413 `PAYLOAD_TOO_LARGE`, `TOO_LONG`) — aqui só a forma. O DFD usa
 * `notApplicable: false`; `state` é a forma alternativa de api/03-documents.md (as duas valem:
 * `NOT_APPLICABLE` em qualquer uma marca a seção como "não se aplica" — US-020).
 */
export const documentSectionSaveSchema = z
  .strictObject({
    content: z.looseObject({ type: z.literal('doc') }).nullable(),
    notApplicable: z.boolean().optional(),
    state: z.enum(SECTION_STATES).optional(),
    justification: z.string().max(SECTION_NOT_APPLICABLE_JUSTIFICATION_MAX).nullable().optional(),
    /** Só em "Manter a minha versão" (RN-DFD-29): a revisão de outra pessoa que será sobrescrita. */
    overwrittenRevision: z.int().min(1).optional(),
  })
  .meta({ id: 'DocumentSectionSaveRequest' });
export type DocumentSectionSave = z.infer<typeof documentSectionSaveSchema>;

export const sectionAuthorSchema = z.object({ id: z.uuid(), name: z.string().nullable() });
export type SectionAuthor = z.infer<typeof sectionAuthorSchema>;

/** Resposta 200 do DOC-05 (`ETag: "s<revision>"`). */
export const documentSectionSavedSchema = z
  .object({
    sectionKey: z.string(),
    state: z.enum(SECTION_STATES),
    revision: z.int(),
    updatedAt: isoDateTimeSchema,
    updatedBy: sectionAuthorSchema.nullable(),
    draftRevision: z.int(),
  })
  .meta({ id: 'DocumentSectionSaved' });
export type DocumentSectionSavedDto = z.infer<typeof documentSectionSavedSchema>;

/** `meta.current` do 412 `SECTION_REVISION_CONFLICT` (FA-01): a seção como está no servidor. */
export const sectionConflictCurrentSchema = z
  .object({
    sectionKey: z.string(),
    state: z.enum(SECTION_STATES),
    revision: z.int(),
    content: z.looseObject({ type: z.literal('doc') }).nullable(),
    justification: z.string().nullable(),
    updatedAt: isoDateTimeSchema,
    updatedBy: sectionAuthorSchema.nullable(),
  })
  .meta({ id: 'SectionConflictCurrent' });
export type SectionConflictCurrent = z.infer<typeof sectionConflictCurrentSchema>;

/** `If-Match` da seção (api.md §1.3). */
export function sectionEtag(revision: number): string {
  return `"s${String(revision)}"`;
}

/** Revisão do `ETag: "s<revision>"` (`null` se o valor não for de seção). */
export function sectionRevisionOf(etag: string | null | undefined): number | null {
  const match = /^(?:W\/)?"s(\d{1,9})"$/.exec(etag?.trim() ?? '');
  return match ? Number(match[1]) : null;
}

// --- Limites e estado (RN-DFD-31) ---------------------------------------------------------------

/** Tamanho do JSON serializado (UTF-8) — limite de 1 MB por seção (DEC-056). */
export function sectionContentBytes(content: RichTextDoc | null | undefined): number {
  return content ? new TextEncoder().encode(JSON.stringify(content)).length : 0;
}

/** Caracteres do texto puro da seção (o que `maxChars` limita — V-07). */
export function sectionContentLength(content: RichTextDoc | null | undefined): number {
  return Array.from(richTextPlainText(content)).length;
}

/** Seção com texto útil (sem espaços) ou tabela com conteúdo → `FILLED` (RN-DFD-31). */
export function hasSectionText(content: RichTextDoc | null | undefined): boolean {
  return richTextPlainText(content).trim() !== '';
}

/** Estado derivado no servidor: `NOT_APPLICABLE` pedido, senão `FILLED`/`EMPTY` pelo conteúdo. */
export function deriveSectionState(input: {
  readonly content: RichTextDoc | null;
  readonly notApplicable: boolean;
}): SectionState {
  if (input.notApplicable) return 'NOT_APPLICABLE';
  return hasSectionText(input.content) ? 'FILLED' : 'EMPTY';
}

/** Problema de limite do conteúdo da seção (o cliente confere antes de enviar — V-06/V-07). */
export type SectionContentLimitProblem =
  { readonly kind: 'PAYLOAD_TOO_LARGE' } | { readonly kind: 'TOO_LONG'; readonly maxChars: number };

export function sectionContentLimitProblem(
  content: RichTextDoc | null | undefined,
  maxChars: number = DEFAULT_SECTION_MAX_CHARS,
): SectionContentLimitProblem | null {
  if (sectionContentBytes(content) > RICH_TEXT_MAX_BYTES) return { kind: 'PAYLOAD_TOO_LARGE' };
  if (sectionContentLength(content) > maxChars) return { kind: 'TOO_LONG', maxChars };
  return null;
}
