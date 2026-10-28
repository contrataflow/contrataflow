---
id: US-088
title: "Logout, expiração e renovação de sessão"
epic: EP-016
feature: FT-051
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-087]
modules: [identity, audit, platform]
screens: [SCR-001, SCR-111]
endpoints: []          # rotas do BFF (/api/auth/logout, /api/auth/session); ver seção API
permissions: []        # capacidade implícita
events: []             # consome MembershipSuspended, MembershipRevoked, MembershipExpired
---

# US-088 — Logout, expiração e renovação de sessão

## Título
Sair com segurança, expirar sessões ociosas ou longas e renovar tokens de forma transparente

## Descrição
**Como** usuário do ContrataFlow, **quero** sair de forma completa, ter minha sessão encerrada automaticamente quando eu me ausentar e não ser interrompido enquanto trabalho, **para** proteger meu acesso em computadores compartilhados sem perder o que estou digitando.

O BFF implementa logout local + *RP-initiated logout* no Authentik, expiração por ociosidade (deslizante) e por duração absoluta conforme a instituição ativa, renovação transparente do access token com rotação do refresh token, sincronização entre abas e o modal "Sua sessão expirou" que preserva rascunhos locais. Quando um vínculo é suspenso, revogado ou expira, as sessões do usuário naquela instituição são encerradas pelo worker.

## Contexto
- Servidores usam computadores compartilhados em protocolos e secretarias; a persona P01 exige que "desligamentos sejam refletidos no mesmo dia". DEC-131 fixa ociosidade padrão de 30 min e duração absoluta de 12 h, configuráveis por instituição (`security.sessionIdleMinutes` 5..120; `security.sessionAbsoluteHours` 1..24), com logout local + RP-initiated logout.
- O Redis de sessões é dependência crítica (DEC-131); sua indisponibilidade gera 503, nunca "sessão expirada".
- CA-T-09 (acceptance-criteria.md): sessão expirada → 401 `SESSION_EXPIRED`, aviso, preservação de rascunhos locais e retorno ao ponto após novo login. Rascunho local em IndexedDB já é previsto no autosave (DEC-182).
- Complementa a US-087 (criação da sessão); a troca de instituição recalcula limites (US-093).

## Objetivo
Garantir que 100% das sessões terminem no máximo no limite configurado (tolerância de 1 min), que nenhuma renovação de token interrompa o usuário (0 erros 401 por renovação concorrente em teste de carga) e que nenhum texto digitado se perca por expiração (restauração após novo login em 100% dos casos testados).

## Persona
- **Principal:** Área requisitante (`REQUISITANTE`) em computador compartilhado.
- **Secundárias:** Planejamento (`PLANEJAMENTO`) redigindo ETP por horas; Administrador do órgão (`ADMIN_ORGAO`), que suspende vínculos e espera efeito imediato.

## Pré-condições
- Sessão criada pela US-087 com tokens cifrados, `createdAt`, `lastSeenAt`, `absoluteExpiresAt` e `idleMinutes`.
- Cliente OIDC do BFF com `offline_access`, rotação de refresh token habilitada e validade do refresh ≥ 24 h (teto da plataforma); `end_session_endpoint` e endpoint de revogação publicados na descoberta OIDC.
- Worker com outbox e filas (US-082, US-083) para consumir eventos de vínculo.

