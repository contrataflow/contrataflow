# 3.10 Workflow (`workflow`)

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2.

| ID | Método | Rota | Permissão | Story |
|---|---|---|---|---|
| WF-01 | GET | `/workflows` | `WORKFLOW_VIEW` | US-043 |
| WF-02 | POST | `/workflows` | `WORKFLOW_MANAGE` | US-043 |
| WF-03 | GET | `/workflows/{id}` | `WORKFLOW_VIEW` | US-043 |
| WF-04 | PATCH | `/workflows/{id}` | `WORKFLOW_MANAGE` | US-042, US-043 |
| WF-05 | POST | `/workflows/{id}/set-default` | `WORKFLOW_PUBLISH` | US-042 |
| WF-06 | POST | `/workflows/resolve` | `WORKFLOW_VIEW` | US-042 |
| WF-07 | GET | `/workflows/{id}/versions` | `WORKFLOW_VIEW` | US-045, US-046 |
| WF-08 | POST | `/workflows/{id}/versions` | `WORKFLOW_MANAGE` | US-043, US-045 |
| WF-09 | GET | `/workflow-versions/{versionId}` | `WORKFLOW_VIEW` | US-043, US-046 |
| WF-10 | POST | `/workflow-versions/{versionId}/stages` | `WORKFLOW_MANAGE` | US-043 |
| WF-11 | PATCH | `/workflow-stages/{stageId}` | `WORKFLOW_MANAGE` | US-043 |
| WF-12 | DELETE | `/workflow-stages/{stageId}` | `WORKFLOW_MANAGE` | US-043 |
| WF-13 | POST | `/workflow-versions/{versionId}/transitions` | `WORKFLOW_MANAGE` | US-043 |
| WF-14 | PATCH | `/workflow-transitions/{transitionId}` | `WORKFLOW_MANAGE` | US-043 |
| WF-15 | DELETE | `/workflow-transitions/{transitionId}` | `WORKFLOW_MANAGE` | US-043 |
| WF-16 | POST | `/workflow-versions/{versionId}/rules` | `WORKFLOW_MANAGE` | US-044 |
| WF-17 | PATCH | `/workflow-rules/{ruleId}` | `WORKFLOW_MANAGE` | US-044 |
| WF-18 | DELETE | `/workflow-rules/{ruleId}` | `WORKFLOW_MANAGE` | US-044 |
| WF-19 | GET | `/rule-context/schema` | `WORKFLOW_VIEW` | US-044 |
| WF-20 | POST | `/workflow-versions/{versionId}/validate` | `WORKFLOW_VIEW` | US-045 |
| WF-21 | POST | `/workflow-versions/{versionId}/publish` | `WORKFLOW_PUBLISH` | US-045 |
| WF-22 | POST | `/workflow-versions/{versionId}/retire` | `WORKFLOW_PUBLISH` | US-045 |
| WF-23 | POST | `/workflow-versions/{versionId}/rules/test` | `WORKFLOW_MANAGE` + `PROCESS_VIEW` (processo base) | US-044 |

### WF-01 — Listar workflows
`GET /api/v1/workflows` · **Permissão:** `WORKFLOW_VIEW` · **Story:** US-043
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** query `status` (texto, opcional — valores não detalhados na story de origem: a definir na implementação); `q` (texto, opcional, busca ≥2 caracteres, api.md §1.2); paginação padrão (api.md §1.2); ordenação não especificada na story (a definir na implementação)
- **Request:** —
- **Response:** `200 { data: Workflow[], meta }`; `Workflow { id, key, name, description, isDefault, applicabilityPriority, applicabilityRule, isActive, version }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_VIEW` |
- **Efeitos:** —
- **Notas:** workflows nascem semeados (DEC-015); `applicabilityPriority` menor é avaliado primeiro (RN-WF-39); `isDefault` único `true` por tenant (RN-WF-40).

