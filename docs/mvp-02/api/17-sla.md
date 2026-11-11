# 3.17 SLA e regras de notificação (`sla`, `notification`) — MVP 2

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint) do MVP 2. Convenções, erros genéricos e de domínio: [api.md §1–§2](../api.md#1-convenções) (que herda o [api.md do MVP 1](../../mvp-01/api.md)). Épico(s): EP-030. Fonte de cada linha: a seção "API" da story citada — divergência entre este arquivo e a story é bug de especificação.

Políticas de SLA por tipo de contratação, modalidade ou valor (motor de regras — ADR-015), com prévia, pausas (diligência, suspensão), escalonamento em degraus, leitura do SLA do processo e regras de notificação condicional (`NotificationRule`). Configuração em SCR-041 (Configurações) e SCR-036 (Notificações); leitura no detalhe do processo (SCR-006).

Legenda: **Idem.** = `Idempotency-Key`; **IM** = `If-Match` (com `ETag` na resposta); "—" = não se aplica. Escritas sem `If-Match` criam recurso novo ou são ações idempotentes por chave. Listas paginam com `page`/`pageSize` (≤ 100) e `sort`, salvo indicação na linha.

## Endpoints novos

| ID | Método | Rota | Permissão | Idem. | IM | Story |
|---|---|---|---|---|---|---|
| NTR-01 | GET | `/notification-rules` | `NOTIFICATION_RULE_MANAGE` | — | — | US-193 |
| NTR-02 | POST | `/notification-rules` | `NOTIFICATION_RULE_MANAGE` | Obrigatório | — | US-193 |
| NTR-03 | GET | `/notification-rules/{id}` | `NOTIFICATION_RULE_MANAGE` | — | — | US-193 |
| NTR-04 | PATCH | `/notification-rules/{id}` | `NOTIFICATION_RULE_MANAGE` | — | Obrigatório | US-193 |
| NTR-05 | POST | `/notification-rules/{id}/activate` | `NOTIFICATION_RULE_MANAGE` | — | Obrigatório | US-193 |
| NTR-06 | POST | `/notification-rules/{id}/deactivate` | `NOTIFICATION_RULE_MANAGE` | — | Obrigatório | US-193 |
| NTR-07 | GET | `/notification-rules/{id}/executions` | `NOTIFICATION_RULE_MANAGE` | — | — | US-193 |
| NTR-08 | POST | `/notification-rules/{id}/preview` | `NOTIFICATION_RULE_MANAGE` | Obrigatório | — | US-193 |
| NTR-09 | GET | `/notification-rules/event-types` | `NOTIFICATION_RULE_MANAGE` | — | — | US-193 |
| SLA-01 | GET | `/sla-policies` | `SLA_POLICY_MANAGE` | — | — | US-189 |
| SLA-02 | POST | `/sla-policies` | `SLA_POLICY_MANAGE` | Obrigatório | — | US-189 |
| SLA-03 | GET | `/sla-policies/{id}` | `SLA_POLICY_MANAGE` | — | — | US-189 |
| SLA-04 | PATCH | `/sla-policies/{id}` | `SLA_POLICY_MANAGE` | — | Obrigatório | US-189 |
| SLA-05 | POST | `/sla-policies/{id}/activate` | `SLA_POLICY_MANAGE` | — | Obrigatório | US-189 |
| SLA-06 | POST | `/sla-policies/{id}/deactivate` | `SLA_POLICY_MANAGE` | — | Obrigatório | US-189 |
| SLA-07 | GET | `/sla-policies/stage-catalog` | `SLA_POLICY_MANAGE` | — | — | US-189 |
| SLA-11 | POST | `/sla-policies/preview` | `SLA_POLICY_MANAGE` ou `PROCESS_VIEW` | Obrigatório | — | US-190 |
| SLA-12 | GET | `/processes/{id}/sla` | `PROCESS_VIEW` | — | — | US-190, US-191, US-192 |

## Rotas do MVP 1 ampliadas

Mudanças **aditivas** (campos opcionais, enums ampliados, filtros novos) sobre contratos do MVP 1; o comportamento do MVP 1 vale sem os campos novos. O contrato original está no arquivo indicado da pasta `mvp-01/api/`.

| ID | Método | Rota (MVP 1) | Permissão (MVP 1) | Contrato original | Ampliado por |
|---|---|---|---|---|---|
| APV-03 | POST | `/approvals/{id}/decide` | `APPROVAL_DECIDE` + POL-03 | [11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md) | US-190 |
| CAL-06 | POST | `/calendar/add-business-days` | implícita | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-190 |
| NTF-01 | GET | `/notifications` | autenticado (destinatário) | [13-dashboard-notifications-audit.md](../../mvp-01/api/13-dashboard-notifications-audit.md) | US-192 |
| PRC-12 | GET | `/processes/{id}/timeline` | `PROCESS_VIEW` | [02-processes.md](../../mvp-01/api/02-processes.md) | US-191, US-192 |
| PRC-19 | POST | `/processes/{id}/forward` | `PROCESS_FORWARD` + POL-01 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-190 |
| PRC-20 | POST | `/processes/{id}/return` | `PROCESS_RETURN` + POL-01 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-190 |
| PRC-23 | POST | `/processes/{id}/suspend` | `PROCESS_SUSPEND` + POL-07 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-191 |
| PRC-24 | POST | `/processes/{id}/resume` | `PROCESS_SUSPEND` + POL-07 | [02-processes.md](../../mvp-01/api/02-processes.md) | US-191 |
| SET-01 | GET | `/settings` | `SETTINGS_MANAGE` | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-192 |
| SET-02 | PATCH | `/settings` | `SETTINGS_MANAGE` (IM por chave no corpo, Idem.) | [14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md) | US-192 |

## Especificação por endpoint

### NTR-01 — GET `/notification-rules`
**Permissão:** `NOTIFICATION_RULE_MANAGE` · **Story:** US-193
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `?status=&eventType=&q=&page=&pageSize=&sort=`
- **Response:** `200 { data: [{ id, name, eventType, eventLabel, condition { mode, label } | null, recipientsSummary, priority, sendEmail, maxPerRecipientPerDay, status, autoDisabledAt, autoDisabledReason, lastExecutionAt, version }], meta }`
- **Códigos:** 200, 401, 403, 422, 429, 503

### NTR-02 — POST `/notification-rules`
**Permissão:** `NOTIFICATION_RULE_MANAGE` · **Story:** US-193
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ name, eventType, condition?, recipients, titleTemplate, bodyTemplate, priority?, sendEmail?, maxPerRecipientPerDay?, status? }` + `Idempotency-Key`
- **Response:** `201 { data: NotificationRule }` + `Location`, `ETag`
- **Códigos:** 201, 401, 403, 409, 422, 429, 503

### NTR-03 — GET `/notification-rules/{id}`
**Permissão:** `NOTIFICATION_RULE_MANAGE` · **Story:** US-193
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** path `id`
- **Response:** `200 { data: NotificationRule }` + `ETag`
- **Códigos:** 200, 401, 403, 404, 429, 503

### NTR-04 — PATCH `/notification-rules/{id}`
**Permissão:** `NOTIFICATION_RULE_MANAGE` · **Story:** US-193
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** campos parciais + `If-Match`
- **Response:** `200 { data: NotificationRule }` + `ETag` nova
- **Códigos:** 200, 401, 403, 404, 409, 412, 422, 428, 503

### NTR-05 — POST `/notification-rules/{id}/activate`
**Permissão:** `NOTIFICATION_RULE_MANAGE` · **Story:** US-193
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `If-Match`
- **Response:** `200 { data: NotificationRule }` (de `INACTIVE` ou `AUTO_DISABLED`)
- **Códigos:** 200, 401, 403, 404, 412, 422, 428, 503

### NTR-06 — POST `/notification-rules/{id}/deactivate`
**Permissão:** `NOTIFICATION_RULE_MANAGE` · **Story:** US-193
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `If-Match`
- **Response:** `200 { data: NotificationRule }`
- **Códigos:** 200, 401, 403, 404, 412, 428, 503

### NTR-07 — GET `/notification-rules/{id}/executions`
**Permissão:** `NOTIFICATION_RULE_MANAGE` · **Story:** US-193
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `?matched=&from=&to=&page=&pageSize=`
- **Response:** `200 { data: [{ id, sourceEventId, processId, processCode | null, matched, recipientsCount, suppressedCount, createdAt }], meta }` (últimos 90 dias)
- **Códigos:** 200, 401, 403, 404, 422, 429, 503

### NTR-08 — POST `/notification-rules/{id}/preview`
**Permissão:** `NOTIFICATION_RULE_MANAGE` · **Story:** US-193
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ processId?, overrides? }` (leitura; sem `Idempotency-Key`)
- **Response:** `200 { data: { title, body, truncated, sample, conditionResult, recipients: { count, categories[] } } }`
- **Códigos:** 200, 401, 403, 404, 422, 429, 503

