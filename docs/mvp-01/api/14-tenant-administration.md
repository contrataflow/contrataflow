# Administração do tenant (`identity`, `access`, `tenancy`, `organization`, `catalog`)

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2.
> Enums (`TenantStatus`, `TenantType`, `OrganizationType`, `DepartmentType`, `CatalogType`, `HolidayScope` e demais): valores em [entities.md §2](../entities.md). Chaves de configuração do tenant: entities.md §6.

## Resumo dos endpoints

| ID | Método | Rota | Permissão | Story |
|---|---|---|---|---|
| USR-01 | GET | `/users` | `USER_VIEW` | US-092 |
| USR-02 | GET | `/users/lookup` | implícita | US-092 |
| USR-03 | POST | `/users/invitations` | `USER_INVITE` (Idem.) | US-091 |
| USR-04 | POST | `/users/invitations/{userId}/resend` | `USER_INVITE` | US-091 |
| USR-05 | DELETE | `/users/invitations/{userId}` | `USER_INVITE` | US-091 |
| USR-06 | POST | `/invitations/accept` | autenticado + token | US-091 |
| USR-14 | POST | `/invitations/preview` | autenticado + token | US-091 |
| USR-07 | GET | `/users/{userId}` | `USER_VIEW` | US-092 |
| USR-08 | PATCH | `/users/{userId}` | `USER_MANAGE` (IM) | US-092 |
| USR-09 | PUT | `/users/{userId}/departments` | `USER_MANAGE` (IM) | US-092 |
| USR-10 | POST | `/users/{userId}/suspend` | `USER_MANAGE` (+ POL-12/POL-16, IM) | US-092 |
| USR-11 | POST | `/users/{userId}/reactivate` | `USER_MANAGE` (IM) | US-092 |
| USR-12 | POST | `/users/{userId}/revoke` | `USER_MANAGE` (+ POL-12/POL-16, IM) | US-092 |
| USR-13 | POST | `/users/{userId}/mfa-reset` | `USER_MANAGE` (+ POL-16, IM) | US-090 |
| ROL-01 | GET | `/permissions` | `ROLE_VIEW` | US-094 |
| ROL-02 | GET | `/roles` | `ROLE_VIEW` | US-095 |
| ROL-03 | POST | `/roles` | `ROLE_MANAGE` (+ POL-13) | US-095 |
| ROL-04 | GET | `/roles/{id}` | `ROLE_VIEW` | US-095 |
| ROL-05 | PATCH | `/roles/{id}` | `ROLE_MANAGE` (IM) | US-095 |
| ROL-06 | PUT | `/roles/{id}/permissions` | `ROLE_MANAGE` (+ POL-13, IM) | US-095 |
| ROL-07 | POST | `/roles/{id}/duplicate` | `ROLE_MANAGE` | US-095 |
| ROL-08 | POST | `/roles/{id}/deactivate` | `ROLE_MANAGE` (+ POL-12, IM) | US-095 |
| ROL-09 | GET | `/roles/{id}/assignments` | `ROLE_VIEW` | US-096 |
| ROL-10 | GET | `/users/{userId}/role-assignments` | `USER_VIEW` ou `ROLE_VIEW` | US-096 |
| ROL-11 | POST | `/users/{userId}/role-assignments` | `ROLE_ASSIGN` (+ POL-13/POL-15, Idem.) | US-096 |
| ROL-12 | POST | `/role-assignments/{id}/revoke` | `ROLE_ASSIGN` (+ POL-12/POL-16, IM) | US-096 |
| ORG-01 | GET | `/organizations` | implícita | US-101 |
| ORG-02 | POST | `/organizations` | `ORGANIZATION_MANAGE` | US-101 |
| ORG-03 | GET | `/organizations/{id}` | implícita | US-101 |
| ORG-04 | PATCH | `/organizations/{id}` | `ORGANIZATION_MANAGE` (IM) | US-101 |
| DEP-01 | GET | `/departments` | implícita | US-102 |
| DEP-02 | GET | `/departments/lookup` | implícita | US-102 |
| DEP-03 | POST | `/departments` | `DEPARTMENT_MANAGE` | US-102 |
| DEP-04 | GET | `/departments/{id}` | implícita | US-102 |
| DEP-05 | PATCH | `/departments/{id}` | `DEPARTMENT_MANAGE` (IM) | US-102 |
| DEP-06 | POST | `/departments/{id}/move` | `DEPARTMENT_MANAGE` (IM) | US-102 |
| DEP-07 | POST | `/departments/{id}/deactivate` | `DEPARTMENT_MANAGE` (IM) | US-102 |
| DEP-08 | POST | `/departments/{id}/activate` | `DEPARTMENT_MANAGE` (IM) | US-102 |
| DEP-09 | DELETE | `/departments/{id}` | `DEPARTMENT_MANAGE` (IM; sem referências) | US-102 |
| SET-01 | GET | `/settings` | `SETTINGS_MANAGE` | US-103 |
| SET-02 | PATCH | `/settings` | `SETTINGS_MANAGE` (IM por chave no corpo, Idem.) | US-103, US-105 |
| SET-03 | GET | `/settings/public` | implícita | US-103 |
| SET-04 | POST | `/numbering/preview` | `SETTINGS_MANAGE` | US-105 |
| CAT-01 | GET | `/catalogs/{catalogType}/items` | implícita | US-104 |
| CAT-02 | POST | `/catalogs/{catalogType}/items` | `CATALOG_MANAGE` | US-104 |
| CAT-03 | PATCH | `/catalog-items/{id}` | `CATALOG_MANAGE` (IM) | US-104 |
| CAT-04 | POST | `/catalog-items/{id}/activate` | `CATALOG_MANAGE` (IM) | US-104 |
| CAT-05 | POST | `/catalog-items/{id}/deactivate` | `CATALOG_MANAGE` (IM) | US-104 |
| CAT-06 | PUT | `/catalogs/{catalogType}/order` | `CATALOG_MANAGE` | US-104 |
| CAL-01 | GET | `/holidays` | implícita | US-106 |
| CAL-02 | POST | `/holidays` | `CALENDAR_MANAGE` | US-106 |
| CAL-03 | PATCH | `/holidays/{id}` | `CALENDAR_MANAGE` (IM) | US-106 |
| CAL-04 | DELETE | `/holidays/{id}` | `CALENDAR_MANAGE` (IM) | US-106 |
| CAL-05 | GET | `/calendar/business-days` | implícita | US-106 |
| CAL-06 | POST | `/calendar/add-business-days` | implícita | US-106, US-055 |

## Tipos de referência

Schemas resumidos reutilizados pelos endpoints abaixo (campos de sistema `version`/`ETag` conforme api.md §1.3):

```ts
// Vínculo do usuário com o tenant (USR-*)
TenantMembership {
  id: string; userId: string;
  name: string; socialName?: string; email: string;
  type: "INTERNAL" | "EXTERNAL";           // MembershipType — SERVICE fora do MVP 1
  status: "INVITED" | "ACTIVE" | "SUSPENDED" | "REVOKED";
  jobTitle?: string; registrationNumber?: string;
  expiresAt?: string;                      // obrigatório para EXTERNAL
  departmentIds: string[]; primaryDepartmentId: string;
  version: number;
}

// Perfil de permissões (ROL-02..08)
Role {
  id: string; key: string; name: string; description?: string;
  isSystem: boolean; isProtected: boolean;
  allowExternalAssignment: boolean; isActive: boolean;
  activeAssignmentsCount: number; version: number;
  permissions?: string[];                  // presente em ROL-04/ROL-06
}

// Atribuição de perfil a um vínculo (ROL-09..12)
RoleAssignment {
  id: string; membershipId: string; roleId: string;
  scopeType: "TENANT" | "ORGANIZATION" | "DEPARTMENT" | "OWN_DEPARTMENTS";
  scopeOrganizationId: string | null; scopeDepartmentId: string | null;
  includeSubtree: boolean; validFrom: string; validUntil: string | null;
  status: "ACTIVE" | "REVOKED"; version: number;
  // US-096 — dados para a aba "Perfis e acessos" (SCR-029) sem consultas extras:
  userId: string; userName: string;
  roleKey: string; roleName: string;
  isAdministrative: boolean;               // perfil concede ROLE_ASSIGN/ROLE_MANAGE/USER_MANAGE (POL-16)
  scopeName: string | null;                // nome do órgão/unidade do escopo
  grantedBy: { id: string; name: string } | null; grantedAt: string;
  revokedAt: string | null;
}

// Item do catálogo de permissões, somente leitura (ROL-01)
Permission {
  code: string; module: string; name: string; description: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH"; scopable: boolean;
  isDeprecated: boolean; introducedIn: string;
}

Organization {
  id: string; name: string; shortName: string; cnpj: string;
  type: OrganizationType; isActive: boolean;
  email?: string; phone?: string; website?: string;
  addressStreet?: string; addressNumber?: string; addressComplement?: string;
  addressDistrict?: string; addressCity?: string; addressState?: string; addressZipCode?: string;
  ibgeCityCode?: string; logoAttachmentId?: string; metadata: object; version: number;
}

Department {
  id: string; organizationId: string; parentId?: string;
  type: DepartmentType; name: string; acronym?: string; code?: string;
  email?: string; phone?: string; headUserId?: string; deputyUserId?: string;
  isActive: boolean; sortOrder: number; path: string; depth: number; version: number;
}

CatalogItem {
  id: string; catalogType: CatalogType; code: string; label: string;
  description?: string; isSystem: boolean; isActive: boolean;
  sortOrder: number; parentId?: string; metadata: object; version: number;
}

Holiday {
  id: string; date: string; name: string; scope: HolidayScope;
  isRecurring: boolean; isActive: boolean; isSystem: boolean; version: number;
}
```