## Fluxo principal
1. **Atividade:** a cada requisição iniciada pelo usuário, o BFF atualiza `lastSeenAt` e recalcula `idleExpiresAt` (RN-IAM-21); rotas de sondagem não renovam.
2. **Renovação:** antes de encaminhar a `/api/v1/*`, se o access token vence em ≤ 60 s, o BFF obtém a trava de renovação da sessão, chama o `token_endpoint` com `grant_type=refresh_token`, grava atomicamente o novo access token e o novo refresh token (rotação) e libera a trava; requisições paralelas aguardam e reutilizam o resultado (RN-IAM-25).
3. **Aviso de ociosidade:** o shell mantém um contador local alimentado por `GET /api/auth/session`; 2 min antes de `idleExpiresAt` exibe o diálogo "Você continua aí? Sua sessão será encerrada por inatividade em 2 minutos." com **"Continuar conectado"** e **"Sair"**.
4. **Aviso de duração absoluta:** 5 min antes de `absoluteExpiresAt`, exibe aviso não bloqueante "Sua sessão termina às 01:00. Salve seu trabalho; depois será preciso entrar novamente."
5. **Expiração:** na primeira requisição após o limite, o BFF apaga os tokens, registra o motivo (`IDLE` ou `ABSOLUTE`) e responde 401 `SESSION_EXPIRED`. O shell mostra o modal **"Sua sessão expirou"** ("Por segurança, sua sessão foi encerrada. O que você digitou foi guardado neste navegador.") com **"Entrar novamente"**, que leva a `/api/auth/login?returnTo=<página atual>` com reautenticação (RN-IAM-32). Ao voltar, o editor oferece "Recuperamos alterações não salvas" (RN-IAM-30).
6. **Logout:** o usuário escolhe **"Sair"** no menu do avatar. Havendo rascunho local não sincronizado, a interface confirma. O navegador chama `POST /api/auth/logout` (com `X-CF-Request: 1`); o BFF executa RN-IAM-20 e devolve `logoutUrl`; o shell envia `logout` às demais abas, limpa caches locais e navega para `logoutUrl`; o Authentik encerra a própria sessão e retorna a `/entrar?motivo=saiu` ("Você saiu com segurança.").
7. **Encerramento por vínculo:** ao consumir `MembershipSuspended`, `MembershipRevoked` ou `MembershipExpired`, o worker encerra as sessões do usuário cuja instituição ativa é a do evento (RN-IAM-27).
8. **Varredura e auditoria:** um job de plataforma, a cada minuto, grava `auth.session_end`/`auth.session_expired` das sessões encerradas ou vencidas (inclusive as nunca mais acessadas) com o horário real do fato e remove os registros (RN-IAM-28).

## Fluxos alternativos
- **FA-01 — "Continuar conectado":** chama `GET /api/auth/session?keepalive=true`, que renova `lastSeenAt`; todas as abas recebem `extended` e reiniciam o contador.
- **FA-02 — Ação do usuário durante o aviso:** qualquer requisição iniciada pelo usuário renova a ociosidade e fecha o diálogo.
- **FA-03 — Autosave na expiração:** o PUT de seção recebe 401 `SESSION_EXPIRED`; o editor mantém o conteúdo no rascunho local, mostra o modal e reenvia após o novo login (com a revisão da seção; conflitos seguem DEC-182).
- **FA-04 — Renovação recusada (`invalid_grant`):** sessão encerrada com motivo `REFRESH_FAILED`; 401 `SESSION_EXPIRED`; mesmo modal.
- **FA-05 — Authentik indisponível na renovação:** com access token ainda válido, a requisição segue; vencido, responde 503 `DEPENDENCY_UNAVAILABLE` ("O serviço de autenticação está indisponível. Seu trabalho foi preservado.") sem encerrar a sessão.
- **FA-06 — Authentik indisponível no logout:** o logout local é concluído; `logoutUrl` aponta para `/entrar?motivo=saiu-parcial` ("Você saiu do ContrataFlow. Para encerrar também a conta institucional neste navegador, feche-o.").
- **FA-07 — Sessão sem instituição ativa** (SCR-111 "sem vínculo"): mesmas regras de expiração e logout, com limites padrão da plataforma e sem auditoria de tenant.
- **FA-08 — Vínculo suspenso enquanto o usuário trabalha:** a próxima requisição recebe 403 `MEMBERSHIP_INACTIVE`; o shell mostra SCR-111 ("Seu acesso a esta instituição foi suspenso.") e, se houver outros vínculos utilizáveis, oferece a seleção (US-093).

