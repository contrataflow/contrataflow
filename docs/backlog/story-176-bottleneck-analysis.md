---
id: US-176
title: "Análise de gargalos por etapa, unidade e responsável"
epic: EP-028
feature: FT-082
mvp: 2
priority: P1
estimate: L
status: Especificada
depends_on: [US-171, US-172]
modules: [analytics, workflow, organization, identity, process, access, audit]
screens: [SCR-028]
endpoints: [ANL-15, ANL-16]
permissions: [REPORT_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: []
---

# US-176 — Análise de gargalos por etapa, unidade e responsável

## Título
Analisar gargalos por etapa, unidade e responsável

## Descrição
**Como** gestor de contratações (`GESTOR_CONTRATACOES`), controle interno (`CONTROLE_INTERNO`), auditor (`AUDITOR`) ou autoridade competente (`AUTORIDADE_COMPETENTE`) com `REPORT_VIEW`, **quero** ver quanto tempo os processos passam em cada **etapa**, em cada **unidade** e com cada **responsável** (média, mediana, p90, percentual dentro do prazo e devoluções), ordenado pelos maiores tempos, e abrir os processos por trás de cada número, **para** descobrir onde as contratações travam e agir (redistribuir, rever prazo, treinar) fora desta tela, sem avaliar pessoas e sem expor processo que eu não posso ver.

A análise é **descritiva** (não prevê nem recomenda — isso é do MVP 5) e lê somente o read model (`AnalyticsStageFact`, e a visão `mv_analytics_stage_monthly` como aceleração). Vive na SCR-028 (`/relatorios/gargalos`), com ponto de entrada na SCR-027. A US-177 acrescenta filas, envelhecimento e comparação entre períodos sobre a mesma base.

## Contexto
- DEC-206, ADR-014, roadmap §4.2 (Gargalos: "tempo por etapa, unidade e responsável; filas e envelhecimento; comparação entre períodos"). FT-082: RN-ANL-20 a RN-ANL-26 (lê só o read model; escopo de unidade pela **unidade da etapa**; passagens abertas × fechadas; dias úteis descontando pausas e exclusão de `MIGRATED`, `SKIPPED` e `CANCELED`; visibilidade e sigilo no detalhamento; responsável sob escopo e auditoria).
- Cada linha de `AnalyticsStageFact` é uma **passagem de etapa** (entrada, saída, duração em dias úteis e corridos, unidade, último responsável, devolução, prazo vencido, pausas de SLA — entities.md §4.11). As definições de dia útil, pausa, devolução e cumprimento de prazo são **fixadas pela US-172** (RN-ANL-70..89) e aqui apenas aplicadas; esta story fixa o que é próprio dos gargalos: quais passagens entram em cada medida, atribuição ao período, amostra pequena, ordenação e drill-down.
- Escopo (permissions.md §5.2): em gargalos, `DEPARTMENT`/`OWN_DEPARTMENTS` recortam pela **unidade da etapa** da passagem, não pela secretaria solicitante (que é o recorte dos relatórios de indicadores — RN-ANL-11).
- Risco apontado na feature: usar o recorte por responsável como **avaliação individual de desempenho**. Mitigação aqui: o responsável é recorte analítico sob escopo, com auditoria, sem ranking numerado, sem classificação "melhor/pior" e com texto fixo na tela (RN-ANL-161).
- O drill-down aplica o predicado de visibilidade da DEC-024 e o sigilo da POL-09, como o relatório detalhado da US-173 (RN-ANL-12, RN-ANL-25, POL-28).
- Metas (p95 ≤ 2 s para o exercício) viram cenários da suíte de performance e são medidas no endurecimento.

## Objetivo
Responder em até 2 s (p95, suíte de performance) em qual etapa, unidade ou responsável o tempo se concentra no exercício, com média, mediana, p90, percentual no prazo e devoluções corretos a cada reconciliação, tamanho da amostra sempre visível, 0 processo não visível ou valor sigiloso exposto no drill-down e 100% das aberturas por responsável auditadas.

## Persona
- **Principal:** Gestor de contratações (`GESTOR_CONTRATACOES`, `REPORT_VIEW` escopo `TENANT` ou de secretaria).
- **Secundárias:** Controle Interno e Auditor (`CONTROLE_INTERNO`, `AUDITOR`, análise independente); Autoridade competente (`AUTORIDADE_COMPETENTE`, visão agregada por unidade); Planejamento, Compras e Licitações (`PLANEJAMENTO`, `COMPRAS`, `LICITACOES`) quando o órgão lhes dá `REPORT_VIEW` de escopo próprio.

## Pré-condições
- `REPORT_VIEW` com escopo que cubra ao menos uma unidade com passagens.
- Fatos de passagem projetados (US-170) e reconciliados (US-171); sem passagens no período a tela mostra estado vazio (FA-01).
- Para o drill-down: o processo precisa ser visível à pessoa (DEC-024) para aparecer na lista.

## Fluxo principal
1. Em `/relatorios` (SCR-027), a pessoa abre o cartão "Gargalos" e chega a `/relatorios/gargalos` (SCR-028), na aba "Por etapa", com o exercício corrente até hoje (início conforme `analytics.fiscalYearStartMonth`).
2. O front chama `ANL-15` com `groupBy=STAGE` e o período. A API valida permissão, escopo, período e filtros e lê o read model.
3. A API calcula, por grupo, as medidas sobre as passagens **fechadas** do período e do escopo (RN-ANL-152 a RN-ANL-155) e responde com `dataAsOf`, o resumo geral e os grupos ordenados do maior para o menor tempo médio.
4. O front mostra o cabeçalho "dados atualizados em …", o resumo e a tabela: etapa, passagens (tamanho da amostra), média, mediana, p90 (dias úteis), % no prazo, devoluções e % de devolução, com barras de tempo acompanhadas dos números e o selo "Amostra pequena" quando aplicável.
5. A pessoa troca a aba para "Por unidade" ou "Por responsável" (`groupBy=DEPARTMENT` ou `ASSIGNEE`), ajusta o período (atalhos "Exercício", "Trimestre", "Mês" e personalizado) e os filtros (órgão, secretaria solicitante, modalidade, tipo de contratação, etapa, unidade) e ordena.
6. Ao abrir uma linha (por exemplo, a etapa "Jurídico"), o front chama `ANL-16` e mostra, num painel lateral, as **passagens** daquele grupo no período (`state=CLOSED`): processo, etapa, unidade, responsável, entrada, saída, dias úteis, situação de saída, prazo cumprido e valor estimado (ou "Sigiloso"), só dos processos que a pessoa pode ver, com link para `/processos/[id]`.
7. Na aba "Por responsável" e ao abrir uma pessoa, a API grava `report.view_detail` (RN-ANL-164); o texto fixo da tela lembra que é análise do fluxo, não avaliação individual.
8. Para quem tem `REPORT_EXPORT`, o botão "Exportar" (US-174) leva a tabela ou a lista do painel para CSV ou XLSX.

## Fluxos alternativos
- **FA-01 — Sem passagens no período:** `200` com lista vazia e resumo zerado; a tela mostra "Nenhuma passagem de etapa concluída neste período e escopo. Amplie o período ou remova filtros."
- **FA-02 — Escopo de unidade:** com `REPORT_VIEW` de unidade, os grupos cobrem só passagens cuja **unidade da etapa** está no escopo; na aba "Por responsável", cada pessoa aparece só com as passagens dessas unidades e a tela diz "Considera apenas as etapas das suas unidades."
- **FA-03 — Amostra pequena:** grupo com menos de 10 passagens recebe `smallSample = true` e o selo "Amostra pequena"; mediana e p90 continuam exibidas, com o tamanho da amostra sempre ao lado.
- **FA-04 — Passagens sem prazo:** passagens sem `dueAt` ficam fora do percentual no prazo; o grupo mostra "{n} com prazo" e, se nenhuma tiver prazo, "% no prazo" aparece como "—".
- **FA-05 — Passagens migradas, puladas ou canceladas:** não entram nas médias de tempo nem na contagem de passagens; a resposta informa `meta.excludedPassagesCount` e a tela mostra "{n} passagens migradas, puladas ou canceladas não entram nos tempos."
- **FA-06 — Dados desatualizados:** defasagem acima de 15 minutos → `meta.stale = true` e aviso "Os dados estão desatualizados desde {hora}."; os números continuam sendo exibidos.
- **FA-07 — Processos não visíveis no drill-down:** a lista mostra só os visíveis (DEC-024); `meta.processVisibility = RESTRICTED` mostra "Esta lista mostra apenas os processos que você pode ver; os números do quadro consideram todos os do seu escopo." sem informar quantos foram ocultados.
- **FA-08 — Valor sigiloso no drill-down:** linha de processo com orçamento sigiloso mostra "Sigiloso" no valor para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo; a UI oferece o *step-up* quando houver (POL-14).
- **FA-09 — Responsável sem nome:** passagens sem `assigneeId` aparecem no grupo "Sem responsável"; pessoa desligada aparece com "(desligado)".
- **FA-10 — Chave de grupo inexistente:** `ANL-16` com etapa que não existe nos workflows do tenant, unidade ou pessoa de outro tenant ou fora do escopo responde `404 NOT_FOUND`.
- **FA-11 — Período longo:** período acima de 36 meses é recusado com `422`; a UI sugere "Escolha até 36 meses."
- **FA-12 — Ordenação por coluna:** a pessoa ordena por qualquer medida; a ordem padrão é pelo maior tempo médio.
- **FA-13 — Link do quadro para a fila:** na linha de cada grupo, "Ver fila agora" leva à aba "Filas" (US-177) já filtrada pelo mesmo grupo.

## Regras de negócio
- **RN-ANL-150** — Fonte: `AnalyticsStageFact` (e a visão `mv_analytics_stage_monthly` como aceleração — RN-ANL-160). `AnalyticsProcessFact` entra só para filtros e atributos do processo no drill-down. **Nunca** `ProcessStage`/`ProcessMovement` (RN-ANL-20, RN-ANL-06, RN-ANL-19). Rótulos de etapa, unidade e pessoa vêm das fachadas de `workflow`, `organization` e `identity`, em lote, a partir de `stageKey`, `departmentId` e `assigneeId`.
- **RN-ANL-151** — Dimensões (`groupBy`): `STAGE` (`stageKey`; o mesmo `stageKey` de versões diferentes de workflow forma um só grupo, rotulado pelo nome mais recente), `DEPARTMENT` (`departmentId` da passagem: a **unidade da etapa**) e `ASSIGNEE` (`assigneeId`, o último responsável da passagem; nulo → "Sem responsável"). Passagens de ramos paralelos (`branchKey`) contam como passagens distintas.
- **RN-ANL-152** — Passagens que compõem os tempos: passagens **fechadas** (`exitedAt` não nulo) com `exitStatus` `COMPLETED` ou `RETURNED`. `MIGRATED`, `SKIPPED` e `CANCELED` **não entram** nas médias, na mediana, no p90, na contagem de passagens nem no percentual (RN-ANL-23); são contadas à parte em `meta.excludedPassagesCount`. Passagens abertas **nunca** entram nos tempos (RN-ANL-22): compõem as filas (US-177).
- **RN-ANL-153** — Atribuição ao período: a passagem pertence ao período em que **saiu** (`exitedAt`, convertido ao fuso do tenant e comparado a `from` e `to` inclusivos). Assim, o tempo de uma passagem que atravessa a virada de mês entra uma vez só, no período em que foi concluída, e a comparação da US-177 usa a mesma regra.
- **RN-ANL-154** — Medidas por grupo: `passagesCount` (n), `avgBusinessDays`, `medianBusinessDays`, `p90BusinessDays` (percentil contínuo `percentile_cont(0.9)` sobre `durationBusinessDays`, **dias úteis descontadas as pausas de SLA**, como a US-172 define; duas casas decimais, arredondamento "para cima na metade"), `onTimePercent`, `withDeadlineCount`, `returnsCount` e `returnRatePercent`. Média e percentis são sobre as passagens da RN-ANL-152; o resumo geral (`totals`) é calculado sobre todas as passagens do recorte, **não** é média das médias.
- **RN-ANL-155** — Prazo e devolução: `onTimePercent` = passagens com `dueAt` não nulo e `wasOverdue = false` ÷ passagens com `dueAt` não nulo × 100 (nulo se nenhuma tiver prazo); `returnsCount` = passagens da etapa encerradas com `exitStatus = RETURNED` (onde as devoluções **saem**); `returnRatePercent` = `returnsCount` ÷ `passagesCount` × 100. Se a US-172 fixar outra definição de devolução ou de cumprimento, ela prevalece e esta regra é ajustada junto (lacuna 3).
- **RN-ANL-156** — Amostra pequena: `smallSample = true` quando `passagesCount < 10` (constante em código, `SMALL_SAMPLE_THRESHOLD`); a resposta e a tela trazem sempre o tamanho da amostra (RN-ANL-24, risco da feature: "amostra pequena gerar conclusões enganosas"). Nenhum grupo é ocultado por amostra pequena.
- **RN-ANL-157** — Período: `from` e `to` (datas ISO, inclusivas, no fuso do tenant); padrão = início do exercício corrente (`analytics.fiscalYearStartMonth`, padrão 1) até hoje; `from ≤ to`; no máximo **36 meses**; `to` no futuro é aceito (não há passagem fechada no futuro) e a resposta traz o período efetivo em `meta.period`.
- **RN-ANL-158** — Escopo (RN-ANL-21, permissions.md §5.2): `TENANT`/`ORGANIZATION` veem todas as passagens do recorte; `DEPARTMENT`/`OWN_DEPARTMENTS` veem as passagens cuja **unidade da etapa** (`departmentId`) está no escopo (com subárvore quando a atribuição inclui). Todos os agregados, inclusive por responsável e o resumo, usam esse recorte. Filtros (`organizationId`, `secretariatId` = `requestingSecretariatId`, `modalityCode`, `contractingTypeCode`, `stageKey`, `departmentId`) só restringem dentro do escopo; id fora do escopo ou de outro tenant → `422` (`REFERENCE_NOT_FOUND`).
- **RN-ANL-159** — Ordenação e paginação: `sort` ∈ `-avgBusinessDays` (padrão), `-medianBusinessDays`, `-p90BusinessDays`, `-passagesCount`, `-returnsCount`, `-returnRatePercent`, `onTimePercent`, `label`; desempates por `-passagesCount` e depois pelo rótulo. `STAGE` e `DEPARTMENT` devolvem todos os grupos (conjunto limitado pelos workflows e pela estrutura); `ASSIGNEE` é paginado (`pageSize` ≤ 100, padrão 50).
- **RN-ANL-160** — Caminho de leitura: com `groupBy` `STAGE` ou `DEPARTMENT`, período de **um mês inteiro** e filtros só pelas chaves da visão (`stageKey`, `departmentId`, `organizationId`), a API usa `mv_analytics_stage_monthly` (que traz passagens, média, mediana, p90, % no prazo e devoluções por mês, etapa e unidade); nos demais casos (vários meses, `ASSIGNEE`, filtros por secretaria, modalidade ou tipo de contratação) calcula sobre `AnalyticsStageFact` pelos índices `(tenant_id, stage_key, exited_at)`, `(tenant_id, department_id, exited_at)` e `(tenant_id, assignee_id, exited_at)`, porque mediana e p90 **não** se compõem a partir de agregados mensais. Os dois caminhos devem dar o mesmo número (teste de paridade).
- **RN-ANL-161** — Caráter analítico do responsável (feature FT-082, riscos): a aba "Por responsável" **não** mostra posição numerada, medalhas, cores de "melhor/pior" nem metas individuais; mostra o texto fixo "Análise do fluxo dos processos. Não é avaliação de desempenho individual. Os números dependem da etapa, do volume e dos prazos de cada processo." e a nota de amostra pequena. A abertura é auditada (RN-ANL-164).
- **RN-ANL-162** — Drill-down (`ANL-16`): lista **passagens** (uma linha por passagem; um processo com ramos paralelos pode aparecer em mais de uma linha) do grupo `{dimension}/{key}`; `state=CLOSED` (padrão) usa as passagens da RN-ANL-152 no período, ordenadas por `-businessDays`; `state=OPEN` usa as passagens abertas agora (fila, definida na US-177), ordenadas por `-ageBusinessDays`. Aplica o mesmo recorte de escopo e os mesmos filtros do quadro. `dimension` na rota: `stage`, `department` ou `assignee` (`key` = `stageKey`, `departmentId` ou `userId`; `none` = "Sem responsável").
- **RN-ANL-163** — Visibilidade e sigilo no drill-down (RN-ANL-25, RN-ANL-12, POL-28): o predicado de visibilidade da DEC-024 é aplicado **na própria consulta** (junção com o predicado exposto por `access`, a mesma porta da US-173), de modo que total, ordenação e paginação só consideram processos visíveis; título e código vêm de `process` em lote para os ids da página, já filtrados. `estimatedValue` (de `AnalyticsProcessFact`) sai como `null` com `estimatedValueMasked = true` quando `isBudgetConfidential` e a pessoa não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo. **Nenhuma soma de valor** é calculada nos gargalos (nem no quadro nem no drill-down), logo não há inferência por diferença; `meta.confidentialExcluded` é sempre `false` aqui. `meta.processVisibility` é `FULL` (escopo `TENANT`/`ORGANIZATION` e predicado sem restrição) ou `RESTRICTED`.
- **RN-ANL-164** — Auditoria de acesso (`report.view_detail`, categoria `ACCESS`; RN-ANL-14, RN-ANL-26): (a) abrir o quadro `groupBy=ASSIGNEE` grava um registro por sessão (`level = OVERVIEW`); (b) cada `ANL-16` grava um registro por sessão, relatório e grupo — para `dimension = assignee`, **por pessoa**; para `stage` e `department`, por dimensão. A deduplicação usa chave Redis com a vida da sessão; se o Redis falhar, a API **grava a auditoria de novo** (audita a mais, nunca a menos). Se a gravação da auditoria falhar, a API responde `503` **sem dados** (falha fechada).
- **RN-ANL-165** — Rótulos: etapa pelo nome mais recente do `stageKey` (se o workflow não resolver, o próprio `stageKey`); unidade pelo nome (inativa: "(inativa)"); pessoa pelo nome de exibição (desligada: "(desligado)"), sem CPF, e-mail ou outro dado pessoal. Nada de dado pessoal além do nome.
- **RN-ANL-166** — Escopo parcial e responsável: com escopo de unidade, a mesma pessoa pode aparecer em duas leituras diferentes (a do gestor de uma secretaria e a do gestor do órgão) com números distintos, porque cada uma conta só as passagens das unidades do seu escopo; a tela informa o recorte em `meta.scope`.
- **RN-ANL-167** — Exportação: o provedor `bottlenecks` (US-174) implementa `SUMMARY` (a tabela da dimensão atual, com os mesmos filtros e período) e `DETAIL` (as passagens de **um** grupo, exigindo `dimension` e `key` nos filtros), pela mesma consulta; a exportação por `ASSIGNEE` grava a dimensão na auditoria `report.export` e exige o mesmo escopo.
- **RN-ANL-168** — Atualidade: `meta.dataAsOf` (mesmo cálculo do cabeçalho da US-172) e `meta.stale` verdadeiro quando a defasagem passa de **15 minutos** (3 vezes a meta de 5 minutos da ADR-014). A mesma definição vale para a US-175, a US-177 e a US-174.
- **RN-ANL-169** — Limites de execução: leitura somente-leitura em uma transação `READ ONLY` com `statement_timeout` de 10 s, um *snapshot* por requisição (resumo e grupos da mesma leitura); sem cache de aplicação (a visão já é a aceleração).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Agrupar por | `groupBy` | `STAGE`, `DEPARTMENT`, `ASSIGNEE` | Não | RN-ANL-151 | `STAGE` |
| Período | `from`, `to` | datas ISO | Não | RN-ANL-157 | início do exercício → hoje |
| Órgão | `organizationId` | lista de uuid | Não | no escopo | — |
| Secretaria solicitante | `secretariatId` | lista de uuid | Não | no escopo | — |
| Modalidade | `modalityCode` | lista de texto | Não | catálogo | — |
| Tipo de contratação | `contractingTypeCode` | lista de texto | Não | catálogo | — |
| Etapa | `stageKey` | lista de texto | Não | existente nos workflows | — |
| Unidade da etapa | `departmentId` | lista de uuid | Não | no escopo | — |
| Ordenação | `sort` | texto | Não | RN-ANL-159 | `-avgBusinessDays` |
| Paginação | `page`, `pageSize` | inteiros | Não | só em `ASSIGNEE`; `pageSize` ≤ 100 | 1 / 50 |
| Passagens (amostra) | `passagesCount` | inteiro | — | RN-ANL-152 | fato |
| Média, mediana e p90 | `avgBusinessDays`, `medianBusinessDays`, `p90BusinessDays` | decimal(8,2) | — | dias úteis, RN-ANL-154 | fato |
| % no prazo | `onTimePercent`, `withDeadlineCount` | decimal(5,2), inteiro | — | RN-ANL-155 | fato |
| Devoluções | `returnsCount`, `returnRatePercent` | inteiro, decimal(5,2) | — | RN-ANL-155 | fato |
| Amostra pequena | `smallSample` | booleano | — | n < 10 | calculado |
| Drill-down: estado | `state` | `CLOSED`, `OPEN` | Não | RN-ANL-162 | `CLOSED` |
| Drill-down: dimensão e chave | `{dimension}`, `{key}` (rota) | `stage`/`department`/`assignee`, texto | Sim | RN-ANL-162 | linha aberta |
| Drill-down: linha | `processId`, `code`, `title`, `stageKey`/`stageLabel`, `departmentLabel`, `assigneeLabel`, `enteredAt`, `exitedAt`, `businessDays`, `calendarDays`, `exitStatus`, `wasOverdue`, `overdueBusinessDays`, `returnedFrom`, `estimatedValue`, `estimatedValueMasked` | vários | — | RN-ANL-163 | fato e processo |
| Data dos dados | `meta.dataAsOf`, `meta.stale` | data/hora, booleano | — | RN-ANL-168 | read model |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `groupBy`, `sort`, `state` ou `pageSize` fora do domínio | Front + API (Zod) | "Filtro inválido." | `VALIDATION_ERROR` (`INVALID_ENUM`/`OUT_OF_RANGE`) |
| V-02 | `from` ou `to` com formato inválido | Front + API (Zod) | "Informe datas válidas." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-03 | `from` posterior a `to` | Front + API (Zod) | "A data inicial deve ser anterior ou igual à final." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-04 | Período acima de 36 meses | Front + API (Zod) | "Escolha um período de até 36 meses." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-05 | Id de filtro fora do escopo ou de outro tenant | API | "Item não encontrado no seu escopo." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-06 | Sem `REPORT_VIEW` | API | "Você não tem permissão para ver os relatórios." | `PERMISSION_DENIED` |
| V-07 | Chave do drill-down inexistente, de outro tenant ou fora do escopo | API | "Item não encontrado." | `NOT_FOUND` |
| V-08 | `pageSize` informado em `STAGE`/`DEPARTMENT` | API | "A paginação só vale para a visão por responsável." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-09 | `agingBand` informado com `state=CLOSED` | API | "A faixa de envelhecimento só vale para a fila." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |

## Permissões
- **Permissão:** `REPORT_VIEW` (risco `L`) para `ANL-15` e `ANL-16`, recortada pelo escopo (unidade da etapa — RN-ANL-158); `PROCESS_VIEW_CONFIDENTIAL_BUDGET` apenas para exibir o valor estimado sigiloso no drill-down; `REPORT_EXPORT` só para exportar (US-174).
- **Políticas:** POL-28 (relatórios e sigilo), POL-09 (sigilo por linha), DEC-024 (visibilidade no drill-down), POL-14 (desmascarar em leitura sem MFA devolve mascarado e oferece *step-up*).
- **MFA:** não exigido por permissão de risco `L`.
- **Sem permissão:** o cartão "Gargalos" não aparece; a API responde `403 PERMISSION_DENIED` e registra `access.denied` (`reasonCode` = `REPORT_VIEW`). Chave de grupo de outro tenant ou fora do escopo: `404 NOT_FOUND`. `CONSULTOR_EXTERNO`: sem `REPORT_VIEW`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio (somente leitura). Os fatos vêm da projeção da US-170. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | Nenhuma | — | Somente leitura. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Análise de gargalos por etapa, unidade e responsável

  Background:
    Given que o tenant "Prefeitura A" está ativo e o read model foi atualizado há 2 minutos
    And "Gil" tem "REPORT_VIEW" com escopo "ORGANIZATION" e não tem a permissão de sigilo
    And "Marta" tem "REPORT_VIEW" com escopo apenas da unidade "Procuradoria"
    And a etapa "JURIDICO" tem 12 passagens fechadas no exercício com 3, 3, 4, 4, 5, 5, 6, 6, 7, 8, 12 e 20 dias úteis

  Scenario: [Sucesso] Tempo por etapa com média, mediana, p90 e amostra
    When "Gil" abrir a análise de gargalos agrupada por "STAGE" no exercício
    Then a etapa "JURIDICO" deve trazer 12 passagens, média 6,92, mediana 5,5 e p90 11,6 dias úteis
    And as etapas devem vir ordenadas pelo maior tempo médio
    And a tela deve mostrar "dados atualizados em" com a hora da última atualização

  Scenario: [Sucesso] Passagens migradas, puladas e canceladas ficam fora dos tempos
    Given que a etapa "JURIDICO" tem também 2 passagens "MIGRATED", 1 "SKIPPED" e 1 "CANCELED" no exercício
    When "Gil" abrir a análise por etapa
    Then a etapa "JURIDICO" deve continuar com 12 passagens e a mesma média
    And "meta.excludedPassagesCount" deve ser 4 e a tela deve informar que essas passagens não entram nos tempos

  Scenario: [Sucesso] Passagem pertence ao período em que saiu
    Given que uma passagem entrou em 28/02 e saiu em 03/03
    When "Gil" consultar fevereiro e depois março
    Then a passagem não deve constar em fevereiro
    And deve constar em março uma única vez

  Scenario: [Sucesso] Percentual no prazo ignora passagens sem prazo
    Given que 8 das 12 passagens do "JURIDICO" têm prazo e 6 delas foram cumpridas
    When "Gil" abrir a análise por etapa
    Then "onTimePercent" deve ser 75 e "withDeadlineCount" deve ser 8

  Scenario: [Sucesso] Devoluções da etapa
    Given que 3 das 12 passagens do "JURIDICO" saíram com "RETURNED"
    When "Gil" abrir a análise por etapa
    Then "returnsCount" deve ser 3 e "returnRatePercent" deve ser 25

  Scenario: [Sucesso] Amostra pequena é sinalizada
    Given que a etapa "DOTACAO" tem 4 passagens fechadas no exercício
    When "Gil" abrir a análise por etapa
    Then "DOTACAO" deve trazer "passagesCount" 4 e "smallSample" verdadeiro
    And a tela deve mostrar o selo "Amostra pequena" ao lado do tamanho da amostra

  Scenario: [Sucesso] Tempo por unidade com escopo da unidade da etapa
    Given que processos solicitados pela Secretaria de Saúde passaram pela unidade "Procuradoria"
    When "Marta" abrir a análise agrupada por "DEPARTMENT"
    Then deve ver apenas passagens cuja unidade da etapa é "Procuradoria", mesmo de processos de qualquer secretaria
    And não deve ver passagens de outras unidades

  Scenario: [Sucesso] Tempo por responsável com auditoria e sem ranking
    When "Gil" abrir a análise agrupada por "ASSIGNEE"
    Then a tabela não deve ter posição numerada, medalhas nem cores de melhor ou pior
    And a tela deve mostrar "Análise do fluxo dos processos. Não é avaliação de desempenho individual."
    And deve gerar registro de auditoria "report.view_detail" com nível "OVERVIEW" uma vez por sessão

  Scenario: [Sucesso] Passagens sem responsável
    Given que existem 5 passagens sem responsável na etapa "JURIDICO"
    When "Gil" abrir a análise por responsável
    Then deve existir o grupo "Sem responsável" com essas passagens

  Scenario: [Sucesso] Drill-down da etapa mostra só processos visíveis
    Given que o processo "0030/2026" é restrito e "Gil" não pode vê-lo
    When "Gil" abrir as passagens da etapa "JURIDICO"
    Then a lista não deve conter o processo "0030/2026"
    And "meta.processVisibility" deve ser "RESTRICTED" sem informar quantos foram ocultados
    And deve gerar registro de auditoria "report.view_detail" para a dimensão "stage" uma vez por sessão

  Scenario: [Sucesso] Valor sigiloso no drill-down
    Given que o processo "0012/2026" tem orçamento sigiloso e "Gil" pode vê-lo
    When "Gil" abrir as passagens do "JURIDICO"
    Then a linha de "0012/2026" deve ter "estimatedValue" nulo e "estimatedValueMasked" verdadeiro
    And nenhuma soma de valor deve existir na resposta

  Scenario: [Sucesso] Abrir uma pessoa gera auditoria por pessoa
    When "Gil" abrir as passagens de "Carlos" e depois as de "Marina"
    Then devem existir dois registros "report.view_detail" com a dimensão "assignee" e o id de cada pessoa
    And abrir "Carlos" de novo na mesma sessão não deve criar outro registro

  Scenario: [Sucesso] Dados desatualizados
    Given que a última atualização do read model foi há 40 minutos
    When "Gil" abrir a análise
    Then "meta.stale" deve ser verdadeiro e a tela deve avisar que os dados estão desatualizados

  Scenario: [Sucesso] Visão mensal e cálculo sobre fatos dão o mesmo resultado
    When "Gil" consultar um único mês completo por "STAGE" (lido da visão) e depois o mesmo mês filtrando todas as modalidades (lido dos fatos)
    Then os números das duas consultas devem ser idênticos

  Scenario: [Validação] Período e parâmetros inválidos
    When "Gil" pedir "from" 2026-05-01 e "to" 2026-01-31
    Then a API deve responder 422 com código "VALIDATION_ERROR" no período
    When "Gil" pedir um período de 40 meses
    Then a API deve responder 422 com código "VALIDATION_ERROR" e "OUT_OF_RANGE"
    When "Gil" pedir "groupBy" "REGION"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e "INVALID_ENUM"

  Scenario: [Validação] Filtro fora do escopo
    When "Marta" filtrar "departmentId" de outra unidade
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND"

  Scenario: [Permissão] Sem REPORT_VIEW
    Given que "Clara" não tem "REPORT_VIEW"
    When "Clara" pedir "GET /bottlenecks"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And o cartão "Gargalos" não deve aparecer para ela
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Permissão] Responsável só com as passagens do escopo
    Given que "Carlos" tem passagens na "Procuradoria" e na "Contabilidade"
    When "Marta" abrir a análise por responsável
    Then "Carlos" deve aparecer apenas com as passagens da "Procuradoria"
    And a tela deve dizer "Considera apenas as etapas das suas unidades."

  Scenario: [Tenant incorreto] Chave de grupo de outro tenant
    Given que a unidade "Procuradoria B" e a pessoa "Paulo B" pertencem ao tenant "Prefeitura B"
    When "Gil" abrir as passagens da unidade "Procuradoria B" e da pessoa "Paulo B"
    Then a API deve responder 404 com código "NOT_FOUND" nos dois casos
    And nenhum nome ou dado de "Prefeitura B" deve ser revelado

  Scenario: [Tenant incorreto] Fatos de outro tenant não entram nos números
    Given que "Prefeitura B" tem passagens na etapa "JURIDICO"
    When "Gil" abrir a análise por etapa em "Prefeitura A"
    Then a etapa "JURIDICO" deve continuar com 12 passagens

  Scenario: [Duplicidade] Evento reprocessado não duplica a passagem
    Given que o evento de saída da passagem "ps-77" foi entregue duas vezes à projeção
    When "Gil" abrir a análise
    Then a passagem "ps-77" deve ser contada uma única vez

  Scenario: [Duplicidade] Reabrir o mesmo drill-down na sessão não repete a auditoria
    When "Gil" abrir três vezes as passagens da etapa "JURIDICO" na mesma sessão
    Then deve existir um único registro "report.view_detail" para essa dimensão e sessão

  Scenario: [Concorrência] Passagem fechada durante a leitura
    Given que a projeção fecha uma passagem do "JURIDICO" enquanto "Gil" consulta
    When "Gil" abrir a análise
    Then resumo e grupos devem vir do mesmo estado do read model, e a soma das passagens dos grupos deve ser igual ao total

  Scenario: [Concorrência] Refresh da visão mensal durante a leitura
    Given que o refresh "CONCURRENTLY" de "mv_analytics_stage_monthly" ocorre durante a consulta
    When "Gil" abrir um único mês completo
    Then a resposta deve vir de uma versão consistente da visão

  Scenario: [Falha de banco] Banco indisponível na leitura
    Given que o banco de dados está indisponível
    When "Gil" abrir a análise
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a tela deve oferecer "Tentar novamente" e manter período e filtros

  Scenario: [Falha de integração] Auditoria indisponível ao abrir por responsável
    Given que a gravação da auditoria falha
    When "Gil" abrir as passagens de "Carlos"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" sem devolver nenhuma linha

  Scenario: [Falha de integração] Redis indisponível na deduplicação da auditoria
    Given que o Redis está indisponível
    When "Gil" abrir duas vezes as passagens de "Carlos" na mesma sessão
    Then a auditoria "report.view_detail" deve ser gravada nas duas aberturas e a resposta deve ser 200

  Scenario: [Falha de integração] Refresh das visões falhou
    Given que o último refresh de "mv_analytics_stage_monthly" falhou e "dataAsOf" está há 2 horas
    When "Gil" abrir um mês completo por etapa
    Then a API deve responder 200 com o último estado e "meta.stale" verdadeiro
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Parâmetro inválido | 422 | `VALIDATION_ERROR` | "Filtro inválido." | Erro no campo |
| Período inválido | 422 | `VALIDATION_ERROR` | "A data inicial deve ser anterior ou igual à final." / "Escolha um período de até 36 meses." | Destaca o período |
| Filtro fora do escopo | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Item não encontrado no seu escopo." | Remove o filtro |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para ver os relatórios." | Oculta o cartão |
| Grupo inexistente, de outro tenant ou fora do escopo | 404 | `NOT_FOUND` | "Item não encontrado." | Fecha o painel e volta ao quadro |
| Muitas requisições | 429 | `RATE_LIMITED` | "Muitas consultas em pouco tempo. Aguarde alguns instantes." | Reabilita após `Retry-After` |
| Banco ou auditoria indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar a análise agora. Tente novamente em instantes." | Botão "Tentar novamente", período e filtros mantidos |