### WF-02 — Criar workflow
`POST /api/v1/workflows` · **Permissão:** `WORKFLOW_MANAGE` · **Story:** US-043
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** —
- **Request:** `{ name: string (3–150, obrigatório); description?: string (≤2000) }`
- **Response:** `201 { data: Workflow }` com rascunho de versão 1 criado junto
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_MANAGE` |
  | 422 | `VALIDATION_ERROR` | `name`/`description` fora dos limites ou ausentes |
- **Efeitos:** Evento `WorkflowCreated` (`workflow.created`); auditoria `workflow.create` (`changes`: `name`, `description`)
- **Notas:** cria também a `WorkflowVersion` v1 em `DRAFT` (sem evento próprio de versão).

### WF-03 — Obter workflow
`GET /api/v1/workflows/{id}` · **Permissão:** `WORKFLOW_VIEW` · **Story:** US-043
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: Workflow }` · `ETag: "<version>"`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 404 | `NOT_FOUND` | Inexistente, outro tenant ou não visível |
- **Efeitos:** —
- **Notas:** —

### WF-04 — Atualizar workflow
`PATCH /api/v1/workflows/{id}` · **Permissão:** `WORKFLOW_MANAGE` · **Story:** US-042, US-043
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** `{ name?: string (3–150); description?: string (≤2000) }`
- **Response:** `200 { data: Workflow }` · `ETag` nova
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_MANAGE` |
  | 404 | `NOT_FOUND` | Inexistente/outro tenant |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `VALIDATION_ERROR` | Campos fora dos limites |
- **Efeitos:** Auditoria `workflow.update` (`changes`: campos alterados)
- **Notas:** não altera etapas/transições/regras (ver WF-10 a WF-18); afeta apenas metadados do workflow.

### WF-05 — Definir workflow padrão
`POST /api/v1/workflows/{id}/set-default` · **Permissão:** `WORKFLOW_PUBLISH` · **Story:** US-042
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: Workflow }` com `isDefault: true` · `ETag` nova
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_PUBLISH` |
  | 404 | `NOT_FOUND` | Inexistente/outro tenant |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `BUSINESS_RULE_VIOLATION` | Workflow inativo ou sem versão publicada |
- **Efeitos:** Evento `WorkflowDefaultChanged` (`workflow.default_changed`) — não disparado pelo seeder inicial (RN-WF-36); auditoria `workflow.set_default` (`changes`: `isDefault` do antigo e do novo; `metadata.previousWorkflowId`)
- **Notas:** exige workflow ativo e com versão publicada (RN-WF-41).

### WF-06 — Resolver workflow aplicável
`POST /api/v1/workflows/resolve` · **Permissão:** `WORKFLOW_VIEW` · **Story:** US-042
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** —
- **Request:** `{ contractingTypeId: uuid; modalityId?: uuid; originId: uuid; estimatedValue?: string (decimal); organizationId: uuid; isPriceRegistration: boolean }`
- **Response:** `200 { data: { workflowId, name, versionNumber, initialStage } }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 422 | `NO_APPLICABLE_WORKFLOW` | Nenhum workflow publicado aplicável e sem padrão |
- **Efeitos:** —
- **Notas:** avaliação por `applicabilityRule` (JSON Logic) em ordem de `applicabilityPriority` (RN-WF-35/39); usado na criação de processo (US-001 FA-06).

