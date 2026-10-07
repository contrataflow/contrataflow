---
id: US-094
title: "Catálogo de permissões e perfis padrão"
epic: EP-016
feature: FT-053
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-100]
modules: [access, platform]
screens: [SCR-031]
endpoints: [ROL-01]
permissions: [ROLE_VIEW]
events: []
---

# US-094 — Catálogo de permissões e perfis padrão

## Título
Catálogo de permissões e perfis padrão

## Descrição
**Como** administrador do órgão, **quero** que o tenant já nasça com o catálogo de permissões e os 15 perfis padrão corretamente configurados, **para** poder liberar o acesso da equipe desde o primeiro dia, sem precisar montar perfis do zero nem entender cada permissão individualmente.

Esta story não tem tela própria de criação: o catálogo de 67 permissões é definido em código e sincronizado por migração, e os 15 perfis padrão (`Role.isSystem = true`) são semeados automaticamente durante o provisionamento do tenant (US-099), já com a matriz de concessões (`RolePermission`) de permissions.md §3.2. O catálogo também é exposto por `GET /permissions` (ROL-01), consumido pela tela de perfis (SCR-031) para exibir nome, descrição, módulo e `riskLevel` de cada permissão ao administrador que for montar ou ajustar um perfil (US-095).

## Contexto
- A Lei 14.133/2021 distribui competências entre várias áreas (requisitante, planejamento, compras, licitações, contabilidade, jurídico, controle interno, autoridade competente...); sem perfis prontos, cada órgão recém-provisionado ficaria sem nenhum usuário capaz de operar o sistema além do administrador.
- DEC-134 define o modelo RBAC granular com escopo: catálogo global de permissões em código, perfis por tenant, matriz `RolePermission` e atribuições `RoleAssignment` com escopo. DEC-035 define os 15 perfis padrão (role templates) e que `ADMIN_ORGAO` é protegido (`isProtected`), sempre com todas as permissões de administração.
- Esta story estabelece a base (catálogo + seeds) sobre a qual US-095 (gestão de perfis), US-096 (atribuição) e US-097 (enforcement) são construídas; é por isso que US-095 depende desta.

## Objetivo
Garantir que 100% dos tenants provisionados fiquem, ao final do provisionamento (US-099), com as 67 permissões sincronizadas e os 15 perfis padrão semeados com a matriz correta — incluindo `allowExternalAssignment = true` apenas em `AUDITOR` e `CONSULTOR_EXTERNO` — de forma idempotente e auditável, e com o catálogo consultável por `GET /permissions` em até 200 ms (p95).

## Persona
- **Principal:** Administrador do órgão (perfil `ADMIN_ORGAO`) — consulta o catálogo ao montar ou revisar perfis (US-095).
- **Secundária:** Processo de provisionamento do tenant (ator `SYSTEM`, US-099) — executa o seeder `access.defaultRoles`.

