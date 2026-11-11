---
id: US-179
title: "Ciclo de vida do tenant no backoffice"
epic: EP-029
feature: FT-083
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-178]
modules: [tenancy, identity, access, audit, platform]
screens: [SCR-123]
endpoints: [PLT-02, PLT-03, PLT-04, PLT-05, PLT-06, PLT-07, PLT-13, PLT-14]
permissions: [PLATFORM_TENANT_MANAGE]
events: [TenantActivated, TenantSuspended, TenantOffboarded, TenantDeactivated]
---

# US-179 — Ciclo de vida do tenant no backoffice

## Título
Ciclo de vida do tenant no backoffice

## Descrição
**Como** operador da plataforma (`User.isPlatformOperator`, com `PLATFORM_TENANT_MANAGE`), **quero** ativar, suspender, encerrar (com a data de fim do prazo de retenção) e desativar uma instituição contratante pela área `/plataforma`, com confirmação, motivo e as ações que a situação atual permite, **para** conduzir a vida do contrato sem terminal, sem transição inválida e com trilha auditável visível ao cliente, sem nunca tocar em dado de processo ou documento.

A story entrega, sobre o detalhe da instituição da US-178, o painel **"Ciclo de vida"**: situação atual, ações disponíveis calculadas pelo servidor, diálogos de confirmação com o impacto de cada ação, histórico de mudanças e o indicador de prazo de encerramento vencido. As operações são **as da US-099/DEC-078** (`ActivateTenantCommand`, `SuspendTenantCommand`, `OffboardTenantCommand`, `DeactivateTenantCommand`, PLT-04..07): a story não cria regra de transição nova, só dá a elas uma tela, um contrato completo para o encerramento (data de fim da retenção) e para a desativação (confirmação do identificador) e as consultas de apoio `PLT-13` e `PLT-14`.

## Contexto
- No MVP 1 suspender, encerrar e desativar eram da CLI (encerrar e desativar nem tinham rota documentada: lacunas 1 e 3 da US-099); DT-07 aceitou isso porque havia poucos pilotos. A DEC-208 traz as quatro ações para o backoffice, com "confirmação e motivo" e "data de fim da retenção" (FT-083).
- DEC-078/RN-TEN-09: `PROVISIONING → ACTIVE`; `ACTIVE → SUSPENDED`; `SUSPENDED → ACTIVE`; `ACTIVE|SUSPENDED → OFFBOARDING`; `OFFBOARDING → ACTIVE` (reversão); `OFFBOARDING|PROVISIONING → DEACTIVATED` (final); qualquer outra → `409 INVALID_STATE`. DEC-132/RN-TEN-10: `PROVISIONING`, `SUSPENDED` e `DEACTIVATED` recusam toda requisição de usuário (`403 TENANT_SUSPENDED`); `OFFBOARDING` permite só leitura e exportação a `ADMIN_ORGAO` e `AUDITOR`.
- RN-TEN-11: suspensão exige motivo (10–1.000 caracteres), nunca exibido aos usuários do tenant, efeito em até 60 s em todas as instâncias, **sem destruir sessões** (cada requisição é recusada) e **sem pausar prazos de etapas**. RN-TEN-12: jobs de tenant fora de `ACTIVE` terminam sem efeito, exceto `audit-seal` (sempre) e `document-render` em `OFFBOARDING`. RN-TEN-13: encerramento exige motivo; desativação exige confirmação digitada do slug; nenhuma das duas exclui dados (DEC-034, PEND-07) e o slug continua reservado. RN-TEN-15: ações de plataforma são auditadas **no tenant** com `actorType = PLATFORM_OPERATOR`.
- FT-083: `RN-PLAT-03` (provisionar, suspender, encerrar e desativar usam as operações da US-099 e emitem `TenantProvisioned`, `TenantSuspended`, `TenantOffboarded`, `TenantDeactivated`), `RN-PLAT-02` (o backoffice não devolve dado de processo ou documento) e `RN-PLAT-06` (toda ação de operador é auditada e visível ao administrador do tenant). As RN-PLAT-120..139 abaixo só acrescentam o que é da tela e do contrato.
- Já definido na US-178 e **não repetido aqui**: acesso do operador, MFA sempre, 404 para quem não é operador, `backoffice.access`, allowlist de campos de saída, limites de taxa por operador (RN-PLAT-100..105 e 118), listagem e detalhe.
- O `Tenant` já tem `offboardingStartedAt` e `offboardingEndsAt` (obrigatório em `OFFBOARDING` — entities.md §4.1) e os eventos `TenantOffboarded` (com `offboardingEndsAt?`) e `TenantDeactivated` existem no catálogo (events.md §4); a US-099 só os deixou sem rota. Pessoa de teste: "Rui" (operador); tenant: "Prefeitura Exemplo".

## Objetivo
Executar qualquer mudança de situação do tenant em até 3 cliques e 1 confirmação, com 0 transição inválida chegando ao banco, efeito em todas as instâncias em até 60 s (p95), 100% das mudanças com motivo, auditoria `actorType = PLATFORM_OPERATOR` e evento correspondente, e 0 dado de negócio do tenant exposto ao operador durante o processo.

## Persona
- **Principal:** Operador da plataforma — Sucesso do Cliente/Implantação (Rui; `PLATFORM_TENANT_MANAGE`, MFA).
- **Secundárias:** Administrador do órgão (`ADMIN_ORGAO`) — sente o efeito (suspensão, somente leitura no encerramento) e vê a ação do operador na auditoria do tenant depois da reativação; Auditor (`AUDITOR`) — mantém leitura e exportação durante o encerramento; usuários do tenant — recebem `TENANT_SUSPENDED` quando a instituição está fora de `ACTIVE`.

## Pré-condições
- US-178 concluída (área `/plataforma`, sessão do operador, lista e detalhe) e US-099 (operações e máquina de estados).
- Operador com `PLATFORM_TENANT_MANAGE` e sessão com MFA; tenant existente.
- `TenantStatusCache` e a base `TenantJob` ativos (US-100), para o efeito em até 60 s e para os jobs `skipped`.
- Para ativar a partir de `PROVISIONING`: checklist completo (RN-TEN-06) e, para o convite, fila de e-mail e `IdentityFacade` (US-091/US-112).

## Fluxo principal
1. No detalhe da instituição (SCR-123), o operador vê o painel **"Ciclo de vida"** com a situação atual e desde quando, o motivo da suspensão ou do encerramento (visível só a ele), a data de fim do prazo de encerramento (quando há) e os botões das ações permitidas, fornecidos por `PLT-14`.
2. O operador escolhe a ação (por exemplo, "Suspender"). A tela abre o **diálogo de confirmação** com o impacto em texto ("Os usuários perdem o acesso em até 60 segundos. Os prazos das etapas continuam correndo.") e os campos exigidos pela ação (motivo, data, confirmação do identificador).
3. Ao confirmar, a tela envia a operação (`PLT-04`, `PLT-05`, `PLT-06` ou `PLT-07`) com `If-Match` igual ao `ETag` do detalhe aberto e fica bloqueada até a resposta.
4. A API valida operador, MFA, permissão, corpo e transição; em **uma única transação** na conexão de plataforma (`SystemDbService`, `reason = TENANT_LIFECYCLE`) atualiza `tenants` (situação, datas, motivo, `version`), grava a auditoria no tenant (`actorType = PLATFORM_OPERATOR`) e o evento no outbox.
5. Após o commit, a API invalida o `TenantStatusCache` e responde `200` com o tenant e o novo `ETag`; na ativação a partir de `PROVISIONING`, enfileira o convite do primeiro administrador.
6. A tela atualiza o painel, mostra o aviso do efeito ("Suspensa. O acesso dos usuários é bloqueado em até 60 segundos.") e recarrega o histórico (`PLT-13`).
7. Nos tenants, em até 60 s, as requisições dos usuários passam a seguir a matriz da DEC-132: o BFF limpa a instituição ativa da sessão no primeiro `403 TENANT_SUSPENDED` e leva a pessoa à seleção de instituição ou à SCR-111 ("O acesso a esta instituição está indisponível no momento. Procure o administrador."), sem exibir o motivo.
8. O operador comunica a mudança ao administrador pelo canal contratual (fora do sistema); a tela lembra disso em cada confirmação (RN-PLAT-136).

