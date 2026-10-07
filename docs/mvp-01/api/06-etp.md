# ETP (`etp`)

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2.

| ID | Método | Rota | Permissão | Story |
|---|---|---|---|---|
| ETP-01 | GET | `/processes/{id}/etps` | `PROCESS_VIEW` | US-019 |
| ETP-02 | POST | `/processes/{id}/etps` | `ETP_CREATE` + POL-02 | US-019 |
| ETP-03 | GET | `/etps/{id}` | `PROCESS_VIEW` (+ POL-09) | US-020 |
| ETP-04 | PATCH | `/etps/{id}` | `ETP_UPDATE` + POL-02 | US-022, US-023 |
| ETP-05 | GET | `/etps/{id}/alternatives` | `PROCESS_VIEW` (+ POL-09) | US-021 |
| ETP-06 | POST | `/etps/{id}/alternatives` | `ETP_UPDATE` + POL-02 | US-021 |
| ETP-07 | PATCH | `/etp-alternatives/{alternativeId}` | `ETP_UPDATE` + POL-02 | US-021 |
| ETP-08 | DELETE | `/etp-alternatives/{alternativeId}` | `ETP_UPDATE` + POL-02 | US-021 |
| ETP-09 | POST | `/etp-alternatives/{alternativeId}/decide` | `ETP_UPDATE` + POL-02 | US-021 |

Seções, validação, submissão/finalização e versões do ETP usam os endpoints genéricos de documento (`DOC-05`..`DOC-23`) com o `documentId` do ETP — fora do escopo deste arquivo.

---

### ETP-01 — Listar ETPs do processo
`GET /api/v1/processes/{id}/etps` · **Permissão:** `PROCESS_VIEW` · **Story:** US-019

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório) — processo
- **Request:** —
- **Response:** `200 { data: Etp[] }` (0 ou 1, singleton)
```ts
EtpSummary { id: string; documentId: string; code: string; status: string; conclusion: string; version: number; }
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `PROCESS_VIEW` |
| 404 | `NOT_FOUND` | Processo inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** —

### ETP-02 — Criar ETP (com importação opcional do DFD)
`POST /api/v1/processes/{id}/etps` · **Permissão:** `ETP_CREATE` + POL-02 · **Story:** US-019

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório) — processo
- **Request:**
```ts
{ importFromDfd?: boolean; } // true somente quando há DFD finalizado elegível (RN-ETP-04)
```
- **Response:** `201 { data: Etp }`
```ts
Etp {
  id: string; documentId: string; code: string; status: string;
  conclusion: "PENDING" | "VIABLE" | "NOT_VIABLE"; // EtpConclusion
  importedFromDfdVersionId?: string | null; // RN-ETP-04/05
  responsibleId: string; // RN-ETP-08, criador
  version: number;
}
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão/escopo |
| 404 | `NOT_FOUND` | Processo inexistente/outro tenant |
| 409 | `DOCUMENT_ALREADY_EXISTS` | Já existe ETP ativo no processo |
| 409 | `DOCUMENT_NOT_EDITABLE` | Processo em status não editável |
| 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | Etapa não permite o tipo |
| 422 | `VALIDATION_ERROR` (`NOT_ALLOWED` em `importFromDfd`) | `importFromDfd = true` sem DFD elegível |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave, corpo diferente |

- **Efeitos:** Eventos: `ETPCreated` (`DocumentCreated`) (`document.created.etp`) — `documentId`, `documentTypeCode = ETP`, `kind`; `sourceDocumentId` nulo. Auditoria: `document.create` (`DATA_CHANGE`) — `changes`: `documentTypeCode`, `importedFromDfdVersionId`; `metadata`: `code`, `idempotencyKey`.
- **Notas:** a importação copia dados do DFD; não duplica o documento.

### ETP-03 — Obter ETP
`GET /api/v1/etps/{id}` · **Permissão:** `PROCESS_VIEW` (+ POL-09) · **Story:** US-020

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: Etp }` + `ETag` — cabeçalho, `draftContent.sections[key]` (`content`, `state`, `justification`, `revision`), `conclusion`, `parcelingDecision`, `estimatedTotalValue`/`estimatedTotalValueMasked`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `NOT_FOUND` | Inexistente/outro tenant/não visível |

- **Efeitos:** —
- **Notas:** valores sigilosos seguem api.md §1.4 (sufixo `Masked`).

### ETP-04 — Atualizar ETP (estimativas e conclusão)
`PATCH /api/v1/etps/{id}` · **Permissão:** `ETP_UPDATE` + POL-02 · **Story:** US-022, US-023

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:**
```ts
{
  estimatedValueSource?: "MANUAL" | "PRICE_RESEARCH"; // RN-ETP-28
  estimatedTotalValue?: string;      // decimal ≥0, 2 casas; condicional MANUAL; somente leitura se PRICE_RESEARCH
  priceResearchId?: string;          // condicional PRICE_RESEARCH; pesquisa não cancelada do mesmo processo
  conclusion?: "VIABLE" | "NOT_VIABLE"; // RN-ETP-34/35
  parcelingDecision?: string;        // ParcelingDecision; RN-ETP-34
}
```
- **Response:** `200 { data: Etp }` com `estimatedTotalValue`, `estimatedTotalValueMasked`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 409 | `DOCUMENT_NOT_EDITABLE` | ETP fora de `DRAFT`/`RETURNED` |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | `priceResearchId` inválido (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`); `estimatedTotalValue` inválido (`INVALID_DECIMAL`) |

