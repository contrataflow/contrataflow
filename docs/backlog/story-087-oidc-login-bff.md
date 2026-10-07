---
id: US-087
title: "Login OIDC com Authentik e sessão segura no BFF"
epic: EP-016
feature: FT-051
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-078, US-080, US-086]
modules: [identity, tenancy, audit, platform]
screens: [SCR-001, SCR-101, SCR-111]
endpoints: [ME-01, ME-04]
permissions: []        # capacidade implícita (vínculo ativo) — permissions.md §7
events: []             # login não gera evento de domínio; trilha em auditoria (events.md §7)
---

# US-087 — Login OIDC com Authentik e sessão segura no BFF

## Título
Entrar com a conta institucional (OIDC + PKCE) e obter sessão segura no BFF

## Descrição
**Como** servidor ou colaborador de uma instituição contratante, **quero** entrar no ContrataFlow com minha conta institucional a partir de uma página simples, **para** acessar o sistema com segurança, sem senhas compartilhadas e sem que credenciais ou tokens fiquem expostos no navegador.

A página de entrada (SCR-001) leva ao BFF (`/api/auth/login`), que inicia o fluxo Authorization Code + PKCE (S256) no Authentik com `state` e `nonce` guardados em cookie curto e criptografado. No retorno (`/api/auth/callback`), o BFF troca o código usando o segredo do cliente e o `code_verifier`, valida o `id_token`, pede à API que resolva a identidade (vinculando o `sub` ao `User` convidado no primeiro login) e liste os vínculos, cria a sessão no Redis de sessões com id opaco no cookie `__Host-cf_session` e seleciona a instituição ativa: automaticamente quando há um único vínculo utilizável, pela seleção (SCR-101) quando há vários e pela página "sem vínculo" (SCR-111) quando não há nenhum. A partir daí, toda chamada a `/api/v1/*` passa pelo BFF, que injeta o access token e o `X-Tenant-Id` da sessão; a API valida o JWT e o contexto em toda requisição (DEC-132).

## Contexto
- Nos órgãos, é comum o uso de senhas "do setor" e até de servidores por consultores (dores das personas P01 e P15). O produto exige identidade individual, MFA conforme política (US-090) e trilha de acesso.
- Decisões: OIDC com Authentik e cliente confidencial no BFF (DEC-130, DEC-053, ADR-003); sessão no Redis com cookie `__Host-cf_session` (DEC-131), sendo o Redis de sessões dependência crítica, em alta disponibilidade e separado do Redis de cache/filas; contexto de requisição e status do tenant (DEC-132); CSRF e cabeçalhos (DEC-135); logs seguros (DEC-138); LGPD (DEC-140); identidade global + vínculo por tenant, com o tenant exibido como **instituição contratante** (DEC-012).
- Domínio único com seleção de instituição (DEC-141): a página de entrada não tem identidade visual de tenant. Login gov.br fica fora do MVP 1 (PEND-18).
- É a primeira story do EP-016 e estabelece o pipeline autenticado (BFF → API) usado por todas as demais. Complementos: US-088 (logout, expiração e renovação), US-089 (recuperação de senha), US-090 (MFA), US-093 (troca de instituição), US-097 (autorização).

## Objetivo
Permitir que qualquer usuário com vínculo utilizável entre em até 3 interações (clicar em "Entrar", informar credenciais, confirmar), com processamento do BFF + API no callback em p95 < 800 ms (excluído o tempo no Authentik), garantindo: zero tokens acessíveis ao navegador (verificado por teste automatizado), 100% das requisições à API com JWT e contexto validados, nenhuma possibilidade de *open redirect* e sessão nova a cada login.

## Persona
- **Principal:** Área requisitante — Cláudia Ferreira (perfil `REQUISITANTE`), letramento digital baixo.
- **Secundárias:** Consultoria externa — Bruno Carvalho (`CONSULTOR_EXTERNO`, vínculos `EXTERNAL` em várias instituições); Administrador do órgão — Rafael Nogueira (`ADMIN_ORGAO`, primeiro acesso após o provisionamento); Autoridade competente (`AUTORIDADE_COMPETENTE`, acesso pelo celular).

## Pré-condições
- Authentik configurado por *blueprint* versionado (local: US-078): cliente OIDC confidencial do BFF com *redirect URI* `https://<app>/api/auth/callback`, *post-logout redirect* `https://<app>/entrar`, escopos `openid profile email offline_access`, `sub` = UUID do usuário no Authentik, PKCE obrigatório, chaves de assinatura RS256/ES256, cadastro público (*enrollment*) desativado.
- Redis de sessões disponível (DEC-131) e Redis de cache separado.
- Usuário existente em `users` com `authentikUserId` (convite — US-091; provisionamento — US-099; ou seed de desenvolvimento — US-078) e senha definida no Authentik.
- Shell web com layout, cliente de API e páginas SCR-111 (US-086); esqueleto da API com pipeline de guards (US-080).

