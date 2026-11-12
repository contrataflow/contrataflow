# 3.20 Workflow v2, aprovação múltipla e migração de versão (`workflow`, `process`, `approval`) — MVP 2

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint) do MVP 2. Convenções, erros genéricos e de domínio: [api.md §1–§2](../api.md#1-convenções) (que herda o [api.md do MVP 1](../../mvp-01/api.md)). Épico(s): EP-021, EP-022. Fonte de cada linha: a seção "API" da story citada — divergência entre este arquivo e a story é bug de especificação.

Workflow v2 e aprovação múltipla: etapas paralelas (ramos e junção), plano, simulação e execução da migração de processos em andamento entre versões (DT-02, ADR-016 — tela SCR-118), `RuleContext` v2, oferta da versão 2 do workflow padrão (Dotação, Jurídico e Controle Interno), continuação dos processos concluídos na v1, e a política de decisão `ANY`/`ALL`/`SEQUENTIAL` com aprovadores por linha, redirecionamento e prazo das aprovações avulsas (DT-03, DT-17, PEND-13 → DEC-193). Telas: SCR-034, SCR-118, SCR-006, SCR-013, SCR-014 e SCR-015.

Legenda: **Idem.** = `Idempotency-Key`; **IM** = `If-Match` (com `ETag` na resposta); "—" = não se aplica. Escritas sem `If-Match` criam recurso novo ou são ações idempotentes por chave. Listas paginam com `page`/`pageSize` (≤ 100) e `sort`, salvo indicação na linha.

## Endpoints novos

| ID | Método | Rota | Permissão | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| APV-06 | POST | `/approvals/{id}/approvers/{approverId}/reassign` | `APPROVAL_REASSIGN` + POL-17 | Obrigatório | Obrigatório | US-135 |
| APV-31 | GET | `/approvals/{id}/approvers` | `APPROVAL_VIEW` | — | — | US-136 |
| PRC-39 | GET | `/processes/{id}/branches` | `PROCESS_VIEW` | — | — | US-124 |
| PRC-50 | GET | `/workflows/{id}/completed-continuation` | `WORKFLOW_MIGRATE` | — | — | US-131 |
| PRC-51 | POST | `/workflows/{id}/completed-continuation/migrations` | `WORKFLOW_MIGRATE` | Obrigatório | — | US-131 |
| PRC-52 | POST | `/workflow-migrations/{migrationId}/items/bulk-decision` | `WORKFLOW_MIGRATE` | Obrigatório | — | US-131 |
| WF-24 | GET | `/workflow-versions/{versionId}/branches` | `WORKFLOW_VIEW` | — | — | US-123 |
| WF-25 | POST | `/workflows/{id}/migrations` | `WORKFLOW_MIGRATE` | Obrigatório | — | US-126 |
| WF-26 | GET | `/workflows/{id}/migrations` | `WORKFLOW_VIEW` | — | — | US-126 |
| WF-27 | GET | `/workflows/{id}/migrations/{migrationId}` | `WORKFLOW_VIEW` | — | — | US-126, US-128 |
| WF-28 | PATCH | `/workflows/{id}/migrations/{migrationId}` | `WORKFLOW_MIGRATE` | — | Obrigatório | US-126 |
| WF-29 | GET | `/workflows/{id}/migrations/{migrationId}/filter-preview` | `WORKFLOW_VIEW` | — | — | US-126 |
| WF-30 | POST | `/workflows/{id}/migrations/{migrationId}/cancel` | `WORKFLOW_MIGRATE` | Opcional | Opcional | US-126 |
| WF-31 | POST | `/workflows/{id}/migrations/{migrationId}/simulate` | `WORKFLOW_MIGRATE` | Obrigatório | Obrigatório | US-127 |
| WF-32 | GET | `/workflows/{id}/migrations/{migrationId}/items` | `WORKFLOW_VIEW` | — | — | US-127, US-128 |
| WF-33 | GET | `/workflows/{id}/migrations/{migrationId}/items/{itemId}` | `WORKFLOW_VIEW` | — | — | US-127 |
| WF-34 | PUT | `/workflows/{id}/migrations/{migrationId}/items/{itemId}/decision` | `WORKFLOW_MIGRATE` | — | Obrigatório | US-127 |
| WF-35 | POST | `/workflows/{id}/migrations/{migrationId}/execute` | `WORKFLOW_MIGRATE` | Obrigatório | Obrigatório | US-128 |
| WF-36 | GET | `/workflows/{id}/migrations/{migrationId}/items/export` | `WORKFLOW_VIEW` | — | — | US-128 |
| WF-60 | POST | `/rules/context-preview` | `WORKFLOW_MANAGE` ou `PROCESS_VIEW` | — | — | US-129, US-148 |
| WF-62 | GET | `/workflows/{id}/seed-offer` | `WORKFLOW_VIEW` | — | — | US-130 |
| WF-63 | POST | `/workflows/{id}/seed-offer/adopt` | `WORKFLOW_MANAGE` ou `WORKFLOW_PUBLISH` | Obrigatório | Obrigatório | US-130 |
| WF-64 | POST | `/workflows/{id}/seed-offer/dismiss` | `WORKFLOW_PUBLISH` | Obrigatório | Obrigatório | US-130 |
| WF-65 | PUT | `/workflow-stages/{stageId}/approvers` | `WORKFLOW_MANAGE` | — | Obrigatório | US-132 |

## Rotas do MVP 1 ampliadas

Mudanças **aditivas** (campos opcionais, enums ampliados, filtros novos) sobre contratos do MVP 1; o comportamento do MVP 1 vale sem os campos novos. O contrato original está no arquivo indicado da pasta `mvp-01/api/`.

| ID | Método | Rota (MVP 1) | Permissão (MVP 1) | Contrato original | Ampliado por |
|---|---|---|---|---|---|
| APV-01 | GET | `/approvals` | Cobertura de aprovador (POL-03) | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-125, US-136, US-137 |
| APV-02 | GET | `/approvals/{id}` | `APPROVAL_VIEW` ou designado | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-125, US-133, US-134, US-136, US-137 |
| APV-03 | POST | `/approvals/{id}/decide` | `APPROVAL_DECIDE` + POL-03 | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-134 |
| APV-04 | POST | `/approvals/{id}/withdraw` | `PROCESS_FORWARD` + POL-17 | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-135 |
| APV-05 | POST | `/approvals/{id}/reassign` | `APPROVAL_REASSIGN` | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-135 |
| CAL-06 | POST | `/calendar/add-business-days` | implícita | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-137 |
| DOC-09 | POST | `/documents/{id}/submit` | permissão de submissão do tipo + POL-02 (IM, Idem.) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-133, US-137 |
| DTY-01 | GET | `/document-types` | impl. | [03-documents.md](../../mvp-01/api/03-documents.md) | US-137 |
| DTY-02 | POST | `/document-types` | `DOCUMENT_TYPE_MANAGE` | [03-documents.md](../../mvp-01/api/03-documents.md) | US-132 |
| DTY-03 | PATCH | `/document-types/{id}` | `DOCUMENT_TYPE_MANAGE` (IM) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-132, US-137 |
| PRC-01 | GET | `/processes` | `PROCESS_VIEW` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-125 |
| PRC-04 | GET | `/processes/{id}` | `PROCESS_VIEW` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-124 |
| PRC-07 | GET | `/processes/{id}/summary` | `PROCESS_VIEW` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-125 |
| PRC-08 | GET | `/processes/{id}/available-actions` | `PROCESS_VIEW` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-124 |
| PRC-09 | GET | `/processes/{id}/checklist` | `PROCESS_VIEW` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-124 |
| PRC-10 | GET | `/processes/{id}/stages` | `PROCESS_VIEW` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-124 |
| PRC-11 | GET | `/processes/{id}/movements` | `PROCESS_VIEW` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-124 |
| PRC-19 | POST | `/processes/{id}/forward` | `PROCESS_FORWARD` + POL-01 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-124, US-133 |
| PRC-20 | POST | `/processes/{id}/return` | `PROCESS_RETURN` + POL-01 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-124 |
| PRC-21 | POST | `/processes/{id}/claim` | `PROCESS_CLAIM` + POL-04 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-124 |
| PRC-22 | POST | `/processes/{id}/assign` | `PROCESS_ASSIGN` ou titular/substituto + POL-05 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-124 |
| PRC-23 | POST | `/processes/{id}/suspend` | `PROCESS_SUSPEND` + POL-07 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-124 |
| PRC-24 | POST | `/processes/{id}/resume` | `PROCESS_SUSPEND` + POL-07 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-124 |
| PRC-25 | POST | `/processes/{id}/cancel` | `PROCESS_CANCEL` + POL-06 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-124 |
| TSK-01 | GET | `/tasks` | `INBOX_VIEW` | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-125, US-136, US-137 |
| TSK-02 | GET | `/tasks/counters` | `INBOX_VIEW` | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-125, US-136 |
| TSK-03 | POST | `/tasks/bulk-claim` | `PROCESS_CLAIM` | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-125 |
| TSK-04 | POST | `/tasks/bulk-assign` | `PROCESS_ASSIGN` (ou titular) | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-125 |
| WF-08 | POST | `/workflows/{id}/versions` | `WORKFLOW_MANAGE` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-132 |
| WF-09 | GET | `/workflow-versions/{versionId}` | `WORKFLOW_VIEW` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-123, US-132 |
| WF-10 | POST | `/workflow-versions/{versionId}/stages` | `WORKFLOW_MANAGE` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-123 |
| WF-11 | PATCH | `/workflow-stages/{stageId}` | `WORKFLOW_MANAGE` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-123, US-132 |
| WF-13 | POST | `/workflow-versions/{versionId}/transitions` | `WORKFLOW_MANAGE` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-123 |
| WF-14 | PATCH | `/workflow-transitions/{transitionId}` | `WORKFLOW_MANAGE` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-123 |
| WF-16 | POST | `/workflow-versions/{versionId}/rules` | `WORKFLOW_MANAGE` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-129 |
| WF-17 | PATCH | `/workflow-rules/{ruleId}` | `WORKFLOW_MANAGE` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-129 |
| WF-19 | GET | `/rule-context/schema` | `WORKFLOW_VIEW` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-129 |
| WF-20 | POST | `/workflow-versions/{versionId}/validate` | `WORKFLOW_VIEW` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-123, US-129, US-132 |
| WF-21 | POST | `/workflow-versions/{versionId}/publish` | `WORKFLOW_PUBLISH` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-123 |
| WF-23 | POST | `/workflow-versions/{versionId}/rules/test` | `WORKFLOW_MANAGE` + `PROCESS_VIEW` (processo base) | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-129 |

## Especificação por endpoint

### APV-06 — POST `/approvals/{id}/approvers/{approverId}/reassign`
**Permissão:** `APPROVAL_REASSIGN` + POL-17 · **Story:** US-135
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `Idempotency-Key`, `If-Match` (linha); `{ approverType, targetApproverUserId?, targetApproverRoleId?, targetApproverDepartmentId?, reason }`
- **Response:** `200 { data: Approval }` com `approvers[]` e `meta.newApproverId` · `ETag`
- **Códigos:** 200, 403, 404, 409, 412, 422, 428, 503

### APV-31 — GET `/approvals/{id}/approvers`
**Permissão:** `APPROVAL_VIEW` · **Story:** US-136
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** path `id`; query `includeHistory` (padrão `true`)
- **Response:** `200 { data: [{ id, sequence, label, approverType, status, activatedAt, dueAt, decision, decidedBy, decidedAt, decidedAsDeputy, decisionComment, reassignedFromId, skippedReason }], meta: { decisionPolicy, totalLines, approvalStatus } }`; `Cache-Control: no-store`
- **Códigos:** 200, 401, 403, 404, 422, 429, 503

### PRC-39 — GET `/processes/{id}/branches`
**Permissão:** `PROCESS_VIEW` · **Story:** US-124
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** path `id`; query `round?` (padrão a rodada atual)
- **Response:** `200 { data: { splitProcessStageId, splitStageKey, joinStageKey, status, openBranchesLeft, branches: [{ branchKey, status, arrivedAt, canceledAt, cancellationReason, activeStage: ActiveStage|null, passes[] }], previousRounds: [{ splitProcessStageId, status }] } }`; `data: null` fora de ramificação
- **Códigos:** 200, 404 `PROCESS_NOT_FOUND`

### PRC-50 — GET `/workflows/{id}/completed-continuation`
**Permissão:** `WORKFLOW_MIGRATE` · **Story:** US-131
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { workflowId, seedKey, targetVersion { id, versionNumber }, sourceVersions[{ id, versionNumber, eligibleCount }], eligibleCount, openMigration { id, status }? } }` · `Cache-Control: no-store`
- **Códigos:** 200, 403, 404

### PRC-51 — POST `/workflows/{id}/completed-continuation/migrations`
**Permissão:** `WORKFLOW_MIGRATE` · **Story:** US-131
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `Idempotency-Key`; `{ sourceWorkflowVersionId?, name?, filter? { requestingSecretariatIds?, openedFrom?, openedTo?, processIds? } }`
- **Response:** `201 { data: WorkflowMigration (DRAFT) }` · `Location`
- **Códigos:** 201, 403, 404, 409, 422, 503

### PRC-52 — POST `/workflow-migrations/{migrationId}/items/bulk-decision`
**Permissão:** `WORKFLOW_MIGRATE` · **Story:** US-131
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `Idempotency-Key`; `{ itemIds[1..100], decision, targetStageKey?, targetDepartmentId?, justification, expectedSimulationHash }`
- **Response:** `200 { data: [{ itemId, processId, ok, code?, message? }], meta: { successCount, errorCount } }`
- **Códigos:** 200, 403, 404, 409, 422

### WF-24 — GET `/workflow-versions/{versionId}/branches`
**Permissão:** `WORKFLOW_VIEW` · **Story:** US-123
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** — (path `versionId`)
- **Response:** `200 { data: { blocks: [{ splitStageKey, joinStageKey|null, branches: [{ branchKey, entryStageKey, stageKeys[], exitTransitionKey|null }], issues: [{ code, reason, message, stageKey?, transitionKey? }] }], issues: [...], stageBranch: { [stageKey]: branchKey } } }`; `ETag` = `WorkflowVersion.version`; rascunho calculado na hora, publicada lida do snapshot
- **Notas (US-123):** `issues` de topo (aditivo) traz os problemas sem ramificação de origem (junção solta: `JOIN_WITHOUT_SPLIT` e a sua `JOIN_EXIT_INVALID`); `stageKey`/`transitionKey` são `null` quando ausentes; `stageKeys[]` segue a ordem do caminho a partir da primeira etapa; `exitTransitionKey` é a primeira transição do ramo para a junção do bloco. Leitura: sem auditoria nem evento. Os problemas são os mesmos `WF_PARALLEL_INVALID` de WF-20.
- **Códigos:** 200, 403, 404, 503

### WF-25 — POST `/workflows/{id}/migrations`
**Permissão:** `WORKFLOW_MIGRATE` · **Story:** US-126
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ name, sourceWorkflowVersionId, targetWorkflowVersionId, stageMapping?, processFilter? }`; `Idempotency-Key` obrigatório; sem `stageMapping` o mapa é gerado
- **Response:** `201 { data: WorkflowMigration }` + `Location`, `ETag`; plano com `mappingDiagnostics`
- **Códigos:** 201, 403 (`PERMISSION_DENIED`, `MFA_REQUIRED`), 404, 422 (`MIGRATION_*`, `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_REUSED`), 503

