---
id: US-182
title: "Entrar com gov.br via Authentik"
epic: EP-029
feature: FT-084
mvp: 2
priority: P1
estimate: L
status: Especificada
depends_on: [US-087, US-103]
modules: [identity, tenancy, audit, platform]
screens: [SCR-001, SCR-101, SCR-111]
endpoints: [GOV-01, GOV-02, GOV-03]
permissions: []
events: [GovbrIdentityLinked]
---

# US-182 — Entrar com gov.br via Authentik

## Título
Entrar com gov.br via Authentik

## Descrição
**Como** servidor de um órgão contratante que já tem conta gov.br, **quero** entrar no ContrataFlow pelo botão "Entrar com gov.br" da tela de entrada, **para** acessar o sistema com a conta que já uso, sem mais uma senha, sem que o gov.br dê acesso a quem o órgão não convidou e sem que o ContrataFlow guarde o CPF em claro.

O botão em `/entrar` (SCR-001) aparece só quando o ambiente está credenciado no Login Único e algum órgão habilitou o gov.br (`auth.govbrEnabled`). Ele leva o navegador a uma rota do BFF (`GET /api/auth/govbr/start`), que inicia o Authorization Code + PKCE de sempre no Authentik já direcionado à **fonte OIDC do gov.br**; o navegador vai ao gov.br, volta ao Authentik e ao callback do BFF. A API de domínio não fala com o gov.br: quando o Authentik pergunta "de quem é esta conta gov.br?", ela responde por uma rota interna (`GOV-02`) que decide **entrar**, **vincular pelo CPF** (`CPF_MATCH`) ou **recusar com orientação**. Sessão, cookie `__Host-cf_session` e validação do JWT na API não mudam (ADR-017); a sessão ganha apenas `loginMethod`, `govbrTrustLevel` e `govbrAuthenticatedAt`.

## Contexto
- PEND-18 ficou fora do MVP 1 e foi resolvida pela DEC-207 e pela [ADR-017](../adr/adr-017-govbr-login.md): gov.br é **fonte federada no Authentik** (DEC-130); o login nativo da DEC-187 conduz o *flow* de senha no servidor e **não** serve para federação, que exige levar o navegador ao provedor. Esta story entrega o caminho de entrada; o vínculo em "Meu perfil" e a desvinculação são da US-183, e as chaves de configuração do órgão são da US-184.
- **gov.br autentica, não dá acesso** (DEC-207, DEC-012): sem `TenantMembership` ativo a entrada é recusada; sem vínculo de identidade também; nada cria `User`, convite ou vínculo de tenant (RN-PLAT-09, feature FT-084). O CPF só serve de chave de comparação: HMAC com a chave de *blind index* da plataforma (DEC-086), máscara na tela, fora de logs (DEC-138, DEC-140).
- O nível de confiança (bronze, prata, ouro) vira atributo da sessão e da auditoria e **não bloqueia** o uso no MVP 2 (RN-PLAT-12); a chave `auth.govbrCountsAsMfa` e o efeito sobre a política de MFA (DEC-133, DEC-142) são da US-184.
- Esta story **não redefine** as RN-PLAT-08 a RN-PLAT-14 da feature FT-084: detalha-as nas RN-PLAT-180 a RN-PLAT-199.
- `/entrar` é pública e não conhece o órgão (domínio único, DEC-141): a disponibilidade do botão é da plataforma ("algum órgão habilitou"); a habilitação **do órgão** é conferida depois, ao escolher a instituição ativa (RN-PLAT-185 e RN-PLAT-189).
- Dependência externa: credenciamento da plataforma no Login Único, por ambiente (não é pendência nova). Sem ele, a fonte não existe, o botão não aparece e o login por usuário e senha segue igual (RN-PLAT-13).
- Pessoas de teste: "Marta" (vinculada), "Lia" (CPF igual ao cadastrado), "Paulo" (conta gov.br sem convite). CPFs aparecem só mascarados (`***.456.789-**`); nomes e dados são fictícios.

## Objetivo
Permitir que um servidor com acesso e identidade vinculada entre com o gov.br em até 3 interações depois do botão (sem digitar senha do ContrataFlow), com 0 usuário ou vínculo de tenant criado por gov.br, 0 CPF ou token do gov.br em log, auditoria e sessão, 100% das recusas com orientação própria e a entrada por usuário e senha intacta quando o gov.br ou a fonte falham.

## Persona
- **Principal:** Servidor com vínculo ativo em um órgão que habilitou o gov.br (qualquer perfil de tenant; Marta).
- **Secundárias:** Servidor com cadastro que ainda não vinculou a conta (Lia, `CPF_MATCH`); pessoa com conta gov.br sem convite (Paulo); administrador do órgão (`ADMIN_ORGAO`), que recebe o pedido de convite; operador da plataforma, que mantém a fonte e o credenciamento.

## Pré-condições
- Plataforma credenciada no Login Único no ambiente, fonte OAuth `gov.br` criada no Authentik e `GOVBR_LOGIN_ENABLED` ligado (lacuna 9); sem isso o botão não existe.
- Ao menos um órgão `ACTIVE` com `auth.govbrEnabled = true` (US-184) para o botão aparecer; o órgão da pessoa precisa ter a chave ligada para a entrada valer.
- A pessoa tem `User` ativo e vínculo `ACTIVE` em um órgão habilitado; a identidade gov.br está vinculada (`PROFILE`, US-183) ou o CPF do gov.br confere com `users.cpf_hash` (`CPF_MATCH`).
- Redis de sessões e API no ar (como na US-087); Authentik com o cliente OIDC do BFF e o fluxo da fonte gov.br publicados por *blueprint*.

## Fluxo principal
1. Em `/entrar` (SCR-001) o servidor da página consulta `GOV-01` (cache de 60 s). Com `govbr.available = true`, a tela mostra, abaixo do formulário de senha e depois do separador "ou", o botão secundário "Entrar com gov.br". Sem disponibilidade, a tela é a do MVP 1.
2. A pessoa clica. O navegador vai a `GET /api/auth/govbr/start?returnTo=…` (rota do BFF, fora da API de domínio). O BFF aplica o limite de 20 req/min por IP, valida `returnTo` (RN-IAM-03), reconfere a disponibilidade e que o Authentik responde (2 s), grava a transação `{ state, nonce, codeVerifier, returnTo, intent: "LOGIN", createdAt }` no cookie `__Host-cf_auth_tx` e responde **302** ao início da fonte gov.br no Authentik, com o `authorize` (PKCE `S256`, mesmo cliente confidencial) como destino de retorno.
3. O navegador vai ao gov.br, a pessoa se autentica lá (senha, certificado, banco, conforme o gov.br) e volta ao Authentik.
4. O fluxo da fonte no Authentik chama `GOV-02` (credencial própria, rede privada) com o CPF do gov.br e o nível de confiança. A API calcula o HMAC em memória e decide (RN-PLAT-183 a RN-PLAT-187): `LOGIN_ALLOWED` com o usuário a autenticar, ou uma recusa.
5. `LOGIN_ALLOWED`: o Authentik autentica como o usuário do ContrataFlow (a identidade vem do **vínculo do ContrataFlow**, não de cadastro do Authentik), grava no token as *claims* `amr` com `govbr`, `govbr_trust_level` e `auth_time`, e redireciona a `GET /api/auth/callback?code=…&state=…`.
6. O BFF valida a transação (`state`, `nonce`, `intent = LOGIN`), troca o código, valida o `id_token` (RN-IAM-04) e lê as *claims* de gov.br. Chama `POST /internal/session-events` (`SESSION_STARTED`, com `loginMethod = GOVBR` e `govbrTrustLevel`).
7. A API **revalida** (usuário `ACTIVE`, vínculo elegível, órgão habilitado — defesa em profundidade, o BFF não decide), atualiza `lastLoginAt` e `lastTrustLevel` e devolve os vínculos, marcando os de órgãos sem gov.br como não utilizáveis (`unusableReason = GOVBR_NOT_ENABLED`, `GOV-03`).
8. O BFF cria a sessão (`sid` novo, RN-IAM-10) com `loginMethod`, `govbrTrustLevel` e `govbrAuthenticatedAt`, escolhe a instituição ativa (RN-PLAT-189) e a ativa na API, que grava `auth.session_start` e `auth.govbr_login` (sucesso) na instituição.
9. O BFF responde **302** a `returnTo` (ou `/painel`; `/selecionar-orgao` com vários órgãos habilitados). Daí em diante a sessão é a de sempre.

