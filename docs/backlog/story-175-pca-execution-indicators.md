---
id: US-175
title: "Indicadores de execução do PCA"
epic: EP-028
feature: FT-081
mvp: 2
priority: P1
estimate: S
status: Especificada
depends_on: [US-144, US-172]
modules: [analytics, pca, organization, catalog, access, audit]
screens: [SCR-027]
endpoints: [ANL-14]
permissions: [REPORT_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: []
---

# US-175 — Indicadores de execução do PCA

## Título
Indicadores de execução do PCA

## Descrição
**Como** gestor de contratações (`GESTOR_CONTRATACOES`), planejamento (`PLANEJAMENTO`), autoridade competente (`AUTORIDADE_COMPETENTE`), controle interno (`CONTROLE_INTERNO`) ou auditor (`AUDITOR`) com `REPORT_VIEW`, **quero** ver, para o exercício, quanto do valor **previsto** no PCA já está **vinculado** a processos e quanto já foi **concluído**, por secretaria, por categoria e por item, com a data da última atualização, **para** acompanhar o PCA durante o exercício e prestar contas à alta administração (Lei 14.133/2021, art. 11, parágrafo único) sem planilha manual e sem expor valores de orçamento sigiloso.

O relatório lê somente o read model (`AnalyticsPcaItemFact` e a visão `mv_analytics_pca_execution`), é recortado pelo escopo de `REPORT_VIEW`, e entra no catálogo da SCR-027 com a chave `pca-execution`. É o painel gerencial do exercício; o acompanhamento transacional item a item continua na aba "Execução" do PCA (US-144, SCR-018).

## Contexto
- DEC-197: acompanhamento da execução por item, secretaria e categoria. DEC-206: execução do PCA entre os relatórios do read model. FT-081 (RN-ANL-18): o relatório compara `plannedValue`, `linkedEstimatedValue` e processos concluídos; a soma dos vinculados exclui sigilosos para quem não tem a permissão (DEC-197, DEC-206, POL-09).
- **Duas visões, duas fontes (por decisão do épico):** a US-144 consulta os vínculos **na hora**, com o predicado de visibilidade da DEC-024 e a permissão de sigilo, e vive na SCR-018 sob `PCA_VIEW`. Esta story lê o **read model**, vive na SCR-027 sob `REPORT_VIEW`, soma o órgão ou a secretaria do escopo **sem** filtrar por visibilidade do processo (agregados — RN-ANL-11), aceita defasagem de até 5 minutos e mostra "dados atualizados em …". Os números podem diferir dos da aba "Execução" quando a pessoa não vê todos os processos; a tela explica a diferença (RN-ANL-148).
- A US-144 deixou claro que a US-175 **consome** `PcaItemChanged`, `ProcessPcaItemLinked` e eventos de processo pela projeção (US-170); esta story não escreve fatos.
- POL-28: totais sem processos sigilosos para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo, com `confidentialExcluded: true`; mascaramento por linha antes de agregar; proteção contra inferência por diferença entre somas.
- A estrutura de relatório (catálogo, filtros, cabeçalho "dados atualizados em …", escopo, formato da resposta) é da US-172; esta story acrescenta o relatório `pca-execution` e a exportação dele sai pela US-174.
- `CONSULTOR_EXTERNO` não tem `REPORT_VIEW` e, portanto, não vê o relatório (lacuna L-07 do PCA).

## Objetivo
Abrir o relatório do exercício (plano de até 5.000 itens) em até 2 s (p95, suíte de performance), com números que batem com o read model a cada reconciliação, 0 valor sigiloso ou item fora do escopo exposto, e a execução do PCA disponível a quem governa sem depender de planilha.

## Persona
- **Principal:** Planejamento (`PLANEJAMENTO`, `REPORT_VIEW` escopo `TENANT`) e Gestor de contratações (`GESTOR_CONTRATACOES`).
- **Secundárias:** Autoridade competente (`AUTORIDADE_COMPETENTE`, visão do exercício); Controle Interno e Auditor (`CONTROLE_INTERNO`, `AUDITOR`, leitura independente); gestor ou analista com `REPORT_VIEW` de escopo de secretaria (vê só os itens da sua secretaria).

## Pré-condições
- `REPORT_VIEW` com escopo que cubra ao menos uma secretaria com itens no plano.
- Plano do órgão no exercício `APPROVED` (vigente) e fatos projetados (US-170/US-171); sem plano aprovado, o relatório mostra estado vazio (FA-01).
- Visão `mv_analytics_pca_execution` atualizada (agenda do refresh — RN-ANL-10).

## Fluxo principal
1. Em `/relatorios` (SCR-027), a pessoa abre o cartão "Execução do PCA" (chave `pca-execution`) ou acessa `/relatorios/execucao-pca`.
2. O front chama `ANL-14` com o exercício padrão (ano corrente no fuso do tenant) e `groupBy=DEPARTMENT`. A API valida permissão e escopo, resolve o plano vigente e lê o read model.
3. A API calcula, por linha e **antes de agregar**, o tratamento do sigilo (RN-ANL-136), soma os grupos e o resumo e responde com `dataAsOf`, `confidentialExcluded`, o plano considerado e os grupos.
4. O front mostra o cabeçalho "Plano {ano} — versão {n}, aprovado em {data}" e "dados atualizados em …", os cartões do resumo ("Previsto", "Vinculado", "Saldo previsto não vinculado", "% executado", "Processos concluídos", "Itens contratados") e a tabela agrupada com barra de progresso acompanhada de texto.
5. A pessoa troca o agrupamento (Secretaria, Categoria ou Item), filtra (secretaria, categoria, situação do item, mês previsto, "sem vínculo", "acima do previsto"), ordena e, no agrupamento por item, pagina.
6. Para quem tem `REPORT_EXPORT`, o botão "Exportar" (US-174) leva a tabela atual para CSV ou XLSX.
7. Para quem tem `PCA_VIEW`, cada linha oferece "Abrir no PCA", que leva à aba "Execução" (SCR-018) com o mesmo recorte, onde se veem os processos vinculados.

## Fluxos alternativos
- **FA-01 — Sem plano aprovado no exercício:** `200` com `data.plan = null` e resumo zerado; a tela mostra "Não há plano aprovado para {ano}. Escolha outro exercício." com seletor de exercício.
- **FA-02 — Escopo de secretaria:** com `REPORT_VIEW` de unidade, o resumo e os grupos cobrem só os itens das secretarias do escopo; o resumo não traz o total do órgão e a tela diz "Mostrando: Secretaria de Saúde".
- **FA-03 — Valores sigilosos:** quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` vê `confidentialExcluded = true`, o aviso "Inclui valores sigilosos não exibidos" e, nas linhas afetadas, o vinculado sem os sigilosos e saldo e percentual indisponíveis ("—"); a UI oferece o *step-up* quando houver (POL-14).
- **FA-04 — Permissão de sigilo de escopo parcial:** a pessoa tem a permissão de sigilo só para a Secretaria de Saúde: as linhas dela mostram o valor completo e as das demais secretarias ficam mascaradas.
- **FA-05 — Item cancelado ou adiado:** itens `CANCELED` aparecem no agrupamento por item, mas não entram nos totais previstos; `POSTPONED` entra no previsto e na contagem por situação.
- **FA-06 — Dados desatualizados:** se a defasagem passar de 15 minutos (`stale`), a tela mostra "Os dados estão desatualizados desde {hora}. Os números podem não refletir as últimas alterações." e continua exibindo o último estado.
- **FA-07 — Exercício sem fatos ainda:** plano aprovado recentemente e fatos em projeção: a tela mostra "Os dados deste plano estão sendo preparados. Volte em alguns minutos." quando `itemsCount = 0` e o plano existe.
- **FA-08 — Filtro fora do escopo:** `departmentId` fora do escopo → `422 VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`); a UI só lista secretarias do escopo.
- **FA-09 — Plano revisado:** a revisão aprovada substitui a base do relatório assim que a projeção processa `PcaStatusChanged`; até lá a tela mostra a versão anterior com `dataAsOf` antigo.

## Regras de negócio
- **RN-ANL-130** — Fonte: `AnalyticsPcaItemFact` e `mv_analytics_pca_execution`, somente (RN-ANL-18, RN-ANL-19, RN-ANL-06). O relatório **nunca** lê `pcas`, `pca_items`, `processes` nem `ProcessStage`/`ProcessMovement`; nomes de secretaria e de categoria vêm de `organization` e `catalog` em lote, a partir dos ids e códigos dos fatos.
- **RN-ANL-131** — Plano considerado: o plano `APPROVED` (vigente) do órgão e do exercício `year`; `DRAFT`, `AWAITING_APPROVAL` e `SUPERSEDED` ficam fora. Com vários órgãos no tenant, o relatório soma os órgãos do escopo e `organizationId` filtra um deles. Sem plano → `plan = null` (FA-01).
- **RN-ANL-132** — Medidas (por linha, grupo e resumo): `itemsCount` (itens não `CANCELED`), `itemsByStatus`, **Previsto** `plannedValue` (soma dos itens não `CANCELED`), **Vinculado** `linkedEstimatedValue` (soma do valor estimado dos processos vinculados que contam — RN-PCA-301/302 —, sem sigilosos para quem não tem a permissão), `linkedProcessesCount`, **Concluído** (`completedProcessesCount` e `contractedItemsCount`: itens `CONTRACTED`), `itemsWithoutLink`, `balance` = previsto − vinculado (pode ser negativo) e `executionPercent` = vinculado ÷ previsto × 100 (nulo se previsto 0).
- **RN-ANL-133** — "Concluído" é **contagem** (processos vinculados concluídos e itens `CONTRACTED`), conforme a feature (RN-ANL-18); não há valor concluído porque o fato não o traz (lacuna 3). O texto da tela diz "Processos concluídos" e "Itens contratados", nunca "valor executado".
- **RN-ANL-134** — Agrupamentos: `DEPARTMENT` (secretaria do item), `CATEGORY` (categoria `PCA_CATEGORY` do item) e `ITEM` (paginado, uma linha por item com código, objeto resumido, secretaria, categoria, mês previsto, situação e os valores). Itens `CANCELED` aparecem em `ITEM` com a situação, mas não somam no previsto nem nas contagens.
- **RN-ANL-135** — Escopo (RN-ANL-11 aplicada ao PCA): `TENANT`/`ORGANIZATION` veem todos os itens do recorte; `DEPARTMENT`/`OWN_DEPARTMENTS` veem os itens cuja **secretaria do item** (`departmentId` do fato) está no escopo. Não há aplicação do predicado de visibilidade de processos (DEC-024): o relatório não lista processos (FA e RN-ANL-148).
- **RN-ANL-136** — Sigilo (POL-28, POL-09, DEC-206): o fato guarda o vinculado **sem** sigilosos e, em campos próprios, a existência e a soma dos vinculados sigilosos (lacuna 2). Para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo a secretaria do item: `linkedEstimatedValue` exclui os sigilosos; a linha com ao menos um vínculo sigiloso traz `linkedEstimatedValueMasked = true` e `balance`, `executionPercent` e `overPlanned` **nulos**; grupos e resumo que contenham uma linha assim também trazem `balance`, `executionPercent` e `overPlanned` nulos e `…Masked = true`; `confidentialExcluded = true` no nível do relatório. A resposta **não** informa quantos processos ou quanto valor foram excluídos. Quem tem a permissão vê a soma completa.
- **RN-ANL-137** — Permissão de sigilo de escopo parcial: quando a permissão não cobre todas as secretarias do recorte, a API **não** usa a coluna de sigilosos da visão; calcula a partir dos fatos por linha, desmascarando só os itens cuja secretaria está no escopo da permissão, e aplica RN-ANL-136 ao restante.
- **RN-ANL-138** — Proteção contra inferência (POL-28): totais, grupos e linhas usam **a mesma base** (sem sigilosos para quem não pode ver); ordenar por `linkedEstimatedValue`, `balance` ou `executionPercent` e filtrar por "acima do previsto" usam apenas valores visíveis (linhas mascaradas são tratadas como sem valor e vão ao fim, e `overPlanned` as ignora); a paginação é estável (desempate por `code`); nenhuma resposta, exportação, log ou auditoria traz valor mascarado. Recortes diferentes do mesmo exercício nunca somam de bases distintas.
- **RN-ANL-139** — Leitura: agrupamentos `DEPARTMENT` e `CATEGORY` sem filtro de situação, mês ou vínculo vêm de `mv_analytics_pca_execution` (tenant, exercício, secretaria, categoria); com esses filtros e em `ITEM`, vêm de `AnalyticsPcaItemFact` pelos índices `(tenant_id, year, department_id)` e `(tenant_id, year, category_code)`. Os dois caminhos devem dar o mesmo número (teste de paridade).
- **RN-ANL-140** — Cabeçalho e atualidade: a resposta traz `meta.dataAsOf` e `meta.stale` (defasagem > 15 min, o mesmo cálculo do cabeçalho da US-172), o plano considerado (`pcaId`, `versionNumber`, `approvedAt`) e `meta.scope`.
- **RN-ANL-141** — `behindSchedule` por item (agrupamento `ITEM`): item `PLANNED` em exercício corrente ou anterior cujo `plannedMonth` já terminou no fuso do tenant (mesma regra do RN-PCA-314, calculada sobre o fato); agregado em `itemsBehindSchedule` nos grupos.
- **RN-ANL-142** — Exercício: `year` é o ano do plano (não depende de `analytics.fiscalYearStartMonth`, que serve aos recortes por período dos demais relatórios); padrão = ano corrente no fuso do tenant; faixa de 2000 ao ano corrente + 1.
- **RN-ANL-143** — Ordenação e paginação: `sort` ∈ `code` (padrão), `-plannedValue`, `-linkedEstimatedValue`, `-balance`, `-executionPercent`, `plannedMonth`, `label`; `pageSize` ≤ 100 e só em `ITEM`; grupos vêm completos (no máximo uma linha por secretaria ou categoria).
- **RN-ANL-144** — Sem auditoria de leitura: o relatório não detalha processos (itens do PCA não são processos), por isso não gera `report.view_detail`; a exportação gera `report.export` (US-174). Negativas geram `access.denied`.
- **RN-ANL-145** — Exportação: o provedor `pca-execution` implementa `SUMMARY` com a tabela do agrupamento corrente (inclusive `ITEM`, até 50.000 linhas) e não implementa `DETAIL`; usa a mesma consulta (RN-ANL-112 da US-174).
- **RN-ANL-146** — Catálogo: o relatório é registrado no catálogo da US-172 com `key = pca-execution`, `exportable = true`, tela SCR-027 e permissão `REPORT_VIEW`; aparece apenas para quem tem `REPORT_VIEW`.
- **RN-ANL-147** — Resultado vazio por escopo: com escopo de secretaria sem itens no plano, `200` com lista vazia e resumo zerado, sem revelar itens de outras secretarias.
- **RN-ANL-148** — Texto de apoio fixo na tela: "Totais do plano a partir dos dados do read model, atualizados a cada poucos minutos. Podem diferir da aba Execução do PCA, que considera apenas os processos que você pode ver."
- **RN-ANL-149** — A leitura é somente-leitura, com `statement_timeout` de 5 s e um único *round-trip* por visão; um *snapshot* por requisição (resumo e grupos calculados da mesma leitura).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Exercício | `year` | inteiro | Não | RN-ANL-142 | ano corrente |
| Órgão | `organizationId` | lista de uuid | Não | no escopo | todos do escopo |
| Agrupar por | `groupBy` | `DEPARTMENT`, `CATEGORY`, `ITEM` | Não | RN-ANL-134 | `DEPARTMENT` |
| Secretaria | `departmentId` | lista de uuid | Não | no escopo da pessoa | — |
| Categoria | `categoryCode` | lista de texto | Não | `PCA_CATEGORY` | — |
| Situação do item | `status` | lista de `PcaItemStatus` | Não | vírgula = OU | todas |
| Mês previsto | `plannedMonth` | 1..12 | Não | — | — |
| Sem vínculo | `withoutLink` | booleano | Não | itens com `linkedProcessesCount = 0` | `false` |
| Acima do previsto | `overPlanned` | booleano | Não | ignora linhas mascaradas (RN-ANL-138) | `false` |
| Ordenação | `sort` | texto | Não | RN-ANL-143 | `code` |
| Paginação | `page`, `pageSize` | inteiros | Não | `pageSize` ≤ 100, só em `ITEM` | 1 / 50 |
| Previsto | `plannedValue` | decimal(18,2) | — | RN-ANL-132 | fato |
| Vinculado | `linkedEstimatedValue` | decimal(18,2) | — | nulo + `linkedEstimatedValueMasked` quando aplicável | fato |
| Saldo | `balance` | decimal | — | nulo se mascarado | cálculo |
| % executado | `executionPercent` | decimal(5,2) | — | nulo se previsto 0 ou mascarado | cálculo |
| Processos / itens concluídos | `completedProcessesCount`, `contractedItemsCount` | inteiros | — | RN-ANL-133 | fato |
| Sigilo | `meta.confidentialExcluded` | booleano | — | RN-ANL-136 | calculado |
| Data dos dados | `meta.dataAsOf`, `meta.stale` | data/hora, booleano | — | RN-ANL-140 | read model |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `groupBy`, `status`, `sort`, `plannedMonth` ou `pageSize` fora do domínio | Front + API (Zod) | "Filtro inválido." | `VALIDATION_ERROR` (`INVALID_ENUM`/`OUT_OF_RANGE`) |
| V-02 | `year` fora de 2000 até o ano corrente + 1 | Front + API (Zod) | "Informe um exercício entre 2000 e {anoMax}." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-03 | `departmentId`/`organizationId` fora do escopo ou de outro tenant | API | "Secretaria não encontrada no seu escopo." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-04 | Sem `REPORT_VIEW` | API | "Você não tem permissão para ver os relatórios." | `PERMISSION_DENIED` |
| V-05 | `pageSize` informado fora de `ITEM` | API | "A paginação só vale para o agrupamento por item." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |

## Permissões
- **Permissão:** `REPORT_VIEW` (risco `L`) para `ANL-14`, com escopo `TENANT`/`ORGANIZATION` (todo o recorte) ou `DEPARTMENT`/`OWN_DEPARTMENTS` (itens da secretaria); `PROCESS_VIEW_CONFIDENTIAL_BUDGET` apenas para incluir valores sigilosos nas somas e nas linhas. `REPORT_EXPORT` só para exportar (US-174).
- **Políticas:** POL-28 (relatórios e sigilo), POL-09 (estendida a fatos e agregados), POL-14 (o desmascaramento em leitura sem MFA não gera `403`: devolve mascarado e a UI oferece o *step-up*). A DEC-024 não se aplica (o relatório não lista processos).
- **MFA:** não exigido por permissão de risco `L`; vale a exceção do *step-up* para desmascarar.
- **Sem permissão:** o cartão "Execução do PCA" não aparece; a API responde `403 PERMISSION_DENIED` e registra `access.denied` (`reasonCode` = `REPORT_VIEW`). Recurso de outro tenant: `404 NOT_FOUND`. `CONSULTOR_EXTERNO`: sem `REPORT_VIEW`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio (somente leitura). Os fatos são alimentados por `pca.*` e `process.*` pela projeção da US-170. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | Nenhuma | — | Somente leitura. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Indicadores de execução do PCA

  Background:
    Given que o tenant "Prefeitura A" está ativo e o read model foi atualizado há 2 minutos
    And o plano "PCA 2027" está "APPROVED" na versão 2 com 120 itens de 5 secretarias
    And "Gil" tem "REPORT_VIEW" com escopo "TENANT" e não tem a permissão de sigilo
    And "Rita" tem "REPORT_VIEW" com escopo "TENANT" e "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    And o item "PCA-014" da Saúde está vinculado a um processo com orçamento sigiloso

  Scenario: [Sucesso] Ver a execução por secretaria
    When "Gil" abrir o relatório "pca-execution" do exercício 2027
    Then deve ver o plano "versão 2" e "dados atualizados em" com a hora da última atualização
    And cada secretaria deve trazer previsto, vinculado, saldo, percentual, processos concluídos e itens contratados
    And o resumo deve somar os itens que não estão "CANCELED"

  Scenario: [Sucesso] Trocar para categoria e para item
    When "Gil" agrupar por "CATEGORY" e depois por "ITEM" com "pageSize" 50
    Then as linhas por categoria devem somar o mesmo previsto do agrupamento por secretaria
    And o agrupamento por item deve trazer código, objeto, secretaria, mês previsto e situação, com paginação

  Scenario: [Sucesso] Sigilo mascarado por linha antes de agregar
    When "Gil" abrir o relatório "pca-execution"
    Then a linha do item "PCA-014" deve ter o vinculado sem o valor sigiloso e "linkedEstimatedValueMasked" verdadeiro
    And saldo e percentual dessa linha, da secretaria "Saúde" e do resumo devem ser nulos
    And "confidentialExcluded" deve ser verdadeiro e a tela deve avisar "Inclui valores sigilosos não exibidos"
    And a resposta não deve informar quantos processos ou qual valor foram excluídos

  Scenario: [Sucesso] Quem tem a permissão de sigilo vê a soma completa
    When "Rita" abrir o relatório "pca-execution"
    Then o vinculado da secretaria "Saúde" deve incluir o valor do processo sigiloso
    And "confidentialExcluded" deve ser falso e saldo e percentual devem estar preenchidos

  Scenario: [Sucesso] Permissão de sigilo só da Saúde
    Given que "Luna" tem "PROCESS_VIEW_CONFIDENTIAL_BUDGET" apenas da "Secretaria de Saúde" e "REPORT_VIEW" com escopo "TENANT"
    When "Luna" abrir o relatório
    Then as linhas da "Saúde" devem trazer a soma completa
    And as linhas das demais secretarias com vínculo sigiloso devem ficar mascaradas

  Scenario: [Sucesso] Ordenar e filtrar sem revelar valor sigiloso
    When "Gil" ordenar por "-linkedEstimatedValue" e filtrar "overPlanned"
    Then a ordem deve usar só os valores visíveis e a linha mascarada deve ir ao fim
    And "overPlanned" deve ignorar a linha mascarada

  Scenario: [Sucesso] Escopo de secretaria
    Given que "Marta" tem "REPORT_VIEW" com escopo apenas da "Secretaria de Educação"
    When "Marta" abrir o relatório "pca-execution"
    Then deve ver apenas os itens da Educação
    And o resumo não deve trazer o total do órgão

  Scenario: [Sucesso] Exercício sem plano aprovado
    When "Gil" abrir o relatório do exercício 2030
    Then a API deve responder 200 com "plan" nulo e o resumo zerado
    And a tela deve dizer "Não há plano aprovado para 2030. Escolha outro exercício."

  Scenario: [Sucesso] Dados desatualizados são sinalizados
    Given que a última atualização do read model foi há 40 minutos
    When "Gil" abrir o relatório
    Then "meta.stale" deve ser verdadeiro e a tela deve avisar que os dados estão desatualizados

  Scenario: [Validação] Parâmetros inválidos
    When "Gil" pedir "groupBy" "REGION", "year" 1990 e "plannedMonth" 13
    Then a API deve responder 422 com código "VALIDATION_ERROR" apontando cada campo
    And nenhuma consulta ao read model deve ser executada

  Scenario: [Validação] Secretaria fora do escopo no filtro
    Given que "Marta" tem escopo apenas da "Secretaria de Educação"
    When "Marta" filtrar "departmentId" da "Secretaria de Saúde"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND"

  Scenario: [Permissão] Sem REPORT_VIEW
    Given que "Clara" não tem "REPORT_VIEW"
    When "Clara" pedir "GET /reports/pca-execution"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And o cartão "Execução do PCA" não deve aparecer para ela
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Dados de outro tenant não aparecem
    Given que o tenant "Prefeitura B" tem plano aprovado e fatos próprios
    When "Gil" abrir o relatório em "Prefeitura A"
    Then nenhuma linha, valor ou secretaria de "Prefeitura B" deve aparecer
    And informar um "departmentId" de "Prefeitura B" deve resultar em 422 "REFERENCE_NOT_FOUND"

  Scenario: [Duplicidade] Evento reprocessado não duplica a soma
    Given que o evento "pca.item_changed" do item "PCA-014" foi entregue duas vezes à projeção
    When "Gil" abrir o relatório
    Then o previsto e o vinculado do item devem ser contados uma única vez

  Scenario: [Duplicidade] Leituras repetidas dão o mesmo resultado
    When "Gil" repetir a mesma consulta três vezes sem novos eventos
    Then os números e "dataAsOf" devem ser idênticos nas três respostas

  Scenario: [Concorrência] Refresh da visão durante a leitura
    Given que o refresh "CONCURRENTLY" de "mv_analytics_pca_execution" ocorre durante a consulta
    When "Gil" abrir o relatório
    Then resumo e grupos devem vir do mesmo estado do read model, sem total diferente da soma dos grupos

  Scenario: [Concorrência] Revisão aprovada enquanto o relatório está aberto
    Given que "Gil" está com o relatório da versão 2 aberto
    When a revisão da versão 3 for aprovada e projetada
    And "Gil" recarregar o relatório
    Then deve ver a versão 3 e o resumo recalculado, sem itens da versão 2

  Scenario: [Falha de banco] Banco indisponível na leitura
    Given que o banco de dados está indisponível
    When "Gil" abrir o relatório
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a tela deve oferecer "Tentar novamente" e manter os filtros

  Scenario: [Falha de integração] Refresh das visões falhou
    Given que o último refresh de "mv_analytics_pca_execution" falhou e "dataAsOf" está há 2 horas
    When "Gil" abrir o relatório
    Then a API deve responder 200 com o último estado e "meta.stale" verdadeiro
    And a tela deve mostrar "dados atualizados em" com a hora antiga e o aviso de atraso

  Scenario: [Sucesso] Exportar a execução do PCA
    Given que "Rita" tem "REPORT_EXPORT"
    When "Rita" exportar o relatório "pca-execution" em "XLSX"
    Then o arquivo deve ter as mesmas linhas da tela e a mesma base de valores
    And a exportação deve constar na auditoria como "report.export"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Parâmetro inválido | 422 | `VALIDATION_ERROR` | "Filtro inválido." / "Informe um exercício entre 2000 e {anoMax}." | Erro no campo |
| Secretaria fora do escopo | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Secretaria não encontrada no seu escopo." | Remove o filtro |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para ver os relatórios." | Oculta o cartão |
| Recurso de outro tenant | 404 | `NOT_FOUND` | "Relatório não encontrado." | Volta ao catálogo |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar o relatório agora. Tente novamente em instantes." | Botão "Tentar novamente", filtros mantidos |
| Muitas requisições | 429 | `RATE_LIMITED` | "Muitas consultas em pouco tempo. Aguarde alguns instantes." | Reabilita após `Retry-After` |

## Dependências
- **Stories:** US-144 (execução do PCA, eventos `PcaItemChanged` e regras RN-PCA-301/302/307/314 de que os fatos derivam), US-172 (catálogo de relatórios, filtros, escopo, cabeçalho "dados atualizados em …"). Indiretas: US-170/US-171 (fatos e reconciliação), US-013 e US-097 (sigilo e autorização), US-174 (exportação), US-142 (vínculos).
- **Decisões/ADRs:** DEC-197, DEC-206, ADR-014, DEC-030, DEC-024, DEC-163; POL-28, POL-09, POL-14.
- **Configurações:** nenhuma chave nova (o exercício do PCA é o ano do plano; `analytics.fiscalYearStartMonth` não se aplica aqui).
- **Lacunas nas fontes canônicas:**
  1. `AnalyticsPcaItemFact` (entities.md §4.11) não traz a situação do plano (`planStatus`/versão): para que o relatório considere só o plano vigente, a projeção precisa gravar `pcaStatus` (`PcaPlanStatus`) e `versionNumber` e a visão `mv_analytics_pca_execution` deve filtrar `APPROVED`; alternativa: remover os fatos da versão superada na projeção de `PcaStatusChanged`. Ajuste em US-170 e na entidade.
  2. A mesma entidade guarda `linkedEstimatedValue` "sem os sigilosos para quem não tem POL-09 na leitura", o que é ambíguo: para o mascaramento por linha (RN-ANL-136/137) o fato precisa de `linkedEstimatedValue` (sem sigilosos), `linkedConfidentialValue` (soma dos sigilosos) e `confidentialLinkedCount`, e a visão deve trazer a soma dos sigilosos em coluna separada (já prevista em §4.11). Ajuste em US-170.
  3. O fato não traz **valor concluído** (só `completedProcessesCount`); "concluído" é contagem nesta story (RN-ANL-133). Se o produto quiser valor concluído, acrescentar `completedEstimatedValue` ao fato.
  4. O fato não traz o objeto do item: a linha por item mostra código, categoria, secretaria e mês; proposta `objectSummary` (varchar(200), conteúdo público do PCA) em `AnalyticsPcaItemFact` para a coluna "Objeto".
  5. Endpoint `ANL-14` (`GET /reports/pca-execution`) e a chave de catálogo `pca-execution`; a rota convive com `GET /reports/{report}`: `pca-execution` é chave reservada e a rota literal tem precedência.
  6. A feature FT-081 chama a execução de "previsto × vinculado × concluído"; fixada aqui a distinção entre as duas leituras (US-144 × US-175) e o texto de apoio da tela (RN-ANL-148): confirmar com o produto.
  7. A janela de reconciliação de revisão (US-143, vínculos via `previousItemId`) pode deixar o vinculado temporariamente abaixo do real no read model; resolvida pela reconciliação noturna (US-171) ou pelo reprocessamento dos eventos de vínculo.

## Impacto técnico
- **Performance:** meta p95 ≤ 2 s para o exercício completo (≤ 5.000 itens), medida na suíte de performance (endurecimento); agrupamentos por secretaria e categoria saem da visão (linhas por exercício, secretaria e categoria) e o agrupamento por item da tabela de fatos, com `LIMIT` na paginação. Sem cache de aplicação: a visão já é o cache e a defasagem aceita é de minutos.
- **Segurança:** o mascaramento é por linha antes de somar; nenhuma resposta calcula uma soma que inclua sigiloso para quem não pode ver; ordenação, filtro e paginação usam a base visível; logs sem valores.
- **Consistência:** leitura em um único *snapshot* por requisição; os dois caminhos (visão e fatos) são cobertos por teste de paridade.
- **Compatibilidade:** sem alteração de endpoints do MVP 1; reaproveita o formato de resposta e o cabeçalho da US-172.
- **Risco de interpretação:** os números da SCR-027 e da aba "Execução" (SCR-018) divergem quando a pessoa não vê todos os processos; mitigado pelo texto de apoio e pela documentação do guia do usuário.

## Backend
- **Módulo(s):** `analytics` (consulta, regras de sigilo, agrupamento), `organization` e `catalog` (rótulos em lote), `access` (escopo e permissão de sigilo), `audit`.
- **Casos de uso:** `GetPcaExecutionReportQuery` (`ANL-14`), `PcaExecutionExportProvider` (provedor `pca-execution`, US-174).
- **Domínio:** `PcaExecutionAggregator` (medidas, saldo, percentual, `behindSchedule`), `ConfidentialValuePolicy` (mesma da tela e da exportação), `PcaExecutionScopeFilter` (secretaria do item), `ReportFreshness`.
- **Integrações internas:** repositório do `analytics` (funções `security definer` com o tenant da sessão para a visão e `SELECT` com RLS para os fatos), `AccessScopeResolver`, `CatalogLabelResolver`, `DepartmentLabelResolver`.
- **Transação:** leitura única `READ ONLY` com `statement_timeout` de 5 s; sem escrita.

## Frontend
- **Tela(s):** SCR-027 (`/relatorios`, cartão "Execução do PCA") e `/relatorios/execucao-pca` (SCR-027, relatório aberto).
- **Componentes:** `PcaExecutionSummaryCards`, `PcaExecutionTable` (agrupada, com `ProgressBar` acompanhada de texto "{x} % executado"), `GroupBySwitch`, `ReportFilters` (da US-172), `ConfidentialExcludedNotice`, `DataAsOfBadge`, `ExportButton` (US-174), `OpenInPcaLink`.
- **Estados:** loading (skeleton), vazio (sem plano aprovado ou sem itens no escopo), erro com "Tentar novamente", sucesso; estado "mascarado" com "—" e tooltip "Inclui valores sigilosos não exibidos".
- **Acessibilidade e responsividade:** barras de progresso com texto e `aria-valuenow`; situação do item por texto e ícone; tabela rolável com cabeçalho fixo em telas largas e cartões abaixo de 768 px; valores monetários com `R$` e alinhamento à direita; teclado completo no seletor de agrupamento.

## Banco de dados
- **Tabelas:** leitura de `analytics_pca_item_facts` e da visão `mv_analytics_pca_execution` (donos `analytics`); nenhuma tabela nova.
- **Migrações:** nenhuma nesta story; os ajustes propostos nas lacunas 1, 2 e 4 entram nas migrações da US-170/M2-19.
- **Índices/constraints relevantes:** `(tenant_id, year, department_id)` e `(tenant_id, year, category_code)` nos fatos; índice único `(tenant_id, year, department_id, category_code)` da visão (exigido pelo `CONCURRENTLY`); função `security definer` `analytics_pca_execution(tenant, year, scope…)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `ANL-14` | GET | `/reports/pca-execution` | `year`, `organizationId[]`, `groupBy`, `departmentId[]`, `categoryCode[]`, `status[]`, `plannedMonth`, `withoutLink`, `overPlanned`, `sort`, `page`, `pageSize` | `200 { data: { plan { pcaId, versionNumber, approvedAt, year } \| null, summary, groups[] \| items[] }, meta: { dataAsOf, stale, confidentialExcluded, scope { level, departmentIds? }, page?, totalItems? } }` | 200, 403, 404, 422, 429, 503 |

## Logs
- `info` `analytics.pca_execution.read` — `groupBy`, `year`, `durationMs`, `rowsReturned`, `source` (`MV` ou `FACTS`), `confidentialExcluded`.
- `warn` `analytics.pca_execution.stale` — `dataAsOf`, `lagMinutes`.
- `error` `analytics.pca_execution.failed` — `errorCode`, `durationMs`.
- **Nunca logar:** valores monetários, códigos e objetos dos itens, nomes de pessoas e filtros por secretaria do solicitante em nível `info` de alta cardinalidade.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `access.denied` | `ACCESS` | Tentativa sem `REPORT_VIEW` | `reasonCode` = `REPORT_VIEW` |
| — | — | Leitura do relatório | Sem registro (RN-ANL-144); a exportação gera `report.export` na US-174 |

## Testes necessários
- **Unitários:** `PcaExecutionAggregator` (previsto, vinculado, saldo, percentual, cancelados, `behindSchedule`); `ConfidentialValuePolicy` (linha, grupo, resumo, ordenação e filtro); `PcaExecutionScopeFilter`; validação de parâmetros.
- **Integração (Testcontainers PostgreSQL):** leitura da visão e dos fatos com RLS e funções `security definer`; paridade visão × fatos; refresh `CONCURRENTLY` durante a leitura; plano revisado; permissão de sigilo de escopo parcial; dado desatualizado.
- **API/contrato:** `ANL-14` (formato da resposta, `meta`, `confidentialExcluded`, `plan` nulo); códigos de erro.
- **RBAC e multi-tenant:** `REPORT_VIEW` por escopo (órgão e secretaria); sem `REPORT_VIEW` → 403; `CONSULTOR_EXTERNO` sem acesso; fatos de outro tenant nunca aparecem (suíte `test/tenant-leak`); **teste de sigilo e de inferência**: nenhum valor sigiloso em resposta, ordenação, filtro, exportação, log e auditoria, inclusive por diferença entre recortes.
- **Concorrência:** leitura durante refresh; projeção de revisão durante a leitura; eventos duplicados e fora de ordem.
- **E2E (Playwright):** abrir o cartão, trocar agrupamento, filtrar, ver o aviso de sigilo, exportar, abrir no PCA.
- **Acessibilidade/performance:** axe na tela; exercício com 5.000 itens com p95 ≤ 2 s na suíte de performance (medida no endurecimento).

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
- [ ] Teste de sigilo e de inferência por diferença de somas verde
- [ ] Teste de paridade visão × fatos e tela × exportação verde
- [ ] Teste de arquitetura: nenhuma consulta a `pcas`, `pca_items`, `processes`, `ProcessStage` ou `ProcessMovement` neste relatório

## Estimativa
**S** — reaproveita a estrutura de relatório, o escopo e o cabeçalho da US-172 e as regras de sigilo já fixadas; o trabalho é uma consulta com três agrupamentos, o mascaramento por linha, o provedor de exportação e uma tela de tabela com cartões.

## Prioridade
**P1** — acompanhar o PCA durante o exercício, e não só ao final, é critério de aceite da FT-081 e insumo da prestação de contas; depende da US-172 e não bloqueia as demais stories do épico.