### WF-26 — GET `/workflows/{id}/migrations`
**Permissão:** `WORKFLOW_VIEW` · **Story:** US-126
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** query `status?`, `page`, `pageSize` (≤ 100), `sort` (`-createdAt`)
- **Response:** `200 { data: WorkflowMigration[], meta }` (sem itens)
- **Códigos:** 200, 403, 404

### WF-27 — GET `/workflows/{id}/migrations/{migrationId}`
**Permissão:** `WORKFLOW_VIEW` · **Story:** US-126 (também citado por US-128)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: WorkflowMigration }` com mapa, filtro, `mappingDiagnostics`, `totals`, nomes e números das versões, `ETag`
- **Códigos:** 200, 403, 404
- **Uso/ampliação em US-128:** request — → response MVP 2 da US-126 + `progress { total, pending, migrated, excluded, failed, stale, lastExecutedAt }` e `totals` finais; `Cache-Control: no-store` · códigos 200, 403, 404

### WF-28 — PATCH `/workflows/{id}/migrations/{migrationId}`
**Permissão:** `WORKFLOW_MIGRATE` · **Story:** US-126
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ name?, stageMapping?, processFilter?, regenerateMapping?, confirmDiscardSimulation? }`; `If-Match` obrigatório
- **Response:** `200 { data: WorkflowMigration }` + nova `ETag`; plano `SIMULATED` volta a `DRAFT`
- **Códigos:** 200, 403, 404, 409 (`MIGRATION_NOT_EDITABLE`), 412, 422, 428

