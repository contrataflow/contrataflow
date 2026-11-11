# 3.11 PCA (`pca`) — MVP 2

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint) do MVP 2. Convenções, erros genéricos e de domínio: [api.md §1–§2](../api.md#1-convenções) (que herda o [api.md do MVP 1](../../mvp-01/api.md)). Épico(s): EP-023. Fonte de cada linha: a seção "API" da story citada — divergência entre este arquivo e a story é bug de especificação.

Plano de Contratações Anual por exercício (`Pca`, `PcaItem` — entities.md §PCA): cadastro e edição dos itens, importação por planilha com prévia e confirmação, envio e aprovação pela autoridade (aprovação avulsa do MVP 1 com `subjectType = PCA`), revisões do plano aprovado, vínculo de DFD e processo a um item (`pca_item_id`), reconciliação das referências textuais do MVP 1 (`pcaYear` + `pcaItemCode`), acompanhamento da execução e exportação para divulgação. Tela: SCR-018. Permissões `PCA_*` (permissions.md do MVP 2).

Legenda: **Idem.** = `Idempotency-Key`; **IM** = `If-Match` (com `ETag` na resposta); "—" = não se aplica. Escritas sem `If-Match` criam recurso novo ou são ações idempotentes por chave. Listas paginam com `page`/`pageSize` (≤ 100) e `sort`, salvo indicação na linha.

## Endpoints novos

| ID | Método | Rota | Permissão | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| PCA-01 | GET | `/pcas` | `PCA_VIEW` | — | — | US-138 |
| PCA-02 | POST | `/pcas` | `PCA_MANAGE` | Obrigatório | — | US-138 |
| PCA-03 | GET | `/pcas/{pcaId}` | `PCA_VIEW` | — | — | US-138 |
| PCA-04 | PATCH | `/pcas/{pcaId}` | `PCA_MANAGE` | — | Obrigatório | US-138 |
| PCA-05 | DELETE | `/pcas/{pcaId}` | `PCA_MANAGE` | — | Obrigatório | US-138 |
| PCA-06 | GET | `/pcas/{pcaId}/items` | `PCA_VIEW` | — | — | US-138 |
| PCA-07 | POST | `/pcas/{pcaId}/items` | `PCA_MANAGE` | Obrigatório | — | US-138 |
| PCA-08 | PATCH | `/pca-items/{itemId}` | `PCA_MANAGE` | — | Obrigatório | US-138 |
| PCA-09 | DELETE | `/pca-items/{itemId}` | `PCA_MANAGE` | — | Obrigatório | US-138 |
| PCA-10 | GET | `/pcas/{pcaId}/import-template` | `PCA_MANAGE` | — | — | US-139 |
| PCA-11 | POST | `/pcas/{pcaId}/imports` | `PCA_MANAGE` | Obrigatório | — | US-139 |
| PCA-12 | GET | `/pcas/{pcaId}/imports/{importId}` | `PCA_MANAGE` | — | — | US-139 |
| PCA-13 | POST | `/pcas/{pcaId}/imports/{importId}/confirm` | `PCA_MANAGE` | Obrigatório | Obrigatório | US-139 |
| PCA-14 | GET | `/pcas/{pcaId}/imports/{importId}/report` | `PCA_MANAGE` | — | — | US-139 |
| PCA-15 | POST | `/pcas/{pcaId}/submit` | `PCA_SUBMIT` | Obrigatório | Obrigatório | US-140 |
| PCA-16 | POST | `/pcas/{pcaId}/withdraw` | `PCA_SUBMIT` | Obrigatório | Obrigatório | US-140 |
| PCA-17 | GET | `/pcas/{pcaId}/approvals` | `PCA_VIEW` | — | — | US-140 |
| PCA-18 | GET | `/pcas/{pcaId}/submission-check` | `PCA_SUBMIT` | — | — | US-140 |
| PCA-20 | POST | `/pcas/{pcaId}/revisions` | `PCA_MANAGE` | Obrigatório | Obrigatório | US-141 |
| PCA-21 | GET | `/pcas/{pcaId}/versions` | `PCA_VIEW` | — | — | US-141 |
| PCA-22 | GET | `/pcas/{pcaId}/versions/compare` | `PCA_VIEW` | — | — | US-141 |
| PCA-23 | GET | `/pcas/{pcaId}/revision-impact` | `PCA_VIEW` | — | — | US-141 |
| PCA-24 | POST | `/pcas/{pcaId}/discard` | `PCA_MANAGE` | — | Obrigatório | US-141 |
| PCA-25 | GET | `/pcas/{pcaId}/execution` | `PCA_VIEW` | — | — | US-144 |
| PCA-26 | GET | `/pca-items/{itemId}/processes` | `PCA_VIEW` | — | — | US-144 |
| PCA-27 | PATCH | `/pca-items/{itemId}/status` | `PCA_MANAGE` | Obrigatório | Obrigatório | US-144 |
| PCA-28 | POST | `/pcas/{pcaId}/execution/recount` | `PCA_MANAGE` | — | — | US-144 |
| PCA-32 | POST | `/pcas/{pcaId}/exports` | `PCA_EXPORT` | Obrigatório | — | US-145 |
| PCA-33 | GET | `/pcas/{pcaId}/exports/{exportId}` | `PCA_EXPORT` | — | — | US-145 |
| PCA-34 | GET | `/pcas/{pcaId}/exports/{exportId}/download` | `PCA_EXPORT` | — | — | US-145 |
| PCA-35 | GET | `/pcas/{pcaId}/exports` | `PCA_EXPORT` | — | — | US-145 |
| PCA-36 | GET | `/pcas/{pcaId}/disclosure-preview` | `PCA_EXPORT` | — | — | US-145 |
| PCA-40 | GET | `/pca-items/lookup` | `PCA_VIEW` | — | — | US-142 |
| PCA-41 | POST | `/pca-items/check-link` | `PCA_VIEW` | — | — | US-142 |
| PCA-42 | GET | `/processes/{id}/pca-link` | `PCA_VIEW` | — | — | US-142 |
| PCA-43 | GET | `/dfds/{id}/pca-link` | `PCA_VIEW` | — | — | US-142 |
| PCA-48 | POST | `/pcas/{pcaId}/reconciliations` | `PCA_RECONCILE` | Obrigatório | — | US-143 |
| PCA-49 | GET | `/pcas/{pcaId}/reconciliations` | `PCA_VIEW` ou `PCA_RECONCILE` | — | — | US-143 |
| PCA-50 | GET | `/pcas/{pcaId}/reconciliations/{runId}` | `PCA_VIEW` ou `PCA_RECONCILE` | — | — | US-143 |
| PCA-51 | GET | `/pcas/{pcaId}/reconciliations/{runId}/entries` | `PCA_VIEW` ou `PCA_RECONCILE` | — | — | US-143 |
| PCA-52 | GET | `/pcas/{pcaId}/reconciliation-pending` | `PCA_VIEW` ou `PCA_RECONCILE` | — | — | US-143 |
| PCA-53 | GET | `/pcas/{pcaId}/reconciliation-pending/export` | `PCA_EXPORT` ou `PCA_VIEW` | — | — | US-143 |
| PCA-54 | GET | `/pca-reconciliation-entries/{entryId}` | `PCA_VIEW` ou `PCA_RECONCILE` | — | — | US-143 |
| PCA-55 | GET | `/pca-reconciliation-entries/{entryId}/candidates` | `PCA_VIEW` ou `PCA_RECONCILE` | — | — | US-143 |
| PCA-56 | POST | `/pca-reconciliation-entries/{entryId}/conciliate` | `PCA_RECONCILE` + POL-22 | Obrigatório | — | US-143 |
| PCA-57 | POST | `/pcas/{pcaId}/reconciliation-pending/conciliate` | `PCA_RECONCILE` + POL-22 | Obrigatório | — | US-143 |

## Rotas do MVP 1 ampliadas

Mudanças **aditivas** (campos opcionais, enums ampliados, filtros novos) sobre contratos do MVP 1; o comportamento do MVP 1 vale sem os campos novos. O contrato original está no arquivo indicado da pasta `mvp-01/api/`.

| ID | Método | Rota (MVP 1) | Permissão (MVP 1) | Contrato original | Ampliado por |
|---|---|---|---|---|---|
| APV-01 | GET | `/approvals` | Cobertura de aprovador (POL-03) | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-140 |
| APV-02 | GET | `/approvals/{id}` | `APPROVAL_VIEW` ou designado | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-140, US-141 |
| APV-03 | POST | `/approvals/{id}/decide` | `APPROVAL_DECIDE` + POL-03 | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-140, US-141 |
| ATT-02 | POST | `/attachments` | `ATTACHMENT_UPLOAD` + alvo editável | [12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md) | US-139 |
| ATT-03 | POST | `/attachments/{id}/confirm` | uploader | [12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md) | US-139 |
| ATT-04 | GET | `/attachments/{id}` | `PROCESS_VIEW` | [12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md) | US-139 |
| CAT-01 | GET | `/catalogs/{catalogType}/items` | implícita | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-138 |
| DEP-02 | GET | `/departments/lookup` | implícita | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-138 |
| DFD-02 | POST | `/processes/{id}/dfds` | `DFD_CREATE` + POL-02 | [05-dfd.md](../../mvp-01/api/05-dfd.md) | US-142 |
| DFD-03 | GET | `/dfds/{id}` | `PROCESS_VIEW` | [05-dfd.md](../../mvp-01/api/05-dfd.md) | US-142 |
| DFD-04 | PATCH | `/dfds/{id}` | `DFD_UPDATE` + POL-02 | [05-dfd.md](../../mvp-01/api/05-dfd.md) | US-142 |
| DOC-08 | GET | `/documents/{id}/validation` | `PROCESS_VIEW` | [03-documents.md](../../mvp-01/api/03-documents.md) | US-142 |
| PRC-02 | POST | `/processes` | `PROCESS_CREATE` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-142 |
| PRC-04 | GET | `/processes/{id}` | `PROCESS_VIEW` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-142 |
| PRC-05 | PATCH | `/processes/{id}` | `PROCESS_UPDATE` + POL-01 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-142 |
| PRC-07 | GET | `/processes/{id}/summary` | `PROCESS_VIEW` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-142 |
| SET-02 | PATCH | `/settings` | `SETTINGS_MANAGE` (IM por chave no corpo, Idem.) | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-138, US-142 |
| TSK-01 | GET | `/tasks` | `INBOX_VIEW` | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-140 |
| USR-02 | GET | `/users/lookup` | implícita | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-138 |

## Especificação por endpoint

### PCA-01 — GET `/pcas`
**Permissão:** `PCA_VIEW` · **Story:** US-138
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** query `year`, `status` (múltiplo), `organizationId`, `q`, `includeSuperseded`, `page`, `pageSize`, `sort` (`-year,-versionNumber`)
- **Response:** `200 { data: Pca[], meta }` (sem itens; totais do órgão só com escopo de órgão)
- **Códigos:** 200, 403, 422

### PCA-02 — POST `/pcas`
**Permissão:** `PCA_MANAGE` · **Story:** US-138
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ year, organizationId?, title? }` + `Idempotency-Key`
- **Response:** `201 { data: Pca }` + `Location`, `ETag`
- **Códigos:** 201, 403, 409, 422, 503

### PCA-03 — GET `/pcas/{pcaId}`
**Permissão:** `PCA_VIEW` · **Story:** US-138
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: Pca, meta: { allowedActions, scope, elaborationDeadline, totals { byDepartment[], byCategory[], byMonth[], byStatus[] } } }` + `ETag`
- **Códigos:** 200, 403, 404