## Pré-condições
- Migração de `permissions` aplicada (catálogo de 67 permissões sincronizado a partir de `packages/types/src/permissions.ts`).
- Tenant em `PROVISIONING` (DEC-132) executando o checklist da US-099, que inclui a chamada ao seeder `access.defaultRoles`.
- Para a consulta do catálogo (ROL-01): usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE`, permissão `ROLE_VIEW`.

## Fluxo principal
1. (Provisionamento, US-099) Ao atingir o item "perfis padrão" do checklist, o sistema invoca o seeder `access.defaultRoles` dentro da transação do provisionamento.
2. O seeder lê a lista fixa de 15 perfis (permissions.md §3.1: `ADMIN_ORGAO`, `GESTOR_CONTRATACOES`, `REQUISITANTE`, `PLANEJAMENTO`, `COMPRAS`, `LICITACOES`, `CONTABILIDADE`, `JURIDICO`, `CONTROLE_INTERNO`, `AUTORIDADE_COMPETENTE`, `FISCAL_CONTRATO`, `GESTOR_CONTRATO`, `AUDITOR`, `SOMENTE_LEITURA`, `CONSULTOR_EXTERNO`) e, para cada um, insere (ou atualiza, se já existir pela chave) o `Role` com `key`, `name`, `isSystem = true`, `isProtected` (`true` somente em `ADMIN_ORGAO`), `allowExternalAssignment` (`true` em `AUDITOR` e `CONSULTOR_EXTERNO`; `false` nos demais) e `isActive = true`.
3. Para cada perfil, o seeder insere as linhas de `RolePermission` correspondentes à coluna do perfil na matriz §3.2 (upsert por `(tenantId, roleId, permissionCode)`).
4. O seeder registra auditoria `role.create` (categoria `SECURITY`, `actorType = SYSTEM`) para cada perfil criado, com `metadata.seeded = true`.
5. O checklist da US-099 segue para o próximo item; falha neste passo propaga a falha ao provisionamento (RN-IAM-77).
6. (Consulta, a qualquer momento) O administrador abre SCR-031; o front chama `GET /permissions` (ROL-01); a API autoriza `ROLE_VIEW` e retorna as 67 permissões com `code`, `module`, `name`, `description`, `riskLevel`, `scopable`; o front agrupa por `module` e exibe o selo de risco.

## Fluxos alternativos
- **FA-01 — Reexecução idempotente do provisionamento:** se o job de provisionamento for reprocessado (ex.: retry após falha em um item posterior do checklist), o seeder não duplica perfis nem concessões (upsert por chave); `Role.updatedAt` não muda quando o conteúdo já é idêntico.
- **FA-02 — Filtro no catálogo:** `GET /permissions?module=access` ou `?riskLevel=HIGH` retorna apenas o subconjunto; parâmetros fora dos valores conhecidos são ignorados (não geram erro).
- **FA-03 — Permissão descontinuada:** permissões com `isDeprecated = true` continuam retornadas (para perfis legados que ainda as referenciam), mas o front as exibe com o selo "Descontinuada" e não as oferece para novos perfis (US-095).

## Regras de negócio
- **RN-IAM-73** — O catálogo de permissões é definido em código (`packages/types/src/permissions.ts`, constante `PERMISSIONS`) com exatamente 67 entradas no MVP 1; cada entrada tem `code` (`RESOURCE_ACTION`, estável), `module`, `name` (pt-BR), `description`, `riskLevel` (`LOW`|`MEDIUM`|`HIGH`), `scopable`, `isDeprecated` (padrão `false`) e `introducedIn` (ex.: `MVP1`); é sincronizado com a tabela `permissions` por migração (upsert por `code`; nunca `DELETE` de código em uso por algum `RolePermission`).
- **RN-IAM-74** — No provisionamento do tenant (US-099), o seeder `access.defaultRoles` cria, em uma única transação, os 15 perfis padrão (`Role.isSystem = true`) com `key`, `name` e escopo padrão de atribuição conforme permissions.md §3.1, e concede a cada perfil as permissões da sua coluna na matriz §3.2 (`RolePermission`).
- **RN-IAM-75** — `ADMIN_ORGAO` é semeado com `isProtected = true`; `AUDITOR` e `CONSULTOR_EXTERNO` são semeados com `allowExternalAssignment = true` (POL-15); os demais 12 perfis são semeados com `allowExternalAssignment = false`; todos os 15 nascem `isActive = true`.
- **RN-IAM-76** — O seeder é idempotente: reexecução (reprocessamento do job de provisionamento) não cria perfis nem concessões duplicadas — upsert por `(tenantId, key)` em `Role` e por `(tenantId, roleId, permissionCode)` em `RolePermission`; nenhuma concessão da matriz é removida por reexecução.
- **RN-IAM-77** — Falha em qualquer etapa da semeadura desfaz a criação dos 15 perfis e de todas as concessões já inseridas naquela execução (mesma transação do item do checklist da US-099); o checklist registra o item como pendente para nova tentativa.
- **RN-IAM-78** — `GET /permissions` (ROL-01) lista o catálogo completo (global, não filtrado por tenant), somente leitura; aceita filtros opcionais `module` e `riskLevel`; parâmetro inválido é ignorado silenciosamente (não quebra a listagem).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Módulo | `module` | filtro (seleção) | Não | valor entre os módulos existentes no catálogo | — |
| Nível de risco | `riskLevel` | filtro (seleção `PermissionRiskLevel`) | Não | `LOW`\|`MEDIUM`\|`HIGH` | — |
| *(leitura)* Código | `code` | texto | — | `RESOURCE_ACTION`, estável | catálogo |
| *(leitura)* Nome / Descrição | `name`, `description` | texto | — | pt-BR | catálogo |
| *(leitura)* Permite escopo | `scopable` | booleano | — | — | catálogo |
| *(leitura)* Descontinuada | `isDeprecated` | booleano | — | — | catálogo |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `module`/`riskLevel` fora dos valores conhecidos | API | — (filtro ignorado; lista completa é retornada) | — |
| V-02 | Seeder: perfil referenciando permissão inexistente no catálogo | API (migração/seed) | — (falha de implantação; não chega ao usuário final) | `REFERENCE_NOT_FOUND` |

## Permissões
- **Permissão:** `ROLE_VIEW` (risco `L`) para `GET /permissions`.
- **Políticas:** nenhuma política contextual na consulta; a semeadura (passos 1–4 do fluxo principal) é executada pelo ator `SYSTEM` dentro do provisionamento e não passa pela checagem de `AuthorizationService` de um usuário.
- **MFA:** não exigido (`ROLE_VIEW` é risco `L`).
- **Sem permissão:** o item de menu "Perfis e permissões" (SCR-031) não é exibido; a API responde 403 `PERMISSION_DENIED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio dedicado (RN-IAM-74): a semeadura é efeito do provisionamento (US-099) e gera apenas auditoria `role.create` (`actorType = SYSTEM`). Os eventos `RoleCreated`/`RoleUpdated` só são produzidos pela gestão de perfis (US-095). Como o tenant ainda não tem vínculos, não há cache de permissões a invalidar. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: a semeadura é um efeito interno do provisionamento, sem usuários ainda vinculados ao tenant. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Catálogo de permissões e perfis padrão

  Background:
    Given que o tenant "Prefeitura de São José" está em provisionamento

  Scenario: [Sucesso] Semear os 15 perfis padrão com a matriz correta
    When o checklist de provisionamento executar o seeder "access.defaultRoles"
    Then devem existir 15 perfis com "isSystem" igual a verdadeiro
    And o perfil "ADMIN_ORGAO" deve ter "isProtected" igual a verdadeiro
    And os perfis "AUDITOR" e "CONSULTOR_EXTERNO" devem ter "allowExternalAssignment" igual a verdadeiro
    And os demais 12 perfis devem ter "allowExternalAssignment" igual a falso
    And cada perfil deve conceder exatamente as permissões da sua coluna em permissions.md §3.2
    And deve existir um registro de auditoria "role.create" com "actorType" "SYSTEM" para cada perfil

  Scenario: [Sucesso] Consultar o catálogo de permissões
    Given que "Ana" possui o perfil "ADMIN_ORGAO"
    When "Ana" chamar "GET /permissions"
    Then a API deve responder 200 com 67 permissões
    And cada permissão deve conter "code", "module", "name", "description", "riskLevel" e "scopable"

  Scenario: [Validação] Filtro com valor desconhecido é ignorado
    When "Ana" chamar "GET /permissions?riskLevel=EXTREME"
    Then a API deve responder 200 com a lista completa de 67 permissões

  Scenario: [Permissão] Usuário sem ROLE_VIEW
    Given que "Bruno" possui apenas o perfil "SOMENTE_LEITURA" sem "ROLE_VIEW"
    When "Bruno" acessar a tela "Perfis e permissões"
    Then o item de menu não deve ser exibido
    When "Bruno" chamar "GET /permissions"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Catálogo é global, mas o acesso exige vínculo no tenant
    When um usuário sem vínculo no tenant "Prefeitura de São José" chamar "GET /permissions" com "X-Tenant-Id" desse tenant
    Then a API deve responder 403 com código "MEMBERSHIP_INACTIVE"

  Scenario: [Duplicidade] Reexecução do seeder não duplica perfis nem concessões
    Given que o seeder "access.defaultRoles" já foi executado com sucesso para o tenant
    When o checklist de provisionamento for reprocessado e o seeder for executado novamente
    Then devem continuar existindo exatamente 15 perfis
    And a quantidade de linhas de "RolePermission" deve permanecer a mesma

  Scenario: [Concorrência] Duas tentativas simultâneas de provisionar o mesmo tenant
    When duas execuções do checklist de provisionamento rodarem simultaneamente para o mesmo tenant
    Then apenas uma deve criar os 15 perfis
    And a outra deve concluir sem erro e sem criar perfis duplicados

  Scenario: [Falha de banco] Banco indisponível durante a semeadura
    Given que o banco de dados fica indisponível durante a execução do seeder
    When o checklist de provisionamento executar "access.defaultRoles"
    Then nenhum perfil ou concessão deve ser persistido
    And o item do checklist deve permanecer pendente para nova tentativa

  Scenario: [Falha de integração] Consulta ao catálogo com Redis indisponível
    Given que o Redis está indisponível
    When "Ana" chamar "GET /permissions"
    Then a API deve responder 200 normalmente, pois o catálogo não depende de cache
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem permissão `ROLE_VIEW` | 403 | `PERMISSION_DENIED` | "Você não tem permissão para ver perfis e permissões." | Item de menu oculto; rota retorna SCR-111 403 |
| Vínculo inativo / tenant suspenso | 403 | `MEMBERSHIP_INACTIVE` / `TENANT_SUSPENDED` | "Seu acesso a este órgão não está ativo." | Redireciona para SCR-111 |
| Falha na semeadura (provisionamento) | 503 | `DEPENDENCY_UNAVAILABLE` | — (erro interno do checklist; sem tela própria) | Item do checklist marcado como pendente; retry |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Mantém estado; botão copiar código |

