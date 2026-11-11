---
id: FT-064
title: "Migração entre versões de workflow"
epic: EP-021
mvp: 2
priority: P0
stories: [US-126, US-127, US-128]
status: Especificada
---

# FT-064 — Migração entre versões de workflow

## Título
Migração entre versões de workflow

## Épico
EP-021 — Workflow v2

## Descrição
Entrega a ferramenta que leva processos em andamento de uma versão de workflow para outra, paga o débito DT-02 e sustenta o ADR-016: plano de migração (`WorkflowMigration`) com mapeamento de etapas e filtro de processos, **simulação obrigatória** que classifica cada processo (`AUTOMATIC`, `NEEDS_DECISION`, `BLOCKED`), decisão humana justificada nos casos ambíguos e execução assíncrona, idempotente e auditada por processo.

A migração é sempre pedida por uma pessoa com `WORKFLOW_MIGRATE`; publicar nova versão nunca migra nada. A execução muda `Process.workflowVersionId`, fecha a etapa ativa como `MIGRATED`, abre a de destino preservando responsável, unidade e `dueAt` e registra movimento `MIGRATE`, timeline e auditoria. Não há reversão automática: voltar exige outra migração. A tela é a SCR-118.

## Valor para o usuário e para o órgão
- Os pilotos levam os processos do MVP 1 para a v2 sem redigitar.
- Cada processo migrado conta a própria história na timeline e na auditoria; nenhuma decisão ambígua é tomada pela máquina.
- A mesma ferramenta serve a qualquer nova versão de workflow do tenant, não só à v2 do padrão.

## Personas
- Administrador do órgão (`ADMIN_ORGAO`, `WORKFLOW_MIGRATE`) — planeja, simula, decide e executa.
- Gestor de contratações (`GESTOR_CONTRATACOES`) — informa os critérios dos casos ambíguos.
- Auditor (`AUDITOR`) — confere a trilha da migração.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-126 ⏳ | Planejar a migração de processos: mapeamento de etapas e filtro | P0 | M | US-045 |
| US-127 ⏳ | Simular a migração e decidir os processos que exigem decisão | P0 | L | US-041, US-124, US-126 |
| US-128 ⏳ | Executar a migração de forma assíncrona, idempotente e auditada | P0 | L | US-054, US-059, US-073, US-083, US-127 |

## Escopo
- Plano `WorkflowMigration` (`DRAFT` → `SIMULATED` → `RUNNING` → `COMPLETED` ou `CANCELED`), mapa gerado por `key` + `type` e completável, filtro `MigrationFilter` (até 1.000 ids).
- Simulação com razões (`STAGE_REMOVED`, `STAGE_TYPE_CHANGED`, `APPROVAL_INCOMPATIBLE`, `PARALLEL_ACTIVE`, `BLOCKING_RULE_VIOLATED`, `FINAL_STATUS`, `EDIT_LOCK`, `MIGRATION_IN_PROGRESS`) e `simulationHash`.
- Decisão humana por item (etapa de destino ou exclusão, justificativa ≥ 20).
- Execução na fila `maintenance`, um processo por transação, item `STALE` quando a etapa mudou depois da simulação, relatório final e notificação de término.

## Fora de escopo
- Reversão automática e migração automática ao publicar.
- A continuação de processos `COMPLETED` na v1 para a v2 — FT-065 (US-131), que usa esta ferramenta.
- Migração entre workflows diferentes (origem e destino são do mesmo `Workflow`, exceto a v1 → v2 do padrão pelo mesmo `seedKey`).
- Reabertura genérica de processos (PEND-03).

## Regras de negócio da feature
- RN-WF2-09 — por padrão, etapas com a mesma `key` e o mesmo `type` nas duas versões se correspondem; toda etapa ativa de origem precisa de destino, completado ou corrigido pelo administrador (DEC-195).
- RN-WF2-10 — a execução exige plano `SIMULATED` com o mesmo `simulationHash`; mudar mapa ou filtro volta o plano a `DRAFT` e invalida a simulação (DEC-195, POL-21).
- RN-WF2-11 — `AUTOMATIC`: etapa ativa mapeada para etapa do mesmo tipo, aprovação pendente compatível e regras de saída do destino sem regressão; `NEEDS_DECISION`: etapa removida ou de outro tipo, aprovação pendente incompatível, processo em paralelismo ou regra `BLOCKING` nova já violada; `BLOCKED`: status final, trava de edição ou migração em curso, sempre excluído (DEC-195).
- RN-WF2-12 — todo item `NEEDS_DECISION` precisa de decisão humana (etapa de destino ou exclusão) com justificativa de ao menos 20 caracteres antes de executar (DEC-195, POL-21).
- RN-WF2-13 — a execução é assíncrona, um processo por transação, idempotente por item: item `MIGRATED`/`EXCLUDED` nunca reexecuta; reexecutar retoma só `PENDING`/`FAILED` (ADR-016).
- RN-WF2-14 — o efeito preserva responsável, unidade e `dueAt` (o prazo não recomeça); aprovações pendentes compatíveis são mantidas e as demais canceladas e solicitadas de novo; grava movimento `MIGRATE`, timeline, auditoria `process.workflow_migrate` e o evento (DEC-195).
- RN-WF2-15 — nenhuma migração roda sem pedido humano e a permissão `WORKFLOW_MIGRATE` exige MFA (DEC-195, POL-21).
- RN-WF2-16 — item cujo `expectedProcessStageIds` não confere na execução vira `STALE` sem efeito (corrida com tramitação) (ADR-016).

