# Plataforma e saúde

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2.
> Enums (`TenantStatus`, `TenantType`, `OrganizationType`, `DepartmentType`, `CatalogType`, `HolidayScope` e demais): valores em [entities.md §2](../entities.md). Chaves de configuração do tenant: entities.md §6.

## Resumo dos endpoints

| ID | Método | Rota | Permissão | Story |
|---|---|---|---|---|
| PLT-01 | POST | `/platform/tenants` | `PLATFORM_TENANT_MANAGE` (Idem.) | US-099 |
| PLT-02 | GET | `/platform/tenants` | `PLATFORM_TENANT_MANAGE` | US-099 |
| PLT-03 | GET | `/platform/tenants/{id}` | `PLATFORM_TENANT_MANAGE` | US-099 |
| PLT-04 | POST | `/platform/tenants/{id}/activate` | `PLATFORM_TENANT_MANAGE` (IM) | US-099 |
| PLT-05 | POST | `/platform/tenants/{id}/suspend` | `PLATFORM_TENANT_MANAGE` (IM) | US-099 |
| PLT-06 | POST | `/platform/tenants/{id}/offboard` | `PLATFORM_TENANT_MANAGE` (IM) | US-099 |
| PLT-07 | POST | `/platform/tenants/{id}/deactivate` | `PLATFORM_TENANT_MANAGE` (IM) | US-099 |
| PLT-08 | PATCH | `/platform/tenants/{id}` | `PLATFORM_TENANT_MANAGE` (IM) | US-099 |
| HLT-01 | GET | `/health/live` | nenhuma (rede interna/ALB) | US-085 |
| HLT-02 | GET | `/health/ready` | nenhuma (rede interna/ALB) | US-085 |
| HLT-03 | GET | `/metrics` | nenhuma (rede interna) | US-085 |

## Tipos de referência

```ts
Tenant {
  id: string; slug: string; name: string; legalName?: string;
  type: TenantType; stateCode: string; ibgeCityCode?: string;
  timezone: string; locale: string; plan: string;
  status: TenantStatus;   // "ACTIVE" | "SUSPENDED" | "OFFBOARDING" | "DEACTIVATED" citados na story;
                           // com activate=false o tenant permanece em PROVISIONING (checklist concluído) até a ativação (TenantActivated)
  primaryOrganizationId: string;
  activatedAt?: string; suspendedAt?: string; deactivatedAt?: string;
  version: number;
}

ProvisioningStep { key: string; status: "PENDING" | "DONE" | "FAILED"; details?: object }
```

Enum `TenantType` referenciado pelo nome — valores não enumerados nos extratos da tarefa.

## Endpoints

### PLT-01 — Provisionar tenant
`POST /api/v1/platform/tenants` · **Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-099
- **Cabeçalhos:** `Idempotency-Key` obrigatório; `If-Match` —
- **Parâmetros:** —
- **Request:**
```ts
{ slug: string; name: string; legalName?: string; type: TenantType; stateCode: string;
  ibgeCityCode?: string; timezone?: string; locale?: string; plan?: string;
  primaryOrganization: { name: string; shortName: string; cnpj: string; type: OrganizationType; email?: string; phone?: string };
  firstAdmin: { email: string; name: string };
  activate?: boolean }
```
  `slug`: minúsculas/números/hífen, não reservado, único (inclusive entre desativados); `name` 3–200; `stateCode`: UF válida; `ibgeCityCode` obrigatório para município/câmara e com prefixo compatível com a UF; `timezone`: allowlist BR, padrão `America/Sao_Paulo`; `locale` padrão `pt-BR`; `plan` padrão `STANDARD`; `primaryOrganization` segue as regras de `ORG-02` (US-101, api/14); `firstAdmin.email` formato válido; `activate` padrão `true`
- **Response:** `201 { data: Tenant & { provisioning: { complete: boolean, steps: ProvisioningStep[] }, firstAdmin: { email: string (mascarado), membershipStatus: "INVITED", invitationDispatched: boolean } } }` com `Location`

  Exemplo (trecho):
  ```json
  { "status": "ACTIVE", "version": 3,
    "provisioning": { "complete": true, "steps": [
      { "key": "tenancy.tenantRecord", "status": "DONE" },
      { "key": "catalog.items", "status": "DONE", "details": { "items": 84 } },
      { "key": "identity.firstAdmin", "status": "DONE" }
    ] },
    "firstAdmin": { "email": "r***@pmsj.exemplo.gov.br", "membershipStatus": "INVITED", "invitationDispatched": true } }
  ```
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Não é operador da plataforma |
| 403 | `MFA_REQUIRED` | Sessão sem MFA |
| 409 | `TENANT_SLUG_TAKEN` | `slug` já em uso |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | Mesma `Idempotency-Key` em processamento (consultar `PLT-03`) |
| 422 | `VALIDATION_ERROR` | `REQUIRED`/`TOO_SHORT`/`TOO_LONG`/`INVALID_FORMAT` (slug, e-mail)/`INVALID_ENUM` (UF, tipo, fuso)/`CONDITIONAL_REQUIRED` (IBGE)/`INVALID_CNPJ` |

