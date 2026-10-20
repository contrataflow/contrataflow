# Pesquisa de preços e fornecedores (`price-research`, `supplier`)

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2.

| ID | Método | Rota | Permissão | Story |
|---|---|---|---|---|
| PRS-01 | GET | `/processes/{id}/price-research` | `PROCESS_VIEW` | US-024 |
| PRS-02 | POST | `/processes/{id}/price-research` | `PRICE_RESEARCH_CREATE` + POL-02 | US-024 |
| PRS-03 | GET | `/price-research/{id}` | `PROCESS_VIEW` (+ POL-09) | US-024 |
| PRS-04 | PATCH | `/price-research/{id}` | `PRICE_RESEARCH_UPDATE` + POL-02 | US-024, US-029 |
| PRS-05 | GET | `/price-research/{id}/items` | `PROCESS_VIEW` (+ POL-09) | US-024, US-029 |
| PRS-06 | POST | `/price-research/{id}/items` | `PRICE_RESEARCH_UPDATE` + POL-02 | US-024 |
| PRS-07 | PATCH | `/price-items/{itemId}` | `PRICE_RESEARCH_UPDATE` + POL-02 | US-029 |
| PRS-08 | DELETE | `/price-items/{itemId}` | `PRICE_RESEARCH_UPDATE` + POL-02 | US-024 |
| PRS-09 | GET | `/price-research/{id}/sources` | `PROCESS_VIEW` (+ POL-09) | US-026 |
| PRS-10 | POST | `/price-research/{id}/sources` | `PRICE_RESEARCH_UPDATE` + POL-02 | US-026 |
| PRS-11 | PATCH | `/price-sources/{sourceId}` | `PRICE_RESEARCH_UPDATE` + POL-02 | US-026 |
| PRS-12 | DELETE | `/price-sources/{sourceId}` | `PRICE_RESEARCH_UPDATE` + POL-02 | US-026 |
| PRS-13 | PUT | `/price-sources/{sourceId}/quotations` | `PRICE_RESEARCH_UPDATE` + POL-02 (IM da fonte) | US-026 |
| PRS-14 | PATCH | `/quotations/{quotationId}` | `PRICE_RESEARCH_UPDATE` + POL-02 | US-026 |
| PRS-15 | DELETE | `/quotations/{quotationId}` | `PRICE_RESEARCH_UPDATE` + POL-02 | US-026 |
| PRS-16 | POST | `/quotations/{quotationId}/exclude` | `PRICE_RESEARCH_EXCLUDE_QUOTATION` + POL-02 | US-027 |
| PRS-17 | POST | `/quotations/{quotationId}/restore` | `PRICE_RESEARCH_EXCLUDE_QUOTATION` + POL-02 | US-027 |
| PRS-18 | POST | `/price-research/{id}/import-preview` | `PRICE_RESEARCH_UPDATE` + POL-02 | US-028 |
| PRS-19 | POST | `/price-research/{id}/import` | `PRICE_RESEARCH_UPDATE` + POL-02 | US-028 |
| PRS-20 | POST | `/price-research/{id}/recalculate` | `PRICE_RESEARCH_UPDATE` + POL-02 | US-029 |
| PRS-21 | GET | `/price-research/{id}/comparative-map` | `PROCESS_VIEW` (+ POL-09) | US-031 |
| PRS-22 | GET | `/price-research/{id}/comparative-map/export` | `PROCESS_VIEW` (+ POL-09) | US-031 |
| PRS-23 | POST | `/price-research/{id}/complete` | `PRICE_RESEARCH_COMPLETE` + POL-02 | US-032 |
| PRS-24 | GET | `/price-research/{id}/import-template` | `PRICE_RESEARCH_UPDATE` + POL-02 | US-028 |
| SUP-01 | GET | `/suppliers` | `SUPPLIER_VIEW` | US-025 |
| SUP-02 | POST | `/suppliers` | `SUPPLIER_MANAGE` | US-025 |
| SUP-03 | GET | `/suppliers/{id}` | `SUPPLIER_VIEW` | US-025 |
| SUP-04 | PATCH | `/suppliers/{id}` | `SUPPLIER_MANAGE` | US-025 |
| SUP-05 | DELETE | `/suppliers/{id}` | `SUPPLIER_MANAGE` (somente sem uso) | US-025 |
| SUP-06 | GET | `/suppliers/lookup` | `SUPPLIER_VIEW` | US-025 |

O "mapa comparativo" em PDF é a renderização do documento `PRICE_RESEARCH` (`DOC-20`/`DOC-21`/`DOC-22`/`DOC-23`, fora deste arquivo), cujo template inclui a seção `PRICE_SUMMARY`. Anexos de fonte usam o fluxo genérico de upload (`ATT-02`, US-068).

---

### PRS-01 — Listar pesquisas de preços do processo
`GET /api/v1/processes/{id}/price-research` · **Permissão:** `PROCESS_VIEW` · **Story:** US-024

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório) — processo
- **Request:** —
- **Response:** `200 { data: PriceResearchSummary[] }` (0 ou 1 não cancelada + canceladas)
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `NOT_FOUND` | Processo inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** —

