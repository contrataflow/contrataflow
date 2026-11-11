---
id: US-171
title: "Reconstruir e reconciliar o read model"
epic: EP-028
feature: FT-080
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-170]
modules: [analytics, process, pca, legal-review, internal-control, catalog, access, audit, platform]
screens: [SCR-041]
endpoints: [ANL-02, ANL-03, ANL-04]
permissions: [SETTINGS_MANAGE]
events: [AnalyticsReconciliationCompleted]
---

# US-171 — Reconstruir e reconciliar o read model

## Título
Reconciliar os fatos contra as tabelas transacionais toda noite e reconstruir o read model do órgão sob demanda

## Descrição
**Como** administrador do órgão (`ADMIN_ORGAO`) e responsável pela operação da plataforma, **quero** que os fatos de indicadores sejam conferidos todas as noites contra os dados transacionais, com as divergências corrigidas e relatadas, e poder pedir a reconstrução completa ou de um período depois de uma mudança de definição, **para** confiar nos números dos relatórios mesmo quando um evento se perde, chega fora de ordem ou a definição de um indicador muda.

A story entrega: a rotina única `ReconcileTenantFacts`, que recalcula cada fato com o mesmo `FactBuilder` do projetor (US-170), compara com o gravado e corrige; a **reconciliação noturna** por tenant, fora do horário de uso; a **reconstrução** total ou por período (ANL-02) com acompanhamento (ANL-03); o **histórico** das execuções e das divergências corrigidas (ANL-04); a **carga inicial** dos tenants que já existiam no MVP 1; a publicação de `AnalyticsReconciliationCompleted`; e o bloco "Reconstruir indicadores" na tela de Configurações gerais (SCR-041). A projeção por evento e as visões materializadas são da US-170; os relatórios que dependem dos fatos corrigidos são das US-172 e US-173.

## Contexto
- A projeção por eventos tem defasagem e pode falhar: evento perdido além da retenção de 30 dias de `analytics_processed_events`, mudança de calendário (`HolidayChanged`) sem recálculo, correção de dados feita direto no banco, bug de uma versão anterior do projetor. A ADR-014 resolve com reconciliação noturna por tenant e a mesma rotina para reconstruir depois de mudança de definição de indicador (RN-ANL-07, RN-ANL-08).
- Os fatos não têm chave estrangeira para as tabelas transacionais (RN-ANL-03): a reconstrução recalcula e regrava sem travar a tramitação, e o fato de rascunho descartado pode sobreviver até a reconciliação removê-lo (US-170, RN-ANL-42).
- A reconciliação **lê** `ProcessStage`, `ProcessMovement` e demais origens porque é a fonte da verdade que o read model replica; essa leitura acontece só no worker, por portas dos módulos donos (D1), e nunca nos relatórios (RN-ANL-06).
- `AnalyticsReconciliationRun` guarda `scope` (`NIGHTLY` ou `REBUILD`), `status` (`RUNNING`, `COMPLETED`, `FAILED`), `factsChecked`, `divergencesFixed` e `divergenceSample` (até 50 chaves, **sem valores**), com unicidade de uma execução `RUNNING` por tenant (entities.md §4.11). `AnalyticsReconciliationCompleted` (`runId`, `scope`, `factsChecked`, `divergencesFixed`) é publicado ao fim e consumido só por métricas (events.md §4.10).
- A ação de auditoria `analytics.rebuild` (categoria `SYSTEM`) está no catálogo (events.md §7). A permissão que autoriza a reconstrução manual não está definida nas fontes: a feature indica `SETTINGS_MANAGE` como candidata, e é a que esta story adota (lacuna 1).
- Mudar uma definição de indicador (início do ciclo, devolução, cumprimento de prazo) exige reconstrução (RN-ANL-48): a versão sobe em `INDICATOR_DEFINITION_VERSION` e a reconstrução alinha os fatos antigos. Metas da feature: ≤ 0,1% de fatos corrigidos por noite e nenhuma divergência sem explicação.

## Objetivo
Garantir que 100% dos tenants ativos sejam reconciliados toda noite, fora do horário de uso e sem travar a tramitação, que cada divergência seja corrigida e contada sem expor valores, que uma reconstrução total ou por período possa ser pedida e acompanhada por quem administra o órgão, e que haja no máximo uma execução em andamento por tenant.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, com `SETTINGS_MANAGE`) — pede a reconstrução e lê o histórico em Configurações gerais.
- **Secundárias:** Operação da plataforma (alertas de divergência, runbook de reconstrução); Gestor de contratações (`GESTOR_CONTRATACOES`), Controle Interno e Auditor — beneficiários, pois leem números corrigidos.

## Pré-condições
- US-170 entregue: fatos, `FactBuilder`, fila `analytics`, visões e job `analytics-refresh`.
- Tenant `ACTIVE`; worker com papel `cf_worker` e *Job Scheduler* ativo (RN-FND-68).
- **Pedido manual (ANL-02):** usuário autenticado, vínculo `ACTIVE`, `SETTINGS_MANAGE` com escopo `TENANT`, sessão com MFA conforme `security.mfaPolicy` (`SETTINGS_MANAGE` é risco `H`: exige MFA nas políticas `ADMINS` e `ALL`, POL-14).
- **Consulta (ANL-03, ANL-04):** `SETTINGS_MANAGE` com escopo `TENANT`.
- Nenhuma execução `RUNNING` do tenant (índice único); no máximo duas reconstruções `FULL` por tenant em 24 h (RN-ANL-65).

