---
id: US-095
title: "Gerenciar perfis e matriz de permissões"
epic: EP-016
feature: FT-053
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-094]
modules: [access]
screens: [SCR-030, SCR-031]
endpoints: [ROL-01, ROL-02, ROL-03, ROL-04, ROL-05, ROL-06, ROL-07, ROL-08]
permissions: [ROLE_VIEW, ROLE_MANAGE]
events: [RoleCreated, RoleUpdated]
---

# US-095 — Gerenciar perfis e matriz de permissões

## Título
Gerenciar perfis e matriz de permissões

## Descrição
**Como** administrador do órgão, **quero** criar, editar, duplicar e desativar perfis e ajustar a matriz de permissões de cada um, **para** adaptar o controle de acesso à estrutura e às necessidades do meu órgão, sem depender de suporte técnico e sem correr o risco de me bloquear ou de conceder poderes que eu mesmo não tenho.

A gestão acontece na lista de perfis (SCR-030) e no detalhe do perfil (SCR-031, matriz de permissões por módulo). Perfis semeados (`isSystem = true`) podem ser editados livremente, exceto `ADMIN_ORGAO`, que nunca perde as permissões com que foi semeado (`isProtected`). Toda concessão de permissão passa pela regra de anti-escalonamento (POL-13): o administrador só pode conceder o que ele próprio possui. Desativar o perfil `ADMIN_ORGAO` é sempre bloqueado (POL-12).

## Contexto
- DEC-035 define os 15 perfis padrão como editáveis pelo administrador do tenant, exceto `ADMIN_ORGAO`. DEC-134 define `Role`/`RolePermission` por tenant e a invalidação do cache de permissões efetivas a cada mudança de perfil.
- Sem esta story, os perfis semeados por US-094 seriam fixos; cada órgão tem particularidades (ex.: uma secretaria que também cuida de licitações) que exigem perfis personalizados ou ajustes na matriz padrão.
- POL-12 (anti-bloqueio) e POL-13 (anti-escalonamento) existem porque a gestão de perfis é, por natureza, uma superfície de risco de segurança: um erro aqui pode trancar o tenant fora do próprio sistema ou permitir que um usuário se autoconceda poderes.

## Objetivo
Permitir que o `ADMIN_ORGAO` crie, edite, duplique e desative perfis e ajuste a matriz de permissões em até 2 minutos por operação, com 0% das operações resultando em tenant sem nenhum `ADMIN_ORGAO` ativo (POL-12) ou em concessão de permissão que o próprio ator não possuía (POL-13).

## Persona
- **Principal:** Administrador do órgão (perfil `ADMIN_ORGAO`, escopo `TENANT`).
- **Secundária:** Auditor (perfil `AUDITOR`) — apenas leitura (`ROLE_VIEW`), sem `ROLE_MANAGE`.

## Pré-condições
- Usuário autenticado (US-087), tenant `ACTIVE`, vínculo `ACTIVE` e não expirado.
- Usuário possui `ROLE_VIEW` (para listar/ver) ou `ROLE_MANAGE` (para criar/editar/duplicar/desativar) — US-097.
- Os 15 perfis padrão já foram semeados (US-094) e o catálogo de permissões está disponível (ROL-01).