## Fluxos alternativos
- **FA-01 — Primeiro uso com CPF igual (`CPF_MATCH`):** sem vínculo de identidade, mas com `users.cpf_hash` igual ao HMAC do CPF do gov.br, usuário ativo e vínculo elegível, a API cria o `UserExternalIdentity` (`linkMethod = CPF_MATCH`), publica `GovbrIdentityLinked` e segue como `LOGIN_ALLOWED`. O usuário recebe o aviso `GOVBR_LINK_CHANGED` (US-183).
- **FA-02 — Conta gov.br sem vínculo (`GOVBR_NOT_LINKED`):** nenhum usuário tem essa identidade nem esse CPF. A entrada é recusada sem sessão, nada é criado, e `/entrar` mostra a orientação dupla (vincular em "Meu perfil" ou pedir o convite).
- **FA-03 — Vinculada, sem acesso ativo (`MEMBERSHIP_REQUIRED`):** a identidade existe, mas não há vínculo `ACTIVE` utilizável em órgão habilitado. Convite `INVITED` não conta: a orientação manda aceitar o convite pelo link do e-mail, entrando com usuário e senha.
- **FA-04 — Órgão não habilitou (`GOVBR_NOT_ENABLED`):** há vínculos ativos, mas só em órgãos com `auth.govbrEnabled = false`. Recusa com a orientação de entrar por usuário e senha.
- **FA-05 — Vários órgãos:** só os de órgãos habilitados são utilizáveis; um habilitado → seleção automática; vários → instituição padrão elegível ou SCR-101, com os demais desabilitados ("Entrada com gov.br não habilitada neste órgão"). A troca de instituição na sessão segue a mesma regra.
- **FA-06 — Usuário bloqueado:** `User.status` `BLOCKED`/`DEACTIVATED` → recusa sem sessão (SCR-111 403 "Seu acesso ao ContrataFlow está bloqueado…", como na US-087).
- **FA-07 — Conflito de contas:** o CPF já pertence a outro cadastro ou o usuário já tem outra conta gov.br ativa (RN-PLAT-187). Recusa genérica, sem revelar quem.
- **FA-08 — Cancelou no gov.br:** a pessoa volta sem autenticar (`access_denied`). `/entrar?motivo=govbr-cancelado`, sem erro técnico.
- **FA-09 — gov.br, Authentik ou resolvedor indisponíveis:** `/entrar?motivo=govbr-indisponivel` (ou `govbr-erro` se o fluxo falhar depois do gov.br), com a sugestão de usar usuário e senha; o formulário de senha continua funcionando.
- **FA-10 — Já autenticado:** com sessão válida, `/entrar` e a rota de início voltam a `returnTo` (FA-07 da US-087).
- **FA-11 — Botão antigo depois de perder a disponibilidade:** `start` responde 302 a `/entrar?motivo=govbr-indisponivel` (RN-PLAT-199).
- **FA-12 — Nível de confiança ausente ou desconhecido:** a entrada vale e `govbrTrustLevel` fica nulo (auditado como "não informado"); nunca conta como segundo fator (US-184).
- **FA-13 — Sessão do ContrataFlow expirada:** quem volta por "Entrar novamente" (`reauth=1`) pode usar o botão; o Authentik pede nova autenticação (`max_age=0`).