### PCA-04 — PATCH `/pcas/{pcaId}`
**Permissão:** `PCA_MANAGE` · **Story:** US-138
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ title }` + `If-Match`
- **Response:** `200 { data: Pca }` + `ETag` nova
- **Códigos:** 200, 403, 404, 409, 412, 422, 428

### PCA-05 — DELETE `/pcas/{pcaId}`
**Permissão:** `PCA_MANAGE` · **Story:** US-138
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `If-Match`
- **Response:** `204`
- **Códigos:** 204, 403, 404, 409, 412, 428

### PCA-06 — GET `/pcas/{pcaId}/items`
**Permissão:** `PCA_VIEW` · **Story:** US-138
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** query `q`, `departmentId`, `categoryId`, `plannedMonth`, `status`, `responsibleId`, `valueFrom`, `valueTo`, `page`, `pageSize`, `sort`
- **Response:** `200 { data: PcaItem[], meta: { page, pageSize, totalItems, totalPages, filteredPlannedValue, scope } }`
- **Códigos:** 200, 403, 404, 422

### PCA-07 — POST `/pcas/{pcaId}/items`
**Permissão:** `PCA_MANAGE` · **Story:** US-138
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** corpo do item (campos da tabela) + `Idempotency-Key`
- **Response:** `201 { data: PcaItem }` + `Location`, `ETag`
- **Códigos:** 201, 403, 404, 409, 422, 503

### PCA-08 — PATCH `/pca-items/{itemId}`
**Permissão:** `PCA_MANAGE` · **Story:** US-138
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** campos alteráveis (sem `code`) + `If-Match`
- **Response:** `200 { data: PcaItem }` + `ETag` nova
- **Códigos:** 200, 403, 404, 409, 412, 422, 428

### PCA-09 — DELETE `/pca-items/{itemId}`
**Permissão:** `PCA_MANAGE` · **Story:** US-138
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `If-Match`
- **Response:** `204`
- **Códigos:** 204, 403, 404, 409, 412, 428

### PCA-10 — GET `/pcas/{pcaId}/import-template`
**Permissão:** `PCA_MANAGE` · **Story:** US-139
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** query `format` (`XLSX`|`CSV`, padrão `XLSX`)
- **Response:** `200` arquivo (`Content-Disposition: attachment`; abas Itens, Instruções e Listas no XLSX)
- **Códigos:** 200, 403, 404, 422

### PCA-11 — POST `/pcas/{pcaId}/imports`
**Permissão:** `PCA_MANAGE` · **Story:** US-139
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ attachmentId }` + `Idempotency-Key`
- **Response:** `202 { data: PcaImport }` + `Location` (PCA-12)
- **Códigos:** 202, 403, 404, 409, 413, 415, 422, 503

