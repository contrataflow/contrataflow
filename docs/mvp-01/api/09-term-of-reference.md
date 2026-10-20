# Termo de Referência (`term`)

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2.

| ID | Método | Rota | Permissão | Story |
|---|---|---|---|---|
| TRM-01 | GET | `/processes/{id}/terms` | `PROCESS_VIEW` | US-036 |
| TRM-02 | POST | `/processes/{id}/terms` | `TERM_CREATE` + POL-02 | US-036 |
| TRM-03 | GET | `/terms/{id}` | `PROCESS_VIEW` (+ POL-09) | US-036 |
| TRM-04 | PATCH | `/terms/{id}` | `TERM_UPDATE` + POL-02 | US-036, US-038 |
| TRM-05 | POST | `/terms/{id}/import-etp/preview` | `TERM_UPDATE` + POL-02 | US-037 |
| TRM-06 | POST | `/terms/{id}/import-etp` | `TERM_UPDATE` + POL-02 | US-037 |

Seções, itens (`DOC-06`/`DOC-07`), validação, pré-visualização e catálogo de critério de julgamento (`CAT-01`) usam os endpoints genéricos de documento/item com o `documentId`/`processId` do TR — fora do escopo deste arquivo.

---

### TRM-01 — Listar Termos de Referência do processo
`GET /api/v1/processes/{id}/terms` · **Permissão:** `PROCESS_VIEW` · **Story:** US-036

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório) — processo
- **Request:** —
- **Response:** `200 { data: TermSummary[], meta: TermListMeta }`
```ts
TermSummary { id: string; documentId: string; code: string; status: string; title: string; version: number; }
TermListMeta { templates: { id; name; isDefault; versionId; versionNumber }[]; defaultTitle: string } // diálogo de criação (FA-01) — implementação US-036
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `NOT_FOUND` | Processo inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** —

### TRM-02 — Criar Termo de Referência
`POST /api/v1/processes/{id}/terms` · **Permissão:** `TERM_CREATE` + POL-02 · **Story:** US-036

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório) — processo
- **Request:**
```ts
{
  templateId?: string; // ativo, tipo TR, versão publicada; padrão do tipo
  title?: string;      // 5–250; padrão "Termo de Referência — {process.title}"
}
```
- **Response:** `201 { data: Term }` com `id`, `documentId`, `code`, `status`, `templateVersion: { id, versionNumber }`, cabeçalho, `version`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | Sem permissão/sem custódia |
| 404 | `NOT_FOUND` | Processo inexistente/outro tenant |
| 409 | `DOCUMENT_ALREADY_EXISTS` | TR já existe no processo |
| 409 | `INVALID_PROCESS_STATUS` | Processo suspenso/cancelado/concluído |
| 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | Etapa atual não permite TR |
| 422 | `VALIDATION_ERROR` | Título fora de 5–250 (`TOO_SHORT`/`TOO_LONG`); `templateId` inválido (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |

- **Efeitos:** Eventos: `DocumentCreated` (`document.created.tr`) — `documentId`, `documentTypeCode = TR`, `kind = STRUCTURED`, `code`, `title`, `templateVersionId`. Auditoria: `document.create` (`DATA_CHANGE`) — `metadata`: `documentTypeCode = TR`, `code`, `templateVersionId`, `priceResearchId`, `idempotencyKey`. Timeline: `DOCUMENT_CREATED`.
- **Notas:** `objectDefinition` é inicializado a partir de `process.object` (RN-TR-14); `importedFromEtpId`/`importedFromEtpVersionId`/`importedAt`/`importedById` nascem nulos (preenchidos só por TRM-06, US-037). **Implementação (US-036):** `id` do TR = `documentId`; com pesquisa de preços `FINALIZED`/`APPROVED` o TR nasce com `priceResearchId`, o total e `estimatedValueSource = PRICE_RESEARCH` (RN-TR-07); com orçamento sigiloso o documento nasce `RESTRICTED`; o 409 `DOCUMENT_ALREADY_EXISTS` traz `meta.existingTermId`; `Location: /api/v1/terms/{id}` e `ETag: "<version>"`.

### TRM-03 — Obter Termo de Referência
`GET /api/v1/terms/{id}` · **Permissão:** `PROCESS_VIEW` (+ POL-09) · **Story:** US-036

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: Term & { etpChangedSinceImport: boolean } }` + `ETag` — cabeçalho mascarado (POL-09), seções (`state`, `revision`, `content`), `completeness`, `meta.allowedActions`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `NOT_FOUND` | Inexistente/outro tenant/não visível |

