import { workflowPublishIssues } from '@contrataflow/validation';
import type {
  WorkflowDto,
  WorkflowValidationIssue,
  WorkflowVersionSummaryDto,
} from '@contrataflow/validation';

/*
 * Modelo da aba "Versões" (SCR-034 · US-045): funções puras para o histórico, a validação e os
 * bloqueios de publicar/aposentar. Quem decide é a API (422 `WORKFLOW_INVALID`/`VALIDATION_ERROR`,
 * 409 `WORKFLOW_IN_USE`).
 */

/** Versão corrente do workflow (a publicada que vale para novos processos). */
export function isCurrentVersion(
  workflow: Pick<WorkflowDto, 'currentPublishedVersion'>,
  item: Pick<WorkflowVersionSummaryDto, 'id'>,
): boolean {
  return workflow.currentPublishedVersion?.id === item.id;
}

/**
 * RN-WF-66 (FA-03): a corrente sem outra publicada para assumir não é aposentada enquanto o
 * workflow estiver em uso (ativo ou padrão) — o mesmo critério da API.
 */
export function retireBlocked(
  workflow: Pick<WorkflowDto, 'isActive' | 'isDefault' | 'currentPublishedVersion'>,
  item: Pick<WorkflowVersionSummaryDto, 'id' | 'status'>,
  history: readonly Pick<WorkflowVersionSummaryDto, 'id' | 'status'>[],
): boolean {
  if (item.status !== 'PUBLISHED' || !isCurrentVersion(workflow, item)) return false;
  if (history.some((other) => other.id !== item.id && other.status === 'PUBLISHED')) return false;
  return workflow.isActive || workflow.isDefault;
}

/** RN-WF-63 (V-02): mensagem das notas ausentes, ou `null` (mesma regra do WF-21). */
export function changeNotesProblem(versionNumber: number, changeNotes: string): string | null {
  return workflowPublishIssues(versionNumber, changeNotes)[0]?.message ?? null;
}

/** Onde corrigir o problema (`stageKey`/`transitionKey`/`ruleId`), para o link do painel. */
export type IssueTarget =
  | { readonly kind: 'stage'; readonly key: string }
  | { readonly kind: 'transition'; readonly key: string }
  | { readonly kind: 'rule'; readonly id: string }
  | { readonly kind: 'none' };

export function issueTarget(issue: WorkflowValidationIssue): IssueTarget {
  if (issue.ruleId) return { kind: 'rule', id: issue.ruleId };
  if (issue.transitionKey) return { kind: 'transition', key: issue.transitionKey };
  if (issue.stageKey) return { kind: 'stage', key: issue.stageKey };
  // FA-05: sem etapa inicial, a correção é na aba "Etapas".
  if (issue.code === 'WF_START_STAGE_COUNT' || issue.code === 'WF_END_STAGE_MISSING') {
    return { kind: 'stage', key: '' };
  }
  return { kind: 'none' };
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

/** Hash resumido para a tabela (o completo vai no `title`). */
export function shortHash(hash: string | null): string | null {
  return hash ? hash.slice(0, 12) : null;
}
