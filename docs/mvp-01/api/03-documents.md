# Documentos genéricos, versões e renderização

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2.

## Catálogo de endpoints

| ID | Método | Rota | Permissão | Story |
|---|---|---|---|---|
| DOC-01 | GET | `/processes/{id}/documents` | `PROCESS_VIEW` | US-062 |
| DOC-02 | POST | `/processes/{id}/documents` | `DOCUMENT_CREATE` + POL-02 (Idem.) | US-063, US-064 |
| DOC-03 | GET | `/documents/{id}` | `PROCESS_VIEW` (+POL-09) | US-062 |
| DOC-04 | PATCH | `/documents/{id}` | permissão de edição do tipo + POL-02 (IM) | US-065 |
| DOC-05 | PUT | `/documents/{id}/sections/{sectionKey}` | permissão de edição do tipo + POL-02 (IM de seção) | US-015, US-020, US-036, US-063 |
| DOC-06 | GET | `/documents/{id}/items` | `PROCESS_VIEW` | US-014, US-022, US-038 |
| DOC-07 | PUT | `/documents/{id}/items` | permissão de edição do tipo + POL-02 (IM) | US-014, US-022, US-038 |
| DOC-08 | GET | `/documents/{id}/validation` | `PROCESS_VIEW` | US-065 |
| DOC-09 | POST | `/documents/{id}/submit` | permissão de submissão do tipo + POL-02 (IM, Idem.) | US-065 |
| DOC-10 | POST | `/documents/{id}/finalize` | permissão de submissão do tipo + POL-02 (IM, Idem.) | US-065 |
| DOC-11 | POST | `/documents/{id}/withdraw` | permissão de submissão do tipo (IM) | US-053 |
| DOC-12 | POST | `/documents/{id}/reopen` | `DOCUMENT_REOPEN` + POL-11 (IM) | US-065 |
| DOC-13 | POST | `/documents/{id}/cancel` | `DOCUMENT_CANCEL` + custódia (IM) | US-065 |
| DOC-14 | DELETE | `/documents/{id}` | permissão de edição do tipo + nunca submetido (IM) | US-065 |
| DOC-15 | GET | `/documents/{id}/versions` | `PROCESS_VIEW` | US-066 |
| DOC-16 | POST | `/documents/{id}/versions` | permissão de edição do tipo + POL-02 (Idem.) | US-066 |
| DOC-17 | GET | `/document-versions/{versionId}` | `PROCESS_VIEW` (+POL-09) | US-066 |
| DOC-18 | GET | `/documents/{id}/versions/compare?from=&to=` | `PROCESS_VIEW` (+POL-09) | US-066 |
| DOC-19 | POST | `/documents/{id}/upload-version` | `DOCUMENT_UPDATE` + POL-02 (IM, Idem.) | US-064 |
| DOC-20 | POST | `/documents/{id}/preview` | `PROCESS_VIEW` | US-067 |
| DOC-21 | POST | `/document-versions/{versionId}/renditions` | `PROCESS_VIEW` (+POL-09) | US-067 |
| DOC-22 | GET | `/document-renditions/{renditionId}` | `PROCESS_VIEW` (+POL-09) | US-067 |
| DOC-23 | GET | `/document-renditions/{renditionId}/download` | `PROCESS_VIEW` (+POL-09) | US-067 |
| DOC-24 | PUT | `/documents/{id}/presence` | permissão de edição do tipo + POL-02 | US-070 |
| DOC-25 | DELETE | `/documents/{id}/presence` | sessão autenticada (própria presença) | US-070 |
| DOC-26 | POST | `/documents/{id}/ai-apply` | permissão de edição do tipo + POL-02 (solicitante da geração) | US-117, US-121 |
| DOC-27 | POST | `/documents/{id}/ai-review` | permissão de edição do tipo + POL-02 | US-122 |
| DTY-01 | GET | `/document-types` | impl. | US-061 |
| DTY-02 | POST | `/document-types` | `DOCUMENT_TYPE_MANAGE` | US-061 |
| DTY-03 | PATCH | `/document-types/{id}` | `DOCUMENT_TYPE_MANAGE` (IM) | US-061 |
| DTY-04 | PUT | `/document-types/{id}/default-template` | `TEMPLATE_PUBLISH` (IM) | US-108 |

## Especificação dos endpoints

### DOC-01 — Listar documentos do processo
`GET /api/v1/processes/{id}/documents` · **Permissão:** `PROCESS_VIEW` · **Story:** US-062
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório) — id do processo. Query (filtros, api.md §1.2): `type?` (lista de `documentTypeId`, OU por vírgula), `status?` (lista de `DocumentStatus`), `responsibleId?` (uuid), `q?` (texto, mín. 2 caracteres). Sem paginação (lista do processo; escopo tipicamente pequeno) nem ordenação documentadas no extrato.
- **Request:** —
- **Response:** `200 { data: Document[] }`. Cada item inclui `documentType` (resumo), `pendingApprovalId`, `confidentiality`, `meta.allowedActions`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `PROCESS_VIEW` no escopo |
  | 404 | `PROCESS_NOT_FOUND` | Processo inexistente, de outro tenant ou não visível |
  | 422 | `VALIDATION_ERROR` | `status`/`type` fora do enum ou do catálogo do tenant |
- **Efeitos:** —
- **Notas:** Somente leitura; a criação de documentos (que altera esta lista) é feita por `DOC-02` e pelos endpoints tipados de DFD/ETP/TR (fora desta seção). `DocumentStatus` = `DRAFT`\|`IN_REVIEW`\|`RETURNED`\|`FINALIZED`\|`APPROVED`\|`REJECTED`\|`CANCELED` (entities.md).
- **Implementação (US-062):**
  - **Item:** `ProcessDocument` = `Document` **sem** `draftContent` (o painel nunca abre o conteúdo; DOC-03 traz) + `responsibleName` (nome exibido do responsável) + `summary` (resumo do módulo tipado — o mesmo `typedSummary` do `DocumentFinalized`; `null` nos livres/externos) + `meta.allowedActions` (mesma função pura do DOC-03 — RN-DOC-18). Inclui cancelados (RN-DOC-19); ordem por `sortOrder` do tipo, nome do tipo e título (RN-DOC-13).
  - **POL-09 no resumo (RN-DOC-17):** documento `RESTRICTED` (ou processo com orçamento sigiloso) e usuário sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo nem a custódia → campos monetários do `summary` = `null` + `<campo>Masked: true`.
  - **`meta` da resposta:** `{ currentStage: { key, name, documentTypeCodes } | null, creatableTypeIds: uuid[], pendingTypeIds: uuid[] }` — `creatableTypeIds` = menu "Criar documento" (tipo ativo ∩ etapa, permissão de criação do tipo — `DOCUMENT_CREATE` nos livres/externos; `DFD_CREATE`/`ETP_CREATE`/`TERM_CREATE`/`RISK_MANAGE`/`PRICE_RESEARCH_CREATE` nos tipados — cobrindo o processo **e** custódia ou participação `COLLABORATOR`/`CONSULTANT` (POL-02, a mesma regra que o DOC-02 aplica), singular sem documento não cancelado); `pendingTypeIds` = singulares da etapa ainda "Não iniciado". Processo fora de `DRAFT`/`IN_PROGRESS`/`RETURNED` → ambos vazios. Independem dos filtros.
  - **Filtros:** `type`/`status` em lista (vírgula ou repetição). Erro aponta o parâmetro inteiro: `status` fora do enum → `errors[] = { field: 'status', code: 'INVALID_ENUM' }`; `type` com id fora do catálogo do tenant (inclusive inativos) → `{ field: 'type', code: 'REFERENCE_NOT_FOUND' }`; `q` com 1 caractere → 422 (o front não chama — V-02). A SCR-006 filtra a lista já carregada (RN-DOC-20).
  - **404:** o guard de `PROCESS_VIEW` (escopo do processo) responde `PROCESS_NOT_FOUND` com o mesmo corpo para inexistente, de outro tenant e não visível, auditando `access.denied` (`reasonCode = PROCESS_VIEW`).

