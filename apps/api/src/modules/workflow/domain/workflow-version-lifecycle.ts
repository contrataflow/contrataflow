import type { Workflow, WorkflowVersion } from './workflow-definition.js';

/*
 * Ciclo de vida da versão publicada (US-045 · `DRAFT → PUBLISHED → RETIRED` — DEC-014). A
 * publicação em si é do `WorkflowVersionPublisher` (US-040 · RN-WF-20: a publicada anterior é
 * supersedida na mesma transação); aqui fica a decisão de aposentar pelo WF-22 (RN-WF-66).
 */

export type RetirementDecision =
  /** V-03: só versão `PUBLISHED` é aposentada. */
  | { readonly kind: 'INVALID_STATE' }
  /** V-04: é a corrente de um workflow em uso e nenhuma outra publicada assume. */
  | { readonly kind: 'IN_USE' }
  /**
   * Pode aposentar. `nextCurrentVersionId`: `undefined` = a corrente não muda (a versão não era a
   * corrente); `string` = outra publicada assume (a de maior número); `null` = o workflow fica sem
   * publicada (só fora de uso — FA-04).
   */
  | { readonly kind: 'RETIRE'; readonly nextCurrentVersionId: string | null | undefined };

/**
 * `WorkflowVersion.retire(...)` (RN-WF-66): aposentar a corrente exige outra `PUBLISHED` para
 * assumir; sem ela, só se o workflow estiver fora de uso — inativo (FA-04) e não padrão (o padrão
 * precisa de publicada — RN-WF-41). Processos já criados seguem na versão fixada (RN-WF-67).
 */
export function decideRetirement(
  workflow: Pick<Workflow, 'isActive' | 'isDefault' | 'currentPublishedVersionId'>,
  version: Pick<WorkflowVersion, 'id' | 'status'>,
  versions: readonly Pick<WorkflowVersion, 'id' | 'status' | 'versionNumber'>[],
): RetirementDecision {
  if (version.status !== 'PUBLISHED') return { kind: 'INVALID_STATE' };
  if (workflow.currentPublishedVersionId !== version.id) {
    return { kind: 'RETIRE', nextCurrentVersionId: undefined };
  }
  const successor = versions
    .filter((other) => other.id !== version.id && other.status === 'PUBLISHED')
    .sort((left, right) => right.versionNumber - left.versionNumber)[0];
  if (successor) return { kind: 'RETIRE', nextCurrentVersionId: successor.id };
  if (workflow.isActive || workflow.isDefault) return { kind: 'IN_USE' };
  return { kind: 'RETIRE', nextCurrentVersionId: null };
}
