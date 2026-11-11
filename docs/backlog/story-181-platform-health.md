---
id: US-181
title: "Saúde operacional por tenant no backoffice"
epic: EP-029
feature: FT-083
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-085, US-116, US-178]
modules: [tenancy, ai, files, analytics, audit, platform]
screens: [SCR-123]
endpoints: [PLT-20, PLT-21, PLT-22, PLT-23, PLT-24]
permissions: [PLATFORM_HEALTH_VIEW, PLATFORM_QUEUE_ADMIN]
events: []
---

# US-181 — Saúde operacional por tenant no backoffice

## Título
Saúde operacional por tenant no backoffice

## Descrição
**Como** operador da plataforma (`User.isPlatformOperator`, com `PLATFORM_HEALTH_VIEW` e MFA), **quero** ver, no backoffice, a saúde operacional de cada tenant — filas e dead-letter, consumo e limite de IA, uso de storage e situação da reconciliação do read model — numa visão geral ordenada por gravidade e num detalhe por tenant, **para** detectar fila travada, limite de IA estourando, storage cheio ou reconciliação atrasada antes de o órgão reclamar, **sem** que o backoffice leia processo, documento ou comentário de nenhum tenant (DEC-208, RN-PLAT-07).

A story entrega a SCR-123 na parte "Saúde" (`/plataforma/saude` e `/plataforma/tenants/{id}/saude`) e cinco endpoints de consulta (`PLT-20` a `PLT-24`). Ela **só lê** contadores, estados, limites e datas: não altera nada, não envia notificação e não substitui o Bull Board nem os alertas A-NN do Alertmanager (que continuam a fonte de plantão).

## Contexto
- DEC-208 e FT-083 (RN-PLAT-02, RN-PLAT-07): o backoffice não devolve dado de processo nem de documento, e a saúde mostra só contadores, estados e limites. O suporte que precisa ver dados entra no tenant pelo acesso de suporte (US-180), com chamado e prazo.
- O MVP 1 já tem a saúde **da plataforma**: `/health/live|ready` e `/metrics` (US-085, `HLT-01..03`), o Bull Board interno e a CLI de reprocessamento (US-083, RB-11), os alertas A05 a A10 de filas e a A21 de selagem. Nenhum deles responde "como está **este tenant**": as métricas não têm rótulo de `tenantId` (RN-FND-85) e a investigação por tenant é feita por log e trace. Esta story acrescenta a visão por tenant, por leituras agregadas e só numéricas.
- Limites e consumo de IA: US-116 e DEC-203 (IA incluída no plano; limite mensal de tokens `ai.monthlyTokenLimit`, padrão 2.000.000, mês civil no fuso do tenant; limite diário por usuário `ai.userDailyRequestLimit`; avisos em 80% e 100% — RN-AI-18/19/20). O limite é do **tenant** (chave de `TenantSetting`, sem escopo por `Organization`); "por órgão" nas fontes é a instituição (lacuna 3).
- Storage: storage.md §8 (limite técnico da plataforma por tenant, proposta de 50 GB — PEND-17, comercial e fora do MVP 2 pela DEC-210 —, avisos em 80% e 95%, uso medido com cache de 10 min e reconciliação diária no `maintenance`).
- Reconciliação: o read model do EP-028 (US-170/US-171, `AnalyticsReconciliationRun`) é reconciliado toda noite por tenant. Enquanto ele não existir, o indicador aparece como "não disponível" (FT-083). A reconciliação grava só contagens (`factsChecked`, `divergencesFixed`); o backoffice nunca lê `divergenceSample` nem `errorMessage`.
- POL-29: rotas `/platform/*` = operador + MFA sempre + permissão da rota. `PLATFORM_HEALTH_VIEW` é permissão **nova** (permissions.md §8); `PLATFORM_QUEUE_ADMIN` continua dono do Bull Board e da CLI e aqui só habilita o atalho.
- Isolamento: o `cf_platform` não tem tabela de negócio (multi-tenancy.md §5.3); as leituras de IA, storage, outbox e reconciliação por tenant passam por funções `SECURITY DEFINER` mínimas que devolvem apenas números (RN-PLAT-162, lacuna 2).

## Objetivo
Mostrar a saúde dos quatro indicadores de qualquer tenant em até 1 s (p95, visão com cache quente) e a visão geral de até 500 tenants em até 2 s (p95, suíte de performance), com 0 campo de conteúdo de tenant em qualquer resposta, log ou auditoria, e com a falha de uma fonte degradando só o indicador afetado.

## Persona
- **Principal:** Operador da plataforma (`isPlatformOperator`, `PLATFORM_HEALTH_VIEW`, MFA), de plantão ou de suporte.
- **Secundárias:** Operador com `PLATFORM_QUEUE_ADMIN` (segue do indicador de filas para o Bull Board/CLI); operador com `PLATFORM_TENANT_MANAGE` (decide suspender ou encerrar com base na saúde — US-179); administrador do órgão, que **não** usa esta tela (vê consumo de IA em `AI-06` e uso de storage no próprio órgão).

## Pré-condições
- Operador autenticado no grupo de operadores do Authentik, com MFA satisfeito (US-178) e `PLATFORM_HEALTH_VIEW` na sessão de plataforma.
- Métricas e contadores de fila coletados (US-085/US-083); para o indicador de reconciliação, o EP-028 implantado (sem ele, "não disponível" — FA-02).
- Sem pré-condição sobre o tenant: a consulta vale para qualquer status (`PROVISIONING`, `ACTIVE`, `SUSPENDED`, `OFFBOARDING`, `DEACTIVATED`), com a avaliação de cada indicador conforme RN-PLAT-170.

## Fluxo principal
1. O operador abre **Saúde** no backoffice (SCR-123, `/plataforma/saude`); o front chama `PLT-22` (resumo da plataforma) e `PLT-20` (visão geral, `status = ACTIVE`, ordenada por gravidade).
2. O resumo mostra, em cartões, o total de tenants por situação e por gravidade e quantos tenants estão em alerta em cada indicador (filas, IA, storage, reconciliação). A lista mostra uma linha por tenant com o selo de gravidade (Normal, Atenção, Crítico, Sem leitura — por texto e ícone) e, por indicador, um valor-chave: "Dead-letter: 3", "IA: 82% do limite", "Storage: 96%", "Reconciliação: há 2 dias".
3. O operador filtra por situação do tenant, gravidade, indicador em alerta ou nome/slug, e a lista se atualiza.
4. Ao abrir um tenant (`/plataforma/tenants/{id}/saude`), o front chama `PLT-21` e mostra os quatro blocos com valores, limites, barra de uso acompanhada de texto, data da medição e aviso de dado antigo (`stale`). O bloco de filas traz o outbox do tenant (pendentes, mais antigo, `FAILED`) e os jobs na dead-letter por fila de origem.
5. No bloco de IA, "Ver mês" abre o detalhe (`PLT-24`): limite, usado, reservado, percentual, faixas de 80% e 100% já cruzadas no mês e a contagem de gerações por estado. **Não** há quebra por usuário, documento ou processo.
6. Em "Filas da plataforma" (`/plataforma/saude/filas`, `PLT-23`), o operador vê, por fila, jobs em espera, ativos, atrasados, com falha, idade do mais antigo, total da dead-letter por fila de origem, último sucesso de cada scheduler, disponibilidade do Redis e estado dos disjuntores de dependência. Quem tem `PLATFORM_QUEUE_ADMIN` vê "Abrir no Bull Board" (instrução de acesso pela rede interna — RB-11); quem não tem, não vê o atalho.
7. A tela se atualiza sozinha a cada 60 s enquanto a aba está visível e mostra "Atualizado às {hora}" (`meta.generatedAt`) e "dados em cache" quando `meta.cached` é verdadeiro.
8. A API grava `platform.health_view` (no máximo uma vez por operador, escopo e 15 minutos — RN-PLAT-175) e nunca devolve conteúdo de tenant.