### PRS-02 — Criar pesquisa de preços a partir dos itens do processo
`POST /api/v1/processes/{id}/price-research` · **Permissão:** `PRICE_RESEARCH_CREATE` + POL-02 · **Story:** US-024

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório) — processo
- **Request:**
```ts
{
  title?: string;          // 5–250; padrão "Pesquisa de preços — {código do processo}"
  templateId?: string;     // ativo, publicado, do tipo; padrão do tipo
  referenceDate?: string;  // YYYY-MM-DD, ≤ hoje; padrão hoje
  items?: Array<{ processItemId: string; quantity?: string }>; // ≥1 (padrão: todos os itens); quantity >0, ≤4 casas
}
```
- **Response:** `201 { data: PriceResearch }`
```json
{ "data": { "id": "0192…", "documentId": "0192…", "processId": "0192…", "code": "PP 0003/2026",
  "title": "Pesquisa de preços — 0012/2026", "status": "DRAFT", "confidentiality": "INTERNAL", "referenceDate": "2026-10-06",
  "parameters": { "defaultMethod": "AUTO_CV", "cvThresholdPercent": "25.0000", "minQuotations": 3,
    "directQuoteMaxAgeDays": 180, "similarContractMaxAgeDays": 365, "outlierLowerPercent": "70.0000",
    "outlierUpperPercent": "130.0000", "unitPriceDecimals": 2, "roundingMode": "HALF_UP" },
  "itemsCount": 3, "itemsWithAlertsCount": 3, "totalEstimatedValue": null, "totalEstimatedValueMasked": false,
  "completedAt": null, "pendingApprovalId": null, "version": 1 } }
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | Sem permissão/custódia |
| 409 | `INVALID_PROCESS_STATUS` | Processo suspenso/cancelado/concluído |
| 409 | `DOCUMENT_ALREADY_EXISTS` | Pesquisa não cancelada já existe |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | Requisição idêntica em processamento |
| 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | Etapa não permite o tipo |
| 422 | `BUSINESS_RULE_VIOLATION` (`PRICE_ITEMS_REQUIRED`) | Processo sem itens |
| 422 | `VALIDATION_ERROR` | Item inválido (`REFERENCE_NOT_FOUND`/`DUPLICATE_IN_LIST`); quantidade inválida (`REQUIRED`/`OUT_OF_RANGE`/`INVALID_DECIMAL`); data-base futura (`OUT_OF_RANGE`); título fora de 5–250 (`TOO_SHORT`/`TOO_LONG`); template inativo (`REFERENCE_INACTIVE`) |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave, corpo diferente |

- **Efeitos:** Eventos: `DocumentCreated` (`document.created.price_research`) — `documentId`, `documentTypeCode = PRICE_RESEARCH`, `kind = STRUCTURED`, `code`, `title`, `templateVersionId`. Auditoria: `document.create` (`DATA_CHANGE`) — `metadata`: `documentCode`, `documentTypeCode`, `processCode`, `itemsCount`, snapshot de `parameters`, `idempotencyKey`. Timeline: `DOCUMENT_CREATED`.
- **Notas:** `parameters` (inclui `roundingMode`) é um snapshot fixado na criação (RN-PRICE-05); confidencialidade herdada do processo.
- **Implementação (US-024, 2026-10-18):** o `id` da pesquisa é o próprio `documentId` (CHECK `price_research_id_is_document`), como no DFD — a rota da SCR-009 e o painel de documentos usam o mesmo identificador. O `PriceResearch` traz também `templateVersionId`, `documentVersion`, `draftRevision`, `lastCalculatedAt`, `createdAt` e `updatedAt`; a resposta 201 traz o mesmo `meta` do PRS-03. O 409 `DOCUMENT_ALREADY_EXISTS` traz `meta: { existingId, existingDocumentId, code }` quando a verificação prévia encontrou a pesquisa (na corrida decidida pelo índice único, sem o id). `PRICE_ITEMS_REQUIRED` é conferido depois da autorização e antes de qualquer gravação (quem não pode criar recebe o 403). A data-base futura e a regra da quantidade são conferidas juntas no caso de uso (um único 422 com `items[i].quantity` e `referenceDate`). A auditoria `document.create` leva `code` (código do documento), `itemsCount` e `parameters`.

### PRS-03 — Obter pesquisa de preços
`GET /api/v1/price-research/{id}` · **Permissão:** `PROCESS_VIEW` (+ POL-09) · **Story:** US-024

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: PriceResearch, meta: { allowedActions } }` + `ETag` (schema de PRS-02)
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `NOT_FOUND` | Inexistente/outro tenant/não visível |

- **Efeitos:** —
- **Notas:** leitura de valores sigilosos sujeita a POL-09/RN-PRICE-12 (api.md §1.4): quem não atende a política recebe `totalEstimatedValue: null` + `totalEstimatedValueMasked: true`.
- **Implementação (US-024):** `meta = { allowedActions: ('UPDATE'|'ADD_ITEMS'|'REMOVE_ITEMS'|'EXCLUDE_QUOTATION')[], documentActions: DOCUMENT_ACTIONS[], lockReason, template }`. `lockReason` explica os botões desabilitados: `PERMISSION_DENIED`, `NOT_CUSTODIAN`, `INVALID_PROCESS_STATUS`, `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`, `DOCUMENT_NOT_EDITABLE` ou `CONFIDENTIAL_BUDGET` (sem POL-09 em processo sigiloso — RN-PRICE-12). `complete`/`reopen` seguem em `documentActions` (`FINALIZE`/`REOPEN`) até a US-032. `meta.template` = versão de template fixada (seções `METHODOLOGY`/`CONCLUSION`/`PRICE_SUMMARY`). **US-027:** `EXCLUDE_QUOTATION` entra em `allowedActions` quando o usuário tem `PRICE_RESEARCH_EXCLUDE_QUOTATION` cobrindo o processo e passa pelas mesmas travas de edição (custódia/participação, processo editável, etapa, documento `DRAFT`/`RETURNED`, POL-09); é independente de `UPDATE` (um perfil pode ter uma sem a outra) e `lockReason` continua explicando só a edição.

