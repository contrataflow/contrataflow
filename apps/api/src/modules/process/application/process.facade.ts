import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { PROCESS_REPOSITORY } from './ports.js';
import type { ProcessRepository } from './ports.js';
import { accessGrantsOf } from './process-runtime.loader.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import { canViewConfidentialBudget } from '../domain/process-list.js';

const HISTORICAL_SETTING = 'access.historicalDepartmentsCanView';

/**
 * API pública do módulo `process` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório. US-001: as leituras de nomes congelados da timeline (fontes
 * `PROCESS` e `PROCESS_STAGE` de `TIMELINE_LOOKUP_SOURCES`), no `tx` do caso de uso. US-060: POL-09
 * de um processo para a leitura da timeline.
 */
@Injectable()
export class ProcessFacade {
  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    private readonly workflow: WorkflowFacade,
    private readonly access: AccessFacade,
    private readonly tenancy: TenancyFacade,
  ) {}

  /**
   * POL-09 sobre UM processo para o usuário da requisição (US-060 · RN-TML-13): a mesma regra do
   * desmascaramento por linha da lista (`canViewConfidentialBudget` — permissão
   * `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo, sem o 2º fator exigido não conta, ou
   * custódia atual). Avaliada como se o processo fosse sigiloso — o conteúdo restrito foi gravado
   * quando era, e tornar o orçamento público depois não o revela retroativamente. Processo
   * inexistente no tenant = `false` (falha fechada).
   */
  async canViewConfidentialBudget(tx: TenantTx, processId: string): Promise<boolean> {
    const rows = await this.processes.loadAggregate(tx, processId);
    if (rows === null) return false;
    const budget = await this.access.confidentialBudgetAccess();
    const settings = await this.tenancy.settingValues(tx, [HISTORICAL_SETTING]);
    const grants = accessGrantsOf(rows.access, settings.get(HISTORICAL_SETTING) !== false);
    return canViewConfidentialBudget(
      { ...rows.process, isBudgetConfidential: true },
      { ...budget.scope, custodyDepartmentIds: budget.custodyDepartmentIds },
      grants.departmentIds,
    );
  }

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
