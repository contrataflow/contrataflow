# Templates

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2.

## Catálogo de endpoints

| ID | Método | Rota | Permissão | Story |
|---|---|---|---|---|
| TPL-01 | GET | `/templates` | `TEMPLATE_VIEW` (lista resumida: impl.) | US-107 |
| TPL-02 | POST | `/templates` | `TEMPLATE_MANAGE` | US-107 |
| TPL-03 | GET | `/templates/{id}` | `TEMPLATE_VIEW` | US-107 |
| TPL-04 | PATCH | `/templates/{id}` | `TEMPLATE_MANAGE` (IM) | US-107 |
| TPL-05 | GET | `/templates/{id}/versions` | `TEMPLATE_VIEW` | US-108 |
| TPL-06 | POST | `/templates/{id}/versions` | `TEMPLATE_MANAGE` | US-108 |
| TPL-07 | GET | `/template-versions/{versionId}` | `TEMPLATE_VIEW` (versão publicada: impl.) | US-107 |
| TPL-08 | PATCH | `/template-versions/{versionId}` | `TEMPLATE_MANAGE` (IM) | US-107, US-109 |
| TPL-09 | POST | `/template-versions/{versionId}/preview` | `TEMPLATE_VIEW` | US-109 |
| TPL-10 | POST | `/template-versions/{versionId}/publish` | `TEMPLATE_PUBLISH` (IM) | US-108 |
| TPL-11 | POST | `/template-versions/{versionId}/retire` | `TEMPLATE_PUBLISH` (IM) | US-108 |
| TPL-12 | GET | `/template-versions/{versionId}/preview/{renditionId}` | `TEMPLATE_VIEW` | US-109 |
| TPL-13 | GET | `/template-versions/{versionId}/preview/{renditionId}/download` | `TEMPLATE_VIEW` | US-109 |

## Especificação dos endpoints

### TPL-01 — Listar templates
`GET /api/v1/templates` · **Permissão:** `TEMPLATE_VIEW` (lista resumida: critério de visibilidade simplificado, impl.) · **Story:** US-107
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** Query: `documentTypeId?` (uuid, filtro), `q?` (texto, busca por nome), `page?` (paginação, api.md §1.2; `pageSize` não detalhado no extrato — a definir na implementação). Ordenação não documentada na fonte.
- **Request:** —
- **Response:** `200 { data: Template[], meta }`.
- **Erros:** — (apenas `200` documentado na fonte; erros genéricos de acesso seguem api.md §2 quando aplicável).
- **Efeitos:** —
- **Notas:** Lista usada para seleção de template em `DOC-02`/wizards tipados e para a tela de administração de templates.

### TPL-02 — Criar template
`POST /api/v1/templates` · **Permissão:** `TEMPLATE_MANAGE` · **Story:** US-107
- **Cabeçalhos:** `Idempotency-Key` obrigatório; `If-Match` —
- **Parâmetros:** —
- **Request:** `{ name: string (obrigatório, 3–150 caracteres, único por tipo de documento — RN-TPL-01); documentTypeId: string (uuid, obrigatório, tipo ativo; imutável após a criação); description?: string (≤ 2.000) }`.
- **Response:** `201 { data: Template }` (inclui a versão 1, criada automaticamente em `DRAFT`).
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `TEMPLATE_MANAGE` |
  | 409 | `TEMPLATE_NAME_TAKEN` | Já existe template com o mesmo nome para o tipo de documento |
  | 422 | `VALIDATION_ERROR` | Campos obrigatórios ausentes/fora de tamanho; `documentTypeId` inexistente, inativo ou de outro tenant (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
- **Efeitos:** Nenhum evento de domínio (só a publicação gera evento — `TPL-10`). Auditoria `template.create` (`CONFIGURATION`): `changes` com `name`, `documentTypeId`; `metadata.templateId`, `idempotencyKey`.
- **Notas:** A versão 1 nasce vazia (sem seções) e é editada via `TPL-08`.

### TPL-03 — Consultar template
`GET /api/v1/templates/{id}` · **Permissão:** `TEMPLATE_VIEW` · **Story:** US-107
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório).
- **Request:** —
- **Response:** `200 { data: Template }`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 404 | `NOT_FOUND` | Template inexistente, de outro tenant ou não visível |
- **Efeitos:** —
- **Notas:** —

