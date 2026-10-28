---
id: US-090
title: "Política de MFA por tenant com step-up"
epic: EP-016
feature: FT-051
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-087, US-097]
modules: [identity, access, platform]
screens: [SCR-029, SCR-039]
endpoints: [USR-13]      # step-up é rota do BFF; SET-02 pertence a US-103
permissions: [USER_MANAGE]
events: []              # consome TenantSettingsChanged (US-103); não gera evento de domínio novo
---

# US-090 — Política de MFA por tenant com step-up

## Título
Política de MFA por tenant com step-up

## Descrição
**Como** administrador do órgão, **quero** que o segundo fator seja exigido conforme a política do meu tenant e poder redefinir o MFA de um usuário que perdeu o dispositivo, **para** elevar a segurança de ações sensíveis sem depender só de senha.

**Como** usuário autenticado, **quero** ser desafiado a confirmar o segundo fator apenas quando a ação exigir, **para** não reautenticar em cada clique.

A política (`security.mfaPolicy`: `NONE`/`ADMINS`/`ALL`) é avaliada a cada requisição com permissão de risco alto (POL-14); sem o segundo fator comprovado, a API responde 403 `MFA_REQUIRED` e o frontend aciona o *step-up* (`/api/auth/step-up`), que reautentica no Authentik exigindo TOTP/WebAuthn sem repetir a senha nem derrubar a sessão.

## Contexto
- DEC-133 define MFA no Authentik (TOTP/WebAuthn) e a política por tenant; DEC-134/POL-14 definem o gate por `riskLevel`. Esta story operacionaliza as duas: verificação do `amr`, *step-up* e administração da política e da recuperação.
- Em auditorias de controle interno, perfis com poder de aprovar ou alterar permissões usando só senha é um risco recorrente; exigir segundo fator nessas ações reduz o risco sem atrito no uso diário.
- Base: US-087 (login/sessão), US-097 (`AuthorizationService`/POL-14), US-103 (endpoint genérico de configurações que persiste `security.mfaPolicy`, fora deste épico).

