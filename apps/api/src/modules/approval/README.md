# `approval`

Solicitação de aprovação, resolução de aprovador e decisão (DEC-040).

- **Avulsa (US-065):** `DocumentApprovalRequestService` na porta `DocumentApprovalRegistry` —
  `subjectType = DOCUMENT`, aprovador pela `DocumentType.approvalPolicy`.
- **De etapa (US-047 → US-051):** `StageApprovalService`, exposto pela `ApprovalFacade`
  (`previewStageApproverIn`, `resolveStageApproverIn`, `requestForStageIn`). Aprovador pela
  configuração da etapa `APPROVAL` (`resolveStageApprover`: `USER`/`ROLE` diretos; `DEPARTMENT_HEAD`
  registra a unidade e o titular atual, `allowDeputy = true`; sem titular/inativa → 422
  `APPROVER_UNRESOLVED`), `Approval` `PENDING` com a cobertura (`ApprovalDocument`), `approval.request`
  e `ApprovalRequested` no `tx` do encaminhamento. A submissão dos documentos cobertos é de quem
  encaminha (`DocumentFacade.enterApprovalStageIn` — `document` está no mesmo nível).
