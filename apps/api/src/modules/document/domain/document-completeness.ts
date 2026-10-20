import { DOCUMENT_LIMITS, countToConfirmNodes, richTextPlainText } from '@contrataflow/validation';
import type {
  DocumentKind,
  DraftSection,
  SectionDefinition,
  SectionRequirement,
  SectionState,
  Violation,
} from '@contrataflow/validation';

import type { Document } from './document.js';
import { isAiReviewPending } from './section-ai-provenance.js';

/*
 * Validação de completude (US-065 · DOC-08 · RN-DOC-51 · api.md §2.1.2): regras GENÉRICAS do módulo
 * `document` — seções `REQUIRED`/`REQUIRED_OR_JUSTIFY` do template da versão, campos de cabeçalho
 * obrigatórios (`fieldConfig.required`), arquivo do documento externo (RN-DOC-40) e conteúdo de IA
 * não revisado (RN-AI-57) — compostas num único `violations[]` com as do `DocumentValidator` do
 * módulo tipado. Funções puras: a leitura do template e do módulo tipado é da aplicação.
 */

export interface CompletenessInput {
  readonly document: Pick<Document, 'draftContent' | 'currentVersionId'>;
  readonly kind: DocumentKind;
  /** Seções do template da versão do documento (vazio para `UPLOADED`). */
  readonly sections: readonly SectionDefinition[];
  /** Campos de cabeçalho obrigatórios (`fieldConfig[k].required`) e o rótulo de cada um. */
  readonly requiredHeaderFields: readonly { readonly field: string; readonly label: string }[];
  /** Valores do cabeçalho tipado (do módulo dono; `{}` para tipos livres). */
  readonly header: Readonly<Record<string, unknown>>;
}

export interface SectionCompleteness {
  readonly key: string;
  readonly requirement: SectionRequirement;
  readonly state: SectionState;
  readonly complete: boolean;
}

export interface CompletenessResult {
  readonly sections: readonly SectionCompleteness[];
  readonly violations: readonly Violation[];
}

function violation(
  code: string,
  message: string,
  location: Partial<Pick<Violation, 'sectionKey' | 'field' | 'itemId'>> = {},
  params: Record<string, unknown> = {},
  severity: Violation['severity'] = 'BLOCKING',
): Violation {
  return {
    code,
    severity,
    message,
    ruleId: null,
    sectionKey: location.sectionKey ?? null,
    field: location.field ?? null,
    itemId: location.itemId ?? null,
    params,
  };
}

/** Texto útil da seção (sem espaços nas pontas). */
function plainTextOf(section: DraftSection | undefined): string {
  if (!section?.content) return '';
  return richTextPlainText(section.content).trim();
}