### WF-29 — GET `/workflows/{id}/migrations/{migrationId}/filter-preview`
**Permissão:** `WORKFLOW_VIEW` · **Story:** US-126
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { matchCount, byStatus{}, byStage[{ stageKey, stageName, count, targetStageKey|null }], withoutTarget, inParallel, limit, overLimit, visibleOnly } }`
- **Códigos:** 200, 403, 404

### WF-30 — POST `/workflows/{id}/migrations/{migrationId}/cancel`
**Permissão:** `WORKFLOW_MIGRATE` · **Story:** US-126
- **Cabeçalhos:** `Idempotency-Key` Opcional · `If-Match` Opcional
- **Request:** `{ reason? }`; `If-Match` obrigatório; `Idempotency-Key` opcional
- **Response:** `200 { data: WorkflowMigration }` com `status = CANCELED`
- **Códigos:** 200, 403, 404, 409 (`MIGRATION_NOT_CANCELABLE`, `INVALID_STATE`), 412, 428

### WF-31 — POST `/workflows/{id}/migrations/{migrationId}/simulate`
**Permissão:** `WORKFLOW_MIGRATE` · **Story:** US-127
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ confirmDiscardDecisions? }`; `Idempotency-Key` e `If-Match` obrigatórios
- **Response:** `200 { data: WorkflowMigration }` (`status = SIMULATED`, `totals`, `simulationHash`, `decisionsPending`, `canExecute`, `blockers[]`)
- **Códigos:** 200, 403, 404, 409 (`MIGRATION_NOT_EDITABLE`), 412, 422 (`MIGRATION_NO_PROCESSES`, `MIGRATION_TOO_MANY_PROCESSES`, `MIGRATION_DISCARD_NOT_CONFIRMED`), 428, 503

