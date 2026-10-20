import type { WorkflowDefinition } from './workflow-definition.js';

/** Item do rascunho que impede uma exclusão (RN-WF-50): transição ou regra que referencia o alvo. */
export interface DeleteBlocker {
  readonly kind: 'TRANSITION' | 'RULE';
  readonly id: string;
  readonly key: string | null;
  readonly name: string;
}

/**
 * RN-WF-50 · FA-01 (US-043): a etapa só pode ser excluída sem transições (de origem ou destino) nem
 * regras (`stageId`) apontando para ela — exclusão sempre restritiva, sem cascata. Regra
 * `REQUIRED_APPROVAL` de outra etapa que a cite por chave não bloqueia (o validador acusa
 * `WF_RULE_SCOPE_INVALID` — FA-04 da US-040).
 */
export function stageDeleteBlockers(
  definition: WorkflowDefinition,
  stageId: string,
): DeleteBlocker[] {
  return [
    ...definition.transitions
      .filter(
        (transition) => transition.fromStageId === stageId || transition.toStageId === stageId,
      )
      .map((transition) => ({
        kind: 'TRANSITION' as const,
        id: transition.id,
        key: transition.key,
        name: transition.name,
      })),
    ...definition.rules
      .filter((rule) => rule.stageId === stageId)
      .map((rule) => ({ kind: 'RULE' as const, id: rule.id, key: null, name: rule.name })),
  ];
}

/** RN-WF-50: a transição só pode ser excluída sem regras (`transitionId`) apontando para ela. */
export function transitionDeleteBlockers(
  definition: WorkflowDefinition,
  transitionId: string,
): DeleteBlocker[] {
  return definition.rules
    .filter((rule) => rule.transitionId === transitionId)
    .map((rule) => ({ kind: 'RULE' as const, id: rule.id, key: null, name: rule.name }));
}