## Fluxos alternativos
- **FA-01 — Ativar a partir de `PROVISIONING`:** `PLT-04` só vale com o checklist completo; com etapas pendentes, `409 INVALID_STATE` lista as etapas e a tela leva ao acompanhamento da US-178 (retomada). Com o checklist completo, ativa, grava `activatedAt`, envia o convite (FA-07) e registra `TenantActivated`.
- **FA-02 — Reativar tenant suspenso:** `PLT-04` sobre `SUSPENDED` volta a `ACTIVE`, preservando `activatedAt`, limpando `suspendedAt` e `suspensionReason` (o motivo continua na auditoria); o job `deadlines` processa os atrasos acumulados.
- **FA-03 — Encerrar:** `PLT-06` sobre `ACTIVE` ou `SUSPENDED` com motivo e data de fim da retenção; passa a `OFFBOARDING`, com `offboardingStartedAt = agora`; usuários comuns recebem `TENANT_SUSPENDED`, `ADMIN_ORGAO` e `AUDITOR` seguem em leitura e exportação.
- **FA-04 — Reverter o encerramento:** `PLT-04` sobre `OFFBOARDING` volta a `ACTIVE` e limpa `offboardingStartedAt` e `offboardingEndsAt` (preservados na auditoria).
- **FA-05 — Desativar:** `PLT-07` sobre `OFFBOARDING` (ou `PROVISIONING`, para descartar um provisionamento abandonado), com motivo e o identificador digitado; `DEACTIVATED` é final. Antes da data de fim da retenção, a tela exige a ciência adicional "O prazo de retenção ainda não terminou" (`acknowledgeEarly`).
- **FA-06 — Ação indisponível na situação atual:** o botão aparece desabilitado com o motivo ("Só é possível desativar uma instituição em encerramento"); a API recusa qualquer tentativa direta com `409 INVALID_STATE`.
- **FA-07 — Convite não enviado na ativação:** com a fila de e-mail ou o Authentik fora do ar, a instituição fica `ACTIVE` com `invitationDispatched = false`; a tela mostra "Convite não enviado" e oferece "Reenviar convite" (`PLT-12`, US-178).
- **FA-08 — Alteração por outro operador:** `If-Match` desatualizado → `412 VERSION_CONFLICT`; a tela recarrega o detalhe, mostra a situação atual e pede que a ação seja decidida de novo.
- **FA-09 — Prazo de encerramento vencido:** `offboardingEndsAt` no passado com a instituição ainda em `OFFBOARDING` → indicador "Prazo vencido há {n} dias" no painel e na lista (filtro `offboardingOverdue`); nada muda sozinho (RN-PLAT-127).
- **FA-10 — Não é operador, sem permissão ou sem MFA:** como na US-178 (404 no web; `403 PERMISSION_DENIED` ou `403 MFA_REQUIRED` na API). Ações de ciclo de vida exigem `PLATFORM_TENANT_MANAGE`; quem só tem `PLATFORM_HEALTH_VIEW` não vê o painel.
- **FA-11 — Usuário com vínculo em mais de uma instituição:** quando uma é suspensa, o BFF limpa só a instituição ativa; a pessoa troca para outra com vínculo `ACTIVE` sem novo login (US-093).