## Regras de negócio
- **RN-IAM-20** — Logout (`POST /api/auth/logout`, exige `X-CF-Request: 1` e origem própria): revoga o refresh token no endpoint de revogação do Authentik (RFC 7009; tempo-limite 2 s; melhor esforço), apaga os tokens, marca a sessão como encerrada (`LOGOUT`), remove o `sid` do índice do usuário, expira o cookie e devolve a URL do *RP-initiated logout* (`end_session_endpoint` com `client_id` e `post_logout_redirect_uri` = `https://<app>/entrar?motivo=saiu`; sem `id_token_hint`, que ficaria no histórico do navegador — DEC-070/DEC-073). É idempotente: sem sessão, responde 200 com `logoutUrl` para SCR-001.
- **RN-IAM-21** — Ociosidade deslizante: `idleExpiresAt = lastSeenAt + security.sessionIdleMinutes` da instituição ativa. Só requisições iniciadas pelo usuário renovam; não renovam `GET /api/auth/session` sem `keepalive`, `NTF-02` (contador de notificações) e `TSK-02` (contadores da caixa), que são consultas de sondagem.
- **RN-IAM-22** — Duração absoluta: `absoluteExpiresAt = createdAt + security.sessionAbsoluteHours`, nunca estendida (nem por "Continuar conectado"); depois dela, somente novo login.
- **RN-IAM-23** — Avisos: diálogo de ociosidade 2 min antes; aviso de término absoluto 5 min antes; ambos anunciados por `aria-live` e operáveis por teclado.
- **RN-IAM-24** — Requisição com sessão vencida → BFF apaga tokens, registra motivo `IDLE` ou `ABSOLUTE` e responde 401 `SESSION_EXPIRED`; o horário do fato é o limite calculado, não o da detecção.
- **RN-IAM-25** — Renovação quando o access token vence em ≤ 60 s, com trava por sessão (uma renovação por vez; espera máxima de 5 s pelas demais requisições); rotação do refresh token gravada de forma atômica (o anterior deixa de ser usado).
- **RN-IAM-26** — Falha definitiva de renovação (`invalid_grant`, token revogado ou reutilizado) encerra a sessão (motivo `REFRESH_FAILED`) → 401 `SESSION_EXPIRED`. Falha transitória: segue com o token válido; sem token válido → 503 `DEPENDENCY_UNAVAILABLE`, sessão preservada.
- **RN-IAM-27** — Ao consumir `MembershipSuspended`, `MembershipRevoked` ou `MembershipExpired`, o worker encerra, pelo índice de sessões do usuário, apenas as sessões cuja instituição ativa é a do evento, gravando `auth.session_end` com motivo `MEMBERSHIP_SUSPENDED`, `MEMBERSHIP_REVOKED` ou `MEMBERSHIP_EXPIRED`. Sessões ativas em outras instituições continuam. O efeito de acesso é imediato porque a API verifica o vínculo em toda requisição (DEC-132); o consumidor é idempotente por `eventId`.
- **RN-IAM-28** — Auditoria de encerramento: `auth.session_end` para `LOGOUT`, `SESSION_LIMIT` e encerramentos por vínculo; `auth.session_expired` para `IDLE`, `ABSOLUTE` e `REFRESH_FAILED`; gravadas pelo job de varredura (a cada 1 min) na instituição ativa da sessão, com `occurredAt` = horário real; registros de encerramento sem tokens ficam no máximo 24 h no Redis.
- **RN-IAM-29** — Sincronização entre abas por `BroadcastChannel` `cf-session` (`logout`, `expired`, `extended`): logout em uma aba leva todas a SCR-001; expiração exibe o modal em todas; "Continuar conectado" reinicia o contador de todas.
- **RN-IAM-30** — Rascunhos locais (IndexedDB, chave usuário + instituição) sobrevivem à expiração por até 24 h e só são oferecidos ao mesmo usuário na mesma instituição; ao entrar outro usuário no navegador, rascunhos de terceiros são apagados.
- **RN-IAM-31** — Logout explícito com rascunho não sincronizado exige confirmação; ao sair, o shell limpa o cache do TanStack Query, os rascunhos locais do usuário e o `sessionStorage`.
- **RN-IAM-32** — O login após expiração pede reautenticação ao Authentik (`max_age=0`), e a sessão do próprio Authentik dura no máximo o teto absoluto da plataforma, para que a ociosidade não seja contornada.
- **RN-IAM-33** — Redis de sessões indisponível → 503 `DEPENDENCY_UNAVAILABLE` em todas as rotas autenticadas (DEC-131); a interface exibe indisponibilidade (SCR-111), nunca "sessão expirada", e preserva rascunhos.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| *(técnico)* Último uso | `lastSeenAt` (registro da sessão) | timestamp | Sim | RN-IAM-21 | BFF |
| *(técnico)* Fim por ociosidade / absoluto | `idleExpiresAt` / `absoluteExpiresAt` | timestamp | Sim | RN-IAM-21/22 | calculados |
| *(técnico)* Motivo do encerramento | `endReason` (`LOGOUT`, `IDLE`, `ABSOLUTE`, `REFRESH_FAILED`, `SESSION_LIMIT`, `MEMBERSHIP_*`) | texto | Ao encerrar | RN-IAM-28 | BFF/worker |
| *(técnico)* Manter conectado | `keepalive` (query de `GET /api/auth/session`) | booleano | Não | RN-IAM-21 | `false` |
| *(configuração)* Ociosidade / Duração absoluta | `security.sessionIdleMinutes` / `security.sessionAbsoluteHours` | int | — | 5..120 / 1..24 (US-103) | 30 / 12 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Logout sem `X-CF-Request` ou com origem externa | BFF | "Não foi possível confirmar a origem da solicitação." | `CSRF_REJECTED` (padrão do BFF — US-086, DEC-073) |
| V-02 | Sessão inexistente | BFF | "Entre para continuar." | `UNAUTHENTICATED` |
| V-03 | Sessão vencida por ociosidade/absoluta ou renovação recusada | BFF | "Sua sessão expirou. Entre novamente para continuar." | `SESSION_EXPIRED` |
| V-04 | Vínculo suspenso/revogado/expirado durante o uso | API | "Seu acesso a esta instituição não está ativo." | `MEMBERSHIP_INACTIVE` |
| V-05 | Authentik ou Redis de sessões indisponíveis | BFF | "Serviço temporariamente indisponível. Seu trabalho foi preservado." | `DEPENDENCY_UNAVAILABLE` |