## Dependências
- **Stories:** US-171 (reconstrução e reconciliação: confiança nos fatos de passagem), US-172 (estrutura de relatórios, filtros, escopo, cabeçalho e as definições dos indicadores RN-ANL-70..89). Indiretas: US-170 (projeção das passagens), US-173 (relatório detalhado: o predicado de visibilidade), US-097 (autorização), US-013 (sigilo), US-073 (auditoria), US-174 (exportação), US-177 (filas, envelhecimento e comparação sobre a mesma base).
- **Decisões/ADRs:** DEC-206, ADR-014, DEC-205 (pausas e prazos), DEC-024, DEC-030, DEC-163; POL-28, POL-09, POL-14; roadmap §4.2.
- **Configurações:** `analytics.fiscalYearStartMonth` (início do exercício, período padrão). Constantes em código: limite de 36 meses e amostra pequena (10 passagens).
- **Lacunas nas fontes canônicas:**
  1. As rotas da feature (`/reports/bottlenecks`, `/queues`, `/aging`, `/compare`, `/details`) foram substituídas por `GET /bottlenecks` (`ANL-15`) e `GET /bottlenecks/{dimension}/{key}/processes` (`ANL-16`), com filas e envelhecimento em um só endpoint (`ANL-17`) e comparação em `ANL-18` (US-177). Registrar em api.md; a chave de exportação continua `bottlenecks`.
  2. A visão `mv_analytics_stage_monthly` (entities.md §4.11) traz mediana e p90 por mês, que **não se compõem** entre meses: por isso a API só a usa para um mês inteiro (RN-ANL-160); confirmar que a visão guarda os percentis do mês e as contagens necessárias.
  3. A definição de **devolução** (passagem encerrada por `RETURNED` × passagem aberta por devolução, `returnedFrom`) e de cumprimento de prazo é da US-172 (RN-ANL-70..89); esta story adota "passagens da etapa que saíram por devolução" para o quadro de gargalos. Alinhar com a US-172 se ela fixar outra.
  4. Os fatos não trazem o nome da etapa; usa-se a fachada de `workflow` pelo `stageKey` (nome mais recente). Alternativa: gravar `stageName` no fato. Decisão de arquitetura a confirmar.
  5. O predicado de visibilidade da DEC-024 lê tabelas transacionais de acesso (`process_access` e afins), não `ProcessStage`/`ProcessMovement`; a aplicação **dentro** da consulta dos fatos (RN-ANL-163) precisa ser a mesma da US-173. Confirmar a porta (`VisibilityPredicate`) com o card dessa story.
  6. A auditoria `report.view_detail` (events.md §7) é definida como "uma vez por sessão e relatório"; esta story a estende para "uma vez por sessão e pessoa" na dimensão responsável (RN-ANL-26) e para a abertura do quadro por responsável (`level = OVERVIEW`). Acrescentar `dimension`, `key` e `level` à lista de `metadata` do registro.
  7. Códigos novos: nenhum; reutilizados `VALIDATION_ERROR`, `PERMISSION_DENIED`, `NOT_FOUND`, `RATE_LIMITED`, `DEPENDENCY_UNAVAILABLE`.
  8. A identidade `assigneeId` do fato é "o último responsável da passagem": passagem reatribuída conta para o último; se o produto quiser tempo por responsável ao longo da passagem, o fato precisaria de histórico de atribuição (fora do MVP 2).