### PRS-04 — Atualizar pesquisa de preços (data-base, título e parâmetros de cálculo)
`PATCH /api/v1/price-research/{id}` · **Permissão:** `PRICE_RESEARCH_UPDATE` + POL-02 · **Story:** US-024, US-029

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:**
```ts
{
  referenceDate?: string;    // ≤ hoje
  title?: string;             // 5–250
  defaultMethod?: string;     // PriceCalculationMethod
  cvThresholdPercent?: string;
  minQuotations?: number;
  unitPriceDecimals?: number;
  roundingMode?: string;      // RoundingMode
}
```
- **Response:** `200 { data: PriceResearch }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 409 | `DOCUMENT_NOT_EDITABLE` | Pesquisa concluída |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | Campo fora de formato/faixa; parâmetro fixado no snapshot (`NOT_ALLOWED`) |

- **Efeitos:** Eventos: `PriceResearchRecalculated` (`price_research.recalculated`) no commit — `priceResearchId`, `itemsCount`, `itemsWithAlertsCount`, sem valores. Auditoria: `document.draft_update` (data-base/título) ou `price_research.method_change`/`price_research.recalculate` (parâmetros de cálculo, US-029).
- **Notas:** demais parâmetros do snapshot (ex.: `directQuoteMaxAgeDays`, `similarContractMaxAgeDays`, `outlierLowerPercent/UpperPercent`) não aparecem como editáveis nas stories-fonte — a definir na implementação.
- **Implementação (US-029):** editáveis também `defaultMethod` (`AUTO_CV`|`MEAN`|`MEDIAN`|`LOWEST`), `cvThresholdPercent` (string decimal, > 0 e ≤ 1000), `minQuotations` (1–10), `outlierLowerPercent` (> 0 e ≤ 100), `outlierUpperPercent` (100–1000), `unitPriceDecimals` (2|4) e `roundingMode` — as faixas de `priceResearch.*`; fora da faixa → 422 `OUT_OF_RANGE`. Os prazos de validade (`directQuoteMaxAgeDays`/`similarContractMaxAgeDays`) continuam 422 `NOT_ALLOWED`. **US-030 (V-02):** `outlierLowerPercent` ≥ `outlierUpperPercent` (com o valor gravado do que não veio no corpo) → 422 `OUT_OF_RANGE` nos dois campos ("O limite inferior de destaque deve ser menor que o superior."), antes de qualquer gravação. Parâmetro ou data-base alterados de fato recalculam todos os itens numa única gravação do cabeçalho (`version + 1`; o preço `MANUAL` não muda — RN-PRICE-47) e gravam `price_research.method_change` (`entityType = PriceResearch`, `changes` `parameters.<campo>` antigo/novo) e `price_research.recalculate` (`trigger = PARAMETERS`/`REFERENCE_DATE`).
- **Implementação (US-024):** só `referenceDate` e `title` são editáveis. Qualquer parâmetro do snapshot no corpo (inclusive `defaultMethod`, `cvThresholdPercent`, `minQuotations`, `unitPriceDecimals`, `roundingMode`) → 422 `VALIDATION_ERROR` `NOT_ALLOWED` ("Este parâmetro foi fixado na criação da pesquisa.") até a US-029 liberar os de cálculo. `If-Match` = `version` da pesquisa (428 sem ele). A nova data-base reavalia os alertas e emite `PriceResearchRecalculated`; só o título não emite o evento. Sem POL-09 em processo sigiloso → 403 `PERMISSION_DENIED` com `access.denied` (`reasonCode = POL-09`). Auditoria `document.draft_update` com o título como impressão digital (sha256 + tamanho).

### PRS-05 — Listar itens da pesquisa
`GET /api/v1/price-research/{id}/items` · **Permissão:** `PROCESS_VIEW` (+ POL-09) · **Story:** US-024, US-029

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório); query: `page`, `pageSize` (api.md §1.2); filtros `lot`, `hasAlerts` (booleano) — sem campo de ordenação documentado (ordem padrão: `sortOrder`)
- **Request:** —
- **Response:** `200 { data: PriceItem[], meta }`
```ts
PriceItem {
  id: string; processItemId: string; quantity: string;
  methodOverride?: string | null; manualUnitPrice?: string | null; manualJustification?: string | null;
  validQuotationsCount: number; meanPrice?: string; medianPrice?: string; lowestPrice?: string; highestPrice?: string;
  stdDeviation?: string; coefficientOfVariation?: string;
  effectiveMethod: string; recommendedUnitPrice?: string; recommendedUnitPriceMasked?: boolean;
  totalPrice?: string; calculatedAt?: string; belowMinimumJustification?: string | null;
  sortOrder: number; version: number;
}
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `NOT_FOUND` | Pesquisa inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** valores mascarados conforme POL-09/RN-PRICE-12 quando a pesquisa é sigilosa.
- **Implementação (US-024):** o `PriceItem` traz também `priceResearchId`, `sequence`, `lotNumber`, `lotName`, `description`, `unit { id, label, allowsDecimal }`, `quotationsCount` (confirmação da remoção — FA-05), `alerts`, `valuesMasked` e `totalPrice` sempre presentes (`null` quando não calculados). Sem POL-09, todos os valores monetários e o CV vêm `null` com `valuesMasked`/`recommendedUnitPriceMasked = true`. `pageSize` padrão 100.
- **Implementação (US-030, 2026-10-19):** `alerts` recalculado junto das estatísticas em todo recálculo (RN-PRICE-50): `NO_VALID_QUOTES` (0 válidas — sozinho, sem `BELOW_MINIMUM_QUOTES`), `BELOW_MINIMUM_QUOTES` (`0 < válidas < minQuotations`), `HIGH_CV` (CV gravado > `cvThresholdPercent`, com ≥ 2 válidas), `HAS_OUTLIERS` (alguma `VALID` com `outlierFlag ≠ NONE`) e `EXPIRED_QUOTES` (alguma `VALID` vencida); coexistem, cada um uma vez, na ordem do enum. Sob POL-09 os alertas continuam presentes (só os valores são mascarados). As cotações com `outlierFlag`/`isExpired` vêm no PRS-09 (a SCR-009 já as lê de lá — não foram aninhadas no PRS-05).

### PRS-06 — Incluir itens na pesquisa
`POST /api/v1/price-research/{id}/items` · **Permissão:** `PRICE_RESEARCH_UPDATE` + POL-02 · **Story:** US-024

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:**
```ts
{ items: Array<{ processItemId: string; quantity?: string }> } // itens do processo, não excluídos, sem repetição
```
- **Response:** `201 { data: PriceItem[] }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 409 | `DOCUMENT_NOT_EDITABLE` | Pesquisa concluída |
| 422 | `VALIDATION_ERROR` | Item inválido (`REFERENCE_NOT_FOUND`/`DUPLICATE_IN_LIST`); quantidade inválida (`OUT_OF_RANGE`/`INVALID_DECIMAL`) |

- **Efeitos:** Eventos: `PriceResearchRecalculated` (`price_research.recalculated`) **sempre** no commit — `priceResearchId`, `itemsCount`, `itemsWithAlertsCount`. Auditoria: `document.items_update` (`DATA_CHANGE`) — `changes`: itens incluídos com quantidade.
- **Notas:** PRS-06 emite `PriceResearchRecalculated` em todo commit, mesmo sem cotações ainda lançadas.
- **Implementação (US-024):** item já presente na pesquisa → 422 `DUPLICATE_IN_LIST` em `items[i].processItemId`. A quantidade segue a mesma regra do PRS-02 (processo → ETP → DFD; obrigatória se nenhuma). Muda a `version` da pesquisa.

### PRS-07 — Atualizar item da pesquisa (quantidade e método)
`PATCH /api/v1/price-items/{itemId}` · **Permissão:** `PRICE_RESEARCH_UPDATE` + POL-02 · **Story:** US-029

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `itemId` (path, uuid, obrigatório)
- **Request:**
```ts
{
  quantity?: string;              // >0
  methodOverride?: string | null; // MEAN|MEDIAN|LOWEST|MANUAL; vazio = segue padrão da pesquisa
  manualUnitPrice?: string;       // >0; condicional MANUAL; casas ≤ unitPriceDecimals
  manualJustification?: string;   // ≥20; condicional MANUAL (RN-PRICE-43)
  belowMinimumJustification?: string | null; // US-032 (RN-PRICE-58): 20–4000; null/vazio apaga
}
```
- **Response:** `200 { data: PriceItem }` com estatísticas recalculadas
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 409 | `DOCUMENT_NOT_EDITABLE` | Pesquisa não editável |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | `MANUAL` sem valor/justificativa (`CONDITIONAL_REQUIRED`); valor inválido (`INVALID_DECIMAL`); `methodOverride` fora do enum (`INVALID_ENUM`); campo calculado enviado (`NOT_ALLOWED`); `quantity` ≤0 (`OUT_OF_RANGE`); `belowMinimumJustification` com menos de 20 caracteres (`TOO_SHORT`) |

- **Efeitos:** Eventos: `PriceResearchRecalculated` (`price_research.recalculated`) no commit. Auditoria: `price_research.method_change` (`DATA_CHANGE`) quando `methodOverride` muda — `changes`: método anterior/novo; `metadata.priceItemId`.
- **Notas:** estatísticas (`validQuotationsCount`, `meanPrice` etc.) e `effectiveMethod`/`recommendedUnitPrice`/`totalPrice` são somente leitura. Edição de `manualUnitPrice` em pesquisa sigilosa sujeita a POL-09/RN-PRICE-12. `belowMinimumJustification` (US-032) é a justificativa de cotações insuficientes exigida pela conclusão quando `0 < validQuotationsCount < minQuotations` (RN-PRICE-58): gravada sem os espaços das pontas, não recalcula preços e nunca vai para a auditoria nem para eventos.
- **Implementação (US-029):** `If-Match` = `version` do item (412 `VERSION_CONFLICT` com `currentVersion`; 428 sem ele); `ETag` da resposta = versão nova do item. `methodOverride: null` volta ao método padrão e apaga `manualUnitPrice`/`manualJustification` (qualquer método diferente de `MANUAL` também os apaga). Com `MANUAL`, valor e justificativa ausentes no corpo vêm do item; faltando algum (ou justificativa < 20 sem os espaços das pontas) → `CONDITIONAL_REQUIRED` no campo; valor ≤ 0 ou com mais casas que `unitPriceDecimals` → `INVALID_DECIMAL` ("Informe um valor válido, com até {N} casas decimais."). `quantity` segue a regra do PRS-02/06 (> 0 → `OUT_OF_RANGE` "Informe uma quantidade maior que zero."; até 4 casas; inteira se a unidade não admite decimais). Campos calculados no corpo → `NOT_ALLOWED`. Reenvio sem mudança real responde 200 com o item atual, sem gravar, auditar nem emitir evento. Item inexistente, de outro tenant ou de processo não visível → 404 `NOT_FOUND` (o "`PRICE_ITEM_NOT_FOUND`" do Gherkin da story é este 404 — `detail` "Item da pesquisa não encontrado."). O item é gravado já recalculado e, na mesma transação, a pesquisa inteira é recalculada (`price_research.recalculate` com `trigger = ITEM_UPDATE` + `PriceResearchRecalculated`).

### PRS-08 — Remover item da pesquisa
`DELETE /api/v1/price-items/{itemId}` · **Permissão:** `PRICE_RESEARCH_UPDATE` + POL-02 · **Story:** US-024

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `itemId` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `204` sem corpo
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 409 | `DOCUMENT_NOT_EDITABLE` | Pesquisa concluída |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`) | Remover o último item da pesquisa |