## Regras de negócio
- **RN-PLAT-180** — Disponibilidade do botão (detalha RN-PLAT-13): `GOV-01` responde `available = true` só se o ambiente estiver credenciado (`GOVBR_LOGIN_ENABLED` e segredos da fonte presentes) **e** existir ao menos um tenant `ACTIVE` com `auth.govbrEnabled = true`. A resposta não traz nome, id nem número de tenants. O BFF guarda o resultado por 60 s; falha de `GOV-01` oculta o botão (falha fechada) e gera `warn`.
- **RN-PLAT-181** — Rota de início (`GET /api/auth/govbr/start`): pública; limite de 20 req/min por IP (RN-IAM-15); `returnTo` validado (RN-IAM-03); cria transação de até 3 abas no `__Host-cf_auth_tx` com `intent = LOGIN`; Authorization Code + PKCE `S256` do **mesmo cliente confidencial** do BFF; `Cache-Control: no-store`. Não existe segundo cliente OIDC nem segundo emissor.
- **RN-PLAT-182** — Fronteira da integração (detalha RN-PLAT-08): só o Authentik fala com o gov.br; credenciais do Login Único ficam no Secrets Manager do Authentik; o BFF e a API **não** têm `client_secret` nem endpoint do gov.br e **nunca** recebem token do gov.br. O único contato do Authentik com o ContrataFlow, nesta story, é `GOV-02`.
- **RN-PLAT-183** — O resolvedor `GOV-02` decide numa ordem fixa e devolve um resultado único: (1) CPF com dígito verificador válido (senão `INVALID_CPF`, recusa `INTERNAL`); (2) `UserExternalIdentity` ativo com o `subjectHash` do CPF; (3) sem ele, `users.cpf_hash` igual ao HMAC (candidato a `CPF_MATCH`); (4) nenhum dos dois → `GOVBR_NOT_LINKED`; (5) `User.status = ACTIVE`; (6) ao menos um vínculo elegível (RN-PLAT-185); (7) conflitos (RN-PLAT-187). A identidade vem **sempre** do vínculo do ContrataFlow.
- **RN-PLAT-184** — gov.br não cria acesso (detalha RN-PLAT-09): nenhuma recusa nem sucesso cria `User`, `TenantMembership`, convite ou perfil. Códigos: `GOVBR_NOT_LINKED`, `MEMBERSHIP_REQUIRED`, `GOVBR_NOT_ENABLED`, `GOVBR_ACCOUNT_CONFLICT` e, para usuário bloqueado, `PERMISSION_DENIED` com `reason = USER_BLOCKED` (como na US-087). O vínculo de identidade **não** substitui o convite.
- **RN-PLAT-185** — Vínculo elegível para a entrada por gov.br: `TenantMembership.status = ACTIVE`, `expiresAt` nulo ou futuro, tenant utilizável (RN-IAM-08: `ACTIVE`, ou `OFFBOARDING` para `ADMIN_ORGAO`/`AUDITOR`) **e** `auth.govbrEnabled = true` naquele tenant. Vínculo `INVITED` não é elegível: o aceite do convite (USR-06) continua exigindo login por usuário e senha.
- **RN-PLAT-186** — Vínculo automático por CPF (`CPF_MATCH`, detalha RN-PLAT-10): só quando `users.cpf_hash` é igual ao HMAC do CPF do gov.br **e** o usuário está ativo **e** há vínculo elegível **e** o usuário não tem outra conta gov.br ativa **e** não existe desvinculação anterior desse par usuário-conta (RN-PLAT-208, da US-183). Cria a linha (`linkMethod = CPF_MATCH`, `linkedAt` agora, `subjectMasked` derivada do CPF em memória), publica `GovbrIdentityLinked` e grava `identity.govbr_link`, tudo na mesma transação. Sob concorrência o índice único decide: quem perde relê o vínculo vencedor e segue como identidade vinculada, sem segundo evento.
- **RN-PLAT-187** — Conflito de contas: se o `subjectHash` está ativo em um usuário cujo `cpf_hash` é diferente do HMAC (ou se outro usuário tem `cpf_hash` igual ao HMAC), ou se o candidato a `CPF_MATCH` já tem outra conta gov.br ativa, a entrada é recusada com `GOVBR_ACCOUNT_CONFLICT`. A mensagem **não revela** quem é o outro usuário nem que ele existe; o evento vai a log `warn` e à auditoria de falha para a investigação do administrador e da plataforma.
- **RN-PLAT-188** — Sessão gov.br (detalha RN-PLAT-12): o BFF lê `amr` (contém `govbr`), `govbr_trust_level` (`BRONZE`, `SILVER`, `GOLD`; valor ausente ou fora do enum → nulo) e `auth_time`, e grava na sessão `loginMethod = GOVBR`, `govbrTrustLevel` e `govbrAuthenticatedAt`. O nível **não bloqueia** nada nesta story. As *claims* seguem no JWT para a API (`RequestContext.amr`, `authTime`); `GOV-03` expõe `login.method`, `login.govbrTrustLevel` e `login.govbrAuthenticatedAt` em `ME-01`.
- **RN-PLAT-189** — Seleção do órgão numa sessão gov.br: só vínculos elegíveis (RN-PLAT-185) são utilizáveis; um → automática (`selection = AUTO`); vários → padrão elegível (`DEFAULT`) ou SCR-101; `ME-04` marca os demais com `usable = false` e `unusableReason = GOVBR_NOT_ENABLED`. Trocar para órgão sem gov.br habilitado numa sessão gov.br → **403** `GOVBR_NOT_ENABLED` com a orientação de entrar por usuário e senha; a habilitação é conferida na entrada e na troca, **não** em toda requisição (US-184, RN-PLAT-223).
- **RN-PLAT-190** — Sem sessão parcial: diferente do login por senha (FA-02 da US-087, que abre sessão sem instituição para aceitar convite), toda recusa desta story termina **sem** sessão do ContrataFlow, sem cookie `__Host-cf_session`, com os tokens eventualmente emitidos revogados (melhor esforço) e a sessão do fluxo no Authentik encerrada.
- **RN-PLAT-191** — Auditoria `auth.govbr_login` (categoria `SECURITY`, sem evento de domínio — RN-PLAT-14 vale só ao vincular): o **sucesso** é gravado no tenant ativo, junto de `auth.session_start`, com `metadata { result: SUCCESS, govbrTrustLevel, linkMethod, selection }`; a **falha** é auditoria de plataforma (`tenantId` nulo), com `result = FAILURE`, `reasonCode` (`GOVBR_NOT_LINKED`, `MEMBERSHIP_REQUIRED`, `GOVBR_NOT_ENABLED`, `GOVBR_ACCOUNT_CONFLICT`, `USER_BLOCKED`, `CANCELED`, `PROVIDER_ERROR`, `INTERNAL`), `govbrTrustLevel` quando informado e `actorUserId` quando o usuário é conhecido. Nunca CPF nem `subjectHash`; a falha sem usuário conhecido leva apenas `subjectRef` (12 primeiros caracteres do HMAC, lacuna 5) para ligar a recusa ao vínculo feito depois.
- **RN-PLAT-192** — Falhas do provedor: cancelamento no gov.br, gov.br ou Authentik indisponíveis, expiração do fluxo, resolvedor fora ou com erro → `/api/auth/govbr/refused` com o motivo correspondente; nenhuma retentativa automática; o BFF não cria sessão. A indisponibilidade afeta **só** quem usa o gov.br: o login por usuário e senha, o *step-up* e a recuperação de senha não dependem dele (RN-PLAT-13).
- **RN-PLAT-193** — Rota de recusa `GET /api/auth/govbr/refused?reason=`: pública; `reason` ∈ {`NOT_LINKED`, `MEMBERSHIP_REQUIRED`, `NOT_ENABLED`, `CONFLICT`, `BLOCKED`, `CANCELED`, `PROVIDER_ERROR`, `INTERNAL`}; valor fora da lista vira `INTERNAL`; a mensagem sai de tabela fixa e **nunca** repete o parâmetro; apaga a transação correspondente do cookie e responde **302** a `/entrar?motivo=govbr-…` (tabela em "Casos de erro"); com transação `intent = LINK` (US-183) volta a `/perfil?aba=seguranca&govbr=…`. O BFF não grava auditoria por conta própria: nas recusas decididas pelo `GOV-02` a API já gravou; nos erros do provedor (cancelamento, gov.br ou Authentik fora) o BFF envia `GOVBR_LOGIN_FAILED` ao `POST /internal/session-events`.
- **RN-PLAT-194** — Credencial e tratamento de dados do `GOV-02`: cabeçalho `X-CF-Resolver-Token` (segredo próprio, no Secrets Manager, comparação em tempo constante, rotacionável), aceito só da rede do Authentik; o CPF chega apenas no corpo, é normalizado, validado e transformado em HMAC **em memória**, e nunca é persistido, logado, auditado, devolvido ou colocado em cache; `trustLevel` fora do enum vira nulo. Sem a credencial → 401 `UNAUTHENTICATED`.
- **RN-PLAT-195** — Rastros do login: ao criar a sessão com sucesso, `UserExternalIdentity.lastLoginAt` e `lastTrustLevel` são atualizados (só avançam no tempo, dois logins simultâneos não regridem o valor) e `User.lastLoginAt` como na RN-IAM-16.
- **RN-PLAT-196** — Anti-fixação, *replay* e CSRF: `state`, `nonce` e PKCE como na US-087 (uso único, 10 min); `sid` novo a cada login; um código emitido numa transação com `intent = LINK` (US-183) **não** cria sessão de login, e o contrário também; callback com `intent` ausente ou divergente da transação é rejeitado (`auth.callback_rejected`, `INTENT_MISMATCH`).
- **RN-PLAT-197** — Limites: 20 req/min por IP em `start`, `callback` e `refused`; excedido → 429 `RATE_LIMITED` com `Retry-After`, sem tocar o Authentik.
- **RN-PLAT-198** — Saída: o logout é o do MVP 1 (US-088, sem *end-session* do Authentik — DEC-187). O Login Único mantém a própria sessão no navegador; por isso, ao sair de uma sessão aberta por gov.br, `/entrar?motivo=saiu-govbr` avisa "Você saiu do ContrataFlow. Sua sessão no gov.br pode continuar aberta neste navegador; saia também do gov.br se o computador for compartilhado." (lacuna 8).
- **RN-PLAT-199** — Sem credenciamento ou sem órgão habilitado: não há fonte utilizável, `GOV-01` devolve `available = false`, o botão não é renderizado e `start` (chamada direta ou botão antigo) responde 302 a `/entrar?motivo=govbr-indisponivel`, sem expor se o motivo é credenciamento ou habilitação.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Botão "Entrar com gov.br" | `govbr.available` (`GOV-01`) | booleano | — | RN-PLAT-180 | calculado |
| *(técnico)* Retorno | `returnTo` (query de `start`) | texto | Não | RN-IAM-03 | `/painel` |
| *(técnico)* Transação | `state`, `nonce`, `codeVerifier`, `returnTo`, `intent`, `createdAt` | cookie cifrado | Sim (no callback) | RN-PLAT-181, RN-PLAT-196 | BFF |
| *(técnico)* Motivo da recusa | `reason` (query de `refused`) | texto | Sim | RN-PLAT-193 | Authentik / BFF |
| *(técnico)* CPF do gov.br | `cpf` (corpo de `GOV-02`) | texto (11 dígitos) | Sim | RN-PLAT-194; DV válido; nunca persistido | Authentik |
| *(técnico)* Nível informado | `trustLevel` (corpo de `GOV-02`) | `BRONZE`/`SILVER`/`GOLD`/nulo | Não | RN-PLAT-188 | gov.br via Authentik |
| *(técnico)* Claims de login | `amr`, `govbr_trust_level`, `auth_time` | token | Sim (gov.br) | RN-PLAT-188 | Authentik |
| *(sessão)* Origem do login | `loginMethod`, `govbrTrustLevel`, `govbrAuthenticatedAt` | `PASSWORD`/`GOVBR`, enum, data/hora | Sim | RN-PLAT-188 | BFF |
| *(sistema)* Último acesso gov.br | `UserExternalIdentity.lastLoginAt`, `lastTrustLevel` | timestamptz, `GovbrTrustLevel` | — | RN-PLAT-195 | API |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `returnTo` inválido ou externo | BFF | — (substituído por `/painel`) | — |
| V-02 | `state` ausente, expirado ou divergente; `intent` divergente | BFF | "Não foi possível concluir a entrada. Tente novamente." | `UNAUTHENTICATED` (interno; redireciona a SCR-001) |
| V-03 | `id_token` inválido ou troca do código recusada | BFF | "Não foi possível concluir a entrada com gov.br. Tente novamente." | `UNAUTHENTICATED` |
| V-04 | CPF do gov.br com dígito verificador inválido ou ausente | API (`GOV-02`) | "Não foi possível concluir a entrada com gov.br. Tente novamente." | `VALIDATION_ERROR` (`INVALID_CPF`) → recusa `INTERNAL` |
| V-05 | `X-CF-Resolver-Token` ausente ou inválido | API (`GOV-02`) | — | `UNAUTHENTICATED` |
| V-06 | Identidade sem usuário nem CPF cadastrado | API (`GOV-02`) | Orientação de `govbr-nao-vinculado` | `GOVBR_NOT_LINKED` |
| V-07 | Sem vínculo `ACTIVE` utilizável | API | Orientação de `govbr-sem-acesso` | `MEMBERSHIP_REQUIRED` |
| V-08 | Órgão sem `auth.govbrEnabled` (entrada, troca) | API | Orientação de `govbr-nao-habilitado` | `GOVBR_NOT_ENABLED` |
| V-09 | Conflito de contas | API | Orientação de `govbr-conflito` | `GOVBR_ACCOUNT_CONFLICT` |
| V-10 | Usuário bloqueado ou desativado | API | "Seu acesso ao ContrataFlow está bloqueado. Procure o suporte da sua instituição." | `PERMISSION_DENIED` (`reason = USER_BLOCKED`) |
| V-11 | `reason` fora da lista em `refused` | BFF | Mensagem de `govbr-erro` | — |
| V-12 | Excesso de tentativas | BFF | "Muitas tentativas. Aguarde alguns instantes." | `RATE_LIMITED` |