### WF-07 — Listar versões do workflow
`GET /api/v1/workflows/{id}/versions` · **Permissão:** `WORKFLOW_VIEW` · **Story:** US-045, US-046
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: WorkflowVersion[] }` ordenado por `versionNumber` desc; `WorkflowVersion { id, workflowId, versionNumber, status, changeNotes, publishedAt?, publishedById?, retiredAt?, retiredById? }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_VIEW` |
  | 404 | `NOT_FOUND` | Workflow inexistente/outro tenant |
- **Efeitos:** —
- **Notas:** usado também como seletor de versão no diagrama (US-046).

### WF-08 — Criar nova versão do workflow
`POST /api/v1/workflows/{id}/versions` · **Permissão:** `WORKFLOW_MANAGE` · **Story:** US-043, US-045 (endpoint compartilhado pelas duas stories)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** —
- **Response:** `201 { data: WorkflowVersion }` — cópia da versão publicada corrente, em `DRAFT`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_MANAGE` |
  | 409 | `WORKFLOW_DRAFT_EXISTS` | Já existe um rascunho deste workflow (uma por workflow) |
  | 409 | `BUSINESS_RULE_VIOLATION` | Não há versão publicada para copiar (US-045 V-06) |
- **Efeitos:** Auditoria `workflow.version_create` (`metadata`: `sourceVersionId`, `newVersionId`)
- **Notas:** usado tanto para iniciar a edição de etapas/transições (US-043) quanto para abrir uma nova versão a partir da publicada (US-045); nenhum evento de domínio é gerado na criação do rascunho.

### WF-09 — Obter versão do workflow
`GET /api/v1/workflow-versions/{versionId}` · **Permissão:** `WORKFLOW_VIEW` · **Story:** US-043, US-046
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `versionId` (uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: WorkflowVersion }` com `stages: WorkflowStage[]` e `transitions: WorkflowTransition[]` embutidos
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_VIEW` |
  | 404 | `NOT_FOUND` | Inexistente/outro tenant |
- **Efeitos:** —
- **Notas:** base para o editor (US-043) e para o diagrama (US-046, com `key`/`name`/`type`/`color`/`groupLabel` por etapa e `key`/`name`/`action`/`isPrimary` por transição — RN-WF-72); visualização não gera auditoria.

### WF-10 — Criar etapa
`POST /api/v1/workflow-versions/{versionId}/stages` · **Permissão:** `WORKFLOW_MANAGE` · **Story:** US-043
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `versionId` (uuid, obrigatório)
- **Request:** `{ key: string (≤60, SCREAMING_SNAKE_CASE, obrigatório, único na versão); name: string (3–150, obrigatório); instructions?: string (markdown, ≤4000); type: StageType ('START'|'TASK'|'APPROVAL'|'END', obrigatório, padrão 'TASK'); departmentResolution: DepartmentResolution ('FIXED'|'REQUESTING_DEPARTMENT'|'REQUESTING_SECRETARIAT'|'CHOSEN_ON_FORWARD', padrão 'REQUESTING_DEPARTMENT'); fixedDepartmentId?: uuid (obrigatório se 'FIXED'); assignmentPolicy: StageAssignmentPolicy ('UNASSIGNED'|'CREATOR'|'DEPARTMENT_HEAD'|'PREVIOUS_ASSIGNEE', padrão 'UNASSIGNED'); approverType?: ApproverType ('USER'|'ROLE'|'DEPARTMENT_HEAD', obrigatório se type='APPROVAL'); approverUserId?: uuid (se 'USER'); approverRoleId?: uuid (se 'ROLE'); approverDepartmentResolution?: 'FIXED'|'REQUESTING_SECRETARIAT'|'REQUESTING_DEPARTMENT' (se 'DEPARTMENT_HEAD'); approverFixedDepartmentId?: uuid; allowDeputy?: boolean (padrão true); approvalDocumentTypeCodes?: string[] (padrão []); slaDays?: number (1–365); slaType?: DayCountType ('BUSINESS'|'CALENDAR', padrão 'BUSINESS'); color?: string (formato #RRGGBB); displayOrder?: number (≥0) }`
- **Response:** `201 { data: WorkflowStage }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_MANAGE` |
  | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | Versão não está em `DRAFT` |
  | 422 | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) | `key` duplicada na versão |
  | 422 | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) | `APPROVAL` sem `approverType`; `FIXED` sem unidade |
