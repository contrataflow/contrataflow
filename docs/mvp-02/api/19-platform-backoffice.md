# 3.19 Plataforma, backoffice e gov.br (`tenancy`, `identity`, `access`, `audit`) — MVP 2

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint) do MVP 2. Convenções, erros genéricos e de domínio: [api.md §1–§2](../api.md#1-convenções) (que herda o [api.md do MVP 1](../../mvp-01/api.md)). Épico(s): EP-029. Fonte de cada linha: a seção "API" da story citada — divergência entre este arquivo e a story é bug de especificação.

Backoffice da plataforma (DT-07, DT-18; rotas `/platform/*` com `x-tenant-scope = PLATFORM`, só operador com MFA), acesso de suporte com prazo e auditoria nos dois lados, saúde por tenant, login gov.br via Authentik (PEND-18, ADR-017) com vínculo de identidade, e os débitos DT-13 a DT-16 (reativação de perfil, selo da auditoria, atualização da biblioteca de templates, limite das ações em lote). Telas SCR-119 a SCR-123 e ajustes em SCR-001, SCR-039 e SCR-041.

Legenda: **Idem.** = `Idempotency-Key`; **IM** = `If-Match` (com `ETag` na resposta); "—" = não se aplica. Escritas sem `If-Match` criam recurso novo ou são ações idempotentes por chave. Listas paginam com `page`/`pageSize` (≤ 100) e `sort`, salvo indicação na linha.

## Endpoints novos

| ID | Método | Rota | Permissão | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| GOV-01 | GET | `/internal/auth-options` | credencial de serviço do Authentik (rede privada) | — | — | US-182 |
| GOV-02 | POST | `/internal/govbr/resolve` | credencial de serviço do Authentik (rede privada) | — | — | US-182, US-183 |
| GOV-03 | GET | `/me`, `/me/memberships` (extensão de `ME-01` e `ME-04`) | impl. (sessão autenticada) | — | — | US-182 |
| GOV-04 | GET | `/me/external-identities` | `PLATFORM_TENANT_MANAGE` | — | — | US-183 |
| GOV-05 | POST | `/me/external-identities/govbr/link-intents` | `PLATFORM_TENANT_MANAGE` | — | — | US-183 |
| GOV-06 | POST | `/me/external-identities/govbr/link` | `PLATFORM_TENANT_MANAGE` | — | — | US-183 |
| GOV-07 | DELETE | `/me/external-identities/govbr` | `PLATFORM_TENANT_MANAGE` | — | — | US-183 |
| GOV-08 | POST | `/platform/govbr/unlink` | `PLATFORM_TENANT_MANAGE` | — | — | US-183 |
| GOV-09 | GET | `/settings/govbr-status` | `SETTINGS_MANAGE` | — | — | US-184 |
| PLT-09 | GET | `/platform/me` | `PLATFORM_TENANT_MANAGE` | — | — | US-178 |
| PLT-10 | GET | `/platform/tenants/slug-availability` | `PLATFORM_TENANT_MANAGE` | — | — | US-178 |
| PLT-11 | GET | `/platform/tenants/{id}/provisioning` | `PLATFORM_TENANT_MANAGE` | — | — | US-178 |
| PLT-12 | POST | `/platform/tenants/{id}/resend-invitation` | `PLATFORM_TENANT_MANAGE` | — | — | US-178 |
| PLT-13 | GET | `/platform/tenants/{id}/status-history` | `PLATFORM_TENANT_MANAGE` | — | — | US-179 |
| PLT-14 | GET | `/platform/tenants/{id}/lifecycle` | `PLATFORM_TENANT_MANAGE` | — | — | US-179 |
| PLT-15 | POST | `/platform/tenants/{tenantId}/support-access` | `PLATFORM_SUPPORT_ACCESS` | Obrigatório | — | US-180 |
| PLT-16 | POST | `/platform/support-access/{grantId}/end` | `PLATFORM_SUPPORT_ACCESS` | — | — | US-180 |
| PLT-17 | GET | `/platform/tenants/{tenantId}/support-access` | `PLATFORM_SUPPORT_ACCESS` | — | — | US-180 |
| PLT-18 | GET | `/platform/tenants/{tenantId}/support-access/eligible-roles` | `PLATFORM_SUPPORT_ACCESS` | — | — | US-180 |
| PLT-19 | GET | `/platform/support-access` | `PLATFORM_SUPPORT_ACCESS` | — | — | US-180 |
| PLT-20 | GET | `/platform/health/tenants` | `PLATFORM_HEALTH_VIEW` | — | — | US-181 |
| PLT-21 | GET | `/platform/tenants/{tenantId}/health` | `PLATFORM_HEALTH_VIEW` | — | — | US-181 |
| PLT-22 | GET | `/platform/health/summary` | `PLATFORM_HEALTH_VIEW` | — | — | US-181 |
| PLT-23 | GET | `/platform/health/queues` | `PLATFORM_HEALTH_VIEW` | — | — | US-181 |
| PLT-24 | GET | `/platform/tenants/{tenantId}/health/ai` | `PLATFORM_HEALTH_VIEW` | — | — | US-181 |
| ROL-13 | POST | `/roles/{id}/reactivate` | `ROLE_MANAGE` | — | Obrigatório | US-185 |
| SPA-01 | GET | `/support-access` | `AUDIT_VIEW` | — | — | US-180 |
| SPA-02 | GET | `/support-access/{grantId}` | `AUDIT_VIEW` | — | — | US-180 |
| SPA-03 | POST | `/support-access/{grantId}/end` | `USER_MANAGE` | — | — | US-180 |
| TPL-14 | GET | `/templates/{id}/library-update` | `TEMPLATE_VIEW` | — | — | US-187 |
| TPL-15 | POST | `/templates/{id}/library-update/adopt` | `TEMPLATE_MANAGE` ou `TEMPLATE_PUBLISH` | Obrigatório | Obrigatório | US-187 |
| TPL-16 | GET | `/templates/library-updates` | `TEMPLATE_VIEW` | — | — | US-187 |
| TPL-17 | POST | `/templates/{id}/library-update/dismiss` | `TEMPLATE_PUBLISH` | — | Obrigatório | US-187 |

## Rotas do MVP 1 ampliadas

Mudanças **aditivas** (campos opcionais, enums ampliados, filtros novos) sobre contratos do MVP 1; o comportamento do MVP 1 vale sem os campos novos. O contrato original está no arquivo indicado da pasta `mvp-01/api/`.

| ID | Método | Rota (MVP 1) | Permissão (MVP 1) | Contrato original | Ampliado por |
|---|---|---|---|---|---|
| AUD-05 | POST | `/audit/seals/verify` | `AUDIT_VIEW` | [13-dashboard-notifications-audit.md](../../mvp-01/api/13-dashboard-notifications-audit.md) | US-186 |
| NTF-01 | GET | `/notifications` | autenticado (destinatário) | [13-dashboard-notifications-audit.md](../../mvp-01/api/13-dashboard-notifications-audit.md) | US-186 |
| PLT-01 | POST | `/platform/tenants` | `PLATFORM_TENANT_MANAGE` (Idem.) | [15-platform-health.md](../../mvp-01/api/15-platform-health.md) | US-178 |
| PLT-02 | GET | `/platform/tenants` | `PLATFORM_TENANT_MANAGE` | [15-platform-health.md](../../mvp-01/api/15-platform-health.md) | US-178, US-179 |
| PLT-03 | GET | `/platform/tenants/{id}` | `PLATFORM_TENANT_MANAGE` | [15-platform-health.md](../../mvp-01/api/15-platform-health.md) | US-178, US-179 |
| PLT-04 | POST | `/platform/tenants/{id}/activate` | `PLATFORM_TENANT_MANAGE` (IM) | [15-platform-health.md](../../mvp-01/api/15-platform-health.md) | US-179 |
| PLT-05 | POST | `/platform/tenants/{id}/suspend` | `PLATFORM_TENANT_MANAGE` (IM) | [15-platform-health.md](../../mvp-01/api/15-platform-health.md) | US-179 |
| PLT-06 | POST | `/platform/tenants/{id}/offboard` | `PLATFORM_TENANT_MANAGE` (IM) | [15-platform-health.md](../../mvp-01/api/15-platform-health.md) | US-179 |
| PLT-07 | POST | `/platform/tenants/{id}/deactivate` | `PLATFORM_TENANT_MANAGE` (IM) | [15-platform-health.md](../../mvp-01/api/15-platform-health.md) | US-179 |
| ROL-02 | GET | `/roles` | `ROLE_VIEW` | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-185 |
| ROL-04 | GET | `/roles/{id}` | `ROLE_VIEW` | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-185 |
| SET-01 | GET | `/settings` | `SETTINGS_MANAGE` | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-184, US-188 |
| SET-02 | PATCH | `/settings` | `SETTINGS_MANAGE` (IM por chave no corpo, Idem.) | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-184, US-188 |
| SET-03 | GET | `/settings/public` | implícita | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-188 |
| TSK-03 | POST | `/tasks/bulk-claim` | `PROCESS_CLAIM` | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-188 |
| TSK-04 | POST | `/tasks/bulk-assign` | `PROCESS_ASSIGN` (ou titular) | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-188 |

## Rotas do BFF e rotas internas

Não fazem parte da API pública `/api/v1` (fora do OpenAPI e da contagem): as do BFF ficam no Next.js (authentication.md); as `/internal/*` só aceitam a credencial de serviço do Authentik, em rede privada.

| Tipo | Método | Rota | Request (resumo) | Response (resumo) | Códigos | Story |
|---|---|---|---|---|---|---|
| BFF | GET | `/api/auth/govbr/start?returnTo=` | `returnTo?` | 302 → fonte gov.br no Authentik; cookie de transação (`intent = LOGIN`) | 302, 429 | US-182 |
| BFF | GET | `/api/auth/govbr/refused?reason=` | `reason` | 302 → `/entrar?motivo=govbr-…`; limpa a transação | 302, 429 | US-182 |
| BFF | GET | `/api/auth/callback?code=&state=` | — (reaproveitado) | 302 → `returnTo`, SCR-101 ou SCR-111; cookie `__Host-cf_session` | 302, 429, 503 | US-182 |
| proposto | POST | `/internal/session-events` (estendido) | `SESSION_STARTED` com `loginMethod`, `govbrTrustLevel?`; novo `GOVBR_LOGIN_FAILED { reason }` | como na US-087; recusa por `MEMBERSHIP_REQUIRED`/`GOVBR_NOT_ENABLED` em 403 | 200, 401, 403, 503 | US-182 |
| BFF | POST | `/api/auth/govbr/link/start` | sem corpo; `X-CF-Request: 1` | `200 { data: { redirectTo } }`; grava a transação `intent = LINK` | 200, 401, 403, 409, 429, 503 | US-183 |

## Especificação por endpoint

### GOV-01 — GET `/internal/auth-options`
**Permissão:** credencial de serviço do Authentik (rede privada) · **Story:** US-182
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** credencial de serviço do BFF, sem JWT nem tenant
- **Response:** `200 { data: { govbr: { available } } }`
- **Códigos:** 200, 401, 503

### GOV-02 — POST `/internal/govbr/resolve`
**Permissão:** credencial de serviço do Authentik (rede privada) · **Story:** US-182 (também citado por US-183)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `X-CF-Resolver-Token`; `{ cpf, trustLevel?, intent: "LOGIN" }`
- **Response:** `200 { data: { outcome: "LOGIN_ALLOWED" | "GOVBR_NOT_LINKED" | "MEMBERSHIP_REQUIRED" | "GOVBR_NOT_ENABLED" | "GOVBR_ACCOUNT_CONFLICT" | "USER_BLOCKED", authentikUserId?, linkMethod? } }` (a US-183 acrescenta `intent: "LINK"`)
- **Códigos:** 200, 401, 422, 503
- **Uso/ampliação em US-183:** request acrescenta `intent: "LINK"` e `linkTicket` → response acrescenta `LINK_PENDING` (+`authentikUserId`), `GOVBR_CPF_MISMATCH`, `GOVBR_ALREADY_LINKED`, `GOVBR_LINK_TICKET_INVALID` · códigos 200, 401, 422, 503

### GOV-03 — GET `/me`, `/me/memberships` (extensão de `ME-01` e `ME-04`)
**Permissão:** impl. (sessão autenticada) · **Story:** US-182
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `ME-01` ganha `login { method, govbrTrustLevel?, govbrAuthenticatedAt? }`; `ME-04` ganha `unusableReason?` por vínculo
- **Códigos:** 200, 401, 403

### GOV-04 — GET `/me/external-identities`
**Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-183
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { govbr: { available, enabledInActiveTenant, linked, identity | null, canLink, canUnlink, strongAuthSatisfied } } }`
- **Códigos:** 200, 401, 403, 503

### GOV-05 — POST `/me/external-identities/govbr/link-intents`
**Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-183
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** sem corpo (chamada do BFF)
- **Response:** `201 { data: { ticket, expiresAt } }`
- **Códigos:** 201, 401, 403, 409, 429, 503

### GOV-06 — POST `/me/external-identities/govbr/link`
**Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-183
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `{ ticket }` (chamada do BFF no callback)
- **Response:** `201 { data: { identity { maskedSubject, linkMethod, linkedAt, lastTrustLevel } } }`
- **Códigos:** 201, 401, 403, 409, 422, 503

### GOV-07 — DELETE `/me/external-identities/govbr`
**Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-183
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `204`
- **Códigos:** 204, 401, 403 (`MFA_REQUIRED`), 404, 503

### GOV-08 — POST `/platform/govbr/unlink`
**Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-183
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `{ email, reason, ticketReference }`; sem `X-Tenant-Id`
- **Response:** `200 { data: { unlinked: true } }`
- **Códigos:** 200, 403, 404, 422, 503

### GOV-09 — GET `/settings/govbr-status`
**Permissão:** `SETTINGS_MANAGE` · **Story:** US-184
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { sourceAvailable } }`
- **Códigos:** 200, 403, 503