## Fluxo principal
**Reconciliação noturna**
1. O *Job Scheduler* `analytics-reconcile-nightly` dispara na janela das 01:00 às 05:00 do fuso do tenant e enfileira um job por tenant ativo, espalhado na janela pelo hash do `tenantId` (RN-ANL-51).
2. O worker abre o contexto do tenant e tenta criar a `AnalyticsReconciliationRun` (`scope = NIGHTLY`, `status = RUNNING`, `startedAt`); se o índice único recusar, a execução termina como `skipped`.
3. O `ReconcileTenantFacts` percorre os processos por cursor de id em lotes de 500 (RN-ANL-52). Para cada lote, lê a origem em transação `READ ONLY`, recalcula os fatos esperados com o `FactBuilder` e compara com os gravados.
4. Para cada divergência, corrige (insere, atualiza ou, só no caso permitido, remove) e soma em `divergencesFixed`; acrescenta até 50 chaves, sem valores, a `divergenceSample` (RN-ANL-53, RN-ANL-55). Fato que o projetor gravou depois da leitura do lote não é sobrescrito (RN-ANL-54).
5. Depois dos processos, percorre os itens do PCA do tenant e confere os fatos de execução (RN-ANL-41 da US-170).
6. Ao fim, grava `finishedAt`, `status = COMPLETED`, `factsChecked` e `divergencesFixed`, dispara o refresh imediato das visões, publica `AnalyticsReconciliationCompleted` pelo outbox e emite as métricas; se a proporção corrigida passar do limite, emite o alerta (RN-ANL-56, RN-ANL-61, RN-ANL-62).

**Reconstrução manual**
7. Em SCR-041, no bloco "Reconstruir indicadores", o administrador vê a data da última atualização (ANL-01) e o histórico recente e aciona **"Reconstruir"**.
8. O diálogo pede o **Escopo** ("Tudo" ou "Período"), as datas quando for período e o **Motivo**, e avisa: "A reconstrução recalcula os indicadores a partir dos processos do órgão. Pode levar de alguns minutos a algumas horas. Os relatórios continuam disponíveis com os dados atuais enquanto isso."
9. O front envia `POST /api/v1/analytics/rebuilds` (ANL-02) com `Idempotency-Key` e o corpo `{ mode, from?, to?, reason }`.
10. A API valida o corpo, a permissão e o MFA; em uma transação, trava a verificação de execução em curso, insere a `AnalyticsReconciliationRun` (`scope = REBUILD`, `RUNNING`, parâmetros, solicitante), grava a auditoria `analytics.rebuild` (fase `REQUESTED`) e enfileira o job `analytics-rebuild` na fila `analytics`; responde **202** com a execução e o cabeçalho `Location`.
11. O worker executa a mesma rotina da noite no escopo pedido, com checkpoint por lote (RN-ANL-59), atualiza `factsChecked` a cada lote e, ao concluir, repete o fim da reconciliação (passo 6) com `scope = REBUILD`.
12. O front consulta `GET /api/v1/analytics/rebuilds/{id}` (ANL-03) a cada 10 s (com recuo) e mostra "Reconstrução em andamento: 12.400 fatos verificados". Ao concluir: "Reconstrução concluída: 38.120 fatos verificados, 312 corrigidos." e o bloco de status volta a `OK`.
13. O histórico (ANL-04) lista as execuções (`NIGHTLY` e `REBUILD`) com situação, duração, fatos verificados, divergências corrigidas e a amostra de chaves.

**Carga inicial**
14. Na ativação do módulo e no provisionamento de tenant novo (US-099), o job `analytics-bootstrap` enfileira uma reconstrução `FULL` (`REBUILD`, solicitante `SYSTEM`) para todo tenant sem execução `REBUILD` concluída. Até concluir, ANL-01 mostra `NOT_INITIALIZED` e os relatórios ficam indisponíveis (US-172, RN-ANL-83).

## Fluxos alternativos
- **FA-01 — Reconstrução já em andamento:** ANL-02 responde 409 `ANALYTICS_REBUILD_IN_PROGRESS` com o `runId` e o início da execução; o diálogo oferece "Acompanhar" (RN-ANL-58).
- **FA-02 — Reconciliação noturna encontra execução em andamento:** termina como `skipped`, sem criar execução nem alertar (RN-ANL-51).
- **FA-03 — Reconstrução por período:** só processos com `openedAt` no intervalo (e os de `openedAt` nulo), suas passagens e os itens do PCA dos exercícios envolvidos; fora disso, nada é tocado (RN-ANL-57).
- **FA-04 — Worker reiniciado no meio:** o job volta pelo retry do BullMQ e retoma do último cursor gravado, sem refazer lotes concluídos (RN-ANL-59).
- **FA-05 — Retries esgotados:** a execução vai a `FAILED` com `errorMessage` curto e sem detalhes internos; o índice único é liberado, o alerta sai e o administrador pode pedir de novo.
- **FA-06 — Execução esquecida em `RUNNING`:** o *watchdog* do `maintenance` marca como `FAILED` ("Execução interrompida") a que passa de 6 h sem job ativo na fila (RN-ANL-58).
- **FA-07 — Órfãos demais:** mais de 5% ou mais de 1.000 fatos órfãos removíveis num único run indicam leitura errada da origem; a execução termina `FAILED` sem apagar nada (RN-ANL-60).
- **FA-08 — Definição de indicador mudou:** a primeira reconciliação noturna depois do deploy se comporta como reconstrução (corrige tudo, sem alerta de proporção) e grava a nova versão da definição em `parameters` (RN-ANL-67).
- **FA-09 — Divergência acima do limite:** a execução conclui normalmente e o alerta operacional informa a proporção; não há notificação a usuário (events.md §4.10).
- **FA-10 — Relatórios durante a reconstrução:** as visões continuam as anteriores até o refresh final; o detalhamento (lido dos fatos) pode mostrar processos já recalculados e outros ainda não, cada um íntegro (RN-ANL-61).
- **FA-11 — Pedido repetido:** o mesmo `Idempotency-Key` com o mesmo corpo devolve a mesma execução (`Idempotent-Replayed: true`); corpo diferente responde 422 `IDEMPOTENCY_KEY_REUSED`.
- **FA-12 — Sem permissão administrativa:** o bloco "Reconstruir indicadores" não aparece; o gestor vê apenas a data da última atualização (US-170).
- **FA-13 — Limite de reconstruções totais:** a terceira `FULL` em 24 h responde 429 `RATE_LIMITED` com `Retry-After` (RN-ANL-65).