## Regras de negócio
- **RN-PLAT-120** — Transições (cita RN-TEN-09, sem redefinir): `PROVISIONING` → ativar, desativar; `ACTIVE` → suspender, encerrar; `SUSPENDED` → ativar, encerrar; `OFFBOARDING` → ativar (reverter), desativar; `DEACTIVATED` → nenhuma. Não há `SUSPENDED → DEACTIVATED` direto (passa por `OFFBOARDING`). Qualquer outra → `409 INVALID_STATE` com `fromStatus` e a ação pedida.
- **RN-PLAT-121** — Ações disponíveis: `PLT-14` devolve, por situação e versão, cada ação (`ACTIVATE`, `SUSPEND`, `OFFBOARD`, `DEACTIVATE`) com `allowed`, o motivo do bloqueio (`INVALID_STATE`, `CHECKLIST_PENDING` com as etapas pendentes) e os campos exigidos (`reason`, `offboardingEndsAt`, `confirmSlug`, `acknowledgeEarly`). A UI só reflete essa resposta; a API **revalida** tudo na execução (a tela não é fonte de verdade).
- **RN-PLAT-122** — Confirmação e motivo por ação: **ativar/reativar/reverter** — confirmação simples com o impacto; **suspender** — motivo (10–1.000 caracteres) e confirmação; **encerrar** — motivo (10–1.000), data de fim da retenção e confirmação; **desativar** — motivo (10–1.000), digitar o identificador da instituição (`confirmSlug`, igualdade exata) e marcar "Entendo que esta ação é definitiva". O botão de confirmar só habilita com tudo preenchido; a validação final é da API.
- **RN-PLAT-123** — Concorrência: toda operação (`PLT-04..07`) exige `If-Match` com a versão do detalhe aberto; ausente → `428 PRECONDITION_REQUIRED`; divergente → `412 VERSION_CONFLICT`. A versão sobe a cada mudança de situação e o `ETag` da resposta substitui o da tela.
- **RN-PLAT-124** — Suspensão (detalha RN-TEN-11): grava `suspendedAt` e `suspensionReason`; a partir da invalidação do cache (≤ 60 s em todas as instâncias; TTL de 30 s como rede de segurança) toda requisição de usuário do tenant recebe `403 TENANT_SUSPENDED`; **sessões não são destruídas**; o BFF limpa a instituição ativa no primeiro `403`; jobs de tenant terminam `skipped` (RN-TEN-12) e os prazos de etapas **não** são pausados; `audit-seal`, `maintenance` e o relay do outbox continuam.
- **RN-PLAT-125** — Reativação e reversão: `ACTIVE` preserva o `activatedAt` original; `SUSPENDED → ACTIVE` limpa `suspendedAt` e `suspensionReason`; `OFFBOARDING → ACTIVE` limpa `offboardingStartedAt` e `offboardingEndsAt`; em ambos o motivo e as datas anteriores permanecem na auditoria. Nenhum convite é reenviado numa reativação.
- **RN-PLAT-126** — Encerramento: `offboardingEndsAt` é uma **data** (fim do dia no fuso do tenant) estritamente futura (`DATE_IN_PAST`) e no máximo 365 dias à frente (`OUT_OF_RANGE`; faixa proposta — lacuna 6), com sugestão padrão de 90 dias na tela (multi-tenancy.md §13.3); grava `offboardingStartedAt = agora` e `offboardingEndsAt`. Efeito: matriz de `OFFBOARDING` da DEC-132 — leitura e exportação para vínculos `ADMIN_ORGAO`/`AUDITOR`, comandos bloqueados, faixa "Instituição em encerramento: somente leitura e exportação" na UI do tenant. **Não** encerra a sessão de quem ainda pode ler (lacuna 5); quem não pode recebe `403 TENANT_SUSPENDED`.
- **RN-PLAT-127** — Fim da retenção: ao chegar `offboardingEndsAt` o sistema **não muda a situação nem o acesso**; apenas marca `offboardingOverdue = true` (derivado em `PLT-02`, `PLT-03` e `PLT-14`) para o operador decidir. Desativar e expurgar continuam decisões humanas (expurgo físico fora do produto: PEND-07). Ajustar ou prorrogar a data **não** é coberto (lacuna 6).
- **RN-PLAT-128** — Desativação (RN-TEN-13): só de `OFFBOARDING` ou `PROVISIONING`; exige `confirmSlug` igual ao slug (`VALIDATION_ERROR`, `CONFIRMATION_MISMATCH`); se `offboardingEndsAt` ainda não passou, exige `acknowledgeEarly = true` (`CONDITIONAL_REQUIRED`); grava `deactivatedAt`; `DEACTIVATED` é final; **nenhum dado é excluído** (vínculos, documentos e auditoria permanecem) e o slug continua reservado para sempre (RN-TEN-02). Efeito: todas as requisições de usuários recebem `403 TENANT_SUSPENDED` e integrações do tenant são desligadas; concessões de suporte `ACTIVE` são encerradas (RN-PLAT-139).
- **RN-PLAT-129** — Ativação a partir de `PROVISIONING`: reexecuta `verify()` de cada etapa; qualquer etapa pendente → `409 INVALID_STATE` com `details.pendingSteps[]`. Com tudo `DONE`, ativa, grava `activatedAt` e, **após o commit**, envia o convite do primeiro administrador (RN-TEN-08); falha no envio não desfaz a ativação.
- **RN-PLAT-130** — Atomicidade: situação, auditoria e outbox na **mesma transação**; falha de qualquer parte (banco, gravação da auditoria) desfaz tudo e responde `503 DEPENDENCY_UNAVAILABLE` sem mudar nada. O `TenantStatusCache` é invalidado **depois** do commit; se o Redis falhar, a mudança continua valendo, a API lê a situação direto do banco (`warn tenant.status_cache_unavailable`) e o evento segue o outbox.
- **RN-PLAT-131** — Repetição e duplo clique: não há `Idempotency-Key` nas operações de ciclo de vida (contrato PLT-04..07). Repetir a mesma ação com a versão nova → `409 INVALID_STATE` (já está na situação pedida); com a versão antiga → `412 VERSION_CONFLICT`. Em nenhum caso duplica auditoria nem evento (a transição acontece uma vez por versão).
- **RN-PLAT-132** — Eventos e auditoria (RN-PLAT-03, RN-PLAT-06): `TenantActivated` (ativação, reativação e reversão), `TenantSuspended`, `TenantOffboarded` (com `offboardingEndsAt`) e `TenantDeactivated`; auditoria `tenant.activate`, `tenant.suspend` e `tenant.deactivate` (esta com `metadata.toStatus` = `OFFBOARDING` ou `DEACTIVATED`, como na US-099), sempre `actorType = PLATFORM_OPERATOR`, **no tenant**, com `metadata.channel = BACKOFFICE`, `fromStatus`, `toStatus` e o motivo.
- **RN-PLAT-133** — Histórico (`PLT-13`): mudanças de situação do tenant em ordem decrescente (provisionamento, ativação, suspensão, reativação, encerramento, reversão, desativação), cada uma com data, operador (nome e id — pessoal da plataforma, não do tenant), `fromStatus`, `toStatus`, canal (`CLI`, `API`, `BACKOFFICE`) e motivo; lido da auditoria do tenant com `actorType = PLATFORM_OPERATOR` pela política de `cf_platform`; paginado (25 por página).
- **RN-PLAT-134** — Sigilo do motivo: o texto do motivo é de uso interno da plataforma — nunca vai para `/me`, para o BFF, para a SCR-111 nem para logs (só `hasReason`); na auditoria exibida ao administrador do tenant, a visão omite `metadata.reason` das ações `tenant.suspend` e `tenant.deactivate` (lacuna 4). O operador vê o motivo em `PLT-03` e `PLT-13`.
- **RN-PLAT-135** — Efeito em até 60 s e matriz de acesso: a mudança vale em todas as instâncias em até 60 s (invalidação direta + TTL de 30 s); a matriz de acesso por situação é a da DEC-132 e a verificação do vínculo vem **antes** da situação (RN-TEN-20), de modo que quem não tem vínculo nunca descobre a situação do tenant.
- **RN-PLAT-136** — Sem notificação do sistema: a plataforma não envia e-mail nem notificação aos usuários na suspensão ou no encerramento (a comunicação contratual ocorre fora do produto — US-099); cada diálogo lembra o operador: "Avise o administrador da instituição pelo canal combinado em contrato."
- **RN-PLAT-137** — O ciclo de vida nunca dá acesso a dados: suspender, encerrar ou desativar **não** cria vínculo para o operador (RN-TEN-14, DEC-139) e a tela não oferece exportar nem visualizar dados; a exportação do encerramento é do administrador do tenant, pela UI dele. Resposta de `PLT-13`/`PLT-14` segue a allowlist da US-178 (RN-PLAT-105).
- **RN-PLAT-138** — Jobs: a base `TenantJob` aplica RN-TEN-12 sem código novo; esta story só adiciona o teste de que, em `SUSPENDED` e `DEACTIVATED`, `deadlines` e `notifications` terminam `skipped`, e em `OFFBOARDING` o `document-render` continua (exportação de PDFs).
- **RN-PLAT-139** — Acesso de suporte (US-180): ao **desativar**, as concessões `ACTIVE` do tenant são encerradas pelo sistema (`SupportAccessEnded`, `endedById` nulo, motivo `TENANT_DEACTIVATED`); ao **suspender**, a concessão continua registrada mas o vínculo `EXTERNAL` fica sem efeito enquanto a instituição estiver fora de `ACTIVE` (`403 TENANT_SUSPENDED`), expirando no prazo normal (lacuna 7).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Situação | `status` | `TenantStatus` | — | somente leitura | sistema |
| Versão | `version` / `ETag` | inteiro | — | enviada em `If-Match` | sistema |
| Motivo | `reason` | texto | Sim em suspender, encerrar e desativar | 10–1.000 (RN-TEN-11/13) | — |
| Fim da retenção | `offboardingEndsAt` | data | Sim em encerrar | futura, ≤ 365 dias (RN-PLAT-126) | hoje + 90 dias (sugestão) |
| Confirmação do identificador | `confirmSlug` | texto | Sim em desativar | igual ao slug (RN-PLAT-128) | — |
| Ciência de desativação antecipada | `acknowledgeEarly` | booleano | Condicional | obrigatório se `offboardingEndsAt` > hoje | `false` |
| Ações disponíveis | `actions[]` (`action`, `allowed`, `blockedReason?`, `requires[]`, `pendingSteps?`) | lista | — | RN-PLAT-121 | `PLT-14` |
| Prazo vencido | `offboardingOverdue` | booleano | — | RN-PLAT-127 | calculado |
| Datas | `activatedAt`, `suspendedAt`, `offboardingStartedAt`, `offboardingEndsAt`, `deactivatedAt` | data/hora | — | RN-PLAT-124..128 | sistema |
| Histórico | `entries[]` (`occurredAt`, `operator`, `action`, `fromStatus`, `toStatus`, `channel`, `reason`) | lista | — | RN-PLAT-133 | `PLT-13` |
| Filtro de lista | `offboardingOverdue` | booleano | Não | só `OFFBOARDING` | `false` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Motivo ausente ou com menos de 10 caracteres | Front + API (Zod) | "Informe o motivo (mín. 10 caracteres)." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`) |
| V-02 | Motivo com mais de 1.000 caracteres | Front + API | "O motivo pode ter até 1.000 caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-03 | Data de fim da retenção ausente, passada ou além de 365 dias | Front + API | "Informe uma data futura de até 365 dias." | `VALIDATION_ERROR` (`REQUIRED`/`DATE_IN_PAST`/`OUT_OF_RANGE`) |
| V-04 | Identificador digitado diferente do da instituição | Front + API | "A confirmação não corresponde ao identificador." | `VALIDATION_ERROR` (`CONFIRMATION_MISMATCH`) |
| V-05 | Desativar antes do fim da retenção sem a ciência | Front + API | "Confirme que deseja desativar antes do fim do prazo de retenção." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-06 | Transição não permitida na situação atual | API | "Não é possível {ação}: a instituição está {situação}." | `INVALID_STATE` |
| V-07 | Ativar com etapas de provisionamento pendentes | API | "Há etapas pendentes no provisionamento." | `INVALID_STATE` (`details.pendingSteps`) |
| V-08 | `If-Match` ausente | API | "Recarregue a instituição e tente novamente." | `PRECONDITION_REQUIRED` |
| V-09 | `If-Match` divergente | API | "A instituição foi alterada por outra pessoa. Recarregue." | `VERSION_CONFLICT` |
| V-10 | Não é operador, sem `PLATFORM_TENANT_MANAGE` ou sem MFA | API | "Acesso restrito a operadores da plataforma." / "Confirme sua identidade com o segundo fator." | `PERMISSION_DENIED` / `MFA_REQUIRED` |
| V-11 | Instituição inexistente | API | "Instituição não encontrada." | `TENANT_NOT_FOUND` |
| V-12 | Filtro, `page` ou `pageSize` inválidos | Front + API | "Filtro inválido." | `VALIDATION_ERROR` (`INVALID_ENUM`/`OUT_OF_RANGE`) |

## Permissões
- **Permissão:** `PLATFORM_TENANT_MANAGE` (permissions.md §8) para `PLT-02`, `PLT-03`, `PLT-04`, `PLT-05`, `PLT-06`, `PLT-07`, `PLT-13` e `PLT-14`; vem da *claim* `cf_platform_permissions` e não faz parte de perfis de tenant.
- **Políticas:** POL-29 (operador + MFA sempre + permissão da rota; sem dado de processo ou documento); DEC-139 (o operador não ganha vínculo); DEC-132 (matriz de acesso por situação).
- **MFA:** sempre, em toda rota do backoffice (US-178, RN-PLAT-101).
- **Sem permissão:** não operador → 404 no web e `403 PERMISSION_DENIED` na API (`access.denied` de plataforma); operador sem a permissão → `403 PERMISSION_DENIED`; sem MFA → `403 MFA_REQUIRED`. `ADMIN_ORGAO` e demais usuários do tenant, inclusive do próprio tenant afetado, nunca executam estas operações.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TenantActivated` | `tenant.activated` | Ativação, reativação e reversão do encerramento | Invalida o cache de status; payload acrescido de `fromStatus` e `channel` (lacuna 8) |
| `TenantSuspended` | `tenant.suspended` | Suspensão | Invalida o cache de status |
| `TenantOffboarded` | `tenant.offboarded` | Encerramento | `tenantId`, `offboardingEndsAt` |
| `TenantDeactivated` | `tenant.deactivated` | Desativação | `tenantId`; evento final do tenant |