## Impacto técnico
- **Performance:** meta p95 ≤ 2 s para o exercício, medida na suíte de performance (endurecimento) e não no card. Os índices dos fatos cobrem as três dimensões; a visão acelera o mês fechado; percentis exatos por `percentile_cont` em uma consulta agrupada. Para um tenant com 1 milhão de passagens no exercício, o plano esperado é varredura por índice de `exited_at`; se passar de 2 s, o critério de revisão da ADR-014 (particionar por exercício) se aplica.
- **Segurança e LGPD:** responsável como recorte analítico sob escopo e auditoria; sem ranking; texto fixo; nenhum dado pessoal além do nome; auditoria fecha em falha; nenhum valor somado; visibilidade aplicada na consulta.
- **Consistência:** um *snapshot* por requisição; os caminhos "visão" e "fatos" têm teste de paridade; exclusão de passagens `MIGRATED`/`SKIPPED`/`CANCELED` testada contra a reconciliação.
- **Compatibilidade:** sem alteração de endpoints do MVP 1; reaproveita o formato de resposta da US-172; prepara as US-177 (filas e comparação) com um agregador comum (`StageDurationAggregator`).
- **Risco de interpretação:** conclusões erradas por amostra pequena e uso individual dos números; mitigados pelo tamanho da amostra sempre visível, pelo selo e pelo texto fixo.