### TPL-04 — Atualizar dados do template
`PATCH /api/v1/templates/{id}` · **Permissão:** `TEMPLATE_MANAGE` · **Story:** US-107
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório).
- **Request:** `{ name?: string (3–150, único por tipo); description?: string (≤ 2.000); isActive?: boolean }`.
- **Response:** `200 { data: Template }` + novo `ETag`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `TEMPLATE_MANAGE` |
  | 404 | `NOT_FOUND` | Template inexistente/outro tenant |
  | 409 | `TEMPLATE_NAME_TAKEN` | Novo nome já usado para o mesmo tipo de documento |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente (editado por outra pessoa) |
  | 422 | `VALIDATION_ERROR` | Campo fora de tamanho |
- **Efeitos:** Auditoria `template.update` (`CONFIGURATION`): `changes` dos campos de metadados alterados.
- **Notas:** Não altera o conteúdo da versão (seções/layout) — isso é feito por `TPL-08`.

### TPL-05 — Listar versões do template
`GET /api/v1/templates/{id}/versions` · **Permissão:** `TEMPLATE_VIEW` · **Story:** US-108
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório) — id do template. Query: `status?` (`TemplateVersionStatus`: `DRAFT`\|`PUBLISHED`\|`RETIRED`, entities.md); paginação (`meta` presente na resposta, api.md §1.2) — campos de ordenação não detalhados na fonte.
- **Request:** —
- **Response:** `200 { data: TemplateVersion[], meta }`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 404 | `NOT_FOUND` | Template inexistente/outro tenant |
- **Efeitos:** —
- **Notas:** Histórico de versões, inclusive `changeNotes` de cada uma.