## Fluxo principal
1. O usuário acessa **"Perfis"** (SCR-030, `/admin/perfis`); o sistema chama `GET /roles` (ROL-02) e lista os 15 perfis padrão e os personalizados, com contagem de vínculos ativos por perfil.
2. O usuário clica em **"Novo perfil"**; informa **Nome** e **Descrição** (opcional); o front valida com `createRoleSchema` (Zod).
3. Ao salvar, o front envia `POST /roles` (ROL-03); a API autoriza `ROLE_MANAGE`, gera a `key` a partir do nome, cria o `Role` (`isSystem = false`, `isActive = true`) e responde **201** com `Location` e `ETag: "1"`.
4. O sistema leva o usuário ao detalhe do perfil (SCR-031, `/admin/perfis/[roleId]`), que exibe a matriz de permissões agrupada por módulo (dados de ROL-01) com interruptores por permissão.
5. O usuário ativa/desativa permissões na matriz e clica em **"Salvar matriz"**; o front envia `PUT /roles/{id}/permissions` (ROL-06) com `If-Match` e a lista completa de códigos marcados.
6. A API, em uma transação: autoriza `ROLE_MANAGE`; aplica POL-13 (permissões novas devem estar entre as do próprio ator, salvo se ele possuir `ADMIN_ORGAO`); se o perfil for `isProtected`, rejeita a remoção de qualquer permissão semeada (RN-IAM-82); grava o diff em `RolePermission`; registra auditoria `role.permissions_update`; publica `RoleUpdated`; confirma.
7. A API responde **200** com o perfil atualizado e `ETag` incrementado; o front invalida o cache de permissões exibido e mostra "Matriz atualizada".
8. Para editar nome/descrição/`allowExternalAssignment`, o usuário usa **"Editar perfil"** (`PATCH /roles/{id}`, ROL-05, com `If-Match`); para criar uma variação de um perfil existente, usa **"Duplicar"** (`POST /roles/{id}/duplicate`, ROL-07); para remover o perfil de uso sem excluir o histórico, usa **"Desativar"** (`POST /roles/{id}/deactivate`, ROL-08, com `If-Match`), com confirmação explícita informando quantos vínculos ativos usam o perfil.

## Fluxos alternativos
- **FA-01 — Remover permissão protegida de `ADMIN_ORGAO`:** ao desmarcar, na matriz, uma permissão que `ADMIN_ORGAO` já possuía desde a semeadura, o front bloqueia o interruptor (desabilitado, com dica "Permissão protegida — não pode ser removida do Administrador do órgão") e a API rejeita o mesmo payload caso enviado (RN-IAM-82).
- **FA-02 — Anti-escalonamento ao conceder permissão que o próprio ator não tem:** a matriz oculta/desabilita os interruptores de permissões que o usuário logado não possui, salvo se ele tiver `ADMIN_ORGAO`; se a API ainda receber o código (ex.: requisição manual), responde 403 `PRIVILEGE_ESCALATION_FORBIDDEN`.
- **FA-03 — Ativar `allowExternalAssignment` em perfil com permissão `HIGH`:** o sistema exige MFA ativo na sessão antes de confirmar (*step-up* em `/api/auth/step-up`, DEC-133) e grava auditoria `SECURITY`; sem MFA, a API responde 403 `MFA_REQUIRED` e o front dispara o *step-up*. A flag apenas habilita a atribuição a vínculos `EXTERNAL` (POL-15); o bloqueio de atribuir perfil `HIGH` sem essa flag ocorre na atribuição (US-096).
- **FA-04 — Desativar perfil com vínculos ativos:** a confirmação lista a quantidade de `RoleAssignment` ativos que ficarão sem efeito; o usuário confirma explicitamente (`confirmDeactivate: true`).
- **FA-05 — Desativar `ADMIN_ORGAO`:** sempre bloqueado por POL-12; a UI exibe "Não é possível desativar o perfil Administrador do órgão: o tenant precisa manter ao menos um administrador ativo." e nem exibe o botão "Desativar" nesse perfil.
- **FA-06 — Duplicar perfil:** copia nome ("{nome} (cópia)"), descrição e permissões do perfil de origem para um novo perfil `isSystem = false`, sujeito a POL-13.
- **FA-07 — Reativar perfil:** fora do escopo desta story — o catálogo de endpoints (ROL-01..08) só oferece desativação; perfil desativado permanece assim até suporte técnico ou nova story.

