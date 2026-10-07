---
id: EP-009
title: "Caixa de tarefas"
mvp: 1
priority: P0
features: [FT-036]
status: Especificado
---

# EP-009 — Caixa de tarefas

## Título
Caixa de tarefas e aprovações

## Objetivo
Dar a cada usuário um ponto único e confiável para saber "o que preciso fazer hoje" — processos sob sua custódia, na fila da sua unidade, aprovações pendentes de sua decisão, devolvidos, atrasados e acompanhados — e permitir agir em volume quando necessário, sem depender da lista geral de processos nem de controles paralelos (planilhas, e-mails).

## Contexto e problema
- Hoje, saber o que exige ação imediata depende de filtrar manualmente a lista geral de processos a cada acesso; não há visão consolidada de pendências, prazos vencidos ou aprovações aguardando decisão.
- DEC-026 decidiu que o MVP 1 não terá uma entidade `Task` própria: a caixa é uma consulta sobre o estado já existente de `ProcessStage`, `ProcessAssignment` e `Approval`, evitando duplicar estado e mantendo uma única fonte de verdade sobre "onde está o processo e quem decide".
- A segregação de funções e a cobertura de aprovador (DEC-022, art. 7º §1º da Lei 14.133/2021) já definem quem pode decidir cada aprovação; este épico expõe essa competência em uma lista utilizável no dia a dia, sem recriar a regra.
- Volume operacional (ex.: início de exercício, mutirões de triagem) exige, além da visão individual, uma forma de agir sobre vários processos de uma vez.

## Escopo
- Consulta unificada da caixa de tarefas com seis visões (comigo, fila da unidade, aprovações pendentes, devolvidos, atrasados, acompanhando) e contadores (US-056).
- Lista dedicada de aprovações com filtros, restrita à cobertura de aprovador do usuário (US-057).
- Ações em lote (assumir/atribuir) sobre a fila da unidade, com resultado por item (US-058).

## Fora de escopo
- Entidade `Task` própria ou read model dedicado (débito técnico monitorado por DEC-026; considerar apenas se a performance da consulta exigir).
- Decisão de aprovação em si (aprovar/devolver/indeferir) — US-052.
- Assumir/atribuir um único processo — US-049/US-050 (reaproveitados por este épico).
- Visões/filtros personalizados salvos pelo usuário (`SavedViewScope.INBOX` existe no enum, mas sua UI não faz parte deste épico).

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Servidor da área requisitante | `REQUISITANTE` | Ver e assumir o que está sob sua responsabilidade ou na fila da unidade |
| Membro lotado na unidade | Perfis com `PROCESS_CLAIM` | Ver a fila da unidade e assumir processos |
| Titular/substituto de unidade | (capacidade implícita, qualquer perfil) | Ver e distribuir a fila da unidade, inclusive em lote |
| Aprovador (direto, por perfil ou por titularidade) | `GESTOR_CONTRATACOES`, `AUTORIDADE`, entre outros | Priorizar e localizar aprovações pendentes de sua decisão |
| Gestor de contratações | `GESTOR_CONTRATACOES` | Redistribuir volume de processos entre a equipe |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-036 | Caixa de tarefas e aprovações | US-056, US-057, US-058 | P0 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-056 | Caixa de tarefas unificada | P0 | L | 8 |
| US-057 | Lista de aprovações | P0 | M | 5 |
| US-058 | Ações em lote na caixa de tarefas | P2 | M | 5 |
| **Total** | | | | **18** |

## Módulos e entidades
- Módulos: `process`, `approval`, `access`, `platform`.
- Entidades: `ProcessStage` (consumida), `ProcessAssignment` (consumida), `Approval` (consumida), `ProcessParticipant` (consumida), `Process` (consumida). Nenhuma entidade é de propriedade deste épico (DEC-026).

## Telas
- SCR-013 — Caixa de tarefas (`/tarefas`)
- SCR-014 — Aprovações (`/aprovacoes`)
- SCR-115 — Atribuir responsável / assumir (diálogo, reaproveitado de US-049/US-050, estendido para lote em US-058)

## Integrações
- Interna: módulo `approval` (cobertura de aprovador, POL-03/DEC-022); módulo `organization` (titular/substituto de unidade); módulo `platform` (idempotência do lote).
- Nenhuma integração externa própria.

## Eventos principais
- `ProcessAssigned` — gerado item a item pelas ações rápidas e em lote (reaproveitado de US-049/US-050); este épico não possui evento próprio (US-056/US-057 são consultas).

## Permissões envolvidas
- `INBOX_VIEW` — acessar a caixa de tarefas.
- `APPROVAL_VIEW` — acessar a lista de aprovações (complementar à designação direta/por perfil/titularidade).
- `PROCESS_CLAIM` — assumir (individual ou em lote).
- `PROCESS_ASSIGN` — atribuir (individual ou em lote).

## Regras configuráveis
- Nenhuma chave de configuração própria. Candidata futura (não implementada neste épico): `tasks.bulkActionLimit` (padrão 50), caso o teto fixo de US-058 precise variar por tenant.

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Tempo de resposta da consulta unificada (p95) | < 500 ms com até 10.000 processos ativos | `inbox_query_duration_ms` (US-056) |
| Processos assumidos via ação rápida/lote vs. total assumido | ≥ 60% em 3 meses | Contagem de `ProcessAssigned` por origem |
| Aprovações decididas a partir da lista dedicada (SCR-014) | ≥ 50% das decisões em 3 meses | Auditoria `approval.decide` com origem registrada |

## Dependências
- **Depende de:** stories de workflow/tramitação (US-042, US-047, US-048, US-049, US-050 — etapas, assumir e atribuir individuais); stories de aprovação (US-051, US-052 — solicitação e decisão); stories de acesso (US-097 — permissões e escopos); stories de estrutura organizacional (US-102 — titular/substituto de unidade).
- **Habilita:** futuras melhorias de produtividade (visões salvas, notificações proativas de atraso) que podem reaproveitar a mesma consulta.

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Consulta UNION não sustenta p95 < 500 ms em tenants grandes | Média | Alto | Monitorar `inbox_query_duration_ms`; DEC-026 prevê read model dedicado se necessário |
| Ação em lote distribuir processos à pessoa errada em volume | Baixa | Alto | Motivo obrigatório, resultado por item visível, auditoria por item (não agregada) |

## Pontos em aberto
- Avaliar no MVP 2 se o limite de 50 itens por lote (US-058) deve tornar-se configurável por tenant.

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados (`inbox_query_duration_ms`, origem de `ProcessAssigned`, origem de `approval.decide`)
- [ ] Testes E2E das jornadas do épico passando (consultar caixa, consultar aprovações, agir em lote)
- [ ] Documentação e treinamento (guia do usuário) atualizados