### WF-32 — GET `/workflows/{id}/migrations/{migrationId}/items`
**Permissão:** `WORKFLOW_VIEW` · **Story:** US-127 (também citado por US-128)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** query `classification?`, `decision?`, `result?`, `reason?`, `stageKey?`, `q?`, `page`, `pageSize` (≤ 100), `sort`
- **Response:** `200 { data: MigrationItem[], meta: { page, pageSize, totalItems, totalPages, byClassification{}, byDecision{} } }` sem valores monetários
- **Códigos:** 200, 403, 404, 422
- **Uso/ampliação em US-128:** request query da US-127 + `result` → response itens com `result`, `errorCode`, `errorMessage`, `movementId`, `executedAt` · códigos 200, 403, 404, 422

### WF-33 — GET `/workflows/{id}/migrations/{migrationId}/items/{itemId}`
**Permissão:** `WORKFLOW_VIEW` · **Story:** US-127
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: MigrationItem }` com `reasons[]` detalhadas, `effectPreview`, regras novas violadas, `ETag` = `version` do item
- **Códigos:** 200, 403, 404

### WF-34 — PUT `/workflows/{id}/migrations/{migrationId}/items/{itemId}/decision`
**Permissão:** `WORKFLOW_MIGRATE` · **Story:** US-127
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ decision: 'MIGRATE'|'EXCLUDE', targetStageKey?, justification? }`; `If-Match` obrigatório
- **Response:** `200 { data: MigrationItem }` + nova `ETag`; plano com `decisionsPending` atualizado em `meta`
- **Códigos:** 200, 403, 404, 409 (`MIGRATION_NOT_SIMULATED`), 412, 422 (`MIGRATION_ITEM_BLOCKED`, `MIGRATION_TARGET_*`, `VALIDATION_ERROR`), 428