## Backend
- **Módulo(s):** `analytics` (consultas, agregador, regras), `workflow`, `organization` e `identity` (rótulos em lote), `process` (título e código da página do drill-down, em lote), `access` (escopo, predicado de visibilidade, permissão de sigilo), `audit`.
- **Casos de uso:** `GetBottlenecksQuery` (`ANL-15`), `ListBottleneckProcessesQuery` (`ANL-16`), `BottlenecksExportProvider` (provedor `bottlenecks`, US-174).
- **Domínio:** `StageDurationAggregator` (n, média, mediana, p90, prazo, devolução; compartilhado com a US-177), `StagePassagePolicy` (quais passagens entram — RN-ANL-152/153), `BottleneckScope` (unidade da etapa), `ConfidentialValuePolicy` (valor por linha no drill-down), `DetailAccessAuditor` (deduplicação e falha fechada — RN-ANL-164), `ReportFreshness`.
- **Integrações internas:** repositório do `analytics` (`SELECT` com RLS nos fatos e funções `security definer` na visão), `AccessScopeResolver`, `VisibilityPredicate`, `StageLabelResolver`, `DepartmentLabelResolver`, `UserLabelResolver`, `ProcessSummaryPort`, `AuditService`, Redis (deduplicação da auditoria por sessão).
- **Transação:** leitura única `READ ONLY` (`statement_timeout` 10 s); a auditoria `report.view_detail` é gravada **antes** de devolver o drill-down e do quadro por responsável; falha ao auditar → `503` sem dados.