## Fluxos alternativos
- **FA-01 — IA desligada no tenant:** o bloco mostra `enabled = false` e estado "IA desligada" sem gravidade; o consumo do mês, se houver, continua visível.
- **FA-02 — Reconciliação não disponível:** sem o módulo `analytics` implantado ou sem nenhuma execução registrada para o tenant, o bloco responde `state = NOT_AVAILABLE` ("Reconciliação ainda não disponível para este órgão"), sem gravidade e sem alerta.
- **FA-03 — Redis indisponível:** o bloco de filas do tenant e o `PLT-23` respondem `UNAVAILABLE` (`errorCode = SOURCE_ERROR`); IA, storage e reconciliação seguem normais; o cache de leitura é dispensado (calcula direto) com `warn`.
- **FA-04 — Uma fonte lenta ou com erro:** cada fonte tem tempo limite próprio de 3 s; a que falhar vira `UNAVAILABLE` com `errorCode` genérico (`SOURCE_TIMEOUT` ou `SOURCE_ERROR`), a resposta é `200` com `meta.partial = true` e a tela marca só aquele bloco com "Sem leitura. Tentar de novo".
- **FA-05 — Tenant suspenso, em encerramento ou desativado:** os indicadores de espera de fila, IA e reconciliação não são avaliados (`NOT_EVALUATED`, porque os jobs de tenant não rodam — RN-TEN-12); storage e a dead-letter/`FAILED` do outbox continuam avaliados. `DEACTIVATED` só aparece na lista com o filtro de situação explícito.
- **FA-06 — Tenant em provisionamento:** aparece como "Em provisionamento" sem gravidade; os blocos mostram o que já existir.
- **FA-07 — Dado antigo:** bloco medido há mais de 15 minutos (ou, no storage, há mais de 24 h) vem com `stale = true` e a tela mostra "Medido há {tempo}".
- **FA-08 — Tenant sem uso:** tenant recém-ativado sem IA, storage ou jobs responde zeros e gravidade normal; nunca erro.
- **FA-09 — Filtro sem resultado:** a lista mostra "Nenhum órgão com este filtro." e mantém o filtro.
- **FA-10 — Mês anterior:** `PLT-24` aceita um mês de até 12 meses atrás; meses sem geração respondem zeros.
- **FA-11 — Auditoria da consulta indisponível:** se a gravação de `platform.health_view` falhar, a API responde `503 DEPENDENCY_UNAVAILABLE` (a leitura do operador não pode ficar sem rastro), sem devolver dados.

