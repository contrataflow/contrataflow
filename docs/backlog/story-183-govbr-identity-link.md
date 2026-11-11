---
id: US-183
title: "Vincular e desvincular a identidade gov.br"
epic: EP-029
feature: FT-084
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-098, US-182]
modules: [identity, notification, audit, platform]
screens: [SCR-039]
endpoints: [GOV-04, GOV-05, GOV-06, GOV-07, GOV-08]
permissions: [PLATFORM_TENANT_MANAGE]
events: [GovbrIdentityLinked, GovbrIdentityUnlinked]
---

# US-183 — Vincular e desvincular a identidade gov.br

## Título
Vincular e desvincular a identidade gov.br

## Descrição
**Como** servidor com acesso ao ContrataFlow, **quero** vincular a minha conta gov.br ao meu usuário em "Meu perfil" e desvinculá-la quando quiser, **para** entrar com o gov.br (US-182) sem que ninguém, nem o gov.br, consiga ligar a minha identidade a um usuário que não é o meu, e saber na hora, por aviso, sempre que esse vínculo mudar.

Em "Meu perfil" (SCR-039, seção "Segurança") o usuário autenticado vê o cartão "Conta gov.br": sem vínculo, o botão "Vincular conta gov.br" abre o gov.br pelo Authentik e, na volta, o vínculo é concluído **na mesma sessão e no mesmo navegador**, por um ticket de uso único; com vínculo, o cartão mostra o CPF **mascarado**, como e quando foi vinculado, o último acesso e o último nível de confiança, e oferece "Desvincular", que exige segundo fator na sessão ou login gov.br recente (≤ 10 min). Vincular e desvincular geram evento, auditoria e o aviso `GOVBR_LINK_CHANGED` ao próprio usuário. O operador da plataforma também pode desvincular, com chamado e justificativa.

## Contexto
- DEC-207 e [ADR-017](../adr/adr-017-govbr-login.md): a identidade gov.br só se liga a um `User` por ação da própria pessoa autenticada (`PROFILE`) ou por CPF cujo HMAC é igual a `users.cpf_hash` (`CPF_MATCH`, feito no primeiro login, US-182). Vincular a pessoa errada é o risco central; por isso o vínculo é amarrado à sessão, ao navegador e ao ticket, e cada mudança avisa o usuário.
- A tabela `UserExternalIdentity` (entities.md §4.12) é do módulo `identity`, de plataforma (sem `tenant_id`/RLS, como `users`): o vínculo vale para **todos** os órgãos do usuário (DEC-012). A habilitação (`auth.govbrEnabled`) é do **órgão ativo da sessão** e só condiciona **vincular**; desvincular nunca depende dela (RN-PLAT-11).
- Esta story **não redefine** as RN-PLAT-08 a RN-PLAT-14 da feature FT-084: detalha-as nas RN-PLAT-200 a RN-PLAT-216. O fluxo de entrada, a ordem de decisão do resolvedor (`GOV-02`) e o `CPF_MATCH` são da US-182; esta story acrescenta a intenção `LINK` ao mesmo resolvedor.
- O CPF nunca é guardado em claro (DEC-086, DEC-140): o vínculo guarda o HMAC (`subjectHash`) e, para exibição, a **máscara** `***.456.789-**` (lacuna 1). `subjectHash` e CPF não saem da API em nenhuma resposta, log, evento ou e-mail (DEC-138).
- O MVP 1 entrega "Meu perfil" (US-098) com atalhos ao Authentik e o painel somente leitura de MFA (US-090); o cartão do gov.br entra na mesma seção "Segurança" e reaproveita o interceptador global de `MFA_REQUIRED` (POL-14) para o *step-up*.
- Notificações: o envio transacional de e-mail só conhece origens duráveis (`Notification` e convite) — a mesma limitação registrada na DEC-142 para o `USR-13`. `GOVBR_LINK_CHANGED` resolve isso criando `Notification` (lacuna 2).
- Pessoas de teste: "Marta" (usuária que vincula), "Lia" (CPF igual ao cadastrado), "Rui" (operador da plataforma), "Paulo" (outro usuário). CPFs só mascarados; nomes e dados fictícios.

## Objetivo
Permitir vincular a conta gov.br em até 3 interações depois do botão e desvincular em até 2 (mais o *step-up*, quando for o caso), com 0 vínculo feito sem a pessoa autenticada ou em sessão alheia, 0 CPF ou `subjectHash` exposto, 100% das mudanças com auditoria, evento e aviso ao usuário, e conflito de contas e CPF divergente recusados com orientação que não revela outro usuário.

## Persona
- **Principal:** Servidor com acesso ativo a um órgão que habilitou o gov.br (qualquer perfil de tenant; Marta).
- **Secundárias:** Servidor cujo vínculo foi feito por CPF no primeiro login e que quer desfazê-lo (Lia); operador da plataforma que desvincula a pedido, com chamado (Rui, `User.isPlatformOperator`, `PLATFORM_TENANT_MANAGE`, MFA); administrador do órgão (`ADMIN_ORGAO`), que orienta quem tem conflito ou CPF divergente.

## Pré-condições
- Usuário autenticado (sessão do BFF, US-087), tenant ativo `ACTIVE` e vínculo `ACTIVE`.
- Para **vincular:** fonte do gov.br disponível no ambiente (`GOV-01`), `auth.govbrEnabled = true` no tenant ativo (US-184), o usuário sem vínculo gov.br ativo e Redis de sessões e Authentik no ar.
- Para **desvincular:** existir vínculo ativo e a sessão ter segundo fator real comprovado (`amr`) ou ter sido aberta por login gov.br há no máximo 10 minutos (`amr` contém `govbr`, `auth_time` recente).
- Para o aviso por e-mail: fila `email` e `notification` disponíveis; sem elas o vínculo vale e o aviso fica pendente (FA-09).