### PCA-12 — GET `/pcas/{pcaId}/imports/{importId}`
**Permissão:** `PCA_MANAGE` · **Story:** US-139
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** query `rejectionsPage`, `rejectionsPageSize` (≤ 100)
- **Response:** `200 { data: PcaImport, meta: { rejectionsTotal } }` · `ETag` · `Cache-Control: no-store`
- **Códigos:** 200, 403, 404

### PCA-13 — POST `/pcas/{pcaId}/imports/{importId}/confirm`
**Permissão:** `PCA_MANAGE` · **Story:** US-139
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{}` + `Idempotency-Key` + `If-Match` (versão da importação)
- **Response:** `202 { data: PcaImport }` (`APPLYING`)
- **Códigos:** 202, 403, 404, 409, 410, 412, 422, 428

### PCA-14 — GET `/pcas/{pcaId}/imports/{importId}/report`
**Permissão:** `PCA_MANAGE` · **Story:** US-139
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200` `text/csv` (`;`, UTF-8 com BOM, `Content-Disposition: attachment`)
- **Códigos:** 200, 403, 404, 409

### PCA-15 — POST `/pcas/{pcaId}/submit`
**Permissão:** `PCA_SUBMIT` · **Story:** US-140
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ comment? }` + `If-Match` (versão do plano) + `Idempotency-Key`
- **Response:** `200 { data: Pca, meta: { approval: { id, status, decisionPolicy, approvers[] } } }` + `ETag` nova
- **Códigos:** 200, 403, 404, 409, 412, 422, 428, 503

### PCA-16 — POST `/pcas/{pcaId}/withdraw`
**Permissão:** `PCA_SUBMIT` · **Story:** US-140
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ reason? }` + `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: Pca }` + `ETag` nova
- **Códigos:** 200, 403, 404, 409, 412, 422, 428, 503