## Regras de negócio
- **RN-PLAT-160** — Só números, estados e datas: toda resposta é montada por esquema de saída `strict` (lista de campos permitidos: contadores, bytes, percentuais, enums, datas, ids do tenant e da fila). É proibido devolver ou logar processo, documento, comentário, nome de pessoa, valor monetário, texto de erro de job, payload ou identificador de recurso de tenant (RN-PLAT-02, RN-PLAT-07, DEC-208). Nenhuma rota `/platform/*` devolve dado de processo ou documento.
- **RN-PLAT-161** — Acesso: operador (`isPlatformOperator`) com MFA sempre e `PLATFORM_HEALTH_VIEW` em `PLT-20` a `PLT-24` (RN-PLAT-01, POL-29). `PLATFORM_QUEUE_ADMIN` só habilita o atalho ao Bull Board; ninguém ganha leitura de conteúdo por esta tela. O operador **não** precisa de acesso de suporte no tenant para ver a saúde dele.
- **RN-PLAT-162** — Fonte e papel: as leituras que tocam tabelas de tenant (`ai_generations`, `tenant_settings`, anexos e renditions, `outbox_events`, `analytics_reconciliation_runs`) passam por funções `SECURITY DEFINER` (dona `cf_definer`, `search_path` fixo, `EXECUTE` só para `cf_platform`) de colunas fixas e retorno numérico, chamadas pelo `SystemDbService` com a razão `PLATFORM_HEALTH`; `cf_platform` **não** ganha `SELECT` em tabela de negócio. Um teste de arquitetura reprova importar repositórios de `process`, `document`, `collaboration` ou `dfd` neste caminho.
- **RN-PLAT-163** — Filas do tenant: o bloco traz (a) do **outbox**, por tenant: `pendingCount`, `oldestPendingAgeSeconds` e `failedCount` (eventos `FAILED`); (b) da **dead-letter**, por tenant: `total` e `bySourceQueue` (contadores mantidos pela plataforma: incrementados quando o wrapper do worker grava na dead-letter e decrementados em retry, descarte e expiração, e reconciliados no `maintenance` pelo `meta.tenantId` dos registros, sem ler `data`). O estado de espera/ativos por tenant **não** existe (as filas BullMQ não são indexadas por tenant e as métricas não têm rótulo de tenant): ele aparece só no nível da plataforma (`PLT-23`) — lacuna 1.
- **RN-PLAT-164** — Gravidade (proposta, parametrizável por variável de ambiente da plataforma, sem chave de tenant): **outbox** — mais antigo > 30 s = Atenção, > 5 min = Crítico, `failedCount > 0` = Crítico (alinhado aos alertas A05/A06); **dead-letter** — `total > 0` = Atenção, `total > 10` = Crítico (alinhado ao A08, que alerta por taxa; aqui por estoque); a gravidade do bloco de filas é a maior entre as duas. Valores e nomes dos limites ficam em `PLATFORM_HEALTH_*` (lacuna 6).
- **RN-PLAT-165** — IA (US-116, DEC-203): `enabled`, `limitTokens` (`ai.monthlyTokenLimit`), `usedTokens` (consumo real do mês civil no fuso do tenant), `reservedTokens` (reservas ativas), `percentUsed` = (usado + reservado) ÷ limite, `thresholdsReached` (faixas 80 e 100 já cruzadas no mês), `userDailyRequestLimit` (só o valor configurado) e `generationsByStatus` (contagem por `AiGenerationStatus`). Gravidade: ≥ 80% = Atenção, ≥ 100% = Crítico; IA desligada não tem gravidade. A fonte é o consumo e a configuração do tenant (não do provedor).
- **RN-PLAT-166** — Disponibilidade do provedor de IA: o estado do disjuntor `ai_provider` (`cf_circuit_breaker_state`) aparece em `PLT-23` como dependência da plataforma, nunca por tenant; indisponibilidade do provedor não altera a gravidade do bloco de IA de nenhum tenant.
- **RN-PLAT-167** — Storage (storage.md §8): `usedBytes` (anexos `AVAILABLE` e `DELETED` retidos + renditions não efêmeras, pela consulta de uso do módulo `files`), `limitBytes` (limite técnico da plataforma, igual para todos — PEND-17), `percentUsed`, `measuredAt` e `thresholdState` (`BELOW`, `WARN_80`, `WARN_95`, `FULL`). Gravidade: ≥ 80% = Atenção, ≥ 95% = Crítico. O valor vem do cache de uso (10 min) ou da reconciliação diária; nunca de listar objetos do bucket. Nome, tipo e quantidade de arquivos não são devolvidos.
- **RN-PLAT-168** — Reconciliação do read model (EP-028): `state` ∈ `OK`, `RUNNING`, `STALE`, `FAILED`, `NOT_AVAILABLE`, mais `lastRun` (`status`, `scope`, `startedAt`, `finishedAt`, `factsChecked`, `divergencesFixed`). Gravidade (proposta): última `COMPLETED` há ≤ 36 h = Normal, > 36 h = Atenção, > 72 h = Crítico; última execução `FAILED` = Atenção, duas seguidas = Crítico; `RUNNING` há > 2 h = Atenção. Sem `AnalyticsReconciliationRun` ou sem o módulo → `NOT_AVAILABLE` (sem gravidade).
- **RN-PLAT-169** — Gravidade do tenant = a maior entre os blocos avaliados (`OK` < `ATTENTION` < `CRITICAL`). Bloco `UNAVAILABLE` ou `NOT_AVAILABLE` não rebaixa nem eleva a gravidade, mas, se **todos** os blocos avaliáveis estiverem sem leitura, a gravidade do tenant é `UNKNOWN` ("Sem leitura"), nunca "Normal".
- **RN-PLAT-170** — Estado do tenant: `ACTIVE` avalia os quatro blocos; `SUSPENDED`, `OFFBOARDING` e `DEACTIVATED` avaliam storage e dead-letter/`FAILED` do outbox e marcam IA, espera do outbox e reconciliação como `NOT_EVALUATED`; `PROVISIONING` não tem gravidade. A visão geral usa `status = ACTIVE` por padrão e exclui `DEACTIVATED` a menos que o filtro peça.
- **RN-PLAT-171** — Falha parcial: cada fonte (filas/Redis, IA, storage, reconciliação) roda com tempo limite de 3 s e isolada das demais; a falha de uma vira bloco `UNAVAILABLE` (`errorCode` genérico `SOURCE_TIMEOUT` ou `SOURCE_ERROR`, sem mensagem de exceção) e `meta.partial = true`. Só a indisponibilidade do banco principal (que sustenta a autenticação, a lista de tenants e a auditoria) derruba a resposta com `503 DEPENDENCY_UNAVAILABLE`.
- **RN-PLAT-172** — Cache curto: `PlatformCache` (`cf:{env}:p:health:tenant:{tenantId}` com TTL de 30 s; `cf:{env}:p:health:overview:{hash dos filtros}` e `…:summary` com TTL de 60 s; `…:queues` com TTL de 60 s) com *single-flight* (uma recarga por chave, demais requisições aguardam). Blocos `UNAVAILABLE` não ficam em cache por mais de 5 s. Não existe parâmetro para furar o cache; `meta.generatedAt` e `meta.cached` informam a idade. Redis fora → calcula direto (`warn cache.unavailable`).
- **RN-PLAT-173** — Visão geral (`PLT-20`): calculada em lote, **uma consulta agregada por fonte** para todos os tenants da página (sem N+1); paginada (`page`, `pageSize` ≤ 100, padrão 50); filtros `status[]`, `severity[]`, `indicator` (indicador em alerta: `queues`, `ai`, `storage`, `reconciliation`) e `q` (nome ou slug, ≥ 2 caracteres); ordenação padrão por gravidade decrescente e depois por nome, com desempate por `id`.
- **RN-PLAT-174** — Resumo (`PLT-22`): contagens de tenants por situação e por gravidade e número de tenants em alerta por indicador, mais a gravidade geral das filas da plataforma; sem nomes de tenant e sem listas.
- **RN-PLAT-175** — Auditoria da consulta: `platform.health_view` (`ACCESS`) é gravada no máximo uma vez por operador, escopo (`TENANT` por `tenantId`, ou `PLATFORM` para `PLT-20`, `PLT-22`, `PLT-23`) e 15 minutos (chave no `PlatformCache`; sem Redis, grava sempre). Com `tenantId`, o registro vai **no tenant** com `actorType = PLATFORM_OPERATOR` e fica visível ao administrador com `AUDIT_VIEW` (RN-PLAT-06); sem tenant, vai para a auditoria de plataforma (`tenantId` nulo). Falha de gravação → `503`. A auditoria guarda escopo e blocos consultados, nunca valores.
- **RN-PLAT-176** — Detalhe de IA (`PLT-24`): `month` no formato `YYYY-MM` (padrão: mês corrente no fuso do tenant; no máximo 12 meses atrás; não futuro); resposta com `limitTokens`, `usedTokens`, `reservedTokens`, `percentUsed`, `thresholdsReached` com a data de cada cruzamento e `generationsByStatus`; sem `byUser`, `byDocumentType` nem custo por usuário (o custo `costUsd` por tenant não entra — é dado comercial fora do MVP 2, DEC-203).
- **RN-PLAT-177** — Atualidade: cada bloco traz `measuredAt` e `stale` (> 15 min; storage > 24 h, pois o uso vem de cache de 10 min e reconciliação diária). A tela nunca exibe um valor antigo como se fosse atual.
- **RN-PLAT-178** — Somente leitura: esta story não envia notificação, não altera limite, não faz retry nem descarte de job (continuam na CLI auditada da US-083) e não substitui os alertas A-NN. Métricas Prometheus continuam sem rótulo de `tenantId` (RN-FND-85).
- **RN-PLAT-179** — Isolamento e vazamento: a resposta de um tenant nunca contém número de outro; `tenantId` desconhecido → `404 TENANT_NOT_FOUND`; as funções `SECURITY DEFINER` recebem sempre o `tenantId` explícito (ou a lista da página) e validam que ele existe; o teste de conteúdo semeia textos marcadores em processo, documento, comentário e geração de IA e prova que nenhum aparece em resposta, log ou auditoria.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Situação do tenant | `status[]` | lista de `TenantStatus` | Não | RN-PLAT-170/173 | `ACTIVE` |
| Gravidade | `severity[]` | `OK`, `ATTENTION`, `CRITICAL`, `UNKNOWN` | Não | RN-PLAT-169 | todas |
| Indicador em alerta | `indicator` | `queues`, `ai`, `storage`, `reconciliation` | Não | RN-PLAT-173 | — |
| Busca | `q` | texto (≥ 2) | Não | nome ou slug | — |
| Paginação | `page`, `pageSize` | inteiros | Não | `pageSize` ≤ 100 | 1 / 50 |
| Mês (IA) | `month` | `YYYY-MM` | Não | RN-PLAT-176 | mês corrente |
| Filas do tenant | `queues.outbox`, `queues.deadLetter` | contadores | — | RN-PLAT-163 | outbox e dead-letter |
| IA | `ai.*` | contadores, percentual, enum | — | RN-PLAT-165 | uso e configuração |
| Storage | `storage.*` | bytes, percentual, enum | — | RN-PLAT-167 | cache de uso |
| Reconciliação | `reconciliation.*` | enum, datas, contadores | — | RN-PLAT-168 | última execução |
| Estado do bloco | `state`, `severity`, `measuredAt`, `stale`, `errorCode?` | enums, data, booleano | — | RN-PLAT-171/177 | calculado |
| Metadados | `meta.generatedAt`, `meta.cached`, `meta.partial` | data, booleanos | — | RN-PLAT-172 | calculado |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `status`, `severity`, `indicator` ou `pageSize` fora do domínio | Front + API (Zod) | "Filtro inválido." | `VALIDATION_ERROR` (`INVALID_ENUM`/`OUT_OF_RANGE`) |
| V-02 | `q` com menos de 2 caracteres | Front + API (Zod) | "Digite ao menos 2 caracteres." | `VALIDATION_ERROR` (`TOO_SHORT`) |
| V-03 | `month` em formato inválido, futuro ou mais antigo que 12 meses | Front + API (Zod) | "Informe um mês entre os últimos 12 meses." | `VALIDATION_ERROR` (`INVALID_FORMAT`/`OUT_OF_RANGE`) |
| V-04 | `tenantId` inexistente | API | "Órgão não encontrado." | `TENANT_NOT_FOUND` |
| V-05 | Sem `PLATFORM_HEALTH_VIEW` ou não é operador | API | "Você não tem permissão para ver a saúde da plataforma." | `PERMISSION_DENIED` |
| V-06 | Sessão sem MFA | API | "Confirme sua identidade com o segundo fator para continuar." | `MFA_REQUIRED` |