- **Efeitos:** Auditoria `workflow.update` (`metadata.stageId`) — edição em rascunho não gera evento de domínio
- **Notas:** campos de aprovador detalhados conforme entidade `WorkflowStage` (entities.md; a story resume como `approverType`); `key` imutável após criada (RN-WF-45); `departmentResolution`/`approverType` condicionais por RN-WF-48.

### WF-11 — Atualizar etapa
`PATCH /api/v1/workflow-stages/{stageId}` · **Permissão:** `WORKFLOW_MANAGE` · **Story:** US-043
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Parâmetros:** path `stageId` (uuid, obrigatório)
- **Request:** mesmos campos de WF-10, todos opcionais, exceto `key` (imutável — RN-WF-45)
- **Response:** `200 { data: WorkflowStage }` · `ETag` nova
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_MANAGE` |
  | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | Versão não está em `DRAFT` |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) | Combinação de campos inválida |
- **Efeitos:** Auditoria `workflow.update` (`metadata.stageId`)
- **Notas:** —

### WF-12 — Excluir etapa
`DELETE /api/v1/workflow-stages/{stageId}` · **Permissão:** `WORKFLOW_MANAGE` · **Story:** US-043
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Parâmetros:** path `stageId` (uuid, obrigatório)
- **Request:** —
- **Response:** `204`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_MANAGE` |
  | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | Versão não está em `DRAFT` |
  | 409 | `BUSINESS_RULE_VIOLATION` | Etapa referenciada por transição não removida |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
- **Efeitos:** Auditoria `workflow.update` (`metadata.stageId`)
- **Notas:** remover primeiro as transições que usam a etapa (V-08 de US-043).

### WF-13 — Criar transição
`POST /api/v1/workflow-versions/{versionId}/transitions` · **Permissão:** `WORKFLOW_MANAGE` · **Story:** US-043
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `versionId` (uuid, obrigatório)
- **Request:** `{ key: string (≤60, obrigatório, único na versão); name: string (3–150, obrigatório); fromStageId: uuid (obrigatório, da mesma versão); toStageId: uuid (obrigatório, da mesma versão, diferente de fromStageId — RN-WF-49); action: TransitionAction ('FORWARD'|'RETURN'|'COMPLETE' nesta story, obrigatório); isPrimary?: boolean (padrão false); requiresComment?: boolean (padrão false; forçado true se action='RETURN') }`
- **Response:** `201 { data: WorkflowTransition }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_MANAGE` |
  | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | Versão não está em `DRAFT` |
  | 422 | `VALIDATION_ERROR` | Origem igual ao destino; `key` duplicada |
- **Efeitos:** Auditoria `workflow.update` (`metadata.transitionId`)
- **Notas:** conjunto completo de `TransitionAction` na entidade inclui também `APPROVE`/`REJECT` (usados nas etapas `APPROVAL`, fora do escopo de criação manual desta story).

### WF-14 — Atualizar transição
`PATCH /api/v1/workflow-transitions/{transitionId}` · **Permissão:** `WORKFLOW_MANAGE` · **Story:** US-043
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Parâmetros:** path `transitionId` (uuid, obrigatório)
- **Request:** mesmos campos de WF-13, todos opcionais, exceto `key` (imutável por analogia à etapa — RN-WF-45)
- **Response:** `200 { data: WorkflowTransition }` · `ETag` nova
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_MANAGE` |
  | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | Versão não está em `DRAFT` |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `VALIDATION_ERROR` | Origem igual ao destino |
- **Efeitos:** Auditoria `workflow.update` (`metadata.transitionId`)
- **Notas:** —

### WF-15 — Excluir transição
`DELETE /api/v1/workflow-transitions/{transitionId}` · **Permissão:** `WORKFLOW_MANAGE` · **Story:** US-043
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Parâmetros:** path `transitionId` (uuid, obrigatório)
- **Request:** —
- **Response:** `204`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_MANAGE` |
  | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | Versão não está em `DRAFT` |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