## Frontend
- **Tela(s):** SCR-028 (`/relatorios/gargalos`, abas "Por etapa", "Por unidade", "Por responsável"; as abas "Filas", "Envelhecimento" e "Comparação" são da US-177) com painel lateral de drill-down; ponto de entrada no cartão "Gargalos" da SCR-027.
- **Componentes:** `BottleneckTabs`, `BottleneckTable` (ordenável), `DurationBars` (média, mediana e p90 com valores em texto), `SampleSizeBadge` ("Amostra pequena"), `PeriodPicker` (atalhos e personalizado, até 36 meses), `ReportFilters` (da US-172), `ScopeNotice`, `AnalyticNoticeAssignee` (texto fixo), `PassagesDrawer` (lista paginada com link ao processo), `ConfidentialValueCell` ("Sigiloso"), `DataAsOfBadge`, `ExportButton` (US-174).
- **Estados:** loading (skeleton), vazio ("Nenhuma passagem de etapa concluída neste período e escopo. Amplie o período ou remova filtros."), erro com "Tentar novamente" (período e filtros mantidos), sucesso; estado "dados desatualizados".
- **Acessibilidade e responsividade:** barras sempre com valores em texto; selo de amostra e situação por texto e ícone (nunca só cor); abas por teclado (`role="tablist"`); painel lateral com foco preso e `Esc` para fechar; tabela em cartões abaixo de 768 px; filtros em gaveta no celular; períodos informados por texto e por seletor; URL com os filtros (`?dimensao=etapa&de=…&ate=…`) para compartilhar a visão.

