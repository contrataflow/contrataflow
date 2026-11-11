---
id: US-131
title: "Levar à fase preparatória processos concluídos na v1"
epic: EP-021
feature: FT-065
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-128, US-130]
modules: [process, workflow, notification, timeline, access, audit, platform]
screens: [SCR-118, SCR-034]
endpoints: [PRC-50, PRC-51, PRC-52]
permissions: [WORKFLOW_MIGRATE, PROCESS_VIEW]
events: [ProcessWorkflowMigrated, WorkflowMigrationCompleted]
---

# US-131 — Levar à fase preparatória processos concluídos na v1

## Título
Continuar na fase preparatória completa os processos concluídos na v1 do workflow padrão

## Descrição
**Como** administrador do órgão, **quero** levar os processos que o MVP 1 deu por concluídos ("Planejamento da contratação concluído") para a etapa `DOTACAO` da v2 do workflow padrão, por decisão minha e com justificativa, **para** continuar a fase preparatória (dotação, edital, parecer jurídico, controle interno e autorização) sem refazer o planejamento já aprovado.

É o **único caminho** em que um processo `COMPLETED` volta a `IN_PROGRESS` (DEC-195; a reabertura genérica, PEND-03, continua fora do MVP 2). A story usa a mecânica de migração das US-126 a US-128 (plano, simulação obrigatória, decisão humana, execução assíncrona, idempotente e auditada) e acrescenta o que é próprio da continuação: elegibilidade restrita ao padrão da fase preparatória, classificação sempre `NEEDS_DECISION` com o motivo `COMPLETED_V1_CONTINUATION`, destino único `DOTACAO`, unidade de destino quando a etapa não tem unidade fixa, decisão em lote por seleção explícita e os efeitos sobre status, etapa, prazo, histórico e acesso.

## Contexto
- A v2 do workflow padrão (US-130) vai até a autorização da licitação e rotula `COMPLETED` como "Fase preparatória concluída" (DEC-196). Os processos que os pilotos concluíram na v1 terminaram em `CONCLUSAO` ("Planejamento da contratação concluído") e, sem este caminho, teriam de ser refeitos.
- DEC-195 e ADR-016 (item 5): processo `COMPLETED` na v1 do padrão pode ser migrado para a v2 entrando em `DOTACAO`, **sempre `NEEDS_DECISION`**, com decisão humana por processo. O status volta a `IN_PROGRESS` só por esse caminho. Nenhuma migração roda sozinha e voltar exige outra migração.
- A feature FT-065 (RN-WF2-22) fixa o tratamento: entrada em `DOTACAO`, decisão humana, rótulo "concluído" vindo do nome da etapa `END` da versão. O processo `COMPLETED` do MVP 1 é terminal (RN-PROC-117: nenhuma edição, tramitação ou documento); a migração é a exceção controlada (gatilho de banco aceita a mudança de `workflowVersionId` e de status só com `app.migration_item_id`).
- `WorkflowMigrationItem` (entities MVP 2 §4.7) já prevê o motivo `COMPLETED_V1_CONTINUATION`, o filtro `statuses` com `COMPLETED` "só na continuação v1 → v2 do padrão" e a regra de integridade que permite origem e destino de `Workflow`s com o mesmo `seedKey`.
- A permissão é `WORKFLOW_MIGRATE` (risco `H`, MFA sempre — POL-21); executar exige plano `SIMULATED`, mesmo `simulationHash` e todos os `NEEDS_DECISION` decididos com justificativa.