### NTR-09 — GET `/notification-rules/event-types`
**Permissão:** `NOTIFICATION_RULE_MANAGE` · **Story:** US-193
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** —
- **Response:** `200 { data: [{ eventType, routingKey, label, group, variables[] }] }`
- **Códigos:** 200, 401, 403, 429, 503

### SLA-01 — GET `/sla-policies`
**Permissão:** `SLA_POLICY_MANAGE` · **Story:** US-189
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `?isActive=&workflowId=&q=&page=&pageSize=&sort=`
- **Response:** `200 { data: [{ id, key, name, description, priority, workflow { id, name } | null, isActive, applicability { mode, label }, stagesCount, pauseConditionsCount, escalationStepsCount, evaluationOrder, version, createdAt, updatedAt }], meta }`
- **Códigos:** 200, 401, 403, 422, 429, 503

### SLA-02 — POST `/sla-policies`
**Permissão:** `SLA_POLICY_MANAGE` · **Story:** US-189
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ key, name, description?, applicabilityRule, priority?, workflowId?, stages?, pauseConditions?, escalationSteps?, isActive? }` + `Idempotency-Key`
- **Response:** `201 { data: SlaPolicy }` + `Location`, `ETag`
- **Códigos:** 201, 401, 403, 409, 422, 429, 503

### SLA-03 — GET `/sla-policies/{id}`
**Permissão:** `SLA_POLICY_MANAGE` · **Story:** US-189
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** path `id`
- **Response:** `200 { data: SlaPolicy completa }` + `ETag`
- **Códigos:** 200, 401, 403, 404, 429, 503

### SLA-04 — PATCH `/sla-policies/{id}`
**Permissão:** `SLA_POLICY_MANAGE` · **Story:** US-189
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** campos parciais; arrays enviados substituem os anteriores; `If-Match`
- **Response:** `200 { data: SlaPolicy }` + `ETag` nova
- **Códigos:** 200, 401, 403, 404, 412, 422, 428, 503

### SLA-05 — POST `/sla-policies/{id}/activate`
**Permissão:** `SLA_POLICY_MANAGE` · **Story:** US-189
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `If-Match`
- **Response:** `200 { data: SlaPolicy }`
- **Códigos:** 200, 401, 403, 404, 412, 422, 428, 503

### SLA-06 — POST `/sla-policies/{id}/deactivate`
**Permissão:** `SLA_POLICY_MANAGE` · **Story:** US-189
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` Obrigatório
- **Request:** `If-Match`
- **Response:** `200 { data: SlaPolicy }`
- **Códigos:** 200, 401, 403, 404, 412, 428, 503

