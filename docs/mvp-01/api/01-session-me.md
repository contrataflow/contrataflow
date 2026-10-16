# Sessão e usuário corrente (`identity`, `access`)

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2.

| ID | Método | Rota | Permissão | Story |
|---|---|---|---|---|
| ME-01 | GET | `/me` | Implícita (usuário autenticado) | US-098 |
| ME-02 | PATCH | `/me` | Implícita (usuário autenticado) | US-098 |
| ME-03 | GET | `/me/permissions` | Implícita (usuário autenticado) | US-097 |
| ME-04 | GET | `/me/memberships` | Implícita (usuário autenticado) | US-093 |
| ME-05 | GET | `/me/notification-preferences` | Implícita (usuário autenticado) | US-113 |
| ME-06 | PUT | `/me/notification-preferences` | Implícita (usuário autenticado) | US-113 |

Rotas do BFF (fora do OpenAPI da API interna; ver `architecture/authentication.md`): `GET /api/auth/login`, `GET /api/auth/callback`, `POST /api/auth/logout`, `GET /api/auth/session`, `POST /api/auth/switch-tenant`, `GET /api/auth/step-up`, `GET /api/auth/forgot-password` (US-086, US-089, US-093).

---

### ME-01 — Obter perfil do usuário autenticado
`GET /api/v1/me` · **Permissão:** implícita (qualquer usuário autenticado) · **Story:** US-098

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** —
- **Request:** —
- **Response:** `200 { data: User }` + `ETag`:
```ts
User {
  id: string;                    // uuid, somente leitura
  name: string;                  // 2–200
  socialName?: string | null;    // 2–200
  phone?: string | null;         // formato BR
  preferences: { density: string; theme: string }; // registro RN-IAM-111
  version: number;
}
```
- **Erros:** —
- **Efeitos:** —
- **Notas:** demais atributos do `User` conforme entities.md (entidade `User`).

### ME-02 — Atualizar perfil do usuário autenticado
`PATCH /api/v1/me` · **Permissão:** implícita (qualquer usuário autenticado) · **Story:** US-098

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório (versão do `User`; DEC-104)
- **Parâmetros:** —
- **Request:**
```ts
{
  name?: string;               // 2–200, trim; se enviado, não pode ficar vazio
  socialName?: string | null;  // 2–200
  phone?: string | null;       // formato BR
  preferences?: { density?: string; theme?: string }; // chaves do registro RN-IAM-111
}
```
- **Response:** `200 { data: User }` (schema de ME-01) + `ETag`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 412 | `VERSION_CONFLICT` | `If-Match` divergente (dados atualizados em outra aba) |
| 422 | `VALIDATION_ERROR` | `name` ausente/curto; `phone` em formato inválido |
| 422 | `SETTING_KEY_UNKNOWN` | Chave de `preferences` desconhecida |

- **Efeitos:** Eventos: —. Auditoria: `profile.update` (`DATA_CHANGE`) no commit — `changes`: campos alterados (`name`, `socialName`, `phone`, `preferences`).
- **Notas:** `If-Match` ausente → 428 `PRECONDITION_REQUIRED` (genérico, api.md §1.3).

### ME-03 — Obter permissões efetivas do usuário
`GET /api/v1/me/permissions` · **Permissão:** implícita (qualquer usuário autenticado) · **Story:** US-097

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** —
- **Request:** —
- **Response:** `200 { data: { permissions: [{ code: string, scopes: [{ type: "TENANT" | "ORGANIZATION" | "DEPARTMENT" | "OWN_DEPARTMENTS", organizationId?: uuid, departmentId?: uuid, includeSubtree: boolean }] }], implicit: { headOfDepartmentIds: uuid[], ownDepartmentIds: uuid[] } } }` — permissões em ordem alfabética, escopos sem repetição (permissions.md §9 · RN-IAM-106); `ownDepartmentIds` = lotações do vínculo (US-001: pré-preenchimento e destaque do setor solicitante no wizard SCR-005).
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 401 | `UNAUTHENTICATED` / `SESSION_EXPIRED` | Sem token válido / sessão expirada |
| 403 | `MEMBERSHIP_INACTIVE` | Vínculo com o tenant ativo (`X-Tenant-Id`) não está `ACTIVE` |
| 403 | `TENANT_SUSPENDED` | Tenant ativo não está `ACTIVE` |
| 503 | `DEPENDENCY_UNAVAILABLE` | Banco indisponível com o cache de permissões vazio/expirado |

- **Efeitos:** Consulta somente leitura — não gera `AuditLog`. Cache de permissões é invalidado por eventos `role.*`, `membership.*` e `department.moved` (consumidos, não gerados por esta rota).
- **Notas:** escopos de `permissions[].scopes` das atribuições vigentes (permissions.md §1) e `implicit` conforme as capacidades implícitas de permissions.md §7. Servido do mesmo retrato em cache que o guard de autorização usa (US-097). Conveniência de UI: a API decide cada requisição (RN-IAM-107).

### ME-04 — Listar vínculos (instituições) do usuário
`GET /api/v1/me/memberships` · **Permissão:** implícita (qualquer usuário autenticado) · **Story:** US-093

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** — (chamada sem `X-Tenant-Id`)
- **Request:** —
- **Response:** `200 { data: [{ membershipId: string, tenant: { id: string, name: string, status: string }, type: string, status: string, usable: boolean }] }`
- **Erros:** —
- **Efeitos:** —
- **Notas:** `usable` consolida `status = ACTIVE`, vínculo não expirado e tenant disponível; consumida pela troca de tenant (`POST /api/auth/switch-tenant`, BFF — fora deste OpenAPI).

### ME-05 — Obter preferências de notificação
`GET /api/v1/me/notification-preferences` · **Permissão:** implícita (qualquer usuário autenticado) · **Story:** US-113

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** —
- **Request:** —
- **Response:** `200 { data: [{ notificationType: string, channel: "IN_APP" | "EMAIL", enabled: boolean, editable: boolean }] }`
- **Erros:** —
- **Efeitos:** —
- **Notas:** `notificationType` é o registro `NotificationType` (events.md §6); `editable = false` para combinações obrigatórias (RN-NTF-23).

### ME-06 — Atualizar preferências de notificação
`PUT /api/v1/me/notification-preferences` · **Permissão:** implícita (qualquer usuário autenticado) · **Story:** US-113

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** —
- **Request:** `{ preferences: [{ notificationType: string, channel: "IN_APP" | "EMAIL", enabled: boolean }] }` — não vazio
- **Response:** `200 { data: [{ notificationType, channel, enabled, editable }] }` (schema de ME-05)
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` (`INVALID_ENUM`) | `notificationType`/`channel` fora dos enums/registro |
| 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`) | Tentativa de desativar `IN_APP` de tipo obrigatório |
| 422 | `VALIDATION_ERROR` | Corpo vazio ou malformado |

- **Efeitos:** Eventos: — (lido diretamente pelo `NotificationDispatcher` no próximo despacho — US-111). Auditoria: `notification.preferences_update` (`SECURITY`) no commit — `changes`: combinações alteradas (tipo, canal, de/para); `metadata`: quantidade total.
- **Notas:** sem `If-Match` (preferência pessoal sem controle de versão exposto).