function hasJustification(section: DraftSection | undefined): boolean {
  return (section?.justification?.trim().length ?? 0) >= DOCUMENT_LIMITS.reasonMin;
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * RN-AI-57 (US-122): conteúdo aplicado por IA sem revisão humana (`SECTION_AI_REVIEW_PENDING`) e
 * marcações "[a confirmar]" (`SECTION_PLACEHOLDER_PENDING`, `params.count`) — violações bloqueantes
 * independentes (FA-03), avaliadas em todo tipo de documento.
 */
function aiViolations(key: string, title: string, section: DraftSection | undefined): Violation[] {
  if (section?.state !== 'FILLED') return [];
  const at = { sectionKey: key };
  const violations: Violation[] = [];
  if (isAiReviewPending(section)) {
    violations.push(
      violation(
        'SECTION_AI_REVIEW_PENDING',
        `Revise o conteúdo gerado por IA na seção "${title}".`,
        at,
      ),
    );
  }
  const count = countToConfirmNodes(section.content);
  if (count > 0) {
    violations.push(
      violation(
        'SECTION_PLACEHOLDER_PENDING',
        `Resolva ${count === 1 ? 'o item' : `os ${String(count)} itens`} [a confirmar] da seção "${title}".`,
        at,
        { count },
      ),
    );
  }
  return violations;
}

/** Uma seção do template contra o rascunho: violações e se está completa. */
function evaluateSection(
  definition: SectionDefinition,
  section: DraftSection | undefined,
): { readonly result: SectionCompleteness; readonly violations: Violation[] } {
  const state: SectionState = section?.state ?? 'EMPTY';
  const text = plainTextOf(section);
  const at = { sectionKey: definition.key };
  const violations: Violation[] = [];

  if (state === 'NOT_APPLICABLE') {
    if (definition.requirement === 'REQUIRED') {
      violations.push(
        violation(
          'SECTION_REQUIRED',
          `Preencha a seção "${definition.title}": ela não admite "não se aplica".`,
          at,
        ),
      );
    } else if (!hasJustification(section)) {
      violations.push(
        violation(
          'SECTION_JUSTIFICATION_REQUIRED',
          `Justifique por que a seção "${definition.title}" não se aplica (mínimo de ${DOCUMENT_LIMITS.reasonMin} caracteres).`,
          at,
          { minChars: DOCUMENT_LIMITS.reasonMin },
        ),
      );
    }
  } else if (text === '') {
    if (definition.requirement === 'REQUIRED') {
      violations.push(violation('SECTION_REQUIRED', `Preencha a seção "${definition.title}".`, at));
    } else if (definition.requirement === 'REQUIRED_OR_JUSTIFY') {
      violations.push(
        violation(
          'SECTION_REQUIRED',
          `Preencha a seção "${definition.title}" ou justifique por que ela não se aplica.`,
          at,
        ),
      );
    }
  } else if (definition.minChars !== undefined && text.length < definition.minChars) {
    violations.push(
      violation(
        'SECTION_TOO_SHORT',
        `A seção "${definition.title}" deve ter ao menos ${definition.minChars} caracteres.`,
        at,
        { minChars: definition.minChars, length: text.length },
      ),
    );
  }

  violations.push(...aiViolations(definition.key, definition.title, section));

  return {
    violations,
    result: {
      key: definition.key,
      requirement: definition.requirement,
      state,
      complete: violations.length === 0,
    },
  };
}

/** Regras genéricas de completude do módulo `document` (RN-DOC-51 a). */
export function evaluateGenericCompleteness(input: CompletenessInput): CompletenessResult {
  const ordered = [...input.sections].sort((a, b) => a.order - b.order);
  const sections: SectionCompleteness[] = [];
  const violations: Violation[] = [];
  for (const definition of ordered) {
    const evaluated = evaluateSection(
      definition,
      input.document.draftContent.sections[definition.key],
    );
    sections.push(evaluated.result);
    violations.push(...evaluated.violations);
  }
  // Seções do rascunho fora do template (documento sem template, seção retirada): as marcas de IA
  // continuam bloqueando (RN-AI-57).
  const defined = new Set(ordered.map((definition) => definition.key));
  for (const key of Object.keys(input.document.draftContent.sections).sort()) {
    if (defined.has(key)) continue;
    violations.push(...aiViolations(key, key, input.document.draftContent.sections[key]));
  }
  for (const { field, label } of input.requiredHeaderFields) {
    if (isBlank(input.header[field])) {
      violations.push(violation('FIELD_REQUIRED', `Informe ${label}.`, { field }));
    }
  }
  // RN-DOC-40 (US-064): documento externo sem nenhum arquivo enviado não avança.
  if (input.kind === 'UPLOADED' && input.document.currentVersionId === null) {
    violations.push(
      violation('FIELD_REQUIRED', 'Envie o arquivo do documento.', { field: 'currentVersionId' }),
    );
  }
  return { sections, violations };
}

/**
 * Compõe as violações genéricas com as do módulo tipado (RN-DOC-51 b) num único array: bloqueantes
 * antes dos avisos, sem repetir a mesma pendência (mesmo código e mesmo local).
 */
export function composeViolations(
  generic: readonly Violation[],
  typed: readonly Violation[],
): Violation[] {
  const seen = new Set<string>();
  const unique: Violation[] = [];
  for (const item of [...generic, ...typed]) {
    const key = [item.code, item.sectionKey, item.field, item.itemId, item.ruleId].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return [
    ...unique.filter((item) => item.severity === 'BLOCKING'),
    ...unique.filter((item) => item.severity === 'WARNING'),
  ];
}

/** Resultado da checagem antes de finalizar/submeter (V-01/V-02 · FA-04). */
export type CompletenessGate =
  | { readonly kind: 'OK'; readonly acknowledged: readonly Violation[] }
  | { readonly kind: 'INCOMPLETE'; readonly violations: readonly Violation[] }
  | { readonly kind: 'WARNINGS_NOT_ACKNOWLEDGED'; readonly violations: readonly Violation[] };

/**
 * Bloqueantes impedem a ação (`DOCUMENT_INCOMPLETE`); avisos exigem reconhecimento explícito por
 * código em `acknowledgedWarnings` (`WARNINGS_NOT_ACKNOWLEDGED`) — DEC-016.
 */
export function gateCompleteness(
  violations: readonly Violation[],
  acknowledgedWarnings: readonly string[],
): CompletenessGate {
  const blocking = violations.filter((item) => item.severity === 'BLOCKING');
  if (blocking.length > 0) return { kind: 'INCOMPLETE', violations };
  const warnings = violations.filter((item) => item.severity === 'WARNING');
  const acknowledged = new Set(acknowledgedWarnings);
  const pending = warnings.filter((item) => !acknowledged.has(item.code));
  if (pending.length > 0) return { kind: 'WARNINGS_NOT_ACKNOWLEDGED', violations: pending };
  return { kind: 'OK', acknowledged: warnings };
}
