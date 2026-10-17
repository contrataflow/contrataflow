# 3.13 Dashboard, notificações e auditoria (`dashboard`, `notification`, `audit`)

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2.

| ID | Método | Rota | Permissão | Story |
|---|---|---|---|---|
| DSH-01 | GET | `/dashboard/summary` | `DASHBOARD_VIEW` | US-076 |
| DSH-02 | GET | `/dashboard/widgets/{widgetKey}` | `DASHBOARD_VIEW` | US-076 |
| NTF-01 | GET | `/notifications` | autenticado (destinatário) | US-111 |
| NTF-02 | GET | `/notifications/unread-count` | autenticado (destinatário) | US-111 |
| NTF-03 | POST | `/notifications/{id}/read` | destinatário | US-111 |
| NTF-04 | POST | `/notifications/read-all` | autenticado (destinatário) | US-111 |
| NTF-05 | POST | `/notifications/{id}/archive` | destinatário | US-111 |
| AUD-01 | GET | `/audit` | `AUDIT_VIEW` | US-075 |
| AUD-02 | GET | `/audit/{id}` | `AUDIT_VIEW` | US-075 |
| AUD-03 | GET | `/audit/export` | `AUDIT_EXPORT` | US-075 |
| AUD-04 | GET | `/audit/seals` | `AUDIT_VIEW` | US-074 |
| AUD-05 | POST | `/audit/seals/verify` | `AUDIT_VIEW` | US-074 |

### DSH-01 — Obter resumo do dashboard
`GET /api/v1/dashboard/summary` · **Permissão:** `DASHBOARD_VIEW` · **Story:** US-076
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** query `secretariatId?` (uuid, `Department` tipo `SECRETARIAT`/`BOARD`, ativa, do órgão do tenant); `departmentId?` (uuid, ativa, na subárvore de `secretariatId` quando ambos informados)
- **Request:** —
- **Response:** `200 { data: { pendingCount, overdueCount, dueSoonCount, openCount, generatedAt } }`, `meta: { cache: { hit, expiresAt } }`
  ```json
  { "data": { "pendingCount": 14, "overdueCount": 3, "dueSoonCount": 5, "openCount": 42, "generatedAt": "2026-10-07T13:00:00Z" },
    "meta": { "cache": { "hit": true, "expiresAt": "2026-10-07T13:01:00Z" } } }
  ```
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `DASHBOARD_VIEW` |
  | 403 | `MEMBERSHIP_INACTIVE` / `TENANT_SUSPENDED` | Vínculo inativo ou tenant suspenso |
  | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | `secretariatId`/`departmentId` inválido |
  | 422 | `VALIDATION_ERROR` (`DEPARTMENT_NOT_IN_SECRETARIAT`) | `departmentId` fora da subárvore de `secretariatId` |
- **Efeitos:** — (leitura agregada, mesma convenção de TSK-01/02 — DEC-026)
- **Notas:** resposta cacheada (`meta.cache`); contadores sem recorte de secretaria/unidade quando os filtros não são informados (todas as visíveis ao usuário).