## Permissões
- **Permissão:** `PLATFORM_HEALTH_VIEW` (nova — permissions.md §8) em `PLT-20` a `PLT-24`; `PLATFORM_QUEUE_ADMIN` só para o atalho ao Bull Board/CLI (a ação em si continua nas ferramentas da US-083).
- **Políticas:** POL-29 (operador + MFA + permissão da rota; o backoffice não lê processos nem documentos). Não há escopo por unidade: a visão é da plataforma. Nenhuma permissão de tenant dá acesso a estas rotas.
- **MFA:** sempre (RN-PLAT-01), independentemente da política do tenant (DEC-078).
- **Sem permissão:** `403 PERMISSION_DENIED` e `access.denied` na auditoria de plataforma; sem MFA, `403 MFA_REQUIRED`. A rota e o menu "Saúde" não existem para quem não é operador. Tenant inexistente: `404 TENANT_NOT_FOUND`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio (somente leitura). A consulta gera só a auditoria `platform.health_view`. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | Nenhuma | — | Somente leitura. O aviso de IA em 80%/100% (`AI_USAGE_LIMIT_WARNING`) e o de storage ao administrador seguem nas stories de origem (US-116, storage.md §8). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Saúde operacional por tenant no backoffice

  Background:
    Given que "Rui" é operador da plataforma com MFA e "PLATFORM_HEALTH_VIEW"
    And "Lia" é operadora com MFA e sem "PLATFORM_HEALTH_VIEW"
    And o tenant "Prefeitura A" está "ACTIVE" com IA ligada e limite de 2.000.000 tokens, com 1.640.000 usados
    And o tenant "Prefeitura B" está "ACTIVE" com 96% do limite de storage usado
    And o tenant "Prefeitura C" está "SUSPENDED"
    And a "Prefeitura A" tem um processo com o objeto "OBJETO-MARCADOR-A", um comentário "COMENTARIO-MARCADOR-A" e uma geração de IA com a saída "SAIDA-MARCADOR-A"

  Scenario: [Sucesso] Visão geral ordenada por gravidade
    When "Rui" abrir a Saúde da plataforma
    Then a lista deve trazer "Prefeitura B" como "CRITICAL" por storage e "Prefeitura A" como "ATTENTION" por IA
    And a lista deve estar ordenada por gravidade decrescente e depois por nome
    And "Prefeitura C" não deve aparecer na lista padrão de situação "ACTIVE"

  Scenario: [Sucesso] Saúde de um tenant com os quatro blocos
    When "Rui" abrir a saúde da "Prefeitura A"
    Then devem aparecer os blocos "queues", "ai", "storage" e "reconciliation" com "state", "severity", "measuredAt" e "stale"
    And "meta.generatedAt" deve estar preenchido

  Scenario: [Sucesso] Consumo de IA em 82% é atenção
    When "Rui" abrir a saúde da "Prefeitura A"
    Then o bloco "ai" deve trazer "limitTokens" 2000000, "usedTokens" 1640000 e "percentUsed" 82
    And a gravidade do bloco deve ser "ATTENTION" e "thresholdsReached" deve conter 80

  Scenario: [Sucesso] Limite de IA estourado é crítico
    Given que a "Prefeitura A" chegou a 2.010.000 tokens usados
    When "Rui" abrir a saúde da "Prefeitura A"
    Then a gravidade do bloco "ai" deve ser "CRITICAL" e "thresholdsReached" deve conter 80 e 100

  Scenario: [Sucesso] Storage com avisos de 80% e 95%
    When "Rui" abrir a saúde da "Prefeitura B"
    Then o bloco "storage" deve trazer "usedBytes", "limitBytes", "percentUsed" 96 e "thresholdState" "WARN_95"
    And a gravidade do bloco deve ser "CRITICAL"
    And nenhum nome, tipo ou quantidade de arquivo deve ser retornado

  Scenario: [Sucesso] Dead-letter e outbox do tenant
    Given que a "Prefeitura A" tem 3 jobs na dead-letter da fila "document-render" e o evento mais antigo pendente do outbox tem 45 segundos
    When "Rui" abrir a saúde da "Prefeitura A"
    Then o bloco "queues" deve trazer "deadLetter.total" 3 com "bySourceQueue" da fila "document-render"
    And "outbox.oldestPendingAgeSeconds" deve ser 45 e a gravidade do bloco deve ser "ATTENTION"

  Scenario: [Sucesso] Evento do outbox com falha é crítico
    Given que a "Prefeitura A" tem 1 evento do outbox em "FAILED"
    When "Rui" abrir a saúde da "Prefeitura A"
    Then a gravidade do bloco "queues" deve ser "CRITICAL"

  Scenario: [Sucesso] Reconciliação atrasada
    Given que a última reconciliação "COMPLETED" da "Prefeitura A" foi há 40 horas
    When "Rui" abrir a saúde da "Prefeitura A"
    Then o bloco "reconciliation" deve trazer "state" "STALE" e gravidade "ATTENTION"
    And só devem aparecer "status", "scope", datas, "factsChecked" e "divergencesFixed"

  Scenario: [Sucesso] Reconciliação ainda não disponível
    Given que o read model do EP-028 ainda não existe para a "Prefeitura B"
    When "Rui" abrir a saúde da "Prefeitura B"
    Then o bloco "reconciliation" deve trazer "state" "NOT_AVAILABLE" sem gravidade
    And a tela deve dizer "Reconciliação ainda não disponível para este órgão"

  Scenario: [Sucesso] IA desligada
    Given que a IA está desligada na "Prefeitura B"
    When "Rui" abrir a saúde da "Prefeitura B"
    Then o bloco "ai" deve trazer "enabled" falso e nenhuma gravidade

  Scenario: [Sucesso] Tenant suspenso avalia só o que ainda faz sentido
    When "Rui" abrir a saúde da "Prefeitura C"
    Then os blocos "ai" e "reconciliation" devem estar "NOT_EVALUATED"
    And os blocos "storage" e "queues" devem trazer dead-letter e falhas do outbox

  Scenario: [Sucesso] Resumo e filas da plataforma
    When "Rui" abrir o resumo e as filas da plataforma
    Then o resumo deve trazer tenants por situação e por gravidade e a contagem de tenants em alerta por indicador, sem nomes
    And as filas devem trazer por fila "waiting", "active", "delayed", "failed", a idade do mais antigo e o total da dead-letter por fila de origem

  Scenario: [Sucesso] Atalho para o Bull Board só com PLATFORM_QUEUE_ADMIN
    Given que "Rui" também tem "PLATFORM_QUEUE_ADMIN" e "Lia" tem "PLATFORM_HEALTH_VIEW" sem ela
    When os dois abrirem as filas da plataforma
    Then "Rui" deve ver "Abrir no Bull Board" e "Lia" não

  Scenario: [Sucesso] Detalhe de IA do mês anterior
    When "Rui" pedir o detalhe de IA da "Prefeitura A" do mês anterior
    Then deve ver limite, usado, reservado, percentual, faixas cruzadas com data e contagem de gerações por estado
    And não deve haver quebra por usuário, documento ou custo

  Scenario: [Sucesso] Nenhuma resposta traz conteúdo de tenant
    When "Rui" chamar "PLT-20", "PLT-21", "PLT-22", "PLT-23" e "PLT-24" para a "Prefeitura A"
    Then nenhuma resposta deve conter "OBJETO-MARCADOR-A", "COMENTARIO-MARCADOR-A" ou "SAIDA-MARCADOR-A"
    And todas as respostas devem passar no esquema de saída estrito
    And nenhum log nem registro de auditoria deve conter esses textos

  Scenario: [Validação] Parâmetros inválidos
    When "Rui" pedir "severity" "GRAVE", "pageSize" 500 e "q" "a"
    Then a API deve responder 422 com código "VALIDATION_ERROR" apontando cada campo
    And nenhuma consulta às fontes deve ser executada

  Scenario: [Validação] Mês de IA inválido
    When "Rui" pedir o detalhe de IA com "month" "2099-01" e depois "2024-13"
    Then a API deve responder 422 com código "VALIDATION_ERROR" nas duas chamadas

  Scenario: [Permissão] Sem PLATFORM_HEALTH_VIEW
    When "Lia" pedir "GET /platform/health/tenants"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria de plataforma "access.denied"
    And o menu "Saúde" não deve aparecer para ela

  Scenario: [Permissão] Administrador de tenant não acessa a saúde
    Given que "Marta" é "ADMIN_ORGAO" da "Prefeitura A" e não é operadora
    When "Marta" pedir "GET /platform/tenants/{id}/health"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Permissão] Operador sem MFA
    Given que "Rui" está com a sessão sem MFA satisfeito
    When "Rui" pedir "GET /platform/health/summary"
    Then a API deve responder 403 com código "MFA_REQUIRED"

  Scenario: [Tenant incorreto] Tenant inexistente
    When "Rui" pedir a saúde de um "tenantId" que não existe
    Then a API deve responder 404 com código "TENANT_NOT_FOUND"

  Scenario: [Tenant incorreto] Números de um tenant não aparecem em outro
    When "Rui" abrir a saúde da "Prefeitura A"
    Then nenhum valor de "usedBytes", "usedTokens" ou contador de fila da "Prefeitura B" deve aparecer na resposta
    And a função de leitura deve ter sido chamada apenas com o "tenantId" da "Prefeitura A"

  Scenario: [Tenant incorreto] Operador sem acesso de suporte continua sem ver o tenant
    Given que "Rui" não tem acesso de suporte "ACTIVE" à "Prefeitura A"
    When "Rui" abrir a saúde da "Prefeitura A" e pedir "GET /processes" com o "X-Tenant-Id" da "Prefeitura A"
    Then a saúde deve responder 200 apenas com contadores
    And "GET /processes" deve responder 403 com código "MEMBERSHIP_INACTIVE"

  Scenario: [Duplicidade] Leituras repetidas dentro do cache
    When "Rui" abrir a saúde da "Prefeitura A" três vezes em 20 segundos
    Then as três respostas devem ter os mesmos números e o mesmo "generatedAt"
    And a segunda e a terceira devem trazer "meta.cached" verdadeiro

  Scenario: [Duplicidade] A consulta é auditada uma vez por janela
    When "Rui" abrir a saúde da "Prefeitura A" cinco vezes em 10 minutos
    Then deve existir um único registro "platform.health_view" no tenant, com "actorType" "PLATFORM_OPERATOR"
    And o administrador da "Prefeitura A" deve conseguir ver esse registro com "AUDIT_VIEW"

  Scenario: [Concorrência] Vários operadores na mesma consulta
    Given que o cache de "Prefeitura A" expirou
    When "Rui" e outro operador abrirem a saúde da "Prefeitura A" ao mesmo tempo
    Then as fontes devem ser consultadas uma única vez e as duas respostas devem ter o mesmo "generatedAt"

  Scenario: [Concorrência] O limite de IA é cruzado durante a leitura
    Given que a "Prefeitura A" cruza 100% do limite de IA enquanto "Rui" consulta
    When "Rui" abrir a saúde da "Prefeitura A"
    Then o bloco "ai" deve vir de um único instantâneo, com "usedTokens", "percentUsed" e "thresholdsReached" coerentes entre si

  Scenario: [Concorrência] Tenant muda de situação durante a leitura
    Given que a "Prefeitura A" é suspensa enquanto "Rui" consulta
    When "Rui" abrir a saúde da "Prefeitura A"
    Then a resposta deve refletir uma única situação do tenant, sem misturar blocos avaliados e "NOT_EVALUATED"

  Scenario: [Falha de banco] Banco principal indisponível
    Given que o banco de dados está indisponível
    When "Rui" abrir a Saúde da plataforma
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e "Retry-After"
    And a tela deve oferecer "Tentar novamente" e manter os filtros

  Scenario: [Falha de banco] Consulta de uma fonte estoura o tempo
    Given que a leitura de storage da "Prefeitura A" passa de 3 segundos
    When "Rui" abrir a saúde da "Prefeitura A"
    Then a API deve responder 200 com "meta.partial" verdadeiro
    And o bloco "storage" deve trazer "state" "UNAVAILABLE" e "errorCode" "SOURCE_TIMEOUT"
    And os blocos "queues", "ai" e "reconciliation" devem estar normais

  Scenario: [Falha de integração] Redis indisponível
    Given que o Redis está indisponível
    When "Rui" abrir a saúde da "Prefeitura A"
    Then o bloco "queues" deve trazer "state" "UNAVAILABLE" e os blocos "ai", "storage" e "reconciliation" devem estar disponíveis
    And deve ser registrado log "warn" "cache.unavailable"
    And a gravidade do tenant não deve ser "OK" se todos os blocos avaliáveis estiverem sem leitura

  Scenario: [Falha de integração] Fonte de IA indisponível
    Given que a leitura de consumo de IA falha com erro
    When "Rui" abrir a saúde da "Prefeitura A"
    Then o bloco "ai" deve trazer "state" "UNAVAILABLE" e "errorCode" "SOURCE_ERROR" sem mensagem de exceção
    And os demais blocos devem estar disponíveis

  Scenario: [Falha de integração] Reconciliação sem execução registrada
    Given que o job noturno do EP-028 nunca rodou para a "Prefeitura B"
    When "Rui" abrir a saúde da "Prefeitura B"
    Then o bloco "reconciliation" deve trazer "state" "NOT_AVAILABLE" e nenhum alerta
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Parâmetro inválido | 422 | `VALIDATION_ERROR` | "Filtro inválido." / "Informe um mês entre os últimos 12 meses." | Erro no campo |
| Sem permissão ou não é operador | 403 | `PERMISSION_DENIED` | "Você não tem permissão para ver a saúde da plataforma." | Oculta o menu; rota 403 |
| Sessão sem MFA | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para continuar." | Conduz ao passo de MFA |
| Tenant inexistente | 404 | `TENANT_NOT_FOUND` | "Órgão não encontrado." | Volta à lista |
| Muitas requisições | 429 | `RATE_LIMITED` | "Muitas consultas em pouco tempo. Aguarde alguns instantes." | Reabilita após `Retry-After` |
| Banco principal ou auditoria indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar a saúde agora. Tente novamente em instantes." | "Tentar novamente", filtros mantidos |
| Uma fonte indisponível | 200 | — (`meta.partial`, bloco `UNAVAILABLE`) | "Sem leitura. Tentar de novo." | Marca só o bloco afetado |