## Fluxo principal
1. Em **Meu perfil › Segurança** (SCR-039, `/perfil?aba=seguranca`) a tela chama `GOV-04` e mostra o cartão "Conta gov.br" (estados em "Frontend").
2. **Vincular.** Marta clica em "Vincular conta gov.br". O front envia `POST /api/auth/govbr/link/start` (rota do BFF, com `X-CF-Request: 1`); o BFF chama `GOV-05`, que confere `auth.govbrEnabled` do órgão ativo, a ausência de vínculo ativo e o limite, e cria o **ticket** (uso único, 10 min, preso ao usuário e ao `sessionIdHash`).
3. O BFF grava a transação `{ state, nonce, codeVerifier, returnTo = "/perfil?aba=seguranca", intent: "LINK", ticketRef, createdAt }` no cookie `__Host-cf_auth_tx` e responde `{ redirectTo }`; o front navega ao início da fonte gov.br no Authentik (a mesma rota da US-182, com o ticket como parâmetro de início).
4. A pessoa se autentica no gov.br e volta ao Authentik, cujo fluxo chama `GOV-02` com `intent = LINK`, o CPF, o nível e o ticket. A API valida o ticket, calcula o HMAC e confere conflito, CPF cadastrado e vínculo existente (RN-PLAT-203 a RN-PLAT-205); sem impedimento, guarda `subjectHash`, máscara e nível **no ticket** e responde `LINK_PENDING` com o `authentikUserId` do dono do ticket. Com impedimento, o fluxo termina em `/api/auth/govbr/refused`.
5. O Authentik emite o código e redireciona a `GET /api/auth/callback`. O BFF valida a transação (`state`, `nonce`, `intent = LINK`, **mesmo navegador**), troca o código, valida o `id_token` e confere que o `sub` é o do usuário da sessão; **descarta** os tokens dessa troca (revoga o refresh) e mantém os da sessão.
6. O BFF chama `GOV-06` com o ticket e o token **da sessão**. A API confere ticket, `sessionIdHash`, habilitação do órgão ativo e, **na mesma transação**, grava `UserExternalIdentity` (`linkMethod = PROFILE`), a auditoria `identity.govbr_link` e o evento `GovbrIdentityLinked` na caixa de saída; os índices únicos têm a palavra final sob concorrência.
7. O BFF responde **302** a `/perfil?aba=seguranca&govbr=vinculado`; a tela mostra "Conta gov.br vinculada." (toast com `aria-live`) e o cartão com o CPF mascarado. O worker cria o aviso `GOVBR_LINK_CHANGED`.
8. **Desvincular.** Marta clica em "Desvincular". A tela abre a confirmação "Desvincular a conta gov.br? Você deixará de entrar com ela em todos os órgãos. Seu acesso por usuário e senha continua. Você pode vincular de novo quando quiser."
9. Ao confirmar, o front envia `DELETE /me/external-identities/govbr` (`GOV-07`). A API confere o segundo fator real ou o login gov.br recente (RN-PLAT-207), marca `unlinkedAt`/`unlinkedById`, grava `identity.govbr_unlink`, publica `GovbrIdentityUnlinked` e responde **204**. O cartão volta ao estado "não vinculada" e o worker cria o aviso.

## Fluxos alternativos
- **FA-01 — Desvincular sem segundo fator na sessão:** `GOV-07` responde 403 `MFA_REQUIRED`; o interceptador abre `/api/auth/step-up?returnTo=/perfil?aba=seguranca&acao=desvincular`; ao voltar, a confirmação reabre e o pedido é repetido. `GOV-04` devolve `strongAuthSatisfied` para a tela pedir o *step-up* antes de enviar.
- **FA-02 — Desvincular logo depois de entrar com gov.br:** sessão aberta por gov.br há ≤ 10 min vale como confirmação, sem *step-up*.
- **FA-03 — Conflito de contas:** a conta gov.br já está vinculada a **outro** usuário. Recusa com "Esta conta gov.br não pode ser vinculada ao seu usuário. Procure o administrador do seu órgão." sem dizer quem; nada é gravado além da auditoria da falha.
- **FA-04 — CPF divergente:** o usuário tem CPF cadastrado e ele não confere com o do gov.br: recusa com orientação (RN-PLAT-203).
- **FA-05 — Já vinculado:** com vínculo ativo, o botão não aparece; uma chamada direta recebe 409 `GOVBR_ALREADY_LINKED`. Trocar de conta gov.br é desvincular e vincular de novo.
- **FA-06 — Órgão ativo sem gov.br:** o cartão mostra "O seu órgão ainda não habilitou o gov.br." sem botão de vincular; quem já tem vínculo continua vendo-o e podendo desvinculá-lo (RN-PLAT-211).
- **FA-07 — Cancelou no gov.br ou o fluxo falhou:** volta a `/perfil?aba=seguranca&govbr=cancelado|indisponivel|erro`, sem vínculo; o ticket expira em 10 min.
- **FA-08 — Ticket expirado, usado ou de outra sessão:** `GOV-06` responde 422 `GOVBR_LINK_TICKET_INVALID` ("O pedido de vínculo expirou. Tente novamente."); nada é vinculado.
- **FA-09 — Fila de e-mail ou notificação fora do ar:** o vínculo vale; o evento fica `PENDING` na caixa de saída e o aviso sai quando o consumidor voltar.
- **FA-10 — Operador desvincula (suporte):** pelo backoffice ou pela CLI de plataforma, com `reason` e `ticketReference` (`GOV-08`); o usuário recebe o mesmo aviso, com "foi desvinculada pela equipe da plataforma".
- **FA-11 — Vínculo feito por CPF no primeiro login:** aparece no cartão como "Pelo CPF cadastrado"; pode ser desvinculado como qualquer outro.
- **FA-12 — Sessão aberta por gov.br depois de desvincular:** continua válida até o fim normal; a próxima entrada por gov.br é recusada (`GOVBR_NOT_LINKED`).