- **Efeitos:** Eventos: `PriceResearchRecalculated` (`price_research.recalculated`) no commit. Auditoria: `document.items_update` (`DATA_CHANGE`) — `changes`: item removido; `metadata`: nº de cotações apagadas.
- **Notas:** a pesquisa precisa de ao menos um item.
- **Implementação (US-024):** `If-Match` = `version` do item (o `PriceItem.version` do PRS-05). O 422 do último item vem em `errors[]` (`field = itemId`, `NOT_ALLOWED`, "A pesquisa precisa de ao menos um item."). Muda a `version` da pesquisa.

### PRS-09 — Listar fontes da pesquisa
`GET /api/v1/price-research/{id}/sources` · **Permissão:** `PROCESS_VIEW` (+ POL-09) · **Story:** US-026

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório); paginação padrão (api.md §1.2), sem filtros/ordenação documentados
- **Request:** —
- **Response:** `200 { data: PriceSource[], meta }`
```ts
PriceSource {
  id: string; sourceTypeId: string; description: string; supplierId?: string | null;
  quoteDate?: string; accessedAt?: string; url?: string; referenceOrganization?: string;
  referenceDocument?: string; supplierChoiceJustification?: string; notes?: string; version: number;
}
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `NOT_FOUND` | Pesquisa inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** —
- **Implementação (US-026, 2026-10-18):** cada `PriceSource` traz também `priceResearchId`, `sourceType { id, code, label, isActive, requiredFields, maxAgeDays }`, `supplier { id, legalName, documentNumber } | null`, `sortOrder`, `createdAt`, `updatedAt` e `quotations: Quotation[]` (as cotações da fonte — a grade da SCR-009 não precisa de outra chamada). `Quotation = { id, priceResearchId, priceItemId, priceSourceId, unitPrice, unitPriceMasked, brandModel, status, exclusionReason, exclusionJustification, outlierFlag, isExpired, createdAt, updatedAt, version }`; sem POL-09 em processo sigiloso, `unitPrice: null` + `unitPriceMasked: true`. Campos opcionais sempre presentes (`null`). `pageSize` padrão 20 (a SCR-009 pede 100).

### PRS-10 — Criar fonte de pesquisa
`POST /api/v1/price-research/{id}/sources` · **Permissão:** `PRICE_RESEARCH_UPDATE` + POL-02 · **Story:** US-026

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:**
```ts
{
  sourceTypeId: string;                 // catálogo PRICE_SOURCE_TYPE, ativo
  description: string;                  // ≤300
  supplierId?: string;                  // condicional (requiredFields); fornecedor ativo do tenant
  quoteDate?: string;                   // condicional
  accessedAt?: string;                  // condicional; não futura
  url?: string;                         // condicional; inicia com https://
  referenceOrganization?: string;       // condicional; ≤250
  referenceDocument?: string;           // condicional; ≤120
  supplierChoiceJustification?: string; // condicional
  notes?: string;
}
```
- **Response:** `201 { data: PriceSource }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Pesquisa inexistente/outro tenant |
| 422 | `QUOTATION_REQUIRED_FIELDS` | Campos exigidos pelo tipo de fonte ausentes |
| 422 | `VALIDATION_ERROR` | `sourceTypeId`/`supplierId` inválido (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`); `url` sem `https://` (`INVALID_FORMAT`); data futura (`DATE_IN_PAST`) |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave, corpo diferente |

- **Efeitos:** Auditoria: `price_research.source_create` (`DATA_CHANGE`) — `metadata.sourceTypeId`.
- **Notas:** anexo (`attachment`) usa o fluxo genérico de upload (`ATT-02`, US-068).
- **Implementação (US-026):** ordem das validações: tipo ativo do tenant (422 `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` em `sourceTypeId`) → formato (`url` sem `https://` → `INVALID_FORMAT`) → datas não futuras (`quoteDate` > hoje no fuso do tenant ou `accessedAt` > agora → `DATE_IN_PAST`) → campos de `requiredFields` (422 `QUOTATION_REQUIRED_FIELDS` com `detail` "Para este tipo de fonte, informe: {campos}." e um erro `CONDITIONAL_REQUIRED` por campo; o anexo nunca é exigido aqui — RN-PRICE-28) → fornecedor ativo do tenant. `""` e `null` nos opcionais equivalem a ausente. Também grava `PriceResearchRecalculated` (RN-PRICE-27) e responde `ETag` = versão da fonte. 409 `DOCUMENT_NOT_EDITABLE` (V-08) e 403 POL-09 como no PRS-04.

### PRS-11 — Atualizar fonte de pesquisa
`PATCH /api/v1/price-sources/{sourceId}` · **Permissão:** `PRICE_RESEARCH_UPDATE` + POL-02 · **Story:** US-026

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `sourceId` (path, uuid, obrigatório)
- **Request:** campos editáveis de PRS-10 (parciais)
- **Response:** `200 { data: PriceSource }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` / `QUOTATION_REQUIRED_FIELDS` | Ver PRS-10 |

- **Efeitos:** Eventos: `PriceResearchRecalculated` (`price_research.recalculated`). Auditoria: `price_research.source_update` (`DATA_CHANGE`) — `changes`: campos alterados.
- **Notas:** —
- **Implementação (US-026):** `null` apaga um opcional. Trocar o tipo reavalia os campos exigidos com o tipo novo (que precisa estar ativo); mantendo o tipo, valem os `requiredFields` atuais do catálogo (lidos na gravação — mudanças no catálogo não retroagem sobre fontes não editadas). Tipo, `quoteDate` ou `accessedAt` alterados reavaliam `isExpired` das cotações da fonte (as alteradas ganham versão nova). `changes` da auditoria: ids e datas em claro; texto livre e URL como impressão digital (sha256 + tamanho). PATCH sem mudança efetiva = 200 sem nova versão.

### PRS-12 — Remover fonte de pesquisa
`DELETE /api/v1/price-sources/{sourceId}` · **Permissão:** `PRICE_RESEARCH_UPDATE` + POL-02 · **Story:** US-026

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `sourceId` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `204` sem corpo
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `PriceResearchRecalculated` (`price_research.recalculated`). Auditoria: `price_research.source_delete` (`DATA_CHANGE`) — `metadata`: quantidade de cotações removidas.
- **Notas:** —
- **Implementação (US-026):** remoção física (sem `deleted_at` — RN-PRICE-29 prevalece sobre o "SD" de entities.md); `ON DELETE CASCADE` leva as cotações. Anexos já enviados com alvo `PRICE_SOURCE` ficam órfãos (o alvo passa a 404).

### PRS-13 — Lançar cotações da fonte (grade)
`PUT /api/v1/price-sources/{sourceId}/quotations` · **Permissão:** `PRICE_RESEARCH_UPDATE` + POL-02 (`If-Match` da fonte) · **Story:** US-026

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório (versão da fonte)
- **Parâmetros:** `sourceId` (path, uuid, obrigatório)
- **Request:**
```ts
{ items: Array<{ priceItemId: string; unitPrice: string; brandModel?: string }> } // unitPrice >0, unitPriceDecimals casas; brandModel ≤200
```
- **Response:** `200 { data: Quotation[] }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Fonte inexistente/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` (`INVALID_DECIMAL`) | Preço ausente/zero/negativo ou fora das casas |

- **Efeitos:** Eventos: `PriceResearchRecalculated` (`price_research.recalculated`). Auditoria: `price_research.quotation_create`/`quotation_update` (`DATA_CHANGE`) por linha — `metadata`: `priceItemId`, `priceSourceId`.
- **Notas:** linhas sobre cotação `EXCLUDED` são bloqueadas (`INVALID_STATE`) — restaurar antes de editar (PRS-17). Edição de `unitPrice` em pesquisa sigilosa sujeita a POL-09/RN-PRICE-12.
- **Implementação (US-026):** `unitPrice` opcional por linha: linha sem preço e sem marca não altera nada; só marca → 422 `INVALID_DECIMAL`; linha idêntica à gravada é ignorada (sem versão nem auditoria). Erros de todas as linhas num único 422 (nada gravado). Linha sobre cotação `EXCLUDED` → 409 `INVALID_STATE` com `meta.priceItemIds`. Aceita `Idempotency-Key` opcional (FA-07 da story: reenvio com a mesma chave → mesma resposta + `Idempotent-Replayed: true`). Com alguma gravação, a fonte ganha versão nova (`ETag`) e a pesquisa é recalculada (`validQuotationsCount` = cotações `VALID`, alertas, contadores, `lastCalculatedAt`). `isExpired` (RN-PRICE-26): a data da fonte (`quoteDate`, ou a data local de `accessedAt` quando `ageReference = accessedAt`) anterior a `referenceDate − validade`; validade = `directQuoteMaxAgeDays`/`similarContractMaxAgeDays` do snapshot para `PESQUISA_DIRETA_FORNECEDOR`/`CONTRATACAO_SIMILAR` e `maxAgeDays` do catálogo para os demais; tipo sem `maxAgeDays` nunca expira. Métrica `price_research_quotations_upsert_duration_ms`.

### PRS-14 — Atualizar cotação individual
`PATCH /api/v1/quotations/{quotationId}` · **Permissão:** `PRICE_RESEARCH_UPDATE` + POL-02 · **Story:** US-026

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `quotationId` (path, uuid, obrigatório)
- **Request:**
```ts
{ unitPrice?: string; brandModel?: string }
```
- **Response:** `200 { data: Quotation }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 409 | `INVALID_STATE` | Cotação `EXCLUDED` |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` (`INVALID_DECIMAL`) | Preço inválido |

- **Efeitos:** Eventos: `PriceResearchRecalculated` (`price_research.recalculated`). Auditoria: `price_research.quotation_update` (`DATA_CHANGE`) — `metadata`: `priceItemId`, `priceSourceId`.
- **Notas:** edição de `unitPrice` em pesquisa sigilosa sujeita a POL-09/RN-PRICE-12.
- **Implementação (US-026):** `If-Match` = versão da cotação; a fonte também ganha versão nova (invalida a grade aberta com a versão antiga). Preço/marca iguais aos gravados = 200 sem gravação. 409 `INVALID_STATE` vem depois do 412.
- **Implementação (US-030):** `outlierFlag`/`isExpired` no corpo → 422 `VALIDATION_ERROR` `NOT_ALLOWED` no campo ("Este campo é calculado pelo sistema e não pode ser alterado diretamente."). A resposta (como a do PRS-16/17) traz a cotação já recalculada. O recálculo grava `outlierFlag`/`isExpired` de qualquer cotação da pesquisa **sem versão nova** (campos do sistema — não invalidam o `If-Match` de quem edita outra cotação).

### PRS-15 — Remover cotação
`DELETE /api/v1/quotations/{quotationId}` · **Permissão:** `PRICE_RESEARCH_UPDATE` + POL-02 · **Story:** US-026

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `quotationId` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `204` sem corpo
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `PriceResearchRecalculated` (`price_research.recalculated`). Auditoria: `price_research.quotation_delete` (`DATA_CHANGE`) — `metadata`: `priceItemId`, `priceSourceId`.
- **Notas:** —
- **Implementação (US-026):** cotação `EXCLUDED` também pode ser removida (remoção ≠ exclusão justificada). A fonte ganha versão nova.

### PRS-16 — Desconsiderar cotação
`POST /api/v1/quotations/{quotationId}/exclude` · **Permissão:** `PRICE_RESEARCH_EXCLUDE_QUOTATION` + POL-02 · **Story:** US-027

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `quotationId` (path, uuid, obrigatório)
- **Request:**
```ts
{ exclusionReason: string; exclusionJustification: string } // ExclusionReason enum; justificativa ≥20
```
- **Response:** `200 { data: Quotation }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 409 | `INVALID_STATE` | Já `EXCLUDED` |
| 409 | `DOCUMENT_NOT_EDITABLE` | Pesquisa não editável |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | Motivo ausente (`REQUIRED`); justificativa curta (`TOO_SHORT`) |

- **Efeitos:** Eventos: `QuotationExcluded` (`price_research.quotation_excluded`) — `priceResearchId`, `quotationId`, `priceItemId`, `reason`; seguido de `PriceResearchRecalculated`. Auditoria: `price_research.quotation_exclude` (`DATA_CHANGE`) — `metadata.reason`; justificativa como hash + tamanho.
- **Notas:** —
- **Implementação (US-027):** permissão `PRICE_RESEARCH_EXCLUDE_QUOTATION` no lugar da de edição (403 `PERMISSION_DENIED`, `access.denied` com `reasonCode = PRICE_RESEARCH_EXCLUDE_QUOTATION`); demais travas da POL-02 estendida e POL-09 como no PRS-14. `exclusionJustification` é aparada e exige 20–4000 caracteres (422 `TOO_SHORT`/`TOO_LONG`); `exclusionReason` ausente → 422 `REQUIRED`, fora do enum → `INVALID_ENUM`. Ordem: 404 → permissão/travas → 412 (`If-Match` = versão da COTAÇÃO) → 409 `INVALID_STATE` (`detail` "Esta cotação já está desconsiderada." e `meta.status`). Grava `excludedById`/`excludedAt`, **sobe a versão da fonte** (a grade PRS-13 aberta com a versão antiga recebe 412) e recalcula a pesquisa (`validQuotationsCount` sem a cotação, alertas, contadores). Última cotação válida do item: permitido (RN-PRICE-33) — o item passa a `NO_VALID_QUOTES`. A cotação segue em PRS-09 com `exclusionReason`/`exclusionJustification`. Auditoria: `changes` = `status` (`VALID` → `EXCLUDED`) e `exclusionJustification` como `{ sha256, length }`; o evento leva só ids e o código do motivo. Timeline: `QUOTATION_EXCLUDED` (item, fonte e motivo). Resposta: `ETag` = nova versão da cotação.

### PRS-17 — Restaurar cotação
`POST /api/v1/quotations/{quotationId}/restore` · **Permissão:** `PRICE_RESEARCH_EXCLUDE_QUOTATION` + POL-02 · **Story:** US-027

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `quotationId` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: Quotation }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 409 | `INVALID_STATE` | Já `VALID` |
| 409 | `DOCUMENT_NOT_EDITABLE` | Pesquisa não editável |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `QuotationRestored` (`price_research.quotation_restored`) — `priceResearchId`, `quotationId`, `priceItemId`; seguido de `PriceResearchRecalculated`. Auditoria: `price_research.quotation_restore` (`DATA_CHANGE`) — `metadata.priceItemId`.
- **Notas:** —
- **Implementação (US-027):** mesmas permissão, travas e ordem de validação do PRS-16 (409 `INVALID_STATE` com "Esta cotação já está válida."); limpa `exclusionReason`, `exclusionJustification`, `excludedById` e `excludedAt`, sobe a versão da fonte e recalcula a pesquisa. Auditoria com `changes` = `status` (`EXCLUDED` → `VALID`); timeline `QUOTATION_RESTORED`. `ETag` = nova versão da cotação.

### PRS-18 — Pré-visualizar importação de cotações por planilha
`POST /api/v1/price-research/{id}/import-preview` · **Permissão:** `PRICE_RESEARCH_UPDATE` + POL-02 · **Story:** US-028

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** multipart `.xlsx` (`file`, obrigatório)
- **Response:** `200 { data: { previewToken: string, expiresAt: string, fileName: string, columns: [...], rows: [...], columnIssues: [...], summary: { total: number, valid: number, errors: number, empty: number, warnings: number, rows: number } } }`
```ts
QuotationImportRow { row: number; sequence: number | null; priceItemId: string | null; valid: number; errors: number; empty: number; warnings: number; issues: QuotationImportIssue[] }
QuotationImportIssue { severity: "ERROR" | "WARNING"; code: "REFERENCE_NOT_FOUND" | "INVALID_DECIMAL" | "DUPLICATE_IN_LIST" | "QUOTATION_EXCLUDED"; row: number | null; column: string | null; header: string | null; priceSourceId: string | null; message: string }
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Pesquisa inexistente/outro tenant |
| 409 | `DOCUMENT_NOT_EDITABLE` | Pesquisa não editável |
| 413 | `FILE_TOO_LARGE` | Arquivo acima do limite |
| 415 | `FILE_TYPE_NOT_ALLOWED` | Extensão/MIME fora de `.xlsx` ou arquivo corrompido |
| 422 | `VALIDATION_ERROR` (em `file`) | Sem a coluna `Item` (`REQUIRED`), sem coluna de fonte reconhecida (`REFERENCE_NOT_FOUND`), acima de 500 itens ou 50 fontes (`OUT_OF_RANGE`) |

- **Efeitos:** — (não grava nada, não gera evento).
- **Notas:** `previewToken` válido por 15 min (Redis, chave do tenant), amarrado à pesquisa e ao usuário; consumido em PRS-19. Os erros por linha/célula vêm no `200` (`rows[].issues`, `columnIssues`) com os códigos de `errors[].code` (api.md §2.1.1): item não encontrado (`REFERENCE_NOT_FOUND`) ou repetido (`DUPLICATE_IN_LIST`) invalidam a linha; preço inválido (`INVALID_DECIMAL`) invalida a célula; coluna sem fonte (`REFERENCE_NOT_FOUND`, aviso — FA-02) e cotação `EXCLUDED` (`QUOTATION_EXCLUDED`, aviso — RN-PRICE-39) são ignoradas. Corpo `multipart/form-data` (campo `file`); sem preços na resposta.

### PRS-19 — Aplicar importação de cotações
`POST /api/v1/price-research/{id}/import` · **Permissão:** `PRICE_RESEARCH_UPDATE` + POL-02 · **Story:** US-028

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:**
```ts
{ previewToken: string }
```
- **Response:** `200 { data: { appliedCount: number, skippedCount: number } }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Pesquisa inexistente/outro tenant; token de outra pesquisa, de outro usuário ou de outro tenant |
| 409 | `DOCUMENT_NOT_EDITABLE` | Pesquisa não editável |
| 410 | `IMPORT_PREVIEW_EXPIRED` | Token expirado (15 min) ou já aplicado |
| 422 | `VALIDATION_ERROR` / `IDEMPOTENCY_KEY_REUSED` | Corpo inválido / chave reutilizada |

- **Efeitos:** Eventos: `PriceResearchRecalculated` (`price_research.recalculated`) no commit (um único). Auditoria: `price_research.import` (`DATA_CHANGE`) — `metadata`: `appliedCount`, `skippedCount`, `createdCount`, `updatedCount`, `fileName`. As fontes com cotações alteradas ganham versão nova.
- **Notas:** aplica sobre as cotações vigentes: a edição manual feita entre a prévia e a aplicação é sobrescrita (vale o último valor aplicado); cotação desconsiderada, preço igual ao gravado e item/fonte removidos depois da prévia são ignorados. `appliedCount` = cotações criadas ou com preço alterado; `skippedCount` = células preenchidas não aplicadas (erro/aviso na prévia, iguais à gravada ou sem referência).

### PRS-20 — Recalcular estatísticas da pesquisa
`POST /api/v1/price-research/{id}/recalculate` · **Permissão:** `PRICE_RESEARCH_UPDATE` + POL-02 · **Story:** US-029

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** `{}`
- **Response:** `200 { data: { itemsCount: number, itemsWithAlertsCount: number, lastCalculatedAt: string } }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Pesquisa inexistente/outro tenant |

- **Efeitos:** Eventos: `PriceResearchRecalculated` (`price_research.recalculated`) — `priceResearchId`, `itemsCount`, `itemsWithAlertsCount` (RN-PRICE-45). Auditoria: `price_research.recalculate` (`DATA_CHANGE`) — `metadata`: `itemsCount`, `itemsWithAlertsCount`, `trigger`.
- **Notas:** recálculo manual; também disparado implicitamente por PRS-04/06/07/08/11/12/13/14/15/16/17/19.
- **Implementação (US-029):** mesma guarda das demais escritas (POL-02 estendida + documento `DRAFT`/`RETURNED` — 409 `DOCUMENT_NOT_EDITABLE` — + POL-09 + trava da linha da pesquisa); corpo `{}` estrito. Resposta `{ itemsCount, itemsWithAlertsCount, lastCalculatedAt }` + `ETag` = versão nova da pesquisa. Idempotente: só as linhas cujo resultado mudou são regravadas; o cabeçalho sempre ganha `lastCalculatedAt` e `version + 1`. Banco indisponível → 503 `DEPENDENCY_UNAVAILABLE` sem alterar nada. Toda gravação de cotação/fonte/item (PRS-04/06/07/08/10..17/19) recalcula pelo mesmo motor (`PriceCalculationService`) e grava `price_research.recalculate` com o `trigger` (`QUOTATION`, `IMPORT`, `ITEMS`, `ITEM_UPDATE`, `PARAMETERS`, `REFERENCE_DATE`, `MANUAL`).

### PRS-21 — Obter mapa comparativo
`GET /api/v1/price-research/{id}/comparative-map` · **Permissão:** `PROCESS_VIEW` (+ POL-09) · **Story:** US-031

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: { items: [...], sources: [...], cells: [...] } }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `PRICE_RESEARCH_NOT_FOUND` | Pesquisa inexistente/outro tenant/não visível |