Observação: os enums `TenantType`/`OrganizationType`/`DepartmentType`/`CatalogType`/`HolidayScope` são referenciados pelo nome — os extratos da tarefa não enumeram seus valores; conferir o catálogo completo em `entities.md`.

## Endpoints

### USR-01 — Listar usuários e vínculos
`GET /api/v1/users` · **Permissão:** `USER_VIEW` · **Story:** US-092
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** query `q` (string, Não, busca textual mín. 2 caracteres — api.md §1.2), `status` (string, Não, lista separada por vírgula = OU), `type` (enum `INTERNAL`\|`EXTERNAL`, Não), `departmentId` (uuid, Não); paginação padrão (api.md §1.2); ordenação: a definir na implementação (não especificada na story)
- **Request:** —
- **Response:** `200 { data: TenantMembership[], meta }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `USER_VIEW` |

- **Efeitos:** —
- **Notas:** RN-IAM-54/62. Filtros `q` (nome ou e-mail), `status`, `type` (US-091) e `departmentId` (vínculos lotados na unidade — US-092); ordenação por nome. `EXTERNAL` com `expiresAt` vencido ainda `ACTIVE` é exibido como "Expirado" pelo cliente (RN-IAM-64).

### USR-02 — Buscar usuários para seleção (lookup)
`GET /api/v1/users/lookup` · **Permissão:** implícita (vínculo ativo no tenant) · **Story:** US-092
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** query `q` (string, Sim — salvo com `departmentId` —, mín. 2 e máx. 100 caracteres — nome ou e-mail, sem acento e sem distinção de maiúsculas); `departmentId` (uuid, Não — US-050: restringe aos lotados na unidade, até 50, e torna `q` opcional; alimenta o `DepartmentMemberSelect` do SCR-115)
- **Request:** —
- **Response:** `200 { data: { id: string; name: string; email: string; membershipType: 'INTERNAL' | 'EXTERNAL'; membershipExpiresAt: string | null }[] }` — até 20 usuários com vínculo `ACTIVE` (e não vencido) no tenant ativo, por nome; `id` = `userId`. Vínculos de serviço ficam de fora.
- **Erros:** 422 `VALIDATION_ERROR` (`q` ausente/curto)
- **Efeitos:** —
- **Notas:** Contrato definido na US-012 (seletor de participantes — SCR-112): `membershipType`/`membershipExpiresAt` permitem sugerir o papel Consultor e limitar a validade (RN-PROC-127).

### USR-03 — Convidar usuário
`POST /api/v1/users/invitations` · **Permissão:** `USER_INVITE` · **Story:** US-091
- **Cabeçalhos:** `Idempotency-Key` obrigatório; `If-Match` —
- **Parâmetros:** —
- **Request:**
```ts
{ email: string; name: string; type: "INTERNAL" | "EXTERNAL";
  jobTitle?: string; expiresAt?: string; departmentIds?: string[]; roleId?: string }
```
  `email` formato válido (RN-IAM-46); `name` 3–200; `expiresAt` obrigatório se `type=EXTERNAL` (RN-IAM-52); `departmentIds`/`roleId` devem referenciar unidades/perfil ativos do tenant
- **Response:** `201 { data: TenantMembership }` com `Location`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `USER_INVITE` |
| 409 | `MEMBERSHIP_ALREADY_EXISTS` | Vínculo já existente |
| 422 | `VALIDATION_ERROR` | Campo inválido/ausente; `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` em `departmentIds`/`roleId` |

- **Efeitos:** Evento `UserInvited` (`membership.invited`); auditoria `membership.invite` (`SECURITY`); e-mail de convite pela fila `email` — o worker consome `UserInvited` (`InvitationEmailEnqueuer`) e o `EmailSender` gera o link no envio (queues.md §4.3).
- **Notas:** RN-IAM-46/47/52. Também 503 `DEPENDENCY_UNAVAILABLE` (Authentik fora — nada é gravado; banco falha depois do Authentik → a conta criada é removida). `expiresAt` além de `security.externalMembershipMaxDays` → `OUT_OF_RANGE`; no passado → `DATE_IN_PAST`; `INTERNAL` com `expiresAt` → `NOT_ALLOWED`; perfil sem `allowExternalAssignment` em vínculo `EXTERNAL` → `NOT_ALLOWED` em `roleId` (POL-15). Vínculo `REVOKED`/`EXPIRED` da mesma pessoa é reaproveitado (`UNIQUE (tenant_id, user_id)`). `Location: /api/v1/users/{userId}`.

### USR-04 — Reenviar convite
`POST /api/v1/users/invitations/{userId}/resend` · **Permissão:** `USER_INVITE` · **Story:** US-091
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `userId` (uuid, Sim)
- **Request:** —
- **Response:** `200 { data: { inviteExpiresAt: string } }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `USER_INVITE` |
| 404 | `USER_NOT_FOUND` | Convite/vínculo inexistente, de outro tenant ou fora de `INVITED` |
| 429 | `RATE_LIMITED` | RN-IAM-53: 5 reenvios por convite ou menos de 1 minuto desde o último envio (`Retry-After`) |

- **Efeitos:** Evento `UserInvited` (`resend = true`); auditoria `membership.invite` (`metadata.resend`, `resendCount`). O hash do token é zerado no commit — o link anterior deixa de valer.
- **Notas:** Sujeito ao limite de escrita (api.md §1.6).

### USR-05 — Cancelar convite
`DELETE /api/v1/users/invitations/{userId}` · **Permissão:** `USER_INVITE` · **Story:** US-091
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `userId` (uuid, Sim)
- **Request:** —
- **Response:** `204`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `USER_INVITE` |
| 404 | `USER_NOT_FOUND` | Convite inexistente |
| 409 | `INVALID_STATE` | Vínculo não está mais `INVITED` |

- **Efeitos:** Auditoria `membership.revoke` (`metadata.reason = INVITATION_CANCELLED`).
- **Notas:** Revogação lógica (a aplicação não exclui vínculos — `cf_app` sem `DELETE` em `tenant_memberships`): o vínculo vai a `REVOKED` sem token; um novo convite reaproveita o registro.

### USR-06 — Aceitar convite
`POST /api/v1/invitations/accept` · **Permissão:** autenticado (qualquer) + token de convite válido · **Story:** US-091
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** —
- **Request:** `{ token: string }`
- **Response:** `200 { data: TenantMembership & { tenant: { id, name } } }` — a instituição do convite, para a troca da instituição ativa
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `TENANT_SUSPENDED` | Instituição do convite fora de `ACTIVE` |
| 404 | `INVITATION_INVALID` | Token inválido, já aceito, cancelado ou de outra pessoa |
| 410 | `INVITATION_EXPIRED` | Convite expirado |
| 422 | `VALIDATION_ERROR` | `token` ausente ou fora do formato (43 caracteres base64url) |