## Permissões
- **Permissão:** nenhuma — sair e consultar a própria sessão são capacidades implícitas.
- **Políticas:** um usuário só encerra a própria sessão; não há rota para encerrar sessões de terceiros (o encerramento administrativo é efeito da suspensão/revogação do vínculo — US-092).
- **MFA:** não se aplica.
- **Sem permissão:** requisição sem sessão → 401 `UNAUTHENTICATED` e redirecionamento a SCR-001.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Não gera eventos. Consome `MembershipSuspended`, `MembershipRevoked` e `MembershipExpired` (events.md §4.6, "encerramento de sessões") |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma; avisos de expiração são interface, não notificação |

## Critérios de aceite em Gherkin
```gherkin
Feature: Logout, expiração e renovação de sessão

  Background:
    Given que a instituição "Prefeitura de São José" usa ociosidade de 30 minutos e duração absoluta de 12 horas
    And "Cláudia" tem sessão ativa iniciada às 08:00

  Scenario: [Sucesso] Sair encerra a sessão local e a do Authentik
    Given que "Cláudia" tem duas abas abertas
    When "Cláudia" clicar em "Sair" em uma das abas
    Then o refresh token deve ser revogado no Authentik e a sessão encerrada no Redis
    And o cookie "__Host-cf_session" deve ser expirado
    And o navegador deve passar pelo encerramento de sessão do Authentik com "client_id" e voltar a "/entrar?motivo=saiu"
    And a outra aba deve ser levada à página de entrada
    And deve gerar registro de auditoria "auth.session_end" com motivo "LOGOUT"

  Scenario: [Sucesso] Expiração por ociosidade preserva o rascunho
    Given que "Cláudia" digitou um trecho na seção "Justificativa" do DFD e ficou 31 minutos sem interagir
    When o autosave ou qualquer ação for enviada
    Then a resposta deve ser 401 com código "SESSION_EXPIRED"
    And deve ser exibido o modal "Sua sessão expirou" com "Entrar novamente"
    And após novo login "Cláudia" deve voltar ao DFD e ver "Recuperamos alterações não salvas"
    And deve gerar registro de auditoria "auth.session_expired" com motivo "IDLE" e horário 30 minutos após a última atividade

  Scenario: [Sucesso] Renovação transparente do access token
    Given que o access token de "Cláudia" vence em 30 segundos
    When "Cláudia" abrir a lista de processos
    Then o BFF deve renovar o token com rotação do refresh token antes de encaminhar
    And a lista deve ser exibida sem nenhum erro

  Scenario: [Validação] Sondagens não estendem a ociosidade
    Given que "Cláudia" está inativa há 29 minutos com o contador de notificações consultado a cada minuto
    When passarem mais 2 minutos sem ação do usuário
    Then a sessão deve expirar por ociosidade

  Scenario: [Validação] Duração absoluta não é prorrogável
    Given que são 19:58 e "Cláudia" usa o sistema continuamente desde as 08:00
    When "Cláudia" clicar em "Continuar conectado" às 19:59
    Then a sessão deve terminar às 20:00 e exigir novo login

  Scenario: [Permissão] Requisição sem sessão
    When o navegador chamar "GET /api/v1/processes" sem cookie de sessão
    Then o BFF deve responder 401 com código "UNAUTHENTICATED"

  Scenario: [Tenant incorreto] Revogação em uma instituição não encerra sessão em outra
    Given que "Bruno" tem uma sessão ativa na "Prefeitura de São José" e outra na "Prefeitura de Santa Luzia"
    When o vínculo de "Bruno" na "Prefeitura de Santa Luzia" for revogado
    Then apenas a sessão ativa na "Prefeitura de Santa Luzia" deve ser encerrada
    And deve gerar registro de auditoria "auth.session_end" com motivo "MEMBERSHIP_REVOKED" somente na "Prefeitura de Santa Luzia"
    And a sessão na "Prefeitura de São José" deve continuar funcionando

  Scenario: [Duplicidade] Logout repetido
    When "Cláudia" acionar "Sair" duas vezes seguidas
    Then as duas respostas devem ser 200 e existir um único registro "auth.session_end"

  Scenario: [Concorrência] Requisições paralelas com token vencido
    Given que o access token de "Cláudia" está vencido
    When 10 requisições chegarem ao BFF ao mesmo tempo
    Then deve ocorrer exatamente uma renovação no Authentik
    And as 10 requisições devem ser atendidas com o novo token

  Scenario: [Concorrência] Logout em uma aba durante requisição em outra
    When "Cláudia" sair na aba A enquanto a aba B envia um comando
    Then o comando da aba B deve receber 401 e a aba B deve ser levada à página de entrada

  Scenario: [Falha de banco] Banco indisponível na varredura
    Given que o PostgreSQL está indisponível quando o job de varredura processa um logout
    Then o logout do usuário não deve ser afetado
    And a auditoria "auth.session_end" deve ser gravada quando o banco voltar, com o horário original

  Scenario: [Falha de integração] Authentik indisponível na renovação
    Given que o Authentik não responde e o access token de "Cláudia" está vencido
    When "Cláudia" salvar uma alteração
    Then o BFF deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a sessão não deve ser encerrada e o rascunho deve permanecer
    And deve ser registrado log "warn" "auth.refresh_failed"

  Scenario: [Falha de integração] Refresh token recusado
    Given que o Authentik responde "invalid_grant" à renovação
    When "Cláudia" fizer uma requisição
    Then a resposta deve ser 401 com código "SESSION_EXPIRED"
    And deve gerar registro de auditoria "auth.session_expired" com motivo "REFRESH_FAILED"

  Scenario: [Falha de integração] Redis de sessões indisponível
    Given que o Redis de sessões está fora do ar
    When "Cláudia" fizer qualquer requisição
    Then a resposta deve ser 503 com código "DEPENDENCY_UNAVAILABLE"
    And a interface deve exibir indisponibilidade, nunca "Sua sessão expirou"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem sessão | 401 | `UNAUTHENTICATED` | "Entre para continuar." | Vai a SCR-001 com `returnTo` |
| Sessão expirada / renovação recusada | 401 | `SESSION_EXPIRED` | "Sua sessão expirou. Entre novamente para continuar." | Modal; preserva rascunhos; retorna ao ponto |
| Vínculo inativo durante o uso | 403 | `MEMBERSHIP_INACTIVE` | "Seu acesso a esta instituição não está ativo." | SCR-111; oferece outra instituição se houver |
| CSRF no logout | 403 | `CSRF_REJECTED` | "Não foi possível confirmar a origem da solicitação." | Recarrega |
| Authentik ou Redis de sessões indisponíveis | 503 | `DEPENDENCY_UNAVAILABLE` | "Serviço temporariamente indisponível. Seu trabalho foi preservado." | Mantém a tela; "Tentar novamente"; correlationId |

## Dependências
- **Stories:** US-087 (sessão). Indiretas: US-073 (auditoria), US-082/US-083 (eventos e worker), US-086 (shell e modal), US-092 (eventos de vínculo), US-093 (recalcular limites na troca), DEC-182/autosave (US-015).
- **Decisões/ADRs:** DEC-131, DEC-132, DEC-135, DEC-138, DEC-161, DEC-163, DEC-182; ADR-003.
- **Configurações:** `security.sessionIdleMinutes`, `security.sessionAbsoluteHours`.
- **Lacunas nas fontes canônicas** (resolvidas na implementação — DEC-073, authentication.md §4.1):
  1. O parâmetro `keepalive` de `GET /api/auth/session` e a lista de rotas de sondagem que não renovam a ociosidade não estão em authentication.md (em redação).
  2. DEC-163 não prevê job de plataforma por minuto para varredura de sessões; proposto job recorrente `session-sweep` em fila de plataforma (DEC-164).
  3. A auditoria de encerramento é gravada pelo worker após o fato (o logout não tem transação de banco), divergindo do padrão "mesma transação" de DEC-161; adotado `occurredAt` = horário real.
  4. O BFF precisa dos limites de sessão da instituição ativa; a lista de chaves expostas por `SET-03 /settings/public` não está definida (US-103).
  - **Resolução:** (1) `keepalive=true` renova e as sondagens NTF-02/TSK-02 não; (2) a varredura roda no processo da API a cada 1 min até a US-083 (só a API grava auditoria); (3) `occurredAt` = horário real, com `oncePerSession` contra duplicata; (4) a sessão guarda `idleMinutes` e recalcula os prazos na ativação — padrão 30 min / 12 h até a US-103. O worker encontra as sessões pelo índice `cf:{env}:sess:membership:{membershipId}`, não por `tenant_memberships`.

## Impacto técnico
- Trava de renovação por sessão no Redis de sessões (`SET NX PX 10000`) evita tempestade de renovações e reutilização de refresh token rotacionado (que o Authentik trataria como roubo).
- Índices auxiliares propostos no Redis de sessões: `cf:{env}:sess:user:{userId}` (conjunto de sessões do usuário) e `cf:{env}:sess:expiry` (conjunto ordenado por prazo, base da varredura).
- O consumidor de eventos de vínculo roda no worker e precisa ler/apagar chaves do Redis de sessões: formato da sessão definido em constantes compartilhadas (`packages/types`).
- A verificação do vínculo em toda requisição (DEC-132) garante efeito imediato da suspensão; o encerramento de sessão é higiene e experiência.

## Backend
- **Módulo(s):** `identity` (`SessionTerminationHandler` — consumidor de `membership.suspended|revoked|expired`; `SessionSweepJob`), `audit`, `platform` (fila e job recorrente).
- **Casos de uso:** `TerminateMembershipSessionsCommand` (por `membershipId` → `userId` → sessões com aquela instituição ativa); `RecordSessionEndingsCommand` (varredura).
- **BFF:** `SessionStore.touch/expire/end`, `TokenRefresher` (single-flight), rota `POST /api/auth/logout`, rota `GET /api/auth/session`, classificação de rotas de sondagem no proxy.
- **Transação:** cada registro de auditoria da varredura em transação própria na instituição da sessão (contexto de tenant — DEC-164); remoção do registro do Redis somente após o commit.

## Frontend
- **Tela(s):** modal global "Sua sessão expirou", diálogo "Você continua aí?", aviso de término absoluto, menu do avatar com "Sair"; SCR-001 (mensagens `saiu`, `saiu-parcial`, `sessao-expirada`); SCR-111 (vínculo inativo, indisponibilidade).
- **Componentes:** `SessionWatcher` (contadores, `BroadcastChannel` `cf-session`), `SessionExpiredModal`, `IdleWarningDialog`, `LogoutGuard` (confirmação com rascunhos), interceptador do cliente de API (401 `SESSION_EXPIRED` → modal; 503 → banner).
- **Estados:** diálogo com contagem regressiva acessível; modal bloqueante com foco preso; banner de indisponibilidade com "Tentar novamente".
- **Acessibilidade e responsividade:** anúncios por `aria-live="assertive"` no aviso de ociosidade; foco retorna ao elemento de origem ao fechar; diálogos utilizáveis em 360 px.

## Banco de dados
- **Tabelas:** somente leitura de `tenant_memberships` (consumidor) e escrita em `audit_logs`.
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, user_id)` em `tenant_memberships` para obter o `userId` do evento.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| BFF | POST | `/api/auth/logout` | `X-CF-Request: 1` | `200 { data: { logoutUrl } }` | 200, 403 |
| BFF | GET | `/api/auth/session?keepalive=` | `keepalive?` | `200 { data: { user, activeTenant, idleExpiresAt, absoluteExpiresAt } }` | 200, 401, 503 |
| BFF | * | `/api/v1/*` | — | resposta da API; renovação transparente | 401 `SESSION_EXPIRED`, 503 |
| Authentik | POST | revogação (RFC 7009) / `end_session_endpoint` | refresh token / `id_token_hint`, `post_logout_redirect_uri` | — | — |