## Regras de negócio
- **RN-PLAT-200** — Quem vincula (detalha RN-PLAT-10 e RN-PLAT-11): só o usuário autenticado, no **próprio** perfil, com `auth.govbrEnabled = true` no órgão ativo e fonte disponível; nunca em nome de outra pessoa, nem por administrador do órgão. Um vínculo ativo por usuário (`provider = GOVBR`) e uma conta gov.br ativa por usuário (índices únicos parciais da entidade).
- **RN-PLAT-201** — Intenção de vínculo (`GOV-05`): ticket opaco de 256 bits por CSPRNG, guardado só como SHA-256 no Redis de sessões (`cf:{env}:govbr:link:{hash}`), TTL de 10 min, **uso único**, preso a `userId`, `sessionIdHash` e ao órgão ativo; no máximo um ticket ativo por usuário (o novo invalida o anterior); limite de 5 pedidos por hora por usuário → 429 `RATE_LIMITED`. O ticket nunca vai ao navegador em claro além do parâmetro de início da fonte, que é inútil fora da sessão que o criou.
- **RN-PLAT-202** — Conclusão amarrada (`GOV-06`): o vínculo `PROFILE` só se conclui no **callback do BFF**, com a transação `intent = LINK` do **mesmo navegador**, `sub` do `id_token` igual ao do usuário da sessão, ticket válido e `sessionIdHash` igual ao da requisição. Isso impede que um ticket vazado, ou um link enviado a outra pessoa, ligue a conta gov.br de um terceiro ao usuário. Divergência → 422 `GOVBR_LINK_TICKET_INVALID`, sem efeito. Os tokens da troca de código do fluxo `LINK` são descartados; a sessão mantém os seus (e o seu `amr`).
- **RN-PLAT-203** — CPF cadastrado e conta gov.br (proteção contra "pessoa errada"): se `users.cpf_hash` não é nulo e difere do HMAC do CPF do gov.br, a intenção é recusada com 422 `GOVBR_CPF_MISMATCH` (decisão desta story, mais rígida que a ADR-017: ver dúvida de produto 1). Sem CPF cadastrado, o vínculo `PROFILE` vale e o CPF do gov.br **não** é gravado em `users` (cadastro de CPF está fora do escopo).
- **RN-PLAT-204** — Conflito de contas: se o `subjectHash` já está ativo em **outro** usuário, 409 `GOVBR_ACCOUNT_CONFLICT`. A mensagem e a resposta **não revelam** quem é o outro usuário nem que ele existe; a auditoria da falha e o `warn` servem à investigação do administrador e da plataforma. O mesmo vale no `GOV-02` com `intent = LINK`.
- **RN-PLAT-205** — Já vinculado e corrida: com vínculo ativo do usuário, 409 `GOVBR_ALREADY_LINKED`; na gravação final, violação dos índices únicos é reconhecida e convertida em `GOVBR_ALREADY_LINKED` (mesmo usuário) ou `GOVBR_ACCOUNT_CONFLICT` (outro usuário), nunca em 500.
- **RN-PLAT-206** — Máscara e exposição: a API devolve `maskedSubject` no formato `***.NNN.NNN-**` (seis dígitos centrais), gravado como `subjectMasked` na conclusão; **nunca** devolve CPF completo nem `subjectHash`, e a tela não tem campo para digitar CPF. A máscara não entra em evento, log nem e-mail.
- **RN-PLAT-207** — Desvincular (detalha RN-PLAT-11, POL-29): exige que a sessão comprove **segundo fator real** (`amr` com TOTP, WebAuthn ou equivalente, **não** o gov.br contado como MFA pela US-184) **ou** tenha sido aberta por gov.br há no máximo 10 minutos (`amr` contém `govbr` e `auth_time` ≤ 10 min). Senão, 403 `MFA_REQUIRED` e *step-up* (DEC-142). Vale para a desvinculação pelo próprio usuário; não depende de `auth.govbrEnabled`.
- **RN-PLAT-208** — Efeito da desvinculação: marca `unlinkedAt` e `unlinkedById` (o usuário ou o operador) e **mantém a linha** (histórico e auditoria; os índices parciais liberam um novo vínculo). Depois dela, o `CPF_MATCH` **não** revincula automaticamente o mesmo par usuário-conta (RN-PLAT-186): quem desvinculou precisa vincular de novo, por escolha, em "Meu perfil". Sessões abertas não são encerradas.
- **RN-PLAT-209** — Idempotência de `GOV-07`: sem vínculo ativo (inexistente ou já desvinculado) → 404 `NOT_FOUND` ("A conta gov.br já foi desvinculada."); a atualização é atômica (`WHERE unlinked_at IS NULL`), então dois pedidos simultâneos geram **um** evento e **uma** auditoria.
- **RN-PLAT-210** — Evento, auditoria e aviso (RN-PLAT-14): na mesma transação da mudança, auditoria `identity.govbr_link` ou `identity.govbr_unlink` (categoria `SECURITY`) e evento `GovbrIdentityLinked { userId, linkMethod, trustLevel }` ou `GovbrIdentityUnlinked { userId, byOperator }`, sem CPF, máscara nem hash. Tenant da auditoria: o **órgão ativo** na ação do próprio usuário (`PROFILE`, desvinculação); auditoria de plataforma (`tenantId` nulo, `actorType = PLATFORM_OPERATOR` no caso do operador) no `CPF_MATCH` e na desvinculação por operador. A falha de conflito ou divergência também audita (`result = FAILURE`, `reasonCode`).
- **RN-PLAT-211** — Visibilidade do cartão: aparece quando a fonte está disponível **ou** o usuário já tem vínculo; o botão "Vincular" exige disponibilidade, `auth.govbrEnabled` no órgão ativo e ausência de vínculo; "Desvincular" aparece sempre que há vínculo. Com a fonte indisponível e sem vínculo, o cartão não existe (RN-PLAT-13).
- **RN-PLAT-212** — Notificação `GOVBR_LINK_CHANGED` (events.md §6): obrigatória, e-mail padrão ligado, enviada **ao próprio usuário mesmo sendo ele o ator** (exceção à regra do ator). Como o vínculo é global e `Notification` tem tenant, o consumidor cria uma notificação por vínculo `ACTIVE` do usuário (até 10, os de acesso mais recente) com o mesmo `groupKey = govbr:{identityId}:{evento}`, e o e-mail sai **uma vez** por evento. Texto fixo, sem CPF, máscara nem nível: "A conta gov.br foi vinculada ao seu acesso em {data e hora}." / "…desvinculada do seu acesso em {data e hora}." / "…desvinculada pela equipe da plataforma em {data e hora}." e "Se não foi você, entre com usuário e senha, desvincule e procure o administrador do seu órgão." Também gerada para o `CPF_MATCH` da US-182.
- **RN-PLAT-213** — Desvinculação pelo operador (`GOV-08`, detalha RN-PLAT-01 e RN-PLAT-02): rota de plataforma (`/platform/*`, sem `X-Tenant-Id`), `User.isPlatformOperator` + `PLATFORM_TENANT_MANAGE` + MFA sempre (POL-29, DEC-078); corpo `{ email, reason, ticketReference }` com `reason` de 20 a 500 caracteres e chamado obrigatório; usuário ou vínculo inexistente → 404 `NOT_FOUND` uniforme; a resposta e a auditoria **não** trazem CPF, máscara nem dado de órgão. Sem tela no backoffice do MVP 2 (a DEC-208 não prevê gestão de usuários): a rota é usada pela CLI de plataforma (dúvida de produto 2).
- **RN-PLAT-214** — Leitura (`GOV-04`): só do próprio usuário (identidade da sessão, nunca `userId` na rota); devolve `available`, `enabledInActiveTenant`, `linked`, `identity { maskedSubject, linkMethod, linkedAt, lastLoginAt, lastTrustLevel }`, `canLink`, `canUnlink` e `strongAuthSatisfied` (RN-PLAT-207); nada de `subjectHash`, `unlinkedById` ou dados de outro usuário.
- **RN-PLAT-215** — Rota de retorno e recusa: `GET /api/auth/govbr/refused` com transação `intent = LINK` volta a `/perfil?aba=seguranca&govbr=<motivo>` (`conflito`, `cpf-divergente`, `ja-vinculado`, `expirado`, `cancelado`, `indisponivel`, `erro`) em vez de `/entrar`; sem sessão ativa, cai em `/entrar`. Motivos de tabela fixa, nunca eco do parâmetro (RN-PLAT-193).
- **RN-PLAT-216** — Vale para todos os órgãos: a tela diz "O vínculo vale para todos os órgãos em que você tem acesso. Cada órgão decide se aceita a entrada com gov.br." (DEC-012); desvincular remove a entrada por gov.br em todos eles.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| CPF da conta gov.br | `identity.maskedSubject` | texto (`***.456.789-**`) | — | RN-PLAT-206; somente leitura | `subjectMasked` |
| Como foi vinculada | `identity.linkMethod` | `PROFILE`, `CPF_MATCH` | — | "Pelo perfil" / "Pelo CPF cadastrado" | `UserExternalIdentity` |
| Vinculada em | `identity.linkedAt` | data/hora | — | fuso do órgão ativo | `UserExternalIdentity` |
| Último acesso com gov.br | `identity.lastLoginAt` | data/hora | — | nulo = "Nunca entrou com gov.br" | `UserExternalIdentity` |
| Último nível informado | `identity.lastTrustLevel` | `BRONZE`, `SILVER`, `GOLD` | — | texto "Bronze", "Prata", "Ouro" (sem depender de cor) | `UserExternalIdentity` |
| *(técnico)* Ticket | `ticket` | texto opaco | Sim (`GOV-06`) | RN-PLAT-201, RN-PLAT-202; nunca exibido | `GOV-05` |
| Motivo da desvinculação (operador) | `reason` | texto | Sim (`GOV-08`) | 20–500 caracteres | — |
| Chamado (operador) | `ticketReference` | texto curto | Sim (`GOV-08`) | até 80 caracteres | — |
| E-mail do usuário (operador) | `email` | e-mail | Sim (`GOV-08`) | usado só para localizar; não é devolvido | — |
| *(técnico)* Resultado do vínculo | `govbr` (query de `/perfil`) | `vinculado`, `conflito`, `cpf-divergente`, `ja-vinculado`, `expirado`, `cancelado`, `indisponivel`, `erro` | Não | RN-PLAT-215 | BFF |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Órgão ativo sem `auth.govbrEnabled` (ou fonte indisponível) ao vincular | API | "O seu órgão ainda não habilitou o gov.br." | `GOVBR_NOT_ENABLED` (403) |
| V-02 | Usuário já tem vínculo ativo | API | "Seu usuário já tem uma conta gov.br vinculada." | `GOVBR_ALREADY_LINKED` (409) |
| V-03 | Conta gov.br já vinculada a outro usuário | API | "Esta conta gov.br não pode ser vinculada ao seu usuário. Procure o administrador do seu órgão." | `GOVBR_ACCOUNT_CONFLICT` (409) |
| V-04 | CPF cadastrado diferente do CPF da conta gov.br | API | "O CPF da conta gov.br não confere com o CPF cadastrado para o seu usuário. Procure o administrador do seu órgão." | `GOVBR_CPF_MISMATCH` (422) |
| V-05 | Ticket ausente, expirado, usado, de outra sessão ou de outro usuário; `sub` divergente | API + BFF | "O pedido de vínculo expirou. Tente novamente." | `GOVBR_LINK_TICKET_INVALID` (422) |
| V-06 | Desvincular sem segundo fator real e sem login gov.br recente | API | "Confirme sua identidade para continuar." | `MFA_REQUIRED` (403) |
| V-07 | Desvincular sem vínculo ativo | API | "A conta gov.br já foi desvinculada." | `NOT_FOUND` (404) |
| V-08 | Excesso de pedidos de vínculo | API | "Muitas tentativas. Aguarde alguns instantes." | `RATE_LIMITED` (429) |
| V-09 | `reason` curto demais ou `ticketReference` ausente (operador) | Front + API | "Informe o motivo (mín. 20 caracteres) e o número do chamado." | `VALIDATION_ERROR` (`TOO_SHORT`/`REQUIRED`) |
| V-10 | Operador sem `PLATFORM_TENANT_MANAGE` ou sem MFA | API | "Você não tem permissão para esta operação." | `PERMISSION_DENIED` / `MFA_REQUIRED` |