- **Efeitos:** Evento `TenantProvisioned` (`tenant.provisioned`, ao concluir a etapa `tenancy.complete`; único por tenant); eventos próprios das fachadas chamadas (`OrganizationCreated`, `UserInvited` etc., conforme as stories donas); auditoria `tenant.provision` (`SYSTEM`; sucesso: `slug`, `channel`, `seedVersions`, `steps`, `durationMs`, `idempotencyKey`; falha: + `failedStep`, `errorCode`). Notificação: convite por e-mail ao primeiro administrador (via `UserInvited`/US-091, fora do evento de domínio).
- **Notas:** `provisioning.steps[]` é o checklist de seeders registrados (ex.: `tenancy.tenantRecord`, `catalog.items`, …, `identity.firstAdmin`); passos concluídos são preservados em caso de falha (reexecução idempotente — RN-TEN-09); RN-TEN-01/02/03/04.

### PLT-02 — Listar tenants (plataforma)
`GET /api/v1/platform/tenants` · **Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-099
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** query `status` (string, Não), `stateCode` (string, Não), `q` (string, Não); paginação padrão `page`/`pageSize` (api.md §1.2); ordenação: a definir na implementação
- **Request:** —
- **Response:** `200 { data: Pick<Tenant, "id"|"slug"|"name"|"type"|"status"|"stateCode"|"plan"|"activatedAt"|"suspendedAt">[], meta }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Não é operador da plataforma |

- **Efeitos:** —
- **Notas:** —

### PLT-03 — Consultar tenant (plataforma)
`GET /api/v1/platform/tenants/{id}` · **Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-099
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` — (GET retorna `ETag`)
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** —
- **Response:** `200 { data: Tenant & { provisioning: { complete: boolean, steps: ProvisioningStep[] } } }` com `ETag`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Não é operador da plataforma |
| 404 | `TENANT_NOT_FOUND` | Inexistente |

- **Efeitos:** —
- **Notas:** Usado para acompanhar o provisionamento em andamento (ex.: após `409 IDEMPOTENCY_IN_PROGRESS` em `PLT-01`).

### PLT-04 — Ativar tenant
`POST /api/v1/platform/tenants/{id}/activate` · **Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-099
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{}`
- **Response:** `200 { data: Tenant }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Não é operador da plataforma |
| 404 | `TENANT_NOT_FOUND` | Inexistente |
| 409 | `INVALID_STATE` | Transição não permitida, ou etapas de provisionamento pendentes |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Evento `TenantActivated` (`tenant.activated`; invalida o cache de status — US-100); auditoria `tenant.activate` (`SYSTEM`, `changes.status`, `metadata.fromStatus`/`toStatus`).
- **Notas:** Cobre tanto a primeira ativação quanto a reativação após suspensão.

### PLT-05 — Suspender tenant
`POST /api/v1/platform/tenants/{id}/suspend` · **Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-099
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{ reason: string }` — `reason` 10–1.000 caracteres, obrigatório
- **Response:** `200 { data: Tenant }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Não é operador da plataforma |
| 404 | `TENANT_NOT_FOUND` | Inexistente |
| 409 | `INVALID_STATE` | Transição não permitida |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | `reason` ausente/curto |

- **Efeitos:** Evento `TenantSuspended` (`tenant.suspended`; invalida o cache de status); auditoria `tenant.suspend` (`SYSTEM`, `changes`: `status`, `suspendedAt`; `metadata`: motivo informado).
- **Notas:** Usuários do tenant passam a receber `403 TENANT_SUSPENDED` (SCR-111) enquanto suspenso.

### PLT-06 — Encerrar tenant (offboard)
`POST /api/v1/platform/tenants/{id}/offboard` · **Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-099
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{ reason: string }` — `reason` 10–1.000 caracteres. **Contrato de Request/Response não detalhado na tabela de API da story** (US-099 trata "encerrar" apenas em validações/auditoria); derivado por analogia a `PLT-05` — sinalizado como lacuna
- **Response:** `200 { data: Tenant }` (`status` final `"OFFBOARDING"`)
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Não é operador da plataforma |
| 404 | `TENANT_NOT_FOUND` | Inexistente |
| 409 | `INVALID_STATE` | Transição não permitida |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | `reason` ausente/curto |

- **Efeitos:** Evento `TenantOffboarded` (`tenant.offboarded`; payload `tenantId`, `offboardingEndsAt?` — events.md §4; encerra sessões); auditoria `tenant.deactivate` (`SYSTEM`, `metadata`: `fromStatus`, `toStatus = "OFFBOARDING"`, motivo, `channel`).
- **Notas:** A story de origem não detalha o evento canônico deste encerramento (sinalizado como lacuna); compartilha a ação de auditoria `tenant.deactivate` com `PLT-07`, distinguida por `metadata.toStatus`.

### PLT-07 — Desativar tenant
`POST /api/v1/platform/tenants/{id}/deactivate` · **Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-099
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{ reason: string }` — `reason` 10–1.000 caracteres. **Contrato de Request/Response não detalhado na tabela de API da story**; derivado por analogia a `PLT-05` — sinalizado como lacuna. O fluxo por CLI equivalente exige confirmação adicional (`--confirm-slug`), não aplicável à chamada HTTP
- **Response:** `200 { data: Tenant }` (`status` final `"DEACTIVATED"`)
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Não é operador da plataforma |
| 404 | `TENANT_NOT_FOUND` | Inexistente |
| 409 | `INVALID_STATE` | Transição não permitida |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | `reason` ausente/curto |

