---
id: FT-084
title: "Login gov.br"
epic: EP-029
mvp: 2
priority: P1
stories: [US-182, US-183, US-184]
status: Especificada
---

# FT-084 — Login gov.br

## Título
Login gov.br

## Épico
EP-029 — Plataforma e backoffice

## Descrição
O servidor passa a poder entrar com a conta gov.br (Login Único). O gov.br é uma **fonte OIDC federada no Authentik**: o ContrataFlow continua falando só com o Authentik (DEC-130), e o botão "Entrar com gov.br" em `/entrar` leva o navegador ao fluxo de redirecionamento do Authentik, porque o login nativo da DEC-187 não conduz federação. Sessão, cookie e validação na API não mudam ([ADR-017](../adr/adr-017-govbr-login.md)).

gov.br **autentica a pessoa, não dá acesso**: entrar no tenant continua exigindo `TenantMembership` ativo. O primeiro uso só funciona se a identidade já estiver vinculada, o que acontece por ação da própria pessoa em "Meu perfil" ou quando o CPF do gov.br confere com o CPF do usuário (guardado como HMAC). Sem vínculo, a entrada é recusada com orientação. O nível de confiança (bronze, prata, ouro) vira atributo da sessão e da auditoria e **não bloqueia** o uso no MVP 2; opcionalmente, o tenant pode aceitar prata ou ouro como segundo fator.

## Valor para o usuário e para o órgão
- O servidor entra com a conta que já usa, sem mais uma senha.
- O órgão mantém o controle de quem acessa: sem convite não há acesso, mesmo com gov.br.
- A auditoria passa a registrar o nível de confiança de cada login por gov.br, base para políticas futuras.

## Personas
- Servidor (qualquer perfil de tenant) — entra e vincula a identidade.
- Administrador do órgão (`ADMIN_ORGAO`) — habilita o gov.br e define se o nível conta como segundo fator.
- Operador da plataforma — configura a fonte no Authentik quando há credenciamento.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-182 ⏳ | Entrar com gov.br via Authentik | P1 | L | US-087, US-103 |
| US-183 ⏳ | Vincular e desvincular a identidade gov.br | P1 | M | US-098, US-182 |
| US-184 ⏳ | Habilitar o gov.br no órgão e nível de confiança na política de MFA | P1 | S | US-090, US-182 |

## Escopo
- Botão "Entrar com gov.br" em `/entrar` (só aparece com a fonte criada e `auth.govbrEnabled` ligado), rota de início no BFF e reaproveitamento do callback e da sessão.
- Vínculo: em "Meu perfil" (usuário já autenticado, `PROFILE`) ou por CPF igual ao cadastrado (`CPF_MATCH`); desvincular pelo próprio usuário ou pelo operador.
- `UserExternalIdentity` com `subjectHash` (HMAC do CPF), `lastTrustLevel` e `lastLoginAt`; CPF mascarado na exibição e fora de logs.
- Recusas com orientação: sem vínculo ("Vincule sua conta gov.br em Meu perfil" / "Peça ao administrador do seu órgão o convite") e sem `TenantMembership` ativo.
- `govbrTrustLevel` na sessão e na auditoria do login.
- Configuração do tenant: `auth.govbrEnabled` e `auth.govbrCountsAsMfa`.

## Fora de escopo
- Criar usuário ou vínculo de tenant automaticamente a partir do gov.br (rejeitado na ADR-017).
- Exigir nível mínimo de confiança (política futura sobre `govbrTrustLevel`).
- Outros provedores federados (Entra ID do órgão) e assinatura eletrônica gov.br (MVP 3).
- Cadastro de CPF em claro: o sistema nunca guarda nem exibe o CPF completo.

