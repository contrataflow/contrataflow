import {
  DEFAULT_SECTION_MAX_CHARS,
  isRenderAllowed,
  MIN_GREATER_THAN_MAX_MESSAGE,
  richTextFromPlainText,
  richTextPlainText,
  SECTION_KEY_PATTERN,
  SECTION_RENDERS,
  SECTION_TEMPLATE_VARIABLES,
  templateVariablesIn,
  unknownVariableMessage,
} from '@contrataflow/validation';
import type {
  DocumentKind,
  SectionDefinition,
  SectionRender,
  SystemDocumentModule,
  Violation,
} from '@contrataflow/validation';

/*
 * Modelo do editor de template (SCR-114 · US-107): funções puras sobre a lista de seções em
 * edição. A validação local antecipa as mesmas regras da API (chave, variáveis, mínimo × máximo,
 * bloco × tipo) só para orientar o usuário — quem decide é o `TemplateContentValidator` (422
 * `TEMPLATE_INVALID`).
 */

export interface TemplateTypeInfo {
  readonly kind: DocumentKind;
  readonly systemModule: SystemDocumentModule | null;
}

/** Seção em edição: o conteúdo padrão como texto (um parágrafo por linha). */
export interface SectionDraft {
  /** Identidade local estável (a chave muda durante a edição). */
  readonly uid: string;
  readonly key: string;
  readonly title: string;
  readonly requirement: SectionDefinition['requirement'];
  readonly helpText: string;
  readonly legalBasis: string;
  readonly defaultContent: string;
  readonly minChars: string;
  readonly maxChars: string;
  readonly render: SectionRender;
  readonly allowNarrative: boolean;
}

let uidSequence = 0;
function nextUid(): string {
  uidSequence += 1;
  return `secao-${uidSequence}`;
}

export function toDraft(section: SectionDefinition): SectionDraft {
  return {
    uid: nextUid(),
    key: section.key,
    title: section.title,
    requirement: section.requirement,
    helpText: section.helpText ?? '',
    legalBasis: section.legalBasis ?? '',
    defaultContent: richTextPlainText(section.defaultContent),
    minChars: section.minChars === undefined ? '' : String(section.minChars),
    maxChars: String(section.maxChars),
    render: section.render,
    allowNarrative: section.allowNarrative,
  };
}

function optionalNumber(text: string): number | undefined {
  const trimmed = text.trim();
  return trimmed === '' ? undefined : Number(trimmed);
}

/** Seções do corpo do TPL-08, com `order` sequencial pela posição na lista (FA-01). */
export function toSections(drafts: readonly SectionDraft[]): SectionDefinition[] {
  return drafts.map((draft, index) => {
    const minChars = optionalNumber(draft.minChars);
    const helpText = draft.helpText.trim();
    const legalBasis = draft.legalBasis.trim();
    const content = draft.defaultContent.trim();
    return {
      key: draft.key.trim(),
      title: draft.title.trim(),
      order: index + 1,
      requirement: draft.requirement,
      ...(helpText === '' ? {} : { helpText }),
      ...(legalBasis === '' ? {} : { legalBasis }),
      ...(content === '' ? {} : { defaultContent: richTextFromPlainText(draft.defaultContent) }),
      ...(minChars === undefined ? {} : { minChars }),
      maxChars: optionalNumber(draft.maxChars) ?? DEFAULT_SECTION_MAX_CHARS,
      render: draft.render,
      allowNarrative: draft.allowNarrative,
    };
  });
}

/** Nova seção no fim da lista: obrigatória, bloco de texto e máximo padrão. */
export function newSection(): SectionDraft {
  return {
    uid: nextUid(),
    key: '',
    title: '',
    requirement: 'REQUIRED',
    helpText: '',
    legalBasis: '',
    defaultContent: '',
    minChars: '',
    maxChars: String(DEFAULT_SECTION_MAX_CHARS),
    render: 'TEXT',
    allowNarrative: true,
  };
}

/** FA-02: cópia logo abaixo da original, com chave sugerida `<CHAVE>_COPIA` (única na lista). */
export function duplicateSection(
  drafts: readonly SectionDraft[],
  uid: string,
): { readonly drafts: SectionDraft[]; readonly copyUid: string | null } {
  const index = drafts.findIndex((draft) => draft.uid === uid);
  const original = drafts[index];
  if (!original) return { drafts: [...drafts], copyUid: null };
  const keys = new Set(drafts.map((draft) => draft.key));
  let key = `${original.key}_COPIA`;
  for (let suffix = 2; keys.has(key); suffix += 1) key = `${original.key}_COPIA_${suffix}`;
  const copy: SectionDraft = {
    ...original,
    uid: nextUid(),
    key,
    title: `${original.title} (cópia)`,
  };
  return {
    drafts: [...drafts.slice(0, index + 1), copy, ...drafts.slice(index + 1)],
    copyUid: copy.uid,
  };
}

