---
id: US-144
title: "Acompanhar a execução do PCA"
epic: EP-023
feature: FT-071
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-142]
modules: [pca, process, dfd, organization, catalog, audit, platform]
screens: [SCR-018]
endpoints: [PCA-25, PCA-26, PCA-27, PCA-28]
permissions: [PCA_VIEW, PCA_MANAGE, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: [PcaItemChanged]
---

# US-144 — Acompanhar a execução do PCA

## Título
Acompanhar a execução do PCA

## Descrição
**Como** gestor de contratações (`GESTOR_CONTRATACOES`) e planejamento (`PLANEJAMENTO`), **quero** ver, para o plano aprovado, quanto do valor previsto já virou DFD e processo — por item, por secretaria e por categoria —, a situação de cada item e a lista de processos vinculados, e ajustar a situação de um item quando ele é adiado ou cancelado, **para** saber o que do plano está andando, o que está parado e onde o previsto não bate com o estimado.

A situação do item avança sozinha pelos vínculos: o primeiro processo vinculado aberto leva o item a `IN_PROGRESS`; processo vinculado concluído na fase preparatória da versão 2 do workflow leva a `CONTRACTED`. O valor previsto é comparado com a soma do valor estimado dos processos vinculados, por **consulta síncrona sobre os vínculos** (sem passar pelo *read model* do `analytics`). Valores de processos com orçamento sigiloso aparecem mascarados para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (DEC-030).

## Contexto
- DEC-197: acompanhamento da execução por item, secretaria e categoria; `PcaItem.status`, `statusReason` e `linkedProcessesCount` são os únicos campos que mudam em plano `APPROVED`/`SUPERSEDED` (entities.md §4.1, RN-PCA-23). Ciclo de vida do item em entities.md §6.2.
- O consumidor `PcaExecutionTracker` (events.md §3: `process.created`, `process.pca_item_linked`, `process.status_changed.*`, `dfd.pca_item_linked`) "lê o estado atual e grava só se mudou": recalcula a partir do estado, não por delta, e por isso é idempotente.
- O módulo `pca` (N2) não chama `process` nem `dfd`; a leitura dos vínculos passa pela porta `PcaLinkTarget`, implementada por eles (domains.md §12.3). Esta story formaliza as operações de **leitura** da porta (lacuna 2).
- A US-175 (indicadores de execução no *read model* `AnalyticsPcaItemFact`) é de outro card e **consome** `PcaItemChanged` e `ProcessPcaItemLinked`; esta story não escreve nem lê o `analytics`.
- Sigilo: DEC-030 e POL-09 (estendida a valores de processos sigilosos em agregados). Visibilidade de processos: DEC-024. Lacuna L-07: `CONSULTOR_EXTERNO` não acessa o PCA.
- Revisão do plano (US-141): na janela entre a aprovação da revisão e o fim da reconciliação `REVISION` (US-143), vínculos ainda apontam para o item da versão superada; a leitura resolve por `previousItemId` (RN-PCA-208).
- A feature FT-071 (RN-PCA-22) diz "nunca por soma na leitura" para `linkedProcessesCount`; aqui o campo continua mantido pelo consumidor, mas **valores e contagens exibidos por visão** são consultados na hora, porque dependem de quem olha (visibilidade e sigilo). Ver divergência na lacuna 1.

## Objetivo
Entregar, para 100% dos itens de plano aprovado, o comparativo previsto × vinculado com situação correta e atual; abrir a visão de execução de um plano de 500 itens em até 2 s (p95); garantir que nenhum valor sigiloso nem processo fora de escopo seja exposto; e manter a situação do item consistente mesmo com eventos duplicados, atrasados ou fora de ordem.

## Persona
- **Principal:** Gestor de contratações (`GESTOR_CONTRATACOES`, `PCA_VIEW` com escopo `TENANT`).
- **Secundárias:** Planejamento (`PLANEJAMENTO`, ajusta a situação e recontabiliza); Autoridade competente (`AUTORIDADE_COMPETENTE`, consulta); Controle Interno e Auditor (`CONTROLE_INTERNO`, `AUDITOR`, leitura); secretarias com `PCA_VIEW` de escopo de unidade (veem só os seus itens); Gestor de contrato (`GESTOR_CONTRATO`, leitura de unidade).

## Pré-condições
- Plano do órgão em `APPROVED` (vigente) ou `SUPERSEDED` (consulta histórica); planos em `DRAFT`/`AWAITING_APPROVAL` não têm execução.
- Vínculos `pcaItemId` gravados em processos pela US-142 (e, na revisão, migrados pela US-143).
- `PCA_VIEW` para consultar; `PCA_MANAGE` com escopo que cubra a secretaria do item para ajustar a situação ou pedir recontagem.
- Fila e `domain-events` em operação (consumidor `PcaExecutionTracker`).

## Fluxo principal
1. A pessoa abre `/pca/[pcaId]` (SCR-018) e escolhe a aba "Execução".
2. O front chama `PCA-25` com `groupBy=DEPARTMENT`. A API valida permissão e escopo (permissions.md §5.1) e que o plano está `APPROVED`/`SUPERSEDED`.
3. A API lê os itens do escopo e consulta os vínculos **de uma vez** pela porta `PcaLinkTarget` (uma consulta agrupada por `pca_item_id = ANY(:ids)`, com o predicado de visibilidade do usuário e o mascaramento do sigilo), monta o resumo e os grupos e responde.
4. O front mostra os cartões ("Previsto vigente", "Vinculado", "Saldo previsto não vinculado", "% executado"), a distribuição por situação e a tabela agrupada, com barra de progresso acompanhada de texto.
5. A pessoa troca o agrupamento (Secretaria, Categoria ou Item), filtra (secretaria, categoria, situação, mês previsto, "sem vínculo", "acima do previsto", "atrasados") e ordena.
6. Ao abrir uma linha de item, o front chama `PCA-26` e lista os processos vinculados (código, título, situação, etapa, secretaria solicitante, valor estimado ou "Sigiloso"), com link para `/processos/[id]`.
7. Para um item que não vai acontecer ou foi adiado, quem tem `PCA_MANAGE` abre "Alterar situação", escolhe `POSTPONED` ou `CANCELED`, informa o motivo e confirma; o front chama `PCA-27` com `If-Match` do item.
8. Na mesma transação a API grava a situação e o motivo, a auditoria `pca.item_status_change` e o evento `PcaItemChanged` (`STATUS_CHANGED`).
9. Em paralelo e sem ação humana, o `PcaExecutionTracker` reage aos eventos de processo: reconta os vínculos do item, atualiza `linkedProcessesCount` e, se mudar, avança a situação (RN-PCA-307), com auditoria `SYSTEM` e `PcaItemChanged`.

## Fluxos alternativos
- **FA-01 — Valor sigiloso:** quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` vê, nas linhas com processo sigiloso vinculado, "R$ X + N processo(s) com valor sigiloso"; saldo, percentual e alerta "acima do previsto" ficam `null` com `…Masked: true` (RN-PCA-305). A UI oferece o *step-up* para desmascarar (POL-14, `meta.confidentialStepUpAvailable`).
- **FA-02 — Escopo de unidade:** com `PCA_VIEW` de unidade, o resumo e os grupos cobrem só os itens das secretarias do escopo; totais do órgão não aparecem (permissions.md §5.1).
- **FA-03 — Processos fora da visibilidade:** a contagem, a soma e a lista só consideram processos que a pessoa vê (DEC-024); `meta.processVisibility = RESTRICTED` mostra o aviso "Considera apenas os processos que você pode ver."
- **FA-04 — Plano revisado, reconciliação em andamento:** a execução do plano vigente soma também os vínculos que ainda apontam para o item da versão superada (RN-PCA-208); ao fim da reconciliação o resultado é o mesmo.
- **FA-05 — Cancelar item com processo em andamento:** `PCA-27` para `CANCELED` com vínculo ativo responde `409 PCA_ITEM_IN_USE`; a UI lista os processos e orienta a desvincular (US-142) ou a adiar o item.
- **FA-06 — Reabrir item adiado:** `POSTPONED → PLANNED` pela mesma tela; se houver vínculo ativo, a avaliação automática leva o item direto a `IN_PROGRESS` na mesma transação (RN-PCA-310).
- **FA-07 — Processo cancelado:** o processo sai da contagem e do valor vinculado; se era o último vínculo ativo, o item volta de `IN_PROGRESS` a `PLANNED` (RN-PCA-307, lacuna 3).
- **FA-08 — Evento duplicado ou fora de ordem:** o consumidor refaz a contagem a partir do estado; o resultado é o mesmo e nada é gravado se nada mudou.
- **FA-09 — Recontagem manual:** `PCA-28` refaz contagem e situação automática de todos os itens do plano e informa quantos mudaram; usada após falha prolongada da fila ou correção de dados.
- **FA-10 — Item atrasado:** item `PLANNED` cujo mês previsto já passou no exercício do plano recebe o indicador `behindSchedule` e aparece no filtro "atrasados".
- **FA-11 — Plano ainda não aprovado:** `PCA-25` responde `409 INVALID_STATE`; a aba orienta a aguardar a aprovação.

## Regras de negócio
- **RN-PCA-300** — A execução existe para planos `APPROVED` (vigente) e `SUPERSEDED` (leitura histórica); `DRAFT` e `AWAITING_APPROVAL` retornam `409 INVALID_STATE`. Ajustes manuais e recontagem só valem na versão `APPROVED` (RN-PCA-309).
- **RN-PCA-301** — Vínculo que conta: processo com `Process.pcaItemId` igual ao item (e, na janela de migração, ao `previousItemId` do item — RN-PCA-208) e `status` diferente de `CANCELED`. `PcaItem.linkedProcessesCount` guarda essa contagem **total** (sem filtro de visibilidade); DFD com vínculo cujo processo ainda não carrega o `pcaItemId` não entra (a propagação do DFD para o processo é da US-142).
- **RN-PCA-302** — Valor vinculado do item = soma de `Process.estimatedValue` dos processos que contam (RN-PCA-301) e têm estimativa; os sem estimativa entram em `withoutEstimateCount`. Valor previsto vigente = soma de `plannedValue` dos itens não `CANCELED`.
- **RN-PCA-303** — Fonte da leitura: consulta síncrona única, agrupada por item, pela porta `PcaLinkTarget` (operação `summarizeLinks`), com tempo máximo de 5 s (`statement_timeout`); não lê nem escreve `analytics`. A resposta de `PCA-25` calcula os grupos de secretaria e categoria somando os itens já resumidos, sem segunda ida ao banco.
- **RN-PCA-304** — Agrupamentos: `ITEM` (paginado), `DEPARTMENT` (secretaria do item) e `CATEGORY` (categoria do item). Cada linha traz `plannedValue`, `linkedEstimatedValue`, `balance` (previsto − vinculado, pode ser negativo), `executionPercent` (vinculado ÷ previsto; nulo se previsto 0), `overPlanned` (vinculado > previsto), `itemsCount`, `itemsByStatus`, `linkedProcessesCount`, `itemsWithoutLink` e `confidentialLinkedCount`. Itens `CANCELED` aparecem na lista, mas não entram nos totais previstos.
- **RN-PCA-305** — Sigilo (refina RN-PCA-24): para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`, a soma exclui processos com `isBudgetConfidential = true`; sempre que houver ao menos um, a linha traz `linkedEstimatedValueMasked = true`, `confidentialLinkedCount` e `balance`, `executionPercent` e `overPlanned` nulos (incluindo grupos e totais que contenham a linha). Quem tem a permissão vê a soma completa. Nenhum valor mascarado vai para resposta, log, auditoria ou evento.
- **RN-PCA-306** — Visibilidade: contagem, soma e lista de processos usam o predicado da DEC-024 do usuário; os itens exibidos obedecem ao escopo de `PCA_VIEW` (§5.1). `meta.processVisibility` é `FULL` quando o usuário vê processos em escopo `TENANT`/`ORGANIZATION` que cubra o órgão e `RESTRICTED` nos demais casos, sem informar quantos foram ocultados.
- **RN-PCA-307** — Situação automática do item (`PcaExecutionTracker`), avaliada sobre o estado atual: (a) `PLANNED → IN_PROGRESS` quando há ao menos um vínculo que conta; (b) `IN_PROGRESS → CONTRACTED` quando algum vínculo está `COMPLETED` em processo cujo workflow é a versão 2 (fase preparatória concluída — DEC-196); processo `COMPLETED` na versão 1 não promove; (c) `IN_PROGRESS → PLANNED` quando não resta vínculo que conta e nenhum `COMPLETED` (lacuna 3); (d) `POSTPONED`, `CANCELED` e `CONTRACTED` nunca mudam sozinhos. A atualização é condicional (`UPDATE … WHERE status <> :novo OR linked_processes_count <> :n`).
- **RN-PCA-308** — Idempotência e ordem: o tracker não aplica deltas; busca o estado atual do item e grava o resultado, protegido por trava de linha (`SELECT … FOR UPDATE`) do item. Eventos repetidos ou fora de ordem convergem ao mesmo estado. O consumidor tem as tentativas padrão da fila (DEC-163) e vai para `dead-letter` no fim.
- **RN-PCA-309** — Ajuste manual (`PCA-27`) só em item de plano `APPROVED`, por `PCA_MANAGE` cujo escopo cubra a secretaria do item. Transições aceitas: `PLANNED`/`IN_PROGRESS → POSTPONED` ou `CANCELED` (motivo obrigatório); `POSTPONED → PLANNED`; `IN_PROGRESS → CONTRACTED` (motivo opcional). Qualquer outra → `409 INVALID_STATE` com `meta.allowed[]`. `CANCELED` com vínculo que conta é recusado com `PCA_ITEM_IN_USE`. Em `DRAFT`, a situação do item é editada pela US-138.
- **RN-PCA-310** — Depois de um ajuste manual, o item é reavaliado na mesma transação pela função pura de RN-PCA-307 (por exemplo, `POSTPONED → PLANNED` com vínculo ativo resulta em `IN_PROGRESS`); o evento e a auditoria registram a situação final.
- **RN-PCA-311** — Motivo (`statusReason`): 10 a 1.000 caracteres após `trim`, obrigatório em `POSTPONED` e `CANCELED` (check do banco); limpo ao voltar a `PLANNED`.
- **RN-PCA-312** — O total aprovado `Pca.totalPlannedValue` é congelado na aprovação e **não** é recalculado por mudança de situação em plano `APPROVED`; a execução usa o "previsto vigente" (RN-PCA-302), calculado na leitura.
- **RN-PCA-313** — Lista de processos do item (`PCA-26`): só processos visíveis (DEC-024), do mais recente para o mais antigo (`openedAt`), paginada; traz `estimatedValue` (nulo + `estimatedValueMasked` para sigilosos sem POL-09, api.md §1.4) e **não** revela a existência de processos fora do escopo. DFD sem processo não é listado.
- **RN-PCA-314** — `behindSchedule` = item `PLANNED` em plano do exercício corrente ou anterior cujo `plannedMonth` já terminou no fuso do tenant; exercício futuro nunca atrasa.
- **RN-PCA-315** — Concorrência: `PCA-27` exige `If-Match` com a versão do item; divergência → `412 VERSION_CONFLICT`. Ajuste manual e tracker serializam pela trava de linha; o ajuste manual para `POSTPONED`/`CANCELED` nunca é desfeito pelo tracker.
- **RN-PCA-316** — Recontagem (`PCA-28`): refaz, para todos os itens do plano `APPROVED`, a contagem e a situação automática; devolve `itemsRecounted` e `itemsChanged`; é idempotente, limitada a uma execução simultânea por plano (trava Redis com TTL de 2 min) e roda também ao fim de cada reconciliação (US-143).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Agrupar por | `groupBy` | `ITEM`, `DEPARTMENT`, `CATEGORY` | Não | — | `DEPARTMENT` |
| Secretaria | `departmentId` | lista de uuid | Não | no escopo do usuário | — |
| Categoria | `categoryId` | lista de uuid | Não | `PCA_CATEGORY` | — |
| Situação | `status` | lista de `PcaItemStatus` | Não | vírgula = OU | todas |
| Mês previsto | `plannedMonth` | 1..12 | Não | — | — |
| Sem vínculo | `withoutLink` | booleano | Não | itens sem processo que conta | `false` |
| Acima do previsto | `overPlanned` | booleano | Não | ignora linhas mascaradas | `false` |
| Atrasados | `behind` | booleano | Não | RN-PCA-314 | `false` |
| Busca | `q` | texto | Não | ≥ 2 caracteres (código, objeto) | — |
| Ordenação | `sort` | texto | Não | `-plannedValue`, `-linkedEstimatedValue`, `-balance`, `code`, `plannedMonth` | `code` |
| Paginação | `page`, `pageSize` | inteiros | Não | `pageSize` ≤ 100 (só em `ITEM`) | 1 / 50 |
| Valor previsto | `plannedValue` | decimal(18,2) | — | do item | plano |
| Valor vinculado | `linkedEstimatedValue` | decimal(18,2) | — | RN-PCA-302; `null` + `linkedEstimatedValueMasked` (RN-PCA-305) | consulta |
| Processos vinculados | `linkedProcessesCount` | inteiro | — | por visão (RN-PCA-306) | consulta |
| Saldo | `balance` | decimal | — | previsto − vinculado | cálculo |
| % executado | `executionPercent` | decimal(5,2) | — | nulo se previsto 0 ou mascarado | cálculo |
| Nova situação | `status` (corpo de `PCA-27`) | `PcaItemStatus` | Sim | RN-PCA-309 | — |
| Motivo | `statusReason` | texto | Condicional | RN-PCA-311 | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `groupBy`, `status`, `sort` ou `pageSize` fora do domínio | Front + API (Zod) | "Filtro inválido." | `VALIDATION_ERROR` |
| V-02 | Plano em `DRAFT` ou `AWAITING_APPROVAL` | API | "O acompanhamento começa depois da aprovação do plano." | `INVALID_STATE` |
| V-03 | Transição de situação não permitida | API | "Não é possível mudar a situação de {atual} para {nova}." | `INVALID_STATE` |
| V-04 | Motivo ausente ou fora de 10–1.000 caracteres em `POSTPONED`/`CANCELED` | Front + API | "Informe o motivo (de 10 a 1.000 caracteres)." | `VALIDATION_ERROR` |
| V-05 | Ajuste em item de plano `SUPERSEDED` ou fora de `APPROVED` | API | "Só é possível ajustar itens do plano vigente." | `PCA_NOT_EDITABLE` |
| V-06 | Cancelar item com processo vinculado em andamento | API | "O item tem {n} processo(s) em andamento. Desvincule-os ou adie o item." | `PCA_ITEM_IN_USE` |
| V-07 | `If-Match` ausente | API | — | `PRECONDITION_REQUIRED` |
| V-08 | Secretaria do item fora do escopo de `PCA_MANAGE` | API | "Você não pode alterar itens desta secretaria." | `PERMISSION_DENIED` |
| V-09 | Recontagem já em andamento | API | "Já existe uma recontagem em andamento." | `CONFLICT` |

## Permissões
- **Permissão:** `PCA_VIEW` (risco `L`) para `PCA-25` e `PCA-26`, recortada pelo escopo (§5.1); `PCA_MANAGE` (risco `M`) cobrindo a secretaria do item para `PCA-27`; `PCA_MANAGE` com escopo de órgão para `PCA-28`; `PROCESS_VIEW_CONFIDENTIAL_BUDGET` apenas para desmascarar valores (POL-09).
- **Políticas:** POL-22 (administração do PCA), POL-09 (sigilo estendido a agregados), DEC-024 (visibilidade de processos), POL-14 (o desmascaramento em leitura sem MFA não gera 403: devolve mascarado e oferece *step-up*).
- **MFA:** não exigido pelas permissões `L`/`M`; o desmascaramento segue a exceção da POL-14.
- **Sem permissão:** a aba "Execução" some; `PCA-27`/`PCA-28` respondem `403 PERMISSION_DENIED` com `access.denied`; plano de outro tenant ou item fora do escopo de unidade: `404 NOT_FOUND`. `CONSULTOR_EXTERNO`: `404` em todo o PCA (L-07).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `PcaItemChanged` (`change = STATUS_CHANGED`) | `pca.item_changed` | Ajuste manual (`PCA-27`) ou mudança automática do tracker | `pcaId`, `pcaItemId`, `code`, `change`, `status`, `changedFields[]` (`status`, `statusReason`); consumidor `R` (`AnalyticsProjector`, US-175) |

Mudança só de `linkedProcessesCount` não gera evento (atualização silenciosa; a US-175 reconstrói a contagem dos eventos de processo). **Consumidos** pelo `PcaExecutionTracker`: `ProcessCreated` (`pcaItemId?`), `ProcessPcaItemLinked`, `ProcessPcaItemUnlinked`, `ProcessStatusChanged`, `DfdPcaItemLinked`.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | Nenhuma | — | O acompanhamento é consulta e ajuste pontual; a mudança de situação aparece na tela e na auditoria. Alertas de execução ficam para o EP-028/EP-031. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Acompanhar a execução do PCA

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o plano "PCA 2027" está "APPROVED" com 116 itens
    And o item "PCA-017" da "Secretaria de Saúde" tem valor previsto de 600.000,00 e situação "PLANNED"
    And "Helena" tem "PCA_VIEW" e "PCA_MANAGE" com escopo "ORGANIZATION"
    And "Roberto" é gestor de contratações com "PCA_VIEW" e "PROCESS_VIEW" com escopo "TENANT"

  Scenario: [Sucesso] O primeiro processo vinculado leva o item a IN_PROGRESS
    When o processo "0042/2027" for criado vinculado ao item "PCA-017"
    Then o item "PCA-017" deve passar para "IN_PROGRESS" com "linkedProcessesCount" 1
    And deve gerar registro de auditoria "pca.item_status_change" com ator "SYSTEM"
    And deve gerar o evento "PcaItemChanged" com "change" "STATUS_CHANGED"

  Scenario: [Sucesso] Execução por secretaria compara previsto e vinculado
    Given que o item "PCA-017" tem os processos "0042/2027" (estimado 350.000,00) e "0051/2027" (estimado 180.000,00)
    When "Roberto" consultar a execução agrupada por secretaria
    Then a linha da "Secretaria de Saúde" deve mostrar valor vinculado 530.000,00 e processos vinculados 2
    And o saldo do item "PCA-017" deve ser 70.000,00 e o percentual executado 88,33

  Scenario: [Sucesso] Processo concluído na versão 2 leva o item a CONTRACTED
    Given que o item "PCA-017" está "IN_PROGRESS" e o processo "0042/2027" usa o workflow v2
    When o processo "0042/2027" for concluído
    Then o item "PCA-017" deve passar para "CONTRACTED"

  Scenario: [Sucesso] Adiar um item com motivo
    When "Helena" alterar o item "PCA-021" para "POSTPONED" informando o motivo "Aguardando definição do convênio"
    Then o item deve ficar "POSTPONED" com o motivo registrado
    And deve gerar registro de auditoria "pca.item_status_change" e o evento "PcaItemChanged"

  Scenario: [Sucesso] Valor sigiloso fica mascarado para quem não tem permissão
    Given que o processo "0042/2027" tem orçamento sigiloso e o processo "0051/2027" não
    And "Marta" tem "PCA_VIEW" e "PROCESS_VIEW" com escopo "TENANT", sem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    When "Marta" consultar a execução do item "PCA-017"
    Then "linkedEstimatedValue" deve somar apenas o processo "0051/2027" e "linkedEstimatedValueMasked" deve ser verdadeiro
    And "confidentialLinkedCount" deve ser 1
    And "balance", "executionPercent" e "overPlanned" devem ser nulos
    And o valor do processo "0042/2027" não deve aparecer na resposta, nos logs nem na auditoria

  Scenario: [Validação] Adiar sem motivo e transição inválida
    When "Helena" tentar adiar o item "PCA-021" sem motivo
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "statusReason"
    Given que o item "PCA-030" está "CONTRACTED"
    When "Helena" tentar mudar o item "PCA-030" para "PLANNED"
    Then a API deve responder 409 com código "INVALID_STATE" e "meta.allowed" vazio

  Scenario: [Validação] Cancelar item com processo em andamento
    Given que o item "PCA-017" tem o processo "0042/2027" "IN_PROGRESS"
    When "Helena" tentar cancelar o item "PCA-017"
    Then a API deve responder 409 com código "PCA_ITEM_IN_USE" e "meta.activeLinks" 1

  Scenario: [Validação] Execução de plano ainda em elaboração
    Given que o plano "PCA 2028" está "DRAFT"
    When "Roberto" consultar a execução do plano "PCA 2028"
    Then a API deve responder 409 com código "INVALID_STATE"

  Scenario: [Permissão] Escopo de unidade e falta de PCA_MANAGE
    Given que "Marta" tem "PCA_VIEW" apenas com escopo da "Secretaria de Educação"
    When "Marta" consultar a execução
    Then a resposta deve conter somente itens da "Secretaria de Educação" e nenhum total do órgão
    Given que "Bruno" tem "PCA_VIEW" sem "PCA_MANAGE"
    When "Bruno" tentar adiar o item "PCA-021"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Permissão] Lista de processos respeita a visibilidade
    Given que "Marta" não vê o processo "0051/2027" do item "PCA-017"
    When "Marta" listar os processos do item
    Then a lista não deve conter o processo "0051/2027" e a contagem deve refletir só os processos visíveis

  Scenario: [Tenant incorreto] Execução e item de outro tenant
    Given que existe o plano "PCA 2027" e o item "PCA-900" no tenant "Prefeitura B"
    When "Roberto", no tenant "Prefeitura A", consultar a execução desse plano ou alterar esse item
    Then a API deve responder 404 com código "NOT_FOUND" nos dois casos
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Evento de processo entregue duas vezes
    Given que o evento "ProcessPcaItemLinked" do processo "0042/2027" foi processado
    When o mesmo evento for entregue novamente
    Then o item "PCA-017" deve continuar "IN_PROGRESS" com "linkedProcessesCount" 1
    And não deve haver nova auditoria nem novo "PcaItemChanged"

  Scenario: [Duplicidade] Reenvio do ajuste manual com a mesma chave
    Given que "Helena" adiou o item "PCA-021" com a "Idempotency-Key" "k-144"
    When a mesma requisição for reenviada
    Then a API deve responder com "Idempotent-Replayed" verdadeiro
    And deve existir um único evento "PcaItemChanged" e uma única auditoria

  Scenario: [Concorrência] Ajuste manual e abertura de processo ao mesmo tempo
    Given que o item "PCA-021" está "PLANNED"
    When "Helena" adiar o item e, ao mesmo tempo, um processo for vinculado a ele
    Then o item deve terminar "POSTPONED" ou "IN_PROGRESS" de forma consistente com a ordem de gravação
    And o tracker nunca deve desfazer um "POSTPONED" já gravado

  Scenario: [Concorrência] Dois ajustes com a mesma versão do item
    Given que "Helena" e "Carlos" abriram o item "PCA-021" com a mesma versão
    When os dois enviarem o ajuste ao mesmo tempo
    Then um deve ter sucesso e o outro deve receber 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] A gravação do ajuste falha
    Given que o banco de dados falha ao gravar o item
    When "Helena" adiar o item "PCA-021"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a situação do item, a auditoria e o outbox devem permanecer como antes

  Scenario: [Falha de banco] O banco falha durante a consulta de execução
    Given que a consulta agrupada de vínculos excede o tempo máximo
    When "Roberto" abrir a aba "Execução"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a tela deve mostrar "Não foi possível carregar a execução agora" com a ação "Tentar novamente"

  Scenario: [Falha de integração] Redis e fila de eventos indisponíveis
    Given que o Redis das filas está indisponível
    When um processo for vinculado ao item "PCA-017"
    Then a consulta de execução deve já mostrar o processo na soma e na lista
    And o item deve avançar para "IN_PROGRESS" quando o relay do outbox voltar
    When "Helena" pedir a recontagem do plano
    Then a situação de todos os itens deve convergir sem duplicar auditoria
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Parâmetro inválido | 422 | `VALIDATION_ERROR` | "Filtro inválido." | Restaura o filtro anterior |
| Plano ainda não aprovado | 409 | `INVALID_STATE` | "O acompanhamento começa depois da aprovação do plano." | Esconde a aba |
| Transição de situação não permitida | 409 | `INVALID_STATE` | "Não é possível mudar a situação de {atual} para {nova}." | Mostra apenas as opções válidas |
| Motivo inválido | 422 | `VALIDATION_ERROR` | "Informe o motivo (de 10 a 1.000 caracteres)." | Erro no campo; mantém o texto |
| Item de plano não vigente | 409 | `PCA_NOT_EDITABLE` | "Só é possível ajustar itens do plano vigente." | Recarrega |
| Item com processo em andamento | 409 | `PCA_ITEM_IN_USE` | "O item tem {n} processo(s) em andamento. Desvincule-os ou adie o item." | Abre a lista de processos do item |
| Item alterado por outra pessoa | 412 | `VERSION_CONFLICT` | "Outra pessoa alterou este item. Recarregue e tente de novo." | Recarrega e mantém o motivo |
| Sem `If-Match` | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente de novo." | Recarrega |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para alterar itens do plano." | Oculta a ação |
| Plano ou item de outro tenant/escopo | 404 | `NOT_FOUND` | "Plano não encontrado." | Volta à lista de planos |
| Recontagem em andamento | 409 | `CONFLICT` | "Já existe uma recontagem em andamento." | Mostra o andamento |
| Muitas requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns instantes." | Reabilita após `Retry-After` |
| Banco ou fila indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-142 (vínculo `pcaItemId` em DFD e processo; origem dos eventos e da leitura da porta). Indiretas: US-140 (plano aprovado), US-141 (janela de revisão, RN-PCA-208), US-143 (recontagem ao fim da reconciliação), US-138 (itens e situação em `DRAFT`). Habilita a US-175 (indicadores no *read model*, que consome os eventos e não esta consulta) e o EP-028.
- **Decisões/ADRs:** DEC-197, DEC-029, DEC-030, DEC-024, DEC-032, DEC-040, DEC-163 (política de filas), DEC-196 (versão 2 do workflow), DEC-104 e DEC-105 (concorrência e idempotência); ADR-014 (fronteira com o *read model*).
- **Configurações:** nenhuma nova.
- **Lacunas nas fontes canônicas:**
  1. Divergência com FT-071/RN-PCA-22 ("nunca por soma na leitura"): `linkedProcessesCount` segue mantido por consumidor, mas contagens e valores **exibidos** são consultados na hora por visão (visibilidade e sigilo dependem de quem olha). Confirmar com produto.
  2. Operações de leitura da porta `PcaLinkTarget`, hoje só "listar pendentes e gravar": `summarizeLinks(itemIds, viewer)` (contagem, soma, sigilosos, sem estimativa), `listLinkedProcesses(itemId, viewer, page)` e `activeLinkState(itemId)` (para o tracker: vínculos que contam e processo `COMPLETED` na versão 2). Implementadas por `process` (e `dfd`, se necessário).
  3. Transição automática `IN_PROGRESS → PLANNED` quando o último vínculo é cancelado (RN-PCA-307c), ausente do ciclo de vida de entities.md §6.2. Proposta de ajuste da fonte.
  4. Critério para "processo concluído na versão 2" (RN-PCA-307b): proposto o processo cuja `WorkflowVersion` pertence ao workflow padrão com a etapa `END` "Fase preparatória concluída" (DEC-196); como o evento `ProcessStatusChanged` não traz isso, a porta devolve o indicador.
  5. Endpoints `PCA-25` a `PCA-28` e as rotas `/pcas/{pcaId}/execution` e `/pca-items/{itemId}/...` (a feature indica `GET /pca/{id}/execution`); `PCA-28` (recontagem) é novo, derivado do risco "rotina de recontagem" da feature.
  6. A permissão `PCA_EXPORT` descreve também "planilhas de acompanhamento" (permissions.md §2.1); esta story **não** exporta a execução. A exportação de execução fica para o EP-028 (`REPORT_EXPORT`) ou card futuro.
  7. `DfdPcaItemLinked` (routing key `dfd.pca_item_linked`) é citado como consumido (events.md §3), mas não aparece no catálogo de eventos de DFD; tratado como alias do evento de propagação (US-142).