### PCA-17 — GET `/pcas/{pcaId}/approvals`
**Permissão:** `PCA_VIEW` · **Story:** US-140
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** query `page`, `pageSize`
- **Response:** `200 { data: [{ approvalId, status, requestedBy, requestedAt, requestComment, decision, decidedBy, decidedAt, decisionComment }], meta }`
- **Códigos:** 200, 403, 404

### PCA-18 — GET `/pcas/{pcaId}/submission-check`
**Permissão:** `PCA_SUBMIT` · **Story:** US-140
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { canSubmit, approverResolved, approverReason?, violations[] }, meta: { violationsTotal } }`
- **Códigos:** 200, 403, 404

### PCA-20 — POST `/pcas/{pcaId}/revisions`
**Permissão:** `PCA_MANAGE` · **Story:** US-141
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ reason }` · `If-Match` da versão base · `Idempotency-Key`
- **Response:** `201 { data: Pca (nova versão, DRAFT), meta: { itemsCopied, linkedItemsCount } }` · `Location` · `ETag`
- **Códigos:** 201, 403, 404, 409, 412, 422, 428, 503

### PCA-21 — GET `/pcas/{pcaId}/versions`
**Permissão:** `PCA_VIEW` · **Story:** US-141
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: [ { id, versionNumber, status, title, revisionReason, previousVersionId, submittedAt, approvedAt, approvedBy, supersededAt, itemsCount, totalPlannedValue, approvalId } ], meta: { currentVersionId, openRevisionId, allowedActions[], reconciliation: { runId, status } } }`
- **Códigos:** 200, 403, 404

### PCA-22 — GET `/pcas/{pcaId}/versions/compare`
**Permissão:** `PCA_VIEW` · **Story:** US-141
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** filtros e paginação
- **Response:** `200 { data: { from, to, summary { added, removed, changed, unchanged, totalFrom, totalTo, delta }, items: [ { code, change, fromItem, toItem, fields: [ { name, from, to } ] } ] }, meta }`
- **Códigos:** 200, 403, 404, 422

### PCA-23 — GET `/pcas/{pcaId}/revision-impact`
**Permissão:** `PCA_VIEW` · **Story:** US-141
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { blocking: [ { code, reason, activeLinks, processes: [ { id, code, status } ], hiddenLinks } ], warnings: [ { code, kind, details } ] } }`
- **Códigos:** 200, 403, 404, 409

