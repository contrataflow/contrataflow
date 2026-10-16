import type { WorkflowValidationResult } from '@contrataflow/validation';

import { ApiError, businessRuleViolation } from '#shared/errors/api-error.js';

/** 404 de workflow inexistente ou de outro tenant (indistinguíveis — RN-TEN). */
export function workflowNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Workflow não encontrado.' });
}

export function workflowVersionNotFound(): ApiError {
  return new ApiError('NOT_FOUND', { detail: 'Versão do workflow não encontrada.' });
}

export function workflowItemNotFound(item: 'etapa' | 'transição' | 'regra'): ApiError {
  const label = item === 'etapa' ? 'Etapa' : item === 'transição' ? 'Transição' : 'Regra';
  return new ApiError('NOT_FOUND', {
    detail: `${label} do workflow não encontrada.`,
  });
}

/** 409 `WORKFLOW_VERSION_NOT_DRAFT` (RN-WF-05 · FA-06 · V-08). */
export function workflowVersionNotDraft(versionId: string): ApiError {
  return new ApiError('WORKFLOW_VERSION_NOT_DRAFT', {
    extensions: { workflowVersionId: versionId },
  });
}

/** 409 `CONFLICT` da chave já usada (V-04). */
export function workflowKeyTaken(key: string): ApiError {
  return new ApiError('CONFLICT', {
    detail: `Já existe um item com a chave ${key}.`,
    extensions: { conflictField: 'key' },
  });
}

/** 409 `WORKFLOW_DRAFT_EXISTS` com `meta.draftVersionId` (FA-02 · V-09). */
export function workflowDraftExists(draftVersionId: string): ApiError {
  return new ApiError('WORKFLOW_DRAFT_EXISTS', { extensions: { meta: { draftVersionId } } });
}

/**
 * 422 `WORKFLOW_INVALID` (api.md §2.3): os problemas vão em `validation.errors[]`/`warnings[]` com
 * os códigos `WF_*` — `errors[]` do problem+json é reservado aos erros de campo (api.md §2.1.1).
 */
export function workflowInvalid(result: WorkflowValidationResult): ApiError {
  const count = result.errors.length;
  return new ApiError('WORKFLOW_INVALID', {
    detail: `O fluxo tem ${count} ${count === 1 ? 'problema que impede' : 'problemas que impedem'} a publicação.`,
    extensions: { validation: { errors: result.errors, warnings: result.warnings } },
  });
}

/** 412 `VERSION_CONFLICT` com a versão atual (`currentVersion`) para o cliente recarregar (V-10). */
export function workflowVersionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: 'Outra pessoa alterou este item. Recarregue para continuar.',
    extensions: { currentVersion },
  });
}

/**
 * 422 `BUSINESS_RULE_VIOLATION` (RN-WF-41 · V-03): só workflow ativo e com versão publicada pode ser
 * o padrão.
 */
export function workflowNotEligibleForDefault(reason: 'INACTIVE' | 'NOT_PUBLISHED'): ApiError {
  return businessRuleViolation([
    {
      code: reason === 'INACTIVE' ? 'WORKFLOW_INACTIVE' : 'WORKFLOW_NOT_PUBLISHED',
      severity: 'BLOCKING',
      message: 'Publique uma versão e ative o workflow antes de torná-lo padrão.',
      ruleId: 'RN-WF-41',
      sectionKey: null,
      field: null,
      itemId: null,
      params: {},
    },
  ]);
}

/** 412 `VERSION_CONFLICT` da troca do padrão (RN-WF-42 · V-02). */
export function defaultVersionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: 'Este workflow foi alterado por outra pessoa. Atualize a página.',
    extensions: { currentVersion },
  });
}

/** 422 `NO_APPLICABLE_WORKFLOW` (RN-WF-39 · RN-PROC-06 · V-04). */
export function noApplicableWorkflow(): ApiError {
  return new ApiError('NO_APPLICABLE_WORKFLOW', {
    detail: 'Não há fluxo configurado para este tipo de contratação.',
  });
}
