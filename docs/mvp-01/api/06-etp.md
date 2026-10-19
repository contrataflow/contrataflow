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
- **Response:** `200 { data: Etp[], meta: { importableDfd } }` (0 ou 1 ativo + os cancelados, singleton)
```ts
EtpSummary { id: string; documentId: string; code: string; status: string; conclusion: string; version: number; }
// DFD elegível para a importação do ETP-02 (RN-ETP-04 — a MESMA regra da criação): o "Importar
// dados do DFD 0005/2026?" da US-019 (passo 2). `null` quando não há DFD não cancelado em
// FINALIZED/APPROVED com versão (FA-02). Decidido na US-019 (2026-10-18): o servidor resolve a
// elegibilidade numa chamada só, em vez de o front combinar DOC-01 e DOC-03.
ImportableDfd {
  documentId: string; code: string | null; status: "FINALIZED" | "APPROVED";
  versionId: string; versionNumber: number; // approvedVersionId, senão currentVersionId
  objectSummary: string; itemsCount: number; pcaStatus: "PLANNED" | "NOT_PLANNED" | "NOT_APPLICABLE";
}
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
- **Response:** `201 { data: Etp, meta: { allowedActions } }` + `Location: /api/v1/etps/{id}` + `ETag: "1"`
```ts
Etp {
  id: string; // = documentId (CHECK etps_id_is_document — como DFD e pesquisa de preços)
  documentId: string; processId: string; code: string; title: string; status: string;
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
- **Notas:** a importação copia dados do DFD; não duplica o documento. Fonte: o snapshot da versão de origem (`approvedVersionId`, senão `currentVersionId`) — objeto (`header.objectSummary`) + seção `JUSTIFICATION` → `NEED_DESCRIPTION`; situação no PCA (`header.pcaStatus`/`pcaYear`/`pcaItemCode`/`pcaJustification`) → `PCA_ALIGNMENT`; `collections.items` → `DocumentItem` do ETP (mesmo `processItemId` e `quantity`). Criação com custódia OU participação `COLLABORATOR`/`CONSULTANT` (RN-ETP-07 — diferente do DFD, em que a participação não cria). Sem custódia nem participação → 403 `PERMISSION_DENIED` (`access.denied` com `reasonCode = POL-02`); processo fora de `DRAFT`/`IN_PROGRESS`/`RETURNED` → 409 `DOCUMENT_NOT_EDITABLE` (V-03 da US-019, no lugar do `INVALID_PROCESS_STATUS` genérico).

### ETP-03 — Obter ETP
`GET /api/v1/etps/{id}` · **Permissão:** `PROCESS_VIEW` (+ POL-09) · **Story:** US-020

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: EtpDetail, meta: EtpDetailMeta }` + `ETag: "<version do ETP>"` + `Cache-Control: no-store`
```ts
EtpDetail = Etp & { // o Etp do ETP-02 (cabeçalho + resumo do documento: code, status, documentVersion, itemsCount)
  recommendedAlternativeId: string | null; parcelingDecision: ParcelingDecision | null;
  estimatedValueSource: "MANUAL" | "PRICE_RESEARCH" | null;
  estimatedTotalValue: string | null; estimatedTotalValueMasked: boolean; // POL-09 (api.md §1.4)
  priceResearchId: string | null;
  draftRevision: number;
  draftContent: { sections: Record<string, { state; content; justification; revision; updatedAt; updatedById }> };
  // `revision` de cada seção = o `If-Match: "s<revision>"` do DOC-05 (US-020 · RN-ETP-10)
}
// Decidido na US-020 (2026-10-18): as seções da versão do template fixada no documento vêm no
// `meta` (como no DFD-03), porque o TPL-07 exige TEMPLATE_VIEW. `allowedActions` sem UPDATE =
// SCR-008 em modo somente leitura (sem ETP_UPDATE + POL-02, ou ETP fora de DRAFT/RETURNED).
EtpDetailMeta {
  allowedActions: DocumentAction[];
  template: { versionId: string; versionNumber: number; sections: EtpTemplateSection[] } | null;
}
EtpTemplateSection {
  key: string; title: string; order: number; requirement: SectionRequirement;
  helpText: string | null; legalBasis: string | null; minChars: number | null; maxChars: number;
  render: SectionRender; allowNarrative: boolean; // RN-ETP-12
}
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `NOT_FOUND` | Inexistente/outro tenant/não visível ("Documento não encontrado.") |

