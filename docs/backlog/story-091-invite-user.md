---
id: US-091
title: "Convidar usuário e ativar vínculo"
epic: EP-016
feature: FT-052
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-087, US-102, US-112]
modules: [identity, platform]
screens: [SCR-029, SCR-102]
endpoints: [USR-03, USR-04, USR-05, USR-06]
permissions: [USER_INVITE]
events: [UserInvited, MembershipActivated]
---

# US-091 — Convidar usuário e ativar vínculo

## Título
Convidar usuário e ativar vínculo

## Descrição
**Como** administrador do órgão, **quero** convidar uma pessoa por e-mail para um vínculo no meu tenant, **para** que ela defina as próprias credenciais no Authentik e comece a usar o ContrataFlow com o perfil e a lotação corretos, sem compartilhar senhas nem criar contas manualmente.

**Como** pessoa convidada, **quero** receber um link por e-mail, definir minha senha no Authentik e aceitar o convite, **para** ativar meu acesso à instituição que me convidou.

O convite cria (ou reaproveita) o `User` global pelo e-mail, provisiona a conta no Authentik e cria um `TenantMembership` em `INVITED` com um token próprio do ContrataFlow (7 dias). O aceite, após a pessoa definir a senha no Authentik e entrar, ativa o vínculo.

## Contexto
- DEC-012: identidade é global (`User`); o vínculo (`TenantMembership`) é por tenant; uma mesma pessoa pode ter vínculos em várias instituições (ex.: consultoria externa). O convite é o único caminho de entrada de uma pessoa nova no MVP 1 (sem autocadastro).
- Hoje, o acesso a sistemas de contratação costuma ser liberado por e-mail avulso ou ticket de TI, sem prazo nem trilha; aqui o convite expira (7 dias) e cada etapa é auditada.
- Decisões: DEC-012 (identidade global), DEC-130 (Authentik como IdP; o ContrataFlow não guarda senhas), DEC-134 (perfil/escopo só valem com vínculo `ACTIVE`). Base: US-087 (login, `AuthentikAdminClient`), US-102 (secretarias/setores da lotação), US-112 (dados adicionais do formulário).

