# 3.14 Controle Interno (`internal-control`) — MVP 2

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint) do MVP 2. Convenções, erros genéricos e de domínio: [api.md §1–§2](../api.md#1-convenções) (que herda o [api.md do MVP 1](../../mvp-01/api.md)). Épico(s): EP-026. Fonte de cada linha: a seção "API" da story citada — divergência entre este arquivo e a story é bug de especificação.

Manifestação do Controle Interno (`InternalControlReview`): checklists configuráveis e versionados, preenchimento, achados e recomendações com acompanhamento do atendimento, visão de riscos do processo e conclusão da manifestação. Tela: SCR-020.

Legenda: **Idem.** = `Idempotency-Key`; **IM** = `If-Match` (com `ETag` na resposta); "—" = não se aplica. Escritas sem `If-Match` criam recurso novo ou são ações idempotentes por chave. Listas paginam com `page`/`pageSize` (≤ 100) e `sort`, salvo indicação na linha.

## Endpoints novos

| ID | Método | Rota | Permissão | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| ICT-01 | GET | `/internal-control/checklists` | `INTERNAL_CONTROL_CHECKLIST_MANAGE` | — | — | US-158 |
| ICT-02 | POST | `/internal-control/checklists` | `INTERNAL_CONTROL_CHECKLIST_MANAGE` | Obrigatório | — | US-158 |
| ICT-03 | GET | `/internal-control/checklists/{id}` | `INTERNAL_CONTROL_CHECKLIST_MANAGE` | — | — | US-158 |
| ICT-04 | PATCH | `/internal-control/checklists/{id}` | `INTERNAL_CONTROL_CHECKLIST_MANAGE` | — | Obrigatório | US-158 |
| ICT-05 | POST | `/internal-control/checklists/{id}/publish` | `INTERNAL_CONTROL_CHECKLIST_MANAGE` | Obrigatório | Obrigatório | US-158 |
| ICT-06 | POST | `/internal-control/checklists/{id}/retire` | `INTERNAL_CONTROL_CHECKLIST_MANAGE` | — | Obrigatório | US-158 |
| ICT-07 | POST | `/internal-control/checklists/{id}/preview` | `INTERNAL_CONTROL_CHECKLIST_MANAGE` | — | — | US-158 |
| ICT-08 | GET | `/internal-control/reviews` | `INTERNAL_CONTROL_REVIEW_VIEW` | — | — | US-159 |
| ICT-09 | GET | `/internal-control/reviews/{id}` | `INTERNAL_CONTROL_REVIEW_VIEW` | — | — | US-159, US-160, US-161, US-162 |
| ICT-10 | POST | `/internal-control/reviews/{id}/start` | `INTERNAL_CONTROL_REVIEW_MANAGE` | Obrigatório | Obrigatório | US-159 |
| ICT-11 | GET | `/processes/{id}/internal-control` | `PROCESS_VIEW` | — | — | US-159, US-162 |
| ICT-12 | PUT | `/internal-control/reviews/{id}/answers/{itemKey}` | `INTERNAL_CONTROL_REVIEW_MANAGE` | Obrigatório | Obrigatório | US-160 |
| ICT-13 | POST | `/internal-control/reviews/{id}/findings` | `INTERNAL_CONTROL_REVIEW_MANAGE` | Obrigatório | — | US-160 |
| ICT-14 | PATCH | `/internal-control/reviews/{id}/findings/{findingId}` | `INTERNAL_CONTROL_REVIEW_MANAGE` | Obrigatório | Obrigatório | US-160 |
| ICT-15 | GET | `/internal-control/reviews/{id}/findings` | `INTERNAL_CONTROL_REVIEW_VIEW` | — | — | US-160 |
| ICT-16 | POST | `/internal-control/reviews/{id}/manifestation` | `INTERNAL_CONTROL_REVIEW_MANAGE` | Obrigatório | — | US-161 |
| ICT-17 | POST | `/internal-control/reviews/{id}/conclude` | `INTERNAL_CONTROL_REVIEW_CONCLUDE` | Obrigatório | Obrigatório | US-161 |
| ICT-18 | POST | `/internal-control/reviews/{id}/findings/{findingId}/respond` | `PROCESS_VIEW` | Obrigatório | Obrigatório | US-162 |
| ICT-19 | GET | `/internal-control/findings` | `INTERNAL_CONTROL_REVIEW_VIEW` ou `PROCESS_VIEW` | — | — | US-162 |

## Rotas do MVP 1 ampliadas

Mudanças **aditivas** (campos opcionais, enums ampliados, filtros novos) sobre contratos do MVP 1; o comportamento do MVP 1 vale sem os campos novos. O contrato original está no arquivo indicado da pasta `mvp-01/api/`.

| ID | Método | Rota (MVP 1) | Permissão (MVP 1) | Contrato original | Ampliado por |
|---|---|---|---|---|---|
| ATT-02 | POST | `/attachments` | `ATTACHMENT_UPLOAD` + alvo editável | [12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md) | US-160 |
| ATT-03 | POST | `/attachments/{id}/confirm` | uploader | [12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md) | US-160 |
| DOC-05 | PUT | `/documents/{id}/sections/{sectionKey}` | permissão de edição do tipo + POL-02 (IM de seção) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-161 |
| DOC-10 | POST | `/documents/{id}/finalize` | permissão de submissão do tipo + POL-02 (IM, Idem.) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-161 |
| DOC-17 | GET | `/document-versions/{versionId}` | `PROCESS_VIEW` (+POL-09) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-159, US-160 |
| DOC-21 | POST | `/document-versions/{versionId}/renditions` | `PROCESS_VIEW` (+POL-09) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-161 |
| RSK-09 | GET | `/processes/{id}/risk-matrix` | `PROCESS_VIEW` | [08-risks.md](../../mvp-01/api/08-risks.md) | US-159 |

## Especificação por endpoint

### ICT-01 — GET `/internal-control/checklists`
**Permissão:** `INTERNAL_CONTROL_CHECKLIST_MANAGE` · **Story:** US-158
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `status?`, `key?`, `q?`, paginação padrão
- **Response:** `200 { data: [ { id, key, versionNumber, name, status, isDefault, itemsCount, requiredItemsCount, hasApplicabilityRule, openReviewsCount, publishedAt, retiredAt, etag } ], meta: { defaultChecklistKey } }`
- **Códigos:** 200, 401, 403, 429, 503

### ICT-02 — POST `/internal-control/checklists`
**Permissão:** `INTERNAL_CONTROL_CHECKLIST_MANAGE` · **Story:** US-158
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ key, name, items?, applicabilityRule?, isDefault? }` ou `{ fromChecklistId, key?, name? }` + `Idempotency-Key`
- **Response:** `201 { data: Checklist }` + `ETag` e `Location`
- **Códigos:** 201, 401, 403, 404, 409, 422, 429, 503

### ICT-03 — GET `/internal-control/checklists/{id}`
**Permissão:** `INTERNAL_CONTROL_CHECKLIST_MANAGE` · **Story:** US-158
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: Checklist, meta: { etag, openReviewsCount } }`
- **Códigos:** 200, 401, 403, 404

