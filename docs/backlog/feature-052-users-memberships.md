---
id: FT-052
title: "Usuários e vínculos"
epic: EP-016
mvp: 1
priority: P0
stories: [US-091, US-092, US-093]
status: Especificada
---

# FT-052 — Usuários e vínculos

## Título
Usuários e vínculos

## Épico
EP-016 — Identidade, acesso e RBAC

## Descrição
Entrega o ciclo de vida do vínculo de um usuário com um tenant: convite por e-mail, aceite e ativação, gestão contínua (editar, lotar, suspender, reativar, revogar) e a troca do órgão ativo para quem tem mais de um vínculo. É a feature que povoa o `TenantMembership` sobre o qual US-096 atribui perfis e US-097 decide acessos.

## Valor para o usuário e para o órgão
- Onboarding de novos servidores em minutos, sem depender de TI para criar conta (o `User` global é reaproveitado ou provisionado automaticamente no Authentik).
- Suspensão/revogação com efeito imediato em sessões e cache reduz o risco de acesso remanescente após desligamento.

## Personas
- Administrador do órgão (`ADMIN_ORGAO`) — convida, gerencia e revoga vínculos.
- Qualquer usuário convidado — aceita o convite e, se tiver vínculos em mais de um tenant, escolhe o órgão ativo.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-091 | Convidar usuário e ativar vínculo | P0 | M | US-087, US-102, US-112 |
| US-092 | Gerenciar usuários e lotações | P0 | M | US-091 |
| US-093 | Selecionar órgão ativo | P1 | S | US-087 |

## Escopo
- Convite por e-mail com token de 7 dias; aceite e ativação do vínculo.
- Edição de dados do vínculo (cargo, matrícula, lotações), suspensão, reativação e revogação.
- Troca do tenant ativo da sessão (SCR-101) com reset do cache do frontend.

## Fora de escopo
- Contas de serviço (`MembershipType.SERVICE`) — MVP 3.
- Atribuição de perfil em si (tratada na FT-053/US-096); esta feature só grava a atribuição inicial opcional do convite.

## Regras de negócio da feature
- Convite (US-091, RN-IAM-46 a RN-IAM-51): reaproveita o `User` global pelo `email` (citext, único) ou cria um novo, provisionando-o no Authentik sem senha; `inviteTokenHash` é SHA-256 de token opaco por CSPRNG, `inviteExpiresAt = now + 7 dias` (fixo, não configurável); convite para vínculo já `INVITED`/`ACTIVE`/`SUSPENDED` → `MEMBERSHIP_ALREADY_EXISTS` (409); aceite exige login prévio no Authentik com o mesmo e-mail e valida token/expiração em transação única; token vencido → `INVITATION_EXPIRED` (410), inválido → `INVITATION_INVALID` (404), sem revelar qual causa; lotação e perfil inicial, quando informados no convite, só produzem efeito de acesso quando o vínculo estiver `ACTIVE`.
- Gestão de usuários (US-092): nome e e-mail são atributos globais do `User` (DEC-012), não do vínculo; suspensão e revogação aplicam POL-12 (anti-bloqueio) e POL-16 (autoproteção) e têm efeito imediato em sessões ativas e no cache de permissões (consumo de `MembershipSuspended`/`MembershipRevoked` pelo `PermissionCacheInvalidator` e pelo encerramento de sessão).
- Troca de órgão ativo (US-093, SCR-101): acionada via `/api/auth/switch-tenant` do BFF; reseta o cache de permissões do frontend e gera auditoria `auth.tenant_switch` (categoria `ACCESS`); exige vínculo `ACTIVE` no tenant de destino.

## Telas
- SCR-029 — Usuários (`/admin/usuarios`, `/admin/usuarios/[userId]`)
- SCR-101 — Seleção de órgão (`/selecionar-orgao`)
- SCR-102 — Aceite de convite (`/convite/[token]`)

## Endpoints
- `USR-01` `GET /users`, `USR-02` `GET /users/lookup`
- `USR-03` `POST /users/invitations`, `USR-04` `POST /users/invitations/{userId}/resend`, `USR-05` `DELETE /users/invitations/{userId}`, `USR-06` `POST /invitations/accept`
- `USR-07` `GET /users/{userId}`, `USR-08` `PATCH /users/{userId}`, `USR-09` `PUT /users/{userId}/departments`
- `USR-10` `POST /users/{userId}/suspend`, `USR-11` `POST /users/{userId}/reactivate`, `USR-12` `POST /users/{userId}/revoke`
- `ME-04` `GET /me/memberships`

## Entidades
- `User` — identidade global.
- `TenantMembership` — vínculo com status, cargo, matrícula, vigência.
- `MembershipDepartment` — lotações (1 principal + N adicionais).

## Eventos
- `UserInvited` — convite enviado.
- `MembershipActivated` — aceite concluído.
- `MembershipUpdated` — dados/lotações alterados.
- `MembershipSuspended` / `MembershipReactivated` / `MembershipRevoked` — mudança de status.
- `MembershipExpired` — expiração automática (job `maintenance`).

## Permissões
- `USER_VIEW` — consultar usuários (`USR-01`/`USR-07`).
- `USER_INVITE` — convidar/reenviar/cancelar convite.
- `USER_MANAGE` — editar, lotar, suspender, reativar, revogar (POL-12/16 quando aplicável).

## Dependências
- US-102 (secretarias e setores, para lotação), US-112 (templates de e-mail de convite).
- Decisões: DEC-012 (identidade global), DEC-134 (cache de permissões).

## Critérios de aceite da feature
```gherkin
Feature: Usuários e vínculos

  Scenario: Convite, ativação e troca de órgão
    Given que "Carla" (ADMIN_ORGAO) convida "bruno@orgao.gov.br" para a "Prefeitura A"
    When "Bruno" aceitar o convite dentro do prazo de 7 dias
    Then seu vínculo deve ficar "ACTIVE" na "Prefeitura A"
    When "Bruno" também tiver vínculo "ACTIVE" na "Prefeitura B"
    And acessar "/selecionar-orgao"
    Then ele deve poder trocar o tenant ativo da sessão
    And a auditoria deve registrar "auth.tenant_switch"
```

## Métricas de sucesso
- Tempo médio entre `UserInvited` e `MembershipActivated` — meta < 48 h (mediana).
- Percentual de convites expirados sem aceite — acompanhado, sem meta rígida no MVP 1.

## Riscos
- Convite usado pela pessoa errada — mitigação: token hash opaco + exigência de login prévio com o e-mail convidado.
- Usuário com múltiplos vínculos confuso sobre qual está ativo — mitigação: SCR-101 clara e indicador persistente do tenant ativo na interface.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 (US-091 a US-093) concluídas e aceitas
- [ ] Jornada E2E convite → aceite → gestão → troca de órgão automatizada
- [ ] Documentação atualizada