## Fluxo principal
1. O usuário acessa uma rota protegida (ex.: `/processos/0192…`) sem sessão válida; o middleware do Next.js redireciona para `/entrar?returnTo=/processos/0192…` (somente caminho + query).
2. SCR-001 exibe: marca e nome "ContrataFlow — gestão das contratações públicas", botão **"Entrar com conta institucional"**, link **"Esqueci minha senha"** (SCR-002), link **"Precisa de ajuda?"** (central de ajuda) e o aviso de privacidade: "Seus dados de acesso são tratados pela instituição contratante, controladora dos dados, para a execução de políticas públicas e o cumprimento de obrigações legais (LGPD, art. 7º, II e III, e art. 23). Consulte a Política de privacidade e os Termos de uso." Mensagens contextuais por `?motivo=` (`saiu`, `sessao-expirada`, `erro`, `indisponivel`).
3. Ao clicar, o navegador chama `GET /api/auth/login?returnTo=…`. O BFF aplica o limite de 20 req/min por IP, valida `returnTo` (RN-IAM-03), gera `state`, `nonce` e `code_verifier`, calcula `code_challenge = BASE64URL(SHA-256(code_verifier))`, grava a transação `{ state, nonce, codeVerifier, returnTo, createdAt }` no cookie criptografado `__Host-cf_auth` (proposto — ver Lacunas) e responde **302** para o `authorization_endpoint` do Authentik com `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `nonce`, `code_challenge` e `code_challenge_method=S256`.
4. O Authentik exibe o fluxo de autenticação com a identidade visual do ContrataFlow (pt-BR); o usuário informa e-mail e senha (e o segundo fator, quando exigido — US-090).
5. O Authentik redireciona para `GET /api/auth/callback?code=…&state=…`.
6. O BFF localiza a transação pelo `state` no cookie, troca o código no `token_endpoint` com autenticação do cliente (segredo) e o `code_verifier`, e valida o `id_token` (RN-IAM-04).
7. O BFF chama a API pela rede privada (contrato de eventos de sessão — proposto) com o access token do usuário: a API valida o JWT (RN-IAM-05), resolve o `User` pelo `sub` e faz o vínculo do primeiro login (RN-IAM-06), verifica `User.status`, atualiza `lastLoginAt` e devolve o resumo do usuário e a lista de vínculos com o status de cada instituição.
8. O BFF cria a sessão (RN-IAM-10): novo `sid` aleatório, registro no Redis de sessões (somente o hash do `sid` como chave; tokens cifrados), inclusão no índice de sessões do usuário, cookie `__Host-cf_session` e remoção de `__Host-cf_auth`.
9. O BFF escolhe a instituição ativa (RN-IAM-09): um único vínculo utilizável → seleção automática; vários → instituição padrão válida (US-093) ou SCR-101; nenhum → SCR-111 "sem vínculo".
10. Com a instituição definida, o BFF a registra na sessão e informa a API, que confere o vínculo e grava `auth.session_start` na instituição (RN-IAM-17).
11. O BFF responde **302** para `returnTo` (ou `/painel`); a página carrega `GET /api/auth/session` e `ME-01`, e o cabeçalho mostra o nome de exibição (nome social, quando houver) e a instituição ativa.
12. Nas chamadas seguintes, o BFF recebe `/api/v1/*`, descarta `Authorization`, `X-Tenant-Id` e `Cookie` vindos do cliente, injeta `Authorization: Bearer <access token>`, `X-Tenant-Id` da sessão e `X-Correlation-Id`, e encaminha à API (RN-IAM-13). Renovação de tokens e expiração: US-088.
13. A API executa o pipeline de contexto (DEC-132): JWT → `User` (`ACTIVE`) → tenant (status) → vínculo `ACTIVE` e não expirado → contexto em `AsyncLocalStorage` (`tenantId`, `userId`, `membershipId`, `correlationId`, IP, user-agent) → `lastAccessAt` (no máx. 1×/5 min) → autorização (US-097).

## Fluxos alternativos
- **FA-01 — Vários vínculos:** SCR-101 lista as instituições utilizáveis (nome, tipo de vínculo, validade); a escolha segue o passo 10. Esta story entrega a lista simples; o seletor no cabeçalho, a instituição padrão e a troca durante a sessão são da US-093.
- **FA-02 — Nenhum vínculo utilizável:** a sessão é criada **sem instituição ativa** (permite "Sair" e o aceite de convite) e o usuário vai para SCR-111 "sem vínculo": "Sua conta não tem acesso ativo a nenhuma instituição no ContrataFlow. Se você recebeu um convite, abra o link enviado por e-mail. Em caso de dúvida, procure o administrador da sua instituição." Sem instituição ativa, apenas `/api/auth/*`, `ME-04` e `USR-06` respondem; o restante retorna 403 `MEMBERSHIP_INACTIVE`.
- **FA-03 — Retorno a convite:** com `returnTo=/convite/{token}`, após o login o usuário volta a SCR-102, que conclui o aceite (US-091).
- **FA-04 — `state` ausente, expirado (> 10 min) ou divergente:** nenhuma sessão é criada; 302 para `/entrar?motivo=erro` com "Não foi possível concluir a entrada. Tente novamente."; log `warn` `auth.callback_rejected`.
- **FA-05 — Erro devolvido pelo Authentik** (`error=access_denied`, `temporarily_unavailable`…): mensagem correspondente em SCR-001, sem sessão.
- **FA-06 — Usuário bloqueado pela plataforma** (`User.status` `BLOCKED`/`DEACTIVATED`): sem sessão; SCR-111 (403) "Seu acesso ao ContrataFlow está bloqueado. Procure o suporte da sua instituição."
- **FA-07 — Já autenticado em `/entrar`:** redireciona para `returnTo` (ou `/painel`) sem novo login.
- **FA-08 — Instituição fora de `ACTIVE`** (DEC-132): `PROVISIONING`/`SUSPENDED`/`DEACTIVATED` aparecem desabilitadas em SCR-101 ("Instituição temporariamente indisponível"); `OFFBOARDING` só é utilizável por quem tem `ADMIN_ORGAO` ou `AUDITOR`, com faixa permanente "Instituição em encerramento: somente leitura e exportação".
- **FA-09 — Cabeçalhos forjados:** `X-Tenant-Id`, `Authorization` ou `X-Forwarded-For` enviados pelo navegador são descartados pelo BFF; IP do cliente vem da cadeia confiável do balanceador (A-10).

## Regras de negócio
- **RN-IAM-01** — Somente Authorization Code + PKCE `S256` com cliente confidencial (DEC-130); fluxos implícito, híbrido e *password grant* desabilitados no Authentik; `code_challenge_method=plain` rejeitado.
- **RN-IAM-02** — `state` e `nonce` (≥ 256 bits) e `code_verifier` (64 bytes, base64url) gerados por CSPRNG, de uso único e válidos por 10 min, guardados apenas no cookie de transação cifrado (AES-256-GCM; `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=600`); até 3 transações simultâneas por navegador (a mais antiga é descartada).
- **RN-IAM-03** — `returnTo` só é aceito se, após decodificação repetida, for caminho relativo iniciado por `/`, sem `//`, `/\`, esquema, host ou caracteres de controle, com até 2.048 caracteres, fora de `/api/` e `/entrar`, e se a resolução contra a origem da aplicação mantiver a mesma origem; caso contrário é substituído por `/painel` (sem erro ao usuário).
- **RN-IAM-04** — O `id_token` é validado quanto a assinatura (JWKS; algoritmos permitidos RS256/ES256; `none` rejeitado), `iss`, `aud` (contém o `client_id` do BFF), `azp` (quando presente), `exp`, `iat` e `nonce`; tolerância de relógio ≤ 60 s.
- **RN-IAM-05** — A API valida o access token em **toda** requisição: assinatura pelo JWKS em cache (10 min, renovação forçada ao ver `kid` desconhecido, no máx. 1 vez a cada 30 s), `iss`, `aud` configurada da API, `exp`, `nbf`, algoritmo permitido, tolerância ≤ 60 s. Falha → 401 `UNAUTHENTICATED`.
- **RN-IAM-06** — Vínculo do `sub` (primeiro login): procura `User` com `externalSubject = sub`; se não houver, procura `User` com `externalSubject` nulo cujo `authentikUserId` corresponda ao usuário do Authentik identificado pelo `sub` (confirmado pela API do Authentik) e grava `externalSubject = sub`; na ausência de `authentikUserId`, aceita-se o `email` com `email_verified = true` somente se o `User` tiver vínculo `INVITED` ou `ACTIVE`. Nenhum `User` é criado no login (cadastro público desativado); sem correspondência → "sem vínculo".
- **RN-IAM-07** — `User.status` deve ser `ACTIVE`; `BLOCKED`/`DEACTIVATED` impedem a sessão.
- **RN-IAM-08** — Vínculo utilizável: `TenantMembership.status = ACTIVE`, `expiresAt` nulo ou futuro, tenant `ACTIVE` — ou `OFFBOARDING` para quem tem `ADMIN_ORGAO`/`AUDITOR` vigente, em modo somente leitura (DEC-132).
- **RN-IAM-09** — Seleção da instituição: 1 vínculo utilizável → automática; vários → instituição padrão do usuário, se utilizável (US-093), senão SCR-101; nenhum → sessão sem instituição ativa e SCR-111 "sem vínculo".
- **RN-IAM-10** — Sessão: `sid` aleatório de 256 bits, **sempre novo** a cada login (anti-fixação; sessão anterior do mesmo navegador é encerrada); chave no Redis de sessões = SHA-256 do `sid` (o mesmo valor vai para `AuditLog.sessionIdHash`); access, refresh e id tokens cifrados em repouso (AES-256-GCM, chave no Secrets Manager — DEC-137); cookie `__Host-cf_session` com `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, sem `Domain` e sem `Max-Age` (expiração controlada no servidor); no máximo 10 sessões simultâneas por usuário (a mais antiga é encerrada).
- **RN-IAM-11** — Limites da sessão gravados na criação: ociosidade `security.sessionIdleMinutes` e duração absoluta `security.sessionAbsoluteHours` da instituição ativa; sem instituição, os padrões da plataforma (30 min e 12 h). Comportamento detalhado na US-088.
- **RN-IAM-12** — Tokens nunca chegam ao navegador: não aparecem em HTML, JavaScript, URL, `localStorage`, `sessionStorage`, cookies legíveis por script nem em respostas do BFF.
- **RN-IAM-13** — O BFF encaminha somente `/api/v1/*`; remove `Authorization`, `X-Tenant-Id`, `Cookie` e `X-Forwarded-*` do cliente e injeta `Authorization`, `X-Tenant-Id` (da sessão) e `X-Correlation-Id` (gerado se ausente). A API não é exposta à internet (DEC-053).
- **RN-IAM-14** — Métodos mutáveis no BFF exigem `X-CF-Request: 1` e `Origin`/`Sec-Fetch-Site` da própria origem (DEC-135); o login CSRF é impedido pelo `state` vinculado ao cookie de transação.
- **RN-IAM-15** — Limite de 20 req/min por IP em `/api/auth/login` e `/api/auth/callback` (api.md §1.6) → 429 `RATE_LIMITED` com `Retry-After`.
- **RN-IAM-16** — `User.lastLoginAt` é atualizado na criação da sessão; `TenantMembership.lastAccessAt`, no máximo 1×/5 min por vínculo.
- **RN-IAM-17** — `auth.session_start` (SECURITY) é gravado na instituição que se torna ativa, com `sessionIdHash`, IP, user-agent e `metadata { selection: AUTO|DEFAULT|MANUAL, firstLogin, amr }`. Logins sem instituição ficam apenas no log da aplicação e no registro de eventos do Authentik.
- **RN-IAM-18** — Mensagens não revelam se a conta existe (o Authentik usa mensagem genérica de credenciais inválidas); a página de entrada não exibe dados de nenhuma instituição.
- **RN-IAM-19** — Respostas de `/api/auth/*` e de SCR-001 levam `Cache-Control: no-store` e os cabeçalhos de DEC-135 (CSP com nonce, HSTS, `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `frame-ancestors 'none'`).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| *(técnico)* Retorno | `returnTo` (query) | texto | Não | RN-IAM-03 | `/painel` |
| *(técnico)* Transação de login | `state`, `nonce`, `code_verifier`, `returnTo`, `createdAt` | cookie cifrado | Sim (no callback) | RN-IAM-02 | gerado pelo BFF |
| *(técnico)* Sessão | cookie `__Host-cf_session` = `sid` | texto opaco | Sim | RN-IAM-10 | gerado pelo BFF |
| *(técnico)* Registro da sessão | `userId`, `sub`, `activeTenantId`, `membershipId`, tokens cifrados, `accessTokenExpiresAt`, `amr`, `authTime`, `createdAt`, `lastSeenAt`, `absoluteExpiresAt`, `idleMinutes`, `ip`, hash do user-agent | registro no Redis de sessões | Sim | RN-IAM-10/11 | BFF |
| *(sistema)* Identidade vinculada | `User.externalSubject`, `User.lastLoginAt` | uuid / timestamptz | — | RN-IAM-06/16 | API |
| *(sistema)* Último acesso ao vínculo | `TenantMembership.lastAccessAt` | timestamptz | — | RN-IAM-16 | API |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `returnTo` inválido ou externo | BFF | — (substituído por `/painel`) | — |
| V-02 | `state` ausente, expirado ou divergente | BFF | "Não foi possível concluir a entrada. Tente novamente." | `UNAUTHENTICATED` (interno; redireciona para SCR-001) |
| V-03 | `id_token` inválido (assinatura, `iss`, `aud`, `nonce`, `exp`) ou troca do código recusada | BFF | "Não foi possível concluir a entrada. Tente novamente." | `UNAUTHENTICATED` |
| V-04 | Access token inválido/expirado na API | API | — (BFF renova ou pede novo login — US-088) | `UNAUTHENTICATED` |
| V-05 | Usuário bloqueado/desativado | API | "Seu acesso ao ContrataFlow está bloqueado. Procure o suporte da sua instituição." | `PERMISSION_DENIED` (ver Lacunas) |
| V-06 | `X-Tenant-Id` sem vínculo ativo/não expirado | API | "Seu acesso a esta instituição não está ativo." | `MEMBERSHIP_INACTIVE` |
| V-07 | Tenant `SUSPENDED`/`PROVISIONING`/`DEACTIVATED`, ou comando em `OFFBOARDING` | API | "Esta instituição está temporariamente indisponível." / "Instituição em encerramento: somente leitura." | `TENANT_SUSPENDED` |
| V-08 | Mutação sem `X-CF-Request` ou com `Origin` de outra origem | BFF | "Requisição não permitida. Recarregue a página." | `PERMISSION_DENIED` |
| V-09 | Excesso de tentativas de login | BFF | "Muitas tentativas. Aguarde alguns instantes." | `RATE_LIMITED` |

## Permissões
- **Permissão:** nenhuma; login, sessão, `ME-01` e `ME-04` são capacidades implícitas (permissions.md §7).
- **Políticas:** contexto de DEC-132 (usuário `ACTIVE`, vínculo `ACTIVE` não expirado, tenant conforme status). POL-14 (MFA) é aplicada a partir da US-090.
- **MFA:** não exigido por esta story; quando a política exigir, o Authentik pede o segundo fator no próprio login (US-090).
- **Sem permissão:** usuário sem vínculo utilizável vê SCR-111 "sem vínculo"; bloqueado vê SCR-111 (403).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Login e sessão não são fatos de domínio; a trilha é a auditoria `auth.session_start` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma no MVP 1 (alerta de "novo acesso" fica como oportunidade futura) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Login OIDC com Authentik e sessão segura no BFF

  Background:
    Given que a instituição "Prefeitura de São José" (tenant) está ativa
    And o cliente OIDC do BFF está configurado no Authentik com PKCE obrigatório
    And "Cláudia" tem conta no Authentik e vínculo ativo somente na "Prefeitura de São José"

  Scenario: [Sucesso] Entrar com um único vínculo e voltar à página pedida
    Given que "Cláudia" não tem sessão e acessa "/processos/0192aa"
    When for redirecionada para "/entrar", clicar em "Entrar com conta institucional" e informar credenciais válidas
    Then o BFF deve criar uma sessão com o cookie "__Host-cf_session" marcado como HttpOnly, Secure, SameSite=Lax e Path=/
    And a instituição ativa deve ser "Prefeitura de São José" sem exibir a seleção
    And "Cláudia" deve ser levada a "/processos/0192aa"
    And nenhum token deve existir em cookies legíveis por script, localStorage, sessionStorage, HTML ou respostas do BFF
    And deve gerar registro de auditoria "auth.session_start" com "selection" igual a "AUTO" e o hash da sessão

  Scenario: [Sucesso] Primeiro login vincula o sub ao usuário convidado
    Given que o usuário de "Rafael" foi criado pelo convite com "authentikUserId" preenchido e "externalSubject" vazio
    When "Rafael" concluir o login pela primeira vez
    Then "externalSubject" deve ser preenchido com o "sub" do token
    And "lastLoginAt" deve ser atualizado
    And a auditoria "auth.session_start" deve registrar "firstLogin" verdadeiro

  Scenario: [Sucesso] A API valida token e contexto em toda requisição
    Given que "Cláudia" tem sessão ativa
    When o navegador chamar "GET /api/v1/me" pelo BFF
    Then o BFF deve encaminhar com "Authorization: Bearer" e "X-Tenant-Id" da sessão
    And a API deve validar assinatura, "iss", "aud", "exp" e "nbf" e responder 200

  Scenario: [Validação] returnTo externo é descartado
    When o navegador chamar "/api/auth/login?returnTo=//site-malicioso.com/x"
    Then após o login "Cláudia" deve ser levada a "/painel"
    And nenhum redirecionamento para outra origem deve ocorrer

  Scenario: [Validação] state divergente no callback
    Given que o cookie de transação contém o state "S1"
    When o Authentik redirecionar para o callback com o state "S2"
    Then nenhuma sessão deve ser criada
    And "Cláudia" deve ver "Não foi possível concluir a entrada. Tente novamente." na página de entrada

  Scenario: [Validação] id_token com nonce incorreto
    When o callback receber um id_token cujo "nonce" difere do da transação
    Then nenhuma sessão deve ser criada e deve ser registrado log "warn" "auth.callback_rejected"

  Scenario: [Permissão] Usuário bloqueado pela plataforma
    Given que o usuário de "Bruno" está com status "BLOCKED"
    When "Bruno" concluir o login no Authentik
    Then nenhuma sessão deve ser criada
    And "Bruno" deve ver a página de erro 403 "Seu acesso ao ContrataFlow está bloqueado"

  Scenario: [Permissão] Vínculo suspenso não permite acesso
    Given que o único vínculo de "Bruno" está "SUSPENDED"
    When "Bruno" concluir o login
    Then "Bruno" deve ver a página "sem vínculo"
    And qualquer chamada a "/api/v1/processes" deve responder 403 com código "MEMBERSHIP_INACTIVE"

  Scenario: [Tenant incorreto] Cabeçalho de tenant forjado pelo navegador
    Given que "Cláudia" tem sessão ativa na "Prefeitura de São José"
    And existe a instituição "Prefeitura de Santa Luzia" em que "Cláudia" não tem vínculo
    When o navegador enviar "X-Tenant-Id" da "Prefeitura de Santa Luzia" em "GET /api/v1/processes"
    Then o BFF deve descartar o cabeçalho e usar o tenant da sessão
    And nenhum dado da "Prefeitura de Santa Luzia" deve ser lido
    When uma chamada direta à API usar o token de "Cláudia" com "X-Tenant-Id" da "Prefeitura de Santa Luzia"
    Then a API deve responder 403 com código "MEMBERSHIP_INACTIVE"

  Scenario: [Tenant incorreto] Instituição em encerramento
    Given que a "Prefeitura de Santa Luzia" está "OFFBOARDING" e "Paulo" tem vínculo ativo com o perfil "AUDITOR"
    When "Paulo" entrar e selecionar a "Prefeitura de Santa Luzia"
    Then deve ver a faixa "Instituição em encerramento: somente leitura e exportação"
    And qualquer comando deve responder 403 com código "TENANT_SUSPENDED"

  Scenario: [Duplicidade] Reenvio do mesmo callback
    Given que "Cláudia" concluiu o login com o código "C1" e o state "S1"
    When o mesmo callback com "C1" e "S1" for reenviado
    Then a requisição deve ser recusada sem criar segunda sessão
    And deve existir apenas uma sessão de "Cláudia" originada de "C1"

  Scenario: [Duplicidade] Login iniciado em duas abas
    When "Cláudia" iniciar o login em duas abas antes de concluir qualquer uma
    Then as duas transações devem coexistir no cookie de transação
    And concluir o login em cada aba deve funcionar sem erro de state

  Scenario: [Concorrência] Dois primeiros logins simultâneos do mesmo usuário
    Given que "externalSubject" de "Rafael" está vazio
    When dois callbacks de "Rafael" forem processados ao mesmo tempo
    Then "externalSubject" deve ser gravado uma única vez
    And as duas sessões devem ser criadas e válidas

  Scenario: [Falha de banco] Banco indisponível ao iniciar a sessão
    Given que o PostgreSQL está indisponível
    When "Cláudia" concluir o login no Authentik
    Then nenhuma sessão deve ser criada
    And "Cláudia" deve ver a página de indisponibilidade com o correlationId e o botão "Tentar novamente"

  Scenario: [Falha de integração] Authentik indisponível na troca do código
    Given que o endpoint de token do Authentik não responde
    When o callback tentar trocar o código
    Then nenhuma sessão deve ser criada
    And "Cláudia" deve ver "O serviço de autenticação está indisponível. Tente novamente em instantes."

  Scenario: [Falha de integração] Redis de sessões indisponível
    Given que o Redis de sessões está indisponível
    When o callback tentar criar a sessão
    Then o BFF deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e "Retry-After"
    And nenhum cookie de sessão deve ser emitido

  Scenario: [Falha de integração] Rotação de chaves com JWKS indisponível
    Given que a API tem as chaves do Authentik em cache e o endpoint JWKS está fora do ar
    When chegar um token assinado com chave já conhecida
    Then a requisição deve ser aceita
    When chegar um token com "kid" desconhecido
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e registrar alerta
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Transação de login inválida/expirada | 302 → SCR-001 | `UNAUTHENTICATED` | "Não foi possível concluir a entrada. Tente novamente." | Botão "Entrar" disponível |
| Authentik devolve erro ou está indisponível | 302 → SCR-001 / 503 | `DEPENDENCY_UNAVAILABLE` | "O serviço de autenticação está indisponível. Tente novamente em instantes." | Mantém `returnTo` |
| Sem sessão em `/api/v1/*` | 401 | `UNAUTHENTICATED` | "Entre para continuar." | Redireciona a SCR-001 com `returnTo` |
| Usuário bloqueado | 403 | `PERMISSION_DENIED` | "Seu acesso ao ContrataFlow está bloqueado." | SCR-111 (403) com "Sair" |
| Sem vínculo utilizável | 403 | `MEMBERSHIP_INACTIVE` | "Sua conta não tem acesso ativo a nenhuma instituição." | SCR-111 "sem vínculo" |
| Instituição indisponível/encerrando | 403 | `TENANT_SUSPENDED` | "Esta instituição está temporariamente indisponível." | SCR-111 ou faixa de somente leitura |
| CSRF (cabeçalho/origem) | 403 | `PERMISSION_DENIED` | "Requisição não permitida. Recarregue a página." | Recarrega a página |
| Excesso de tentativas | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns instantes." | Respeita `Retry-After` |
| Banco, Redis de sessões ou JWKS indisponíveis | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível entrar agora. Tente novamente em instantes." | SCR-111 (manutenção) com correlationId |

## Dependências
- **Stories:** US-078 (Authentik e Redis locais, *blueprint*), US-080 (pipeline de guards da API), US-086 (shell, cliente de API, SCR-111). Indiretas: US-081, US-084 (correlationId), US-100 (contexto de tenant e RLS), US-073 (auditoria — até sua entrega, `auth.session_start` é só log estruturado), US-088, US-091, US-093, US-097.
- **Decisões/ADRs:** DEC-012, DEC-053, DEC-130, DEC-131, DEC-132, DEC-135, DEC-137, DEC-138, DEC-140, DEC-141, PEND-18; ADR-003.
- **Configurações:** `security.sessionIdleMinutes`, `security.sessionAbsoluteHours`.
- **Lacunas nas fontes canônicas:**
  1. Não há contrato BFF → API para início de sessão, vínculo do `sub` e registro de `auth.session_start`/`auth.tenant_switch`. Proposta: `POST /internal/session-events` (fora de `/api/v1`, rede privada, credencial de serviço do BFF + access token do usuário), a consolidar em authentication.md e api.md.
  2. Nome do cookie de transação de login não definido; proposto `__Host-cf_auth`.
  3. Layout de chaves do Redis de sessões não definido; proposto `cf:{env}:sess:{sidHash}` (registro) e `cf:{env}:sess:user:{userId}` (índice por usuário).
  4. `ME-04`, o início de sessão e `USR-06` leem vínculos de vários tenants, o que o RLS `FORCE` impede; proposta: funções `SECURITY DEFINER` restritas (ex.: `cf_user_memberships(user_id)`), a documentar em multi-tenancy.md, e exceção explícita a `X-Tenant-Id` em DEC-132.
  5. events.md §7 não define em qual tenant registrar `auth.session_start` antes da seleção nem logins sem vínculo; adotado RN-IAM-17.
  6. Não há código de erro para usuário bloqueado (`User.status = BLOCKED`) nem para falha de CSRF; adotado `PERMISSION_DENIED`; propõe-se `USER_BLOCKED`.

## Impacto técnico
- Estabelece o pipeline autenticado usado por todas as stories: middleware de rotas protegidas, proxy `/api/v1/*`, `SessionStore` (Redis de sessões) e, na API, `JwtAuthGuard` + `TenantContextGuard` (DEC-132).
- O Redis de sessões é crítico (DEC-131): em produção, cluster Multi-AZ com failover e instância separada do cache/filas; as chaves de sessão não usam o wrapper `TenantCache` (são de plataforma).
- Validação de JWT com chaves em cache: custo < 1 ms por requisição; renovação do JWKS por `kid` desconhecido protegida contra abuso (1 vez/30 s).
- As tabelas de identidade (`users`, `tenant_memberships`, `membership_departments`) nascem aqui; convites (US-091) e gestão (US-092) as estendem sem novas colunas.
- Riscos: configuração incorreta do Authentik (RS-06) mitigada por *blueprint* versionado e E2E com Authentik real; sequestro de sessão (RS-05) mitigado por cookie `__Host-`, rotação no login e expiração (US-088).

## Backend
- **Módulo(s):** `identity` (dono de `User`, `TenantMembership`, `MembershipDepartment`; `IdentityResolver`, `AuthentikAdminClient` em `infrastructure`), `tenancy` (`TenantContextService`, status do tenant), `audit` (`AuditService`), `platform` (JWT/JWKS, `AsyncLocalStorage`).
- **Casos de uso:** `StartSessionCommand` (vínculo do `sub`, `lastLoginAt`, vínculos utilizáveis); `RecordSessionTenantCommand` (confere vínculo e grava `auth.session_start`); `ListMyMembershipsQuery` (`ME-04`).
- **Domínio:** `User.bindExternalSubject(sub)` (idempotente; falha se já vinculado a outro `sub`); `TenantMembership.isUsable(now, tenantStatus, roles)`.
- **Guards (ordem):** `JwtAuthGuard` → `TenantContextGuard` → (US-090) MFA → (US-097) autorização.
- **BFF (`apps/web/src/server/auth`):** cliente OIDC (descoberta, JWKS, troca de código), `TransactionCookie` (cifra/decifra), `SessionStore` (cria, lê, rotaciona, índice por usuário), `ApiProxy` (`/api/v1/[...path]`), middleware de rotas protegidas.
- **Transação:** o vínculo do `sub` e `lastLoginAt` em uma transação sobre `users` (`UPDATE … WHERE external_subject IS NULL`; conflito no índice único → relê); `auth.session_start` na transação da instituição ativa.

## Frontend
- **Tela(s):** SCR-001 (`/entrar`), SCR-101 (`/selecionar-orgao`, lista simples — completada na US-093), SCR-111 (`/erro/*`: "sem vínculo", 403 bloqueado, indisponibilidade).
- **Componentes:** `LoginCard` (marca, título, botão principal), `LoginReasonMessage` (motivos), `PrivacyNotice` (links para política de privacidade e termos de uso), `HelpLink`, `InstitutionList` (SCR-101), `NoMembershipPage`.
- **Estados:** botão "Entrar" com estado "Redirecionando…"; mensagens de motivo em `role="status"`; erro com correlationId copiável; sem skeleton (página estática).
- **Acessibilidade e responsividade:** foco inicial no título, botão alcançável por teclado, contraste AA, `lang="pt-BR"`; layout de coluna única a partir de 360 px; páginas do Authentik com o mesmo tema e testadas com axe.

## Banco de dados
- **Tabelas:** `users` (plataforma, sem RLS), `tenant_memberships` e `membership_departments` (RLS `ENABLE` + `FORCE`, FKs compostas) conforme entities.md §4.2.
- **Migrações:** criação das três tabelas; função `cf_user_memberships(p_user_id uuid)` `SECURITY DEFINER` (dono com `BYPASSRLS`, `search_path` fixo, retorna apenas `tenant_id`, nome e status do tenant, `id`, `type`, `status` e `expires_at` do vínculo; `EXECUTE` concedido ao papel da aplicação).
- **Índices/constraints relevantes:** `UNIQUE` em `users.email`, `users.external_subject`, `users.authentik_user_id`; `UNIQUE (tenant_id, user_id)` em `tenant_memberships`; índice `(tenant_id, status)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| BFF | GET | `/api/auth/login?returnTo=` | `returnTo?` | 302 → Authentik; cookie de transação | 302, 429 |
| BFF | GET | `/api/auth/callback?code=&state=` | — | 302 → `returnTo`, SCR-101 ou SCR-111; cookie `__Host-cf_session` | 302, 429, 503 |
| BFF | GET | `/api/auth/session` | — | `200 { data: { user, activeTenant, idleExpiresAt, absoluteExpiresAt, readOnly } }` | 200, 401 |
| BFF | * | `/api/v1/*` | cabeçalhos reconstruídos | resposta da API | conforme rota, 401, 503 |
| ME-04 | GET | `/api/v1/me/memberships` | sem `X-Tenant-Id` | `200 { data: [{ membershipId, tenant { id, name, status }, type, status, expiresAt, usable }] }` | 200, 401 |
| ME-01 | GET | `/api/v1/me` | — | `200 { data: { id, displayName, email, activeMembership } }` | 200, 401, 403 |
| proposto | POST | `/internal/session-events` | `{ type: "SESSION_STARTED" \| "TENANT_SWITCHED", sessionIdHash, tenantId?, selection?, ip, userAgent }` | `200 { data: { user, memberships[], mfaRequired } }` | 200, 401, 403, 503 |

Exemplo de `GET /api/auth/session`:
```json
{ "data": {
    "user": { "id": "0192…", "displayName": "Cláudia Ferreira" },
    "activeTenant": { "id": "0192…", "name": "Prefeitura de São José", "status": "ACTIVE" },
    "idleExpiresAt": "2026-10-06T14:30:00Z", "absoluteExpiresAt": "2026-10-07T01:00:00Z",
    "readOnly": false } }
```

## Logs
- `info` `auth.login_started` — `returnToAccepted` (booleano), IP mascarado.
- `info` `auth.session_created` — `userId`, `tenantId`, `selection`, prefixo de 8 caracteres do `sessionIdHash`, `durationMs`.
- `warn` `auth.callback_rejected` — motivo (`STATE_MISMATCH`, `NONCE_MISMATCH`, `TOKEN_INVALID`, `PROVIDER_ERROR`).
- `warn` `auth.return_to_rejected`; `warn` `auth.jwks_refresh` (`kid`, resultado).
- `error` `auth.token_exchange_failed` — status do provedor, `correlationId`.
- **Nunca logar:** `code`, `state`, `nonce`, `code_verifier`, tokens, valores de cookies, senhas, e-mail completo (mascarar `c***@saojose.sp.gov.br`).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `auth.session_start` | `SECURITY` | Instituição ativada na sessão (automática, padrão ou escolhida) | `metadata`: `selection`, `firstLogin`, `amr`; colunas `sessionIdHash`, `ip`, `userAgent`, `actorMembershipId` |

## Testes necessários
- **Unitários:** validador de `returnTo` com corpus de *open redirect* (`//`, `/\`, `%2f%2f`, `javascript:`, CR/LF, Unicode); geração PKCE; cifragem do cookie de transação; validador de `id_token` (assinatura, `iss`, `aud`, `nonce`, `exp`, `alg none`); `TenantMembership.isUsable` por status de tenant.
- **Integração (Testcontainers):** Authentik real + Redis + PostgreSQL: login completo; vínculo do `sub` concorrente; rotação de chaves JWKS; função `cf_user_memberships` não retorna dados além do próprio usuário.
- **API/contrato:** `ME-04` e `ME-01` conforme api.md; 401/403/503 com RFC 9457.
- **RBAC e multi-tenant:** `X-Tenant-Id` forjado; vínculo de outro tenant; tenant `SUSPENDED`/`OFFBOARDING`.
- **Segurança:** Playwright verifica ausência de tokens em cookies legíveis, *storage* e DOM; atributos do cookie; anti-fixação (sid muda a cada login); CSRF em métodos mutáveis.
- **E2E (Playwright):** login com 1 e com 2 vínculos; "sem vínculo"; retorno a `returnTo`; 360 px.
- **Acessibilidade/performance:** axe em SCR-001, SCR-101 e SCR-111; k6 com 100 logins/min → callback p95 < 800 ms (sem Authentik); validação de JWT p95 < 2 ms.

## Definition of Done
- [ ] Cenários Gherkin automatizados (BFF/API + E2E com Authentik real) e passando no CI
- [ ] Nenhum token acessível ao navegador (teste automatizado) e cookie com atributos de DEC-131
- [ ] Pipeline de contexto da API (DEC-132) aplicado a todas as rotas, inclusive status do tenant
- [ ] Auditoria `auth.session_start` verificada em teste (após US-073)
- [ ] Teste de isolamento incluído na suíte "tenant leak" (`X-Tenant-Id` forjado)
- [ ] OpenAPI de `ME-01`/`ME-04` compatível com api.md; contrato interno documentado em authentication.md
- [ ] Logs sem tokens/códigos; métricas `auth_logins_total{result}` e latência do callback; trace BFF → API
- [ ] SCR-001/SCR-101/SCR-111 acessíveis (axe) e responsivas (360 px)
- [ ] Revisão de código e de segurança aprovadas; *blueprint* do Authentik revisado

## Estimativa
**L** — envolve BFF (OIDC, PKCE, cookies, proxy), API (JWT/JWKS, contexto DEC-132, vínculo do `sub`), Redis de sessões em alta disponibilidade, função de leitura entre tenants, três telas e testes com Authentik real.

## Prioridade
**P0** — sem login não há uso do produto; todas as stories autenticadas dependem deste pipeline.
