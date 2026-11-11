---
id: US-170
title: "Alimentar o read model de indicadores pelos eventos"
epic: EP-028
feature: FT-080
mvp: 2
priority: P1
estimate: L
status: Especificada
depends_on: [US-059, US-082, US-083]
modules: [analytics, process, pca, legal-review, internal-control, budget, workflow, catalog, access, platform]
screens: [SCR-041]
endpoints: [ANL-01]
permissions: [REPORT_VIEW, SETTINGS_MANAGE]
events: []
---

# US-170 — Alimentar o read model de indicadores pelos eventos

## Título
Projetar os eventos do outbox nas tabelas de fatos e nas visões materializadas do módulo `analytics`

## Descrição
**Como** administrador do órgão (`ADMIN_ORGAO`) e responsável pela operação da plataforma, **quero** que cada passagem de etapa, cada marco do processo e cada item do PCA sejam projetados, quase em tempo real, em tabelas de fatos próprias, com as durações já calculadas em dias úteis e descontadas as pausas de prazo, **para** que os relatórios e a análise de gargalos leiam números consistentes sem competir com a tramitação.

A story entrega a base do read model (DEC-206, [ADR-014](../adr/adr-014-indicators-read-model.md)): as migrações de `AnalyticsStageFact`, `AnalyticsProcessFact`, `AnalyticsPcaItemFact` e `AnalyticsProcessedEvent`; o consumidor `AnalyticsProjector` na fila `analytics` do worker; o `FactBuilder`, que recalcula os fatos a partir do estado atual das tabelas transacionais (a mesma rotina que a US-171 usa para reconciliar e reconstruir); as visões materializadas `mv_analytics_stage_monthly`, `mv_analytics_process_monthly` e `mv_analytics_pca_execution` com o job de refresh `CONCURRENTLY`; as funções `security definer` de leitura; e o endpoint `GET /analytics/status` (ANL-01), que informa a defasagem e a data da última atualização. As definições de cada indicador (início e fim do ciclo, devolução, cumprimento de prazo) são fixadas na US-172; esta story as implementa em código versionado (`INDICATOR_DEFINITION_VERSION`). Reconciliação, reconstrução e o pedido manual de reconstrução são da US-171; telas de relatório são das US-172 e US-173.

## Contexto
- O dashboard do MVP 1 (DEC-088) lê views transacionais com cache de 60 s e não serve a séries históricas. Varrer `ProcessStage`/`ProcessMovement` para responder "quanto, quando, por quem, com que atraso" disputa I/O com a tramitação (roadmap §4.10). A ADR-014 decide por fatos alimentados pelo outbox, reconstruíveis, com agregados em visões materializadas; os relatórios **nunca** leem `ProcessStage`/`ProcessMovement` em produção (RN-ANL-06).
- Os eventos já existem (MVP 1 e `events.md` do MVP 2 §4): `process.*`, `approval.*`, `document.*`, `pca.*`, `legal_review.*`, `internal_control_review.*`, `budget_allocation.*` e `workflow_migration.*`. O relay publica *at-least-once* (US-082, RN-FND-60) e o worker aplica retries e dead letter (US-083, RN-FND-62 a RN-FND-67); por isso o consumidor precisa ser idempotente e tolerar ordem trocada.
- Os payloads dos eventos carregam só ids e o mínimo necessário e **nunca** valores de orçamento sigiloso (events.md §1). O projetor, portanto, usa o evento como **gatilho** e relê o estado atual no tenant do evento (padrão do `EtpEstimateSynchronizer` e do `PcaExecutionTracker`). Evento atrasado, repetido ou fora de ordem converge para o mesmo fato.
- Valores de processos com orçamento sigiloso ficam gravados nos fatos, com a marca `isBudgetConfidential`; a leitura os exclui das somas e os devolve só a quem tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo (POL-09 estendida, POL-28; entities.md §4.11).
- Visões materializadas não têm RLS e são globais (todos os tenants na mesma visão): o acesso passa só por funções `security definer` que usam `app.tenant_id` da sessão, e `cf_app` não tem `SELECT` direto nelas (entities.md §4.11). O refresh, por isso, é um job de plataforma, não por tenant.
- Dias úteis seguem a DEC-031 (segunda a sexta, exceto `Holiday` do tenant, respeitando `calendar.optionalHolidaysAreNonBusiness`) e as pausas vêm de `ProcessStage.pausedTotalSeconds`, mantido pelo `SlaEvaluator` (DEC-205).

