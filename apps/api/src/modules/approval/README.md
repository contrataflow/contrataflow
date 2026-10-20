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

## Retirar ou redirecionar aprovação pendente (US-053)

- **Rotas:** APV-04 `POST /approvals/{id}/withdraw` (`@ImplicitAccess` + `@Policy('POL-17')` — a
  regra é do dono do sujeito), APV-05 `POST /approvals/{id}/reassign` (`APPROVAL_REASSIGN` em algum
  escopo no guard; cobrindo o processo no caso de uso) e DOC-11 `POST /documents/{id}/withdraw`
  (no `document`, pela porta `DocumentApprovalRegistry.withdrawForDocument`). Todas com
  `@Idempotent` e `@RequireIfMatch`. Contratos em
  `packages/validation/src/approval/approval-withdrawal.ts`; evento `ApprovalReassigned` em
  `approval/events.ts`.
- **Retirada:** `ApprovalWithdrawalService.withdrawIn` (sem transação própria — o APV-04 roda no
  `WithdrawApprovalCommand`, o DOC-11 no `WithdrawDocumentCommand`). Ordem: aprovação do tenant
  (404) → `prepareDecision` do dono do sujeito (trava o processo) → `lockForUpdate` → não `PENDING`
  = 409 antes do `If-Match` (412; no DOC-11 o `If-Match` é o do documento) → `canWithdraw` (POL-17,
  403 `access.denied` com `reasonCode = APPROVAL_WITHDRAW`) → processo suspenso/final = 409 →
  `CANCELED` (`cancellationReason = WITHDRAWN`) + `ApprovalCanceled` → `applyWithdrawal` → auditoria
  `approval.withdraw`. Donos do sujeito: `process` (custódia anterior = solicitante ou lotado na
  unidade da passagem de origem, com `PROCESS_FORWARD` sobre ela; devolução pelo
  `StageTransitionService` à passagem `sequence − 1`, `RETURN` com `metadata.withdrawn`, comentário
  = motivo ou texto fixo — a `RETURN` exige comentário no banco) e `document` (permissão de
  submissão do tipo). Documentos: `releaseCanceledApproval` (`automatic: false`).
- **Redirecionamento:** `ReassignApprovalCommand` — novo aprovador pela resolução da US-051
  (`ApproverResolver.preview`; `ROLE` também precisa de `APPROVAL_DECIDE`), igual ao atual ou
  inelegível = 422 `APPROVER_NOT_ELIGIBLE`, autor de documento coberto = 403
  `SELF_APPROVAL_FORBIDDEN`. Só os campos do aprovador e `allowDeputy` mudam (RN-TRAM-70). O
  `ProcessAccessProjector` (`approval.reassigned`) revoga os `APPROVER` com `sourceId` = aprovação e
  concede ao novo (e ao substituto, com `allowDeputy`). O motivo NUNCA é persistido, logado ou
  publicado — só `hasReason`.
- **APV-02:** `meta.allowedActions` ganha `WITHDRAW` (POL-17) e `REASSIGN` (`APPROVAL_REASSIGN`
  cobrindo o processo) enquanto a aprovação está pendente e o processo nem suspenso nem final.
- **Testes:** `domain/approval-withdrawal.spec.ts`,
  `process/presentation/approval-withdrawal.routes.spec.ts` (8 categorias, em memória) e
  `test/tenant-leak/approval-withdrawal.spec.ts` (PostgreSQL: falha induzida, corrida com a decisão,
  outbox `PENDING`, troca do `APPROVER`, outro tenant).

## Lista de aprovações (US-057)

- **Rota:** APV-01 `GET /approvals` (`@ImplicitAccess` — sem cobertura, `data: []`, nunca 403).
  Contrato em `packages/validation/src/approval/approval-list.ts` (`approvalListQuerySchema` —
  `status` múltiplo com padrão `PENDING`, período invertido = 422, `sort` `requestedAt|dueAt|code`).
- **Cobertura (POL-03 · RN-INBOX-14) como predicado, nunca pós-filtro:** `domain/approval-list.ts`
  (`isDesignatedApprover`/`isInApprovalList`, puros) e `infrastructure/approval-list.sql.ts`
  (`designatedSql`/`coverageSql`, linha a linha o mesmo). Entra quem é designado AGORA (titular e
  substituto atuais — `OrganizationFacade.departmentLeadership`; perfis — `AccessFacade.approverCompetenceIn`)
  e quem decidiu (`decided_by_id`). O mesmo predicado vive em `inbox` (`task-inbox.sql.ts`, visão
  `PENDING_APPROVALS`): mudou a regra, mude os dois.
- **Leitura:** `approvals` com o processo pela view `v_inbox_processes` (do `process`), página e total
  numa instrução, `statement_timeout` 3 s (→ 503). `ListApprovalsHandler` resolve a cobertura, valida
  `requestingDepartmentId` (`departmentReferences` → 422 `REFERENCE_NOT_FOUND`) e o fuso do tenant
  (`BusinessCalendarFacade.timezone`) para o período. Leitor em memória no modo de identidade fake.
- **Observabilidade:** `info approvals.query` (forma dos filtros; nunca `q` nem título),
  `error approvals.query_failed`, histograma `cf_approval_list_query_duration_ms`.