- **Efeitos:** — (leitura sem auditoria nem eventos)
- **Notas:** valores sigilosos seguem api.md §1.4 (sufixo `Masked`). A edição das seções usa o DOC-05 genérico (autosave, "não se aplica" com justificativa ≥ 20 caracteres — "Explique por que esta seção não se aplica (mín. 20 caracteres)."); as pendências da navegação lateral vêm do DOC-08, sem bloquear a edição (RN-ETP-13). Seções com quadro estruturado (RN-ETP-12): `render` `ITEMS_TABLE`/`ALTERNATIVES_TABLE`/`RISK_LIST`, ou a seção `TEXT` com a chave `ESTIMATES`/`ALTERNATIVES`/`RISKS` (a biblioteca padrão semeia as 16 seções como `TEXT`) — itens pelo DOC-06, riscos pelo RSK-01, alternativas pelo ETP-05 (US-021).

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
- **Implementação (US-022, 2026-10-19):** nesta story o corpo aceita só `estimatedValueSource`/`estimatedTotalValue`/`priceResearchId` (`etpUpdateSchema` estrito; `conclusion`/`parcelingDecision` entram com a US-023). `estimatedValueSource` é obrigatório (422 `REQUIRED`); `MANUAL` + `priceResearchId` e `PRICE_RESEARCH` + `estimatedTotalValue` → 422 `NOT_ALLOWED` (valor vinculado é somente leitura). A pesquisa é resolvida pela porta `PriceResearchSummaryRegistry.linkOf` (inexistente, de outro processo ou de outro tenant → `REFERENCE_NOT_FOUND`; cancelada → `REFERENCE_INACTIVE`) e o valor gravado é a cópia do `totalEstimatedValue` (`null` enquanto a pesquisa não tem cálculo — FA-03). `If-Match` = `version` do ETP (o `ETag` do ETP-03); a sincronização do worker (RN-ETP-29/31 — `EtpEstimateSynchronizer`, events.md §3) também sobe a versão. Sem POL-09 em processo sigiloso, 403 (`reasonCode = POL-09`), como nas alternativas. Resposta: o `EtpDetail` + `EtpDetailMeta` do ETP-03. Reenvio igual = 200 sem versão nova nem auditoria. Auditoria `document.draft_update` (`metadata.target = HEADER`, `fields`, `estimatedValueSource`, `priceResearchId`; valor `[MASKED]` em processo sigiloso); a sincronização grava a mesma ação com ator `SYSTEM` e `metadata.trigger` (`recalculated`/`completed`/`canceled`), sem valores.

### ETP-05 — Listar alternativas do ETP
`GET /api/v1/etps/{id}/alternatives` · **Permissão:** `PROCESS_VIEW` (+ POL-09) · **Story:** US-021

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório) — ETP
- **Request:** —
- **Response:** `200 { data: EtpAlternative[], meta }` ordenado por `sortOrder` (empate: criação, id; sem paginação)
```ts
EtpAlternative {
  id: string; etpId: string; processId: string; name: string; description: object;
  advantages: object | null; disadvantages: object | null;
  estimatedCost: string | null; estimatedCostMasked: boolean; riskLevel: string | null;
  observations: string | null; sortOrder: number;
  decision: "UNDER_ANALYSIS" | "RECOMMENDED" | "DISCARDED"; decisionJustification: string | null;
  createdAt: string; updatedAt: string; version: number;   // `version` = ETag/If-Match de ETP-07/08/09
}
meta: {
  canManage: boolean;                       // ETP_UPDATE + POL-02 e o ETP ativo em DRAFT/RETURNED
  recommendedAlternativeId: string | null;  // Etp.recommendedAlternativeId
  estimatedCostMasked: boolean;             // POL-09 para este usuário
}
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `NOT_FOUND` | ETP inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** `Cache-Control: no-store` (`meta.canManage` é por usuário). Sem `meta.canManage`, a seção "Alternativas" da SCR-008 abre somente leitura (Permissão · FA-05 da US-021).

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

- **Efeitos:** Auditoria: `etp.alternative_create` (`DATA_CHANGE`) — `changes`: campos não sensíveis; textos longos como hash + tamanho; `estimatedCost` só como `"[sigiloso]"` (POL-09).
- **Notas:** não há evento de domínio na criação; só na decisão `RECOMMENDED` (ver ETP-09). `201` com `Location: /api/v1/etp-alternatives/{id}` e `ETag: "1"`. Erros da POL-02 estendida às coleções tipadas (os mesmos de ETP-07/08/09): 409 `DOCUMENT_NOT_EDITABLE` (ETP fora de `DRAFT`/`RETURNED` ou cancelado), 409 `INVALID_PROCESS_STATUS`, 422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`. Em processo sigiloso, quem não atende a POL-09 recebe o custo mascarado e não pode enviar `estimatedCost` (403 `PERMISSION_DENIED`, "Você não pode alterar o custo estimado deste processo sigiloso." — decisão da US-021, 2026-10-18: evita gravar às cegas ou apagar um valor que a pessoa não vê).

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
- **Notas:** `null` limpa os opcionais; `name`/`description` não aceitam `null`. A decisão só muda pelo ETP-09 (`decision` aqui → 422 `NOT_ALLOWED`). Sem mudança efetiva → `200` com a mesma versão e sem auditoria. 412 traz `currentVersion`; sem `If-Match` → 428.

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
- **Notas:** a excluída sai das leituras e da unicidade de nome, mas continua auditável (e nomeável na timeline).

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
- **Notas:** o 409 `RECOMMENDED_ALTERNATIVE_EXISTS` traz `meta.recommendedAlternativeId`. Com `replaceRecommended: true`, a antiga volta a `UNDER_ANALYSIS` (a justificativa dela é preservada como histórico) antes da nova, na mesma transação. Recomendar grava `Etp.recommendedAlternativeId` (a versão do ETP sobe); tirar a recomendada da decisão limpa o campo. Repetir a mesma decisão com a mesma justificativa → `200` sem auditoria nem evento. Concorrência: o documento ETP fica travado na transação (decisões simultâneas se enfileiram) e o índice único parcial é a última barreira — a perdedora recebe o mesmo 409.