## Objetivo
Garantir que 100% dos eventos elegíveis do outbox virem fatos corretos e idempotentes, com defasagem p95 ≤ 5 min entre o evento e o dado exibido (meta medida na suíte de performance), que o reprocessamento do mesmo evento não altere nenhum fato, que a API enxergue apenas `SELECT` e funções de leitura, e que o administrador consiga ver quão atualizados estão os indicadores do órgão.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, com `SETTINGS_MANAGE`) — acompanha a saúde da projeção em Configurações gerais.
- **Secundárias:** Operação da plataforma (métricas, alertas e runbook); Gestor de contratações (`GESTOR_CONTRATACOES`), Controle Interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`) — consumidores indiretos, que leem "dados atualizados em ..." (ANL-01) nos relatórios com `REPORT_VIEW`.

## Pré-condições
- Outbox, relay e worker operando (US-082, US-083); fila `analytics` criada e assinada pelo fan-out (`DomainEventsProcessor`) para as routing keys do projetor.
- Papéis de banco `cf_worker` (leitura das tabelas transacionais e escrita nas tabelas do `analytics`) e `cf_app` (apenas `SELECT` nos fatos e `EXECUTE` nas funções de leitura) configurados.
- Migração do módulo aplicada; calendário do tenant (`Holiday`, `calendar.optionalHolidaysAreNonBusiness`, `tenant.timezone`) disponível.
- **ANL-01:** vínculo ativo, tenant `ACTIVE`; `REPORT_VIEW` ou `SETTINGS_MANAGE`.
- **Tenant já existente no MVP 1:** os fatos nascem vazios; os relatórios só são liberados depois da primeira execução `COMPLETED` do tipo `REBUILD` (US-171). Até lá, ANL-01 responde `state = NOT_INITIALIZED`.

## Fluxo principal
1. Um caso de uso do MVP 1 ou do MVP 2 muda o estado (ex.: encaminhar o processo, US-047) e grava o evento no `outbox_events` na mesma transação (DEC-161).
2. O relay publica o evento e o fan-out o enfileira na fila `analytics` com `jobId = eventId` (US-082, US-083); o `meta` do job traz `tenantId`, `correlationId` e `causationId` (DEC-164).
3. O `runJob` abre o contexto do tenant (`app.tenant_id`) e a transação; o `AnalyticsProjector` valida o envelope com o schema Zod do evento. Evento fora do mapa da RN-ANL-30 é confirmado sem efeito.
4. Dentro da transação, o projetor obtém um *advisory lock* de transação sobre `(tenant, agregado)` (RN-ANL-49), que serializa eventos concorrentes do mesmo processo.
5. Insere `(tenantId, eventId, eventType, processedAt)` em `analytics_processed_events`. Se a chave já existir, o evento é duplicado: a transação termina sem alterar fato (RN-ANL-31).
6. O `FactBuilder` resolve as chaves naturais afetadas (RN-ANL-30), lê o estado atual pelas portas de leitura dos módulos donos (`process`, `pca`, `legal-review`, `internal-control`, `catalog`) e calcula as colunas derivadas: dias úteis e corridos, pausas, devolução, atraso, marcos e contadores (RN-ANL-34 a RN-ANL-41).
7. Grava por *upsert* na chave natural (`processStageId`, `processId`, `pcaItemId`) apenas se alguma coluna mudou, atualizando `lastEventId` (o maior `eventId` já visto, sem regredir) e `projectedAt`; recalcula também o fato do item do PCA quando mudou algo que o alimenta.
8. Confirma a transação; registra a métrica de defasagem (`projectedAt − occurredAt`) e o log `analytics.event_projected`.
9. A cada 5 minutos o job `analytics-refresh` (plataforma) verifica se houve eventos processados (ou reconciliação concluída) depois do último refresh; se houve, atualiza as três visões com `REFRESH MATERIALIZED VIEW CONCURRENTLY`, uma de cada vez, e grava o resultado em `analytics_view_refreshes` com o `dataAsOf` (RN-ANL-43, RN-ANL-44).
10. O administrador abre **Configurações gerais** (SCR-041, `/admin/configuracoes`), bloco "Atualização dos indicadores"; o front chama `GET /api/v1/analytics/status` (ANL-01) e exibe "Dados atualizados em 11/11/2026 14:05", o estado da projeção e a última reconciliação.
11. Nos relatórios (US-172 e US-173), o gestor com `REPORT_VIEW` vê o mesmo `dataAsOf` no cabeçalho, vindo de `meta.dataAsOf` das próprias respostas; ANL-01 serve ao bloco administrativo e ao aviso de atraso.

## Fluxos alternativos
- **FA-01 — Evento repetido:** o relay reentrega o mesmo `eventId`; a chave de `analytics_processed_events` já existe, o job termina como sucesso silencioso e nenhum fato muda (RN-ANL-31, RN-ANL-02).
- **FA-02 — Evento fora de ordem ou atrasado:** `process.status_changed.completed` chega antes de `process.stage_changed.complete`; como o projetor relê o estado atual, ambos produzem o mesmo fato final e `lastEventId` guarda o maior `eventId` (RN-ANL-32).
- **FA-03 — Evento sem efeito:** `document.created.etp` ou `approval.reassigned` não alteram nenhuma coluna de fato; o projetor confirma sem gravar `analytics_processed_events` nem fato (RN-ANL-30).
- **FA-04 — Rascunho descartado:** `process.draft_discarded` mantém o fato do processo com `openedAt` nulo e `status = DRAFT`; ele nunca entra em relatório (RN-ANL-42). A reconciliação (US-171) remove o órfão.
- **FA-05 — Entidade não encontrada ao reler:** o processo foi removido entre o commit e a leitura (rascunho eliminado); o projetor registra `analytics.source_missing` e conclui sem erro, pois a chave natural não tem mais origem.
- **FA-06 — Banco indisponível:** a transação é desfeita (nem `analytics_processed_events` nem fato são gravados), o erro é transitório e o job volta com backoff (RN-ANL-46).
- **FA-07 — Evento inválido:** payload fora do schema ou sem `processId`/`tenantId` onde obrigatório é erro permanente (`UnrecoverableError`) e vai para a `dead-letter` com alerta (RN-ANL-46).
- **FA-08 — Refresh em curso:** uma execução do job que encontra outra em andamento termina como `skipped` (RN-FND-68); o `dataAsOf` não avança.
- **FA-09 — Falha do refresh de uma visão:** a visão anterior continua legível (`CONCURRENTLY` não bloqueia nem apaga); a falha é registrada, o `dataAsOf` não avança e o alerta é emitido depois de dois ciclos seguidos com falha.
- **FA-10 — Projetor atrasado:** `now − dataAsOf` acima de 10 minutos faz ANL-01 responder `state = DELAYED`; os relatórios continuam respondendo, com `meta.stale = true` (US-172, RN-ANL-82).
- **FA-11 — Tenant sem carga inicial:** ANL-01 responde `state = NOT_INITIALIZED` e `lastReconciliation = null` até a primeira reconstrução completa (US-171); os eventos continuam sendo projetados nesse intervalo.
- **FA-12 — Mudança de calendário ou de definição:** `HolidayChanged` e a troca de `INDICATOR_DEFINITION_VERSION` não são eventos do projetor; os fatos já gravados só se alinham na reconciliação noturna ou na reconstrução (RN-ANL-48; ver lacuna 6).

## Regras de negócio
- **RN-ANL-01** — Só o worker escreve nas tabelas de fatos; a API (`cf_app`) tem apenas `SELECT` e as visões são lidas só por funções `security definer` com o tenant da sessão (DEC-206, ADR-014). *(regra da feature, adotada)*
- **RN-ANL-02** — A projeção é idempotente por `eventId` e por chave natural; evento repetido ou fora de ordem não altera o resultado (ADR-014). *(regra da feature, adotada)*
- **RN-ANL-03** — Os fatos não têm chave estrangeira para tabelas transacionais; sobrevivem a rascunho descartado e a reconstrução não trava a tramitação (entities.md §4.11). *(regra da feature, adotada)*
- **RN-ANL-04** — Durações em dias úteis e corridos, descontadas as pausas de SLA, calculadas uma vez no fechamento da passagem (DEC-206, DEC-205). *(regra da feature, adotada)*
- **RN-ANL-05** — Valores de processos com orçamento sigiloso ficam gravados; as somas das visões os excluem e a soma deles entra em coluna separada (DEC-206, DEC-030, POL-09). *(regra da feature, adotada)*
- **RN-ANL-06** — Relatórios nunca consultam `ProcessStage`/`ProcessMovement` em produção; só o read model (DEC-206). A leitura dessas tabelas é exclusiva do projetor e da reconciliação, no worker. *(regra da feature, adotada)*
- **RN-ANL-09** — Defasagem-alvo de até 5 minutos, com a data da última atualização exposta (DEC-206). *(regra da feature, adotada)*
- **RN-ANL-10** — O refresh das visões usa `CONCURRENTLY`, com meta de duração monitorada (ADR-014). *(regra da feature, adotada)*
- **RN-ANL-30** — Mapa de consumo. O `AnalyticsProjector` assina `process.*`, `approval.*`, `document.*`, `pca.*`, `legal_review.*`, `internal_control_review.*`, `budget_allocation.*` e `workflow_migration.*` (events.md §3) e age assim: (a) `process.*` e `approval.*` — recalcula o processo do envelope (fato do processo e todos os seus fatos de passagem, RN-ANL-33) e, se mudou campo que alimenta o item do PCA, o fato do item vinculado (e o do `previousPcaItemId` em `process.pca_item_linked`); (b) `document.approved.dfd` — recalcula o processo (`dfdApprovedAt`); os demais `document.*` não têm efeito; (c) `pca.item_changed` — recalcula o item de `pcaItemId`; `pca.status_changed.*` — recalcula, em lotes de 500, todos os itens do `pcaId`; os demais `pca.*` não têm efeito; (d) `legal_review.*` e `internal_control_review.*` — recalcula o processo (desfecho e marcos); `legal_review.assigned`, `internal_control_review.finding_*` e `internal_control_review.checklist_published` não têm efeito; (e) `budget_allocation.*` e `workflow_migration.*` — nenhum fato os usa hoje: são confirmados sem efeito, salvo `process.workflow_migrated` (em `process.*`) (ver lacuna 4).
- **RN-ANL-31** — Idempotência por evento: a linha em `analytics_processed_events (tenant_id, eventId)` é inserida **na mesma transação** que grava o fato; conflito de chave significa evento já projetado e encerra o job sem efeito. A tabela é purgada após 30 dias pelo job `maintenance`; depois disso, a proteção contra repetição passa a ser a convergência da RN-ANL-32.
- **RN-ANL-32** — Projeção por estado atual: o evento só diz **o que** recalcular; o valor gravado é sempre o do estado transacional lido no momento (leitura `READ COMMITTED`, após o commit que originou o evento). `lastEventId` guarda o maior `eventId` (UUIDv7, ordenável no tempo) já aplicado ao fato e nunca regride; `projectedAt` registra o instante da gravação. Fato inalterado não é regravado (sem `UPDATE` vazio).
- **RN-ANL-33** — Unidade de recálculo: o processo inteiro (fato do processo + todos os fatos de passagem) numa só transação, porque `returnsCount`, `overdueStagesCount`, `currentStageKeys` e `cycleTimeBusinessDays` dependem do conjunto. Passagem que deixou de existir na origem (migração) é removida do fato na mesma transação.
- **RN-ANL-34** — Dias úteis: `businessDaysBetween(a, b)` soma, para cada data do fuso do tenant que seja dia útil (DEC-031), a fração do dia coberta por `[a, b]` (segundos cobertos ÷ 86.400), com 2 casas decimais. Dias corridos: `(b − a)` em dias com 2 casas. Ambos são 0 quando `b ≤ a`.
- **RN-ANL-35** — Pausas: `pausedSeconds = ProcessStage.pausedTotalSeconds` (mais `now − pausedAt` se a pausa ainda estiver aberta no fechamento). A duração em dias úteis da passagem é `businessDaysBetween(enteredAt, exitedAt) × (1 − pausedSeconds ÷ segundosDecorridos)`, limitada a ≥ 0, e a em dias corridos é calculada igual. O desconto é proporcional porque a origem guarda o total de pausa, não os intervalos (lacuna 2).
- **RN-ANL-36** — Atraso: na passagem fechada, `wasOverdue = (exitedAt > dueAt)` com `dueAt` já estendido pelas pausas (DEC-031, DEC-205) e `overdueBusinessDays = businessDaysBetween(dueAt, exitedAt)` (nulo se `dueAt` é nulo ou `wasOverdue` é falso). Passagem aberta com `process.stage_overdue` recebido passa a `wasOverdue = true`; os valores finais são recalculados no fechamento.
- **RN-ANL-37** — Demais colunas da passagem: `returnedFrom = true` quando a passagem foi aberta por movimentação `RETURN` ou `APPROVAL_RETURNED` (via `enteredViaMovementId`); `exitStatus` copia `ProcessStage.status` ao fechar (`COMPLETED`, `RETURNED`, `CANCELED`, `MIGRATED`, `SKIPPED`); durações só para `COMPLETED` e `RETURNED` (nulas nas demais); `assigneeId` é o responsável ao fechar (ou o último com `ProcessAssignment.endedAt`); `departmentId`, `branchKey`, `stageKey`, `stageType`, `workflowVersionId`, `slaPolicyId` e `escalationLevelReached` copiados da passagem; `organizationId`, `requestingSecretariatId`, `modalityCode` e `contractingTypeCode` copiados do processo (códigos dos itens de catálogo, nunca ids).
- **RN-ANL-38** — Fato do processo: `openedAt`, `completedAt`, `canceledAt`, `status`, `year`, `code`, `workflowVersionId`, `pcaItemId`, `pcaStatus`, `isBudgetConfidential` e `estimatedValue` copiados do processo; `dfdApprovedAt` = instante da aprovação do DFD (`document.approved.dfd`); `planningCompletedAt` = saída `COMPLETED` da etapa `APROVACAO_AUTORIDADE`; `legalConcludedAt`/`legalOutcome` e `internalControlOutcome` = da última análise concluída ou dispensada; `cycleTimeBusinessDays` conforme a RN-ANL-71 (só para processo `COMPLETED`); `currentStageKeys` = chaves das passagens `ACTIVE`.
- **RN-ANL-39** — Contadores do processo: `returnsCount` = passagens com `exitStatus = RETURNED`; `overdueStagesCount` = passagens com `wasOverdue = true`; `migrationsCount` = passagens com `exitStatus = MIGRATED`. Todos derivados dos fatos de passagem, nunca de somas incrementais.
- **RN-ANL-40** — Sigilo na gravação: o valor de processo sigiloso é gravado como qualquer outro, com `isBudgetConfidential = true`; a decisão de mostrar ou somar é da leitura (US-172, US-173). O fato nunca copia título, objeto, descrição nem texto livre do processo, e nenhum valor entra em log, métrica ou evento (POL-09, DEC-138).
- **RN-ANL-41** — Fato do item do PCA: `plannedValue`, `plannedMonth`, `status`, `year`, `code`, `departmentId`, `categoryCode` copiados do item; `linkedProcessesCount` = processos com `pcaItemId` do item, `openedAt` preenchido e `status <> CANCELED`; `completedProcessesCount` = os de `status = COMPLETED`; `firstProcessOpenedAt` = menor `openedAt` entre os vinculados; `linkedEstimatedValue` = soma de `estimatedValue` dos vinculados **não sigilosos** (a soma dos sigilosos depende de coluna nova, lacuna 3).
- **RN-ANL-42** — Rascunho descartado (`process.draft_discarded`) e processo sem `openedAt` não entram em nenhum agregado nem detalhamento; o fato pode existir com `status = DRAFT` até a reconciliação.
- **RN-ANL-43** — Visões e refresh: `mv_analytics_stage_monthly`, `mv_analytics_process_monthly` e `mv_analytics_pca_execution` têm índice único completo nas chaves do recorte (exigência do `CONCURRENTLY`). O job `analytics-refresh` roda a cada 5 minutos por *Job Scheduler* (RN-FND-68), faz o refresh de uma visão por vez e só se houver evento processado ou reconciliação/reconstrução concluída (US-171) depois do último refresh; `statement_timeout` de 10 minutos por visão e meta de duração ≤ 5 min. A agenda é fixa e não desliga fora do pico, pois a meta de defasagem exige o ciclo contínuo; a carga é controlada pelo `CONCURRENTLY` e pelo refresh condicionado.
- **RN-ANL-44** — `dataAsOf` = o menor entre (a) o início do último refresh bem-sucedido e (b) o instante de enfileiramento do evento mais antigo ainda não projetado na fila `analytics`; assim o número exibido afirma só o que já está nos agregados. É gravado em `analytics_view_refreshes` (plataforma, sem `tenant_id`) e exposto a todos os tenants igualmente, por ser um instante global.
- **RN-ANL-45** — ANL-01 exige `REPORT_VIEW` **ou** `SETTINGS_MANAGE`. Com `REPORT_VIEW` apenas, devolve `state`, `dataAsOf` e `lagSeconds`; com `SETTINGS_MANAGE`, devolve ainda `lastReconciliation` (resumo da última execução do tenant) e `rebuild` (execução em curso). `state` é `OK` (≤ 10 min), `DELAYED` (> 10 min) ou `NOT_INITIALIZED` (sem reconstrução completa do tenant). Nenhum campo traz contagem de eventos pendentes de outros tenants.
- **RN-ANL-46** — Classificação de erro (RN-FND-66): banco ou Redis fora e *deadlock* são transitórios (retry com backoff padrão, 5 tentativas); `23505` em `analytics_processed_events` é duplicidade esperada (sucesso silencioso); payload inválido, `eventVersion` desconhecida e erro de cálculo determinístico são permanentes e vão para a `dead-letter`. Fila `analytics` com concorrência por réplica configurável e limitador por tenant para não monopolizar o worker.
- **RN-ANL-47** — O projetor roda no papel `cf_worker` com `app.tenant_id` do `meta` do job; job sem `tenantId` é rejeitado (DEC-164). Toda leitura de origem é feita por portas de leitura dos módulos donos (D1), nunca por SQL direto do `analytics` em tabela alheia.
- **RN-ANL-48** — Definição versionada: `INDICATOR_DEFINITION_VERSION` (constante em `packages/types`) identifica as regras das RN-ANL-34 a RN-ANL-41 e RN-ANL-71 a RN-ANL-76. Mudar qualquer uma exige elevar a versão e executar a reconstrução (US-171); o deploy sozinho não regrava fatos antigos.
- **RN-ANL-49** — Concorrência: o *advisory lock* de transação usa a chave `hash(tenantId, processId)` (ou `hash(tenantId, pcaItemId)` nos eventos de PCA); dois eventos do mesmo agregado são aplicados em série, sempre sobre o estado mais recente. O lock não toca linhas transacionais e é liberado no fim da transação.

## Campos
Não há formulário. Entradas e saídas da story:

| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| *(entrada)* Identificador do evento | `eventId` | uuid (UUIDv7) | Sim | Chave de idempotência (RN-ANL-31) | envelope do evento |
| *(entrada)* Tenant | `tenantId` | uuid | Sim | Contexto do job e RLS (RN-ANL-47) | `meta` do job |
| *(entrada)* Tipo e chave de roteamento | `eventType`, `routingKey` | texto | Sim | Mapa da RN-ANL-30 | envelope |
| *(entrada)* Processo | `processId` | uuid | Condicional | Obrigatório em `process.*`, `approval.*`, `legal_review.*`, `internal_control_review.*`, `document.approved.dfd` | envelope |
| *(saída)* Estado da atualização | `state` | `OK` \| `DELAYED` \| `NOT_INITIALIZED` | — | RN-ANL-45 | derivado |
| Dados atualizados em | `dataAsOf` | timestamptz (ISO 8601) | — | RN-ANL-44 | `analytics_view_refreshes` |
| Defasagem | `lagSeconds` | inteiro | — | `now − dataAsOf` | derivado |
| Último refresh das visões | `lastViewRefreshAt` | timestamptz | — | Fim do último refresh bem-sucedido | `analytics_view_refreshes` |
| Última reconciliação | `lastReconciliation { runId, scope, status, finishedAt, factsChecked, divergencesFixed }` | objeto ou nulo | — | Só com `SETTINGS_MANAGE` (RN-ANL-45) | `AnalyticsReconciliationRun` |
| Reconstrução em curso | `rebuild { active, runId? }` | objeto | — | Só com `SETTINGS_MANAGE` | `AnalyticsReconciliationRun` |
| Versão da definição | `definitionVersion` | inteiro | — | `INDICATOR_DEFINITION_VERSION` | código |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Envelope do evento fora do schema Zod (campo ausente ou tipo incorreto) | Worker | — (alerta operacional; sem mensagem a usuário) | `EVENT_PAYLOAD_INVALID` (permanente, `dead-letter`) |
| V-02 | `eventVersion` não suportada pelo projetor | Worker | — | `EVENT_VERSION_UNSUPPORTED` (permanente) |
| V-03 | Job sem `tenantId` ou com tenant inexistente | Worker | — | `TENANT_CONTEXT_MISSING` (permanente) |
| V-04 | Parâmetro de consulta desconhecido em ANL-01 | API (Zod) | "Consulta inválida." | `VALIDATION_ERROR` |
| V-05 | Chamador sem `REPORT_VIEW` nem `SETTINGS_MANAGE` | API | "Você não tem permissão para esta ação." | `PERMISSION_DENIED` |
| V-06 | Colunas derivadas inconsistentes (ex.: `exitedAt < enteredAt`, duração negativa) | Worker (invariante do `FactBuilder`) | — | `ANALYTICS_FACT_INVARIANT` (permanente; o fato não é gravado) |

## Permissões
- **Permissão:** projeção e refresh não têm permissão de usuário (papel `cf_worker`). ANL-01: `REPORT_VIEW` (risco `L`) ou `SETTINGS_MANAGE` (risco `H`), com escopo `TENANT` do vínculo para esta leitura administrativa.
- **Políticas:** POL-28 (relatórios e sigilo — o status não traz valores nem processos), POL-09 (nenhum valor sigiloso em log, métrica ou evento), POL-14 (MFA).
- **MFA:** ANL-01 é leitura e não exige MFA, inclusive para `SETTINGS_MANAGE` (a exigência por risco `H` vale para as ações de escrita desta feature, na US-171).
- **Sem permissão:** o bloco "Atualização dos indicadores" não aparece em SCR-041 sem `SETTINGS_MANAGE`; a API responde 403 `PERMISSION_DENIED` e grava `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Esta story **consome** eventos e não produz nenhum. `AnalyticsReconciliationCompleted` é da US-171. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação a usuário. Projetor atrasado, falha de refresh e entrada na `dead-letter` geram **alerta operacional** (observability.md §10), não notificação. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Alimentar o read model de indicadores pelos eventos

  Background:
    Given que o tenant "Prefeitura A" está ativo com o módulo de indicadores inicializado
    And a secretaria "Saúde" tem o processo "0012/2026" na etapa "ESTUDOS_PRELIMINARES" (ETP), aberto em 02/11/2026
    And "Marta" tem o perfil "ADMIN_ORGAO" com "SETTINGS_MANAGE" e "Gil" tem o perfil "GESTOR_CONTRATACOES" com "REPORT_VIEW"
    And o calendário do tenant tem feriado em 12/11/2026

  Scenario: [Sucesso] Encaminhamento vira passagem de etapa com dias úteis
    When o processo "0012/2026" for encaminhado de "ESTUDOS_PRELIMINARES" para "PESQUISA_PRECOS" em 17/11/2026
    And o evento "ProcessStageChanged" for projetado
    Then deve existir uma passagem em "AnalyticsStageFact" com "stageKey" "ESTUDOS_PRELIMINARES", "exitStatus" "COMPLETED" e "durationBusinessDays" igual aos dias úteis do período, sem contar o feriado e os fins de semana
    And a nova passagem "PESQUISA_PRECOS" deve existir aberta, com "exitedAt" nulo e durações nulas
    And "lastEventId" do fato do processo deve ser o "eventId" do evento
    And a defasagem registrada deve ser "projectedAt" menos "occurredAt"

  Scenario: [Sucesso] Devolução marca a passagem e abre a seguinte como retorno
    Given que o processo está na etapa "PESQUISA_PRECOS"
    When o processo for devolvido para "ESTUDOS_PRELIMINARES"
    Then a passagem de "PESQUISA_PRECOS" deve ficar com "exitStatus" "RETURNED"
    And a nova passagem de "ESTUDOS_PRELIMINARES" deve ter "returnedFrom" verdadeiro
    And "returnsCount" do fato do processo deve ser 1

  Scenario: [Sucesso] Pausa de prazo é descontada da duração
    Given que a passagem "JURIDICO" ficou 10 dias corridos entre entrada e saída, com 4 dias corridos de pausa por diligência
    When o evento "ProcessStageChanged" da saída for projetado
    Then "pausedSeconds" deve ser 345600
    And "durationCalendarDays" deve ser 6,00
    And "durationBusinessDays" deve ser os dias úteis do período multiplicados por 0,60

  Scenario: [Sucesso] Prazo vencido na saída
    Given que a passagem tinha "dueAt" em 10/11/2026
    When ela for concluída em 13/11/2026
    Then "wasOverdue" deve ser verdadeiro e "overdueBusinessDays" os dias úteis entre 10/11 e 13/11 sem o feriado
    And "overdueStagesCount" do fato do processo deve ser 1

  Scenario: [Sucesso] Marcos e tempo de ciclo do processo concluído
    Given que o DFD foi aprovado, a etapa "APROVACAO_AUTORIDADE" foi concluída, o parecer jurídico "FAVORABLE" e a manifestação do Controle Interno "COMPLETED" foram emitidos
    When o processo for concluído
    Then o fato do processo deve ter "dfdApprovedAt", "planningCompletedAt", "legalOutcome" "FAVORABLE", "internalControlOutcome" e "completedAt" preenchidos
    And "cycleTimeBusinessDays" deve seguir a definição versionada da RN-ANL-71

  Scenario: [Sucesso] Orçamento sigiloso fica gravado e fora das somas
    Given que o processo "0014/2026" da secretaria "Saúde" tem "isBudgetConfidential" verdadeiro e "estimatedValue" de "1200000.00"
    When o evento "ProcessConfidentialityChanged" e o refresh das visões forem concluídos
    Then "AnalyticsProcessFact" deve ter "isBudgetConfidential" verdadeiro e o valor gravado
    And a linha de "mv_analytics_process_monthly" não deve incluir o valor na coluna de valor visível
    And o valor deve constar na coluna separada de valor sigiloso
    And nenhum log, métrica ou evento deve conter o valor

  Scenario: [Sucesso] Vínculo com o PCA atualiza o item antigo e o novo
    Given que o processo "0012/2026" está vinculado ao item "PCA-2026-014"
    When o processo for revinculado ao item "PCA-2026-021" (evento "ProcessPcaItemLinked" com "previousPcaItemId")
    Then "linkedProcessesCount" do item "PCA-2026-014" deve diminuir em 1 e o do item "PCA-2026-021" aumentar em 1
    And os dois fatos devem ser gravados na mesma transação

  Scenario: [Sucesso] Refresh condicionado e data da última atualização
    Given que houve eventos processados depois do último refresh
    When o job "analytics-refresh" rodar
    Then as três visões devem ser atualizadas com "CONCURRENTLY", uma por vez
    And "analytics_view_refreshes" deve registrar duração e "dataAsOf"
    When o job rodar de novo sem novos eventos
    Then nenhuma visão deve ser atualizada e "dataAsOf" deve avançar para o início da verificação

  Scenario: [Sucesso] Status para o administrador e para o gestor
    When "Marta" chamar "GET /analytics/status"
    Then a API deve responder 200 com "state" "OK", "dataAsOf", "lagSeconds", "lastReconciliation" e "rebuild"
    When "Gil" chamar "GET /analytics/status"
    Then a API deve responder 200 apenas com "state", "dataAsOf", "lagSeconds" e "definitionVersion"

  Scenario: [Sucesso] Projetor atrasado é sinalizado
    Given que o último refresh bem-sucedido começou há 14 minutos
    When "Marta" chamar "GET /analytics/status"
    Then a API deve responder 200 com "state" "DELAYED" e "lagSeconds" acima de 600

  Scenario: [Sucesso] Tenant ainda sem carga inicial
    Given que o tenant "Prefeitura C" não tem nenhuma execução "REBUILD" concluída
    When "Marta" da "Prefeitura C" chamar "GET /analytics/status"
    Then a API deve responder 200 com "state" "NOT_INITIALIZED" e "lastReconciliation" nulo

  Scenario: [Validação] Evento inválido não vira fato
    Given que chega um evento "ProcessStageChanged" sem "processId" e sem "toStage"
    When o projetor processar o job
    Then o job deve falhar como permanente com "EVENT_PAYLOAD_INVALID" e ir para a "dead-letter"
    And nenhum fato nem linha de "analytics_processed_events" deve ser gravado
    And deve ser emitido o alerta de job na "dead-letter"
    When "Marta" chamar "GET /analytics/status?tenant=outro"
    Then a API deve responder 422 com código "VALIDATION_ERROR"

  Scenario: [Permissão] Status só para quem pode ver relatórios ou administrar
    Given que "Paulo" não tem "REPORT_VIEW" nem "SETTINGS_MANAGE"
    When "Paulo" chamar "GET /analytics/status"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar auditoria "access.denied"
    Given que o papel "cf_app" tenta "INSERT" ou "UPDATE" em "analytics_stage_facts" e "SELECT" direto em "mv_analytics_process_monthly"
    Then o banco deve negar os três comandos

  Scenario: [Tenant incorreto] Evento de um tenant não toca fatos de outro
    Given que o evento "ProcessStatusChanged" do processo "0031/2026" pertence à "Prefeitura B"
    When o projetor processar o job com o "tenantId" da "Prefeitura B"
    Then apenas os fatos da "Prefeitura B" devem mudar
    And os fatos da "Prefeitura A" devem permanecer idênticos
    Given que um job chega sem "tenantId"
    Then o job deve ser rejeitado com "TENANT_CONTEXT_MISSING"
    When "Marta" da "Prefeitura A" chamar a função de leitura das visões com o tenant da sessão
    Then nenhuma linha da "Prefeitura B" deve ser devolvida

  Scenario: [Duplicidade] Mesmo evento entregue duas vezes
    Given que o evento "E1" já foi projetado
    When o relay entregar o evento "E1" de novo
    Then o job deve terminar com sucesso sem alterar nenhum fato
    And "projectedAt" e "lastEventId" não devem mudar

  Scenario: [Duplicidade] Evento fora de ordem converge para o mesmo fato
    Given que "ProcessStatusChanged" (conclusão) chega antes de "ProcessStageChanged" (última etapa)
    When os dois forem projetados
    Then o fato do processo e o da última passagem devem ficar idênticos aos de quando chegam em ordem
    And "lastEventId" deve ser o maior "eventId" entre os dois

  Scenario: [Concorrência] Dois eventos do mesmo processo ao mesmo tempo
    When dois eventos do processo "0012/2026" forem projetados por duas réplicas do worker simultaneamente
    Then o segundo deve aguardar o lock de transação do primeiro
    And o fato final deve refletir o estado atual do processo, sem perda de atualização

  Scenario: [Concorrência] Refresh simultâneo
    Given que o job "analytics-refresh" está atualizando "mv_analytics_stage_monthly"
    When outra réplica iniciar o job
    Then a segunda execução deve terminar como "skipped"
    And as leituras por "cf_app" durante o refresh devem continuar devolvendo a versão anterior

  Scenario: [Falha de banco] Transação desfeita e reprocessada
    Given que o banco fica indisponível depois da leitura do estado e antes do commit
    When o projetor processar o evento
    Then a transação deve ser desfeita sem gravar "analytics_processed_events" nem fato
    And o job deve voltar à fila com backoff
    When o banco voltar e o job for reprocessado
    Then o fato deve ser gravado uma única vez

  Scenario: [Falha de banco] Refresh que falha mantém a versão anterior
    Given que o refresh de "mv_analytics_process_monthly" falha por tempo esgotado
    Then a visão deve continuar legível com os dados anteriores
    And "dataAsOf" não deve avançar e o alerta deve sair depois de dois ciclos com falha
    And "GET /analytics/status" deve passar a "DELAYED" quando "lagSeconds" passar de 600

  Scenario: [Falha de integração] Redis ou fila indisponível
    Given que o Redis está indisponível e o relay não consegue enfileirar eventos
    When os casos de uso continuarem gravando eventos no outbox
    Then os eventos devem ficar "PENDING" sem perda e sem duplicidade visível
    And "GET /analytics/status" deve passar a "DELAYED"
    When o Redis voltar
    Then os eventos devem ser projetados em ordem de chegada e o estado deve voltar a "OK"

  Scenario: [Sucesso] Meta de desempenho (suíte de performance)
    Given um tenant com 50.000 processos e 600.000 passagens e uma carga de 20 eventos por segundo
    When a suíte de performance medir "projectedAt" menos "occurredAt"
    Then o p95 da defasagem do projetor deve ser de até 60 segundos
    And o p95 de "dataAsOf" até a hora da leitura deve ser de até 5 minutos
    And o refresh de cada visão deve levar até 5 minutos
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta o bloco; mensagem se acessado por link |
| Parâmetro desconhecido | 422 | `VALIDATION_ERROR` | "Consulta inválida." | Recarrega sem parâmetros |
| Banco ou Redis indisponível ao ler o status | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível consultar a atualização dos indicadores agora. Tente novamente em instantes." | Mostra o bloco em erro com "Tentar novamente"; respeita `Retry-After` |
| Evento inválido (worker) | — | `EVENT_PAYLOAD_INVALID` | — | Sem UI; alerta e `dead-letter` |
| Fato inconsistente (worker) | — | `ANALYTICS_FACT_INVARIANT` | — | Sem UI; alerta; a reconciliação mostra a divergência |

