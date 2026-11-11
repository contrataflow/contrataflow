# 3.15 Edital (`tender`) — MVP 2

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint) do MVP 2. Convenções, erros genéricos e de domínio: [api.md §1–§2](../api.md#1-convenções) (que herda o [api.md do MVP 1](../../mvp-01/api.md)). Épico(s): EP-027. Fonte de cada linha: a seção "API" da story citada — divergência entre este arquivo e a story é bug de especificação.

Minuta do edital e do contrato (`Tender`): criação a partir de template e do TR (importação com prévia), lotes e itens, critérios de julgamento, matriz de alocação de riscos (art. 22), validação de completude e rascunho por IA (`draft.tender`). Publicação, PNCP e assinatura ficam no MVP 3 — no MVP 2 o edital é a minuta e sua análise. Tela: SCR-021.

Legenda: **Idem.** = `Idempotency-Key`; **IM** = `If-Match` (com `ETag` na resposta); "—" = não se aplica. Escritas sem `If-Match` criam recurso novo ou são ações idempotentes por chave. Listas paginam com `page`/`pageSize` (≤ 100) e `sort`, salvo indicação na linha.

## Endpoints novos

| ID | Método | Rota | Permissão | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| TND-01 | POST | `/processes/{id}/tender` | `TENDER_CREATE` + POL-01 | Obrigatório | — | US-163 |
| TND-02 | GET | `/processes/{id}/tender` | `PROCESS_VIEW` | — | — | US-163 |
| TND-03 | GET | `/tenders/{id}` | `PROCESS_VIEW` | — | — | US-163, US-164, US-165, US-166 |
| TND-04 | PATCH | `/tenders/{id}` | `TENDER_CREATE` + POL-01 | — | Obrigatório | US-163 |
| TND-05 | POST | `/tenders/{id}/import-term/preview` | `TENDER_UPDATE` + POL-02 | — | — | US-164 |
| TND-06 | POST | `/tenders/{id}/import-term` | `TENDER_UPDATE` + POL-02 | Obrigatório | Obrigatório | US-164 |
| TND-07 | GET | `/tenders/{id}/lots` | `PROCESS_VIEW` | — | — | US-165 |
| TND-08 | PUT | `/tenders/{id}/lots` | `TENDER_UPDATE` | — | Obrigatório | US-165 |
| TND-09 | GET | `/tenders/{id}/risk-allocations` | `PROCESS_VIEW` | — | — | US-166 |
| TND-10 | PUT | `/tenders/{id}/risk-allocations` | `TENDER_UPDATE` | — | Obrigatório | US-166 |
| TND-11 | POST | `/tenders/{id}/contract-draft` | `TENDER_CREATE` | Obrigatório | — | US-167 |
| TND-12 | POST | `/tenders/{id}/contract-draft/import-term` | `TENDER_UPDATE` | Obrigatório | Obrigatório | US-167 |
| TND-13 | GET | `/tenders/{id}/completeness` | `PROCESS_VIEW` | — | — | US-168 |
| TND-14 | POST | `/tenders/{id}/conclude` | `TENDER_SUBMIT` | Obrigatório | Obrigatório | US-168 |

## Rotas do MVP 1 ampliadas

Mudanças **aditivas** (campos opcionais, enums ampliados, filtros novos) sobre contratos do MVP 1; o comportamento do MVP 1 vale sem os campos novos. O contrato original está no arquivo indicado da pasta `mvp-01/api/`.

| ID | Método | Rota (MVP 1) | Permissão (MVP 1) | Contrato original | Ampliado por |
|---|---|---|---|---|---|
| AI-01 | POST | `/processes/{id}/ai-generations` | `AI_GENERATE` + POL-18 | [16-ai.md](../../mvp-01/api/16-ai.md) | US-169 |
| AI-02 | GET | `/ai-generations/{generationId}` | `PROCESS_VIEW` | [16-ai.md](../../mvp-01/api/16-ai.md) | US-169 |
| AI-04 | POST | `/ai-generations/{generationId}/discard` | solicitante (RN-AI-13) | [16-ai.md](../../mvp-01/api/16-ai.md) | US-169 |
| AI-05 | GET | `/ai/availability` | impl. | [16-ai.md](../../mvp-01/api/16-ai.md) | US-169 |
| AI-06 | GET | `/ai/usage` | `SETTINGS_MANAGE` | [16-ai.md](../../mvp-01/api/16-ai.md) | US-169 |
| DOC-03 | GET | `/documents/{id}` | `PROCESS_VIEW` (+POL-09) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-167 |
| DOC-04 | PATCH | `/documents/{id}` | permissão de edição do tipo + POL-02 (IM) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-167 |
| DOC-05 | PUT | `/documents/{id}/sections/{sectionKey}` | permissão de edição do tipo + POL-02 (IM de seção) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-163, US-167 |
| DOC-08 | GET | `/documents/{id}/validation` | `PROCESS_VIEW` | [03-documents.md](../../mvp-01/api/03-documents.md) | US-168, US-169 |
| DOC-13 | POST | `/documents/{id}/cancel` | `DOCUMENT_CANCEL` + custódia (IM) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-167 |
| DOC-17 | GET | `/document-versions/{versionId}` | `PROCESS_VIEW` (+POL-09) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-164 |
| DOC-18 | GET | `/documents/{id}/versions/compare?from=&to=` | `PROCESS_VIEW` (+POL-09) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-164 |
| DOC-20 | POST | `/documents/{id}/preview` | `PROCESS_VIEW` | [03-documents.md](../../mvp-01/api/03-documents.md) | US-167 |
| DOC-21 | POST | `/document-versions/{versionId}/renditions` | `PROCESS_VIEW` (+POL-09) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-168 |
| DOC-22 | GET | `/document-renditions/{renditionId}` | `PROCESS_VIEW` (+POL-09) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-168 |
| DOC-26 | POST | `/documents/{id}/ai-apply` | permissão de edição do tipo + POL-02 (solicitante da geração) | [03-documents.md](../../mvp-01/api/03-documents.md) | US-169 |
| DOC-27 | POST | `/documents/{id}/ai-review` | permissão de edição do tipo + POL-02 | [03-documents.md](../../mvp-01/api/03-documents.md) | US-169 |
| RSK-09 | GET | `/processes/{id}/risk-matrix` | `PROCESS_VIEW` | [08-risks.md](../../mvp-01/api/08-risks.md) | US-166 |

## Especificação por endpoint

### TND-01 — POST `/processes/{id}/tender`
**Permissão:** `TENDER_CREATE` + POL-01 · **Story:** US-163
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ title?, modalityId?, judgmentCriterionId, disputeMode?, executionRegime?, awardType?, isPriceRegistration?, smallBusinessBenefit?, isElectronic?, inPersonJustification?, estimatedValueDisclosed?, proposalValidityDays?, executionTermDays?, contractTermMonths?, guaranteePercent?, siteVisit?, habilitationRequirements? }` + `Idempotency-Key`
- **Response:** `201 { data: Tender, meta: { document, riskMatrixReasons[] } }` + `ETag` + `Location`
- **Códigos:** 201, 401, 403, 404, 409, 422, 429, 503

### TND-02 — GET `/processes/{id}/tender`
**Permissão:** `PROCESS_VIEW` · **Story:** US-163
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: Tender | null, meta: { canCreate, createBlockedReason?, stageKey, templatePublished } }`
- **Códigos:** 200, 401, 403, 404