### PLT-09 — GET `/platform/me`
**Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-178
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { userId, name, permissions[], mfaVerified, areas[] } }`
- **Códigos:** 200, 403

### PLT-10 — GET `/platform/tenants/slug-availability`
**Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-178
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `slug`
- **Response:** `200 { data: { slug, available, reason? } }`
- **Códigos:** 200, 403, 422, 429

### PLT-11 — GET `/platform/tenants/{id}/provisioning`
**Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-178
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { status, complete, steps[], lastError? { step, errorCode } } }`
- **Códigos:** 200, 403, 404, 503

### PLT-12 — POST `/platform/tenants/{id}/resend-invitation`
**Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-178
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `{}`
- **Response:** `200 { data: { invitationDispatched, firstAdmin{ email mascarado, membershipStatus, resendCount } } }`
- **Códigos:** 200, 403, 404, 409, 429, 503

### PLT-13 — GET `/platform/tenants/{id}/status-history`
**Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-179
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `page`, `pageSize`
- **Response:** `200 { data: [{ occurredAt, operator{ id, name }, action, fromStatus, toStatus, channel, reason? }], meta }`
- **Códigos:** 200, 403, 404, 503

### PLT-14 — GET `/platform/tenants/{id}/lifecycle`
**Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-179
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { status, version, offboardingEndsAt?, offboardingOverdue, actions[] { action, allowed, blockedReason?, requires[], pendingSteps[]? } } }` + `ETag`
- **Códigos:** 200, 403, 404, 503

### PLT-15 — POST `/platform/tenants/{tenantId}/support-access`
**Permissão:** `PLATFORM_SUPPORT_ACCESS` · **Story:** US-180
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ ticketReference, reason, roleId, durationHours }` + `Idempotency-Key`
- **Response:** `201 { data: SupportAccessGrant }` + `Location`, `ETag`
- **Códigos:** 201, 403, 404, 409, 422, 429, 503