## Objetivo
Permitir que o administrador leve ao menos 95% dos processos concluídos na v1 que ele escolher para `DOTACAO`, sem redigitação e sem alterar documentos, aprovações ou histórico, com 100% dos itens executados decididos por uma pessoa, justificados e auditados (KPI de EP-021).

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, `WORKFLOW_MIGRATE`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`, acompanha os processos retomados e, quando tiver `WORKFLOW_MIGRATE` por perfil personalizado, decide em conjunto); responsável da etapa `DOTACAO` (recebe os processos); Controle Interno e Auditor (conferem a trilha); Sistema (execução na fila `maintenance`).

## Pré-condições
- A v2 do workflow padrão está publicada (publicação automática ou adoção, US-130) e contém a etapa `DOTACAO` (`TASK`).
- Existem processos `COMPLETED` cuja versão de workflow pertence a um `Workflow` com `seedKey = PREPARATORY_PHASE` anterior à versão de destino.
- Usuário com `WORKFLOW_MIGRATE` e sessão com MFA; processos fora da visibilidade de quem executa não entram no filtro (o administrador vê todos pelo escopo `TENANT`).
- Nenhuma migração `RUNNING` para a mesma versão de origem (restrição de unicidade).

## Fluxo principal
1. Depois de a v2 estar publicada, a SCR-034 do workflow mostra a faixa "{N} processos concluídos na versão anterior podem continuar na fase preparatória completa" (dado de `GET /workflows/{id}/completed-continuation`, PRC-50) com a ação "Planejar continuação".
2. O administrador escolhe a versão de origem (quando há mais de uma com processos elegíveis), informa um nome (sugestão: "Continuação dos concluídos — versão {N}") e filtros opcionais (secretaria solicitante, período de abertura, lista de processos) e confirma. O front envia `POST /workflows/{id}/completed-continuation/migrations` (PRC-51, `Idempotency-Key`).
3. A API cria o plano `WorkflowMigration` em `DRAFT` com origem, destino (versão publicada corrente), `processFilter.statuses = ['COMPLETED']`, `stageMapping` gerado por `key` + `type` (informativo: o destino da continuação é sempre `DOTACAO`) e navega para a SCR-118 em modo "Continuação dos concluídos".
4. O administrador aciona "Simular" (endpoint de simulação da US-127): cada processo do filtro é classificado `NEEDS_DECISION` com motivo `COMPLETED_V1_CONTINUATION` e `proposedTargetStageKey = DOTACAO`; os que não podem ir (migração em curso, trava de edição, status final diferente de `COMPLETED`) saem `BLOCKED`.
5. Na SCR-118 o administrador revisa a lista (código, título, secretaria, concluído em, valor mascarado quando sigiloso) e **decide**: individualmente pelo endpoint de decisão de item da US-127, ou **em lote** por seleção explícita de itens (`POST /workflow-migrations/{migrationId}/items/bulk-decision`, PRC-52): `MIGRATE` para `DOTACAO` com a unidade de destino (quando a etapa for `CHOSEN_ON_FORWARD`) e a justificativa (≥ 20 caracteres), ou `EXCLUDE`.
6. Com todos os itens `NEEDS_DECISION` decididos e a simulação válida, o administrador aciona "Executar" (endpoint de execução da US-128, com MFA). O plano vai a `RUNNING` e a fila `maintenance` processa **um processo por transação**.
7. Para cada item `MIGRATE`, a transação (mecânica da US-128): confere `expectedProcessStageIds`; grava `Process.workflowVersionId` na versão de destino; muda o status de `COMPLETED` para `IN_PROGRESS` e limpa `completedAt`/`completedById`; mantém a `ProcessStage` `END` encerrada como histórico e abre a `ProcessStage` de `DOTACAO` (`ACTIVE`, `enteredAt = agora`, unidade e atribuição conforme a etapa de destino); atualiza `currentStageId`, `activeStagesCount`, `currentDepartmentId` e `currentStageDueAt`; concede `ProcessAccess` `CURRENT` à unidade de destino; grava `ProcessMovement` (`action = MIGRATE`, `metadata.migration` e `continuation`), a entrada de timeline `WORKFLOW_MIGRATED`, a auditoria `process.workflow_migrate` e o evento `ProcessWorkflowMigrated`.
8. Ao fim, o plano vai a `COMPLETED` (nenhum item `PENDING`); `WorkflowMigrationCompleted` notifica quem iniciou; os itens `FAILED`/`STALE` ficam no relatório e podem ir para um novo plano. Os responsáveis das etapas de destino e o criador de cada processo recebem `PROCESS_MIGRATED`.
9. O responsável da unidade de `DOTACAO` encontra o processo na caixa de tarefas e segue a fase preparatória (US-147 em diante).

## Fluxos alternativos
- **FA-01 — Versão de origem única:** havendo uma só versão com elegíveis, PRC-51 a assume e o passo de escolha some.
- **FA-02 — Processo excluído:** `EXCLUDE` (com justificativa ≥ 20) mantém o processo `COMPLETED` na v1; o item fica `EXCLUDED` e não será reexecutado.
- **FA-03 — Mudança no mapa ou no filtro depois da simulação:** o plano volta a `DRAFT` e a simulação é invalidada (US-126/US-127); decisões já tomadas são preservadas para os itens que continuam no filtro.
- **FA-04 — Processo mudou depois da simulação (corrida):** o item cujo `expectedProcessStageIds` ou status não confere vira `STALE` sem efeito (ex.: já continuado por outro plano).
- **FA-05 — Falha em um item:** o item vira `FAILED` com `errorCode`; o plano segue; reexecutar retoma só `PENDING`/`FAILED`.
- **FA-06 — Sem processos elegíveis:** PRC-50 devolve `eligibleCount = 0` e a faixa não aparece; PRC-51 responde `MIGRATION_NO_ELIGIBLE_PROCESSES`.
- **FA-07 — Cancelar o plano:** `DRAFT`/`SIMULATED` → `CANCELED` pelo endpoint da US-126, sem efeito nos processos.
- **FA-08 — Desfazer:** não há reversão automática; um processo continuado por engano segue por tramitação normal ou por outra migração (ADR-016).

## Regras de negócio
- **RN-WF2-101** — **Elegibilidade:** só `Process.status = COMPLETED` cuja `workflowVersionId` aponta para uma versão de `Workflow` com `seedKey = PREPARATORY_PHASE` anterior ao destino; o destino é uma versão `PUBLISHED` do mesmo `Workflow` (ou de outro com o mesmo `seedKey`) que contém a etapa `DOTACAO` do tipo `TASK`. O filtro `statuses` com `COMPLETED` só é aceito nessa combinação; em qualquer outra migração continua recusado. Contratação direta (`DIRECT_CONTRACTING`) e workflows sem semente ficam fora desta story.
- **RN-WF2-102** — Todo item da continuação é classificado `NEEDS_DECISION` (motivo `COMPLETED_V1_CONTINUATION`), nunca `AUTOMATIC`, com `proposedTargetStageKey = DOTACAO`. As únicas decisões válidas são `MIGRATE` com `targetStageKey = DOTACAO` ou `EXCLUDE`; ambas exigem justificativa (≥ 20 e ≤ 2.000 caracteres). A decisão é humana por processo: o lote (PRC-52) é uma **seleção explícita de 1 a 100 itens**, e a mesma justificativa é gravada em cada item (`decisionJustification`), com `decidedById`/`decidedAt` e `workflow_migration.decide_item` por item.
- **RN-WF2-103** — Unidade de destino: se `DOTACAO` tem `departmentResolution = FIXED`, vale a unidade fixa; `REQUESTING_DEPARTMENT`, o setor solicitante do processo; `CHOSEN_ON_FORWARD` (padrão semeado até o administrador configurar), a decisão **exige** `targetDepartmentId` (unidade ativa do tenant); sem ele, o item não conta como decidido (`MIGRATION_DECISIONS_PENDING`). Sem responsável individual: o processo entra na fila da unidade segundo o `assignmentPolicy` de `DOTACAO`.
- **RN-WF2-104** — `BLOCKED` na continuação (e `decision = EXCLUDE` obrigatório): migração em curso para o mesmo processo (`MIGRATION_IN_PROGRESS`), processo com trava de edição (`EDIT_LOCK`) e status diferente de `COMPLETED` (`FINAL_STATUS`, ex.: `CANCELED`). Processo `COMPLETED` que já tenha sido continuado deixa de ser elegível.
- **RN-WF2-105** — Efeitos da execução por item (uma transação, com `app.migration_item_id`): versão do processo → destino; `COMPLETED` → `IN_PROGRESS`; `completedAt`/`completedById` limpos (o instante anterior fica em `ProcessMovement.metadata.continuation.previousCompletedAt`); etapa `END` mantida como histórico; nova `ProcessStage` `DOTACAO` `ACTIVE` com `enteredAt = agora`; `dueAt` calculado pelo SLA de `DOTACAO` a partir de agora (nulo se a etapa não tem prazo; não há `dueAt` anterior a preservar); `activeStagesCount = 1`; `ProcessAccess` `CURRENT` para a unidade de destino e os `HISTORICAL` anteriores preservados; movimento `MIGRATE` com `metadata.migration = { migrationId, itemId, fromVersion, toVersion, mapping }` e `continuation = true`; `approvalsCanceled` e `approvalsKept` vazios.
- **RN-WF2-106** — Dados do planejamento intactos: documentos, versões, aprovações decididas, pesquisa de preços, itens, anexos e comentários do processo não são alterados; nenhuma `Approval` é criada ou cancelada; documentos `APPROVED`/`FINALIZED` continuam como estão. O processo volta a aceitar edição e tramitação pelas políticas normais (POL-01/POL-02) na nova etapa.
- **RN-WF2-107** — Histórico e rótulos: as entradas `PROCESS_COMPLETED` anteriores permanecem com `params.endStageName` da v1 ("Planejamento da contratação concluído"); a continuação gera `WORKFLOW_MIGRATED` ("Processo migrado da versão {de} para a versão {para} do workflow") com `params.continuation = true`; a nova conclusão pela v2 mostrará "Fase preparatória concluída". Indicadores de ciclo tratam a continuação como nova passagem, sem reescrever o histórico (consumidor `analytics`).
- **RN-WF2-108** — Autorização e segurança: `WORKFLOW_MIGRATE` com MFA sempre (POL-21, risco `H`); processos fora da visibilidade de quem executa não entram no filtro; valores de orçamento sigiloso na lista seguem POL-09 (mascarados); a execução exige plano `SIMULATED` com o mesmo `simulationHash` e todos os `NEEDS_DECISION` decididos (`MIGRATION_NOT_SIMULATED`, `MIGRATION_SIMULATION_STALE`, `MIGRATION_DECISIONS_PENDING`). Um plano `RUNNING` por versão de origem (unicidade).
- **RN-WF2-109** — Idempotência e relatório: item `MIGRATED`/`EXCLUDED` nunca é reexecutado; reexecutar o plano retoma só `PENDING`/`FAILED`; criar a continuação é idempotente por `Idempotency-Key` e só pode haver **um** plano aberto (`DRAFT`/`SIMULATED`) de continuação por par origem × destino (`MIGRATION_CONTINUATION_ALREADY_OPEN`); o relatório do plano (US-128) lista processos continuados, excluídos, `FAILED` e `STALE` com a justificativa e é exportável (`workflow_migration.export`).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Versão de origem | `sourceWorkflowVersionId` (PRC-51) | seleção | Condicional | obrigatório se houver mais de uma com elegíveis | a única elegível |
| Nome do plano | `name` | texto | Não | 3–150 | "Continuação dos concluídos — versão {N}" |
| Secretarias | `filter.requestingSecretariatIds` | lista | Não | unidades do tenant | todas |
| Aberto de / até | `filter.openedFrom` / `openedTo` | datas | Não | `openedFrom` ≤ `openedTo` | — |
| Processos | `filter.processIds` | lista de ids | Não | máx. 1.000; de outro tenant não casam | — |
| *(sistema)* Situação | `processFilter.statuses` | `['COMPLETED']` | — | fixo na continuação (RN-WF2-101) | PRC-51 |
| Itens selecionados | `itemIds` (PRC-52) | lista de ids | Sim | 1 a 100, sem repetição, do plano | seleção na tabela |
| Decisão | `decision` | `MIGRATE` \| `EXCLUDE` | Sim | RN-WF2-102 | — |
| Etapa de destino | `targetStageKey` | texto | Condicional | `DOTACAO` se `MIGRATE` | `DOTACAO` |
| Unidade de destino | `targetDepartmentId` | seleção | Condicional | RN-WF2-103 | — |
| Justificativa | `justification` | texto longo | Sim | ≥ 20 e ≤ 2.000 | — |
| *(sistema)* Hash da simulação | `expectedSimulationHash` | texto | Sim | igual ao do plano | lido da SCR-118 |
| Chave de idempotência | `Idempotency-Key` | UUID (cabeçalho) | Sim (PRC-51, PRC-52) | DEC-105 | gerada pelo front |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Nenhum processo elegível | API | "Não há processos concluídos na versão anterior para continuar." | `MIGRATION_NO_ELIGIBLE_PROCESSES` |
| V-02 | Versão de destino sem a etapa `DOTACAO` ou não publicada | API | "A versão de destino não tem a etapa Dotação orçamentária." | `MIGRATION_CONTINUATION_TARGET_INVALID` |
| V-03 | Já existe plano aberto de continuação para a mesma origem e destino | API | "Já existe um plano de continuação em aberto. Continue o plano existente." | `MIGRATION_CONTINUATION_ALREADY_OPEN` |
| V-04 | Decisão `MIGRATE` com destino diferente de `DOTACAO` | Front + API | "Os processos concluídos só podem continuar pela etapa Dotação orçamentária." | `MIGRATION_CONTINUATION_TARGET_INVALID` |
| V-05 | Justificativa ausente ou menor que 20 caracteres | Front + API | "Informe a justificativa (mín. 20 caracteres)." | `VALIDATION_ERROR` (`TOO_SHORT`) |
| V-06 | `targetDepartmentId` ausente com unidade a escolher | Front + API | "Escolha a unidade que receberá os processos." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-07 | `itemIds` vazio, com mais de 100 ou repetidos | Front + API | "Selecione de 1 a 100 processos, sem repetição." | `VALIDATION_ERROR` (`TOO_SHORT`/`TOO_LONG`/`DUPLICATE_IN_LIST`) |
| V-08 | Item `BLOCKED` com decisão `MIGRATE` | API (por item) | "Este processo não pode continuar: {motivo}." | `MIGRATION_ITEM_BLOCKED` |
| V-09 | Plano não simulado, hash divergente ou decisões pendentes ao executar | API | "Simule o plano e decida todos os processos antes de executar." | `MIGRATION_NOT_SIMULATED` / `MIGRATION_SIMULATION_STALE` / `MIGRATION_DECISIONS_PENDING` |
| V-10 | Plano fora de `DRAFT`/`SIMULATED` ao decidir | API | "Este plano não aceita mais decisões." | `MIGRATION_NOT_EDITABLE` |

## Permissões
- **Permissão:** `WORKFLOW_MIGRATE` (PRC-50, PRC-51, PRC-52 e as ações reutilizadas das US-126 a US-128); `PROCESS_VIEW` e a visibilidade (DEC-024) para listar os processos do filtro.
- **Políticas:** POL-21 (migração de versão: plano `SIMULATED` com mesmo `simulationHash`, decisões com justificativa, MFA sempre, processos fora da visibilidade não entram); POL-09 (valores sigilosos mascarados na lista).
- **MFA:** exigido sempre para `WORKFLOW_MIGRATE` (risco `H`); sem MFA → 403 `MFA_REQUIRED`.
- **Sem permissão:** a faixa "Planejar continuação" e a SCR-118 não aparecem sem `WORKFLOW_MIGRATE`; a API responde 403 `PERMISSION_DENIED` e registra `access.denied` (`reasonCode = WORKFLOW_MIGRATE`).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessWorkflowMigrated` | `process.workflow_migrated` | Cada item continuado (execução, US-128) | `migrationId`, `migrationItemId`, `fromVersionNumber`, `toVersionNumber`, `fromStageKeys` (`CONCLUSAO`), `toStageKeys` (`DOTACAO`), `statusFrom = COMPLETED`, `statusTo = IN_PROGRESS`, `approvalsCanceled = []`, `approvalsKept = []` |
| `WorkflowMigrationCompleted` | `workflow_migration.completed` | Fim da execução do plano | `migrationId`, `totals { migrated, excluded, failed, stale }` |

