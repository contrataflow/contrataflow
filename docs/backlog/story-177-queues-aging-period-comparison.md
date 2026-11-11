---
id: US-177
title: "Filas, envelhecimento e comparação entre períodos"
epic: EP-028
feature: FT-082
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-176]
modules: [analytics, workflow, organization, identity, process, access, audit]
screens: [SCR-028]
endpoints: [ANL-17, ANL-18]
permissions: [REPORT_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: []
---

# US-177 — Filas, envelhecimento e comparação entre períodos

## Título
Ver filas, envelhecimento e comparar períodos nos gargalos

## Descrição
**Como** gestor de contratações (`GESTOR_CONTRATACOES`), controle interno (`CONTROLE_INTERNO`), auditor (`AUDITOR`) ou autoridade competente (`AUTORIDADE_COMPETENTE`) com `REPORT_VIEW`, **quero** ver o que está **parado agora** em cada etapa, unidade ou responsável (filas), há **quanto tempo** (envelhecimento em faixas) e **comparar** o mesmo indicador de tempo entre dois períodos de mesma duração (por exemplo, este trimestre e o anterior), **para** orientar a redistribuição de trabalho e o escalonamento e saber se uma mudança de processo ou de prazo funcionou.

Complementa a US-176: lá o tempo é medido nas passagens **fechadas**; aqui as **abertas** formam filas e faixas de envelhecimento (RN-ANL-22) e as fechadas de dois períodos alimentam a comparação. Tudo vem do read model (`AnalyticsStageFact` e `mv_analytics_stage_monthly`), nas abas "Filas", "Envelhecimento" e "Comparação" da SCR-028 (`/relatorios/gargalos`).

## Contexto
- DEC-206, ADR-014, roadmap §4.2. FT-082: filas = "o que está parado agora em cada etapa, unidade ou responsável (passagens abertas)"; envelhecimento = "distribuição do tempo parado por faixas"; comparação = "o mesmo indicador em dois recortes". RN-ANL-22 (abertas compõem filas e envelhecimento; fechadas compõem tempos e comparações), RN-ANL-23 (dias úteis descontadas as pausas; sem `MIGRATED`, `SKIPPED`, `CANCELED`), **RN-ANL-24** (comparação exige períodos de mesma duração e mostra o tamanho da amostra de cada um, sinalizando amostra pequena), RN-ANL-25 (drill-down com visibilidade e sigilo), RN-ANL-26 (responsável sob escopo e auditoria).
- Esta story **reaproveita** da US-176 o agregador de duração (`StageDurationAggregator`), a atribuição por data de saída (RN-ANL-153), as medidas e o limite de amostra (RN-ANL-154 a RN-ANL-156), o escopo pela unidade da etapa (RN-ANL-158), o drill-down `ANL-16` com `state=OPEN` (RN-ANL-162/163), a auditoria `report.view_detail` (RN-ANL-164), o texto fixo do responsável (RN-ANL-161) e a atualidade (RN-ANL-168). As definições de dias úteis, pausas, devolução e cumprimento de prazo são da US-172 (RN-ANL-70..89).
- O fato de passagem **calcula** a duração no fechamento (entities.md §4.11); passagens abertas não têm duração gravada. A idade das abertas é calculada **na leitura**, com o mesmo calendário de dias úteis do tenant (feriados do tenant) e descontando as pausas (RN-ANL-171). Faixas de envelhecimento e granularidade da comparação não estavam fixadas nas fontes: ficam fixadas aqui (RN-ANL-172, RN-ANL-179, RN-ANL-180) e comunicadas aos demais cards.
- Armadilha conhecida da análise com passagens fechadas: no período **ainda em andamento**, as passagens longas continuam abertas e ficam de fora, o que faz o tempo médio parecer menor do que será. Por isso a comparação sinaliza o período atual incompleto e a aba "Filas" traz o outro lado (RN-ANL-181).
- Escopo, visibilidade e sigilo como nos relatórios (POL-28). Os gargalos não somam valores; o valor aparece só por linha no drill-down, mascarado conforme a POL-09.
- Metas (p95 ≤ 2 s) viram cenários da suíte de performance, medidas no endurecimento.

## Objetivo
Mostrar, em até 2 s (p95, suíte de performance), o que está parado agora e há quanto tempo, e a variação entre dois períodos comparáveis com amostra de cada um, com 0 comparação entre períodos de durações diferentes, 0 processo não visível ou valor sigiloso exposto na lista da fila, e filas coerentes com o fechamento das passagens após cada reconciliação.

## Persona
- **Principal:** Gestor de contratações (`GESTOR_CONTRATACOES`, `REPORT_VIEW` escopo `TENANT` ou de secretaria).
- **Secundárias:** Controle Interno e Auditor (`CONTROLE_INTERNO`, `AUDITOR`); Autoridade competente (`AUTORIDADE_COMPETENTE`, visão agregada por unidade); responsáveis de unidade com `REPORT_VIEW` de escopo próprio (veem as filas da sua unidade).

## Pré-condições
- `REPORT_VIEW` com escopo que cubra ao menos uma unidade com passagens.
- Fatos projetados (US-170) e reconciliados (US-171); passagens abertas têm `exitedAt` nulo e, quando em pausa, `pausedSince` (lacuna 1).
- Para comparar: dois períodos de meses inteiros, com mesma duração (RN-ANL-179).
- Calendário do tenant (feriados) disponível para o cálculo de dias úteis na leitura (RN-ANL-171).

## Fluxo principal
1. Em `/relatorios/gargalos` (SCR-028), a pessoa abre a aba "Filas".
2. O front chama `ANL-17` com `groupBy=STAGE` (padrão) e os filtros. A API valida permissão, escopo e filtros e lê as passagens **abertas** do read model.
3. A API calcula a idade de cada passagem aberta em dias úteis, descontadas as pausas (RN-ANL-171), distribui nas faixas (RN-ANL-172) e agrega por grupo (RN-ANL-173).
4. O front mostra "Fila em {data e hora}" e "dados atualizados em …", o resumo ("{n} passagens paradas, {m} processos, a mais antiga com {x} dias úteis, {k} vencidas") e a tabela por etapa: passagens abertas, processos distintos, idade média, mediana e a mais antiga, vencidas, em pausa e a barra empilhada de faixas com os números em texto.
5. A aba "Envelhecimento" mostra a mesma base como **distribuição** por faixa (0–2, 3–5, 6–10, 11–20 e 21+ dias úteis) por etapa ou unidade, com a contagem e o percentual de cada faixa.
6. Ao abrir uma linha ou uma faixa (por exemplo, "Jurídico" na faixa "21+"), o front chama `ANL-16` com `state=OPEN` e, opcionalmente, `agingBand`, e lista as passagens paradas, da mais antiga para a mais nova, só de processos que a pessoa pode ver, com link para `/processos/[id]`.
7. Na aba "Comparação", a pessoa escolhe a dimensão e o **par de períodos**: um atalho ("Mês", "Trimestre", "Semestre" ou "Exercício", comparando o atual com o imediatamente anterior) ou datas personalizadas de mesma duração. O front chama `ANL-18`.
8. A API valida a comparabilidade (RN-ANL-179), calcula as medidas dos dois períodos pela mesma regra da US-176 e a variação, e responde com o tamanho da amostra de cada período e os avisos.
9. O front mostra, por grupo, os dois períodos lado a lado, a variação absoluta e percentual dos tempos e em pontos percentuais do prazo e das devoluções, com setas acompanhadas de texto ("aumentou 1,92 dia útil, +38,4%") e selos de "Amostra pequena" e "Período atual em andamento".
10. Para quem tem `REPORT_EXPORT`, o botão "Exportar" (US-174) leva a tabela da aba atual ou as passagens da fila de um grupo para CSV ou XLSX.

## Fluxos alternativos
- **FA-01 — Nada parado:** sem passagens abertas no escopo, `200` com lista vazia; a tela mostra "Nenhum processo parado neste escopo agora."
- **FA-02 — Passagem em pausa:** passagem pausada (diligência do jurídico, suspensão) tem a idade congelada no início da pausa e aparece com "em pausa"; não entra em "vencidas" enquanto pausada.
- **FA-03 — Escopo de unidade:** com `REPORT_VIEW` de unidade, as filas e as faixas cobrem só passagens cuja **unidade da etapa** está no escopo; por responsável, só as passagens dessas unidades ("Considera apenas as etapas das suas unidades.").
- **FA-04 — Fila por responsável:** `groupBy=ASSIGNEE` mostra quem tem processos parados, sem posição numerada nem cores de melhor ou pior, com o texto fixo "Análise do fluxo dos processos. Não é avaliação de desempenho individual." e a abertura auditada (RN-ANL-188).
- **FA-05 — Processos não visíveis:** a lista da fila mostra só os processos visíveis (DEC-024); `meta.processVisibility = RESTRICTED` mostra "Esta lista mostra apenas os processos que você pode ver; os números do quadro consideram todos os do seu escopo."
- **FA-06 — Valor sigiloso na lista:** linha com orçamento sigiloso mostra "Sigiloso" para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo.
- **FA-07 — Períodos de durações diferentes:** `422 PERIODS_NOT_COMPARABLE` com `meta.reason = DIFFERENT_DURATION` e as durações; a UI explica "Escolha dois períodos com o mesmo número de meses (por exemplo, trimestre contra trimestre)."
- **FA-08 — Período fora do alinhamento de meses ou sobreposto:** `422 PERIODS_NOT_COMPARABLE` com `meta.reason = NOT_MONTH_ALIGNED`, `OVERLAPPING` ou `TOO_LONG`; a UI marca o campo.
- **FA-09 — Período atual em andamento:** `meta.currentPeriodIncomplete = true`; a tela avisa "O período atual ainda não terminou. Passagens em andamento não entram nos tempos e o resultado tende a parecer menor." e oferece "Ver fila agora".
- **FA-10 — Amostra pequena:** período com menos de 10 passagens no grupo recebe `smallSample`; a linha traz `lowConfidence = true` e o aviso "Comparação com amostra pequena em um dos períodos."
- **FA-11 — Grupo em um só período:** grupo com passagens apenas no período atual (ou só no anterior) aparece com `presence = ONLY_CURRENT` (ou `ONLY_PREVIOUS`), sem variação ("—").
- **FA-12 — Variação percentual indefinida:** com valor anterior zero ou sem passagens em um dos períodos, a variação percentual é nula e a absoluta só existe quando os dois períodos têm passagens.
- **FA-13 — Dados desatualizados:** `meta.stale = true` (defasagem > 15 min) mostra "Os dados estão desatualizados desde {hora}."; as filas podem incluir passagens recém-fechadas ainda não projetadas.
- **FA-14 — Chave de grupo inexistente:** `ANL-16` com etapa desconhecida, unidade ou pessoa de outro tenant ou fora do escopo responde `404 NOT_FOUND`.
- **FA-15 — Exercício com início diferente de janeiro:** com `analytics.fiscalYearStartMonth = 7`, o atalho "Trimestre" compara trimestres do exercício (jul–set × abr–jun) e "Exercício" compara jul–jun contra jul–jun.

## Regras de negócio
- **RN-ANL-170** — Fonte e filas: as filas e o envelhecimento leem **passagens abertas** (`exitedAt` nulo) de `AnalyticsStageFact`, pelo índice parcial `(tenant_id, exited_at) WHERE exited_at IS NULL` (RN-ANL-22). Os atributos de filtro (`organizationId`, `requestingSecretariatId`, `modalityCode`, `contractingTypeCode`) já estão no fato de passagem. Nunca `ProcessStage`/`ProcessMovement` (RN-ANL-20, RN-ANL-06, RN-ANL-19). Passagens fechadas nunca entram em fila; passagens abertas nunca entram na comparação.
- **RN-ANL-171** — Idade da passagem aberta: dias úteis entre `enteredAt` e o instante da consulta (`asOf`), no fuso do tenant, pelo **mesmo calendário de dias úteis** que a projeção usa no fechamento (feriados do tenant — a função `BusinessCalendar` da US-172), **descontadas as pausas de SLA**: `pausedSeconds` acumulado e, se a passagem está pausada agora (`pausedSince` não nulo), o tempo desde o início da pausa não conta e a idade fica congelada em `pausedSince`. Resultado com duas casas decimais (`ageBusinessDays`); a faixa usa a parte inteira.
- **RN-ANL-172** — Faixas de envelhecimento (constante em código `AGING_BANDS`, em dias úteis inteiros, limites inclusivos): `0–2`, `3–5`, `6–10`, `11–20`, `21+` (chaves `B0_2`, `B3_5`, `B6_10`, `B11_20`, `B21_PLUS`). Toda passagem aberta cai em exatamente uma faixa; a soma das faixas é igual a `openCount`. A resposta traz a definição das faixas em `data.bands[]`.
- **RN-ANL-173** — Medidas por grupo da fila: `openCount`, `distinctProcessesCount` (um processo com ramos paralelos pode ter mais de uma passagem aberta), `avgAgeBusinessDays`, `medianAgeBusinessDays`, `oldestAgeBusinessDays`, `overdueCount` (passagens não pausadas com `dueAt` anterior a `asOf`), `pausedCount`, `aging[]` (`band`, `count`, `percent`) e `smallSample` (`openCount < 10`, RN-ANL-156). O resumo geral (`totals`) é calculado sobre todas as passagens abertas do recorte, não sobre os grupos. "Vencida" usa o `dueAt` do fato como está projetado (lacuna 5).
- **RN-ANL-174** — Escopo e filtros (RN-ANL-158 da US-176): unidade da etapa no escopo de `REPORT_VIEW`; filtros `organizationId`, `secretariatId`, `modalityCode`, `contractingTypeCode`, `stageKey` e `departmentId` só restringem dentro do escopo (fora → `422 REFERENCE_NOT_FOUND`).
- **RN-ANL-175** — Dimensões das filas: `STAGE`, `DEPARTMENT` e `ASSIGNEE` (RN-ANL-151 da US-176), com os mesmos rótulos (RN-ANL-165). `ASSIGNEE` aplica o texto fixo e as proibições de ranking e de classificação "melhor/pior" (RN-ANL-161); passagem sem responsável vai para "Sem responsável".
- **RN-ANL-176** — Ordenação e paginação das filas: `sort` ∈ `-avgAgeBusinessDays` (padrão), `-oldestAgeBusinessDays`, `-openCount`, `-overdueCount`, `-medianAgeBusinessDays`, `label`; desempate por `-openCount` e pelo rótulo; `ASSIGNEE` paginado (`pageSize` ≤ 100, padrão 50), `STAGE` e `DEPARTMENT` completos.
- **RN-ANL-177** — Lista da fila (drill-down): `ANL-16` com `state=OPEN`, opcionalmente `agingBand`, ordenada por `-ageBusinessDays`; uma linha por passagem aberta; aplica visibilidade (DEC-024) **dentro da consulta**, sigilo por linha e auditoria, como as RN-ANL-162 a RN-ANL-164 da US-176. Cada linha traz `ageBusinessDays`, `agingBand`, `isPaused`, `dueAt` e `overdue`. Não há soma de valores.
- **RN-ANL-178** — "Agora": a resposta traz `meta.asOf` (instante da consulta, usado no cálculo das idades) e `meta.dataAsOf` (atualização do read model); a defasagem de até 5 minutos significa que uma passagem fechada há instantes pode ainda aparecer como aberta (RN-ANL-168 da US-176 define `stale`).
- **RN-ANL-179** — Comparabilidade (RN-ANL-24): os dois períodos são **de meses inteiros** (início no dia 1 e fim no último dia do mês), têm **o mesmo número de meses** (1 a 12) e **não se sobrepõem**; o período anterior termina antes do início do atual e não precisa ser adjacente (pode ser o mesmo trimestre do exercício passado). Violação → `422 PERIODS_NOT_COMPARABLE` com `meta.reason` ∈ `DIFFERENT_DURATION`, `NOT_MONTH_ALIGNED`, `OVERLAPPING`, `TOO_LONG` e `meta.currentMonths`/`meta.previousMonths`.
- **RN-ANL-180** — Atalhos (`preset` ∈ `MONTH`, `QUARTER`, `SEMESTER`, `FISCAL_YEAR`) com `reference` (data; padrão hoje): o período **atual** é o que contém `reference` e o **anterior** é o imediatamente anterior de mesma duração; trimestres e semestres são contados a partir do início do exercício (`analytics.fiscalYearStartMonth`, padrão 1) e o exercício vai do mês de início a 12 meses depois. Ou `preset`, ou as quatro datas (`currentFrom`, `currentTo`, `previousFrom`, `previousTo`); informar os dois → `422 VALIDATION_ERROR` (`NOT_ALLOWED`); informar parte das datas → `CONDITIONAL_REQUIRED`. Padrão da tela: `QUARTER`.
- **RN-ANL-181** — Período atual incompleto: se `currentTo` é posterior à data de hoje, `meta.currentPeriodIncomplete = true`; a comparação usa apenas passagens já fechadas nos dois períodos e **não** proporciona o período anterior (sem "mesmo trecho"); o aviso de RN-ANL-181 é obrigatório na tela e na aba "Parâmetros" da exportação.
- **RN-ANL-182** — Medidas comparadas: para cada período e grupo, as mesmas medidas e passagens da US-176 (RN-ANL-152 a RN-ANL-155): `passagesCount`, `avgBusinessDays`, `medianBusinessDays`, `p90BusinessDays`, `onTimePercent`, `returnsCount`, `returnRatePercent`, `smallSample`. Variação: para os três tempos, `absolute` (atual − anterior, em dias úteis) e `percent` (absoluta ÷ anterior × 100); para `onTimePercent` e `returnRatePercent`, a diferença em **pontos percentuais** (`onTimePp`, `returnRatePp`), nunca "percentual de percentual"; duas casas decimais.
- **RN-ANL-183** — Amostra (RN-ANL-24): cada período mostra `passagesCount` e `smallSample` (< 10 passagens, RN-ANL-156 da US-176); a linha traz `lowConfidence = true` se qualquer dos dois períodos tiver amostra pequena; a variação continua calculada e exibida, junto do aviso. Nenhum grupo é ocultado por amostra pequena.
- **RN-ANL-184** — Grupos e totais: o conjunto de grupos é a **união** dos que têm ao menos uma passagem em um dos períodos; `presence` ∈ `BOTH`, `ONLY_CURRENT`, `ONLY_PREVIOUS`; sem passagens em um dos períodos, a variação do grupo é nula e `comparable = false`. A linha de totais é calculada sobre todas as passagens de cada período (não é média das médias).
- **RN-ANL-185** — Ordenação da comparação: `sort` ∈ `-delta.avgBusinessDays` (padrão: maior aumento do tempo médio primeiro), `delta.avgBusinessDays` (maior redução primeiro), `-delta.p90BusinessDays`, `-delta.returnRatePp`, `-current.passagesCount`, `label`; grupos sem variação ao fim. A tela não usa vocabulário de julgamento ("piorou", "melhorou") nem cor como único sinal: usa "aumentou"/"diminuiu" com seta e texto; para `ASSIGNEE`, vale RN-ANL-175.
- **RN-ANL-186** — Leitura da comparação: os dois períodos são calculados **na mesma consulta** (`FILTER` por período sobre uma única leitura de `AnalyticsStageFact`) para garantir um só *snapshot*; com `groupBy` `STAGE` ou `DEPARTMENT`, dois períodos de **um mês** cada e filtros só pelas chaves da visão, a API usa `mv_analytics_stage_monthly` (RN-ANL-160 da US-176); nos demais casos, os fatos, porque mediana e p90 não se compõem entre meses. Os dois caminhos dão o mesmo número (paridade).
- **RN-ANL-187** — Exportação (US-174): provedores `bottleneck-queues` (`SUMMARY`: a tabela de filas com as faixas; `DETAIL`: passagens abertas de **um** grupo, exigindo `dimension` e `key`) e `bottleneck-comparison` (`SUMMARY`: a tabela comparativa com os dois períodos, a variação, a amostra e os avisos; sem `DETAIL`); mesma consulta da tela; a aba "Parâmetros" do XLSX registra os períodos e `currentPeriodIncomplete`.
- **RN-ANL-188** — Auditoria: abrir `ANL-17` ou `ANL-18` com `groupBy=ASSIGNEE` grava `report.view_detail` (`level = OVERVIEW`, uma vez por sessão e por relatório — `bottleneck-queues` ou `bottleneck-comparison`); a lista da fila (`ANL-16`, `state=OPEN`) segue a RN-ANL-164 (por pessoa, quando `assignee`). Falha de gravação → `503` sem dados; falha do Redis na deduplicação → audita de novo. Filas e comparações por etapa e unidade não geram `report.view_detail` na visão geral.
- **RN-ANL-189** — Limites e atualidade: leitura `READ ONLY`, `statement_timeout` de 10 s, um *snapshot* por requisição; `meta.dataAsOf` e `meta.stale` como na RN-ANL-168 da US-176; sem cache de aplicação; as constantes `AGING_BANDS`, de amostra pequena (10) e de duração máxima (12 meses por período) ficam em código versionado e mudá-las não exige reconstrução dos fatos (são só de apresentação e de validação).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Agrupar por | `groupBy` | `STAGE`, `DEPARTMENT`, `ASSIGNEE` | Não | RN-ANL-175 | `STAGE` |
| Órgão, secretaria, modalidade, tipo, etapa, unidade | `organizationId`, `secretariatId`, `modalityCode`, `contractingTypeCode`, `stageKey`, `departmentId` | listas | Não | RN-ANL-174 | — |
| Ordenação | `sort` | texto | Não | RN-ANL-176 / RN-ANL-185 | `-avgAgeBusinessDays` / `-delta.avgBusinessDays` |
| Paginação | `page`, `pageSize` | inteiros | Não | só em `ASSIGNEE`; ≤ 100 | 1 / 50 |
| Passagens abertas | `openCount`, `distinctProcessesCount` | inteiros | — | RN-ANL-173 | fato |
| Idade média, mediana e mais antiga | `avgAgeBusinessDays`, `medianAgeBusinessDays`, `oldestAgeBusinessDays` | decimal(8,2) | — | RN-ANL-171 | cálculo na leitura |
| Vencidas / em pausa | `overdueCount`, `pausedCount` | inteiros | — | RN-ANL-173 | fato |
| Faixas | `aging[].band`, `count`, `percent` | `B0_2`…`B21_PLUS`, inteiro, decimal | — | RN-ANL-172 | cálculo |
| Faixa (filtro da lista) | `agingBand` (em `ANL-16`) | `B0_2`…`B21_PLUS` | Não | só `state=OPEN` | — |
| Atalho de período | `preset` | `MONTH`, `QUARTER`, `SEMESTER`, `FISCAL_YEAR` | Condicional | RN-ANL-180 | `QUARTER` |
| Data de referência | `reference` | data ISO | Não | só com `preset` | hoje |
| Período atual | `currentFrom`, `currentTo` | datas ISO | Condicional | RN-ANL-179 (sem `preset`) | — |
| Período anterior | `previousFrom`, `previousTo` | datas ISO | Condicional | RN-ANL-179 (sem `preset`) | — |
| Medidas por período | `current.*`, `previous.*` | objeto (US-176) | — | RN-ANL-182 | fato |
| Variação | `delta.avgBusinessDays`, `medianBusinessDays`, `p90BusinessDays` (`absolute`, `percent`), `onTimePp`, `returnRatePp` | decimais | — | RN-ANL-182 | cálculo |
| Aviso de amostra | `lowConfidence`, `current.smallSample`, `previous.smallSample` | booleanos | — | RN-ANL-183 | calculado |
| Presença do grupo | `presence`, `comparable` | enum, booleano | — | RN-ANL-184 | calculado |
| Período atual em andamento | `meta.currentPeriodIncomplete` | booleano | — | RN-ANL-181 | calculado |
| Instante e dados | `meta.asOf`, `meta.dataAsOf`, `meta.stale` | data/hora, booleano | — | RN-ANL-178 | leitura |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `groupBy`, `sort`, `preset` ou `agingBand` fora do domínio | Front + API (Zod) | "Filtro inválido." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-02 | Datas com formato inválido | Front + API (Zod) | "Informe datas válidas." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-03 | `preset` junto com datas | Front + API (Zod) | "Use um atalho de período ou informe as datas, não os dois." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-04 | Sem `preset` e com datas incompletas | Front + API (Zod) | "Informe o início e o fim dos dois períodos." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-05 | Períodos de durações diferentes | Front + API | "Os períodos têm durações diferentes ({m1} e {m2} meses). Escolha dois períodos com o mesmo número de meses." | `PERIODS_NOT_COMPARABLE` (`DIFFERENT_DURATION`) |
| V-06 | Período que não começa no dia 1 nem termina no último dia do mês | Front + API | "Escolha períodos de meses inteiros." | `PERIODS_NOT_COMPARABLE` (`NOT_MONTH_ALIGNED`) |
| V-07 | Períodos sobrepostos ou anterior depois do atual | Front + API | "Os períodos não podem se sobrepor. O anterior deve terminar antes do início do atual." | `PERIODS_NOT_COMPARABLE` (`OVERLAPPING`) |
| V-08 | Período com mais de 12 meses | Front + API | "Escolha períodos de até 12 meses." | `PERIODS_NOT_COMPARABLE` (`TOO_LONG`) |
| V-09 | Id de filtro fora do escopo ou de outro tenant | API | "Item não encontrado no seu escopo." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-10 | Sem `REPORT_VIEW` | API | "Você não tem permissão para ver os relatórios." | `PERMISSION_DENIED` |
| V-11 | Chave do drill-down inexistente, de outro tenant ou fora do escopo | API | "Item não encontrado." | `NOT_FOUND` |
| V-12 | `pageSize` informado fora de `ASSIGNEE` | API | "A paginação só vale para a visão por responsável." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |

## Permissões
- **Permissão:** `REPORT_VIEW` (risco `L`) para `ANL-17` e `ANL-18` (e `ANL-16` com `state=OPEN`), recortada pela unidade da etapa; `PROCESS_VIEW_CONFIDENTIAL_BUDGET` apenas para o valor estimado sigiloso na lista da fila; `REPORT_EXPORT` só para exportar (US-174).
- **Políticas:** POL-28, POL-09 (sigilo por linha), DEC-024 (visibilidade na lista da fila), POL-14 (*step-up* para desmascarar).
- **MFA:** não exigido por permissão de risco `L`.
- **Sem permissão:** as abas não aparecem; a API responde `403 PERMISSION_DENIED` e registra `access.denied` (`reasonCode` = `REPORT_VIEW`). Chave de outro tenant ou fora do escopo: `404 NOT_FOUND`. `CONSULTOR_EXTERNO`: sem `REPORT_VIEW`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio (somente leitura). |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | Nenhuma | — | Somente leitura. Alertas de fila parada e de prazo vencido são do SLA (EP-030) e das regras de notificação, fora desta story. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Filas, envelhecimento e comparação entre períodos

  Background:
    Given que o tenant "Prefeitura A" está ativo e o read model foi atualizado há 2 minutos
    And "Gil" tem "REPORT_VIEW" com escopo "ORGANIZATION" e não tem a permissão de sigilo
    And "Marta" tem "REPORT_VIEW" com escopo apenas da unidade "Procuradoria"
    And o tenant usa "analytics.fiscalYearStartMonth" igual a 1

  Scenario: [Sucesso] Fila da etapa com idade e faixas de envelhecimento
    Given que a etapa "JURIDICO" tem 7 passagens abertas com 1, 2, 4, 5, 9, 12 e 25 dias úteis de idade
    When "Gil" abrir a aba "Filas" agrupada por "STAGE"
    Then a etapa "JURIDICO" deve trazer "openCount" 7, idade média 8,29, mediana 5 e mais antiga 25
    And as faixas "0–2", "3–5", "6–10", "11–20" e "21+" devem trazer 2, 2, 1, 1 e 1 passagens
    And a soma das faixas deve ser igual a 7
    And "smallSample" deve ser verdadeiro e a tela deve mostrar "Fila em" com a hora da consulta e "dados atualizados em"

  Scenario: [Sucesso] Idade desconta as pausas e passagem pausada fica congelada
    Given que uma passagem entrou há 10 dias úteis e teve 4 dias úteis de pausa já encerrada
    And outra passagem entrou há 12 dias úteis e está pausada há 5 dias úteis
    When "Gil" abrir a fila da etapa
    Then a primeira deve ter idade 6 dias úteis
    And a segunda deve ter idade 7 dias úteis congelada, "isPaused" verdadeiro e não contar em "overdueCount"

  Scenario: [Sucesso] Passagens vencidas
    Given que 2 das 7 passagens do "JURIDICO" têm prazo anterior ao instante da consulta e não estão pausadas
    When "Gil" abrir a fila por etapa
    Then "overdueCount" do "JURIDICO" deve ser 2

  Scenario: [Sucesso] Passagem fechada sai da fila e entra nos tempos
    Given que a passagem "ps-10" do "JURIDICO" está aberta
    When o processo for encaminhado e a projeção fechar a passagem
    And "Gil" abrir a aba "Filas" e a análise de tempos
    Then "ps-10" não deve constar da fila
    And "ps-10" deve compor os tempos da etapa "JURIDICO" no período em que saiu

  Scenario: [Sucesso] Envelhecimento por unidade
    When "Gil" abrir a aba "Envelhecimento" agrupada por "DEPARTMENT"
    Then cada unidade deve trazer a contagem e o percentual de cada faixa
    And a soma das contagens das faixas de cada unidade deve ser igual às passagens abertas da unidade

  Scenario: [Sucesso] Lista da fila mostra só processos visíveis
    Given que o processo "0030/2026" está parado no "JURIDICO" e é restrito, e "Gil" não pode vê-lo
    When "Gil" abrir a lista da fila da etapa "JURIDICO" na faixa "21+"
    Then a lista não deve conter o processo "0030/2026"
    And as linhas devem vir da mais antiga para a mais nova, com "ageBusinessDays" e "agingBand"
    And "meta.processVisibility" deve ser "RESTRICTED" sem informar quantos foram ocultados

  Scenario: [Sucesso] Valor sigiloso na lista da fila
    Given que o processo "0012/2026" está parado no "JURIDICO" com orçamento sigiloso
    When "Gil" abrir a lista da fila
    Then a linha de "0012/2026" deve ter "estimatedValue" nulo e "estimatedValueMasked" verdadeiro
    And nenhuma soma de valor deve existir na resposta

  Scenario: [Sucesso] Fila por responsável sem ranking e com auditoria
    When "Gil" abrir a aba "Filas" agrupada por "ASSIGNEE"
    Then a tabela não deve ter posição numerada nem cores de melhor ou pior
    And a tela deve mostrar "Análise do fluxo dos processos. Não é avaliação de desempenho individual."
    And deve gerar registro de auditoria "report.view_detail" com nível "OVERVIEW" uma vez por sessão

  Scenario: [Sucesso] Escopo da unidade da etapa nas filas
    Given que processos de várias secretarias estão parados na unidade "Procuradoria"
    When "Marta" abrir a aba "Filas"
    Then deve ver apenas passagens abertas cuja unidade da etapa é "Procuradoria"

  Scenario: [Sucesso] Comparar este trimestre com o anterior
    Given que o "JURIDICO" teve 14 passagens no trimestre anterior com média 5,00, mediana 4,5, p90 8,0 e 80% no prazo
    And teve 12 passagens no trimestre atual com média 6,92, mediana 5,5, p90 11,6 e 75% no prazo
    When "Gil" comparar com o atalho "QUARTER" agrupado por "STAGE"
    Then a etapa "JURIDICO" deve trazer a variação da média de 1,92 dia útil e 38,4%
    And a variação do prazo cumprido deve ser de menos 5 pontos percentuais
    And a linha deve mostrar 14 passagens no período anterior e 12 no atual

  Scenario: [Sucesso] Período atual em andamento é sinalizado
    Given que o trimestre atual termina daqui a 40 dias
    When "Gil" comparar com o atalho "QUARTER"
    Then "meta.currentPeriodIncomplete" deve ser verdadeiro
    And a tela deve avisar que o período atual não terminou e que passagens em andamento não entram nos tempos

  Scenario: [Sucesso] Amostra pequena na comparação
    Given que a etapa "DOTACAO" teve 4 passagens no período atual e 20 no anterior
    When "Gil" comparar os períodos
    Then a linha de "DOTACAO" deve ter "current.smallSample" verdadeiro e "lowConfidence" verdadeiro
    And a tela deve mostrar o tamanho da amostra dos dois períodos e o aviso de amostra pequena

  Scenario: [Sucesso] Grupo presente em um só período
    Given que a unidade "Central de Licitações" só teve passagens no período atual
    When "Gil" comparar por "DEPARTMENT"
    Then a linha dessa unidade deve ter "presence" "ONLY_CURRENT", "comparable" falso e variação nula

  Scenario: [Sucesso] Atalho segue o início do exercício
    Given que "analytics.fiscalYearStartMonth" é 7
    When "Gil" comparar com o atalho "FISCAL_YEAR" com referência em 15/09/2026
    Then o período atual deve ser 01/07/2026 a 30/06/2027 e o anterior 01/07/2025 a 30/06/2026

  Scenario: [Sucesso] Períodos não adjacentes
    When "Gil" comparar abril a junho de 2026 com abril a junho de 2025
    Then a API deve responder 200 com os dois trimestres comparados

  Scenario: [Sucesso] Dados desatualizados
    Given que a última atualização do read model foi há 40 minutos
    When "Gil" abrir a aba "Filas"
    Then "meta.stale" deve ser verdadeiro e a tela deve avisar que os dados estão desatualizados

  Scenario: [Validação] Períodos de durações diferentes
    When "Gil" comparar 01/04/2026 a 30/06/2026 com 01/01/2026 a 28/02/2026
    Then a API deve responder 422 com código "PERIODS_NOT_COMPARABLE" e "meta.reason" "DIFFERENT_DURATION"
    And a mensagem deve pedir dois períodos com o mesmo número de meses
    And nenhuma consulta de passagens deve ser executada

  Scenario: [Validação] Períodos fora do alinhamento, sobrepostos ou grandes demais
    When "Gil" comparar 10/04/2026 a 09/07/2026 com 10/01/2026 a 09/04/2026
    Then a API deve responder 422 com código "PERIODS_NOT_COMPARABLE" e "meta.reason" "NOT_MONTH_ALIGNED"
    When "Gil" comparar abril a junho de 2026 com maio a julho de 2026
    Then a API deve responder 422 com código "PERIODS_NOT_COMPARABLE" e "meta.reason" "OVERLAPPING"
    When "Gil" comparar 13 meses com 13 meses
    Then a API deve responder 422 com código "PERIODS_NOT_COMPARABLE" e "meta.reason" "TOO_LONG"

  Scenario: [Validação] Atalho e datas ao mesmo tempo
    When "Gil" informar "preset" "QUARTER" e também "currentFrom"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED"
    When "Gil" informar apenas "currentFrom" e "currentTo"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED"

  Scenario: [Validação] Filtro e faixa inválidos
    When "Gil" pedir "groupBy" "REGION" e "agingBand" "B99"
    Then a API deve responder 422 com código "VALIDATION_ERROR" apontando cada campo

  Scenario: [Permissão] Sem REPORT_VIEW
    Given que "Clara" não tem "REPORT_VIEW"
    When "Clara" pedir "GET /bottlenecks/queues" e "GET /bottlenecks/comparison"
    Then a API deve responder 403 com código "PERMISSION_DENIED" nas duas chamadas
    And as abas "Filas", "Envelhecimento" e "Comparação" não devem aparecer para ela
    And deve gerar registro de auditoria "access.denied" para cada tentativa

  Scenario: [Permissão] Comparação respeita o escopo da unidade da etapa
    When "Marta" comparar dois trimestres por "STAGE"
    Then as medidas dos dois períodos devem incluir apenas passagens da unidade "Procuradoria"

  Scenario: [Tenant incorreto] Chave da fila de outro tenant
    Given que a unidade "Procuradoria B" e a pessoa "Paulo B" pertencem ao tenant "Prefeitura B"
    When "Gil" abrir a lista da fila da unidade "Procuradoria B" e da pessoa "Paulo B"
    Then a API deve responder 404 com código "NOT_FOUND" nos dois casos
    And nenhum dado de "Prefeitura B" deve ser revelado

  Scenario: [Tenant incorreto] Passagens de outro tenant não entram nas filas nem na comparação
    Given que "Prefeitura B" tem passagens abertas e fechadas na etapa "JURIDICO"
    When "Gil" abrir as filas e a comparação em "Prefeitura A"
    Then nenhuma contagem ou tempo de "Prefeitura B" deve aparecer

  Scenario: [Duplicidade] Evento reprocessado não duplica passagem aberta
    Given que o evento de entrada na etapa "JURIDICO" foi entregue duas vezes à projeção
    When "Gil" abrir a fila
    Then a passagem deve ser contada uma única vez

  Scenario: [Duplicidade] Reabrir a fila por responsável na sessão não repete a auditoria
    When "Gil" abrir três vezes a aba "Filas" agrupada por "ASSIGNEE" na mesma sessão
    Then deve existir um único registro "report.view_detail" com nível "OVERVIEW" para essa sessão

  Scenario: [Concorrência] Passagem fechada durante a leitura da fila
    Given que a projeção fecha uma passagem do "JURIDICO" enquanto "Gil" consulta a fila
    When "Gil" abrir a aba "Filas"
    Then a fila e as faixas devem vir do mesmo estado do read model e a soma das faixas deve ser igual a "openCount"

  Scenario: [Concorrência] Os dois períodos vêm do mesmo estado
    Given que a projeção grava novas passagens fechadas enquanto "Gil" compara dois trimestres
    When "Gil" abrir a comparação
    Then os dois períodos devem ser calculados sobre o mesmo estado do read model

  Scenario: [Falha de banco] Banco indisponível na leitura
    Given que o banco de dados está indisponível
    When "Gil" abrir as filas ou a comparação
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a tela deve oferecer "Tentar novamente" e manter filtros e períodos

  Scenario: [Falha de integração] Auditoria indisponível ao abrir fila por responsável
    Given que a gravação da auditoria falha
    When "Gil" abrir a aba "Filas" agrupada por "ASSIGNEE"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" sem devolver nenhuma linha

  Scenario: [Falha de integração] Refresh das visões falhou na comparação mensal
    Given que o último refresh de "mv_analytics_stage_monthly" falhou e "dataAsOf" está há 2 horas
    When "Gil" comparar dois meses por "STAGE"
    Then a API deve responder 200 com o último estado e "meta.stale" verdadeiro
    And a tela deve mostrar o aviso de dados desatualizados
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Parâmetro inválido | 422 | `VALIDATION_ERROR` | "Filtro inválido." | Erro no campo |
| Atalho e datas juntos ou datas incompletas | 422 | `VALIDATION_ERROR` (`NOT_ALLOWED`/`CONDITIONAL_REQUIRED`) | "Use um atalho de período ou informe as datas, não os dois." / "Informe o início e o fim dos dois períodos." | Destaca os campos |
| Períodos não comparáveis | 422 | `PERIODS_NOT_COMPARABLE` | "Os períodos têm durações diferentes ({m1} e {m2} meses). Escolha dois períodos com o mesmo número de meses." (variações por `meta.reason`) | Destaca os períodos e sugere os atalhos |
| Filtro fora do escopo | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Item não encontrado no seu escopo." | Remove o filtro |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para ver os relatórios." | Oculta as abas |
| Grupo inexistente, de outro tenant ou fora do escopo | 404 | `NOT_FOUND` | "Item não encontrado." | Fecha o painel e volta ao quadro |
| Muitas requisições | 429 | `RATE_LIMITED` | "Muitas consultas em pouco tempo. Aguarde alguns instantes." | Reabilita após `Retry-After` |
| Banco ou auditoria indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar a análise agora. Tente novamente em instantes." | Botão "Tentar novamente", filtros e períodos mantidos |

## Dependências
- **Stories:** US-176 (agregador de duração, medidas, escopo da unidade da etapa, drill-down `ANL-16`, auditoria por responsável, atualidade). Indiretas: US-171/US-170 (fatos de passagem confiáveis, inclusive pausas das passagens abertas), US-172 (definições de dias úteis, pausas, devolução, prazo; estrutura de relatórios), US-173 (visibilidade no detalhamento), US-097 (autorização), US-013 (sigilo), US-073 (auditoria), US-174 (exportação).
- **Decisões/ADRs:** DEC-206, ADR-014, DEC-205 (pausas e prazos), DEC-024, DEC-030; POL-28, POL-09, POL-14; roadmap §4.2.
- **Configurações:** `analytics.fiscalYearStartMonth` (atalhos de trimestre, semestre e exercício). Constantes em código: faixas de envelhecimento, amostra pequena (10) e duração máxima de 12 meses por período.
- **Lacunas nas fontes canônicas:**
  1. `AnalyticsStageFact` (entities.md §4.11) tem `pausedSeconds`, mas "calculados no fechamento": para a idade de passagens **abertas** e pausadas (RN-ANL-171) a projeção (US-170) precisa manter `pausedSeconds` acumulado da passagem aberta e gravar `pausedSince` (timestamptz, nulo) ao entrar em pausa e limpá-lo ao retomar (eventos de pausa e retomada do SLA, EP-030). Ajuste na entidade e em US-170; sem isso a fila superestima a idade de passagens pausadas.
  2. O cálculo de dias úteis de passagens abertas ocorre **na leitura** e usa o calendário e os feriados do tenant: o `analytics` precisa de uma fachada de leitura do calendário (`BusinessCalendar`, a mesma da projeção) com cache por requisição.
  3. As **faixas de envelhecimento** (`0–2`, `3–5`, `6–10`, `11–20`, `21+`) e a **granularidade da comparação** (meses inteiros, mesma duração de 1 a 12 meses, atalhos `MONTH`/`QUARTER`/`SEMESTER`/`FISCAL_YEAR` alinhados ao início do exercício) estavam em aberto no épico; fixadas aqui. Se a US-172 fixar outra granularidade para os períodos dos indicadores, harmonizar.
  4. Código de erro novo `PERIODS_NOT_COMPARABLE` (422, `meta.reason` ∈ `DIFFERENT_DURATION`, `NOT_MONTH_ALIGNED`, `OVERLAPPING`, `TOO_LONG`) em api.md §2.2; os demais são reutilizados.
  5. `dueAt` das passagens abertas muda com pausas, prorrogações e escalonamento (SLA); "vencida" usa o `dueAt` como projetado: a projeção precisa atualizar `dueAt` do fato quando o SLA o altera (eventos `sla_policy.*` e de prorrogação). Sem isso `overdueCount` pode ficar defasado.
  6. Endpoints `ANL-17` (`GET /bottlenecks/queues`, filas e envelhecimento em uma resposta) e `ANL-18` (`GET /bottlenecks/comparison`); a feature indicava `/reports/bottlenecks/queues`, `/aging` e `/compare`. Chaves de exportação `bottleneck-queues` e `bottleneck-comparison` no catálogo da US-172/US-174.
  7. `report.view_detail` ganha `level` (`OVERVIEW`, `DRILL_DOWN`), `dimension` e `key` em `metadata` (ver US-176, lacuna 6), e passa a ser gravado também ao abrir as filas e a comparação por responsável.
  8. A fila **inclui** processos suspensos (passagem aberta e pausada, idade congelada) e **exclui** os cancelados (a passagem é fechada como `CANCELED`); confirmar com o produto que processo suspenso deve aparecer na fila.

## Impacto técnico
- **Performance:** o índice parcial das passagens abertas mantém a leitura pequena (o volume de passagens abertas é da ordem do WIP do órgão); a idade é calculada em lote, com um mapa de feriados carregado uma vez por requisição; a comparação lê os fatos uma única vez com `FILTER` por período. Meta p95 ≤ 2 s para o exercício, na suíte de performance (endurecimento).
- **Segurança e LGPD:** mesmas salvaguardas da US-176 (escopo pela unidade da etapa, visibilidade dentro da consulta, sigilo por linha, auditoria que falha fechada, sem ranking de pessoas); nenhuma soma de valor.
- **Interpretação:** viés do período em andamento tratado por aviso e pela aba "Filas"; amostra pequena sempre exibida; variação em pontos percentuais para taxas.
- **Consistência:** uma única leitura por requisição; paridade visão × fatos; as filas refletem a projeção (defasagem de até 5 minutos).
- **Compatibilidade:** sem alteração de endpoints do MVP 1; reaproveita o agregador e o formato da US-176; prepara o MVP 5 (previsão e saúde do processo sobre o mesmo read model).

## Backend
- **Módulo(s):** `analytics` (consultas, faixas, comparação), `workflow`, `organization`, `identity` (rótulos), `process` (título e código da página da fila), `access` (escopo, visibilidade, permissão de sigilo), `audit`, calendário do tenant (feriados) via fachada.
- **Casos de uso:** `GetBottleneckQueuesQuery` (`ANL-17`), `CompareBottleneckPeriodsQuery` (`ANL-18`), `ListBottleneckProcessesQuery` (`ANL-16`, `state=OPEN`, da US-176), `BottleneckQueuesExportProvider` e `BottleneckComparisonExportProvider` (US-174).
- **Domínio:** `StageDurationAggregator` (US-176), `OpenPassageAge` (idade em dias úteis descontando pausas), `AgingBands` (RN-ANL-172), `PeriodPair` (comparabilidade e atalhos — RN-ANL-179/180), `DeltaCalculator` (absoluta, percentual e pontos percentuais), `DetailAccessAuditor` (US-176).
- **Integrações internas:** repositório do `analytics`, `AccessScopeResolver`, `VisibilityPredicate`, `BusinessCalendar`, `StageLabelResolver`, `DepartmentLabelResolver`, `UserLabelResolver`, `ProcessSummaryPort`, `AuditService`, Redis (deduplicação da auditoria).
- **Transação:** leitura única `READ ONLY` (`statement_timeout` 10 s); a auditoria é gravada antes de devolver dados por responsável.

## Frontend
- **Tela(s):** SCR-028 (`/relatorios/gargalos`), abas "Filas", "Envelhecimento" e "Comparação" (as abas por etapa, unidade e responsável são da US-176) e painel lateral com a lista da fila.
- **Componentes:** `QueueTable`, `AgingStackedBar` (faixas com números em texto), `AgingMatrix` (aba "Envelhecimento"), `PeriodPairPicker` (atalhos e datas, com a duração calculada e validada), `ComparisonTable` (dois períodos lado a lado, variação com seta e texto), `SampleSizeBadge`, `IncompletePeriodNotice`, `AnalyticNoticeAssignee` (US-176), `PassagesDrawer` (US-176, `state=OPEN`), `DataAsOfBadge`, `ExportButton` (US-174).
- **Estados:** loading (skeleton), vazio ("Nenhum processo parado neste escopo agora."), erro com "Tentar novamente" (filtros e períodos mantidos), sucesso; estados "dados desatualizados" e "período atual em andamento".
- **Acessibilidade e responsividade:** faixas e variações sempre com valores em texto (nunca só cor ou seta); legenda das faixas por texto; abas por teclado; painel lateral com foco preso e `Esc`; tabela comparativa em cartões abaixo de 768 px com os dois períodos empilhados; URL com período e filtros para compartilhar a visão (`?aba=comparacao&atalho=trimestre`).

## Banco de dados
- **Tabelas:** leitura de `analytics_stage_facts` (e `analytics_process_facts` para atributos da lista, via US-176) e da visão `mv_analytics_stage_monthly`; calendário de feriados do tenant pela fachada; nenhuma tabela nova.
- **Migrações:** nenhuma nesta story; `pausedSince` e a atualização de `pausedSeconds`/`dueAt` de passagens abertas (lacunas 1 e 5) entram na migração da US-170/M2-19.
- **Índices/constraints relevantes:** índice parcial `(tenant_id, exited_at) WHERE exited_at IS NULL` (filas e envelhecimento), mais `(tenant_id, department_id, exited_at)` e `(tenant_id, assignee_id, exited_at)` para os filtros; função `security definer` da visão mensal; leitura sempre com `tenant_id` e RLS.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `ANL-17` | GET | `/bottlenecks/queues` | `groupBy`, `organizationId[]`, `secretariatId[]`, `modalityCode[]`, `contractingTypeCode[]`, `stageKey[]`, `departmentId[]`, `sort`, `page`, `pageSize` | `200 { data: { groupBy, bands[ { key, label, minDays, maxDays } ], totals { openCount, distinctProcessesCount, avgAgeBusinessDays, medianAgeBusinessDays, oldestAgeBusinessDays, overdueCount, pausedCount, aging[] }, groups[ { key, label, openCount, distinctProcessesCount, avgAgeBusinessDays, medianAgeBusinessDays, oldestAgeBusinessDays, overdueCount, pausedCount, aging[ { band, count, percent } ], smallSample } ] }, meta: { asOf, dataAsOf, stale, scope, confidentialExcluded: false, page?, totalItems? } }` | 200, 403, 422, 429, 503 |
| `ANL-18` | GET | `/bottlenecks/comparison` | `groupBy`, `preset`+`reference` **ou** `currentFrom`, `currentTo`, `previousFrom`, `previousTo`; mesmos filtros; `sort`, `page`, `pageSize` | `200 { data: { groupBy, current { from, to }, previous { from, to }, totals { current, previous, delta }, groups[ { key, label, presence, comparable, lowConfidence, current { passagesCount, avgBusinessDays, medianBusinessDays, p90BusinessDays, onTimePercent, returnsCount, returnRatePercent, smallSample }, previous { … }, delta { avgBusinessDays { absolute, percent }, medianBusinessDays { … }, p90BusinessDays { … }, onTimePp, returnRatePp } } ] }, meta: { dataAsOf, stale, durationMonths, currentPeriodIncomplete, scope, confidentialExcluded: false } }` | 200, 403, 422, 429, 503 |

## Logs
- `info` `analytics.queues.read` — `groupBy`, `durationMs`, `openCount`, `scopeLevel`.
- `info` `analytics.comparison.read` — `groupBy`, `durationMonths`, `source` (`MV` ou `FACTS`), `durationMs`, `currentPeriodIncomplete`.
- `warn` `analytics.queues.stale` — `dataAsOf`, `lagMinutes`.
- `warn` `analytics.comparison.not_comparable` — `reason`.
- `error` `analytics.queues.failed` / `analytics.comparison.failed` — `errorCode`, `durationMs`.
- **Nunca logar:** nomes e ids de pessoas do recorte por responsável, códigos e títulos de processo, valores.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `report.view_detail` | `ACCESS` | Abrir filas ou comparação por `ASSIGNEE` (1×/sessão e relatório, `level = OVERVIEW`) e abrir a lista da fila (`ANL-16`, `state=OPEN`; por pessoa quando `assignee`), antes de devolver os dados | `metadata`: `report` (`bottleneck-queues` ou `bottleneck-comparison`), `dimension`, `key?`, `level`, `state?`, `scopeLevel` |
| `access.denied` | `ACCESS` | Tentativa sem `REPORT_VIEW` | `reasonCode` = `REPORT_VIEW` |

## Testes necessários
- **Unitários:** `OpenPassageAge` (feriados, fins de semana, pausa encerrada, pausa em curso, fuso do tenant); `AgingBands` (limites, soma das faixas); `PeriodPair` (meses inteiros, mesma duração, sobreposição, atalhos com `fiscalYearStartMonth` 1 e 7, ano bissexto); `DeltaCalculator` (absoluta, percentual, pontos percentuais, anterior zero, sem passagens); sinalização de amostra e de período incompleto; validação de parâmetros.
- **Integração (Testcontainers PostgreSQL + Redis):** filas e faixas com o índice parcial e RLS; fila × projeção de fechamento; comparação sobre uma leitura única; paridade visão × fatos; escopo de unidade da etapa; predicado de visibilidade na lista; auditoria antes da resposta e deduplicação por sessão com e sem Redis.
- **API/contrato:** `ANL-17` e `ANL-18` (formato, faixas, `meta`, `presence`, `lowConfidence`); `PERIODS_NOT_COMPARABLE` com cada `reason`; `404` para chave de outro tenant.
- **RBAC e multi-tenant:** `REPORT_VIEW` por escopo (órgão e unidade da etapa); sem `REPORT_VIEW` → 403; fatos e chaves de outro tenant nunca aparecem (suíte `test/tenant-leak`); **teste de visibilidade e de sigilo** na lista da fila.
- **Concorrência:** passagem fechada durante a leitura; novas passagens durante a comparação; eventos duplicados e fora de ordem; aberturas simultâneas por responsável na mesma sessão.
- **E2E (Playwright):** abrir "Filas" e a lista de uma faixa, ver o envelhecimento, comparar trimestres, ver os avisos de amostra e de período em andamento, erro de períodos de durações diferentes, exportar.
- **Acessibilidade/performance:** axe nas abas e no painel; consulta de filas e comparação do exercício com p95 ≤ 2 s na suíte de performance (medida no endurecimento).

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
- [ ] Teste de arquitetura: nenhuma consulta a `ProcessStage` ou `ProcessMovement` nas filas e na comparação
- [ ] Teste de visibilidade e sigilo na lista da fila verde; auditoria por responsável verificada
- [ ] Teste de comparabilidade (cada `reason` de `PERIODS_NOT_COMPARABLE`) e de paridade visão × fatos verde
- [ ] Métricas `cf_analytics_query_duration_seconds{report="bottleneck-queues|bottleneck-comparison",source}` publicadas

## Estimativa
**M** — reaproveita o agregador, o escopo, o drill-down e a auditoria da US-176; o trabalho novo é a idade de passagens abertas com pausas, as faixas, o par de períodos com validação de comparabilidade e atalhos, a variação (inclusive em pontos percentuais) e três abas com avisos de amostra e de período em andamento.

## Prioridade
**P1** — filas e comparação entre períodos completam a análise de gargalos prometida no roadmap §4.2 e orientam a redistribuição de trabalho; dependem da US-176 e não bloqueiam outras stories do épico.