### PLT-16 — POST `/platform/support-access/{grantId}/end`
**Permissão:** `PLATFORM_SUPPORT_ACCESS` · **Story:** US-180
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `{}`
- **Response:** `200 { data: SupportAccessGrant }`
- **Códigos:** 200, 403, 404, 409, 429, 503

### PLT-17 — GET `/platform/tenants/{tenantId}/support-access`
**Permissão:** `PLATFORM_SUPPORT_ACCESS` · **Story:** US-180
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `?status=&page=&pageSize=`
- **Response:** `200 { data: SupportAccessGrant[], meta }`
- **Códigos:** 200, 403, 404, 422, 429, 503

### PLT-18 — GET `/platform/tenants/{tenantId}/support-access/eligible-roles`
**Permissão:** `PLATFORM_SUPPORT_ACCESS` · **Story:** US-180
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: [{ id, key, name }] }` (só perfis elegíveis; sem permissões)
- **Códigos:** 200, 403, 404, 429, 503

### PLT-19 — GET `/platform/support-access`
**Permissão:** `PLATFORM_SUPPORT_ACCESS` · **Story:** US-180
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `?mine=&tenantId=&status=&page=&pageSize=`
- **Response:** `200 { data: SupportAccessGrant[] (com tenant { id, slug, name }), meta }`
- **Códigos:** 200, 403, 422, 429, 503

### PLT-20 — GET `/platform/health/tenants`
**Permissão:** `PLATFORM_HEALTH_VIEW` · **Story:** US-181
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `?status[]=&severity[]=&indicator=&q=&page=&pageSize=`
- **Response:** `200 { data: [{ tenant { id, slug, name, status }, severity, queues { state, severity, deadLetterTotal }, ai { state, severity, percentUsed }, storage { state, severity, percentUsed }, reconciliation { state, severity, lastFinishedAt } }], meta { page, pageSize, totalItems, generatedAt, cached, partial } }`
- **Códigos:** 200, 403, 422, 429, 503

### PLT-21 — GET `/platform/tenants/{tenantId}/health`
**Permissão:** `PLATFORM_HEALTH_VIEW` · **Story:** US-181
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { tenant { id, slug, name, status }, severity, queues { outbox { pendingCount, oldestPendingAgeSeconds, failedCount }, deadLetter { total, bySourceQueue } }, ai { enabled, limitTokens, usedTokens, reservedTokens, percentUsed, thresholdsReached[], userDailyRequestLimit, generationsByStatus }, storage { usedBytes, limitBytes, percentUsed, thresholdState }, reconciliation { lastRun { status, scope, startedAt, finishedAt, factsChecked, divergencesFixed } | null } }, meta }`; cada bloco com `state`, `severity`, `measuredAt`, `stale`, `errorCode?`
- **Códigos:** 200, 403, 404, 429, 503