## Permissões
- **Permissão:** vincular, listar e desvincular o **próprio** vínculo são capacidades implícitas de usuário autenticado (POL-29, permissions.md §7); `GOV-08` exige `PLATFORM_TENANT_MANAGE` (backoffice).
- **Políticas:** POL-29 (vincular exige `auth.govbrEnabled` no tenant ativo; desvincular exige sessão com MFA ou login gov.br ≤ 10 min); POL-14 (*step-up*); autoproteção natural: não existe rota para vincular ou desvincular **outro** usuário no tenant.
- **MFA:** `GOV-07` conforme RN-PLAT-207; `GOV-05` e `GOV-06` não exigem MFA (decisão da POL-29; risco de sessão sequestrada vincular uma conta gov.br alheia e mitigação pelo aviso ao usuário em "Impacto técnico" e na dúvida de produto 3); `GOV-08` sempre com MFA (DEC-078).
- **Sem permissão:** administrador do órgão não vincula nem desvincula por usuário; operador sem permissão ou sem MFA recebe 403 e `access.denied` (`reasonCode = PLATFORM_TENANT_MANAGE`).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `GovbrIdentityLinked` | `identity.govbr_linked` | Vínculo `PROFILE` concluído (`GOV-06`); `CPF_MATCH` na US-182 | Payload `userId`, `linkMethod`, `trustLevel`; envelope de plataforma (`tenantId` nulo); sem CPF, máscara nem hash |
| `GovbrIdentityUnlinked` | `identity.govbr_unlinked` | Desvinculação pelo usuário (`GOV-07`) ou pelo operador (`GOV-08`) | Payload `userId`, `byOperator` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `GOVBR_LINK_CHANGED` | O próprio usuário, em cada vínculo `ACTIVE` (até 10) | In-app e e-mail padrão (obrigatória; e-mail único por evento) | Depois de `GovbrIdentityLinked` (qualquer método) e de `GovbrIdentityUnlinked` (inclusive por operador) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Vincular e desvincular a identidade gov.br

  Background:
    Given que o tenant "Prefeitura A" está ativo com "auth.govbrEnabled" ligado
    And "Marta" está autenticada na "Prefeitura A" com vínculo "ACTIVE" e sem conta gov.br vinculada
    And o CPF cadastrado de "Marta" é igual ao da conta gov.br dela

  Scenario: [Sucesso] Vincular a conta gov.br em Meu perfil
    When "Marta" clicar em "Vincular conta gov.br" e concluir a autenticação no gov.br
    Then deve existir uma identidade gov.br de "Marta" com o método "PROFILE"
    And "Marta" deve ver "Conta gov.br vinculada." e o CPF como "***.456.789-**"
    And deve gerar registro de auditoria "identity.govbr_link"
    And deve gerar o evento "GovbrIdentityLinked" com "linkMethod" igual a "PROFILE"
    And "Marta" deve receber a notificação "GOVBR_LINK_CHANGED" e o e-mail correspondente

  Scenario: [Sucesso] Entrar com gov.br depois de vincular
    Given que "Marta" vinculou a conta gov.br
    When "Marta" sair e escolher "Entrar com gov.br" em "/entrar"
    Then "Marta" deve entrar na "Prefeitura A" com a sessão normal

  Scenario: [Sucesso] Ver o vínculo com o CPF mascarado
    Given que "Marta" tem a conta gov.br vinculada
    When "Marta" abrir "Meu perfil" na seção "Segurança"
    Then deve ver o CPF mascarado, "Pelo perfil", a data do vínculo, o último acesso e o nível "Prata"
    And a resposta não deve conter o CPF completo nem o "subjectHash"

  Scenario: [Sucesso] Desvincular com segundo fator na sessão
    Given que "Marta" tem a conta gov.br vinculada e uma sessão com segundo fator
    When "Marta" confirmar "Desvincular"
    Then a API deve responder 204
    And a identidade deve ficar com "unlinkedAt" e "unlinkedById" preenchidos
    And deve gerar o evento "GovbrIdentityUnlinked" com "byOperator" falso
    And deve gerar registro de auditoria "identity.govbr_unlink"
    And "Marta" deve receber a notificação "GOVBR_LINK_CHANGED"

  Scenario: [Sucesso] Desvincular logo depois de entrar com gov.br
    Given que "Marta" abriu a sessão com gov.br há 4 minutos, sem segundo fator
    When "Marta" confirmar "Desvincular"
    Then a API deve responder 204 sem pedir o segundo fator

  Scenario: [Sucesso] Desvincular pelo operador
    Given que "Rui" é operador da plataforma com "PLATFORM_TENANT_MANAGE" e MFA
    When "Rui" desvincular a conta gov.br de "Marta" informando o chamado "SUP-123" e o motivo com 30 caracteres
    Then a identidade de "Marta" deve ficar desvinculada
    And o evento "GovbrIdentityUnlinked" deve ter "byOperator" verdadeiro
    And a auditoria "identity.govbr_unlink" deve ter "actorType" "PLATFORM_OPERATOR" e "tenantId" nulo
    And "Marta" deve ser avisada de que a equipe da plataforma desvinculou a conta

  Scenario: [Sucesso] Desvinculada, o CPF não revincula sozinho
    Given que "Marta" desvinculou a conta gov.br e o CPF dela é igual ao cadastrado
    When "Marta" entrar com gov.br
    Then a entrada deve ser recusada com "GOVBR_NOT_LINKED"
    And nenhuma identidade deve ser criada

  Scenario: [Validação] Ticket expirado
    Given que o ticket de vínculo de "Marta" foi criado há 11 minutos
    When o BFF tentar concluir o vínculo
    Then a API deve responder 422 com código "GOVBR_LINK_TICKET_INVALID"
    And nenhuma identidade deve ser criada

  Scenario: [Validação] CPF diferente do cadastrado
    Given que o CPF cadastrado de "Marta" difere do CPF da conta gov.br escolhida
    When "Marta" tentar vincular
    Then a API deve responder 422 com código "GOVBR_CPF_MISMATCH"
    And "Marta" deve ver a orientação de procurar o administrador do órgão

  Scenario: [Validação] Motivo curto na desvinculação pelo operador
    When "Rui" desvincular uma conta informando o motivo "teste"
    Then a API deve responder 422 com código "VALIDATION_ERROR" apontando "reason"

  Scenario: [Permissão] Desvincular sem segundo fator nem login gov.br recente
    Given que "Marta" tem sessão só com senha, aberta há 2 horas
    When "Marta" enviar "DELETE /me/external-identities/govbr"
    Then a API deve responder 403 com código "MFA_REQUIRED"
    And depois do passo de confirmação de identidade a desvinculação deve poder ser repetida

  Scenario: [Permissão] Órgão sem gov.br habilitado não permite vincular
    Given que o órgão ativo de "Marta" está sem "auth.govbrEnabled"
    When "Marta" tentar vincular a conta gov.br
    Then a API deve responder 403 com código "GOVBR_NOT_ENABLED"
    And o botão "Vincular conta gov.br" não deve aparecer, mas "Desvincular" deve aparecer se houver vínculo

  Scenario: [Permissão] Operador sem permissão
    Given que "Paulo" não tem "PLATFORM_TENANT_MANAGE"
    When "Paulo" enviar o pedido de desvinculação de plataforma
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Cada usuário só vê e muda o próprio vínculo
    Given que "Paulo" também tem conta gov.br vinculada
    When "Marta" abrir "GET /me/external-identities"
    Then a resposta deve conter só a identidade de "Marta"
    And não existe rota para "Marta" desvincular a conta de "Paulo"

  Scenario: [Tenant incorreto] O vínculo vale em todos os órgãos
    Given que "Marta" também tem vínculo "ACTIVE" na "Prefeitura B"
    When "Marta" vincular a conta gov.br com a "Prefeitura A" ativa
    Then a identidade deve valer para a entrada na "Prefeitura B" se ela habilitar o gov.br

  Scenario: [Tenant incorreto] Ticket de outra sessão
    Given que "Paulo" criou um ticket de vínculo na sessão dele
    When "Marta" tentar concluir o vínculo com o ticket de "Paulo"
    Then a API deve responder 422 com código "GOVBR_LINK_TICKET_INVALID"
    And nenhuma identidade deve ser criada para "Marta" nem para "Paulo"

  Scenario: [Duplicidade] Vincular de novo com vínculo ativo
    Given que "Marta" já tem a conta gov.br vinculada
    When "Marta" enviar outro pedido de vínculo
    Then a API deve responder 409 com código "GOVBR_ALREADY_LINKED"

  Scenario: [Duplicidade] Desvincular duas vezes
    Given que "Marta" desvinculou a conta gov.br
    When "Marta" enviar "DELETE /me/external-identities/govbr" outra vez
    Then a API deve responder 404 com código "NOT_FOUND"
    And não deve haver segundo evento nem segunda auditoria

  Scenario: [Duplicidade] Ticket de uso único
    Given que o vínculo de "Marta" foi concluído com o ticket "T1"
    When o mesmo callback for reenviado com o ticket "T1"
    Then a API deve responder 422 com código "GOVBR_LINK_TICKET_INVALID" e não duplicar o vínculo

  Scenario: [Concorrência] Mesma conta gov.br vinculada por dois usuários ao mesmo tempo
    Given que "Marta" e "Paulo" usam a mesma conta gov.br
    When os dois concluírem o vínculo ao mesmo tempo
    Then apenas um deve ficar vinculado
    And o outro deve receber "GOVBR_ACCOUNT_CONFLICT" sem saber quem é o outro usuário

  Scenario: [Concorrência] Dois dispositivos de "Marta" vinculando ao mesmo tempo
    When "Marta" concluir o vínculo em dois dispositivos ao mesmo tempo
    Then deve existir uma única identidade ativa e um único evento "GovbrIdentityLinked"
    And o outro pedido deve receber "GOVBR_ALREADY_LINKED"

  Scenario: [Concorrência] Desvincular enquanto outro dispositivo entra com gov.br
    When "Marta" desvincular e, ao mesmo tempo, entrar com gov.br em outro dispositivo
    Then a entrada deve ser concluída ou recusada com "GOVBR_NOT_LINKED", nunca com estado intermediário
    And o vínculo deve ficar desvinculado

  Scenario: [Falha de banco] Banco indisponível ao concluir o vínculo
    Given que o PostgreSQL está indisponível
    When o BFF tentar concluir o vínculo
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma identidade, auditoria ou evento deve ser gravado
    And "Marta" deve ver "Não foi possível vincular agora. Tente novamente." com o botão "Tentar novamente"

  Scenario: [Falha de banco] Banco indisponível ao desvincular
    Given que o PostgreSQL está indisponível
    When "Marta" confirmar "Desvincular"
    Then a API deve responder 503 e o vínculo deve continuar ativo

  Scenario: [Falha de integração] gov.br indisponível durante o vínculo
    Given que o gov.br não responde
    When "Marta" clicar em "Vincular conta gov.br"
    Then "Marta" deve voltar a "Meu perfil" com "O gov.br não respondeu agora. Tente novamente em instantes."
    And nenhuma identidade deve ser criada

  Scenario: [Falha de integração] Fila de e-mail indisponível
    Given que o relay do outbox está indisponível
    When "Marta" vincular a conta gov.br
    Then o vínculo deve ser criado e a API deve responder 201
    And o evento "GovbrIdentityLinked" deve permanecer "PENDING" até o relay voltar

  Scenario: [Falha de integração] Redis de sessões indisponível
    Given que o Redis de sessões está indisponível
    When "Marta" clicar em "Vincular conta gov.br"
    Then o BFF deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e nenhum ticket deve ser criado
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Órgão sem gov.br habilitado | 403 | `GOVBR_NOT_ENABLED` | "O seu órgão ainda não habilitou o gov.br." | Oculta "Vincular" |
| Já vinculado | 409 | `GOVBR_ALREADY_LINKED` | "Seu usuário já tem uma conta gov.br vinculada." | Recarrega o cartão |
| Conta gov.br de outro usuário | 409 | `GOVBR_ACCOUNT_CONFLICT` | "Esta conta gov.br não pode ser vinculada ao seu usuário. Procure o administrador do seu órgão." | Aviso no cartão; sem detalhe |
| CPF diferente do cadastrado | 422 | `GOVBR_CPF_MISMATCH` | "O CPF da conta gov.br não confere com o CPF cadastrado para o seu usuário. Procure o administrador do seu órgão." | Aviso no cartão |
| Ticket inválido ou expirado | 422 | `GOVBR_LINK_TICKET_INVALID` | "O pedido de vínculo expirou. Tente novamente." | Botão "Vincular conta gov.br" |
| Falta segundo fator ao desvincular | 403 | `MFA_REQUIRED` | "Confirme sua identidade para continuar." | Abre o *step-up* e repete |
| Sem vínculo ativo ao desvincular | 404 | `NOT_FOUND` | "A conta gov.br já foi desvinculada." | Atualiza o cartão |
| Muitos pedidos de vínculo | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns instantes." | Respeita `Retry-After` |
| Operador sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta operação." | — |
| Dados inválidos (operador) | 422 | `VALIDATION_ERROR` | "Informe o motivo (mín. 20 caracteres) e o número do chamado." | Erro no campo |
| Banco, Redis de sessões ou Authentik indisponíveis | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível vincular agora. Tente novamente." | "Tentar novamente", dados mantidos |