## Regras de negócio
- **RN-IAM-79** — `ROLE_VIEW` permite listar e visualizar perfis e suas permissões (ROL-02/04); `ROLE_MANAGE` permite criar, editar, atualizar a matriz, duplicar e desativar (ROL-03/05/06/07/08). A atribuição de um perfil a um vínculo (`ROLE_ASSIGN`) é tratada na US-096.
- **RN-IAM-80** — Criação (ROL-03): `name` obrigatório (3–120 caracteres, único por tenant, comparação case-insensitive), `description` opcional (até 500 caracteres); `key` é gerada automaticamente a partir do `name` (SCREAMING_SNAKE_CASE, ASCII, única por tenant) e **imutável** após a criação; `isSystem = false`, `isProtected = false`, `isActive = true`; `allowExternalAssignment` opcional (padrão `false`); `permissions[]` opcional na criação (códigos válidos do catálogo).
- **RN-IAM-81** — POL-13 (anti-escalonamento) se aplica a toda operação que concede permissão a um perfil (`permissions[]` na criação, `PUT` da matriz ROL-06, duplicação ROL-07): um usuário sem o perfil `ADMIN_ORGAO` só pode incluir permissões que ele próprio já possua (em algum escopo); violação → 403 `PRIVILEGE_ESCALATION_FORBIDDEN`. Usuários com `ADMIN_ORGAO` estão isentos desta checagem.
- **RN-IAM-82** — Perfis com `isProtected = true` (somente `ADMIN_ORGAO`) nunca perdem, via ROL-05/06, nenhuma permissão presente desde a semeadura (DEC-035); uma submissão que remova alguma dessas permissões é rejeitada por completo (nenhuma alteração parcial é aplicada), com 422 `BUSINESS_RULE_VIOLATION` e `violations[]` identificando a(s) permissão(ões) protegida(s); novas permissões podem ser adicionadas livremente a `ADMIN_ORGAO`.
- **RN-IAM-83** — Marcar `allowExternalAssignment = true` (ROL-05) em um perfil que já possua ao menos uma permissão com `riskLevel = HIGH` exige sessão com MFA satisfeito, independentemente de `security.mfaPolicy` (DEC-133), e gera auditoria categoria `SECURITY`; sem MFA → 403 `MFA_REQUIRED`, disparando *step-up* no BFF.
- **RN-IAM-84** — POL-12 (anti-bloqueio) em ROL-08: desativar o perfil `ADMIN_ORGAO` é sempre bloqueado, pois deixaria o tenant sem nenhum vínculo `ACTIVE` com esse perfil → 409 `LAST_ADMIN_REQUIRED`. Desativar (`isActive = false`) qualquer outro perfil preserva as `RoleAssignment` existentes, que passam a não conceder nenhuma permissão enquanto o perfil estiver inativo.
- **RN-IAM-85** — Perfis `isSystem = true` (os 15 semeados) e os personalizados não podem ser excluídos — o catálogo de endpoints só oferece desativação (ROL-08), nunca exclusão.
- **RN-IAM-86** — Duplicar (ROL-07) cria um novo perfil `isSystem = false`, `isProtected = false`, copiando nome (sufixo " (cópia)", ajustado para manter unicidade), descrição e o conjunto de permissões do perfil de origem, sujeito a POL-13 (RN-IAM-81); `key` nova gerada conforme RN-IAM-80.
- **RN-IAM-87** — `name` (case-insensitive) ou `key` gerada já em uso no tenant → 409 `ROLE_ALREADY_EXISTS`; nenhum perfil é criado/duplicado.
- **RN-IAM-88** — Toda alteração de perfil (ROL-03/05/06/07/08) publica o evento correspondente (`RoleCreated`/`RoleUpdated`) consumido por `PermissionCacheInvalidator`, que invalida (por `DEL`, operação idempotente) o cache Redis de permissões efetivas (5 min, DEC-134) de todos os vínculos com atribuição ativa desse perfil.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nome | `name` | texto curto | Sim | 3–120 caracteres; único por tenant (case-insensitive) | — |
| Descrição | `description` | texto longo | Não | até 500 caracteres | — |
| Permite atribuição a vínculos externos | `allowExternalAssignment` | interruptor | Não | RN-IAM-83 se houver permissão `HIGH` | `false` |
| Matriz de permissões | `permissions[]` (código) | multi-seleção (interruptores por módulo) | Não na criação | códigos do catálogo (ROL-01); RN-IAM-81/82 | `[]` na criação |
| *(sistema)* Chave | `key` | texto técnico | — | gerada do nome; imutável | gerada |
| *(sistema)* Semeado / Protegido / Ativo | `isSystem`, `isProtected`, `isActive` | booleano | — | RN-IAM-80/82/84 | gerados |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `name` ausente ou fora do tamanho | Front + API (Zod) | "Informe um nome entre 3 e 120 caracteres." | `VALIDATION_ERROR` |
| V-02 | `name`/`key` duplicados no tenant | API (+ índice único) | "Já existe um perfil com esse nome." | `ROLE_ALREADY_EXISTS` |
| V-03 | Código de permissão inexistente no catálogo | API | "Selecione permissões válidas." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-04 | Permissão não possuída pelo próprio ator (POL-13) | API | "Você não pode conceder uma permissão que você mesmo não possui." | `PRIVILEGE_ESCALATION_FORBIDDEN` |
| V-05 | Remoção de permissão protegida de `ADMIN_ORGAO` (DEC-035) | API | "Esta permissão é protegida e não pode ser removida do Administrador do órgão." | `BUSINESS_RULE_VIOLATION` |
| V-06 | Desativar `ADMIN_ORGAO` (POL-12) | API | "Não é possível desativar o perfil Administrador do órgão: mantenha ao menos um administrador ativo." | `LAST_ADMIN_REQUIRED` |
| V-07 | `allowExternalAssignment = true` com permissão `HIGH` sem MFA (POL-14) | API | "Confirme sua identidade para continuar." | `MFA_REQUIRED` |
| V-08 | `If-Match` ausente em `PATCH`/`PUT`/desativação | API | "Recarregue a página e tente novamente." | `PRECONDITION_REQUIRED` |
| V-09 | `If-Match` divergente (edição concorrente) | API | "Este perfil foi alterado por outra pessoa. Recarregue para ver a versão atual." | `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `ROLE_VIEW` (ROL-02/04) e `ROLE_MANAGE` (ROL-03/05/06/07/08), ambas sem restrição de escopo (perfis são recursos de tenant, não de unidade).
- **Políticas:** POL-12 (anti-bloqueio, ROL-08 em `ADMIN_ORGAO`), POL-13 (anti-escalonamento, concessão de permissões), POL-14 (MFA ao ligar `allowExternalAssignment` em perfil com permissão `HIGH`), POL-15 (a flag `allowExternalAssignment` administrada aqui habilita a atribuição a vínculos `EXTERNAL`; a checagem que bloqueia perfil `HIGH` sem essa flag ocorre na atribuição, US-096).
- **MFA:** exigido no caso da RN-IAM-83; demais operações seguem `security.mfaPolicy` padrão (ambas as permissões são risco `H`, logo exigido se a política for `ADMINS` ou `ALL`).
- **Sem permissão:** sem `ROLE_VIEW`, o item "Perfis" não aparece no menu; sem `ROLE_MANAGE`, a lista e o detalhe ficam somente leitura (botões "Novo perfil", "Editar", "Salvar matriz", "Duplicar" e "Desativar" ocultos); a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `RoleCreated` | `role.created` | Commit de ROL-03 ou ROL-07 | Payload: `roleId`, `key`, `permissionsAdded[]` (vazio em criação sem `permissions[]`) |
| `RoleUpdated` | `role.updated` | Commit de ROL-05, ROL-06 ou ROL-08 | Payload: `roleId`, `key`, `permissionsAdded[]`, `permissionsRemoved[]` (vazios quando a alteração é só de metadados ou de `isActive`) |

Consumidor: `PermissionCacheInvalidator` (routing `role.*`), que invalida o cache Redis de permissões efetivas dos vínculos com atribuição ativa do perfil (DEC-134).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: alterar um perfil (template) não notifica usuários diretamente — o aviso de segurança `ROLE_CHANGED` só é disparado quando a atribuição de alguém muda (`RoleAssigned`/`RoleRevoked`, US-096). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerenciar perfis e matriz de permissões

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And os 15 perfis padrão estão semeados
    And "Ana" possui o perfil "ADMIN_ORGAO" com escopo "TENANT"

  Scenario: [Sucesso] Criar perfil personalizado
    When "Ana" criar o perfil "Fiscal de Obras" sem permissões iniciais
    Then o perfil deve ser criado com "isSystem" igual a falso
    And a API deve responder 201 com "ETag" igual a "1"
    And deve gerar o evento "RoleCreated"

  Scenario: [Sucesso] Atualizar a matriz de permissões
    Given que existe o perfil "Fiscal de Obras" na versão 1
    And "Ana" possui a permissão "SUPPLIER_VIEW"
    When "Ana" marcar "SUPPLIER_VIEW" na matriz do perfil e salvar com "If-Match: \"1\""
    Then a API deve responder 200 com "ETag" igual a "2"
    And deve gerar o evento "RoleUpdated" com "permissionsAdded" contendo "SUPPLIER_VIEW"
    And deve gerar registro de auditoria "role.permissions_update"

  Scenario: [Validação] Nome fora do tamanho mínimo
    When "Ana" tentar criar um perfil com nome "Fi"
    Then o sistema deve exibir "Informe um nome entre 3 e 120 caracteres."
    And nenhum perfil deve ser criado

  Scenario: [Permissão] Anti-escalonamento ao conceder permissão não possuída
    Given que "Carlos" possui o perfil "REQUISITANTE" com "ROLE_MANAGE" mas sem "SETTINGS_MANAGE"
    When "Carlos" tentar adicionar "SETTINGS_MANAGE" à matriz de um perfil
    Then a API deve responder 403 com código "PRIVILEGE_ESCALATION_FORBIDDEN"
    And nenhuma alteração deve ser persistida na matriz

  Scenario: [Permissão] Proteção do ADMIN_ORGAO
    When "Ana" tentar remover a permissão "USER_MANAGE" do perfil "ADMIN_ORGAO"
    Then a API deve responder 422 com código "BUSINESS_RULE_VIOLATION"
    And a matriz do perfil "ADMIN_ORGAO" não deve perder "USER_MANAGE"

  Scenario: [Tenant incorreto] Perfil de outro tenant
    Given que existe o perfil "Fiscal de Obras" no tenant "Prefeitura B"
    When "Ana", no tenant "Prefeitura de São José", chamar "GET /roles/{id}" com o id desse perfil
    Then a API deve responder 404 com código "ROLE_NOT_FOUND"

  Scenario: [Duplicidade] Nome de perfil já existente
    Given que já existe o perfil "Fiscal de Obras"
    When "Ana" tentar criar outro perfil com nome "fiscal de obras"
    Then a API deve responder 409 com código "ROLE_ALREADY_EXISTS"

  Scenario: [Concorrência] Edição concorrente da matriz
    Given que o perfil "Fiscal de Obras" está na versão 2
    When "Ana" enviar "PUT /roles/{id}/permissions" com "If-Match: \"1\""
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And o corpo deve conter "currentVersion" igual a 2

  Scenario: [Falha de banco] Banco indisponível ao desativar perfil
    Given que o banco de dados fica indisponível durante a desativação
    When "Ana" tentar desativar o perfil "Fiscal de Obras"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o perfil deve permanecer com "isActive" igual a verdadeiro

  Scenario: [Falha de integração] Relay do outbox indisponível ao atualizar perfil
    Given que o relay do outbox está indisponível
    When "Ana" atualizar a matriz de um perfil
    Then a alteração deve ser persistida e a API deve responder 200
    And o evento "RoleUpdated" deve permanecer "PENDING" no outbox até o relay voltar
    And o cache de permissões dos vínculos afetados pode ficar desatualizado por até 5 minutos (TTL do cache) até a invalidação ser processada
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Nome inválido/ausente | 422 | `VALIDATION_ERROR` | "Informe um nome entre 3 e 120 caracteres." | Erro no campo |
| Nome/chave duplicados | 409 | `ROLE_ALREADY_EXISTS` | "Já existe um perfil com esse nome." | Erro no campo "Nome" |
| Permissão inexistente no catálogo | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Selecione permissões válidas." | Recarrega catálogo |
| Anti-escalonamento | 403 | `PRIVILEGE_ESCALATION_FORBIDDEN` | "Você não pode conceder uma permissão que você mesmo não possui." | Interruptor permanece desmarcado |
| Remoção de permissão protegida | 422 | `BUSINESS_RULE_VIOLATION` | "Esta permissão é protegida e não pode ser removida do Administrador do órgão." | Interruptor volta a marcado |
| Último administrador | 409 | `LAST_ADMIN_REQUIRED` | "Mantenha ao menos um administrador ativo." | Botão "Desativar" oculto em `ADMIN_ORGAO` |
| MFA exigido | 403 | `MFA_REQUIRED` | "Confirme sua identidade para continuar." | Dispara *step-up* |
| Perfil não encontrado/outro tenant | 404 | `ROLE_NOT_FOUND` | "Perfil não encontrado." | Redireciona para a lista |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente novamente." | Recarrega o recurso |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Este perfil foi alterado por outra pessoa. Recarregue para ver a versão atual." | Recarrega e destaca o conflito |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerenciar perfis." | Ações ocultas |
| Banco/Redis crítico indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém dados; botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-094 (catálogo e seeds dos 15 perfis, pré-requisito); US-097 (`AuthorizationService`, enforcement e predicado de visibilidade reutilizável na UI); US-096 (atribuição de perfis a vínculos, consumidora direta dos perfis geridos aqui); US-090 (MFA/*step-up*, usado pela RN-IAM-83); US-092 (gestão de usuários, aplica POL-12/16 de forma análoga em vínculos).
- **Decisões/ADRs:** DEC-035, DEC-134, DEC-133, DEC-104 (`If-Match`/`ETag`).
- **Configurações:** `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:** nenhuma (duplicidade → `ROLE_ALREADY_EXISTS` (409), api.md §2.2, no padrão `*_ALREADY_EXISTS`; reativação de perfil fora do MVP 1 — alternativa: duplicar o perfil desativado, ROL-07).

