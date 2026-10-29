# `access`

RBAC, escopos e políticas de autorização (DEC-040, DEC-134).

## Catálogo de permissões (US-094)

- Fonte única: `packages/types/src/permissions.ts` (`PERMISSIONS`, 68 entradas no MVP 1). A tabela
  global `permissions` é sincronizada **por migração** (upsert por `code`, nunca `DELETE` — a FK de
  `role_permissions` impede remover código em uso). Permissão nova: entrada na constante →
  migração nova com o mesmo upsert → coluna da matriz em `domain/default-roles.ts`. Para
  descontinuar, `isDeprecated: true` (a permissão continua listada).
- `GET /api/v1/permissions` (ROL-01) exige `ROLE_VIEW` e é servido da constante (sem banco nem
  Redis); filtros `module`/`riskLevel` com valor desconhecido são ignorados.
- O teste de integração `test/access/default-roles.spec.ts` confere a tabela com a constante, campo
  a campo; o teste de domínio confere a matriz com `docs/mvp-01/permissions.md` §3.2.

## Perfis padrão — seeder `access.defaultRoles` (integração com a US-099)

O checklist de provisionamento do tenant (US-099) chama, no item "perfis padrão":

```ts
await runAsSystem({ name: 'Provisionamento do tenant', tenantId, correlationId }, () =>
  tenantTransaction.run((tx) => accessFacade.seedDefaultRoles(tx)),
);
```

- **Contexto:** ator `SYSTEM` com o `tenantId` do tenant em `PROVISIONING`; a auditoria
  `role.create` (categoria `SECURITY`, `metadata.seeded = true`) herda o ator.
- **Transação:** o `tx` é o do item do checklist. Qualquer falha propaga e desfaz os 15 perfis e
  todas as concessões daquela execução (RN-IAM-77); o checklist marca o item como pendente e tenta
  de novo.
- **Idempotência:** perfis por `(tenant_id, key)` e concessões por `(tenant_id, role_id,
permission_code)` com `ON CONFLICT DO NOTHING` — reexecução não duplica, não altera `updatedAt`
  e não remove concessões; completa as que faltarem. Execuções simultâneas se serializam no índice
  único: uma cria, a outra conclui sem criar nada.
- **Retorno:** `{ rolesCreated, permissionsGranted }`. Logs `access.default_roles_seeded` (info),
  `access.default_roles_seed_retry` (warn, nada novo criado) e `access.default_roles_seed_failed`
  (error); métrica `access_default_roles_seeded_total{result}`.
- Sem evento de domínio nem invalidação de cache: o tenant ainda não tem vínculos.

O escopo padrão de atribuição de cada perfil (§3.1) fica em `DEFAULT_ROLES[].defaultAssignmentScope`
(não é coluna de `roles`), para a atribuição de perfis (US-096).

## Gestão de perfis (US-095 · ROL-02..08 · SCR-030/031)

- Casos de uso em `application/role.commands.ts` (`RoleCommandSupport` concentra transação,
  autorização, auditoria e outbox) e `application/role.queries.ts`; regras puras em
  `domain/role-management.ts` (chave gerada do nome, diff da matriz, POL-12/13, RN-IAM-82/83/86).
- **Permissões do ator (POL-13):** `RoleActorResolver` usa as permissões efetivas da requisição
  (US-097), em qualquer escopo — o retrato que o `AuthorizationGuard` pôs no contexto, o mesmo de
  ROL-01 e ME-03; sem ele, calculadas na transação do caso de uso. Atribuição vigente de perfil
  ativo concede; perfil inativo não concede nada (RN-IAM-84); a ponte pelas chaves do vínculo só vale
  sem nenhuma atribuição gravada. Isento do anti-escalonamento: `ADMIN_ORGAO` vigente com escopo
  `TENANT` (`EffectivePermissionsService.holdsTenantWideRole`). `ROLE_VIEW`/`ROLE_MANAGE` são
  conferidas com o mesmo conjunto (`authorizeActor`), com MFA por `security.mfaPolicy`. O vínculo
  lido do PostgreSQL não traz `roleKeys` (spec-530): nada aqui decide só por elas.