### WF-35 — POST `/workflows/{id}/migrations/{migrationId}/execute`
**Permissão:** `WORKFLOW_MIGRATE` · **Story:** US-128
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ simulationHash }`; `Idempotency-Key` e `If-Match` (primeira execução) obrigatórios; sobre plano `RUNNING` retoma (sem `If-Match`)
- **Response:** `202 { data: WorkflowMigration }` (`status = RUNNING`, `startedAt`, `progress`) + `Location` do plano
- **Códigos:** 202, 403 (`PERMISSION_DENIED`, `MFA_REQUIRED`), 404, 409 (`MIGRATION_NOT_SIMULATED`, `MIGRATION_SIMULATION_STALE`, `MIGRATION_ALREADY_RUNNING`, `MIGRATION_TARGET_NOT_PUBLISHED`, `MIGRATION_NOT_EDITABLE`), 412, 422 (`MIGRATION_DECISIONS_PENDING`, `MIGRATION_NOTHING_TO_MIGRATE`, `VALIDATION_ERROR`), 428, 503

### WF-36 — GET `/workflows/{id}/migrations/{migrationId}/items/export`
**Permissão:** `WORKFLOW_VIEW` · **Story:** US-128
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** — (query `classification?`, `result?`)
- **Response:** `200 text/csv; charset=utf-8` com `Content-Disposition: attachment` (RN-WF2-78)
- **Códigos:** 200, 403, 404, 409 (`MIGRATION_NOT_SIMULATED`)

### WF-60 — POST `/rules/context-preview`
**Permissão:** `WORKFLOW_MANAGE` ou `PROCESS_VIEW` · **Story:** US-129 (também citado por US-148)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `{ processId, contextVersion? (padrão 2), namespaces?: string[] }`
- **Response:** `200 { data: { contextVersion, namespaces: { <ns>: 'LOADED'|'UNAVAILABLE'|'SKIPPED' }, context, maskedPaths[], buildMs } }` · `Cache-Control: no-store`
- **Códigos:** 200, 403, 404, 422, 503

### WF-62 — GET `/workflows/{id}/seed-offer`
**Permissão:** `WORKFLOW_VIEW` · **Story:** US-130
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { workflowId, seedKey, status, offeredSeedVersion, offerDismissedAt, customized, currentVersion { id, versionNumber, seedVersion }, seed { seedVersion, stagesCount }, comparison { stages[], rules[] } } }` · `ETag` do workflow
- **Códigos:** 200, 403, 404

### WF-63 — POST `/workflows/{id}/seed-offer/adopt`
**Permissão:** `WORKFLOW_MANAGE` ou `WORKFLOW_PUBLISH` · **Story:** US-130
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `Idempotency-Key`, `If-Match`; corpo vazio
- **Response:** `201 { data: WorkflowVersion (DRAFT) }` · `Location` · `ETag`
- **Códigos:** 201, 403, 404, 409, 412, 422, 428, 503

### WF-64 — POST `/workflows/{id}/seed-offer/dismiss`
**Permissão:** `WORKFLOW_PUBLISH` · **Story:** US-130
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `Idempotency-Key`, `If-Match`; corpo vazio
- **Response:** `200 { data: { offeredSeedVersion, offerDismissedAt } }`
- **Códigos:** 200, 403, 404, 409, 412, 422, 428, 503

### WF-65 — PUT `/workflow-stages/{stageId}/approvers`
**Permissão:** `WORKFLOW_MANAGE` · **Story:** US-132
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ decisionPolicy, approvers: [{ approverType, approverUserId?, approverRoleId?, approverDepartmentResolution?, approverFixedDepartmentId?, allowDeputy?, label? }] }` + `If-Match`
- **Response:** `200 { data: { stageId, decisionPolicy, approvers: [{ id, sequence, …, resolved { label, status } }] } }` · `ETag`
- **Códigos:** 200, 403, 404, 409, 412, 422, 428, 503
- **Regras (US-132):** `approvers` padrão `[]`; `sequence`, `applicabilityRule` e `decisionPolicyRules` no corpo → 422 `VALIDATION_ERROR` (`NOT_ALLOWED`); mais de 20 → `TOO_LONG` em `approvers`; linha repetida → `DUPLICATE_IN_LIST` em `approvers[n]`; referência ausente/incompatível → `CONDITIONAL_REQUIRED`/`NOT_ALLOWED` em `approvers[n].campo`; usuário/perfil/unidade inexistente, de outro tenant ou inativo → `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` em `approvers[n].campo`; política diferente de `ANY` (ou linhas) em etapa que não é `APPROVAL` → `NOT_ALLOWED` em `decisionPolicy`/`approvers`. O rascunho aceita `ALL`/`SEQUENTIAL` com menos de duas linhas (o mínimo é da validação/publicação). Mesmo conteúdo já gravado = 200 sem novo `ETag` nem auditoria. Etapa de outro tenant → 404 `NOT_FOUND`; versão publicada → 409 `WORKFLOW_VERSION_NOT_DRAFT`.
- **`resolved`:** `label` = rótulo da linha ou o nome resolvido (usuário, perfil, "Titular de {unidade}", "Titular da secretaria/unidade solicitante"); `status` ∈ `OK`, `INACTIVE`, `NO_HEAD`. Só na resposta do WF-65; WF-09 devolve as linhas sem `resolved` (e sem `id` quando servida do snapshot publicado).

### APV-01 — GET `/approvals` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-125:** request MVP 1 → response linha com `branchKey`, `branchLabel`, `siblings[]` (quando de ramo) · códigos 200, 422
- **US-136:** request MVP 1 + `decisionPolicy`, `myLineStatus` → response `data[]` do MVP 1 + `decisionPolicy`, `progress`, `myLine`, `currentApprover` (aditivo) · códigos 200, 401, 422, 429, 503
- **US-137:** request MVP 1 + `overdue`, `dueFrom`, `dueTo` → response `dueAt` e `isOverdue` (já existentes) agora preenchidos para `DOCUMENT` · códigos 200, 401, 422, 429, 503

### APV-02 — GET `/approvals/{id}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-125:** request — → response detalhe com `branchKey`, `branchLabel`, `siblings[]` · códigos 200, 403, 404
- **US-133:** request — → response `200 { data: Approval }` com `decisionPolicy` e `approvers[]` (`id`, `sequence`, `status`, `approverType`, `userId`, `roleId`, `departmentId`, `allowDeputy`, `label`, `activatedAt`, `dueAt`, `decision`, `decidedBy`, `decidedAt`, `decidedAsDeputy`, `skippedReason`) · `ETag` · códigos 200, 403, 404. Aprovações do MVP 1 vêm com `ANY` e a linha do backfill
- **US-134:** request — → response `200 { data: Approval }` com `decisionPolicy`, `approvers[]` (`id`, `sequence`, `status`, `label`, `decision?`, `decidedBy?`, `decidedAt?`, `decidedAsDeputy`, `version`) e `meta` (`myLine { id, sequence, status, etag }` — `etag` = o `If-Match` do voto: versão da aprovação em `ANY`, da linha em `ALL`/`SEQUENTIAL` —, `decidableLineIds[]`, `allowedActions`, `decisionOptions[]` com `closesApproval` — a opção que não encerra vem habilitada e sem `violations` —, `decisionBlocker` + `ALREADY_VOTED`, `LINE_NOT_PENDING`; linha `WAITING` = `NOT_DESIGNATED_APPROVER`) · `ETag` · códigos 200, 403, 404
- **US-136:** request path `id` → response `data` do MVP 1 + `decisionPolicy`, `approvers[]`; `meta` + `myApproverLineId`, `lineActions`, `waitingFor`; `decisionBlocker` + `LINE_NOT_PENDING`; `ETag` · códigos 200, 401, 403, 404, 429, 503
- **US-137:** request path `id` → response `dueAt` preenchido; sem campo novo · códigos 200, 401, 403, 404, 429, 503

