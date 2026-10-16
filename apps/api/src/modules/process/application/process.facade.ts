import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { PROCESS_REPOSITORY } from './ports.js';
import type { ProcessRepository } from './ports.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';

/**
 * API pública do módulo `process` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório. US-001: as leituras de nomes congelados da timeline (fontes
 * `PROCESS` e `PROCESS_STAGE` de `TIMELINE_LOOKUP_SOURCES`), no `tx` do caso de uso.
 */
@Injectable()
export class ProcessFacade {
  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    private readonly workflow: WorkflowFacade,
  ) {}

  /** Código (nulo em rascunho sem número) e sigilo do orçamento dos processos do tenant. */
  processReferences(
    tx: TenantTx,
    processIds: readonly string[],
  ): Promise<
    Map<string, { readonly code: string | null; readonly isBudgetConfidential: boolean }>
  > {
    return this.processes.codes(tx, processIds);
  }

  /** Nome da etapa de cada passagem (`ProcessStage`), da versão de workflow fixada no processo. */
  async stageNames(tx: TenantTx, processStageIds: readonly string[]): Promise<Map<string, string>> {
    const refs = await this.processes.stageRefs(tx, processStageIds);
    const names = new Map<string, string>();
    const byVersion = new Map<string, Map<string, string>>();
    for (const [processStageId, ref] of refs) {
      let stages = byVersion.get(ref.workflowVersionId);
      if (!stages) {
        const snapshot = await this.workflow.publishedDefinitionIn(tx, ref.workflowVersionId);
        stages = new Map((snapshot?.stages ?? []).map((stage) => [stage.id, stage.name]));
        byVersion.set(ref.workflowVersionId, stages);
      }
      const name = stages.get(ref.workflowStageId);
      if (name !== undefined) names.set(processStageId, name);
    }
    return names;
  }
}