## Regras de negócio
- **RN-ANL-03** — Sem FK para tabelas transacionais: o fato sobrevive ao rascunho descartado e a reconstrução não trava a tramitação (entities.md §4.11). *(regra da feature, adotada)*
- **RN-ANL-07** — O job noturno reconcilia fatos × tabelas transacionais por tenant, fora do horário de uso, e há no máximo uma execução `RUNNING` por tenant (DEC-206, ADR-014). *(regra da feature, adotada)*
- **RN-ANL-08** — A reconstrução é a mesma rotina da reconciliação e roda depois de mudança de definição de indicador, auditada como `analytics.rebuild` (ADR-014). *(regra da feature, adotada)*
- **RN-ANL-50** — Rotina única: `ReconcileTenantFacts(mode, window)` serve a `NIGHTLY` (todos os fatos) e a `REBUILD` (`FULL` ou `PERIOD`) e usa o **mesmo** `FactBuilder` do projetor; nenhum cálculo de indicador é duplicado. Origem lida só por portas de leitura dos módulos donos, em `READ ONLY`.
- **RN-ANL-51** — Agenda noturna: janela de 01:00 a 05:00 no fuso do tenant; um job por tenant ativo, distribuído pelo hash do `tenantId`; tenant `SUSPENDED` ou inativo não é reconciliado; execução em andamento bloqueia a próxima, que conclui como `skipped` (RN-FND-68).
- **RN-ANL-52** — Lotes: 500 processos por lote por cursor de id; cada lote tem leitura própria (`statement_timeout` de 30 s, `lock_timeout` de 2 s, sem trava nas tabelas transacionais) e gravação própria; pausa de 200 ms entre lotes e no máximo uma reconciliação por réplica do worker, para não competir com o projetor.
- **RN-ANL-53** — Divergência é toda diferença entre o fato esperado e o gravado em qualquer coluna, exceto `lastEventId` e `projectedAt`. Tipos: `MISSING` (esperado e inexistente — inserir), `STALE` (diferente — atualizar), `ORPHAN` (gravado sem origem e com `openedAt` nulo — remover) e `ORPHAN_KEPT` (gravado sem origem mas com `openedAt` preenchido — **não** remover, só relatar, por ser anomalia a investigar). `divergencesFixed` conta `MISSING`, `STALE` e `ORPHAN`; `factsChecked` conta fatos de processo, de passagem e de item do PCA comparados.
- **RN-ANL-54** — Corrida com o projetor: o lote guarda o instante `readStartedAt` da leitura da origem e só grava fato cujo `projectedAt ≤ readStartedAt`; se o projetor gravou depois, o fato dele é mais novo e fica (não conta como divergência). A gravação preserva `lastEventId` e só atualiza `projectedAt`.
- **RN-ANL-55** — `divergenceSample` guarda no máximo 50 itens `{ table, key, kind, columns[] }`, na ordem de descoberta, com a chave natural (`processId`, `processStageId` ou `pcaItemId`) e os **nomes** das colunas divergentes; nunca valores, títulos nem nomes de pessoas. Só `SETTINGS_MANAGE` lê a amostra.
- **RN-ANL-56** — Limites operacionais da `NIGHTLY` (proposta a validar com o piloto): proporção `divergencesFixed ÷ factsChecked` acima de 0,1% gera alerta de aviso e acima de 1% alerta crítico (observability.md §10); `FAILED` e `ORPHAN_KEPT` sempre alertam. `REBUILD` e a `NIGHTLY` com mudança de definição (RN-ANL-67) não alertam por proporção.
- **RN-ANL-57** — `REBUILD` por `mode`: `FULL` recalcula todo o tenant; `PERIOD` recalcula processos com `openedAt` em `[from, to]` (mais os de `openedAt` nulo), suas passagens e os itens do PCA cujo `year` está nos anos do intervalo. `from ≤ to ≤ hoje` e intervalo de até 5 anos. Remoção de órfãos só ocorre dentro do escopo.
- **RN-ANL-58** — Uma `AnalyticsReconciliationRun` `RUNNING` por tenant (índice único); `NIGHTLY` e `REBUILD` competem pela mesma vaga. O pedido manual com vaga ocupada responde 409. O *watchdog* marca `FAILED` a execução `RUNNING` há mais de 6 h cujo job não está ativo na fila.
- **RN-ANL-59** — Retomada: o job guarda o cursor (`lastProcessId`) e a fase (`PROCESSES`, `PCA_ITEMS`) em `parameters` a cada lote; o retry continua dali e a rotina é idempotente (reprocessar um lote não muda fato já correto).
- **RN-ANL-60** — Trava de segurança de exclusão: se os órfãos removíveis excederem 5% dos fatos examinados ou 1.000, a execução falha com `errorMessage` "Quantidade anormal de fatos sem origem." e **nada** é removido, evitando apagar fatos por leitura da origem em tenant ou janela errados.
- **RN-ANL-61** — Fim da execução, em ordem: (a) grava `COMPLETED`, `finishedAt`, contagens e amostra; (b) pede o refresh imediato das visões (US-170, RN-ANL-43); (c) publica `AnalyticsReconciliationCompleted` com `runId`, `scope`, `factsChecked` e `divergencesFixed` (mesma transação do passo a); (d) emite métricas. Falha não publica o evento.
- **RN-ANL-62** — Evento e auditoria: `AnalyticsReconciliationCompleted` é publicado nas duas modalidades (`analytics.reconciliation_completed`); a auditoria `analytics.rebuild` é gravada **só nas reconstruções**: no pedido (ator = quem pediu, `metadata.phase = REQUESTED`) e no fim (ator `SYSTEM`, `metadata.phase = COMPLETED` ou `FAILED`); a reconciliação noturna fica registrada no histórico da execução, sem auditoria própria (lacuna 3).
- **RN-ANL-63** — Permissão e MFA: ANL-02, ANL-03 e ANL-04 exigem `SETTINGS_MANAGE` com escopo `TENANT`; ANL-02 exige MFA nas políticas `ADMINS` e `ALL` (POL-14); a carga inicial e a reconciliação noturna rodam como `SYSTEM`, sem sessão.
- **RN-ANL-64** — Pedido: `reason` de 10 a 300 caracteres, obrigatório e gravado só na auditoria (nunca em log); `Idempotency-Key` obrigatório (24 h, DEC-105); resposta 202 com `Location: /api/v1/analytics/rebuilds/{id}`.
- **RN-ANL-65** — Limite de custo: no máximo duas reconstruções `FULL` por tenant em 24 h (`RATE_LIMITED`, 429, com `Retry-After`); `PERIOD` não tem limite além da vaga única.
- **RN-ANL-66** — Histórico: as execuções ficam 400 dias (job `maintenance` purga as mais antigas); ANL-04 pagina por cursor, ordem `startedAt` decrescente, com filtros `scope`, `status` e período; `errorMessage` é texto padronizado em pt-BR, sem detalhe técnico, SQL ou nome de tabela.
- **RN-ANL-67** — Mudança de definição: se `INDICATOR_DEFINITION_VERSION` do código difere da gravada em `parameters.definitionVersion` da última execução `COMPLETED`, a próxima `NIGHTLY` é marcada `parameters.definitionChanged = true`, processa tudo e não alerta por proporção; toda execução grava a versão aplicada.
- **RN-ANL-68** — Carga inicial: o job `analytics-bootstrap` enfileira `REBUILD FULL` por tenant sem `REBUILD` concluído (solicitante `SYSTEM`, motivo "Carga inicial"); roda uma vez por tenant e é idempotente pela vaga única.
- **RN-ANL-69** — Isolamento: `analytics_reconciliation_runs` tem `tenant_id` e RLS; toda leitura e escrita da rotina usa `app.tenant_id` do tenant da execução; execução de outro tenant, ou id inexistente, responde 404.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Escopo | `mode` | `FULL` \| `PERIOD` | Sim | RN-ANL-57 | `FULL` |
| De | `from` | data (AAAA-MM-DD) | Condicional | Obrigatório em `PERIOD`; ≤ `to` | — |
| Até | `to` | data (AAAA-MM-DD) | Condicional | Obrigatório em `PERIOD`; ≤ hoje; intervalo ≤ 5 anos | — |
| Motivo | `reason` | texto | Sim | 10 a 300 caracteres após trim (RN-ANL-64) | — |
| Chave de idempotência | `Idempotency-Key` | texto | Sim | 24 h | gerada pelo front |
| Tipo (filtro do histórico) | `scope[]` | `NIGHTLY` \| `REBUILD` | Não | multi | todos |
| Situação (filtro) | `status[]` | `RUNNING` \| `COMPLETED` \| `FAILED` | Não | multi | todas |
| Período (filtro) | `startedFrom`, `startedTo` | datas | Não | `startedFrom ≤ startedTo` | 90 dias |
| Paginação | `cursor`, `limit` | texto, inteiro | Não | `limit` 1–100, padrão 20 | servidor |
| *(saída)* Execução | `id` | uuid | — | — | servidor |
| *(saída)* Tipo | `scope` | `NIGHTLY` \| `REBUILD` | — | — | execução |
| *(saída)* Situação | `status` | `RUNNING` \| `COMPLETED` \| `FAILED` | — | — | execução |
| *(saída)* Início e fim | `startedAt`, `finishedAt` | timestamptz | — | `finishedAt` nulo em `RUNNING` | execução |
| *(saída)* Fatos verificados | `factsChecked` | inteiro | — | cresce por lote durante a execução | execução |
| *(saída)* Divergências corrigidas | `divergencesFixed` | inteiro | — | RN-ANL-53 | execução |
| *(saída)* Amostra | `divergenceSample[]` | lista de `{ table, key, kind, columns[] }` | — | até 50, sem valores (RN-ANL-55) | execução |
| *(saída)* Parâmetros | `parameters { mode, from?, to?, definitionVersion, definitionChanged? }` | objeto | — | lacuna 2 | execução |
| *(saída)* Solicitante | `requestedBy { id, name }?` | objeto ou nulo | — | nulo quando `SYSTEM` | execução |
| *(saída)* Mensagem de falha | `errorMessage` | texto ou nulo | — | só em `FAILED` (RN-ANL-66) | execução |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `mode` ausente ou fora de `FULL`/`PERIOD` | Front + API (Zod) | "Escolha o escopo da reconstrução." | `VALIDATION_ERROR` |
| V-02 | `PERIOD` sem `from` ou sem `to` | Front + API | "Informe o período a reconstruir." | `VALIDATION_ERROR` |
| V-03 | `from` posterior a `to`, `to` no futuro ou intervalo acima de 5 anos | Front + API | "Informe um período válido, de até 5 anos e sem datas futuras." | `VALIDATION_ERROR` |
| V-04 | `reason` fora de 10 a 300 caracteres | Front + API | "Informe o motivo da reconstrução (de 10 a 300 caracteres)." | `VALIDATION_ERROR` |
| V-05 | `Idempotency-Key` ausente | API | "Atualize a página e tente de novo." | `VALIDATION_ERROR` |
| V-06 | `Idempotency-Key` reutilizada com corpo diferente | API | "Esta chave já foi usada em outra solicitação." | `IDEMPOTENCY_KEY_REUSED` (422) |
| V-07 | Sessão sem MFA quando a política exige | API | "Confirme sua identidade com o segundo fator para continuar." | `MFA_REQUIRED` (403) |
| V-08 | Já existe execução `RUNNING` do tenant | API (+ índice único) | "Já há uma atualização de indicadores em andamento. Acompanhe o andamento e tente depois." | `ANALYTICS_REBUILD_IN_PROGRESS` (409) |
| V-09 | Terceira reconstrução `FULL` em 24 h | API | "Você já reconstruiu tudo duas vezes hoje. Tente de novo em {horário}." | `RATE_LIMITED` (429) |
| V-10 | Filtros do histórico inválidos (`scope`, `status`, datas, `limit`, `cursor`) | API (Zod) | "Filtro inválido." | `VALIDATION_ERROR` |
| V-11 | `id` que não é UUID em ANL-03 | API | "Execução não encontrada." | `ANALYTICS_RUN_NOT_FOUND` (404) |