- **Efeitos:** —
- **Notas:** `etpChangedSinceImport` é campo **calculado** por comparação de versão entre o ETP atual e `importedFromEtpVersionId` (RN-TR-24); usado pela UI para sinalizar defasagem da importação ETP→TR (US-037). **Implementação (US-036):** `ETag` = `TermOfReference.version` (o `If-Match` do TRM-04); `data` traz também `inApproval`, `templateVersion { id, versionNumber }`, `draftRevision`/`draftContent` (revisão por seção — `If-Match: "s<revision>"` do DOC-05), `completeness { required, satisfied, percent, sections[] }` (avaliação do DOC-08 — RN-TR-13), `priceResearch` (vinculada) e `completedPriceResearch` (a concluída do processo — aviso de FA-04), com o total mascarado pela POL-09; `meta.template` traz as seções da versão fixada.

### TRM-04 — Atualizar Termo de Referência (dados, valor e condições contratuais)
`PATCH /api/v1/terms/{id}` · **Permissão:** `TERM_UPDATE` + POL-02 · **Story:** US-038 (campos de valor/pesquisa: US-036)

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:**
```ts
{
  objectDefinition?: string;             // 10–2000 (RN-TR-14)
  priceResearchId?: string;              // pesquisa do mesmo processo
  estimatedTotalValue?: string;          // decimal ≥0, 2 casas; POL-09
  estimatedValueSource?: "PRICE_RESEARCH" | "ETP" | "MANUAL";
  contractDurationMonths?: number;       // 1–120
  executionDeadline?: number;            // condicional (RN-TR-29)
  executionDeadlineType?: "BUSINESS" | "CALENDAR"; // condicional (RN-TR-29)
  deliveryLocation?: string;
  paymentTermDays?: number;              // 1–90
  productWarrantyMonths?: number;        // 0–120
  contractGuaranteePercent?: string;     // 0–10 (arts. 96–98)
  allowsSubcontracting?: boolean;
  selectionCriterionId?: string;         // catálogo JUDGMENT_CRITERION, ativo (art. 33)
  awardType?: "BY_ITEM" | "BY_LOT" | "GLOBAL";
}
```
- **Response:** `200 { data: Term }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 409 | `DOCUMENT_NOT_EDITABLE` | TR concluído |
| 409 | `INVALID_PROCESS_STATUS` | Processo não permite alterações |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | Valores fora de faixa (`OUT_OF_RANGE`); decimal inválido (`INVALID_DECIMAL`); prazo sem tipo de contagem (`CONDITIONAL_REQUIRED`); referências inválidas (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`); item repetido (`DUPLICATE_IN_LIST`, via `DOC-07`) |

- **Efeitos:** Eventos: — (nenhum evento de domínio; ajuste de rascunho, RN-TR-33). Auditoria: `document.draft_update` (`DATA_CHANGE`, coalescida a cada 10 min) — campos alterados (valor mascarado se sigiloso); `document.items_update` quando itens são alterados via `DOC-07`.
- **Notas:** limites numéricos (vigência, prazo de pagamento, garantias) citados nas stories US-036/US-038, referenciando entities.md §4.8. **Implementação (US-036):** aceita `objectDefinition`, `priceResearchId`, `estimatedTotalValue` e `estimatedValueSource` (as condições contratuais entram com a US-038). `priceResearchId` ou `PRICE_RESEARCH` sem id (= a concluída do processo) vincula a pesquisa do mesmo processo concluída e copia o total (422 `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` em `priceResearchId`; valor no corpo = `NOT_ALLOWED`); `MANUAL` exige o valor (`CONDITIONAL_REQUIRED`) e desvincula a pesquisa; `ETP` só pela importação (422 `NOT_ALLOWED`); sem POL-09 em processo sigiloso, alterar o valor = 403. A auditoria `document.draft_update` do painel é imediata (objeto como hash + tamanho). **Implementação (US-038):** aceita as condições contratuais; campo ausente = sem mudança e `null` limpa (exceto `allowsSubcontracting`, booleano). Faixas no schema — vigência 1–120, prazo de pagamento 1–90, garantia do objeto 0–120, `executionDeadline` ≥ 1 (teto técnico de 36.500 dias), `deliveryLocation` ≤ 2.000 (422 `OUT_OF_RANGE`/`TOO_LONG`), `contractGuaranteePercent` string decimal de 0 a 10 com até 4 casas (`INVALID_DECIMAL` no formato, `OUT_OF_RANGE` acima de 10) e a resposta o devolve sem zeros à direita (`"5"`, `"2.5"`). O par prazo × tipo de contagem é conferido sobre o estado resultante (RN-TR-29: 422 `CONDITIONAL_REQUIRED` no campo que falta). `selectionCriterionId` novo tem de ser item ativo do catálogo `JUDGMENT_CRITERION` do tenant (`REFERENCE_NOT_FOUND` — inexistente, de outro catálogo ou de outro tenant — / `REFERENCE_INACTIVE`, mensagem "Selecione um critério de julgamento válido."). Reenviar os valores atuais não grava nem audita. Na auditoria, `deliveryLocation` vai como hash + tamanho; log `term.conditions_updated` com `fieldsChanged`.