### DSH-02 — Obter indicador do dashboard
`GET /api/v1/dashboard/widgets/{widgetKey}` · **Permissão:** `DASHBOARD_VIEW` · **Story:** US-076
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `widgetKey` (`DashboardWidgetKey`, registro de 9 valores: `PENDING_ITEMS`, `BY_STATUS`, `BY_STAGE`, `OVERDUE`, `DUE_SOON`, `AVG_STAGE_DURATION`, `OPENED_BY_MONTH`, `VALUE_BY_SECRETARIAT`, `RECENT_ACTIVITY` — RN-DASH-02); query `secretariatId?`, `departmentId?` (mesmas regras de DSH-01); `limit?` (número 1–100, padrão 20, aplicável somente a `RECENT_ACTIVITY`)
- **Request:** —
- **Response:** `200 { data: { widgetKey, series/items, generatedAt } }`, `meta: { generatedAt, cache: { hit, expiresAt } }`; itens agregados sigilosos expõem `confidentialExcluded: boolean` (POL-09) ao lado do valor
  ```json
  { "data": { "widgetKey": "VALUE_BY_SECRETARIAT",
      "series": [
        { "key": "org-secretaria-obras", "label": "Secretaria de Obras", "value": "1250000.00", "confidentialExcluded": false },
        { "key": "org-secretaria-saude", "label": "Secretaria de Saúde", "value": "320000.00", "confidentialExcluded": true }
      ] },
    "meta": { "generatedAt": "2026-10-07T13:00:00Z", "cache": { "hit": false, "expiresAt": "2026-10-07T13:01:00Z" } } }
  ```
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `DASHBOARD_VIEW` |
  | 403 | `MEMBERSHIP_INACTIVE` / `TENANT_SUSPENDED` | Vínculo inativo ou tenant suspenso |
  | 404 | `WIDGET_NOT_FOUND` | `widgetKey` fora do registro `DashboardWidgetKey` |
  | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | `secretariatId`/`departmentId` inválido |
  | 422 | `VALIDATION_ERROR` (`DEPARTMENT_NOT_IN_SECRETARIAT`) | `departmentId` fora da subárvore de `secretariatId` |
  | 422 | `VALIDATION_ERROR` (`OUT_OF_RANGE`) | `limit` de `RECENT_ACTIVITY` fora de 1–100 |
- **Efeitos:** — (leitura agregada)
- **Notas:** agregados que somam processos de orçamento sigiloso sem POL-09 excluem a linha do cálculo e marcam `confidentialExcluded: true` (POL-09), em vez de mascarar o valor (diferente da convenção `<campo>Masked` de api.md §1.4). A story detalha o formato de resposta apenas para `VALUE_BY_SECRETARIAT` (campo `series`) e cita `items`/`limit` para `RECENT_ACTIVITY`; o formato exato dos outros 7 indicadores (`PENDING_ITEMS`, `BY_STATUS`, `BY_STAGE`, `OVERDUE`, `DUE_SOON`, `AVG_STAGE_DURATION`, `OPENED_BY_MONTH`) não está detalhado — a definir na implementação.

### NTF-01 — Listar notificações
`GET /api/v1/notifications` · **Permissão:** usuário autenticado (lista apenas as próprias) · **Story:** US-111
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** query `cursor?` (opaco); `limit?` (int ≤100); `unreadOnly?` (booleano, padrão `false`)
- **Request:** —
- **Response:** `200 { data: [Notification], meta: { nextCursor, hasMore } }`; `Notification { id, type: NotificationType, title, body, link, groupKey, groupCount, groupedEventIds, readAt, archivedAt, emailStatus: EmailDeliveryStatus, emailSentAt, createdAt }` (campos `groupKey`/`groupCount`/`groupedEventIds`/`emailStatus`/`emailSentAt` via entities.md, não detalhados na story)
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `MEMBERSHIP_INACTIVE` | Vínculo não ativo |
  | 422 | `VALIDATION_ERROR` | `cursor`/`limit` inválidos |
- **Efeitos:** — (consome a fila `notifications`; não publica eventos de domínio)
- **Notas:** `groupKey` = `{type}:{processId}`, agrupamento de 5 minutos (events.md §6); `groupCount` é o número de eventos agregados na notificação; `groupedEventIds` guarda os demais eventos agregados (máx. 50, usado para idempotência na reentrega). `title`/`body` vêm do template do `type` (≤200/≤1000 caracteres — RN-NTF-07); `link` é rota relativa (RN-NTF-08).

### NTF-02 — Obter contador de não lidas
`GET /api/v1/notifications/unread-count` · **Permissão:** usuário autenticado · **Story:** US-111
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** —
- **Request:** —
- **Response:** `200 { data: { count } }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `MEMBERSHIP_INACTIVE` | Vínculo não ativo |
- **Efeitos:** —
- **Notas:** usado para o contador do sininho; cliente mantém último valor em cache quando a API está indisponível.

### NTF-03 — Marcar notificação como lida
`POST /api/v1/notifications/{id}/read` · **Permissão:** destinatário da notificação · **Story:** US-111
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: Notification }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 404 | `NOTIFICATION_NOT_FOUND` | De outro destinatário, inexistente ou outro tenant |
- **Efeitos:** — (preenche `readAt`; não gera `AuditLog` — DEC-161)
- **Notas:** —

### NTF-04 — Marcar todas como lidas
`POST /api/v1/notifications/read-all` · **Permissão:** usuário autenticado · **Story:** US-111
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** —
- **Request:** —
- **Response:** `200 { data: { updated } }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `MEMBERSHIP_INACTIVE` | Vínculo não ativo |
- **Efeitos:** — (não gera `AuditLog` — DEC-161)
- **Notas:** `updated` é a quantidade de notificações marcadas como lidas.

