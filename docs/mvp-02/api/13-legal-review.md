# 3.13 Análise jurídica (`legal-review`) — MVP 2

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint) do MVP 2. Convenções, erros genéricos e de domínio: [api.md §1–§2](../api.md#1-convenções) (que herda o [api.md do MVP 1](../../mvp-01/api.md)). Épico(s): EP-025. Fonte de cada linha: a seção "API" da story citada — divergência entre este arquivo e a story é bug de especificação.

Análise jurídica (`LegalReview`, diligências e parecer): fila priorizada por critérios objetivos, atribuição, as seis situações (aguardando, em análise, diligência, favorável, favorável com ressalvas, desfavorável), diligência com prazo e pausa de SLA, parecer como `Document` (`PARECER_JURIDICO`) vinculado às versões analisadas, dispensa de análise (art. 53, § 5º) e rascunho do parecer por IA (`draft.legal_opinion`, sobre a camada do EP-020). Tela: SCR-019.

Legenda: **Idem.** = `Idempotency-Key`; **IM** = `If-Match` (com `ETag` na resposta); "—" = não se aplica. Escritas sem `If-Match` criam recurso novo ou são ações idempotentes por chave. Listas paginam com `page`/`pageSize` (≤ 100) e `sort`, salvo indicação na linha.

## Endpoints novos

| ID | Método | Rota | Permissão | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| LGL-01 | GET | `/legal-reviews` | `LEGAL_REVIEW_VIEW` | — | — | US-149 |
| LGL-02 | GET | `/legal-reviews/{id}` | `LEGAL_REVIEW_VIEW` | — | — | US-149, US-150, US-152, US-153, US-154, US-155, US-156, US-157 |
| LGL-03 | POST | `/legal-reviews/{id}/assign` | `PROCESS_ASSIGN` + POL-05 | Obrigatório | Obrigatório | US-150 |
| LGL-04 | POST | `/legal-reviews/bulk-assign` | `PROCESS_ASSIGN` + POL-05 | Obrigatório | — | US-150 |
| LGL-05 | GET | `/legal-review-settings` | `ADMIN_ORGAO` | — | — | US-151 |
| LGL-06 | PUT | `/legal-review-settings/queue-criteria` | `LEGAL_REVIEW_CONFIGURE` | — | Obrigatório | US-151 |
| LGL-07 | POST | `/legal-review-settings/waiver-hypotheses` | `LEGAL_REVIEW_CONFIGURE` | Obrigatório | — | US-151 |
| LGL-08 | PATCH | `/legal-review-settings/waiver-hypotheses/{id}` | `LEGAL_REVIEW_CONFIGURE` | — | Obrigatório | US-151 |
| LGL-09 | GET | `/legal-reviews/summary` | `LEGAL_REVIEW_VIEW` | — | — | US-149, US-150 |
| LGL-10 | POST | `/legal-reviews/{id}/start` | `LEGAL_REVIEW_MANAGE` + POL-19 | Obrigatório | Obrigatório | US-152 |
| LGL-11 | GET | `/legal-reviews/{id}/documents` | `LEGAL_REVIEW_VIEW` | — | — | US-152, US-153 |
| LGL-12 | GET | `/legal-reviews/{id}/documents/compare` | `LEGAL_REVIEW_VIEW` | — | — | US-152, US-153 |
| LGL-13 | POST | `/legal-reviews/{id}/diligences` | `LEGAL_REVIEW_MANAGE` + POL-01 | Obrigatório | Obrigatório | US-153 |
| LGL-14 | POST | `/legal-review-diligences/{diligenceId}/answer` | `LEGAL_REVIEW_MANAGE` + POL-01 | Obrigatório | Obrigatório | US-153 |
| LGL-15 | GET | `/legal-reviews/{id}/diligences` | `PROCESS_VIEW` | — | — | US-153 |
| LGL-16 | GET | `/legal-reviews/{id}/reservations` | `LEGAL_REVIEW_VIEW` | — | — | US-154, US-155 |
| LGL-17 | POST | `/legal-reviews/{id}/reservations` | `LEGAL_REVIEW_MANAGE` + POL-01 | Obrigatório | Obrigatório | US-154 |
| LGL-18 | PATCH | `/legal-review-reservations/{reservationId}` | `LEGAL_REVIEW_MANAGE` + POL-01 | — | Obrigatório | US-154 |
| LGL-19 | POST | `/legal-reviews/{id}/conclude` | `LEGAL_REVIEW_CONCLUDE` + POL-19 | Obrigatório | Obrigatório | US-155 |
| LGL-20 | POST | `/legal-reviews/{id}/opinion` | `LEGAL_REVIEW_MANAGE` + POL-01 | Obrigatório | Obrigatório | US-154 |
| LGL-21 | POST | `/legal-reviews/{id}/waive` | `LEGAL_REVIEW_WAIVE` + POL-26 | Obrigatório | Obrigatório | US-156 |
| LGL-24 | GET | `/processes/{id}/legal-review` | `LEGAL_REVIEW_VIEW` | — | — | US-155 |

## Rotas do MVP 1 ampliadas

Mudanças **aditivas** (campos opcionais, enums ampliados, filtros novos) sobre contratos do MVP 1; o comportamento do MVP 1 vale sem os campos novos. O contrato original está no arquivo indicado da pasta `mvp-01/api/`.

| ID | Método | Rota (MVP 1) | Permissão (MVP 1) | Contrato original | Ampliado por |
|---|---|---|---|---|---|
| AI-01 | POST | `/processes/{id}/ai-generations` | `AI_GENERATE` + POL-18 | [16-ai.md](../../mvp-01/api/16-ai.md) | US-157 |
| AI-02 | GET | `/ai-generations/{generationId}` | `PROCESS_VIEW` | [16-ai.md](../../mvp-01/api/16-ai.md) | US-157 |
| AI-04 | POST | `/ai-generations/{generationId}/discard` | solicitante (RN-AI-13) | [16-ai.md](../../mvp-01/api/16-ai.md) | US-157 |
| AI-05 | GET | `/ai/availability` | impl. | [16-ai.md](../../mvp-01/api/16-ai.md) | US-157 |
| AI-06 | GET | `/ai/usage` | `SETTINGS_MANAGE` | [16-ai.md](../../mvp-01/api/16-ai.md) | US-157 |
| CAT-01 | GET | `/catalogs/{catalogType}/items` | implícita | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-151 |
| DOC-05 | PUT | `/documents/{id}/sections/{sectionKey}` | permissão de edição do tipo + POL-02 (IM de seção) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-154 |
| DOC-08 | GET | `/documents/{id}/validation` | `PROCESS_VIEW` | [03-documents.md](../../mvp-01/api/03-documents.md) | US-154 |
| DOC-10 | POST | `/documents/{id}/finalize` | permissão de submissão do tipo + POL-02 (IM, Idem.) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-154, US-155 |
| DOC-12 | POST | `/documents/{id}/reopen` | `DOCUMENT_REOPEN` + POL-11 (IM) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-154 |
| DOC-17 | GET | `/document-versions/{versionId}` | `PROCESS_VIEW` (+POL-09) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-152 |
| DOC-18 | GET | `/documents/{id}/versions/compare?from=&to=` | `PROCESS_VIEW` (+POL-09) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-152 |
| DOC-26 | POST | `/documents/{id}/ai-apply` | permissão de edição do tipo + POL-02 (solicitante da geração) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-157 |
| DOC-27 | POST | `/documents/{id}/ai-review` | permissão de edição do tipo + POL-02 | [03-documents.md](../../mvp-01/api/03-documents.md) | US-157 |
| PRC-20 | POST | `/processes/{id}/return` | `PROCESS_RETURN` + POL-01 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-153 |
| PRC-22 | POST | `/processes/{id}/assign` | `PROCESS_ASSIGN` ou titular/substituto + POL-05 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-150 |

## Especificação por endpoint

### LGL-01 — GET `/legal-reviews`
**Permissão:** `LEGAL_REVIEW_VIEW` · **Story:** US-149
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `status[]?`, `assignee?`, `dueFrom?`, `dueTo?`, `valueBand[]?`, `priority[]?`, `secretariatId?`, `q?`, `sort?`, `cursor?`, `limit?`
- **Response:** `200 { data: [ { id, processId, processCode, processObject, secretariat, status, sequence, assignee?, enteredQueueAt, stageDueAt?, valueBand?, masked, priority, queuePriorityScore, priorityFactors (resumo), version } ], meta: { nextCursor, hasMore } }`
- **Códigos:** 200, 401, 403, 422, 429, 503

### LGL-02 — GET `/legal-reviews/{id}`
**Permissão:** `LEGAL_REVIEW_VIEW` · **Story:** US-149 (também citado por US-150, US-152, US-153, US-154, US-155, US-156, US-157)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: LegalReview + process + priorityFactors completos + currentRound }` + `ETag`
- **Códigos:** 200, 401, 403, 404, 429, 503
- **Uso/ampliação em US-150:** request — (US-149) → response painel; ganha `canAssign` · códigos 200, 401, 403, 404
- **Uso/ampliação em US-152:** request — (US-149) → response painel + fatores; ganha `canStart` e `currentRound` · códigos 200, 401, 403, 404
- **Uso/ampliação em US-153:** request — (US-149) → response painel; ganha `canRequestDiligence`, `diligenceTargets[]` · códigos 200, 401, 403, 404
- **Uso/ampliação em US-154:** request — (US-149) → response painel; ganha `opinion`, `reservationsCount`, `openCount` · códigos 200, 401, 403, 404
- **Uso/ampliação em US-155:** request path `id` → response painel com `conclusionChecklist` e situação final · códigos 200, 403, 404
- **Uso/ampliação em US-156:** request — (US-149) → response painel; ganha `canWaive`, `waiverOptions[]` (`id`, `code`, `name`, `legalBasis`, `actReference`, `applicable`, `reasonCode?`) e, em `WAIVED`, `waiver` (hipótese, justificativa, `waivedById`, `waivedAt`) · códigos 200, 401, 403, 404
- **Uso/ampliação em US-157:** request — (US-149) → response painel; ganha `aiReviewPendingSections[]` e `aiPlaceholdersPending` · códigos 200, 401, 403, 404

### LGL-03 — POST `/legal-reviews/{id}/assign`
**Permissão:** `PROCESS_ASSIGN` + POL-05 · **Story:** US-150
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ assigneeId: uuid | null, reason? }` + `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: LegalReview }` + `ETag`
- **Códigos:** 200, 401, 403, 404, 409, 412, 422, 428, 429, 503

