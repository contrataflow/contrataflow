import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { PROCESS_RUNTIME_READER } from './ports.js';
import type { ProcessRuntimeReader } from './ports.js';
import { executionStateOf, loadVisible } from './process-actions.queries.js';
import { ProcessViewerResolver } from './process-viewer.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import type {
  RuleTestProcess,
  RuleTestProcessSource,
} from '../../workflow/application/workflow.facade.js';

/*
 * Processo de referência de "Testar regra" (US-044 · WF-23 · RN-WF-59): o mesmo runtime e a mesma
 * visibilidade (DEC-024) do PRC-08/PRC-09, no `tx` do teste. Inexistente, de outro tenant e não
 * visível viram `null` (404 igual — nunca indica se existe). O orçamento só aparece no resultado
 * para quem o vê no detalhe do processo (POL-09 — `PROCESS_VIEW_CONFIDENTIAL_BUDGET`).
 */
@Injectable()
export class RuleTestProcessReader implements RuleTestProcessSource {
  constructor(
    @Inject(PROCESS_RUNTIME_READER) private readonly reader: ProcessRuntimeReader,
    private readonly viewers: ProcessViewerResolver,
    private readonly access: AccessFacade,
  ) {}

  async load(tx: TenantTx, processId: string): Promise<RuleTestProcess | null> {
    try {
      const { runtime } = await loadVisible(tx, this.reader, this.viewers, processId);
      return {
        state: executionStateOf(runtime),
        budgetVisible:
          !runtime.ruleProcess.isBudgetConfidential ||
          this.access.can('PROCESS_VIEW_CONFIDENTIAL_BUDGET'),
      };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }
}