- **Efeitos:** —
- **Notas:** visão somente leitura sobre `PriceItem`/`PriceSource`/`Quotation` (editados em PRS-06..PRS-17/PRS-07).
- **Implementação (US-031):** `data = { priceResearchId, code, title, referenceDate, lastCalculatedAt, unitPriceDecimals, totalEstimatedValue, masked, items[], sources[], cells[] }`. `items[]` por `sortOrder` (`sequence`, `lotNumber`, `description`, `unitLabel`, `quantity`, `effectiveMethod`, `validQuotationsCount`, estatísticas de US-029, `recommendedUnitPrice`, `totalPrice`, `valuesMasked`, `alerts[]`); `sources[]` por `sortOrder` (`description`, `sourceType { code, label }`, `supplierName`, `quoteDate`); `cells[]` só nos cruzamentos com cotação, por item e fonte (`priceItemId`, `priceSourceId`, `quotationId`, `unitPrice`, `unitPriceMasked`, `status`, `exclusionReason`, `outlierFlag`, `isExpired`). POL-09: `masked: true`, `unitPrice: null` + `unitPriceMasked: true` em toda célula, estatísticas/CV/totais `null` + `valuesMasked: true`; selos e alertas continuam visíveis. Leitura numa única transação (`READ COMMITTED`); banco indisponível → 503 `DEPENDENCY_UNAVAILABLE`.