### NTF-05 — Arquivar notificação
`POST /api/v1/notifications/{id}/archive` · **Permissão:** destinatário da notificação · **Story:** US-111
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: Notification }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 404 | `NOTIFICATION_NOT_FOUND` | De outro destinatário, inexistente ou outro tenant |
- **Efeitos:** — (preenche `archivedAt`; não gera `AuditLog` — DEC-161)
- **Notas:** —

### AUD-01 — Consultar trilha de auditoria
`GET /api/v1/audit` · **Permissão:** `AUDIT_VIEW` · **Story:** US-075
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** query `occurredFrom`, `occurredTo` (data/hora, obrigatórios, intervalo ≤90 dias — RN-AUD-17; sugestão de UI: últimos 7 dias); `actorUserId?` (uuid); `action?` (seleção múltipla, catálogo events.md §7); `category?` (`AuditCategory`); `result?` (`AuditResult`); `entityType?`, `entityId?`; `processId?`; `cursor?`, `limit?` (≤100, padrão 50)
- **Request:** —
- **Response:** `200 { data: [AuditLog], meta: { nextCursor, hasMore } }`; `AuditLog { id, action, category: AuditCategory, result: AuditResult, actorUserId?, entityType?, entityId?, processId?, occurredAt, changes?, metadata? }` (shape resumido a partir dos campos citados nas seções de Auditoria das demais stories; schema completo do registro: ver entities.md)
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `AUDIT_VIEW` |
  | 403 | `MFA_REQUIRED` | Ação exige verificação adicional |
  | 403 | `TENANT_SUSPENDED` | Tenant em encerramento, perfil não elegível |
  | 422 | `VALIDATION_ERROR` (`OUT_OF_RANGE`) | Período ausente ou acima de 90 dias |
  | 422 | `VALIDATION_ERROR` | `occurredTo` anterior a `occurredFrom` |
- **Efeitos:** — (consulta não gera evento de domínio; é registrada como `AuditLog`, não como evento de outbox); auditoria `audit.search` (`ACCESS`; `metadata`: filtros aplicados); `access.denied` (`reasonCode = AUDIT_VIEW`/`MFA_REQUIRED`)
- **Notas:** `limit` acima de 100 é ajustado para o máximo pela API (sem erro). Cursor inválido ou corrompido → 422 `VALIDATION_ERROR` (`cursor`). Ordem `occurredAt DESC, id DESC`; período inclusivo nos dois extremos.