### PCA-24 — POST `/pcas/{pcaId}/discard`
**Permissão:** `PCA_MANAGE` · **Story:** US-141
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ reason? }` · `If-Match`
- **Response:** `200 { data: { id, discardedAt } }`
- **Códigos:** 200, 403, 404, 409, 412, 428, 503

### PCA-25 — GET `/pcas/{pcaId}/execution`
**Permissão:** `PCA_VIEW` · **Story:** US-144
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** filtros
- **Response:** `200 { data: { pca { id, year, versionNumber, status }, summary { plannedValue, linkedEstimatedValue, balance, executionPercent, itemsCount, itemsByStatus, linkedProcessesCount, itemsWithoutLink, confidentialLinkedCount, …Masked }, groups[] ou items[] }, meta { groupBy, processVisibility, confidentialStepUpAvailable, page… } }`
- **Códigos:** 200, 403, 404, 409, 422, 503

### PCA-26 — GET `/pca-items/{itemId}/processes`
**Permissão:** `PCA_VIEW` · **Story:** US-144
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** paginação
- **Response:** `200 { data: [ { id, code, title, status, currentStageName, requestingDepartment, estimatedValue, estimatedValueMasked, openedAt } ], meta }`
- **Códigos:** 200, 403, 404

### PCA-27 — PATCH `/pca-items/{itemId}/status`
**Permissão:** `PCA_MANAGE` · **Story:** US-144
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ status, statusReason? }` · `If-Match` · `Idempotency-Key`
- **Response:** `200 { data: PcaItem }` · `ETag`
- **Códigos:** 200, 403, 404, 409, 412, 422, 428, 503

### PCA-28 — POST `/pcas/{pcaId}/execution/recount`
**Permissão:** `PCA_MANAGE` · **Story:** US-144
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { itemsRecounted, itemsChanged } }`
- **Códigos:** 200, 403, 404, 409, 429, 503

### PCA-32 — POST `/pcas/{pcaId}/exports`
**Permissão:** `PCA_EXPORT` · **Story:** US-145
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ format }` · `Idempotency-Key`
- **Response:** `202 { data: PcaExport (PENDING) }` · `Location`
- **Códigos:** 202, 403, 404, 409, 422, 429, 503

### PCA-33 — GET `/pcas/{pcaId}/exports/{exportId}`
**Permissão:** `PCA_EXPORT` · **Story:** US-145
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: PcaExport }` (estado, contagens, `errorCode`)
- **Códigos:** 200, 403, 404

### PCA-34 — GET `/pcas/{pcaId}/exports/{exportId}/download`
**Permissão:** `PCA_EXPORT` · **Story:** US-145
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { url, expiresAt } }` (300 s)
- **Códigos:** 200, 403, 404, 409, 503

