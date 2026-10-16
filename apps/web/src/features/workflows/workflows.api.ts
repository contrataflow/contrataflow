import type {
  DepartmentLookupItem,
  DocumentTypeDto,
  ProcessListItemDto,
  RoleDto,
  RuleContextSchemaDto,
  TenantMembershipDto,
  WorkflowDto,
  WorkflowRuleCreate,
  WorkflowRuleDto,
  WorkflowRuleTestResult,
  WorkflowRuleUpdate,
  WorkflowStageCreate,
  WorkflowStageDto,
  WorkflowStageUpdate,
  WorkflowTransitionCreate,
  WorkflowTransitionDto,
  WorkflowTransitionUpdate,
  WorkflowValidationResult,
  WorkflowVersionDetailDto,
  WorkflowVersionSummaryDto,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import type { IdempotentContext } from '@/lib/api/use-idempotent-mutation';
import { tenantKey } from '@/lib/query/keys';

/*
 * Workflows (US-042/US-043 · SCR-034): WF-01..05 e WF-08..15 de api/10-workflow.md — lista, padrão,
 * criação, "Criar rascunho" e a edição de etapas e transições do rascunho (cada item com o seu
 * `If-Match`). US-045: histórico de versões (WF-07), validar (WF-20), publicar (WF-21) e aposentar
 * (WF-22). As chaves seguem a convenção `['t', tenantId, …]` (RN-FND-90).
 */

export const workflowKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'workflows'),
  list: (tenantId: string) => tenantKey(tenantId, 'workflows', 'list'),
  detail: (tenantId: string, id: string) => tenantKey(tenantId, 'workflows', 'detail', id),
  version: (tenantId: string, versionId: string) =>
    tenantKey(tenantId, 'workflows', 'version', versionId),
  versions: (tenantId: string, workflowId: string) =>
    tenantKey(tenantId, 'workflows', 'versions', workflowId),
  lookups: (tenantId: string, kind: 'departments' | 'roles' | 'users' | 'documentTypes') =>
    tenantKey(tenantId, 'workflows', 'lookups', kind),
  ruleContextSchema: (tenantId: string) => tenantKey(tenantId, 'workflows', 'rule-context-schema'),
  ruleTestProcesses: (tenantId: string, q: string) =>
    tenantKey(tenantId, 'workflows', 'rule-test-processes', q),
};

export const WORKFLOWS_PATH = '/admin/workflows';

export function workflowEditorHref(id: string): string {
  return `${WORKFLOWS_PATH}/${id}`;
}

/** SCR-035 (US-044). */
export function workflowRulesHref(id: string): string {
  return `${WORKFLOWS_PATH}/${id}/regras`;
}

/** Staleness das telas de configuração (architecture.md §8.5). */
export const WORKFLOWS_STALE_TIME_MS = 60_000;

/** WF-01: todos os workflows do tenant (até 100), na ordem da aplicabilidade. */
export function fetchWorkflows(signal?: AbortSignal): Promise<ApiResult<WorkflowDto[]>> {
  return apiRequest<WorkflowDto[]>('/workflows', { query: { pageSize: 100 }, signal });
}

/** WF-05: tornar padrão com a versão lida em `If-Match` (RN-WF-42). */
export function setDefaultWorkflow(id: string, version: number): Promise<ApiResult<WorkflowDto>> {
  return apiRequest<WorkflowDto>(`/workflows/${id}/set-default`, {
    method: 'POST',
    ifMatch: `"${version}"`,
  });
}

/** WF-03. */
export function fetchWorkflow(id: string, signal?: AbortSignal): Promise<ApiResult<WorkflowDto>> {
  return apiRequest<WorkflowDto>(`/workflows/${id}`, { signal });
}

export interface WorkflowCreateInput {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
}