Os eventos `Tenant*` não têm consumidor assíncrono obrigatório: o caso de uso remove o status do cache logo após o commit (DEC-078). `SupportAccessEnded` (RN-PLAT-139) pertence à US-180.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| E-mail de convite (US-091/US-112) | Primeiro administrador | E-mail | Só na ativação a partir de `PROVISIONING` (depois do commit) |
| — | Usuários do tenant e administradores | — | Nenhuma: suspensão e encerramento não geram notificação; a interface do tenant exibe a SCR-111 e a faixa de encerramento (RN-PLAT-136) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Ciclo de vida do tenant no backoffice

  Background:
    Given que "Rui" é operador da plataforma com "PLATFORM_TENANT_MANAGE" e MFA ativo
    And o tenant "Prefeitura Exemplo" (slug "prefeitura-exemplo") está "ACTIVE" com versão 3
    And "Paula" é "ADMIN_ORGAO", "Sérgio" é "AUDITOR" e "Cláudia" é "REQUISITANTE" nesse tenant
    And a data atual no fuso "America/Sao_Paulo" é 11/11/2026

  Scenario: [Sucesso] Suspender e reativar
    When "Rui" suspender o tenant com If-Match "3" e motivo "Contrato com pagamento em atraso"
    Then a API deve responder 200 com status "SUSPENDED" e versão 4
    And deve ser gerado o evento "TenantSuspended" e a auditoria "tenant.suspend" com actorType "PLATFORM_OPERATOR" e channel "BACKOFFICE"
    And em até 60 segundos as requisições de "Cláudia" devem receber 403 "TENANT_SUSPENDED" sem exibir o motivo
    And a sessão de "Cláudia" não deve ser destruída e o BFF deve limpar a instituição ativa
    When "Rui" ativar o tenant com If-Match "4"
    Then o status deve voltar a "ACTIVE" preservando o "activatedAt" original e limpando "suspendedAt" e o motivo
    And deve ser gerado o evento "TenantActivated" e nenhum convite deve ser reenviado

  Scenario: [Sucesso] Suspensão não pausa prazos nem para os jobs essenciais
    Given que o tenant "prefeitura-exemplo" está "SUSPENDED"
    Then os jobs "deadlines" e "notifications" do tenant devem terminar sem efeito
    And os jobs "audit-seal" e "maintenance" devem continuar executando
    And ao reativar o tenant o job "deadlines" deve processar os atrasos acumulados

  Scenario: [Sucesso] Encerrar com data de fim da retenção
    When "Rui" encerrar o tenant com If-Match "3", motivo "Fim do contrato em 31/12/2026" e fim da retenção em "10/02/2027"
    Then a API deve responder 200 com status "OFFBOARDING", "offboardingStartedAt" de hoje e "offboardingEndsAt" em 10/02/2027
    And deve ser gerado o evento "TenantOffboarded" com "offboardingEndsAt" e a auditoria "tenant.deactivate" com toStatus "OFFBOARDING"

  Scenario: [Sucesso] Encerramento permite somente leitura e exportação a ADMIN_ORGAO e AUDITOR
    Given que o tenant "prefeitura-exemplo" está "OFFBOARDING"
    When "Paula" baixar o PDF de um documento aprovado
    Then o download deve ser permitido e "Sérgio" deve conseguir consultar a auditoria
    When "Paula" tentar encaminhar um processo
    Then a API deve responder 403 com código "TENANT_SUSPENDED"
    And "Cláudia" deve receber 403 "TENANT_SUSPENDED" em qualquer rota

  Scenario: [Sucesso] Reverter o encerramento
    Given que o tenant "prefeitura-exemplo" está "OFFBOARDING" com versão 5
    When "Rui" ativar o tenant com If-Match "5"
    Then o status deve ser "ACTIVE" com "offboardingStartedAt" e "offboardingEndsAt" nulos
    And a auditoria deve preservar a data de fim da retenção anterior

  Scenario: [Sucesso] Desativar após o fim da retenção
    Given que o tenant "prefeitura-exemplo" está "OFFBOARDING" com fim da retenção em 10/02/2027 e a data atual é 11/02/2027
    When "Rui" desativar o tenant com motivo "Retenção encerrada e dados entregues" e confirmSlug "prefeitura-exemplo"
    Then a API deve responder 200 com status "DEACTIVATED" e "deactivatedAt" preenchido
    And deve ser gerado o evento "TenantDeactivated" e a auditoria "tenant.deactivate" com toStatus "DEACTIVATED"
    And nenhum dado do tenant deve ser excluído e o slug "prefeitura-exemplo" deve continuar reservado

  Scenario: [Sucesso] Ativar um provisionamento completo mantido em PROVISIONING
    Given que o tenant "prefeitura-nova" está "PROVISIONING" com todas as etapas "DONE"
    When "Rui" ativar o tenant "prefeitura-nova" com o If-Match atual
    Then o status deve ser "ACTIVE" com "activatedAt" preenchido e o evento "TenantActivated" gerado
    And o e-mail de convite do primeiro administrador deve ser enfileirado somente após o commit

  Scenario: [Sucesso] Ver as ações disponíveis e o histórico
    When "Rui" abrir o painel "Ciclo de vida" de um tenant "SUSPENDED"
    Then "PLT-14" deve marcar "ACTIVATE" e "OFFBOARD" como permitidas e "SUSPEND" e "DEACTIVATE" como bloqueadas por "INVALID_STATE"
    And "PLT-13" deve listar as mudanças em ordem decrescente com operador, situação anterior, situação nova, canal e motivo

  Scenario: [Sucesso] Indicar o prazo de encerramento vencido
    Given que o tenant "prefeitura-exemplo" está "OFFBOARDING" com fim da retenção em 10/02/2027 e a data atual é 20/02/2027
    When "Rui" abrir a lista filtrando "offboardingOverdue"
    Then o tenant deve aparecer com "offboardingOverdue" verdadeiro e o texto "Prazo vencido há 10 dias"
    And a situação e o acesso do tenant não devem ter mudado

  Scenario: [Validação] Suspensão sem motivo ou com motivo curto
    When "Rui" suspender o tenant sem motivo
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REQUIRED" no campo "reason"
    When "Rui" suspender o tenant com o motivo "atraso"
    Then a API deve responder 422 com erro "TOO_SHORT" no campo "reason"

  Scenario: [Validação] Data de fim da retenção inválida
    When "Rui" encerrar o tenant com fim da retenção em "10/11/2026"
    Then a API deve responder 422 com erro "DATE_IN_PAST" no campo "offboardingEndsAt"
    When "Rui" encerrar o tenant com fim da retenção em "11/11/2028"
    Then a API deve responder 422 com erro "OUT_OF_RANGE" no campo "offboardingEndsAt"

  Scenario: [Validação] Confirmação do identificador e ciência de desativação antecipada
    Given que o tenant "prefeitura-exemplo" está "OFFBOARDING" com fim da retenção em 10/02/2027
    When "Rui" desativar o tenant com confirmSlug "prefeitura"
    Then a API deve responder 422 com erro "CONFIRMATION_MISMATCH" no campo "confirmSlug"
    When "Rui" desativar o tenant com confirmSlug "prefeitura-exemplo" sem "acknowledgeEarly"
    Then a API deve responder 422 com erro "CONDITIONAL_REQUIRED" no campo "acknowledgeEarly"

  Scenario: [Validação] Transição não permitida e ativação com etapas pendentes
    When "Rui" desativar o tenant "ACTIVE"
    Then a API deve responder 409 com código "INVALID_STATE"
    Given que o tenant "prefeitura-nova" está "PROVISIONING" com a etapa "document.templateLibrary" pendente
    When "Rui" ativar o tenant "prefeitura-nova"
    Then a API deve responder 409 com código "INVALID_STATE" e "pendingSteps" com "document.templateLibrary"

  Scenario: [Permissão] Administrador do tenant tenta suspender o próprio tenant
    When "Paula" enviar POST "/api/v1/platform/tenants/{id}/suspend" do tenant "prefeitura-exemplo"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve existir auditoria de plataforma "access.denied" com reasonCode "PLATFORM_TENANT_MANAGE"
    And o tenant deve continuar "ACTIVE"

  Scenario: [Permissão] Operador sem segundo fator ou sem a permissão
    Given que "Rui" se autenticou sem segundo fator
    When "Rui" suspender o tenant
    Then a API deve responder 403 com código "MFA_REQUIRED" e o tenant deve continuar "ACTIVE"
    Given que "Rui" tem só "PLATFORM_HEALTH_VIEW"
    When "Rui" suspender o tenant
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Suspender um tenant não afeta outro
    Given que o tenant "Prefeitura Vizinha" está "ACTIVE" e "Marcos" tem vínculo "ACTIVE" nos dois tenants
    When "Rui" suspender "prefeitura-exemplo"
    Then "Marcos" deve receber 403 "TENANT_SUSPENDED" em "prefeitura-exemplo" e acesso normal em "Prefeitura Vizinha"
    And nenhuma linha, cache de status ou auditoria de "Prefeitura Vizinha" deve ter sido alterada

  Scenario: [Tenant incorreto] Instituição inexistente e ausência de dados do tenant
    When "Rui" enviar a suspensão de um id de tenant que não existe
    Then a API deve responder 404 com código "TENANT_NOT_FOUND"
    And as respostas de "PLT-13" e "PLT-14" não devem conter processo, documento, comentário ou nome de usuário do tenant

  Scenario: [Duplicidade] Repetir a mesma suspensão
    Given que "Rui" suspendeu o tenant e a versão passou de 3 para 4
    When "Rui" repetir a suspensão com If-Match "4"
    Then a API deve responder 409 com código "INVALID_STATE"
    And deve existir uma única auditoria "tenant.suspend" e um único evento "TenantSuspended" para a versão 4

  Scenario: [Duplicidade] Duplo clique em "Suspender"
    When a tela enviar duas vezes a suspensão com If-Match "3"
    Then uma requisição deve receber 200 e a outra 412 com código "VERSION_CONFLICT"
    And deve existir uma única auditoria e um único evento

  Scenario: [Concorrência] Dois operadores agem sobre a mesma versão
    Given que "Rui" e "Caio" abriram o detalhe do tenant com versão 3
    When "Rui" suspender com If-Match "3" e depois "Caio" encerrar com If-Match "3"
    Then "Caio" deve receber 412 com código "VERSION_CONFLICT"
    And a tela de "Caio" deve recarregar o detalhe e mostrar a situação "SUSPENDED"

  Scenario: [Concorrência] Operação sem If-Match
    When "Rui" suspender o tenant sem o cabeçalho "If-Match"
    Then a API deve responder 428 com código "PRECONDITION_REQUIRED" e o tenant deve continuar "ACTIVE"

  Scenario: [Concorrência] Requisição de usuário em andamento durante a suspensão
    Given que "Cláudia" está com uma requisição em andamento quando "Rui" suspende o tenant
    Then a requisição já iniciada pode terminar e as seguintes devem receber 403 "TENANT_SUSPENDED" em até 60 segundos
    And nenhum dado deve ficar parcialmente gravado

  Scenario: [Falha de banco] Banco indisponível ao suspender
    Given que o banco de dados falha durante a transação de suspensão
    When "Rui" suspender o tenant com If-Match "3"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o status, a auditoria e o outbox do tenant não devem ter sido alterados
    When "Rui" repetir a suspensão com o banco disponível e o mesmo If-Match
    Then a API deve responder 200 com status "SUSPENDED"

  Scenario: [Falha de banco] Banco indisponível ao carregar o painel
    Given que o banco de dados está indisponível
    When "Rui" abrir o painel "Ciclo de vida"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a tela deve oferecer "Tentar novamente" e não deve oferecer nenhuma ação

  Scenario: [Falha de integração] Redis do cache de status indisponível
    Given que o Redis do cache de status está indisponível
    When "Rui" suspender o tenant com If-Match "3"
    Then a API deve responder 200 com status "SUSPENDED" e deve ser registrado o aviso "tenant.status_cache_unavailable"
    And as requisições de "Cláudia" devem receber 403 "TENANT_SUSPENDED" lendo a situação direto do banco

  Scenario: [Falha de integração] Fila de e-mail indisponível na ativação
    Given que o tenant "prefeitura-nova" está "PROVISIONING" com todas as etapas "DONE" e a fila "email" está indisponível
    When "Rui" ativar o tenant
    Then o tenant deve ficar "ACTIVE" e a resposta deve indicar "invitationDispatched" falso
    And a tela deve oferecer "Reenviar convite"

  Scenario: [Falha de integração] Broker de eventos indisponível
    Given que o broker de mensageria está indisponível
    When "Rui" encerrar o tenant com motivo e data válidos
    Then a API deve responder 200 com status "OFFBOARDING"
    And o evento "TenantOffboarded" deve permanecer no outbox e ser publicado quando o broker voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Motivo, data ou confirmação inválidos | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Erro no campo do diálogo |