## Impacto técnico
- **Performance:** uma consulta agrupada por plano (`pca_item_id = ANY(...)` com o predicado de visibilidade) mais agregação em memória; índices `processes (tenant_id, pca_item_id) WHERE pca_item_id IS NOT NULL` e `pca_items (tenant_id, pca_id, department_id|category_id|status)` já existem. Meta: p95 ≤ 2 s para 500 itens (medida no endurecimento).
- **Fronteira de módulos:** `pca` não importa `process`; a porta é declarada em `pca` e implementada por `process`/`dfd` (D1, DIP). O tracker não escreve em `process`.
- **Segurança:** o mascaramento ocorre no servidor, antes de agregar; nenhuma resposta permite subtrair valores para inferir sigilosos (saldo e percentual nulos quando há sigiloso).
- **Consistência:** o tracker usa recontagem por estado e trava de linha; eventos perdidos são corrigidos por `PCA-28` e pela recontagem pós-reconciliação.
- **Compatibilidade:** nenhuma mudança em contratos do MVP 1; nenhuma migração nova.

## Backend
- **Módulo(s):** `pca` (dono do item, do tracker e da consulta), `process` e `dfd` (implementam a leitura da porta), `organization` (nomes de secretaria), `catalog` (categoria), `audit`, `platform` (fila e outbox).
- **Casos de uso:** `GetPcaExecutionQuery` (`PCA-25`), `ListItemProcessesQuery` (`PCA-26`), `ChangePcaItemStatusCommand` (`PCA-27`), `RecountPcaExecutionCommand` (`PCA-28`), consumidor `PcaExecutionTracker`.
- **Domínio:** `PcaItem.applyAutomaticStatus(state)` (função pura de RN-PCA-307), `PcaItem.changeStatus(to, reason)` (RN-PCA-309), `ExecutionSummary` (agregação por item, secretaria e categoria), `ConfidentialMaskingPolicy`.
- **Integrações internas:** `PcaLinkTarget` (leitura), `VisibilityPredicateBuilder` (DEC-024), `PermissionService` (escopo e POL-09), `OutboxWriter`, `AuditService`.
- **Transação:** `PCA-27`: trava do item → validação → gravação de situação/motivo → reavaliação automática → auditoria → outbox. Tracker: trava do item → leitura do estado pela porta → gravação condicional → auditoria e outbox só se a situação mudou. `PCA-25` e `PCA-26` são leituras (`READ ONLY`).

