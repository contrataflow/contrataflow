---
id: US-128
title: "Executar a migração de forma assíncrona, idempotente e auditada"
epic: EP-021
feature: FT-064
mvp: 2
priority: P0
estimate: L
status: Especificada
depends_on: [US-054, US-059, US-073, US-083, US-127]
modules: [process, workflow, approval, access, timeline, notification, audit, platform, analytics]
screens: [SCR-118]
endpoints: [WF-35, WF-36, WF-27, WF-32]
permissions: [WORKFLOW_MIGRATE, WORKFLOW_VIEW]
events: [WorkflowMigrationStarted, ProcessWorkflowMigrated, WorkflowMigrationCompleted, ApprovalCanceled, ApprovalRequested]
---

# US-128 — Executar a migração de forma assíncrona, idempotente e auditada

## Título
Executar a migração de forma assíncrona, idempotente e auditada

## Descrição
**Como** administrador do órgão (`ADMIN_ORGAO` com `WORKFLOW_MIGRATE`), **quero** executar um plano de migração já simulado e decidido e acompanhar o andamento até o relatório final, **para** levar os processos em andamento para a nova versão do workflow sem perder prazo, responsável nem histórico, com cada processo migrado de forma isolada, auditável e sem risco de duplicar ou corromper nada se algo falhar no meio.

A story entrega a **execução** (DEC-195, ADR-016): o pedido humano de execução (WF-35, com a prova do `simulationHash`), o runner assíncrono na fila `maintenance`, um processo por transação e idempotente por item, o efeito completo da migração em cada processo (`Process.workflowVersionId`, etapa `MIGRATED`, etapa de destino com `dueAt` preservado, atribuição `MIGRATION`, movimento `MIGRATE`, timeline, auditoria `process.workflow_migrate`, evento `ProcessWorkflowMigrated`, aprovações mantidas ou canceladas e solicitadas de novo), o tratamento de itens `STALE` e `FAILED`, o fim do plano com o evento `WorkflowMigrationCompleted` e a notificação ao solicitante, o acompanhamento na SCR-118 e o relatório exportável. **Não há reversão automática**: voltar exige outra migração.

## Contexto
- DEC-195 e o ADR-016 (§4–§7) definem a execução assíncrona, um processo por transação, idempotente por item, com trava consultiva por processo, e a regra de que **nenhuma migração roda sozinha**: publicar uma versão nunca migra nada, e a execução exige pedido humano com `WORKFLOW_MIGRATE` e MFA (POL-21).
- `docs/mvp-02/entities.md` §4.7 e §5 fixam o modelo: `WorkflowMigration` (`RUNNING`, `startedAt/By`, `completedAt`, `totals`), `WorkflowMigrationItem` (`result` `PENDING`/`MIGRATED`/`EXCLUDED`/`FAILED`/`STALE`, `movementId`, `errorCode/Message`, `executedAt`; check `result <> 'MIGRATED' OR movement_id IS NOT NULL`), `Process.workflowVersionId` (agora mutável **só** pela execução: o trigger aceita a mudança apenas com `app.migration_item_id` setado na transação), `ProcessStageStatus.MIGRATED`, `MovementAction.MIGRATE`, `AssignmentType.MIGRATION` e `ApprovalCanceled.reason = MIGRATION`.
- `events.md` define `WorkflowMigrationStarted`, `ProcessWorkflowMigrated`, `WorkflowMigrationCompleted`, a timeline `WORKFLOW_MIGRATED`, as notificações `PROCESS_MIGRATED` e `WORKFLOW_MIGRATION_FINISHED` (e-mail padrão ✔, para quem iniciou — exceção ao "nunca notificar o ator", por ser trabalho assíncrono pedido pelo próprio usuário) e as auditorias `process.workflow_migrate` e `workflow_migration.execute`/`export`.
- A US-127 produz o plano `SIMULATED` com `simulationHash`, os itens classificados e as decisões; a US-124 define ramos e o seu fechamento; a US-083 define a fila `maintenance` e o `runJob` com `meta.tenantId`; a US-073 define a auditoria transacional; a US-059, a projeção de timeline; a US-054, os movimentos.
- ADR-014: os fatos do read model tratam `MIGRATED` como **mudança de versão**, não como devolução nem conclusão de etapa; o `AnalyticsProjector` consome `process.workflow_migrated` e `workflow_migration.*`.