### TND-03 — GET `/tenders/{id}`
**Permissão:** `PROCESS_VIEW` · **Story:** US-163 (também citado por US-164, US-165, US-166)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: Tender, meta: { document, editable, editBlockedReason?, riskMatrixReasons[], lots: { count, itemsUnassigned }, riskMatrix: { required, count, complete }, termChangedSinceImport } }` + `ETag`
- **Códigos:** 200, 401, 403, 404
- **Uso/ampliação em US-164:** request — (US-163) → response ganha `termChangedSinceImport` e `termImportAvailable` · códigos 200, 401, 403, 404
- **Uso/ampliação em US-165:** request — (US-163) → response `meta.lots` (`count`, `itemsUnassigned`) refletem esta story · códigos 200, 401, 403, 404
- **Uso/ampliação em US-166:** request — (US-163) → response `meta.riskMatrix` (`required`, `count`, `complete`) reflete esta story · códigos 200, 401, 403, 404

### TND-04 — PATCH `/tenders/{id}`
**Permissão:** `TENDER_CREATE` + POL-01 · **Story:** US-163
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** subconjunto dos campos de TND-01 (exceto `title`) + `If-Match`
- **Response:** `200 { data: Tender, meta: { changedFields[] } }` + `ETag`
- **Códigos:** 200, 401, 403, 404, 409, 412, 422, 428, 429, 503

### TND-05 — POST `/tenders/{id}/import-term/preview`
**Permissão:** `TENDER_UPDATE` + POL-02 · **Story:** US-164
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `{}` (calcula a partir do estado atual)
- **Response:** `200 { data: { importToken, expiresAt, term: { documentId, code, versionId, versionNumber }, sections: [{ target, sources, mode, before, after, hasContent, skippedReason? }], fields: [{ target, source, current, proposed, skippedReason? }], items: { count, preview: [{ processItemId, sequence, description, unit, quantity }], lotSeeding: { allowed, lotsPlanned, itemsWithoutLot } }, warnings[] } }`
- **Códigos:** 200, 401, 403, 404, 409, 422 (`TERM_REQUIRED_FOR_IMPORT`, `BUSINESS_RULE_VIOLATION`)

### TND-06 — POST `/tenders/{id}/import-term`
**Permissão:** `TENDER_UPDATE` + POL-02 · **Story:** US-164
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ importToken, sections: string[], fields: string[], copyItems: boolean, seedLots?: boolean, confirmReplaceSections?: string[] }` + `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: { tender: Tender, sectionsImported: string[], fieldsImported: string[], itemsImported: number, lotsCreated: number, documentVersion: { id, versionNumber } } }` + `ETag`
- **Códigos:** 200, 401, 403, 404, 409, 410 (`IMPORT_PREVIEW_EXPIRED`), 412, 422, 428, 503

