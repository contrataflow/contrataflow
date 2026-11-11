# 3.16 Indicadores, gargalos e relatórios (`analytics`) — MVP 2

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint) do MVP 2. Convenções, erros genéricos e de domínio: [api.md §1–§2](../api.md#1-convenções) (que herda o [api.md do MVP 1](../../mvp-01/api.md)). Épico(s): EP-028. Fonte de cada linha: a seção "API" da story citada — divergência entre este arquivo e a story é bug de especificação.

Relatórios e indicadores sobre o read model próprio (DEC-206, ADR-014) — nunca consulta direta a `ProcessStage`/`ProcessMovement`: tempo de ciclo, devoluções, prazos, volume e valor, execução do PCA, gargalos por etapa, unidade e responsável, detalhamento por processo e exportação assíncrona (CSV/XLSX/PDF, arquivo de 24 h). Telas: SCR-027 (Relatórios) e SCR-028 (Relatório detalhado).

Legenda: **Idem.** = `Idempotency-Key`; **IM** = `If-Match` (com `ETag` na resposta); "—" = não se aplica. Escritas sem `If-Match` criam recurso novo ou são ações idempotentes por chave. Listas paginam com `page`/`pageSize` (≤ 100) e `sort`, salvo indicação na linha.

## Endpoints novos

| ID | Método | Rota | Permissão | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| ANL-01 | GET | `/analytics/status` | `REPORT_VIEW` ou `SETTINGS_MANAGE` | — | — | US-170 |
| ANL-02 | POST | `/analytics/rebuilds` | `SETTINGS_MANAGE` | Obrigatório | — | US-171 |
| ANL-03 | GET | `/analytics/rebuilds/{id}` | `SETTINGS_MANAGE` | — | — | US-171 |
| ANL-04 | GET | `/analytics/reconciliation-runs` | `SETTINGS_MANAGE` | — | — | US-171 |
| ANL-05 | GET | `/reports` | `REPORT_VIEW` | — | — | US-172 |
| ANL-06 | GET | `/reports/{report}` | `REPORT_VIEW` | — | — | US-172 |
| ANL-07 | GET | `/reports/saved-views` | `REPORT_VIEW` | — | — | US-172 |
| ANL-08 | POST | `/reports/saved-views` | `REPORT_VIEW` | Obrigatório | — | US-172 |
| ANL-09 | GET | `/reports/{report}/processes` | `REPORT_VIEW` | — | — | US-173 |
| ANL-10 | GET | `/reports/detail/{processId}` | `REPORT_VIEW` | — | — | US-173 |
| ANL-11 | POST | `/reports/{report}/exports` | `REPORT_EXPORT` ou `REPORT_VIEW` | Obrigatório | — | US-174 |
| ANL-12 | GET | `/reports/exports/{id}` | `REPORT_EXPORT` ou `REPORT_VIEW` | — | — | US-174 |
| ANL-13 | GET | `/reports/exports/{id}/download` | `REPORT_EXPORT` ou `REPORT_VIEW` | — | — | US-174 |
| ANL-14 | GET | `/reports/pca-execution` | `REPORT_VIEW` ou `OWN_DEPARTMENTS` | — | — | US-175 |
| ANL-15 | GET | `/bottlenecks` | `REPORT_VIEW` | — | — | US-176 |
| ANL-16 | GET | `/bottlenecks/{dimension}/{key}/processes` | `REPORT_VIEW` | — | — | US-176 |
| ANL-17 | GET | `/bottlenecks/queues` | `REPORT_VIEW` | — | — | US-177 |
| ANL-18 | GET | `/bottlenecks/comparison` | `REPORT_VIEW` | — | — | US-177 |
| ANL-19 | GET | `/reports/exports` | `REPORT_EXPORT` ou `REPORT_VIEW` | — | — | US-174 |

## Especificação por endpoint

### ANL-01 — GET `/analytics/status`
**Permissão:** `REPORT_VIEW` ou `SETTINGS_MANAGE` · **Story:** US-170
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** sem parâmetros
- **Response:** `200 { data: { state, dataAsOf, lagSeconds, lastViewRefreshAt, definitionVersion, lastReconciliation?, rebuild? } }` (os dois últimos só com `SETTINGS_MANAGE`)
- **Códigos:** 200, 403, 422, 503

### ANL-02 — POST `/analytics/rebuilds`
**Permissão:** `SETTINGS_MANAGE` · **Story:** US-171
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `Idempotency-Key`; corpo `{ mode, from?, to?, reason }`
- **Response:** `202 { data: Run }` + `Location`
- **Códigos:** 202, 403, 409, 422, 429, 503

### ANL-03 — GET `/analytics/rebuilds/{id}`
**Permissão:** `SETTINGS_MANAGE` · **Story:** US-171
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** path `id`
- **Response:** `200 { data: Run }` (`scope = REBUILD`)
- **Códigos:** 200, 403, 404

### ANL-04 — GET `/analytics/reconciliation-runs`
**Permissão:** `SETTINGS_MANAGE` · **Story:** US-171
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `scope[]`, `status[]`, `startedFrom`, `startedTo`, `cursor`, `limit`
- **Response:** `200 { data: Run[], meta { nextCursor } }`
- **Códigos:** 200, 403, 422

### ANL-05 — GET `/reports`
**Permissão:** `REPORT_VIEW` · **Story:** US-172
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: ReportDefinition[] }` (`key`, `title`, `description`, `groupBys[]`, `granularities[]`, `canExport`)
- **Códigos:** 200, 403

### ANL-06 — GET `/reports/{report}`
**Permissão:** `REPORT_VIEW` · **Story:** US-172
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `granularity`, `fiscalYear` ou `from`/`to`, `secretariatId[]`, `modalityCode[]`, `contractingTypeCode[]`, `groupBy`
- **Response:** `200 { data: { report, granularity, period, groupBy, rows[], totals, groupTotals[] }, meta { dataAsOf, lagSeconds, stale, confidentialExcluded, confidentialStepUpAvailable, scope, groupsTruncated, definitionVersion } }`
- **Códigos:** 200, 403, 404, 409, 422, 503

### ANL-07 — GET `/reports/saved-views`
**Permissão:** `REPORT_VIEW` · **Story:** US-172
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `report?`
- **Response:** `200 { data: SavedView[] }` (próprias e compartilhadas, `scope = REPORT`)
- **Códigos:** 200, 403

### ANL-08 — POST `/reports/saved-views`
**Permissão:** `REPORT_VIEW` · **Story:** US-172
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `Idempotency-Key`; `{ name, filters, isDefault, isShared }`
- **Response:** `201 { data: SavedView }` + `ETag`
- **Códigos:** 201, 403, 409, 422

### ANL-09 — GET `/reports/{report}/processes`
**Permissão:** `REPORT_VIEW` · **Story:** US-173
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** filtros do recorte, `periodKey`, `stageKey`, `metric`, `q`, `sort`, `cursor`, `limit`
- **Response:** `200 { data: ProcessRow[], meta { nextCursor, totalItems, totalItemsCapped, matchedTotal, visibleTotal, hiddenCount, dataAsOf, lagSeconds, stale, confidentialStepUpAvailable } }`
- **Códigos:** 200, 403, 404, 409, 422, 429, 503

### ANL-10 — GET `/reports/detail/{processId}`
**Permissão:** `REPORT_VIEW` · **Story:** US-173
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** path `processId`
- **Response:** `200 { data: { process, milestones, stages[], indicators }, meta { dataAsOf, projectedAt, stale } }`
- **Códigos:** 200, 403, 404, 409, 429, 503

### ANL-11 — POST `/reports/{report}/exports`
**Permissão:** `REPORT_EXPORT` ou `REPORT_VIEW` · **Story:** US-174
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ format, content?, filters }` · `Idempotency-Key`
- **Response:** `202 { data: ReportExport (PENDING) }` · `Location`
- **Códigos:** 202, 403, 404, 409, 422, 429, 503