## Dependências
- **Stories:** US-098 (Meu perfil, SCR-039, `ME-01`), US-182 (entrada por gov.br, `GOV-02`, sessão com `loginMethod` e nível, rotas do BFF). Indiretas: US-090 (*step-up* e `amr`), US-087/US-088 (sessão e `sessionIdHash`), US-099/US-178 (backoffice e CLI de plataforma), US-111/US-112/US-113 (notificações, e-mail, preferências), US-073 (auditoria), US-184 (habilitação do órgão).
- **Decisões/ADRs:** DEC-207, ADR-017, DEC-012, DEC-086, DEC-138, DEC-140, DEC-142, DEC-078, DEC-139, DEC-208; POL-29, POL-14. Dependência externa: credenciamento da plataforma no Login Único.
- **Configurações:** `auth.govbrEnabled` (por tenant; condiciona só o vínculo); `GOVBR_LOGIN_ENABLED` (ambiente).
- **Lacunas nas fontes canônicas:**
  1. `UserExternalIdentity` (entities.md §4.12) não guarda a máscara do CPF: para exibir `***.456.789-**` sem decifrar `users.cpfEncrypted` (que pode ser nulo) propõe-se a coluna `subjectMasked` (varchar(14), obrigatória, gravada na conclusão do vínculo `PROFILE` e no `CPF_MATCH`). A regra "sem revínculo automático depois de desvincular" (RN-PLAT-208) depende de manter a linha desvinculada, já prevista na entidade (`unlinkedAt`, `unlinkedById`).
  2. O consumidor de `GovbrIdentityLinked`/`Unlinked` precisa criar `Notification` por tenant a partir de um evento de plataforma (`tenantId` nulo) e acionar o e-mail uma única vez; o `notification` hoje parte de eventos de tenant e a DEC-142 já registrou que e-mail sem origem durável não tem canal. Proposta: função `SECURITY DEFINER` para listar os vínculos ativos do usuário, `groupKey` comum e idempotência por `eventId`.
  3. O ticket de vínculo (Redis de sessões, SHA-256, TTL 10 min, preso ao `sessionIdHash`) e as rotas `POST /api/auth/govbr/link/start` e `GET /api/auth/govbr/refused` (retorno por `intent`) não estão em authentication.md; a passagem do ticket até a política do fluxo da fonte no Authentik (parâmetro de início) é a mesma incerteza da lacuna 1 da US-182 e entra na prova de conceito.
  4. Códigos novos fora de api.md §2.2: `GOVBR_ALREADY_LINKED`, `GOVBR_CPF_MISMATCH`, `GOVBR_LINK_TICKET_INVALID` (além de `GOVBR_ACCOUNT_CONFLICT` e `GOVBR_NOT_ENABLED`, da US-182).
  5. Não há permissão específica para o operador desvincular uma identidade de usuário: reaproveitada `PLATFORM_TENANT_MANAGE`; o backoffice (DEC-208) não tem tela de usuários nem como o operador achar o `userId` — adotado localizar por e-mail. Avaliar uma permissão de plataforma própria (`PLATFORM_USER_SUPPORT`) e a tela.
  6. O tenant das auditorias `identity.govbr_link` e `identity.govbr_unlink` (events.md §7) não está definido; adotado o órgão ativo (ações do usuário) e a plataforma (`CPF_MATCH` e operador).
  7. Dúvidas de produto: (1) a recusa por CPF divergente (RN-PLAT-203) é mais rígida que a ADR-017; (2) tela de desvinculação do operador; (3) exigir segundo fator ou autenticação recente também para **vincular**, para a POL-29 não deixar uma sessão sequestrada ligar uma conta gov.br alheia; (4) encerrar as sessões gov.br do usuário na desvinculação pelo operador.