### DOC-02 — Criar documento no processo
`POST /api/v1/processes/{id}/documents` · **Permissão:** `DOCUMENT_CREATE` + POL-02 (escopo do tipo de documento) · **Story:** US-063, US-064
- **Cabeçalhos:** `Idempotency-Key` obrigatório; `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório) — id do processo.
- **Request:** `{ documentTypeId: string (uuid, obrigatório); title: string (obrigatório, 5–250 caracteres); responsibleId?: string (uuid) }`. `documentTypeId` deve ser de um tipo `FREE_TEXT` ou `UPLOADED` ativo e permitido na etapa atual; `responsibleId` documentado apenas para `FREE_TEXT` (US-063) — comportamento para `UPLOADED` não detalhado no extrato (a definir na implementação).
- **Response:** `201 { data: Document }` com `code?`, `status: 'DRAFT'`, `version`; para `FREE_TEXT` inclui `draftContent` (seções conforme template); para `UPLOADED` sem versão inicial (enviada depois via `DOC-19`). Cabeçalhos `Location`, `ETag` (api.md §1.1).
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem permissão de criação do tipo |
  | 404 | `NOT_FOUND` | Processo inexistente/outro tenant |
  | 409 | `DOCUMENT_ALREADY_EXISTS` | Tipo singular (`allowMultiplePerProcess = false`) já existe no processo |
  | 422 | `VALIDATION_ERROR` | Título fora de 5–250; `documentTypeId` inexistente/inativo/outro `kind`/outro tenant (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`); sem modelo publicado (`REFERENCE_INACTIVE`) |
  | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | Tipo não permitido na etapa atual do processo |
- **Efeitos:** Evento `DocumentCreated` (`document.created.<type>`) no commit — payload `documentId`, `documentTypeCode`, `kind`, `code?`, `title`, `templateVersionId`. Projeção síncrona na timeline: `DOCUMENT_CREATED`. Auditoria `document.create` (`DATA_CHANGE`) — `metadata`: `documentTypeCode`, `templateVersionId`, `code`, `idempotencyKey`.
- **Notas:** `confidentiality` herda `defaultConfidentiality` do tipo (pode tornar-se `RESTRICTED` se o conteúdo trouxer valores sigilosos — DEC-030, entities.md). Documentos estruturados (DFD/ETP/TR) usam endpoints próprios fora desta seção.
- **Implementação (US-063 — `FREE_TEXT`):** ordem das verificações: processo visível (404) → tipo do tenant `FREE_TEXT`/`UPLOADED` (senão `REFERENCE_NOT_FOUND`) e ativo (`REFERENCE_INACTIVE`) → `DOCUMENT_CREATE` + POL-02 (403/409/422 da etapa) → template padrão publicado (`DocumentType.defaultTemplateId` → `currentPublishedVersionId` com status `PUBLISHED`, template ativo do mesmo tipo; senão `REFERENCE_INACTIVE` em `documentTypeId` com "Este tipo de documento não tem um modelo publicado. Fale com o administrador." — conferido depois da autorização, para não revelar a configuração a quem não pode criar) → `responsibleId` com vínculo ativo (422) → fábrica única (singular 409, número, auditoria, evento, timeline). `draftContent.sections` recebe uma entrada por `SectionDefinition.key` (`revision = 1`, `FILLED` com `defaultContent` de texto útil, senão `EMPTY`); as variáveis do processo e do órgão (`{{process.code}}`, `{{process.title}}`, `{{process.object}}`, `{{organization.name}}`) são resolvidas na criação, as do documento e da emissão (`{{document.*}}`, `{{today}}`…) ficam para o PDF (RN-DOC-65). A resposta traz `meta: { allowedActions, template }` — `template` como no DOC-03 (`null` no `UPLOADED`). O menu "Criar documento" do DOC-01 (`creatableTypeIds`) omite o `FREE_TEXT` sem template padrão publicado (FA-05), pela mesma regra.

### DOC-03 — Consultar documento
`GET /api/v1/documents/{id}` · **Permissão:** `PROCESS_VIEW` (+POL-09) · **Story:** US-062
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** —
- **Response:** `200 { data: Document }` + `ETag: "<document.version>"`. Campos monetários de subtipos (ex.: `estimatedValue`, `estimatedTotalValue`), quando presentes no payload, seguem o mascaramento POL-09 (api.md §1.4): `null` + `<campo>Masked: true` para quem não atende à política.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `PROCESS_VIEW` no escopo |
  | 404 | `NOT_FOUND` | Documento inexistente, de outro tenant ou não visível |
- **Efeitos:** —
- **Notas:** Base para `DOC-04` e para os painéis tipados (DFD/ETP/TR) que reaproveitam este recurso para o cabeçalho.
- **`meta.allowedActions`** (US-065 · RN-DOC-18): subconjunto de `UPDATE`, `FINALIZE` \| `SUBMIT` (conforme `requiresApproval` do tipo), `REOPEN`, `CANCEL`, `DELETE` — calculado pelo `DocumentLifecycleService` (status, custódia/participação, POL-02/POL-11, permissão do tipo, etapa e status do processo). `WITHDRAW` entra com a US-053 (DOC-11). A resposta é `{ data: Document, meta: { allowedActions } }` também em DOC-04/09/10/12/13. Implementado em versão mínima pela US-065 (sem POL-09: documentos genéricos não têm campos monetários); a US-062 completa.
- **`meta.template`** (US-063): `{ versionId, versionNumber, sections: [{ key, title, order, requirement, helpText, legalBasis, minChars, maxChars }] } | null` — a versão do template FIXADA no documento (`templateVersionId`), seções na ordem, para o editor de seções da SCR-105 sem exigir `TEMPLATE_VIEW` (o TPL-07 exige; mesmo motivo do `meta.template` do ETP-03/TRM-03). `null` no `UPLOADED`. Só o DOC-02 e o DOC-03 preenchem; nas demais respostas com `DocumentMeta` o campo é omitido (o cliente mantém o que leu).

### DOC-04 — Atualizar dados do documento
`PATCH /api/v1/documents/{id}` · **Permissão:** permissão de edição do tipo + POL-02 · **Story:** US-065
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório (`"<version>"`)
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** `{ title?: string; responsibleId?: string (uuid) }`.
- **Response:** `200 { data: Document }` + novo `ETag`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem permissão de edição do tipo |
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant |
  | 409 | `DOCUMENT_NOT_EDITABLE` | Documento fora de `DRAFT`/`RETURNED` |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `VALIDATION_ERROR` | Campo fora dos limites ou `responsibleId` sem vínculo ativo |
- **Efeitos:** Auditoria `document.draft_update` (`DATA_CHANGE`, coalescida — RN-DOC-54) com os campos alterados.
- **Notas:** Não cria `DocumentVersion` (ajuste de cabeçalho do rascunho).

