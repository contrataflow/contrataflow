---
id: FT-063
title: "Etapas paralelas"
epic: EP-021
mvp: 2
priority: P0
stories: [US-123, US-124, US-125]
status: Especificada
---

# FT-063 — Etapas paralelas

## Título
Etapas paralelas

## Épico
EP-021 — Workflow v2

## Descrição
Permite que um workflow ramifique em dois ou mais caminhos que correm ao mesmo tempo e se juntem de novo, por meio dos tipos de etapa `PARALLEL_SPLIT` e `PARALLEL_JOIN` (DEC-194). O administrador modela os ramos no editor; o motor valida o grafo na publicação (`WF_PARALLEL_INVALID`) e, em execução, o processo passa a ter uma ou mais `ProcessStage` ativas, uma por ramo, com `ProcessBranch` controlando a junção.

A caixa de tarefas mostra um item por ramo, o painel situacional lista as etapas ativas lado a lado e o prazo do processo é o menor `dueAt` entre elas. `Process.currentStageId` continua por compatibilidade (aponta para a única etapa ativa ou para o split) e a API ganha `activeStages[]` de forma aditiva. O uso é opcional por tenant: a v2 do workflow padrão é sequencial (DEC-196).

## Valor para o usuário e para o órgão
- Jurídico e Controle Interno (ou outras áreas) trabalham ao mesmo tempo, reduzindo o tempo de ciclo da fase preparatória.
- Cada ramo tem responsável, prazo e histórico próprios, sem ambiguidade de "quem está com o processo".
- A devolução para antes da ramificação é explícita e rastreável (ramos e aprovações pendentes cancelados com motivo).

## Personas
- Administrador do órgão (`ADMIN_ORGAO`) — modela e publica workflows com ramos.
- Responsável de ramo (qualquer perfil com `PROCESS_VIEW` e atribuição na etapa) — trabalha a sua etapa sem alterar a do outro ramo.
- Gestor de contratações (`GESTOR_CONTRATACOES`) — acompanha os ramos e os prazos no painel.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-123 | Modelar etapas paralelas no workflow (ramificação e junção) | P0 | L | US-040, US-043, US-045 |
| US-124 | Executar ramos paralelos no processo | P0 | L | US-041, US-047, US-048, US-123 |
| US-125 | Ramos paralelos na caixa de tarefas, no painel situacional e nos prazos | P0 | M | US-004, US-055, US-056, US-124 |

## Escopo
- Tipos `PARALLEL_SPLIT` e `PARALLEL_JOIN` (sem responsável, prazo nem aprovador), `WorkflowStage.branchKey` calculado na publicação e validação do grafo.
- Runtime: `ProcessBranch`, `ProcessStage.branchKey`/`splitProcessStageId`, junção na transação em que o último ramo chega, ações disponíveis por etapa ativa.
- Devolução dentro do ramo (fica no ramo) e para antes do split (cancela ramos e aprovações pendentes); suspensão pausa todos os ramos.
- Status macro com várias etapas ativas, `activeStages[]`, `ProcessAccess` por ramo, caixa de tarefas por ramo, painel "Onde está?" e menor `dueAt`.

## Fora de escopo
- Ramos aninhados e mais de um `PARALLEL_JOIN` por split.
- Transição entre ramos.
- Migração de processos que estão em paralelismo — classificados como `NEEDS_DECISION` (FT-064).
- SLA com pausa e escalonamento por ramo — EP-030.

## Regras de negócio da feature
- RN-WF2-01 — todo `PARALLEL_SPLIT` tem ao menos duas transições `FORWARD` e exatamente um `PARALLEL_JOIN` alcançável por todos os ramos; sem ramos aninhados nem transição entre ramos; violação recusa a publicação com `WF_PARALLEL_INVALID` (DEC-194).
- RN-WF2-02 — `PARALLEL_SPLIT` e `PARALLEL_JOIN` não têm responsável, prazo nem aprovador e são atravessados automaticamente pelo motor (DEC-194).
- RN-WF2-03 — entrar no split cria a `ProcessStage` do split, um `ProcessBranch` `OPEN` por transição de saída e a primeira etapa de cada ramo, na mesma transação (DEC-194).
- RN-WF2-04 — o `PARALLEL_JOIN` fecha quando todos os ramos chegam a ele; só então o processo segue pela transição de saída da junção, e as regras de saída da junção avaliam o processo inteiro (DEC-194).
- RN-WF2-05 — `RETURN` dentro do ramo fica no ramo; `RETURN` para etapa anterior ao split cancela os demais ramos e as aprovações pendentes com o motivo "Processo devolvido para etapa anterior à ramificação", com registro na timeline (DEC-194).
- RN-WF2-06 — status macro com várias etapas ativas: `RETURNED` se alguma foi aberta por devolução; senão `IN_PROGRESS` se alguma for `TASK`; senão `AWAITING_APPROVAL`; suspensão pausa todos os ramos (DEC-194, DEC-013).
- RN-WF2-07 — o prazo do processo para indicadores e alertas é o menor `dueAt` entre as etapas ativas; a custódia (DEC-023) vale por ramo (DEC-194).
- RN-WF2-08 — `Process.currentStageId` aponta para a única etapa ativa ou, no paralelismo, para o split; `activeStages[]` é aditivo e não quebra leitores do MVP 1 (DEC-194, DEC-108).