- **Efeitos:** Evento `MembershipActivated` (`membership.activated`); auditoria `membership.activate` (`SECURITY`).
- **Notas:** RN-IAM-47/49/50. `@TenantScope('CROSS_TENANT_LOOKUP')`: o convite é achado pelo hash (`cf_find_invitation`, `SystemDbService`/`INVITATION_LOOKUP`) e ativado no tenant DO CONVITE, nunca no ativo da sessão. Token de uso único (o hash é apagado no aceite).

### USR-14 — Consultar convite antes do aceite
`POST /api/v1/invitations/preview` · **Permissão:** autenticado (qualquer) + token de convite válido · **Story:** US-091
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** —
- **Request:** `{ token: string }` (no corpo, nunca na URL da API)
- **Response:** `200 { data: { tenant: { id, name }, type, jobTitle?, departments: { id, name }[], expiresAt?, inviteExpiresAt } }`
- **Erros:** os mesmos de USR-06.
- **Efeitos:** —
- **Notas:** Decisão da US-091 — o SCR-102 mostra instituição, cargo e lotação antes da confirmação (passo 6 do fluxo) e a story não tinha leitura do convite.

### USR-07 — Consultar usuário/vínculo
`GET /api/v1/users/{userId}` · **Permissão:** `USER_VIEW` · **Story:** US-092
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` — (GET retorna `ETag`)
- **Parâmetros:** path `userId` (uuid, Sim)
- **Request:** —
- **Response:** `200 { data: TenantMembershipDetail, meta: { allowedActions, isSelf } }` com `ETag` — `TenantMembershipDetail` = `TenantMembership` + `departments[] { id, name, isActive, isPrimary }` (principal primeiro), `suspendedAt`, `suspensionReason`, `revokedAt`, `revocationReason`; `allowedActions` ⊂ `UPDATE`, `UPDATE_DEPARTMENTS`, `SUSPEND`, `REACTIVATE`, `REVOKE` (vazio sem `USER_MANAGE`; sem `SUSPEND`/`REVOKE` quando `isSelf` — POL-16). USR-08..12 respondem no mesmo formato.
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `USER_VIEW` |
| 404 | `USER_NOT_FOUND` | Inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** api.md §1.5 (`meta.allowedActions`).

### USR-08 — Atualizar dados do vínculo
`PATCH /api/v1/users/{userId}` · **Permissão:** `USER_MANAGE` · **Story:** US-092
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `userId` (uuid, Sim)
- **Request:** `{ jobTitle?: string; registrationNumber?: string; expiresAt?: string }` — `jobTitle` ≤150; `registrationNumber` ≤40; `expiresAt` só para vínculo `EXTERNAL`, dentro do intervalo permitido
- **Response:** `200 { data: TenantMembership }` com `ETag`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `USER_MANAGE` |
| 404 | `USER_NOT_FOUND` | Inexistente/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | `TOO_LONG`/`OUT_OF_RANGE` |

- **Efeitos:** Evento `MembershipUpdated` (`membership.updated`); auditoria `membership.update` (`SECURITY`, `changes`: campos alterados).
- **Notas:** RN-IAM-54/55.

### USR-09 — Atualizar lotações do vínculo
`PUT /api/v1/users/{userId}/departments` · **Permissão:** `USER_MANAGE` · **Story:** US-092
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `userId` (uuid, Sim)
- **Request:** `{ departmentIds: string[]; primaryDepartmentId: string }` — `departmentIds` ≥1 item, unidades ativas do tenant; `primaryDepartmentId` ∈ `departmentIds`
- **Response:** `200 { data: TenantMembership }` com `ETag`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `USER_MANAGE` |
| 404 | `USER_NOT_FOUND` | Inexistente/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | `REQUIRED`/`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`/`INVALID_ENUM` (`primaryDepartmentId` fora da lista) |

- **Efeitos:** Evento `MembershipUpdated` (`membership.updated`, `changedFields[]` inclui `departments`); auditoria `membership.departments_update` (`SECURITY`, `changes`: lotações anteriores/novas).
- **Notas:** —

### USR-10 — Suspender vínculo
`POST /api/v1/users/{userId}/suspend` · **Permissão:** `USER_MANAGE` (+ POL-12/POL-16) · **Story:** US-092
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `userId` (uuid, Sim)
- **Request:** `{ reason?: string }` — `reason` ≤500
- **Response:** `200 { data: TenantMembership }` com `ETag`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `USER_MANAGE`, ou tentativa sobre o próprio vínculo (POL-16) |
| 404 | `USER_NOT_FOUND` | Inexistente/outro tenant |
| 409 | `LAST_ADMIN_REQUIRED` | Último `ADMIN_ORGAO` ativo (POL-12) |
| 409 | `INVALID_STATE` | Vínculo não `ACTIVE` |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Evento `MembershipSuspended` (`membership.suspended`, `hasReason`); auditoria `membership.suspend` (`SECURITY`, `metadata.hasReason`).
- **Notas:** POL-12 (último administrador), POL-16 (autoproteção).

### USR-11 — Reativar vínculo
`POST /api/v1/users/{userId}/reactivate` · **Permissão:** `USER_MANAGE` · **Story:** US-092
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `userId` (uuid, Sim)
- **Request:** `{}`
- **Response:** `200 { data: TenantMembership }` com `ETag`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `USER_MANAGE` |
| 404 | `USER_NOT_FOUND` | Inexistente/outro tenant |
| 409 | `INVALID_STATE` | Vínculo não `SUSPENDED` |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Evento `MembershipReactivated` (`membership.reactivated`); auditoria `membership.reactivate` (`SECURITY`).
- **Notas:** —

### USR-12 — Revogar vínculo
`POST /api/v1/users/{userId}/revoke` · **Permissão:** `USER_MANAGE` (+ POL-12/POL-16) · **Story:** US-092
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `userId` (uuid, Sim)
- **Request:** `{ reason?: string }` — `reason` ≤500
- **Response:** `200 { data: TenantMembership }` com `ETag`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `USER_MANAGE`, ou sobre o próprio vínculo (POL-16) |
| 404 | `USER_NOT_FOUND` | Inexistente/outro tenant |
| 409 | `LAST_ADMIN_REQUIRED` | Último `ADMIN_ORGAO` ativo (POL-12) |
| 409 | `INVALID_STATE` | Ação incompatível com status atual |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Evento `MembershipRevoked` (`membership.revoked`, `hasReason`; dispara encerramento de sessões); auditoria `membership.revoke` (`SECURITY`, `metadata.hasReason`).
- **Notas:** POL-12, POL-16.

### USR-13 — Redefinir MFA do usuário
`POST /api/v1/users/{userId}/mfa-reset` · **Permissão:** `USER_MANAGE` (+ POL-16) · **Story:** US-090
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` — (idempotente e sem alterar o vínculo — DEC-142)
- **Parâmetros:** path `userId` (uuid, Sim)
- **Request:** `{ reason: string }` — `reason` 10–500 caracteres, obrigatório
- **Response:** `200 { data: { userId: string, resetAt: string } }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `USER_MANAGE` |
| 403 | `MFA_REQUIRED` | Sessão do administrador sem segundo fator (`USER_MANAGE` é `HIGH`; política `ADMINS`/`ALL`) |
| 404 | `USER_NOT_FOUND` | Inexistente/outro tenant |
| 409 | `INVALID_STATE` | Vínculo `REVOKED` |
| 422 | `VALIDATION_ERROR` | `reason` ausente/curto (`NOT_ALLOWED` se o alvo for o próprio vínculo — POL-16: redefinição sobre si mesmo deve usar a recuperação no login) |
| 503 | `DEPENDENCY_UNAVAILABLE` | API administrativa do Authentik indisponível (com `Retry-After`) |

- **Efeitos:** remove os dispositivos de MFA da conta no Authentik (novo *enrollment* no próximo desafio); auditoria `membership.mfa_reset` (`SECURITY`, `metadata`: `targetUserId`, `reason`). Sem evento de domínio. Repetir antes do novo cadastro conclui normalmente.
- **Notas:** POL-16; RN-IAM-43 (`meta.allowedActions` de USR-07 inclui `MFA_RESET` fora do próprio vínculo e do revogado; botão oculto para o próprio usuário); consome indiretamente `security.mfaPolicy` (`SET-02`/US-103).

### ROL-01 — Listar permissões do catálogo
`GET /api/v1/permissions` · **Permissão:** `ROLE_VIEW` · **Story:** US-094
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** query `module` (string, Não, valor entre os módulos existentes no catálogo), `riskLevel` (enum `LOW`\|`MEDIUM`\|`HIGH`, Não); valores desconhecidos são ignorados (lista completa é retornada)
- **Request:** —
- **Response:** `200 { data: Permission[] }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `ROLE_VIEW` |