/** WF-02 (cria também a v1 em rascunho); `Idempotency-Key` da intenção do usuário. */
export function createWorkflow(
  body: WorkflowCreateInput,
  context: IdempotentContext,
): Promise<ApiResult<WorkflowDto>> {
  return apiRequest<WorkflowDto>('/workflows', {
    method: 'POST',
    body,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
}

/** WF-08 ("Criar rascunho"): cópia da versão publicada corrente. */
export function createWorkflowDraft(
  workflowId: string,
): Promise<ApiResult<WorkflowVersionDetailDto>> {
  return apiRequest<WorkflowVersionDetailDto>(`/workflows/${workflowId}/versions`, {
    method: 'POST',
    body: {},
  });
}

/** WF-09: versão com etapas, transições e regras (`ETag` = versão). */
export function fetchWorkflowVersion(
  versionId: string,
  signal?: AbortSignal,
): Promise<ApiResult<WorkflowVersionDetailDto>> {
  return apiRequest<WorkflowVersionDetailDto>(`/workflow-versions/${versionId}`, { signal });
}

const ifMatchOf = (version: number | undefined) => `"${String(version ?? 1)}"`;

/** WF-07 (RN-WF-69): histórico de versões por número decrescente (até 100). */
export function fetchWorkflowVersions(
  workflowId: string,
  signal?: AbortSignal,
): Promise<ApiResult<WorkflowVersionSummaryDto[]>> {
  return apiRequest<WorkflowVersionSummaryDto[]>(`/workflows/${workflowId}/versions`, {
    query: { pageSize: 100 },
    signal,
  });
}

/** WF-20: `errors[]` (bloqueiam "Publicar") e `warnings[]` da versão. */
export function validateWorkflowVersion(
  versionId: string,
): Promise<ApiResult<WorkflowValidationResult>> {
  return apiRequest<WorkflowValidationResult>(`/workflow-versions/${versionId}/validate`, {
    method: 'POST',
  });
}

/** WF-21 com o `If-Match` da versão; notas obrigatórias a partir da v2 (RN-WF-63). */
export function publishWorkflowVersion(
  version: Pick<WorkflowVersionSummaryDto, 'id' | 'version'>,
  changeNotes: string,
): Promise<ApiResult<WorkflowVersionSummaryDto>> {
  const notes = changeNotes.trim();
  return apiRequest<WorkflowVersionSummaryDto>(`/workflow-versions/${version.id}/publish`, {
    method: 'POST',
    body: notes === '' ? {} : { changeNotes: notes },
    ifMatch: ifMatchOf(version.version),
  });
}

/** WF-22 com o `If-Match` da versão. */
export function retireWorkflowVersion(
  version: Pick<WorkflowVersionSummaryDto, 'id' | 'version'>,
): Promise<ApiResult<WorkflowVersionSummaryDto>> {
  return apiRequest<WorkflowVersionSummaryDto>(`/workflow-versions/${version.id}/retire`, {
    method: 'POST',
    ifMatch: ifMatchOf(version.version),
  });
}

/** WF-10. */
export function createStage(
  versionId: string,
  body: WorkflowStageCreate,
): Promise<ApiResult<WorkflowStageDto>> {
  return apiRequest<WorkflowStageDto>(`/workflow-versions/${versionId}/stages`, {
    method: 'POST',
    body,
  });
}

/** WF-11 com o `If-Match` da etapa. */
export function updateStage(
  stage: Pick<WorkflowStageDto, 'id' | 'version'>,
  patch: WorkflowStageUpdate,
): Promise<ApiResult<WorkflowStageDto>> {
  return apiRequest<WorkflowStageDto>(`/workflow-stages/${stage.id}`, {
    method: 'PATCH',
    body: patch,
    ifMatch: ifMatchOf(stage.version),
  });
}

/** WF-12. */
export function deleteStage(
  stage: Pick<WorkflowStageDto, 'id' | 'version'>,
): Promise<ApiResult<unknown>> {
  return apiRequest<unknown>(`/workflow-stages/${stage.id}`, {
    method: 'DELETE',
    ifMatch: ifMatchOf(stage.version),
  });
}

/** WF-13. */
export function createTransition(
  versionId: string,
  body: WorkflowTransitionCreate,
): Promise<ApiResult<WorkflowTransitionDto>> {
  return apiRequest<WorkflowTransitionDto>(`/workflow-versions/${versionId}/transitions`, {
    method: 'POST',
    body,
  });
}

/** WF-14 com o `If-Match` da transição. */
export function updateTransition(
  transition: Pick<WorkflowTransitionDto, 'id' | 'version'>,
  patch: WorkflowTransitionUpdate,
): Promise<ApiResult<WorkflowTransitionDto>> {
  return apiRequest<WorkflowTransitionDto>(`/workflow-transitions/${transition.id}`, {
    method: 'PATCH',
    body: patch,
    ifMatch: ifMatchOf(transition.version),
  });
}

/** WF-15. */
export function deleteTransition(
  transition: Pick<WorkflowTransitionDto, 'id' | 'version'>,
): Promise<ApiResult<unknown>> {
  return apiRequest<unknown>(`/workflow-transitions/${transition.id}`, {
    method: 'DELETE',
    ifMatch: ifMatchOf(transition.version),
  });
}

/** WF-16. */
export function createRule(
  versionId: string,
  body: WorkflowRuleCreate,
): Promise<ApiResult<WorkflowRuleDto>> {
  return apiRequest<WorkflowRuleDto>(`/workflow-versions/${versionId}/rules`, {
    method: 'POST',
    body,
  });
}

/** WF-17 com o `If-Match` da regra. */
export function updateRule(
  rule: Pick<WorkflowRuleDto, 'id' | 'version'>,
  patch: WorkflowRuleUpdate,
): Promise<ApiResult<WorkflowRuleDto>> {
  return apiRequest<WorkflowRuleDto>(`/workflow-rules/${rule.id}`, {
    method: 'PATCH',
    body: patch,
    ifMatch: ifMatchOf(rule.version),
  });
}

/** WF-18. */
export function deleteRule(
  rule: Pick<WorkflowRuleDto, 'id' | 'version'>,
): Promise<ApiResult<unknown>> {
  return apiRequest<unknown>(`/workflow-rules/${rule.id}`, {
    method: 'DELETE',
    ifMatch: ifMatchOf(rule.version),
  });
}

/** WF-19: campos do RuleContext v1 para o construtor de regras. */
export function fetchRuleContextSchema(
  signal?: AbortSignal,
): Promise<ApiResult<RuleContextSchemaDto>> {
  return apiRequest<RuleContextSchemaDto>('/rule-context/schema', { signal });
}

export interface RuleTestInput {
  readonly type: WorkflowRuleDto['type'];
  readonly config: Record<string, unknown>;
  readonly severity: WorkflowRuleDto['severity'];
  readonly message?: string;
  readonly processId: string;
}

/** WF-23: "Testar regra" (dry-run — nada é salvo). */
export function testRule(
  versionId: string,
  body: RuleTestInput,
): Promise<ApiResult<WorkflowRuleTestResult>> {
  return apiRequest<WorkflowRuleTestResult>(`/workflow-versions/${versionId}/rules/test`, {
    method: 'POST',
    body,
  });
}

/** PRC-01 (busca por código/título): processos visíveis para o teste de regra. */
export function searchRuleTestProcesses(
  q: string,
  signal?: AbortSignal,
): Promise<ApiResult<ProcessListItemDto[]>> {
  return apiRequest<ProcessListItemDto[]>('/processes', { query: { q, pageSize: 10 }, signal });
}

/*
 * Catálogos do painel de propriedades: só leitura, carregados sob demanda. Sem a permissão de
 * leitura correspondente (403), o seletor fica vazio com o aviso — a API valida a referência.
 */

/** DEP-02: até 50 unidades ativas. */
export function fetchActiveDepartments(
  signal?: AbortSignal,
): Promise<ApiResult<DepartmentLookupItem[]>> {
  return apiRequest<DepartmentLookupItem[]>('/departments/lookup', { signal });
}

/** ROL-02 só com perfis ativos. */
export function fetchApproverRoles(signal?: AbortSignal): Promise<ApiResult<RoleDto[]>> {
  return apiRequest<RoleDto[]>('/roles', { query: { isActive: true }, signal });
}

/** USR-01 com os vínculos ativos (até 100). */
export function fetchApproverUsers(
  signal?: AbortSignal,
): Promise<ApiResult<TenantMembershipDto[]>> {
  return apiRequest<TenantMembershipDto[]>('/users', {
    query: { status: 'ACTIVE', pageSize: 100 },
    signal,
  });
}

/** DTY-01: tipos de documento (o painel mostra só os ativos). */
export function fetchWorkflowDocumentTypes(
  signal?: AbortSignal,
): Promise<ApiResult<DocumentTypeDto[]>> {
  return apiRequest<DocumentTypeDto[]>('/document-types', { signal });
}

/** RN-WF-41: só workflow ativo e com versão publicada pode ser o padrão. */
export function canBecomeDefault(workflow: WorkflowDto): boolean {
  return workflow.isActive && workflow.currentPublishedVersion !== null;
}

export type Applicability =
  | { readonly kind: 'ANY' }
  | { readonly kind: 'MODALITIES'; readonly codes: readonly string[] }
  | { readonly kind: 'CUSTOM' };

/**
 * Resumo legível da `applicabilityRule` (somente leitura na lista): nula = qualquer processo; a
 * forma semeada `{ in: [{ var: 'process.modalityCode' }, [...]] }` vira a lista de modalidades.
 */
export function describeApplicability(rule: unknown): Applicability {
  if (rule === null || rule === undefined) return { kind: 'ANY' };
  if (typeof rule === 'object' && 'in' in rule && Array.isArray(rule.in)) {
    const [variable, codes] = rule.in as unknown[];
    const isModality =
      typeof variable === 'object' &&
      variable !== null &&
      'var' in variable &&
      variable.var === 'process.modalityCode';
    if (isModality && Array.isArray(codes) && codes.every((code) => typeof code === 'string')) {
      return { kind: 'MODALITIES', codes };
    }
  }
  return { kind: 'CUSTOM' };
}
