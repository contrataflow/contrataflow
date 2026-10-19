import {
  deriveSectionState,
  RICH_TEXT_MAX_BYTES,
  richTextProblem,
  sectionContentBytes,
  sectionContentLimitProblem,
  SECTION_NOT_APPLICABLE_JUSTIFICATION_MIN,
} from '@contrataflow/validation';
import type {
  DraftSection,
  RichTextDoc,
  SectionDefinition,
  SectionState,
  SystemDocumentModule,
} from '@contrataflow/validation';

import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

import type { TransitionStamp } from './document.js';
import { aiAfterSave } from './section-ai-provenance.js';

/*
 * `SectionDraft` (US-015 · RN-DFD-31/36 · DEC-056): a gravação de uma seção do rascunho pelo
 * autosave (DOC-05). Puro: confere o conteúdo contra o schema do editor e os limites da seção da
 * versão do template, deriva o estado no servidor e reconhece o reenvio idêntico (no-op). A
 * concorrência (revisão esperada) e o status do documento são do caso de uso, na atualização
 * condicional atômica.
 */

export interface SectionDraftInput {
  readonly content: RichTextDoc | null;
  readonly notApplicable: boolean;
  readonly justification: string | null;
}

export type SectionDraftProblem =
  | { readonly kind: 'RICH_TEXT_INVALID'; readonly message: string }
  | { readonly kind: 'PAYLOAD_TOO_LARGE' }
  | { readonly kind: 'TOO_LONG'; readonly maxChars: number }
  | { readonly kind: 'JUSTIFICATION_REQUIRED' }
  | { readonly kind: 'JUSTIFICATION_TOO_SHORT' };

/**
 * RN-DFD-31: schema de `packages/editor`/`validation` (nós desconhecidos → `RICH_TEXT_INVALID`),
 * até 1 MB serializado (`PAYLOAD_TOO_LARGE`), texto até `maxChars` (`TOO_LONG`); "não se aplica"
 * exige justificativa (US-020). O tamanho vem antes do schema: um corpo enorme não é percorrido.
 */
export function sectionDraftProblem(
  input: SectionDraftInput,
  definition: Pick<SectionDefinition, 'maxChars'>,
): SectionDraftProblem | null {
  if (sectionContentBytes(input.content) > RICH_TEXT_MAX_BYTES)
    return { kind: 'PAYLOAD_TOO_LARGE' };
  if (input.content !== null) {
    const problem = richTextProblem(input.content);
    if (problem !== null) return { kind: 'RICH_TEXT_INVALID', message: problem };
  }
  const limit = sectionContentLimitProblem(input.content, definition.maxChars);
  if (limit !== null) return limit;
  if (input.notApplicable) {
    const length = input.justification?.trim().length ?? 0;
    if (length === 0) return { kind: 'JUSTIFICATION_REQUIRED' };
    if (length < SECTION_NOT_APPLICABLE_JUSTIFICATION_MIN)
      return { kind: 'JUSTIFICATION_TOO_SHORT' };
  }
  return null;
}

/**
 * Tipos em que a seção `REQUIRED` não admite "não se aplica" na gravação (US-036 · RN-TR-12 · V-07:
 * 422 `NOT_ALLOWED` em `state`). Nos demais (DFD, ETP — RN-ETP-11), a marcação é aceita e só a
 * completude do DOC-08 a recusa como resolução.
 */
const REQUIRED_REJECTS_NOT_APPLICABLE: ReadonlySet<SystemDocumentModule> = new Set([
  'TERM_OF_REFERENCE',
]);

export function rejectsNotApplicable(
  systemModule: SystemDocumentModule | null,
  definition: Pick<SectionDefinition, 'requirement'>,
): boolean {
  return (
    definition.requirement === 'REQUIRED' &&
    systemModule !== null &&
    REQUIRED_REJECTS_NOT_APPLICABLE.has(systemModule)
  );
}

/** O que a seção passa a guardar (estado derivado; justificativa só em "não se aplica"). */
export interface SectionDraftValue {
  readonly state: SectionState;
  readonly content: RichTextDoc | null;
  readonly justification: string | null;
}

export function sectionDraftValue(input: SectionDraftInput): SectionDraftValue {
  const state = deriveSectionState(input);
  return {
    state,
    // `EMPTY` guarda `null` (como o rascunho inicial): só espaços não é conteúdo.
    content: state === 'EMPTY' ? null : input.content,
    justification: state === 'NOT_APPLICABLE' ? (input.justification?.trim() ?? null) : null,
  };
}

/** SHA-256 do JSON canônico do valor da seção (comparação do no-op e `contentHash` da auditoria). */
export function sectionValueHash(value: SectionDraftValue): string {
  return sha256Hex(
    canonicalJson({
      state: value.state,
      content: value.content,
      justification: value.justification,
    }),
  );
}

/**
 * RN-DFD-36: o valor é igual ao gravado (hash e estado) — reenvio após *timeout* ou gravação
 * repetida. Aceito como no-op (sem revisão nova nem auditoria), mesmo com `If-Match` desatualizado.
 */
export function isIdenticalSave(
  previous: DraftSection | undefined,
  next: SectionDraftValue,
): boolean {
  if (previous === undefined) return false;
  return (
    sectionValueHash({
      state: previous.state,
      content: previous.content ?? null,
      justification: previous.justification,
    }) === sectionValueHash(next)
  );
}

/**
 * A seção gravada: `revision + 1` (a seção ausente do rascunho conta como revisão 0), carimbo e a
 * proveniência de IA mantida enquanto houver conteúdo (US-122 · `aiAfterSave`).
 */
export function applySectionDraft(
  previous: DraftSection | undefined,
  value: SectionDraftValue,
  stamp: TransitionStamp,
): DraftSection {
  const ai = aiAfterSave(previous, value.state);
  return {
    state: value.state,
    content: value.content as DraftSection['content'],
    justification: value.justification,
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: stamp.now.toISOString(),
    updatedById: stamp.actorId,
    ...(ai === null && previous?.ai === undefined ? {} : { ai }),
  };
}
