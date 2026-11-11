---
id: FT-081
title: "Indicadores e relatórios"
epic: EP-028
mvp: 2
priority: P1
stories: [US-172, US-173, US-174, US-175]
status: Especificada
---

# FT-081 — Indicadores e relatórios

## Título
Indicadores e relatórios

## Épico
EP-028 — Indicadores e gargalos

## Descrição
Os relatórios de gestão do MVP 2, lidos do read model da FT-080:
- **Relatórios (SCR-027):** tempo de ciclo, devoluções, cumprimento de prazo, volume e valor por secretaria e modalidade, por mês e exercício, com filtros e a data da última atualização.
- **Relatório detalhado (SCR-028):** o detalhamento por processo por trás de cada número, respeitando a visibilidade de cada pessoa.
- **Exportação:** CSV e XLSX pela fila de exportações, auditada.
- **Execução do PCA:** previsto × vinculado × concluído por item, secretaria e categoria.

Todo resultado respeita o escopo da permissão `REPORT_VIEW` (tenant, órgão ou unidades). Valores de processos com orçamento sigiloso são excluídos das somas de quem não tem a permissão de sigilo, e o relatório informa que há valores não exibidos (`confidentialExcluded`). O detalhamento por processo aplica sempre o predicado de visibilidade da DEC-024. Nenhuma consulta toca `ProcessStage` ou `ProcessMovement`.

## Valor para o usuário e para o órgão
- A gestão responde "quanto, quando, por quem, com que atraso" sem planilha manual.
- Prestação de contas à alta administração (art. 11, parágrafo único) com números rastreáveis até o processo.
- Acompanhamento do PCA durante o exercício, não só ao final.

## Personas
- Gestor de contratações (`GESTOR_CONTRATACOES`) — relatórios e exportação.
- Controle interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`) — detalhamento e exportação auditada.
- Autoridade competente (`AUTORIDADE_COMPETENTE`) — visão do exercício e do PCA.
- Planejamento (`PLANEJAMENTO`) — execução do PCA.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-172 | Relatórios de indicadores | P1 | L | US-013, US-097, US-171 |
| US-173 | Relatório detalhado com detalhamento por processo | P1 | M | US-172 |
| US-174 | Exportar relatórios | P1 | M | US-073, US-083, US-172 |
| US-175 | Indicadores de execução do PCA | P1 | S | US-144, US-172 |

## Escopo
- Catálogo de relatórios: tempo de ciclo, devoluções, cumprimento de prazo, volume e valor por secretaria e modalidade, com recortes por mês, exercício (`analytics.fiscalYearStartMonth`), secretaria, modalidade e tipo de contratação.
- Cabeçalho "dados atualizados em ..." em todos os relatórios.
- Relatório detalhado com lista de processos por trás do indicador, ordenação e paginação.
- Exportação CSV/XLSX assíncrona, com download e auditoria.
- Execução do PCA: previsto, vinculado e concluído, por item, secretaria e categoria.
- Mascaramento do sigilo e aviso "inclui valores sigilosos não exibidos".

## Fora de escopo
- Construtor de relatórios livres e BI externo.
- Análise de gargalos (FT-082).
- Dashboard operacional (DEC-088, EP-014).
- Publicação do PCA em sítio oficial (exportação do EP-023).

## Regras de negócio da feature
- RN-ANL-11 — Os agregados são recortados pelo escopo de `REPORT_VIEW`: `TENANT` e `ORGANIZATION` veem todo o recorte; `DEPARTMENT` e `OWN_DEPARTMENTS` veem processos cuja **secretaria solicitante** está no escopo (DEC-206, permissions.md §5.2).
- RN-ANL-12 — O detalhamento por processo aplica o predicado de visibilidade da DEC-024 sobre os fatos, mesmo com escopo `TENANT`: só lista o que a pessoa veria em Processos (DEC-206, POL-28).
- RN-ANL-13 — Processos com orçamento sigiloso ficam fora das somas de quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` sobre eles, e o resultado traz `confidentialExcluded: true`; o mascaramento é por linha **antes** de agregar (DEC-030, POL-28).
- RN-ANL-14 — Abrir o detalhamento por processo é auditado (`report.view_detail`, uma vez por sessão e relatório) (DEC-206).
- RN-ANL-15 — A exportação exige `REPORT_EXPORT`, aplica o mesmo filtro de escopo e de sigilo da tela e é auditada (`report.export`) (DEC-206, POL-28).
- RN-ANL-16 — A exportação roda pela fila de exportações no worker; o arquivo fica disponível por tempo limitado e só a quem pediu (DEC-206).
- RN-ANL-17 — O tempo de ciclo e o cumprimento de prazo usam os fatos em dias úteis, descontadas as pausas de SLA (DEC-206, DEC-205).
- RN-ANL-18 — A execução do PCA compara `plannedValue`, `linkedEstimatedValue` e processos concluídos; a soma dos vinculados exclui sigilosos para quem não tem a permissão (DEC-197, DEC-206, POL-09).
- RN-ANL-19 — Nenhum relatório consulta `ProcessStage`/`ProcessMovement` em produção; só o read model (DEC-206).

