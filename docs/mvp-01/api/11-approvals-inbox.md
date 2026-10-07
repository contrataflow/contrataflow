# 3.11 Aprovações e caixa de tarefas (`approval`, `inbox`)

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2.

| ID | Método | Rota | Permissão | Story |
|---|---|---|---|---|
| APV-01 | GET | `/approvals` | `APPROVAL_VIEW` (ou designado) | US-057 |
| APV-02 | GET | `/approvals/{id}` | `APPROVAL_VIEW` ou designado | US-052 |
| APV-03 | POST | `/approvals/{id}/decide` | `APPROVAL_DECIDE` + POL-03 | US-052 |
| APV-04 | POST | `/approvals/{id}/withdraw` | `PROCESS_FORWARD` + POL-17 | US-053 |
| APV-05 | POST | `/approvals/{id}/reassign` | `APPROVAL_REASSIGN` | US-053 |
| TSK-01 | GET | `/tasks` | `INBOX_VIEW` | US-056 |
| TSK-02 | GET | `/tasks/counters` | `INBOX_VIEW` | US-056 |
| TSK-03 | POST | `/tasks/bulk-claim` | `PROCESS_CLAIM` | US-058 |
| TSK-04 | POST | `/tasks/bulk-assign` | `PROCESS_ASSIGN` (ou titular) | US-058 |

### APV-01 — Listar aprovações
`GET /api/v1/approvals` · **Permissão:** `APPROVAL_VIEW` (ou designado à aprovação) · **Story:** US-057
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** query `status` (enum múltiplo `ApprovalStatus`, opcional, padrão `PENDING`); `subjectType` (enum `ApprovalSubjectType`, opcional); `requestingDepartmentId` (uuid, opcional, unidade ativa do tenant); `requestedFrom`/`requestedTo` (data, opcional, `requestedFrom` ≤ `requestedTo`); `q` (texto, opcional, ≥2 caracteres); paginação padrão; ordenação: `sort` (padrão `-requestedAt`, campos permitidos conforme RN-INBOX-18 — lista completa não enumerada na story: a definir na implementação)
- **Request:** —
- **Response:** `200 { data: [{ id, subjectType, process: { id, code, title }, document?, requestingDepartment, requestedBy, requestedAt, dueAt?, status }], meta: { page, pageSize, totalItems, totalPages } }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `APPROVAL_VIEW` nem designação |
  | 422 | `VALIDATION_ERROR` | Enum inválido; período invertido; `requestingDepartmentId` de outro tenant (`REFERENCE_NOT_FOUND`) |
- **Efeitos:** —
- **Notas:** leitura; não gera auditoria.

### APV-02 — Obter aprovação
`GET /api/v1/approvals/{id}` · **Permissão:** `APPROVAL_VIEW` ou designado · **Story:** US-052
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: Approval }` com `documents[]`, `meta.allowedActions` (api.md §1.5) · `ETag: "<version>"`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `APPROVAL_VIEW` nem designação |
  | 404 | `NOT_FOUND` | Inexistente, outro tenant ou não visível |
- **Efeitos:** —
- **Notas:** —

### APV-03 — Decidir aprovação
`POST /api/v1/approvals/{id}/decide` · **Permissão:** `APPROVAL_DECIDE` + POL-03 (segregação de funções) · **Story:** US-052
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** `{ decision: ApprovalDecision ('APPROVE'|'RETURN'|'REJECT', obrigatório); comment?: string (≥10 e ≤5000; condicional — obrigatório se decision ∈ {'RETURN','REJECT'}, RN-TRAM-55); acknowledgedWarnings?: uuid[] (padrão []; só enviado após confirmação explícita na UI) }`
- **Response:** `200 { data: Approval }` com `processStage: { key, name }`, `processStatus`, `ETag` nova
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `NOT_DESIGNATED_APPROVER` | Usuário não é o aprovador designado (POL-03) |
  | 403 | `SELF_APPROVAL_FORBIDDEN` | Segregação de funções (autor de documento coberto) |
  | 403 | `MEMBERSHIP_INACTIVE` / `TENANT_SUSPENDED` | Vínculo ou tenant inativo |
  | 409 | `APPROVAL_NOT_PENDING` | Aprovação já decidida |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `VALIDATION_ERROR` | `decision` ausente/fora do enum; `comment` ausente/curto em `RETURN`/`REJECT` |
  | 422 | `WARNINGS_NOT_ACKNOWLEDGED` | Avisos `WARNING` não reconhecidos |
  | 422 | `TRANSITION_BLOCKED` | Regra `BLOCKING` não satisfeita |
  | 422 | `APPROVER_UNRESOLVED` | Aprovador da próxima etapa não resolvido |
  | 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave com corpo diferente |