### TPL-06 — Criar nova versão do template (rascunho)
`POST /api/v1/templates/{id}/versions` · **Permissão:** `TEMPLATE_MANAGE` · **Story:** US-108
- **Cabeçalhos:** `Idempotency-Key` obrigatório; `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório) — id do template.
- **Request:** — (sem corpo; clona a versão mais recente do template como novo rascunho).
- **Response:** `201 { data: TemplateVersion }` (`status = 'DRAFT'`).
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `TEMPLATE_MANAGE` |
  | 404 | `NOT_FOUND` | Template inexistente/outro tenant |
  | 409 | `TEMPLATE_DRAFT_EXISTS` | Já existe uma versão `DRAFT` em edição para este template |
- **Efeitos:** Nenhum evento de domínio (criação de rascunho gera só auditoria `template.version_create` (events.md §7)).
- **Notas:** Apenas um rascunho por template (RN implícita — `TEMPLATE_DRAFT_EXISTS`); publicar (`TPL-10`) ou aposentar (`TPL-11`) libera a criação de um novo.

### TPL-07 — Consultar versão do template
`GET /api/v1/template-versions/{versionId}` · **Permissão:** `TEMPLATE_VIEW` (versão publicada: critério de visibilidade simplificado, impl.) · **Story:** US-107
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `versionId` (uuid, obrigatório).
- **Request:** —
- **Response:** `200 { data: TemplateVersion }` — `{ versionNumber, status, sections: SectionDefinition[], fieldConfig, importMappings, layout, changeNotes }`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 404 | `NOT_FOUND` | Versão inexistente/outro tenant |
- **Efeitos:** —
- **Notas:** `SectionDefinition` (entities.md §5.1): `{ key, title, order, requirement: SectionRequirement, helpText?, legalBasis?, defaultContent?, minChars?, maxChars, render, allowNarrative }`; `SectionRequirement` = `REQUIRED`\|`REQUIRED_OR_JUSTIFY`\|`OPTIONAL` (entities.md).

### TPL-08 — Atualizar conteúdo/layout da versão do template
`PATCH /api/v1/template-versions/{versionId}` · **Permissão:** `TEMPLATE_MANAGE` · **Story:** US-107, US-109
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `versionId` (uuid, obrigatório). Só é aceito enquanto a versão está `DRAFT`.
- **Request:** `{ sections?: SectionDefinition[]; fieldConfig?: Record<string, { label?: string; required?: boolean; defaultValue?: unknown }>; importMappings?: ImportMappings; changeNotes?: string; layout?: PrintLayout }`.
  - `SectionDefinition`: `{ key: string (SCREAMING_SNAKE_CASE, único na versão, obrigatório); title: string (1–150, obrigatório); order: number (sequencial ≥ 1, obrigatório); requirement: SectionRequirement (obrigatório, padrão REQUIRED); helpText?: string (markdown, ≤ 2.000); legalBasis?: string (≤ 300); defaultContent?: TipTapDoc (≤ 1 MB; variáveis validadas — RN-TPL-06); minChars?: number; maxChars: number (padrão 50.000; minChars ≤ maxChars); render?: string (padrão TEXT; RN-TPL-05); allowNarrative?: boolean (padrão true; só relevante se render ≠ TEXT) }`.
  - `ImportMappings` (entities.md §5.8): `{ fromDocumentType: 'ETP'; sections: Array<{ target: string; sources: string[]; mode: 'REPLACE'|'APPEND' }>; fields: Array<{ target: string; source: string }>; items: { copyQuantities: boolean; copyCalculationMemoToNotes: boolean } }`.
  - `PrintLayout` (US-109): `{ orientation: 'portrait'|'landscape' (padrão portrait); marginsMm: { top, right, bottom, left } (10–40 cada, padrão 20); fontFamily: string (enum fixo, padrão Inter); fontSizePt: number (9–14, padrão 11); lineHeight: number (1,0–2,0, padrão 1,15); header?: TipTapDoc (≤ 1 MB; variáveis — RN-TPL-22); footer?: TipTapDoc (≤ 1 MB); logo?: { attachmentId: string (uuid; `TENANT_ASSET`, `AVAILABLE` — RN-TPL-23); position?: 'left'|'center'|'right' (padrão left); maxHeightMm?: number (> 0 e ≤ margem superior, padrão 15) }; showPageNumbers?: boolean (padrão true); showDocumentHashInFooter?: boolean (padrão true); draftWatermark?: boolean (padrão true); pageSize: 'A4' (fixo no MVP 1, somente leitura) }`.
- **Response:** `200 { data: TemplateVersion }` + novo `ETag`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `TEMPLATE_MANAGE` |
  | 404 | `NOT_FOUND` | Versão inexistente/outro tenant |
  | 409 | `TEMPLATE_VERSION_NOT_DRAFT` | Versão já publicada ou aposentada |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `TEMPLATE_INVALID` | Chave de seção duplicada/fora do padrão; variável desconhecida em `defaultContent`/`helpText`/`header`/`footer`; `render` incompatível com o tipo de documento; `importMappings` referenciando seção inexistente |
  | 422 | `VALIDATION_ERROR` | `minChars > maxChars`; margem fora de 10–40 mm; `fontSizePt` fora de 9–14; `lineHeight` fora de 1,0–2,0; `logo.position` fora do enum (`INVALID_ENUM`) |
  | 409 | `ATTACHMENT_NOT_AVAILABLE` | `logo.attachmentId` existe mas não está `AVAILABLE` |
  | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | `logo.attachmentId` inexistente ou de outro tenant |
- **Efeitos:** Auditoria `template.update` (`CONFIGURATION`): para conteúdo, resumo (`sectionsChanged[]`, `fieldConfigChanged`, `importMappingsChanged`); para layout, `layoutChangedFields[]` (ex.: `fontFamily`, `logo.attachmentId`).
- **Notas:** Upload do logo usa o módulo de anexos (`ATT-02` a `ATT-05`, fora desta seção) com `targetType = 'TENANT_ASSET'`. Mapeamento padrão semeado para `importMappings` (ETP → documento): `OBJECT ← RECOMMENDED_SOLUTION`; `JUSTIFICATION ← NEED_DESCRIPTION + PROBLEM + OBJECTIVE` (`APPEND`); `SPECIFICATIONS ← REQUIREMENTS`; `ESTIMATED_VALUE ← ESTIMATES` (entities.md §5.8).

### TPL-09 — Solicitar prévia da versão do template
`POST /api/v1/template-versions/{versionId}/preview` · **Permissão:** `TEMPLATE_VIEW` · **Story:** US-109
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` opcional (a prévia não altera o recurso)
- **Parâmetros:** path `versionId` (uuid, obrigatório).
- **Request:** —
- **Response:** `202 { data: { renditionId: string } }`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `TEMPLATE_VIEW` |
  | 404 | `NOT_FOUND` | Versão inexistente/outro tenant |
  | 422 | `TEMPLATE_INVALID` | Layout/seções com pendências que impedem a geração da prévia |
- **Efeitos:** Nenhuma auditoria (ação de consulta/visualização, não altera dados) — apenas logs técnicos do worker de renderização.
- **Notas:** Classe "Exportações e renderização" (api.md §1.6): 20 req/min. Resultado consultado por `TPL-12`/`TPL-13`. Falha de renderização (Gotenberg/fila) é reportada como `errorCode` interno no estado da prévia, não como erro HTTP desta chamada.

