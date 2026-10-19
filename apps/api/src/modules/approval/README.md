# `approval`

Solicitação de aprovação, resolução de aprovador e decisão (DEC-040 · DEC-022).

## Solicitar aprovação e resolver o aprovador (US-051)

Sem comando nem transação própria: roda no `tx` da ação de origem e qualquer falha a desfaz inteira.

- **Disparo A — etapa** (`subjectType = PROCESS_STAGE`): o encaminhamento (PRC-19, US-047) entra
  numa etapa `APPROVAL`. Pela `ApprovalFacade`: `previewStageApproverIn` (PRC-08 `approverPreview`),
  `resolveStageApproverIn` (ANTES de qualquer escrita) e `requestForStageIn` (depois da nova
  passagem — FK). A submissão dos documentos cobertos (`DRAFT`/`RETURNED` → `IN_REVIEW`, versão
  `SUBMISSION`; `FINALIZED`/`APPROVED` só ganham `pendingApprovalId`) é de quem encaminha
  (`DocumentFacade.enterApprovalStageIn` — `document` está no mesmo nível).
- **Disparo B — avulso** (`subjectType = DOCUMENT`): a submissão DOC-09 de um tipo com
  `requiresApproval`, pela porta `DocumentApprovalRegistry` do shared kernel
  (`ApprovalRequestService.requestForDocumentSubmission`); aprovador pela `approvalPolicy`
  (`approverConfigOfPolicy`), cobertura = o próprio documento, `dueAt` e `requestComment` nulos.

Peças:

- `domain/approval.ts` — `resolveApprover(config, facts)` puro (RN-TRAM-47..49): `USER` com vínculo
  ativo; `ROLE` grava só o perfil, desde que haja detentor competente; `DEPARTMENT_HEAD` = titular
  atual com vínculo ativo, `allowDeputy = true` (sempre — também na avulsa). Motivos de recusa em
  `ApproverUnresolvedError.reason` (logs/métricas).
- `ApproverResolver` — lê no `tx` a unidade (`OrganizationFacade.findDepartmentForApproval`), os
  vínculos (`IdentityFacade.membersInTenant`) e os detentores do perfil
  (`AccessFacade.roleHoldersInScopeIn` — escopo `TENANT`, órgão do processo ou
  `DEPARTMENT`/`OWN_DEPARTMENTS` contendo a unidade solicitante; `CURRENT`/`HISTORICAL` nunca
  contam). Sem aprovador → 422 `APPROVER_UNRESOLVED` (+ `warn approval.role_scope_empty` para perfil
  vazio e `error approval.request_failed`).
- `ApprovalRequestService` — `Approval` `PENDING` + `ApprovalDocument` (versão exata), auditoria
  `approval.request` e `ApprovalRequested` no outbox. Índices de pendência única
  (`approvals_pending_stage_key`/`_document_key`) → 409 `APPROVAL_NOT_PENDING`. Log
  `info approval.requested` (`resolvedVia`, `durationMs`; nunca o `requestComment`), métricas
  `cf_approval_requested_total`, `cf_approval_request_duration_ms`,
  `cf_approval_request_failed_total`, span `approval.request`.

Efeitos síncronos do `ApprovalRequested` (mesmo `tx`): timeline `APPROVAL_REQUESTED` (fonte `ROLE`
registrada no `timeline`) e `ProcessAccess` `APPROVER` do aprovador e, com `allowDeputy`, do
substituto da unidade (`ProcessAccessProjector`). No worker: `APPROVAL_REQUESTED` obrigatória em
app — `ROLE_HOLDERS` (`RoleHoldersLookup`) para perfil, até 50; acima, titular e substituto da
unidade atual.

## Decidir aprovação (US-052)

- **Rotas:** APV-02 `GET /approvals/{id}` e APV-03 `POST /approvals/{id}/decide`
  (`presentation/approval.controller.ts`; `@Idempotent`, `@RequireIfMatch` → 428,
  `APPROVAL_DECIDE` em algum escopo no guard com o 2º fator, `@Policy('POL-03')`). Contratos em
  `packages/validation/src/approval/approval-decision.ts` (`decideApprovalSchema` — com
  `transitionId` para escolher a devolução —, `approvalSchema`, `approvalMetaSchema`,
  `decidedApprovalSchema`, `decisionCommentIssues`). Eventos `ApprovalCompleted`/`Returned`/
  `Rejected` em `approval/events.ts`.
- **Coordenador:** `DecideApprovalCommand` (`TransactionalCommandHandler`, transações
  `APPROVAL_TRANSACTIONS`). Os efeitos são do dono do sujeito pela porta
  `#shared/approval/approval-subject.ts` (`ApprovalSubjectRegistry`): `process` registra
  `PROCESS_STAGE` (`ProcessApprovalSubjectHandler`) e `document` registra `DOCUMENT`
  (`DocumentApprovalSubjectHandler`). Ordem: aprovação do tenant (404 `APPROVAL_NOT_FOUND`) →
  `prepareDecision` (trava o processo — ordem processo → aprovação → documentos) →
  `lockForUpdate` da aprovação → não `PENDING` = 409 `APPROVAL_NOT_PENDING` ANTES do `If-Match`
  (412) → POL-03 (`ApprovalDecisionPolicy`: titular/substituto ATUAIS da unidade, detentores do
  perfil pelo mesmo predicado da US-051, `USER`; 403 `NOT_DESIGNATED_APPROVER` e, com
  `approval.preventSelfApproval`, `SELF_APPROVAL_FORBIDDEN` — ambos `access.denied`) → processo
  suspenso/final = 409 `INVALID_PROCESS_STATUS` → `planDecision` (sem escrita: regras, destino,
  aprovador da próxima etapa) → `recordDecision` (`WHERE status = PENDING AND version`) + evento →
  `applyDecision` → `approval.decide`. Depois do commit, os `afterCommit` (selo na fila).
- **Detalhe:** `GetApprovalQuery` — visível ao designado, ao solicitante e ao decisor; senão
  processo visível + `APPROVAL_VIEW` (403 sem a permissão; não visível = 404). `meta` repete as
  checagens do APV-03 (`decisionBlockerOf`) e traz `decisionOptions` do dono do sujeito.
- **Domínio:** `domain/approval-decision.ts` (`ApprovalRecord`, `decideApproval`,
  `designationOf`, `isSelfApproval`, `isDecidableProcessStatus`, `decisionBlockerOf`).
- **Observabilidade:** logs `approval.decided`, `approval.decide_rejected`,
  `approval.decide_failed` (base), `approval.chained` (process) e `rendition.enqueue_failed`
  (document); métricas `cf_approval_decided_total`, `cf_approval_decide_duration_ms`,
  `cf_approval_decide_failed_total`; spans `approval.decide.plan`/`.effects`. Nunca o comentário.
- **Worker:** `APPROVAL_DECIDED` ao solicitante e aos responsáveis dos documentos cobertos
  (`ApprovalStakeholdersLookup` — `APPROVAL_STAKEHOLDERS`).
- **Testes:** `domain/approval-decision.spec.ts`,
  `process/presentation/approval-decision.routes.spec.ts` (8 categorias, em memória — no `process`,
  que pode depender do `approval`, como o da US-051) e `test/tenant-leak/approval-decision.spec.ts`
  (PostgreSQL: falha induzida, corrida, RLS).