## Telas
- SCR-118 — Migração de processos entre versões de workflow (`/admin/workflows/[id]/migracoes/[migrationId]`)
- SCR-034 — Workflow, ampliado (atalho "Migrar processos" nas versões) (`/admin/workflows/[id]`)

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `POST /workflows/{id}/migrations` — criar plano (origem, destino, mapa, filtro)
- `PATCH /workflows/{id}/migrations/{migrationId}` — ajustar mapa e filtro (invalida a simulação)
- `POST /workflows/{id}/migrations/{migrationId}/simulate` — simular e classificar os processos
- `PUT /workflows/{id}/migrations/{migrationId}/items/{itemId}/decision` — decidir item `NEEDS_DECISION`
- `POST /workflows/{id}/migrations/{migrationId}/execute` — executar (assíncrono)
- `POST /workflows/{id}/migrations/{migrationId}/cancel` — cancelar plano em `DRAFT` ou `SIMULATED`
- `GET /workflows/{id}/migrations/{migrationId}/items` — itens, classificação, decisão e resultado

## Entidades
- `WorkflowMigration` — plano, mapa, filtro, `simulationHash`, totais.
- `WorkflowMigrationItem` — um por processo: classificação, decisão, resultado, erro.
- `Process` — `workflowVersionId` muda só por esta execução.
- `ProcessStage` — novo status `MIGRATED`.
- `ProcessMovement` — ação `MIGRATE`; `ProcessAssignment` — tipo `MIGRATION`.
- `Approval` — pendentes compatíveis mantidas ou canceladas e re-solicitadas.

## Eventos
- `WorkflowMigrationSimulated` — simulação concluída.
- `WorkflowMigrationStarted` — execução pedida.
- `ProcessWorkflowMigrated` — cada item executado.
- `WorkflowMigrationCompleted` — fim da execução (notifica quem iniciou).
- `WorkflowMigrationCanceled` — cancelamento do plano.

## Permissões
- `WORKFLOW_MIGRATE` — criar, simular, decidir e executar (POL-21; MFA sempre).
- `WORKFLOW_VIEW` — consultar planos e relatório.

## Dependências
- Stories: US-045 (versões publicadas), US-041 e US-124 (motor e ramos), US-054, US-059, US-073, US-083 (movimentos, caixa, fila e auditoria do MVP 1).
- Decisões: DEC-195, DEC-014; ADR-016.
- Habilita FT-065 (US-131) e qualquer nova versão de workflow do tenant.

## Critérios de aceite da feature
```gherkin
Feature: Migração entre versões de workflow
  Scenario: Administrador migra processos com simulação e decisão humana
    Given a versão 1 do workflow com processos em andamento e a versão 2 publicada
    And um plano de migração com o mapa de etapas revisado
    When o administrador simular a migração
    Then cada processo é classificado como "AUTOMATIC", "NEEDS_DECISION" ou "BLOCKED"
    When ele decidir cada "NEEDS_DECISION" com etapa de destino e justificativa
    And executar a migração
    Then os processos migram na fila "maintenance", um por transação
    And cada um ganha movimento "MIGRATE", entrada na timeline e auditoria "process.workflow_migrate"
    And o prazo da etapa não recomeça

  Scenario: Execução sem simulação válida é recusada
    Given um plano alterado depois da simulação
    When o administrador tentar executar
    Then a execução é recusada e o plano volta a "DRAFT"

  Scenario: Processo que mudou de etapa depois da simulação não é migrado às cegas
    Given um item simulado com a etapa "ESTUDOS_PRELIMINARES"
    And o processo foi tramitado para outra etapa antes da execução
    When a execução chegar ao item
    Then o item fica "STALE" sem alterar o processo
```

## Métricas de sucesso
- ≥ 95% dos processos elegíveis do piloto migrados sem redigitação.
- ≤ 2% dos itens `FAILED` ou `STALE`; 0 execuções sem simulação válida.

## Riscos
- Processo migrado para etapa errada — simulação obrigatória, mapa revisado, decisão humana justificada.
- Falha no meio do lote — transação por processo e idempotência por item.
- Corrida com tramitação em curso — trava por processo e `expectedProcessStageIds`.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
