import type {
  WorkflowDefinition,
  WorkflowRule,
  WorkflowStage,
  WorkflowTransition,
} from './workflow-definition.js';

export interface CloneTarget {
  readonly workflowVersionId: string;
  readonly now: Date;
  readonly userId: string | null;
  /** Gerador de ids (UUIDv7 na aplicação). */
  readonly newId: () => string;
}

export interface ClonedDefinition extends WorkflowDefinition {
  /** Etapa `START` do clone (ou `null`): o `initialStageId` da nova versão. */
  readonly initialStageId: string | null;
}

/**
 * RN-WF-22: copia etapas, transições e regras para outra versão com ids NOVOS e as referências
 * remapeadas (`fromStageId`/`toStageId`, `stageId`/`transitionId` e a etapa inicial). As linhas
 * nascem com `version = 1` e autoria de quem criou a versão; `REQUIRED_APPROVAL.stageKey` é por
 * chave e continua valendo.
 */
export function cloneDefinition(source: WorkflowDefinition, target: CloneTarget): ClonedDefinition {
  const stageIds = new Map<string, string>();
  const transitionIds = new Map<string, string>();
  const control = {
    workflowVersionId: target.workflowVersionId,
    createdAt: target.now,
    updatedAt: target.now,
    createdById: target.userId,
    updatedById: target.userId,
    version: 1,
  };
  const remap = (ids: Map<string, string>, id: string): string => {
    const mapped = ids.get(id);
    if (mapped === undefined) throw new Error(`Referência ${id} fora da versão de origem.`);
    return mapped;
  };

  const stages = source.stages.map((stage): WorkflowStage => {
    const id = target.newId();
    stageIds.set(stage.id, id);
    return {
      ...stage,
      ...control,
      id,
      approvalDocumentTypeCodes: [...stage.approvalDocumentTypeCodes],
      documentTypeCodes: [...stage.documentTypeCodes],
    };
  });
  const transitions = source.transitions.map((transition): WorkflowTransition => {
    const id = target.newId();
    transitionIds.set(transition.id, id);
    return {
      ...transition,
      ...control,
      id,
      fromStageId: remap(stageIds, transition.fromStageId),
      toStageId: remap(stageIds, transition.toStageId),
    };
  });
  const rules = source.rules.map((rule): WorkflowRule => ({
    ...rule,
    ...control,
    id: target.newId(),
    stageId: rule.stageId === null ? null : remap(stageIds, rule.stageId),
    transitionId: rule.transitionId === null ? null : remap(transitionIds, rule.transitionId),
    config: structuredClone(rule.config),
  }));
  const start = stages.find((stage) => stage.type === 'START');
  return { stages, transitions, rules, initialStageId: start?.id ?? null };
}
