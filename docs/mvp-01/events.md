# MVP 1 — Eventos de Domínio

> **Documento canônico** de eventos do MVP 1: nomes, routing keys, produtores, payloads, consumidores, projeção na timeline, notificações e catálogo de ações de auditoria.
> Base: [DEC-160 a DEC-164](../architecture/decisions.md#8-eventos-filas-e-jobs) · [ADR-004](../adr/adr-004-outbox-events.md) · [queues.md](../architecture/queues.md).

Sumário: [1. Convenções](#1-convenções) · [2. Envelope](#2-envelope) · [3. Entrega](#3-entrega-e-consumidores) · [4. Catálogo](#4-catálogo-de-eventos) · [5. Timeline](#5-projeção-na-timeline) · [6. Notificações](#6-notificações-derivadas-de-eventos) · [7. Auditoria](#7-catálogo-de-ações-de-auditoria) · [8. Versionamento](#8-versionamento-e-evolução)

---

## 1. Convenções

- **Nome:** PascalCase no passado (`ProcessCreated`). **Routing key:** `<agregado>.<fato>` em snake_case (`process.created`).
- **Nomes especializados** (DEC-162): um fato canônico pode ser publicado com routing key especializada (`process.stage_changed.forward`). Assinantes podem usar curinga (`process.stage_changed.*`). Não há mensagem duplicada.
- Eventos são **fatos imutáveis**; payload contém IDs e o mínimo necessário para consumidores. Dados sigilosos (valores de orçamento sigiloso, conteúdo de documentos, CPF) **nunca** entram no payload.
- Todo evento é gravado no `outbox_events` **na mesma transação** da mudança de estado (DEC-161).
- `eventVersion` inicia em 1; mudanças incompatíveis criam nova versão (§8).
- Constantes em `packages/types/src/events.ts`; schemas Zod do payload em `packages/validation/src/events/*`.

## 2. Envelope

Conforme DEC-160. Exemplo:
```json
{
  "eventId": "01927f1a-6c1e-7c8b-9a2e-3f6d2b1c0a11",
  "eventType": "ProcessStageChanged",
  "routingKey": "process.stage_changed.forward",
  "eventVersion": 1,
  "occurredAt": "2026-10-05T14:30:00Z",
  "tenantId": "0192…",
  "aggregateType": "Process",
  "aggregateId": "0192…",
  "processId": "0192…",
  "actor": { "type": "USER", "userId": "0192…", "membershipId": "0192…" },
  "correlationId": "c-7f3a2b",
  "causationId": null,
  "payload": {
    "cause": "FORWARD",
    "movementId": "0192…",
    "fromStage": { "processStageId": "…", "key": "ABERTURA" },
    "toStage": { "processStageId": "…", "key": "APROVACAO_DFD", "type": "APPROVAL" },
    "fromDepartmentId": "…", "toDepartmentId": "…", "toUserId": null,
    "dueAt": "2026-10-09T23:59:59-03:00",
    "documentIds": ["…"]
  }
}
```

## 3. Entrega e consumidores

| Tipo de consumidor | Onde roda | Garantia | Usado para |
|---|---|---|---|
| **Síncrono (in-process, mesma transação)** | API/worker, dentro do caso de uso | Atômico com a mudança | `TimelineProjector` (§5), `ProcessAccessProjector` (DEC-024) |
| **Assíncrono** | Worker, via relay do outbox → fila `domain-events` → filas consumidoras | *At-least-once*, idempotente por `eventId` | `notifications`, `email`, métricas de negócio; MVP 3: `webhooks`; MVP 5: `ai` (reindexação e validações). No MVP 1 o `ai` não consome eventos: a geração roda na fila de trabalho `ai-generation` (DEC-079) |

Consumidores assíncronos do MVP 1:

| Consumidor | Fila | Assina | Idempotência |
|---|---|---|---|
| `NotificationDispatcher` | `notifications` | eventos da §6 | `UNIQUE (tenant_id, recipient_id, source_event_id, type)` em `notifications` |
| `EmailSender` | `email` | notificações com canal e-mail | `Notification.emailStatus` (só envia se `PENDING`) |
| `PermissionCacheInvalidator` | `domain-events` (handler leve) | `role.*`, `membership.*`, `department.moved`, `department.updated` (titular/substituto — US-102), `department.deactivated` | Operação idempotente (DEL de chave) |
| `BusinessMetricsCollector` | `domain-events` | `process.*`, `document.*`, `approval.*` | Contadores tolerantes a reentrega (deduplicação por `eventId` em Redis, 24 h) |
| `EtpEstimateSynchronizer` (US-022) | `domain-events` (handler leve, transação do tenant do evento — papel `cf_worker`) | `price_research.recalculated`, `document.finalized.price_research`, `document.canceled.price_research` | Lê o estado atual (não o payload): `UPDATE etps … WHERE estimated_total_value IS DISTINCT FROM price_research.total_estimated_value` — reentrega não acha linha, não sobe versão nem audita (RN-ETP-29). Só ETPs em `DRAFT`/`RETURNED` recebem o valor novo; o cancelamento desfaz o vínculo de todo ETP não excluído preservando o último valor (RN-ETP-31). Cada mudança grava `document.draft_update` (`SYSTEM`, sem valores) |

---

## 4. Catálogo de eventos

Legenda **Cons.**: T = timeline (síncrono), A = ProcessAccess (síncrono), N = notificações, C = invalidação de cache, M = métricas, E = valor estimado do ETP vinculado (`EtpEstimateSynchronizer` — US-022).

### 4.1 Processo (módulo `process`)
| Evento | Routing key | Produtor (story) | Payload (além do envelope) | Cons. |
|---|---|---|---|---|
| `ProcessCreated` | `process.created` | Criar processo (US-001); duplicar (US-011) | `code?`, `number?`, `year`, `title`, `organizationId`, `requestingSecretariatId`, `requestingDepartmentId`, `contractingTypeCode`, `modalityCode?`, `priority`, `workflowId`, `workflowVersionId`, `initialStageKey`, `initialDepartmentId`, `initialResponsibleId?`, `creationChannel`, `duplicatedFromId?` (unidade e responsável da etapa inicial — concessões `CURRENT`/`RESPONSIBLE` do `ProcessAccessProjector`; US-001) | T A M |
| `ProcessUpdated` | `process.updated` | Editar processo (US-005), etiquetas (US-007) | `changedFields: string[]` (sem valores sigilosos), `version` | T |
| `ProcessNumberAssigned` | `process.number_assigned` | 1º encaminhamento com `assignOn = START` (US-047) | `number`, `year`, `code` | T |
| `ProcessItemsChanged` | `process.items_changed` | Gerenciar itens (US-006) | `added: id[]`, `updated: id[]`, `removed: id[]`, `itemsCount` | T |
| `ProcessAssigned` | `process.assigned` | Assumir (US-049), atribuir (US-050), entrada em etapa | `processStageId`, `departmentId`, `fromUserId?`, `toUserId?`, `assignmentType`, `hasReason` | T A N |
| `ProcessStageChanged` | `process.stage_changed.<cause>` | Encaminhar (US-047), devolver (US-048), decisão de aprovação (US-052), concluir (US-010) | `cause` (`FORWARD`, `RETURN`, `APPROVAL_APPROVED`, `APPROVAL_RETURNED`, `APPROVAL_REJECTED`, `COMPLETE`), `movementId`, `fromStage {processStageId, key}`, `toStage {processStageId, key, type}`, `fromDepartmentId`, `toDepartmentId`, `toUserId?`, `dueAt?`, `documentIds[]`, `approvalId?` | T A N M |
| ↳ `ProcessForwarded` | `process.stage_changed.forward` | especialização (`cause = FORWARD`) | — | — |
| ↳ `ProcessReturned` | `process.stage_changed.return` | especialização (`cause = RETURN`) | — | — |
| `ProcessStatusChanged` | `process.status_changed.<status>` (retomada: `.resumed`) | Ciclo de vida (US-008, US-009, US-010, US-047, US-052) | `fromStatus`, `toStatus`, `cause` (`FORWARD`, `RETURN`, `APPROVAL_DECISION`, `SUSPEND`, `RESUME`, `CANCEL`, `COMPLETE`), `reasonProvided: boolean`, `reason?` (motivo da suspensão/cancelamento ou comentário da retomada — `params.reason` da timeline) | T N M |
| ↳ `ProcessSuspended` / `ProcessResumed` | `process.status_changed.suspended` / `.resumed` | US-008 | — | — |
| ↳ `ProcessCanceled` | `process.status_changed.canceled` | US-009 | — | — |
| ↳ `ProcessCompleted` | `process.status_changed.completed` | US-010, US-052 | — | — |
| `ProcessDuplicated` | `process.duplicated` | US-011 | `sourceProcessId`, `newProcessId`, `options {copyDocuments, copyAttachments}` | T |
| `ProcessDraftDiscarded` | `process.draft_discarded` | US-009 (rascunho sem número) | `reasonProvided` | M |
| `ProcessParticipantAdded` | `process.participant_added` | US-012 | `participantId`, `userId?`, `departmentId?`, `role`, `expiresAt?`, `notify`, `grantedVia` (`MANAGE`, `FOLLOW`) | T A N |
| `ProcessParticipantRemoved` | `process.participant_removed` | US-012; job de expiração | `participantId`, `reason` (`REVOKED`, `EXPIRED`) | T A |
| `ProcessConfidentialityChanged` | `process.confidentiality_changed` | US-013 | `isBudgetConfidential` | T |
| `ProcessStageDueSoon` | `process.stage_due_soon` | Job `deadlines` (US-055) | `processStageId`, `stageKey`, `dueAt`, `businessDaysLeft`, `assigneeId?`, `departmentId` | N |
| `ProcessStageOverdue` | `process.stage_overdue` | Job `deadlines` (US-055) | `processStageId`, `stageKey`, `dueAt`, `overdueSince`, `assigneeId?`, `departmentId` | T N M |

### 4.2 Aprovação (módulo `approval`)
| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `ApprovalRequested` | `approval.requested` | US-051 | `approvalId`, `subjectType`, `processStageId?`, `documentId?`, `documentVersionIds[]`, `approverType`, `approverUserId?`, `approverRoleId?`, `approverDepartmentId?`, `allowDeputy`, `dueAt?` | T A N |
| `ApprovalCompleted` | `approval.completed` | US-052 (decisão `APPROVE`) | `approvalId`, `subjectType`, `decidedById`, `decidedAsDeputy`, `documentVersionIds[]`, `hasComment` | T N M |
| `ApprovalReturned` | `approval.returned` | US-052 (decisão `RETURN`) | idem (`hasComment: true`) | T N M |
| `ApprovalRejected` | `approval.rejected` | US-052 (decisão `REJECT`) | idem | T N M |
| `ApprovalCanceled` | `approval.canceled` | US-053 (retirada), cancelamento do processo (US-009) | `approvalId`, `reason` (`WITHDRAWN`, `PROCESS_CANCELED`, `REASSIGNED`) | T |
| `ApprovalReassigned` | `approval.reassigned` | US-053 (redirecionamento) | `approvalId`, `fromApproverType`, `fromApproverUserId?`, `fromApproverRoleId?`, `fromApproverDepartmentId?`, `approverType`, `toApproverUserId?`, `toApproverRoleId?`, `toApproverDepartmentId?`, `allowDeputy`, `hasReason` (nunca o motivo) | T A N |

### 4.3 Documentos (módulos `document`, `dfd`, `etp`, `price-research`, `risk`, `term`)
Eventos genéricos com `documentTypeCode`; routing key `document.<fato>.<tipo_em_minúsculas>` (DEC-162).

| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `DocumentCreated` | `document.created.<type>` | US-014, US-019, US-024, US-035, US-036, US-063, US-064, US-011 | `documentId`, `documentTypeCode`, `kind`, `code?`, `title`, `templateVersionId?`, `sourceDocumentId?` | T M |
| `DocumentVersionCreated` | `document.version_created.<type>` | US-066 e transições que criam versão | `documentId`, `documentVersionId`, `versionNumber`, `reason`, `contentHash` | T |
| `DocumentSubmitted` | `document.submitted.<type>` | US-065, US-051 | `documentId`, `documentVersionId`, `approvalId?` | T |
| `DocumentFinalized` | `document.finalized.<type>` | US-065 (finalizar), US-032, US-039, US-016, US-023, US-035 | `documentId`, `documentVersionId`, `typedSummary?` | T N M |
| `DocumentApproved` | `document.approved.<type>` | US-052 (via aprovação) | `documentId`, `documentVersionId`, `approvalId` | T M |
| `DocumentReturned` | `document.returned.<type>` | US-052 | `documentId`, `approvalId` | T |
| `DocumentRejected` | `document.rejected.<type>` | US-052 | `documentId`, `approvalId` | T |
| `DocumentWithdrawn` | `document.withdrawn.<type>` | US-053, retirada automática no cancelamento do processo (US-009) | `documentId`, `documentTypeCode`, `approvalId`, `reason?` (texto fixo "Processo cancelado" na retirada automática — nunca texto do usuário) | T |
| `DocumentReopened` | `document.reopened.<type>` | US-065 | `documentId`, `fromStatus`, `baseVersionId` | T |
| `DocumentCanceled` | `document.canceled.<type>` | US-065 | `documentId`, `fromStatus` | T |
| `DocumentRenditionReady` | `document.rendition_ready` | Worker `document-render` (US-067) | `documentId`, `documentVersionId?`, `renditionId`, `kind`, `sha256`, `pageCount` | — |
| `DocumentRenditionFailed` | `document.rendition_failed` | Worker `document-render` (US-067) | `documentId`, `renditionId`, `kind`, `errorCode`, `attempts` | N |

Nomes especializados exigidos pelo produto:

| Nome | Equivale a | Routing key |
|---|---|---|
| `DFDCreated` | `DocumentCreated` (DFD) | `document.created.dfd` |
| `DFDApproved` | `DocumentApproved` (DFD) | `document.approved.dfd` |
| `ETPCreated` | `DocumentCreated` (ETP) | `document.created.etp` |
| `ETPApproved` | `DocumentApproved` (ETP) | `document.approved.etp` |
| `PriceResearchCompleted` | `DocumentFinalized` (PRICE_RESEARCH) — `typedSummary: { totalEstimatedValueMasked: boolean, itemsCount, itemsWithAlertsCount }` | `document.finalized.price_research` |
| `TermCompleted` | `DocumentFinalized` (TR) | `document.finalized.tr` |

Eventos próprios de módulos tipados:

| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `EtpAlternativeRecommended` | `etp.alternative_recommended` | US-021 | `etpId`, `alternativeId`, `previousAlternativeId?` | T |
| `PriceResearchRecalculated` | `price_research.recalculated` | US-029 | `priceResearchId`, `itemsCount`, `itemsWithAlertsCount` | E (US-022) |
| `QuotationExcluded` | `price_research.quotation_excluded` | US-027 | `priceResearchId`, `quotationId`, `priceItemId`, `reason` | T |
| `QuotationRestored` | `price_research.quotation_restored` | US-027 | `priceResearchId`, `quotationId`, `priceItemId` | T |
| `RiskCreated` | `risk.created` | US-033 | `riskId`, `code`, `level`, `phase`, `categoryCode` | T |
| `RiskAssessed` | `risk.assessed` | US-033 (alteração de P×I) | `riskId`, `fromLevel`, `toLevel`, `score` | T |
| `RiskTreatmentChanged` | `risk.treatment_changed` | US-034, US-119 (RSK-11) | `riskId`, `treatmentId`, `change` (`CREATED`, `UPDATED`, `STATUS_CHANGED`, `DELETED`), `status` | — |
| `RiskDeleted` | `risk.deleted` | US-033 | `riskId`, `code` | T |
| `TermImportedFromEtp` | `term.imported_from_etp` | US-037 | `termId`, `etpId`, `etpVersionId` (nulo se o ETP ainda não tem versão), `sectionsImported[]`, `itemsImported` | T |

### 4.4 Colaboração e arquivos (módulos `collaboration`, `files`)
| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `CommentCreated` | `comment.created` | US-071 | `commentId`, `targetType`, `documentId?`, `sectionKey?`, `parentId?`, `parentAuthorId?` | T N |
| `CommentUpdated` | `comment.updated` | US-071 | `commentId` | — |
| `CommentDeleted` | `comment.deleted` | US-071 | `commentId`, `byModerator: boolean` | T |
| `UserMentioned` | `comment.user_mentioned` | US-072 | `commentId`, `mentionId`, `mentionedUserId?`, `mentionedDepartmentId?` | N |
| `AttachmentUploaded` | `attachment.uploaded` | Worker `file-scan` (US-068) | `attachmentId`, `targetType`, `targetId?`, `fileName`, `sizeBytes`, `sha256` | T |
| `AttachmentRejected` | `attachment.rejected` | Worker `file-scan` (US-068) | `attachmentId`, `status` (`INFECTED`/`REJECTED`), `reasonCode` | N |
| `AttachmentDeleted` | `attachment.deleted` | US-068 | `attachmentId`, `hasReason` | T |

### 4.5 Configuração (módulos `workflow`, `document`, `catalog`, `supplier`)
| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `WorkflowCreated` | `workflow.created` | US-043 | `workflowId`, `key` | — |
| `WorkflowVersionPublished` | `workflow.version_published` | US-045 | `workflowId`, `workflowVersionId`, `versionNumber`, `definitionHash` | C |
| `WorkflowVersionRetired` | `workflow.version_retired` | US-045 | `workflowId`, `workflowVersionId` | C |
| `WorkflowDefaultChanged` | `workflow.default_changed` | US-042 | `workflowId` | C |
| `TemplateVersionPublished` | `template.version_published` | US-108 | `templateId`, `templateVersionId`, `versionNumber`, `documentTypeCode`, `contentHash` | C |
| `TemplateVersionRetired` | `template.version_retired` | US-108 | `templateId`, `templateVersionId` | C |
| `DocumentTypeChanged` | `document_type.changed` | US-061 | `documentTypeId`, `code`, `changedFields[]` | C |
| `CatalogItemChanged` | `catalog.item_changed` | US-104 | `catalogType`, `catalogItemId`, `code`, `change` (`CREATED`, `UPDATED`, `ACTIVATED`, `DEACTIVATED`) | C |
| `HolidayChanged` | `catalog.holiday_changed` | US-106 | `holidayId`, `date`, `change` | C |
| `SupplierCreated` / `SupplierUpdated` | `supplier.created` / `supplier.updated` | US-025 | `supplierId`, `documentType`, `changedFields[]?` | — |

### 4.6 Identidade, acesso e tenancy (módulos `identity`, `access`, `tenancy`, `organization`)
| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `UserInvited` | `membership.invited` | US-091 (convite, reenvio e convite do primeiro administrador) | `membershipId`, `userId`, `type`, `expiresAt?`, `inviteExpiresAt`, `resend` | `InvitationEmailEnqueuer` (fila `email`, `kind = INVITATION`) + C |
| `MembershipActivated` | `membership.activated` | US-091 | `membershipId`, `userId` | C |
| `MembershipUpdated` | `membership.updated` | US-092 | `membershipId`, `changedFields[]` (inclui `departments`) | C |
| `MembershipSuspended` / `MembershipReactivated` | `membership.suspended` / `.reactivated` | US-092 | `membershipId`, `hasReason` | C |
| `MembershipRevoked` | `membership.revoked` | US-092 | `membershipId`, `hasReason` | C (+ encerramento de sessões) |
| `MembershipExpired` | `membership.expired` | Job `maintenance` | `membershipId` | C |
| `RoleCreated` / `RoleUpdated` | `role.created` / `role.updated` | US-095 | `roleId`, `key`, `permissionsAdded[]`, `permissionsRemoved[]` | C |
| `RoleAssigned` | `role.assigned` | US-096 | `roleAssignmentId`, `membershipId`, `roleId`, `scopeType`, `scopeId?`, `validUntil?` | C N |
| `RoleRevoked` | `role.revoked` | US-096 | `roleAssignmentId`, `membershipId`, `roleId` | C N |
| `TenantProvisioned` | `tenant.provisioned` | US-099 | `tenantId`, `slug`, `primaryOrganizationId` | — |
| `TenantActivated` / `TenantSuspended` | `tenant.activated` / `tenant.suspended` | US-099 (plataforma) | `tenantId` | C |
| `TenantOffboarded` / `TenantDeactivated` | `tenant.offboarded` / `tenant.deactivated` | US-099 (plataforma) | `tenantId`, `offboardingEndsAt?` | C (+ encerramento de sessões) |
| `TenantSettingsChanged` | `tenant.settings_changed` | US-103 | `keys[]` | C |
| `OrganizationCreated` / `OrganizationUpdated` | `organization.created` / `.updated` | US-101 | `organizationId`, `changedFields[]?` | C |
| `DepartmentCreated` / `DepartmentUpdated` | `department.created` / `.updated` | US-102 | `departmentId`, `changedFields[]?` | C |
| `DepartmentMoved` | `department.moved` | US-102 | `departmentId`, `fromParentId?`, `toParentId?` | C |
| `DepartmentDeactivated` | `department.deactivated` | US-102 | `departmentId` | C |

### 4.7 Inteligência artificial (módulo `ai`; aplicação e revisão nos módulos `document` e `risk`)
Geração assistida de documentos (EP-020, DEC-037, DEC-079). Payloads nunca levam o resumo, a instrução, o contexto, o texto gerado nem valores. Em `document.ai_content_*.<type>`, `<type>` = `dfd`, `etp`, `risk_map` ou `tr`.

| Evento | Routing key | Produtor | Payload | Cons. |
|---|---|---|---|---|
| `AiGenerationRequested` | `ai.generation_requested` | US-115 (AI-01) | `generationId`, `processId`, `documentId?`, `targetModule`, `kind`, `action?`, `sectionKey?` | M |
| `AiGenerationCompleted` | `ai.generation_completed` | US-115 (worker `ai-generation`) | `generationId`, `processId`, `documentId?`, `targetModule`, `kind`, `action?`, `sectionKey?`, `requestedById`, `model`, `promptKey`, `promptVersion`, `totalTokens`, `sectionsCount`, `risksCount`, `placeholdersCount` | T N M |
| `AiGenerationFailed` | `ai.generation_failed` | US-115 (worker `ai-generation`) | `generationId`, `processId`, `documentId?`, `requestedById`, `errorCode`, `attempts` | N M |
| `AiContentApplied` | `document.ai_content_applied.<type>` | US-117, US-121 (DOC-26); US-119 (RSK-11) | `generationId`, `documentId?`, `targetModule`, `sectionKeys[]`, `riskIds[]`, `replacedFilledSections` | T M |
| `AiContentReviewed` | `document.ai_content_reviewed.<type>` | US-122 (DOC-27); US-119 (RSK-12) | `documentId?`, `targetModule`, `sectionKeys[]`, `riskIds[]`, `generationIds[]` | T |
| `AiUsageThresholdReached` | `ai.usage_threshold_reached` | US-116 (no término da geração que cruza a faixa) | `month`, `threshold` (`80`/`100`), `usedTokens`, `limitTokens` | N |

O ator do envelope de `AiGenerationCompleted`/`AiGenerationFailed` é o solicitante (o job carrega o ator — DEC-164); `AiUsageThresholdReached` é publicado uma vez por mês e faixa (chave natural `(tenant, month, threshold)`).

---

## 5. Projeção na timeline

`TimelineProjector` (síncrono) grava `ProcessTimelineEntry` com `sourceEventId = eventId`. Os `type` abaixo formam o registro `TimelineEntryType`; a mensagem pt-BR é renderizada no frontend a partir de `type` + `params` (nomes congelados no momento do fato).

| `type` | Evento de origem | Mensagem (pt-BR) | `params` principais | Visibilidade |
|---|---|---|---|---|
| `PROCESS_CREATED` | `ProcessCreated` | "{actor} abriu o processo {code}" | `code`, `title`, `requestingDepartmentName` | STANDARD |
| `PROCESS_DUPLICATED_FROM` | `ProcessCreated` (com `duplicatedFromId`) | "Processo criado a partir de {sourceCode}" | `sourceCode` | STANDARD |
| `PROCESS_DUPLICATED` | `ProcessDuplicated` (no processo de origem) | "{actor} duplicou o processo em {newCode}" | `newProcessId`, `newCode` | STANDARD |
| `PROCESS_UPDATED` | `ProcessUpdated` | "{actor} alterou {fieldsLabel}" | `fields[]` | `BUDGET_RESTRICTED` se incluir `estimatedValue` com sigilo |
| `PROCESS_NUMBER_ASSIGNED` | `ProcessNumberAssigned` | "Processo autuado sob o nº {code}" | `code` | STANDARD |
| `ITEMS_CHANGED` | `ProcessItemsChanged` | "{actor} atualizou os itens ({itemsCount})" | contagens | STANDARD |
| `PROCESS_FORWARDED` | `ProcessStageChanged` (`FORWARD`) | "{actor} encaminhou para {toStageName} — {toDepartmentName}" | `fromStageName`, `toStageName`, `toDepartmentName`, `toUserName?`, `dueAt`, `documents[]`, `hasComment` | STANDARD |
| `PROCESS_RETURNED` | `ProcessStageChanged` (`RETURN`) | "{actor} devolveu para {toStageName} — {toDepartmentName}" | idem | STANDARD |
| `PROCESS_STAGE_CHANGED` | `ProcessStageChanged` (`APPROVAL_*`, `COMPLETE`) | "Processo seguiu para {toStageName}" | idem + `decision` | STANDARD |
| `PROCESS_CLAIMED` | `ProcessAssigned` (`CLAIM`) | "{actor} assumiu o processo" | — | STANDARD |
| `PROCESS_ASSIGNED` | `ProcessAssigned` (`MANUAL`) | "{actor} atribuiu o processo a {toUserName}" | `toUserName`, `fromUserName?` | STANDARD |
| `PROCESS_SUSPENDED` / `PROCESS_RESUMED` | `ProcessStatusChanged` | "{actor} suspendeu/retomou o processo" | `reason` (texto) | STANDARD |
| `PROCESS_CANCELED` | `ProcessStatusChanged` | "{actor} cancelou o processo" | `reason` | STANDARD |
| `PROCESS_COMPLETED` | `ProcessStatusChanged` | "Planejamento da contratação concluído" (MVP 1 — DEC-015) | — | STANDARD |
| `PARTICIPANT_ADDED` / `PARTICIPANT_REMOVED` | `ProcessParticipant*` | "{actor} adicionou {name} como {roleLabel}" | `name`, `role`, `expiresAt?` | STANDARD |
| `CONFIDENTIALITY_CHANGED` | `ProcessConfidentialityChanged` | "{actor} marcou o orçamento como sigiloso / público" | — | STANDARD |
| `STAGE_OVERDUE` | `ProcessStageOverdue` | "Prazo da etapa {stageName} vencido" | `stageName`, `dueAt` | STANDARD |
| `DOCUMENT_CREATED` | `DocumentCreated` | "{actor} criou {documentLabel}" | `documentCode`, `documentTitle`, `typeName` | STANDARD |
| `DOCUMENT_VERSION_CREATED` | `DocumentVersionCreated` | "{actor} gerou a versão {versionNumber} de {documentLabel}" | `versionNumber`, `reason` | STANDARD |
| `DOCUMENT_SUBMITTED` / `DOCUMENT_FINALIZED` | `DocumentSubmitted` / `DocumentFinalized` | "{actor} submeteu/concluiu {documentLabel}" | — | STANDARD (`BUDGET_RESTRICTED` para resumo de valores) |
| `DOCUMENT_APPROVED` / `DOCUMENT_RETURNED` / `DOCUMENT_REJECTED` | `Document*` | "{documentLabel} aprovado/devolvido/indeferido" | `approverName` | STANDARD |
| `DOCUMENT_REOPENED` / `DOCUMENT_CANCELED` / `DOCUMENT_WITHDRAWN` | `Document*` | "{actor} reabriu/cancelou/retirou {documentLabel}" | `reason?` | STANDARD |
| `APPROVAL_REQUESTED` | `ApprovalRequested` | "Aprovação solicitada a {approverLabel}" | `approverLabel`, `dueAt` | STANDARD |
| `APPROVAL_DECIDED` | `ApprovalCompleted`/`Returned`/`Rejected` | "{actor} {decisionLabel} — {title}" | `decision`, `asDeputy`, `hasComment` | STANDARD |
| `APPROVAL_CANCELED` / `APPROVAL_REASSIGNED` | `Approval*` | "Aprovação cancelada/redirecionada" | `reason`, `toApproverLabel?` | STANDARD |
| `COMMENT_ADDED` | `CommentCreated` | "{actor} comentou" (+ trecho de até 140 caracteres) | `excerpt`, `documentLabel?` | STANDARD; `BUDGET_RESTRICTED` quando o documento-alvo é `RESTRICTED` (US-071 · DEC-030). Comentário excluído depois: PRC-12 devolve `excerpt: null` e `commentDeleted: true` |
| `COMMENT_REMOVED` | `CommentDeleted` (moderação) | "Comentário removido por moderação" | — | STANDARD |
| `ATTACHMENT_ADDED` / `ATTACHMENT_REMOVED` | `Attachment*` | "{actor} anexou/removeu {fileName}" | `fileName`, `targetLabel` | STANDARD |
| `ETP_ALTERNATIVE_RECOMMENDED` | `EtpAlternativeRecommended` | "{actor} definiu a alternativa recomendada: {name}" | `name` | STANDARD |
| `QUOTATION_EXCLUDED` / `QUOTATION_RESTORED` | `Quotation*` | "{actor} desconsiderou/restaurou cotação do item {itemSequence}" | `itemSequence`, `sourceLabel`, `reasonLabel` | `BUDGET_RESTRICTED` se sigiloso |
| `RISK_ADDED` / `RISK_LEVEL_CHANGED` / `RISK_REMOVED` | `Risk*` | "{actor} registrou o risco {code} ({levelLabel})" | `code`, `title`, `level` | STANDARD |
| `TERM_IMPORTED_FROM_ETP` | `TermImportedFromEtp` | "{actor} importou dados do ETP (v{etpVersion}) para o TR" | `etpVersion`, `sectionsCount` | STANDARD |
| `AI_CONTENT_GENERATED` | `AiGenerationCompleted` | "{actor} gerou com IA {generationLabel} de {documentLabel}" (rascunho completo, proposta de riscos ou ajuste "{actionLabel}" da seção {sectionTitle}) | `kind`, `action?`, `sectionTitle?`, `targetModule`, `documentCode?`, `typeName`, `model`, `promptVersion` | STANDARD |
| `AI_CONTENT_APPLIED` | `AiContentApplied` | "{actor} aplicou conteúdo gerado por IA em {documentLabel}" (+ "{sectionsCount} seções" / "{risksCount} riscos") | `sectionsCount`, `risksCount`, `replacedFilledSections` | STANDARD |
| `AI_CONTENT_REVIEWED` | `AiContentReviewed` | "{actor} revisou o conteúdo gerado por IA em {documentLabel}" (+ contagens) | `sectionsCount`, `risksCount` | STANDARD |

Os nomes e rótulos dos `params` são resolvidos pelo projetor no momento do fato, por fontes dos módulos donos lidas na mesma transação, e nunca refeitos depois (DEC-077); `{documentLabel}` é gravado como `documentCode`, `documentTitle` e `typeName`. Um evento pode gerar mais de uma entrada (`PROCESS_CREATED` e `PROCESS_DUPLICATED_FROM`): a unicidade é por (`sourceEventId`, `type`). Evento ou discriminador sem linha nesta tabela é ignorado.

A coluna "Mensagem" é o dicionário `type` → texto compartilhado pela API e pelo web em `packages/types/src/timeline-messages.ts` (`TIMELINE_MESSAGE_TEMPLATES` e `renderTimelineEntry` — placeholders derivados como `{actor}`, `{documentLabel}`, `{fieldsLabel}`, `{roleLabel}`, `{decisionLabel}` e `{levelLabel}`); os grupos de apresentação do filtro de PRC-12 (RN-TML-12 da US-060) ficam em `TIMELINE_GROUP_TYPES` (`packages/types/src/timeline.ts`). Tipo novo entra nesta tabela, no registro, no dicionário e em um grupo.

---

## 6. Notificações derivadas de eventos

Registro `NotificationType`. Canais padrão: in-app sempre; e-mail conforme coluna. Usuário pode desativar canais não obrigatórios (US-113).

| `NotificationType` | Origem | Destinatários | E-mail padrão | Obrigatória |
|---|---|---|---|---|
| `PROCESS_RECEIVED` | `ProcessStageChanged` para etapa `TASK`/`START` | `toUserId`; se nulo, membros lotados na unidade de destino com `PROCESS_CLAIM` | ✔ | não |
| `PROCESS_RETURNED` | `ProcessStageChanged` (`RETURN`, `APPROVAL_RETURNED`, `APPROVAL_REJECTED`) | Responsável de destino (ou `PREVIOUS_ASSIGNEE`); senão membros da unidade | ✔ | não |
| `PROCESS_ASSIGNED` | `ProcessAssigned` (`MANUAL`, `RETURN`) | Novo responsável (exceto quando é o próprio ator) | ✔ | não |
| `PROCESS_STATUS_CHANGED` | `ProcessStatusChanged` (suspenso, retomado, cancelado, concluído) | Criador, responsável atual, participantes com `notify` | não | não |
| `APPROVAL_REQUESTED` | `ApprovalRequested` | Aprovador designado; titular + substituto (se `allowDeputy`); para `ROLE`, detentores do perfil com escopo sobre o processo (máx. 50, senão notifica a unidade atual) | ✔ | **sim** (in-app) |
| `APPROVAL_DECIDED` | `ApprovalCompleted`/`Returned`/`Rejected` | Solicitante e responsáveis (`responsibleId`) dos documentos cobertos | ✔ | não |
| `APPROVAL_REASSIGNED` | `ApprovalReassigned` | Novo aprovador; aprovador anterior | ✔ | não |
| `MENTIONED` | `UserMentioned` | Usuário mencionado (ou membros da unidade mencionada, máx. 50) com visibilidade do processo | ✔ | não |
| `COMMENT_REPLY` | `CommentCreated` com `parentId` | Autor do comentário pai (se ≠ ator) | não | não |
| `STAGE_DUE_SOON` | `ProcessStageDueSoon` | Responsável; se não houver, titular da unidade | não | não |
| `STAGE_OVERDUE` | `ProcessStageOverdue` | Responsável e titular da unidade | ✔ | não |
| `PARTICIPANT_ADDED` | `ProcessParticipantAdded` | Participante adicionado com `notify = true` (exceto quando o próprio ator se adiciona — "seguir", PRC-31) | ✔ | não |
| `ATTACHMENT_REJECTED` | `AttachmentRejected` | Quem enviou | não | **sim** |
| `DOCUMENT_RENDER_FAILED` | `DocumentRenditionFailed` (após esgotar tentativas) | Quem solicitou a renderização | não | não |
| `ROLE_CHANGED` | `RoleAssigned`/`RoleRevoked` | Usuário afetado (aviso de segurança) | ✔ | **sim** |
| `AI_GENERATION_READY` | `AiGenerationCompleted` | Solicitante da geração (`requestedById`); link para o editor com `?ia=<generationId>` | não | não |
| `AI_GENERATION_FAILED` | `AiGenerationFailed` | Solicitante da geração | não | não |
| `AI_USAGE_LIMIT_WARNING` | `AiUsageThresholdReached` (80% e 100% do limite mensal) | Vínculos ativos com `SETTINGS_MANAGE` (máx. 50) | ✔ | não |

Regras gerais:
- Nunca notificar o próprio ator. Exceção: avisos de conclusão de trabalho assíncrono pedido pelo próprio usuário — `AI_GENERATION_READY` e `AI_GENERATION_FAILED` (US-115) vão ao solicitante, e `ATTACHMENT_REJECTED` (US-068) a quem enviou o arquivo, que são o ator do envelope (o job roda com o ator de quem pediu).
- Agrupamento: notificações iguais (`type` + `processId` + destinatário) em 5 min são agrupadas em uma (`groupKey`) para evitar ruído.
- Conteúdo sem dados sigilosos (POL-09); link direto (`/processos/{id}`, `/aprovacoes/{id}`).
- E-mail somente se `notifications.emailEnabled` (tenant) e preferência do usuário permitirem: sem desejo de e-mail (preferência ou padrão do tipo) → `emailStatus = NOT_APPLICABLE`; desejado mas desligado no tenant → `SKIPPED`; senão `PENDING`. Notificação agrupada mantém o `emailStatus` que já tinha (sem novo e-mail por agrupamento).
- Destinatários por unidade ou perfil acima de 50: notifica o titular e o substituto da unidade ("notifica a unidade").
- Destinatário que depende de dado de outro módulo (`ProcessAccess`, atribuições de perfil, participantes, anexos, renderizações) só é resolvido quando a fonte do módulo dono existir; sem ela, nada é criado (falha fechada, log `notification.recipient_unresolved`) — US-111.

---

## 7. Catálogo de ações de auditoria

Escritas pelo `AuditService` na mesma transação do caso de uso (DEC-161). `category` entre parênteses. Toda ação negada por autorização registra `access.denied` (ACCESS, `DENIED`), com contenção de rajadas: até 20 registros por usuário (ou IP, se anônimo) e ação a cada 60 s; os excedentes são somados em `metadata.suppressedCount` do próximo registro (US-073). Parâmetros de coalescência e contenção são da plataforma (variáveis de ambiente), não do tenant. A categoria de cada ação é fixa no catálogo (`packages/types/src/audit.ts`): o caso de uso informa a ação e o `AuditService` deriva a categoria; ação sem categoria indicada na linha herda a da área.

| Área | Ações |
|---|---|
| Autenticação e acesso | `auth.session_start`, `auth.session_end`, `auth.session_expired`, `auth.mfa_required` (SECURITY), `auth.tenant_switch` (ACCESS), `access.denied` (ACCESS) |
| Plataforma | `tenant.provision`, `tenant.update`, `tenant.activate`, `tenant.suspend`, `tenant.offboard`, `tenant.deactivate` (SYSTEM); `support.access_grant`, `support.access_revoke` (SECURITY) |
| Configuração | `settings.update`, `organization.create`, `organization.update`, `department.create`, `department.update`, `department.move`, `department.deactivate`, `department.delete`, `catalog.create`, `catalog.update`, `catalog.deactivate`, `holiday.create`, `holiday.update`, `holiday.delete`, `tag.create`, `tag.update`, `tag.deactivate`, `document_type.create`, `document_type.update`, `template.create`, `template.update`, `template.version_create`, `template.version_publish`, `template.version_retire`, `workflow.create`, `workflow.update`, `workflow.version_create`, `workflow.version_publish`, `workflow.version_retire`, `workflow.set_default` (CONFIGURATION) |
| Identidade e perfis | `membership.invite`, `membership.activate`, `membership.update`, `membership.departments_update`, `membership.suspend`, `membership.reactivate`, `membership.revoke`, `membership.expire`, `membership.mfa_reset`, `role.create`, `role.update`, `role.permissions_update`, `role.deactivate`, `role.assign`, `role.revoke`, `profile.update`, `notification.preferences_update` (SECURITY) |
| Processo | `process.create`, `process.update`, `process.items_update`, `process.tags_update`, `process.discard_draft`, `process.number_assign`, `process.duplicate`, `process.participant_add`, `process.participant_remove`, `process.confidentiality_change` (DATA_CHANGE); `process.forward`, `process.return`, `process.claim`, `process.assign`, `process.suspend`, `process.resume`, `process.cancel`, `process.complete` (WORKFLOW); `process.confidential_view` (ACCESS — 1×/sessão/processo); `process.export` (EXPORT) |
| Aprovação | `approval.request`, `approval.decide`, `approval.withdraw`, `approval.reassign`, `approval.cancel` (WORKFLOW) |
| Documentos | `document.create`, `document.draft_update` (coalescida: 1 registro por documento/seção/usuário a cada 10 min, com intervalo de revisões e variação de tamanho), `document.items_update`, `document.version_create`, `document.submit`, `document.finalize`, `document.withdraw`, `document.reopen`, `document.cancel`, `document.delete`, `document.render_request`, `document.download` (EXPORT), `document.duplicate` (DATA_CHANGE) |
| Tipados | `etp.alternative_create`, `etp.alternative_update`, `etp.alternative_delete`, `etp.alternative_decide`, `price_research.source_create`, `price_research.source_update`, `price_research.source_delete`, `price_research.quotation_create`, `price_research.quotation_update`, `price_research.quotation_delete`, `price_research.quotation_exclude`, `price_research.quotation_restore`, `price_research.method_change`, `price_research.recalculate`, `price_research.import`, `price_research.complete` (US-032), `price_research.export` (EXPORT), `risk.create`, `risk.update`, `risk.assess`, `risk.delete`, `risk.treatment_create`, `risk.treatment_update`, `risk.treatment_delete`, `term.import_etp` (DATA_CHANGE) |
| Colaboração e arquivos | `comment.create`, `comment.update`, `comment.delete`, `comment.moderate`, `attachment.upload_intent`, `attachment.confirm`, `attachment.scan_result` (SYSTEM), `attachment.download` (EXPORT), `attachment.delete`, `supplier.create`, `supplier.update`, `supplier.deactivate`, `supplier.delete` (DATA_CHANGE) |
| Auditoria | `audit.search` (ACCESS), `audit.export` (EXPORT), `audit.seal` (SYSTEM) |
| IA (EP-020) | `ai.generation_request`, `ai.generation_discard`, `ai.content_apply`, `ai.content_review` (DATA_CHANGE); `ai.generation_complete`, `ai.generation_fail` (SYSTEM). `metadata`: `generationId`, `targetModule`, `kind`, `action`, `sectionKey(s)`/`riskIds`, `provider`, `model`, `promptKey`, `promptVersion`, `inputRefs` (ids, versões e hashes), `contextHash`, `outputHash`, tokens, `costUsd`, `errorCode` — nunca o texto do resumo, da instrução, do contexto ou da saída. Ligar/desligar a IA e alterar limites = `settings.update` (CONFIGURATION) |
| Operação de filas (plataforma — US-083) | `queue_dashboard.access` (ACCESS — concedido ou negado); `outbox.republish`, `dead_letter.retry`, `dead_letter.discard` (SYSTEM). Sempre `actorType = PLATFORM_OPERATOR`; `tenantId` do job/evento afetado quando houver, senão de plataforma; ticket e motivo em `metadata` |

Regras de conteúdo da auditoria:
- Coalescência de `document.draft_update` no autosave (US-015 · RN-DFD-35): janela de 10 min por (documento, alvo — `SECTION:<CHAVE>`/`HEADER`/`ITEMS` —, usuário) aberta no Redis (`SET NX`) antes da transação; o registro leva `fromRevision` (primeira revisão ainda não auditada do usuário/alvo), `toRevision`, `sizeBytesBefore`/`sizeBytesAfter`, `contentHash` e `windowMinutes`. Redis indisponível → audita toda gravação (*fail-safe*, `warn audit.coalesce_store_unavailable`). Sobrescrita após conflito (`conflictResolution = KEEP_MINE`) e campos estruturados do cabeçalho são imediatos. A auditoria continua *append-only*: a janela só decide se a gravação gera registro.
- `changes` registra somente campos alterados; campos sensíveis mascarados (`cpf`, tokens) e conteúdo rico resumido (hash + tamanho), nunca o texto completo.
- `metadata` inclui, quando aplicável: `processCode`, `documentCode`, `fromStatus`/`toStatus`, `ruleViolations`, `warningsAcknowledged`, `idempotencyKey`.

---

## 8. Versionamento e evolução

- Campo novo opcional no payload → mesma versão.
- Remoção/renomeação/mudança de semântica → `eventVersion + 1`; o produtor publica a nova versão e, por um período de transição, consumidores tratam ambas (upcaster em `packages/validation/src/events/upcasters.ts`).
- Eventos são documentados aqui **antes** de serem produzidos; o CI valida que todo `eventType` emitido existe no registro `packages/types/src/events.ts`.
- MVP 3 expõe um subconjunto destes eventos como **webhooks** públicos (contratos estáveis e versionados separadamente).