- **Efeitos:** — (RN-IAM-74: sem evento de domínio; catálogo semeado no provisionamento — US-099 — gera apenas auditoria `role.create` com `actorType=SYSTEM`)
- **Notas:** Catálogo estável, versionado por `introducedIn`.

### ROL-02 — Listar perfis
`GET /api/v1/roles` · **Permissão:** `ROLE_VIEW` · **Story:** US-095
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** query `search` (string, Não), `isActive` (boolean, Não); ordenação: a definir na implementação
- **Request:** —
- **Response:** `200 { data: Role[] }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `ROLE_VIEW` |

- **Efeitos:** —
- **Notas:** —

### ROL-03 — Criar perfil
`POST /api/v1/roles` · **Permissão:** `ROLE_MANAGE` (+ POL-13) · **Story:** US-095
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** —
- **Request:** `{ name: string; description?: string; allowExternalAssignment?: boolean; permissions?: string[] }` — `name` 3–120, único no tenant (case-insensitive); `description` ≤500; `permissions`: códigos existentes no catálogo (`ROL-01`)
- **Response:** `201 { data: Role }` com `Location`, `ETag: "1"`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PRIVILEGE_ESCALATION_FORBIDDEN` | Permissão concedida que o próprio ator não possui (POL-13) |
| 403 | `MFA_REQUIRED` | `allowExternalAssignment=true` + permissão `HIGH` sem MFA (POL-14) |
| 409 | `ROLE_ALREADY_EXISTS` | `name`/`key` duplicados no tenant |
| 422 | `VALIDATION_ERROR` | Nome fora do tamanho; `REFERENCE_NOT_FOUND` em `permissions[]` |

- **Efeitos:** Evento `RoleCreated` (`role.created`, `permissionsAdded[]`); auditoria `role.create` (`SECURITY`); consumidor `PermissionCacheInvalidator` (routing `role.*`).
- **Notas:** POL-13 (anti-escalonamento), POL-14 (MFA para atribuição externa de risco).

### ROL-04 — Consultar perfil
`GET /api/v1/roles/{id}` · **Permissão:** `ROLE_VIEW` · **Story:** US-095
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` — (GET retorna `ETag`)
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** —
- **Response:** `200 { data: Role & { permissions: string[] } }` com `ETag`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `ROLE_VIEW` |
| 404 | `ROLE_NOT_FOUND` | Inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** —

### ROL-05 — Atualizar perfil
`PATCH /api/v1/roles/{id}` · **Permissão:** `ROLE_MANAGE` · **Story:** US-095
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{ name?: string; description?: string; allowExternalAssignment?: boolean }` — mesmas regras de `ROL-03`
- **Response:** `200 { data: Role }` com `ETag`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `ROLE_MANAGE` |
| 404 | `ROLE_NOT_FOUND` | Inexistente/outro tenant |
| 409 | `ROLE_ALREADY_EXISTS` | Novo nome duplicado |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | Nome fora do tamanho |

- **Efeitos:** Evento `RoleUpdated` (`role.updated`); auditoria `role.update` (`SECURITY`, `changes`: campos alterados); invalida cache via `PermissionCacheInvalidator`.
- **Notas:** —

### ROL-06 — Atualizar permissões do perfil
`PUT /api/v1/roles/{id}/permissions` · **Permissão:** `ROLE_MANAGE` (+ POL-13) · **Story:** US-095
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{ permissions: string[] }` — códigos existentes no catálogo
- **Response:** `200 { data: Role & { permissions: string[] } }` com `ETag`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PRIVILEGE_ESCALATION_FORBIDDEN` | Concessão de permissão que o ator não possui (POL-13) |
| 404 | `ROLE_NOT_FOUND` | Inexistente/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | `REFERENCE_NOT_FOUND`; `BUSINESS_RULE_VIOLATION` ao remover permissão protegida de `ADMIN_ORGAO` (DEC-035) |

- **Efeitos:** Evento `RoleUpdated` (`role.updated`, `permissionsAdded[]`/`permissionsRemoved[]`); auditoria `role.permissions_update` (`SECURITY`); invalida cache via `PermissionCacheInvalidator`.
- **Notas:** POL-13; DEC-035 (permissões protegidas do Administrador do órgão).

### ROL-07 — Duplicar perfil
`POST /api/v1/roles/{id}/duplicate` · **Permissão:** `ROLE_MANAGE` · **Story:** US-095
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{}`
- **Response:** `201 { data: Role }` com `Location`, `ETag: "1"`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `ROLE_MANAGE` |
| 404 | `ROLE_NOT_FOUND` | Perfil de origem inexistente |
| 422 | `VALIDATION_ERROR` | Nome gerado para a cópia inválido/duplicado |

- **Efeitos:** Evento `RoleCreated` (`role.created`); auditoria `role.create` (`SECURITY`).
- **Notas:** Cópia nasce com `isSystem=false`.

### ROL-08 — Desativar perfil
`POST /api/v1/roles/{id}/deactivate` · **Permissão:** `ROLE_MANAGE` (+ POL-12) · **Story:** US-095
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{ confirmDeactivate?: boolean }`
- **Response:** `200 { data: Role }` com `ETag`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `ROLE_MANAGE` |
| 404 | `ROLE_NOT_FOUND` | Inexistente/outro tenant |
| 409 | `LAST_ADMIN_REQUIRED` | Desativar `ADMIN_ORGAO` (POL-12) |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Evento `RoleUpdated` (`role.updated`); auditoria `role.deactivate` (`SECURITY`, `metadata.activeAssignmentsAffected`); invalida cache.
- **Notas:** POL-12.

### ROL-09 — Listar atribuições de um perfil
`GET /api/v1/roles/{id}/assignments` · **Permissão:** `ROLE_VIEW` · **Story:** US-096
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** —
- **Response:** `200 { data: RoleAssignment[] }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `ROLE_VIEW` |
| 404 | `ROLE_NOT_FOUND` | Inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** —

### ROL-10 — Listar atribuições de um usuário
`GET /api/v1/users/{userId}/role-assignments` · **Permissão:** `USER_VIEW` ou `ROLE_VIEW` · **Story:** US-096
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `userId` (uuid, Sim)
- **Request:** —
- **Response:** `200 { data: RoleAssignment[], meta: { canAssign: boolean, isSelf: boolean } }` — atribuições não revogadas (vigentes, futuras e vencidas), inclusive a do convite; `canAssign` = o ator tem `ROLE_ASSIGN`; `isSelf` = o vínculo é o do ator (POL-16 na tela)
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `USER_VIEW`/`ROLE_VIEW` |
| 404 | `USER_NOT_FOUND` | Inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** —

### ROL-11 — Atribuir perfil a um vínculo
`POST /api/v1/users/{userId}/role-assignments` · **Permissão:** `ROLE_ASSIGN` (+ POL-13/POL-15) · **Story:** US-096
- **Cabeçalhos:** `Idempotency-Key` obrigatório; `If-Match` —
- **Parâmetros:** path `userId` (uuid, Sim)
- **Request:**
```ts
{ roleId: string; scopeType: "TENANT" | "ORGANIZATION" | "DEPARTMENT" | "OWN_DEPARTMENTS";
  scopeOrganizationId?: string; scopeDepartmentId?: string; includeSubtree?: boolean;
  validFrom?: string; validUntil?: string }