| Transição não permitida | 409 | `INVALID_STATE` | "Não é possível {ação}: a instituição está {situação}." | Recarrega o painel e desabilita a ação |
| Ativar com etapas pendentes | 409 | `INVALID_STATE` | "Há etapas pendentes no provisionamento." | Lista as etapas e leva ao acompanhamento |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a instituição e tente novamente." | Recarrega o detalhe |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "A instituição foi alterada por outra pessoa. Recarregue." | Recarrega, mostra a situação atual e fecha o diálogo |
| Não é operador ou sem a permissão | 403 | `PERMISSION_DENIED` | "Acesso restrito a operadores da plataforma." | Página "não encontrada" (web) |
| Sessão sem segundo fator | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator." | *Step-up* e retorno ao painel |
| Instituição inexistente | 404 | `TENANT_NOT_FOUND` | "Instituição não encontrada." | Volta à lista |
| Excesso de chamadas | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns instantes." | Reabilita após `Retry-After` |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Nada foi alterado." | "Tentar novamente"; o diálogo mantém os campos |
| Usuário em tenant fora de `ACTIVE` (efeito, não erro da operação) | 403 | `TENANT_SUSPENDED` | "O acesso a esta instituição está indisponível no momento. Procure o administrador." | SCR-111; oferece trocar de instituição |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Erro inesperado. Código: {correlationId}." | Exibe o `correlationId` copiável |