## Permissões
- **Permissão:** `SETTINGS_MANAGE` (risco `H`) com escopo `TENANT` para ANL-02, ANL-03 e ANL-04; perfil padrão `ADMIN_ORGAO`. Reconciliação noturna, carga inicial e reconstrução em execução usam o papel `cf_worker`, sem permissão de usuário.
- **Políticas:** POL-14 (MFA), POL-28 (a amostra não traz valor nem processo legível), DEC-206 (a API só tem `SELECT` nos fatos; o único `INSERT` de `cf_app` nesta feature é a linha de execução `REBUILD`, lacuna 4).
- **MFA:** exigido em ANL-02 quando `security.mfaPolicy` é `ADMINS` ou `ALL`; ANL-03 e ANL-04 são leituras e não exigem.
- **Sem permissão:** o bloco "Reconstruir indicadores" é ocultado; a API responde 403 `PERMISSION_DENIED` (ou `MFA_REQUIRED`) e grava `access.denied`; execução de outro tenant responde 404 `ANALYTICS_RUN_NOT_FOUND`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `AnalyticsReconciliationCompleted` | `analytics.reconciliation_completed` | Fim de execução `COMPLETED`, noturna ou reconstrução | `runId`, `scope`, `factsChecked`, `divergencesFixed`; consumidor M (métricas); sem valores, chaves nem nomes |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. Divergência acima do limite e falha da execução geram alerta operacional (observability.md §10), não notificação de usuário (events.md §4.10). O administrador acompanha pela tela e pelo toast de conclusão. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Reconstruir e reconciliar o read model

  Background:
    Given que o tenant "Prefeitura A" está ativo com o módulo de indicadores inicializado
    And "Marta" tem o perfil "ADMIN_ORGAO" com "SETTINGS_MANAGE", escopo "TENANT" e sessão com MFA
    And "Gil" tem o perfil "GESTOR_CONTRATACOES" com "REPORT_VIEW" e sem "SETTINGS_MANAGE"
    And o tenant tem 3.000 processos com seus fatos projetados

  Scenario: [Sucesso] Reconciliação noturna corrige divergência e publica o evento
    Given que o fato do processo "0012/2026" foi alterado manualmente fora do projetor
    When o job noturno do tenant rodar às 02:10
    Then a execução "NIGHTLY" deve terminar "COMPLETED" com "divergencesFixed" igual a 1
    And o fato deve voltar ao valor calculado a partir das tabelas transacionais
    And "divergenceSample" deve ter uma chave do tipo "STALE" com os nomes das colunas e sem valores
    And o evento "AnalyticsReconciliationCompleted" deve ser publicado com "runId", "scope", "factsChecked" e "divergencesFixed"
    And o refresh das visões deve ser pedido

  Scenario: [Sucesso] Fato perdido é recriado e rascunho descartado é removido
    Given que o evento de conclusão do processo "0020/2026" nunca foi projetado
    And existe um fato de rascunho descartado, sem "openedAt" e sem origem
    When a reconciliação noturna rodar
    Then o fato do processo "0020/2026" deve ser inserido como "MISSING" com o estado atual
    And o fato do rascunho deve ser removido como "ORPHAN"
    And "divergencesFixed" deve ser 2

  Scenario: [Sucesso] Fato mais novo do projetor não é sobrescrito
    Given que o projetor gravou o fato do processo "0033/2026" depois que o lote da reconciliação leu a origem
    When o lote tentar gravar o fato esperado
    Then o fato do projetor deve permanecer
    And a diferença não deve ser contada em "divergencesFixed"

  Scenario: [Sucesso] Reconstrução total pedida pelo administrador
    When "Marta" chamar "POST /analytics/rebuilds" com modo "FULL" e motivo "Mudança da definição de ciclo" e "Idempotency-Key" "K1"
    Then a API deve responder 202 com "status" "RUNNING", "scope" "REBUILD" e o cabeçalho "Location"
    And deve gerar a auditoria "analytics.rebuild" com a fase "REQUESTED"
    When o worker concluir a execução
    Then "GET /analytics/rebuilds/{id}" deve devolver "COMPLETED", "factsChecked" e "divergencesFixed"
    And deve gerar o evento "AnalyticsReconciliationCompleted" com "scope" "REBUILD"
    And deve gerar a auditoria "analytics.rebuild" com a fase "COMPLETED" e ator "SYSTEM"
    And a reconstrução não deve gerar alerta de proporção de divergências

  Scenario: [Sucesso] Reconstrução por período toca só o intervalo
    When "Marta" pedir "PERIOD" de 01/01/2026 a 30/06/2026
    Then apenas os processos abertos nesse intervalo, suas passagens e os itens do PCA de 2026 devem ser recalculados
    And os fatos dos processos abertos em 2025 não devem ser regravados

  Scenario: [Sucesso] Mudança de definição alinha os fatos sem alerta
    Given que "INDICATOR_DEFINITION_VERSION" subiu de 1 para 2 no deploy
    When a reconciliação noturna rodar
    Then a execução deve registrar "definitionChanged" verdadeiro e a versão 2 em "parameters"
    And 80% dos fatos podem ser corrigidos sem gerar alerta por proporção

  Scenario: [Sucesso] Carga inicial de tenant que já existia no MVP 1
    Given que a "Prefeitura C" não tem nenhuma reconstrução concluída e "GET /analytics/status" mostra "NOT_INITIALIZED"
    When o job "analytics-bootstrap" rodar
    Then uma reconstrução "FULL" com solicitante "SYSTEM" deve ser concluída
    And "GET /analytics/status" deve passar a "OK"

  Scenario: [Sucesso] Histórico de execuções
    When "Marta" chamar "GET /analytics/reconciliation-runs" com "scope" "NIGHTLY"
    Then a API deve responder 200 com as execuções em ordem decrescente de início e "meta.nextCursor"
    And cada item deve ter "factsChecked", "divergencesFixed" e "divergenceSample" sem valores monetários

  Scenario: [Sucesso] Divergência acima do limite gera alerta e não notificação
    Given que a execução noturna corrigiu 0,4% dos fatos
    Then deve ser emitido o alerta de aviso de divergência
    And nenhuma notificação deve ser enviada a usuário

  Scenario: [Validação] Corpo ou filtros inválidos
    When "Marta" pedir "PERIOD" sem "from"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Marta" pedir "PERIOD" de 01/01/2026 a 31/12/2032
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Marta" pedir "FULL" com motivo "ok"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Marta" chamar "GET /analytics/reconciliation-runs" com "limit" 500
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    When "Marta" chamar "GET /analytics/rebuilds/abc"
    Then a API deve responder 404 com código "ANALYTICS_RUN_NOT_FOUND"

  Scenario: [Permissão] Só quem administra o tenant reconstrói e consulta
    When "Gil" chamar "POST /analytics/rebuilds"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar auditoria "access.denied"
    When "Gil" chamar "GET /analytics/reconciliation-runs"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    Given que a sessão de "Marta" não tem MFA e a política é "ADMINS"
    When "Marta" chamar "POST /analytics/rebuilds"
    Then a API deve responder 403 com código "MFA_REQUIRED"
    And nenhuma execução deve ser criada

  Scenario: [Tenant incorreto] Execução e reconstrução de outro tenant
    Given que existe a execução "R-77" da "Prefeitura B"
    When "Marta", da "Prefeitura A", chamar "GET /analytics/rebuilds/R-77"
    Then a API deve responder 404 com código "ANALYTICS_RUN_NOT_FOUND"
    When "Marta" pedir uma reconstrução "FULL"
    Then nenhum fato da "Prefeitura B" deve ser lido, regravado ou removido
    And "GET /analytics/reconciliation-runs" não deve listar execuções da "Prefeitura B"

  Scenario: [Duplicidade] Reenvio do pedido e segunda reconstrução
    Given que "Marta" pediu a reconstrução com "Idempotency-Key" "K1" e recebeu 202
    When a mesma requisição for reenviada com "K1"
    Then a API deve responder 202 com a mesma execução e o cabeçalho "Idempotent-Replayed: true"
    And deve existir uma única execução e uma única auditoria "analytics.rebuild" da fase "REQUESTED"
    When "Marta" pedir outra reconstrução com a chave "K2" enquanto a primeira está "RUNNING"
    Then a API deve responder 409 com código "ANALYTICS_REBUILD_IN_PROGRESS"

  Scenario: [Concorrência] Dois administradores pedem ao mesmo tempo
    When "Marta" e "Otávio", também "ADMIN_ORGAO", pedirem uma reconstrução ao mesmo tempo
    Then exatamente um pedido deve responder 202
    And o outro deve responder 409 com código "ANALYTICS_REBUILD_IN_PROGRESS"
    And deve existir uma única execução "RUNNING" do tenant

  Scenario: [Concorrência] Reconciliação noturna encontra reconstrução em andamento
    Given que uma reconstrução manual está "RUNNING"
    When o job noturno do tenant disparar
    Then ele deve terminar como "skipped" sem criar execução

  Scenario: [Concorrência] Reconstrução enquanto o projetor continua trabalhando
    Given que a reconstrução está no lote 4 de 7
    When o projetor gravar o fato de um processo já reconciliado
    Then o fato do projetor deve ser mantido e a reconstrução deve concluir sem erro

  Scenario: [Falha de banco] Falha no meio do lote retoma do cursor
    Given que o banco cai durante o lote 4 da reconstrução
    When o job voltar pelo retry
    Then a execução deve continuar do cursor gravado, sem refazer os lotes 1 a 3
    And o resultado final deve ser igual ao de uma execução sem falha

  Scenario: [Falha de banco] Pedido com banco indisponível
    Given que o banco está indisponível durante a transação de "POST /analytics/rebuilds"
    When "Marta" confirmar o pedido
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhuma execução, auditoria nem job deve ser criado

  Scenario: [Falha de banco] Retries esgotados liberam a vaga
    Given que a execução esgotou as tentativas
    Then ela deve ficar "FAILED" com "errorMessage" padronizado e sem detalhe técnico
    And "Marta" deve conseguir pedir uma nova reconstrução

  Scenario: [Falha de integração] Fila indisponível no pedido
    Given que o Redis está indisponível
    When "Marta" chamar "POST /analytics/rebuilds"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a execução e a auditoria do pedido devem ter sido desfeitas

  Scenario: [Falha de integração] Execução esquecida em "RUNNING"
    Given que o worker caiu e a execução está "RUNNING" há 7 horas sem job ativo
    When o job "maintenance" rodar
    Then a execução deve ficar "FAILED" com a mensagem "Execução interrompida."
    And a vaga do tenant deve ser liberada

  Scenario: [Validação] Trava contra exclusão em massa
    Given que a leitura da origem devolve 0 processos por engano e 40% dos fatos pareceriam órfãos
    When a reconciliação rodar
    Then ela deve terminar "FAILED" com "Quantidade anormal de fatos sem origem."
    And nenhum fato deve ser removido

  Scenario: [Sucesso] Meta de desempenho (suíte de performance)
    Given um tenant com 50.000 processos e 600.000 passagens
    When a suíte de performance executar a reconstrução "FULL" com o projetor ativo
    Then a execução deve terminar em até 60 minutos
    And o p95 dos comandos de tramitação não deve ultrapassar o SLO-05 durante a execução
    And o refresh final de cada visão deve levar até 5 minutos
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta o bloco; mensagem se acessado por link |
| Sem MFA | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para continuar." | Abre o passo de MFA e repete o pedido |
| Execução inexistente ou de outro tenant | 404 | `ANALYTICS_RUN_NOT_FOUND` | "Execução não encontrada." | Volta ao histórico |
| Reconstrução em andamento | 409 | `ANALYTICS_REBUILD_IN_PROGRESS` | "Já há uma atualização de indicadores em andamento. Acompanhe o andamento e tente depois." | Troca o botão por "Acompanhar" |
| Corpo ou filtros inválidos | 422 | `VALIDATION_ERROR` | "Informe um período válido, de até 5 anos e sem datas futuras." (conforme o campo) | Realça o campo |
| Chave de idempotência reutilizada com corpo diferente | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Limite de reconstruções totais | 429 | `RATE_LIMITED` | "Você já reconstruiu tudo duas vezes hoje. Tente de novo em {horário}." | Desabilita "Tudo" até o horário |
| Banco ou fila indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível iniciar a reconstrução agora. Tente novamente em instantes." | "Tentar novamente"; respeita `Retry-After` |
| Execução falhou (worker) | — | — | "A reconstrução não foi concluída. Peça a uma nova tentativa; se o problema continuar, informe o código {correlationId} ao suporte." | Mostra `FAILED` no histórico com o código de suporte |