## Telas
- SCR-034 — Workflow, ampliado (modelagem de ramificação e junção) (`/admin/workflows/[id]`)
- SCR-006 — Detalhe do processo, ampliado (ramos paralelos) (`/processos/[id]`)
- SCR-013 — Caixa de tarefas, ampliada (um item por ramo) (`/tarefas`)

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `PATCH /workflows/{id}/versions/{versionId}/stages/{stageId}` — estende os endpoints de etapa do MVP 1 (WF-07 a WF-18) para os tipos novos
- `POST /workflows/{id}/versions/{versionId}/validate` — validação do grafo, inclusive `WF_PARALLEL_INVALID`
- `GET /processes/{id}` — passa a devolver `activeStages[]` (aditivo)
- `GET /processes/{id}/available-actions` — PRC-08, ações por etapa ativa (`stages[]`) quando há paralelismo
- `POST /processes/{id}/forward` e `POST /processes/{id}/return` — tramitação do MVP 1 agindo sobre uma etapa ativa informada

## Entidades
- `ProcessBranch` — ramo aberto por um split; serializa a junção.
- `ProcessStage` — `branchKey`, `splitProcessStageId`, fonte de verdade das etapas ativas.
- `ProcessAssignment` — uma responsabilidade ativa por etapa ativa.
- `ProcessMovement` — `branchKey` e `MovementMetadata.branch`/`canceledBranches`.
- `ProcessAccess` — `DEPARTMENT/CURRENT` por ramo; `HISTORICAL` na junção.
- `WorkflowStage` — tipos novos e `branchKey`.

## Eventos
- `ProcessBranchesOpened` — entrada no split.
- `ProcessBranchArrived` — última etapa do ramo concluída.
- `ProcessBranchesJoined` — último ramo chega à junção.
- `ProcessBranchesCanceled` — devolução para antes da ramificação.

## Permissões
- `WORKFLOW_MANAGE` — modelar ramos no rascunho; `WORKFLOW_PUBLISH` — publicar.
- `PROCESS_VIEW` — consultar `activeStages[]` e a caixa de tarefas por ramo.
- Tramitar cada ramo segue as permissões e a custódia do MVP 1, avaliadas por etapa ativa.

## Dependências
- Stories: US-040, US-043, US-045 (modelo, editor e publicação); US-041, US-047, US-048 (motor e tramitação); US-004, US-055, US-056 (painel, prazos e caixa de tarefas).
- Decisões: DEC-194, DEC-013, DEC-023, DEC-026, DEC-180; ADR-005.
- Habilita FT-064 (processo em paralelismo na simulação) e o uso configurável de Jurídico e Controle Interno em ramos.

## Critérios de aceite da feature
```gherkin
Feature: Etapas paralelas
  Scenario: Processo ramifica, cada ramo é trabalhado e a junção libera a etapa seguinte
    Given uma versão de workflow publicada com um "PARALLEL_SPLIT" que abre os ramos "JURIDICO" e "CONTROLE_INTERNO" e um "PARALLEL_JOIN"
    And um processo que chega ao split
    When o processo entrar no split
    Then existem duas etapas ativas, uma por ramo, cada uma com responsável e prazo
    And a caixa de tarefas mostra um item por ramo e a API devolve "activeStages[]" com as duas
    When o ramo "JURIDICO" for concluído
    Then o processo continua com uma etapa ativa e o evento "ProcessBranchArrived" é registrado
    When o ramo "CONTROLE_INTERNO" for concluído
    Then o "PARALLEL_JOIN" fecha e o processo segue para a etapa de saída da junção

  Scenario: Devolução para antes da ramificação cancela os outros ramos
    Given um processo com dois ramos ativos e uma aprovação pendente em um deles
    When o responsável de um ramo devolver o processo para uma etapa anterior ao split
    Then os demais ramos e a aprovação pendente ficam "CANCELED" com o motivo registrado
    And a timeline mostra "Ramos paralelos cancelados pela devolução"

  Scenario: Publicação recusa grafo de ramos inválido
    Given uma versão em rascunho com um "PARALLEL_SPLIT" sem "PARALLEL_JOIN"
    When o administrador tentar publicar
    Then a publicação é recusada com "WF_PARALLEL_INVALID"
```

## Métricas de sucesso
- 100% das junções fechadas na mesma transação do último ramo, sem etapa ativa órfã (teste de invariante).
- Redução do tempo de ciclo em tenants que paralelizam etapas: medida no read model de indicadores (EP-028), sem meta fixa até o piloto.

## Riscos
- Complexidade do motor e da experiência — um nível de ramos, validação na publicação e uso opcional por tenant.
- Leitores do MVP 1 que presumem uma etapa ativa — `currentStageId` mantido e `activeStages[]` aditivo; teste de contrato.
- Corrida entre dois ramos que terminam ao mesmo tempo — trava `FOR UPDATE` na `ProcessStage` do split.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