## Objetivo
Migrar com segurança ≥ 95% dos processos elegíveis do piloto sem redigitação, com ≤ 2% de itens `FAILED`/`STALE`, **0** execuções sem simulação válida e **0** processos em estado parcial (cada item grava tudo ou nada), com relatório final completo e auditável.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`) com `WORKFLOW_MIGRATE`.
- **Secundárias:** Responsáveis pelas etapas migradas (recebem `PROCESS_MIGRATED`); Gestor de contratações (`GESTOR_CONTRATACOES`); Auditor (`AUDITOR`) e Controle Interno (`CONTROLE_INTERNO`), que conferem a trilha e o relatório; Sistema (`SYSTEM`) como executor.

## Pré-condições
- Plano `SIMULATED` (US-127), sem item `NEEDS_DECISION` pendente (`canExecute = true`) e com ao menos um item `MIGRATE`.
- Usuário com `WORKFLOW_MIGRATE`, MFA válido na sessão (POL-21) e o `simulationHash` atual do plano em mãos.
- A versão de destino está `PUBLISHED` no momento do pedido; não há outro plano `RUNNING` para a mesma versão de origem.
- A fila `maintenance` e o worker (`apps/worker`) estão operando; se não estiverem, o plano fica `RUNNING` aguardando e a execução começa quando voltarem (RN-WF2-65).

## Fluxo principal
1. Na SCR-118, fase **Execução**, o administrador vê o resumo ("{N} processos serão migrados, {M} excluídos, {K} bloqueados") e o aviso "Não há reversão automática — para voltar será preciso outra migração". Confirma marcando "Entendo e quero executar" e passa pelo MFA se necessário.
2. O front envia WF-35 com `Idempotency-Key`, `If-Match` e o `simulationHash` exibido. A API valida permissão, MFA, estado e hash (RN-WF2-63/64) e, **na mesma transação**: leva o plano a `RUNNING` (`startedAt`, `startedById`), audita `workflow_migration.execute` e grava no outbox o evento `WorkflowMigrationStarted` (`itemsToMigrate`). Responde **202** com o plano em `RUNNING`.
3. O consumidor `WorkflowMigrationRunner` recebe o evento e enfileira o job `workflow-migration-run` na fila `maintenance` (`meta.tenantId`, `migrationId`, `requestedById`, `correlationId`; `jobId` fixo por plano). O runner toma a trava consultiva do plano e processa os itens um a um.
4. Para cada item, numa **transação própria** (RN-WF2-66): trava o processo (`FOR UPDATE`, ordem processo → split → etapas), confere versão e `expectedProcessStageIds`; se algo mudou, marca `STALE` sem efeito; se a decisão é `EXCLUDE`, marca `EXCLUDED`; se é `MIGRATE`, aplica o efeito (RN-WF2-67..71): muda a versão do processo, fecha a(s) etapa(s) ativa(s) como `MIGRATED`, abre a etapa de destino **preservando** unidade, responsável e `dueAt`, trata as aprovações, grava o movimento `MIGRATE`, a timeline, a auditoria `process.workflow_migrate`, o evento `ProcessWorkflowMigrated` e a notificação `PROCESS_MIGRATED`, e marca o item `MIGRATED` com `movementId` e `executedAt`.
5. Falha de um item (ex.: aprovador não resolvido na etapa de destino) desfaz **apenas aquele** item: `FAILED` com `errorCode`/`errorMessage` em pt-BR; os demais seguem (RN-WF2-73).
6. A SCR-118 acompanha o andamento (WF-27 com `progress`, a cada 5 s): barra de progresso, contadores por resultado e a lista de itens (WF-32 com `result`), com link para cada processo migrado e destaque para `FAILED`/`STALE`.
7. Quando nenhum item está `PENDING`, o runner leva o plano a `COMPLETED` (`completedAt`, `totals` finais), audita `workflow_migration.execute` (fase de conclusão, ator `SYSTEM`), emite `WorkflowMigrationCompleted` e notifica quem iniciou (`WORKFLOW_MIGRATION_FINISHED`, in-app e e-mail).
8. O administrador abre o **relatório** (resumo + itens) e o exporta em CSV (WF-36, auditado). Itens `FAILED`/`STALE` ficam no relatório e podem ir para **uma nova migração** (filtro por `processIds`).
9. Cada processo migrado mostra na timeline "Processo migrado da versão 2 para a versão 3 do workflow" e passa a ser regido pelas etapas e regras da nova versão.

## Fluxos alternativos
- **FA-01 — Hash divergente:** se outra pessoa re-simulou, o hash enviado não bate: 409 `MIGRATION_SIMULATION_STALE`; a tela recarrega o plano e pede nova conferência.
- **FA-02 — Decisões pendentes:** com item `NEEDS_DECISION` sem decisão, 422 `MIGRATION_DECISIONS_PENDING` (com a contagem); a tela leva ao primeiro item pendente.
- **FA-03 — Worker fora do ar:** o plano fica `RUNNING` ("Na fila"); o painel mostra "Aguardando o processamento" e, passados 5 minutos sem progresso, o botão "Retomar" (WF-35 de novo); nada é duplicado.
- **FA-04 — Processo tramitado depois da simulação:** o item vira `STALE` (RN-WF2-74), sem alterar o processo, e entra no relatório.
- **FA-05 — Aprovação pendente compatível:** a aprovação é mantida (apontada para a nova etapa), sem novo pedido nem perda de votos.
- **FA-06 — Aprovação incompatível:** é cancelada (`ApprovalCanceled`, motivo "Processo migrado de versão do workflow") e, se o destino é `APPROVAL`, solicitada de novo pela etapa de destino.
- **FA-07 — Processo em ramificação:** os ramos e o split fecham e o processo segue numa única etapa de destino (RN-WF2-70).
- **FA-08 — Processo suspenso:** a migração preserva a suspensão e o prazo pausado (RN-WF2-69).
- **FA-09 — Cancelar durante a execução:** não existe; o plano `RUNNING` não cancela nem pausa (WF-30 → 409). O que ainda não rodou continua; o que rodou não é revertido.
- **FA-10 — Voltar à versão anterior:** exige outro plano (destino → origem), com as mesmas regras, simulação e decisões.
- **FA-11 — Reexecutar após a conclusão:** plano `COMPLETED` é imutável; processos `FAILED`/`STALE` entram em novo plano.

## Regras de negócio
- **RN-WF2-63** — Executar (WF-35) exige `WORKFLOW_MIGRATE`, MFA na sessão (POL-21), plano `SIMULATED` com `canExecute = true` (todos os `NEEDS_DECISION` decididos com justificativa — RN-WF2-12/55), `simulationHash` do corpo **igual** ao gravado, versão de destino ainda `PUBLISHED` e nenhum outro plano `RUNNING` na mesma versão de origem (unique parcial). O pedido é sempre humano: nenhum job, publicação ou evento inicia uma migração (DEC-195, DEC-014).
- **RN-WF2-64** — Erros do pedido: plano `DRAFT` ou sem simulação → 409 `MIGRATION_NOT_SIMULATED`; hash diferente → 409 `MIGRATION_SIMULATION_STALE`; decisões pendentes → 422 `MIGRATION_DECISIONS_PENDING` (`meta.pending`); nada a migrar → 422 `MIGRATION_NOTHING_TO_MIGRATE`; outro plano `RUNNING` na origem → 409 `MIGRATION_ALREADY_RUNNING`; destino não publicado → 409 `MIGRATION_TARGET_NOT_PUBLISHED`; plano `COMPLETED`/`CANCELED` → 409 `MIGRATION_NOT_EDITABLE`. Os erros do pedido não alteram o plano (exceto a invalidação por mudança de mapa/filtro, que já o devolveu a `DRAFT` — US-126).
- **RN-WF2-65** — Execução assíncrona: no pedido o plano vai a `RUNNING` e o evento `WorkflowMigrationStarted` entra no outbox na mesma transação; o `WorkflowMigrationRunner` (consumidor do evento) enfileira o job `workflow-migration-run` na fila `maintenance` com `meta.tenantId` e `jobId` único por plano (reentrega não duplica); o runner toma uma **trava consultiva por plano** (segunda instância sai sem processar) e executa os itens `PENDING` em lotes pequenos, **um processo por transação**, em série por plano (paralelo entre planos de tenants diferentes). Fila ou Redis fora do ar não perdem o pedido (outbox com reentrega); o plano continua `RUNNING` até o worker voltar.
- **RN-WF2-66** — Transação do item: (1) trava o processo com `SELECT … FOR UPDATE` (espera até 5 s; esgotado → item volta a `PENDING` para nova tentativa do job) e, depois, o split e as etapas na ordem da US-124; (2) seta `app.migration_item_id` (autoriza o trigger a mudar `Process.workflowVersionId`); (3) relê o item: `MIGRATED`/`EXCLUDED` → **encerra sem efeito** (idempotência); (4) confere `Process.workflowVersionId = origem` e o conjunto de `ProcessStage` `ACTIVE` = `expectedProcessStageIds`; diferente → `STALE`. Os locks seguem a ordem processo → split → etapa de ramo, a mesma da tramitação, evitando deadlock com a operação normal.
- **RN-WF2-67** — Efeito `MIGRATE`, na mesma transação: `Process.workflowVersionId` ← destino; as `ProcessStage` ativas (e o split, se houver) fecham com `status = MIGRATED`, `exitedAt = agora`, `exitedViaMovementId`; abre-se **uma** `ProcessStage` na etapa de destino (`sequence + 1`, `ACTIVE`, `enteredAt = agora`, `enteredViaMovementId`) **preservando** `departmentId`, `assigneeId`, `dueAt`, `dueDateOverridden`/`dueDateOverrideReason`, `pausedAt`, `pausedTotalSeconds`, `overdueSince` e os marcadores de alerta (`dueSoonNotifiedAt`, `overdueNotifiedAt`) — **o prazo não recomeça** e nenhum alerta se repete; `slaDays`/`slaType` são o snapshot da etapa de destino (informativos). As atribuições ativas encerram e nasce um `ProcessAssignment` `MIGRATION` com o mesmo responsável e unidade (sem responsável → fila da unidade). `Process` recebe `currentStageId`, `currentWorkflowStageId`, `currentDepartmentId`, `currentResponsibleId`, `currentStageDueAt`, `activeStagesCount = 1` e `version + 1`. `ProcessAccess` preserva a unidade (`CURRENT`); acessos de ramos viram `HISTORICAL`.
- **RN-WF2-68** — Aprovações pendentes: a **compatível** (US-127 RN-WF2-60) é mantida — a `Approval` passa a referenciar a nova `ProcessStage` e as linhas `ApprovalApprover` e os votos permanecem; a **incompatível** é cancelada (`CANCELED`, `decisionComment` "Processo migrado de versão do workflow", `ApprovalCanceled` com `reason = MIGRATION`) e, se a etapa de destino é `APPROVAL`, uma **nova** aprovação é solicitada pelo mecanismo da US-051 (documentos cobertos, aprovador e política da etapa de destino; `ApprovalRequested`). Se a nova solicitação falhar (`APPROVER_UNRESOLVED`, `DOCUMENT_INCOMPLETE`), **todo o item** é desfeito e fica `FAILED` com esse código. Os ids mantidos e cancelados vão para `approvalsKept[]`/`approvalsCanceled[]` do evento.
- **RN-WF2-69** — Status do processo: `statusTo` = `statusFrom` quando o tipo de etapa não muda de lado (`TASK` ↔ `TASK`: `IN_PROGRESS` e `RETURNED` preservados; `APPROVAL` ↔ `APPROVAL`: `AWAITING_APPROVAL`); destino `APPROVAL` → `AWAITING_APPROVAL`; destino `TASK` vindo de `AWAITING_APPROVAL` → `IN_PROGRESS`. Processo `SUSPENDED` permanece `SUSPENDED` (com `suspendedAt`, `suspensionReason` e prazo pausado preservados) e `statusBeforeSuspension` é recalculado pelo tipo da etapa de destino. `ProcessStatusChanged` só é emitido se o status mudar.
- **RN-WF2-70** — Processo em ramificação (`PARALLEL_ACTIVE`): fecham como `MIGRATED` o split e todas as etapas de ramo ativas; `ProcessBranch` `OPEN` → `CANCELED` (`cancellationReason` "Processo migrado de versão do workflow"); aprovações pendentes dos ramos são canceladas (RN-WF2-68, sempre incompatíveis); a etapa de destino única herda unidade, responsável, `dueAt` e demais marcadores da etapa **representativa** (menor `dueAt` — US-127 RN-WF2-59). Não é emitido `ProcessBranchesCanceled` (próprio da devolução).
- **RN-WF2-71** — Rastreabilidade do item migrado: `ProcessMovement` com `action = MIGRATE` (`sequence + 1`, de → para etapa, `statusFrom`/`statusTo`, `actorType = SYSTEM`, `metadata.migration = { migrationId, itemId, fromVersion, toVersion, mapping, decision, targetStageKey, requestedById }` — a justificativa humana fica na auditoria e no item); timeline `WORKFLOW_MIGRATED` ("Processo migrado da versão {N} para a versão {M} do workflow"); auditoria `process.workflow_migrate` (`WORKFLOW`, ator `SYSTEM`, `metadata` com `migrationId`, `itemId`, versões, mapa aplicado, decisão e justificativa quando humana); evento `ProcessWorkflowMigrated`; notificação `PROCESS_MIGRATED` aos responsáveis das etapas de destino e ao criador (agrupada por 5 min, e-mail padrão "não"). **Não** emite `ProcessStageChanged` (os consumidores usam `ProcessWorkflowMigrated`) nem `ProcessAssigned`.
- **RN-WF2-72** — Idempotência: item `MIGRATED`/`EXCLUDED` **nunca** reexecuta; reentrega do job, retomada do plano e execução concorrente (duas instâncias) produzem no máximo um movimento por item (unique por `(tenant_id, migration_id, process_id)` + `result` relido sob o lock); `Idempotency-Key` em WF-35 reproduz a resposta do pedido sem criar novo job.
- **RN-WF2-73** — Falha de item: qualquer erro de negócio dentro da transação (`APPROVER_UNRESOLVED`, `DOCUMENT_INCOMPLETE`, `TARGET_STAGE_INVALID`) desfaz o item inteiro e grava `result = FAILED`, `errorCode` (≤ 60), `errorMessage` (≤ 500, pt-BR, sem dados sigilosos nem *stack*) e `executedAt`; falha transitória de infraestrutura (banco, `PROCESS_LOCKED`) é retentada pelo job com *backoff* (3 tentativas) e só depois vira `FAILED`; a falha de um item **não** interrompe o lote. O processo nunca fica parcialmente migrado.
- **RN-WF2-74** — `STALE`: item cujo `expectedProcessStageIds` não confere (o processo foi tramitado, devolvido, suspenso/retomado com mudança de etapa, cancelado ou já migrado por outro plano) fica `STALE` (`errorCode` `STAGES_CHANGED` ou `VERSION_CHANGED`), sem efeito algum, e segue para o relatório; não é recalculado nem reclassificado automaticamente (ADR-016 §Riscos).
- **RN-WF2-75** — Conclusão: quando nenhum item está `PENDING`, o plano vai a `COMPLETED` (`completedAt`, `totals` finais `{ automatic, needsDecision, blocked, migrated, excluded, failed, stale }`), audita `workflow_migration.execute` (ator `SYSTEM`, `metadata.phase = COMPLETED`), emite `WorkflowMigrationCompleted` (`totals { migrated, excluded, failed, stale }`) e notifica **quem iniciou** (`WORKFLOW_MIGRATION_FINISHED`, in-app + e-mail, exceção ao "nunca notificar o ator"). Itens `EXCLUDE` (decisão ou `BLOCKED`) são marcados `EXCLUDED` pelo runner sem alterar o processo.
- **RN-WF2-76** — Retomada: WF-35 sobre plano `RUNNING` com o mesmo `simulationHash` (`If-Match` dispensado) reenfileira os itens `PENDING` e `FAILED` (retentativa idempotente); se o runner está ativo (trava), a chamada responde 202 sem nada duplicar. Plano `COMPLETED`/`CANCELED` não retoma.
- **RN-WF2-77** — Acompanhamento: WF-27 devolve `progress { total, pending, migrated, excluded, failed, stale, lastExecutedAt }` calculado dos itens (leitura consistente, sem cache); a SCR-118 consulta a cada 5 s enquanto `RUNNING`; o alerta de plataforma dispara se um plano ficar `RUNNING` sem progresso por mais de 15 minutos (`workflow_migration.stalled`); WF-32 aceita `result` e devolve `errorCode`/`errorMessage`, `movementId` e `executedAt` por item.
- **RN-WF2-78** — Relatório (WF-36): CSV `text/csv; charset=utf-8` (com BOM, neutralizando fórmulas como o PRC-34) com uma linha por item — código e título do processo, classificação, razões, decisão, etapa de destino, justificativa, quem decidiu e quando, resultado, erro, `executedAt`, sequência do movimento —, para planos `SIMULATED`, `RUNNING` ou `COMPLETED`; permissão `WORKFLOW_VIEW`; sem valores monetários (POL-09); auditado (`workflow_migration.export`, `EXPORT`, com a contagem de linhas).
- **RN-WF2-79** — Sem reversão e sem automatismo: nenhuma ação desfaz uma migração; voltar é outro plano (destino → origem, mesmas regras, simulação e decisões); a autorização do pedido (permissão e MFA) é verificada **no pedido** e vale para a execução inteira — o job carrega `requestedById` apenas para rastreio e notificação; nenhuma migração é criada ou executada por publicação, seeder, job agendado ou evento (DEC-195).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Hash da simulação | `simulationHash` | texto 64 (hex) | Sim | Igual ao do plano `SIMULATED`; obrigatório também na retomada | plano (WF-27) |
| Entendo que não há reversão | *(só UI)* | checkbox | Sim | Habilita o botão "Executar migração" | `false` |
| Situação do plano | `status` | `WorkflowMigrationStatus` | — | `RUNNING` após o pedido; `COMPLETED` no fim | sistema |
| Iniciada por / em | `startedById`, `startedAt` | uuid / data | — | Sistema | sessão |
| Concluída em | `completedAt` | data | — | Sistema | runner |
| Progresso | `progress` | objeto | — | `{ total, pending, migrated, excluded, failed, stale, lastExecutedAt }` | WF-27 |
| Totais | `totals` | objeto | — | Finais ao concluir | runner |
| Resultado do item | `result` | `MigrationItemResult` | — | `PENDING` → `MIGRATED`/`EXCLUDED`/`FAILED`/`STALE` | runner |
| Movimento | `movementId` | uuid | — | Obrigatório em `MIGRATED` | runner |
| Erro | `errorCode`, `errorMessage` | texto ≤ 60 / ≤ 500 | — | Em `FAILED`/`STALE` | runner |
| Executado em | `executedAt` | data | — | Fim do tratamento do item | runner |
| Filtro de resultado na lista | `result` (query de WF-32) | enum | Não | `PENDING`, `MIGRATED`, `EXCLUDED`, `FAILED`, `STALE` | UI |
| Relatório | CSV de WF-36 | arquivo | — | RN-WF2-78 | WF-36 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `simulationHash` ausente ou fora do formato (64 hex) | Front + API (Zod) | "Recarregue o plano e confirme a simulação antes de executar." | `VALIDATION_ERROR` |
| V-02 | Plano `DRAFT` (ou nunca simulado) | API | "Simule o plano antes de executá-lo." | `MIGRATION_NOT_SIMULATED` (409) |
| V-03 | `simulationHash` diferente do plano | API | "A simulação mudou. Recarregue o plano, confira os números e tente de novo." | `MIGRATION_SIMULATION_STALE` (409) |
| V-04 | Itens `NEEDS_DECISION` sem decisão | API | "Faltam {N} decisões. Decida todos os processos pendentes antes de executar." | `MIGRATION_DECISIONS_PENDING` (422) |
| V-05 | Nenhum item `MIGRATE` | API | "Nenhum processo será migrado. Revise as decisões." | `MIGRATION_NOTHING_TO_MIGRATE` (422) |
| V-06 | Outro plano `RUNNING` na mesma origem | API | "Já existe uma migração em execução nesta versão. Aguarde o término." | `MIGRATION_ALREADY_RUNNING` (409) |
| V-07 | Versão de destino não está mais `PUBLISHED` | API | "A versão de destino não está mais publicada. Crie um novo plano." | `MIGRATION_TARGET_NOT_PUBLISHED` (409) |
| V-08 | Plano `COMPLETED`/`CANCELED` | API | "Este plano já foi encerrado." | `MIGRATION_NOT_EDITABLE` (409) |
| V-09 | `If-Match` ausente/divergente na primeira execução | API | "O plano foi alterado. Recarregue e tente de novo." | `PRECONDITION_REQUIRED` (428) / `VERSION_CONFLICT` (412) |
| V-10 | Sessão sem MFA | API | "Confirme sua identidade com o segundo fator para migrar processos." | `MFA_REQUIRED` (403) |
| V-11 | Mesma `Idempotency-Key` com corpo diferente | API | "Esta requisição já foi usada com outros dados." | `IDEMPOTENCY_KEY_REUSED` (422) |
| V-12 | Exportar plano `DRAFT` | API | "Simule o plano para gerar o relatório." | `MIGRATION_NOT_SIMULATED` (409) |
| V-13 | Aprovador/documento da etapa de destino não resolvidos (por item) | Runner | "Não foi possível solicitar a aprovação na etapa de destino: {motivo}." | item `FAILED` — `APPROVER_UNRESOLVED` / `DOCUMENT_INCOMPLETE` |
| V-14 | Etapas do processo mudaram depois da simulação (por item) | Runner | "O processo foi movimentado depois da simulação e não foi migrado." | item `STALE` — `STAGES_CHANGED` / `VERSION_CHANGED` |

## Permissões
- **Permissão:** `WORKFLOW_MIGRATE` para executar e retomar (WF-35); `WORKFLOW_VIEW` para acompanhar, listar itens e exportar o relatório (WF-27, WF-32, WF-36). O runner (`SYSTEM`) não tem permissão própria: age em nome do pedido autorizado (RN-WF2-79).
- **Políticas:** POL-21 (MFA sempre; execução só com `SIMULATED` + mesmo `simulationHash` + decisões completas; nenhuma migração sem pedido humano), POL-01 (a migração é exceção administrativa à custódia, auditada), POL-09 (nenhum valor sigiloso no relatório, nos logs nem nos eventos), DEC-024.
- **MFA:** **sempre** em WF-35 (POL-21); leituras e exportação não exigem MFA.
- **Sem permissão:** "Executar migração" e "Retomar" não aparecem; a SCR-118 fica em leitura; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`; plano de outro tenant → 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `WorkflowMigrationStarted` | `workflow_migration.started` | Commit do pedido de execução (WF-35) | `migrationId`, `itemsToMigrate`; consumido pelo `WorkflowMigrationRunner` e pelo `AnalyticsProjector` |
| `ProcessWorkflowMigrated` | `process.workflow_migrated` | Item `MIGRATED` | `migrationId`, `migrationItemId`, versões e números, `fromStageKeys[]`, `toStageKeys[]`, `movementId`, `approvalsCanceled[]`, `approvalsKept[]`, `statusFrom`, `statusTo`; consumidores T A N R; sem valores sigilosos |
| `WorkflowMigrationCompleted` | `workflow_migration.completed` | Fim da execução | `migrationId`, `totals { migrated, excluded, failed, stale }`; notifica quem iniciou |
| `ApprovalCanceled` | `approval.canceled` | Aprovação incompatível cancelada | `reason = MIGRATION` (aditivo, `events.md` §2) |
| `ApprovalRequested` | `approval.requested` | Nova aprovação solicitada na etapa de destino `APPROVAL` | MVP 1 + `decisionPolicy`/`approvers[]` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `PROCESS_MIGRATED` | Responsáveis das etapas ativas de destino e criador do processo (máx. 50 por unidade/perfil, agrupadas em 5 min) | In-app (e-mail padrão "não") | `ProcessWorkflowMigrated` |
| `WORKFLOW_MIGRATION_FINISHED` | Quem iniciou a execução (`startedById`) — exceção à regra "nunca notificar o ator" | In-app + e-mail (padrão ✔) | `WorkflowMigrationCompleted` |
| `APPROVAL_REQUESTED` (MVP 1) | Aprovador da nova aprovação | In-app + e-mail | `ApprovalRequested` na etapa de destino `APPROVAL` |

