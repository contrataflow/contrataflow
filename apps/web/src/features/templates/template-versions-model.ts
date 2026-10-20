import type { TemplateVersionDto, TemplateVersionHistoryItem } from '@contrataflow/validation';

import { localProblems, toDraft } from './template-editor-model';

/*
 * Modelo da aba "Versões" (SCR-033 · US-108): funções puras para o feedback antecipado da
 * publicação e para os bloqueios da aposentadoria. Quem decide é a API (422 `TEMPLATE_INVALID`,
 * 409 `TEMPLATE_IN_USE`).
 */

/** Pendência do rascunho que impediria a publicação, com a seção afetada. */
export interface PublishProblem {
  readonly sectionKey: string | null;
  readonly message: string;
}

/**
 * Feedback antecipado (passo 2): a mesma validação local do editor (US-107) sobre as seções do
 * rascunho. Vazio = nada a resolver antes de publicar.
 */
export function prePublishProblems(version: TemplateVersionDto): PublishProblem[] {
  const drafts = version.sections.map(toDraft);
  const keyByUid = new Map(drafts.map((draft) => [draft.uid, draft.key]));
  return localProblems(drafts, version.documentType).map((problem) => ({
    sectionKey: keyByUid.get(problem.uid) ?? null,
    message: problem.message,
  }));
}

/**
 * RN-TPL-18 (FA-03): a versão corrente sem outra publicada para assumir não é aposentada quando o
 * template é o padrão do tipo.
 */
export function retireBlocked(
  item: TemplateVersionHistoryItem,
  history: readonly TemplateVersionHistoryItem[],
  isDefault: boolean,
): boolean {
  if (!isDefault || !item.isCurrent) return false;
  return !history.some((other) => other.id !== item.id && other.status === 'PUBLISHED');
}

const DATE_TIME = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
});

/** Data e hora no fuso do órgão; `null` → `null`. */
export function formatDateTime(iso: string | null): string | null {
  return iso ? DATE_TIME.format(new Date(iso)) : null;
}