## Objetivo
Permitir que um administrador convide uma pessoa e que ela ative o vínculo em até 3 interações a partir do e-mail recebido, com 100% dos convites expirando em 7 dias quando não aceitos e nenhuma senha transitando pelo ContrataFlow.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`) — envia, reenvia e cancela convites.
- **Secundárias:** Pessoa convidada (interna ou externa) — aceita o convite.

## Pré-condições
- Quem convida possui `USER_INVITE`.
- Órgão, secretaria e setor de destino existem e estão ativos (US-102), quando a lotação é definida no convite.
- `AuthentikAdminClient` (estabelecido em US-087) disponível para provisionar a conta no Authentik.

## Fluxo principal
1. Em **Administração › Usuários** (SCR-029), o administrador aciona **"Convidar usuário"** e informa e-mail, nome, tipo de vínculo (`INTERNAL`/`EXTERNAL`), cargo, lotação e, opcionalmente, o perfil inicial.
2. O front valida com Zod e envia `POST /users/invitations` (`USR-03`) com `Idempotency-Key`.
3. A API, em uma transação: valida as referências (unidade ativa, perfil existente); verifica se já existe `TenantMembership` não revogado/expirado para aquele e-mail no tenant (`MEMBERSHIP_ALREADY_EXISTS` caso exista); localiza o `User` global pelo e-mail ou cria um novo; se o `User` não tiver `authentikUserId`, provisiona a conta no Authentik via `AuthentikAdminClient` (sem senha definida); cria `TenantMembership` (`status = INVITED`, `invitedById`, `invitedAt`, `inviteTokenHash` = SHA-256 de um token opaco por CSPRNG, `inviteExpiresAt = now + 7 dias`) e, se informadas, as `MembershipDepartment`; grava auditoria `membership.invite` e publica `UserInvited` no outbox.
4. Fora da transação, o caso de uso envia o e-mail de convite (fila `email`, não o sistema de `Notification`) com o link `/convite/{token}` (SCR-102) — o token em claro só existe no e-mail.
5. A pessoa convidada abre o link; se ainda não tiver senha definida no Authentik, é levada primeiro ao fluxo de definição de senha do Authentik (mesmo princípio de política de senha da US-089) e depois retorna a SCR-102 autenticada.
6. SCR-102 mostra a instituição, o cargo e a lotação do convite e pede confirmação; o front envia `POST /invitations/accept` (`USR-06`) com o token.
7. A API valida o token (hash, expiração, usuário autenticado é o destinatário), ativa o vínculo (`status = ACTIVE`, `activatedAt = now`), grava auditoria `membership.activate` e publica `MembershipActivated`.
8. A pessoa é levada ao painel do ContrataFlow já na instituição que a convidou.

## Fluxos alternativos
- **FA-01 — Reenvio (`USR-04`):** gera novo token/expiração (7 dias) e reenvia o e-mail; o link anterior deixa de ser válido. Permitido enquanto `status = INVITED`.
- **FA-02 — Cancelamento (`USR-05`):** exclui o convite (`DELETE`) enquanto `status = INVITED`; o vínculo não chega a existir para fins de acesso.
- **FA-03 — Convite expirado:** a pessoa abre o link após `inviteExpiresAt`; SCR-102 exibe "Este convite expirou. Peça para reenviarem." (`INVITATION_EXPIRED`, 410).
- **FA-04 — Token inválido:** link malformado, hash sem correspondência ou vínculo já `ACTIVE`/`REVOKED`; SCR-102 exibe "Este convite não é válido." (`INVITATION_INVALID`, 404).
- **FA-05 — E-mail já vinculado a outra instituição:** permitido — identidade global (DEC-012); o novo convite cria um segundo `TenantMembership` independente.
- **FA-06 — Vínculo `EXTERNAL` sem validade informada:** o formulário exige `expiresAt` antes de enviar o convite.
- **FA-07 — Pessoa já convidada tenta novo convite antes de aceitar:** `MEMBERSHIP_ALREADY_EXISTS` (409); a UI sugere reenviar (`USR-04`) em vez de criar outro convite.

## Regras de negócio
- **RN-IAM-46** — Convidar exige `USER_INVITE`; reaproveita o `User` global existente pelo `email` (citext, único) ou cria um novo; se o `User` ainda não tiver `authentikUserId`, a API o provisiona no Authentik via `AuthentikAdminClient` (sem senha — a pessoa a define no próprio Authentik).
- **RN-IAM-47** — `inviteTokenHash` é o SHA-256 de um token opaco gerado por CSPRNG, nunca persistido em claro; `inviteExpiresAt = now + 7 dias` (fixo no MVP 1, não configurável por tenant).
- **RN-IAM-48** — `MEMBERSHIP_ALREADY_EXISTS` (409) quando já existe `TenantMembership` para aquele `(tenantId, userId/email)` com `status` em `INVITED`, `ACTIVE` ou `SUSPENDED`; reenvio (`USR-04`) substitui token e expiração sem criar novo vínculo; cancelamento (`USR-05`) só é permitido em `INVITED`.
- **RN-IAM-49** — O aceite (`USR-06`) exige usuário autenticado (login prévio no Authentik, inclusive definição de senha) cujo `User.email` corresponda ao do convite; valida `inviteTokenHash` e `inviteExpiresAt > now`; ativa o vínculo (`status = ACTIVE`, `activatedAt = now`) em transação única.
- **RN-IAM-50** — `INVITATION_EXPIRED` (410) quando `inviteExpiresAt ≤ now`; `INVITATION_INVALID` (404) quando o token não corresponde a nenhum hash pendente (inexistente, já aceito ou cancelado) — sem revelar qual dessas causas se aplica.
- **RN-IAM-51** — Lotação (`MembershipDepartment`) e perfil inicial (`RoleAssignment`), quando informados no convite, são gravados junto com o `TenantMembership` em `INVITED`, mas só produzem efeito de acesso quando o vínculo estiver `ACTIVE`.
- **RN-IAM-52** — Convite para vínculo `EXTERNAL` exige `expiresAt` (≤ `security.externalMembershipMaxDays`, padrão 180 dias); para `INTERNAL`, `expiresAt` permanece nulo.
- **RN-IAM-53** — Reenvio (`USR-04`) é limitado a 5 vezes por convite, com intervalo mínimo de 1 minuto entre tentativas.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| E-mail | `email` | texto | Sim | Formato de e-mail; RN-IAM-46 | — |
| Nome | `name` | texto curto | Sim | 3–200 caracteres | — |
| Tipo de vínculo | `type` | seleção (`MembershipType`) | Sim | `INTERNAL`\|`EXTERNAL` (`SERVICE` fora do MVP 1) | `INTERNAL` |
| Cargo/função | `jobTitle` | texto curto | Não | até 150 caracteres | — |
| Validade do vínculo | `expiresAt` | data | Condicional (`EXTERNAL`) | RN-IAM-52 | — |
| Lotação | `departmentIds[]` | seleção múltipla | Não | unidades ativas do tenant | — |
| Perfil inicial | `roleId` | seleção | Não | perfil ativo do tenant | — |
| *(sistema)* Token de convite | `inviteTokenHash`, `inviteExpiresAt` | — | — | RN-IAM-47 | gerados |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | E-mail ausente ou formato inválido | Front + API | "Informe um e-mail válido." | `VALIDATION_ERROR` |
| V-02 | Vínculo já existente | API | "Esta pessoa já tem um vínculo com esta instituição." | `MEMBERSHIP_ALREADY_EXISTS` |
| V-03 | `expiresAt` ausente para `EXTERNAL` | Front + API | "Informe a validade do vínculo externo." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-04 | Unidade/perfil inexistente, inativo ou de outro tenant | API | "Selecione uma opção válida." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-05 | Token de convite expirado | API | "Este convite expirou. Peça para reenviarem." | `INVITATION_EXPIRED` |
| V-06 | Token de convite inválido | API | "Este convite não é válido." | `INVITATION_INVALID` |

## Permissões
- **Permissão:** `USER_INVITE` para `USR-03`/`USR-04`/`USR-05`; o aceite (`USR-06`) é capacidade implícita de qualquer usuário autenticado sobre o próprio convite.
- **Políticas:** nenhuma política contextual além de RN-IAM-48 (unicidade do vínculo).
- **MFA:** `USER_INVITE` é risco `H` — exige MFA quando `security.mfaPolicy` ∈ {`ADMINS`, `ALL`} (POL-14, US-090).
- **Sem permissão:** botão "Convidar usuário" oculto sem `USER_INVITE`; API responde 403 `PERMISSION_DENIED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `UserInvited` | `membership.invited` | Commit de `USR-03` | `membershipId`, `userId`, `type`, `expiresAt?`; e-mail enviado pelo próprio caso de uso (fila `email`), não por este evento |
| `MembershipActivated` | `membership.activated` | Commit de `USR-06` | `membershipId`, `userId` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| Convite para ingressar na instituição | Pessoa convidada | E-mail (fila `email`, fora do sistema de `Notification`) | Em `USR-03` e a cada reenvio (`USR-04`) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Convidar usuário e ativar vínculo

  Background:
    Given que a instituição "Prefeitura de São José" está ativa
    And "Ana" possui o perfil "ADMIN_ORGAO" com a permissão "USER_INVITE"

  Scenario: [Sucesso] Convidar e aceitar o convite
    When "Ana" convidar "bruno@pmsj.gov.br" para o setor "Compras" com o perfil "COMPRAS"
    Then deve ser criado um "TenantMembership" com status "INVITED" e expiração em 7 dias
    And o evento "UserInvited" deve ser gerado
    When "Bruno" definir a senha no Authentik e abrir o link do convite
    And confirmar a aceitação
    Then o vínculo deve passar para "ACTIVE" com "activatedAt" preenchido
    And o evento "MembershipActivated" deve ser gerado
    And "Bruno" deve ser levado ao painel da "Prefeitura de São José"

  Scenario: [Validação] Vínculo externo sem validade
    When "Ana" tentar convidar uma consultoria externa sem informar a validade do vínculo
    Then a API deve responder 422 "VALIDATION_ERROR" no campo "expiresAt"

  Scenario: [Permissão] Usuário sem USER_INVITE não convida
    Given que "Carla" possui apenas o perfil "REQUISITANTE"
    When "Carla" enviar POST para "/users/invitations"
    Then a API deve responder 403 "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Aceitar convite de outra instituição
    Given que existe um convite de "Bruno" na "Prefeitura B"
    When "Bruno" autenticado tentar aceitar esse convite estando com a "Prefeitura de São José" como instituição ativa
    Then a API deve ativar o vínculo apenas na "Prefeitura B", sem afetar a "Prefeitura de São José"

  Scenario: [Duplicidade] Convite repetido para o mesmo e-mail
    Given que já existe um convite "INVITED" para "bruno@pmsj.gov.br"
    When "Ana" tentar convidar "bruno@pmsj.gov.br" novamente
    Then a API deve responder 409 "MEMBERSHIP_ALREADY_EXISTS"

  Scenario: [Concorrência] Reenvio enquanto a pessoa está aceitando
    Given que "Bruno" abriu o link do convite original
    When "Ana" reenviar o convite (gerando novo token) no mesmo instante
    And "Bruno" concluir a aceitação com o token original
    Then apenas uma das tentativas deve ativar o vínculo com sucesso
    And a outra deve receber "INVITATION_INVALID" ou "INVITATION_EXPIRED"

  Scenario: [Falha de banco] Banco indisponível ao convidar
    Given que o PostgreSQL está indisponível
    When "Ana" tentar convidar "bruno@pmsj.gov.br"
    Then a API deve responder 503 "DEPENDENCY_UNAVAILABLE"
    And nenhum "User", "TenantMembership" ou e-mail deve ser criado ou enviado

  Scenario: [Falha de integração] Authentik indisponível ao provisionar a conta
    Given que o Authentik está fora do ar
    When "Ana" tentar convidar uma pessoa sem conta prévia no Authentik
    Then a API deve responder 503 "DEPENDENCY_UNAVAILABLE"
    And nenhum "TenantMembership" deve ser criado sem a conta correspondente no Authentik
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Vínculo já existente | 409 | `MEMBERSHIP_ALREADY_EXISTS` | "Esta pessoa já tem um vínculo com esta instituição." | Sugere reenviar o convite existente |
| Convite expirado | 410 | `INVITATION_EXPIRED` | "Este convite expirou. Peça para reenviarem." | Botão para solicitar reenvio (se autenticado) |
| Convite inválido | 404 | `INVITATION_INVALID` | "Este convite não é válido." | Link para a página de entrada |
| Sem `USER_INVITE` | 403 | `PERMISSION_DENIED` | "Você não tem permissão para convidar usuários." | Oculta o botão |
| Authentik indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível enviar o convite agora. Tente novamente em instantes." | Mantém os dados do formulário |