## Frontend
- **Tela(s):** SCR-018 (`/pca/[pcaId]`, aba "Execução").
- **Componentes:** `ExecutionSummaryCards`, `ExecutionStatusBar` (distribuição por situação), `GroupBySwitch` (secretaria, categoria, item), filtros no padrão `FilterPanel` das listas (filtros abertos, "Mais filtros", chips só dos extras), `ExecutionTable` com `ProgressMeter` acompanhado do percentual em texto, `ItemProcessesDrawer`, `ChangeItemStatusDialog`, `ConfidentialValueTag` ("Sigiloso" com cadeado), `StepUpUnmaskButton`, aviso de visibilidade restrita.
- **Estados:** loading (skeleton de cartões e tabela), vazio ("Nenhum item corresponde aos filtros" e "Plano sem itens vinculados ainda"), erro com "Tentar novamente", sucesso (toast "Situação do item atualizada.").
- **Acessibilidade e responsividade:** barras de progresso com `role="progressbar"` e valor em texto; situação por texto e ícone, não só cor; tabela com cabeçalhos associados e navegação por teclado; abaixo de 768 px a tabela vira cartões e o *drawer* ocupa a tela; valores mascarados anunciados como "valor sigiloso".

## Banco de dados
- **Tabelas:** `pca_items` (`status`, `status_reason`, `linked_processes_count`), `pcas`, `audit_logs`, `outbox_events`; leitura de `processes` (e `dfds`) pela porta.
- **Migrações:** nenhuma nova; índice opcional `pca_items (tenant_id, pca_id, planned_month)` para o filtro de mês.
- **Índices/constraints relevantes:** `(tenant_id, pca_id, status)`, `(tenant_id, previous_item_id)`, `processes (tenant_id, pca_item_id)`; check `status NOT IN ('POSTPONED','CANCELED') OR status_reason IS NOT NULL`; trigger que restringe plano `APPROVED`/`SUPERSEDED` a `status`, `status_reason`, `linked_processes_count`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `PCA-25` | GET | `/pcas/{pcaId}/execution?groupBy=&departmentId=&categoryId=&status=&plannedMonth=&withoutLink=&overPlanned=&behind=&q=&sort=&page=&pageSize=` | filtros | `200 { data: { pca { id, year, versionNumber, status }, summary { plannedValue, linkedEstimatedValue, balance, executionPercent, itemsCount, itemsByStatus, linkedProcessesCount, itemsWithoutLink, confidentialLinkedCount, …Masked }, groups[] ou items[] }, meta { groupBy, processVisibility, confidentialStepUpAvailable, page… } }` | 200, 403, 404, 409, 422, 503 |
| `PCA-26` | GET | `/pca-items/{itemId}/processes?page=&pageSize=` | paginação | `200 { data: [ { id, code, title, status, currentStageName, requestingDepartment, estimatedValue, estimatedValueMasked, openedAt } ], meta }` | 200, 403, 404 |
| `PCA-27` | PATCH | `/pca-items/{itemId}/status` | `{ status, statusReason? }` · `If-Match` · `Idempotency-Key` | `200 { data: PcaItem }` · `ETag` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `PCA-28` | POST | `/pcas/{pcaId}/execution/recount` | — | `200 { data: { itemsRecounted, itemsChanged } }` | 200, 403, 404, 409, 429, 503 |

