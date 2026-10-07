---
id: FT-002
title: "Consultar processos"
epic: EP-001
mvp: 1
priority: P0
stories: [US-002, US-003]
status: Especificada
---

# FT-002 — Consultar processos

## Título
Consultar processos

## Épico
EP-001 — Processo de contratação

## Descrição
Consulta de processos: lista paginada no servidor com busca textual, filtros, atalhos e ordenação (US-002), mais visões salvas e exportação CSV sobre o mesmo contrato de filtros (US-003). A API aplica sempre o predicado de visibilidade (permissions.md §5) e o mascaramento do orçamento sigiloso (POL-09), inclusive no filtro e na ordenação por valor.

## Valor para o usuário e para o órgão
- Responde "onde está cada processo, com quem e o que está atrasado" sem planilhas paralelas.
- Visões salvas e exportação CSV sustentam relatórios e prestações de contas recorrentes sem redigitação.

## Personas
- Gestor de contratações e qualquer servidor que acompanha processos — consulta.
- Controle Interno/Auditor — consulta e exportação, inclusive de valores sigilosos quando aplicável.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-002 | Listar, pesquisar, filtrar e ordenar processos | P0 | L | US-001, US-097 |
| US-003 | Visões salvas e exportação CSV da lista de processos | P2 | M | US-002 |

## Escopo
- Tabela paginada, busca FTS + trigram, filtros fechados, atalhos, ordenação, colunas configuráveis.
- Visões salvas (pessoais e compartilhadas) e exportação CSV em streaming, até 10.000 linhas.

## Fora de escopo
- Conteúdo do painel do processo — FT-003.
- Exportações de outros módulos (pesquisa de preços, ETP etc.) — tratadas nos respectivos épicos.

## Regras de negócio da feature
- RN-PROC-19 a RN-PROC-33 (US-002): visibilidade, combinação de filtros, valores reservados, atraso, busca, ordenação, paginação, colunas, badge de sigilo.
- RN-PROC-34 a RN-PROC-46 (US-003): visão padrão única, compartilhamento por critério (nunca por dado), limite de 20 visões, exportação com o mesmo contrato, limite de 10.000 linhas, proteção contra CSV injection, formato pt-BR.

## Telas
- SCR-004 — Processos (`/processos`)

## Endpoints
- PRC-01 `GET /processes` — lista
- PRC-34 `GET /processes/export` — exportação CSV
- PRC-35, PRC-36, PRC-37, PRC-38 — CRUD de visões salvas
- TAG-01, CAT-01, ORG-01, DEP-02, USR-02, ME-02, ME-03 — leituras de apoio

## Entidades
- `Process` — consulta
- `SavedView` — dona desta feature
- `Tag`/`ProcessTag` — filtro e exibição

## Eventos
- Nenhum evento de domínio próprio (consulta); `process.export` é ação de auditoria, não evento.

## Permissões
- `PROCESS_VIEW`, `PROCESS_VIEW_CONFIDENTIAL_BUDGET`, `PROCESS_EXPORT`, `INBOX_VIEW` (escopo de visões da caixa de tarefas)

## Dependências
- US-001 (processo e campos desnormalizados), US-097 (escopos efetivos e autorização).
- Decisões: DEC-024, DEC-026, DEC-030, DEC-031, DEC-057, DEC-104, DEC-105, DEC-106, DEC-133, DEC-134, DEC-183, DEC-184.

## Critérios de aceite da feature
```gherkin
Feature: Consultar processos
  Scenario: Buscar, salvar uma visão e exportar
    Given que "Carla" tem "PROCESS_VIEW" e processos atrasados na sua unidade
    When ela aplicar o atalho "Atrasados" e salvar a visão como "Meus atrasados"
    And exportar o resultado em CSV
    Then a visão "Meus atrasados" deve ficar disponível para reaplicação
    And o arquivo CSV deve conter apenas os processos atrasados visíveis a ela, com valores sigilosos mascarados quando aplicável
```

## Métricas de sucesso
- p95 da lista < 800 ms com 100 mil processos.
- Exportação em streaming sem exceder 10.000 linhas; 0 incidentes de CSV injection.

## Riscos
- Abuso de exportações caras — mitigado por rate limit de 20 req/min e trava de uma exportação por usuário (RS-07).
- Visão compartilhada revelando dado que o aplicador não deveria ver — mitigado por "compartilha critério, nunca dado" (RN-PROC-37).

## Definition of Done da feature
- [ ] US-002 (P0) e US-003 (P2) concluídas e aceitas
- [ ] Jornada E2E (buscar, filtrar, salvar visão, exportar) automatizada
- [ ] Documentação atualizada