## Dependências
- **Stories:** US-085 (health checks, métricas e dashboards técnicos, `cf_dead_letter_jobs`, runbooks), US-116 (consumo e limites de IA: `ai.monthlyTokenLimit`, `AiGeneration`, faixas 80%/100%), US-178 (acesso ao backoffice, operador com MFA e navegação da SCR-123). Indiretas: US-083 (filas, dead-letter, Bull Board e CLI, RB-11), US-068 (uso de storage e quota), US-170/US-171 (read model e reconciliação do EP-028), US-099/US-100 (tenants, `SystemDbService`, papéis e RLS), US-073 (auditoria), US-179 (ciclo de vida, que usa a saúde para decidir), US-180 (acesso de suporte, o caminho para ver dado quando preciso).
- **Decisões/ADRs:** DEC-208, DEC-203, DEC-078, DEC-076, DEC-079, DEC-088, DEC-163, DEC-164, DEC-206; ADR-002, ADR-014; POL-29.
- **Configurações:** nenhuma chave de tenant. Variáveis de ambiente da plataforma (propostas): `PLATFORM_HEALTH_OUTBOX_WARN_SECONDS` (30), `PLATFORM_HEALTH_OUTBOX_CRITICAL_SECONDS` (300), `PLATFORM_HEALTH_DLQ_CRITICAL_COUNT` (10), `PLATFORM_HEALTH_RECONCILE_WARN_HOURS` (36), `PLATFORM_HEALTH_RECONCILE_CRITICAL_HOURS` (72), `PLATFORM_HEALTH_SOURCE_TIMEOUT_MS` (3000). Reusa `ai.monthlyTokenLimit`, `ai.enabled`, `ai.userDailyRequestLimit` e o limite técnico de storage da plataforma.
- **Lacunas nas fontes canônicas:**
  1. **Filas por tenant:** queues.md §15.2 expõe contagens por estado só por fila (sem tenant) e o BullMQ não indexa jobs por tenant; a FT-083 pede "filas e dead-letter" por tenant. Proposta (RN-PLAT-163): outbox por tenant (SQL) + dead-letter por tenant (contadores da plataforma mantidos pelo wrapper do worker e reconciliados no `maintenance`) e o estado de espera só no nível da plataforma. **Dúvida de produto:** isso atende a expectativa de "filas por tenant"?
  2. **Leitura entre tenants:** multi-tenancy.md §5.3 e a RN-TEN-28 dão a `cf_platform` apenas `tenants` e a auditoria de plataforma, com razões fechadas. São necessárias a razão `PLATFORM_HEALTH` e funções `SECURITY DEFINER` mínimas (nomes propostos: `cf_platform_ai_usage`, `cf_platform_storage_usage`, `cf_platform_outbox_health`, `cf_platform_reconciliation_status`), registradas em ADR-002/multi-tenancy.md §5.3 e §6 e no `system-prisma-allowlist`.
  3. **"Por órgão" × por tenant:** DEC-203 e a FT-083 falam em limite "por órgão"; `ai.monthlyTokenLimit` é `TenantSetting` (por tenant) e `AiGeneration` não tem `organizationId`. A saúde mostra por tenant; confirmar se o produto quer quebra por `Organization` (exigiria `organizationId` em `AiGeneration`).
  4. **Storage:** o limite de 50 GB é proposta (PEND-17, comercial, fora do MVP 2 — DEC-210); as fontes não definem evento ou notificação para os avisos de 80%/95% (só o log `storage.quota_threshold_reached`); esta story apenas lê. O nome da consulta de uso do módulo `files` também não está definido nas fontes.
  5. **Reconciliação:** `AnalyticsReconciliationRun` só existe com o EP-028; "não disponível" é detectado por ausência de execuções ou do módulo (sinal de ativação a definir). Os limites de 36 h e 72 h são proposta (a janela noturna é de 01:00 a 05:00 — RN-ANL-51). Não há indicador de defasagem da projeção por eventos (só da reconciliação).
  6. **Limites de gravidade:** A05, A06 e A08 são alertas de plataforma (taxa e idade); a transposição para "estoque por tenant" e os valores de Atenção e Crítico são proposta, parametrizável por ambiente.
  7. **Permissão nova e sessão de plataforma:** `PLATFORM_HEALTH_VIEW` está em permissions.md §8 do MVP 2, mas o mapeamento da claim `cf_platform_permissions` (US-083/US-178) e do grupo do Authentik precisa incluí-la; o catálogo de permissões de plataforma do MVP 1 (permissions.md §8) não a lista.
  8. **Auditoria `platform.health_view`:** events.md §7 só a nomeia (`ACCESS`); a janela de 15 min, a gravação no tenant e a visibilidade ao administrador (RN-PLAT-175) são proposta. **Dúvida de produto:** o administrador deve ver que um operador olhou os contadores do órgão, ou isso é ruído (o registro iria só à auditoria de plataforma)?
  9. **Cache:** "cache curto" não está especificado; propostos 30 s (tenant) e 60 s (visão geral, resumo e filas), com *single-flight*.
  10. **Bull Board:** o painel roda em porta interna do worker (queues.md §15.1), inalcançável pelo navegador do backoffice; o "atalho" é uma instrução de acesso (RB-11), não um link direto.
  11. **Tenants fora de `ACTIVE`:** a matriz de avaliação por situação (RN-PLAT-170) é proposta; as fontes só dizem que jobs de tenant fora de `ACTIVE` terminam sem efeito (RN-TEN-12).
  12. **Códigos e formatos novos fora de api.md:** `SOURCE_TIMEOUT` e `SOURCE_ERROR` (estado de bloco, não erro HTTP), `UNKNOWN` como gravidade, `meta.partial`, `meta.cached`.