## Logs
- `info` `pca.execution_queried` — `pcaId`, `groupBy`, `itemsCount`, `durationMs`, `processVisibility`.
- `info` `pca.item_status_changed` — `pcaItemId`, `from`, `to`, `cause` (`MANUAL`, `TRACKER`), `eventId?`.
- `info` `pca.execution_recounted` — `pcaId`, `itemsRecounted`, `itemsChanged`, `durationMs`.
- `warn` `pca.execution_query_slow` — `pcaId`, `durationMs` (acima de 1,5 s).
- `error` `pca.tracker_failed` — `eventId`, `pcaItemId`, causa (vai para retry/DLQ).
- **Nunca logar:** valores estimados ou previstos, objeto dos itens, motivos, títulos de processos sigilosos e nomes de pessoas.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `pca.item_status_change` | `DATA_CHANGE` | Ajuste manual ou mudança automática de situação | `changes`: `status` (de → para), `statusReasonPresent`; `metadata`: `pcaId`, `code`, `cause`, `eventId?` (ator `SYSTEM` no tracker); sem texto do motivo |
| `access.denied` | `ACCESS` | `PCA-27`/`PCA-28` sem permissão ou escopo | `reasonCode` = permissão |

## Testes necessários
- **Unitários:** função pura de situação automática (todas as combinações de vínculos, `COMPLETED` v1 × v2, `POSTPONED`/`CANCELED` imutáveis); transições manuais; `ExecutionSummary` (soma, saldo, percentual, previsto vigente sem cancelados); `ConfidentialMaskingPolicy` (parcial, nulos); `behindSchedule`.
- **Integração (Testcontainers PostgreSQL + Redis):** tracker com eventos reais do outbox (duplicado, fora de ordem, atrasado); trava de linha; consulta agrupada com o predicado de visibilidade; leitura por `previousItemId` na janela de revisão; recontagem; rollback do ajuste sem evento.
- **API/contrato:** `PCA-25` a `PCA-28` com `ETag`/`If-Match`/`Idempotency-Key`; formato de campos mascarados (`…Masked`); aditividade com api.md.
- **RBAC e multi-tenant:** `PCA_VIEW` por escopo de unidade; `PCA_MANAGE` por secretaria; processo fora da visibilidade ausente na lista e na contagem; valor sigiloso ausente em resposta, log, auditoria e evento (teste de sigilo); plano e item de outro tenant → 404 (suíte `test/tenant-leak`).
- **Concorrência:** ajuste manual × tracker; dois ajustes; recontagem simultânea.
- **E2E (Playwright):** abrir plano, ver execução por secretaria, trocar agrupamento, filtrar, abrir processos do item, adiar item e ver o motivo; mascaramento para perfil sem a permissão.
- **Acessibilidade/performance:** axe na aba e no *drawer*; abertura da execução de 500 itens (p95 ≤ 2 s) e do `PCA-26`, na suíte de performance (medidas no endurecimento).

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
- [ ] Teste de sigilo: nenhum valor de processo sigiloso em resposta, log, auditoria ou evento para quem não tem POL-09
- [ ] Consumidor idempotente comprovado com eventos duplicados e fora de ordem

## Estimativa
**M** — consulta agrupada com visibilidade e sigilo, consumidor idempotente de eventos, ajuste manual com travas, recontagem e aba de execução com agrupamentos e filtros; sem nova entidade ou migração.

## Prioridade
**P1** — fecha o ciclo do PCA (planejar, aprovar, vincular, acompanhar) exigido pelo critério de saída do MVP 2 e alimenta os indicadores do EP-028; não bloqueia a aprovação nem o vínculo.
