# `inbox`

Caixa de tarefas — somente consultas sobre views publicadas (DEC-040, DEC-026).

- **US-056 (TSK-01/TSK-02):** `TasksController` → `GetTaskInboxHandler`/`GetTaskInboxCountersHandler`.
  Cada visão (`MINE`, `UNIT_QUEUE`, `PENDING_APPROVALS`, `RETURNED`, `OVERDUE`, `FOLLOWING`) é um
  predicado puro em `domain/task-inbox.ts`, repetido em SQL por `infrastructure/task-inbox.sql.ts`
  sobre as views `security_invoker` da migração `20261019150000_task_inbox_views`
  (`v_inbox_processes` e `v_inbox_participations` do `process`; `v_inbox_pending_approvals` do
  `approval`). Página + total e todos os contadores saem, cada um, de uma instrução (RN-INBOX-09).
- Quem consulta (`InboxViewerResolver`): permissões efetivas (`access`), titular/substituto
  (`OrganizationFacade.departmentLeadership`) e a cobertura dos perfis aprovadores
  (`AccessFacade.approverCompetenceIn`). Nomes e o DTO `deadline` vêm das fachadas donas
  (`workflow`, `organization`, `identity`, `ProcessFacade.stageDeadlinesIn`).
- O "Assumir" da fila é o PRC-21 do `process` (US-049), com `Idempotency-Key` opcional.
- As ações em lote da fila (US-058 · TSK-03/TSK-04) moram no `process` (`TaskBulkController`),
  sobre o PRC-21/PRC-22 por item.
- **Fachada (US-076):** `InboxFacade.countersIn(tx, now, restriction)` — os contadores de TSK-02 no
  `tx` do chamador, com recorte opcional pela unidade solicitante (`matchesRestriction`), para o
  `PENDING_ITEMS`/`pendingCount` do dashboard nunca divergirem da caixa (RN-DASH-03 · DEC-088).
