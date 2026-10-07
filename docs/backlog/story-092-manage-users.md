---
id: US-092
title: "Gerenciar usuários e lotações"
epic: EP-016
feature: FT-052
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-091]
modules: [identity]
screens: [SCR-029]
endpoints: [USR-01, USR-07, USR-08, USR-09, USR-10, USR-11, USR-12]
permissions: [USER_VIEW, USER_MANAGE]
events: [MembershipUpdated, MembershipSuspended, MembershipReactivated, MembershipRevoked]
---

# US-092 — Gerenciar usuários e lotações

## Título
Gerenciar usuários e lotações

## Descrição
**Como** administrador do órgão, **quero** visualizar, editar, lotar, suspender, reativar e revogar os vínculos dos usuários do meu tenant, **para** manter o quadro de acesso correto conforme movimentações de pessoal, sem depender de suporte da plataforma.

A tela de usuários (SCR-029) lista os vínculos (`TenantMembership`) do tenant com busca e filtros, e o detalhe permite editar cargo/matrícula, redefinir as lotações e mudar o status do vínculo. Nome, e-mail e demais dados de identidade continuam sendo globais (`User`, DEC-012) e não são editados aqui.

## Contexto
- Hoje, bloquear o acesso de um servidor que saiu do órgão depende de abrir chamado com a plataforma; isso cria uma janela de risco de acesso indevido.
- DEC-012 separa identidade global (`User`) de vínculo por tenant (`TenantMembership`); esta story cobre o ciclo de vida do vínculo depois que ele já existe (criado pelo convite — US-091).
- POL-12 (anti-bloqueio) e POL-16 (autoproteção) existem porque, historicamente, remover o próprio acesso ou o do último administrador por engano já causou órgãos sem ninguém habilitado a corrigir a situação.

## Objetivo
Permitir que `ADMIN_ORGAO` mantenha o quadro de usuários 100% refletindo a realidade (lotação, cargo, status) sem suporte externo, com efeito imediato (cache e sessão) e sem nunca deixar o tenant sem administrador ativo.