```
  `roleId`: perfil ativo do tenant; `scopeOrganizationId` obrigatório se `ORGANIZATION`; `scopeDepartmentId` obrigatório se `DEPARTMENT`; `includeSubtree` padrão `true` em `DEPARTMENT`/`OWN_DEPARTMENTS`; `validFrom` padrão agora; `validUntil` > `validFrom` e não pode superar a validade do vínculo externo
- **Response:** `201 { data: RoleAssignment }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PRIVILEGE_ESCALATION_FORBIDDEN` | Perfil com permissões que o ator não possui (POL-13) |
| 403 | `MFA_REQUIRED` | MFA não satisfeito (POL-14) |
| 403 | `MEMBERSHIP_INACTIVE` | Vínculo de destino fora de `ACTIVE` ou vencido (RN-IAM-90) |
| 404 | `USER_NOT_FOUND` | Vínculo inexistente/outro tenant |
| 409 | `ROLE_ASSIGNMENT_ALREADY_EXISTS` | Atribuição ativa do mesmo perfil no mesmo escopo |
| 422 | `EXTERNAL_HIGH_RISK_ROLE` | Perfil de risco para vínculo `EXTERNAL` (POL-15) |
| 422 | `VALIDATION_ERROR` | `REQUIRED`/`CONDITIONAL_REQUIRED`/`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`/`OUT_OF_RANGE` |

- **Efeitos:** Evento `RoleAssigned` (`role.assigned`); auditoria `role.assign` (`ACCESS`).
- **Notas:** POL-13, POL-14, POL-15.

### ROL-12 — Revogar atribuição de perfil
`POST /api/v1/role-assignments/{id}/revoke` · **Permissão:** `ROLE_ASSIGN` (+ POL-12/POL-16) · **Story:** US-096
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{ reason?: string }` — `reason` ≤500
- **Response:** `200 { data: RoleAssignment }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Autoproteção: remover o próprio último perfil administrativo (POL-16) |
| 404 | `ROLE_ASSIGNMENT_NOT_FOUND` | Inexistente/outro tenant (padrão `<RESOURCE>_NOT_FOUND`, api.md §2.1) |
| 409 | `LAST_ADMIN_REQUIRED` | Revogar último `ADMIN_ORGAO` (POL-12) |
| 409 | `INVALID_STATE` | Atribuição já revogada |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Evento `RoleRevoked` (`role.revoked`); auditoria `role.revoke` (`ACCESS`, `metadata.hasReason`).
- **Notas:** POL-12, POL-16.

### ORG-01 — Listar órgãos
`GET /api/v1/organizations` · **Permissão:** implícita (vínculo ativo no tenant) · **Story:** US-101
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** query `isActive` (boolean, Não), `q` (string, Não, busca textual mín. 2 caracteres); paginação padrão (api.md §1.2); ordenação: a definir na implementação
- **Request:** —
- **Response:** `200 { data: Organization[], meta }` — ordenada por nome; `Organization` traz `isPrimary` (= `tenants.primaryOrganizationId`)
- **Erros:** —
- **Efeitos:** —
- **Notas:** `q` busca em nome, sigla e CNPJ (com ou sem máscara).

### ORG-02 — Criar órgão
`POST /api/v1/organizations` · **Permissão:** `ORGANIZATION_MANAGE` · **Story:** US-101
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** —
- **Request:**
```ts
{ name: string; shortName: string; cnpj: string; type: OrganizationType;
  email?: string; phone?: string; website?: string;
  addressStreet?: string; addressNumber?: string; addressComplement?: string;
  addressDistrict?: string; addressCity?: string; addressState?: string; addressZipCode?: string;
  ibgeCityCode?: string }
```
  `name` 3–250 (trim); `shortName` 2–30, `[A-Z0-9-]`, único no tenant; `cnpj` 14 dígitos com DV válido, único no tenant; `website` exige `https://`; `addressState` 2 letras; `addressZipCode` 8 dígitos; `ibgeCityCode` 7 dígitos
- **Response:** `201 { data: Organization }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `ORGANIZATION_MANAGE` |
| 422 | `VALIDATION_ERROR` | `REQUIRED`/`INVALID_FORMAT` (`shortName`, `website`)/`INVALID_CNPJ` |

- **Efeitos:** Evento `OrganizationCreated` (`organization.created`); auditoria `organization.create` (`DATA_CHANGE`, `changes`: campos não sensíveis).
- **Notas:** RN-TEN-41/42/43. `shortName` é gravado em maiúsculas e `cnpj` sem máscara; sigla ou CNPJ repetidos no tenant → `422 VALIDATION_ERROR` (`INVALID_FORMAT` em `shortName` / `INVALID_CNPJ` em `cnpj`); `metadata`, `isActive` e `logoAttachmentId` enviados na criação são descartados.

### ORG-03 — Consultar órgão
`GET /api/v1/organizations/{id}` · **Permissão:** implícita · **Story:** US-101
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** —
- **Response:** `200 { data: Organization }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 404 | `NOT_FOUND` | Inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** —

### ORG-04 — Atualizar órgão
`PATCH /api/v1/organizations/{id}` · **Permissão:** `ORGANIZATION_MANAGE` · **Story:** US-101
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** Campos de `ORG-02` (todos opcionais) + `isActive?: boolean` + `logoAttachmentId?: string`
- **Response:** `200 { data: Organization }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `ORGANIZATION_MANAGE` |
| 403 | `MFA_REQUIRED` | Ação exige MFA (POL-14) |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 409 | `PRIMARY_ORGANIZATION_REQUIRED` | Inativar o órgão principal ou o único órgão ativo do tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | Mesmos códigos de `ORG-02`; `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` em `logoAttachmentId` |

- **Efeitos:** Evento `OrganizationUpdated` (`organization.updated`, `changedFields[]`); auditoria `organization.update` (`DATA_CHANGE`, valores anterior/novo).
- **Notas:** RN-TEN-41 — `PRIMARY_ORGANIZATION_REQUIRED` protege o órgão principal e o último órgão ativo do tenant. `412 VERSION_CONFLICT` traz `currentVersion` (versão atual do órgão). Campo opcional é limpo com `null`; corpo sem mudança → `200` sem nova versão, auditoria nem evento.

### DEP-01 — Listar secretarias/setores
`GET /api/v1/departments` · **Permissão:** implícita · **Story:** US-102
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** query `organizationId` (uuid, Não), `isActive` (boolean, Não), `q` (string, Não, mín. 2 caracteres — nome, sigla ou código); paginação padrão (api.md §1.2)
- **Request:** —
- **Response:** `200 { data: Department[], meta }` — sempre **lista plana na ordem da árvore** (pais antes dos filhos; irmãos por `sortOrder`, nome e id), paginada depois da ordenação; o cliente monta a árvore com `parentId`/`path`/`depth`. `Department` traz também `isSecretariat` (RN-TEN-49)
- **Erros:** —
- **Efeitos:** —
- **Notas:** Decisão da US-102: um único formato (sem parâmetro de árvore). Unidade cujo pai ficou fora do filtro entra como raiz local.

### DEP-02 — Buscar unidades para seleção (lookup)
`GET /api/v1/departments/lookup` · **Permissão:** implícita · **Story:** US-102
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** query `organizationId` (uuid, Não), `q` (string, Não)
- **Request:** —
- **Response:** `200 { data: { id: string, name: string, type: DepartmentType, path: string }[] }`
- **Erros:** —
- **Efeitos:** —
- **Notas:** Só unidades **ativas** (RN-TEN-50), por nome, no máximo 50.

### DEP-03 — Criar unidade
`POST /api/v1/departments` · **Permissão:** `DEPARTMENT_MANAGE` · **Story:** US-102
- **Cabeçalhos:** `Idempotency-Key` opcional (assistente de implantação — US-099 FA-09); `If-Match` —
- **Parâmetros:** —
- **Request:**
```ts
{ organizationId: string; parentId?: string; type: DepartmentType; name: string;
  acronym?: string; code?: string; email?: string; phone?: string;
  headUserId?: string; deputyUserId?: string }
```
  `organizationId`: órgão ativo; `parentId`: dentro do mesmo órgão (RN-TEN-44/46); `name` 3–200, único entre irmãos; `acronym` ≤30, único no órgão; `code` ≤40; `headUserId`/`deputyUserId`: pessoa com lotação/escopo na unidade (RN-TEN-48), diferentes entre si
- **Response:** `201 { data: Department }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `DEPARTMENT_MANAGE` |
| 422 | `VALIDATION_ERROR` | `REQUIRED`/`REFERENCE_NOT_FOUND` (`parentId`, `headUserId`, `deputyUserId`)/`INVALID_FORMAT` (nome ou sigla duplicados) |