### TPL-10 — Publicar versão do template
`POST /api/v1/template-versions/{versionId}/publish` · **Permissão:** `TEMPLATE_PUBLISH` · **Story:** US-108
- **Cabeçalhos:** `Idempotency-Key` obrigatório; `If-Match` obrigatório
- **Parâmetros:** path `versionId` (uuid, obrigatório).
- **Request:** —
- **Response:** `200 { data: TemplateVersion }` (`status = 'PUBLISHED'`).
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `TEMPLATE_PUBLISH` |
  | 404 | `NOT_FOUND` | Versão inexistente/outro tenant |
  | 409 | `TEMPLATE_VERSION_NOT_DRAFT` | Versão não está `DRAFT` |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `TEMPLATE_INVALID` | Violações bloqueantes impedem a publicação |
- **Efeitos:** Evento `TemplateVersionPublished` (`template.version_published`) — payload `templateId`, `templateVersionId`, `versionNumber`, `documentTypeCode`, `contentHash`. Auditoria `template.version_publish` (`CONFIGURATION`): `metadata.templateVersionId`, `versionNumber`, `contentHash`, `idempotencyKey`.
- **Notas:** Publicação é definitiva (versão passa a imutável); nova edição exige `TPL-06` (novo rascunho).

### TPL-11 — Aposentar versão do template
`POST /api/v1/template-versions/{versionId}/retire` · **Permissão:** `TEMPLATE_PUBLISH` · **Story:** US-108
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `versionId` (uuid, obrigatório).
- **Request:** —
- **Response:** `200 { data: TemplateVersion }` (`status = 'RETIRED'`).
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `TEMPLATE_PUBLISH` |
  | 404 | `NOT_FOUND` | Versão inexistente/outro tenant |
  | 409 | `INVALID_STATE` | Versão não está `PUBLISHED` |
  | 409 | `TEMPLATE_IN_USE` | É a versão corrente, sem substituta publicada, e é padrão de algum tipo de documento (`DTY-04`) |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
- **Efeitos:** Evento `TemplateVersionRetired` (`template.version_retired`) — payload `templateId`, `templateVersionId`. Auditoria `template.version_retire`: `metadata.templateVersionId`.
- **Notas:** Para trocar o padrão de um tipo de documento antes de aposentar, usar `DTY-04` ([03-documents.md](03-documents.md)).

### TPL-12 — Consultar prévia efêmera do template
`GET /api/v1/template-versions/{versionId}/preview/{renditionId}` · **Permissão:** `TEMPLATE_VIEW` · **Story:** US-109
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `versionId` (uuid, obrigatório); `renditionId` (uuid, obrigatório).
- **Request:** —
- **Response:** `200 { data: { renditionId, status: RenditionStatus, pageCount? } }` — estrutura exata não detalhada na fonte além do status efêmero; modelada por analogia a `DocumentRendition` (ver [03-documents.md §DOC-22](03-documents.md)) — confirmar na implementação.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 404 | `NOT_FOUND` | Prévia inexistente, de outro tenant ou expirada (não detalhado explicitamente na fonte; inferido por analogia a `DOC-22`) |
- **Efeitos:** Nenhum evento nem auditoria — estado efêmero.
- **Notas:** Estado mantido em **Redis, TTL 24 h** (não persiste em `DocumentRendition`); passado esse prazo, repetir `TPL-09`.

### TPL-13 — Baixar prévia efêmera do template
`GET /api/v1/template-versions/{versionId}/preview/{renditionId}/download` · **Permissão:** `TEMPLATE_VIEW` · **Story:** US-109
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `versionId` (uuid, obrigatório); `renditionId` (uuid, obrigatório).
- **Request:** —
- **Response:** `200 { data: { url: string, expiresAt: string } }`.
- **Erros:**
  | HTTP | `code` | Quando |
  |---|---|---|
  | 404 | `NOT_FOUND` | Prévia inexistente/outro tenant |
  | 409 | `RENDITION_NOT_READY` | Download antes de pronta ou após expirar os 24 h (inferido por analogia a `DOC-23`; não detalhado explicitamente na fonte) |
- **Efeitos:** —
- **Notas:** Mesmo TTL de 24 h de `TPL-12`; URL assinada e temporária (`expiresAt`), igual ao padrão de `DOC-23`.
