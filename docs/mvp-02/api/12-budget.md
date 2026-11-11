# 3.12 Dotação orçamentária (`budget`) — MVP 2

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint) do MVP 2. Convenções, erros genéricos e de domínio: [api.md §1–§2](../api.md#1-convenções) (que herda o [api.md do MVP 1](../../mvp-01/api.md)). Épico(s): EP-024. Fonte de cada linha: a seção "API" da story citada — divergência entre este arquivo e a story é bug de especificação.

Dotação orçamentária do processo (`BudgetAllocation`): classificação, fonte, valor reservado e evidência, com confronto com o valor estimado e a regra de saída da etapa `DOTACAO` no `RuleContext` v2. Não há tela própria: a dotação aparece no detalhe do processo (SCR-006) e na caixa de tarefas (SCR-013). Valores sigilosos seguem a POL do orçamento sigiloso do MVP 1 (`PROCESS_VIEW_CONFIDENTIAL_BUDGET`).

Legenda: **Idem.** = `Idempotency-Key`; **IM** = `If-Match` (com `ETag` na resposta); "—" = não se aplica. Escritas sem `If-Match` criam recurso novo ou são ações idempotentes por chave. Listas paginam com `page`/`pageSize` (≤ 100) e `sort`, salvo indicação na linha.

## Endpoints novos

| ID | Método | Rota | Permissão | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| BUD-01 | GET | `/processes/{id}/budget-allocations` | `PROCESS_VIEW` | — | — | US-146, US-148 |
| BUD-02 | POST | `/processes/{id}/budget-allocations` | `BUDGET_ALLOCATION_MANAGE` + POL-09 | Obrigatório | — | US-146 |
| BUD-03 | GET | `/processes/{id}/budget-allocations/{allocationId}` | `PROCESS_VIEW` | — | — | US-146 |
| BUD-04 | PATCH | `/processes/{id}/budget-allocations/{allocationId}` | `BUDGET_ALLOCATION_MANAGE` + POL-09 | — | Obrigatório | US-146 |
| BUD-05 | DELETE | `/processes/{id}/budget-allocations/{allocationId}` | `BUDGET_ALLOCATION_MANAGE` + POL-09 | — | Obrigatório | US-146 |
| BUD-10 | POST | `/processes/{id}/budget-allocations/{allocationId}/confirm` | `BUDGET_ALLOCATION_CONFIRM` + POL-25 | Obrigatório | Obrigatório | US-147 |
| BUD-11 | POST | `/processes/{id}/budget-allocations/{allocationId}/cancel` | `BUDGET_ALLOCATION_MANAGE` + POL-25 | Obrigatório | Obrigatório | US-147 |
| BUD-12 | POST | `/processes/{id}/budget-allocations/declaration` | `BUDGET_ALLOCATION_MANAGE` + POL-25 | Obrigatório | — | US-147 |
| BUD-20 | GET | `/processes/{id}/budget-allocations/coverage` | `PROCESS_VIEW` | — | — | US-148 |

## Rotas do MVP 1 ampliadas

Mudanças **aditivas** (campos opcionais, enums ampliados, filtros novos) sobre contratos do MVP 1; o comportamento do MVP 1 vale sem os campos novos. O contrato original está no arquivo indicado da pasta `mvp-01/api/`.

| ID | Método | Rota (MVP 1) | Permissão (MVP 1) | Contrato original | Ampliado por |
|---|---|---|---|---|---|
| ATT-01 | GET | `/processes/{id}/attachments` | `PROCESS_VIEW` | [12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md) | US-147 |
| ATT-02 | POST | `/attachments` | `ATTACHMENT_UPLOAD` + alvo editável | [12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md) | US-147 |
| ATT-03 | POST | `/attachments/{id}/confirm` | uploader | [12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md) | US-147 |
| ATT-04 | GET | `/attachments/{id}` | `PROCESS_VIEW` | [12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md) | US-147 |
| ATT-05 | GET | `/attachments/{id}/download` | `PROCESS_VIEW` + POL-09 | [12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md) | US-147 |
| CAT-01 | GET | `/catalogs/{catalogType}/items` | implícita | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-146 |
| DOC-21 | POST | `/document-versions/{versionId}/renditions` | `PROCESS_VIEW` (+POL-09) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-147 |
| DOC-22 | GET | `/document-renditions/{renditionId}` | `PROCESS_VIEW` (+POL-09) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-147 |
| DOC-23 | GET | `/document-renditions/{renditionId}/download` | `PROCESS_VIEW` (+POL-09) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-147 |
| PRC-08 | GET | `/processes/{id}/available-actions` | `PROCESS_VIEW` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-148 |
| PRC-09 | GET | `/processes/{id}/checklist` | `PROCESS_VIEW` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-148 |
| PRC-19 | POST | `/processes/{id}/forward` | `PROCESS_FORWARD` + POL-01 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-148 |
| PRC-20 | POST | `/processes/{id}/return` | `PROCESS_RETURN` + POL-01 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-148 |
| SET-01 | GET | `/settings` | `SETTINGS_MANAGE` | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-148 |
| SET-02 | PATCH | `/settings` | `SETTINGS_MANAGE` (IM por chave no corpo, Idem.) | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-148 |
| TSK-01 | GET | `/tasks` | `INBOX_VIEW` | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-146, US-148 |
| WF-19 | GET | `/rule-context/schema` | `WORKFLOW_VIEW` | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-148 |
| WF-23 | POST | `/workflow-versions/{versionId}/rules/test` | `WORKFLOW_MANAGE` + `PROCESS_VIEW` (processo base) | [10-workflow.md](../../mvp-01/api/10-workflow.md) | US-148 |

## Especificação por endpoint

### BUD-01 — GET `/processes/{id}/budget-allocations`
**Permissão:** `PROCESS_VIEW` · **Story:** US-146 (também citado por US-148)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `?status=DRAFT,CONFIRMED&fiscalYear=` (padrão exclui `CANCELED`)
- **Response:** `200 { data: BudgetAllocation[], meta: { summary { allocationsCount, draftCount, confirmedCount, canceledCount }, allowedActions } }`; valor mascarado conforme POL-09
- **Códigos:** 200, 401, 403, 404
- **Uso/ampliação em US-148:** request como na US-146 → response `meta.coverage` (resumo de `Coverage`) — aditivo · códigos 200, 403, 404

### BUD-02 — POST `/processes/{id}/budget-allocations`
**Permissão:** `BUDGET_ALLOCATION_MANAGE` + POL-09 · **Story:** US-146
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ fiscalYear, budgetUnitId, budgetActionId, expenseNatureId, fundingSourceId, reservedAmount, notes? }` + `Idempotency-Key`
- **Response:** `201 { data: BudgetAllocation, meta: { warnings[] } }` + `ETag`, `Location`
- **Códigos:** 201, 401, 403, 404, 409, 422, 429, 503

### BUD-03 — GET `/processes/{id}/budget-allocations/{allocationId}`
**Permissão:** `PROCESS_VIEW` · **Story:** US-146
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: BudgetAllocation }` + `ETag`; `reservedAmount`/`reservedAmountMasked` sempre presentes
- **Códigos:** 200, 401, 403, 404