## Impacto técnico
- Reutiliza o padrão de comando transacional (US-001): validação → autorização (`ROLE_MANAGE` + POL-12/13/14) → domínio → `RolePermission` → `AuditService` → `OutboxWriter` → commit.
- A checagem de POL-13 exige carregar as permissões efetivas do próprio ator (via `AuthorizationService`, US-097) antes de validar o payload — acoplamento direto com a story de enforcement.
- Invalidação de cache é *fire-and-forget* via outbox/evento (não bloqueia a resposta da mutação); o pior caso é permissões efetivas desatualizadas por até o TTL do cache (5 min).

## Backend
- **Módulo(s):** `access` (dono); usa `audit` (`AuditService`), `platform` (`OutboxWriter`), e a leitura de permissões efetivas do ator via `AuthorizationService` (US-097).
- **Casos de uso:** `CreateRoleCommand`, `UpdateRoleCommand`, `UpdateRolePermissionsCommand`, `DuplicateRoleCommand`, `DeactivateRoleCommand` (e seus handlers); `ListRolesQuery`, `GetRoleQuery`.
- **Domínio:** `Role.create(props)` (RN-IAM-80), `Role.updatePermissions(codes, actorPermissions)` (RN-IAM-81/82), `Role.deactivate(activeAdminCount)` (RN-IAM-84), `Role.duplicate()` (RN-IAM-86).
- **Integrações internas:** `AuthorizationService.getEffectivePermissions(actorMembershipId)` para POL-13; `AuthorizationService.countActiveAssignments('ADMIN_ORGAO')` para POL-12.
- **Transação:** cada comando (ROL-03/05/06/07/08) é atômico: validação + domínio + `RolePermission` (diff) + auditoria + outbox (`RoleCreated`/`RoleUpdated`) em uma transação com `app.tenant_id`.