## Persona
- **Principal:** Administrador do órgão (perfil `ADMIN_ORGAO`, escopo `TENANT`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`) com `USER_VIEW` para consulta.

## Pré-condições
- Usuário autenticado (US-087), tenant `ACTIVE`, vínculo `ACTIVE`.
- Existe ao menos um vínculo `TenantMembership` ativado por convite (US-091).
- Ator possui `USER_VIEW` (consulta) ou `USER_MANAGE` (edição) — permissions.md §2.6.

## Fluxo principal
1. O administrador acessa **Administração › Usuários** (SCR-029), que lista vínculos (`USR-01`) com nome, e-mail, cargo, lotação principal, tipo e status, com busca e filtros por status/tipo/lotação.
2. Ao abrir um usuário, o sistema carrega o detalhe (`USR-07`): dados globais (somente leitura: nome, nome social, e-mail), dados do vínculo (cargo, matrícula, tipo, status, validade se `EXTERNAL`) e lotações.
3. O administrador edita cargo/matrícula e clica em **"Salvar"**; o front envia `PATCH /users/{userId}` com `If-Match` → `USR-08`.
4. Para alterar lotações, usa o seletor em árvore (marca a lotação principal) e salva; o front envia `PUT /users/{userId}/departments` → `USR-09`.
5. Para suspender, clica em **"Suspender acesso"**, informa motivo (opcional) e confirma; `POST /users/{userId}/suspend` → `USR-10`.
6. Para reativar um vínculo suspenso, clica em **"Reativar"**; `POST /users/{userId}/reactivate` → `USR-11`.
7. Para revogar definitivamente, clica em **"Revogar vínculo"**, confirma o aviso de irreversibilidade e informa motivo (opcional); `POST /users/{userId}/revoke` → `USR-12`.
8. Em qualquer mutação, a API valida, aplica POL-12/16 quando se aplica, grava o evento e a auditoria, invalida o cache de permissões do vínculo (permissions.md §1.2) e responde com o recurso atualizado e novo `ETag`.
9. O front atualiza lista e detalhe sem recarregar a página, exibindo toast de confirmação.

## Fluxos alternativos
- **FA-01 — Vínculo `EXTERNAL`:** o detalhe exibe e permite editar `expiresAt` (até `security.externalMembershipMaxDays` a partir de hoje); ao expirar, o job `maintenance` já revoga via `MembershipExpired` (fora desta story).
- **FA-02 — Buscar usuário inexistente/de outro tenant:** `USR-07`/mutações retornam 404 (DEC-024/api.md §1.5) sem indicar que o usuário existe em outro tenant.
- **FA-03 — Tentar suspender/revogar o próprio vínculo:** botões ficam desabilitados com tooltip "Você não pode remover o próprio acesso" (POL-16); a API bloqueia mesmo se a UI for contornada.
- **FA-04 — Última lotação removida:** `USR-09` exige ao menos uma lotação; lista vazia é bloqueada no front antes de enviar.
- **FA-05 — Reduzir lotações de quem é responsável atual de processos:** permitido (sem bloqueio de negócio no MVP 1); a visibilidade por histórico (`access.historicalDepartmentsCanView`) preserva o acesso a processos já tramitados.

## Regras de negócio
- **RN-IAM-54** — Esta story opera sobre `TenantMembership`/`MembershipDepartment`; os campos globais de `User` (nome, nome social, e-mail, CPF, telefone) são somente leitura aqui (DEC-012) e geridos pelo próprio usuário (US-098) ou pelo Authentik.
- **RN-IAM-55** — `USR-08` edita `jobTitle` (≤150), `registrationNumber` (≤40) e, somente para `type = EXTERNAL`, `expiresAt` (hoje < `expiresAt` ≤ hoje + `security.externalMembershipMaxDays`). `type` e `invitedById` são imutáveis.
- **RN-IAM-56** — `USR-09` substitui o conjunto de lotações do vínculo: ≥1 unidade **ativa** do tenant, exatamente uma marcada `isPrimary`.
- **RN-IAM-57** — Suspender (`USR-10`) exige vínculo `ACTIVE`, POL-12 e POL-16; `suspensionReason` opcional (≤500).
- **RN-IAM-58** — Reativar (`USR-11`) exige vínculo `SUSPENDED` e tenant `ACTIVE`; limpa `suspendedAt`/`suspensionReason`.
- **RN-IAM-59** — Revogar (`USR-12`) exige vínculo não `REVOKED`, POL-12 e POL-16; `revocationReason` opcional (≤500); é definitivo — reverter exige novo convite (US-091).
- **RN-IAM-60** — Revogar encerra as sessões ativas do usuário naquele tenant e retira o tenant da lista utilizável em `ME-04`.
- **RN-IAM-61** — Toda mutação de vínculo/lotação invalida de imediato o cache de permissões efetivas do `membershipId` (permissions.md §1.2), além da expiração natural de 5 min.
- **RN-IAM-62** — `USR-01` é filtrável por nome/e-mail (busca ≥2 caracteres), `status`, `type` e lotação; só retorna vínculos do tenant ativo (RLS).
- **RN-IAM-63** — Toda mutação exige `If-Match` com a `version` atual; divergência → `VERSION_CONFLICT` (412).
- **RN-IAM-64** — Vínculo `EXTERNAL` com `expiresAt` no passado aparece como "Expirado" na listagem mesmo antes do job `maintenance` processar `MembershipExpired`.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nome / E-mail (leitura) | `name`/`socialName`/`email` | texto | — | RN-IAM-54 | `User` |
| Cargo/função | `jobTitle` | texto curto | Não | ≤150 caracteres | — |
| Matrícula | `registrationNumber` | texto curto | Não | ≤40 caracteres | — |
| Validade (só `EXTERNAL`) | `expiresAt` | data | Condicional | RN-IAM-55 | definida no convite |
| Lotações | `departmentIds` | seleção em árvore (múltipla) | Sim (`USR-09`) | ≥1, ativas, do tenant | lotação atual |
| Lotação principal | `primaryDepartmentId` | seleção | Sim (`USR-09`) | ∈ `departmentIds` | lotação principal atual |
| Motivo da suspensão | `suspensionReason` | texto longo | Não | ≤500 caracteres | — |
| Motivo da revogação | `revocationReason` | texto longo | Não | ≤500 caracteres | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `jobTitle`/`registrationNumber`/motivo acima do limite | Front + API | "O {campo} deve ter no máximo N caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-02 | `expiresAt` fora do intervalo para `EXTERNAL` | Front + API | "Informe uma validade entre hoje e {max} dias." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-03 | Lotação inexistente/inativa/outro tenant | API | "Selecione uma lotação válida." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-04 | `departmentIds` vazio | Front + API | "Selecione ao menos uma lotação." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-05 | `primaryDepartmentId` fora de `departmentIds` | API | "A lotação principal deve estar entre as selecionadas." | `VALIDATION_ERROR` (`INVALID_ENUM`) |

## Permissões
- **Permissão:** `USER_VIEW` (listar/ver) e `USER_MANAGE` (editar/lotar/suspender/reativar/revogar) — ambas sem escopo de processo, válidas em `TENANT` (permissions.md §2.6).
- **Políticas:** POL-12 (anti-bloqueio — mantém ≥1 `ADMIN_ORGAO` `ACTIVE`) e POL-16 (autoproteção — não suspende/revoga o próprio vínculo) em `USR-10`/`USR-12`.
- **MFA:** `USER_MANAGE` é risco `H` — exige MFA quando `security.mfaPolicy` ∈ {`ADMINS`, `ALL`} (POL-14).
- **Sem permissão:** menu "Usuários" e a rota ficam ocultos sem `USER_VIEW`; botões de edição ficam ocultos sem `USER_MANAGE`; API responde 403 `PERMISSION_DENIED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `MembershipUpdated` | `membership.updated` | Commit de `USR-08`/`USR-09` | `changedFields[]` inclui `departments` quando via `USR-09` |
| `MembershipSuspended` | `membership.suspended` | Commit de `USR-10` | `hasReason` |
| `MembershipReactivated` | `membership.reactivated` | Commit de `USR-11` | — |
| `MembershipRevoked` | `membership.revoked` | Commit de `USR-12` | `hasReason`; dispara encerramento de sessões |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: events.md §6 não define `NotificationType` para eventos de `membership`; o usuário percebe a mudança no próximo acesso. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerenciar usuários e lotações

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And "Carla" tem vínculo "ACTIVE" com o perfil "ADMIN_ORGAO" e escopo "TENANT"
    And "Diego" tem vínculo "ACTIVE" lotado no "Setor de Compras"

  Scenario: [Sucesso] Atualizar cargo e lotação de um usuário
    When "Carla" editar o cargo de "Diego" para "Coordenador de Compras" e mover sua lotação principal para "Setor de Licitações"
    Then o vínculo de "Diego" deve ser atualizado
    And deve gerar o evento "MembershipUpdated" com "changedFields" incluindo "departments"
    And deve gerar registro de auditoria "membership.departments_update"
    And o cache de permissões efetivas de "Diego" deve ser invalidado

  Scenario: [Validação] Remover todas as lotações
    When "Carla" tentar salvar as lotações de "Diego" sem nenhuma unidade selecionada
    Then o sistema deve exibir "Selecione ao menos uma lotação."
    And a API, se chamada diretamente, deve responder 422 com código "VALIDATION_ERROR" no campo "departmentIds"

  Scenario: [Permissão] Usuário sem USER_MANAGE tenta suspender
    Given que "Elisa" possui apenas "USER_VIEW"
    When "Elisa" enviar "POST /users/{id}/suspend" para "Diego"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com "reasonCode" "USER_MANAGE"

  Scenario: [Tenant incorreto] Usuário de outro tenant
    Given que "Fábio" só tem vínculo no tenant "Prefeitura B"
    When "Carla" tentar abrir o detalhe de "Fábio" no tenant "Prefeitura de São José"
    Then a API deve responder 404 com código "USER_NOT_FOUND"
    And a resposta não deve revelar que "Fábio" existe em outro tenant

  Scenario: [Duplicidade] Suspender vínculo já suspenso
    Given que o vínculo de "Diego" já está "SUSPENDED"
    When "Carla" enviar novamente "POST /users/{id}/suspend"
    Then a API deve responder 409 com código "INVALID_STATE"
    And nenhum novo evento "MembershipSuspended" deve ser gravado

  Scenario: [Concorrência] Edição simultânea do mesmo vínculo
    Given que dois administradores abriram o detalhe de "Diego" com a mesma "version"
    When ambos salvarem alterações de lotação quase ao mesmo tempo
    Then a segunda requisição deve receber 412 com código "VERSION_CONFLICT"
    And a tela deve recarregar o vínculo atual antes de permitir nova tentativa

  Scenario: [Falha de banco] Banco indisponível ao revogar
    Given que o banco de dados fica indisponível durante "POST /users/{id}/revoke"
    When "Carla" confirmar a revogação de "Diego"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o vínculo de "Diego" deve permanecer no status anterior

  Scenario: [Falha de integração] Redis indisponível ao invalidar cache
    Given que o Redis de cache está indisponível
    When "Carla" suspender o vínculo de "Diego"
    Then o vínculo deve ser suspenso normalmente no banco
    And deve ser registrado log "warn" "access.cache_invalidation_failed"
    And a permissão de "Diego" deve ser recalculada do banco na próxima verificação
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Vínculo inexistente/outro tenant/não visível | 404 | `USER_NOT_FOUND` | "Usuário não encontrado." | Volta à lista |
| Sem `USER_VIEW`/`USER_MANAGE` | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta/desabilita ação |
| Suspender/revogar o próprio vínculo | 403 | `PERMISSION_DENIED` (POL-16) | "Você não pode remover o próprio acesso." | Botão desabilitado com tooltip |
| Último `ADMIN_ORGAO` | 409 | `LAST_ADMIN_REQUIRED` | "É preciso manter ao menos um administrador ativo." | Mantém o vínculo; sugere promover outro usuário antes |
| Ação incompatível com o status atual | 409 | `INVALID_STATE` | "Esta ação não é válida para o status atual do vínculo." | Atualiza a tela com o status real |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Os dados foram alterados por outra pessoa. Recarregue." | Recarrega o detalhe |
| Banco/Redis crítico indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente." | Mantém dados; botão "Tentar novamente" |

## Dependências
- **Stories:** US-091 (cria o vínculo convidado que esta story gerencia); US-097 (autorização e cache de permissões); US-102 (unidades/lotações).
- **Decisões/ADRs:** DEC-012, DEC-024, DEC-104, DEC-134.
- **Configurações:** `security.externalMembershipMaxDays`.
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- Reaproveita o padrão de comando transacional (contexto de tenant + auditoria + outbox) estabelecido em US-001.
- `USR-09` substitui a coleção `MembershipDepartment` em bloco (delete + insert) na mesma transação de `MembershipUpdated`, preservando `UNIQUE (tenant_id, membership_id, department_id)`.
- POL-12 exige uma contagem de `ACTIVE` `ADMIN_ORGAO` antes de confirmar `USR-10`/`USR-12`, com bloqueio (`FOR UPDATE` ou equivalente) para evitar corrida com outra revogação simultânea.

## Backend
- **Módulo(s):** `identity` (dono); usa `access` (invalidação de cache, POL-12/16), `organization` (validação de lotações), `platform` (`AuditService`, `OutboxWriter`).
- **Casos de uso:** `UpdateMembershipCommand`, `UpdateMembershipDepartmentsCommand`, `SuspendMembershipCommand`, `ReactivateMembershipCommand`, `RevokeMembershipCommand`.
- **Domínio:** `TenantMembership.updateProfile(...)`, `.replaceDepartments(...)`, `.suspend(reason?)`, `.reactivate()`, `.revoke(reason?)`, com guarda de POL-12/16 no serviço de aplicação.
- **Transação:** cada comando é atômico: validação → política → mutação → projeção de cache → `AuditService` → `OutboxWriter` → commit.

## Frontend
- **Tela(s):** SCR-029 (`/admin/usuarios` e `/admin/usuarios/[userId]`).
- **Componentes:** `UserList` (busca, filtros, paginação), `UserDetailForm`, `DepartmentTreeMultiSelect` (com destaque da principal), `ConfirmDialog` (suspender/revogar com motivo), `StatusBadge`.
- **Estados:** skeleton na lista/detalhe; vazio ("Nenhum usuário encontrado"); erro com "Tentar novamente"; botões de ação conforme `allowedActions` do detalhe.
- **Acessibilidade e responsividade:** foco no primeiro campo do formulário ao abrir; confirmações com `role="alertdialog"`; lista colapsa para cartões em telas < 768 px.

## Banco de dados
- **Tabelas:** `tenant_memberships`, `membership_departments`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma (usa entities.md §4.2 já existente).
- **Índices/constraints relevantes:** `(tenant_id, status)` em `tenant_memberships`; `UNIQUE (tenant_id, membership_id, department_id)` e `UNIQUE (tenant_id, membership_id) WHERE is_primary` em `membership_departments`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| USR-01 | GET | `/users` | `?q=&status=&type=&departmentId=&page=` | `200 { data: [User+membership], meta }` | 200, 403 |
| USR-07 | GET | `/users/{userId}` | — | `200 { data: {...} }` com `ETag` | 200, 403, 404 |
| USR-08 | PATCH | `/users/{userId}` | `{ jobTitle?, registrationNumber?, expiresAt? }` + `If-Match` | `200 { data }` | 200, 403, 404, 412, 422 |
| USR-09 | PUT | `/users/{userId}/departments` | `{ departmentIds[], primaryDepartmentId }` + `If-Match` | `200 { data }` | 200, 403, 404, 412, 422 |
| USR-10 | POST | `/users/{userId}/suspend` | `{ reason? }` + `If-Match` | `200 { data }` | 200, 403, 404, 409, 412 |
| USR-11 | POST | `/users/{userId}/reactivate` | `{}` + `If-Match` | `200 { data }` | 200, 403, 404, 409, 412 |
| USR-12 | POST | `/users/{userId}/revoke` | `{ reason? }` + `If-Match` | `200 { data }` | 200, 403, 404, 409, 412 |

## Logs
- `info` `membership.mutation` — `membershipId`, `action`, `durationMs`.
- `warn` `access.cache_invalidation_failed` — quando o Redis falhar.
- `error` `membership.mutation_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** e-mail completo, CPF, motivos de suspensão/revogação em texto livre.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `membership.update` | `SECURITY` | Commit de `USR-08` | `changes`: campos alterados |
| `membership.departments_update` | `SECURITY` | Commit de `USR-09` | `changes`: lotações anteriores/novas |
| `membership.suspend` | `SECURITY` | Commit de `USR-10` | `metadata.hasReason` |
| `membership.reactivate` | `SECURITY` | Commit de `USR-11` | — |
| `membership.revoke` | `SECURITY` | Commit de `USR-12` | `metadata.hasReason` |
| `access.denied` | `ACCESS` | Tentativa sem permissão/política | `reasonCode` |

## Testes necessários
- **Unitários:** guardas POL-12 (contagem de admins) e POL-16 (auto-vínculo); validação de lotações (RN-IAM-56).
- **Integração (Testcontainers):** substituição atômica de `MembershipDepartment`; RLS isola tenants; cache invalidado após cada mutação.
- **API/contrato:** respostas e `ETag`/`If-Match` conforme api.md.
- **RBAC e multi-tenant:** matriz `USER_VIEW`/`USER_MANAGE`; acesso a vínculo de outro tenant → 404.
- **Concorrência:** duas suspensões simultâneas do último admin → só uma permitida, a outra recebe `LAST_ADMIN_REQUIRED`.
- **E2E (Playwright):** editar cargo, trocar lotação, suspender e reativar um usuário de teste.
- **Acessibilidade/performance:** axe sem violações sérias; p95 < 400 ms nas mutações.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados e passando no CI
- [ ] POL-12 e POL-16 cobertos por teste de violação e de sucesso
- [ ] Cache de permissões invalidado e verificado em teste de integração
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de USR-01/07..12 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas de latência por ação
- [ ] Acessibilidade (axe) e responsividade (360 px) verificadas
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — CRUD de vínculo com várias transições de status e duas políticas de segurança (POL-12/16), mas sem lógica de domínio complexa nova.

## Prioridade
**P0** — sem gerenciar usuários, o tenant não consegue corrigir seu próprio quadro de acesso após o provisionamento inicial.