### LGL-04 — POST `/legal-reviews/bulk-assign`
**Permissão:** `PROCESS_ASSIGN` + POL-05 · **Story:** US-150
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ assigneeId, reason?, items: [ { legalReviewId, version } ] }` + `Idempotency-Key`
- **Response:** `200 { data: [ { legalReviewId, ok, code?, message?, review? } ], meta: { successCount, errorCount } }`
- **Códigos:** 200, 401, 403, 422, 429, 503

### LGL-05 — GET `/legal-review-settings`
**Permissão:** `ADMIN_ORGAO` · **Story:** US-151
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { queueCriteria: { value, default, version, isDefault }, rescoring, waiverHypotheses: [ { id, code, label, description?, isActive, isSystem, version, metadata, usageCount, canActivate, missing[] } ] } }`
- **Códigos:** 200, 401, 403, 429, 503

### LGL-06 — PUT `/legal-review-settings/queue-criteria`
**Permissão:** `LEGAL_REVIEW_CONFIGURE` · **Story:** US-151
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ criteria: [ { factor, weight, direction } ] }` + `If-Match`; `?dryRun=true`
- **Response:** `200 { data: { criteria, version, rescoring }, meta: { preview? } }`
- **Códigos:** 200, 401, 403, 412, 422, 428, 429, 503

### LGL-07 — POST `/legal-review-settings/waiver-hypotheses`
**Permissão:** `LEGAL_REVIEW_CONFIGURE` · **Story:** US-151
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ code, label, description?, legalBasis, actReference, condition?, maxEstimatedValue? }` + `Idempotency-Key`
- **Response:** `201 { data: WaiverHypothesis }` + `ETag` (sempre `isActive = false`)
- **Códigos:** 201, 401, 403, 422, 429, 503