## Dependências
- **Stories:** US-059 (projeção na timeline: padrão de projetor por evento e catálogo de eventos de processo), US-082 (outbox e relay *at-least-once*), US-083 (worker, filas, retries e *dead letter*). Indiretas: US-055 (prazos e atraso), US-106 (calendário útil), US-123/US-124 (passagens paralelas), US-130 (etapas da v2), US-144 (execução do PCA), US-149/US-159 (desfechos do jurídico e do Controle Interno).
- **Decisões/ADRs:** DEC-024, DEC-030, DEC-031, DEC-088, DEC-160 a DEC-164, DEC-194, DEC-197, DEC-205, DEC-206, ADR-004, ADR-014.
- **Configurações:** `calendar.optionalHolidaysAreNonBusiness`, `tenant.timezone`; `analytics.fiscalYearStartMonth` (usada na US-172).
- **Lacunas nas fontes canônicas:**
  1. **Controle do refresh das visões e `dataAsOf`:** entities.md §4.11 não prevê onde guardar o resultado do refresh. Proposta: tabela de plataforma `analytics_view_refreshes` (`id`, `viewName`, `startedAt`, `finishedAt`, `status` `COMPLETED`/`FAILED`/`SKIPPED`, `durationMs`, `rowsCount`, `dataAsOf`), sem `tenant_id` e sem RLS, legível só por função `security definer`. **Acrescentar à §4.11.**
  2. **Intervalos de pausa:** `ProcessStage` guarda só `pausedAt` e `pausedTotalSeconds`; sem os intervalos, o desconto em dias úteis é proporcional (RN-ANL-35) e, em ramos paralelos, pausas simultâneas podem ser descontadas em duplicidade no ciclo (RN-ANL-71). Alternativa: tabela de intervalos de pausa no módulo `sla`. **Dúvida de produto/arquitetura; validar a precisão com o piloto.**
  3. **Soma sigilosa no item do PCA:** `AnalyticsPcaItemFact.linkedEstimatedValue` é, nesta story, a soma dos vinculados não sigilosos (a leitura precisa da parcela sigilosa para quem tem a permissão). Proposta: coluna `linkedConfidentialValue numeric(18,2)` (e `linkedConfidentialCount int`) em `analytics_pca_item_facts`. **Ajuste em entities.md §4.11 e alinhamento com a US-175.**
  4. **Assinaturas sem efeito:** `budget_allocation.*` e `workflow_migration.*` constam no projetor (events.md §3), mas nenhum fato usa dotação ou plano de migração. Proposta: manter a assinatura (custo desprezível, confirmada sem efeito) ou removê-la; só a execução por processo (`process.workflow_migrated`) altera fatos. **Decidir com a equipe; ajuste em events.md §3 se removida.**
  5. **Chaves das visões:** `mv_analytics_stage_monthly` não traz secretaria solicitante, modalidade nem tipo de contratação, e `mv_analytics_process_monthly` não traz tipo de contratação; sem elas, devoluções e prazo por secretaria e o filtro por tipo de contratação (FT-081) não saem das visões. Proposta: acrescentar `requesting_secretariat_id`, `modality_code` e `contracting_type_code` à chave da visão de passagens e `contracting_type_code` à de processos, com medidas aditivas (somas e contagens, além de mediana e p90 mensais). **Ajuste em entities.md §4.11.**
  6. **Calendário e definição:** `HolidayChanged` (US-106) e a troca de versão da definição não disparam recálculo; só a reconciliação noturna corrige. Proposta: aceitar o intervalo de até 24 h e exibir a data da última reconciliação em ANL-01.
  7. **Permissão do status:** não há permissão própria para o bloco administrativo; usa-se `SETTINGS_MANAGE`, como a feature indica. **Confirmar; alternativa: permissão `ANALYTICS_MANAGE` (risco `H`).**
  8. **Local do bloco administrativo:** não há tela de administração do read model entre as 41; usa-se um bloco em SCR-041 (`/admin/configuracoes`). **Incluir US-170/US-171 na linha de SCR-041 em features.md.**
  9. **Códigos e métricas novos a consolidar no card de API/observabilidade:** `EVENT_PAYLOAD_INVALID`, `EVENT_VERSION_UNSUPPORTED`, `TENANT_CONTEXT_MISSING`, `ANALYTICS_FACT_INVARIANT`; métricas `cf_analytics_projection_lag_seconds`, `cf_analytics_events_projected_total{result}`, `cf_analytics_view_refresh_duration_seconds{view}`, `cf_analytics_view_age_seconds` e alertas de defasagem (> 10 min) e de refresh com falha em dois ciclos.