### ICT-04 — PATCH `/internal-control/checklists/{id}`
**Permissão:** `INTERNAL_CONTROL_CHECKLIST_MANAGE` · **Story:** US-158
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ name?, items?, applicabilityRule?, isDefault? }` + `If-Match`
- **Response:** `200 { data: Checklist }` + novo `ETag`
- **Códigos:** 200, 401, 403, 404, 409, 412, 422, 428, 503

### ICT-05 — POST `/internal-control/checklists/{id}/publish`
**Permissão:** `INTERNAL_CONTROL_CHECKLIST_MANAGE` · **Story:** US-158
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ confirmReplaceDefault? }` + `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: Checklist, meta: { retiredVersionNumber?, defaultKeyChanged } }`
- **Códigos:** 200, 401, 403, 404, 409, 412, 422, 428, 429, 503

### ICT-06 — POST `/internal-control/checklists/{id}/retire`
**Permissão:** `INTERNAL_CONTROL_CHECKLIST_MANAGE` · **Story:** US-158
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** corpo vazio + `If-Match`
- **Response:** `200 { data: Checklist, meta: { openReviewsCount } }`
- **Códigos:** 200, 401, 403, 404, 409, 412, 428, 503

### ICT-07 — POST `/internal-control/checklists/{id}/preview`
**Permissão:** `INTERNAL_CONTROL_CHECKLIST_MANAGE` · **Story:** US-158
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `{ processId? }`
- **Response:** `200 { data: { applicable, items: [ { key, group, question, legalBasis, required, evidenceHint, suggestion, reason } ] } }`
- **Códigos:** 200, 401, 403, 404, 429, 503