## Dependências
- **Stories:** US-087 (login, `AuthentikAdminClient`), US-102 (secretarias e setores da lotação), US-112 (dados adicionais do formulário de convite, se aplicável). Indiretas: US-090 (MFA em `USER_INVITE`), US-092 (gestão subsequente do vínculo), US-094/US-096 (perfil inicial).
- **Decisões/ADRs:** DEC-012, DEC-130, DEC-134; ADR-003.
- **Configurações:** `security.externalMembershipMaxDays`.
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- Primeira story a criar `User` fora do primeiro login (US-087); reaproveita a mesma tabela e o mesmo `AuthentikAdminClient`, sem novas colunas.
- A criação do usuário no Authentik é uma chamada externa dentro do fluxo transacional — se falhar, a transação de banco é desfeita (nenhum `User`/`TenantMembership` "órfão" sem conta no IdP); se o banco falhar depois da chamada ao Authentik ter sucesso, o `User` recém-criado no IdP é removido por compensação.
- `inviteTokenHash` nunca é logado nem retornado em claro por nenhuma rota após o envio do e-mail.

## Backend
- **Módulo(s):** `identity` (dono de `User`, `TenantMembership`, `MembershipDepartment`; `AuthentikAdminClient`), `access` (atribuição do perfil inicial, se informado), `platform` (fila `email`, `OutboxWriter`).
- **Casos de uso:** `InviteUserCommand` → `InviteUserHandler` (`USR-03`); `ResendInvitationCommand` (`USR-04`); `CancelInvitationCommand` (`USR-05`); `AcceptInvitationCommand` → `AcceptInvitationHandler` (`USR-06`).
- **Integrações internas:** `AuthentikAdminClient.createUser`; `DepartmentFacade.assertActive` (US-102); `AuthorizationService` para o perfil inicial (US-097).
- **Transação:** criação de `User` (se novo) + `TenantMembership` + `MembershipDepartment` + auditoria + outbox em uma transação; chamada ao Authentik antes do commit, com compensação se a transação falhar depois.
- **Implementação (2026-10-15):**
  - Autorização (`USER_INVITE`/`USER_VIEW` + MFA), perfil inicial e unidades da lotação pela porta `MembershipReferences` do shared kernel, implementada por `access` e `organization` (decisions.md, DEC-041) — `identity` não importa os dois.
  - O token NÃO nasce na API: a transação deixa `inviteTokenHash` nulo e grava `UserInvited`; o worker (`InvitationEmailEnqueuer` → fila `email` → `InvitationEmailSource`) gera o token no envio e grava só o hash (queues.md §4.3). Assim o token em claro só existe no e-mail e o e-mail só sai com o convite comitado.
  - Reenvio zera o hash e renova a validade na mesma transação (link anterior inválido no commit); limite de RN-IAM-53 pela coluna nova `inviteResendCount` e por `invitedAt`.
  - Cancelamento = revogação lógica (`REVOKED`, sem token; auditoria `membership.revoke` com `INVITATION_CANCELLED`) — a aplicação não exclui vínculos; novo convite reaproveita o registro `REVOKED`/`EXPIRED`.
  - Aceite (`CROSS_TENANT_LOOKUP`): convite pelo hash em `cf_find_invitation` (`SystemDbService`), ativação condicional (hash + validade) no tenant do convite; perdedor da corrida com reenvio/outro aceite → `INVITATION_INVALID`/`INVITATION_EXPIRED`.
  - Convite do primeiro administrador (US-099): `FirstAdminSeeder.dispatch` usa o mesmo envio (validade, `membership.invite`, `UserInvited`).
  - USR-14 `POST /invitations/preview` (nova) para o SCR-102 mostrar instituição, cargo e lotação; USR-01 com a base da lista de convites pendentes.