## Impacto técnico
- **Performance:** meta p95 ≤ 1 s para a saúde de um tenant com cache quente e ≤ 2 s para a visão geral de 500 tenants (medidas na suíte de performance, no endurecimento); consultas agregadas por fonte para a página inteira (sem N+1), `statement_timeout` de 3 s por fonte, cache de 30/60 s com *single-flight* e funções com índices já existentes (`(tenant_id, created_at)` em `ai_generations`, `(tenant_id, status)` no outbox).
- **Segurança:** é a superfície em que o "backoffice não lê conteúdo" é mais fácil de violar por acidente; mitigada por funções `SECURITY DEFINER` numéricas, esquema de saída `strict`, teste de conteúdo com marcadores, teste de arquitetura e logs sem valores. Nenhum rótulo de métrica com `tenantId`.
- **Consistência:** cada bloco é lido em um instantâneo próprio e a resposta marca `measuredAt` por bloco; os blocos podem ter idades diferentes, e a tela mostra isso.
- **Compatibilidade:** nenhum endpoint do MVP 1 muda; `HLT-01..03`, Bull Board e CLI continuam como estão. As funções e contadores novos são aditivos.
- **Risco de interpretação:** "saudável" não significa "sem erro de processamento do órgão" (o backoffice não vê conteúdo); a tela diz isso no texto de apoio: "Indicadores técnicos de uso e processamento. Não mostram dados de processos nem de documentos."