## Dependências
- **Stories:** US-170 (fatos, `FactBuilder`, fila `analytics`, visões e refresh). Indiretas: US-099 (provisionamento de tenant, carga inicial), US-103 (Configurações gerais, SCR-041), US-083 (jobs agendados e *dead letter*), US-073 (auditoria), US-094/US-097 (permissão e MFA).
- **Decisões/ADRs:** DEC-105, DEC-206, DEC-164, ADR-014, POL-14.
- **Configurações:** `security.mfaPolicy`; janela noturna fixa (01:00 a 05:00 do fuso do tenant) em código.
- **Lacunas nas fontes canônicas:**
  1. **Permissão da reconstrução:** `permissions.md` não tem permissão própria para o read model. Adotada `SETTINGS_MANAGE` (feature FT-080), que cobre ANL-02 a ANL-04. **Confirmar; alternativa: `ANALYTICS_MANAGE` (risco `H`, só `ADMIN_ORGAO`).**
  2. **Campos da execução:** `AnalyticsReconciliationRun` (entities.md §4.11) não guarda o pedido nem o período. Proposta: `+ parameters jsonb` (`mode`, `from`, `to`, `definitionVersion`, `definitionChanged`, cursor e fase de retomada) e `+ requestedById uuid` (nulo quando `SYSTEM`). **Ajuste em entities.md §4.11.**
  3. **Auditoria da reconciliação noturna:** events.md §7 lista `analytics.rebuild` (SYSTEM) sem separar pedido manual, conclusão e reconciliação noturna. Proposta: duas gravações na reconstrução (`metadata.phase = REQUESTED`/`COMPLETED`/`FAILED`, a primeira com ator `USER`) e nenhuma auditoria na noturna. **Ajuste em events.md §7.**
  4. **Escrita da API na execução:** a API só tem `SELECT` nos fatos (RN-ANL-01); o pedido manual exige `INSERT` de `cf_app` em `analytics_reconciliation_runs` (somente `scope = REBUILD`, `status = RUNNING`), com `GRANT` restrito por política de linha. Alternativa: criar a linha pelo worker e devolver o `runId` gerado pela API. **Dúvida de arquitetura.**
  5. **Retenção e limites:** retenção de 400 dias das execuções, janela de 01:00 a 05:00, limites de 0,1% e 1% de divergência e de duas reconstruções `FULL` por dia são propostas desta story, a validar com o piloto e a operação.
  6. **Códigos novos a consolidar no card de API:** `ANALYTICS_REBUILD_IN_PROGRESS` (409), `ANALYTICS_RUN_NOT_FOUND` (404); parâmetros e objeto `run` de ANL-02 a ANL-04.
  7. **Cancelamento:** não há cancelamento manual de reconstrução em andamento; a única saída é aguardar o fim ou a falha. **Dúvida de produto.**
  8. **Local do bloco:** não há tela de administração do read model entre as 41; usa-se um bloco em SCR-041 (`/admin/configuracoes`). **Incluir US-171 na linha de SCR-041 em features.md.**