- **Efeitos:** Evento `DepartmentCreated` (`department.created`); auditoria `department.create` (`DATA_CHANGE`, campos iniciais).
- **Notas:** RN-TEN-44/46/48. `acronym` é gravada em maiúsculas; órgão inexistente/inativo → `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` em `organizationId`; unidade superior inativa → `REFERENCE_INACTIVE` em `parentId`; titular = substituto → `NOT_ALLOWED` em `deputyUserId`; titular/substituto com vínculo não ativo → `REFERENCE_INACTIVE`.

### DEP-04 — Consultar unidade
`GET /api/v1/departments/{id}` · **Permissão:** implícita · **Story:** US-102
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** —
- **Response:** `200 { data: Department }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 404 | `NOT_FOUND` | Inexistente/outro tenant |

- **Efeitos:** —
- **Notas:** —

### DEP-05 — Atualizar unidade
`PATCH /api/v1/departments/{id}` · **Permissão:** `DEPARTMENT_MANAGE` · **Story:** US-102
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** Campos de `DEP-03`, todos opcionais (+ `sortOrder`); `null` limpa um opcional. `organizationId`/`parentId` só iguais aos atuais (diferentes → `422 NOT_ALLOWED`: órgão não muda e a unidade superior muda pelo `DEP-06`)
- **Response:** `200 { data: Department }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `DEPARTMENT_MANAGE` |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | Mesmos códigos de `DEP-03` |

- **Efeitos:** Evento `DepartmentUpdated` (`department.updated`, `changedFields[]`); auditoria `department.update` (`DATA_CHANGE`, anterior/novo).
- **Notas:** —

### DEP-06 — Mover unidade na hierarquia
`POST /api/v1/departments/{id}/move` · **Permissão:** `DEPARTMENT_MANAGE` · **Story:** US-102
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{ parentId?: string }` — vazio = raiz
- **Response:** `200 { data: Department }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `DEPARTMENT_MANAGE` |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `DEPARTMENT_CYCLE` | Movimentação criaria ciclo |
| 422 | `VALIDATION_ERROR` | `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` em `parentId` (outro órgão/tenant ou inativa); `INVALID_FORMAT` em `name` (nome já usado no destino) |

- **Efeitos:** Evento `DepartmentMoved` (`department.moved`, `fromParentId?`, `toParentId?`); auditoria `department.move` (`DATA_CHANGE`, `fromParentId`, `toParentId`, qtde. de descendentes recalculados); consumidor `PermissionCacheInvalidator` invalida escopos `DEPARTMENT`/`OWN_DEPARTMENTS`.
- **Notas:** Recalcula `path`/`depth` dos descendentes (RN-TEN-45).

### DEP-07 — Desativar unidade
`POST /api/v1/departments/{id}/deactivate` · **Permissão:** `DEPARTMENT_MANAGE` · **Story:** US-102
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{}`
- **Response:** `200 { data: Department }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `DEPARTMENT_MANAGE` |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Evento `DepartmentDeactivated` (`department.deactivated`); auditoria `department.deactivate` (`DATA_CHANGE`).
- **Notas:** RN-TEN-50.

### DEP-08 — Ativar unidade
`POST /api/v1/departments/{id}/activate` · **Permissão:** `DEPARTMENT_MANAGE` · **Story:** US-102
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{}`
- **Response:** `200 { data: Department }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `DEPARTMENT_MANAGE` |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | `REFERENCE_INACTIVE` — órgão da unidade está inativo |

- **Efeitos:** Evento `DepartmentUpdated` (`department.updated`); auditoria `department.update` (`DATA_CHANGE`).
- **Notas:** —

### DEP-09 — Excluir unidade
`DELETE /api/v1/departments/{id}` · **Permissão:** `DEPARTMENT_MANAGE` (sem referências) · **Story:** US-102
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** —
- **Response:** `204`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `DEPARTMENT_MANAGE` |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 409 | `DEPARTMENT_HAS_REFERENCES` | Unidade referenciada (oferecer "Desativar") |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Auditoria `department.delete` (`DATA_CHANGE`, `metadata`: dados da unidade removida). Sem evento de domínio listado na story.
- **Notas:** Exclusão física só é permitida sem referências; caso contrário, usar `DEP-07`. O 409 traz `references[]` (`SUBUNITS`, `ASSIGNMENTS`, `WORKFLOW_STAGES`, `OTHER`).

### SET-01 — Consultar configurações do tenant
`GET /api/v1/settings` · **Permissão:** `SETTINGS_MANAGE` · **Story:** US-103
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** —
- **Request:** —
- **Response:** `200 { data: { [chave: string]: { value: unknown, version: number } }, meta: { aiTerms: { currentVersion: string, provider: string, maxMonthlyTokens: number } } }` — todas as chaves do registro (catálogo completo de chaves/tipos/limites: `entities.md` §6); `meta.aiTerms` alimenta o diálogo de aceite dos termos de uso da IA e a faixa do limite mensal (`maxMonthlyTokens` = `AI_TENANT_MAX_MONTHLY_TOKENS`) (US-116, DEC-079)
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `SETTINGS_MANAGE` |

- **Efeitos:** —
- **Notas:** Grupos exibidos por prefixo de chave: `labels.*`, `branding.*`, `numbering.*`, `process.*`, `access.*`, `approval.*`, `security.*`, `deadlines.*`, `calendar.*`, `priceResearch.*`, `risk.*`, `uploads.*`, `notifications.*`, `features.*`, `ai.*` (US-116). Chave sem linha persistida (RN-TEN-57) vem com o valor padrão e `version: 0`; `features.<flag>` só aparece quando gravada. A resposta traz `Cache-Control: private, max-age=0, must-revalidate` e `ETag` fraco do conteúdo. A leitura exige `SETTINGS_MANAGE` e, com `security.mfaPolicy` ≠ `NONE`, MFA na sessão (POL-14: permissão de risco `H`) — `403 MFA_REQUIRED`.

### SET-02 — Atualizar configurações do tenant
`PATCH /api/v1/settings` · **Permissão:** `SETTINGS_MANAGE` · **Story:** US-103, US-105
- **Cabeçalhos:** `Idempotency-Key` opcional (reenvio com a mesma chave devolve a mesma resposta com `Idempotent-Replayed: true` — US-105); `If-Match` — (concorrência via `expectedVersions` por chave no corpo, não pelo cabeçalho `If-Match`)
- **Parâmetros:** —
- **Request:** `{ values: { [chave: string]: unknown }, expectedVersions: { [chave: string]: number } }` — cada chave validada pelo schema Zod específico (`entities.md` §6); `expectedVersions` obrigatório para toda chave presente em `values` (RN-TEN-54); máscara de numeração deve conter `{seq:N}` e `{year}` (e `{org}` se escopo `ORGANIZATION`)
- **Response:** `200 { data: { [chave: string]: { value: unknown, version: number } } }` — somente as chaves alteradas
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `SETTINGS_MANAGE` |
| 403 | `MFA_REQUIRED` | Ação exige MFA (POL-14) |
| 412 | `VERSION_CONFLICT` | `expectedVersions[chave]` divergente do atual |
| 422 | `SETTING_KEY_UNKNOWN` | Chave fora do registro |
| 422 | `VALIDATION_ERROR` | Valor fora do schema da chave |
| 422 | `AI_TERMS_NOT_ACCEPTED` | `ai.enabled` passa a `true` sem `ai.termsAcceptedVersion` igual à versão vigente (`AI_TERMS_VERSION`) no lote ou já gravada, ou o lote aceita versão que não é a vigente (US-116 · RN-AI-16) |
| 422 | `NUMBERING_MASK_INVALID` | Máscara sem `{seq:N}`/`{year}`, token desconhecido (inclui `{seq}` sem `N`, `N` fora de 1–6 e `{type}` na máscara do processo), ou escopo `ORGANIZATION` sem `{org}` |
| 428 | `PRECONDITION_REQUIRED` | `expectedVersions` ausente para chave alterada (incluído apesar de fora do conjunto padrão da seção, por ser mecanismo específico — versão por chave, não `If-Match`) |

