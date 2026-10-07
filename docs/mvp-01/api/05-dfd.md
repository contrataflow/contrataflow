# DFD (`dfd`)

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2.

| ID | Método | Rota | Permissão | Story |
|---|---|---|---|---|
| DFD-01 | GET | `/processes/{id}/dfds` | `PROCESS_VIEW` | US-014 |
| DFD-02 | POST | `/processes/{id}/dfds` | `DFD_CREATE` + POL-02 | US-014 |
| DFD-03 | GET | `/dfds/{id}` | `PROCESS_VIEW` | US-014, US-015 |
| DFD-04 | PATCH | `/dfds/{id}` | `DFD_UPDATE` + POL-02 | US-015 |
| DFD-05 | POST | `/dfds/{id}/duplicate` | `DFD_CREATE` (+ `PROCESS_CREATE` se novo processo) | US-018 |

Seções, itens, validação, pré-visualização e finalização do DFD usam os endpoints genéricos de documento (`DOC-05`..`DOC-23`) e de itens do processo (`PRC-14`) com o `documentId`/`processId` do DFD — fora do escopo deste arquivo.

---

### DFD-01 — Listar DFDs do processo
`GET /api/v1/processes/{id}/dfds` · **Permissão:** `PROCESS_VIEW` · **Story:** US-014

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório) — processo
- **Request:** —
- **Response:** `200 { data: Dfd[] }` (0 ou 1 ativo + cancelados, sem ordenação documentada)
```ts
DfdSummary {
  id: string;
  documentId: string;
  code: string;      // RN-DFD-04
  status: string;     // Document.status
  requestDate: string; // YYYY-MM-DD
  priority: string;   // Priority
  version: number;
}
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `NOT_FOUND` | Processo inexistente, de outro tenant ou não visível |

- **Efeitos:** —
- **Notas:** Singleton por processo (0 ou 1 DFD ativo); demais registros são cancelados (histórico).

### DFD-02 — Criar DFD a partir de template
`POST /api/v1/processes/{id}/dfds` · **Permissão:** `DFD_CREATE` + POL-02 · **Story:** US-014

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório) — processo
- **Request:**
```ts
{
  templateId?: string; // uuid; ativo, tipo DFD, versão publicada; padrão: template padrão do tipo
}
```
- **Response:** `201 { data: Dfd }` + `Location` + `ETag: "1"`
```ts
Dfd {
  id: string; documentId: string; code: string; status: string; // DRAFT
  requestDate: string; requestingDepartmentId: string; responsibleId: string;
  objectSummary: string; priority: string; pcaStatus: string; // PcaStatus
  wizardStep: string; completedSteps: string[]; version: number;
}
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Falta `DFD_CREATE` no escopo |
| 403 | `NOT_PROCESS_CUSTODIAN` | Usuário sem custódia do processo |
| 404 | `NOT_FOUND` | Processo inexistente/outro tenant |
| 409 | `DOCUMENT_ALREADY_EXISTS` | Já existe DFD ativo no processo |
| 409 | `INVALID_PROCESS_STATUS` | Processo suspenso, cancelado ou concluído |
| 422 | `VALIDATION_ERROR` | `templateId` inexistente/inativo/outro tipo/outro tenant (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | Etapa atual não permite DFD |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave com corpo diferente |

- **Efeitos:** Eventos: `DocumentCreated` (`DFDCreated`) (`document.created.dfd`) — `documentId`, `documentTypeCode = DFD`, `kind = STRUCTURED`, `code`, `title`, `templateVersionId`. Auditoria: `document.create` (`DATA_CHANGE`). Timeline: `DOCUMENT_CREATED`.
- **Notas:** campos completos do cabeçalho (data, setor, responsável, objeto, prioridade, PCA) seguem RN-DFD-09 a RN-DFD-16 e são preenchidos via DFD-04 no wizard.

### DFD-03 — Obter DFD
`GET /api/v1/dfds/{id}` · **Permissão:** `PROCESS_VIEW` · **Story:** US-014, US-015

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório) — DFD
- **Request:** —
- **Response:** `200 { data: Dfd, meta: { allowedActions } }` + `ETag: "<dfd.version>"` (schema de DFD-02, acrescido de `draftContent.sections[k].revision` por seção, US-015)
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `DFD_NOT_FOUND` | Inexistente, outro tenant ou não visível |