## Dependências
- **Stories:** US-178 (área, sessão do operador, lista e detalhe, `PLT-12`), US-099 (operações PLT-04..07, máquina de estados, matriz DEC-132, jobs). Indiretas: US-100 (`TenantStatusCache`, `TenantJob`, `SystemDbService`), US-073 (auditoria), US-082 (outbox), US-091/US-112 (convite na ativação), US-093 (troca de instituição), US-086 (SCR-111), US-180 (concessões de suporte afetadas pela desativação).
- **Decisões/ADRs:** DEC-208, DEC-078, DEC-132, DEC-139, DEC-076, DEC-034, DEC-105; ADR-002; POL-29; PEND-07; DT-07.
- **Configurações:** nenhuma chave de tenant nova; prazo sugerido de encerramento de 90 dias e teto de 365 dias como constantes da plataforma (lacuna 6).
- **Lacunas nas fontes canônicas:**
  1. `PLT-13` (`GET /platform/tenants/{id}/status-history`) e `PLT-14` (`GET /platform/tenants/{id}/lifecycle`) são novos. `PLT-06` ganha `offboardingEndsAt` (a API do MVP 1 só previa `reason` e marcava o contrato como lacuna da US-099); `PLT-07` ganha `confirmSlug` e `acknowledgeEarly`; `PLT-02` ganha `offboardingOverdue`; `PLT-03` e `PLT-14` expõem `offboardingOverdue`. Todos entram no `api.md` do MVP 2.
  2. O `api.md` do MVP 1 diz que a confirmação do identificador "não se aplica à chamada HTTP" (`PLT-07`); o backoffice precisa dela (RN-TEN-13), então a rota passa a exigir `confirmSlug`. A CLI mantém `--confirm-slug`. Novo detalhe de erro `CONFIRMATION_MISMATCH` no catálogo de `VALIDATION_ERROR` (api.md §2.1.1).
  3. A US-099 usa a mesma ação de auditoria `tenant.deactivate` para encerrar e desativar (distinguidas por `metadata.toStatus`); mantido. Proposta alternativa: `tenant.offboard` separada, para o filtro da auditoria do tenant — decisão de quem fecha o `events.md`.
  4. Motivo × visibilidade: `RN-TEN-11` diz que o motivo da suspensão nunca é exibido aos usuários do tenant, mas a auditoria `tenant.suspend` guarda o motivo em `metadata` e é visível ao administrador (`AUDIT_VIEW`) depois da reativação. Adotado: a visão de auditoria do tenant omite `metadata.reason` dessas ações (ajuste na tela de auditoria, US-074/US-073); o texto completo fica só para operadores.
  5. Sessões: events.md §4 marca `TenantOffboarded`/`TenantDeactivated` com "encerramento de sessões" e a API do MVP 1 diz que o encerramento "encerra sessões", mas a DEC-078 diz que os eventos `Tenant*` não têm consumidor assíncrono e a DEC-132 exige leitura para `ADMIN_ORGAO`/`AUDITOR` em `OFFBOARDING`. Adotado: nenhuma sessão é destruída ativamente; a recusa vem a cada requisição e o BFF limpa a instituição ativa no primeiro `403`. Ajustar events.md e a API.
  6. Faixa e consequência de `offboardingEndsAt`: o catálogo só diz "sugerido 90 dias" e que o campo é obrigatório em `OFFBOARDING`. Proposta: futura e até 365 dias; passada a data, **nada muda sozinho** (só `offboardingOverdue`); **não** há ação de prorrogar (workaround: reverter e encerrar de novo, o que reabre os comandos por instantes). Decisão de produto: acesso de leitura acaba na data? há ação "prorrogar"? Conferir também a restrição `status = 'OFFBOARDING'` ⇒ `offboarding_ends_at IS NOT NULL` no banco.
  7. `SupportAccessGrant` ativo × ciclo de vida: nem a DEC-139 nem a FT-083 dizem o que acontece com concessões quando o tenant é suspenso ou desativado. Adotado (RN-PLAT-139): desativar encerra as concessões `ACTIVE` pelo sistema; suspender mantém a concessão sem efeito. Confirmar na US-180.
  8. Payloads dos eventos: `TenantActivated` precisa de `fromStatus` (primeira ativação, reativação, reversão) e todos de `channel`; o catálogo traz só `tenantId` (e `offboardingEndsAt?`).
  9. Notificação: não há aviso do sistema ao administrador na suspensão ou no encerramento (mantido da US-099). Dúvida de produto: avisar `ADMIN_ORGAO` por e-mail quando começa o encerramento e `TenantOffboarded` indica o prazo?
  10. `PLT-08` (corrigir dados do tenant) continua fora da área: não consta no escopo da FT-083.