## Frontend
- **Tela(s):** SCR-030 (`/admin/perfis`, lista) e SCR-031 (`/admin/perfis/[roleId]`, matriz).
- **Componentes:** `RoleList` (com contagem de vínculos ativos), `RoleForm` (nome/descrição/`allowExternalAssignment`), `PermissionMatrix` (interruptores agrupados por módulo, com `RiskLevelBadge` e estado desabilitado para permissões fora do alcance do ator ou protegidas), `DeactivateRoleDialog` (confirmação com contagem de vínculos afetados), `DuplicateRoleButton`.
- **Dados:** TanStack Query — `['t', tenantId, 'roles']`, `['t', tenantId, 'roles', roleId]`, `['t', tenantId, 'permissions']` (staleTime alto); `useMutation` por comando, invalidando `roles`/`roles[id]` e `['t', tenantId, 'me', 'permissions']` quando o perfil do próprio ator for afetado.
- **Estados:** skeleton na lista/matriz; vazio ("Nenhum perfil personalizado ainda" — os 15 padrão sempre existem); erro com "Tentar novamente"; botões com estado de carregamento; interruptores desabilitados (não ocultos) para permissões fora do alcance do ator, com tooltip explicando o motivo.
- **Acessibilidade e responsividade:** matriz navegável por teclado (grade de interruptores com `role="switch"` e rótulos associados); confirmações de desativação anunciadas via `aria-live`; matriz com rolagem horizontal e cabeçalho fixo em telas estreitas.