### ANL-12 — GET `/reports/exports/{id}`
**Permissão:** `REPORT_EXPORT` ou `REPORT_VIEW` · **Story:** US-174
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: ReportExport }` (estado, `scopeLabel`, `confidentialExcluded`, `dataAsOf`, `stale`, `rowsCount`, `fileExpiresAt`, `errorCode`)
- **Códigos:** 200, 403, 404

### ANL-13 — GET `/reports/exports/{id}/download`
**Permissão:** `REPORT_EXPORT` ou `REPORT_VIEW` · **Story:** US-174
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { url, urlExpiresAt } }` (300 s)
- **Códigos:** 200, 403, 404, 409, 410, 503

### ANL-14 — GET `/reports/pca-execution`
**Permissão:** `REPORT_VIEW` ou `OWN_DEPARTMENTS` · **Story:** US-175
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `year`, `organizationId[]`, `groupBy`, `departmentId[]`, `categoryCode[]`, `status[]`, `plannedMonth`, `withoutLink`, `overPlanned`, `sort`, `page`, `pageSize`
- **Response:** `200 { data: { plan { pcaId, versionNumber, approvedAt, year } | null, summary, groups[] | items[] }, meta: { dataAsOf, stale, confidentialExcluded, scope { level, departmentIds? }, page?, totalItems? } }`
- **Códigos:** 200, 403, 404, 422, 429, 503