- **Efeitos:** Evento `TenantSettingsChanged` (`tenant.settings_changed`, `keys[]`); auditoria `settings.update` (`CONFIGURATION`, uma entrada por chave alterada). Consumidores: `FeatureFlagService`, `NumberingFacade`, `BusinessCalendarFacade` (invalidam cache por chave).
- **Notas:** RN-TEN-52/53/54; US-090 consome `security.mfaPolicy`; US-105 consome `numbering.*`. Tudo ou nada, nesta ordem de conferência: chave desconhecida (422 `SETTING_KEY_UNKNOWN`) → valor inválido (422 `VALIDATION_ERROR`, `errors[].field = "values.<chave>"`, ou `NUMBERING_MASK_INVALID` quando só há violação de máscara) → versão ausente (428) → versão divergente (412). O 412 traz `conflicts[] { key, currentVersion }` e, com uma única chave em conflito, `currentVersion`. Chave sem linha usa `expectedVersions[chave] = 0` e a primeira gravação cria a versão 1. Valor igual ao atual não grava, não audita nem versiona; lote sem nenhuma mudança → `200 { data: {} }` sem evento. Com `numbering.process.scope = ORGANIZATION`, a máscara efetiva (a do lote ou a gravada) precisa de `{org}`. `branding.logoAttachmentId` não nulo só é aceito com anexo `AVAILABLE` do tenant (`REFERENCE_NOT_FOUND` até a US-068).

### SET-03 — Consultar configurações públicas
`GET /api/v1/settings/public` · **Permissão:** implícita (acessível sem vínculo ativo) · **Story:** US-103
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** —
- **Request:** —
- **Response:** `200 { data: { [chave: string]: unknown } }` — somente chaves públicas
- **Erros:** — (sem código de domínio específico nesta story; ver api.md §2 para o 401 de sessão ausente, quando aplicável)
- **Efeitos:** —
- **Notas:** Usado para branding/identidade (`labels.*`, `branding.*`) por qualquer vínculo ativo: a rota é do tenant da requisição (`X-Tenant-Id` + vínculo ativo, sem `SETTINGS_MANAGE`); antes do login não há tenant no contexto. Mesmos cabeçalhos de cache do `SET-01`.

### SET-04 — Pré-visualizar máscara de numeração
`POST /api/v1/numbering/preview` · **Permissão:** `SETTINGS_MANAGE` · **Story:** US-105
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** —
- **Request:** `{ mask: string; scope?: "TENANT" | "ORGANIZATION"; documentTypeCode?: string }` — sem `documentTypeCode`, máscara do processo (`scope` omitido = o gravado); com ele (código do tipo, ex.: `DFD`), máscara de documento daquele tipo (`{type}` permitido)
- **Response:** `200 { data: { example: string, nextValue: string } }` — `nextValue` é o próximo valor hipotético da sequência corrente (`lastValue + 1`, em texto)
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `SETTINGS_MANAGE` |
| 422 | `NUMBERING_MASK_INVALID` | Máscara sem `{seq:N}`/`{year}`, token desconhecido, ou `ORGANIZATION` sem `{org}` |
| 422 | `VALIDATION_ERROR` | Corpo fora do contrato (`scope` fora do enum, `documentTypeCode` fora do padrão do código, campo extra) |

- **Efeitos:** —
- **Notas:** Não persiste nem incrementa (RN-TEN-73): leitura simples, em transação somente leitura, que não disputa o bloqueio da sequência real. Calcula sobre a máscara do corpo, nunca a gravada (FA-04). Sequência: `PROCESS:<org|*>:<ano>` (o órgão é o principal do tenant) ou `DOCUMENT:<TYPE>:*:<ano>`; ano no fuso do tenant. `{org}` usa a sigla do órgão principal. Sem auditoria (`x-audit-exempt`).

### CAT-01 — Listar itens de um catálogo
`GET /api/v1/catalogs/{catalogType}/items` · **Permissão:** implícita · **Story:** US-104
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `catalogType` (enum `CatalogType`, Sim); query `isActive` (boolean, Não), `q` (string, Não); paginação padrão (api.md §1.2; `pageSize` padrão 100, pois o catálogo tem dezenas de itens); ordenação: `sortOrder`, depois `code`
- **Request:** —
- **Response:** `200 { data: CatalogItem[], meta }`
- **Erros:** —
- **Efeitos:** —
- **Notas:** —

### CAT-02 — Criar item de catálogo
`POST /api/v1/catalogs/{catalogType}/items` · **Permissão:** `CATALOG_MANAGE` · **Story:** US-104
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** path `catalogType` (enum `CatalogType`, Sim)
- **Request:** `{ code: string; label: string; description?: string; parentId?: string; metadata?: object }` — `code` `SCREAMING_SNAKE_CASE`, único no catálogo, imutável; `label` 1–150; `description` ≤1.000; `parentId` no mesmo `catalogType`; `metadata` conforme schema do tipo (`entities.md` §5.9)
- **Response:** `201 { data: CatalogItem }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `CATALOG_MANAGE` |
| 422 | `VALIDATION_ERROR` | `REQUIRED`/`INVALID_FORMAT` (`code` duplicado/fora do padrão)/`REFERENCE_NOT_FOUND` (`parentId`)/schema de `metadata` |

- **Efeitos:** Evento `CatalogItemChanged` (`catalog.item_changed`, `change=CREATED`); auditoria `catalog.create` (`CONFIGURATION`, `code`/`label`/`metadata`).
- **Notas:** RN-TEN-60/62/63. O item novo entra no fim da lista (`sortOrder = max + 1`); `parentId` precisa ser de outro item do mesmo catálogo e tenant (inexistente, de outro tenant ou de outro catálogo → `REFERENCE_NOT_FOUND`, sem revelar o item). `metadata` omitida vale `{}` e é validada pelo schema do `catalogType` da rota (`errors[].field = "metadata.<chave>"`; chave fora do schema → `NOT_ALLOWED`). Resposta com `Location` e `ETag` (versão 1).

### CAT-03 — Atualizar item de catálogo
`PATCH /api/v1/catalog-items/{id}` · **Permissão:** `CATALOG_MANAGE` · **Story:** US-104
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{ label?: string; description?: string; parentId?: string; sortOrder?: number; metadata?: object }` — `code` não é editável
- **Response:** `200 { data: CatalogItem }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `CATALOG_MANAGE` |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 409 | `CATALOG_ITEM_SYSTEM` | Tentativa de alterar `code` de item semeado (`isSystem`) |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | Schema de `metadata`; `REFERENCE_NOT_FOUND` (`parentId`) |

- **Efeitos:** Evento `CatalogItemChanged` (`catalog.item_changed`, `change=UPDATED`); auditoria `catalog.update` (`CONFIGURATION`, campos alterados).
- **Notas:** No MVP 1 não há exclusão física de itens de catálogo — apenas `CAT-04`/`CAT-05`. `code` só é aceito no corpo para ser recusado: item de sistema → 409 `CATALOG_ITEM_SYSTEM`; item comum → 422 `VALIDATION_ERROR` (`NOT_ALLOWED` em `code`, RN-TEN-59). `metadata` substitui o objeto inteiro. Nada alterado → 200 sem nova versão, auditoria nem evento. O 412 traz `currentVersion`.

### CAT-04 — Ativar item de catálogo
`POST /api/v1/catalog-items/{id}/activate` · **Permissão:** `CATALOG_MANAGE` · **Story:** US-104
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{}`
- **Response:** `200 { data: CatalogItem }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `CATALOG_MANAGE` |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Evento `CatalogItemChanged` (`catalog.item_changed`, `change=ACTIVATED`); auditoria `catalog.update` (`CONFIGURATION`, reativação).
- **Notas:** —

### CAT-05 — Desativar item de catálogo
`POST /api/v1/catalog-items/{id}/deactivate` · **Permissão:** `CATALOG_MANAGE` · **Story:** US-104
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{}`
- **Response:** `200 { data: CatalogItem }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `CATALOG_MANAGE` |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Evento `CatalogItemChanged` (`catalog.item_changed`, `change=DEACTIVATED`); auditoria `catalog.deactivate` (`CONFIGURATION`, `metadata.catalogItemId`).
- **Notas:** Itens semeados (`isSystem`) não podem ser excluídos fisicamente — apenas ativar/desativar; ver `CATALOG_ITEM_SYSTEM` em `CAT-03`.

### CAT-06 — Reordenar itens de catálogo
`PUT /api/v1/catalogs/{catalogType}/order` · **Permissão:** `CATALOG_MANAGE` · **Story:** US-104
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` — (operação afeta múltiplos recursos de uma vez; não versionada por item)
- **Parâmetros:** path `catalogType` (enum `CatalogType`, Sim)
- **Request:** `{ orderedIds: string[] }` — uuids dos itens do catálogo, sem repetição
- **Response:** `200 { data: CatalogItem[] }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `CATALOG_MANAGE` |
| 422 | `VALIDATION_ERROR` | `DUPLICATE_IN_LIST`/`REFERENCE_NOT_FOUND` (id fora do catálogo ou de outro tenant)/`CONDITIONAL_REQUIRED` (lista incompleta) em `orderedIds` |

- **Efeitos:** Evento `CatalogItemChanged` (`catalog.item_changed`, `change=UPDATED`, um por item cuja posição mudou); auditoria `catalog.update` (`CONFIGURATION`, uma única entrada com `changes` por item movido: `sortOrder.<code>` anterior e novo).
- **Notas:** A lista deve conter TODOS os itens do catálogo (ativos e inativos); `sortOrder` é recalculado de 1 a n. As linhas do catálogo são travadas (`FOR UPDATE`) durante a operação: reordenações concorrentes serializam e a ordem final é a da última a confirmar. Ordem idêntica à atual → 200 sem efeitos.

### CAL-01 — Listar feriados
`GET /api/v1/holidays` · **Permissão:** implícita · **Story:** US-106
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** query `year` (int 1900–2200, Não; padrão: o ano corrente no fuso do tenant); paginação padrão (api.md §1.2; `pageSize` padrão 100, máximo 200)
- **Request:** —
- **Response:** `200 { data: Holiday[], meta }`
- **Erros:** —
- **Efeitos:** —
- **Notas:** Feriados do ano (ativos e inativos) por data e nome; `year` inválido → 422 `VALIDATION_ERROR` em `year`.

### CAL-02 — Criar feriado
`POST /api/v1/holidays` · **Permissão:** `CALENDAR_MANAGE` · **Story:** US-106
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** —
- **Request:** `{ date: string; name: string; scope: HolidayScope; isRecurring?: boolean }` — `date` `YYYY-MM-DD`; `name` 1–120; `(date, name)` único no tenant
- **Response:** `201 { data: Holiday }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `CALENDAR_MANAGE` |
| 409 | `CONFLICT` | `(date, name)` já existe |
| 422 | `VALIDATION_ERROR` | `REQUIRED`/`INVALID_FORMAT` (data) |