### TRM-05 — Pré-visualizar importação do ETP
`POST /api/v1/terms/{id}/import-etp/preview` · **Permissão:** `TERM_UPDATE` + POL-02 · **Story:** US-037

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório) — TR
- **Request:** `{}` (calcula a partir do estado atual)
- **Response:** `200 { data: { importToken: string, expiresAt: string, etp: { id: string, versionNumber: number }, sections: Array<{ target: string, sources: string[], mode: string, preview: string }>, fields: Array<{ target: string, source: string, value: unknown, valueMasked: boolean }>, items: { count: number, copyQuantities: boolean, copyCalculationMemoToNotes: boolean, preview: Array<{ processItemId: string, sequence: number, description: string, etpQuantity: string, trCurrentQuantity: string }> } } }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | TR inexistente/outro tenant |
| 422 | `ETP_REQUIRED_FOR_IMPORT` | Processo sem ETP não cancelado |

- **Efeitos:** — (não grava nada, não gera evento).
- **Notas:** o `importToken` é **assinado e sem estado** (stateless), válido por 15 min; consumido por TRM-06. **Implementação (US-037):** a origem é o rascunho mais recente do ETP não cancelado (FA-02: `etp.inProgress` em `DRAFT`/`RETURNED`/`IN_REVIEW`; `etp.versionNumber` = versão vigente ou `null`); a resposta acrescenta `etp.code`/`status`/`inProgress`, `sections[].before` (texto atual do TR), `fields[].current`, `items.preview[].specified` (FA-04) e `replacesPriceResearchValue` (RN-TR-22). Só entram seções do mapeamento presentes no template e com conteúdo na origem, e campos com valor no ETP; sem `importMappings` na versão do template, só os itens (quantidades). Formato do token: api.md §1.3.

### TRM-06 — Aplicar importação do ETP
`POST /api/v1/terms/{id}/import-etp` · **Permissão:** `TERM_UPDATE` + POL-02 · **Story:** US-037

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` obrigatório
- **Parâmetros:** `id` (path, uuid, obrigatório) — TR
- **Request:**
```ts
{
  importToken: string;                 // emitido por TRM-05; 15 min
  sections: string[];                  // ≥1 entre sections/fields/items
  fields: string[];
  copyItems: boolean;                   // padrão true
  overwriteExisting?: boolean;          // padrão false; só com copyItems
  confirmReplaceValueSource?: boolean;  // condicional (RN-TR-22), só após aviso
}
```
- **Response:** `200 { data: { term: TermOfReference, sectionsImported: string[], itemsImported: number } }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | TR inexistente/outro tenant |
| 409 | `DOCUMENT_NOT_EDITABLE` | TR fora de `DRAFT`/`RETURNED` |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | Requisição idêntica em processamento |
| 410 | `IMPORT_PREVIEW_EXPIRED` | Token expirado ou ETP/TR mudaram desde a prévia |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente (TR mudou) |
| 422 | `VALIDATION_ERROR` | Nenhuma seleção enviada; `importToken` ausente/inválido/de outro TR; substituir origem do valor sem confirmação (`CONDITIONAL_REQUIRED`) |
| 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | Tipo TR não permitido na etapa atual |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave, corpo diferente |

- **Efeitos:** Eventos: `TermImportedFromEtp` (`term.imported_from_etp`) — `termId`, `etpId`, `etpVersionId`, `sectionsImported[]`, `itemsImported`; `DocumentVersionCreated` (`document.version_created.tr`), `reason = IMPORT`, mesmo commit. Auditoria: `term.import_etp` (`DATA_CHANGE`) — `changes`: chaves de seções/campos/itens alterados (sem conteúdo); `metadata`: `etpId`, `etpVersionId`, `itemsImported`, `idempotencyKey`. Timeline: `TERM_IMPORTED_FROM_ETP`.
- **Notas:** o campo calculado `etpChangedSinceImport` (ver TRM-03) é a forma de a UI detectar nova defasagem após esta importação (RN-TR-24). **Implementação (US-037):** a resposta traz também `fieldsImported[]` e `documentVersion` (`id`, `versionNumber` da versão `IMPORT`); `ETag` = nova versão do TR. Seção fora da prévia → 422 `NOT_ALLOWED` em `sections`; conteúdo acima do limite da seção → 422 `TOO_LONG` em `sections`; `priceResearchId` sozinho sobre valor vinculado a outra pesquisa → 422 `NOT_ALLOWED` em `fields`; campo mascarado (POL-09) é ignorado (FA-05). Itens: `itemsImported` conta as linhas do ETP gravadas no TR (as iguais contam; as especificadas sem `overwriteExisting` não). Seções `APPEND` repetem a referência a cada importação.