## Dependências
- **Stories:** US-100 (fundação de autorização/escopos, pré-requisito declarado no backlog do épico); US-099 (provisionamento do tenant — chama o seeder desta story em seu checklist); US-097 (consome o catálogo e a matriz no `AuthorizationService`); US-095 (gestão de perfis personalizados, depende desta).
- **Decisões/ADRs:** DEC-035, DEC-134.
- **Configurações:** nenhuma chave própria.
- **Lacunas nas fontes canônicas:** nenhuma — US-099 já registra a chamada ao seeder `access.defaultRoles` no seu checklist de provisionamento.

## Impacto técnico
- Estabelece o **catálogo global de permissões** como dado versionado em código + migração — toda nova permissão do roadmap passa pela mesma esteira (constante `PERMISSIONS` → migração → seed/matriz).
- Seeder deve ser **idempotente e transacional** (upsert), pois é reexecutável pelo checklist de provisionamento (US-099) em caso de retry de itens posteriores.
- `GET /permissions` é um catálogo pequeno e estável (67 linhas): candidato a cache de aplicação de longa duração (ex.: `staleTime` alto no front), sem necessidade de cache Redis dedicado.

## Backend
- **Módulo(s):** `access` (dono do catálogo e do seeder); consumido por `platform` (checklist de provisionamento, US-099).
- **Casos de uso:** `SeedDefaultRolesCommand` → `SeedDefaultRolesHandler` (chamado pelo checklist da US-099); `ListPermissionsQuery` → `ListPermissionsHandler`.
- **Domínio:** `Permission` (catálogo, somente leitura em runtime); `Role.seedDefaults()` (fábrica que aplica RN-IAM-74/75); `RolePermission.grant(roleId, permissionCode)`.
- **Integrações internas:** `platform` (checklist de provisionamento chama `AccessFacade.seedDefaultRoles(tenantId)`); `audit` (`AuditService`, ator `SYSTEM`).
- **Transação:** upsert dos 15 `Role` + suas `RolePermission` em uma transação por tenant, com `app.tenant_id` definido; falha desfaz tudo (RN-IAM-77).