### ANL-15 — GET `/bottlenecks`
**Permissão:** `REPORT_VIEW` · **Story:** US-176
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `groupBy`, `from`, `to`, `organizationId[]`, `secretariatId[]`, `modalityCode[]`, `contractingTypeCode[]`, `stageKey[]`, `departmentId[]`, `sort`, `page`, `pageSize`
- **Response:** `200 { data: { groupBy, totals, groups[ { key, label, passagesCount, avgBusinessDays, medianBusinessDays, p90BusinessDays, onTimePercent, withDeadlineCount, returnsCount, returnRatePercent, smallSample } ] }, meta: { dataAsOf, stale, period, scope, excludedPassagesCount, confidentialExcluded: false, page?, totalItems? } }`
- **Códigos:** 200, 403, 422, 429, 503

### ANL-16 — GET `/bottlenecks/{dimension}/{key}/processes`
**Permissão:** `REPORT_VIEW` · **Story:** US-176
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `dimension` ∈ `stage`/`department`/`assignee`; `state` (`CLOSED`/`OPEN`), `from`, `to`, mesmos filtros, `agingBand` (só `OPEN`), `sort`, `page`, `pageSize` (≤ 100)
- **Response:** `200 { data: [ { passageId, processId, code, title, stageKey, stageLabel, departmentLabel, assigneeLabel, enteredAt, exitedAt?, businessDays, calendarDays, exitStatus?, wasOverdue, overdueBusinessDays?, returnedFrom, ageBusinessDays?, isPaused?, estimatedValue?, estimatedValueMasked } ], meta: { dataAsOf, stale, scope, processVisibility, page, totalItems } }`
- **Códigos:** 200, 403, 404, 422, 429, 503

### ANL-17 — GET `/bottlenecks/queues`
**Permissão:** `REPORT_VIEW` · **Story:** US-177
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `groupBy`, `organizationId[]`, `secretariatId[]`, `modalityCode[]`, `contractingTypeCode[]`, `stageKey[]`, `departmentId[]`, `sort`, `page`, `pageSize`
- **Response:** `200 { data: { groupBy, bands[ { key, label, minDays, maxDays } ], totals { openCount, distinctProcessesCount, avgAgeBusinessDays, medianAgeBusinessDays, oldestAgeBusinessDays, overdueCount, pausedCount, aging[] }, groups[ { key, label, openCount, distinctProcessesCount, avgAgeBusinessDays, medianAgeBusinessDays, oldestAgeBusinessDays, overdueCount, pausedCount, aging[ { band, count, percent } ], smallSample } ] }, meta: { asOf, dataAsOf, stale, scope, confidentialExcluded: false, page?, totalItems? } }`
- **Códigos:** 200, 403, 422, 429, 503

### ANL-18 — GET `/bottlenecks/comparison`
**Permissão:** `REPORT_VIEW` · **Story:** US-177
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `groupBy`, `preset`+`reference` **ou** `currentFrom`, `currentTo`, `previousFrom`, `previousTo`; mesmos filtros; `sort`, `page`, `pageSize`
- **Response:** `200 { data: { groupBy, current { from, to }, previous { from, to }, totals { current, previous, delta }, groups[ { key, label, presence, comparable, lowConfidence, current { passagesCount, avgBusinessDays, medianBusinessDays, p90BusinessDays, onTimePercent, returnsCount, returnRatePercent, smallSample }, previous { … }, delta { avgBusinessDays { absolute, percent }, medianBusinessDays { … }, p90BusinessDays { … }, onTimePp, returnRatePp } } ] }, meta: { dataAsOf, stale, durationMonths, currentPeriodIncomplete, scope, confidentialExcluded: false } }`
- **Códigos:** 200, 403, 422, 429, 503

### ANL-19 — GET `/reports/exports`
**Permissão:** `REPORT_EXPORT` ou `REPORT_VIEW` · **Story:** US-174
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** paginação (≤ 50)
- **Response:** `200 { data: ReportExport[], meta }` mais recentes primeiro, só do solicitante
- **Códigos:** 200, 403