## Banco de dados
- **Tabelas:** leitura de `analytics_stage_facts`, `analytics_process_facts` (atributos do drill-down) e da visão `mv_analytics_stage_monthly` (dono `analytics`); nenhuma tabela nova.
- **Migrações:** nenhuma nesta story (os ajustes das lacunas entram na M2-19/US-170).
- **Índices/constraints relevantes:** `(tenant_id, stage_key, exited_at)`, `(tenant_id, department_id, exited_at)`, `(tenant_id, assignee_id, exited_at)` e `(tenant_id, entered_at)` nos fatos; índice único da visão `(tenant_id, month, stage_key, department_id)`; função `security definer` `analytics_stage_monthly(tenant, from, to, scope…)`; `(tenant_id, process_id)` em `analytics_process_facts`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `ANL-15` | GET | `/bottlenecks` | `groupBy`, `from`, `to`, `organizationId[]`, `secretariatId[]`, `modalityCode[]`, `contractingTypeCode[]`, `stageKey[]`, `departmentId[]`, `sort`, `page`, `pageSize` | `200 { data: { groupBy, totals, groups[ { key, label, passagesCount, avgBusinessDays, medianBusinessDays, p90BusinessDays, onTimePercent, withDeadlineCount, returnsCount, returnRatePercent, smallSample } ] }, meta: { dataAsOf, stale, period, scope, excludedPassagesCount, confidentialExcluded: false, page?, totalItems? } }` | 200, 403, 422, 429, 503 |
| `ANL-16` | GET | `/bottlenecks/{dimension}/{key}/processes` | `dimension` ∈ `stage`/`department`/`assignee`; `state` (`CLOSED`/`OPEN`), `from`, `to`, mesmos filtros, `agingBand` (só `OPEN`), `sort`, `page`, `pageSize` (≤ 100) | `200 { data: [ { passageId, processId, code, title, stageKey, stageLabel, departmentLabel, assigneeLabel, enteredAt, exitedAt?, businessDays, calendarDays, exitStatus?, wasOverdue, overdueBusinessDays?, returnedFrom, ageBusinessDays?, isPaused?, estimatedValue?, estimatedValueMasked } ], meta: { dataAsOf, stale, scope, processVisibility, page, totalItems } }` | 200, 403, 404, 422, 429, 503 |