### DOC-05 — Salvar seção do documento (autosave)
`PUT /api/v1/documents/{id}/sections/{sectionKey}` · **Permissão:** permissão de edição do tipo + POL-02 (escopo de custódia/participação) · **Story:** US-015, US-020, US-036, US-063
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório — revisão da **seção**, formato `"s<revision>"` (não a versão do documento; api.md §1.3)
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento; `sectionKey` (string, obrigatório) — chave da seção, deve existir no template da versão.
- **Request:** `{ content: TipTapDoc | null; notApplicable?: boolean; state?: 'EMPTY'|'FILLED'|'NOT_APPLICABLE'; justification?: string | null (obrigatório ≥ 20 caracteres em "não se aplica"); overwrittenRevision?: number }`. A API aceita as duas formas (US-015): `notApplicable: true` **ou** `state: 'NOT_APPLICABLE'` marcam "não se aplica"; fora disso o estado é **derivado no servidor** (`FILLED` com texto útil, senão `EMPTY` — RN-DFD-31). `content` ≤ `maxChars` da seção (padrão 50.000 — `TOO_LONG`) e ≤ 1 MB serializado (413 `PAYLOAD_TOO_LARGE`); `overwrittenRevision` só é enviado ao escolher "Manter a minha versão" após um conflito 412 (auditoria imediata `conflictResolution = KEEP_MINE`). Reenvio idêntico (mesmo conteúdo e estado) = 200 com a revisão atual, sem nova revisão nem auditoria, mesmo com `If-Match` desatualizado (RN-DFD-36).
- **Response:** `200 { data: { sectionKey, state, revision, updatedAt, updatedBy, draftRevision } }` + `ETag: "s<revision>"`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem permissão de edição do tipo |
  | 403 | `NOT_PROCESS_CUSTODIAN` | Sem custódia nem participação `COLLABORATOR`/`CONSULTANT` (POL-02, `access.denied`) |
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant |
  | 409 | `DOCUMENT_NOT_EDITABLE` | Documento fora de `DRAFT`/`RETURNED` (`meta.status`, `meta.statusSince`) |
  | 409 | `INVALID_PROCESS_STATUS` | Processo fora de `DRAFT`/`IN_PROGRESS`/`RETURNED` |
  | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | Tipo não permitido na etapa atual |
  | 412 | `SECTION_REVISION_CONFLICT` | Revisão da seção divergente (corpo traz `meta.current`: `sectionKey`, `state`, `revision`, `content`, `justification`, `updatedAt`, `updatedBy { id, name }`) |
  | 413 | `PAYLOAD_TOO_LARGE` | Seção acima de 1 MB serializado |
  | 428 | `PRECONDITION_REQUIRED` | `If-Match` ausente |
  | 422 | `SECTION_NOT_IN_TEMPLATE` | `sectionKey` fora do template da versão |
  | 422 | `RICH_TEXT_INVALID` | Conteúdo fora do schema TipTap permitido |
  | 422 | `VALIDATION_ERROR` | `justification` ausente/curta (`CONDITIONAL_REQUIRED`/`TOO_SHORT`); `content` acima de `maxChars` (`TOO_LONG`) |
- **Efeitos:** Nenhum evento de domínio (DEC-017) — autosave não cria `DocumentVersion`. Auditoria `document.draft_update` (`DATA_CHANGE`, coalescida por documento/seção/usuário — RN-DOC-54/RN-DFD-35): `metadata` com `sectionKey`, intervalo de revisões, variação de tamanho; texto nunca em claro (hash + tamanho). Coalescência (US-015): janela de 10 min por (documento, alvo, usuário) aberta no Redis (`SET NX`) antes da transação; o registro leva `fromRevision` (primeira revisão ainda não auditada do usuário/alvo), `toRevision`, `sizeBytesBefore/After`, `contentHash` e `windowMinutes`; Redis indisponível → audita toda gravação e loga `warn audit.coalesce_store_unavailable`. Não incrementa `Document.version` (RN-DFD-26).
- **Notas:** Classe de limite dedicada (api.md §1.6): 60 req/min por documento (usuário + documento), além do limite de corpo de 1 MB por seção (api.md §2.1, `PAYLOAD_TOO_LARGE`, 413).

### DOC-06 — Listar itens do documento
`GET /api/v1/documents/{id}/items` · **Permissão:** `PROCESS_VIEW` · **Story:** US-014, US-022, US-038
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** —
- **Response:** `200 { data: DocumentItem[] }` + `ETag: "<document.version>"`. Campos-base: `{ processItemId, sequence, description, unit, quantity, notes, sortOrder }` (DFD — US-014); TR (US-038) acrescenta `specification`, `acceptanceCriteria`; ETP (US-022) usa `calculationMemo` em vez de `notes`/`sortOrder`. Os campos efetivamente retornados variam por tipo de documento.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `PROCESS_VIEW` no escopo |
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant |
- **Efeitos:** —
- **Notas:** Itens originam-se de `ProcessItem` (PRC-13/PRC-14, fora desta seção).