## Backend
- **Módulo(s):** `platform` (consulta e composição, `PlatformCache`, contadores de dead-letter), `tenancy` (lista de tenants e situação, `SystemDbService`), `ai` (leitura de consumo e limites por porta), `files` (uso de storage por porta), `analytics` (situação da reconciliação por porta), `audit`; sem módulo de domínio novo (DEC-208).
- **Casos de uso:** `GetPlatformHealthSummaryQuery` (`PLT-22`), `ListTenantsHealthQuery` (`PLT-20`), `GetTenantHealthQuery` (`PLT-21`), `GetPlatformQueuesHealthQuery` (`PLT-23`), `GetTenantAiUsageHealthQuery` (`PLT-24`).
- **Domínio:** `HealthSeverityPolicy` (limites e regras de RN-PLAT-164/165/167/168/169/170), `HealthBlock<T>` (estado, gravidade, `measuredAt`, `stale`), `TenantHealthAssembler` (composição com falha parcial), `HealthResponseSchema` (esquema de saída `strict`), `DeadLetterTenantCounter` (incremento no wrapper do worker; reconciliação).
- **Integrações internas:** portas `AiUsageHealthPort`, `StorageUsageHealthPort`, `OutboxHealthPort`, `ReconciliationHealthPort` (cada uma chama uma função `SECURITY DEFINER` via `SystemDbService` com a razão `PLATFORM_HEALTH`), `QueueStatsReader` (snapshot de `getJobCounts` coletado pela réplica líder do relay — queues.md §15.2), `PlatformCache`, `AuditService`.
- **Transação:** consultas `READ ONLY` independentes por fonte, com `statement_timeout` de 3 s; a auditoria `platform.health_view` é uma escrita curta e separada (fora das leituras).

## Frontend
- **Tela(s):** SCR-123 — "Saúde" (`/plataforma/saude`), "Saúde do órgão" (`/plataforma/tenants/{id}/saude`) e "Filas da plataforma" (`/plataforma/saude/filas`), na área separada do backoffice.
- **Componentes:** `HealthSummaryCards`, `TenantHealthTable` (selo de gravidade por texto e ícone, valor-chave por indicador, ordenação), `HealthFilters`, `HealthBlockCard` (valores, `UsageBar` com texto "{x} % do limite", `StaleNotice`, estado "Sem leitura. Tentar de novo."), `AiUsageDetail` (`PLT-24`), `PlatformQueuesTable`, `BullBoardHint` (só com `PLATFORM_QUEUE_ADMIN`), `AutoRefreshToggle` (60 s, pausa com aba oculta), `DataAsOfBadge`.
- **Estados:** loading (skeleton), vazio ("Nenhum órgão com este filtro."), erro total com "Tentar novamente" e filtros mantidos, erro parcial por bloco, sucesso; estados de bloco "IA desligada", "Reconciliação ainda não disponível", "Não avaliado — órgão suspenso".
- **Acessibilidade e responsividade:** gravidade sempre por texto e ícone, nunca só por cor; barras de uso com `aria-valuenow` e texto; atualização automática anunciada por `aria-live="polite"` somente quando há mudança de gravidade; tabela rolável com cabeçalho fixo em telas largas e cartões abaixo de 768 px (uso de plantão, desktop-first); teclado completo nos filtros.