- **Efeitos:** —
- **Notas:** —

### DFD-04 — Atualizar cabeçalho do DFD
`PATCH /api/v1/dfds/{id}` · **Permissão:** `DFD_UPDATE` + POL-02 · **Story:** US-015

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório (`"<version>"`, RN-DFD-27)
- **Parâmetros:** `id` (path, uuid, obrigatório)
- **Request:** campos parciais do cabeçalho (RN-DFD-09 a RN-DFD-16):
```ts
{
  requestDate?: string;             // ≤ hoje
  requestingDepartmentId?: string;  // na secretaria solicitante do processo
  responsibleId?: string;           // vínculo ativo
  objectSummary?: string;           // 10–2000
  priority?: string;                // Priority
  expectedDate?: string;            // ≥ requestDate; ≥ hoje
  estimatedValue?: string | null;   // decimal ≥0, 2 casas; POL-09
  pcaStatus?: string;                // PcaStatus
  pcaYear?: number;                  // condicional (PLANNED)
  pcaItemCode?: string;              // ≤60
  pcaJustification?: string;         // ≥20; condicional (NOT_PLANNED)
  wizardStep?: string;               // DfdWizardStep
  completedSteps?: string[];
}
```
- **Response:** `200 { data: Dfd }` + `ETag`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `NOT_PROCESS_CUSTODIAN` | Sem custódia nem participação |
| 409 | `DOCUMENT_NOT_EDITABLE` | DFD fora de `DRAFT`/`RETURNED` |
| 409 | `INVALID_PROCESS_STATUS` | Processo suspenso/cancelado/concluído |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | Campo inválido (ver regras acima); campo não editável → `NOT_ALLOWED` |

- **Efeitos:** Eventos: — (não emite evento de domínio). Auditoria: `document.draft_update` (`DATA_CHANGE`) — coalescida (RN-DFD-35) para texto; imediata para campos estruturados.
- **Notas:** usado também para persistir `wizardStep`/`completedSteps` do wizard (RN-DFD-34). `If-Match` ausente → 428 `PRECONDITION_REQUIRED` (genérico, api.md §1.3).

### DFD-05 — Duplicar DFD
`POST /api/v1/dfds/{id}/duplicate` · **Permissão:** `DFD_CREATE` (+ `PROCESS_CREATE` se destino for novo processo) · **Story:** US-018

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** `id` (path, uuid, obrigatório) — DFD de origem
- **Request:**
```ts
{
  targetType: "NEW_PROCESS" | "EXISTING_PROCESS"; // RN-DFD-72/73
  targetProcessId?: string; // obrigatório se EXISTING_PROCESS
}
```
- **Response:** `201 { data: Dfd }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Falta `DFD_CREATE` (ou `PROCESS_CREATE`, se novo processo) |
| 409 | `DOCUMENT_ALREADY_EXISTS` | Processo destino já tem DFD ativo |
| 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | Etapa do destino não permite DFD |
| 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | `targetProcessId` de outro tenant/inexistente |

- **Efeitos:** Eventos: `ProcessCreated` (se destino for novo processo, via US-011); `DocumentCreated` (`DFDCreated`) sempre; `ProcessItemsChanged` quando itens são clonados (RN-DFD-75). Auditoria: `document.duplicate` (`DATA_CHANGE`) — `metadata.sourceDocumentId`, `targetProcessId`, `targetType`.
- **Notas:** usa `PRC-14` (criação de item) internamente, por item clonado, sem chamada direta do front.