- **Efeitos:**
  - Eventos: `ApprovalCompleted` (`approval.completed`, decisão `APPROVE`: `documentVersionIds[]`, `decidedAsDeputy`) · `ApprovalReturned` (`approval.returned`, decisão `RETURN`: idem + `hasComment: true`) · `ApprovalRejected` (`approval.rejected`, decisão `REJECT`) · `ProcessStageChanged` (`process.stage_changed.<cause>`, `cause` ∈ `APPROVAL_APPROVED`\|`APPROVAL_RETURNED`\|`APPROVAL_REJECTED`) · `ProcessStatusChanged` (`process.status_changed.<status>`, quando o status macro muda) · `ApprovalRequested` (`approval.requested`, se a próxima etapa também é `APPROVAL` — RN-TRAM-60)
  - Timeline: entrada `PROCESS_STAGE_CHANGED` (ou equivalente); `ProcessAccess` `APPROVER` criado para a nova aprovação quando aplicável
  - Auditoria: `approval.decide` (`WORKFLOW`; `changes`: `status`, `decision`; `metadata`: `processCode`, `fromStatus`/`toStatus`, `documentIds[]`, `warningsAcknowledged`, `decidedAsDeputy`) · `access.denied` (`reasonCode = APPROVAL_DECIDE`, `approvalId`)
- **Notas:** POL-03 exige que o decisor seja o aprovador designado (ou substituto elegível); segregação de funções impede autoaprovação de documento próprio.

### APV-04 — Retirar aprovação
`POST /api/v1/approvals/{id}/withdraw` · **Permissão:** `PROCESS_FORWARD` + política POL-17 (custódia anterior) · **Story:** US-053
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** `{ reason?: string (≤2000) }`
- **Response:** `200 { data: Approval }` com `processStage` atual, `ETag` nova
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem custódia anterior (POL-17) ou sem `PROCESS_FORWARD` |
  | 409 | `APPROVAL_NOT_PENDING` | Aprovação já decidida ou retirada |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave com corpo diferente |
- **Efeitos:**
  - Eventos: `ApprovalCanceled` (`approval.canceled`; `reason = WITHDRAWN`) · `ProcessStageChanged` (`process.stage_changed.return`; `cause = RETURN`, `approvalId` preenchido)
  - Auditoria: `approval.withdraw` (`WORKFLOW`; `metadata`: `processCode`/`documentCode`, `subjectType`, `hasReason`) · `access.denied` (`reasonCode`, `approvalId`)
- **Notas:** POL-17 restringe a retirada a quem tramitou o processo para a etapa de aprovação atual (custódia anterior).