### DOC-07 — Substituir itens do documento
`PUT /api/v1/documents/{id}/items` · **Permissão:** permissão de edição do tipo + POL-02 · **Story:** US-014, US-022, US-038
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório (`"<version>"` do documento)
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** `{ items: Array<{ processItemId: string (uuid, obrigatório); quantity: string decimal (obrigatório, > 0, ≤ 4 casas; inteiro se a unidade não admitir decimais); notes?: string (≤ 1.000, DFD); sortOrder?: number (TR); calculationMemo?: TipTapDoc (≤ 1 MB, ETP, RN-ETP-27); specification?: TipTapDoc (≤ 50.000/1 MB, TR); acceptanceCriteria?: TipTapDoc (≤ 50.000/1 MB, TR) }> }`. `processItemId` deve ser item ativo do mesmo processo/tenant, sem repetição (RN-DFD-14 exige ≥ 1 item no DFD).
- **Response:** `200 { data: DocumentItem[] }` + novo `ETag`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem permissão de edição do tipo |
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant |
  | 409 | `DOCUMENT_NOT_EDITABLE` | Documento fora de `DRAFT`/`RETURNED` |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente (outra pessoa alterou os itens) |
  | 422 | `VALIDATION_ERROR` | Quantidade ≤ 0/casas decimais (`OUT_OF_RANGE`/`INVALID_DECIMAL`); item repetido (`DUPLICATE_IN_LIST`); item inexistente/inativo/outro processo (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
  | 422 | `RICH_TEXT_INVALID` | `calculationMemo`/`specification`/`acceptanceCriteria` fora do schema |
- **Efeitos:** Nenhum evento de domínio — auditoria `document.items_update` (`DATA_CHANGE`): itens incluídos/removidos/alterados (quantidades; texto como hash + tamanho); `metadata.itemsCount`.
- **Notas:** Substituição completa da lista (não incremental). RN-ETP-26 (4 casas), RN-ETP-28/29 (sincronização de `estimatedTotalValue` com a pesquisa de preços, fora desta seção).

### DOC-08 — Consultar validação de completude do documento
`GET /api/v1/documents/{id}/validation` · **Permissão:** `PROCESS_VIEW` · **Story:** US-065
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** —
- **Response:** `200 { data: { documentId, isComplete: boolean, draftRevision, evaluatedAt, summary: { blocking, warnings }, sections: [{ key, requirement, state, complete }], violations: Violation[] } }` (formato único de `violations[]`, api.md §2.1.2). Exemplo (DFD):
  ```json
  {
    "data": {
      "documentId": "01927f2b-1c3d-7a10-8b9e-5d4c3b2a1f00",
      "isComplete": false,
      "draftRevision": 14,
      "evaluatedAt": "2026-10-05T14:35:10Z",
      "summary": { "blocking": 2, "warnings": 1 },
      "sections": [
        { "key": "EXPECTED_RESULTS", "requirement": "REQUIRED", "state": "EMPTY", "complete": false }
      ],
      "violations": [
        { "code": "SECTION_REQUIRED", "severity": "BLOCKING", "message": "Descreva os resultados esperados com a contratação.", "ruleId": null, "sectionKey": "EXPECTED_RESULTS", "field": null, "itemId": null, "params": {} }
      ]
    }
  }
  ```
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `PROCESS_VIEW` no escopo |
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant |
- **Efeitos:** —
- **Notas:** Indicador não bloqueante (consulta); consumido por `DOC-09`/`DOC-10` para decidir `DOCUMENT_INCOMPLETE`/`WARNINGS_NOT_ACKNOWLEDGED`. Códigos específicos por módulo (`DFD_*`, `ETP_*`, `TR_*`…) definidos nas stories donas (api.md §2.1.2).

### DOC-09 — Submeter documento
`POST /api/v1/documents/{id}/submit` · **Permissão:** permissão de submissão do tipo + POL-02 · **Story:** US-065
- **Cabeçalhos:** `Idempotency-Key` obrigatório; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** `{ acknowledgedWarnings?: string[] }` — deve cobrir todos os códigos `WARNING` pendentes de `DOC-08`.
- **Response:** `200 { data: Document }` (novo `status`, `version`).
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem permissão de submissão do tipo |
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant |
  | 409 | `INVALID_STATE` | Transição incompatível com o status atual |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `DOCUMENT_INCOMPLETE` | Pendências `BLOCKING` não resolvidas (`violations[]`) |
  | 422 | `WARNINGS_NOT_ACKNOWLEDGED` | Há `WARNING` não reconhecido em `acknowledgedWarnings` |
  | 422 | `APPROVER_UNRESOLVED` | Tipo com aprovação sem aprovador resolvível (US-051 · RN-TRAM-49): desfaz a submissão |
  | 409 | `APPROVAL_NOT_PENDING` | Corrida perdida no índice de pendência única do documento (US-051 · V-03) |
- **Efeitos:** Eventos `DocumentSubmitted` (`documentId`, `documentVersionId`, `approvalId?`), `DocumentVersionCreated` (`documentId`, `documentVersionId`, `versionNumber`, `reason = SUBMISSION`, `contentHash` — RN-DOC-53: toda transição cria versão) e `ApprovalRequested` (payload no módulo de aprovações, fora desta seção) quando a etapa exige aprovação. Projeção na timeline: `DOCUMENT_SUBMITTED`, `DOCUMENT_VERSION_CREATED`. Auditoria `document.submit` (`DATA_CHANGE`): `metadata.documentVersionId`, `approvalId?`.
- **Notas:** `VersionReason` = `MANUAL`\|`SUBMISSION`\|`FINALIZATION`\|`IMPORT`\|`UPLOAD`\|`REOPEN`\|`SYSTEM` (entities.md).
- **POL-02 nas transições (US-065):** além dos erros acima, DOC-04/09/10/14 respondem 403 `PERMISSION_DENIED` sem custódia nem participação `COLLABORATOR`/`CONSULTANT`, 409 `INVALID_PROCESS_STATUS` com o processo fora de `DRAFT`/`IN_PROGRESS`/`RETURNED` e 422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` com o tipo fora de `WorkflowStage.documentTypeCodes`; DOC-12 (POL-11) responde 403 `NOT_PROCESS_CUSTODIAN` sem custódia. A `Approval` avulsa e `approval_documents` (versão analisada) são gravadas no mesmo `tx` (as tabelas `approvals`/`approval_documents` nascem na migração da US-065). US-051: o aprovador é resolvido como na etapa (`USER` com vínculo ativo; `ROLE` com detentor competente no escopo da unidade solicitante; `DEPARTMENT_HEAD` = titular atual com `allowDeputy = true`), `dueAt = null`, `requestComment = null`, e `ApprovalRequested` (timeline `APPROVAL_REQUESTED`, concessão `APPROVER` do titular e do substituto, aviso obrigatório) sai no mesmo `tx`.

### DOC-10 — Finalizar documento
`POST /api/v1/documents/{id}/finalize` · **Permissão:** permissão de submissão do tipo + POL-02 · **Story:** US-065
- **Cabeçalhos:** `Idempotency-Key` obrigatório; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** `{ acknowledgedWarnings?: string[]; expectedDraftRevision?: number }` — `expectedDraftRevision` é o `draftRevision` do `DOC-08` que a pessoa revisou (US-016 · RN-DFD-43); divergente → 412 `VERSION_CONFLICT` ("O documento foi alterado desde que você o revisou.", `currentDraftRevision`). Também aceito em `DOC-09`.
- **Response:** `200 { data: Document }`.
- **Erros:** idênticos a `DOC-09` (`PERMISSION_DENIED` 403, `NOT_FOUND` 404, `INVALID_STATE` 409, `VERSION_CONFLICT` 412, `DOCUMENT_INCOMPLETE`/`WARNINGS_NOT_ACKNOWLEDGED` 422).
- **Efeitos:** Eventos `DocumentFinalized` (`documentId`, `documentVersionId`, `typedSummary?`), `DocumentVersionCreated` (`reason = FINALIZATION`). Projeção `DOCUMENT_FINALIZED`. Auditoria `document.finalize`: `metadata.documentVersionId`, `typedSummary?`.
- **Notas:** Transição terminal do rascunho (sem aprovação exigida nessa etapa); ver US-065 para a máquina de estados completa.

### DOC-11 — Retirar documento submetido
`POST /api/v1/documents/{id}/withdraw` · **Permissão:** permissão de submissão do tipo (custódia anterior) · **Story:** US-053
- **Cabeçalhos:** `Idempotency-Key` obrigatório; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** `{ reason?: string (≤ 2.000) }`.
- **Response:** `200 { data: Document }` com `status = DRAFT`, novo `ETag`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem custódia anterior/permissão |
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant |
  | 409 | `APPROVAL_NOT_PENDING` | Aprovação já decidida ou retirada |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave com corpo diferente |
- **Efeitos:** Eventos `DocumentWithdrawn` (`document.withdrawn.<type>`; payload `documentId`, `approvalId` — events.md §4), `ApprovalCanceled` (`reason = WITHDRAWN`) e, quando a retirada ocorre em etapa de aprovação, `ProcessStageChanged` (`cause = RETURN`, `approvalId` preenchido). Auditoria `approval.withdraw` (`WORKFLOW`): `metadata` com `processCode`/`documentCode`, `subjectType`, `hasReason`.
- **Notas:** Reconduz o documento a `DRAFT` para nova edição; complementar a `APV-04` (retirada da aprovação propriamente dita, fora desta seção).

### DOC-12 — Reabrir documento
`POST /api/v1/documents/{id}/reopen` · **Permissão:** `DOCUMENT_REOPEN` + POL-11 · **Story:** US-065
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** `{ reopenReason: string (obrigatório, ≥ 20 caracteres) }`.
- **Response:** `200 { data: Document }`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `DOCUMENT_REOPEN`/POL-11 |
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant |
  | 409 | `INVALID_STATE` | Reabertura com aprovação pendente ou status incompatível |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `VALIDATION_ERROR` | `reopenReason` com menos de 20 caracteres (`TOO_SHORT`) |
- **Efeitos:** Evento `DocumentReopened` (`documentId`, `fromStatus`, `baseVersionId`). Projeção `DOCUMENT_REOPENED`. Auditoria `document.reopen` (`DATA_CHANGE`): `changes.fromStatus`; `metadata` hash da justificativa + tamanho.
- **Notas:** Bloqueado enquanto houver aprovação `PENDING` associada (V-04, US-065).

### DOC-13 — Cancelar documento
`POST /api/v1/documents/{id}/cancel` · **Permissão:** `DOCUMENT_CANCEL` + custódia do processo · **Story:** US-065
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** `{ cancellationReason: string (obrigatório, ≥ 20 caracteres) }`.
- **Response:** `200 { data: Document }`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `NOT_PROCESS_CUSTODIAN` | Sem custódia atual do processo |
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant |
  | 409 | `INVALID_STATE` | Transição incompatível com o status atual |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `VALIDATION_ERROR` | `cancellationReason` com menos de 20 caracteres |
- **Efeitos:** Evento `DocumentCanceled` (`documentId`, `fromStatus`). Projeção `DOCUMENT_CANCELED`. Auditoria `document.cancel`: `changes.fromStatus`; `metadata` hash da justificativa + tamanho.
- **Notas:** Único caminho de encerramento para documento já submetido (V-07, US-065); para rascunho nunca submetido, usar `DOC-14`.

### DOC-14 — Excluir documento (rascunho)
`DELETE /api/v1/documents/{id}` · **Permissão:** permissão de edição do tipo (documento nunca submetido) · **Story:** US-065
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** —
- **Response:** `204` (sem corpo).
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem permissão de edição do tipo |
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant |
  | 409 | `INVALID_STATE` | Documento já submetido (só pode ser cancelado — `DOC-13`) |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
- **Efeitos:** Nenhum evento de domínio. Auditoria `document.delete` (`DATA_CHANGE`): `metadata.documentTypeCode`.
- **Notas:** Exclusão física restrita a rascunhos sem nenhuma `DocumentVersion` de submissão.

### DOC-15 — Listar versões do documento
`GET /api/v1/documents/{id}/versions` · **Permissão:** `PROCESS_VIEW` · **Story:** US-066
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento. Query: `page`, `pageSize` (paginação padrão, api.md §1.2); ordem fixa `versionNumber` desc (RN-DOC-59 · US-066).
- **Request:** —
- **Response:** `200 { data: DocumentVersionSummary[], meta: { page, pageSize, totalItems, totalPages } }` — a versão sem o snapshot: `id`, `documentId`, `processId`, `versionNumber`, `reason`, `statusAtCreation`, `contentHash`, `templateVersionId`, `attachmentId` (quando `UPLOADED`), `changeSummary`, `createdById`, `createdByName`, `createdAt`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `PROCESS_VIEW` no escopo |
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant |
- **Efeitos:** —
- **Notas:** Versões são imutáveis (RN-DOC-57/58); base para `DOC-17`/`DOC-18`.

### DOC-16 — Criar versão manual do documento
`POST /api/v1/documents/{id}/versions` · **Permissão:** permissão de edição do tipo + POL-02 · **Story:** US-066
- **Cabeçalhos:** `Idempotency-Key` obrigatório; `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** `{ changeSummary?: string (≤ 500) }`.
- **Response:** `201 { data: DocumentVersion }` + `Location: /api/v1/document-versions/{versionId}` (`DocumentVersion` = `DocumentVersionSummary` + `kind` + `content`, com POL-09 como no `DOC-17`). O documento continua no mesmo status; `currentVersionId`/`currentVersionNumber` passam a apontar a versão `MANUAL` e a `version` (ETag) do documento avança.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem permissão de edição do tipo |
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant |
  | 409 | `DOCUMENT_NOT_EDITABLE` | Documento fora de `DRAFT`/`RETURNED` |
  | 422 | `VALIDATION_ERROR` | Tipo `UPLOADED` (`NOT_ALLOWED` — use `DOC-19`); `changeSummary` acima de 500 caracteres (`TOO_LONG`) |
- **Efeitos:** Evento `DocumentVersionCreated` (`documentId`, `documentVersionId`, `versionNumber`, `reason = MANUAL`, `contentHash`). Auditoria `document.version_create`: `metadata.versionNumber`, `reason = MANUAL`, `contentHash`.
- **Notas:** Ponto de checkpoint manual do rascunho, independente das transições automáticas de `DOC-09`/`DOC-10`. Concorrência (RN-DOC-58): a transação trava a linha do documento (`SELECT … FOR UPDATE`) antes de ler o maior `versionNumber` — pedidos simultâneos viram versões consecutivas, sem lacuna nem repetição.

### DOC-17 — Consultar versão do documento
`GET /api/v1/document-versions/{versionId}` · **Permissão:** `PROCESS_VIEW` (+POL-09) · **Story:** US-066
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `versionId` (uuid, obrigatório) — id da versão.
- **Request:** —
- **Response:** `200 { data: DocumentVersion }` com `content` (snapshot completo, nulo para `UPLOADED`); campos monetários no `content`, quando houver, seguem POL-09 (api.md §1.4).
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `PROCESS_VIEW` no escopo |
  | 404 | `NOT_FOUND` | Versão inexistente/outro tenant |
- **Efeitos:** —
- **Notas:** `content` é o snapshot JSON (hash RFC 8785) correspondente a `contentHash`.

### DOC-18 — Comparar versões do documento
`GET /api/v1/documents/{id}/versions/compare` · **Permissão:** `PROCESS_VIEW` (+POL-09) · **Story:** US-066
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento. Query: `from` (uuid, obrigatório) — id da versão de origem; `to` (uuid, obrigatório, ≠ `from`) — id da versão de destino; ambas devem pertencer ao mesmo `id`.
- **Request:** —
- **Response:** `200 { data: { documentId, kind, from, to, header: HeaderDiff[], sections: SectionDiff[], collections: CollectionDiff[] } }` (`from`/`to` = `DocumentVersionSummary`; contrato registrado na US-066, schema `documentVersionComparisonSchema`). Cada entrada traz `changeType: 'ADDED'|'REMOVED'|'CHANGED'|'UNCHANGED'|'MASKED'`; igualdade pelo JSON canônico (RFC 8785 — ordem de chaves não conta):
  - `header[]` — `{ field, changeType, from, to }`: primeiro os metadados `document.title`, `document.code`, `document.confidentiality`, `template.versionNumber`, depois os campos do cabeçalho tipado em ordem alfabética. Documento `UPLOADED` (FA-02): só `file.attachmentId` e `file.sha256` (sem diff de conteúdo; seções e coleções vazias).
  - `sections[]` — `{ sectionKey, changeType, from: { state, text, justification } | null, to }` por `sectionKey` (ordem alfabética); `text` é o texto extraído do TipTap; a mudança considera estado, conteúdo TipTap (inclusive formatação) e justificativa.
  - `collections[]` — `{ collection, itemId, changeType, changedFields[], maskedFields[], from, to }` por chave natural (`processItemId` em `items`, `id` nas demais; sem chave ou repetida, a posição `#n`), na ordem do destino e as removidas ao final.
  - `MASKED` (RN-DOC-61 · FA-03): campo monetário de processo sigiloso (agora ou no momento da versão) para quem não atende POL-09 — `from`/`to` nulos nos dois lados; nas linhas de coleção o campo vai para `maskedFields`, nunca para `changedFields`, e o valor vem `null` + `<campo>Masked: true`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `PROCESS_VIEW` no escopo |
  | 404 | `NOT_FOUND` | Documento/versão inexistentes ou outro tenant |
  | 422 | `VALIDATION_ERROR` | `from`/`to` de outro documento, inexistentes ou iguais |
- **Efeitos:** —
- **Notas:** Não gera auditoria (leitura/comparação). Reaproveitado por outras telas de histórico tipado (ETP, TR etc.).

### DOC-19 — Enviar nova versão do arquivo (upload)
`POST /api/v1/documents/{id}/upload-version` · **Permissão:** `DOCUMENT_UPDATE` + POL-02 · **Story:** US-064
- **Cabeçalhos:** `Idempotency-Key` obrigatório; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** `{ attachmentId: string (uuid, obrigatório); changeSummary?: string (≤ 500) }`. `attachmentId` deve estar `AVAILABLE` (intenção de upload + confirmação prévias, fora desta seção) e dentro da allowlist de extensão/tamanho do tenant (`uploads.*`).
- **Response:** `201 { data: DocumentVersion }`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `DOCUMENT_UPDATE`/POL-02 |
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant |
  | 409 | `DOCUMENT_NOT_EDITABLE` | Documento fora de `DRAFT`/`RETURNED` |
  | 409 | `UPLOAD_NOT_RECEIVED` | Confirmação sem objeto na quarentena |
  | 409 | `ATTACHMENT_NOT_AVAILABLE` | Arquivo ainda em varredura, infectado ou rejeitado |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `VALIDATION_ERROR` | Tipo não permitido na etapa (`DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`) |
  | 413 | `FILE_TOO_LARGE` | Arquivo acima de `uploads.maxFileSizeMb` (domínio, api.md §2.2) |
  | 415 | `FILE_TYPE_NOT_ALLOWED` | Extensão/MIME fora da allowlist (domínio, api.md §2.2) |
- **Efeitos:** Eventos `DocumentCreated` (na 1ª chamada, casca do documento — ver `DOC-02`) e `DocumentVersionCreated` (`documentId`, `documentVersionId`, `versionNumber`, `reason = UPLOAD`, `contentHash`). Projeções `DOCUMENT_CREATED`/`DOCUMENT_VERSION_CREATED`. Auditoria `document.version_create`: `metadata.versionNumber`, `reason = UPLOAD`, `attachmentId`, `sha256`.
- **Notas:** Classe de limite "Upload" (api.md §1.6): 60 req/min por usuário + tenant. O ciclo de varredura do arquivo (`AttachmentUploaded`/`AttachmentRejected`) é do módulo de anexos (US-068, fora desta seção) e é apenas pré-condição aqui.

### DOC-20 — Gerar prévia em PDF do rascunho
`POST /api/v1/documents/{id}/preview` · **Permissão:** `PROCESS_VIEW` · **Story:** US-067
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** —
- **Response:** `202 { data: DocumentRendition }` com `kind = 'PREVIEW'`, `status = 'PENDING'`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem acesso ao documento (ou 404 por DEC-024) |
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant/não visível |
- **Efeitos:** Auditoria `document.render_request` (`DATA_CHANGE`): `metadata.kind = 'PREVIEW'`, `draftRevision`, `renditionId`, `reused`. Evento assíncrono ao concluir o worker (ver `DOC-22`): `DocumentRenditionReady` (`document.rendition_ready`) ou `DocumentRenditionFailed` (`document.rendition_failed`).
- **Notas:** Classe "Exportações e renderização" (api.md §1.6): 20 req/min por usuário + tenant. Prévia expira em 24 h (`expiresAt`, RN-DOC-68); nova chamada após expirar gera novo `renditionId`.

### DOC-21 — Gerar PDF de uma versão
`POST /api/v1/document-versions/{versionId}/renditions` · **Permissão:** `PROCESS_VIEW` (+POL-09) · **Story:** US-067
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `versionId` (uuid, obrigatório) — id da versão.
- **Request:** `{ kind: 'CONTENT'|'APPROVAL_STAMPED'; approvalId?: string (uuid, obrigatório se kind = APPROVAL_STAMPED) }`.
- **Response:** `202 { data: DocumentRendition }` (`status = 'PENDING'`); `200 { data: DocumentRendition }` se já existir rendition equivalente (reaproveitamento, FA-01).
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem acesso ao documento |
  | 404 | `NOT_FOUND` | Versão inexistente/outro tenant |
  | 422 | `VALIDATION_ERROR` | Sem `DocumentVersion` correspondente (`REFERENCE_NOT_FOUND`) |
- **Efeitos:** Auditoria `document.render_request`: `metadata.kind`, `documentVersionId?`. Eventos assíncronos (worker): `DocumentRenditionReady`/`DocumentRenditionFailed`.
- **Notas:** Equivalente = mesma versão, `kind`, `approvalId` e forma de POL-09 (`masked`: quem não pode ver o orçamento sigiloso recebe o PDF com os valores ocultos); `FAILED` não conta ("Tentar novamente" gera outra). `approvalId` que não cobre a versão → 422 `REFERENCE_NOT_FOUND`; documento externo → 422 `NOT_ALLOWED`. Mesma classe de limite de `DOC-20` (20 req/min). `RenditionKind` = `PREVIEW`\|`CONTENT`\|`APPROVAL_STAMPED`\|`SIGNED` (entities.md; `SIGNED` reservado a MVP futuro).

### DOC-22 — Consultar status de uma renderização
`GET /api/v1/document-renditions/{renditionId}` · **Permissão:** `PROCESS_VIEW` (+POL-09) · **Story:** US-067
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `renditionId` (uuid, obrigatório).
- **Request:** —
- **Response:** `200 { data: DocumentRendition }` — `{ kind, status, pageCount?, sha256?, sizeBytes? }`. `RenditionStatus` = `PENDING`\|`PROCESSING`\|`READY`\|`FAILED`\|`EXPIRED` (entities.md).
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem acesso ao documento |
  | 404 | `NOT_FOUND` | Rendition inexistente/outro tenant |
- **Efeitos:** —
- **Notas:** Usado para *polling* até `status = READY` antes de `DOC-23`.

### DOC-23 — Baixar PDF gerado
`GET /api/v1/document-renditions/{renditionId}/download` · **Permissão:** `PROCESS_VIEW` (+POL-09) · **Story:** US-067
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `renditionId` (uuid, obrigatório).
- **Request:** —
- **Response:** `200 { data: { url: string, expiresAt: string } }` (URL assinada e temporária).
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem acesso ao documento |
  | 404 | `NOT_FOUND` | Rendition inexistente/outro tenant |
  | 409 | `RENDITION_NOT_READY` | Download antes de `READY` ou prévia expirada |
  | 403 | `PERMISSION_DENIED` | PDF completo (`masked = false`) de conteúdo sigiloso para quem não atende POL-09 |
  | 503 | `DEPENDENCY_UNAVAILABLE` | Auditoria ou storage indisponível (nunca URL sem trilha) |
- **Efeitos:** Auditoria `document.download` (`EXPORT`): `metadata.renditionId`, `kind`.
- **Notas:** Mesma classe de limite de renderização (20 req/min) por reuso do fluxo de exportação.

### DOC-24 — Registrar presença de edição (heartbeat)
`PUT /api/v1/documents/{id}/presence` · **Permissão:** permissão de edição do tipo + POL-02 · **Story:** US-070
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** `{ sectionKey?: string }` — deve existir no template da versão atual; se inválida, o heartbeat é silenciosamente ignorado e mantém o `sectionKey` anterior.
- **Response:** `200 { data: { editors: Array<{ userId, name, sectionKey, since }> } }` — lista exclui o próprio chamador.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem permissão de edição do tipo |
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant/não visível |
  | 409 | `DOCUMENT_NOT_EDITABLE` | Documento não pode ser editado pelo usuário (indicador não é exibido/enviado) |
  | 422 | `SECTION_NOT_IN_TEMPLATE` | `sectionKey` informado não existe no template (silencioso) |
- **Efeitos:** Nenhum evento de domínio nem auditoria (RN-DOC-93) — dado puramente efêmero.
- **Notas:** Estado mantido em **Redis, TTL 60 s** por usuário/documento; se o Redis estiver indisponível, a resposta é `200` degradada (indicador oculto, sem bloquear a edição) em vez de erro.

### DOC-25 — Encerrar presença de edição
`DELETE /api/v1/documents/{id}/presence` · **Permissão:** sessão autenticada (encerra apenas a própria presença) · **Story:** US-070
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório) — id do documento.
- **Request:** —
- **Response:** `204` (sem corpo).
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 404 | `NOT_FOUND` | Documento inexistente/outro tenant (heartbeat encerra silenciosamente) |
- **Efeitos:** Nenhum evento de domínio nem auditoria (RN-DOC-93).
- **Notas:** Chamado ao fechar o editor/sair da seção; complementa o TTL de 60 s de `DOC-24`.