### SLA-07 — GET `/sla-policies/stage-catalog`
**Permissão:** `SLA_POLICY_MANAGE` · **Story:** US-189
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** `?workflowId=` (opcional)
- **Response:** `200 { data: [{ stageKey, name, type, isApproval, workflows: [{ id, name }] }] }`
- **Códigos:** 200, 401, 403, 404, 422, 503

### SLA-11 — POST `/sla-policies/preview`
**Permissão:** `SLA_POLICY_MANAGE` ou `PROCESS_VIEW` · **Story:** US-190
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Request:** `{ processId, policyId?, stageKeys? }` (leitura; sem `Idempotency-Key`)
- **Response:** `200 { data: { processId, contextVersion, candidates: [{ policyId, key, name, priority, isActive, result, winner }], appliedPolicy: { id, key, name, priority } | null, stages: [{ stageKey, name, type, source, days, dayCountType, approverDays, illustrativeDueAt }] } }`
- **Códigos:** 200, 401, 403, 404, 422, 429, 503

### SLA-12 — GET `/processes/{id}/sla`
**Permissão:** `PROCESS_VIEW` · **Story:** US-190 (também citado por US-191, US-192)
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Request:** path `id`; query `includeClosed`
- **Response:** `200 { data: { processId, stages: [{ processStageId, stageKey, name, branchKey, status, enteredAt, exitedAt, dueAt, slaDays, slaType, dueDateOverridden, slaPolicy, overdueSince, pausedAt, pauseReason, pausedSeconds, escalationLevel, lastEscalatedAt, nextEscalation }] }, meta: { escalationEnabled } }`; `Cache-Control: no-store`
- **Códigos:** 200, 401, 403, 404, 422, 429, 503
- **Uso/ampliação em US-191:** request path `id`; query `includeClosed` → response `stages[]` com `pausedAt`, `pauseReason`, `pausedSeconds`, `dueAt`, `overdueSince` (campos criados em US-190, preenchidos aqui) · códigos 200, 401, 403, 404, 422, 429, 503
- **Uso/ampliação em US-192:** request path `id`; query `includeClosed` → response `stages[]` com `escalationLevel`, `lastEscalatedAt`, `nextEscalation` (campos criados em US-190, preenchidos aqui); `meta.escalationEnabled` · códigos 200, 401, 403, 404, 422, 429, 503