## Banco de dados
- **Tabelas:** `roles`, `role_permissions`, `role_assignments` (somente leitura, para contagem de vínculos ativos), `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma nova (reutiliza `roles`/`role_permissions` de US-094/entities.md).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, key)`, `UNIQUE (tenant_id, lower(name))` em `roles`; PK composta em `role_permissions`; índice `(tenant_id, role_id) WHERE revoked_at IS NULL` em `role_assignments` para a contagem de vínculos ativos.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| ROL-02 | GET | `/api/v1/roles` | Query: `search?`, `isActive?` | `200 { data: Role[] }` com `id`, `key`, `name`, `isSystem`, `isProtected`, `allowExternalAssignment`, `isActive`, `activeAssignmentsCount`, `version` | 200, 401, 403 |
| ROL-03 | POST | `/api/v1/roles` | `{ name, description?, allowExternalAssignment?, permissions?: string[] }` | `201 { data: Role }` com `Location`, `ETag: "1"` | 201, 401, 403, 422 |
| ROL-04 | GET | `/api/v1/roles/{id}` | — | `200 { data: Role & { permissions: string[] } }` com `ETag` | 200, 401, 403, 404 |
| ROL-05 | PATCH | `/api/v1/roles/{id}` | `{ name?, description?, allowExternalAssignment? }` + `If-Match` | `200 { data: Role }` com `ETag` | 200, 401, 403, 404, 409, 412, 422, 428 |
| ROL-06 | PUT | `/api/v1/roles/{id}/permissions` | `{ permissions: string[] }` + `If-Match` | `200 { data: Role & { permissions: string[] } }` com `ETag` | 200, 401, 403, 404, 412, 422, 428 |
| ROL-07 | POST | `/api/v1/roles/{id}/duplicate` | `{}` | `201 { data: Role }` com `Location`, `ETag: "1"` | 201, 401, 403, 404, 422 |
| ROL-08 | POST | `/api/v1/roles/{id}/deactivate` | `{ confirmDeactivate? }` + `If-Match` | `200 { data: Role }` com `ETag` | 200, 401, 403, 404, 409, 412, 428 |