- **Efeitos:** Evento `TenantDeactivated` (`tenant.deactivated`; payload `tenantId` — events.md §4; encerra sessões); auditoria `tenant.deactivate` (`SYSTEM`, `metadata`: `fromStatus`, `toStatus = "DEACTIVATED"`, motivo, `channel`).
- **Notas:** Operação sem evento canônico detalhado na story de origem (sinalizado como lacuna); distinta de `PLT-06` pelo `toStatus` final.

### PLT-08 — Atualizar dados do tenant (plataforma)
`PATCH /api/v1/platform/tenants/{id}` · **Permissão:** `PLATFORM_TENANT_MANAGE` · **Story:** US-099
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{ name?: string; legalName?: string; timezone?: string; locale?: string; plan?: string }` — mesmos limites de `PLT-01`. **Conjunto exato de campos editáveis não detalhado na story** — sinalizado como lacuna
- **Response:** `200 { data: Tenant }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Não é operador da plataforma |
| 404 | `TENANT_NOT_FOUND` | Inexistente |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | Conforme schema dos campos |

- **Efeitos:** Sem evento de domínio (o catálogo indica apenas auditoria para este endpoint); auditoria `tenant.update` (categoria `SYSTEM`, por consistência com as demais ações `tenant.*`; `changes`: campos alterados — forma exata não detalhada na story, a definir na implementação).
- **Notas:** —

### HLT-01 — Verificar processo ativo (liveness)
`GET /health/live` (fora de `/api/v1`) · **Permissão:** nenhuma (rede interna/ALB) · **Story:** US-085
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** —
- **Request:** —
- **Response:** `200` ou `503`, corpo `application/health+json`
- **Erros:** Não usa `application/problem+json` (ver api.md §2); `200` (`pass`) enquanto o *event loop* responde, `503` (`fail`) quando o atraso do *event loop* chega a 2 s (RN-FND-79/80) — o orquestrador reinicia o contêiner.
- **Efeitos:** — (consulta por *pull*/scrape; não gera evento nem auditoria — observação técnica, não ação de usuário)
- **Notas:** Não reflete a saúde de dependências externas (isso é papel de `HLT-02`); corpo restrito a uma *allowlist* de campos (sem host, stack ou credencial).

### HLT-02 — Verificar prontidão (readiness)
`GET /health/ready` (fora de `/api/v1`) · **Permissão:** nenhuma (rede interna/ALB) · **Story:** US-085
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** —
- **Request:** —
- **Response:** `200` ou `503`, corpo `application/health+json` com `checks` por dependência
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 503 | — (corpo `health+json` com `status: "fail"`; não usa `problem+json`) | Dependência crítica indisponível |

- **Efeitos:** — (sem evento/auditoria)
- **Notas:** `503` retira a instância do balanceador (`api`/`web`) ou gera alerta (`worker`); dependência degradável indisponível retorna `200` com `status: "warn"` e a instância continua recebendo tráfego; `HEALTH_CACHE_TTL_MS` (padrão `5000`) e `HEALTH_CHECK_TIMEOUT_MS` (`1000` PostgreSQL / `500` Redis) controlam o comportamento.

### HLT-03 — Expor métricas Prometheus
`GET /metrics` (fora de `/api/v1`) · **Permissão:** nenhuma — restrita à rede interna (`METRICS_PORT`, porta de administração separada da pública) · **Story:** US-085
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** —
- **Request:** —
- **Response:** `200`, corpo texto no formato Prometheus
- **Erros:** — (acesso fora da rede interna é bloqueado na camada de rede — listener/WAF/security group —, sem resposta de aplicação)
- **Efeitos:** — (sem evento/auditoria)
- **Notas:** Nunca exposto na porta pública (verificado por teste de infraestrutura dedicado); labels não podem ter cardinalidade aberta (ex.: `tenantId`, e-mail); *scrape* a cada `METRICS_SCRAPE_INTERVAL_SECONDS` (padrão `15`).