### DOC-26 — Aplicar conteúdo gerado por IA nas seções
`POST /api/v1/documents/{id}/ai-apply` · **Permissão:** permissão de edição do tipo (`DFD_UPDATE`, `ETP_UPDATE`, `RISK_MANAGE` para o `RISK_MAP`, `TERM_UPDATE`) + POL-02 · só o solicitante da geração (RN-AI-13) · **Story:** US-117 (rascunho completo); US-118, US-119, US-120 (demais documentos); US-121 (ajuste de seção)

- **Cabeçalhos:** `If-Match` obrigatório (versão do documento) · `Idempotency-Key` obrigatório
- **Parâmetros:** `id` (path, uuid) — documento alvo da geração
- **Request:**
```ts
{
  generationId: string;            // AiGeneration SUCCEEDED deste documento
  sectionKeys: string[];           // ≥ 1; subconjunto das seções da proposta
  confirmReplaceFilled?: boolean;  // obrigatório (true) se alguma seção escolhida estiver FILLED/NOT_APPLICABLE
}
```
- **Response:** `200 { data: { document: Document, appliedSectionKeys: string[], versionCreated: { id: string, versionNumber: number } | null } }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem a permissão de edição do tipo |
| 403 | `NOT_PROCESS_CUSTODIAN` | POL-02 |
| 403 | `AI_GENERATION_NOT_OWNED` | Usuário não é o solicitante da geração |
| 404 | `NOT_FOUND` / `AI_GENERATION_NOT_FOUND` | Documento ou geração inexistente/de outro tenant |
| 409 | `DOCUMENT_NOT_EDITABLE` | Documento fora de `DRAFT`/`RETURNED` |
| 409 | `AI_GENERATION_NOT_APPLICABLE` | Geração não `SUCCEEDED`, expirada ou de outro documento |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | Requisição idêntica em processamento |
| 410 | `AI_SUGGESTION_STALE` | Ajuste de seção (`SECTION`) com a seção em revisão diferente de `baseRevision` |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | `sectionKeys` vazio ou fora da proposta (`NOT_ALLOWED`); substituir seção preenchida sem `confirmReplaceFilled` (`CONDITIONAL_REQUIRED`) |
| 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | Tipo não permitido na etapa atual |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave, corpo diferente |
| 428 | `PRECONDITION_REQUIRED` | `If-Match` ausente |

- **Efeitos:** numa transação:
  1. Se um rascunho completo (`DRAFT`) substitui alguma seção `FILLED`, cria antes uma `DocumentVersion` (`reason = SYSTEM`, `changeSummary` "Antes de aplicar conteúdo gerado por IA") → `DocumentVersionCreated`.
  2. Cada seção escolhida recebe o conteúdo da proposta, fica `FILLED`, ganha `revision + 1` e a proveniência `ai` (`reviewedAt = null`).
  3. O documento ganha `draftRevision + 1`.
  4. A geração vira `APPLIED` (`appliedTargets`, pela porta `AiSuggestionSource.markApplied`).
  5. Auditoria `ai.content_apply` (`DATA_CHANGE`; `metadata`: `generationId`, `sectionKeys`, `replacedFilledSections`, `versionCreated`).
  6. Evento `AiContentApplied` (`document.ai_content_applied.<type>`) → timeline `AI_CONTENT_APPLIED`.
  Sem notificação.
- **Notas:**
  - Campos tipados, itens (`DocumentItem`), alternativas e valores nunca são alterados (RN-AI-27).
  - Ajuste de seção (`SECTION`) não cria versão: o painel guarda o texto anterior e oferece "Desfazer" via DOC-05 (RN-AI-50).
  - **Uma aplicação por geração:** aplicar parte das seções encerra a proposta (`APPLIED`); para usar as demais, gerar de novo. Exceção: a proposta do `RISK_MAP` tem duas partes (riscos por RSK-11 e seções aqui), cada uma aplicada uma vez enquanto a proposta não expirar.
  - O `If-Match` é o `ETag` de DOC-03 (`document.version`), que também muda a cada autosave (DOC-05). Em 412, o painel recarrega o documento, mostra o que mudou e repete a aplicação com o `ETag` novo.

### DOC-27 — Marcar seções geradas por IA como revisadas
`POST /api/v1/documents/{id}/ai-review` · **Permissão:** permissão de edição do tipo + POL-02 · **Story:** US-122

- **Cabeçalhos:** — (a concorrência é controlada por seção, no corpo)
- **Parâmetros:** `id` (path, uuid)
- **Request:**
```ts
{
  sectionKeys: string[];                      // ≥ 1
  expectedRevisions: Record<string, number>;  // revisão atual de cada seção
  confirmAll?: boolean;                        // true quando vem de "Revisar todas" (confirmação explícita na UI)
}
```
- **Response:** `200 { data: { document: Document, reviewedSectionKeys: string[] } }`. Seções sem proveniência pendente são ignoradas (idempotente).
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | Sem permissão de edição / POL-02 |
| 404 | `NOT_FOUND` | Documento inexistente/de outro tenant |
| 409 | `DOCUMENT_NOT_EDITABLE` | Documento fora de `DRAFT`/`RETURNED` |
| 412 | `VERSION_CONFLICT` | Alguma seção com revisão diferente de `expectedRevisions` (`meta.current` traz as revisões atuais) |
| 422 | `VALIDATION_ERROR` | `sectionKeys` vazio ou chave fora do template (`NOT_ALLOWED`) |

- **Efeitos:** `ai.reviewedAt`/`reviewedById` preenchidos e `revision + 1` em cada seção revisada; auditoria `ai.content_review` (`DATA_CHANGE`; `metadata`: `sectionKeys`, `generationIds`, `confirmAll`); evento `AiContentReviewed` (`document.ai_content_reviewed.<type>`) → timeline `AI_CONTENT_REVIEWED`.
- **Notas:** revisar não exige que as marcações [a confirmar] estejam resolvidas. Ambas são violações bloqueantes independentes em DOC-08 (`SECTION_AI_REVIEW_PENDING`, `SECTION_PLACEHOLDER_PENDING` — RN-AI-57).

### DTY-01 — Listar tipos de documento
`GET /api/v1/document-types` · **Permissão:** acesso autenticado ao tenant (impl.); `includeInactive=true` exige `DOCUMENT_TYPE_MANAGE` · **Story:** US-061
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** Query: `includeInactive?` (boolean, padrão `false`), `kind?` (lista de `DocumentKind`, OU por vírgula), `q?` (texto).
- **Request:** —
- **Response:** `200 { data: DocumentType[] }` — `{ id, code, name, description, kind, systemModule, isSystem, isActive, allowMultiplePerProcess, numberingEnabled, numberingMask, nextNumberPreview, requiresApproval, approvalPolicy, defaultConfidentiality, defaultTemplate?: { id, name, versionNumber }, sortOrder, editableFields[], version }`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | `includeInactive=true` sem `DOCUMENT_TYPE_MANAGE` |
- **Efeitos:** —
- **Notas:** Resposta cacheável (10 min, citado em US-062); `DocumentKind` = `FREE_TEXT`\|`UPLOADED`\|`STRUCTURED`.

### DTY-02 — Criar tipo de documento
`POST /api/v1/document-types` · **Permissão:** `DOCUMENT_TYPE_MANAGE` · **Story:** US-061
- **Cabeçalhos:** `Idempotency-Key` obrigatório; `If-Match` —
- **Parâmetros:** —
- **Request:** `{ kind: 'FREE_TEXT'|'UPLOADED'; code: string (obrigatório, maiúsculas/números/`_`); name: string (obrigatório, 3–120); description?: string (≤ 2.000); allowMultiplePerProcess: boolean; numberingEnabled: boolean; numberingMask?: string; requiresApproval: boolean; approvalPolicy?: ApprovalPolicy (obrigatório se requiresApproval); defaultConfidentiality: Confidentiality; sortOrder?: number (0–999) }`. `kind = STRUCTURED` não é aceito na criação (reservado à plataforma).
- **Response:** `201 { data: DocumentType }` + `Location`, `ETag`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `DOCUMENT_TYPE_MANAGE` |
  | 409 | `CONFLICT` | `code` já usado no tenant |
  | 422 | `VALIDATION_ERROR` | Obrigatórios/tamanhos/formato de `code`; `kind = STRUCTURED` (`INVALID_ENUM`) |
  | 422 | `NUMBERING_MASK_INVALID` | Máscara sem `{seq:N}`/`{year}` ou token desconhecido |
  | 422 | `APPROVER_UNRESOLVED` | Unidade fixa do aprovador sem titular |
- **Efeitos:** Evento `DocumentTypeChanged` (`documentTypeId`, `code`, `changedFields[]`) — consumidor de invalidação de cache. Auditoria `document_type.create` (`CONFIGURATION`): `changes` valores iniciais; `metadata.code`, `kind`, `idempotencyKey`.
- **Notas:** `Confidentiality` = `PUBLIC`\|`INTERNAL`\|`RESTRICTED` (entities.md). Sem projeção em timeline (configuração não pertence a um processo). Código repetido responde `409 CONFLICT` com `detail` "Já existe um tipo com o código {code}." (US-061 · V-05; `DOCUMENT_TYPE_CODE_TAKEN` de api.md §2.2 fica como refinamento futuro). `NUMBERING_MASK_INVALID` traz `errors[]` com `field = numberingMask`.

### DTY-03 — Atualizar tipo de documento
`PATCH /api/v1/document-types/{id}` · **Permissão:** `DOCUMENT_TYPE_MANAGE` · **Story:** US-061
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório).
- **Request:** campos editáveis conforme RN-DOC-03 (`name`, `description`, `allowMultiplePerProcess`, `numberingEnabled`, `numberingMask`, `requiresApproval`, `approvalPolicy`, `defaultConfidentiality`, `sortOrder`, `isActive`); `kind`/`code` imutáveis após a criação.
- **Response:** `200 { data: DocumentType }` + novo `ETag`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` / `MFA_REQUIRED` | Sem permissão ou ação exige confirmação adicional |
  | 404 | `NOT_FOUND` | Tipo inexistente/outro tenant |
  | 409 | `CONFLICT` | Desativação bloqueada por fluxo publicado que exige o tipo |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `VALIDATION_ERROR` | Campo imutável/restrito (`NOT_ALLOWED`); `allowMultiplePerProcess` alterado com documentos existentes |
  | 422 | `NUMBERING_MASK_INVALID` | Máscara inválida |
  | 422 | `APPROVER_UNRESOLVED` | Aprovador/unidade não resolvível |