## Frontend
- **Tela(s):** SCR-031 (`/admin/perfis/[roleId]`) — painel de referência do catálogo (consumido junto com US-095); sem tela própria de CRUD.
- **Componentes:** `PermissionCatalogPanel` (lista agrupada por `module`, com selo de `riskLevel` e busca local), `RiskLevelBadge`.
- **Estados:** skeleton no carregamento do catálogo; erro com "Tentar novamente"; catálogo é o mesmo para todos os tenants (sem estado vazio).
- **Acessibilidade e responsividade:** selos de risco com texto além de cor (AA); lista colapsável por módulo em telas estreitas.

## Banco de dados
- **Tabelas:** `permissions` (migração de sincronização do catálogo), `roles`, `role_permissions` (seed).
- **Migrações:** `permissions` conforme entities.md (PK `code`); seed idempotente dos 15 `roles` × matriz `role_permissions` por tenant, executado pelo checklist de provisionamento (não é seed global, pois `roles`/`role_permissions` têm `tenant_id`).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, key)` e `UNIQUE (tenant_id, lower(name))` em `roles`; PK composta `(tenant_id, role_id, permission_code)` em `role_permissions`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| ROL-01 | GET | `/api/v1/permissions` | Query: `module?`, `riskLevel?` | `200 { data: Permission[] }` com `code`, `module`, `name`, `description`, `riskLevel`, `scopable`, `isDeprecated`, `introducedIn` | 200, 401, 403 |

## Logs
- `info` `access.default_roles_seeded` — `tenantId`, `rolesCreated`, `permissionsGranted`, `durationMs`.
- `warn` `access.default_roles_seed_retry` — quando o checklist reexecuta o item.
- `error` `access.default_roles_seed_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** não se aplica dado sensível (catálogo, não dado pessoal).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `role.create` | `SECURITY` | Para cada perfil semeado no provisionamento | `metadata`: `key`, `isSystem = true`, `seeded = true`, `permissionsGranted[]` |