## Impacto técnico
- **Segurança:** o vínculo é amarrado à sessão (ticket com `sessionIdHash`), ao navegador (transação `LINK`) e à pessoa (`sub`), o que fecha o ataque de "vincular a conta de outra pessoa" por ticket ou link vazado. O ticket e o `subjectHash` ficam só no Redis de sessões e no banco; a máscara é o único derivado do CPF que sai da API. Risco aceito pela POL-29: sessão sequestrada pode vincular (sem MFA); mitigações: aviso imediato ao usuário, desvinculação com segundo fator e auditoria.
- **Compatibilidade:** só acrescenta rotas e a tabela de identidades; `ME-01` e a tela SCR-039 ganham um cartão; o fluxo de `/api/auth/callback` passa a respeitar `intent` (acordado com a US-182).
- **Performance:** operações de baixa frequência; `GOV-04` é uma leitura por chave do usuário (p95 < 100 ms).
- **Migração:** `user_external_identities` e seus índices (se a US-182 ainda não os criou); nenhuma mudança em `users`.
- **Reuso:** cartão e fluxo de *step-up* seguem os do painel de MFA da US-090; o resolvedor é o mesmo da US-182 com `intent = LINK`.

## Backend
- **Módulo(s):** `identity` (dono de `UserExternalIdentity`, tickets de vínculo e regras), `notification` (consumidor de `GOVBR_LINK_CHANGED`), `audit`, `platform` (rate limit, credencial do resolvedor). BFF em `apps/web/src/bff/auth/` (`govbr/link/start`, extensão do callback e de `refused`).
- **Casos de uso:** `GetMyExternalIdentitiesQuery` (`GOV-04`), `CreateGovbrLinkIntentCommand` (`GOV-05`), `CompleteGovbrLinkCommand` (`GOV-06`), `UnlinkGovbrIdentityCommand` (`GOV-07`), `UnlinkGovbrIdentityByOperatorCommand` (`GOV-08`), extensão de `ResolveGovbrIdentityCommand` (`intent = LINK`), `GovbrLinkChangedNotifier` (worker).
- **Domínio:** `UserExternalIdentity.link(method, subjectHash, subjectMasked)` / `.unlink(by)` (invariantes e idempotência), `GovbrLinkTicket` (criação, consumo atômico, vínculo à sessão), `GovbrLinkPolicy` (CPF cadastrado, conflito, vínculo existente), `StrongAuthPolicy` (segundo fator real ou gov.br ≤ 10 min).
- **Integrações internas:** `AuditService`, outbox (`GovbrIdentityLinked`/`Unlinked`), `SessionStore`/Redis de sessões (ticket), fachada de `tenancy` (`auth.govbrEnabled` do tenant ativo), função `SECURITY DEFINER` dos vínculos do usuário (notificação).
- **Transação:** a gravação da identidade (ou `unlinkedAt`), a auditoria e a linha do outbox na **mesma** transação; o consumo do ticket é atômico (`GETDEL`) e acontece antes, com devolução se a transação falhar; Authentik fora de transação.