### PLT-22 — GET `/platform/health/summary`
**Permissão:** `PLATFORM_HEALTH_VIEW` · **Story:** US-181
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { tenantsByStatus, tenantsBySeverity, indicatorsInAlert { queues, ai, storage, reconciliation }, platformQueuesSeverity }, meta }`
- **Códigos:** 200, 403, 429, 503

### PLT-23 — GET `/platform/health/queues`
**Permissão:** `PLATFORM_HEALTH_VIEW` · **Story:** US-181
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: { queues: [{ name, waiting, active, delayed, failed, oldestWaitingAgeSeconds, severity }], deadLetter { total, bySourceQueue }, schedulers: [{ name, lastSuccessAt, severity }], redis { queues, sessions, cache? }, breakers: [{ dependency, state }] }, meta }`
- **Códigos:** 200, 403, 429, 503

### PLT-24 — GET `/platform/tenants/{tenantId}/health/ai`
**Permissão:** `PLATFORM_HEALTH_VIEW` · **Story:** US-181
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `?month=YYYY-MM`
- **Response:** `200 { data: { month, enabled, limitTokens, usedTokens, reservedTokens, percentUsed, thresholdsReached: [{ threshold, reachedAt }], generationsByStatus }, meta }`
- **Códigos:** 200, 403, 404, 422, 429, 503