### PCA-35 — GET `/pcas/{pcaId}/exports`
**Permissão:** `PCA_EXPORT` · **Story:** US-145
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** paginação
- **Response:** `200 { data: PcaExport[], meta }` mais recentes primeiro
- **Códigos:** 200, 403, 404

### PCA-36 — GET `/pcas/{pcaId}/disclosure-preview`
**Permissão:** `PCA_EXPORT` · **Story:** US-145
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { organization { name, cnpj }, year, versionNumber, approvedAt, lastExportedAt, itemsCount, canceledOmittedCount, maskedItemsCount, publishedTotal, columns[], warnings[] } }`
- **Códigos:** 200, 403, 404, 409

### PCA-40 — GET `/pca-items/lookup`
**Permissão:** `PCA_VIEW` · **Story:** US-142
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** Query: um entre `processId`, `dfdId`, `organizationId`; `year?`, `q?` (≥ 2), `departmentId?`, `allDepartments?`, `limit?` (1–50, padrão 20)
- **Response:** `200 { data: [{ id, code, object, department{id,name}, category{id,label}, status, plan{id,year,versionNumber} }], meta: { planFound, planYear, planId?, hasMore } }` — sem valores · `Cache-Control: no-store`
- **Códigos:** 200, 403, 404, 422, 429

### PCA-41 — POST `/pca-items/check-link`
**Permissão:** `PCA_VIEW` · **Story:** US-142
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `{ pcaItemId, targetType: PROCESS|DFD, targetId?, organizationId?, estimatedValue? }` (sem gravar)
- **Response:** `200 { data: { eligible, violations[{code,severity,message,params}], balance? } }` · `balance`: `{ evaluated, exceeded }` e, com `PCA_VIEW`, `{ plannedValue, committedValue, available, confidentialExcluded }`
- **Códigos:** 200, 403, 404, 422, 429

### PCA-42 — GET `/processes/{id}/pca-link`
**Permissão:** `PCA_VIEW` · **Story:** US-142
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { pcaStatus, pcaYear, pcaItemCode, pcaLinkStatus, item?{id,code,object,department,category,status}, plan?{id,year,versionNumber,status}, alerts[], balance?, history[{at,actor,via,fromCode,toCode,reason?}] } }` · `ETag`
- **Códigos:** 200, 403, 404

### PCA-43 — GET `/dfds/{id}/pca-link`
**Permissão:** `PCA_VIEW` · **Story:** US-142
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** Igual a PCA-42 para o DFD (sem `balance`)
- **Códigos:** 200, 403, 404

### PCA-48 — POST `/pcas/{pcaId}/reconciliations`
**Permissão:** `PCA_RECONCILE` · **Story:** US-143
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{}` + `Idempotency-Key`; `PCA_RECONCILE`
- **Response:** `202 { data: PcaReconciliationRun }` (`status RUNNING`, `trigger MANUAL`, contadores 0) + `Location`
- **Códigos:** 202, 403, 404, 409, 422, 429, 503

### PCA-49 — GET `/pcas/{pcaId}/reconciliations`
**Permissão:** `PCA_VIEW` ou `PCA_RECONCILE` · **Story:** US-143
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** Query: `status?`, `trigger?`, `page`, `pageSize` (≤ 100), `sort=-startedAt`
- **Response:** `200 { data: Run[], meta: paginação }`
- **Códigos:** 200, 403, 404

### PCA-50 — GET `/pcas/{pcaId}/reconciliations/{runId}`
**Permissão:** `PCA_VIEW` ou `PCA_RECONCILE` · **Story:** US-143
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: Run + durationMs, reasons: { NO_MATCH, … } }`
- **Códigos:** 200, 403, 404

### PCA-51 — GET `/pcas/{pcaId}/reconciliations/{runId}/entries`
**Permissão:** `PCA_VIEW` ou `PCA_RECONCILE` · **Story:** US-143
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** Query: `outcome?`, `targetType?`, `reasonCode?`, `q?`, `page`, `pageSize`
- **Response:** `200 { data: Entry[], meta }` (entradas visíveis; resultado atual de cada uma)
- **Códigos:** 200, 403, 404, 422

