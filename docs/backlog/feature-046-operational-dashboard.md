---
id: FT-046
title: "Dashboard operacional"
epic: EP-014
mvp: 1
priority: P0
stories: [US-076]
status: Especificada
---

# FT-046 — Dashboard operacional

## Título
Dashboard operacional

## Épico
EP-014 — Dashboard

## Descrição
Entrega o painel inicial do produto (SCR-003, `/painel`): um resumo rápido de pendências, atrasos e volume, mais um conjunto de indicadores independentes (por status, por etapa, atrasados, próximos do prazo, tempo médio por etapa, abertos por mês, valor por secretaria e atividade recente). Todo indicador respeita a visibilidade de processos do usuário (DEC-024) e o sigilo do orçamento estimado (POL-09), inclusive em valores agregados.

A feature não introduz entidade própria: é inteiramente composta por consultas agregadas sobre dados já existentes de processo, tramitação e timeline, com cache de 60 s para manter a meta de desempenho (p95 < 1 s por indicador).

## Valor para o usuário e para o órgão
- Reduz a zero cliques para saber "como está a operação" ao abrir o sistema.
- Evita montar filtros manualmente na lista de processos para chegar a números que hoje exigem trabalho manual (atrasados, volume por secretaria).
- Mantém os números do painel consistentes com os da caixa de tarefas, evitando divergência entre telas.

## Personas
- Área requisitante (`REQUISITANTE`) — vê suas pendências e processos em andamento.
- Gestor de contratações (`GESTOR_CONTRATACOES`) — visão geral de status, atrasos e volume por secretaria.
- Planejamento (`PLANEJAMENTO`) — volume de processos abertos por mês e por etapa.
- Compras (`COMPRAS`) e Gestor de contrato (`GESTOR_CONTRATO`) — pendências, atrasados e atividade recente.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-076 | Dashboard operacional por perfil | P0 | L | US-002, US-055, US-056 |

## Escopo
- Endpoint de resumo (`DSH-01`) e endpoint de indicador individual (`DSH-02`), ambos sob `DASHBOARD_VIEW`.
- Nove indicadores definidos em US-076 (pendências, por status, por etapa, atrasados, próximos do prazo, tempo médio por etapa, abertos por mês, valor por secretaria, atividade recente).
- Filtro por secretaria/unidade, aplicado dentro da visibilidade do usuário.
- Cache de 60 s por tenant/usuário/indicador/filtros, com degradação graciosa se o Redis estiver indisponível.

## Fora de escopo
- Entidade/persistência própria de indicadores (não existe — DEC-026).
- Exportação de indicadores e relatórios gerenciais aprofundados (outro épico/MVP).
- Dashboards específicos por fase de execução contratual, contratos ou fornecedores (fora do MVP 1).

## Regras de negócio da feature
- Visibilidade de processos (DEC-024) aplicada a todo indicador; `DASHBOARD_VIEW` é só o portão de acesso, nunca amplia escopo (RN-DASH-01).
- Catálogo fechado de indicadores via `DashboardWidgetKey` (registro) — RN-DASH-02.
- Consistência obrigatória entre o indicador de pendências e os contadores da caixa de tarefas (`TSK-02`) — RN-DASH-03.
- Mascaramento agregado de valores sigilosos por secretaria (POL-09) — RN-DASH-07.
- Cache de 60 s com fallback direto ao banco se o Redis falhar — RN-DASH-10.

## Telas
- SCR-003 — Dashboard (`/painel`)

## Endpoints
- DSH-01 `GET /dashboard/summary` — resumo rápido (pendências, atrasados, próximos do prazo, abertos)
- DSH-02 `GET /dashboard/widgets/{widgetKey}` — dado detalhado de cada indicador

## Entidades
- `Process`, `ProcessStage`, `ProcessTimelineEntry`, `Approval` — consumidas (sem entidade própria da feature)

## Eventos
- Nenhum — feature somente leitura (`DSH-01`/`DSH-02` não geram eventos de domínio).

## Permissões
- `DASHBOARD_VIEW` — acesso ao painel e aos endpoints
- `PROCESS_VIEW_CONFIDENTIAL_BUDGET` — valores não mascarados no indicador de valor por secretaria

## Dependências
- Stories: US-002, US-055, US-056.
- Decisões: DEC-024, DEC-026, DEC-030, DEC-180.

## Critérios de aceite da feature
```gherkin
Feature: Dashboard operacional
  Scenario: Jornada ponta a ponta do painel
    Given que "Ana" tem vínculo ativo e "DASHBOARD_VIEW"
    When "Ana" abrir o painel em "/painel"
    Then ela deve ver o resumo e os indicadores dentro de sua visibilidade de processos
    And ao filtrar por secretaria os indicadores devem se atualizar
    And ao clicar no indicador "Atrasados" ela deve ser levada à lista filtrada correspondente
```

## Métricas de sucesso
- p95 < 1 s por indicador, com até 10.000 processos ativos no tenant
- Taxa de acerto do cache > 70% em uso normal

## Riscos
- Agregação de 90 dias (tempo médio por etapa) pesada sob base grande — mitigar com índice dedicado em `process_stages` e monitorar como débito técnico.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