### ROL-13 — POST `/roles/{id}/reactivate`
**Permissão:** `ROLE_MANAGE` · **Story:** US-185
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{ confirmReactivate: true }` + `If-Match`
- **Response:** `200 { data: Role, meta: { restoredAssignmentsCount } }` com `ETag`
- **Códigos:** 200, 401, 403, 404, 409, 412, 422, 428, 429, 503

### SPA-01 — GET `/support-access`
**Permissão:** `AUDIT_VIEW` · **Story:** US-180
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `?status=&page=&pageSize=` (tenant de `X-Tenant-Id`)
- **Response:** `200 { data: SupportAccessGrant[], meta }`
- **Códigos:** 200, 401, 403, 422, 429, 503

### SPA-02 — GET `/support-access/{grantId}`
**Permissão:** `AUDIT_VIEW` · **Story:** US-180
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: SupportAccessGrant }`
- **Códigos:** 200, 401, 403, 404, 429, 503

### SPA-03 — POST `/support-access/{grantId}/end`
**Permissão:** `USER_MANAGE` · **Story:** US-180
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `{}`
- **Response:** `200 { data: SupportAccessGrant }`
- **Códigos:** 200, 401, 403, 404, 409, 429, 503

### TPL-14 — GET `/templates/{id}/library-update`
**Permissão:** `TEMPLATE_VIEW` · **Story:** US-187
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `sectionKey?`
- **Response:** `200 { data: { status, libraryKey, tenantLibraryVersion, currentLibraryVersion, customized, sections[] { key, status, changedFields[] }, blocks { layout, fieldConfig, importMappings }, draftVersionId?, dismissedAt?, section? { mine, library } }, meta }`
- **Códigos:** 200, 401, 403, 404