As criações do plano e as decisões de item não geram evento de domínio (só auditoria); `WorkflowMigrationSimulated` e `WorkflowMigrationStarted` são produzidos pelas US-127 e US-128.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `PROCESS_MIGRATED` | Responsáveis das etapas ativas de destino (ou titular e substituto da unidade, se não houver responsável) e criador do processo | in-app (e-mail desligado por padrão) | `ProcessWorkflowMigrated` |
| `WORKFLOW_MIGRATION_FINISHED` | Quem iniciou a execução | in-app + e-mail (padrão ligado) | `WorkflowMigrationCompleted` |

## Critérios de aceite em Gherkin
```gherkin
Feature: Levar à fase preparatória processos concluídos na v1

  Background:
    Given que o tenant "Prefeitura A" tem o workflow "Fase preparatória — Lei 14.133/2021" com a versão 1 e a versão 2 publicada
    And a versão 2 tem a etapa "DOTACAO" com unidade "CHOSEN_ON_FORWARD"
    And os processos "0007/2026" (Secretaria de Obras) e "0011/2026" (Secretaria de Saúde) estão "COMPLETED" na versão 1
    And "Carla" tem vínculo ativo com o perfil "ADMIN_ORGAO" (WORKFLOW_MIGRATE) e MFA na sessão

  Scenario: [Sucesso] Continuar um processo concluído entrando em Dotação
    When "Carla" criar o plano de continuação a partir da versão 1
    Then o plano deve nascer "DRAFT" com "processFilter.statuses" igual a ["COMPLETED"]
    And deve gerar registro de auditoria "workflow_migration.create"
    When "Carla" simular o plano
    Then os itens "0007/2026" e "0011/2026" devem ser "NEEDS_DECISION" com motivo "COMPLETED_V1_CONTINUATION" e destino proposto "DOTACAO"
    When "Carla" decidir "MIGRATE" para "DOTACAO" com a unidade "Contabilidade" e a justificativa "Continuar a fase preparatória conforme DEC-196"
    And executar o plano
    Then o processo "0007/2026" deve ficar "IN_PROGRESS" na etapa "DOTACAO" da versão 2 com "completedAt" nulo
    And a timeline deve exibir "WORKFLOW_MIGRATED" e manter "PROCESS_COMPLETED" com "Planejamento da contratação concluído"
    And deve gerar registro de auditoria "process.workflow_migrate" e o evento "ProcessWorkflowMigrated" com "statusFrom" "COMPLETED"
    And o plano deve terminar "COMPLETED" com o evento "WorkflowMigrationCompleted"

  Scenario: [Sucesso] Decisão em lote por seleção explícita e exclusão de um processo
    Given que a simulação tem os itens "0007/2026" e "0011/2026" como "NEEDS_DECISION"
    When "Carla" selecionar "0007/2026" e decidir "MIGRATE" para "DOTACAO" com unidade e justificativa de 40 caracteres
    And "Carla" decidir "EXCLUDE" para "0011/2026" com a justificativa "Processo encerrado sem interesse na fase de edital"
    Then cada item deve ter "decidedById" de "Carla" e a própria justificativa gravada
    And deve gerar um registro de auditoria "workflow_migration.decide_item" por item

  Scenario: [Validação] Destino, justificativa e unidade inválidos
    When "Carla" decidir "MIGRATE" para "JURIDICO"
    Then a API deve responder 422 com código "MIGRATION_CONTINUATION_TARGET_INVALID"
    When "Carla" decidir "MIGRATE" para "DOTACAO" com justificativa de 10 caracteres
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "TOO_SHORT" no campo "justification"
    When "Carla" decidir "MIGRATE" para "DOTACAO" sem "targetDepartmentId"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" no campo "targetDepartmentId"

  Scenario: [Permissão] Gestor sem WORKFLOW_MIGRATE ou sem MFA
    Given que "Marta" tem o perfil "GESTOR_CONTRATACOES" sem "WORKFLOW_MIGRATE"
    When "Marta" consultar a continuação ou criar o plano
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    Given que "Carla" está sem MFA na sessão
    When "Carla" executar o plano
    Then a API deve responder 403 com código "MFA_REQUIRED"

  Scenario: [Tenant incorreto] Plano de outro tenant
    Given que existe um plano de continuação no tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura A", enviar a decisão em lote para esse plano
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Plano aberto repetido e reexecução
    Given que já existe um plano de continuação "DRAFT" para a versão 1 e a versão 2
    When "Carla" criar outro plano com a mesma origem e destino
    Then a API deve responder 409 com código "MIGRATION_CONTINUATION_ALREADY_OPEN" e "meta.migrationId" do plano existente
    Given que o plano foi executado e o item "0007/2026" está "MIGRATED"
    When "Carla" reexecutar o plano
    Then o item "0007/2026" não deve ser reprocessado e nenhum novo "ProcessWorkflowMigrated" deve ser gerado

  Scenario: [Concorrência] Processo continuado por outro plano entre a simulação e a execução
    Given que o processo "0011/2026" também consta de outro plano que foi executado primeiro
    When o plano de "Carla" for executado
    Then o item "0011/2026" deve ficar "STALE" sem efeito no processo
    And os demais itens devem ser migrados normalmente

  Scenario: [Falha de banco] Falha ao migrar um item
    Given que o banco falha na transação do item "0011/2026"
    When o plano for executado
    Then o item "0011/2026" deve ficar "FAILED" com "errorCode" preenchido e o processo deve continuar "COMPLETED" na versão 1
    And o item "0007/2026" deve ficar "MIGRATED"
    When "Carla" reexecutar o plano depois de o banco voltar
    Then apenas o item "0011/2026" deve ser reprocessado

  Scenario: [Falha de integração] Fila de manutenção indisponível ao iniciar a execução
    Given que o Redis das filas está indisponível
    When "Carla" executar o plano simulado
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o plano deve continuar "SIMULATED" sem o evento "WorkflowMigrationStarted"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem processos elegíveis | 422 | `MIGRATION_NO_ELIGIBLE_PROCESSES` | "Não há processos concluídos na versão anterior para continuar." | Oculta a faixa; mostra estado vazio |
| Destino sem `DOTACAO` ou não publicado | 422 | `MIGRATION_CONTINUATION_TARGET_INVALID` | "A versão de destino não tem a etapa Dotação orçamentária." | Aponta a SCR-034 para publicar/ajustar a v2 |
| Plano de continuação já aberto | 409 | `MIGRATION_CONTINUATION_ALREADY_OPEN` | "Já existe um plano de continuação em aberto. Continue o plano existente." | Link ao plano (`meta.migrationId`) |
| Item bloqueado | 200 (por item) / 422 | `MIGRATION_ITEM_BLOCKED` | "Este processo não pode continuar: {motivo}." | Linha marcada; seleção desabilitada |
| Plano sem simulação / hash divergente / decisões pendentes | 409 / 409 / 422 | `MIGRATION_NOT_SIMULATED` / `MIGRATION_SIMULATION_STALE` / `MIGRATION_DECISIONS_PENDING` | "Simule o plano e decida todos os processos antes de executar." | Destaca os itens pendentes |
| Plano fora de `DRAFT`/`SIMULATED` | 409 | `MIGRATION_NOT_EDITABLE` | "Este plano não aceita mais decisões." | Modo somente leitura |
| Corpo inválido | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca os campos |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Não foi possível repetir esta ação com os mesmos dados." | Recarrega o plano |
| Sem permissão / sem MFA | 403 | `PERMISSION_DENIED` / `MFA_REQUIRED` | "Você não tem permissão para migrar processos." / "Confirme sua identidade (MFA) para continuar." | Oculta ações; abre o desafio de MFA |
| Plano de outro tenant / inexistente | 404 | `NOT_FOUND` | "Plano não encontrado." | Volta à lista de migrações |
| Fila de manutenção ou banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível executar agora. O plano continua salvo; tente novamente." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-128 (execução assíncrona, idempotente e auditada — mecânica de cada item), US-130 (v2 publicada ou adotada, com `DOTACAO`); por consequência US-126 (plano, mapa e filtro) e US-127 (simulação e decisões), de que a US-128 depende. Habilita US-147 em diante (o processo retomado segue a dotação) e as stories de edital, jurídico e controle interno.
- **Decisões/ADRs:** DEC-195, DEC-196, DEC-013, DEC-014, DEC-024; ADR-016.
- **Configurações:** nenhuma nova.
- **Lacunas nas fontes canônicas:**
  1. `WorkflowMigrationItem` (entities MVP 2 §4.7) não tem campo para a **unidade de destino** quando `DOTACAO` é `CHOSEN_ON_FORWARD`; proposta: `targetDepartmentId` (uuid, nulo, FK `departments`; obrigatório em `MIGRATE` quando a etapa pede escolha) e `decideItem` do PRC-52 aceita-o.
  2. `Process.completedAt`/`completedById` e a restrição de `COMPLETED` (entities §5.1) não dizem o que acontece na volta a `IN_PROGRESS`; proposta: limpar os dois campos e guardar o instante anterior em `ProcessMovement.metadata` (RN-WF2-105).
  3. Para um processo `COMPLETED` não há etapa `ACTIVE`; `expectedProcessStageIds` (entities §4.7) deve conter a `ProcessStage` `END` encerrada mais recente (a conferência de corrida continua válida). A tabela de entities não menciona esse caso.
  4. A **decisão em lote** (PRC-52) é proposta desta story para viabilizar a continuação de muitos processos sem perder a "decisão humana por processo" da DEC-195; a política de produto sobre aceitar lote com justificativa única é dúvida a confirmar.
  5. Os códigos `MIGRATION_*` desta story (`NO_ELIGIBLE_PROCESSES`, `CONTINUATION_TARGET_INVALID`, `CONTINUATION_ALREADY_OPEN`, `ITEM_BLOCKED`, `NOT_EDITABLE`) podem se sobrepor aos que US-126 a US-128 definirem; a consolidação cabe ao `api.md` do MVP 2.
  6. Continuação da contratação direta (`DIRECT_CONTRACTING`) não é prevista na DEC-195; fora do escopo desta story. Dúvida de produto.

## Impacto técnico
- **Exceção controlada à imutabilidade:** o único caminho que reverte `COMPLETED` é a execução da migração, com `app.migration_item_id` setado na transação (gatilhos de `processes.workflow_version_id` e `status`). Teste de regressão garante que nenhuma outra rota reabre processo (RN-PROC-117 continua valendo).
- **Concorrência e carga:** um processo por transação, `SELECT … FOR UPDATE` no processo, conferência de `expectedProcessStageIds` e retomada idempotente por item (ADR-016); a fila `maintenance` limita a taxa para não competir com a tramitação.
- **Analytics:** a continuação gera nova passagem de etapa e `statusFrom = COMPLETED`; o read model (ADR-014) precisa tratar a volta a `IN_PROGRESS` sem duplicar o processo concluído nos indicadores (consumidor `R` do `ProcessWorkflowMigrated`).
- **Sigilo:** valores sigilosos mascarados na lista da SCR-118 e na exportação (POL-09).
- **Dados antigos:** processos concluídos na v1 não ganham documentos novos (`EDITAL`, `PARECER_JURIDICO` etc.); eles são criados nas etapas novas, normalmente.

## Backend
- **Módulo(s):** `process` (dono: `WorkflowMigration`, itens, execução), `workflow` (leitura de versões e etapas pela fachada), `notification`, `timeline`, `access`, `audit`, `platform` (fila `maintenance`, outbox, idempotência).
- **Casos de uso:** `GetCompletedContinuationQuery` (PRC-50), `CreateCompletedContinuationPlanCommand` (PRC-51, delega a `CreateWorkflowMigrationCommand` da US-126 com filtro e mapa pré-preenchidos), `BulkDecideMigrationItemsCommand` (PRC-52, delega a `DecideMigrationItemCommand` da US-127 por item), `ExecuteWorkflowMigrationCommand`/`MigrateProcessItemHandler` (US-128, com o ramo `COMPLETED_V1_CONTINUATION`).
- **Domínio:** `ContinuationEligibilityPolicy` (RN-WF2-101/104), `ContinuationDecisionPolicy` (RN-WF2-102/103), `ProcessContinuation.apply(item)` (reabre `COMPLETED` → `IN_PROGRESS` só na migração), `MigrationItemClassifier` com o motivo `COMPLETED_V1_CONTINUATION`.
- **Integrações internas:** `WorkflowFacade` (etapa `DOTACAO`, `departmentResolution`, SLA), `OrganizationFacade` (unidade de destino), `AuthorizationService`, `TimelineProjector`, `OutboxWriter`.
- **Transação:** criação e decisão em transação curta; cada item da execução em transação própria (versão, status, etapas, atribuição, acesso, movimento, timeline, auditoria e outbox).

## Frontend
- **Tela(s):** SCR-118 (`/admin/workflows/[id]/migracoes/[migrationId]`) em modo "Continuação dos concluídos"; SCR-034 (`/admin/workflows/[id]`) com a faixa de entrada.
- **Componentes:** `ContinuationBanner` (SCR-034), `ContinuationPlanDialog`, `ContinuationItemsTable` (seleção múltipla, filtro por secretaria, valor mascarado), `BulkDecisionDialog` (decisão, unidade de destino, justificativa com contador), `SimulationSummary`, `ExecutionProgress`, `ContinuationReport`.
- **Estados:** loading (skeleton da tabela); vazio ("Nenhum processo concluído para continuar"); simulação pendente; decisões pendentes (contador "{n} sem decisão"); executando (progresso por item, atualização periódica); concluído com relatório; erro com "Tentar novamente".
- **Acessibilidade e responsividade:** seleção por teclado com `aria-label` por linha; resultado do lote e progresso anunciados por `aria-live`; justificativa com rótulo e erro associado; tabela em cartões abaixo de 768 px.

## Banco de dados
- **Tabelas:** `workflow_migrations`, `workflow_migration_items`, `processes`, `process_stages`, `process_assignments`, `process_access`, `process_movements`, `process_timeline_entries`, `audit_logs`, `outbox_events`, `notifications`.
- **Migrações:** nenhuma obrigatória além de M2-07/M2-08; a lacuna 1 acrescentaria `workflow_migration_items.target_department_id` (uuid, nulo, FK composta) se aceita.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, source_workflow_version_id) WHERE status = 'RUNNING'`; `UNIQUE (tenant_id, migration_id, process_id)`; `CHECK (decision <> 'MIGRATE' OR classification = 'AUTOMATIC' OR (target_stage_key IS NOT NULL AND decision_justification IS NOT NULL))`; `CHECK (classification <> 'BLOCKED' OR decision = 'EXCLUDE')`; índice `(tenant_id, migration_id, classification, result)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `PRC-50` | GET | `/workflows/{id}/completed-continuation` | — | `200 { data: { workflowId, seedKey, targetVersion { id, versionNumber }, sourceVersions[{ id, versionNumber, eligibleCount }], eligibleCount, openMigration { id, status }? } }` · `Cache-Control: no-store` | 200, 403, 404 |
| `PRC-51` | POST | `/workflows/{id}/completed-continuation/migrations` | `Idempotency-Key`; `{ sourceWorkflowVersionId?, name?, filter? { requestingSecretariatIds?, openedFrom?, openedTo?, processIds? } }` | `201 { data: WorkflowMigration (DRAFT) }` · `Location` | 201, 403, 404, 409, 422, 503 |
| `PRC-52` | POST | `/workflow-migrations/{migrationId}/items/bulk-decision` | `Idempotency-Key`; `{ itemIds[1..100], decision, targetStageKey?, targetDepartmentId?, justification, expectedSimulationHash }` | `200 { data: [{ itemId, processId, ok, code?, message? }], meta: { successCount, errorCount } }` | 200, 403, 404, 409, 422 |

As ações de simular, decidir item, executar, consultar o relatório e cancelar usam os endpoints das US-126 a US-128 (`/workflows/{id}/migrations` e `/workflow-migrations/{migrationId}/...`), sem alteração de contrato.

## Logs
- `info` `workflow_migration.continuation_created` — `migrationId`, `sourceVersion`, `targetVersion`, `eligibleCount`.
- `info` `workflow_migration.items_decided` — `migrationId`, `count`, `decision`, `batchId`.
- `info` `workflow_migration.item_migrated` — `migrationId`, `itemId`, `processId`, `durationMs`; `warn` `...item_stale`; `error` `...item_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** justificativa, valores sigilosos, título ou objeto do processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow_migration.create` | `CONFIGURATION` | PRC-51 | `metadata`: `migrationId`, `sourceWorkflowVersionId`, `targetWorkflowVersionId`, `filter` (forma, sem ids de processo) |
| `workflow_migration.decide_item` | `CONFIGURATION` | Decisão de cada item (individual ou em lote) | `changes`: `decision`, `targetStageKey`; `metadata`: `migrationId`, `itemId`, `processCode`, `batchId?`, `hasJustification` |
| `workflow_migration.execute` | `CONFIGURATION` | Início e fim da execução (US-128) | `metadata`: `migrationId`, `totals` |
| `process.workflow_migrate` | `WORKFLOW` | Cada item migrado | `changes`: `status`, `workflowVersionId`, `currentStageId`; `metadata`: `migrationId`, `itemId`, versões, mapa aplicado, decisão e justificativa |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = WORKFLOW_MIGRATE` |