## Permissões
- **Permissão:** nenhuma; entrar é capacidade implícita de quem tem identidade vinculada e vínculo ativo (permissions.md §7). `GOV-01` e `GOV-02` não são rotas de usuário: usam credenciais de serviço.
- **Políticas:** POL-29 (entrada por gov.br sem vínculo ou sem `TenantMembership` ativo é recusada — `GOVBR_NOT_LINKED`, `MEMBERSHIP_REQUIRED`); contexto da DEC-132 (usuário `ACTIVE`, vínculo `ACTIVE` não expirado, tenant utilizável).
- **MFA:** não exigida por esta story; o gov.br **não conta** como segundo fator enquanto `auth.govbrCountsAsMfa = NEVER` (padrão); com a chave ligada, a US-184 define o efeito. Sessão gov.br sem MFA real recebe `MFA_REQUIRED` e *step-up* como qualquer outra (POL-14).
- **Sem permissão:** sem vínculo de identidade, sem acesso ativo, órgão sem habilitação, conflito ou bloqueio → recusa sem sessão, com a orientação do motivo; nada indica a existência de outro usuário.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `GovbrIdentityLinked` | `identity.govbr_linked` | Só no vínculo automático por CPF (`linkMethod = CPF_MATCH`) | Payload `userId`, `linkMethod`, `trustLevel`; sem CPF nem hash; envelope de plataforma (`tenantId` nulo). O vínculo `PROFILE` e `GovbrIdentityUnlinked` são da US-183 |
| — | — | Login por gov.br | Sem evento de domínio; a trilha é a auditoria `auth.govbr_login` (events.md §7) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `GOVBR_LINK_CHANGED` (consumidor da US-183) | O próprio usuário | In-app e e-mail (obrigatória) | Depois de `GovbrIdentityLinked` por `CPF_MATCH`; o texto e a regra de entrega estão na US-183 |