## Impacto técnico
- A reconciliação é a única rotina que lê, em massa, as tabelas transacionais para fins analíticos. Por isso roda à noite, em lotes curtos de leitura `READ ONLY`, com `lock_timeout` baixo e pausa entre lotes; o custo é medido na suíte de performance, nunca durante o card.
- Reuso do `FactBuilder` garante paridade entre o projetor e a reconciliação; testes de paridade (eventos em qualquer ordem × reconstrução) são o principal seguro do épico.
- A trava de exclusão (RN-ANL-60) e a regra `ORPHAN_KEPT` evitam que uma leitura errada apague fatos legítimos; a reconstrução nunca remove fato de processo já aberto.
- `REBUILD FULL` em tenant grande regrava muitas linhas; os fatos são particionáveis por exercício (critério de revisão da ADR-014) se o volume exigir.
- Compatibilidade: nenhuma rota do MVP 1 muda; os eventos mantêm `eventVersion = 1`; a tabela `analytics_reconciliation_runs` é nova.

## Backend
- **Módulo(s):** `analytics` (dono), portas de leitura em `process`, `pca`, `legal-review`, `internal-control` e `catalog`; `audit`, `access` (permissão e MFA) e `platform` (fila, *Job Scheduler*, `maintenance`).
- **Casos de uso:** `ReconcileTenantFactsCommand` (noturna), `RequestAnalyticsRebuildCommand` (ANL-02), `RunAnalyticsRebuildCommand` (job `analytics-rebuild`), `BootstrapAnalyticsCommand` (job `analytics-bootstrap`), `GetAnalyticsRebuildQuery` (ANL-03), `ListReconciliationRunsQuery` (ANL-04), `ExpireStaleReconciliationRunsCommand` (`maintenance`), `PurgeReconciliationRunsCommand` (`maintenance`).
- **Domínio:** `ReconcileTenantFacts` (cursor, lotes, comparação), `FactDiff` (`MISSING`, `STALE`, `ORPHAN`, `ORPHAN_KEPT`), `DivergenceSample`, `RebuildWindow`, `OrphanGuard`, `AnalyticsRun` (máquina de estados `RUNNING` → `COMPLETED`/`FAILED`), reuso de `FactBuilder` e `IndicatorDefinitions` (US-170).
- **Integrações internas:** portas de leitura de `process`, `pca`, `legal-review`, `internal-control`, `catalog`; `OutboxWriter` (evento), `AuditService` (`analytics.rebuild`), `MfaPolicy`.
- **Transação:** pedido manual = verificação da vaga → `INSERT` da execução → auditoria → enfileiramento (a falha de qualquer passo desfaz tudo); cada lote da execução tem transação própria; o fim (`COMPLETED` + evento) é uma transação.