### TPL-15 — POST `/templates/{id}/library-update/adopt`
**Permissão:** `TEMPLATE_MANAGE` ou `TEMPLATE_PUBLISH` · **Story:** US-187
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Request:** `{ libraryVersion, choices? }` + `Idempotency-Key` + `If-Match`
- **Response:** `201 { data: TemplateVersion }` (`status = DRAFT`) com `Location` e `ETag`
- **Códigos:** 201, 401, 403, 404, 409, 412, 422, 428, 429, 503

### TPL-16 — GET `/templates/library-updates`
**Permissão:** `TEMPLATE_VIEW` · **Story:** US-187
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: [{ templateId, name, documentTypeCode, libraryKey, status, tenantLibraryVersion, currentLibraryVersion, customized, draftVersionId?, dismissedAt? }] }`
- **Códigos:** 200, 401, 403

### TPL-17 — POST `/templates/{id}/library-update/dismiss`
**Permissão:** `TEMPLATE_PUBLISH` · **Story:** US-187
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `{}` + `If-Match`
- **Response:** `200 { data: { status: "DISMISSED", dismissedAt } }`
- **Códigos:** 200, 401, 403, 404, 409, 412, 428, 503

### AUD-05 — POST `/audit/seals/verify` (ampliação do MVP 1)
Contrato original: [mvp-01/api/13-dashboard-notifications-audit.md](../../mvp-01/api/13-dashboard-notifications-audit.md). Mudanças do MVP 2, todas aditivas:
- **US-186:** request `{ periodStart, periodEnd }` → response `200 { data: { brokenAtPeriodStart, results[], notification: { status: "PUBLISHED" | "ALREADY_NOTIFIED" | "NONE", notifiedAt? } } }` · códigos 200, 403, 404, 422, 429, 503

### NTF-01 — GET `/notifications` (ampliação do MVP 1)
Contrato original: [mvp-01/api/13-dashboard-notifications-audit.md](../../mvp-01/api/13-dashboard-notifications-audit.md). Mudanças do MVP 2, todas aditivas:
- **US-186:** request `?cursor&limit&unreadOnly` → response passa a listar `type = AUDIT_SEAL_BROKEN`, `priority = HIGH`, `entityType = AUDIT_SEAL` · códigos 200, 401, 403, 422

### PLT-01 — POST `/platform/tenants` (ampliação do MVP 1)
Contrato original: [mvp-01/api/15-platform-health.md](../../mvp-01/api/15-platform-health.md). Mudanças do MVP 2, todas aditivas:
- **US-178:** request US-099 + `additionalOrganizations[]` (≤ 5) + `Idempotency-Key` → response `201 { data: Tenant + provisioning{ complete, steps[] } + firstAdmin{ email mascarado, membershipStatus, invitationDispatched } }` + `Location` · códigos 201, 403, 409, 422, 429, 503

### PLT-02 — GET `/platform/tenants` (ampliação do MVP 1)
Contrato original: [mvp-01/api/15-platform-health.md](../../mvp-01/api/15-platform-health.md). Mudanças do MVP 2, todas aditivas:
- **US-178:** request `status[]`, `stateCode`, `type`, `q`, `slug`, `sort`, `page`, `pageSize` → response `200 { data: [{ id, slug, name, type, status, stateCode, plan, activatedAt, suspendedAt, version }], meta }` · códigos 200, 403, 422, 503
- **US-179:** request + `offboardingOverdue` (estende a US-178) → response `200 { data: [… + offboardingEndsAt, offboardingOverdue], meta }` · códigos 200, 403, 422, 503

### PLT-03 — GET `/platform/tenants/{id}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/15-platform-health.md](../../mvp-01/api/15-platform-health.md). Mudanças do MVP 2, todas aditivas:
- **US-178:** request — → response `200 { data: Tenant + provisioning + firstAdmin{ … resendCount } }` + `ETag` · códigos 200, 403, 404, 503
- **US-179:** request — (estende a US-178) → response `200 { data: Tenant + datas do ciclo de vida + motivo (só operador) }` + `ETag` · códigos 200, 403, 404, 503