## Impacto técnico
- Maior peça de infraestrutura do épico: nova fila (`analytics`), consumidor com tratamento de ordem trocada e repetição, quatro tabelas, três visões, funções `security definer` e um job de plataforma; por isso a estimativa **L**.
- O projetor lê tabelas transacionais (só `SELECT`, `READ COMMITTED`, no tenant do evento) e, por D1, o faz por portas de leitura dos módulos donos; o recálculo do processo inteiro (RN-ANL-33) custa uma consulta por processo, de ordem de dezenas de linhas, e é a unidade que a suíte de performance mede.
- O desconto de pausas é aproximado (RN-ANL-35): é determinístico e reproduzível pela reconstrução, mas não exato para pausas que atravessam fins de semana; fica registrado na lacuna 2.
- Visões materializadas são globais: um refresh serve a todos os tenants. O custo cresce com o volume total; o critério de revisão da ADR-014 (refresh > 5 min) leva ao particionamento por exercício.
- O `analytics_processed_events` cresce com o volume de eventos e tem retenção de 30 dias; índice `(processed_at)` para a purga e para a verificação de "há evento depois do último refresh".
- Compatibilidade: nenhuma rota do MVP 1 muda; eventos não mudam (`eventVersion = 1`). Fatos novos nascem vazios nos tenants existentes e dependem da carga inicial da US-171.