- **Efeitos:** Evento `DocumentTypeChanged` (inclui ativar/desativar). Auditoria `document_type.update`: `changes` campo a campo (inclui `approvalPolicy`); `metadata` com `code`, `isSystem`, `impact { documentsCount, workflowsReferencing }`.
- **Notas:** Tipos `STRUCTURED`/`isSystem` têm campos restritos (V-04/V-12, US-061). Campos fora de `editableFields` (inclusive `code`/`kind`) → 422 `VALIDATION_ERROR` (`NOT_ALLOWED`). Corpo sem alteração real (valores iguais aos atuais ou `{}`) → 200 sem nova versão, auditoria nem evento. `editableFields` da resposta lista o que o tipo aceita alterar (RN-DOC-03).

### DTY-04 — Definir template padrão do tipo
`PUT /api/v1/document-types/{id}/default-template` · **Permissão:** `TEMPLATE_PUBLISH` · **Story:** US-108
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório) — id do tipo de documento.
- **Request:** `{ templateId: string (uuid, obrigatório) }` — deve ser template do mesmo tipo de documento, com ao menos uma versão `PUBLISHED`.
- **Response:** `200 { data: DocumentType }` (com `defaultTemplate` atualizado).
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `TEMPLATE_PUBLISH` |
  | 404 | `NOT_FOUND` | Tipo ou template inexistentes/outro tenant |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `BUSINESS_RULE_VIOLATION` (`TEMPLATE_NOT_PUBLISHED`) | Template sem versão publicada |
  | 422 | `VALIDATION_ERROR` | Template de outro tipo de documento |
- **Efeitos:** Evento `DocumentTypeChanged` (`changedFields: ["defaultTemplateId"]`). Auditoria `document_type.update`: `changes.defaultTemplateId` (anterior → novo).
- **Notas:** Especificação completa do ciclo de publicação de templates em [04-templates.md](04-templates.md) (US-108); este endpoint pertence ao catálogo de `document-types`. **Implementação (US-108):** template de outro tipo → `VALIDATION_ERROR` com `errors[] = { field: 'templateId', code: 'NOT_ALLOWED' }`; template inativo conta como sem versão publicada (`TEMPLATE_NOT_PUBLISHED`, `field = templateId`). O mesmo template já padrão → 200 sem nova versão, auditoria nem evento. `DocumentType.defaultTemplate` (DTY-01..04) = `{ id, name, versionNumber }` da versão publicada corrente do template padrão, ou `null`.
