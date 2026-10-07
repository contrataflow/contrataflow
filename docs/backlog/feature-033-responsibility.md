---
id: FT-033
title: "Responsabilidade"
epic: EP-008
mvp: 1
priority: P0
stories: [US-049, US-050]
status: Especificada
---

# FT-033 — Responsabilidade

## Título
Responsabilidade

## Épico
EP-008 — Tramitação

## Descrição
Cobre as duas formas de assumir responsabilidade individual por um processo dentro da unidade que o detém: assumir (`claim`, autoatribuição sem motivo, US-049) quando o processo está na fila da unidade, e atribuir/reatribuir (US-050), ação de um gestor, titular ou substituto sobre terceiros, com motivo obrigatório sempre que já exista um responsável definido. Em ambos os casos a unidade atual permanece inalterada — apenas o responsável individual muda.

## Valor para o usuário e para o órgão
- Deixa sempre claro, para a equipe, quem está tratando cada processo dentro da unidade.
- Permite redistribuir trabalho e reagir a ausências sem depender de o próprio servidor agir primeiro.

## Personas
- Servidor lotado na unidade atual — assume (`claim`) um processo sem responsável (US-049).
- Gestor de contratações, titular ou substituto da unidade (`GESTOR_CONTRATACOES`) — atribui ou reatribui o responsável (US-050).

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-049 | Assumir processo recebido pela unidade | P0 | S | US-047 |
| US-050 | Atribuir e reatribuir responsável | P0 | M | US-049 |

## Escopo
- Assumir: `PROCESS_CLAIM` + lotação ativa na unidade atual + processo sem responsável individual (POL-04).
- Atribuir/reatribuir: `PROCESS_ASSIGN` com escopo que cubra o processo, ou ser titular/substituto da unidade atual (POL-05); elegibilidade do novo responsável (vínculo ativo, lotação, `PROCESS_VIEW`); motivo obrigatório sempre que já exista responsável definido; `assigneeId = null` para devolver à fila da unidade.

## Fora de escopo
- Resolução automática de responsável na entrada de etapa (`assignmentPolicy` do `WorkflowStage`) — FT-031/FT-032.
- Decisão de aprovação — FT-034.

## Regras de negócio da feature
- RN-TRAM-31 a RN-TRAM-35 — US-049.
- RN-TRAM-36 a RN-TRAM-42 — US-050.

## Telas
- SCR-115 — Atribuir responsável / assumir, diálogo (aberto a partir de SCR-006 e SCR-013)

## Endpoints
- PRC-21 `POST /processes/{id}/claim` — assumir o processo
- PRC-22 `POST /processes/{id}/assign` — atribuir ou reatribuir o responsável

## Entidades
- `ProcessAssignment` — tipos `CLAIM` (US-049) e `MANUAL` (US-050) (dono)

## Eventos
- `ProcessAssigned` — emitido na atribuição manual (US-050); não emitido no `claim` (US-049, RN-TRAM-35)

## Permissões
- `PROCESS_CLAIM` — assumir processo sem responsável (POL-04)
- `PROCESS_ASSIGN` — atribuir/reatribuir responsável dentro da unidade atual (POL-05)

## Dependências
- Stories: US-047 (origem da fila sem responsável), US-048 (devolução pode deixar a etapa sem responsável), US-102 (titular/substituto da unidade).
- Decisões/ADRs: DEC-023, DEC-024, DEC-055, DEC-104.

## Critérios de aceite da feature
```gherkin
Feature: Responsabilidade
  Scenario: Assumir um processo na fila da unidade
    Given um processo "IN_PROGRESS" sem responsável individual, na unidade do usuário
    When o usuário assumir o processo
    Then o processo passa a ter o usuário como responsável, sem exigir motivo nem aprovação
```

## Métricas de sucesso
- Etapas sem responsável individual são assumidas ou atribuídas antes de qualquer alerta de atraso, em pelo menos 90% dos casos.

## Riscos
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Gestor reatribuir um processo já com responsável sem justificar o motivo | Baixa | Médio | `reason` obrigatório (10–2.000 caracteres) sempre que já exista `currentResponsibleId` (RN-TRAM-39) |

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