- **Efeitos:** Evento `HolidayChanged` (`catalog.holiday_changed`, `change=CREATED`); auditoria `holiday.create` (`CONFIGURATION`, `date`/`name`/`scope`).
- **Notas:** RN-TEN-76. `scope` aceita `STATE`, `MUNICIPAL` ou `OPTIONAL` (`NATIONAL` só nasce do seed — 422 em `scope`); `isSystem` e `isActive` do cliente são descartados (novo feriado: `isSystem = false`, ativo). Data ausente → `REQUIRED`; formato ou data inexistente → `INVALID_FORMAT`. Cadastro retroativo é permitido e nunca recalcula `dueAt` (RN-TEN-79). O nome é comparado sem diferenciar maiúsculas; duas criações simultâneas do mesmo feriado: uma 201, a outra 409 `CONFLICT`. Resposta com `Location` e `ETag`.

### CAL-03 — Atualizar feriado
`PATCH /api/v1/holidays/{id}` · **Permissão:** `CALENDAR_MANAGE` · **Story:** US-106
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** `{ name?: string; scope?: HolidayScope; isRecurring?: boolean; isActive?: boolean }`
- **Response:** `200 { data: Holiday }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `CALENDAR_MANAGE` |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 409 | `CATALOG_ITEM_SYSTEM` | Alterar o nome de feriado de sistema (`isSystem`) |
| 409 | `CONFLICT` | O novo nome repete `(date, name)` de outro feriado |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |
| 422 | `VALIDATION_ERROR` | `REQUIRED`/`INVALID_FORMAT`; `NOT_ALLOWED` em `scope` (`NATIONAL` num feriado que não é de sistema) |

- **Efeitos:** Evento `HolidayChanged` (`catalog.holiday_changed`, `change=UPDATED`); auditoria `holiday.update` (`CONFIGURATION`, campos alterados).
- **Notas:** Feriados de sistema podem ser desativados (`isActive:false`) e ter `scope`/`isRecurring` ajustados, mas não renomeados nem excluídos — ver `CAL-04`. A data não é editável (excluir e recadastrar). Nada alterado → 200 sem nova versão, auditoria nem evento. O 412 traz `currentVersion`. Nunca recalcula `dueAt` já gravados (RN-TEN-79).

### CAL-04 — Excluir feriado
`DELETE /api/v1/holidays/{id}` · **Permissão:** `CALENDAR_MANAGE` · **Story:** US-106
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` obrigatório
- **Parâmetros:** path `id` (uuid, Sim)
- **Request:** —
- **Response:** `204`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `CALENDAR_MANAGE` |
| 404 | `NOT_FOUND` | Inexistente/outro tenant |
| 409 | `CATALOG_ITEM_SYSTEM` | Feriado semeado (`isSystem`) — não pode ser excluído |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Evento `HolidayChanged` (`catalog.holiday_changed`, `change=DELETED`); auditoria `holiday.delete` (`CONFIGURATION`, `metadata`: `holidayId`, `date`).
- **Notas:** `If-Match` desatualizado → 412 (`currentVersion`). Exclusão física permitida apenas para feriados não semeados; feriados de sistema só podem ser desativados (`CAL-03`) — coerente com `CATALOG_ITEM_SYSTEM` em itens de catálogo.

### CAL-05 — Consultar dias úteis em um intervalo
`GET /api/v1/calendar/business-days` · **Permissão:** implícita · **Story:** US-106
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** query `from` (data `YYYY-MM-DD`, Sim), `to` (data `YYYY-MM-DD`, Sim; `from` ≤ `to`, no máximo 1.100 dias)
- **Request:** —
- **Response:** `200 { data: { businessDays: number, dates: string[] } }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Datas inválidas (`REQUIRED`/`INVALID_FORMAT`); intervalo invertido ou acima de 1.100 dias (`OUT_OF_RANGE` em `to`) |

- **Efeitos:** —
- **Notas:** `dates` traz os dias úteis do intervalo (inclusive as pontas) em ordem; `OPTIONAL` só conta como não útil com `calendar.optionalHolidaysAreNonBusiness = true`; só feriados ativos do próprio tenant entram (RN-TEN-74).

### CAL-06 — Somar dias úteis a uma data/hora
`POST /api/v1/calendar/add-business-days` · **Permissão:** implícita (uso interno e por UI) · **Story:** US-106, US-055
- **Cabeçalhos:** `Idempotency-Key` —; `If-Match` —
- **Parâmetros:** —
- **Request:** `{ fromDateTime: string; businessDays: number; dayCountType?: 'BUSINESS' | 'CALENDAR' }` — `fromDateTime` ISO 8601 em UTC (`Z`); `businessDays` inteiro de 0 a 1.000; `dayCountType` padrão `BUSINESS`
- **Response:** `200 { data: { dueDateTime: string } }`
- **Erros:**

| HTTP | code | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` (`OUT_OF_RANGE`) | `businessDays` fora do intervalo (0–1.000) |

- **Efeitos:** —
- **Notas:** Usado tanto internamente (cálculo de `dueAt` no encaminhamento de etapas — RN-TRAM-78/82/83) quanto pela UI para pré-visualizar o novo prazo antes de confirmar uma sobrescrita (US-055); `dueAt` é sempre o fim do dia no fuso horário do tenant. O dia é o dia LOCAL de `fromDateTime` no fuso do tenant (DEC-003); o dia de partida não conta (`businessDays = 0` → fim do próprio dia); `CALENDAR` soma dias corridos sem olhar feriados. Leitura sem efeito colateral: repetir a chamada devolve o mesmo prazo. Indisponibilidade crítica no cálculo retorna `503 DEPENDENCY_UNAVAILABLE` (fora da tabela de erros padrão da seção, citada aqui por ser o único caso adicional da story).