- **Efeitos:** Eventos: — (nenhum evento próprio; consome `PriceResearchRecalculated`/`PriceResearchCompleted` para sincronizar `estimatedTotalValue`, RN-ETP-29). Auditoria: `document.items_update` (quantidades/memória) e `document.draft_update` (`estimatedValueSource`, `priceResearchId`, `conclusion`, `parcelingDecision`).
- **Notas:** conclusão exige RN-ETP-34/35 (alternativa recomendada e valor estimado para `VIABLE`; aviso reconhecido para `NOT_VIABLE` via `DOC-10`, fora deste arquivo). `If-Match` ausente → 428 (genérico, api.md §1.3).

### ETP-05 — Listar alternativas do ETP
`GET /api/v1/etps/{id}/alternatives` · **Permissão:** `PROCESS_VIEW` (+ POL-09) · **Story:** US-021

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório) — ETP
- **Request:** —
- **Response:** `200 { data: EtpAlternative[] }` ordenado por `sortOrder` (sem paginação/ordenação adicional documentada)
```ts
EtpAlternative {
  id: string; name: string; description: object; advantages?: object; disadvantages?: object;
  estimatedCost?: string | null; estimatedCostMasked?: boolean; riskLevel?: string;
  observations?: string; sortOrder: number;
  decision: "UNDER_ANALYSIS" | "RECOMMENDED" | "DISCARDED"; decisionJustification?: string;
  version: number;
}
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `NOT_FOUND` | ETP inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** —

### ETP-06 — Criar alternativa de solução
`POST /api/v1/etps/{id}/alternatives` · **Permissão:** `ETP_UPDATE` + POL-02 · **Story:** US-021

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:**
```ts
{
  name: string;              // ≤150, único no ETP (case-insensitive)
  description: object;       // rich text, obrigatório
  advantages?: object;       // rich text
  disadvantages?: object;    // rich text
  estimatedCost?: string;    // decimal ≥0, 2 casas; POL-09
  riskLevel?: string;        // RiskLevel
  observations?: string;
}
```
- **Response:** `201 { data: EtpAlternative }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | ETP inexistente/outro tenant |
| 422 | `VALIDATION_ERROR` | `name` ausente/duplicado (`DUPLICATE_IN_LIST`)/>150; `description` ausente (`REQUIRED`); `estimatedCost` inválido (`INVALID_DECIMAL`) |

- **Efeitos:** Auditoria: `etp.alternative_create` (`DATA_CHANGE`) — `changes`: campos não sensíveis; textos longos como hash + tamanho.
- **Notas:** não há evento de domínio na criação; só na decisão `RECOMMENDED` (ver ETP-09).

### ETP-07 — Atualizar alternativa de solução
`PATCH /api/v1/etp-alternatives/{alternativeId}` · **Permissão:** `ETP_UPDATE` + POL-02 · **Story:** US-021

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `alternativeId` (path, uuid, obrigatório)
- **Request:** campos de ETP-06 (parciais) + `sortOrder?: number`
- **Response:** `200 { data: EtpAlternative }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 409 | `DOCUMENT_NOT_EDITABLE` | ETP fora de `DRAFT`/`RETURNED` |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | Ver ETP-06 |

- **Efeitos:** Auditoria: `etp.alternative_update` (`DATA_CHANGE`) — `changes`: campos alterados.
- **Notas:** —

### ETP-08 — Excluir alternativa de solução
`DELETE /api/v1/etp-alternatives/{alternativeId}` · **Permissão:** `ETP_UPDATE` + POL-02 · **Story:** US-021

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `alternativeId` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `204` sem corpo
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 409 | `DOCUMENT_NOT_EDITABLE` | ETP fora de `DRAFT`/`RETURNED` |
| 409 | `INVALID_STATE` | Exclusão da alternativa `RECOMMENDED` corrente |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Auditoria: `etp.alternative_delete` (`DATA_CHANGE`) — exclusão lógica; `metadata.alternativeId`.
- **Notas:** —

### ETP-09 — Decidir alternativa (recomendar/descartar)
`POST /api/v1/etp-alternatives/{alternativeId}/decide` · **Permissão:** `ETP_UPDATE` + POL-02 · **Story:** US-021

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** `alternativeId` (path, uuid, obrigatório)
- **Request:**
```ts
{
  decision: "UNDER_ANALYSIS" | "RECOMMENDED" | "DISCARDED";
  decisionJustification: string;      // ≥20; condicional (RN-ETP-19) para RECOMMENDED/DISCARDED
  replaceRecommended?: boolean;       // só após aviso de RECOMMENDED_ALTERNATIVE_EXISTS
}
```
- **Response:** `200 { data: EtpAlternative }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 409 | `DOCUMENT_NOT_EDITABLE` | ETP fora de `DRAFT`/`RETURNED` |
| 409 | `RECOMMENDED_ALTERNATIVE_EXISTS` | Já existe alternativa recomendada sem `replaceRecommended` |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`/`TOO_SHORT`) | Justificativa ausente/curta para `RECOMMENDED`/`DISCARDED` |

- **Efeitos:** Eventos: `EtpAlternativeRecommended` (`etp.alternative_recommended`), quando `RECOMMENDED` confirmado — `etpId`, `alternativeId`, `previousAlternativeId?`. Auditoria: `etp.alternative_decide` (`DATA_CHANGE`) — `metadata`: `decision`, `replaceRecommended`, `previousAlternativeId?`.
- **Notas:** —