### BUD-04 — PATCH `/processes/{id}/budget-allocations/{allocationId}`
**Permissão:** `BUDGET_ALLOCATION_MANAGE` + POL-09 · **Story:** US-146
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** qualquer subconjunto de `fiscalYear`, `budgetUnitId`, `budgetActionId`, `expenseNatureId`, `fundingSourceId`, `reservedAmount`, `notes` + `If-Match`
- **Response:** `200 { data: BudgetAllocation, meta: { warnings[] } }` + novo `ETag`
- **Códigos:** 200, 403, 404, 409, 412, 422, 428, 503

### BUD-05 — DELETE `/processes/{id}/budget-allocations/{allocationId}`
**Permissão:** `BUDGET_ALLOCATION_MANAGE` + POL-09 · **Story:** US-146
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ reason }` + `If-Match`
- **Response:** `200 { data: BudgetAllocation }` com `status = CANCELED` (remoção lógica de rascunho)
- **Códigos:** 200, 403, 404, 409, 412, 422, 428, 503

### BUD-10 — POST `/processes/{id}/budget-allocations/{allocationId}/confirm`
**Permissão:** `BUDGET_ALLOCATION_CONFIRM` + POL-25 · **Story:** US-147
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ reservationNumber, reservationDate, evidenceAttachmentId, notes? }` + `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: BudgetAllocation (CONFIRMED), meta: { coverageReached } }` + novo `ETag`
- **Códigos:** 200, 403, 404, 409, 412, 422, 428, 503

### BUD-11 — POST `/processes/{id}/budget-allocations/{allocationId}/cancel`
**Permissão:** `BUDGET_ALLOCATION_MANAGE` + POL-25 · **Story:** US-147
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ reason }` + `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: BudgetAllocation (CANCELED), meta: { coverageReached } }`
- **Códigos:** 200, 403, 404, 409, 412, 422, 428, 503

### BUD-12 — POST `/processes/{id}/budget-allocations/declaration`
**Permissão:** `BUDGET_ALLOCATION_MANAGE` + POL-25 · **Story:** US-147
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ title? }` + `Idempotency-Key`
- **Response:** `202 { data: { documentId, documentVersionId, renditionId, code } }`
- **Códigos:** 202, 403, 404, 409, 422, 503