## Testes necessários
- **Unitários:** fábrica `Role.seedDefaults()` cobrindo os 15 perfis e a matriz §3.2 linha a linha (snapshot); `ADMIN_ORGAO.isProtected`; `AUDITOR`/`CONSULTOR_EXTERNO.allowExternalAssignment`.
- **Integração (Testcontainers PostgreSQL):** seed real contra o banco; reexecução idempotente (RN-IAM-76); rollback em falha simulada (RN-IAM-77); RLS por tenant.
- **API/contrato:** `GET /permissions` retorna exatamente 67 itens e os campos do catálogo; filtros `module`/`riskLevel`.
- **RBAC e multi-tenant:** `ROLE_VIEW` exigido; vínculo inativo → 403; catálogo idêntico entre tenants.
- **Concorrência:** duas execuções simultâneas do seeder para o mesmo tenant não duplicam `roles`/`role_permissions`.
- **E2E (Playwright):** provisionamento de um tenant de teste confirma, ponta a ponta, os 15 perfis na tela de perfis.
- **Acessibilidade/performance:** `GET /permissions` p95 < 200 ms; painel do catálogo sem violações sérias de axe.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (integração + API) e passando no CI
- [ ] Catálogo de 67 permissões sincronizado por migração e validado contra `packages/types/src/permissions.ts`
- [ ] Seeder idempotente e transacional comprovado por teste de reexecução e de falha induzida
- [ ] Auditoria `role.create` (ator SYSTEM) verificada em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de ROL-01 compatível com api.md
- [ ] Logs sem dados sensíveis; métrica `access_default_roles_seeded_total`
- [ ] Painel do catálogo acessível (axe) e responsivo
- [ ] Revisão de código e de segurança aprovadas
- [ ] Integração com o checklist de provisionamento da US-099 documentada

## Estimativa
**M** — catálogo e seeder são bem delimitados e sem fluxo de UI de escrita própria, mas exigem precisão na matriz de 15 perfis × permissões e testes de idempotência/transação.

## Prioridade
**P0** — sem perfis padrão, nenhum tenant provisionado tem usuários capazes de operar o sistema além do próprio administrador.