Sem valores sigilosos; preferências do usuário respeitadas (US-113); notificações do SMTP falho vão à fila `email` para nova tentativa.

## Critérios de aceite em Gherkin
```gherkin
Feature: Executar a migração de forma assíncrona, idempotente e auditada

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And "Marina" tem vínculo ativo com o perfil "ADMIN_ORGAO" (com "WORKFLOW_MIGRATE") e MFA válido na sessão
    And o plano "Migração v2 → v3" está "SIMULATED" com o "simulationHash" "H1" e a versão 3 do workflow "LICITACAO_PADRAO" "PUBLISHED"
    And os itens são: "0101/2026" e "0106/2026" "AUTOMATIC" (etapa "ESTUDOS_PRELIMINARES", prazo 20/11/2026, responsável "Carla"), "0107/2026" "AUTOMATIC" com aprovação pendente compatível, "0102/2026" "NEEDS_DECISION" decidido "MIGRATE" para "ESTUDOS_PRELIMINARES", "0103/2026" decidido "EXCLUDE" e "0105/2026" "BLOCKED"

  Scenario: [Sucesso] Executar migra cada processo em transação própria e conclui o plano
    When "Marina" executar o plano com "simulationHash" "H1"
    Then a API deve responder 202 com o plano "RUNNING" e deve gerar o evento WorkflowMigrationStarted com "itemsToMigrate" igual a 4
    And deve gerar registro de auditoria "workflow_migration.execute"
    When o worker processar a fila "maintenance"
    Then "0101/2026" deve ter "workflowVersionId" da versão 3, etapa anterior "MIGRATED" e nova etapa ativa com "dueAt" 20/11/2026 e responsável "Carla"
    And deve existir o movimento "MIGRATE" e o "ProcessAssignment" do tipo "MIGRATION"
    And a timeline deve exibir "Processo migrado da versão 2 para a versão 3 do workflow"
    And deve gerar registro de auditoria "process.workflow_migrate" com o mapa aplicado
    And deve gerar o evento ProcessWorkflowMigrated e a notificação "PROCESS_MIGRATED"
    And "0103/2026" e "0105/2026" devem ficar "EXCLUDED" sem alteração do processo
    And o plano deve ficar "COMPLETED" com totals { migrated: 4, excluded: 2, failed: 0, stale: 0 }
    And deve gerar o evento WorkflowMigrationCompleted e a notificação "WORKFLOW_MIGRATION_FINISHED" para "Marina"

  Scenario: [Sucesso] Aprovação compatível é mantida e incompatível é cancelada e solicitada de novo
    Given que "0107/2026" tem aprovação compatível e "0108/2026" tem aprovação de "Dr. Álvaro" cuja etapa de destino exige o perfil "AUTORIDADE_COMPETENTE"
    When o worker migrar os dois processos
    Then a aprovação de "0107/2026" deve continuar "PENDING" apontando para a nova etapa, sem novo pedido
    And a aprovação de "0108/2026" deve ficar "CANCELED" com o motivo "Processo migrado de versão do workflow"
    And deve existir uma nova aprovação "PENDING" para o perfil "AUTORIDADE_COMPETENTE"
    And "ProcessWorkflowMigrated" de "0108/2026" deve listar a aprovação em "approvalsCanceled"
    And deve gerar os eventos ApprovalCanceled com "reason" "MIGRATION" e ApprovalRequested

  Scenario: [Sucesso] Processo em ramificação segue em uma única etapa
    Given que "0104/2026" tem os ramos "JURIDICO" (prazo 18/11) e "CONTROLE_INTERNO" (prazo 20/11) ativos e decisão "MIGRATE" para "ESTUDOS_PRELIMINARES"
    When o worker migrar "0104/2026"
    Then o split e as duas etapas de ramo devem ficar "MIGRATED" e os dois "ProcessBranch" "CANCELED"
    And a nova etapa deve ter o prazo 18/11 e a unidade do ramo "JURIDICO"
    And "activeStagesCount" deve ser 1 e deve gerar registro de auditoria "process.workflow_migrate"

  Scenario: [Validação] Pedidos recusados antes de iniciar
    When "Marina" executar com "simulationHash" diferente de "H1"
    Then a API deve responder 409 com código "MIGRATION_SIMULATION_STALE"
    Given que o plano ainda está "DRAFT"
    When "Marina" executar o plano
    Then a API deve responder 409 com código "MIGRATION_NOT_SIMULATED"
    Given que 2 itens "NEEDS_DECISION" estão sem decisão
    When "Marina" executar o plano
    Then a API deve responder 422 com código "MIGRATION_DECISIONS_PENDING" e "meta.pending" igual a 2
    And o plano não deve ir a "RUNNING" e nenhum job deve ser enfileirado

  Scenario: [Validação] Aprovador da etapa de destino não resolvido
    Given que a etapa de destino "APROVACAO_AUTORIDADE" não tem aprovador resolvível para "0109/2026"
    When o worker migrar "0109/2026"
    Then o item deve ficar "FAILED" com "errorCode" "APPROVER_UNRESOLVED" e a mensagem em português
    And o processo "0109/2026" deve permanecer na versão 2, sem etapa nova nem movimento
    And os demais itens devem continuar sendo migrados

  Scenario: [Permissão] Sem WORKFLOW_MIGRATE ou sem MFA
    Given que "Bruno" tem apenas "WORKFLOW_VIEW"
    When "Bruno" executar o plano
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    When "Bruno" exportar o relatório do plano
    Then a API deve responder 200 e deve gerar registro de auditoria "workflow_migration.export"
    Given que "Marina" está com a sessão sem MFA
    When "Marina" executar o plano
    Then a API deve responder 403 com código "MFA_REQUIRED" e o plano deve continuar "SIMULATED"

  Scenario: [Tenant incorreto] Plano de outro tenant
    Given que existe o plano "Migração B" "SIMULATED" no tenant "Prefeitura B"
    When "Marina", no tenant "Prefeitura A", executar ou exportar esse plano
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum processo, item ou dado do tenant "Prefeitura B" deve ser alterado ou revelado
    And o worker de "Prefeitura A" nunca deve processar itens de "Prefeitura B"

  Scenario: [Duplicidade] Reenvio do pedido e reentrega do job
    Given que "Marina" executou o plano com a "Idempotency-Key" "E-01" e recebeu 202
    When a mesma requisição for reenviada
    Then a API deve responder 202 com "Idempotent-Replayed" verdadeiro
    And deve existir um único job "workflow-migration-run" e um único evento WorkflowMigrationStarted
    Given que "0101/2026" já está "MIGRATED"
    When o job for reentregue pelo broker
    Then o item não deve ser reexecutado e deve existir um único movimento "MIGRATE" para "0101/2026"

  Scenario: [Concorrência] Processo tramitado depois da simulação
    Given que "0106/2026" foi encaminhado para "PESQUISA_PRECOS" por "Carla" depois da simulação
    When o worker chegar ao item de "0106/2026"
    Then o item deve ficar "STALE" com "errorCode" "STAGES_CHANGED"
    And o processo não deve ser alterado e o plano deve concluir com "stale" igual a 1

  Scenario: [Concorrência] Dois planos para a mesma versão de origem e tramitação em curso
    Given que o plano "Migração v2 → v3" está "RUNNING"
    When "Paulo" (administrador) executar outro plano com a mesma origem
    Then a API deve responder 409 com código "MIGRATION_ALREADY_RUNNING"
    Given que "Carla" está encaminhando "0101/2026" no mesmo instante em que o worker o migra
    When as duas operações disputarem o processo
    Then uma deve esperar a outra pelo lock ordenado, sem deadlock, e o item deve terminar "MIGRATED" ou "STALE", nunca com estado parcial

  Scenario: [Falha de banco] Falha no meio de um item
    Given que o banco falha após fechar a etapa e antes de gravar o movimento de "0107/2026"
    When o worker migrar "0107/2026"
    Then a transação do item deve ser revertida e o processo deve permanecer intacto na versão 2
    And o item deve voltar a "PENDING" para nova tentativa e, esgotadas as tentativas, ficar "FAILED"
    And os itens anteriores devem permanecer "MIGRATED"

  Scenario: [Falha de integração] Redis e worker indisponíveis ao pedir a execução
    Given que o Redis das filas está indisponível no momento do pedido
    When "Marina" executar o plano
    Then a API deve responder 202 e o plano deve ficar "RUNNING" com o evento no outbox
    And a execução deve iniciar quando o worker voltar, sem job duplicado
    And a tela deve mostrar "Aguardando o processamento" e, depois de 5 minutos, "Retomar"

  Scenario: [Falha de integração] SMTP indisponível na notificação final
    Given que o provedor de e-mail (SMTP) está indisponível
    When o plano for concluído
    Then a notificação in-app "WORKFLOW_MIGRATION_FINISHED" deve existir
    And o e-mail deve ficar na fila "email" para nova tentativa sem afetar o plano "COMPLETED"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| `simulationHash` inválido | 422 | `VALIDATION_ERROR` | "Recarregue o plano e confirme a simulação antes de executar." | Recarrega o plano |
| Plano não simulado | 409 | `MIGRATION_NOT_SIMULATED` | "Simule o plano antes de executá-lo." | Leva à fase Simulação |
| Simulação mudou | 409 | `MIGRATION_SIMULATION_STALE` | "A simulação mudou. Recarregue o plano, confira os números e tente de novo." | Recarrega e reexibe o resumo |
| Decisões pendentes | 422 | `MIGRATION_DECISIONS_PENDING` | "Faltam {N} decisões. Decida todos os processos pendentes antes de executar." | Abre o próximo pendente |
| Nada a migrar | 422 | `MIGRATION_NOTHING_TO_MIGRATE` | "Nenhum processo será migrado. Revise as decisões." | Volta às decisões |
| Outra migração em execução | 409 | `MIGRATION_ALREADY_RUNNING` | "Já existe uma migração em execução nesta versão. Aguarde o término." | Link para o plano em execução |
| Destino não publicado | 409 | `MIGRATION_TARGET_NOT_PUBLISHED` | "A versão de destino não está mais publicada. Crie um novo plano." | Link para SCR-034 |
| Plano encerrado | 409 | `MIGRATION_NOT_EDITABLE` | "Este plano já foi encerrado." | Modo leitura |
| Cancelar plano em execução | 409 | `MIGRATION_NOT_CANCELABLE` | "Uma migração em execução não pode ser cancelada." | Botão ausente |
| `If-Match` divergente/ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "O plano foi alterado. Recarregue e tente de novo." | `ConflictDialog` |
| Corpo diferente com a mesma chave | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta requisição já foi usada com outros dados." | Gera nova chave |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para migrar processos." | Ações ocultas |
| MFA ausente | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para migrar processos." | Step-up e reenvio |
| Plano/item inexistente/outro tenant | 404 | `NOT_FOUND` | "Plano não encontrado." | Volta à lista |
| Item: aprovador/documento | — (item `FAILED`) | `APPROVER_UNRESOLVED` / `DOCUMENT_INCOMPLETE` | "Não foi possível solicitar a aprovação na etapa de destino: {motivo}." | Linha em erro no relatório com link para o processo |
| Item: processo mudou | — (item `STALE`) | `STAGES_CHANGED` / `VERSION_CHANGED` | "O processo foi movimentado depois da simulação e não foi migrado." | Linha "Não migrado" no relatório |
| Banco/Redis indisponível no pedido | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível iniciar agora. Tente novamente em instantes." | Toast com `correlationId` e "Tentar novamente" |

## Dependências
- **Stories:** US-127 (plano simulado e decidido), US-126 (plano), US-124 (ramos e ordem de locks), US-054 (movimentos), US-059 (timeline), US-073 (auditoria transacional), US-083 (filas, `runJob`, outbox), US-051/US-052 e EP-022 (aprovações), US-113 (preferências de notificação). Habilita US-131 (continuação v1 → v2) e qualquer nova versão de workflow do tenant.
- **Decisões/ADRs:** DEC-195, DEC-014, DEC-193, DEC-194, DEC-196, DEC-160..164 (outbox e filas); [ADR-016](../adr/adr-016-workflow-version-migration.md), [ADR-014](../adr/adr-014-indicators-read-model.md), [ADR-004](../adr/adr-004-outbox-events.md); POL-21.
- **Configurações:** nenhuma chave nova.
- **Lacunas nas fontes canônicas:**
  - `events.md` §3 não lista o consumidor que enfileira/executa o job (`WorkflowMigrationRunner`: dono `process`, fila `maintenance`, assina `workflow_migration.started`, idempotência por `jobId` do plano + `result` do item) nem `queues.md` o job `workflow-migration-run`; no MVP 1 a fila `maintenance` só roda *schedulers* de plataforma.
  - `entities.md` não define o status do processo `RETURNED` após migração: adotado preservar o status; efeito colateral — a atribuição `MIGRATION` tira o processo da visão "Devolvidos" (`RETURNED`, RN-INBOX-05, baseada em `type = RETURN`) — **dúvida de produto**.
  - `ProcessMovement.actorType` na migração: adotado `SYSTEM` com `requestedById` em `metadata` (a persona "Sistema" do épico); confirmar com a trilha de auditoria desejada pelo Controle Interno.
  - Códigos de erro de item (`STAGES_CHANGED`, `VERSION_CHANGED`, `TARGET_STAGE_INVALID`, `PROCESS_LOCKED`) e de pedido (`MIGRATION_NOTHING_TO_MIGRATE`, `MIGRATION_ALREADY_RUNNING`, `MIGRATION_TARGET_NOT_PUBLISHED`) são novos; `MIGRATION_NOT_SIMULATED`, `MIGRATION_DECISIONS_PENDING` e `MIGRATION_SIMULATION_STALE` vêm de POL-21.
  - Retomada: o texto "reexecutar o plano retoma só `PENDING`/`FAILED`" (`entities.md`) foi interpretado como retomada de plano `RUNNING` (RN-WF2-76); `FAILED` de plano `COMPLETED` só por novo plano (§6.8).
  - Sobre o que fazer com a versão de destino aposentada durante a execução: adotado seguir (definições imutáveis); dúvida se `WF-22` deve bloquear aposentar destino de plano `RUNNING`.
  - Meta de vazão (ex.: 2.000 itens em até 10 min) não consta das fontes: proposta como teste de performance, a calibrar no endurecimento.

## Impacto técnico
- **Risco principal:** mexer no coração do runtime (etapa, atribuição, aprovação, prazo, versão). Mitigação: transação por item, ordem de locks comum à tramitação, trigger que só permite mudar `workflowVersionId` com `app.migration_item_id`, simulação obrigatória, `expectedProcessStageIds` e testes de invariante antes/depois (nenhuma etapa ativa órfã, uma etapa ativa no destino, `dueAt` igual).
- **Compatibilidade (DEC-108):** endpoints novos (WF-35/WF-36); WF-27 e WF-32 ganham campos aditivos (`progress`, `result`, `errorCode`); `ProcessStageStatus.MIGRATED`, `MovementAction.MIGRATE` e `AssignmentType.MIGRATION` já previstos; consumidores (caixa, painel, analytics) precisam tratar `MIGRATED` (ADR-014: não conta como devolução).
- **Fila/worker:** job com `tenantId` na `meta`, `jobId` único por plano, retentativas com *backoff*, trava consultiva por plano; alerta de plano `RUNNING` sem progresso por 15 min; reentrega segura por idempotência de item.
- **Performance:** execução em série por plano para limitar carga no banco; lotes pequenos; sem N+1 nos itens; meta de vazão a calibrar (lacuna).
- **Dados:** sem backfill; migração de schema da US-126/US-127 já criou as tabelas; `Process.workflowVersionId` perde a imutabilidade sob o trigger controlado.
- **Observabilidade:** logs por item e por plano, métricas `workflow_migration_items_total{result}` e `workflow_migration_duration_seconds`.

## Backend
- **Módulo(s):** `process` (runner, itens, efeitos no runtime), `workflow` (definição de destino), `approval` (manter, cancelar e solicitar), `access` (`ProcessAccess`), `timeline`, `notification`, `audit`, `platform` (outbox, idempotência, fila), `analytics` (projeção).
- **Casos de uso:** `ExecuteWorkflowMigrationCommand` (pedido/retomada), `WorkflowMigrationRunner` (consumidor e job `workflow-migration-run`), `MigrateProcessItemCommand` (transação por item), `CompleteWorkflowMigrationCommand`, `GetMigrationProgressQuery`, `ExportMigrationReportQuery`.
- **Domínio:** `MigrationItemExecutor` (STALE/EXCLUDE/MIGRATE), `StageMigrationService` (fechar `MIGRATED`, abrir destino preservando prazo), `ApprovalMigrationPolicy` (manter/cancelar/re-solicitar), `ProcessStatusResolver` (RN-WF2-69), `BranchMigrationHandler` (RN-WF2-70), `MigrationLockManager` (trava por plano e ordem de locks).
- **Integrações internas:** `approval.requestApproval`/`cancelPendingForMigration`, `workflow` (definição), `organization` (unidade/titular), `timeline`, `notification`, `audit` (transacional), outbox.
- **Transação:** pedido = status + auditoria + outbox; item = locks + efeitos + movimento + auditoria + evento + `result`; conclusão = status + totals + auditoria + evento + notificação.

## Frontend
- **Tela(s):** SCR-118 (`/admin/workflows/[id]/migracoes/[migrationId]`) — fase **Execução** e **Relatório**.
- **Componentes:** `ExecutionPanel` (resumo, aviso "sem reversão", checkbox de ciência, `ExecuteButton` com step-up de MFA), `MigrationProgress` (barra `Progress` com `aria-valuenow`, contadores por resultado, "Atualizado há N s", polling de 5 s), `MigrationResultTable` (itens com link para o processo, chips `MIGRATED`/`EXCLUDED`/`FAILED`/`STALE`), `ResumeButton` (aparece após 5 min sem progresso), `MigrationReportCard` (totais, "Exportar CSV"), `ApprovalImpactNote`.
- **Estados:** loading (skeleton), vazio (sem itens `FAILED`/`STALE`: "Nenhuma pendência no relatório"), erro por bloco com "Tentar novamente", "Na fila", em execução (progresso), concluído (relatório), conflito (`ConflictDialog`), leitura para `WORKFLOW_VIEW`.
- **Acessibilidade e responsividade:** progresso anunciado por `aria-live="polite"` em marcos de 25%, resultados com ícone e texto, foco no relatório ao concluir, diálogo de confirmação com foco preso; abaixo de 768 px tabela em cartões; contraste AA.

## Banco de dados
- **Tabelas:** `workflow_migrations` (atualiza `status`, `started_at/by`, `completed_at`, `totals`), `workflow_migration_items` (atualiza `result`, `movement_id`, `error_code/message`, `executed_at`), `processes`, `process_stages` (`MIGRATED`), `process_assignments` (`MIGRATION`), `process_movements` (`MIGRATE`), `process_access`, `approvals`/`approval_approvers`, `process_branches`, `timeline_entries`, `audit_logs`, `outbox_events`.
- **Migrações:** expand já aplicada (enums `MIGRATED`/`MIGRATE`/`MIGRATION`, trigger de `workflow_version_id` com `app.migration_item_id`); esta story adiciona apenas o *seed* do job e as permissões de consulta/índice necessários; sem backfill.
- **Índices/constraints relevantes:** `unique (tenant_id, migration_id, process_id)`; `unique (tenant_id, source_workflow_version_id) WHERE status='RUNNING'`; check `result <> 'MIGRATED' OR movement_id IS NOT NULL`; índice `(tenant_id, migration_id, classification, result)` para `progress` e a lista; trigger de imutabilidade de `workflow_version_id` com exceção controlada.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| WF-35 | POST | `/workflows/{id}/migrations/{migrationId}/execute` | `{ simulationHash }`; `Idempotency-Key` e `If-Match` (primeira execução) obrigatórios; sobre plano `RUNNING` retoma (sem `If-Match`) | `202 { data: WorkflowMigration }` (`status = RUNNING`, `startedAt`, `progress`) + `Location` do plano | 202, 403 (`PERMISSION_DENIED`, `MFA_REQUIRED`), 404, 409 (`MIGRATION_NOT_SIMULATED`, `MIGRATION_SIMULATION_STALE`, `MIGRATION_ALREADY_RUNNING`, `MIGRATION_TARGET_NOT_PUBLISHED`, `MIGRATION_NOT_EDITABLE`), 412, 422 (`MIGRATION_DECISIONS_PENDING`, `MIGRATION_NOTHING_TO_MIGRATE`, `VALIDATION_ERROR`), 428, 503 |
| WF-27 | GET | `/workflows/{id}/migrations/{migrationId}` | — | MVP 2 da US-126 + `progress { total, pending, migrated, excluded, failed, stale, lastExecutedAt }` e `totals` finais; `Cache-Control: no-store` | 200, 403, 404 |
| WF-32 | GET | `/workflows/{id}/migrations/{migrationId}/items` | query da US-127 + `result` | itens com `result`, `errorCode`, `errorMessage`, `movementId`, `executedAt` | 200, 403, 404, 422 |
| WF-36 | GET | `/workflows/{id}/migrations/{migrationId}/items/export` | — (query `classification?`, `result?`) | `200 text/csv; charset=utf-8` com `Content-Disposition: attachment` (RN-WF2-78) | 200, 403, 404, 409 (`MIGRATION_NOT_SIMULATED`) |

## Logs
- `info` `workflow_migration.started` com `migrationId`, `itemsToMigrate`, `requestedById`, `correlationId`.
- `info` `workflow_migration.item_migrated` com `migrationId`, `itemId`, `processId`, `fromStageKeys`, `toStageKey`, `approvalsKept`, `approvalsCanceled`, `durationMs`.
- `info` `workflow_migration.item_excluded` / `item_stale` com `migrationId`, `itemId`, `errorCode`.
- `warn` `workflow_migration.item_failed` com `migrationId`, `itemId`, `errorCode`, `attempt`.
- `warn` `workflow_migration.stalled` quando um plano `RUNNING` passa de 15 min sem progresso.
- `info` `workflow_migration.completed` com `migrationId`, `totals`, `durationMs`.
- `error` `workflow_migration.runner_failed` com `correlationId` e causa técnica.
- Nunca logar: justificativas, títulos de processos, valores estimados (POL-09), tokens, ids de processo em massa (apenas por item).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow_migration.execute` | `CONFIGURATION` | Pedido (WF-35, ator = pessoa) e conclusão (`actorType = SYSTEM`, `metadata.phase = COMPLETED`) | `metadata`: `migrationId`, `simulationHash`, `itemsToMigrate`, `totals`, `idempotencyKey`, `resumed` |
| `process.workflow_migrate` | `WORKFLOW` (`actorType = SYSTEM`) | Cada processo migrado | `changes`: `workflowVersionId`, `currentStageId`, `status`; `metadata`: `migrationId`, `itemId`, `requestedById`, versões, mapa aplicado, decisão e justificativa (quando humana), `approvalsKept[]`, `approvalsCanceled[]` |
| `approval.cancel` (ação do MVP 1) | `WORKFLOW` | Aprovação incompatível cancelada | `metadata.reason = MIGRATION` |
| `workflow_migration.export` | `EXPORT` | WF-36 | `metadata`: `migrationId`, `rows`, filtros |
| `access.denied` | `ACCESS` | 403 | permissão exigida e rota |