### PRS-22 — Exportar mapa comparativo (xlsx)
`GET /api/v1/price-research/{id}/comparative-map/export?format=xlsx` · **Permissão:** `PROCESS_VIEW` (+ POL-09) · **Story:** US-031

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório); query: `format` (obrigatório, somente `xlsx` no MVP 1)
- **Request:** —
- **Response:** `200` arquivo `xlsx`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `PRICE_RESEARCH_NOT_FOUND` | Pesquisa não visível/outro tenant |
| 422 | `EXPORT_TOO_LARGE` | Acima de 500 itens ou 50 fontes |
| 422 | `VALIDATION_ERROR` (`INVALID_ENUM`) | `format` diferente de `xlsx` |

- **Efeitos:** Auditoria: `price_research.export` (`EXPORT`) — `metadata`: `format`, `itemsCount`, `sourcesCount`, `masked: boolean`.
- **Notas:** —
- **Implementação (US-031):** `format` obrigatório (ausente → 422 `REQUIRED`; outro valor → 422 `INVALID_ENUM`). Arquivo `mapa-comparativo-<código>.xlsx` (`Content-Disposition: attachment`), uma aba: cabeçalho `Item`/`Descrição`/`Unidade`/`Quantidade`, uma coluna de preço por fonte (descrições repetidas ganham ` (n)`), depois estatísticas, método, valor unitário/total estimado, alertas e "Observações" (selos das células: desconsiderada com o motivo, acima/abaixo da mediana, vencida — os preços continuam numéricos); abaixo, a legenda das fontes e o resumo (data-base, calculado em, total). POL-09 = texto "Sigiloso" nas células monetárias. 422 `EXPORT_TOO_LARGE` traz `meta: { itemsCount, sourcesCount, maxItems, maxSources }` e sai antes de montar o arquivo (sem auditoria). Conteúdo determinístico (sem data de geração): duas exportações sem recálculo entre elas geram bytes idênticos. A auditoria é gravada depois de montar o arquivo e antes de enviar: falha → 503 sem arquivo. Classe de *rate limit* `export`. PDF: a seção `PRICE_SUMMARY` do documento `PRICE_RESEARCH` renderiza a mesma matriz a partir das coleções `priceSummary`/`priceSummarySources`/`priceSummaryItems` do snapshot (`PriceResearchDocumentValidator.snapshotParts`), mascarada pela rendition (`masked`).