### BUD-20 — GET `/processes/{id}/budget-allocations/coverage`
**Permissão:** `PROCESS_VIEW` · **Story:** US-148
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: Coverage }` (campos abaixo); valores mascarados conforme POL-09
- **Códigos:** 200, 401, 403, 404

### ATT-01 — GET `/processes/{id}/attachments` (ampliação do MVP 1)
Contrato original: [mvp-01/api/12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md). Mudanças do MVP 2, todas aditivas:
- **US-147:** request como na US-069 (o painel filtra a lista por `targetType = BUDGET_ALLOCATION` e `targetId`) → response lista com `status` · códigos 200

### ATT-02 — POST `/attachments` (ampliação do MVP 1)
Contrato original: [mvp-01/api/12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md). Mudanças do MVP 2, todas aditivas:
- **US-147:** request `{ targetType: "BUDGET_ALLOCATION", targetId, fileName, declaredMimeType, sizeBytes, categoryId? }` (US-068) → response `201` com URL assinada · códigos 201, 403, 404, 409, 413, 415, 422

### ATT-03 — POST `/attachments/{id}/confirm` (ampliação do MVP 1)
Contrato original: [mvp-01/api/12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md). Mudanças do MVP 2, todas aditivas:
- **US-147:** request — → response `202` (varredura) · códigos 202, 409

### ATT-04 — GET `/attachments/{id}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md). Mudanças do MVP 2, todas aditivas:
- **US-147:** request — → response anexo e estado de varredura · códigos 200, 404

### ATT-05 — GET `/attachments/{id}/download` (ampliação do MVP 1)
Contrato original: [mvp-01/api/12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md). Mudanças do MVP 2, todas aditivas:
- **US-147:** request — → response `{ url, expiresAt }` (POL-09 para alvo de dotação em processo sigiloso) · códigos 200, 403, 404, 409

### CAT-01 — GET `/catalogs/{catalogType}/items` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-146:** request `catalogType` ∈ `BUDGET_UNIT`, `BUDGET_ACTION`, `EXPENSE_NATURE`, `FUNDING_SOURCE`; `?active=true` → response `200 { data: CatalogItem[] }` com `code`, `label`, `metadata.officialCode` · códigos 200, 401, 404

### DOC-21 — POST `/document-versions/{versionId}/renditions` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-147:** request `{ kind: "CONTENT" }` → response `202` (nova tentativa de PDF) · códigos 202, 403, 404

### DOC-22 — GET `/document-renditions/{renditionId}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-147:** request — → response estado do PDF · códigos 200

### DOC-23 — GET `/document-renditions/{renditionId}/download` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-147:** request — → response `{ url, expiresAt }` · códigos 200, 409

### PRC-08 — GET `/processes/{id}/available-actions` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-148:** request — → response `reasons[]` com a mensagem da regra de cobertura; ação `RETURN` para `DOTACAO` quando configurada · códigos 200

### PRC-09 — GET `/processes/{id}/checklist` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-148:** request — → response itens R1/R2 com `severity` efetiva e `satisfied` · códigos 200

### PRC-19 — POST `/processes/{id}/forward` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-148:** request como na US-047 (`acknowledgedWarnings[]` para `WARNING`) → response `TRANSITION_BLOCKED`/`WARNINGS_NOT_ACKNOWLEDGED` com `violations[]` da cobertura · códigos 200, 403, 404, 409, 412, 422, 503

### PRC-20 — POST `/processes/{id}/return` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-148:** request como na US-048 (`targetStageId` = `DOTACAO`, `comment`) → response devolução humana · códigos 200, 403, 404, 409, 412, 422

### SET-01 — GET `/settings` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-148:** request — → response inclui `budget.coverageRuleSeverity` · códigos 200, 403

### SET-02 — PATCH `/settings` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-148:** request `{ values: { "budget.coverageRuleSeverity": "WARNING" }, expectedVersions: { … } }` → response `200 { data: { "budget.coverageRuleSeverity": { value, version } } }` · códigos 200, 403, 412, 422, 428

### TSK-01 — GET `/tasks` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-146:** request como na US-056 → response itens da etapa `DOTACAO` ganham `budget { allocationsCount, draftCount, confirmedCount }` (aditivo) · códigos 200, 401, 403
- **US-148:** request como na US-056 → response `budget.coverageState` na linha da etapa `DOTACAO` — aditivo · códigos 200

### WF-19 — GET `/rule-context/schema` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-148:** request `version=2` / expressão com `budget.*` → response namespace `budget` disponível; valores sigilosos como `"[sigiloso]"` · códigos 200, 403, 422

### WF-23 — POST `/workflow-versions/{versionId}/rules/test` (ampliação do MVP 1)
Contrato original: [mvp-01/api/10-workflow.md](../../mvp-01/api/10-workflow.md). Mudanças do MVP 2, todas aditivas:
- **US-148:** request `version=2` / expressão com `budget.*` → response namespace `budget` disponível; valores sigilosos como `"[sigiloso]"` · códigos 200, 403, 422