### APV-03 — POST `/approvals/{id}/decide` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-134:** request `Idempotency-Key`, `If-Match` (da aprovação em `ANY`, da linha em `ALL`/`SEQUENTIAL` — `meta.myLine.etag`); `{ decision, comment?, approvalApproverId?, acknowledgedWarnings?, transitionId? }` → response `200 { data: Approval, meta: { outcome, remainingPending, remainingWaiting, activatedApproverId, approvalApproverId } }` com `processStage`, `processStatus`, `chainedApprovalId` no encerramento (no voto que não encerra: `processStage`/`chainedApprovalId` nulos e `processStatus` atual) · `ETag` (da aprovação) · erros: 409 `APPROVAL_NOT_PENDING`, 409 `APPROVAL_LINE_NOT_PENDING` (`meta.approvalApproverId`, `meta.lineStatus`), 409 `APPROVER_ALREADY_VOTED`, 403 `NOT_DESIGNATED_APPROVER` (`meta.reason` = `LINE_WAITING`/`NOT_LINE_APPROVER` quando é por linha), 422 `VALIDATION_ERROR` (`approvalApproverId` `CONDITIONAL_REQUIRED`) · códigos 200, 403, 404, 409, 412, 422, 428, 503

### APV-04 — POST `/approvals/{id}/withdraw` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-135:** request `Idempotency-Key`, `If-Match` (aprovação); `{ reason? }` → response `200 { data: Approval }` com `processStage` atual · `ETag` · códigos 200, 403, 404, 409, 412, 422, 428, 503

### APV-05 — POST `/approvals/{id}/reassign` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-135:** request como no MVP 1 → response `200 { data: Approval }`; aprovação com várias linhas → `422 APPROVAL_LINE_REQUIRED` · códigos 200, 403, 404, 409, 412, 422, 428

### CAL-06 — POST `/calendar/add-business-days` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-137:** request `{ fromDateTime, businessDays, dayCountType? }` (preview do prazo no diálogo) → response `200 { data: { dueDateTime } }` · códigos 200, 422, 503

### DOC-09 — POST `/documents/{id}/submit` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-133:** request como na US-065 → response `200 { data: Document }` com `pendingApprovalId` (a política e as linhas da avulsa ficam no APV-02; o resumo `approval { … }` nesta resposta fica pendente) · erros por linha como no PRC-19 · códigos 200, 403, 404, 409, 422, 503
- **US-137:** request `{ acknowledgedWarnings?, expectedDraftRevision? }` + `If-Match` + `Idempotency-Key` (MVP 1) → response `200 { data: Document }` + `pendingApprovalId` e, aditivo, `pendingApprovalDueAt` · códigos 200, 403, 404, 409, 412, 422, 503

### DTY-01 — GET `/document-types` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-137:** request — → response `approvalPolicy.slaDays`/`slaType` por tipo (já existente; origem do preview) · códigos 200, 403

### DTY-02 — POST `/document-types` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-132:** request `approvalPolicy` com `decisionPolicy?` e `approvers[]?` → response `201 { data: DocumentType }` · códigos 201, 403, 409, 422. Com linhas, os campos do aprovador único enviados são sobrescritos pelo espelho da linha 1; `ALL`/`SEQUENTIAL` com menos de duas linhas → 422 `DOCUMENT_APPROVAL_POLICY_INVALID`; repetição → `VALIDATION_ERROR` (`DUPLICATE_IN_LIST` em `approvalPolicy.approvers[n]`); referência por linha em `approvalPolicy.approvers[n].campo`. A resposta sempre traz `decisionPolicy` e `approvers` (padrão `ANY`, `[]`).