## Frontend
- **Tela(s):** SCR-041 (`/admin/configuracoes`), bloco "Reconstruir indicadores" abaixo de "Atualização dos indicadores" (US-170).
- **Componentes:** `RebuildButton` e `RebuildDialog` (escopo, período, motivo, aviso de tempo), `RebuildProgress` (contagem de fatos verificados), `ReconciliationRunsTable` (histórico paginado com situação, duração, fatos, correções), `DivergenceSampleDrawer` (chaves e nomes de colunas, sem valores).
- **Estados:** skeleton; vazio ("Nenhuma execução ainda."); em andamento (barra indeterminada com a contagem); concluído (toast com contagens); falho (mensagem com o código de suporte e "Pedir de novo"); erro de rede com "Tentar novamente".
- **Acessibilidade e responsividade:** situação com texto e ícone; progresso com `role="status"` e `aria-live="polite"`; diálogo com foco preso e `Esc`; tabela vira lista de cartões abaixo de 768 px; datas no fuso do tenant.

## Banco de dados
- **Tabelas:** `analytics_reconciliation_runs` (nova); leitura e escrita dos fatos da US-170; leitura, só no worker, de `processes`, `process_stages`, `process_movements`, `process_assignments`, `pca_items`, `legal_reviews`, `internal_control_reviews` e `holidays`.
- **Migrações:** tabela de execuções com RLS `FORCE`, `CHECK (status IN ('RUNNING','COMPLETED','FAILED'))`, `CHECK (scope IN ('NIGHTLY','REBUILD'))`, colunas `parameters` e `requested_by_id` (lacuna 2); `GRANT` de escrita a `cf_worker` e de `INSERT` restrito a `cf_app` (lacuna 4).
- **Índices/constraints relevantes:** único parcial `(tenant_id) WHERE status = 'RUNNING'`; `(tenant_id, started_at DESC)` para o histórico; `(tenant_id, scope, status, started_at)` para os filtros.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `ANL-02` | POST | `/api/v1/analytics/rebuilds` | `Idempotency-Key`; corpo `{ mode, from?, to?, reason }` | `202 { data: Run }` + `Location` | 202, 403, 409, 422, 429, 503 |
| `ANL-03` | GET | `/api/v1/analytics/rebuilds/{id}` | path `id` | `200 { data: Run }` (`scope = REBUILD`) | 200, 403, 404 |
| `ANL-04` | GET | `/api/v1/analytics/reconciliation-runs` | `scope[]`, `status[]`, `startedFrom`, `startedTo`, `cursor`, `limit` | `200 { data: Run[], meta { nextCursor } }` | 200, 403, 422 |