## Backend
- **Módulo(s):** `analytics` (dono), com portas de leitura em `process`, `pca`, `legal-review`, `internal-control` e `catalog` (calendário); `platform` (fila, *Job Scheduler*, `dead-letter`).
- **Casos de uso:** `ProjectDomainEventCommand` (consumidor `AnalyticsProjector`), `RefreshAnalyticsViewsCommand` (job `analytics-refresh`), `PurgeAnalyticsProcessedEventsCommand` (job `maintenance`), `GetAnalyticsStatusQuery` (ANL-01).
- **Domínio:** `FactBuilder` (`buildProcessFacts`, `buildPcaItemFact`), `BusinessCalendar.businessDaysBetween`, `PauseDiscount`, `StageFactCalculator`, `ProcessFactCalculator`, `IndicatorDefinitions` (versão e constantes), `EventToKeysMapper`.
- **Integrações internas:** `ProcessFactSource`, `PcaFactSource`, `LegalReviewFactSource`, `InternalControlFactSource`, `CalendarFactSource` (portas implementadas pelos módulos donos); `OutboxWriter` não é usado (a story não produz evento).
- **Transação:** um evento = uma transação do tenant (lock → `analytics_processed_events` → leitura de origem → *upsert* dos fatos); refresh = comando de plataforma fora de transação de tenant.