/** FA-01: move a seção para a posição `to` (arrastar ou teclado). */
export function moveSection(
  drafts: readonly SectionDraft[],
  from: number,
  to: number,
): SectionDraft[] {
  if (from === to || from < 0 || to < 0 || from >= drafts.length || to >= drafts.length) {
    return [...drafts];
  }
  const next = [...drafts];
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

/** Blocos aceitos pelo tipo de documento (RN-TPL-05). */
export function availableRenders(type: TemplateTypeInfo): SectionRender[] {
  return SECTION_RENDERS.filter((render) => isRenderAllowed(render, type));
}

export type DraftField =
  'key' | 'title' | 'helpText' | 'defaultContent' | 'minChars' | 'maxChars' | 'render';

export interface LocalProblem {
  readonly uid: string;
  readonly field: DraftField;
  readonly message: string;
}

const allowedVariables: ReadonlySet<string> = new Set(SECTION_TEMPLATE_VARIABLES);

/** Problemas que impedem salvar (V-04, V-05, V-06, V-10 e campos obrigatórios). */
export function localProblems(
  drafts: readonly SectionDraft[],
  type: TemplateTypeInfo,
): LocalProblem[] {
  const problems: LocalProblem[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    const key = draft.key.trim();
    if (key === '') {
      problems.push({ uid: draft.uid, field: 'key', message: 'Informe a chave.' });
    } else if (!SECTION_KEY_PATTERN.test(key)) {
      problems.push({
        uid: draft.uid,
        field: 'key',
        message: 'Use letras maiúsculas, números e _ (ex.: OBJETO).',
      });
    } else if (seen.has(key)) {
      problems.push({
        uid: draft.uid,
        field: 'key',
        message: `A chave "${key}" já existe nesta versão.`,
      });
    }
    seen.add(key);
    if (draft.title.trim() === '') {
      problems.push({ uid: draft.uid, field: 'title', message: 'Informe o título.' });
    }
    for (const field of ['helpText', 'defaultContent'] as const) {
      const unknown = templateVariablesIn(draft[field]).find((name) => !allowedVariables.has(name));
      if (unknown !== undefined) {
        problems.push({ uid: draft.uid, field, message: unknownVariableMessage(unknown) });
      }
    }
    const min = optionalNumber(draft.minChars);
    const max = optionalNumber(draft.maxChars) ?? DEFAULT_SECTION_MAX_CHARS;
    for (const [field, value] of [
      ['minChars', min],
      ['maxChars', optionalNumber(draft.maxChars)],
    ] as const) {
      if (
        value !== undefined &&
        (!Number.isInteger(value) || value < (field === 'minChars' ? 0 : 1))
      ) {
        problems.push({ uid: draft.uid, field, message: 'Informe um número inteiro válido.' });
      }
    }
    if (min !== undefined && Number.isInteger(min) && min > max) {
      problems.push({ uid: draft.uid, field: 'minChars', message: MIN_GREATER_THAN_MAX_MESSAGE });
    }
    if (!isRenderAllowed(draft.render, type)) {
      problems.push({
        uid: draft.uid,
        field: 'render',
        message: 'Este tipo de bloco não é permitido para este tipo de documento.',
      });
    }
  }
  return problems;
}

/** Violações do 422 `TEMPLATE_INVALID` por seção (`sectionKey`) — o restante fica geral. */
export function violationsBySection(violations: readonly Violation[]): {
  readonly bySection: ReadonlyMap<string, readonly Violation[]>;
  readonly general: readonly Violation[];
} {
  const bySection = new Map<string, Violation[]>();
  const general: Violation[] = [];
  for (const violation of violations) {
    if (violation.sectionKey === null) {
      general.push(violation);
      continue;
    }
    bySection.set(violation.sectionKey, [
      ...(bySection.get(violation.sectionKey) ?? []),
      violation,
    ]);
  }
  return { bySection, general };
}

/** Insere `{{variavel}}` na posição do cursor (paleta de variáveis). */
export function insertVariable(
  text: string,
  variable: string,
  selection: { readonly start: number; readonly end: number } = {
    start: text.length,
    end: text.length,
  },
): { readonly text: string; readonly cursor: number } {
  const token = `{{${variable}}}`;
  return {
    text: `${text.slice(0, selection.start)}${token}${text.slice(selection.end)}`,
    cursor: selection.start + token.length,
  };
}