## Testes necessários
- **Unitários:** `ContinuationEligibilityPolicy` (status, `seedKey`, versão de destino); `ContinuationDecisionPolicy` (destino único, justificativa, unidade condicional); regras de lote (1 a 100, repetidos); canonicalização do `simulationHash` com decisões.
- **Integração (Testcontainers PostgreSQL + Redis):** continuação ponta a ponta (plano → simulação → decisão → execução) com estados finais dos processos; gatilhos de `status` e `workflowVersionId` só com `app.migration_item_id`; item `STALE` por corrida; retomada após falha; nenhuma outra rota reabre `COMPLETED`.
- **API/contrato:** PRC-50 a PRC-52 conforme a tabela; reutilização dos endpoints da US-126 a US-128 sem mudança de contrato.
- **RBAC e multi-tenant:** `WORKFLOW_MIGRATE` e MFA; plano e processos de outro tenant → 404/ignorados (suíte `test/tenant-leak`); processo sigiloso mascarado na lista.
- **Concorrência:** dois planos com o mesmo processo; execução × cancelamento do plano.
- **E2E (Playwright):** v2 publicada → faixa → plano → simular → decidir em lote → executar → processo na caixa de `DOTACAO`.
- **Acessibilidade/performance:** axe na tabela e nos diálogos; execução de 1.000 itens sem bloquear a tramitação (meta na suíte de performance, medida no endurecimento).

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada
- [ ] Teste prova que `COMPLETED` só volta a `IN_PROGRESS` pela migração
- [ ] Documentos, aprovações e histórico do processo continuado verificados como intactos
- [ ] Lacunas 1 a 6 resolvidas ou aceitas pela coordenação antes da implementação

## Estimativa
**M** — a mecânica pesada (plano, simulação, execução assíncrona) é das US-126 a US-128; aqui entram a elegibilidade restrita, a decisão em lote, a unidade de destino e os efeitos específicos de reabrir um processo concluído.

## Prioridade
**P1** — exceção à regra de prioridade registrada em `features.md`: a fase preparatória dos processos novos fecha sem esta story, mas os concluídos do MVP 1 só continuam com ela.