## Regras de negócio da feature
- RN-PLAT-08 — O ContrataFlow nunca fala direto com o gov.br e tokens do gov.br não chegam ao BFF nem à API; tudo passa pelo Authentik (DEC-207, DEC-130).
- RN-PLAT-09 — gov.br nunca cria `User` nem `TenantMembership`; sem vínculo de identidade ou sem membership ativo a entrada é recusada com `GOVBR_NOT_LINKED` ou `MEMBERSHIP_REQUIRED` (DEC-207, DEC-012, POL-29).
- RN-PLAT-10 — O vínculo ocorre só por ação da pessoa autenticada em "Meu perfil" ou por CPF cujo HMAC seja igual a `users.cpf_hash`; o CPF não é gravado em claro, aparece mascarado e não vai para logs (DEC-207, DEC-086, DEC-140).
- RN-PLAT-11 — Vincular exige `auth.govbrEnabled` no tenant ativo; desvincular exige sessão com MFA ou login gov.br recente (≤ 10 min) (POL-29, DEC-207).
- RN-PLAT-12 — O nível de confiança é atributo da sessão e da auditoria e não bloqueia o uso; só conta como segundo fator se `auth.govbrCountsAsMfa` permitir (padrão `NEVER`) (DEC-207, DEC-133).
- RN-PLAT-13 — O botão e a fonte só existem com credenciamento no Login Único e `auth.govbrEnabled = true` (padrão `false`); a indisponibilidade do gov.br não afeta o login por usuário e senha (DEC-207).
- RN-PLAT-14 — Vincular e desvincular geram `GovbrIdentityLinked`/`GovbrIdentityUnlinked`, auditoria e a notificação `GOVBR_LINK_CHANGED` ao usuário (DEC-207).

## Telas
- SCR-001 — Login (`/entrar`): botão, mensagens de recusa e orientação.
- Perfil do usuário ("Meu perfil"): vincular e desvincular, com CPF mascarado e último nível informado.
- Configurações gerais do órgão: seção de autenticação (gov.br e segundo fator).

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `GET /auth/govbr/start` — rota do BFF que inicia a entrada pelo Authentik (não faz parte da API de domínio)
- `GET /me/external-identities` — identidades vinculadas do usuário
- `POST /me/external-identities/govbr/link` — vincular a conta gov.br pelo perfil
- `DELETE /me/external-identities/govbr` — desvincular
- `PATCH /settings` — `auth.govbrEnabled` e `auth.govbrCountsAsMfa` (estende SET-02)

## Entidades
- `UserExternalIdentity` — vínculo com o gov.br (módulo `identity`, tabela de plataforma).
- `User` (`cpf_hash`), `TenantMembership`, `TenantSetting`, sessão (`govbrTrustLevel`), `AuditLog`.

## Eventos
- `GovbrIdentityLinked` — ao vincular (por perfil ou CPF).
- `GovbrIdentityUnlinked` — ao desvincular.
- Auditoria `auth.govbr_login` (sem evento de domínio) a cada login por gov.br.

## Permissões
- Vincular e desvincular: usuário autenticado, sem permissão de tenant específica (POL-29).
- `SETTINGS_MANAGE` — habilitar o gov.br e definir o segundo fator.
- `PLATFORM_TENANT_MANAGE` — configuração da fonte pela plataforma, quando houver credenciamento.

## Dependências
- US-087 (login), US-090 (MFA), US-098 e US-103 (perfil e configurações); DEC-207, ADR-017.
- Dependência externa: credenciamento da plataforma no Login Único (por ambiente).

## Critérios de aceite da feature
```gherkin
Feature: Login gov.br
  Scenario: Entrar com gov.br depois de vincular a conta
    Given que o órgão tem "auth.govbrEnabled" ligado
    And "Marta" tem convite ativo e está logada por usuário e senha
    When "Marta" vincular a conta gov.br em "Meu perfil"
    And sair e escolher "Entrar com gov.br" em "/entrar"
    Then "Marta" deve entrar no órgão com a sessão normal
    And a auditoria deve registrar "auth.govbr_login" com o nível de confiança
    And o CPF deve aparecer apenas mascarado

  Scenario: gov.br sem vínculo não dá acesso
    Given que "Paulo" tem conta gov.br mas nenhum convite no órgão
    When "Paulo" escolher "Entrar com gov.br"
    Then a entrada deve ser recusada com a orientação de pedir o convite ao administrador
    And nenhum usuário nem vínculo de tenant deve ser criado
```

## Métricas de sucesso
- ≥ 40% dos logins por gov.br nos tenants habilitados em 3 meses (a validar com o piloto).
- 0 usuários ou vínculos criados automaticamente por gov.br.
- ≥ 90% das recusas por falta de vínculo resolvidas em até 1 dia útil.

## Riscos
- Credenciamento atrasa — fonte e botão só existem com credenciais.
- Vínculo com a pessoa errada — só por ação do próprio usuário ou CPF igual, com auditoria e desvinculação.
- Exposição do CPF — HMAC, máscara e fora de logs.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada (com IdP federado simulado)
- [ ] Documentação atualizada