### APV-05 — Redirecionar aprovação
`POST /api/v1/approvals/{id}/reassign` · **Permissão:** `APPROVAL_REASSIGN` · **Story:** US-053
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` Obrigatório
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** `{ approverType: ApproverType ('USER'|'ROLE'|'DEPARTMENT_HEAD', obrigatório); targetApproverUserId?: uuid (obrigatório se 'USER'); targetApproverRoleId?: uuid (obrigatório se 'ROLE'); targetApproverDepartmentId?: uuid (obrigatório se 'DEPARTMENT_HEAD'); reason: string (≥10 e ≤2000, obrigatório) }`
- **Response:** `200 { data: Approval }` · `ETag` nova
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `SELF_APPROVAL_FORBIDDEN` | Novo aprovador violaria segregação de funções |
  | 403 | `PERMISSION_DENIED` | Sem `APPROVAL_REASSIGN` |
  | 409 | `APPROVAL_NOT_PENDING` | Aprovação já decidida ou retirada |
  | 412 | `VERSION_CONFLICT` | `If-Match` divergente |
  | 422 | `APPROVER_NOT_ELIGIBLE` | Novo aprovador igual ao atual ou inelegível para o processo |
  | 422 | `VALIDATION_ERROR` (`TOO_SHORT`) | `reason` ausente ou com menos de 10 caracteres |
  | 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave com corpo diferente |
- **Efeitos:**
  - Eventos: `ApprovalReassigned` (`approval.reassigned`; `fromApproverUserId?`, `toApproverUserId?`, `toApproverRoleId?`)
  - Auditoria: `approval.reassign` (`WORKFLOW`; `changes`: `approverUserId`/`approverRoleId`/`approverDepartmentId`; `metadata.hasReason`) · `access.denied` (`reasonCode`, `approvalId`)
- **Notas:** exatamente um dos três campos `targetApprover*` deve ser informado, conforme `approverType` (RN-TRAM-69).

### TSK-01 — Listar tarefas (caixa de tarefas)
`GET /api/v1/tasks` · **Permissão:** `INBOX_VIEW` · **Story:** US-056
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** query `view` (enum `MINE`\|`UNIT_QUEUE`\|`PENDING_APPROVALS`\|`RETURNED`\|`OVERDUE`\|`FOLLOWING`, opcional, padrão `MINE` — RN-INBOX-02); `page` (int ≥1, padrão 1); `pageSize` (int 1–100, padrão 20); `sort` (texto, padrão `-dueAt`, campos permitidos por visão conforme RN-INBOX-10 — lista completa não enumerada na story: a definir na implementação)
- **Request:** —
- **Response:** `200 { data: [{ processId, code, title, currentStage, currentDepartment, currentResponsible?, dueAt, isOverdue, approval? }], meta: { page, pageSize, totalItems, totalPages } }`
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `INBOX_VIEW` |
  | 422 | `VALIDATION_ERROR` | `view`/`sort` fora do enum; `pageSize` acima de 100 |
- **Efeitos:** — (leitura; a ação rápida "Assumir" é `PRC-21`, reaproveitada de US-049, fora desta seção)
- **Notas:** `isOverdue` derivado de `overdueSince`.

### TSK-02 — Obter contadores da caixa de tarefas
`GET /api/v1/tasks/counters` · **Permissão:** `INBOX_VIEW` · **Story:** US-056
- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** —
- **Request:** —
- **Response:** `200 { data: { mine, unitQueue?, pendingApprovals, returned, overdue, following } }` (contadores por visão — RN-INBOX-09)
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem `INBOX_VIEW` |
- **Efeitos:** —
- **Notas:** `unitQueue` presente apenas quando a visão de fila da unidade é aplicável ao usuário.

### TSK-03 — Assumir processos em lote
`POST /api/v1/tasks/bulk-claim` · **Permissão:** `PROCESS_CLAIM` · **Story:** US-058
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Parâmetros:** —
- **Request:** `{ processIds: uuid[] (mínimo 2, máximo 50, sem repetição — RN-INBOX-19) }`
- **Response:** `200 { data: [{ processId, ok, code?, message?, process? }], meta: { successCount, errorCount } }` — resultado por item do lote
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem permissão base para ação em lote |
  | 422 | `VALIDATION_ERROR` (`TOO_SHORT`) | `processIds` com menos de 2 itens |
  | 422 | `VALIDATION_ERROR` (`TOO_LONG`) | `processIds` com mais de 50 itens |
  | 422 | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) | Item repetido em `processIds` |
  | 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave com corpo diferente |

  Erros por item (dentro do array `data[]`, resposta `200`): `PROCESS_ALREADY_ASSIGNED` (processo já assumido por outra pessoa) · `REFERENCE_NOT_FOUND` (item de outro tenant/inexistente).
- **Efeitos:** Evento `ProcessAssigned` (`process.assigned`; `assignmentType = CLAIM`) por item bem-sucedido; auditoria `process.claim` (`WORKFLOW`; `metadata.batchId`, `metadata.idempotencyKey`) por item bem-sucedido; `access.denied` (`reasonCode = PROCESS_CLAIM`) se o lote inteiro for rejeitado por falta de permissão base
- **Notas:** lote de 2 a 50 `processId` distintos (RN-INBOX-19): menos de 2 → `TOO_SHORT`; mais de 50 → `TOO_LONG` (api.md §3 alinhado).

### TSK-04 — Atribuir processos em lote
`POST /api/v1/tasks/bulk-assign` · **Permissão:** `PROCESS_ASSIGN` (ou titular da unidade) · **Story:** US-058
- **Cabeçalhos:** `Idempotency-Key` Obrigatório · `If-Match` —
- **Parâmetros:** —
- **Request:** `{ processIds: uuid[] (mínimo 2, máximo 50, sem repetição — RN-INBOX-19); assigneeId: uuid (obrigatório; vínculo ativo, lotado na unidade atual, com `PROCESS_VIEW`); reason: string (obrigatório, não vazio) }`
- **Response:** `200 { data: [{ processId, ok, code?, message?, process? }], meta: { successCount, errorCount } }` — resultado por item do lote
- **Erros:**
  | HTTP | code | quando |
  |---|---|---|
  | 403 | `PERMISSION_DENIED` | Sem permissão base para ação em lote |
  | 422 | `VALIDATION_ERROR` (`TOO_SHORT`) | `processIds` com menos de 2 itens |
  | 422 | `VALIDATION_ERROR` (`TOO_LONG`) | `processIds` com mais de 50 itens |
  | 422 | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) | Item repetido em `processIds` |
  | 422 | `VALIDATION_ERROR` (`REQUIRED`) | `assigneeId`/`reason` ausentes |
  | 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave com corpo diferente |

  Erros por item (dentro do array `data[]`, resposta `200`): `PROCESS_ALREADY_ASSIGNED` · `REFERENCE_NOT_FOUND`.
- **Efeitos:** Evento `ProcessAssigned` (`process.assigned`; `assignmentType = MANUAL`) por item bem-sucedido; auditoria `process.assign` (`WORKFLOW`; `metadata.batchId`, `reason`) por item bem-sucedido; `access.denied` (`reasonCode = PROCESS_ASSIGN`) se o lote inteiro for rejeitado por falta de permissão base
- **Notas:** mesmo limite de lote de TSK-03 (2 a 50, RN-INBOX-19).
