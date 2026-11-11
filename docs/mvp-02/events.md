# MVP 2 — Eventos de Domínio

> **Documento canônico** dos eventos do MVP 2: nomes, routing keys, produtores, payloads, consumidores, projeção na timeline, notificações, lembretes e ações de auditoria. Estende [mvp-01/events.md](../mvp-01/events.md): convenções, envelope (DEC-160), outbox na mesma transação (DEC-161), nomes especializados (DEC-162) e regras de versionamento continuam valendo.
> Decisões: [DEC-193 a DEC-209](../architecture/decisions.md#mvp-2--governança-e-controle) · [ADR-014](../adr/adr-014-indicators-read-model.md) (read model) · [ADR-015](../adr/adr-015-rules-engine-sla-notifications.md) (SLA e notificação condicional). Entidades: [entities.md](entities.md).

Sumário: [1. Convenções](#1-convenções) · [2. Mudanças aditivas](#2-mudanças-aditivas-em-eventos-do-mvp-1) · [3. Consumidores](#3-consumidores-novos) · [4. Catálogo](#4-catálogo-de-eventos) · [5. Timeline](#5-projeção-na-timeline) · [6. Notificações](#6-notificações-e-lembretes) · [7. Auditoria](#7-catálogo-de-ações-de-auditoria) · [8. Tabela consolidada](#8-evento--timeline--notificação--auditoria) · [9. Versionamento](#9-versionamento)

---

## 1. Convenções

- Iguais às do MVP 1 ([§1](../mvp-01/events.md#1-convenções)): nome PascalCase no passado, routing key `<agregado>.<fato>` em snake_case, payload só com ids e o mínimo necessário, **sem** valores de orçamento sigiloso, conteúdo de documento (parecer, edital, manifestação), texto de diligência, ressalva ou achado, nem CPF/identificador gov.br.
- Agregados novos e prefixos de routing key: `pca.*`, `budget_allocation.*`, `legal_review.*`, `internal_control_review.*`, `tender.*`, `workflow_migration.*`, `rule.*`, `sla_policy.*`, `notification_rule.*`, `analytics.*`, `support_access.*`, `identity.*`. Documentos dos tipos novos usam os eventos genéricos com `<type>` = `parecer_juridico`, `edital`, `minuta_contrato`, `manifestacao_controle_interno`.
- Eventos são registrados aqui e em `packages/types/src/events.ts` **antes** de serem produzidos (D8); o CI valida.
- **Notificável por regra** (coluna NR): o evento pode ser origem de `NotificationRule` (DEC-205). Só eventos com `processId` e sem dado sensível no payload são elegíveis.

## 2. Mudanças aditivas em eventos do MVP 1

Campos opcionais novos — **mesma `eventVersion`** (regra do MVP 1, §8):

| Evento | Acréscimo | Motivo |
|---|---|---|
| `ProcessStageChanged` | `branchKey?`, `splitProcessStageId?`, `activeStageIds[]` (após o fato); `cause` aceita `MIGRATE` e `SKIP` só nos eventos próprios (abaixo) — **não** neste | Paralelismo (DEC-194) |
| `ProcessCreated` | `pcaItemId?` | PCA (DEC-197) |
| `ProcessStageDueSoon` / `ProcessStageOverdue` | `branchKey?`, `slaPolicyKey?`, `escalationLevel?` | SLA (DEC-205) |
| `ApprovalRequested` | `decisionPolicy`, `approvers[]` (`{ approvalApproverId, sequence, approverType, approverUserId?, approverRoleId?, approverDepartmentId?, allowDeputy, status }` — `allowDeputy` acrescentado na US-133: o substituto é avisado e recebe `APPROVER` por linha), `pcaId?`, `thresholdResolution?`; `subjectType` aceita `PCA`. Os dois campos da US-133 são opcionais no esquema (eventos do MVP 1 no outbox) e sempre gravados nas solicitações novas | Aprovação múltipla e PCA (DEC-193, DEC-197) |
| `ApprovalCompleted` / `ApprovalReturned` / `ApprovalRejected` | `decisionPolicy`, `decidingApprovalApproverId`, `votes[]` (`{ sequence, decision, decidedById, decidedAsDeputy }`), `pcaId?` | Idem |
| `ApprovalCanceled` | `reason` aceita `BRANCH_CANCELED`, `MIGRATION` | Paralelismo e migração |
| `ApprovalReassigned` | `approvalApproverId?`, `sequence?` | Redirecionamento por linha |
| `DocumentFinalized` (`parecer_juridico`) | `typedSummary: { legalReviewId, round }` (sem a situação) | Parecer |
| `AiGeneration*`, `AiContent*` | `targetModule` aceita `LEGAL_OPINION`, `TENDER`; `<type>` aceita `parecer_juridico`, `edital` | IA (DEC-202) |

## 3. Consumidores novos

Legenda **Cons.** (além da do MVP 1 — T, A, N, C, M, E): **R** = projetor do read model (`AnalyticsProjector`), **P** = acompanhamento da execução do PCA (`PcaExecutionTracker`), **S** = reavaliação de SLA (`SlaEvaluator`), **NR** = regras de notificação (`NotificationRuleDispatcher`), **X** = reconciliação do PCA (`PcaReconciliationScheduler`).

| Consumidor | Dono | Fila | Assina | Idempotência |
|---|---|---|---|---|
| `AnalyticsProjector` | `analytics` | `analytics` (nova) | `process.*`, `approval.*`, `document.*`, `pca.*`, `legal_review.*`, `internal_control_review.*`, `budget_allocation.*`, `workflow_migration.*` | `analytics_processed_events (tenant_id, event_id)` + projeção por chave natural (ADR-014) |
| `PcaExecutionTracker` | `pca` | `domain-events` (handler leve) | `process.created`, `process.pca_item_linked`, `process.status_changed.*`, `dfd.pca_item_linked` | Lê o estado atual (contagem por item) e grava só se mudou |
| `PcaReconciliationScheduler` | `pca` | `maintenance` | `pca.status_changed.approved` | Uma execução `RUNNING` por plano (unique) |
| `SlaEvaluator` | `process` (consulta `sla`) | `deadlines` | `legal_review.diligence_requested`, `legal_review.resumed`, `sla_policy.changed` | Recalcula pausas e degraus pelo estado atual; degrau já disparado (`escalationLevel`) não repete |
| `NotificationRuleDispatcher` | `notification` | `notifications` | Eventos marcados NR | `notification_rule_executions (tenant_id, rule_id, source_event_id)` |
| `PermissionCacheInvalidator` (MVP 1) | `access` | `domain-events` | + `role.reactivated`, `support_access.*` | DEL de chave |

Síncronos (mesma transação): `TimelineProjector` e `ProcessAccessProjector` passam a tratar os eventos novos de processo, aprovação, jurídico, Controle Interno, edital e dotação marcados **T**/**A**.

---

## 4. Catálogo de eventos

### 4.1 Processo e workflow v2 (módulo `process`)
| Evento | Routing key | Produtor | Payload (além do envelope) | Cons. |
|---|---|---|---|---|
| `ProcessBranchesOpened` | `process.branches_opened` | Entrada em `PARALLEL_SPLIT` (DEC-194) | `movementId`, `splitProcessStageId`, `splitStageKey`, `branches[]` (`{ branchKey, processStageId, stageKey, departmentId, toUserId?, dueAt? }`) | T A N R NR |
| `ProcessBranchArrived` | `process.branch_arrived` | Conclusão da última etapa do ramo | `splitProcessStageId`, `branchKey`, `movementId`, `openBranchesLeft` | T R |
| `ProcessBranchesJoined` | `process.branches_joined` | Último ramo chega ao `PARALLEL_JOIN` | `splitProcessStageId`, `joinProcessStageId`, `nextStage { processStageId, key, type }`, `toDepartmentId` | T A N R NR |
| `ProcessBranchesCanceled` | `process.branches_canceled` | `RETURN` para antes da ramificação | `splitProcessStageId`, `canceledBranchKeys[]`, `canceledApprovalIds[]`, `movementId` | T A R |
| `ProcessStageSkipped` | `process.stage_skipped` | Etapa com `applicabilityRule` falsa (DEC-204) | `processStageId`, `stageKey`, `ruleRef { mode, ruleDefinitionVersionId? }`, `contextVersion`, `movementId` (sem o valor avaliado quando sigiloso) | T R NR |
| `ProcessWorkflowMigrated` | `process.workflow_migrated` | Execução de `WorkflowMigrationItem` (DEC-195) | `migrationId`, `migrationItemId`, `fromWorkflowVersionId`, `toWorkflowVersionId`, `fromVersionNumber`, `toVersionNumber`, `fromStageKeys[]`, `toStageKeys[]`, `movementId`, `approvalsCanceled[]`, `approvalsKept[]`, `statusFrom`, `statusTo` | T A N R |
| `ProcessPcaItemLinked` | `process.pca_item_linked` | Cadastro, propagação do DFD ou reconciliação (DEC-197) | `pcaItemId`, `pcaId`, `pcaItemCode`, `via` (`CREATE`, `UPDATE`, `DFD`, `RECONCILIATION`, `MANUAL`), `previousPcaItemId?` | T P R |
| `ProcessPcaItemUnlinked` | `process.pca_item_unlinked` | Desvinculação manual | `pcaItemId`, `hasReason` | T P R |
| `ProcessStageSlaPaused` | `process.stage_sla_paused` | `SlaEvaluator` (pausa por condição) | `processStageId`, `stageKey`, `reason` (`SlaPauseReason`), `pausedAt` | T R |
| `ProcessStageSlaResumed` | `process.stage_sla_resumed` | `SlaEvaluator` | `processStageId`, `stageKey`, `reason`, `pausedSeconds`, `newDueAt` | T R |
| `ProcessStageEscalated` | `process.stage_escalated` | Job `deadlines` (degrau de `SlaEscalationStep`) | `processStageId`, `stageKey`, `branchKey?`, `slaPolicyKey`, `level`, `dueAt`, `overdueBusinessDays`, `notifyTargets[]` (papéis, não pessoas) | T N R NR |

### 4.2 PCA (módulo `pca`)
| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `PcaCreated` | `pca.created` | Criar plano (versão 1) | `pcaId`, `organizationId`, `year` | M |
| `PcaRevisionCreated` | `pca.revision_created` | Criar revisão de plano aprovado | `pcaId`, `previousVersionId`, `versionNumber`, `itemsCopied` | M |
| `PcaImported` | `pca.imported` | Importação de planilha | `pcaId`, `attachmentId`, `rowsRead`, `itemsCreated`, `itemsUpdated`, `rowsRejected` | N (`PCA_IMPORT_FINISHED`) |
| `PcaItemChanged` | `pca.item_changed` | Edição de item / acompanhamento | `pcaId`, `pcaItemId`, `code`, `change` (`CREATED`, `UPDATED`, `STATUS_CHANGED`, `DELETED`), `status`, `changedFields[]` | R |
| `PcaStatusChanged` | `pca.status_changed.<status>` | Envio, decisão, retirada, substituição | `pcaId`, `organizationId`, `year`, `versionNumber`, `fromStatus`, `toStatus`, `approvalId?` | N R X |
| ↳ `PcaApproved` | `pca.status_changed.approved` | especialização | — | — |
| `PcaReconciliationCompleted` | `pca.reconciliation_completed` | Job de reconciliação | `pcaId`, `runId`, `trigger`, `linkedCount`, `unresolvedCount`, `ambiguousCount` | N |
| `PcaReferenceConciliated` | `pca.reference_conciliated` | Conciliação manual | `runId`, `entryId`, `targetType`, `targetId`, `action` (`LINK`/`NO_ITEM`), `pcaItemId?` | — |
| `DfdPcaItemLinked` | `dfd.pca_item_linked` | Vínculo do DFD a item do PCA (US-142/US-143) | `dfdId`, `processId`, `pcaItemId`, `via` | `PcaExecutionTracker` |
| `DfdPcaItemUnlinked` | `dfd.pca_item_unlinked` | Desvínculo/troca do item no DFD (US-142) | `dfdId`, `processId`, `pcaItemId` | `PcaExecutionTracker` |

### 4.3 Aprovação (módulo `approval`)
| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `ApprovalVoteRecorded` | `approval.vote_recorded` | Decisão positiva de linha que não encerra (`ALL`/`SEQUENTIAL`) | `approvalId`, `approvalApproverId`, `sequence`, `decidedById`, `decidedAsDeputy`, `remainingPending`, `remainingWaiting` | T N R |
| `ApprovalApproverActivated` | `approval.approver_activated` | `SEQUENTIAL`: próxima linha passa a `PENDING` | `approvalId`, `approvalApproverId`, `sequence`, `approverType`, `approverUserId?`, `approverRoleId?`, `approverDepartmentId?`, `allowDeputy`, `dueAt?` | T A N |

`ApprovalRequested`, `ApprovalCompleted`, `ApprovalReturned`, `ApprovalRejected`, `ApprovalCanceled` e `ApprovalReassigned` continuam como no MVP 1, com os acréscimos da §2. Aprovações de assunto `PCA` têm `processId` nulo no envelope.

### 4.4 Dotação orçamentária (módulo `budget`)
| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `BudgetAllocationCreated` | `budget_allocation.created` | Indicar dotação | `budgetAllocationId`, `fiscalYear`, `expenseNatureCode`, `fundingSourceCode` (sem valor) | T R |
| `BudgetAllocationUpdated` | `budget_allocation.updated` | Editar rascunho | `budgetAllocationId`, `changedFields[]` | — |
| `BudgetAllocationConfirmed` | `budget_allocation.confirmed` | Confirmar reserva | `budgetAllocationId`, `fiscalYear`, `hasEvidence: true`, `coverageReached: boolean` (sem valores) | T N R NR |
| `BudgetAllocationCanceled` | `budget_allocation.canceled` | Cancelar | `budgetAllocationId`, `fromStatus`, `hasReason`, `coverageReached` | T N R NR |

### 4.5 Análise jurídica (módulo `legal-review`)
| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `LegalReviewOpened` | `legal_review.opened` | Entrada em `JURIDICO` (`StageLifecycleListener`) | `legalReviewId`, `sequence`, `processStageId`, `queuePriorityScore`, `enteredQueueAt` | T N R |
| `LegalReviewAssigned` | `legal_review.assigned` | Distribuição pelo chefe da assessoria | `legalReviewId`, `fromUserId?`, `toUserId` | T N |
| `LegalReviewStarted` | `legal_review.started` | Início da análise | `legalReviewId`, `round`, `documentVersionIds[]` (rodada) | T R |
| `LegalReviewDiligenceRequested` | `legal_review.diligence_requested` | Pedido de diligência (com `RETURN` do processo) | `legalReviewId`, `diligenceId`, `round`, `returnStageKey`, `movementId`, `dueAt?` (sem o texto) | T N R S NR |
| `LegalReviewDiligenceReminderDue` | `legal_review.diligence_reminder_due` | Job `deadlines` (antes do prazo e no vencimento) | `legalReviewId`, `diligenceId`, `dueAt`, `businessDaysLeft`, `assigneeId?`, `departmentId` | N |
| `LegalReviewResumed` | `legal_review.resumed` | Processo volta a `JURIDICO` | `legalReviewId`, `diligenceId`, `round`, `processStageId`, `documentVersionIds[]` | T N R S |
| `LegalReviewConcluded` | `legal_review.concluded` | Conclusão | `legalReviewId`, `status` (`FAVORABLE`, `FAVORABLE_WITH_RESERVATIONS`, `UNFAVORABLE`), `round`, `opinionDocumentVersionId`, `reservationsCount` | T N R NR |
| `LegalReviewWaived` | `legal_review.waived` | Dispensa (art. 53, § 5º) | `legalReviewId`, `waiverHypothesisCode` | T N R NR |
| `LegalReviewCanceled` | `legal_review.canceled` | Processo/ramo cancelado | `legalReviewId`, `reason` (`PROCESS_CANCELED`, `BRANCH_CANCELED`, `MIGRATION`) | T R |
| `LegalReservationResolved` | `legal_review.reservation_resolved` | Ressalva atendida ou risco aceito | `legalReviewId`, `reservationId`, `status` (`ADDRESSED`, `RISK_ACCEPTED`) | T |

Nome especializado exigido pelo produto: `LegalOpinionIssued` = `DocumentFinalized` (`PARECER_JURIDICO`) — `document.finalized.parecer_juridico`.

### 4.6 Controle Interno (módulo `internal-control`)
| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `InternalControlReviewOpened` | `internal_control_review.opened` | Entrada em `CONTROLE_INTERNO` | `reviewId`, `sequence`, `processStageId`, `checklistKey`, `checklistVersion` | T N R |
| `InternalControlReviewStarted` | `internal_control_review.started` | Início | `reviewId`, `round` | T R |
| `InternalControlFindingRecorded` | `internal_control_review.finding_recorded` | Achado registrado | `reviewId`, `findingId`, `sequence`, `severity`, `checklistItemKey?` (sem texto) | — |
| `InternalControlFindingResolved` | `internal_control_review.finding_resolved` | Atendimento / risco aceito / cancelado | `reviewId`, `findingId`, `status` | T |
| `InternalControlReviewConcluded` | `internal_control_review.concluded` | Conclusão | `reviewId`, `status`, `round`, `reportDocumentVersionId`, `findingsCount`, `highOrCriticalCount` | T N R NR |
| `InternalControlReviewCanceled` | `internal_control_review.canceled` | Processo/ramo cancelado | `reviewId`, `reason` | T R |
| `InternalControlChecklistPublished` | `internal_control_review.checklist_published` | Publicar versão de checklist | `checklistId`, `key`, `versionNumber`, `itemsCount` | C |

Nome especializado: `InternalControlReportIssued` = `DocumentFinalized` (`MANIFESTACAO_CONTROLE_INTERNO`) — `document.finalized.manifestacao_controle_interno`.

### 4.7 Edital (módulo `tender`) e documentos novos
| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `TenderCreated` | `tender.created` | Criar minuta | `tenderId`, `documentId`, `contractDraftDocumentId?`, `modalityCode`, `judgmentCriterionCode` | T R |
| `TenderUpdated` | `tender.updated` | Editar cabeçalho | `tenderId`, `changedFields[]` | — |
| `TenderImportedFromTerm` | `tender.imported_from_term` | Importar do TR | `tenderId`, `termDocumentVersionId`, `sectionsImported[]`, `itemsImported`, `lotsCreated` | T |
| `TenderLotsChanged` | `tender.lots_changed` | Gerenciar lotes | `tenderId`, `lotsCount`, `itemsUnassigned` | — |
| `TenderRiskAllocationChanged` | `tender.risk_allocation_changed` | Matriz de riscos | `tenderId`, `allocationsCount`, `change` (`CREATED`, `UPDATED`, `DELETED`) | — |

Os documentos `EDITAL`, `MINUTA_CONTRATO`, `PARECER_JURIDICO` e `MANIFESTACAO_CONTROLE_INTERNO` usam os eventos genéricos `Document*` do MVP 1 (`document.<fato>.<type>`). Nome especializado: `TenderDraftCompleted` = `DocumentFinalized` (`EDITAL`) — `document.finalized.edital`.

### 4.8 Configuração: workflow, migração, regras, SLA e notificação
| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `WorkflowSeedVersionOffered` | `workflow.seed_version_offered` | Seeder (DEC-196) | `workflowId`, `seedKey`, `offeredSeedVersion` | N |
| `WorkflowSeedVersionAdopted` | `workflow.seed_version_adopted` | Publicação automática ou adoção pelo administrador | `workflowId`, `workflowVersionId`, `seedVersion`, `automatic` | C |
| `WorkflowMigrationSimulated` | `workflow_migration.simulated` | Simulação (DEC-195) | `migrationId`, `sourceWorkflowVersionId`, `targetWorkflowVersionId`, `totals { automatic, needsDecision, blocked }` | — |
| `WorkflowMigrationStarted` | `workflow_migration.started` | Execução pedida | `migrationId`, `itemsToMigrate` | — |
| `WorkflowMigrationCompleted` | `workflow_migration.completed` | Fim da execução | `migrationId`, `totals { migrated, excluded, failed, stale }` | N |
| `WorkflowMigrationCanceled` | `workflow_migration.canceled` | Cancelamento do plano | `migrationId`, `hasReason` | — |
| `RuleVersionPublished` | `rule.version_published` | Publicar versão de regra | `ruleDefinitionId`, `key`, `kind`, `ruleDefinitionVersionId`, `versionNumber`, `contextVersion`, `expressionHash` | C |
| `RuleVersionRetired` | `rule.version_retired` | Aposentar | `ruleDefinitionId`, `ruleDefinitionVersionId` | C |
| `SlaPolicyChanged` | `sla_policy.changed` | Criar/editar/ativar/desativar política | `slaPolicyId`, `key`, `change` (`CREATED`, `UPDATED`, `ACTIVATED`, `DEACTIVATED`) | C S |
| `NotificationRuleChanged` | `notification_rule.changed` | Criar/editar/ativar/desativar | `notificationRuleId`, `eventType`, `change` | C |
| `NotificationRuleAutoDisabled` | `notification_rule.auto_disabled` | `NotificationRuleDispatcher` (limite estourado) | `notificationRuleId`, `eventType`, `windowCount`, `limit` | N |

### 4.9 Plataforma, identidade, acesso e auditoria
| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `GovbrIdentityLinked` | `identity.govbr_linked` | Vínculo em "Meu perfil" ou por CPF (DEC-207) | `userId`, `linkMethod`, `trustLevel` | N |
| `GovbrIdentityUnlinked` | `identity.govbr_unlinked` | Desvincular | `userId`, `byOperator: boolean` | N |
| `SupportAccessGranted` | `support_access.granted` | Backoffice (DEC-208) | `grantId`, `membershipId`, `operatorUserId`, `roleKey`, `expiresAt`, `ticketReference` | C N |
| `SupportAccessEnded` | `support_access.ended` | Encerramento manual ou expiração | `grantId`, `membershipId`, `reason` (`ENDED`, `EXPIRED`) | C N |
| `RoleReactivated` | `role.reactivated` | Reativar perfil (DT-13) | `roleId`, `key` | C |
| `AuditSealBroken` | `audit.seal_broken` | Verificação da cadeia de selos (DT-14) | `sealId`, `periodStart`, `periodEnd`, `detectedAt`, `check` (`DIGEST`, `CHAIN`) | N |
| `TemplateLibraryUpdateAvailable` | `template.library_update_available` | Seeder da biblioteca (DT-15) | `libraryVersion`, `templatesChanged[]` (`{ libraryKey, documentTypeCode }`) | N |
| `TemplateLibraryUpdateAdopted` | `template.library_update_adopted` | Adoção assistida | `templateId`, `templateVersionId`, `libraryKey`, `libraryVersion` | C |

`TenantSettingsChanged` (MVP 1) cobre `auth.govbrEnabled`, `inbox.bulkMaxItems` e as demais chaves novas.

### 4.10 Read model (módulo `analytics`)
| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `AnalyticsReconciliationCompleted` | `analytics.reconciliation_completed` | Job noturno / reconstrução | `runId`, `scope`, `factsChecked`, `divergencesFixed` | M |
| `ReportExportFinished` | `analytics.report_export_finished` | Job `exports` — conclusão do pedido de exportação de relatório (`READY`, `FAILED` ou `EXPIRED` por timeout) (US-174) | `exportId`, `reportKey`, `format`, `status`, `requestedById`, `errorCode?` — sem valores, filtros em claro nem nomes | N |

Divergência acima do limite operacional gera alerta (observability.md), não notificação de usuário.

---

## 5. Projeção na timeline

Tipos novos do registro `TimelineEntryType` (mesmas regras do MVP 1: `params` congelados no fato, unicidade por (`sourceEventId`, `type`), dicionário em `packages/types/src/timeline-messages.ts` e grupo em `TIMELINE_GROUP_TYPES`).

| `type` | Evento de origem | Mensagem (pt-BR) | `params` principais | Visibilidade |
|---|---|---|---|---|
| `BRANCHES_OPENED` | `ProcessBranchesOpened` | "Processo seguiu em paralelo para {branchesLabel}" | `branches[] { stageName, departmentName }` | STANDARD |
| `BRANCH_ARRIVED` | `ProcessBranchArrived` | "Ramo {stageName} concluído — aguardando {openBranchesLeft} ramo(s)" | `stageName`, `openBranchesLeft` | STANDARD |
| `BRANCHES_JOINED` | `ProcessBranchesJoined` | "Ramos paralelos concluídos; processo seguiu para {toStageName}" | `toStageName`, `toDepartmentName` | STANDARD |
| `BRANCHES_CANCELED` | `ProcessBranchesCanceled` | "Ramos paralelos cancelados pela devolução para {toStageName}" | `branchesLabel`, `toStageName` | STANDARD |
| `STAGE_SKIPPED` | `ProcessStageSkipped` | "Etapa {stageName} dispensada pela regra {ruleLabel}" | `stageName`, `ruleLabel` | STANDARD |
| `WORKFLOW_MIGRATED` | `ProcessWorkflowMigrated` | "Processo migrado da versão {fromVersion} para a versão {toVersion} do workflow" | `fromVersion`, `toVersion`, `fromStageNames[]`, `toStageNames[]`, `workflowName` | STANDARD |
| `PCA_ITEM_LINKED` | `ProcessPcaItemLinked` / `ProcessPcaItemUnlinked` | "Processo vinculado ao item {pcaItemCode} do PCA {year}" / "Vínculo com o item {pcaItemCode} do PCA removido" | `pcaItemCode`, `year`, `via` | STANDARD |
| `SLA_PAUSED` / `SLA_RESUMED` | `ProcessStageSlaPaused` / `Resumed` | "Prazo da etapa {stageName} pausado ({reasonLabel})" / "Prazo retomado; novo vencimento {dueAt}" | `stageName`, `reason`, `dueAt?` | STANDARD |
| `STAGE_ESCALATED` | `ProcessStageEscalated` | "Prazo da etapa {stageName}: escalonamento nível {level}" | `stageName`, `level` | STANDARD |
| `APPROVAL_VOTE_RECORDED` | `ApprovalVoteRecorded` | "{actor} aprovou ({votesLabel}) — {title}" | `sequence`, `remainingPending`, `asDeputy` | STANDARD |
| `APPROVAL_TURN` | `ApprovalApproverActivated` | "Aprovação passou para {approverLabel}" | `approverLabel`, `sequence` | STANDARD |
| `BUDGET_ALLOCATION_ADDED` | `BudgetAllocationCreated` | "{actor} indicou dotação ({expenseNatureLabel} · fonte {fundingSourceLabel})" | rótulos dos catálogos | STANDARD |
| `BUDGET_ALLOCATION_CONFIRMED` / `_CANCELED` | `BudgetAllocation*` | "{actor} confirmou/cancelou a dotação (reserva {reservationNumber})" | `reservationNumber`, `coverageReached` | STANDARD; `BUDGET_RESTRICTED` se incluir valor |
| `LEGAL_REVIEW_OPENED` | `LegalReviewOpened` | "Processo entrou na fila do Jurídico" | — | STANDARD |
| `LEGAL_REVIEW_ASSIGNED` | `LegalReviewAssigned` | "{actor} distribuiu a análise jurídica a {toUserName}" | `toUserName` | STANDARD |
| `LEGAL_REVIEW_STARTED` | `LegalReviewStarted` / `LegalReviewResumed` | "{actor} iniciou a análise jurídica" / "Análise jurídica retomada (rodada {round})" | `round` | STANDARD |
| `LEGAL_DILIGENCE_REQUESTED` | `LegalReviewDiligenceRequested` | "{actor} pediu diligência e devolveu para {returnStageName}" | `returnStageName`, `round`, `dueAt?` | STANDARD |
| `LEGAL_REVIEW_CONCLUDED` | `LegalReviewConcluded` | "Parecer jurídico: {outcomeLabel}" | `outcome`, `reservationsCount`, `documentCode` | STANDARD |
| `LEGAL_REVIEW_WAIVED` | `LegalReviewWaived` | "Análise jurídica dispensada ({hypothesisLabel})" | `hypothesisLabel` | STANDARD |
| `LEGAL_RESERVATION_RESOLVED` | `LegalReservationResolved` | "Ressalva {sequence} do parecer {statusLabel}" | `sequence`, `status` | STANDARD |
| `INTERNAL_CONTROL_OPENED` | `InternalControlReviewOpened` | "Processo entrou na análise do Controle Interno" | `checklistName` | STANDARD |
| `INTERNAL_CONTROL_CONCLUDED` | `InternalControlReviewConcluded` | "Manifestação do Controle Interno: {outcomeLabel}" | `outcome`, `findingsCount` | STANDARD |
| `INTERNAL_CONTROL_FINDING_RESOLVED` | `InternalControlFindingResolved` | "Achado {sequence} do Controle Interno {statusLabel}" | `sequence`, `status` | STANDARD |
| `TENDER_CREATED` | `TenderCreated` | "{actor} criou a minuta do edital" | `documentCode` | STANDARD |
| `TENDER_IMPORTED_FROM_TERM` | `TenderImportedFromTerm` | "{actor} importou dados do TR (v{termVersion}) para o edital" | `termVersion`, `sectionsCount`, `lotsCreated` | STANDARD |

Mudanças em tipos do MVP 1: `PROCESS_COMPLETED` passa a renderizar o **nome da etapa `END`** da versão do processo ("Planejamento da contratação concluído" na v1; "Fase preparatória concluída" na v2 — DEC-196), gravado em `params.endStageName`; `PROCESS_FORWARDED`/`PROCESS_RETURNED`/`PROCESS_STAGE_CHANGED` ganham `params.branchLabel?`. Grupos de filtro novos: "PCA e orçamento", "Jurídico", "Controle Interno", "Edital" e "Prazos"; `WORKFLOW_MIGRATED`, `STAGE_SKIPPED` e `BRANCHES_*` entram em "Tramitação".

---

## 6. Notificações e lembretes

Tipos novos do registro `NotificationType` (regras gerais do MVP 1 continuam: nunca notificar o próprio ator, agrupamento de 5 min, sem dado sigiloso, máx. 50 destinatários por unidade/perfil, preferências do usuário — US-113).

| `NotificationType` | Origem | Destinatários | E-mail padrão | Obrigatória |
|---|---|---|---|---|
| `APPROVAL_REQUESTED` *(MVP 1, uso ampliado)* | `ApprovalRequested` (linhas `PENDING`) e `ApprovalApproverActivated` | Aprovador de cada linha `PENDING` (titular + substituto se `allowDeputy`; `ROLE` como no MVP 1) | ✔ | **sim** (in-app) |
| `APPROVAL_VOTE_RECORDED` | `ApprovalVoteRecorded` | Solicitante | não | não |
| `PARALLEL_BRANCH_RECEIVED` | `ProcessBranchesOpened` | Responsável/unidade de cada ramo (como `PROCESS_RECEIVED`) | ✔ | não |
| `PARALLEL_BRANCHES_JOINED` | `ProcessBranchesJoined` | Destino da etapa seguinte (como `PROCESS_RECEIVED`) | ✔ | não |
| `PROCESS_MIGRATED` | `ProcessWorkflowMigrated` | Responsáveis das etapas ativas de destino; criador do processo | não | não |
| `WORKFLOW_MIGRATION_FINISHED` | `WorkflowMigrationCompleted` | Quem iniciou a execução (exceção: trabalho assíncrono pedido pelo próprio usuário) | ✔ | não |
| `WORKFLOW_VERSION_OFFERED` | `WorkflowSeedVersionOffered` | Vínculos com `WORKFLOW_PUBLISH` (máx. 50) | ✔ | não |
| `PCA_APPROVAL_DECIDED` | `PcaStatusChanged` (`APPROVED` ou volta a `DRAFT` por decisão) | Quem enviou; vínculos com `PCA_MANAGE` no órgão (máx. 50) | ✔ | não |
| `PCA_IMPORT_FINISHED` | `PcaImported` | Quem importou (exceção: trabalho assíncrono do próprio usuário) | não | não |
| `PCA_RECONCILIATION_PENDING` | `PcaReconciliationCompleted` com `unresolvedCount + ambiguousCount > 0` | Vínculos com `PCA_RECONCILE` no órgão (máx. 50) | ✔ | não |
| `BUDGET_ALLOCATION_CONFIRMED` | `BudgetAllocationConfirmed` | Responsável da etapa `DOTACAO` (se ≠ ator) e criador do processo | não | não |
| `BUDGET_ALLOCATION_CANCELED` | `BudgetAllocationCanceled` (de `CONFIRMED`) | Responsáveis das etapas ativas; gestor (`PROCESS_ASSIGN` no escopo) | ✔ | não |
| `LEGAL_REVIEW_QUEUED` | `LegalReviewOpened` | Titular e substituto da unidade jurídica da etapa | não | não |
| `LEGAL_REVIEW_ASSIGNED` | `LegalReviewAssigned` | Procurador designado | ✔ | não |
| `LEGAL_DILIGENCE_REQUESTED` | `LegalReviewDiligenceRequested` | Responsável (ou unidade) da etapa de devolução; criador do processo | ✔ | **sim** (in-app) |
| `LEGAL_DILIGENCE_REMINDER` | `LegalReviewDiligenceReminderDue` (lembrete antes do prazo e no vencimento) | Responsável da etapa de devolução; titular da unidade no vencimento | ✔ | não |
| `LEGAL_DILIGENCE_ANSWERED` | `LegalReviewResumed` | Procurador designado | ✔ | não |
| `LEGAL_REVIEW_CONCLUDED` | `LegalReviewConcluded`, `LegalReviewWaived` | Criador do processo; responsável da etapa seguinte; titular da secretaria solicitante | ✔ | não |
| `INTERNAL_CONTROL_QUEUED` | `InternalControlReviewOpened` | Titular e substituto da unidade do Controle Interno | não | não |
| `INTERNAL_CONTROL_CONCLUDED` | `InternalControlReviewConcluded` | Criador do processo; responsável da etapa seguinte; titular da secretaria solicitante | ✔ | não |
| `SLA_ESCALATION` | `ProcessStageEscalated` | Os papéis do degrau (`SlaEscalationStep.notify`): responsável, titular/substituto da unidade, gestor, titular da secretaria solicitante | ✔ | não |
| `RULE_NOTIFICATION` | Qualquer evento NR via `NotificationRule` | Conforme `NotificationRecipientSpec`; título/corpo do modelo da regra; `groupKey = rule:{ruleId}:{processId}` | conforme a regra | não |
| `NOTIFICATION_RULE_DISABLED` | `NotificationRuleAutoDisabled` | Vínculos com `NOTIFICATION_RULE_MANAGE` (máx. 50) | ✔ | não |
| `AUDIT_SEAL_BROKEN` | `AuditSealBroken` (DT-14) | Vínculos ativos com `ADMIN_ORGAO` e `AUDITOR` | ✔ | **sim** |
| `SUPPORT_ACCESS_GRANTED` | `SupportAccessGranted` / `SupportAccessEnded` | Vínculos com `ADMIN_ORGAO` (máx. 50) | ✔ | **sim** |
| `TEMPLATE_LIBRARY_UPDATE` | `TemplateLibraryUpdateAvailable` (DT-15) | Vínculos com `TEMPLATE_PUBLISH` (máx. 50) | não | não |
| `GOVBR_LINK_CHANGED` | `GovbrIdentityLinked` / `Unlinked` | O próprio usuário (aviso de segurança — exceção à regra do ator) | ✔ | **sim** |
| `REPORT_EXPORT_READY` | `ReportExportFinished` (`READY` ou `FAILED`) | O solicitante do pedido (exceção à regra do ator: ele pediu o arquivo — US-174) | não | **sim** (in-app) |

**Lembretes** (job `deadlines`, idempotentes por marcação na entidade):
- Diligência: `legalReview.diligenceReminderBusinessDays` antes de `LegalReviewDiligence.dueAt` e no vencimento (`lastReminderAt` evita repetição no mesmo dia útil).
- SLA: os avisos do MVP 1 (`STAGE_DUE_SOON`, `STAGE_OVERDUE`) continuam quando não há política; com política, os degraus (`SLA_ESCALATION`) substituem `STAGE_DUE_SOON` e acrescentam-se a `STAGE_OVERDUE` (`escalationLevel` evita repetição; `repeatEveryBusinessDays` reenvia).
- Aprovação por linha: com `ApprovalApprover.dueAt`, os avisos de prazo de aprovação usam o prazo da linha `PENDING`.
- Pausas de SLA não geram notificação, só timeline.

---

## 7. Catálogo de ações de auditoria

Escritas pelo `AuditService` na mesma transação (DEC-161); mesmas regras de conteúdo do MVP 1 (sem texto de parecer, manifestação, diligência, ressalva ou achado — só ids, hashes e tamanhos; valores sigilosos mascarados).

| Área | Ações |
|---|---|
| PCA | `pca.create`, `pca.update`, `pca.revise`, `pca.import`, `pca.item_create`, `pca.item_update`, `pca.item_delete`, `pca.item_status_change` (DATA_CHANGE); `pca.submit`, `pca.withdraw` (WORKFLOW); `pca.reconcile`, `pca.conciliate`, `pca.delete`, `pca.discard_revision` (DATA_CHANGE); `pca.export` (EXPORT); `process.pca_link`, `process.pca_unlink`, `dfd.pca_link`, `dfd.pca_unlink` (DATA_CHANGE — `actorType = SYSTEM` na reconciliação) |
| Dotação | `budget_allocation.create`, `budget_allocation.update` (DATA_CHANGE); `budget_allocation.confirm`, `budget_allocation.cancel` (WORKFLOW) |
| Jurídico | `legal_review.assign`, `legal_review.start`, `legal_review.diligence_request`, `legal_review.resume`, `legal_review.conclude`, `legal_review.waive`, `legal_review.cancel` (WORKFLOW); `legal_review.reservation_create`, `legal_review.reservation_resolve` (DATA_CHANGE); `legal_review.configure` (CONFIGURATION) |
| Controle Interno | `internal_control_review.start`, `internal_control_review.conclude`, `internal_control_review.cancel` (WORKFLOW); `internal_control_review.answer_update`, `internal_control_review.finding_create`, `internal_control_review.finding_update`, `internal_control_review.finding_resolve` (DATA_CHANGE); `internal_control_checklist.create`, `internal_control_checklist.publish`, `internal_control_checklist.retire` (CONFIGURATION) |
| Edital | `tender.create`, `tender.update`, `tender.import_term`, `tender.lots_update`, `tender.risk_allocation_update` (DATA_CHANGE) |
| Tramitação v2 | `process.branch_open`, `process.branch_join`, `process.branch_cancel`, `process.stage_skip` (WORKFLOW — `actorType = SYSTEM` quando automático); `process.workflow_migrate` (WORKFLOW — `metadata`: `migrationId`, `itemId`, versões, mapa aplicado, decisão e justificativa); `process.sla_pause`, `process.sla_resume`, `process.stage_escalate` (SYSTEM) |
| Aprovação | `approval.vote` (WORKFLOW — decisão de linha que não encerra); `approval.decide`, `approval.reassign` passam a registrar `metadata.approvalApproverId` e `decisionPolicy` |
| Migração de workflow | `workflow_migration.create`, `workflow_migration.update`, `workflow_migration.simulate`, `workflow_migration.decide_item`, `workflow_migration.execute`, `workflow_migration.cancel` (CONFIGURATION); `workflow_migration.export` (EXPORT) |
| Workflow | `workflow.seed_adopt`, `workflow.seed_offer_dismiss` (CONFIGURATION) |
| Regras, SLA e notificação | `rule.create`, `rule.update`, `rule.version_create`, `rule.version_publish`, `rule.version_retire`, `rule.test_run`, `rule.simulate` (CONFIGURATION — `rule.simulate` com processo real também registra `processId`); `sla_policy.create`, `sla_policy.update`, `sla_policy.activate`, `sla_policy.deactivate` (CONFIGURATION); `notification_rule.create`, `notification_rule.update`, `notification_rule.activate`, `notification_rule.deactivate` (CONFIGURATION), `notification_rule.auto_disable` (SYSTEM) |
| Relatórios | `report.view_detail` (ACCESS — detalhamento por processo, 1×/sessão/relatório), `report.export` (EXPORT); `analytics.rebuild` (SYSTEM) |
| IA | Inalteradas; `metadata.targetModule` aceita `LEGAL_OPINION` e `TENDER` |
| Identidade e plataforma | `auth.govbr_login` (SECURITY — com `govbrTrustLevel`), `identity.govbr_link`, `identity.govbr_unlink` (SECURITY); `role.reactivate` (SECURITY — DT-13); `support.access_grant`, `support.access_end` (SECURITY, `actorType = PLATFORM_OPERATOR`, já previstas no MVP 1, agora com `grantId` e `ticketReference`); `backoffice.access` (ACCESS); `platform.health_view` (ACCESS) |
| Templates (DT-15) | `template.library_adopt` (CONFIGURATION — `metadata`: `libraryKey`, `libraryVersion`, `contentHash` anterior e novo) |
| Caixa de tarefas (DT-16) | Sem ação nova: `settings.update` registra `inbox.bulkMaxItems` |

---

## 8. Evento → timeline → notificação → auditoria

Visão consolidada dos fatos do MVP 2 (o detalhe está nas seções anteriores). "—" = sem efeito naquele canal.

| Fato | Evento | Timeline (`type`) | Notificação (`NotificationType`) | Auditoria (ação) | Read model |
|---|---|---|---|---|---|
| Processo entra em ramificação | `ProcessBranchesOpened` | `BRANCHES_OPENED` | `PARALLEL_BRANCH_RECEIVED` | `process.branch_open` | ✔ |
| Ramo concluído | `ProcessBranchArrived` | `BRANCH_ARRIVED` | — | `process.forward` (movimento do ramo) | ✔ |
| Junção | `ProcessBranchesJoined` | `BRANCHES_JOINED` | `PARALLEL_BRANCHES_JOINED` | `process.branch_join` | ✔ |
| Devolução cancela ramos | `ProcessBranchesCanceled` | `BRANCHES_CANCELED` | `PROCESS_RETURNED` (MVP 1, pelo `ProcessStageChanged`) | `process.branch_cancel` | ✔ |
| Etapa dispensada por regra | `ProcessStageSkipped` | `STAGE_SKIPPED` | — (ou `RULE_NOTIFICATION`) | `process.stage_skip` | ✔ |
| Migração de versão do processo | `ProcessWorkflowMigrated` | `WORKFLOW_MIGRATED` | `PROCESS_MIGRATED` | `process.workflow_migrate` | ✔ |
| Plano de migração concluído | `WorkflowMigrationCompleted` | — | `WORKFLOW_MIGRATION_FINISHED` | `workflow_migration.execute` | — |
| Voto em aprovação múltipla | `ApprovalVoteRecorded` | `APPROVAL_VOTE_RECORDED` | `APPROVAL_VOTE_RECORDED` | `approval.vote` | ✔ |
| Vez do próximo aprovador | `ApprovalApproverActivated` | `APPROVAL_TURN` | `APPROVAL_REQUESTED` | — (parte de `approval.vote`) | — |
| Plano do PCA aprovado | `PcaStatusChanged` (`approved`) | — | `PCA_APPROVAL_DECIDED` | `approval.decide` | ✔ |
| Reconciliação do PCA | `PcaReconciliationCompleted` | — | `PCA_RECONCILIATION_PENDING` (se houver pendências) | `pca.reconcile` | — |
| Processo vinculado ao PCA | `ProcessPcaItemLinked` | `PCA_ITEM_LINKED` | — | `process.pca_link` | ✔ |
| Dotação indicada | `BudgetAllocationCreated` | `BUDGET_ALLOCATION_ADDED` | — | `budget_allocation.create` | ✔ |
| Dotação confirmada | `BudgetAllocationConfirmed` | `BUDGET_ALLOCATION_CONFIRMED` | `BUDGET_ALLOCATION_CONFIRMED` | `budget_allocation.confirm` | ✔ |
| Dotação cancelada | `BudgetAllocationCanceled` | `BUDGET_ALLOCATION_CANCELED` | `BUDGET_ALLOCATION_CANCELED` | `budget_allocation.cancel` | ✔ |
| Entrada na fila jurídica | `LegalReviewOpened` | `LEGAL_REVIEW_OPENED` | `LEGAL_REVIEW_QUEUED` | — (sistema, pela tramitação) | ✔ |
| Distribuição | `LegalReviewAssigned` | `LEGAL_REVIEW_ASSIGNED` | `LEGAL_REVIEW_ASSIGNED` | `legal_review.assign` | — |
| Diligência pedida | `LegalReviewDiligenceRequested` | `LEGAL_DILIGENCE_REQUESTED` | `LEGAL_DILIGENCE_REQUESTED` | `legal_review.diligence_request` | ✔ |
| Lembrete de diligência | `LegalReviewDiligenceReminderDue` | — | `LEGAL_DILIGENCE_REMINDER` | — | — |
| Análise retomada | `LegalReviewResumed` | `LEGAL_REVIEW_STARTED` | `LEGAL_DILIGENCE_ANSWERED` | `legal_review.resume` | ✔ |
| Parecer concluído | `LegalReviewConcluded` (+ `document.finalized.parecer_juridico`) | `LEGAL_REVIEW_CONCLUDED` | `LEGAL_REVIEW_CONCLUDED` | `legal_review.conclude` | ✔ |
| Análise dispensada | `LegalReviewWaived` | `LEGAL_REVIEW_WAIVED` | `LEGAL_REVIEW_CONCLUDED` | `legal_review.waive` | ✔ |
| Manifestação do CI concluída | `InternalControlReviewConcluded` | `INTERNAL_CONTROL_CONCLUDED` | `INTERNAL_CONTROL_CONCLUDED` | `internal_control_review.conclude` | ✔ |
| Minuta do edital criada | `TenderCreated` | `TENDER_CREATED` | — | `tender.create` | ✔ |
| Edital concluído | `DocumentFinalized` (`edital`) | `DOCUMENT_FINALIZED` | — | `document.finalize` | ✔ |
| Escalonamento de prazo | `ProcessStageEscalated` | `STAGE_ESCALATED` | `SLA_ESCALATION` | `process.stage_escalate` | ✔ |
| Pausa/retomada de prazo | `ProcessStageSlaPaused` / `Resumed` | `SLA_PAUSED` / `SLA_RESUMED` | — | `process.sla_pause` / `process.sla_resume` | ✔ |
| Regra de notificação disparada | (evento NR de origem) | — | `RULE_NOTIFICATION` | — (execução em `notification_rule_executions`) | — |
| Regra de notificação desligada | `NotificationRuleAutoDisabled` | — | `NOTIFICATION_RULE_DISABLED` | `notification_rule.auto_disable` | — |
| Selo de auditoria quebrado (DT-14) | `AuditSealBroken` | — | `AUDIT_SEAL_BROKEN` | `audit.seal` (`result = FAILURE`) | — |
| Acesso de suporte | `SupportAccessGranted` / `Ended` | — | `SUPPORT_ACCESS_GRANTED` | `support.access_grant` / `support.access_end` | — |
| Vínculo gov.br | `GovbrIdentityLinked` / `Unlinked` | — | `GOVBR_LINK_CHANGED` | `identity.govbr_link` / `identity.govbr_unlink` | — |
| Login por gov.br | — (sem evento de domínio) | — | — | `auth.govbr_login` | — |
| Atualização da biblioteca de templates (DT-15) | `TemplateLibraryUpdateAvailable` | — | `TEMPLATE_LIBRARY_UPDATE` | — / `template.library_adopt` na adoção | — |
| Perfil reativado (DT-13) | `RoleReactivated` | — | — | `role.reactivate` | — |

---

## 9. Versionamento

- Todos os acréscimos da §2 são campos opcionais: **nenhum evento do MVP 1 sobe de `eventVersion`**. Consumidores do MVP 1 ignoram os campos novos; os consumidores novos tratam a ausência deles (eventos antigos reprocessados pelo `REBUILD` do read model).
- `ProcessStageChanged` emitido durante o paralelismo continua com `fromStage`/`toStage` do ramo; consumidores que assumem "uma etapa ativa" devem passar a ler `activeStageIds` — a caixa de tarefas e o dashboard são ajustados na mesma entrega (DT-03).
- Eventos novos nascem com `eventVersion = 1`. O subconjunto publicável como webhook (MVP 3) será escolhido entre os eventos deste documento sem payload sensível.