## Frontend
- **Tela(s):** SCR-039 (`/perfil`, `?aba=seguranca`), com o cartão "Conta gov.br" abaixo do `MfaStatusBadge`.
- **Componentes:** `GovbrIdentityCard` (estados: indisponível/oculto, "órgão sem gov.br", "não vinculada" com `GovbrLinkButton`, "vinculada" com `MaskedCpf`, `TrustLevelChip` e `UnlinkGovbrButton`), `UnlinkGovbrDialog` (confirmação e *step-up*), mensagens de retorno (`govbr=…`) em `role="status"`/`role="alert"`.
- **Estados:** carregando (*skeleton* do cartão); botão "Redirecionando…"; sucesso por toast com `aria-live`; erro com "Tentar novamente"; vazio (cartão oculto sem fonte nem vínculo).
- **Acessibilidade e responsividade:** nível de confiança por texto e ícone, nunca só cor; o CPF mascarado tem rótulo para leitor de tela ("CPF final 789, parcialmente oculto"); diálogo com foco preso e retorno do foco ao botão; botões ≥ 44 px; coluna única abaixo de 768 px; testado com axe.

## Banco de dados
- **Tabelas:** `user_external_identities` (plataforma, sem RLS; entities.md §4.12, com `subjectMasked` proposto), `audit_logs`, `outbox_events`, `notifications`.
- **Migrações:** criação de `user_external_identities` (colunas da entidade + `subject_masked`) com os índices abaixo; permissão de `SELECT`/`INSERT`/`UPDATE` do papel da aplicação, **sem** `DELETE`; função `SECURITY DEFINER` dos vínculos ativos do usuário para o consumidor de notificação.
- **Índices/constraints relevantes:** `UNIQUE (provider, subject_hash) WHERE unlinked_at IS NULL`; `UNIQUE (user_id, provider) WHERE unlinked_at IS NULL`; check `unlinked_at IS NULL OR unlinked_by_id IS NOT NULL`; índice `(user_id, provider)`; `subject_hash` e `subject_masked` fora de qualquer `SELECT *` de listagem (colunas explícitas).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| BFF | POST | `/api/auth/govbr/link/start` | sem corpo; `X-CF-Request: 1` | `200 { data: { redirectTo } }`; grava a transação `intent = LINK` | 200, 401, 403, 409, 429, 503 |
| `GOV-04` | GET | `/me/external-identities` | — | `200 { data: { govbr: { available, enabledInActiveTenant, linked, identity \| null, canLink, canUnlink, strongAuthSatisfied } } }` | 200, 401, 403, 503 |
| `GOV-05` | POST | `/me/external-identities/govbr/link-intents` | sem corpo (chamada do BFF) | `201 { data: { ticket, expiresAt } }` | 201, 401, 403, 409, 429, 503 |
| `GOV-06` | POST | `/me/external-identities/govbr/link` | `{ ticket }` (chamada do BFF no callback) | `201 { data: { identity { maskedSubject, linkMethod, linkedAt, lastTrustLevel } } }` | 201, 401, 403, 409, 422, 503 |
| `GOV-07` | DELETE | `/me/external-identities/govbr` | — | `204` | 204, 401, 403 (`MFA_REQUIRED`), 404, 503 |
| `GOV-08` | POST | `/platform/govbr/unlink` | `{ email, reason, ticketReference }`; sem `X-Tenant-Id` | `200 { data: { unlinked: true } }` | 200, 403, 404, 422, 503 |
| `GOV-02` (ext.) | POST | `/internal/govbr/resolve` | acrescenta `intent: "LINK"` e `linkTicket` | acrescenta `LINK_PENDING` (+`authentikUserId`), `GOVBR_CPF_MISMATCH`, `GOVBR_ALREADY_LINKED`, `GOVBR_LINK_TICKET_INVALID` | 200, 401, 422, 503 |