### DTY-03 — PATCH `/document-types/{id}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-132:** request idem + `If-Match` → response `200 { data: DocumentType }` · códigos 200, 403, 404, 412, 422, 428
- **US-137:** request `approvalPolicy.slaDays`/`slaType` (já existente) + `If-Match` → response `200 { data: DocumentType }` · códigos 200, 403, 404, 412, 422

### PRC-01 — GET `/processes` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-125:** request MVP 1; filtros por etapa/unidade/responsável casam com qualquer etapa ativa → response `ProcessListItem` + `activeStages[]` compacto, `activeStagesCount`, `deadline` pelo menor `dueAt` (+ `criticalStage`) · códigos 200, 403, 422

### PRC-04 — GET `/processes/{id}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-124:** request — → response MVP 1 + `activeStages[]`, `activeStagesCount` (aditivo; `currentStage` = split no paralelismo) · códigos 200, 404

### PRC-07 — GET `/processes/{id}/summary` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-125:** request — → response MVP 1 + `where.stages[]`, `responsible.byStage[]`, `nextStep.byStage[]`, `pending.items[].processStageId/branchKey`, `approvals[].branchKey`, `deadline.criticalStage` · códigos 200, 404

### PRC-08 — GET `/processes/{id}/available-actions` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-124:** request — → response `{ data: ActionEntry[], stages?: [{ processStageId, branchKey, stageKey, stageName, isMine }] }`; entradas de etapa ganham `processStageId` e `branchKey`; razões incluem `PROCESS_STAGE_REQUIRED`, `NOT_PROCESS_CUSTODIAN`, `TRANSITION_BLOCKED` (inclui regras do join no último ramo) · códigos 200, 404

### PRC-09 — GET `/processes/{id}/checklist` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-124:** request query `processStageId?` → response MVP 1; sem o parâmetro agrega as pendências de todas as etapas ativas (`violations[].processStageId`, `branchKey`) · códigos 200, 404

### PRC-10 — GET `/processes/{id}/stages` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-124:** request — → response MVP 1 + `StageEntry.branchKey`, `isCurrent` verdadeiro em **cada** etapa ativa, `passes[].branchKey` · códigos 200, 404

### PRC-11 — GET `/processes/{id}/movements` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-124:** request query `branchKey?` → response MVP 1 + `branchKey` em cada movimento · códigos 200, 404

### PRC-19 — POST `/processes/{id}/forward` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-124:** request MVP 1 + `processStageId?` (obrigatório com várias etapas ativas); `Idempotency-Key` e `If-Match` obrigatórios → response `200 { data: Process }` + `activeStages[]`; `movement { id, sequence, branchKey? }` · códigos 200, 403, 404, 409 (`STAGE_CHANGED`, `INVALID_PROCESS_STATUS`), 412, 422
- **US-133:** request como na US-047 → response `200 { data: Process, … }` com `approval { id, approverLabel, decisionPolicy, approvers[] { id, sequence, status, approverType, label } }` quando o destino é `APPROVAL` (aditivo; `approverLabel` composto pela política — "A ou B", "A e B", "A, depois B") · erros: 422 `APPROVER_UNRESOLVED` (`meta.sequence`, `meta.approverLabel` ou `meta.reason` = `POLICY_INVALID`/`LIMIT_EXCEEDED`), 403 `SELF_APPROVAL_FORBIDDEN` (`meta.sequence`), 422 `APPROVER_DUPLICATED` (`meta.sequences`) · códigos 200, 403, 404, 409, 412, 422, 503

### PRC-20 — POST `/processes/{id}/return` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-124:** request MVP 1 + `processStageId?`, `confirmBranchCancellation?` → response `200 { data: Process }` + `activeStages[]` · códigos 200, 403, 404, 409, 412, 422

### PRC-21 — POST `/processes/{id}/claim` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-124:** request corpo opcional `{ processStageId? }`; `If-Match` → response `200 { data: Process }` · códigos 200, 403, 404, 409 (`PROCESS_ALREADY_ASSIGNED`), 412, 422

### PRC-22 — POST `/processes/{id}/assign` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-124:** request MVP 1 + `processStageId?` → response `200 { data: Process }` · códigos 200, 403, 404, 409, 412, 422

### PRC-23 — POST `/processes/{id}/suspend` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-124:** request MVP 1 (`reason`) → response `200` — pausa **todas** as etapas ativas (`activeStages[].pausedAt`) · códigos 200, 403, 404, 409, 412, 422

### PRC-24 — POST `/processes/{id}/resume` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-124:** request MVP 1 → response `200` — estende o `dueAt` de cada etapa ativa · códigos 200, 403, 404, 409, 412

### PRC-25 — POST `/processes/{id}/cancel` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-124:** request MVP 1 → response `200` — cancela ramos, etapas e aprovações pendentes · códigos 200, 403, 404, 409, 412, 422