## Banco de dados
- **Tabelas:** nenhuma tabela nova. Leitura, por funções `SECURITY DEFINER`, de `ai_generations`, `tenant_settings` (somente as chaves `ai.enabled`, `ai.monthlyTokenLimit`, `ai.userDailyRequestLimit`), anexos e renditions (soma de bytes), `outbox_events` (contagem e idade por tenant) e `analytics_reconciliation_runs` (última execução); `tenants` (leitura direta pelo `cf_platform`). Contadores de dead-letter por tenant ficam no Redis da plataforma (chave `cf:{env}:p:dlq:tenant:{tenantId}`), com reconciliação diária.
- **Migrações:** migração de funções (aditiva e reversível): `cf_platform_ai_usage(tenant_ids uuid[], month_start timestamptz, month_end timestamptz)`, `cf_platform_storage_usage(tenant_ids uuid[])`, `cf_platform_outbox_health(tenant_ids uuid[])`, `cf_platform_reconciliation_status(tenant_ids uuid[])`, com `EXECUTE` só para `cf_platform` (nomes propostos — lacuna 2). Sem alteração de tabela de negócio.
- **Índices/constraints relevantes:** reaproveita `(tenant_id, created_at)` e `(tenant_id, status, expires_at)` de `ai_generations`, o índice de pendentes do outbox e `(tenant_id, started_at)` de `analytics_reconciliation_runs`; sem novo índice previsto (confirmar no plano de execução da suíte de performance).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `PLT-20` | GET | `/api/v1/platform/health/tenants` | `?status[]=&severity[]=&indicator=&q=&page=&pageSize=` | `200 { data: [{ tenant { id, slug, name, status }, severity, queues { state, severity, deadLetterTotal }, ai { state, severity, percentUsed }, storage { state, severity, percentUsed }, reconciliation { state, severity, lastFinishedAt } }], meta { page, pageSize, totalItems, generatedAt, cached, partial } }` | 200, 403, 422, 429, 503 |
| `PLT-21` | GET | `/api/v1/platform/tenants/{tenantId}/health` | — | `200 { data: { tenant { id, slug, name, status }, severity, queues { outbox { pendingCount, oldestPendingAgeSeconds, failedCount }, deadLetter { total, bySourceQueue } }, ai { enabled, limitTokens, usedTokens, reservedTokens, percentUsed, thresholdsReached[], userDailyRequestLimit, generationsByStatus }, storage { usedBytes, limitBytes, percentUsed, thresholdState }, reconciliation { lastRun { status, scope, startedAt, finishedAt, factsChecked, divergencesFixed } \| null } }, meta }`; cada bloco com `state`, `severity`, `measuredAt`, `stale`, `errorCode?` | 200, 403, 404, 429, 503 |
| `PLT-22` | GET | `/api/v1/platform/health/summary` | — | `200 { data: { tenantsByStatus, tenantsBySeverity, indicatorsInAlert { queues, ai, storage, reconciliation }, platformQueuesSeverity }, meta }` | 200, 403, 429, 503 |
| `PLT-23` | GET | `/api/v1/platform/health/queues` | — | `200 { data: { queues: [{ name, waiting, active, delayed, failed, oldestWaitingAgeSeconds, severity }], deadLetter { total, bySourceQueue }, schedulers: [{ name, lastSuccessAt, severity }], redis { queues, sessions, cache? }, breakers: [{ dependency, state }] }, meta }` | 200, 403, 429, 503 |
| `PLT-24` | GET | `/api/v1/platform/tenants/{tenantId}/health/ai` | `?month=YYYY-MM` | `200 { data: { month, enabled, limitTokens, usedTokens, reservedTokens, percentUsed, thresholdsReached: [{ threshold, reachedAt }], generationsByStatus }, meta }` | 200, 403, 404, 422, 429, 503 |

`state` de bloco ∈ `AVAILABLE`, `UNAVAILABLE`, `NOT_AVAILABLE`, `NOT_EVALUATED`; `severity` ∈ `OK`, `ATTENTION`, `CRITICAL` (nulo sem gravidade); a gravidade do tenant admite também `UNKNOWN`. Todas as rotas têm `x-tenant-scope = PLATFORM`, exigem operador + MFA + `PLATFORM_HEALTH_VIEW` e **não** recebem `X-Tenant-Id`.

## Logs
- `info` `platform.health.read` — `scope` (`OVERVIEW`, `SUMMARY`, `QUEUES`, `TENANT`, `AI`), `tenantsCount`, `durationMs`, `cached`, `partial`, `correlationId` (o `tenantId` só no escopo `TENANT`, como campo de log e nunca como rótulo de métrica).
- `warn` `platform.health.source_failed` — `source` (`queues`, `ai`, `storage`, `reconciliation`), `errorCode`, `durationMs`.
- `warn` `cache.unavailable` — padrão do `PlatformCache`.
- `info` `system_db.call` — `reason = PLATFORM_HEALTH`, `caller`, `outcome`, `durationMs`.
- `error` `platform.health.failed` — `errorCode`, `durationMs`.
- **Nunca logar:** valores de uso por tenant em nível `info` de alta cardinalidade, nomes de tenant, mensagens de exceção das fontes, conteúdo de qualquer recurso do tenant.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `platform.health_view` | `ACCESS` | Leitura de `PLT-21`/`PLT-24` (no tenant, `actorType = PLATFORM_OPERATOR`) e de `PLT-20`/`PLT-22`/`PLT-23` (auditoria de plataforma), no máximo 1×/operador/escopo/15 min | `metadata`: `scope` (`TENANT` ou `PLATFORM`), `blocks` consultados; sem valores |
| `access.denied` | `ACCESS` | 403 em `PLT-20..24` (auditoria de plataforma) | `reasonCode` = `PLATFORM_HEALTH_VIEW` (ou `MFA_REQUIRED`) |

## Testes necessários
- **Unitários:** `HealthSeverityPolicy` (cada limite, estados `NOT_AVAILABLE`/`NOT_EVALUATED`/`UNAVAILABLE`, gravidade do tenant e `UNKNOWN`); `TenantHealthAssembler` com falha parcial; cálculo de `percentUsed` (usado + reservado), mês civil no fuso do tenant e `stale`; coalescência da auditoria; esquema de saída `strict`.
- **Integração (Testcontainers PostgreSQL + Redis):** as funções `SECURITY DEFINER` (só colunas numéricas; `EXECUTE` só para `cf_platform`; `cf_platform` sem `SELECT` em tabelas de negócio); outbox pendente e `FAILED` por tenant; contadores de dead-letter e reconciliação; leitura em lote sem N+1; cache com *single-flight*; Redis fora; fonte lenta com tempo limite.
- **API/contrato:** `PLT-20..24` conforme o `api.md` do MVP 2 (formato dos blocos, `meta`, `partial`); códigos de erro; `x-tenant-scope = PLATFORM`.
- **RBAC e multi-tenant:** `PLATFORM_HEALTH_VIEW` + MFA + operador; administrador de tenant → 403; resposta de um tenant sem número de outro (suíte `test/tenant-leak` para as funções e as rotas); **teste de conteúdo** com marcadores em processo, documento, comentário e geração de IA ausentes em resposta, log e auditoria; **teste de arquitetura** (nenhum import de `process`, `document`, `collaboration`, `dfd`) e de autorização (nenhuma rota `/platform/*` devolve dado de processo ou documento).
- **Concorrência:** recarga simultânea do cache; limite de IA cruzado durante a leitura; mudança de situação do tenant durante a leitura; refresh do outbox.
- **E2E (Playwright):** abrir a Saúde, filtrar por "storage em alerta", abrir um tenant, ver o bloco parcial com o Redis desligado, abrir o detalhe de IA e as filas da plataforma.
- **Acessibilidade/performance:** axe nas três telas; teclado nos filtros; p95 ≤ 1 s (tenant) e ≤ 2 s (500 tenants) na suíte de performance (medida no endurecimento).

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
- [ ] Teste de conteúdo (marcadores) e teste de arquitetura verdes: nenhuma rota devolve conteúdo de tenant
- [ ] Teste de falha parcial verde: Redis, IA ou storage fora degradam só o indicador afetado
- [ ] Lacunas 1 e 2 registradas nas fontes canônicas (queues.md, multi-tenancy.md §5.3/§6, ADR-002)

## Estimativa
**M** — cinco endpoints de leitura, quatro fontes com funções de banco mínimas, composição com falha parcial, cache curto e três telas de consulta; o esforço está no isolamento (nada de conteúdo), nos limites de gravidade e nos contadores de dead-letter por tenant, não na complexidade de escrita.

## Prioridade
**P1** — a FT-083 promete detectar fila travada, limite de IA estourado e reconciliação atrasada antes do órgão reclamar; depende da US-178 e de US-085/US-116, não bloqueia as demais stories do épico e se torna mais valiosa a cada tenant novo.
