---
id: FT-051
title: "Autenticação"
epic: EP-016
mvp: 1
priority: P0
stories: [US-087, US-088, US-089, US-090]
status: Especificada
---

# FT-051 — Autenticação

## Título
Autenticação

## Épico
EP-016 — Identidade, acesso e RBAC

## Descrição
Entrega o login via Authentik (OIDC Authorization Code + PKCE) com sessão opaca mantida no BFF, o logout (local e RP-initiated), a expiração/renovação de sessão, a recuperação de senha e a política de MFA por tenant com *step-up*. Tokens nunca chegam ao browser (DEC-053); toda a identidade visual do fluxo é do ContrataFlow, mesmo sendo o Authentik quem autentica.

## Valor para o usuário e para o órgão
- Elimina senhas fracas e compartilhadas: recuperação segura e política de MFA configurável por risco.
- Sessão previsível (ociosidade e duração absoluta configuráveis) reduz o risco de sessões esquecidas abertas em computadores públicos do órgão.

## Personas
- Qualquer usuário autenticado (`User`) — login, logout, recuperação.
- Administrador do órgão (`ADMIN_ORGAO`) — define `security.mfaPolicy` e pode resetar MFA de um usuário.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-087 | Login OIDC com Authentik e sessão segura no BFF | P0 | L | US-078, US-080, US-086 |
| US-088 | Logout, expiração e renovação de sessão | P0 | M | US-087 |
| US-089 | Recuperação de senha | P0 | S | US-087 |
| US-090 | Política de MFA por tenant com step-up | P1 | M | US-087, US-097 |

## Escopo
- Login/callback/logout via BFF; sessão opaca no cookie `__Host-cf_session` (Redis).
- Renovação transparente de token; expiração por ociosidade e por duração absoluta.
- Recuperação de senha e MFA (TOTP/WebAuthn) delegados ao Authentik, com identidade visual do produto.
- *Step-up* (403 `MFA_REQUIRED`) quando a ação exige MFA e a sessão não o satisfaz.

## Fora de escopo
- Federação com gov.br/Entra ID (futuro).
- Encerramento remoto de sessões ativas (fora desta entrega).
- Reset de MFA pelo próprio usuário sem suporte (feito pelo administrador via `USR-13`, tratado em US-090).

## Regras de negócio da feature
- Login usa Authorization Code + PKCE (S256), cliente confidencial no BFF, escopos `openid profile email offline_access`; `sub` do Authentik mapeado ao `User.externalSubject` (DEC-130).
- Sessão com ociosidade padrão 30 min e duração absoluta 12 h, configuráveis por tenant dentro dos limites da plataforma (`security.sessionIdleMinutes`/`security.sessionAbsoluteHours` — DEC-131); indisponibilidade do Redis de sessão responde 503.
- Recuperação de senha (US-089) usa o fluxo do Authentik: mensagens nunca revelam se a conta existe; senha exigida com ≥ 12 caracteres e verificação contra vazamentos conhecidos.
- MFA (US-090) segue `security.mfaPolicy` (`NONE`/`ADMINS`/`ALL`); a API verifica a claim `amr` e responde 403 `MFA_REQUIRED` para disparar o *step-up* no BFF quando a permissão exercida é `HIGH` e a política exige (POL-14, aplicada pelo motor de autorização da US-097).
- Reset de MFA de um usuário é feito pelo administrador (`USR-13`, `USER_MANAGE` + POL-16) via API administrativa do Authentik, nunca diretamente pelo ContrataFlow.

## Telas
- SCR-001 — Login (`/entrar` → fluxo Authentik)
- SCR-002 — Recuperar senha (`/recuperar-senha` → fluxo Authentik)
- SCR-111 — Páginas de erro e estados globais (sessão expirada, manutenção, sem vínculo)

## Endpoints
- `ME-01` `GET /me` — perfil básico pós-login
- `ME-04` `GET /me/memberships` — vínculos do usuário (seleção de órgão pós-login)
- `USR-13` `POST /users/{userId}/mfa-reset` — reset de MFA pelo administrador
- Rotas do BFF (fora do catálogo `api.md` §3, por serem internas ao Next.js): `/api/auth/login`, `/callback`, `/logout`, `/session`, `/forgot-password`, `/step-up` (DEC-053)

## Entidades
- `User` — identidade global, `externalSubject`/`authentikUserId`, `lastLoginAt`.
- `TenantMembership` — validado como `ACTIVE` e não expirado a cada requisição (DEC-132).

## Eventos
- Nenhum evento de domínio é gerado por login/logout/recuperação (trilha fica na auditoria — `auth.session_start`, `auth.session_end`, `auth.session_expired`, `auth.mfa_required`). A feature consome `MembershipSuspended`/`MembershipRevoked`/`MembershipExpired` para encerrar sessões ativas do vínculo afetado.

## Permissões
- Nenhuma: autenticar, fazer logout e recuperar senha são capacidades públicas/implícitas (permissions.md §7). O *step-up* de MFA é exigido pela permissão `HIGH` que o usuário está exercendo, não por uma permissão desta feature.

## Dependências
- Stories de fundação fora deste épico: US-078, US-080, US-086 (pré-requisitos de US-087, conforme `depends_on`).
- US-097 (motor de autorização) para a verificação de POL-14 no *step-up* de MFA.
- Decisões: DEC-053, DEC-130, DEC-131, DEC-132, DEC-133, DEC-135, DEC-137, DEC-138.

## Critérios de aceite da feature
```gherkin
Feature: Autenticação

  Scenario: Jornada completa de login, uso e logout
    Given que "Fábio" tem conta ativa no Authentik e vínculo "ACTIVE" na "Prefeitura A"
    When "Fábio" fizer login em "/entrar"
    Then o BFF deve criar uma sessão opaca no cookie "__Host-cf_session"
    And "Fábio" deve ser redirecionado ao Dashboard do tenant ativo
    When uma ação exigir permissão "HIGH" e a política de MFA do tenant for "ADMINS"
    Then a API deve responder 403 "MFA_REQUIRED" e o BFF deve disparar o step-up
    When "Fábio" fizer logout
    Then a sessão deve ser encerrada local e no Authentik (RP-initiated logout)
```

## Métricas de sucesso
- Tempo de login (do clique em "Entrar" ao Dashboard) — p95 < 3 s.
- Taxa de conclusão do step-up de MFA — > 95% das tentativas.
- Sessões encerradas automaticamente por revogação/suspensão de vínculo — 100% em até 1 min (consumo do evento).

## Riscos
- Indisponibilidade do Authentik — mitigação: mensagens claras de erro e retry no BFF; nenhuma autenticação local alternativa é criada.
- Força bruta em login/recuperação — mitigação: limite de 20 req/min por IP nas rotas de auth (api.md §1.6).

## Definition of Done da feature
- [ ] Todas as stories P0/P1 (US-087 a US-090) concluídas e aceitas
- [ ] Jornada E2E login → step-up → logout automatizada
- [ ] Documentação atualizada (guia do usuário de login/recuperação/MFA)