## Logs
- `info` `auth.logout` — `userId`, `tenantId`, `rpLogout` (sucesso/parcial).
- `info` `auth.session_expired` — motivo, `idleMinutes`, `sessionAgeMinutes`.
- `info` `auth.sessions_terminated` — `membershipId`, motivo, quantidade.
- `warn` `auth.refresh_failed` — tipo (`TRANSIENT`/`INVALID_GRANT`), latência do provedor.
- `warn` `auth.rp_logout_unavailable`; `error` `auth.session_store_unavailable`.
- **Nunca logar:** `sid`, tokens, `id_token_hint`, valores de cookie.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `auth.session_end` | `SECURITY` | Logout, limite de sessões, encerramento por vínculo | `metadata`: `reason`, `sessionAgeMinutes`; coluna `sessionIdHash` |
| `auth.session_expired` | `SECURITY` | Ociosidade, duração absoluta, renovação recusada | `metadata`: `reason`, `idleMinutes`; `occurredAt` = limite atingido |

## Testes necessários
- **Unitários:** cálculo de `idleExpiresAt`/`absoluteExpiresAt`; classificação de rotas de sondagem; máquina de estados do `SessionWatcher`; regra de rascunhos por usuário.
- **Integração (Testcontainers):** Authentik real: rotação de refresh, `invalid_grant` após reutilização, revogação no logout; Redis: trava de renovação; consumidor de `membership.revoked` encerra só a sessão da instituição do evento; varredura grava auditoria com horário original.
- **Concorrência:** 10 e 100 requisições paralelas com token vencido → 1 renovação; logout × requisição em voo.
- **RBAC e multi-tenant:** consultor com sessões em duas instituições; auditoria gravada só no tenant da sessão.
- **E2E (Playwright, relógio simulado):** aviso de ociosidade, "Continuar conectado", expiração com restauração de rascunho, logout com duas abas, término absoluto.
- **Acessibilidade/performance:** axe nos diálogos; overhead do BFF por requisição < 3 ms p95 sem renovação.