## Frontend
- **Tela(s):** SCR-029 (`/admin/usuarios`, formulário "Convidar usuário"); SCR-102 (`/convite/[token]`, aceite).
- **Componentes:** `InviteUserForm` (e-mail, nome, tipo, cargo, validade condicional, `DepartmentTreeSelect`, `RoleSelect` opcional), `InvitationAcceptCard` em SCR-102.
- **Estados:** lista de convites pendentes com ações "Reenviar"/"Cancelar"; SCR-102 com estados de convite válido, expirado e inválido; *loading* durante o aceite.
- **Acessibilidade e responsividade:** formulário com rótulos associados e foco no primeiro erro; SCR-102 legível em telas pequenas, com o botão de confirmação sempre visível.

## Banco de dados
- **Tabelas escritas:** `users`, `tenant_memberships`, `membership_departments`, `role_assignments` (se perfil informado), `audit_logs`, `outbox_events`.
- **Migrações:** `20261015330000_invitations_role_assignments` — `tenant_memberships.invite_resend_count` (RN-IAM-53), índice único parcial de `invite_token_hash` e a tabela `role_assignments` (RLS, FKs compostas, checks de escopo/vigência, única vigente por escopo), que não existia (a gestão é da US-096; a leitura das permissões efetivas, da US-097).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, user_id)` em `tenant_memberships`; `(tenant_id, expires_at) WHERE type = 'EXTERNAL'`; checks de RN-IAM-52.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| USR-03 | POST | `/users/invitations` | `{ email, name, type, jobTitle?, expiresAt?, departmentIds?, roleId? }` + `Idempotency-Key` | `201 { data: TenantMembership }` | 201, 403, 409, 422, 503 |
| USR-04 | POST | `/users/invitations/{userId}/resend` | — | `200 { data: { inviteExpiresAt } }` | 200, 403, 404, 429 |
| USR-05 | DELETE | `/users/invitations/{userId}` | — | `204` | 204, 403, 404, 409 |
| USR-06 | POST | `/invitations/accept` | `{ token }` | `200 { data: TenantMembership & { tenant } }` | 200, 403, 404, 410, 422 |
| USR-14 | POST | `/invitations/preview` | `{ token }` | `200 { data: InvitationPreview }` | 200, 403, 404, 410, 422 |

## Logs
- `info` `identity.invitation_sent` — `membershipId`, `durationMs`, `correlationId` (e-mail mascarado `b***@pmsj.gov.br`, DEC-138).
- `info` `identity.invitation_accepted` — `membershipId`, `correlationId`.
- `warn` `identity.authentik_provision_failed` — quando a criação no Authentik falha.
- **Nunca logar:** e-mail completo, nome, token de convite em claro, CPF.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `membership.invite` | `SECURITY` | Commit de `USR-03` | `type`, `expiresAt?`, `invitedById` |
| `membership.activate` | `SECURITY` | Commit de `USR-06` | `membershipId` |

## Testes necessários
- **Unitários:** geração/verificação de `inviteTokenHash`; RN-IAM-46..52; reaproveitamento de `User` existente por e-mail.
- **Integração (Testcontainers Postgres + Redis):** transação de convite com falha simulada no Authentik (nada persiste); aceite concorrente com reenvio (RN-IAM-48).
- **API/contrato:** respostas e erros de `USR-03`..`USR-06` conforme api.md.
- **RBAC e multi-tenant:** `USER_INVITE` por tenant; aceite de convite de outro tenant não afeta o tenant ativo da sessão.
- **Concorrência:** duas aceitações simultâneas do mesmo token → uma ativa, a outra recebe erro; reenvio durante aceite (Gherkin acima).
- **E2E (Playwright + Authentik real):** jornada completa convite → e-mail → definição de senha no Authentik → aceite → painel.
- **Acessibilidade/performance:** axe no formulário de convite e em SCR-102.

## Definition of Done
- [ ] Cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `USER_INVITE` aplicado em `USR-03`/`04`/`05`; aceite restrito ao destinatário do convite
- [ ] Transação única comprovada por teste de falha induzida (banco e Authentik)
- [ ] Auditoria `membership.invite`/`membership.activate` e eventos `UserInvited`/`MembershipActivated` verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de `USR-03`..`USR-06` compatível com api.md
- [ ] Logs sem dados sensíveis (e-mail mascarado, sem token em claro)
- [ ] Acessibilidade (axe) e responsividade do formulário e de SCR-102
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — integra banco, fila de e-mail e API administrativa do Authentik em uma única transação compensável, com duas telas (convite e aceite) e regras de expiração/reenvio.

## Prioridade
**P0** — é o único caminho de entrada de novas pessoas no MVP 1 (sem autocadastro); sem ele, nenhum usuário além dos semeados em desenvolvimento consegue acessar um tenant.