## Logs
- `info` `role.created` / `role.updated` — `roleId`, `key`, `actorId`, `permissionsAdded.length`, `permissionsRemoved.length`, `correlationId`.
- `warn` `role.permission_cache_invalidation_delayed` — quando o outbox atrasa a publicação além de 30 s.
- `error` `role.update_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** fora dos eventos acima, não registrar em nível `info` a lista de permissões efetivas de outros usuários.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `role.create` | `SECURITY` | Commit de ROL-03 | `changes`: `name`, `description`, `allowExternalAssignment`; `metadata`: `permissionsGranted[]` |
| `role.update` | `SECURITY` | Commit de ROL-05 | `changes`: campos alterados (`name`/`description`/`allowExternalAssignment`) |
| `role.permissions_update` | `SECURITY` | Commit de ROL-06 | `metadata`: `permissionsAdded[]`, `permissionsRemoved[]` |
| `role.deactivate` | `SECURITY` | Commit de ROL-08 | `metadata`: `activeAssignmentsAffected` |
| `access.denied` | `ACCESS` | Tentativa sem `ROLE_MANAGE`/`ROLE_VIEW` ou violação de POL-12/13 | `reasonCode`, `roleId` |

## Testes necessários
- **Unitários:** `Role.create`/`updatePermissions`/`deactivate`/`duplicate` (RN-IAM-80..87); geração de `key` a partir do nome; diff de permissões.
- **Integração (Testcontainers PostgreSQL + Redis):** POL-12 bloqueando desativação de `ADMIN_ORGAO`; POL-13 bloqueando concessão acima do próprio ator; proteção de `ADMIN_ORGAO` (RN-IAM-82); invalidação de cache via `PermissionCacheInvalidator` após `RoleUpdated`.
- **API/contrato:** respostas e erros conforme api.md; cabeçalhos `Location`, `ETag`, `If-Match`.
- **RBAC e multi-tenant:** matriz `ROLE_VIEW`/`ROLE_MANAGE` por perfil; perfil de outro tenant → 404 `ROLE_NOT_FOUND`.
- **Concorrência:** duas edições simultâneas da matriz do mesmo perfil → uma 200, outra 412 `VERSION_CONFLICT`.
- **E2E (Playwright):** criar perfil → ajustar matriz → duplicar → desativar, incluindo o bloqueio ao tentar desativar `ADMIN_ORGAO` e o *step-up* de MFA da RN-IAM-83.
- **Acessibilidade/performance:** axe na matriz de permissões; k6 em `PUT /roles/{id}/permissions` → p95 < 300 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] POL-12 e POL-13 aplicadas na API e refletidas na UI (interruptores desabilitados, botão de desativar oculto em `ADMIN_ORGAO`)
- [ ] Proteção de `ADMIN_ORGAO` (RN-IAM-82) coberta por teste de integração
- [ ] Auditoria `role.create`/`role.update`/`role.permissions_update`/`role.deactivate` e eventos `RoleCreated`/`RoleUpdated` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de ROL-02..08 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas e traces presentes
- [ ] Matriz de permissões acessível (axe) e responsiva
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — o CRUD de perfil é direto, mas as políticas de segurança (POL-12/13/14), a proteção do `ADMIN_ORGAO` e a invalidação de cache elevam a complexidade de teste.

## Prioridade
**P0** — sem gestão de perfis, os 15 perfis semeados por US-094 seriam fixos, o que não atende às particularidades de cada órgão e bloqueia a atribuição personalizada (US-096).