## Impacto técnico
- **Performance:** `PLT-04..07` p95 ≤ 500 ms (uma transação curta, sem leitura de dados de negócio); `PLT-14` ≤ 300 ms, e só `PROVISIONING` roda `verify()` por etapa; `PLT-13` ≤ 300 ms (índice da auditoria por tenant, ação e data); propagação do status em todas as instâncias ≤ 60 s (p95), validada no teste de matriz.
- **Segurança:** transição validada só no servidor; `If-Match` em toda mutação; motivo fora de logs e de respostas voltadas ao tenant; operador sem vínculo; confirmação digitada e ciência explícita nas ações irreversíveis; allowlist de saída (US-178).
- **Consistência:** situação, auditoria e outbox na mesma transação; cache invalidado depois do commit, com TTL como rede de segurança; sem duplicidade de evento em repetição.
- **Compatibilidade:** `PLT-04..07` mudam de forma aditiva (campos obrigatórios novos só em `PLT-06` e `PLT-07`, que no MVP 1 não tinham contrato publicado; a CLI continua válida); eventos ganham campos opcionais.
- **Risco operacional:** desativação é definitiva (sem volta no produto) — confirmação digitada, ciência de antecedência e histórico; suspensão por engano — reativação imediata e `If-Match` evita corrida entre operadores.

## Backend
- **Módulo(s):** `tenancy` (dono: máquina de estados, comandos, consultas), `identity` (operador, convite), `access` (permissão de plataforma), `audit`, `platform` (BFF: limpeza da instituição ativa no `403 TENANT_SUSPENDED`).
- **Casos de uso:** `ActivateTenantCommand`, `SuspendTenantCommand`, `OffboardTenantCommand`, `DeactivateTenantCommand` (os da US-099, agora com rotas e contratos completos), `GetTenantLifecycleQuery` (`PLT-14`), `ListTenantStatusHistoryQuery` (`PLT-13`).
- **Domínio:** agregado `Tenant` com a máquina de estados de RN-TEN-09 (`tenancy/domain/tenant.ts`), VO `OffboardingPeriod` (data futura, teto), `LifecycleActionPolicy` (ações permitidas e campos exigidos, usada por `PLT-14` e pelos comandos), `ProvisioningChecklistService`.
- **Integrações internas:** `SystemDbService` (`reason = TENANT_LIFECYCLE`; leitura de histórico por `PLATFORM_AUDIT`), `TenantStatusCache`, `AuditService` (gravação no tenant como `PLATFORM_OPERATOR`), `OutboxWriter`, `IdentityFacade.dispatchInvitation` (só na ativação de `PROVISIONING`), `SupportAccessPort` (US-180, encerra concessões na desativação).
- **Apresentação:** `PlatformTenantsController` (`PLT-04..07`, `PLT-13`, `PLT-14`), todas `@TenantScope('PLATFORM')`, com `PlatformOperatorGuard` + MFA e `PLATFORM_TENANT_MANAGE`; `If-Match` obrigatório nas mutações.
- **Transação:** mudança de situação + auditoria + outbox em uma transação na conexão de plataforma; invalidação do cache e envio do convite após o commit; nenhuma chamada externa dentro da transação.

## Frontend
- **Tela(s):** SCR-123 (`/plataforma/instituicoes/[tenantId]`, painel "Ciclo de vida" e aba "Histórico"; lista com filtro e indicador de prazo vencido).
- **Componentes:** `TenantLifecyclePanel`, `LifecycleActionButton` (desabilitado com motivo), `LifecycleConfirmDialog` (impacto, motivo, data, confirmação do identificador, ciência), `OffboardingDeadlineBadge`, `TenantStatusBadge` (texto e ícone), `TenantStatusHistory`, `ConcurrencyConflictNotice`.
- **Estados:** loading (skeleton), erro com "Tentar novamente", ação em andamento (botões e diálogo travados), sucesso com aviso do efeito, conflito de versão (recarrega), situação sem ações (`DEACTIVATED`: "Instituição desativada. Nenhuma ação disponível.").
- **Acessibilidade e responsividade:** diálogos com foco preso e retorno do foco ao botão de origem; o aviso de efeito em `aria-live="polite"`; situação por texto e ícone, não só cor; campo de confirmação do identificador com rótulo e instrução lidos por leitores de tela (colar é permitido); painel empilhado abaixo de 768 px.