## Logs
- `info` `analytics.bottlenecks.read` — `groupBy`, `periodMonths`, `durationMs`, `source` (`MV` ou `FACTS`), `groupsReturned`, `scopeLevel`.
- `info` `analytics.bottlenecks.drilldown` — `dimension`, `state`, `durationMs`, `rowsReturned` (sem a chave quando `dimension = assignee`).
- `warn` `analytics.bottlenecks.stale` — `dataAsOf`, `lagMinutes`.
- `warn` `analytics.bottlenecks.audit_dedupe_unavailable` — falha do Redis (a auditoria foi gravada de novo).
- `error` `analytics.bottlenecks.failed` — `errorCode`, `durationMs`.
- **Nunca logar:** nomes e ids de pessoas do recorte por responsável, códigos e títulos de processo, valores, filtros por pessoa.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `report.view_detail` | `ACCESS` | Abrir o quadro `ASSIGNEE` (1×/sessão) e abrir o drill-down (1×/sessão e relatório; por pessoa quando `assignee`), **antes** de devolver os dados | `metadata`: `report = bottlenecks`, `dimension`, `key` (só em `assignee` e `department`), `level` (`OVERVIEW` ou `DRILL_DOWN`), `state`, `period`, `scopeLevel` |
| `access.denied` | `ACCESS` | Tentativa sem `REPORT_VIEW` | `reasonCode` = `REPORT_VIEW` |