### APV-03 — POST `/approvals/{id}/decide` (ampliação do MVP 1)
Contrato original: [mvp-01/api/11-approvals-inbox.md](../../mvp-01/api/11-approvals-inbox.md). Mudanças do MVP 2, todas aditivas:
- **US-190:** request como em US-052 → response idem, quando a decisão abre nova etapa · códigos 200, 403, 404, 409, 412, 422, 503

### CAL-06 — POST `/calendar/add-business-days` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-190:** request `{ fromDateTime, businessDays, dayCountType? }` (usado internamente e na pré-visualização) → response `200 { data: { dueDateTime } }` · códigos 200, 422, 503

### NTF-01 — GET `/notifications` (ampliação do MVP 1)
Contrato original: [mvp-01/api/13-dashboard-notifications-audit.md](../../mvp-01/api/13-dashboard-notifications-audit.md). Mudanças do MVP 2, todas aditivas:
- **US-192:** request filtros do MVP 1 → response itens `SLA_ESCALATION` (título, corpo, `link`) · códigos 200, 401, 422, 429, 503

### PRC-12 — GET `/processes/{id}/timeline` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-191:** request filtros do MVP 1 (grupo "Prazos") → response entradas `SLA_PAUSED`/`SLA_RESUMED` com `params` (`stageName`, `reason`, `dueAt?`) · códigos 200, 401, 403, 404, 429, 503
- **US-192:** request filtros do MVP 1 (grupo "Prazos") → response entradas `STAGE_ESCALATED` (`stageName`, `level`) · códigos 200, 401, 403, 404, 429, 503

### PRC-19 — POST `/processes/{id}/forward` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-190:** request como em US-047 → response passagem com `dueAt`/`slaPolicyId` (efeito desta story) · códigos 200, 403, 404, 409, 412, 422, 503

### PRC-20 — POST `/processes/{id}/return` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-190:** request como em US-048 → response idem · códigos 200, 403, 404, 409, 412, 422, 503

### PRC-23 — POST `/processes/{id}/suspend` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-191:** request `{ reason }` + `If-Match` + `Idempotency-Key` (US-008) → response `200 { data: Process }`; passagens ativas pausadas com `pauseReason` · códigos 200, 403, 404, 409, 412, 422, 428, 503

### PRC-24 — POST `/processes/{id}/resume` (ampliação do MVP 1)
Contrato original: [mvp-01/api/02-processes.md](../../mvp-01/api/02-processes.md). Mudanças do MVP 2, todas aditivas:
- **US-191:** request `{ comment? }` + `If-Match` + `Idempotency-Key` (US-008) → response `200 { data: Process }`; `dueAt` estendido · códigos 200, 403, 404, 409, 412, 422, 428, 503

### SET-01 — GET `/settings` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-192:** request — (US-103) → response inclui `sla.escalationEnabled` · códigos 200, 401, 403, 503

### SET-02 — PATCH `/settings` (ampliação do MVP 1)
Contrato original: [mvp-01/api/14-tenant-administration.md](../../mvp-01/api/14-tenant-administration.md). Mudanças do MVP 2, todas aditivas:
- **US-192:** request `{ "sla.escalationEnabled": boolean }` + `If-Match` (US-103) → response `200`; `TenantSettingsChanged` · códigos 200, 401, 403, 412, 422, 503