### LGL-08 — PATCH `/legal-review-settings/waiver-hypotheses/{id}`
**Permissão:** `LEGAL_REVIEW_CONFIGURE` · **Story:** US-151
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ label?, description?, legalBasis?, actReference?, condition?, maxEstimatedValue?, isActive? }` + `If-Match`
- **Response:** `200 { data: WaiverHypothesis }` + `ETag`
- **Códigos:** 200, 401, 403, 404, 409, 412, 422, 428, 429, 503

### LGL-09 — GET `/legal-reviews/summary`
**Permissão:** `LEGAL_REVIEW_VIEW` · **Story:** US-149 (também citado por US-150)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { counts, unassigned, overdue, mine, byAssignee[] } }`
- **Códigos:** 200, 401, 403, 429, 503
- **Uso/ampliação em US-150:** request — (US-149) → response carga por procurador (`byAssignee`) · códigos 200, 401, 403

### LGL-10 — POST `/legal-reviews/{id}/start`
**Permissão:** `LEGAL_REVIEW_MANAGE` + POL-19 · **Story:** US-152
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** corpo vazio + `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: LegalReview, meta: { round, documents[] } }` + `ETag`
- **Códigos:** 200, 401, 403, 404, 409, 412, 422, 428, 429, 503

### LGL-11 — GET `/legal-reviews/{id}/documents`
**Permissão:** `LEGAL_REVIEW_VIEW` · **Story:** US-152 (também citado por US-153)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `round?`
- **Response:** `200 { data: [ { round, documentId, documentTypeCode, title, documentVersionId, versionNumber, authorId, versionCreatedAt, isCurrent, newerVersionNumber? } ] }`
- **Códigos:** 200, 401, 403, 404, 429, 503
- **Uso/ampliação em US-153:** request `round?` (US-152) → response versões por rodada, inclusive a rodada nova · códigos 200, 401, 403, 404