## Banco de dados
- **Tabelas:** `tenants` (escrita por `cf_platform`: `status`, `suspendedAt`, `suspensionReason`, `offboardingStartedAt`, `offboardingEndsAt`, `deactivatedAt`, `activatedAt`, `version`); leitura de `audit_logs` do tenant (`actor_type = PLATFORM_OPERATOR`, política de `cf_platform`) para o histórico; `outbox_events` (agregado `Tenant`). Nenhuma tabela nova.
- **Migrações:** nenhuma de esquema; conferir (e, se faltar, acrescentar de forma aditiva) `CHECK (status <> 'OFFBOARDING' OR offboarding_ends_at IS NOT NULL)` e `CHECK (status <> 'DEACTIVATED' OR deactivated_at IS NOT NULL)`; índice `audit_logs (tenant_id, action, occurred_at DESC)` já usado pela auditoria.
- **Índices/constraints relevantes:** `CHECK (status <> 'SUSPENDED' OR suspension_reason IS NOT NULL)`; índice `tenants(status)`; `version` para `If-Match`; trigger `tenants_slug_immutable` (o slug não muda).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `PLT-14` | GET | `/api/v1/platform/tenants/{id}/lifecycle` | — | `200 { data: { status, version, offboardingEndsAt?, offboardingOverdue, actions[] { action, allowed, blockedReason?, requires[], pendingSteps[]? } } }` + `ETag` | 200, 403, 404, 503 |
| `PLT-04` | POST | `/api/v1/platform/tenants/{id}/activate` | `{}` + `If-Match` | `200 { data: Tenant }` + novo `ETag` | 200, 403, 404, 409, 412, 428, 503 |
| `PLT-05` | POST | `/api/v1/platform/tenants/{id}/suspend` | `{ reason }` + `If-Match` | `200 { data: Tenant }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `PLT-06` | POST | `/api/v1/platform/tenants/{id}/offboard` | `{ reason, offboardingEndsAt }` + `If-Match` | `200 { data: Tenant }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `PLT-07` | POST | `/api/v1/platform/tenants/{id}/deactivate` | `{ reason, confirmSlug, acknowledgeEarly? }` + `If-Match` | `200 { data: Tenant }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `PLT-13` | GET | `/api/v1/platform/tenants/{id}/status-history` | `page`, `pageSize` | `200 { data: [{ occurredAt, operator{ id, name }, action, fromStatus, toStatus, channel, reason? }], meta }` | 200, 403, 404, 503 |
| `PLT-02` | GET | `/api/v1/platform/tenants` | + `offboardingOverdue` (estende a US-178) | `200 { data: [… + offboardingEndsAt, offboardingOverdue], meta }` | 200, 403, 422, 503 |
| `PLT-03` | GET | `/api/v1/platform/tenants/{id}` | — (estende a US-178) | `200 { data: Tenant + datas do ciclo de vida + motivo (só operador) }` + `ETag` | 200, 403, 404, 503 |

Trecho de `PLT-14`: `{ "status": "OFFBOARDING", "version": 5, "offboardingEndsAt": "2027-02-10", "offboardingOverdue": false, "actions": [{ "action": "ACTIVATE", "allowed": true, "requires": [] }, { "action": "DEACTIVATE", "allowed": true, "requires": ["reason", "confirmSlug", "acknowledgeEarly"] }, { "action": "SUSPEND", "allowed": false, "blockedReason": "INVALID_STATE", "requires": [] }] }`.

## Logs
- `info` `tenant.status_changed` — `tenantId`, `from`, `to`, `channel = BACKOFFICE`, `operatorId`, `hasReason`, `durationMs`.
- `warn` `tenant.status_cache_unavailable` — `tenantId`, `errorCode` (Redis fora; leitura direta no banco).
- `warn` `tenant.invitation_dispatch_failed` — `tenantId`, `membershipId` (ativação a partir de `PROVISIONING`).
- `warn` `tenant.lifecycle_conflict` — `tenantId`, `action`, `expectedVersion`, `currentVersion`.
- `error` `tenant.lifecycle_failed` — `tenantId`, `action`, `errorCode`, `durationMs`.
- **Nunca logar:** texto do motivo (só `hasReason`), identificador digitado na confirmação, e-mail do administrador, nome de usuários do tenant, conteúdo de processo ou documento.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `tenant.activate` | `SYSTEM` | Ativação, reativação e reversão do encerramento | `changes`: `status`; `metadata`: `fromStatus`, `toStatus`, `channel = BACKOFFICE` |
| `tenant.suspend` | `SYSTEM` | Suspensão | `changes`: `status`, `suspendedAt`; `metadata`: `reason`, `channel` (visão do tenant omite `reason` — RN-PLAT-134) |
| `tenant.deactivate` | `SYSTEM` | Encerramento e desativação | `metadata`: `fromStatus`, `toStatus` (`OFFBOARDING`/`DEACTIVATED`), `reason`, `offboardingEndsAt` (no encerramento), `acknowledgedEarly` (na desativação), `channel` |
| `access.denied` | `ACCESS` | Operador sem a permissão ou não operador em rota de plataforma | Auditoria de plataforma; `reasonCode = PLATFORM_TENANT_MANAGE` |

Todas com `actorType = PLATFORM_OPERATOR` e gravadas **no tenant afetado**, visíveis ao administrador com `AUDIT_VIEW` (RN-PLAT-06, DEC-139). A consulta ao histórico (`PLT-13`) não gera auditoria própria.

## Testes necessários
- **Unitários:** máquina de estados (todas as transições válidas e inválidas, incluindo `SUSPENDED → DEACTIVATED` recusada), `OffboardingPeriod` (futura, teto, fuso), `LifecycleActionPolicy` (ações e campos exigidos por situação e versão), cálculo de `offboardingOverdue`, validação de `confirmSlug` e `acknowledgeEarly`.
- **Integração (Testcontainers PostgreSQL + Redis):** cada transição com auditoria e outbox na mesma transação (falha injetada em cada parte desfaz tudo); `If-Match` e versão; reativação preservando `activatedAt`; reversão limpando as datas; ativação a partir de `PROVISIONING` com e sem checklist completo; Redis fora (leitura direta no banco); histórico lido da auditoria do tenant.
- **API/contrato:** `PLT-04..07`, `PLT-13` e `PLT-14` conforme `api.md`; códigos `412`, `428`, `409`, `422`; allowlist de saída (nenhum dado de processo ou documento).
- **RBAC e multi-tenant:** não operador → 404/403; operador sem MFA; operador sem `PLATFORM_TENANT_MANAGE`; `ADMIN_ORGAO` do próprio tenant; **matriz DEC-132** (situação × leitura/comando/exportação × `ADMIN_ORGAO`/`AUDITOR`/`REQUISITANTE`) com efeito em até 60 s; suspender um tenant não altera o outro (suíte `test/tenant-leak`).
- **Concorrência:** dois operadores com a mesma versão; duplo clique; requisição de usuário em andamento durante a suspensão; repetição com versão nova e antiga.
- **E2E (Playwright):** suspender e reativar com a sessão de um usuário aberta (vê SCR-111 e volta); encerrar com data e conferir somente leitura e exportação para `ADMIN_ORGAO`; desativar com a confirmação do identificador; conflito de versão entre dois operadores.
- **Acessibilidade/performance:** axe nos diálogos e no painel; foco e teclado; `PLT-04..07` p95 ≤ 500 ms; propagação de status ≤ 60 s medida na suíte de performance (endurecimento).

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes (`cf_tenant_status_changes_total` por transição e canal)
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada
- [ ] Matriz de acesso por situação (DEC-132) coberta por testes e efeito em até 60 s comprovado
- [ ] Teste de autorização: operador sem MFA recebe `MFA_REQUIRED` e nenhuma rota do ciclo de vida devolve dado de processo ou documento
- [ ] Guia do operador e runbook RB-12 atualizados (suspender, encerrar com data, desativar, reverter, prazo vencido)

## Estimativa
**M** — as quatro operações e a máquina de estados já existem (US-099) e a área vem da US-178; o trabalho é completar os contratos de encerramento e desativação, as duas consultas de apoio, o painel com diálogos de confirmação, o tratamento de concorrência e a matriz de testes de acesso por situação.

## Prioridade
**P1** — sem as quatro ações no backoffice a operação do contrato continua dependendo de CLI e a FT-083 fica incompleta; depende da US-178 e não bloqueia o acesso de suporte (US-180) nem a saúde operacional (US-181).