### AUD-02 — Obter registro de auditoria
`GET /api/v1/audit/{id}` · **Permissão:** `AUDIT_VIEW` · **Story:** US-075
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: AuditLog }` com diff de `changes` (antes/depois)
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `AUDIT_VIEW` |
  | 404 | `NOT_FOUND` | Registro inexistente ou de outro tenant |
- **Efeitos:** Auditoria `audit.search` (`ACCESS`; mesma ação reaproveitada de AUD-01; `metadata`: filtros aplicados)
- **Notas:** —

### AUD-03 — Exportar trilha de auditoria
`GET /api/v1/audit/export` · **Permissão:** `AUDIT_EXPORT` · **Story:** US-075
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** query: mesmos filtros de AUD-01 (sem `cursor`) + `format?` (`csv`\|`ndjson`, padrão `csv` — RN-AUD-19)
- **Request:** —
- **Response:** `200`, arquivo `text/csv` ou `application/x-ndjson`, `Content-Disposition: attachment`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `AUDIT_EXPORT` |
  | 403 | `MFA_REQUIRED` | Ação exige verificação adicional |
  | 403 | `TENANT_SUSPENDED` | Tenant em encerramento, perfil não elegível |
  | 422 | `VALIDATION_ERROR` (`OUT_OF_RANGE`) | Período ausente ou acima de 90 dias |
  | 422 | `VALIDATION_ERROR` (`INVALID_ENUM`) | `format` fora de `csv`/`ndjson` |
  | 422 | `EXPORT_TOO_LARGE` | Exportação acima de 100 mil linhas |
- **Efeitos:** Auditoria `audit.export` (`EXPORT`; `metadata`: filtros aplicados, `format`, `rowCount`); `access.denied` (`reasonCode = AUDIT_EXPORT`/`MFA_REQUIRED`)
- **Notas:** refinar período/filtros quando exceder o limite de linhas (`audit.export.maxRows` — `AUDIT_EXPORT_MAX_ROWS`, padrão 100.000; o problem+json traz `estimatedCount`). O fim do período é fixado no instante do pedido (a própria auditoria da exportação não entra no arquivo). Arquivo `auditoria-AAAAMMDD-AAAAMMDD.{csv,ndjson}`, ordem `occurredAt DESC, id DESC`. CSV: UTF-8 com BOM, CRLF, RFC 4180, uma coluna por campo de `AuditLog` (sem `tenantId`), `changes`/`metadata` em JSON, escape de fórmulas (RN-AUD-20) em toda coluna de texto. NDJSON: um `AuditLog` por linha. Classe de limite "Exportações e renderização" (429 `RATE_LIMITED`).

### AUD-04 — Listar selos de integridade
`GET /api/v1/audit/seals` · **Permissão:** `AUDIT_VIEW` · **Story:** US-074
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** query `periodFrom?`, `periodTo?`; `page?`, `pageSize?` (paginação padrão, api.md §1.2)
- **Request:** —
- **Response:** `200 { data: [{ id, periodStart, periodEnd, recordCount, digest, chainHash, sealedAt }], meta }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `AUDIT_VIEW` |
- **Efeitos:** Auditoria `audit.search` (reaproveitado; `ACCESS`; `metadata`: filtros de período)
- **Notas:** cada selo cobre um período de hora cheia; `recordCount` ≥ 1 (RN-AUD-12); `digest`/`chainHash` calculados no job de selagem (RN-AUD-11).

### AUD-05 — Verificar integridade dos selos
`POST /api/v1/audit/seals/verify` · **Permissão:** `AUDIT_VIEW` · **Story:** US-074
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** —
- **Request:** `{ periodStart: timestamptz (obrigatório); periodEnd: timestamptz (obrigatório, posterior a periodStart; intervalo limitado a `audit.sealVerification.maxPeriods` = 720 selos) }`
- **Response:** `200 { data: { brokenAtPeriodStart: timestamptz | null, results: [{ periodStart, periodEnd, recordCount, status: 'VALID'|'INVALID', brokenAt?: 'digest'|'chain' }] } }` — `results` em ordem de `periodStart`; `brokenAtPeriodStart` = primeira quebra (RN-AUD-16)
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `AUDIT_VIEW` |
  | 403 | `MFA_REQUIRED` | Ação exige verificação adicional |
  | 404 | `NOT_FOUND` | Nenhum selo do tenant no intervalo (selo de outro tenant ou inexistente) |
  | 422 | `VALIDATION_ERROR` (`OUT_OF_RANGE`) | Intervalo acima de 720 selos (`audit.sealVerification.maxPeriods`) — contado em horas cheias do intervalo |
  | 503 | `DEPENDENCY_UNAVAILABLE` | Banco indisponível durante a verificação |
  | 422 | `VALIDATION_ERROR` | `periodEnd` anterior a `periodStart` |
- **Efeitos:** — (nenhum evento de domínio; observável via `AuditLog` `audit.seal` registrado no período seguinte — RN-AUD-14, via AUD-04 e via métricas/logs)
- **Notas:** reduzir o intervalo quando exceder `audit.sealVerification.maxPeriods` (720); reexecução do job de selagem para período já selado é no-op silencioso no backend.