### LGL-12 — GET `/legal-reviews/{id}/documents/compare`
**Permissão:** `LEGAL_REVIEW_VIEW` · **Story:** US-152 (também citado por US-153)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `fromRound`, `toRound`
- **Response:** `200 { data: [ { documentId, documentTypeCode, change, fromVersionId?, toVersionId?, fromVersionNumber?, toVersionNumber? } ] }`
- **Códigos:** 200, 401, 403, 404, 422, 429, 503
- **Uso/ampliação em US-153:** request `fromRound`, `toRound` (US-152) → response mudança por documento · códigos 200, 401, 403, 404, 422

### LGL-13 — POST `/legal-reviews/{id}/diligences`
**Permissão:** `LEGAL_REVIEW_MANAGE` + POL-01 · **Story:** US-153
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ request, returnStageKey, dueAt? }` + `If-Match` + `Idempotency-Key`
- **Response:** `201 { data: LegalReviewDiligence, meta: { review: LegalReview, movementId } }` + `ETag`
- **Códigos:** 201, 401, 403, 404, 409, 412, 422, 428, 429, 503

### LGL-14 — POST `/legal-review-diligences/{diligenceId}/answer`
**Permissão:** `LEGAL_REVIEW_MANAGE` + POL-01 · **Story:** US-153
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ answerSummary }` + `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: LegalReviewDiligence }` + `ETag`
- **Códigos:** 200, 401, 403, 404, 409, 412, 422, 428, 429, 503