### PLT-04 — POST `/platform/tenants/{id}/activate` (ampliação do MVP 1)
Contrato original: [mvp-01/api/15-platform-health.md](../../mvp-01/api/15-platform-health.md). Mudanças do MVP 2, todas aditivas:
- **US-179:** request `{}` + `If-Match` → response `200 { data: Tenant }` + novo `ETag` · códigos 200, 403, 404, 409, 412, 428, 503

### PLT-05 — POST `/platform/tenants/{id}/suspend` (ampliação do MVP 1)
Contrato original: [mvp-01/api/15-platform-health.md](../../mvp-01/api/15-platform-health.md). Mudanças do MVP 2, todas aditivas:
- **US-179:** request `{ reason }` + `If-Match` → response `200 { data: Tenant }` · códigos 200, 403, 404, 409, 412, 422, 428, 503

### PLT-06 — POST `/platform/tenants/{id}/offboard` (ampliação do MVP 1)
Contrato original: [mvp-01/api/15-platform-health.md](../../mvp-01/api/15-platform-health.md). Mudanças do MVP 2, todas aditivas:
- **US-179:** request `{ reason, offboardingEndsAt }` + `If-Match` → response `200 { data: Tenant }` · códigos 200, 403, 404, 409, 412, 422, 428, 503

### PLT-07 — POST `/platform/tenants/{id}/deactivate` (ampliação do MVP 1)
Contrato original: [mvp-01/api/15-platform-health.md](../../mvp-01/api/15-platform-health.md). Mudanças do MVP 2, todas aditivas:
- **US-179:** request `{ reason, confirmSlug, acknowledgeEarly? }` + `If-Match` → response `200 { data: Tenant }` · códigos 200, 403, 404, 409, 412, 422, 428, 503

### ROL-02 — GET `/roles` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-185:** request `search?`, `isActive?` → response `data[]` ganha `deactivatedAt`, `deactivatedBy { id, name }` · códigos 200, 401, 403

### ROL-04 — GET `/roles/{id}` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-185:** request — → response `data` ganha `deactivatedAt`, `deactivatedBy`; perfil inativo traz `meta.reactivationPreview` · códigos 200, 401, 403, 404

### SET-01 — GET `/settings` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-184:** request — → response `200 { data: { "<chave>": { value, version } } }`, agora com `auth.govbrEnabled` e `auth.govbrCountsAsMfa` · códigos 200, 403
- **US-188:** request — → response `inbox.bulkMaxItems` com `value` e `version`; `meta.limits["inbox.bulkMaxItems"] = { min, max, effective }` · códigos 200, 401, 403

### SET-02 — PATCH `/settings` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-184:** request `{ values: { "auth.govbrEnabled"?, "auth.govbrCountsAsMfa"? }, expectedVersions }` → response `200 { data: { "<chave>": { value, version } } }` (só as alteradas) · códigos 200, 403 (`PERMISSION_DENIED`, `MFA_REQUIRED`), 412, 422, 428, 503
- **US-188:** request `{ values: { "inbox.bulkMaxItems": 100 }, expectedVersions: { "inbox.bulkMaxItems": 1 } }` → response `200 { data: { chave: { value, version } } }` · códigos 200, 403, 412, 422, 428, 429, 503

### SET-03 — GET `/settings/public` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-188:** request — → response passa a incluir `inbox.bulkMaxItems` com o valor efetivo · códigos 200, 401

### TSK-03 — POST `/tasks/bulk-claim` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-188:** request `{ processIds }` (2 até o limite efetivo) → response sem mudança; `TOO_LONG` traz `params.max` · códigos 200, 403, 422, 429, 503

### TSK-04 — POST `/tasks/bulk-assign` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-188:** request `{ processIds, assigneeId, reason }` (2 até o limite efetivo) → response sem mudança; `TOO_LONG` traz `params.max` · códigos 200, 403, 422, 429, 503