## Telas
- SCR-027 — Relatórios (`/relatorios`).
- SCR-028 — Relatório detalhado e gargalos (`/relatorios/[relatorio]`) — nesta feature, o detalhamento por processo.

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `GET /reports` — catálogo de relatórios disponíveis à pessoa.
- `GET /reports/{report}` — agregados do relatório com filtros, escopo e `confidentialExcluded`.
- `GET /reports/{report}/details` — detalhamento por processo (visibilidade DEC-024), paginado.
- `POST /reports/{report}/exports` — solicitar exportação CSV ou XLSX.
- `GET /reports/exports/{id}` — acompanhar e baixar a exportação.
- `GET /reports/pca-execution` — execução do PCA por exercício, secretaria e categoria.

## Entidades
- Leitura de `AnalyticsProcessFact`, `AnalyticsStageFact` e `AnalyticsPcaItemFact` e das visões materializadas (dono `analytics`).
- `TenantSetting` `analytics.fiscalYearStartMonth`.
- Arquivo de exportação como `Attachment` (`targetType` conforme o card de API).

## Eventos
- Nenhum evento de domínio novo; auditoria `report.view_detail` (ACCESS) e `report.export` (EXPORT).
- Notificação de exportação pronta, se a fila de exportações a oferecer (padrão do MVP 1).

## Permissões
- `REPORT_VIEW` — ver os relatórios e o detalhamento, recortados pelo escopo.
- `REPORT_EXPORT` — exportar CSV/XLSX.
- `PROCESS_VIEW_CONFIDENTIAL_BUDGET` — incluir valores sigilosos nas somas e nas linhas.

## Dependências
- FT-080 (read model) e US-171 (reconstrução e reconciliação).
- US-013 (sigilo do orçamento), US-097 (autorização na API e no frontend), US-073 (auditoria), US-083 (worker e filas), US-144 (execução do PCA do EP-023).
- DEC-206, ADR-014, POL-28.

## Critérios de aceite da feature
```gherkin
Feature: Indicadores e relatórios
  Scenario: Do indicador ao processo, com sigilo respeitado
    Given que "Gil" tem "REPORT_VIEW" com escopo da secretaria de Saúde e sem a permissão de sigilo
    And existem processos da Saúde, um deles com orçamento sigiloso
    When "Gil" abrir o relatório de volume e valor por modalidade
    Then deve ver apenas processos da Saúde, com a data da última atualização
    And os totais devem excluir o processo sigiloso e indicar "confidentialExcluded"
    When "Gil" abrir o detalhamento de uma modalidade
    Then deve listar apenas processos que ele pode ver em Processos
    And o acesso ao detalhamento deve constar na auditoria

  Scenario: Exportar relatório
    Given que "Rita" (Controle Interno) tem "REPORT_EXPORT"
    When ela exportar o relatório de cumprimento de prazo em XLSX
    Then o arquivo deve respeitar o mesmo escopo e sigilo da tela
    And a exportação deve constar na auditoria como "report.export"
```

## Métricas de sucesso
- Relatório do exercício com p95 ≤ 2 s.
- 100% das exportações auditadas e com o mesmo recorte da tela.
- 0 vazamentos de processos não visíveis ou de valores sigilosos nos testes de autorização e de tenant leak.

## Riscos
- Soma revelar valor sigiloso por diferença — mascaramento por linha antes de agregar e totais sem sigilosos.
- Número da tela divergir do exportado — mesma consulta e mesmo filtro nos dois caminhos, com teste de paridade.
- Gestor ler dados desatualizados — data da última atualização sempre visível.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
