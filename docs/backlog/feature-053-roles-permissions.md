---
id: FT-053
title: "Perfis e permissões"
epic: EP-016
mvp: 1
priority: P0
stories: [US-094, US-095, US-096, US-097]
status: Especificada
---

# FT-053 — Perfis e permissões

## Título
Perfis e permissões

## Épico
EP-016 — Identidade, acesso e RBAC

## Descrição
Entrega o RBAC completo do ContrataFlow: o catálogo global de 67 permissões e os 15 perfis padrão semeados no provisionamento (US-094); a gestão desses perfis e de sua matriz de permissões (US-095); a atribuição de perfis a vínculos com escopo e vigência (US-096); e o motor de autorização que aplica tudo isso, em toda rota da API e no frontend, com cache e meta-teste de cobertura (US-097). É a feature mais transversal do épico — todas as demais stories do produto dependem dela para decidir "quem pode o quê".

## Valor para o usuário e para o órgão
- Segregação de funções exigida pela Lei 14.133/2021 (art. 7º, § 1º) aplicada de forma verificável, não apenas por convenção.
- Administrador do órgão ajusta perfis à realidade local (criar, duplicar, editar matriz) sem depender de código ou suporte da plataforma.
- Escopo (`TENANT`/`ORGANIZATION`/`DEPARTMENT`/`OWN_DEPARTMENTS`) permite restringir acesso por órgão ou unidade sem multiplicar perfis.

## Personas
- Administrador do órgão (`ADMIN_ORGAO`) — gerencia perfis e atribuições; único que sempre tem permissões de administração (`isProtected`).
- Gestor de contratações (`GESTOR_CONTRATACOES`) — pode receber `ROLE_ASSIGN` para distribuir acesso na própria área.
- Todo usuário — consome o resultado do motor de autorização (US-097) em cada tela.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-094 | Catálogo de permissões e perfis padrão | P0 | M | US-100 |
| US-095 | Gerenciar perfis e matriz de permissões | P0 | M | US-094 |
| US-096 | Atribuir perfis com escopo e vigência | P0 | M | US-091, US-094 |
| US-097 | Autorização na API e no frontend | P0 | L | US-094, US-096, US-100 |

## Escopo
- Catálogo de 67 permissões (`code`, `module`, `riskLevel`, `scopable`) e seeder idempotente dos 15 perfis padrão com a matriz perfil × permissão.
- Criação, edição, duplicação e desativação de perfis personalizados, com proteção de `ADMIN_ORGAO`.
- Atribuição e revogação de perfis a vínculos, com escopo e vigência.
- `AuthorizationService`, cache de permissões efetivas, decorators `@RequirePermission`/`@Policy`, predicado de visibilidade (DEC-024) e `GET /me/permissions`.

## Fora de escopo
- Permissões por participação no processo além do conjunto fixo já definido em permissions.md §4 (não é editável pelo tenant).
- Múltiplos aprovadores/decisão sequencial (PEND-13, módulo `workflow`).

## Regras de negócio da feature
- **Catálogo e seeder (US-094, RN-IAM-74 a 78):** o seeder `access.defaultRoles` cria os 15 perfis em uma única transação no provisionamento, com `ADMIN_ORGAO` sempre `isProtected = true` e `AUDITOR`/`CONSULTOR_EXTERNO` sempre `allowExternalAssignment = true`; é idempotente (upsert por `(tenantId, key)`), e `GET /permissions` (`ROL-01`) lista o catálogo completo, somente leitura.
- **Gestão de perfis (US-095, RN-IAM-79 a 88):** POL-13 (anti-escalonamento) se aplica a toda concessão de permissão a um perfil, com isenção para `ADMIN_ORGAO`; perfis `isProtected` nunca perdem as permissões semeadas (rejeição total da submissão, sem alteração parcial); desativar `ADMIN_ORGAO` é sempre bloqueado por POL-12 (`LAST_ADMIN_REQUIRED`); `name`/`key` duplicados → `ROLE_ALREADY_EXISTS`.
- **Atribuição com escopo e vigência (US-096, RN-IAM-89 a 99):** cada atribuição liga vínculo × perfil × escopo × vigência; POL-13 (anti-escalonamento), POL-15 (restrição a vínculos externos), POL-12 (anti-bloqueio do último administrador) e POL-16 (autoproteção) se aplicam à criação e à revogação; o commit invalida imediatamente o cache de permissões efetivas do vínculo.
- **Motor de autorização (US-097, RN-IAM-100 a 108):** a decisão de autorização combina permissão por escopo, participação no processo e política contextual (permissions.md §1); toda rota mutável deve declarar permissão/política sob pena de falhar o build (meta-teste); o cache Redis (5 min) é invalidado pelos eventos `RoleUpdated`/`RoleAssigned`/`RoleRevoked`/`MembershipUpdated`/`MembershipSuspended`/`MembershipRevoked`/`DepartmentMoved`; overhead com cache quente deve manter p95 < 5 ms.