### TND-07 — GET `/tenders/{id}/lots`
**Permissão:** `PROCESS_VIEW` · **Story:** US-165
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { lots: [{ id, number, name, description?, smallBusinessBenefit?, effectiveBenefit, estimatedValue?, valueIncomplete, masked, items: [{ processItemId, sequence, description, unit, quantity }] }], unassignedItems: [{ processItemId, sequence, description }] }, meta: { awardType, coverage, planningSuggestion, warnings[], editable, editBlockedReason? } }` + `ETag`
- **Códigos:** 200, 401, 403, 404

### TND-08 — PUT `/tenders/{id}/lots`
**Permissão:** `TENDER_UPDATE` · **Story:** US-165
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ lots: [{ id?, number, name, description?, smallBusinessBenefit?, processItemIds: uuid[] }] }` + `If-Match`
- **Response:** `200` com o mesmo formato de TND-07 + `ETag`
- **Códigos:** 200, 401, 403, 404, 409, 412, 413, 422, 428, 429, 503

### TND-09 — GET `/tenders/{id}/risk-allocations`
**Permissão:** `PROCESS_VIEW` · **Story:** US-166
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { allocations: [{ id, riskId?, riskCode?, riskLevel?, title, riskTitleChanged, currentRiskTitle?, allocation, rationale, mitigation?, economicBalanceImpact?, sortOrder }], availableRisks: [{ riskId, code, title, level, category, treatments: [{ type, description }] }] }, meta: { required, reasons[], complete, pending: [{ code, riskId?, allocationId? }], riskMapAvailable, editable, editBlockedReason? } }` + `ETag`
- **Códigos:** 200, 401, 403, 404

### TND-10 — PUT `/tenders/{id}/risk-allocations`
**Permissão:** `TENDER_UPDATE` · **Story:** US-166
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ allocations: [{ id?, riskId?, title?, refreshTitle?, allocation, rationale, mitigation?, economicBalanceImpact? }] }` + `If-Match`
- **Response:** `200` com o mesmo formato de TND-09 + `ETag`
- **Códigos:** 200, 401, 403, 404, 409, 412, 413, 422, 428, 429, 503