### ICT-08 — GET `/internal-control/reviews`
**Permissão:** `INTERNAL_CONTROL_REVIEW_VIEW` · **Story:** US-159
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** filtros `status[]`, `assigneeId`, `assignee=me`, `unassigned`, `inStage`, `q`, `cursor`, `limit`
- **Response:** `200 { data: ReviewListItem[], meta { nextCursor, counts } }`
- **Códigos:** 200, 403, 422

### ICT-09 — GET `/internal-control/reviews/{id}`
**Permissão:** `INTERNAL_CONTROL_REVIEW_VIEW` · **Story:** US-159 (também citado por US-160, US-161, US-162)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** path `id`
- **Response:** `200 { data: { review, checklist, items[], findings[], riskView, documents[] }, meta { etag, progress, actions } }`
- **Códigos:** 200, 403, 404
- **Uso/ampliação em US-160:** request path `id` → response estendido com `items[].etag`, `suggestedAnswer`, `findingRequired`, `evidenceOutdated` e `findings[].etag` · códigos 200, 403, 404
- **Uso/ampliação em US-161:** request path `id` → response painel + `meta.conclusionChecklist[]`, `meta.etag` · códigos 200, 403, 404
- **Uso/ampliação em US-162:** request path `id` → response achados com situação, resposta e autor · códigos 200, 403, 404

### ICT-10 — POST `/internal-control/reviews/{id}/start`
**Permissão:** `INTERNAL_CONTROL_REVIEW_MANAGE` · **Story:** US-159
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: InternalControlReview }`
- **Códigos:** 200, 403, 404, 409, 412, 422, 428, 503

### ICT-11 — GET `/processes/{id}/internal-control`
**Permissão:** `PROCESS_VIEW` · **Story:** US-159 (também citado por US-162)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** path `id`
- **Response:** `200 { data: { current, history[] } }` (detalhe conforme RN-ICT-65)
- **Códigos:** 200, 403, 404
- **Uso/ampliação em US-162:** request path `id` → response manifestação vigente e achados do processo · códigos 200, 403, 404

### ICT-12 — PUT `/internal-control/reviews/{id}/answers/{itemKey}`
**Permissão:** `INTERNAL_CONTROL_REVIEW_MANAGE` · **Story:** US-160
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ answer, note?, evidenceDocumentVersionId? }` + `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: Answer, meta { reviewEtag, progress } }`
- **Códigos:** 200, 403, 404, 409, 412, 422, 428, 503