- **Efeitos:** Auditoria `workflow.update` (`metadata.transitionId`)
- **Notas:** —

### WF-16 — Criar regra
`POST /api/v1/workflow-versions/{versionId}/rules` · **Permissão:** `WORKFLOW_MANAGE` · **Story:** US-044
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `versionId` (uuid, obrigatório)
- **Request:** `{ scope: RuleScope ('STAGE_EXIT'|'TRANSITION', obrigatório — RN-WF-53); stageId?: uuid (obrigatório se scope='STAGE_EXIT', mesma versão); transitionId?: uuid (obrigatório se scope='TRANSITION', mesma versão); type: RuleType ('REQUIRED_DOCUMENT'|'REQUIRED_FIELD'|'REQUIRED_APPROVAL'|'CONDITION', obrigatório); name: string (≤150, obrigatório); description?: string; severity: RuleSeverity ('BLOCKING'|'WARNING', padrão 'BLOCKING'); message: string (≤500, obrigatório); config: object (formato conforme `type` — `{ documentTypeCode, minStatus, minCount? }` para `REQUIRED_DOCUMENT` RN-WF-55; `{ field }` para `REQUIRED_FIELD` RN-WF-56, lista em WF-19; `{ stageKey }` para `REQUIRED_APPROVAL` RN-WF-57; `{ expression }` JSON Logic para `CONDITION` RN-WF-58); isActive?: boolean (padrão true); displayOrder?: number (≥0) }`
- **Response:** `201 { data: WorkflowRule }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_MANAGE` |
  | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | Versão não está em `DRAFT` |
  | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | `stageId`/`transitionId`/`documentTypeCode`/`stageKey` inválidos |
  | 422 | `VALIDATION_ERROR` (`TOO_LONG`) | `name`/`message` acima do limite |
- **Efeitos:** Auditoria `workflow.update` (`metadata`: `ruleId`, `type`, `scope`, `stageId`/`transitionId`)
- **Notas:** regra usada em `WF-23` (teste) e avaliada no fluxo real de transição (api.md §2.1.2, `violations[]`).

### WF-17 — Atualizar regra
`PATCH /api/v1/workflow-rules/{ruleId}` · **Permissão:** `WORKFLOW_MANAGE` · **Story:** US-044
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Parâmetros:** path `ruleId` (uuid, obrigatório)
- **Request:** mesmos campos de WF-16, todos opcionais
- **Response:** `200 { data: WorkflowRule }` · `ETag` nova
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_MANAGE` |
  | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | Versão não está em `DRAFT` |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `VALIDATION_ERROR` | Referência ou tamanho inválidos |
- **Efeitos:** Auditoria `workflow.update` (`metadata.ruleId`)
- **Notas:** —

### WF-18 — Excluir regra
`DELETE /api/v1/workflow-rules/{ruleId}` · **Permissão:** `WORKFLOW_MANAGE` · **Story:** US-044
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Parâmetros:** path `ruleId` (uuid, obrigatório)
- **Request:** —
- **Response:** `204`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_MANAGE` |
  | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | Versão não está em `DRAFT` |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
- **Efeitos:** Auditoria `workflow.update` (`metadata.ruleId`)
- **Notas:** —

### WF-19 — Obter schema do contexto de regras
`GET /api/v1/rule-context/schema` · **Permissão:** `WORKFLOW_VIEW` · **Story:** US-044
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** —
- **Request:** —
- **Response:** `200 { data: { version: 1, fields: [{ path, label, type }] } }`
- **Erros:** — (leitura pública aos usuários com `WORKFLOW_VIEW`)
- **Efeitos:** —
- **Notas:** alimenta o seletor de `config.field` em regras `REQUIRED_FIELD` (WF-16/17) e o querybuilder de `CONDITION`.