### PCA-52 — GET `/pcas/{pcaId}/reconciliation-pending`
**Permissão:** `PCA_VIEW` ou `PCA_RECONCILE` · **Story:** US-143
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** Query: `outcome?` (padrão `UNRESOLVED,AMBIGUOUS`), `targetType?`, `reasonCode?`, `secretariatId?`, `processStatus?`, `q?`, `olderThanDays?`, `sort`, `page`, `pageSize`
- **Response:** `200 { data: [{ entryId, runId, targetType, target{ id, processId, code, title, status, secretariat }, pcaYear, pcaItemCode, outcome, reasonCode, candidatesCount, topCandidate?{ id, code }, ageDays }], meta: { page, pageSize, totalItems, totalPages, totals{ unresolved, ambiguous, olderThan30Days }, scopeLimited, awaitingPlan? } }`
- **Códigos:** 200, 403, 404, 422

### PCA-53 — GET `/pcas/{pcaId}/reconciliation-pending/export`
**Permissão:** `PCA_EXPORT` ou `PCA_VIEW` · **Story:** US-143
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** Mesmos filtros de PCA-52; `PCA_EXPORT`
- **Response:** `200 text/csv` (`Content-Disposition: attachment; filename="pca-pendencias-AAAA-AAAAMMDD-HHmm.csv"`)
- **Códigos:** 200, 403, 404, 422, 429

### PCA-54 — GET `/pca-reconciliation-entries/{entryId}`
**Permissão:** `PCA_VIEW` ou `PCA_RECONCILE` · **Story:** US-143
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `PCA_RECONCILE`
- **Response:** `200 { data: Entry + target{ …, object }, candidates[{ item{ id, code, object, department, status }, score }], resolvedBy?, resolvedAt?, resolutionNote? }, meta.allowedActions`
- **Códigos:** 200, 403, 404

### PCA-55 — GET `/pca-reconciliation-entries/{entryId}/candidates`
**Permissão:** `PCA_VIEW` ou `PCA_RECONCILE` · **Story:** US-143
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** Query: `q?` (≥ 2), `limit?` (1–50)
- **Response:** `200 { data: [{ id, code, object, department, category, status, suggested, score? }] }` — itens elegíveis do plano vigente, sem valores
- **Códigos:** 200, 403, 404, 422

### PCA-56 — POST `/pca-reconciliation-entries/{entryId}/conciliate`
**Permissão:** `PCA_RECONCILE` + POL-22 · **Story:** US-143
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ action: LINK|NO_ITEM, pcaItemId?, justification?, note? }` + `Idempotency-Key`
- **Response:** `200 { data: Entry }` (`MANUAL`/`SKIPPED`)
- **Códigos:** 200, 403, 404, 409, 422, 429, 503

### PCA-57 — POST `/pcas/{pcaId}/reconciliation-pending/conciliate`
**Permissão:** `PCA_RECONCILE` + POL-22 · **Story:** US-143
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ entryIds[1..100], action, pcaItemId?, justification?, note? }` + `Idempotency-Key`
- **Response:** `200 { data: { requested, done, failed, results[{ entryId, status: DONE|FAILED, code? }] } }`
- **Códigos:** 200, 403, 404, 422, 429, 503

### APV-01 — GET `/approvals` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-140:** request `subjectType = PCA` aceito (existente) → response itens com `process` nulo e `pca { id, title, year, versionNumber }` (aditivo, sem valores) · códigos 200, 422

### APV-02 — GET `/approvals/{id}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-140:** request (existente) → response `pca { id, title, year, versionNumber, itemsCount, totalPlannedValue, submittedBy }`; `meta.decisionOptions[]` com as três decisões sem `transitionId`; `decisionBlocker` inclui `PCA_SELF_APPROVAL_FORBIDDEN` · códigos 200, 403, 404
- **US-141:** request — → response detalhe com `subjectType = PCA`, `pcaId` e resumo da revisão (US-140) · códigos 200, 403, 404

### APV-03 — POST `/approvals/{id}/decide` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-140:** request `{ decision, comment? }` + `If-Match` + `Idempotency-Key` (existente; sem `transitionId`) → response `200 { data: Approval }` com `pca { id, status }` · códigos 200, 403, 404, 409, 412, 422
- **US-141:** request decisão (US-140) → response em `APPROVE` de revisão executa a substituição (RN-PCA-212); pode responder `422 PCA_REVISION_LINKED_ITEMS` · códigos 200, 403, 404, 409, 412, 422, 503

