import type { ActionEntry, ProcessChecklist } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { ForwardPreviews } from './forward-previews.js';
import { PROCESS_RUNTIME_READER, PROCESS_TRANSACTIONS } from './ports.js';
import type { ProcessRuntimeReader, ProcessTransactions } from './ports.js';
import { ProcessViewerResolver } from './process-viewer.js';
import type { ResolvedViewer } from './process-viewer.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type { ProcessExecutionState } from '../../workflow/application/workflow.facade.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';
import { canViewProcess } from '../domain/process-visibility.js';

/*
 * Leituras do painel situacional sobre o motor de workflow (US-041 · PRC-08/PRC-09): autoriza pela
 * visibilidade (DEC-024 — `PROCESS_VIEW` cobrindo o processo ou concessão própria), carrega o
 * runtime NUM snapshot e delega à `WorkflowFacade` — a mesma que os comandos de tramitação usam.
 * Somente leitura: nenhuma escrita, evento ou `AuditLog`.
 */

/** Inexistente, de outro tenant e não visível respondem igual (nunca indica se existe). */
export function processNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Processo não encontrado.' });
}

/** O runtime do processo como o motor o lê. */
export function executionStateOf(runtime: ProcessRuntime): ProcessExecutionState {
  return {
    processId: runtime.id,
    workflowVersionId: runtime.workflowVersionId,
    status: runtime.status,
    createdById: runtime.createdById,
    currentDepartmentId: runtime.currentDepartmentId,
    currentResponsibleId: runtime.currentResponsibleId,
    numbered: runtime.numbered ?? true,
    ruleProcess: runtime.ruleProcess,
    passes: runtime.passes,
    approvals: runtime.approvals,
    documents: runtime.documents,
  };
}

/** Carrega o runtime visível ao usuário ou 404. */
export async function loadVisible(
  tx: TenantTx,
  reader: ProcessRuntimeReader,
  viewers: ProcessViewerResolver,
  processId: string,
): Promise<{ readonly runtime: ProcessRuntime; readonly viewer: ResolvedViewer }> {
  const runtime = await reader.load(tx, processId);
  if (runtime === null) throw processNotFound();
  const viewer = await viewers.resolve(tx);
  if (!canViewProcess(runtime.access, viewer.visibility, runtime.organizationId ?? null)) {
    throw processNotFound();
  }
  return { runtime, viewer };
}

export interface GetAvailableActionsQuery {
  readonly processId: string;
}

/**
 * `GetAvailableActionsQuery` — PRC-08: ações da etapa atual com motivos de indisponibilidade e,
 * nas entradas `FORWARD`, as prévias do encaminhamento (US-047 — `ForwardPreviews`).
 */
@Injectable()
export class GetAvailableActionsHandler {
  constructor(
    @Inject(PROCESS_RUNTIME_READER) private readonly reader: ProcessRuntimeReader,
    @Inject(PROCESS_TRANSACTIONS) private readonly transactions: ProcessTransactions,
    private readonly viewers: ProcessViewerResolver,
    private readonly workflow: WorkflowFacade,
    private readonly previews: ForwardPreviews,
  ) {}

  execute(query: GetAvailableActionsQuery): Promise<ActionEntry[]> {
    return this.transactions.read(async (tx) => {
      const { runtime, viewer } = await loadVisible(tx, this.reader, this.viewers, query.processId);
      const actions = await this.workflow.getAvailableActions(
        tx,
        executionStateOf(runtime),
        viewer.engine,
      );
      return this.previews.enrich(tx, runtime, actions);
    });
  }
}

export interface EvaluateStageRulesQuery {
  readonly processId: string;
}

/** `EvaluateStageRulesQuery` — PRC-09: pendências (bloqueantes e avisos) da etapa atual. */
@Injectable()
export class EvaluateStageRulesHandler {
  constructor(
    @Inject(PROCESS_RUNTIME_READER) private readonly reader: ProcessRuntimeReader,
    @Inject(PROCESS_TRANSACTIONS) private readonly transactions: ProcessTransactions,
    private readonly viewers: ProcessViewerResolver,
    private readonly workflow: WorkflowFacade,
  ) {}

  execute(query: EvaluateStageRulesQuery): Promise<ProcessChecklist> {
    return this.transactions.read(async (tx) => {
      const { runtime } = await loadVisible(tx, this.reader, this.viewers, query.processId);
      return { violations: await this.workflow.evaluateRules(tx, executionStateOf(runtime)) };
    });
  }
}
