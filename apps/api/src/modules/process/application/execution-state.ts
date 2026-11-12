import type { ProcessExecutionState } from '../../workflow/application/workflow.facade.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';

/** O runtime do processo como o motor de workflow o lê (US-041; módulo próprio desde a US-124). */
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