## Telas
- SCR-030 — Perfis (`/admin/perfis`)
- SCR-031 — Permissões — matriz do perfil (`/admin/perfis/[roleId]`)
- SCR-029 — Usuários, aba "Perfis e acessos" (`/admin/usuarios/[userId]`)

## Endpoints
- `ROL-01` `GET /permissions`
- `ROL-02` `GET /roles`, `ROL-03` `POST /roles`, `ROL-04` `GET /roles/{id}`, `ROL-05` `PATCH /roles/{id}`, `ROL-06` `PUT /roles/{id}/permissions`, `ROL-07` `POST /roles/{id}/duplicate`, `ROL-08` `POST /roles/{id}/deactivate`
- `ROL-09` `GET /roles/{id}/assignments`, `ROL-10` `GET /users/{userId}/role-assignments`, `ROL-11` `POST /users/{userId}/role-assignments`, `ROL-12` `POST /role-assignments/{id}/revoke`
- `ME-03` `GET /me/permissions`

## Entidades
- `Permission` — catálogo global (tabela de plataforma).
- `Role` — perfil por tenant.
- `RolePermission` — matriz perfil × permissão.
- `RoleAssignment` — atribuição vínculo × perfil × escopo × vigência.

## Eventos
- `RoleCreated` / `RoleUpdated` — criação/edição de perfil ou matriz.
- `RoleAssigned` / `RoleRevoked` — atribuição/revogação a um vínculo.
- `PermissionCacheInvalidator` — consumidor transversal (`role.*`, `membership.*`, `department.moved`) que mantém o cache de permissões efetivas coerente.

## Permissões
- `ROLE_VIEW` — consultar catálogo, perfis e atribuições.
- `ROLE_MANAGE` — criar/editar/duplicar/desativar perfis e sua matriz.
- `ROLE_ASSIGN` — atribuir/revogar perfis a vínculos.
- O catálogo completo de 67 permissões do MVP 1 (permissions.md §2) é o objeto gerenciado por esta feature e aplicado por ela a todos os demais módulos.

## Dependências
- US-100 (contexto de requisição) e US-091 (convite, que pode gravar a primeira atribuição).
- Decisões: DEC-134, DEC-035, DEC-023, DEC-024.

## Critérios de aceite da feature
```gherkin
Feature: Perfis e permissões

  Scenario: Criar perfil, ajustar matriz, atribuir e revogar
    Given que "Carla" (ADMIN_ORGAO) cria o perfil personalizado "Fiscal de Obras"
    And concede a ele a permissão "PROCESS_VIEW"
    When "Carla" atribuir "Fiscal de Obras" a "Bruno" com escopo "DEPARTMENT" na "Secretaria de Obras"
    Then "Bruno" deve passar a ver os processos dessa secretaria imediatamente
    When "Carla" revogar essa atribuição
    Then "Bruno" deve perder esse acesso na próxima requisição, sem esperar o TTL do cache
```

## Métricas de sucesso
- 100% das rotas mutáveis com permissão/política declarada (gate de CI).
- Overhead de autorização com cache quente — p95 < 5 ms.
- Zero ocorrências de `PRIVILEGE_ESCALATION_FORBIDDEN` revertidas manualmente (sinal de política furada).

## Riscos
- Administrador remove o próprio último acesso administrativo — mitigação: POL-12/16 bloqueando a ação antes do commit.
- Perfil com permissão de alto risco atribuído a vínculo externo — mitigação: POL-15 (`EXTERNAL_HIGH_RISK_ROLE`).

## Definition of Done da feature
- [ ] Todas as stories P0 (US-094 a US-097) concluídas e aceitas
- [ ] Jornada E2E criar perfil → ajustar matriz → atribuir → revogar automatizada
- [ ] Meta-teste de cobertura de rotas ativo no CI
- [ ] Documentação atualizada