## Definition of Done
- [ ] Cenários Gherkin automatizados (BFF, worker e E2E com relógio simulado) passando no CI
- [ ] Logout completo (local + revogação + RP-initiated) verificado com Authentik real
- [ ] Encerramento por vínculo restrito à instituição do evento, com teste
- [ ] Auditoria `auth.session_end`/`auth.session_expired` com horário real verificada
- [ ] Nenhum rascunho perdido nos cenários de expiração testados; rascunhos de terceiros apagados
- [ ] Logs sem `sid`/tokens; métricas `auth_refresh_total{result}` e `auth_sessions_expired_total{reason}`
- [ ] Diálogos acessíveis (axe, teclado, leitor de tela) e responsivos
- [ ] Revisão de código e de segurança aprovadas

## Como funciona (revisão de 2026-10-28 · DEC-187)
- **Logout:** "Sair" faz `POST /api/auth/logout` (CSRF de DEC-135); o BFF revoga o refresh token no Authentik (melhor esforço, 2 s), encerra a sessão (`LOGOUT`, tokens apagados) e responde `{ data: { logoutUrl: '/entrar?motivo=saiu' } }`. O navegador **não** passa mais pelo `end-session` do Authentik: o login nativo já encerra a sessão do IdP logo depois de trocar o código, e o Authentik 2026.8 recusava o `end-session` com `post_logout_redirect_uri` sem `id_token_hint` (o "Bad Request" visto em 2026-10-28). Authentik fora do ar: o logout local se conclui do mesmo jeito e o BFF registra `warn auth.revocation_unavailable`; `saiu-parcial` deixou de existir.
- **Expiração:** o "Entrar novamente" leva a `/api/auth/login?reauth=1`, que agora é só um atalho para `/entrar?motivo=sessao-expirada&returnTo=…` — o login nativo sempre pede a senha, então a reautenticação (RN-IAM-32) vale sem `prompt=login`.
- **Código:** `apps/web/src/bff/auth-handler.ts` (`logout`, `loginEntry`).

## Estimativa
**M** — lógica concentrada no BFF (renovação concorrente, ociosidade, logout completo), um consumidor e um job no worker e componentes globais de interface; reutiliza a sessão da US-087.

## Prioridade
**P0** — sem expiração e logout confiáveis o produto não atende requisitos mínimos de segurança (OWASP ASVS nível 2) nem o uso em computadores compartilhados.