## Testes necessários
- **Unitários:** `StageDurationAggregator` (média, mediana, p90 com os 12 valores do exemplo, arredondamento, amostra pequena, percentual no prazo sem prazo, devolução); `StagePassagePolicy` (exclusão de `MIGRATED`/`SKIPPED`/`CANCELED`, atribuição por `exitedAt` na virada de mês e de fuso); `BottleneckScope`; `DetailAccessAuditor` (deduplicação por sessão e pessoa, falha fechada); validação de período.
- **Integração (Testcontainers PostgreSQL + Redis):** consultas nas três dimensões com RLS e funções `security definer`; paridade visão × fatos; predicado de visibilidade dentro da consulta (total e paginação só do visível); refresh `CONCURRENTLY` durante a leitura; passagens de ramos paralelos; reconciliação alterando a medida; auditoria antes da resposta.
- **API/contrato:** `ANL-15` e `ANL-16` (formato, `meta`, `smallSample`, `excludedPassagesCount`, `processVisibility`); códigos de erro; `404` para chave de outro tenant.
- **RBAC e multi-tenant:** `REPORT_VIEW` por escopo (órgão, unidade da etapa, responsável com escopo parcial); sem `REPORT_VIEW` → 403; fatos e chaves de outro tenant nunca aparecem (suíte `test/tenant-leak`); **teste de visibilidade e de sigilo** no drill-down (processo restrito e valor sigiloso).
- **Concorrência:** projeção fechando passagem durante a leitura; refresh durante a leitura; eventos duplicados e fora de ordem; duas aberturas simultâneas da mesma pessoa na mesma sessão (um registro de auditoria).
- **E2E (Playwright):** abrir "Gargalos", trocar abas, ajustar período, abrir o painel de passagens, ver o texto fixo por responsável, exportar.
- **Acessibilidade/performance:** axe nas abas e no painel; consulta do exercício com volume alto (p95 ≤ 2 s) na suíte de performance (medida no endurecimento).

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
- [ ] Teste de arquitetura: nenhuma consulta a `ProcessStage` ou `ProcessMovement` nos gargalos
- [ ] Teste de paridade visão × fatos e quadro × exportação verde
- [ ] Teste de visibilidade e sigilo no drill-down verde; auditoria por pessoa verificada
- [ ] Métricas `cf_analytics_query_duration_seconds{report="bottlenecks",source}` publicadas

## Estimativa
**L** — três dimensões com percentis, atribuição ao período e exclusão de passagens; dois caminhos de leitura (visão e fatos) com paridade; drill-down com visibilidade aplicada dentro da consulta, sigilo por linha e auditoria que falha fechada; quadro por responsável com tratamento de privacidade; provedor de exportação e tela com abas, painel e filtros.

## Prioridade
**P1** — achar onde as contratações travam é o objetivo central do épico (roadmap §4.2) e critério de aceite da FT-082; depende da US-171 e da US-172 e é a base das filas e da comparação (US-177).