### LGL-15 — GET `/legal-reviews/{id}/diligences`
**Permissão:** `PROCESS_VIEW` · **Story:** US-153
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: [ { id, round, request, returnStageKey, returnStageName, requestedAt, requestedById, dueAt, answeredAt?, answerSummary?, status } ] }`
- **Códigos:** 200, 401, 403, 404, 429, 503

### LGL-16 — GET `/legal-reviews/{id}/reservations`
**Permissão:** `LEGAL_REVIEW_VIEW` · **Story:** US-154 (também citado por US-155)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `status?`
- **Response:** `200 { data: [ { id, sequence, description, documentTypeCode?, status, response?, respondedById?, respondedAt?, version } ], meta: { reservationsCount, openCount } }`
- **Códigos:** 200, 401, 403, 404, 429, 503
- **Uso/ampliação em US-155:** request — → response ressalvas e situações (lista exibida no diálogo) · códigos 200, 403, 404

### LGL-17 — POST `/legal-reviews/{id}/reservations`
**Permissão:** `LEGAL_REVIEW_MANAGE` + POL-01 · **Story:** US-154
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ description, documentTypeCode? }` + `If-Match` + `Idempotency-Key`
- **Response:** `201 { data: LegalReviewReservation }` + `ETag`
- **Códigos:** 201, 401, 403, 404, 409, 412, 422, 428, 429, 503

### LGL-18 — PATCH `/legal-review-reservations/{reservationId}`
**Permissão:** `LEGAL_REVIEW_MANAGE` + POL-01 · **Story:** US-154
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ description?, documentTypeCode? }` **ou** `{ status, response }` + `If-Match`
- **Response:** `200 { data: LegalReviewReservation }` + `ETag`
- **Códigos:** 200, 401, 403, 404, 409, 412, 422, 428, 429, 503

### LGL-19 — POST `/legal-reviews/{id}/conclude`
**Permissão:** `LEGAL_REVIEW_CONCLUDE` + POL-19 · **Story:** US-155
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ status, conclusionSummary }` + `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: LegalReview }` (concluída, com `documents[]`) + `ETag`
- **Códigos:** 200, 401, 403, 404, 409, 412, 422, 428, 503

### LGL-20 — POST `/legal-reviews/{id}/opinion`
**Permissão:** `LEGAL_REVIEW_MANAGE` + POL-01 · **Story:** US-154
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ title? }` + `If-Match` + `Idempotency-Key`
- **Response:** `201`/`200 { data: Document, meta: { review: LegalReview } }` + `ETag`
- **Códigos:** 200, 201, 401, 403, 404, 409, 412, 422, 428, 429, 503

### LGL-21 — POST `/legal-reviews/{id}/waive`
**Permissão:** `LEGAL_REVIEW_WAIVE` + POL-26 · **Story:** US-156
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ hypothesisId, justification }` + `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: LegalReview }` + `ETag`
- **Códigos:** 200, 401, 403, 404, 409, 412, 422, 428, 429, 503

### LGL-24 — GET `/processes/{id}/legal-review`
**Permissão:** `LEGAL_REVIEW_VIEW` · **Story:** US-155
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** path `id`
- **Response:** análise vigente (para SCR-006 e SCR-015)
- **Códigos:** 200, 403, 404

### AI-01 — POST `/processes/{id}/ai-generations` (ampliação do MVP 1)
Contrato original: [mvp-01/api/16-ai.md](../../mvp-01/api/16-ai.md). Mudanças do MVP 2, todas aditivas:
- **US-157:** request `{ targetModule: 'LEGAL_OPINION', documentId, kind: 'DRAFT', instruction? }` + `Idempotency-Key` → response `202 { data: AiGeneration, meta: { pollAfterMs } }` + `Location` · códigos 202, 401, 403, 404, 409, 422, 429, 503

