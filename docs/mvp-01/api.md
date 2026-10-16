# MVP 1 — API REST (`/api/v1`)

> **Documento canônico** do contrato da API do MVP 1. Base: [DEC-100 a DEC-108](../architecture/decisions.md#6-api), [permissions.md](permissions.md), [events.md](events.md), [entities.md](entities.md).
> As seções 1–3 (convenções, erros e catálogo) são normativas. A seção 4 detalha request, response, erros e eventos de cada endpoint. O OpenAPI 3.1 gerado dos schemas Zod (`packages/validation`) deve refletir exatamente este documento — divergências são bugs.

Sumário: [1. Convenções](#1-convenções) · [2. Erros](#2-erros) · [3. Catálogo de endpoints](#3-catálogo-de-endpoints) · [4. Especificação por endpoint](#4-especificação-por-endpoint)

---

## 1. Convenções

### 1.1 Base, formato e cabeçalhos
- Base: `https://<app>/api/v1` (chamado pelo browser via BFF, que encaminha à API interna — DEC-053).
- JSON UTF-8, camelCase; datas ISO 8601 UTC; datas puras `YYYY-MM-DD`; decimais como **string** (DEC-003).
- Respostas: `{ "data": … }` (recurso), `{ "data": [...], "meta": { … } }` (lista/feed) — DEC-106.

| Cabeçalho | Direção | Uso |
|---|---|---|
| `Authorization: Bearer <access_token>` | BFF → API | Inserido pelo BFF; nunca pelo browser |
| `X-Tenant-Id` | BFF → API | Órgão ativo da sessão (DEC-132) |
| `X-Correlation-Id` | ambos | Gerado no BFF se ausente; devolvido em toda resposta |
| `X-CF-Request: 1` | Browser → BFF | Obrigatório em métodos mutáveis (CSRF — DEC-135) |
| `Idempotency-Key` | Browser → API | UUID; aceito em `POST` de criação e comandos (DEC-105) |
| `If-Match: "<version>"` | Browser → API | Obrigatório em `PATCH`/`PUT`/`DELETE`/comandos sobre recursos versionados (DEC-104) |
| `ETag: "<version>"` | API → Browser | Em `GET` de recurso versionado e em respostas de mutação |
| `Location` | API → Browser | Em `201 Created` |
| `Idempotent-Replayed: true` | API → Browser | Resposta reproduzida de chave idempotente |
| `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After` | API → Browser | Limites (429) |

### 1.2 Paginação, ordenação, filtros e busca
- Listas: `?page=1&pageSize=20` (máx. 100) → `meta: { page, pageSize, totalItems, totalPages }`.
- Feeds: `?cursor=<opaco>&limit=50` (máx. 100) → `meta: { nextCursor, hasMore }`.
- Ordenação: `?sort=-updatedAt,code` (campos permitidos documentados por endpoint; padrão indicado).
- Filtros: `?status=IN_PROGRESS,RETURNED&priority=HIGH` (vírgula = OU; parâmetros distintos = E). Datas: `createdFrom`, `createdTo` (inclusivos).
- Busca textual: `?q=` (mín. 2 caracteres; FTS português + trigram em código/título).

### 1.3 Concorrência e idempotência
- `version` de cada recurso é exposto como `ETag`. Mutação com `If-Match` divergente → **412** `VERSION_CONFLICT` (corpo traz `currentVersion` e, quando útil, o recurso atual em `meta.current`). Sem `If-Match` onde exigido → **428** `PRECONDITION_REQUIRED`.
- Autosave de seção usa a **revisão da seção** no `If-Match` (`"s<revision>"`) → `SECTION_REVISION_CONFLICT` (412).
- `Idempotency-Key`: mesma chave + mesmo corpo em 24 h → mesma resposta (`Idempotent-Replayed: true`); mesma chave + corpo diferente → **422** `IDEMPOTENCY_KEY_REUSED`; requisição original ainda em processamento → **409** `IDEMPOTENCY_IN_PROGRESS`.

### 1.4 Valores sigilosos
Campos monetários de processos com orçamento sigiloso são retornados como `null` com `"<campo>Masked": true` para quem não atende POL-09 (ex.: `estimatedValue: null, estimatedValueMasked: true`). Nunca omitir o campo (contrato estável).

### 1.5 Autorização nas respostas
- Recurso de outro tenant, inexistente ou não visível → **404**.
- Visível sem permissão/política para a ação → **403** com `code` específico.
- Recursos com ações retornam `meta.allowedActions` quando indicado (evita chamada extra).
- IDs **referenciados no corpo** (ex.: `requestingDepartmentId`) que não existem, estão inativos, pertencem a outro tenant ou não estão no escopo do usuário → **422** `VALIDATION_ERROR` com `errors[].code = "REFERENCE_NOT_FOUND"` (ou `REFERENCE_INACTIVE`) no campo — nunca revelando a existência do recurso em outro tenant.
- Header `X-Tenant-Id` de tenant em que o usuário não tem vínculo ativo → **403** `MEMBERSHIP_INACTIVE`; tenant inexistente responde igual (nunca revela se o tenant existe); `TENANT_SUSPENDED` só aparece para quem tem vínculo no tenant (US-080).
- Header `X-Tenant-Id` **ausente ou malformado** (não é UUID) em rota de tenant → **400** `MALFORMED_REQUEST` com `errors[] = [{ field: "X-Tenant-Id", code: "REQUIRED" | "INVALID_FORMAT" }]` — não revela nada (não há tenant); o BFF refaz a seleção de instituição (US-100 · RN-TEN-19 · DEC-076). Rotas sem tenant ativo (ME-04, `/platform/*`, `/health/*`, aceite de convite) ignoram o cabeçalho; toda rota declara o escopo no OpenAPI (`x-tenant-scope`: `TENANT`, `PLATFORM`, `NONE` ou `CROSS_TENANT_LOOKUP`).
- Instituição em `OFFBOARDING` (DEC-132 · RN-TEN-37): vínculos `ADMIN_ORGAO`/`AUDITOR` têm acesso de leitura e exportação — todos os `GET` e as rotas de exportação DOC-20, DOC-21, DOC-23, ATT-05, AUD-03, PRS-22 e PRC-34; qualquer outro comando → **403** `TENANT_SUSPENDED`.

### 1.6 Limites (rate limiting)
| Classe | Limite padrão | Chave |
|---|---|---|
| Leitura | 600 req/min | usuário + tenant |
| Escrita/comandos | 120 req/min | usuário + tenant |
| Autosave de seção | 60 req/min por documento | usuário + documento |
| Exportações e renderização | 20 req/min | usuário + tenant |
| Upload (intenção) | 60 req/min | usuário + tenant |
| Global por tenant | 6.000 req/min | tenant |
| Auth (BFF) | 20 req/min | IP |

---

## 2. Erros

Formato RFC 9457 (DEC-103):
```json
{
  "type": "https://docs.contrataflow.com.br/errors/transition-blocked",
  "title": "Não é possível encaminhar o processo",
  "status": 422,
  "detail": "Há 2 pendências obrigatórias na etapa \"Estudos preliminares\".",
  "instance": "/api/v1/processes/0192…/forward",
  "code": "TRANSITION_BLOCKED",
  "correlationId": "c-7f3a2b",
  "errors": [],
  "violations": [
    { "ruleId": "0192…", "severity": "BLOCKING", "message": "O ETP deve estar completo." },
    { "ruleId": "0192…", "severity": "WARNING", "message": "Recomenda-se elaborar o mapa de riscos." }
  ]
}
```

### 2.1 Códigos genéricos
| Código | HTTP | Quando |
|---|---|---|
| `MALFORMED_REQUEST` | 400 | JSON inválido, tipo de conteúdo errado no corpo |
| `UNAUTHENTICATED` | 401 | Sem token válido |
| `SESSION_EXPIRED` | 401 | Sessão BFF expirada (ociosidade/absoluta) |
| `MFA_REQUIRED` | 403 | Ação exige MFA (POL-14) |
| `PERMISSION_DENIED` | 403 | Falta permissão no escopo |
| `TENANT_SUSPENDED` | 403 | Tenant não `ACTIVE` |
| `MEMBERSHIP_INACTIVE` | 403 | Vínculo não `ACTIVE`/expirado |
| `NOT_FOUND` / `<RESOURCE>_NOT_FOUND` | 404 | Inexistente, outro tenant ou não visível |
| `CONFLICT` | 409 | Conflito de estado genérico |
| `INVALID_STATE` | 409 | Operação incompatível com o status atual do recurso |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | Ver §1.3 |
| `VERSION_CONFLICT` | 412 | `If-Match` divergente |
| `PAYLOAD_TOO_LARGE` | 413 | Corpo acima do limite (padrão 2 MB; seções 1 MB) |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | |
| `VALIDATION_ERROR` | 422 | Falha de schema (Zod) — `errors[]` por campo |
| `BUSINESS_RULE_VIOLATION` | 422 | Regra de negócio genérica — `violations[]` |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Ver §1.3 |
| `PRECONDITION_REQUIRED` | 428 | `If-Match` ausente |
| `RATE_LIMITED` | 429 | |
| `INTERNAL_ERROR` | 500 | Erro inesperado (sem detalhes internos) |
| `DEPENDENCY_UNAVAILABLE` | 503 | Banco/Redis/S3/Authentik indisponível; `Retry-After` |

### 2.1.1 Códigos de erro por campo (`errors[].code`)
Usados dentro de `VALIDATION_ERROR` (422), um por campo inválido. Mensagens pt-BR em `errors[].message`.

| Código | Quando |
|---|---|
| `REQUIRED` | Campo obrigatório ausente ou vazio |
| `TOO_SHORT` / `TOO_LONG` | Fora dos limites de tamanho |
| `INVALID_FORMAT` | Formato inválido (e-mail, URL, data, máscara, cor) |
| `INVALID_ENUM` | Valor fora do enum |
| `OUT_OF_RANGE` | Número/data fora do intervalo permitido |
| `DATE_IN_PAST` | Data anterior à permitida (ex.: prazo alvo) |
| `INVALID_DECIMAL` | Decimal inválido ou com casas além do permitido |
| `INVALID_CNPJ` / `INVALID_CPF` | Dígito verificador inválido (CNPJ numérico ou alfanumérico) |
| `REFERENCE_NOT_FOUND` | Id referenciado inexistente, de outro tenant ou fora do escopo |
| `REFERENCE_INACTIVE` | Id referenciado inativo (catálogo, unidade, órgão, perfil) |
| `DEPARTMENT_NOT_IN_SECRETARIAT` | Setor fora da subárvore da secretaria informada |
| `CONDITIONAL_REQUIRED` | Obrigatório pela combinação de campos (ex.: justificativa quando `pcaStatus = NOT_PLANNED`) |
| `DUPLICATE_IN_LIST` | Item repetido em lista enviada |
| `NOT_ALLOWED` | Campo não editável no estado atual do recurso |

### 2.1.2 Violações de regras e de completude (`violations[]`)
Formato único para regras de workflow (`TRANSITION_BLOCKED`, `WARNINGS_NOT_ACKNOWLEDGED`, PRC-09) e para a validação de completude de documentos (DOC-08 e erros `DOCUMENT_INCOMPLETE`, `PRICE_RESEARCH_INCOMPLETE`):
```json
{ "code": "DFD_ITEMS_REQUIRED", "severity": "BLOCKING", "message": "Informe ao menos um item com quantidade.",
  "ruleId": null, "sectionKey": null, "field": null, "itemId": null, "params": {} }
```
- Regras de workflow: `code = "WORKFLOW_RULE"`, `ruleId` preenchido e `message` = mensagem configurada na regra.
- Completude genérica (módulo `document`): `SECTION_REQUIRED` (`sectionKey`), `SECTION_JUSTIFICATION_REQUIRED` (`sectionKey`), `SECTION_TOO_SHORT`, `FIELD_REQUIRED` (`field`), `ITEMS_REQUIRED`.
- Completude específica de cada tipo: códigos com prefixo do módulo — `DFD_*`, `ETP_*`, `PRICE_*`, `RISK_*`, `TR_*` — definidos na tabela de validações da story dona (US-014/US-016, US-023, US-029/US-032, US-035, US-039). São estáveis e documentados no card; a UI usa `code` para ícones/links e `message` para exibição.

### 2.2 Códigos de domínio
| Código | HTTP | Contexto |
|---|---|---|
| `POSSIBLE_DUPLICATE_PROCESS` | 409 | Processo semelhante criado recentemente (corpo traz candidatos; reenviar com `confirmDuplicate: true`) |
| `DUPLICATE_INTERNAL_CODE` | 409 | `internalCode` já usado no tenant |
| `NO_APPLICABLE_WORKFLOW` | 422 | Nenhum workflow publicado aplicável e sem padrão |
| `INVALID_PROCESS_STATUS` | 409 | Ação incompatível com o status do processo |
| `NOT_PROCESS_CUSTODIAN` | 403 | POL-01 |
| `STAGE_CHANGED` | 409 | `expectedStageId` difere da etapa atual (outro usuário tramitou) |
| `TRANSITION_NOT_AVAILABLE` | 422 | Transição inexistente/indisponível para a etapa |
| `TRANSITION_BLOCKED` | 422 | Regras `BLOCKING` não satisfeitas (`violations[]`) |
| `WARNINGS_NOT_ACKNOWLEDGED` | 422 | Regras `WARNING` não reconhecidas (`acknowledgedWarnings`) |
| `DEPARTMENT_REQUIRED` | 422 | Etapa destino `CHOSEN_ON_FORWARD` sem unidade |
| `DUE_DATE_OVERRIDE_NOT_ALLOWED` | 422 | Transição não permite alterar prazo |
| `PROCESS_ALREADY_ASSIGNED` | 409 | POL-04 |
| `ASSIGNEE_NOT_ELIGIBLE` | 422 | POL-05 |
| `APPROVER_NOT_ELIGIBLE` | 422 | POL-03/DEC-022 — novo aprovador do redirecionamento (`APV-05`) inelegível ou igual ao atual |
| `WIDGET_NOT_FOUND` | 404 | `widgetKey` fora do registro `DashboardWidgetKey` (`DSH-02`) |
| `STORAGE_QUOTA_EXCEEDED` | 422 | Upload acima do limite de armazenamento do tenant (limite técnico da plataforma, storage.md §8 — valor em PEND-17) |
| `CANNOT_DISCARD_NUMBERED_PROCESS` | 409 | Rascunho com número deve ser cancelado |
| `ITEM_IN_USE` | 409 | Item referenciado por documento/pesquisa |
| `PARTICIPANT_NOT_ELIGIBLE` | 422 | POL-10 |
| `DOCUMENT_ALREADY_EXISTS` | 409 | Tipo singular já existe no processo |
| `DOCUMENT_NOT_EDITABLE` | 409 | POL-02 (status) |
| `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | 422 | POL-02 (etapa) |
| `DOCUMENT_INCOMPLETE` | 422 | Validação de completude (`violations[]`) |
| `SECTION_REVISION_CONFLICT` | 412 | Autosave concorrente na mesma seção |
| `SECTION_NOT_IN_TEMPLATE` | 422 | Chave de seção inexistente no template da versão |
| `RICH_TEXT_INVALID` | 422 | Conteúdo TipTap fora do schema permitido |
| `APPROVAL_NOT_PENDING` | 409 | |
| `NOT_DESIGNATED_APPROVER` | 403 | POL-03 |
| `SELF_APPROVAL_FORBIDDEN` | 403 | Segregação de funções |
| `APPROVER_UNRESOLVED` | 422 | Ex.: unidade sem titular; perfil sem detentores no escopo |
| `RECOMMENDED_ALTERNATIVE_EXISTS` | 409 | Já existe alternativa recomendada (use `replaceRecommended: true`) |
| `QUOTATION_REQUIRED_FIELDS` | 422 | Campos exigidos pelo tipo de fonte ausentes |
| `PRICE_RESEARCH_INCOMPLETE` | 422 | Conclusão com itens sem preço/justificativa (`violations[]`) |
| `SUPPLIER_ALREADY_EXISTS` | 409 | Mesmo CNPJ/CPF no tenant |
| `SUPPLIER_IN_USE` | 409 | Exclusão de fornecedor referenciado por fonte de preço não excluída (oferecer "Inativar") |
| `ETP_REQUIRED_FOR_IMPORT` | 422 | Sem ETP no processo |
| `IMPORT_PREVIEW_EXPIRED` | 410 | Token de prévia expirado (15 min) ou origem alterada desde a prévia (ex.: ETP editado — US-037); refazer a prévia |
| `FILE_TYPE_NOT_ALLOWED` | 415 | Extensão/MIME fora da allowlist |
| `FILE_TOO_LARGE` | 413 | Acima de `uploads.maxFileSizeMb` |
| `UPLOAD_NOT_RECEIVED` | 409 | Confirmação sem objeto na quarentena |
| `ATTACHMENT_NOT_AVAILABLE` | 409 | Download de arquivo não `AVAILABLE` |
| `RENDITION_NOT_READY` | 409 | Download antes de `READY` |
| `TEMPLATE_INVALID` | 422 | Seções/variáveis/layout inválidos |
| `TEMPLATE_VERSION_NOT_DRAFT` | 409 | |
| `WORKFLOW_INVALID` | 422 | Grafo inválido (`errors[]` com `stageKey`/`transitionKey`) |
| `WORKFLOW_VERSION_NOT_DRAFT` | 409 | |
| `WORKFLOW_IN_USE` | 409 | Aposentar/desativar versão usada como única opção aplicável |
| `MEMBERSHIP_ALREADY_EXISTS` | 409 | Convite para usuário já vinculado |
| `ROLE_ALREADY_EXISTS` | 409 | Perfil com o mesmo nome (sem distinção de maiúsculas) ou chave no tenant (US-095) |
| `ROLE_ASSIGNMENT_ALREADY_EXISTS` | 409 | Atribuição ativa do mesmo perfil no mesmo escopo para o vínculo (US-096) |
| `PARTICIPANT_ALREADY_EXISTS` | 409 | Usuário/unidade já é participante ativo do processo (US-012) |
| `INVITATION_INVALID` | 404 | Token inválido |
| `INVITATION_EXPIRED` | 410 | |
| `LAST_ADMIN_REQUIRED` | 409 | POL-12 |
| `PRIMARY_ORGANIZATION_REQUIRED` | 409 | Inativar o órgão principal ou o único órgão ativo do tenant (US-101) |
| `PRIVILEGE_ESCALATION_FORBIDDEN` | 403 | POL-13 |
| `EXTERNAL_HIGH_RISK_ROLE` | 422 | POL-15 |
| `DEPARTMENT_HAS_REFERENCES` | 409 | Exclusão de unidade referenciada |
| `DEPARTMENT_CYCLE` | 422 | Movimentação criaria ciclo |
| `CATALOG_ITEM_SYSTEM` | 409 | Exclusão/alteração de código de item de sistema — `CatalogItem` ou `Holiday` semeado (`isSystem`) |
| `NUMBERING_MASK_INVALID` | 422 | Máscara sem `{seq:N}`/`{year}` ou com token desconhecido |
| `SETTING_KEY_UNKNOWN` | 422 | Chave fora do registro |
| `EXPORT_TOO_LARGE` | 422 | Exportação acima do limite (refinar filtros) |
| `TENANT_SLUG_TAKEN` | 409 | Plataforma |
| `WORKFLOW_DRAFT_EXISTS` | 409 | Já existe versão rascunho do workflow (uma por workflow); `meta.draftVersionId` traz o rascunho existente (US-040) |
| `TEMPLATE_DRAFT_EXISTS` | 409 | Já existe versão rascunho do template (uma por template) |
| `DOCUMENT_TYPE_CODE_TAKEN` | 409 | Código de tipo de documento já usado no tenant |
| `TEMPLATE_NAME_TAKEN` | 409 | Nome de template já usado para o mesmo tipo de documento no tenant (US-107) |
| `TEMPLATE_IN_USE` | 409 | Aposentar a versão corrente de um template padrão de tipo ativo sem outra versão publicada (US-108) |
| `COMMENT_EDIT_WINDOW_EXPIRED` | 409 | Edição de comentário após 15 minutos |
| `USER_BLOCKED` | 403 | `User.status = BLOCKED` (bloqueio de plataforma) |
| `CSRF_REJECTED` | 403 | BFF: falta `X-CF-Request` ou `Origin` inválido em método mutável |

### 2.3 Erros de validação do grafo de workflow (`WF_*`)
`WORKFLOW_INVALID` (422) traz, no membro de extensão `validation`, `errors[]` (bloqueiam a publicação) e `warnings[]` (não bloqueiam) — o `errors[]` de topo do problem+json continua reservado aos erros de campo (§2.1.1). Cada item: `{ code, message, stageKey, transitionKey, ruleId }` (`workflowValidationIssueSchema` em `packages/validation`). Catálogo definido na US-040:
- **Erros:** `WF_START_STAGE_COUNT`, `WF_END_STAGE_MISSING`, `WF_STAGE_UNREACHABLE`, `WF_END_UNREACHABLE`, `WF_APPROVAL_TRANSITIONS`, `WF_ACTION_NOT_ALLOWED_FROM_STAGE`, `WF_TRANSITION_TARGET_INVALID`, `WF_PRIMARY_DUPLICATED`, `WF_DOCUMENT_TYPE_UNKNOWN`, `WF_APPROVER_UNRESOLVABLE`, `WF_DEPARTMENT_INVALID`, `WF_RULE_CONFIG_INVALID`, `WF_RULE_PATH_UNKNOWN`, `WF_RULE_OPERATOR_FORBIDDEN`, `WF_RULE_SCOPE_INVALID`, `WF_LIMIT_EXCEEDED`.
- **Avisos:** `WF_STAGE_NO_SLA`, `WF_APPROVER_HEAD_MISSING`, `WF_STAGE_NO_INSTRUCTIONS`, `WF_RULE_INACTIVE`.

---

## 3. Catálogo de endpoints

Legenda: **Perm.** = permissão (+ política); "impl." = capacidade implícita (vínculo ativo); **Idem.** = aceita `Idempotency-Key`; **IM** = exige `If-Match`.

### 3.1 Sessão e usuário corrente (`identity`, `access`)
| # | Método | Rota | Perm. | Sucesso | Eventos | Story |
|---|---|---|---|---|---|---|
| ME-01 | GET | `/me` | impl. | 200 | — | US-086, US-098 |
| ME-02 | PATCH | `/me` | impl. (IM) | 200 | — (auditoria `profile.update`) | US-098 |
| ME-03 | GET | `/me/permissions` | impl. | 200 | — | US-097 |
| ME-04 | GET | `/me/memberships` | impl. | 200 | — | US-093 |
| ME-05 | GET | `/me/notification-preferences` | impl. | 200 | — | US-113 |
| ME-06 | PUT | `/me/notification-preferences` | impl. | 200 | — | US-113 |

Rotas do BFF (não fazem parte da API NestJS; especificadas em [authentication.md](../architecture/authentication.md)): `GET /api/auth/login`, `GET /api/auth/callback`, `POST /api/auth/logout`, `GET /api/auth/session`, `POST /api/auth/switch-tenant`, `GET /api/auth/step-up`, `GET /api/auth/forgot-password` (US-089).

### 3.2 Processos (`process`)
| # | Método | Rota | Perm. | Sucesso | Eventos | Story |
|---|---|---|---|---|---|---|
| PRC-01 | GET | `/processes` | `PROCESS_VIEW` | 200 | — | US-002 |
| PRC-02 | POST | `/processes` | `PROCESS_CREATE` (Idem.) | 201 | `ProcessCreated` | US-001 |
| PRC-03 | POST | `/processes/check-duplicates` | `PROCESS_CREATE` | 200 | — | US-001 |
| PRC-04 | GET | `/processes/{id}` | `PROCESS_VIEW` | 200 | — | US-004 |
| PRC-05 | PATCH | `/processes/{id}` | `PROCESS_UPDATE` + POL-01 (IM) | 200 | `ProcessUpdated` | US-005 |
| PRC-06 | DELETE | `/processes/{id}` | criador com `PROCESS_CREATE` ou `PROCESS_CANCEL` (IM) | 204 | `ProcessDraftDiscarded` | US-009 |
| PRC-07 | GET | `/processes/{id}/summary` | `PROCESS_VIEW` | 200 | — | US-004 |
| PRC-08 | GET | `/processes/{id}/available-actions` | `PROCESS_VIEW` | 200 | — | US-004, US-041 |
| PRC-09 | GET | `/processes/{id}/checklist` | `PROCESS_VIEW` | 200 | — | US-004, US-041 |
| PRC-10 | GET | `/processes/{id}/stages` | `PROCESS_VIEW` | 200 | — | US-004, US-054 |
| PRC-11 | GET | `/processes/{id}/movements` | `PROCESS_VIEW` | 200 | — | US-054 |
| PRC-12 | GET | `/processes/{id}/timeline` | `PROCESS_VIEW` | 200 | — | US-060 |
| PRC-13 | GET | `/processes/{id}/items` | `PROCESS_VIEW` | 200 | — | US-006 |
| PRC-14 | POST | `/processes/{id}/items` | `PROCESS_UPDATE` + POL-01 (Idem.) | 201 | `ProcessItemsChanged` | US-006 |
| PRC-15 | PATCH | `/process-items/{itemId}` | `PROCESS_UPDATE` + POL-01 (IM) | 200 | `ProcessItemsChanged` | US-006 |
| PRC-16 | DELETE | `/process-items/{itemId}` | `PROCESS_UPDATE` + POL-01 (IM) | 204 | `ProcessItemsChanged` | US-006 |
| PRC-17 | POST | `/processes/{id}/items/reorder` | `PROCESS_UPDATE` + POL-01 (IM no processo) | 200 | `ProcessItemsChanged` | US-006 |
| PRC-18 | PUT | `/processes/{id}/tags` | `PROCESS_UPDATE` + POL-01 (IM) | 200 | `ProcessUpdated` | US-007 |
| PRC-19 | POST | `/processes/{id}/forward` | `PROCESS_FORWARD` + POL-01 (IM, Idem.) | 200 | `ProcessStageChanged`, `ProcessStatusChanged`, `ProcessAssigned`, `ProcessNumberAssigned`, `DocumentSubmitted`, `DocumentVersionCreated`, `ApprovalRequested` | US-047 |
| PRC-20 | POST | `/processes/{id}/return` | `PROCESS_RETURN` + POL-01 (IM, Idem.) | 200 | `ProcessStageChanged`, `ProcessStatusChanged`, `ProcessAssigned` | US-048 |
| PRC-21 | POST | `/processes/{id}/claim` | `PROCESS_CLAIM` + POL-04 (IM) | 200 | `ProcessAssigned` | US-049 |
| PRC-22 | POST | `/processes/{id}/assign` | `PROCESS_ASSIGN` ou titular + POL-05 (IM) | 200 | `ProcessAssigned` | US-050 |
| PRC-23 | POST | `/processes/{id}/suspend` | `PROCESS_SUSPEND` + POL-07 (IM) | 200 | `ProcessStatusChanged` | US-008 |
| PRC-24 | POST | `/processes/{id}/resume` | `PROCESS_SUSPEND` + POL-07 (IM) | 200 | `ProcessStatusChanged` | US-008 |
| PRC-25 | POST | `/processes/{id}/cancel` | `PROCESS_CANCEL` + POL-06 (IM) | 200 | `ProcessStatusChanged`, `ApprovalCanceled` | US-009 |
| PRC-26 | POST | `/processes/{id}/complete` | `PROCESS_COMPLETE` + POL-08 (IM, Idem.) | 200 | `ProcessStageChanged`, `ProcessStatusChanged` | US-010 |
| PRC-27 | POST | `/processes/{id}/duplicate` | `PROCESS_DUPLICATE` + `PROCESS_CREATE` (Idem.) | 201 | `ProcessCreated`, `ProcessDuplicated`, `DocumentCreated` | US-011 |
| PRC-28 | GET | `/processes/{id}/participants` | `PROCESS_VIEW` | 200 | — | US-012 |
| PRC-29 | POST | `/processes/{id}/participants` | `PROCESS_MANAGE_PARTICIPANTS` + POL-10 (Idem.) | 201 | `ProcessParticipantAdded` | US-012 |
| PRC-30 | DELETE | `/process-participants/{participantId}` | `PROCESS_MANAGE_PARTICIPANTS` | 204 | `ProcessParticipantRemoved` | US-012 |
| PRC-31 | POST | `/processes/{id}/follow` | `PROCESS_FOLLOW` | 200 | `ProcessParticipantAdded` | US-012 |
| PRC-32 | DELETE | `/processes/{id}/follow` | `PROCESS_FOLLOW` | 204 | `ProcessParticipantRemoved` | US-012 |
| PRC-33 | PUT | `/processes/{id}/confidentiality` | `PROCESS_SET_CONFIDENTIAL_BUDGET` (IM) | 200 | `ProcessConfidentialityChanged` | US-013 |
| PRC-34 | GET | `/processes/export` | `PROCESS_EXPORT` | 200 (`text/csv`) | — (auditoria `process.export`) | US-003 |
| PRC-35 | GET | `/saved-views` | `PROCESS_VIEW` ou `INBOX_VIEW` | 200 | — | US-003 |
| PRC-36 | POST | `/saved-views` | idem | 201 | — | US-003 |
| PRC-37 | PATCH | `/saved-views/{id}` | dono (IM) | 200 | — | US-003 |
| PRC-38 | DELETE | `/saved-views/{id}` | dono | 204 | — | US-003 |
| TAG-01 | GET | `/tags` | `PROCESS_VIEW` | 200 | — | US-007 |
| TAG-02 | POST | `/tags` | `TAG_MANAGE` | 201 | — | US-007 |
| TAG-03 | PATCH | `/tags/{id}` | `TAG_MANAGE` (IM) | 200 | — | US-007 |

### 3.3 Documentos genéricos, versões e renderização (`document`)
| # | Método | Rota | Perm. | Sucesso | Eventos | Story |
|---|---|---|---|---|---|---|
| DOC-01 | GET | `/processes/{id}/documents` | `PROCESS_VIEW` | 200 | — | US-062 |
| DOC-02 | POST | `/processes/{id}/documents` | `DOCUMENT_CREATE` + POL-02 (Idem.) | 201 | `DocumentCreated` | US-063, US-064 |
| DOC-03 | GET | `/documents/{id}` | `PROCESS_VIEW` (+POL-09) | 200 | — | US-062 |
| DOC-04 | PATCH | `/documents/{id}` | permissão de edição do tipo + POL-02 (IM) | 200 | — | US-065 |
| DOC-05 | PUT | `/documents/{id}/sections/{sectionKey}` | permissão de edição do tipo + POL-02 (IM de seção) | 200 | — (auditoria coalescida) | US-015, US-020, US-036, US-063 |
| DOC-06 | GET | `/documents/{id}/items` | `PROCESS_VIEW` | 200 | — | US-014, US-022, US-038 |
| DOC-07 | PUT | `/documents/{id}/items` | permissão de edição do tipo + POL-02 (IM) | 200 | — | US-014, US-022, US-038 |
| DOC-08 | GET | `/documents/{id}/validation` | `PROCESS_VIEW` | 200 | — | US-065 |
| DOC-09 | POST | `/documents/{id}/submit` | permissão de submissão do tipo + POL-02 (IM, Idem.) | 200 | `DocumentSubmitted`, `DocumentVersionCreated`, `ApprovalRequested` | US-065 |
| DOC-10 | POST | `/documents/{id}/finalize` | permissão de submissão do tipo + POL-02 (IM, Idem.) | 200 | `DocumentFinalized`, `DocumentVersionCreated` | US-065 |
| DOC-11 | POST | `/documents/{id}/withdraw` | permissão de submissão do tipo (IM) | 200 | `DocumentWithdrawn`, `ApprovalCanceled` | US-053 |
| DOC-12 | POST | `/documents/{id}/reopen` | `DOCUMENT_REOPEN` + POL-11 (IM) | 200 | `DocumentReopened` | US-065 |
| DOC-13 | POST | `/documents/{id}/cancel` | `DOCUMENT_CANCEL` + custódia (IM) | 200 | `DocumentCanceled` | US-065 |
| DOC-14 | DELETE | `/documents/{id}` | permissão de edição do tipo + nunca submetido (IM) | 204 | — (auditoria `document.delete`) | US-065 |
| DOC-15 | GET | `/documents/{id}/versions` | `PROCESS_VIEW` | 200 | — | US-066 |
| DOC-16 | POST | `/documents/{id}/versions` | permissão de edição do tipo + POL-02 (Idem.) | 201 | `DocumentVersionCreated` | US-066 |
| DOC-17 | GET | `/document-versions/{versionId}` | `PROCESS_VIEW` (+POL-09) | 200 | — | US-066 |
| DOC-18 | GET | `/documents/{id}/versions/compare?from=&to=` | `PROCESS_VIEW` (+POL-09) | 200 | — | US-066 |
| DOC-19 | POST | `/documents/{id}/upload-version` | `DOCUMENT_UPDATE` + POL-02 (IM, Idem.) | 201 | `DocumentVersionCreated` | US-064 |
| DOC-20 | POST | `/documents/{id}/preview` | `PROCESS_VIEW` | 202 | — | US-067 |
| DOC-21 | POST | `/document-versions/{versionId}/renditions` | `PROCESS_VIEW` (+POL-09) | 202 | — | US-067 |
| DOC-22 | GET | `/document-renditions/{renditionId}` | `PROCESS_VIEW` (+POL-09) | 200 | — | US-067 |
| DOC-23 | GET | `/document-renditions/{renditionId}/download` | `PROCESS_VIEW` (+POL-09) | 200 (`{ url, expiresAt }`) | — (auditoria `document.download`) | US-067 |
| DOC-24 | PUT | `/documents/{id}/presence` | permissão de edição do tipo + POL-02 | 200 | — (Redis, TTL 60 s) | US-070 |
| DOC-25 | DELETE | `/documents/{id}/presence` | sessão autenticada (própria presença) | 204 | — | US-070 |
| DTY-01 | GET | `/document-types` | impl. | 200 | — | US-061 |
| DTY-02 | POST | `/document-types` | `DOCUMENT_TYPE_MANAGE` | 201 | `DocumentTypeChanged` | US-061 |
| DTY-03 | PATCH | `/document-types/{id}` | `DOCUMENT_TYPE_MANAGE` (IM) | 200 | `DocumentTypeChanged` | US-061 |
| DTY-04 | PUT | `/document-types/{id}/default-template` | `TEMPLATE_PUBLISH` (IM) | 200 | `DocumentTypeChanged` | US-108 |

### 3.4 Templates (`document`)
| # | Método | Rota | Perm. | Sucesso | Eventos | Story |
|---|---|---|---|---|---|---|
| TPL-01 | GET | `/templates` | `TEMPLATE_VIEW` (lista resumida: impl.) | 200 | — | US-107 |
| TPL-02 | POST | `/templates` | `TEMPLATE_MANAGE` | 201 | — | US-107 |
| TPL-03 | GET | `/templates/{id}` | `TEMPLATE_VIEW` | 200 | — | US-107 |
| TPL-04 | PATCH | `/templates/{id}` | `TEMPLATE_MANAGE` (IM) | 200 | — | US-107 |
| TPL-05 | GET | `/templates/{id}/versions` | `TEMPLATE_VIEW` | 200 | — | US-108 |
| TPL-06 | POST | `/templates/{id}/versions` | `TEMPLATE_MANAGE` | 201 | — | US-108 |
| TPL-07 | GET | `/template-versions/{versionId}` | `TEMPLATE_VIEW` (versão publicada: impl.) | 200 | — | US-107 |
| TPL-08 | PATCH | `/template-versions/{versionId}` | `TEMPLATE_MANAGE` (IM) | 200 | — | US-107, US-109 |
| TPL-09 | POST | `/template-versions/{versionId}/preview` | `TEMPLATE_VIEW` | 202 | — | US-109 |
| TPL-10 | POST | `/template-versions/{versionId}/publish` | `TEMPLATE_PUBLISH` (IM) | 200 | `TemplateVersionPublished` | US-108 |
| TPL-11 | POST | `/template-versions/{versionId}/retire` | `TEMPLATE_PUBLISH` (IM) | 200 | `TemplateVersionRetired` | US-108 |
| TPL-12 | GET | `/template-versions/{versionId}/preview/{renditionId}` | `TEMPLATE_VIEW` | 200 | — (estado efêmero em Redis, TTL 24 h) | US-109 |
| TPL-13 | GET | `/template-versions/{versionId}/preview/{renditionId}/download` | `TEMPLATE_VIEW` | 200 (`{ url, expiresAt }`) | — | US-109 |

### 3.5 DFD (`dfd`)
| # | Método | Rota | Perm. | Sucesso | Eventos | Story |
|---|---|---|---|---|---|---|
| DFD-01 | GET | `/processes/{id}/dfds` | `PROCESS_VIEW` | 200 | — | US-014 |
| DFD-02 | POST | `/processes/{id}/dfds` | `DFD_CREATE` + POL-02 (Idem.) | 201 | `DocumentCreated` (`DFDCreated`) | US-014 |
| DFD-03 | GET | `/dfds/{id}` | `PROCESS_VIEW` | 200 | — | US-014, US-015 |
| DFD-04 | PATCH | `/dfds/{id}` | `DFD_UPDATE` + POL-02 (IM) | 200 | — | US-015 |
| DFD-05 | POST | `/dfds/{id}/duplicate` | `DFD_CREATE` (+ `PROCESS_CREATE` se novo processo) (Idem.) | 201 | `DocumentCreated`, `ProcessCreated?` | US-018 |

Seções, itens, validação, finalização e versões do DFD usam os endpoints genéricos DOC-05..DOC-19 com o `documentId` do DFD. "Concluir e enviar para aprovação" (US-016) = `POST /processes/{id}/forward` para a etapa de aprovação (que submete o DFD automaticamente — DEC-018).

### 3.6 ETP (`etp`)
| # | Método | Rota | Perm. | Sucesso | Eventos | Story |
|---|---|---|---|---|---|---|
| ETP-01 | GET | `/processes/{id}/etps` | `PROCESS_VIEW` | 200 | — | US-019 |
| ETP-02 | POST | `/processes/{id}/etps` | `ETP_CREATE` + POL-02 (Idem.) | 201 | `DocumentCreated` (`ETPCreated`) | US-019 |
| ETP-03 | GET | `/etps/{id}` | `PROCESS_VIEW` (+POL-09) | 200 | — | US-020 |
| ETP-04 | PATCH | `/etps/{id}` | `ETP_UPDATE` + POL-02 (IM) | 200 | — | US-022, US-023 |
| ETP-05 | GET | `/etps/{id}/alternatives` | `PROCESS_VIEW` (+POL-09) | 200 | — | US-021 |
| ETP-06 | POST | `/etps/{id}/alternatives` | `ETP_UPDATE` + POL-02 | 201 | — | US-021 |
| ETP-07 | PATCH | `/etp-alternatives/{alternativeId}` | `ETP_UPDATE` + POL-02 (IM) | 200 | — | US-021 |
| ETP-08 | DELETE | `/etp-alternatives/{alternativeId}` | `ETP_UPDATE` + POL-02 (IM) | 204 | — | US-021 |
| ETP-09 | POST | `/etp-alternatives/{alternativeId}/decide` | `ETP_UPDATE` + POL-02 (IM) | 200 | `EtpAlternativeRecommended` | US-021 |

### 3.7 Pesquisa de preços e fornecedores (`price-research`, `supplier`)
| # | Método | Rota | Perm. | Sucesso | Eventos | Story |
|---|---|---|---|---|---|---|
| PRS-01 | GET | `/processes/{id}/price-research` | `PROCESS_VIEW` | 200 | — | US-024 |
| PRS-02 | POST | `/processes/{id}/price-research` | `PRICE_RESEARCH_CREATE` + POL-02 (Idem.) | 201 | `DocumentCreated` | US-024 |
| PRS-03 | GET | `/price-research/{id}` | `PROCESS_VIEW` (+POL-09) | 200 | — | US-024 |
| PRS-04 | PATCH | `/price-research/{id}` | `PRICE_RESEARCH_UPDATE` + POL-02 (IM) | 200 | `PriceResearchRecalculated` | US-024, US-029 |
| PRS-05 | GET | `/price-research/{id}/items` | `PROCESS_VIEW` (+POL-09) | 200 | — | US-024, US-029 |
| PRS-06 | POST | `/price-research/{id}/items` | `PRICE_RESEARCH_UPDATE` + POL-02 | 201 | `PriceResearchRecalculated` | US-024 |
| PRS-07 | PATCH | `/price-items/{itemId}` | `PRICE_RESEARCH_UPDATE` + POL-02 (IM) | 200 | `PriceResearchRecalculated` | US-029 |
| PRS-08 | DELETE | `/price-items/{itemId}` | `PRICE_RESEARCH_UPDATE` + POL-02 (IM) | 204 | `PriceResearchRecalculated` | US-024 |
| PRS-09 | GET | `/price-research/{id}/sources` | `PROCESS_VIEW` (+POL-09) | 200 | — | US-026 |
| PRS-10 | POST | `/price-research/{id}/sources` | `PRICE_RESEARCH_UPDATE` + POL-02 (Idem.) | 201 | — | US-026 |
| PRS-11 | PATCH | `/price-sources/{sourceId}` | `PRICE_RESEARCH_UPDATE` + POL-02 (IM) | 200 | `PriceResearchRecalculated` | US-026 |
| PRS-12 | DELETE | `/price-sources/{sourceId}` | `PRICE_RESEARCH_UPDATE` + POL-02 (IM) | 204 | `PriceResearchRecalculated` | US-026 |
| PRS-13 | PUT | `/price-sources/{sourceId}/quotations` | `PRICE_RESEARCH_UPDATE` + POL-02 (IM da fonte) | 200 | `PriceResearchRecalculated` | US-026 |
| PRS-14 | PATCH | `/quotations/{quotationId}` | `PRICE_RESEARCH_UPDATE` + POL-02 (IM) | 200 | `PriceResearchRecalculated` | US-026 |
| PRS-15 | DELETE | `/quotations/{quotationId}` | `PRICE_RESEARCH_UPDATE` + POL-02 (IM) | 204 | `PriceResearchRecalculated` | US-026 |
| PRS-16 | POST | `/quotations/{quotationId}/exclude` | `PRICE_RESEARCH_EXCLUDE_QUOTATION` + POL-02 (IM) | 200 | `QuotationExcluded`, `PriceResearchRecalculated` | US-027 |
| PRS-17 | POST | `/quotations/{quotationId}/restore` | `PRICE_RESEARCH_EXCLUDE_QUOTATION` + POL-02 (IM) | 200 | `QuotationRestored`, `PriceResearchRecalculated` | US-027 |
| PRS-18 | POST | `/price-research/{id}/import-preview` | `PRICE_RESEARCH_UPDATE` + POL-02 | 200 | — | US-028 |
| PRS-19 | POST | `/price-research/{id}/import` | `PRICE_RESEARCH_UPDATE` + POL-02 (Idem.) | 200 | `PriceResearchRecalculated` | US-028 |
| PRS-20 | POST | `/price-research/{id}/recalculate` | `PRICE_RESEARCH_UPDATE` + POL-02 | 200 | `PriceResearchRecalculated` | US-029 |
| PRS-21 | GET | `/price-research/{id}/comparative-map` | `PROCESS_VIEW` (+POL-09) | 200 | — | US-031 |
| PRS-22 | GET | `/price-research/{id}/comparative-map/export?format=xlsx` | `PROCESS_VIEW` (+POL-09) | 200 (`xlsx`) | — (auditoria `price_research.export`) | US-031 |
| PRS-23 | POST | `/price-research/{id}/complete` | `PRICE_RESEARCH_COMPLETE` + POL-02 (IM, Idem.) | 200 | `DocumentFinalized` (`PriceResearchCompleted`), `DocumentVersionCreated` | US-032 |
| PRS-24 | GET | `/price-research/{id}/import-template` | `PRICE_RESEARCH_UPDATE` + POL-02 | 200 (`xlsx`) | — | US-028 |
| SUP-01 | GET | `/suppliers` | `SUPPLIER_VIEW` | 200 | — | US-025 |
| SUP-02 | POST | `/suppliers` | `SUPPLIER_MANAGE` (Idem.) | 201 | `SupplierCreated` | US-025 |
| SUP-03 | GET | `/suppliers/{id}` | `SUPPLIER_VIEW` | 200 | — | US-025 |
| SUP-04 | PATCH | `/suppliers/{id}` | `SUPPLIER_MANAGE` (IM) | 200 | `SupplierUpdated` | US-025 |
| SUP-05 | DELETE | `/suppliers/{id}` | `SUPPLIER_MANAGE` (IM; somente sem uso) | 204 | — | US-025 |
| SUP-06 | GET | `/suppliers/lookup?documentNumber=` | `SUPPLIER_VIEW` | 200 | — | US-025 |

> "Mapa comparativo" em PDF = renderização do documento `PRICE_RESEARCH` (DOC-20/DOC-21), cujo template inclui a seção `PRICE_SUMMARY`.

### 3.8 Riscos (`risk`)
| # | Método | Rota | Perm. | Sucesso | Eventos | Story |
|---|---|---|---|---|---|---|
| RSK-01 | GET | `/processes/{id}/risks` | `PROCESS_VIEW` | 200 | — | US-033 |
| RSK-02 | POST | `/processes/{id}/risks` | `RISK_MANAGE` + POL-02 (Idem.) | 201 | `RiskCreated` | US-033 |
| RSK-03 | GET | `/risks/{id}` | `PROCESS_VIEW` | 200 | — | US-033 |
| RSK-04 | PATCH | `/risks/{id}` | `RISK_MANAGE` + POL-02 (IM) | 200 | `RiskAssessed` (se P/I mudar) | US-033 |
| RSK-05 | DELETE | `/risks/{id}` | `RISK_MANAGE` + POL-02 (IM) | 204 | `RiskDeleted` | US-033 |
| RSK-06 | POST | `/risks/{id}/treatments` | `RISK_MANAGE` + POL-02 | 201 | `RiskTreatmentChanged` | US-034 |
| RSK-07 | PATCH | `/risk-treatments/{treatmentId}` | `RISK_MANAGE` + POL-02 (IM) | 200 | `RiskTreatmentChanged` | US-034 |
| RSK-08 | DELETE | `/risk-treatments/{treatmentId}` | `RISK_MANAGE` + POL-02 (IM) | 204 | `RiskTreatmentChanged` | US-034 |
| RSK-09 | GET | `/processes/{id}/risk-matrix` | `PROCESS_VIEW` | 200 | — | US-035 |
| RSK-10 | POST | `/processes/{id}/risk-map` | `RISK_MANAGE` + POL-02 (Idem.) | 201 | `DocumentCreated` | US-035 |

> Edição de riscos (POL-02) considera o documento `RISK_MAP`: se existir e estiver em `FINALIZED`/`APPROVED`/`IN_REVIEW`, riscos ficam bloqueados até reabertura. Sem documento, riscos são editáveis sob custódia.

### 3.9 Termo de Referência (`term`)
| # | Método | Rota | Perm. | Sucesso | Eventos | Story |
|---|---|---|---|---|---|---|
| TRM-01 | GET | `/processes/{id}/terms` | `PROCESS_VIEW` | 200 | — | US-036 |
| TRM-02 | POST | `/processes/{id}/terms` | `TERM_CREATE` + POL-02 (Idem.) | 201 | `DocumentCreated` | US-036 |
| TRM-03 | GET | `/terms/{id}` | `PROCESS_VIEW` (+POL-09) | 200 | — | US-036 |
| TRM-04 | PATCH | `/terms/{id}` | `TERM_UPDATE` + POL-02 (IM) | 200 | — | US-038 |
| TRM-05 | POST | `/terms/{id}/import-etp/preview` | `TERM_UPDATE` + POL-02 | 200 | — | US-037 |
| TRM-06 | POST | `/terms/{id}/import-etp` | `TERM_UPDATE` + POL-02 (IM, Idem.) | 200 | `TermImportedFromEtp` | US-037 |

### 3.10 Workflow (`workflow`)
| # | Método | Rota | Perm. | Sucesso | Eventos | Story |
|---|---|---|---|---|---|---|
| WF-01 | GET | `/workflows` | `WORKFLOW_VIEW` | 200 | — | US-043 |
| WF-02 | POST | `/workflows` | `WORKFLOW_MANAGE` (Idem.) | 201 | `WorkflowCreated` | US-040, US-043 |
| WF-03 | GET | `/workflows/{id}` | `WORKFLOW_VIEW` | 200 | — | US-040, US-043 |
| WF-04 | PATCH | `/workflows/{id}` | `WORKFLOW_MANAGE` (IM) | 200 | — | US-040, US-042, US-043 |
| WF-05 | POST | `/workflows/{id}/set-default` | `WORKFLOW_PUBLISH` (IM) | 200 | `WorkflowDefaultChanged` | US-042 |
| WF-06 | POST | `/workflows/resolve` | `WORKFLOW_VIEW` | 200 | — | US-042 |
| WF-07 | GET | `/workflows/{id}/versions` | `WORKFLOW_VIEW` | 200 | — | US-040, US-045 |
| WF-08 | POST | `/workflows/{id}/versions` | `WORKFLOW_MANAGE` | 201 | — | US-040, US-043, US-045 |
| WF-09 | GET | `/workflow-versions/{versionId}` | `WORKFLOW_VIEW` | 200 | — | US-040, US-043, US-046 |
| WF-10 | POST | `/workflow-versions/{versionId}/stages` | `WORKFLOW_MANAGE` | 201 | — | US-040, US-043 |
| WF-11 | PATCH | `/workflow-stages/{stageId}` | `WORKFLOW_MANAGE` (IM) | 200 | — | US-040, US-043 |
| WF-12 | DELETE | `/workflow-stages/{stageId}` | `WORKFLOW_MANAGE` (IM) | 204 | — | US-040, US-043 |
| WF-13 | POST | `/workflow-versions/{versionId}/transitions` | `WORKFLOW_MANAGE` | 201 | — | US-040, US-043 |
| WF-14 | PATCH | `/workflow-transitions/{transitionId}` | `WORKFLOW_MANAGE` (IM) | 200 | — | US-040, US-043 |
| WF-15 | DELETE | `/workflow-transitions/{transitionId}` | `WORKFLOW_MANAGE` (IM) | 204 | — | US-040, US-043 |
| WF-16 | POST | `/workflow-versions/{versionId}/rules` | `WORKFLOW_MANAGE` | 201 | — | US-040, US-044 |
| WF-17 | PATCH | `/workflow-rules/{ruleId}` | `WORKFLOW_MANAGE` (IM) | 200 | — | US-040, US-044 |
| WF-18 | DELETE | `/workflow-rules/{ruleId}` | `WORKFLOW_MANAGE` (IM) | 204 | — | US-040, US-044 |
| WF-19 | GET | `/rule-context/schema` | `WORKFLOW_VIEW` | 200 | — | US-044 |
| WF-20 | POST | `/workflow-versions/{versionId}/validate` | `WORKFLOW_VIEW` | 200 | — | US-045 |
| WF-21 | POST | `/workflow-versions/{versionId}/publish` | `WORKFLOW_PUBLISH` (IM) | 200 | `WorkflowVersionPublished` | US-045 |
| WF-22 | POST | `/workflow-versions/{versionId}/retire` | `WORKFLOW_PUBLISH` (IM) | 200 | `WorkflowVersionRetired` | US-045 |
| WF-23 | POST | `/workflow-versions/{versionId}/rules/test` | `WORKFLOW_MANAGE` + `PROCESS_VIEW` do processo base | 200 | — | US-044 |

### 3.11 Aprovações e caixa de tarefas (`approval`, `inbox`)
| # | Método | Rota | Perm. | Sucesso | Eventos | Story |
|---|---|---|---|---|---|---|
| APV-01 | GET | `/approvals` | `APPROVAL_VIEW` (ou designado) | 200 | — | US-057 |
| APV-02 | GET | `/approvals/{id}` | `APPROVAL_VIEW` ou designado | 200 | — | US-052 |
| APV-03 | POST | `/approvals/{id}/decide` | `APPROVAL_DECIDE` + POL-03 (IM, Idem.) | 200 | `ApprovalCompleted`/`ApprovalReturned`/`ApprovalRejected`, `DocumentApproved`/`Returned`/`Rejected`, `ProcessStageChanged`, `ProcessStatusChanged`, `ApprovalRequested` (próxima etapa) | US-052 |
| APV-04 | POST | `/approvals/{id}/withdraw` | `PROCESS_FORWARD` + POL-17 (IM) | 200 | `ApprovalCanceled`, `ProcessStageChanged` | US-053 |
| APV-05 | POST | `/approvals/{id}/reassign` | `APPROVAL_REASSIGN` (IM) | 200 | `ApprovalReassigned` | US-053 |
| TSK-01 | GET | `/tasks` | `INBOX_VIEW` | 200 | — | US-056 |
| TSK-02 | GET | `/tasks/counters` | `INBOX_VIEW` | 200 | — | US-056 |
| TSK-03 | POST | `/tasks/bulk-claim` | `PROCESS_CLAIM` (Idem.) | 200 (resultado por item; lote de 2 a 50) | `ProcessAssigned` | US-058 |
| TSK-04 | POST | `/tasks/bulk-assign` | `PROCESS_ASSIGN`/titular (Idem.) | 200 (resultado por item; lote de 2 a 50) | `ProcessAssigned` | US-058 |

### 3.12 Comentários e anexos (`collaboration`, `files`)
| # | Método | Rota | Perm. | Sucesso | Eventos | Story |
|---|---|---|---|---|---|---|
| CMT-01 | GET | `/processes/{id}/comments` | `PROCESS_VIEW` | 200 | — | US-071 |
| CMT-02 | POST | `/processes/{id}/comments` | `COMMENT_CREATE` (Idem.) | 201 | `CommentCreated`, `UserMentioned` | US-071, US-072 |
| CMT-03 | PATCH | `/comments/{id}` | autor ≤ 15 min (IM) | 200 | `CommentUpdated`, `UserMentioned` | US-071 |
| CMT-04 | DELETE | `/comments/{id}` | autor ou `COMMENT_MODERATE` (IM) | 204 | `CommentDeleted` | US-071 |
| CMT-05 | GET | `/processes/{id}/mention-candidates?q=` | `COMMENT_CREATE` | 200 | — | US-072 |
| ATT-01 | GET | `/processes/{id}/attachments` | `PROCESS_VIEW` | 200 | — | US-069 |
| ATT-02 | POST | `/attachments` | `ATTACHMENT_UPLOAD` + alvo editável (Idem.) | 201 | — (auditoria `attachment.upload_intent`) | US-068 |
| ATT-03 | POST | `/attachments/{id}/confirm` | uploader | 202 | — (job `file-scan`) | US-068 |
| ATT-04 | GET | `/attachments/{id}` | `PROCESS_VIEW` | 200 | — | US-068, US-069 |
| ATT-05 | GET | `/attachments/{id}/download` | `PROCESS_VIEW` (+POL-09) | 200 (`{ url, expiresAt }`) | — (auditoria `attachment.download`) | US-069 |
| ATT-06 | DELETE | `/attachments/{id}` | `ATTACHMENT_UPLOAD` (próprio) ou `ATTACHMENT_DELETE` (IM) | 204 | `AttachmentDeleted` | US-068 |

### 3.13 Dashboard, notificações e auditoria (`dashboard`, `notification`, `audit`)
| # | Método | Rota | Perm. | Sucesso | Eventos | Story |
|---|---|---|---|---|---|---|
| DSH-01 | GET | `/dashboard/summary` | `DASHBOARD_VIEW` | 200 | — | US-076 |
| DSH-02 | GET | `/dashboard/widgets/{widgetKey}` | `DASHBOARD_VIEW` | 200 | — | US-076 |
| NTF-01 | GET | `/notifications` | impl. | 200 | — | US-111 |
| NTF-02 | GET | `/notifications/unread-count` | impl. | 200 | — | US-111 |
| NTF-03 | POST | `/notifications/{id}/read` | destinatário | 200 | — | US-111 |
| NTF-04 | POST | `/notifications/read-all` | impl. | 200 | — | US-111 |
| NTF-05 | POST | `/notifications/{id}/archive` | destinatário | 200 | — | US-111 |
| AUD-01 | GET | `/audit` | `AUDIT_VIEW` | 200 | — (auditoria `audit.search`) | US-075 |
| AUD-02 | GET | `/audit/{id}` | `AUDIT_VIEW` | 200 | — | US-075 |
| AUD-03 | GET | `/audit/export` | `AUDIT_EXPORT` | 200 (`text/csv` ou `application/x-ndjson`) | — (auditoria `audit.export`) | US-075 |
| AUD-04 | GET | `/audit/seals` | `AUDIT_VIEW` | 200 | — | US-074 |
| AUD-05 | POST | `/audit/seals/verify` | `AUDIT_VIEW` | 200 | — | US-074 |

### 3.14 Administração do tenant (`identity`, `access`, `tenancy`, `organization`, `catalog`)
| # | Método | Rota | Perm. | Sucesso | Eventos | Story |
|---|---|---|---|---|---|---|
| USR-01 | GET | `/users` | `USER_VIEW` | 200 | — | US-092 (base na US-091) |
| USR-02 | GET | `/users/lookup` | impl. | 200 | — | US-092 |
| USR-03 | POST | `/users/invitations` | `USER_INVITE` (Idem.) | 201 | `UserInvited` | US-091 |
| USR-04 | POST | `/users/invitations/{userId}/resend` | `USER_INVITE` | 200 | `UserInvited` (`resend`) | US-091 |
| USR-05 | DELETE | `/users/invitations/{userId}` | `USER_INVITE` | 204 | — | US-091 |
| USR-06 | POST | `/invitations/accept` | usuário autenticado + token | 200 | `MembershipActivated` | US-091 |
| USR-14 | POST | `/invitations/preview` | usuário autenticado + token | 200 | — | US-091 |
| USR-07 | GET | `/users/{userId}` | `USER_VIEW` | 200 | — | US-092 |
| USR-08 | PATCH | `/users/{userId}` | `USER_MANAGE` (IM) | 200 | `MembershipUpdated` | US-092 |
| USR-09 | PUT | `/users/{userId}/departments` | `USER_MANAGE` (IM) | 200 | `MembershipUpdated` | US-092 |
| USR-10 | POST | `/users/{userId}/suspend` | `USER_MANAGE` + POL-12/16 (IM) | 200 | `MembershipSuspended` | US-092 |
| USR-11 | POST | `/users/{userId}/reactivate` | `USER_MANAGE` (IM) | 200 | `MembershipReactivated` | US-092 |
| USR-12 | POST | `/users/{userId}/revoke` | `USER_MANAGE` + POL-12/16 (IM) | 200 | `MembershipRevoked` | US-092 |
| USR-13 | POST | `/users/{userId}/mfa-reset` | `USER_MANAGE` + POL-16 (IM) | 200 | — | US-090 |
| ROL-01 | GET | `/permissions` | `ROLE_VIEW` | 200 | — | US-094 |
| ROL-02 | GET | `/roles` | `ROLE_VIEW` | 200 | — | US-095 |
| ROL-03 | POST | `/roles` | `ROLE_MANAGE` + POL-13 | 201 | `RoleCreated` | US-095 |
| ROL-04 | GET | `/roles/{id}` | `ROLE_VIEW` | 200 | — | US-095 |
| ROL-05 | PATCH | `/roles/{id}` | `ROLE_MANAGE` (IM) | 200 | `RoleUpdated` | US-095 |
| ROL-06 | PUT | `/roles/{id}/permissions` | `ROLE_MANAGE` + POL-13 (IM) | 200 | `RoleUpdated` | US-095 |
| ROL-07 | POST | `/roles/{id}/duplicate` | `ROLE_MANAGE` | 201 | `RoleCreated` | US-095 |
| ROL-08 | POST | `/roles/{id}/deactivate` | `ROLE_MANAGE` + POL-12 (IM) | 200 | `RoleUpdated` | US-095 |
| ROL-09 | GET | `/roles/{id}/assignments` | `ROLE_VIEW` | 200 | — | US-096 |
| ROL-10 | GET | `/users/{userId}/role-assignments` | `USER_VIEW` ou `ROLE_VIEW` | 200 | — | US-096 |
| ROL-11 | POST | `/users/{userId}/role-assignments` | `ROLE_ASSIGN` + POL-13/15 (Idem.) | 201 | `RoleAssigned` | US-096 |
| ROL-12 | POST | `/role-assignments/{id}/revoke` | `ROLE_ASSIGN` + POL-12/16 (IM) | 200 | `RoleRevoked` | US-096 |
| ORG-01 | GET | `/organizations` | impl. | 200 | — | US-101 |
| ORG-02 | POST | `/organizations` | `ORGANIZATION_MANAGE` | 201 | `OrganizationCreated` | US-101 |
| ORG-03 | GET | `/organizations/{id}` | impl. | 200 | — | US-101 |
| ORG-04 | PATCH | `/organizations/{id}` | `ORGANIZATION_MANAGE` (IM) | 200 | `OrganizationUpdated` | US-101 |
| DEP-01 | GET | `/departments` | impl. | 200 | — | US-102 |
| DEP-02 | GET | `/departments/lookup` | impl. | 200 | — | US-102 |
| DEP-03 | POST | `/departments` | `DEPARTMENT_MANAGE` | 201 | `DepartmentCreated` | US-102 |
| DEP-04 | GET | `/departments/{id}` | impl. | 200 | — | US-102 |
| DEP-05 | PATCH | `/departments/{id}` | `DEPARTMENT_MANAGE` (IM) | 200 | `DepartmentUpdated` | US-102 |
| DEP-06 | POST | `/departments/{id}/move` | `DEPARTMENT_MANAGE` (IM) | 200 | `DepartmentMoved` | US-102 |
| DEP-07 | POST | `/departments/{id}/deactivate` | `DEPARTMENT_MANAGE` (IM) | 200 | `DepartmentDeactivated` | US-102 |
| DEP-08 | POST | `/departments/{id}/activate` | `DEPARTMENT_MANAGE` (IM) | 200 | `DepartmentUpdated` | US-102 |
| DEP-09 | DELETE | `/departments/{id}` | `DEPARTMENT_MANAGE` (IM; sem referências) | 204 | — | US-102 |
| SET-01 | GET | `/settings` | `SETTINGS_MANAGE` | 200 | — | US-103 |
| SET-02 | PATCH | `/settings` | `SETTINGS_MANAGE` (IM por chave no corpo) | 200 | `TenantSettingsChanged` | US-103, US-105 |
| SET-03 | GET | `/settings/public` | impl. | 200 | — | US-103 |
| SET-04 | POST | `/numbering/preview` | `SETTINGS_MANAGE` | 200 | — | US-105 |
| CAT-01 | GET | `/catalogs/{catalogType}/items` | impl. | 200 | — | US-104 |
| CAT-02 | POST | `/catalogs/{catalogType}/items` | `CATALOG_MANAGE` | 201 | `CatalogItemChanged` | US-104 |
| CAT-03 | PATCH | `/catalog-items/{id}` | `CATALOG_MANAGE` (IM) | 200 | `CatalogItemChanged` | US-104 |
| CAT-04 | POST | `/catalog-items/{id}/activate` | `CATALOG_MANAGE` (IM) | 200 | `CatalogItemChanged` | US-104 |
| CAT-05 | POST | `/catalog-items/{id}/deactivate` | `CATALOG_MANAGE` (IM) | 200 | `CatalogItemChanged` | US-104 |
| CAT-06 | PUT | `/catalogs/{catalogType}/order` | `CATALOG_MANAGE` | 200 | `CatalogItemChanged` | US-104 |
| CAL-01 | GET | `/holidays?year=` | impl. | 200 | — | US-106 |
| CAL-02 | POST | `/holidays` | `CALENDAR_MANAGE` | 201 | `HolidayChanged` | US-106 |
| CAL-03 | PATCH | `/holidays/{id}` | `CALENDAR_MANAGE` (IM) | 200 | `HolidayChanged` | US-106 |
| CAL-04 | DELETE | `/holidays/{id}` | `CALENDAR_MANAGE` (IM) | 204 | `HolidayChanged` | US-106 |
| CAL-05 | GET | `/calendar/business-days?from=&to=` | impl. | 200 | — | US-106 |
| CAL-06 | POST | `/calendar/add-business-days` | impl. | 200 | — | US-106, US-055 |

### 3.15 Plataforma e saúde
| # | Método | Rota | Perm. | Sucesso | Eventos | Story |
|---|---|---|---|---|---|---|
| PLT-01 | POST | `/platform/tenants` | `PLATFORM_TENANT_MANAGE` (Idem.) | 201 | `TenantProvisioned` | US-099 |
| PLT-02 | GET | `/platform/tenants` | `PLATFORM_TENANT_MANAGE` | 200 | — | US-099 |
| PLT-03 | GET | `/platform/tenants/{id}` | `PLATFORM_TENANT_MANAGE` | 200 | — | US-099 |
| PLT-04 | POST | `/platform/tenants/{id}/activate` | `PLATFORM_TENANT_MANAGE` (IM) | 200 | `TenantActivated` | US-099 |
| PLT-05 | POST | `/platform/tenants/{id}/suspend` | `PLATFORM_TENANT_MANAGE` (IM) | 200 | `TenantSuspended` | US-099 |
| PLT-06 | POST | `/platform/tenants/{id}/offboard` | `PLATFORM_TENANT_MANAGE` (IM) | 200 | `TenantOffboarded` | US-099 |
| PLT-07 | POST | `/platform/tenants/{id}/deactivate` | `PLATFORM_TENANT_MANAGE` (IM) | 200 | `TenantDeactivated` | US-099 |
| PLT-08 | PATCH | `/platform/tenants/{id}` | `PLATFORM_TENANT_MANAGE` (IM) | 200 | — (auditoria `tenant.update`) | US-099 |
| HLT-01 | GET | `/health/live` (fora de `/api/v1`) | público (rede interna/ALB) | 200 | — | US-085 |
| HLT-02 | GET | `/health/ready` (fora de `/api/v1`) | público (rede interna/ALB) | 200/503 | — | US-085 |
| HLT-03 | GET | `/metrics` (fora de `/api/v1`) | rede interna | 200 | — | US-085 |

**Total MVP 1:** 269 operações na API (as rotas do BFF não estão incluídas na contagem; recontagem de 2026-10-07, após WF-23, DOC-24/25, TPL-12/13, USR-13, PRS-24 e demais inclusões).

---

## 4. Especificação por endpoint

O detalhe de cada operação (cabeçalhos, parâmetros, request, response, erros, efeitos e notas) fica em um arquivo por seção do catálogo, na pasta [`api/`](api/). As convenções (§1) e os erros genéricos e de domínio (§2) valem para todos e não são repetidos lá.

| Arquivo | Seção do catálogo | Prefixos | Operações |
|---|---|---|---|
| [01-session-me.md](api/01-session-me.md) | 3.1 Sessão e usuário corrente | ME | 6 |
| [02-processes.md](api/02-processes.md) | 3.2 Processos | PRC, TAG | 41 |
| [03-documents.md](api/03-documents.md) | 3.3 Documentos genéricos, versões e renderização | DOC, DTY | 29 |
| [04-templates.md](api/04-templates.md) | 3.4 Templates | TPL | 13 |
| [05-dfd.md](api/05-dfd.md) | 3.5 DFD | DFD | 5 |
| [06-etp.md](api/06-etp.md) | 3.6 ETP | ETP | 9 |
| [07-price-research-suppliers.md](api/07-price-research-suppliers.md) | 3.7 Pesquisa de preços e fornecedores | PRS, SUP | 30 |
| [08-risks.md](api/08-risks.md) | 3.8 Riscos | RSK | 10 |
| [09-term-of-reference.md](api/09-term-of-reference.md) | 3.9 Termo de Referência | TRM | 6 |
| [10-workflow.md](api/10-workflow.md) | 3.10 Workflow | WF | 23 |
| [11-approvals-inbox.md](api/11-approvals-inbox.md) | 3.11 Aprovações e caixa de tarefas | APV, TSK | 9 |
| [12-comments-attachments.md](api/12-comments-attachments.md) | 3.12 Comentários e anexos | CMT, ATT | 11 |
| [13-dashboard-notifications-audit.md](api/13-dashboard-notifications-audit.md) | 3.13 Dashboard, notificações e auditoria | DSH, NTF, AUD | 12 |
| [14-tenant-administration.md](api/14-tenant-administration.md) | 3.14 Administração do tenant | USR, ROL, ORG, DEP, SET, CAT, CAL | 54 |
| [15-platform-health.md](api/15-platform-health.md) | 3.15 Plataforma e saúde | PLT, HLT | 11 |
| **Total** | | | **269** |

Itens marcados "a definir na implementação" nesses arquivos são detalhes que as stories não fixam (ex.: campos de ordenação de algumas listas); decidir no refinamento da sprint e atualizar o arquivo correspondente.
