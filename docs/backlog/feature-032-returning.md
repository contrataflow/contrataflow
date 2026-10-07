---
id: FT-032
title: "Devolução"
epic: EP-008
mvp: 1
priority: P0
stories: [US-048]
status: Especificada
---

# FT-032 — Devolução

## Título
Devolução

## Épico
EP-008 — Tramitação

## Descrição
Cobre a devolução direta do processo para uma etapa anterior já percorrida, feita por quem detém a custódia numa etapa de tarefa (`TASK`/`START`), com motivo obrigatório. Não altera documentos automaticamente (POL-11): reabrir um documento já concluído continua sendo uma ação separada do novo custodiante. Quando o processo está em etapa de aprovação (`AWAITING_APPROVAL`), a devolução ocorre pela decisão `RETURN` do aprovador ou pela retirada da solicitação — ambas em FT-034 — e não por esta feature.

## Valor para o usuário e para o órgão
- Permite corrigir ou complementar o trabalho de uma etapa anterior sem reiniciar o processo.
- Preserva o status dos documentos já produzidos, evitando retrabalho de revisão.

## Personas
- Servidor custodiante atual (`currentResponsibleId` ou membro da `currentDepartmentId`) — devolve o processo pelo diálogo SCR-104.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-048 | Devolver processo | P0 | M | US-047 |

## Escopo
- Validação de custódia (POL-01) e status `IN_PROGRESS` (nunca em `AWAITING_APPROVAL`, onde a devolução é efeito de decisão ou retirada — FT-034).
- Seleção de `targetStageId` entre etapas anteriores já percorridas e configuradas como destino da transição `RETURN`.
- Motivo obrigatório (`comment`, 10–5.000 caracteres).
- Recômputo de prazo e de unidade/responsável de destino, com preferência pelo responsável da passagem anterior (`PREVIOUS_ASSIGNEE`).

## Fora de escopo
- Devolução decorrente de decisão de aprovação ou de retirada de solicitação pendente — FT-034.
- Encaminhamento para a etapa seguinte — FT-031.

## Regras de negócio da feature
- RN-TRAM-23 a RN-TRAM-30 — US-048.

## Telas
- SCR-104 — Devolver processo, diálogo (aberto a partir de SCR-006)

## Endpoints
- PRC-20 `POST /processes/{id}/return` — devolver o processo para etapa anterior

## Entidades
- `ProcessStage` — etapa encerrada e etapa de destino reaberta (dono)
- `ProcessAssignment` — atribuição resolvida por `PREVIOUS_ASSIGNEE` ou fila da unidade (dono)
- `ProcessMovement` — registro imutável `RETURN` (dono)

## Eventos
- `ProcessStageChanged` (`cause = RETURN`) — ao concluir a devolução
- `ProcessStatusChanged` — processo passa a `RETURNED`
- `ProcessAssigned` — quando `PREVIOUS_ASSIGNEE` resolve um responsável individual

## Permissões
- `PROCESS_RETURN` — devolver o processo, condicionado à custódia (POL-01)

## Dependências
- Stories: US-047 (encaminhamento — mesma família de ações e padrão transacional), US-049 (assumir, alternativa quando a devolução não resolve responsável individual), US-106 (dias úteis).
- Decisões/ADRs: DEC-013, DEC-014, DEC-015, DEC-023, DEC-024, DEC-031, DEC-055, DEC-104, DEC-105; ADR-005.
- Configurações: destinos e permissão de sobrescrita de prazo configurados na `WorkflowTransition` `RETURN`; `calendar.optionalHolidaysAreNonBusiness`.

## Critérios de aceite da feature
```gherkin
Feature: Devolução
  Scenario: Devolver o processo para quem atuou na etapa anterior
    Given um processo "IN_PROGRESS" cuja etapa atual pode devolver para "Estudos preliminares", já percorrida
    When o custodiante devolver o processo para "Estudos preliminares" com um motivo de ao menos 10 caracteres
    Then o processo deve voltar ao responsável anterior daquela etapa ("PREVIOUS_ASSIGNEE"), com status "RETURNED" e documentos sem alteração de status
```

## Métricas de sucesso
- 100% das devoluções preservam o status dos documentos do processo (nenhuma mudança automática de status por devolução, POL-11).

## Riscos
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Nenhuma instância anterior da etapa ter tido responsável individual, deixando o destino sem responsável | Média | Baixo | Fila da unidade como destino explícito e sem erro (RN-TRAM-28); responsável pode ser assumido (FT-033) |

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
