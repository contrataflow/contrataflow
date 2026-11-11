---
id: FT-082
title: "Gargalos"
epic: EP-028
mvp: 2
priority: P1
stories: [US-176, US-177]
status: Especificada
---

# FT-082 — Gargalos

## Título
Gargalos

## Épico
EP-028 — Indicadores e gargalos

## Descrição
Análise descritiva do tempo que os processos passam em cada etapa, unidade e responsável, para mostrar onde as contratações travam (roadmap §4.2, DEC-206). A análise vive na SCR-028 e lê só o read model (`AnalyticsStageFact` e a visão `mv_analytics_stage_monthly`):
- **Tempo por etapa, unidade e responsável:** duração média, mediana e p90, percentual dentro do prazo e devoluções, com ordenação pelos maiores tempos.
- **Filas:** o que está parado agora em cada etapa, unidade ou responsável (passagens abertas).
- **Envelhecimento:** distribuição do tempo parado por faixas.
- **Comparação entre períodos:** o mesmo indicador em dois recortes (por exemplo, este trimestre × o anterior).

É descritiva: não prevê nem recomenda (previsão e saúde do processo são do MVP 5). Os mesmos controles de escopo, visibilidade e sigilo dos relatórios valem aqui.

## Valor para o usuário e para o órgão
- O gestor vê em segundos qual etapa, unidade ou pessoa concentra o atraso.
- Filas e envelhecimento orientam a redistribuição de trabalho e o escalonamento.
- Comparar períodos mostra se uma mudança de processo ou de SLA funcionou.

## Personas
- Gestor de contratações (`GESTOR_CONTRATACOES`) — uso principal.
- Controle interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`) — análise independente.
- Autoridade competente (`AUTORIDADE_COMPETENTE`) — visão agregada por unidade.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-176 | Análise de gargalos por etapa, unidade e responsável | P1 | L | US-171, US-172 |
| US-177 | Filas, envelhecimento e comparação entre períodos | P1 | M | US-176 |

## Escopo
- Tempo por etapa, por unidade e por responsável, com média, mediana, p90, passagens, devoluções e percentual no prazo.
- Filas atuais (passagens sem saída) por etapa, unidade e responsável, com link ao processo pela visibilidade da pessoa.
- Envelhecimento em faixas configuráveis em código, por etapa e unidade.
- Comparação entre dois períodos, com variação absoluta e percentual.
- Recortes por exercício, secretaria, modalidade e tipo de contratação, e exportação pela FT-081.

## Fora de escopo
- Previsão de prazo, saúde do processo, recomendações e alertas preditivos (MVP 5).
- Ações sobre o processo a partir da tela (redistribuir, escalonar): continuam no fluxo normal e no SLA (EP-030).
- Ranking de pessoas com finalidade de avaliação de desempenho: o responsável aparece como recorte analítico, sob escopo e auditoria.
- Políticas de SLA (EP-030); aqui só a medição.

## Regras de negócio da feature
- RN-ANL-20 — A análise lê somente `AnalyticsStageFact` e as visões materializadas; nunca `ProcessStage`/`ProcessMovement` (DEC-206).
- RN-ANL-21 — Nos gargalos o escopo de unidade recorta pela **unidade da etapa** da passagem, e não pela secretaria solicitante (permissions.md §5.2, DEC-206).
- RN-ANL-22 — Passagens abertas (`exitedAt` nulo) compõem filas e envelhecimento; passagens fechadas compõem tempos e comparações (entities.md §4.11).
- RN-ANL-23 — Durações usam dias úteis descontadas as pausas de SLA; passagens `MIGRATED`, `SKIPPED` e `CANCELED` não entram nas médias de tempo (DEC-206, DEC-205).
- RN-ANL-24 — A comparação entre períodos exige períodos de mesma duração e mostra o tamanho da amostra de cada um, sinalizando amostra pequena (DEC-206).
- RN-ANL-25 — O detalhamento de uma fila ou de um gargalo até o processo aplica o predicado de visibilidade da DEC-024 e o sigilo da POL-09, como no relatório detalhado (POL-28).
- RN-ANL-26 — Os agregados por responsável respeitam o escopo de `REPORT_VIEW` e a abertura por pessoa é auditada como acesso a detalhamento (`report.view_detail`) (DEC-206).

## Telas
- SCR-028 — Relatório detalhado e gargalos (`/relatorios/[relatorio]`), com as visões de etapa, unidade, responsável, filas, envelhecimento e comparação.
- SCR-027 — Relatórios: ponto de entrada para as análises de gargalos.

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `GET /bottlenecks` (ANL-15) — tempo por etapa, unidade ou responsável (parâmetro de agrupamento), com filtros.
- `GET /bottlenecks/queues` (ANL-17) — filas atuais e envelhecimento em faixas por etapa, unidade e responsável.
- `GET /bottlenecks/comparison` (ANL-18) — comparação entre dois períodos de mesma duração.
- `GET /bottlenecks/{dimension}/{key}/processes` (ANL-16) — processos por trás de um número (visibilidade DEC-024).

## Entidades
- Leitura de `AnalyticsStageFact` e `AnalyticsProcessFact` e da visão `mv_analytics_stage_monthly` (dono `analytics`).
- `TenantSetting` `analytics.fiscalYearStartMonth`.

## Eventos
- Nenhum evento novo; auditoria `report.view_detail` e `report.export`.

## Permissões
- `REPORT_VIEW` — ver os gargalos, recortados pelo escopo.
- `REPORT_EXPORT` — exportar as tabelas de gargalos.
- `PROCESS_VIEW_CONFIDENTIAL_BUDGET` — valores sigilosos nas linhas, quando houver.

## Dependências
- FT-080 (fatos de passagem de etapa) e US-171 (reconciliação confiável); US-172 (estrutura de relatórios, filtros e escopo).
- EP-030 (pausas e prazos de SLA melhoram a medição quando existirem); EP-023 não é necessário aqui.

## Critérios de aceite da feature
```gherkin
Feature: Análise de gargalos
  Scenario: Descobrir onde o processo trava e comparar períodos
    Given que "Gil" tem "REPORT_VIEW" com escopo do órgão
    And o trimestre atual tem passagens mais longas na etapa "JURIDICO" que o trimestre anterior
    When "Gil" abrir a análise de gargalos agrupada por etapa
    Then a etapa "JURIDICO" deve aparecer entre as de maior tempo médio, com mediana, p90 e percentual no prazo
    When "Gil" comparar o trimestre atual com o anterior
    Then deve ver a variação absoluta e percentual e o tamanho da amostra de cada período
    When "Gil" abrir a fila da etapa "JURIDICO"
    Then deve ver os processos parados agora, apenas os que ele pode ver em Processos
```

## Métricas de sucesso
- ≥ 60% dos gestores usam a análise de gargalos ao menos uma vez por mês.
- Consulta de gargalos do exercício com p95 ≤ 2 s.
- 0 vazamentos de processos não visíveis nos testes de autorização.

## Riscos
- Uso da análise por responsável como avaliação individual — escopo, auditoria e texto da tela deixando claro o caráter analítico.
- Amostra pequena gerar conclusões enganosas — tamanho da amostra sempre exibido e sinalização.
- Passagens migradas ou puladas distorcerem a média — excluídas dos cálculos de tempo.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