### PRS-23 — Concluir pesquisa de preços
`POST /api/v1/price-research/{id}/complete` · **Permissão:** `PRICE_RESEARCH_COMPLETE` + POL-02 · **Story:** US-032

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` obrigatório
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** `{}`
- **Response:** `200 { data: PriceResearch }` com `completedAt`, `document: { status: "FINALIZED", currentVersionId }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `PRICE_RESEARCH_NOT_FOUND` | Pesquisa inexistente/outro tenant/não visível |
| 409 | `DOCUMENT_NOT_EDITABLE` | Já concluída/não editável |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | Requisição idêntica em processamento |
| 422 | `DOCUMENT_INCOMPLETE` | Seções obrigatórias do documento vazias (completude genérica do DOC-10) |
| 428 | `PRECONDITION_REQUIRED` | `If-Match` ausente |
| 503 | `DEPENDENCY_UNAVAILABLE` | Banco indisponível (nada é alterado) |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `PRICE_RESEARCH_INCOMPLETE` | Item sem `recommendedUnitPrice` (`violations[].code = PRICE_ITEM_WITHOUT_PRICE`) ou abaixo do mínimo sem justificativa (`PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED`) |

- **Efeitos:** Eventos: `PriceResearchCompleted` (`DocumentFinalized`) (`document.finalized.price_research`) — forma tipada; `typedSummary: { totalEstimatedValueMasked, itemsCount, itemsWithAlertsCount }`; `DocumentVersionCreated` (`document.version_created.price_research`) — `reason = FINALIZATION`, `contentHash`. Auditoria: `price_research.complete` (`DATA_CHANGE`) — `changes`: `estimatedValue` anterior/novo (hash + mascarado se sigiloso); `metadata`: `documentVersionId`, `itemsCount`, `itemsWithAlertsCount`, `idempotencyKey`.
- **Notas:** propaga `Process.estimatedValue`/`estimatedValueSource` e `ProcessItem.referenceUnitPrice` (RN-PRICE-61/62).
- **Implementação (US-032):** `If-Match` = `version` da pesquisa (o `ETag` do PRS-03 — toda gravação de item/cotação a sobe); o perdedor de duas conclusões simultâneas recebe 412. A conclusão é a MESMA finalização do DOC-10 (`DocumentFacade.finalizeIn`): POL-02 com `PRICE_RESEARCH_COMPLETE`, completude genérica (avisos reconhecidos pela confirmação na tela), versão `FINALIZATION` com o mapa comparativo e os campos de exceção de cada item (`methodOverride`, `manualUnitPrice`, `manualJustification`, `belowMinimumJustification`), `document.finalize`, `document.version_create`; o gancho `finalized` do `DocumentValidator` da pesquisa grava `completedAt`/`completedById`, o preço de referência dos itens (`manualUnitPrice` com `MANUAL`) e o valor estimado do processo na mesma transação — salvo `estimatedValueSource = TERM` (DEC-032), quando só os itens mudam e a auditoria registra `estimatedValueApplied: false`. Finalizar a pesquisa pelo DOC-10 dá no mesmo (as regras RN-PRICE-58 também entram no DOC-08/10, como `DOCUMENT_INCOMPLETE`). `violations[]` traz `params.sequence` (nº do item no processo) e `field = belowMinimumJustification` no código `PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED`. Resposta: o `PriceResearch` + `document: { status, currentVersionId }` e o `meta` (sem ações de edição, `lockReason = DOCUMENT_NOT_EDITABLE`). `meta.allowedActions` do PRS-03/04 ganha `COMPLETE` (permissão + travas da POL-02).

