---
id: FT-036
title: "Caixa de tarefas e aprovações"
epic: EP-009
mvp: 1
priority: P0
stories: [US-056, US-057, US-058]
status: Especificada
---

# FT-036 — Caixa de tarefas e aprovações

## Título
Caixa de tarefas e aprovações

## Épico
EP-009 — Caixa de tarefas e aprovações

## Descrição
Esta feature entrega a caixa de tarefas unificada (visão consolidada de tudo que exige ação do usuário), a lista dedicada de aprovações (para quem decide em volume) e as ações em lote sobre a fila da unidade. As três stories compartilham a mesma base de dados — `ProcessStage`, `ProcessAssignment` e `Approval` — sem introduzir uma entidade `Task` própria (DEC-026).

## Valor para o usuário e para o órgão
- Reduz o tempo para identificar o que precisa de ação imediata, de "abrir a lista geral e filtrar" para "abrir a caixa de tarefas".
- Dá visibilidade e rastreabilidade a aprovações pendentes, apoiando o cumprimento de prazos e a segregação de funções exigida pela Lei 14.133/2021.
- Permite absorver picos de volume (mutirões de triagem) sem múltiplas ações manuais repetidas.

## Personas
- Servidor da área requisitante (`REQUISITANTE`) — vê o que está com ele e o que está na fila da unidade.
- Membro lotado com `PROCESS_CLAIM` — vê a fila da unidade e assume processos.
- Titular/substituto de unidade — distribui a fila, inclusive em lote.
- Aprovador (direto, por perfil ou por titularidade) — localiza e decide suas aprovações pendentes.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-056 | Caixa de tarefas unificada | P0 | L | US-049, US-051 |
| US-057 | Lista de aprovações | P0 | M | US-051 |
| US-058 | Ações em lote na caixa de tarefas | P2 | M | US-056 |

## Escopo
- Seis visões da caixa de tarefas com contadores e ação rápida de assumir.
- Lista de aprovações com filtros por status, tipo de assunto, unidade solicitante, período e busca.
- Ações em lote de assumir/atribuir (até 50 processos) com resultado por item.

## Fora de escopo
- Entidade `Task` própria ou read model dedicado — tratado como débito técnico monitorado (DEC-026), fora desta feature.
- Decisão de aprovação (US-052) e ações individuais de assumir/atribuir (US-049/US-050) — reaproveitadas, não reimplementadas.
- Visões/filtros salvos pelo usuário.

## Regras de negócio da feature
- A caixa e a lista de aprovações nunca mostram itens fora da visibilidade de processo (DEC-024) ou da cobertura de aprovador (DEC-022/POL-03) do usuário — RN-INBOX-01, RN-INBOX-07, RN-INBOX-14.
- Nenhuma das três stories introduz nova regra de autorização: todas reaproveitam POL-03 (aprovação), POL-04 (assumir) e POL-05 (atribuir) já existentes.
- Ações em lote processam cada processo em sua própria transação; sucesso parcial é o comportamento esperado (RN-INBOX-22).

## Telas
- SCR-013 — Caixa de tarefas (`/tarefas`)
- SCR-014 — Aprovações (`/aprovacoes`)
- SCR-115 — Atribuir responsável / assumir (diálogo, individual e em lote)

## Endpoints
- TSK-01 `GET /tasks` — lista unificada por visão
- TSK-02 `GET /tasks/counters` — contadores por visão
- TSK-03 `POST /tasks/bulk-claim` — assumir em lote
- TSK-04 `POST /tasks/bulk-assign` — atribuir em lote
- APV-01 `GET /approvals` — lista de aprovações com filtros
- PRC-21 `POST /processes/{id}/claim` — assumir individual (reaproveitado de US-049)
- PRC-22 `POST /processes/{id}/assign` — atribuir individual (reaproveitado de US-050)

## Entidades
- `ProcessStage` — etapa ativa, prazo e atraso.
- `ProcessAssignment` — responsabilidade atual (minha, fila da unidade, devolvidos).
- `Approval` — aprovações pendentes e decididas.
- `ProcessParticipant` — base da visão "Acompanhando" (DEC-026).

## Eventos
- `ProcessAssigned` — gerado item a item pelas ações de assumir/atribuir (individuais ou em lote); nenhum evento é gerado pelas consultas (US-056, US-057).

## Permissões
- `INBOX_VIEW` — acesso à caixa de tarefas.
- `APPROVAL_VIEW` — acesso à lista de aprovações.
- `PROCESS_CLAIM` — assumir (individual/lote).
- `PROCESS_ASSIGN` — atribuir (individual/lote).

## Dependências
- Features/stories: workflow e tramitação (US-042, US-047–US-050), aprovação (US-051, US-052), acesso (US-097), estrutura organizacional (US-102).
- Decisões: DEC-022, DEC-024, DEC-026, DEC-031, DEC-105.

## Critérios de aceite da feature
```gherkin
Feature: Caixa de tarefas e aprovações
  Scenario: Jornada completa — da caixa de tarefas à decisão de aprovação
    Given que "Ana" tem processos sob sua responsabilidade, aprovações pendentes e itens na fila da sua unidade
    When "Ana" abrir a caixa de tarefas
    Then ela deve ver cada processo na visão correta, com contadores corretos
    When "Ana" abrir "Aprovações" e filtrar por aprovações pendentes
    Then ela deve ver apenas as aprovações de sua cobertura
    When "Ana" selecionar 3 processos da fila da sua unidade e assumir em lote
    Then os 3 processos devem passar a ser responsabilidade de "Ana"
    And os contadores da caixa de tarefas devem refletir a mudança
```

## Métricas de sucesso
- p95 da consulta unificada < 500 ms com até 10.000 processos ativos.
- ≥ 60% das atribuições de responsabilidade feitas via ação rápida/lote em 3 meses.

## Riscos
- Consulta UNION não escalar em tenants muito grandes — mitigado por índices parciais existentes e, se necessário, read model dedicado (DEC-026).

## Definition of Done da feature
- [ ] Todas as stories P0 (US-056, US-057) concluídas e aceitas; US-058 (P2) concluída conforme priorização do MVP
- [ ] Jornada E2E da feature automatizada (caixa → aprovações → lote)
- [ ] Documentação atualizada