### WF-20 — Validar versão do workflow
`POST /api/v1/workflow-versions/{versionId}/validate` · **Permissão:** `WORKFLOW_VIEW` · **Story:** US-045
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `versionId` (uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: { errors: [{ code, stageKey?, transitionKey?, ruleId? }], warnings: [{ code, stageKey?, transitionKey?, ruleId? }] } }` (catálogo `WF_*` — api.md §2.3)
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 404 | `NOT_FOUND` | Versão inexistente/outro tenant |
- **Efeitos:** —
- **Notas:** `errors[]` bloqueiam a publicação (WF-21); `warnings[]` não bloqueiam; catálogo completo de códigos `WF_*` na US-040.

### WF-21 — Publicar versão do workflow
`POST /api/v1/workflow-versions/{versionId}/publish` · **Permissão:** `WORKFLOW_PUBLISH` · **Story:** US-045
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Parâmetros:** path `versionId` (uuid, obrigatório)
- **Request:** `{ changeNotes?: string (obrigatório a partir da v2 — RN-WF-63) }`
- **Response:** `200 { data: WorkflowVersion }` com `status='PUBLISHED'`, `publishedAt`, `publishedById` (RN-WF-64)
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_PUBLISH` |
  | 409 | `INVALID_STATE` | Versão não está no status esperado para publicar |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `WORKFLOW_INVALID` | `errors[]` de WF-20 pendentes |
  | 422 | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) | `changeNotes` ausente a partir da v2 |
- **Efeitos:** Evento `WorkflowVersionPublished` (`workflow.version_published`; payload `workflowId`, `workflowVersionId`, `versionNumber`, `definitionHash`); auditoria `workflow.version_publish` (`metadata`: `versionNumber`, `definitionHash`, `changeNotes`)
- **Notas:** publicação exige zero `errors[]` de WF-20.

### WF-22 — Aposentar versão do workflow
`POST /api/v1/workflow-versions/{versionId}/retire` · **Permissão:** `WORKFLOW_PUBLISH` · **Story:** US-045
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Parâmetros:** path `versionId` (uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: WorkflowVersion }` com `status='RETIRED'`, `retiredAt`, `retiredById` (RN-WF-66)
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_PUBLISH` |
  | 409 | `INVALID_STATE` | Versão não está no status esperado para aposentar |
  | 409 | `WORKFLOW_IN_USE` | É a única versão aplicável do workflow |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
- **Efeitos:** Evento `WorkflowVersionRetired` (`workflow.version_retired`; payload `workflowId`, `workflowVersionId`); auditoria `workflow.version_retire` (`metadata.versionNumber`)
- **Notas:** publicar uma nova versão antes de aposentar a corrente quando for a única aplicável.

### WF-23 — Testar regra
`POST /api/v1/workflow-versions/{versionId}/rules/test` · **Permissão:** `WORKFLOW_MANAGE` + `PROCESS_VIEW` (do processo informado) · **Story:** US-044
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `versionId` (uuid, obrigatório)
- **Request:** `{ type: RuleType (obrigatório); config: object (mesmo formato de WF-16, conforme type); severity?: RuleSeverity ('BLOCKING'|'WARNING'); processId: uuid (obrigatório, visível ao usuário) }`
- **Response:** `200 { data: { satisfied: boolean, severity, message, contextUsed: object } }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `WORKFLOW_MANAGE` |
  | 404 | `NOT_FOUND` | Processo não encontrado ou não visível |
  | 422 | `WORKFLOW_INVALID` (`WF_RULE_OPERATOR_FORBIDDEN`) | `CONDITION` usa operador fora da allowlist |
- **Efeitos:** —
- **Notas:** não persiste a regra; usa o processo apenas como fonte de contexto para a avaliação (JSON Logic); endpoint de apoio `GET /api/v1/processes?q=` (catálogo da seção de processos, fora do escopo deste documento) alimenta o seletor de processo de teste.