## Critérios de aceite em Gherkin
```gherkin
Feature: Entrar com gov.br via Authentik

  Background:
    Given que a plataforma está credenciada no Login Único e a fonte "gov.br" existe no Authentik
    And o tenant "Prefeitura A" está ativo com "auth.govbrEnabled" ligado
    And "Marta" tem vínculo "ACTIVE" na "Prefeitura A" e a conta gov.br vinculada com o método "PROFILE"

  Scenario: [Sucesso] Entrar com gov.br e voltar à página pedida
    Given que "Marta" não tem sessão e acessa "/processos/0192aa"
    When "Marta" for a "/entrar" e escolher "Entrar com gov.br"
    And concluir a autenticação no gov.br
    Then o BFF deve criar uma sessão nova com o cookie "__Host-cf_session" marcado como HttpOnly, Secure e SameSite=Lax
    And a instituição ativa deve ser a "Prefeitura A" sem exibir a seleção
    And "Marta" deve ser levada a "/processos/0192aa"
    And nenhum token do gov.br deve existir no navegador, no BFF ou na API
    And deve gerar registro de auditoria "auth.govbr_login" com resultado "SUCCESS" e o nível de confiança
    And deve gerar registro de auditoria "auth.session_start" com "loginMethod" igual a "GOVBR"

  Scenario: [Sucesso] Nível de confiança na sessão e na auditoria
    Given que o gov.br informa o nível "SILVER" para "Marta"
    When "Marta" entrar com gov.br
    Then a sessão deve registrar "govbrTrustLevel" igual a "SILVER" e "govbrAuthenticatedAt"
    And "GET /me" deve devolver "login.method" igual a "GOVBR" e "login.govbrTrustLevel" igual a "SILVER"
    And o nível não deve bloquear nenhuma ação de "Marta"

  Scenario: [Sucesso] Primeiro uso com CPF igual ao cadastrado
    Given que "Lia" tem vínculo "ACTIVE" na "Prefeitura A", CPF cadastrado igual ao do gov.br e nenhuma identidade vinculada
    When "Lia" entrar com gov.br
    Then "Lia" deve entrar na "Prefeitura A"
    And deve existir uma identidade gov.br de "Lia" com o método "CPF_MATCH"
    And deve gerar o evento "GovbrIdentityLinked" com "linkMethod" igual a "CPF_MATCH"
    And deve gerar registro de auditoria "identity.govbr_link"
    And o CPF não deve aparecer em log, auditoria, evento nem resposta

  Scenario: [Sucesso] Vários órgãos, só um habilitado
    Given que "Marta" também tem vínculo "ACTIVE" na "Prefeitura B", sem "auth.govbrEnabled"
    When "Marta" entrar com gov.br
    Then a "Prefeitura A" deve ser ativada automaticamente
    And "ME-04" deve marcar a "Prefeitura B" com "usable" falso e "unusableReason" igual a "GOVBR_NOT_ENABLED"

  Scenario: [Sucesso] Gov.br fora do ar não afeta usuário e senha
    Given que o gov.br está indisponível
    When "Marta" entrar com usuário e senha
    Then a entrada deve seguir o fluxo de sempre e a sessão deve ter "loginMethod" igual a "PASSWORD"

  Scenario: [Validação] returnTo externo é descartado
    When o navegador chamar "/api/auth/govbr/start?returnTo=//site-malicioso.com/x"
    Then após o login "Marta" deve ser levada a "/painel"
    And nenhum redirecionamento para outra origem deve ocorrer

  Scenario: [Validação] state divergente no callback
    Given que o cookie de transação contém o state "S1"
    When o Authentik redirecionar ao callback com o state "S2"
    Then nenhuma sessão deve ser criada
    And "Marta" deve ver "Não foi possível concluir a entrada. Tente novamente." em "/entrar"

  Scenario: [Validação] Motivo de recusa fora da lista
    When o navegador abrir "/api/auth/govbr/refused?reason=<script>"
    Then "/entrar" deve exibir a mensagem de "govbr-erro" sem repetir o valor informado

  Scenario: [Validação] CPF inválido vindo do fluxo
    When o Authentik chamar "GOV-02" com um CPF de dígito verificador inválido
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_CPF"
    And o fluxo deve terminar sem sessão em "/entrar?motivo=govbr-erro"

  Scenario: [Permissão] Conta gov.br sem vínculo não dá acesso
    Given que "Paulo" tem conta gov.br, nenhuma identidade vinculada e nenhum usuário com o CPF dele
    When "Paulo" escolher "Entrar com gov.br"
    Then a entrada deve ser recusada com a orientação de vincular em "Meu perfil" ou pedir o convite ao administrador
    And nenhum usuário, convite nem vínculo de tenant deve ser criado
    And deve gerar registro de auditoria "auth.govbr_login" com resultado "FAILURE" e "reasonCode" "GOVBR_NOT_LINKED"

  Scenario: [Permissão] Identidade vinculada sem vínculo ativo
    Given que o único vínculo de "Marta" está "SUSPENDED"
    When "Marta" entrar com gov.br
    Then a entrada deve ser recusada com o código "MEMBERSHIP_REQUIRED" e nenhuma sessão deve ser criada
    And a auditoria deve registrar a falha com o "actorUserId" de "Marta"

  Scenario: [Permissão] Convite pendente não vale para gov.br
    Given que o vínculo de "Marta" na "Prefeitura A" está "INVITED"
    When "Marta" entrar com gov.br
    Then a entrada deve ser recusada com a orientação de aceitar o convite entrando com usuário e senha

  Scenario: [Permissão] Usuário bloqueado
    Given que o usuário de "Marta" está com status "BLOCKED"
    When "Marta" concluir a autenticação no gov.br
    Then nenhuma sessão deve ser criada
    And "Marta" deve ver "Seu acesso ao ContrataFlow está bloqueado"

  Scenario: [Tenant incorreto] Órgão sem gov.br habilitado
    Given que "Marta" só tem vínculo "ACTIVE" na "Prefeitura B", sem "auth.govbrEnabled"
    When "Marta" entrar com gov.br
    Then a entrada deve ser recusada com o código "GOVBR_NOT_ENABLED"
    And nenhuma sessão deve ser criada

  Scenario: [Tenant incorreto] Troca de instituição para órgão sem gov.br
    Given que "Marta" está numa sessão gov.br na "Prefeitura A" e também tem vínculo ativo na "Prefeitura B", sem gov.br
    When "Marta" tentar trocar para a "Prefeitura B"
    Then a API deve responder 403 com código "GOVBR_NOT_ENABLED"
    And a sessão deve continuar na "Prefeitura A"

  Scenario: [Tenant incorreto] A disponibilidade não revela órgãos
    When qualquer pessoa consultar a disponibilidade do botão
    Then a resposta deve conter só "available" e nenhum dado de tenant

  Scenario: [Duplicidade] Reenvio do mesmo callback
    Given que "Marta" concluiu o login com o código "C1" e o state "S1"
    When o mesmo callback for reenviado
    Then a requisição deve ser recusada sem criar segunda sessão

  Scenario: [Duplicidade] Duplo clique no botão
    When "Marta" clicar duas vezes em "Entrar com gov.br"
    Then as duas transações devem coexistir no cookie e concluir uma delas deve funcionar sem erro de state

  Scenario: [Duplicidade] Transação de vínculo não abre sessão de login
    Given que existe uma transação com "intent" igual a "LINK" no navegador
    When o callback chegar com um código dessa transação sem sessão
    Then nenhuma sessão de login deve ser criada

  Scenario: [Concorrência] Dois primeiros logins simultâneos por CPF
    Given que "Lia" tem CPF igual ao do gov.br e nenhuma identidade vinculada
    When dois logins gov.br de "Lia" forem decididos ao mesmo tempo
    Then deve existir uma única identidade "CPF_MATCH" e um único evento "GovbrIdentityLinked"
    And as duas entradas devem ser concluídas

  Scenario: [Concorrência] Dois logins simultâneos não regridem o último acesso
    When "Marta" entrar com gov.br em dois dispositivos ao mesmo tempo
    Then "lastLoginAt" deve ficar com o instante mais recente e "lastTrustLevel" com o nível do mais recente

  Scenario: [Concorrência] Conflito de contas na identidade
    Given que o CPF de "Lia" é de outro cadastro que já tem outra conta gov.br ativa
    When "Lia" entrar com gov.br
    Then a entrada deve ser recusada com "GOVBR_ACCOUNT_CONFLICT" sem revelar quem é o outro usuário
    And nenhuma identidade deve ser criada

  Scenario: [Falha de banco] Banco indisponível na decisão
    Given que o PostgreSQL está indisponível
    When "Marta" concluir a autenticação no gov.br
    Then nenhuma sessão deve ser criada
    And "Marta" deve ver "Não foi possível concluir a entrada com gov.br. Tente novamente." com o botão "Tentar novamente"

  Scenario: [Falha de banco] Banco indisponível ao iniciar a sessão
    Given que o PostgreSQL fica indisponível depois do código emitido
    When o callback chamar o início de sessão
    Then nenhuma sessão deve ser criada e "Marta" deve ver a página de indisponibilidade com o correlationId

  Scenario: [Falha de integração] gov.br indisponível
    Given que o endpoint de token do gov.br não responde
    When "Marta" escolher "Entrar com gov.br"
    Then "Marta" deve ver "O gov.br não respondeu agora. Tente novamente em instantes ou entre com usuário e senha."
    And o login por usuário e senha deve continuar funcionando

  Scenario: [Falha de integração] Authentik indisponível
    Given que o Authentik não responde
    When "Marta" clicar em "Entrar com gov.br"
    Then o BFF deve levá-la a "/entrar" com "O serviço de autenticação está indisponível. Tente novamente em instantes."

  Scenario: [Falha de integração] Cancelou no gov.br
    When "Marta" cancelar a autenticação no gov.br
    Then "Marta" deve ver "Entrada com gov.br cancelada" sem erro técnico

  Scenario: [Falha de integração] Resolvedor fora do ar
    Given que a API não responde ao Authentik
    When "Marta" concluir a autenticação no gov.br
    Then o fluxo deve falhar fechado, sem sessão, em "/entrar?motivo=govbr-erro"
    And o Authentik não deve autenticar "Marta" sem a decisão da API

  Scenario: [Falha de integração] Redis de sessões indisponível
    Given que o Redis de sessões está indisponível
    When o callback tentar criar a sessão
    Then o BFF deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e "Retry-After"
    And nenhum cookie de sessão deve ser emitido
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| `govbr-nao-vinculado` | 302 → SCR-001 | `GOVBR_NOT_LINKED` | "Esta conta gov.br ainda não está ligada a um acesso ao ContrataFlow. Se você já tem acesso, entre com usuário e senha e vincule o gov.br em Meu perfil. Se ainda não tem, peça o convite ao administrador do seu órgão." | Formulário de senha em foco; sem sessão |
| `govbr-sem-acesso` | 302 → SCR-001 | `MEMBERSHIP_REQUIRED` | "Sua conta gov.br está ligada ao ContrataFlow, mas você não tem acesso ativo a nenhum órgão. Peça o convite ao administrador do seu órgão. Se já recebeu um convite, aceite-o pelo link do e-mail, entrando com usuário e senha." | Idem |
| `govbr-nao-habilitado` | 302 → SCR-001 / 403 na troca | `GOVBR_NOT_ENABLED` | "O seu órgão não habilitou a entrada com gov.br. Entre com usuário e senha ou procure o administrador do órgão." | Idem; na troca, a sessão fica onde estava |
| `govbr-conflito` | 302 → SCR-001 | `GOVBR_ACCOUNT_CONFLICT` | "Não foi possível entrar com esta conta gov.br. Procure o administrador do seu órgão." | Idem |
| `govbr-bloqueado` | 302 → SCR-111 (403) | `PERMISSION_DENIED` (`USER_BLOCKED`) | "Seu acesso ao ContrataFlow está bloqueado. Procure o suporte da sua instituição." | "Sair" |
| `govbr-cancelado` | 302 → SCR-001 | — | "Entrada com gov.br cancelada. Você pode tentar de novo ou entrar com usuário e senha." | Botão disponível |
| `govbr-indisponivel` | 302 → SCR-001 | `DEPENDENCY_UNAVAILABLE` | "O gov.br não respondeu agora. Tente novamente em instantes ou entre com usuário e senha." | Botão "Tentar novamente" |
| `govbr-erro` | 302 → SCR-001 | `UNAUTHENTICATED` / `INTERNAL_ERROR` | "Não foi possível concluir a entrada com gov.br. Tente novamente." | Botão disponível |
| `state`/`intent` inválido | 302 → SCR-001 | `UNAUTHENTICATED` | "Não foi possível concluir a entrada. Tente novamente." | Botão "Entrar" |
| Authentik indisponível | 302 → SCR-001 | `DEPENDENCY_UNAVAILABLE` | "O serviço de autenticação está indisponível. Tente novamente em instantes." | Mantém `returnTo` |
| Banco ou Redis de sessões indisponíveis no callback | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível entrar agora. Tente novamente em instantes." | SCR-111 (manutenção) com correlationId |
| Excesso de tentativas | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns instantes." | Respeita `Retry-After` |

## Dependências
- **Stories:** US-087 (login OIDC, BFF, sessão, `POST /internal/session-events`, SCR-001/101/111), US-103 (registro de configurações: `auth.govbrEnabled` lida por tenant; as chaves nascem na US-184). Indiretas: US-088 (logout e expiração), US-090 (`amr` e política de MFA), US-093 (seleção e troca de instituição), US-097 (autorização), US-183 (vínculo `PROFILE`, desvinculação, notificação), US-184 (chaves), US-073 (auditoria).
- **Decisões/ADRs:** DEC-207, ADR-017, DEC-130, DEC-131, DEC-132, DEC-133, DEC-142, DEC-187, DEC-012, DEC-141, DEC-086, DEC-138, DEC-140; POL-29, POL-14. Dependência externa: credenciamento da plataforma no Login Único (por ambiente).
- **Configurações:** `auth.govbrEnabled` (por tenant, US-184); variável de ambiente `GOVBR_LOGIN_ENABLED` e segredos da fonte (por ambiente, lacuna 9); `GOVBR_RESOLVER_TOKEN`.
- **Lacunas nas fontes canônicas:**
  1. O mecanismo da fonte no Authentik não está em authentication.md nem na ADR-017: esta story propõe que o fluxo da fonte `gov.br` execute uma política de expressão que chama `GOV-02` (a identidade vem do vínculo do ContrataFlow) e mapeie `amr` (`govbr`), `govbr_trust_level` e `auth_time`; a rota de início usa o endereço de início da fonte com o `authorize` em `next`. Confirmar em prova de conceito contra o ambiente de homologação do gov.br e registrar em authentication.md §3 e no *blueprint*. A ADR-017 diz que o Authentik "associa" a identidade; aqui a tabela `UserExternalIdentity` do ContrataFlow é a fonte de verdade.
  2. O CPF atravessa Authentik → API (`GOV-02`, rede privada, só em memória) para o cálculo do HMAC. A alternativa (o Authentik calcular o HMAC) leva a chave de *blind index* para fora da API. Decisão de segurança e do DPO; a ADR-017 só diz "CPF guardado como HMAC".
  3. Nenhuma story popula `users.cpfEncrypted`/`cpfHash` (US-098 o deixa somente leitura; US-091, US-092 e US-099 não o gravam): sem isso, o `CPF_MATCH` nunca acontece. É preciso definir quem cadastra o CPF (convite, importação, administrador) numa story própria; o vínculo `PROFILE` não depende disso.
  4. Códigos novos fora de api.md §2.2: `GOVBR_NOT_LINKED` e `MEMBERSHIP_REQUIRED` (POL-29), `GOVBR_NOT_ENABLED` e `GOVBR_ACCOUNT_CONFLICT`; o contrato `POST /internal/session-events` (authentication.md §3.1) ganha `loginMethod`, `govbrTrustLevel` e o tipo `GOVBR_LOGIN_FAILED`.
  5. events.md §7 lista `auth.govbr_login` sem dizer em que tenant gravar: adotado o tenant ativo no sucesso e a auditoria de plataforma (`tenantId` nulo) na falha. O `subjectRef` (12 caracteres do HMAC) só na falha sem usuário conhecido é proposta para medir "recusas resolvidas em 1 dia útil" (feature FT-084); confirmar com o DPO.
  6. `/entrar` não conhece o órgão: a disponibilidade do botão ("algum órgão habilitou") é proposta desta story. Alternativa mais simples (botão por credenciamento apenas, recusa depois): confirmar com o produto.
  7. A screens.md (SCR-001) diz que o login gov.br está fora do MVP 1; atualizar para o MVP 2 (botão, separador "ou" e os motivos de recusa).
  8. O Login Único mantém a sessão do navegador e o ContrataFlow não faz *logout* federado (DEC-187); adotado o aviso de saída. Avaliar o *end-session* do gov.br com o credenciamento.
  9. Não há registro de "configuração de plataforma por ambiente" para o credenciamento: proposta de `GOVBR_LOGIN_ENABLED` (padrão `false`) e dos segredos no Secrets Manager. O manual de identidade visual do Login Único rege o botão e entra como critério do credenciamento.

## Impacto técnico
- **Segurança:** a decisão de entrada está num só ponto (`GOV-02`) e é **repetida** no início da sessão (defesa em profundidade). O Authentik só autentica como o usuário que a API indicar; sem resposta da API, falha fechada. O CPF existe só em memória e em trânsito privado. `GOV-02` fica restrito à rede do Authentik, com credencial própria e comparação em tempo constante.
- **Compatibilidade:** não altera a validação de JWT, o cookie nem as rotas de `/api/v1`; estende `POST /internal/session-events`, `ME-01` e `ME-04` com campos opcionais; o login por senha (DEC-187) e o *step-up* seguem como estão.
- **Performance:** `GOV-02` é uma consulta indexada (índice único parcial do `subjectHash` e do `cpf_hash`), p95 < 100 ms (suíte de performance, no endurecimento); `GOV-01` fica em cache de 60 s no BFF.
- **Dependência externa:** credenciamento e disponibilidade do gov.br; mudança de contrato do Login Único fica isolada na fonte do Authentik (ADR-017), com teste de fumaça em homologação.
- **Risco de vínculo automático errado:** o `CPF_MATCH` depende da qualidade do CPF cadastrado; mitigado pela notificação ao usuário (US-183), pela auditoria e pelo bloqueio de conflito (RN-PLAT-187).

## Backend
- **Módulo(s):** `identity` (dono de `User` e `UserExternalIdentity`; `GovbrIdentityResolver`, `GovbrTrustLevelMapper`), `tenancy` (leitura de `auth.govbrEnabled` por tenant), `audit`, `platform` (credencial de serviço, rate limit). BFF em `apps/web/src/bff/auth/` (rotas `govbr/start` e `govbr/refused`, extensão do callback); Authentik em *blueprint* próprio (fonte `gov.br`, fluxo e política de resolução).
- **Casos de uso:** `GetAuthOptionsQuery` (`GOV-01`), `ResolveGovbrIdentityCommand` (`GOV-02`), extensão de `StartSessionCommand` e `RecordSessionTenantCommand` (loginMethod, nível, auditoria `auth.govbr_login`), `RecordGovbrLoginFailureCommand` (`GOVBR_LOGIN_FAILED`), extensões de `ListMyMembershipsQuery` e `GetMyProfileQuery` (`GOV-03`).
- **Domínio:** `GovbrEntryDecision` (ordem da RN-PLAT-183 como função pura, com tabela de resultados), `GovbrSubject` (CPF normalizado → HMAC-SHA256 com a chave de *blind index*, DEC-086), `UserExternalIdentity.linkByCpfMatch()` (idempotente), `EligibleMembershipPolicy` (RN-PLAT-185), `GovbrTrustLevel`.
- **Integrações internas:** fachada de `tenancy` para `auth.govbrEnabled` (cache de 60 s por tenant), `AuditService`, outbox (`GovbrIdentityLinked`), `SettingsTenantMfaPolicy` (US-184), função `SECURITY DEFINER` para ler vínculos de vários tenants (a mesma da US-087, `cf_user_memberships`, estendida com o estado de `auth.govbrEnabled`).
- **Transação:** `GOV-02` com `CPF_MATCH`: linha de identidade, auditoria e evento em **uma** transação de plataforma; `lastLoginAt`/`lastTrustLevel` no início da sessão por `UPDATE … WHERE last_login_at < :agora`. Fora da transação: Authentik e Redis de sessões (como na US-087).

## Frontend
- **Tela(s):** SCR-001 (`/entrar`: botão, separador "ou" e mensagens de motivo `govbr-*`), SCR-101 (`/selecionar-orgao`: órgãos sem gov.br desabilitados em sessão gov.br), SCR-111 (bloqueado e manutenção, como na US-087).
- **Componentes:** `GovbrLoginButton` (botão secundário, estado "Redirecionando…", sem imagem de terceiros até o credenciamento definir a marca), `LoginDivider`, `LoginReasonMessage` (novos motivos), `InstitutionList` (item desabilitado com o texto do motivo), aviso de saída `saiu-govbr`.
- **Estados:** botão oculto sem disponibilidade; "Redirecionando…" depois do clique; mensagens em `role="status"` (recusas em `role="alert"`); sem *skeleton*.
- **Acessibilidade e responsividade:** botão alcançável por teclado, alvo ≥ 44 px, foco visível de 3 px, contraste AA; mensagem de recusa ligada ao botão por `aria-describedby`; coluna única abaixo de 1024 px (como SCR-001); o foco vai ao título da mensagem depois de uma recusa; testado com axe.

## Banco de dados
- **Tabelas:** `user_external_identities` (nasce na US-183 como parte de entities.md §4.12; esta story a usa e escreve `lastLoginAt`/`lastTrustLevel` e a linha `CPF_MATCH`), leitura de `users` (`cpf_hash`, `status`), `tenant_memberships`, `tenant_settings`; `audit_logs` (`tenant_id` nulo nas falhas).
- **Migrações:** a tabela e os índices em `user_external_identities` (migração da US-183 ou desta, a que for primeiro) e a extensão de `cf_user_memberships` com o estado de `auth.govbrEnabled`.
- **Índices/constraints relevantes:** `UNIQUE (provider, subject_hash) WHERE unlinked_at IS NULL` e `UNIQUE (user_id, provider) WHERE unlinked_at IS NULL` (decidem a concorrência do `CPF_MATCH`); `users.cpf_hash` único (MVP 1).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| BFF | GET | `/api/auth/govbr/start?returnTo=` | `returnTo?` | 302 → fonte gov.br no Authentik; cookie de transação (`intent = LOGIN`) | 302, 429 |
| BFF | GET | `/api/auth/govbr/refused?reason=` | `reason` | 302 → `/entrar?motivo=govbr-…`; limpa a transação | 302, 429 |
| BFF | GET | `/api/auth/callback?code=&state=` | — (reaproveitado) | 302 → `returnTo`, SCR-101 ou SCR-111; cookie `__Host-cf_session` | 302, 429, 503 |
| `GOV-01` | GET | `/internal/auth-options` | credencial de serviço do BFF, sem JWT nem tenant | `200 { data: { govbr: { available } } }` | 200, 401, 503 |
| `GOV-02` | POST | `/internal/govbr/resolve` | `X-CF-Resolver-Token`; `{ cpf, trustLevel?, intent: "LOGIN" }` | `200 { data: { outcome: "LOGIN_ALLOWED" \| "GOVBR_NOT_LINKED" \| "MEMBERSHIP_REQUIRED" \| "GOVBR_NOT_ENABLED" \| "GOVBR_ACCOUNT_CONFLICT" \| "USER_BLOCKED", authentikUserId?, linkMethod? } }` (a US-183 acrescenta `intent: "LINK"`) | 200, 401, 422, 503 |
| `GOV-03` | GET | `/me`, `/me/memberships` (extensão de `ME-01` e `ME-04`) | — | `ME-01` ganha `login { method, govbrTrustLevel?, govbrAuthenticatedAt? }`; `ME-04` ganha `unusableReason?` por vínculo | 200, 401, 403 |
| proposto | POST | `/internal/session-events` (estendido) | `SESSION_STARTED` com `loginMethod`, `govbrTrustLevel?`; novo `GOVBR_LOGIN_FAILED { reason }` | como na US-087; recusa por `MEMBERSHIP_REQUIRED`/`GOVBR_NOT_ENABLED` em 403 | 200, 401, 403, 503 |

## Logs
- `info` `auth.govbr_start` — `returnToAccepted`, IP mascarado.
- `info` `auth.govbr_resolved` — `outcome`, `linkMethod`, `trustLevel`, `durationMs`, `correlationId` (sem `userId` na recusa por `GOVBR_NOT_LINKED`).
- `info` `auth.govbr_session_created` — `userId`, `tenantId`, `selection`, `trustLevel`, `durationMs`.
- `warn` `auth.govbr_refused` — `reason`; `warn` `auth.govbr_conflict` — `correlationId` (sem identificar o outro usuário); `warn` `auth.govbr_options_failed`.
- `error` `auth.govbr_resolver_failed` — `errorCode`, `durationMs`, `correlationId`.
- Métricas: `auth_govbr_logins_total{result,reason,trustLevel,linkMethod}`, latência do `GOV-02`; alerta quando a taxa de falha do resolvedor passar de limite.
- **Nunca logar:** CPF, `subjectHash`, `subjectRef`, tokens do Authentik, `code`, `state`, `nonce`, `code_verifier`, cookies, e-mail completo (DEC-138); o corpo de `GOV-02` não é registrado e o campo `cpf` entra na lista de redação do pino.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `auth.govbr_login` | `SECURITY` | Sucesso: instituição ativada na sessão gov.br (tenant ativo) | `metadata`: `result = SUCCESS`, `govbrTrustLevel`, `linkMethod`, `selection`; colunas `sessionIdHash`, `ip`, `userAgent`, `actorMembershipId` |
| `auth.govbr_login` | `SECURITY` | Falha: qualquer recusa ou erro do provedor (auditoria de plataforma, `tenantId` nulo) | `result = FAILURE`, `reasonCode`, `govbrTrustLevel?`, `actorUserId?`, `subjectRef?` só sem usuário conhecido |
| `auth.session_start` | `SECURITY` | Instituição ativada (MVP 1) | `metadata` ganha `loginMethod` |
| `identity.govbr_link` | `SECURITY` | `CPF_MATCH` (e, na US-183, `PROFILE`) | `metadata`: `linkMethod`, `trustLevel`; sem CPF nem hash |

## Testes necessários
- **Unitários:** `GovbrEntryDecision` (cada passo da ordem, empates e combinações: vinculado, `CPF_MATCH`, não vinculado, sem membership, órgão não habilitado, bloqueado, conflito); `GovbrSubject` (normalização, dígito verificador, HMAC estável); `GovbrTrustLevelMapper` (ausente e fora do enum → nulo); allowlist de `reason`; `EligibleMembershipPolicy`; validação de `intent`.
- **Integração (Testcontainers PostgreSQL + Redis + Authentik de teste com fonte OIDC simulada do gov.br):** jornada completa com IdP federado simulado; `CPF_MATCH` concorrente (índices únicos); `GOV-02` com credencial errada; sessão sem cookie nas recusas; auditoria de falha com `tenantId` nulo; `lastLoginAt` monotônico.
- **API/contrato:** `GOV-01`, `GOV-02`, extensões de `ME-01`, `ME-04` e `session-events`; códigos de erro; resposta de `GOV-01` sem dados de tenant.
- **RBAC e multi-tenant:** habilitação por tenant na entrada e na troca; `ME-04` só do próprio usuário; **teste de segurança de dados**: nenhum CPF, `subjectHash` ou token do gov.br em log, auditoria, evento, resposta ou sessão (varredura automatizada); nenhum `User`/`TenantMembership` criado em qualquer cenário de recusa; suíte `test/tenant-leak` (disponibilidade e `GOVBR_NOT_ENABLED` entre tenants).
- **Concorrência:** primeiros logins simultâneos; logins simultâneos em dois dispositivos; recusa e habilitação alterada durante o fluxo.
- **E2E (Playwright, com IdP federado simulado):** entrar com vínculo; `CPF_MATCH`; recusa sem vínculo e sem acesso; órgão sem gov.br; cancelamento; gov.br indisponível com login por senha funcionando; 360 px e 1024 px.
- **Acessibilidade/performance:** axe em `/entrar` com o botão e com cada motivo; `GOV-02` p95 < 100 ms e callback p95 < 800 ms sem Authentik (suíte de performance, no endurecimento).

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada
- [ ] Teste de que nenhuma recusa cria `User`, `TenantMembership`, convite ou sessão
- [ ] Varredura de CPF, `subjectHash` e tokens do gov.br em logs, auditoria, eventos e respostas verde
- [ ] Jornada E2E com IdP federado simulado verde; teste de fumaça em homologação do gov.br registrado quando houver credenciamento

## Estimativa
**L** — envolve a fonte federada e o fluxo no Authentik (*blueprint* e política de resolução), duas rotas novas no BFF e a extensão do callback, o resolvedor com a ordem de decisão e o vínculo por CPF concorrente-seguro, a extensão do contrato de sessão, `ME-01`/`ME-04`, auditoria de sucesso e de falha, oito motivos de recusa em SCR-001 e testes com IdP federado simulado.

## Prioridade
**P1** — critério de saída do MVP 2 (roadmap §4.8) e valor direto para o servidor, mas depende de credenciamento externo e não bloqueia as demais frentes; o login por usuário e senha continua sendo o caminho principal.