### ICT-13 — POST `/internal-control/reviews/{id}/findings`
**Permissão:** `INTERNAL_CONTROL_REVIEW_MANAGE` · **Story:** US-160
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ title, description, severity, recommendation?, checklistItemKey?, riskId? }` + `Idempotency-Key`
- **Response:** `201 { data: Finding }` + `ETag`
- **Códigos:** 201, 403, 404, 409, 422, 503

### ICT-14 — PATCH `/internal-control/reviews/{id}/findings/{findingId}`
**Permissão:** `INTERNAL_CONTROL_REVIEW_MANAGE` · **Story:** US-160
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** campos alterados **ou** `{ status: "CANCELED", cancellationReason }` + `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: Finding }`
- **Códigos:** 200, 403, 404, 409, 412, 422, 428, 503

### ICT-15 — GET `/internal-control/reviews/{id}/findings`
**Permissão:** `INTERNAL_CONTROL_REVIEW_VIEW` · **Story:** US-160
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** filtros `status[]`, `severity[]`, `checklistItemKey`, `riskId`, `hasRecommendation`, `cursor`, `limit`
- **Response:** `200 { data: Finding[], meta.nextCursor }`
- **Códigos:** 200, 403, 404, 422

### ICT-16 — POST `/internal-control/reviews/{id}/manifestation`
**Permissão:** `INTERNAL_CONTROL_REVIEW_MANAGE` · **Story:** US-161
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `Idempotency-Key`
- **Response:** `201 { data: Document }` (ou `200` se já existe)
- **Códigos:** 200, 201, 403, 404, 409, 503

### ICT-17 — POST `/internal-control/reviews/{id}/conclude`
**Permissão:** `INTERNAL_CONTROL_REVIEW_CONCLUDE` · **Story:** US-161
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ outcome, conclusionSummary, acknowledgedOutdatedDocuments? }` + `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: InternalControlReview }`
- **Códigos:** 200, 403, 404, 409, 412, 422, 503

### ICT-18 — POST `/internal-control/reviews/{id}/findings/{findingId}/respond`
**Permissão:** `PROCESS_VIEW` · **Story:** US-162
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ response, evidenceAttachmentIds? }` + `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: InternalControlFinding }`
- **Códigos:** 200, 403, 404, 409, 412, 422, 503

### ICT-19 — GET `/internal-control/findings`
**Permissão:** `INTERNAL_CONTROL_REVIEW_VIEW` ou `PROCESS_VIEW` · **Story:** US-162
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** filtros `status`, `severity`, `processId`, `departmentId`, `olderThanDays`, cursor
- **Response:** `200 { data: Finding[], meta.nextCursor }` com `ageDays`
- **Códigos:** 200, 403, 422

### ATT-02 — POST `/attachments` (ampliação do MVP 1)
Contrato original: [mvp-01/api/12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md). Mudanças do MVP 2, todas aditivas:
- **US-160:** request MVP 1 (alvo `INTERNAL_CONTROL_REVIEW`) → response MVP 1 (URL de upload) · códigos 201, 403, 404, 422, 503

### ATT-03 — POST `/attachments/{id}/confirm` (ampliação do MVP 1)
Contrato original: [mvp-01/api/12-comments-attachments.md](../../mvp-01/api/12-comments-attachments.md). Mudanças do MVP 2, todas aditivas:
- **US-160:** request MVP 1 → response MVP 1 (verificação de vírus em fila) · códigos 202, 403, 404, 409

### DOC-05 — PUT `/documents/{id}/sections/{sectionKey}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-161:** request MVP 1 (tipo novo) → response MVP 1 · códigos 200, 403, 409, 412, 422

### DOC-10 — POST `/documents/{id}/finalize` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-161:** request MVP 1 (tipo novo) → response MVP 1 · códigos 200, 403, 409, 412, 422

### DOC-17 — GET `/document-versions/{versionId}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-159:** request MVP 1 (abrir versão do documento) → response MVP 1 · códigos 200, 403, 404
- **US-160:** request MVP 1 (abrir a evidência) → response MVP 1 · códigos 200, 403, 404

### DOC-21 — POST `/document-versions/{versionId}/renditions` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-161:** request MVP 1 (PDF da versão final, em fila) → response MVP 1 (rendição `PENDING`/`READY`) · códigos 200, 202, 403, 404

### RSK-09 — GET `/processes/{id}/risk-matrix` (ampliação do MVP 1)
Contrato original: [mvp-01/api/08-risks.md](../../mvp-01/api/08-risks.md). Mudanças do MVP 2, todas aditivas:
- **US-159:** request MVP 1 (atalho "Abrir matriz de riscos") → response MVP 1 · códigos 200, 403, 404