- **Protegidas do `ADMIN_ORGAO`:** `ADMIN_ORGAO_SEEDED_PERMISSIONS` (`@contrataflow/validation`, usada
  também pela UI); um teste confere a igualdade com a coluna `ADMIN_ORGAO` de `DEFAULT_ROLE_GRANTS`.
- **Vínculos ativos:** porta `RoleAssignmentCounter`, implementada pelo repositório de atribuições
  (vínculos distintos com atribuição vigente do perfil).
- **Cache:** `RoleCreated`/`RoleUpdated` (routing `role.*`) → `PermissionCacheInvalidator` do worker
  apaga as permissões efetivas do tenant; sem relay, vale o TTL de 5 min (DEC-134).

## Atribuição de perfis (US-096 · ROL-09..12 · SCR-029 "Perfis e acessos")

- Casos de uso em `application/role-assignment.commands.ts` (`RoleAssignmentSupport`: transação,
  nomes da resposta, invalidação do cache); regras puras em `domain/role-assignment.ts` (escopo e
  vigência — RN-IAM-89/93, `scopeCovers` do POL-13, POL-15/16). Repositório único
  `ROLE_ASSIGNMENT_REPOSITORY` (Prisma/memória) — também atende o convite (US-091), o POL-12 da
  US-092 e a contagem por perfil (US-095).
- **Ator (POL-13):** `AssignmentActorResolver` lê as atribuições VIGENTES do vínculo da requisição com
  as concessões atuais de cada perfil ativo e o escopo de cada uma; `ADMIN_ORGAO`/`TENANT` é isento.
  Sem nenhuma vigente (modo fake, vínculo sem atribuição), valem as permissões efetivas da requisição
  (`RoleActorResolver`) com escopo `TENANT`.
- **Escopo "igual ou mais amplo":** `TENANT` cobre tudo; órgão cobre a si e as unidades dele;
  unidade cobre a si e, com subárvore, as descendentes (pedir subárvore exige tê-la);
  `OWN_DEPARTMENTS` só cobre `OWN_DEPARTMENTS`. Órgãos/unidades (nome, situação, órgão e caminho)
  vêm pela porta `MembershipReferences` (lado `organization`).
- **POL-12 na revogação:** só para `ADMIN_ORGAO`/`TENANT` vigente — trava os vínculos administradores
  (`IdentityFacade.lockActiveMemberships`), relê as atribuições e exige outro vínculo `ACTIVE`.
  **POL-16:** "administrativo" = perfil com `ROLE_ASSIGN`/`ROLE_MANAGE`/`USER_MANAGE`
  (`ADMINISTRATIVE_PERMISSIONS` em `@contrataflow/validation`, usado também pela tela).
- **Cache:** `DEL access:eff:{membershipId}` logo após o commit (Redis fora → `warn
cache.invalidation_unavailable`, sem desfazer nada); o `PermissionCacheInvalidator` repete pelo
  `RoleAssigned`/`RoleRevoked` (routing `role.*`).

## Autorização (US-097 · DEC-134 · RN-IAM-100..108)

Mecanismo único: o `AuthorizationGuard` global (`#shared/auth/authorization.guard.js`, depois de
autenticação → tenant → vínculo → MFA) chama o `AuthorizationService` (porta `AUTHORIZATION_PORT`)
em toda rota `@TenantScope('TENANT')` com vínculo ativo.