## Logs
- `info` `identity.govbr_link_intent_created` — `userId`, `tenantId`, `durationMs`.
- `info` `identity.govbr_linked` — `userId`, `linkMethod`, `trustLevel`, `correlationId`; `info` `identity.govbr_unlinked` — `userId`, `byOperator`, `correlationId`.
- `warn` `identity.govbr_link_rejected` — `reasonCode` (`ACCOUNT_CONFLICT`, `CPF_MISMATCH`, `ALREADY_LINKED`, `TICKET_INVALID`), sem identificar o outro usuário; `warn` `identity.govbr_link_provider_failed`.
- `error` `identity.govbr_link_failed` — `errorCode`, `durationMs`.
- **Nunca logar:** CPF, máscara, `subjectHash`, ticket (em claro ou o hash completo), tokens, `code`, `state`, e-mail completo; o corpo de `GOV-02` e `GOV-08` não é registrado.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `identity.govbr_link` | `SECURITY` | Vínculo `PROFILE` concluído; `CPF_MATCH` (US-182); falha por conflito, CPF divergente ou ticket (`result = FAILURE`) | `metadata`: `linkMethod`, `trustLevel`, `reasonCode` na falha; tenant ativo (`PROFILE`) ou plataforma (`CPF_MATCH`); sem CPF, máscara nem hash |
| `identity.govbr_unlink` | `SECURITY` | Desvinculação pelo usuário ou pelo operador | `metadata`: `byOperator`, `ticketReference` e `reason` (operador); `actorType = PLATFORM_OPERATOR` e `tenantId` nulo no operador |
| `access.denied` | `ACCESS` | Operador sem `PLATFORM_TENANT_MANAGE` | `reasonCode = PLATFORM_TENANT_MANAGE` |

## Testes necessários
- **Unitários:** `GovbrLinkPolicy` (CPF cadastrado igual, diferente, ausente; conflito; já vinculado); `GovbrLinkTicket` (uso único, expiração, vínculo à sessão e ao usuário); `StrongAuthPolicy` (segundo fator, gov.br de 9 e de 11 minutos); formato da máscara; `UserExternalIdentity.link`/`unlink` (idempotência).
- **Integração (Testcontainers PostgreSQL + Redis + Authentik com fonte gov.br simulada):** jornada de vínculo e de desvinculação; índices únicos parciais sob concorrência (duas contas, dois usuários, dois dispositivos); atomicidade de identidade + auditoria + outbox; consumidor de notificação com evento de plataforma; sem `DELETE`.
- **API/contrato:** `GOV-04` a `GOV-08` e a extensão de `GOV-02`; códigos de erro; nenhuma resposta com `subjectHash`, CPF ou `unlinkedById`.
- **RBAC e multi-tenant:** só o próprio usuário; `GOV-08` com e sem permissão/MFA; vínculo global com habilitação por órgão ativo; ticket de outra sessão; suíte `test/tenant-leak` (leitura de identidades de outro usuário; auditoria no tenant correto); **varredura de dados**: CPF, máscara e hash fora de logs, eventos, e-mails e auditoria.
- **Concorrência:** duas contas iguais, dois dispositivos, desvincular × entrar, duplo clique em "Desvincular".
- **E2E (Playwright, IdP federado simulado):** vincular, entrar com gov.br, desvincular com *step-up*, conflito, CPF divergente, e-mail/aviso recebido; 360 px e 1024 px.
- **Acessibilidade/performance:** axe no cartão e no diálogo; `GOV-04` p95 < 100 ms (suíte de performance, no endurecimento).

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
- [ ] Teste de que um ticket de outra sessão, expirado ou reutilizado nunca vincula
- [ ] Varredura de CPF, máscara, `subjectHash` e ticket em logs, eventos, e-mails e auditoria verde
- [ ] Aviso `GOVBR_LINK_CHANGED` (in-app e e-mail único) verificado em teste para vínculo, desvinculação e operador

## Estimativa
**M** — uma entidade nova com índices únicos parciais, cinco rotas (três delas do fluxo de vínculo amarrado à sessão), a extensão do resolvedor e do callback, o cartão e o diálogo no perfil, o consumidor de notificação sobre evento de plataforma e testes de concorrência e de segurança; a parte mais cara é o fluxo `LINK` com ticket.

## Prioridade
**P1** — sem o vínculo em "Meu perfil" a entrada por gov.br só funciona por `CPF_MATCH`, que depende de um cadastro de CPF que ainda não existe; é parte do critério de saída do MVP 2, mas depende da US-182 e do credenciamento externo.