## Objetivo
Garantir que toda ação com permissão `riskLevel = HIGH`, sob política `ADMINS` ou `ALL`, só se conclua com sessão que comprove o segundo fator — com o desafio de *step-up* completável em até 2 interações, sem novo login completo.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`) — define a política e redefine o MFA de usuários.
- **Secundárias:** Usuário com permissão `HIGH` (passa pelo *step-up*); usuário que perdeu o dispositivo de MFA.

## Pré-condições
- Usuário autenticado (US-087) com sessão válida.
- `AuthorizationService` (US-097) resolve `riskLevel` da permissão exercida e a política vigente do tenant.
- Authentik com TOTP e WebAuthn habilitados (*blueprint* — US-078).

## Fluxo principal
1. Um usuário sem o segundo fator satisfeito tenta uma ação coberta por permissão `HIGH` (ex.: `ROLE_ASSIGN`) com a política em `ADMINS` ou `ALL`.
2. A API (DEC-132) verifica o claim `amr`; não encontrando MFA, responde **403** `MFA_REQUIRED` e registra `auth.mfa_required` (SECURITY).
3. O frontend intercepta a resposta e navega para `GET /api/auth/step-up?returnTo=<ação atual>`.
4. O BFF redireciona ao Authentik forçando a etapa de MFA (sem repetir a senha); o usuário confirma com TOTP ou WebAuthn.
5. O Authentik volta a `GET /api/auth/callback`; o BFF troca o código, obtém um access token com `amr` atualizado, atualiza a sessão e redireciona a `returnTo`.
6. O frontend repete a ação original; a API encontra o `amr` satisfatório e conclui a operação.
7. Em paralelo, um administrador abre o usuário em **Administração › Usuários** (SCR-029) e aciona **"Redefinir autenticação em duas etapas"** (`USR-13`); o backend chama a API administrativa do Authentik para remover os fatores cadastrados.
8. No próximo desafio, o usuário é levado ao *enrollment* no Authentik antes de completar o *step-up*.

## Fluxos alternativos
- **FA-01 — Política `NONE`:** a verificação do passo 2 não ocorre; nenhuma ação exige MFA.
- **FA-02 — Política `ALL`:** toda sessão exige o segundo fator desde o primeiro acesso autenticado, não só nas ações `HIGH` (RN-IAM-39).
- **FA-03 — Mudança de política em sessão aberta:** ao consumir `TenantSettingsChanged` com `security.mfaPolicy`, o cache de permissões efetivas (US-097) é invalidado; a próxima ação `HIGH` passa a exigir *step-up*.
- **FA-04 — *Step-up* cancelado ou falho:** a sessão não é atualizada; a ação original continua bloqueada com `MFA_REQUIRED`.
- **FA-05 — Usuário sem fator cadastrado:** o Authentik conduz o *enrollment* antes de permitir a confirmação.
- **FA-06 — Administrador tenta redefinir o próprio MFA pela tela de usuários:** bloqueado (RN-IAM-43); deve usar o *step-up*/recuperação normal.

## Regras de negócio
- **RN-IAM-39** — Com `security.mfaPolicy = ADMINS`, a API exige MFA só quando a permissão exercida é `riskLevel = HIGH`; com `ALL`, toda requisição autenticada exige MFA desde o primeiro acesso; com `NONE`, o `amr` nunca é verificado (POL-14, DEC-133).
- **RN-IAM-40** — O claim `amr` (ou claim customizada do Authentik) é verificado no pipeline de contexto (DEC-132) a cada requisição sujeita à RN-IAM-39; ausência do fator → **403** `MFA_REQUIRED` + auditoria `auth.mfa_required`.
- **RN-IAM-41** — `GET /api/auth/step-up` preserva `returnTo` (validações de RN-IAM-03), força a etapa de MFA sem repetir a senha e, ao concluir, substitui o access/refresh token da sessão existente (sem novo login completo).
- **RN-IAM-42** — Alterações em `security.mfaPolicy` (`TenantSettingsChanged`, US-103) invalidam o cache de permissões efetivas (US-097) imediatamente; sessões abertas são avaliadas pela nova política na próxima requisição.
- **RN-IAM-43** — A redefinição administrativa do MFA (`USR-13`) exige `USER_MANAGE`, não pode ser sobre o próprio vínculo do administrador (autoproteção, mesmo espírito de POL-16) e gera auditoria `SECURITY`; remove os fatores no Authentik via API administrativa, forçando novo *enrollment*.
- **RN-IAM-44** — Métodos aceitos: TOTP e WebAuthn (DEC-133); o ContrataFlow não armazena segredos de MFA — só lê, via `/me`, se a sessão comprova o fator (derivado do `amr`), sem detalhar o dispositivo.
- **RN-IAM-45** — `GET /api/auth/step-up` segue o limite de 20 req/min por IP de `/api/auth/*` (RN-IAM-15) e responde com `Cache-Control: no-store` (RN-IAM-19).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Política de MFA | `security.mfaPolicy` | seleção (`NONE`\|`ADMINS`\|`ALL`) | — | Gerenciada em `SET-02` (US-103); esta story só consome | `ADMINS` |
| Segundo fator confirmado | *(derivado de `amr`)* | booleano (técnico) | — | Calculado pela API a cada requisição (RN-IAM-40) | — |
| Botão "Redefinir autenticação em duas etapas" | — | ação | — | Visível em SCR-029 para `USER_MANAGE`; oculto para o próprio usuário (RN-IAM-43) | — |
| Motivo da redefinição | `reason` | texto curto | Sim (`USR-13`) | 10–500 caracteres | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `amr` ausente/insuficiente para a permissão exigida | API | "Confirme sua identidade para continuar." | `MFA_REQUIRED` |
| V-02 | Redefinição sobre o próprio vínculo | API | "Para redefinir sua própria autenticação em duas etapas, use a recuperação no login." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-03 | `reason` ausente ou curto demais | Front + API | "Informe o motivo da redefinição (mín. 10 caracteres)." | `VALIDATION_ERROR` |
| V-04 | `returnTo` fora do padrão aceito | BFF (RN-IAM-03) | — (substituído por `/painel`) | — |

## Permissões
- **Permissão:** `USER_MANAGE` para redefinir o MFA de outro usuário (`USR-13`); nenhuma para o próprio *step-up* (capacidade implícita de sessão autenticada).
- **Políticas:** POL-14 (gate por `riskLevel`); autoproteção equivalente a POL-16 para `USR-13` (RN-IAM-43).
- **MFA:** tema desta story; `USR-13` é `riskLevel HIGH` e, portanto, também exige sessão com MFA do administrador quando a política for `ADMINS`/`ALL`.
- **Sem permissão:** botão oculto sem `USER_MANAGE`; API responde 403 `PERMISSION_DENIED`.

## Eventos gerados
Nenhum evento de domínio novo. Esta story **consome** `TenantSettingsChanged` (US-103, `tenant.settings_changed`) quando `keys[]` contém `security.mfaPolicy`, e gera apenas auditoria.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| MFA redefinido pelo administrador | Usuário afetado | E-mail | Após `USR-13`, avisando que precisará recadastrar o segundo fator |

## Critérios de aceite em Gherkin
```gherkin
Feature: Política de MFA por tenant com step-up

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And a política "security.mfaPolicy" é "ADMINS"

  Scenario: [Sucesso] Step-up ao tentar uma ação de risco alto
    Given que "Ana" tem o perfil "ADMIN_ORGAO" e sessão sem o segundo fator confirmado
    When "Ana" tentar atribuir um perfil via "ROLE_ASSIGN"
    Then a API deve responder 403 "MFA_REQUIRED"
    When "Ana" concluir o desafio de MFA em "/api/auth/step-up"
    And repetir a atribuição do perfil
    Then a ação deve ser concluída com sucesso

  Scenario: [Validação] Motivo ausente na redefinição administrativa
    When um administrador tentar redefinir o MFA de "Bruno" sem informar o motivo
    Then a API deve responder 422 "VALIDATION_ERROR" no campo "reason"

  Scenario: [Permissão] Usuário sem USER_MANAGE não redefine MFA de terceiros
    Given que "Carla" possui apenas o perfil "REQUISITANTE"
    When "Carla" enviar POST para o endpoint de redefinição de MFA de outro usuário
    Then a API deve responder 403 "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Redefinição de MFA de usuário sem vínculo no tenant do administrador
    When um administrador da "Prefeitura B" tentar redefinir o MFA de um usuário sem vínculo ali
    Then a API deve responder 404 "USER_NOT_FOUND"

  Scenario: [Duplicidade] Redefinições repetidas antes do próximo login
    Given que o MFA de "Bruno" já foi redefinido
    When um administrador acionar a redefinição novamente antes de "Bruno" recadastrar um fator
    Then a API deve concluir normalmente, sem erro, mantendo "Bruno" sem fator cadastrado

  Scenario: [Concorrência] Mudança de política durante uma sessão ativa
    Given que "Ana" está com sessão aberta e a política era "NONE"
    When um administrador alterar "security.mfaPolicy" para "ALL"
    Then a próxima requisição de "Ana" deve ser avaliada pela nova política
    And, sem o segundo fator, deve receber 403 "MFA_REQUIRED"

  Scenario: [Falha de banco] PostgreSQL indisponível durante o step-up
    Given que o PostgreSQL está indisponível
    When "Ana" concluir o desafio de MFA no Authentik e repetir a ação original
    Then a API deve responder 503 "DEPENDENCY_UNAVAILABLE"
    And nenhuma ação deve ser concluída parcialmente

  Scenario: [Falha de integração] Authentik indisponível no step-up
    Given que o Authentik está fora do ar
    When "Ana" acionar "/api/auth/step-up"
    Then o ContrataFlow deve exibir "O serviço de autenticação está indisponível. Tente novamente em instantes."
    And a sessão de "Ana" deve permanecer válida para ações que não exijam MFA
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sessão sem segundo fator para ação `HIGH` | 403 | `MFA_REQUIRED` | "Confirme sua identidade para continuar." | Aciona `/api/auth/step-up` automaticamente |
| Sem `USER_MANAGE` | 403 | `PERMISSION_DENIED` | "Você não tem permissão para redefinir a autenticação em duas etapas." | Oculta o botão |
| Redefinição sobre o próprio vínculo | 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`) | "Use a recuperação no login para o seu próprio caso." | Mantém o formulário |
| Usuário de outro tenant/inexistente | 404 | `USER_NOT_FOUND` | — | Lista de usuários inalterada |
| Authentik indisponível no step-up/reset | 503 | `DEPENDENCY_UNAVAILABLE` | "O serviço de autenticação está indisponível. Tente novamente em instantes." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-087 (sessão e callback), US-097 (`AuthorizationService`, POL-14, cache de permissões efetivas), US-103 (`/settings` e `TenantSettingsChanged` que propagam `security.mfaPolicy`), US-078 (Authentik com TOTP/WebAuthn e API administrativa).
- **Decisões/ADRs:** DEC-132, DEC-133, DEC-134, DEC-135, DEC-138; ADR-003.
- **Configurações:** `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:** nenhuma (`USR-13 POST /users/{userId}/mfa-reset` registrado em api.md §3; auditoria `membership.mfa_reset` em events.md §7).

## Impacto técnico
- Estende o pipeline de contexto (DEC-132) com a verificação de `amr`, no mesmo ponto em que `AuthorizationService` (US-097) resolve a permissão — sem chamada extra ao Authentik por requisição (o claim já está no token).
- `USR-13` depende de uma nova função em `AuthentikAdminClient` (introduzido por US-087) para remover fatores de MFA via API administrativa; falha não deve deixar o vínculo inconsistente (operação idempotente, sem escrita local além da auditoria).
- Mudança de política é rara e de baixo volume; invalidar o cache de permissões efetivas do tenant inteiro (em vez de por usuário) é aceitável.

## Backend
- **Módulo(s):** `access` (verificação de `amr`, dono de POL-14), `identity` (`AuthentikAdminClient.resetMfa`), `platform` (BFF: rota de *step-up*).
- **Casos de uso:** `ResetUserMfaCommand` → `ResetUserMfaHandler` (`USR-13`); consumidor `InvalidateEffectivePermissionsOnSettingsChanged` (reage a `TenantSettingsChanged`).
- **Integrações internas:** `AuthorizationService.assertCan` (US-097) para resolver `riskLevel`; `AuthentikAdminClient` para o reset.
- **Transação:** `USR-13` grava auditoria em transação própria do tenant; a chamada ao Authentik ocorre fora da transação, com *retry* e log de falha.

## Frontend
- **Tela(s):** SCR-029 (`/admin/usuarios/[userId]`, ação "Redefinir autenticação em duas etapas"); SCR-039 (`/perfil`, painel somente leitura do próprio status de MFA); interceptador global de `MFA_REQUIRED` que abre `/api/auth/step-up` em qualquer tela.
- **Componentes:** `MfaResetDialog` (motivo obrigatório + confirmação), `MfaStatusBadge` em SCR-039, interceptador de API (`onMfaRequired`).
- **Estados:** *loading* durante o redirecionamento de *step-up*; retomada automática da ação original após o retorno; erro de indisponibilidade reaproveita o componente de SCR-001.
- **Acessibilidade e responsividade:** diálogo de redefinição navegável por teclado, foco no motivo; aviso de *step-up* anunciado por `aria-live`.

## Banco de dados
- **Tabelas escritas:** `audit_logs` (ação `membership.mfa_reset`); nenhuma tabela nova — o status de MFA não é persistido (vive no Authentik e no `amr` do token).
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** não se aplica.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| BFF | GET | `/api/auth/step-up` | `returnTo?` | `302` → MFA no Authentik; ao concluir, atualiza a sessão | 302, 401, 429, 503 |
| USR-13 *(novo)* | POST | `/users/{userId}/mfa-reset` | `{ reason }` | `200 { data: { userId, resetAt } }` | 200, 403, 404, 422, 503 |

## Logs
- `info` `auth.step_up_completed` — `userId`, `correlationId`, `durationMs` (sem o fator usado).
- `info` `identity.mfa_reset` — `targetUserId`, `actorUserId`, `correlationId`.
- `warn` `auth.step_up_unavailable` — quando o Authentik não responde.
- **Nunca logar:** segredos de TOTP, dados de WebAuthn, tokens.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `auth.mfa_required` | `SECURITY` | API nega por falta de MFA (RN-IAM-40) | `permissionCode`, `route` |
| `membership.mfa_reset` | `SECURITY` | Commit de `USR-13` | `targetUserId`, `reason` |

## Testes necessários
- **Unitários:** avaliação de RN-IAM-39 (matriz política × `riskLevel` × `amr`); autoproteção de `USR-13`.
- **Integração (Testcontainers Postgres + Redis):** invalidação do cache de permissões efetivas ao consumir `TenantSettingsChanged`; auditoria de `USR-13` em transação.
- **API/contrato:** `MFA_REQUIRED` em todas as rotas `HIGH` sob `ADMINS`/`ALL`; `USR-13` conforme proposta de api.md.
- **RBAC e multi-tenant:** `USR-13` sem `USER_MANAGE` → 403; usuário de outro tenant → 404.
- **Concorrência:** duas tentativas de *step-up* simultâneas na mesma sessão não corrompem os tokens (trava de renovação de US-088).
- **E2E (Playwright + Authentik real):** *step-up* completo com TOTP e com WebAuthn; redefinição administrativa seguida de novo *enrollment*.
- **Acessibilidade/performance:** axe no diálogo de redefinição; verificação de `amr` adiciona < 1 ms por requisição.

## Definition of Done
- [ ] Cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `USER_MANAGE` e autoproteção aplicados em `USR-13`; POL-14 aplicada em toda rota `HIGH`
- [ ] Invalidação do cache de permissões verificada em teste ao mudar `security.mfaPolicy`
- [ ] Auditoria `auth.mfa_required` e `membership.mfa_reset` verificada em teste
- [ ] `USR-13` documentado como proposta de atualização de `api.md` (lacuna registrada)
- [ ] Logs sem segredos de MFA
- [ ] Acessibilidade (axe) do diálogo e do aviso de step-up
- [ ] Revisão de código e de segurança aprovadas

## Como funciona (revisão de 2026-10-28 · DEC-187)
- **Login com segundo fator:** o formulário nativo (`/entrar`) envia usuário e senha a `POST /api/auth/login`; o BFF conduz o *flow* do Authentik pelo executor e, quando o usuário tem dispositivo de código (TOTP, estático, e-mail ou SMS), responde `{ step: 'mfa', transaction, methods }`. A tela mostra "Confirme sua identidade" e o código de 6 dígitos; a transação fica no Redis de sessões (cifrada, 5 min, 5 códigos). Código errado → `MFA_INVALID`; prazo ou tentativas esgotados → `MFA_EXPIRED` (volta à senha). A sessão nasce com `amr` contendo o fator, como antes.
- **Limites:** WebAuthn/Duo e o cadastro de MFA dentro do login ainda não têm tela nativa (viram "serviço indisponível" com log); códigos errados contam para o bloqueio por reputação do *flow* (5 erros).
- **Step-up:** continua pelo navegador no Authentik nesta leva (`GET /api/auth/step-up`, `max_age=0`); sem sessão, cai na tela nativa com o destino.
- **Código:** `apps/web/src/bff/auth/authentik-flow.ts`, `apps/web/src/bff/auth/login-challenge.ts`, `apps/web/src/features/auth/login-form.tsx`.

## Estimativa
**M** — estende o pipeline de autorização (US-097) com verificação de `amr`, orquestra o *step-up* preservando a ação original e integra com a API administrativa do Authentik, sem novas tabelas.

## Prioridade
**P1** — eleva a segurança de ações sensíveis, mas o MVP 1 opera com `security.mfaPolicy = ADMINS` por padrão sem bloquear o uso geral; não é pré-requisito das jornadas de negócio essenciais.