### TND-11 — POST `/tenders/{id}/contract-draft`
**Permissão:** `TENDER_CREATE` · **Story:** US-167
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ title?, importFromTerm? }` + `Idempotency-Key`
- **Response:** `201 { data: { document, tender: { contractDraftDocumentId } } }` + `Location`, `ETag`
- **Códigos:** 201, 401, 403, 404, 409, 422, 503

### TND-12 — POST `/tenders/{id}/contract-draft/import-term`
**Permissão:** `TENDER_UPDATE` · **Story:** US-167
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ mode: 'PREVIEW', termVersionId? }` ou `{ mode: 'APPLY', importToken, sections[], conditions[], confirmReplaceFilled? }` + `If-Match` + `Idempotency-Key` (só `APPLY`)
- **Response:** `PREVIEW`: `200 { data: { termVersion, sections[], conditions[], skipped[], warnings[], importToken, expiresAt } }`; `APPLY`: `200 { data: { document, sectionsImported[], conditionsImported[] } }`
- **Códigos:** 200, 401, 403, 404, 409, 410, 412, 422, 428, 503

### TND-13 — GET `/tenders/{id}/completeness`
**Permissão:** `PROCESS_VIEW` · **Story:** US-168
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** path `id`
- **Response:** `200 { data: { canConclude, violations[], summary, term, lots, riskMatrix, contractDraft, aiReview, aiProposals, evaluatedAt }, meta: { analysisHash } }` + `ETag`
- **Códigos:** 200, 401, 403, 404

### TND-14 — POST `/tenders/{id}/conclude`
**Permissão:** `TENDER_SUBMIT` · **Story:** US-168
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ acknowledgedWarnings?: string[] }` + `If-Match` + `Idempotency-Key`
- **Response:** `200 { data: { tender, editalVersion, contractDraftVersion?, renditions[], warningsAcknowledged[] } }`
- **Códigos:** 200, 401, 403, 404, 409, 412, 422, 428, 503

### AI-01 — POST `/processes/{id}/ai-generations` (ampliação do MVP 1)
Contrato original: [mvp-01/api/16-ai.md](../../mvp-01/api/16-ai.md). Mudanças do MVP 2, todas aditivas:
- **US-169:** request `{ targetModule: 'TENDER', documentId, kind: 'DRAFT' | 'SECTION', action?, sectionKey?, instruction? }` + `Idempotency-Key` → response `202 { data: AiGeneration, meta: { pollAfterMs } }` + `Location` · códigos 202, 401, 403, 404, 409, 422, 429, 503

### AI-02 — GET `/ai-generations/{generationId}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/16-ai.md](../../mvp-01/api/16-ai.md). Mudanças do MVP 2, todas aditivas:
- **US-169:** request — → response `200 { data: AiGeneration }` (com `output`, `warnings`, `inputRefs`; `INPUTS_OUTDATED` derivado) · códigos 200, 403, 404

### AI-04 — POST `/ai-generations/{generationId}/discard` (ampliação do MVP 1)
Contrato original: [mvp-01/api/16-ai.md](../../mvp-01/api/16-ai.md). Mudanças do MVP 2, todas aditivas:
- **US-169:** request — → response `200` · códigos 200, 403, 404, 409

