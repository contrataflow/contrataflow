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
- **Permissões do ator (POL-13):** `RoleActorResolver` lê, na transação do comando, as concessões
  ATUAIS dos perfis do tenant cujas chaves estão no vínculo (`roleKeys`); perfil inativo não concede
  nada (RN-IAM-84); chave sem perfil no tenant cai na matriz padrão. `ROLE_VIEW`/`ROLE_MANAGE` são
  conferidas com o mesmo conjunto (`authorizeActor`), com MFA por `security.mfaPolicy`.
- **Protegidas do `ADMIN_ORGAO`:** `ADMIN_ORGAO_SEEDED_PERMISSIONS` (`@contrataflow/validation`, usada
  também pela UI); um teste confere a igualdade com a coluna `ADMIN_ORGAO` de `DEFAULT_ROLE_GRANTS`.
- **Vínculos ativos:** porta `RoleAssignmentCounter` — 0 até a US-096 trocar o adaptador
  `NoRoleAssignmentsCounter` pela contagem em `role_assignments`.
- **Cache:** `RoleCreated`/`RoleUpdated` (routing `role.*`) → `PermissionCacheInvalidator` do worker
  apaga as permissões efetivas do tenant; sem relay, vale o TTL de 5 min (DEC-134).

## Ponte até a US-097

`AccessFacade.assertCan` (usado pelos demais módulos) ainda decide pelos `roleKeys` do contexto contra
a matriz padrão (`domain/permission-grants.ts`, derivada de `DEFAULT_ROLE_GRANTS`) — não enxerga as
matrizes editadas pela US-095. A US-097 troca isso pelas permissões efetivas (perfis do tenant,
escopos e cache) sem mudar os chamadores, e absorve o `RoleActorResolver`.