### AI-02 — GET `/ai-generations/{generationId}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/16-ai.md](../../mvp-01/api/16-ai.md). Mudanças do MVP 2, todas aditivas:
- **US-157:** request — → response `200 { data: AiGeneration }` (com `output`, `warnings`, `inputRefs` só para quem tem `LEGAL_REVIEW_MANAGE`/`AUDIT_VIEW`; `INPUTS_OUTDATED` derivado) · códigos 200, 403, 404

### AI-04 — POST `/ai-generations/{generationId}/discard` (ampliação do MVP 1)
Contrato original: [mvp-01/api/16-ai.md](../../mvp-01/api/16-ai.md). Mudanças do MVP 2, todas aditivas:
- **US-157:** request — → response `200` · códigos 200, 403, 404, 409

### AI-05 — GET `/ai/availability` (ampliação do MVP 1)
Contrato original: [mvp-01/api/16-ai.md](../../mvp-01/api/16-ai.md). Mudanças do MVP 2, todas aditivas:
- **US-157:** request — → response `200 { enabled, canGenerate, reasons[] }` (RN-LGL-124) · códigos 200, 401

### AI-06 — GET `/ai/usage` (ampliação do MVP 1)
Contrato original: [mvp-01/api/16-ai.md](../../mvp-01/api/16-ai.md). Mudanças do MVP 2, todas aditivas:
- **US-157:** request `SETTINGS_MANAGE` → response consumo por gerador, documento e usuário, com `draft.legal_opinion` · códigos 200, 403

### CAT-01 — GET `/catalogs/{catalogType}/items` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-151:** request `isActive?` (MVP 1) → response leitura das hipóteses para a dispensa (US-156) · códigos 200

### DOC-05 — PUT `/documents/{id}/sections/{sectionKey}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-154:** request MVP 1 → response seção salva (POL-02 + POL-19 + POL-24 para o parecer) · códigos 200, 403, 404, 409, 412

### DOC-08 — GET `/documents/{id}/validation` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-154:** request MVP 1 → response `violations[]` com as regras do `LegalOpinionDocumentValidator` · códigos 200, 403, 404

### DOC-10 — POST `/documents/{id}/finalize` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-154:** request MVP 1 + `acknowledgedWarnings` → response `200`; `DocumentFinalized` com `typedSummary` · códigos 200, 403, 404, 409, 412, 422
- **US-155:** request MVP 1 → response finaliza o parecer (pré-condição) · códigos 200, 403, 404, 409, 412, 422

### DOC-12 — POST `/documents/{id}/reopen` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-154:** request MVP 1 (`reopenReason`) → response parecer volta a `DRAFT` (só com a análise `IN_REVIEW`) · códigos 200, 403, 404, 409, 412, 422

### DOC-17 — GET `/document-versions/{versionId}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-152:** request MVP 1 → response conteúdo da versão (POL-09) · códigos 200, 403, 404

### DOC-18 — GET `/documents/{id}/versions/compare?from=&to=` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-152:** request `from`, `to` (MVP 1) → response diff por seção e coleção · códigos 200, 403, 404, 422

### DOC-26 — POST `/documents/{id}/ai-apply` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-157:** request `{ generationId, sectionKeys, confirmReplaceFilled? }` + `If-Match` + `Idempotency-Key` → response `200 { data: { document, appliedSectionKeys, versionCreated } }` · códigos 200, 403, 404, 409, 412, 422, 428, 503

### DOC-27 — POST `/documents/{id}/ai-review` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-157:** request `{ sectionKeys, expectedRevisions, confirmAll? }` → response `200 { data: { document, reviewedSectionKeys } }` · códigos 200, 403, 404, 409, 412, 422, 503

### PRC-20 — POST `/processes/{id}/return` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-153:** request MVP 1 (regras reutilizadas internamente por LGL-13) → response `200 { data: Process }` · códigos 200, 403, 404, 409, 412, 422, 428

### PRC-22 — POST `/processes/{id}/assign` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-150:** request MVP 1 → response reaproveitado internamente (modo composto) · códigos 200, 403, 404, 409, 412, 422