- **Declare na rota** (`#shared/auth/authorization.js`) — meta-teste
  `src/openapi/authorization-coverage.spec.ts` reprova rota mutável sem declaração:
  - `@RequirePermission('PROCESS_CANCEL', { scope: { processParam: 'id' } })` — a permissão precisa
    cobrir o processo do caminho (perfil com escopo ∪ participação §4); não visível = 404
    `PROCESS_NOT_FOUND`, visível sem permissão = 403 `PERMISSION_DENIED`. Sem `scope`, basta a
    permissão em algum escopo (o caso de uso confere o recurso do corpo, ex.:
    `access.assertCanInDepartment('PROCESS_CREATE', unidade, …)`). `detail` troca a mensagem do 403.
  - `@Policy(ProcessCustodyPolicy)` — provider com `static policyId` que implementa
    `ContextualPolicy`; o guard o avalia depois da permissão (recebe usuário, parâmetros, processo e
    `has(code)`). `@Policy('POL-13')` só declara uma política que o caso de uso aplica.
  - `@ImplicitAccess('motivo')` — capacidade implícita (permissions.md §7).
- **Recusas:** 403 com `PERMISSION_DENIED`, `MFA_REQUIRED` (permissão `HIGH` + `security.mfaPolicy`
  ≠ `NONE`; grava também `auth.mfa_required`) ou o código da política (`CONTEXTUAL_POLICIES` em
  `@contrataflow/types`; `ApiError({ auditDenial: true })`). Toda recusa vira `access.denied` com a
  permissão ou o ID da política em `reasonCode` (filtro RFC 9457, amostragem da US-073).
- **Permissões efetivas** (`domain/effective-permissions.ts` · `EffectivePermissionSet`): pares
  `(permissão, escopo)` das atribuições vigentes de perfis ativos, com as unidades expandidas
  (subárvore pela porta `MembershipReferences.subtreeIds`, lotações do `identity`) e as chefias.
  Permissão não escopável (`scopable: false`) vale em qualquer escopo. O retrato vai para o contexto
  (`RequestContext.permissions`): `AccessFacade.assertCan`/`can` dos casos de uso decidem por ele
  sem nova leitura; `effectivePermissions()`/`processVisibilityScope()` para os assíncronos.
- **Cache** (`application/effective-permissions.service.ts`): `cf:{env}:t:{tenantId}:access:eff:{m}`
  por 5 min, com os tokens de geração (`#shared/auth/permission-cache.js`). Invalide com
  `invalidateEffectivePermissions(cache, membershipId)` / `invalidateTenantPermissions(cache)` logo
  após o commit (atribuição, vínculo e perfil já fazem); o `PermissionCacheInvalidator` do worker
  repete pelos eventos `role.*`, `membership.*`, `department.*`. Redis fora → calcula sem cache
  (`warn authorization.cache_unavailable`); banco fora com cache frio → 503
  (`error authorization.decision_failed`). Log `info authorization.cache_rebuilt`, métrica
  `authorization_cache_lookups_total{result}`.
- **Ponte do modo fake:** vínculo SEM nenhuma `RoleAssignment` (nem revogada) usa as chaves do
  registro do vínculo com o escopo padrão do perfil (`TENANT` ou lotações). Em produção o registro
  não traz chaves: sem atribuição, nenhuma permissão.
- **Visibilidade (DEC-024):** `buildVisibilityPredicate(scope)` (`#shared/database/process-visibility.js`)
  nas listagens e `isProcessVisible` na consulta por id — a mesma regra. O módulo `process` registra
  o leitor do processo em `ProcessAccessRegistry` (`#shared/auth/process-access.js`).
- **ME-03** `GET /me/permissions`: `MyPermissionsController` → `GetMyPermissionsHandler`
  (`myPermissionsSchema` em `@contrataflow/validation`), fonte única dos hooks do web
  (`PermissionProvider`, `usePermission`, `useProcessCapabilities`, `<Can>`, `<Gate>`).
- **Ainda nas chaves do contexto:** `rolesGrant`/`rolesCoverAllDepartments` (perfis de TERCEIROS —
  aprovadores e titulares) e os resolvedores de ator da gestão de perfis/atribuições
  (`RoleActorResolver`/`AssignmentActorResolver`, que leem as concessões ATUAIS na transação do
  comando para POL-13).