## Frontend
- **Tela(s):** SCR-041 (`/admin/configuracoes`), bloco "Atualização dos indicadores". O cabeçalho "Dados atualizados em ..." das telas SCR-027 e SCR-028 é entregue nas US-172 e US-173.
- **Componentes:** `AnalyticsStatusCard` (data da última atualização, selo de estado `OK`/`DELAYED`/`NOT_INITIALIZED`, última reconciliação), `AnalyticsFreshnessBadge` (reutilizado pelos relatórios).
- **Estados:** loading (skeleton), erro com "Tentar novamente", `NOT_INITIALIZED` ("Os indicadores deste órgão ainda estão sendo preparados. Isso pode levar algumas horas."), `DELAYED` ("Os indicadores estão atrasados. Os números mostram a situação de {dataAsOf}."), sucesso.
- **Acessibilidade e responsividade:** o estado usa texto e ícone, nunca só cor; `aria-live="polite"` na mudança de estado; data legível por leitor de tela ("11 de novembro de 2026, 14h05"); cartão em coluna única abaixo de 768 px.

## Banco de dados
- **Tabelas:** `analytics_stage_facts`, `analytics_process_facts`, `analytics_pca_item_facts`, `analytics_processed_events` (todas com `tenant_id` e RLS `FORCE`), `analytics_view_refreshes` (plataforma); visões `mv_analytics_stage_monthly`, `mv_analytics_process_monthly`, `mv_analytics_pca_execution`.
- **Migrações:** M2 do módulo `analytics` com as tabelas e índices de entities.md §4.11 (sem FK para tabelas transacionais), as visões com índices únicos, `cf_apply_tenant_rls`, as funções `analytics_read_stage_monthly`, `analytics_read_process_monthly`, `analytics_read_pca_execution` e `analytics_data_as_of` (todas `security definer`, `search_path` fixo, usando `current_setting('app.tenant_id')` e recusando sessão sem tenant), `GRANT SELECT` nas tabelas de fatos e `EXECUTE` nas funções a `cf_app`, `GRANT` de escrita a `cf_worker`, `REVOKE` de acesso direto às visões.
- **Índices/constraints relevantes:** PKs `(tenant_id, process_stage_id)`, `(tenant_id, process_id)`, `(tenant_id, pca_item_id)` e `(tenant_id, event_id)`; os índices de entities.md §4.11; `analytics_processed_events (processed_at)`; índice único de cada visão em `(tenant_id, …chaves do recorte)`, com `COALESCE` nas chaves anuláveis (`modality_code`, `contracting_type_code`); `CHECK (exited_at IS NULL OR exited_at >= entered_at)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `ANL-01` | GET | `/api/v1/analytics/status` | sem parâmetros | `200 { data: { state, dataAsOf, lagSeconds, lastViewRefreshAt, definitionVersion, lastReconciliation?, rebuild? } }` (os dois últimos só com `SETTINGS_MANAGE`) | 200, 403, 422, 503 |

## Logs
- `info` `analytics.event_projected` — `eventId`, `eventType`, `processId?`, `factsWritten`, `lagMs`, `durationMs`, `correlationId`.
- `debug` `analytics.event_skipped_duplicate` — `eventId`; `debug` `analytics.event_ignored` — `eventType`.
- `info` `analytics.view_refresh_completed` — `viewName`, `durationMs`, `rowsCount`, `dataAsOf`; `info` `analytics.view_refresh_skipped` — `reason`.
- `warn` `analytics.projector_lag_high` — `lagSeconds`; `warn` `analytics.source_missing` — `processId`, `eventType`; `warn` `analytics.view_refresh_failed` — `viewName`, `errorClass`.
- `error` `analytics.projection_failed` — `eventId`, `errorClass`, `permanent`, `attempt`.
- **Nunca logar:** `estimatedValue`, título, objeto, descrição, nomes de pessoas, conteúdo de payload de evento além dos ids.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `access.denied` | `ACCESS` | 403 em ANL-01 | `reasonCode`, `route` |

A projeção, o refresh e a leitura do status não geram auditoria própria (são operação do sistema, sem alteração de dado de negócio); a trilha de reconstrução (`analytics.rebuild`) é da US-171.

## Testes necessários
- **Unitários:** `businessDaysBetween` (fim de semana, feriado, `optionalHolidaysAreNonBusiness`, fuso, intervalo no mesmo dia, fração de dia); `PauseDiscount`; `StageFactCalculator` (cada `exitStatus`, `returnedFrom`, atraso na saída, `dueAt` nulo); `ProcessFactCalculator` (marcos, contadores, ciclo, `currentStageKeys`); `EventToKeysMapper` (cada família de evento da RN-ANL-30); classificação de erro (RN-ANL-46).
- **Integração (Testcontainers):** ciclo completo evento → fato com o outbox real; idempotência por `eventId`; fora de ordem (permutações dos eventos de um processo dão o mesmo fato); concorrência com *advisory lock*; rollback sem gravar `analytics_processed_events`; migração de workflow (passagens `MIGRATED`); vínculo do PCA (item antigo e novo); refresh `CONCURRENTLY` com leitura simultânea; `GRANT`/`REVOKE` (`cf_app` não escreve nem lê a visão direto).
- **API/contrato:** ANL-01 por perfil (campos presentes/ausentes), `state` nos três casos, 403, 422 e 503.
- **RBAC e multi-tenant:** teste novo na suíte `test/tenant-leak`: fatos, visões (via função) e ANL-01 nunca mostram outro tenant; job sem `tenantId`; teste de arquitetura de que nenhum módulo de leitura (`analytics` na API) importa tabelas de `process`.
- **Concorrência:** dois workers no mesmo processo; dois refreshes; reentrega simultânea do mesmo `eventId`.
- **E2E (Playwright):** encaminhar um processo, aguardar o ciclo de projeção e refresh de teste e ver "Dados atualizados em ..." avançar em SCR-041; estado `DELAYED` simulado.
- **Acessibilidade/performance:** axe no bloco de SCR-041; metas de defasagem e de duração do refresh na suíte de performance (medidas no endurecimento, nunca no card).

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
- [ ] Teste prova que reentrega e permutação de eventos não alteram nenhum fato
- [ ] Teste prova que `cf_app` só lê fatos e só executa as funções de leitura das visões
- [ ] Teste prova que nenhum valor sigiloso aparece em log, métrica ou evento
- [ ] Meta de defasagem e de duração do refresh registrada como teste da suíte de performance
- [ ] Lacunas 1 a 9 resolvidas ou registradas nas fontes canônicas (entities, events, observability)

## Estimativa
**L** — quatro tabelas, três visões e funções de leitura com `security definer`; consumidor com ordem trocada, repetição e serialização por agregado; cálculo de dias úteis com pausas; job de refresh; portas de leitura em cinco módulos; testes de convergência e de isolamento.

## Prioridade
**P1** — sem os fatos não há relatório, gargalo, exportação nem cumprimento de prazo por etapa (DEC-205); é pré-requisito de todo o épico EP-028, mas não bloqueia a tramitação do MVP 2.