## Testes necessários
- **Unitários:** `MigrationItemExecutor` (STALE por etapa/versão, EXCLUDE, MIGRATE, item já `MIGRATED`), `StageMigrationService` (prazo, pausa, marcadores de alerta preservados), `ApprovalMigrationPolicy` (manter × cancelar + re-solicitar × falha desfaz tudo), `ProcessStatusResolver` (tabela de status, suspenso), `BranchMigrationHandler`, `MigrationLockManager`, geração do CSV (BOM, neutralização de fórmulas).
- **Integração (Testcontainers):** execução ponta a ponta com 5 tipos de processo; **invariantes pós-migração** (uma etapa ativa, `dueAt` igual, uma `ProcessAssignment` ativa, movimento único, `workflowVersionId` do destino, nenhuma aprovação `PENDING` órfã); rollback por item em falha no meio; trigger só aceita mudar a versão com `app.migration_item_id`; unique de plano `RUNNING`; reentrega do job; retomada; outbox com Redis indisponível.
- **API/contrato:** WF-35, WF-27 (`progress`), WF-32, WF-36 contra o OpenAPI; erros `MIGRATION_*`; `Idempotency-Key`/`If-Match`; ausência de valores monetários; contrato de `process.workflow_migrated`.
- **RBAC e multi-tenant:** `WORKFLOW_MIGRATE` × `WORKFLOW_VIEW`, MFA sempre, job com `meta.tenantId` nunca processando itens de outro tenant; arquivo novo na suíte `test/tenant-leak` (executar, acompanhar, exportar e runner entre tenants).
- **Concorrência:** migração × tramitação do mesmo processo (lock ordenado, sem deadlock, `STALE`), dois planos na mesma origem, duas instâncias do runner (trava consultiva), execução repetida do cenário 20× para flakiness.
- **E2E (Playwright):** simular, decidir, executar, acompanhar o progresso, ver o relatório e exportar o CSV; abrir o processo migrado e ver a timeline; fluxo "Retomar".
- **Acessibilidade/performance:** axe na fase Execução/Relatório; vazão de 2.000 itens (teste de performance escrito, meta a calibrar no endurecimento); sem N+1 por item; contador de queries por item.

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
- [ ] Teste de invariantes pós-migração e de rollback por item estáveis
- [ ] Alerta `workflow_migration.stalled` e métricas do runner configurados
- [ ] Dúvidas de produto (`RETURNED` × "Devolvidos", `actorType`, bloqueio de aposentar o destino) respondidas ou registradas no card 9

## Estimativa
**L** — o efeito mais sensível do MVP 2 sobre o runtime: runner assíncrono idempotente com trava e ordem de locks, transformação de etapa/atribuição/aprovação/prazo/status por item (inclusive ramos e suspensão), tratamento de `STALE`/`FAILED`, relatório, acompanhamento e muita bateria de invariantes e concorrência.

## Prioridade
**P0** — fecha a DT-02 (DEC-192): sem execução auditada os pilotos não levam os processos do MVP 1 à fase preparatória completa sem redigitar, e a oferta da v2 do padrão (US-130/US-131) fica sem efeito prático.