### TSK-01 — GET `/tasks` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-125:** request MVP 1 + `branchKey?` (filtro opcional) → response Linha por etapa ativa com `rowKey`, `processStageId`, `branchKey`, `branchLabel`, `activeStagesCount`, `siblings[]`, `siblingsMore` (RN-WF2-30) · códigos 200, 403, 422
- **US-136:** request `?view=PENDING_APPROVALS&page=&pageSize=&sort=` (MVP 1) → response `data[]` do MVP 1; em `PENDING_APPROVALS`, `id` = `approvalApproverId` e `approval { id, approvalApproverId, sequence, decisionPolicy, progress, title, subjectType, requestedBy, requestedAt, dueAt }` (aditivo); `process` nulo em assunto `PCA` · códigos 200, 401, 403, 422, 429, 500, 503
- **US-137:** request `view=PENDING_APPROVALS` → response `approval.dueAt` com o prazo próprio da aprovação avulsa (antes, o da etapa) · códigos 200, 401, 403, 422, 429, 503

### TSK-02 — GET `/tasks/counters` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-125:** request — → response `{ data: { mine, unitQueue?, pendingApprovals, returned, overdue, following }, meta: { countUnit: "ROW" } }` · códigos 200, 403
- **US-136:** request — → response `pendingApprovals` passa a contar linhas `PENDING` (RN-APV-64) · códigos 200, 401, 403, 429, 500, 503

### TSK-03 — POST `/tasks/bulk-claim` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-125:** request `processIds` **ou** `items: [{ processId, processStageId }]` (2–50); `Idempotency-Key` → response `200 { data: [{ processId, processStageId?, ok, code?, message?, process? }], meta: { successCount, errorCount } }` · códigos 200, 403, 422

### TSK-04 — POST `/tasks/bulk-assign` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-125:** request idem + `assigneeId` do MVP 1 → response idem · códigos 200, 403, 422

### WF-08 — POST `/workflows/{id}/versions` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-132:** request como no MVP 1 → response cópia inclui `decisionPolicy` e `approvers[]` · códigos 201, 403, 404, 409, 422

### WF-09 — GET `/workflow-versions/{versionId}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-123:** request — → response MVP 1 + `stages[].type` com os valores novos e `stages[].branchKey` (aditivo) · códigos 200, 403, 404, 503
- **US-132:** request — → response etapas com `decisionPolicy` e `approvers[]` (aditivo) · códigos 200, 403, 404

### WF-10 — POST `/workflow-versions/{versionId}/stages` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-123:** request MVP 1; `type` aceita `PARALLEL_SPLIT`/`PARALLEL_JOIN` (sem SLA/aprovador) → response `201 { data: WorkflowStage }` · códigos 201, 403, 409, 422

### WF-11 — PATCH `/workflow-stages/{stageId}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-123:** request MVP 1 (`If-Match`); mesmas restrições de WF-10 → response `200` + `ETag` · códigos 200, 403, 409, 412, 422
- **US-132:** request como no MVP 1 → response recusa `decisionPolicy` e o aprovador único com lista preenchida · códigos 200, 403, 409, 412, 422, 428

### WF-13 — POST `/workflow-versions/{versionId}/transitions` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-123:** request MVP 1; compatibilidade ação × tipo estendida (RN-WF2-05) → response `201 { data: WorkflowTransition }` · códigos 201, 403, 409, 422

### WF-14 — PATCH `/workflow-transitions/{transitionId}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-123:** request MVP 1 (`If-Match`) → response `200` + `ETag` · códigos 200, 403, 409, 412, 422

### WF-16 — POST `/workflow-versions/{versionId}/rules` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-129:** request corpo do MVP 1 + `contextVersion?` (padrão 2) → response `201 { data: WorkflowRule }` com `contextVersion` · códigos 201, 403, 409, 422

### WF-17 — PATCH `/workflow-rules/{ruleId}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-129:** request parcial + `contextVersion?` + `If-Match` → response `200 { data: WorkflowRule }` · códigos 200, 403, 409, 412, 422, 428

### WF-19 — GET `/rule-context/schema` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-129:** request query `version` (1 | 2, padrão 1) → response `200 { data: { version, namespaces?[], fields: [{ path, label, type, namespace? }] } }` · códigos 200, 403, 422

### WF-20 — POST `/workflow-versions/{versionId}/validate` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-123:** request — → response `200 { data: { valid, errors[], warnings[] } }` com itens `WF_PARALLEL_INVALID` e `reason` · códigos 200, 404
- **US-129:** request — → response `200 { data: { valid, errors[], warnings[] } }` com os códigos novos em `errors[]` · códigos 200, 404
- **US-132:** request — → response `errors[]` com `WF_APPROVERS_INVALID` / `WF_APPROVER_UNRESOLVABLE` e `params.sequence`/`params.reason` · códigos 200, 404

### WF-21 — POST `/workflow-versions/{versionId}/publish` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-123:** request `{ changeNotes? }`; `If-Match` obrigatório → response `200 { data: WorkflowVersion }` (`branchKey` gravado) · códigos 200, 403, 404, 409, 412, 422 (`WORKFLOW_INVALID`), 428

### WF-23 — POST `/workflow-versions/{versionId}/rules/test` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-129:** request `{ type, config, severity?, message?, processId, contextVersion? }` → response `200 { data: { satisfied, severity, message, contextUsed, contextVersion, warnings[] } }` (aviso `NAMESPACE_UNAVAILABLE`) · códigos 200, 403, 404, 422, 503