### ATT-02 — POST `/attachments` (ampliação do MVP 1)
Contrato original: [mvp-01/api/12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md). Mudanças do MVP 2, todas aditivas:
- **US-139:** request `targetType = PCA`, `targetId = pcaId` (existente) → response `201` com URL de upload · códigos 201, 403, 404, 413, 415, 422

### ATT-03 — POST `/attachments/{id}/confirm` (ampliação do MVP 1)
Contrato original: [mvp-01/api/12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md). Mudanças do MVP 2, todas aditivas:
- **US-139:** request (existente) → response `202` · códigos 202, 403, 404, 409

### ATT-04 — GET `/attachments/{id}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md). Mudanças do MVP 2, todas aditivas:
- **US-139:** request (existente) → response `200` com status · códigos 200, 403, 404

### CAT-01 — GET `/catalogs/{catalogType}/items` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-138:** request `PCA_CATEGORY`, `CONTRACTING_TYPE`, `UNIT_OF_MEASURE` (existente) → response itens ativos · códigos 200

### DEP-02 — GET `/departments/lookup` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-138:** request seletor de secretaria (existente) → response secretarias ativas do órgão · códigos 200

### DFD-02 — POST `/processes/{id}/dfds` (ampliação do MVP 1)
Contrato original: [mvp-01/api/05-dfd.md](../../mvp-01/api/05-dfd.md). Mudanças do MVP 2, todas aditivas:
- **US-142:** request — → response `Dfd` com `pcaItemId`, `pcaLinkStatus`, `pcaItem`; DFD novo herda o vínculo · códigos 200/201, 404

### DFD-03 — GET `/dfds/{id}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/05-dfd.md](../../mvp-01/api/05-dfd.md). Mudanças do MVP 2, todas aditivas:
- **US-142:** request — → response `Dfd` com `pcaItemId`, `pcaLinkStatus`, `pcaItem`; DFD novo herda o vínculo · códigos 200/201, 404

### DFD-04 — PATCH `/dfds/{id}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/05-dfd.md](../../mvp-01/api/05-dfd.md). Mudanças do MVP 2, todas aditivas:
- **US-142:** request MVP 1 + `pcaItemId?`, `pcaItemChangeReason?`, `pcaAcknowledgedWarnings?` + `If-Match` → response `200 { data: Dfd }` + `ETag` · códigos 200, 403, 404, 409, 412, 422, 428

### DOC-08 — GET `/documents/{id}/validation` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-142:** request — → response `violations[]` com `DFD_PCA_LINK_REQUIRED` e `DFD_PCA_ITEM_UNAVAILABLE` · códigos 200, 404

### PRC-02 — POST `/processes` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-142:** request MVP 1 + `pcaItemId?`, `pcaAcknowledgedWarnings?` → response `201 { data: Process }` com `pcaItemId`, `pcaLinkStatus`, `pcaItem` (aditivos) · códigos 201, 403, 409, 422, 429, 503

### PRC-04 — GET `/processes/{id}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-142:** request — → response Acrescentam `pcaItemId`, `pcaLinkStatus`, `pcaItem` (nulo para `CONSULTOR_EXTERNO`) · códigos 200, 404

### PRC-05 — PATCH `/processes/{id}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-142:** request MVP 1 + `pcaItemId?` (uuid ou `null`), `pcaItemChangeReason?`, `pcaAcknowledgedWarnings?` + `If-Match` → response `200 { data: Process }` + `ETag` · códigos 200, 403, 404, 409, 412, 422, 428, 503

### PRC-07 — GET `/processes/{id}/summary` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-142:** request — → response Acrescentam `pcaItemId`, `pcaLinkStatus`, `pcaItem` (nulo para `CONSULTOR_EXTERNO`) · códigos 200, 404

### SET-02 — PATCH `/settings` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-138:** request `pca.elaborationDeadline` (existente; `SETTINGS_MANAGE`) → response `200` · códigos 200, 403, 422
- **US-142:** request `pca.requireLinkForPlanned`, `pca.itemBalanceSeverity` → response `200` · códigos 200, 403, 422

### TSK-01 — GET `/tasks` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-140:** request `view = PENDING_APPROVALS` (existente) → response linhas com `process` nulo e `approval { id, title, subjectType = PCA, … }` · códigos 200, 403

### USR-02 — GET `/users/lookup` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-138:** request seletor de responsável (existente) → response usuários com vínculo ativo · códigos 200