## Logs
- `info` `analytics.reconciliation_started` — `runId`, `scope`, `mode`, `windowFrom?`, `windowTo?`, `correlationId`.
- `info` `analytics.reconciliation_batch` — `runId`, `batch`, `factsChecked`, `divergencesFixed`, `durationMs`.
- `info` `analytics.reconciliation_completed` — `runId`, `scope`, `factsChecked`, `divergencesFixed`, `ratio`, `durationMs`.
- `warn` `analytics.reconciliation_skipped` — `reason` (`RUNNING_EXISTS`, `TENANT_INACTIVE`); `warn` `analytics.reconciliation_divergence_high` — `runId`, `ratio`; `warn` `analytics.orphan_kept` — `runId`, `count`.
- `error` `analytics.reconciliation_failed` — `runId`, `errorClass`, `attempt`; `error` `analytics.orphan_limit_exceeded` — `runId`, `count`.
- `info` `analytics.rebuild_requested` — `runId`, `mode`, `requestedById`.
- **Nunca logar:** `reason` do pedido, valores de fatos, títulos, nomes, conteúdo de `divergenceSample` além de contagens.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `analytics.rebuild` | `SYSTEM` | Commit de ANL-02 (ator = quem pediu) | `metadata`: `phase = REQUESTED`, `runId`, `mode`, `from`, `to`, `reason`, `idempotencyKey` |
| `analytics.rebuild` | `SYSTEM` | Fim da reconstrução (ator `SYSTEM`) | `metadata`: `phase = COMPLETED` ou `FAILED`, `runId`, `factsChecked`, `divergencesFixed` |
| `access.denied` | `ACCESS` | 403 em qualquer rota da story | `reasonCode`, `route` |

## Testes necessários
- **Unitários:** `FactDiff` (cada tipo; colunas ignoradas), `RebuildWindow` (`FULL`, `PERIOD`, limites de datas, intervalo de 5 anos), `OrphanGuard` (5% e 1.000), `DivergenceSample` (limite de 50, sem valores), guarda de corrida (`projectedAt ≤ readStartedAt`), cálculo de proporção e limites de alerta, máquina de estados da execução, marcação de mudança de definição.
- **Integração (Testcontainers):** reconciliação noturna com corrupção induzida (fato alterado, removido, órfão de rascunho, órfão com `openedAt`); paridade projetor × reconstrução (permutações de eventos e comparação com a reconstrução); retomada por cursor depois de falha; vaga única sob concorrência; refresh pedido ao fim; `AnalyticsReconciliationCompleted` no outbox; `INSERT` de `cf_app` limitado ao permitido.
- **API/contrato:** ANL-02 a ANL-04 (corpo, filtros, paginação, 202 e `Location`, idempotência, 409, 422, 429, 503); amostra sem valores.
- **RBAC e multi-tenant:** 403 e 404 por papel e tenant; MFA; teste novo na suíte `test/tenant-leak`: reconstrução do tenant A não lê nem grava fatos do B; execução e histórico invisíveis entre tenants.
- **Concorrência:** dois pedidos simultâneos; noturna × manual; reconstrução × projetor; *watchdog* × execução viva.
- **E2E (Playwright):** o administrador abre Configurações gerais, pede uma reconstrução por período, acompanha o progresso e vê o resultado no histórico; gestor sem `SETTINGS_MANAGE` não vê o bloco.
- **Acessibilidade/performance:** axe no bloco e no diálogo; duração da reconstrução e impacto na tramitação como testes da suíte de performance (medidos no endurecimento, nunca no card).

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
- [ ] Teste prova que a reconstrução produz fatos idênticos aos do projetor para o mesmo estado
- [ ] Teste prova que há no máximo uma execução `RUNNING` por tenant, também sob concorrência
- [ ] Teste prova que a amostra de divergências nunca contém valores
- [ ] Teste prova a trava de exclusão em massa e a retomada por cursor
- [ ] Alertas de proporção de divergência e de execução falha configurados e documentados no runbook
- [ ] Lacunas 1 a 8 resolvidas ou registradas nas fontes canônicas

## Estimativa
**M** — uma rotina única de comparação e correção sobre o `FactBuilder` existente, agenda noturna, reconstrução com checkpoint, três endpoints pequenos e um bloco de tela; o esforço está nas travas de segurança, na corrida com o projetor e nos testes de paridade.

## Prioridade
**P1** — é o que torna o read model confiável: sem a reconciliação, um evento perdido vira número errado sem ninguém notar, e sem a reconstrução não há como mudar uma definição de indicador nem carregar os tenants que já existiam (ADR-014, DEC-206).