### AI-05 — GET `/ai/availability` (ampliação do MVP 1)
Contrato original: [mvp-01/api/16-ai.md](../../mvp-01/api/16-ai.md). Mudanças do MVP 2, todas aditivas:
- **US-169:** request — → response `200 { enabled, canGenerate, reasons[] }` (RN-TND-157) · códigos 200, 401

### AI-06 — GET `/ai/usage` (ampliação do MVP 1)
Contrato original: [mvp-01/api/16-ai.md](../../mvp-01/api/16-ai.md). Mudanças do MVP 2, todas aditivas:
- **US-169:** request `SETTINGS_MANAGE` → response consumo por gerador, documento e usuário, com `draft.tender` · códigos 200, 403

### DOC-03 — GET `/documents/{id}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-167:** request — → response minuta com `draftContent`, `status`, `ETag` (MVP 1) · códigos 200, 403, 404

### DOC-04 — PATCH `/documents/{id}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-167:** request MVP 1 → response edição do rascunho (POL-02) · códigos 200, 403, 404, 409, 412, 422

### DOC-05 — PUT `/documents/{id}/sections/{sectionKey}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-163:** request MVP 1 → response seção do `EDITAL` salva (POL-02 com `TENDER_UPDATE`) · códigos 200, 403, 404, 409, 412
- **US-167:** request MVP 1 → response edição do rascunho (POL-02) · códigos 200, 403, 404, 409, 412, 422

### DOC-08 — GET `/documents/{id}/validation` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-168:** request — → response `violations[]` do documento (edital via `TenderValidator`) · códigos 200, 403, 404
- **US-169:** request — → response `violations[]` com `SECTION_AI_REVIEW_PENDING` e `SECTION_PLACEHOLDER_PENDING` · códigos 200, 403, 404

### DOC-13 — POST `/documents/{id}/cancel` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-167:** request MVP 1 → response cancela a minuta em `DRAFT`/`RETURNED` · códigos 200, 403, 404, 409, 412, 422

### DOC-17 — GET `/document-versions/{versionId}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-164:** request MVP 1 → response versão do TR de origem (atalho "Ver versão importada") · códigos 200, 403, 404

### DOC-18 — GET `/documents/{id}/versions/compare?from=&to=` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-164:** request MVP 1 → response comparação das versões do TR (atalho "Comparar versões do TR") · códigos 200, 403, 404

### DOC-20 — POST `/documents/{id}/preview` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-167:** request MVP 1 → response prévia em PDF do rascunho · códigos 202, 403, 404, 422

### DOC-21 — POST `/document-versions/{versionId}/renditions` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-168:** request — → response nova rendition `CONTENT` (retentativa do PDF) · códigos 202, 403, 404, 409

### DOC-22 — GET `/document-renditions/{renditionId}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-168:** request — → response estado da rendition · códigos 200, 403, 404

### DOC-26 — POST `/documents/{id}/ai-apply` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-169:** request `{ generationId, sectionKeys, confirmReplaceFilled? }` + `If-Match` + `Idempotency-Key` → response `200 { data: { document, appliedSectionKeys, versionCreated } }` · códigos 200, 403, 404, 409, 410, 412, 422, 428, 503

### DOC-27 — POST `/documents/{id}/ai-review` (ampliação do MVP 1)
Contrato original: [mvp-01/api/03-documents.md](../../mvp-01/api/03-documents.md). Mudanças do MVP 2, todas aditivas:
- **US-169:** request `{ sectionKeys, expectedRevisions, confirmAll? }` → response `200 { data: { document, reviewedSectionKeys } }` · códigos 200, 403, 404, 409, 412, 422, 503

### RSK-09 — GET `/processes/{id}/risk-matrix` (ampliação do MVP 1)
Contrato original: [mvp-01/api/08-risks.md](../../mvp-01/api/08-risks.md). Mudanças do MVP 2, todas aditivas:
- **US-166:** request MVP 1 (US-035) → response matriz de calor do mapa, usada para exibir o nível dos riscos · códigos 200, 403, 404