### PRS-24 — Obter modelo de planilha para importação
`GET /api/v1/price-research/{id}/import-template` · **Permissão:** `PRICE_RESEARCH_UPDATE` + POL-02 · **Story:** US-028

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `200` arquivo `.xlsx` (matriz itens × fontes com preços atuais)
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Pesquisa inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** planilha de uma aba (`Cotações`), cabeçalho na linha 1 e congelado: `Item` (sequência do item do processo), `Descrição do item`, `Unidade` e uma coluna por fonte com o cabeçalho = descrição da fonte (descrições repetidas ganham ` (n)` pela ordem das fontes); preços atuais como número com as casas de `unitPriceDecimals`. Nome `cotacoes-<código da pesquisa>.xlsx`. Acima de 500 itens ou 50 fontes → 422 `EXPORT_TOO_LARGE`. Também 409 `DOCUMENT_NOT_EDITABLE` (POL-02).

### SUP-01 — Listar fornecedores
`GET /api/v1/suppliers` · **Permissão:** `SUPPLIER_VIEW` · **Story:** US-025

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** query: `q` (busca textual, mín. 2 caracteres, api.md §1.2); `isActive` (filtro booleano); `page`, `pageSize` — sem campo de ordenação documentado
- **Request:** —
- **Response:** `200 { data: Supplier[], meta }`
```ts
Supplier {
  id: string; documentType: string; documentNumber: string; legalName: string; tradeName?: string;
  email?: string; phone?: string; website?: string; contactName?: string;
  addressStreet?: string; /* …demais campos de endereço, iguais a Organization */ addressZipCode?: string;
  isActive: boolean; notes?: string; version: number;
}
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `SUPPLIER_VIEW` |

- **Efeitos:** —
- **Notas:** lista completa dos campos de endereço remetida a "mesmos campos de `Organization`" pela story, sem enumeração própria — ver `entities.md` se necessário.

### SUP-02 — Cadastrar fornecedor
`POST /api/v1/suppliers` · **Permissão:** `SUPPLIER_MANAGE` · **Story:** US-025

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** —
- **Request:**
```ts
{
  documentType: string;       // SupplierDocumentType; imutável após criar
  documentNumber: string;     // CNPJ/CPF com dígito verificador válido; imutável após criar
  legalName: string;          // 2–250
  tradeName?: string;         // ≤250
  email?: string;             // formato válido
  phone?: string;             // ≤20
  website?: string;           // ≤255
  contactName?: string;       // ≤150
  addressStreet?: string;     // … demais campos de endereço, como Organization
  notes?: string;             // ≤5000
}
```
- **Response:** `201 { data: Supplier }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 409 | `SUPPLIER_ALREADY_EXISTS` | Mesmo CNPJ/CPF no tenant |
| 422 | `VALIDATION_ERROR` | Campo obrigatório ausente; CNPJ/CPF com DV inválido (`INVALID_CNPJ`/`INVALID_CPF`); formato inválido (`INVALID_FORMAT`); limites de tamanho (`TOO_LONG`) |

- **Efeitos:** Eventos: `SupplierCreated` (`supplier.created`) — `supplierId`, `documentType`. Auditoria: `supplier.create` (`DATA_CHANGE`) — `changes`: campos não sensíveis (CPF como hash); `metadata.documentType`.
- **Notas:** —

### SUP-03 — Obter fornecedor
`GET /api/v1/suppliers/{id}` · **Permissão:** `SUPPLIER_VIEW` · **Story:** US-025

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: Supplier }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** —

### SUP-04 — Atualizar fornecedor
`PATCH /api/v1/suppliers/{id}` · **Permissão:** `SUPPLIER_MANAGE` · **Story:** US-025

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** campos editáveis de SUP-02, exceto `documentType`/`documentNumber`
- **Response:** `200 { data: Supplier }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`) | Alterar `documentType`/`documentNumber` |
| 422 | `VALIDATION_ERROR` | Demais campos (ver SUP-02) |

- **Efeitos:** Eventos: `SupplierUpdated` (`supplier.updated`), inclui inativação — `supplierId`, `documentType`, `changedFields[]`. Auditoria: `supplier.update` (`DATA_CHANGE`) — `changes`: campos alterados; ou `supplier.deactivate` quando `isActive` passa a `false` (`metadata`: motivo, se informado).
- **Notas:** —

### SUP-05 — Excluir fornecedor
`DELETE /api/v1/suppliers/{id}` · **Permissão:** `SUPPLIER_MANAGE` (somente sem uso) · **Story:** US-025

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `204` sem corpo
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 409 | `SUPPLIER_IN_USE` | Referenciado por fonte de preço não excluída (oferecer "Inativar") |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Auditoria: `supplier.delete` (`DATA_CHANGE`) — exclusão lógica; `metadata.documentType`.
- **Notas:** não há evento de domínio dedicado para a exclusão nas fontes canônicas (lacuna sinalizada na própria story de US-025) — apenas auditoria.

### SUP-06 — Consultar fornecedor por documento
`GET /api/v1/suppliers/lookup?documentNumber=` · **Permissão:** `SUPPLIER_VIEW` · **Story:** US-025

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** query: `documentNumber` (obrigatório, CNPJ/CPF)
- **Request:** —
- **Response:** `200 { data: Supplier | null }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |

- **Efeitos:** —
- **Notas:** usado para evitar duplicidade antes de SUP-02.
