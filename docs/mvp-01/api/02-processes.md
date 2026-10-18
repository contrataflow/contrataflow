# Processos (`process`)

> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2.

| ID | Método | Rota | Permissão | Story |
|---|---|---|---|---|
| PRC-01 | GET | `/processes` | `PROCESS_VIEW` | US-002 |
| PRC-02 | POST | `/processes` | `PROCESS_CREATE` | US-001 |
| PRC-03 | POST | `/processes/check-duplicates` | `PROCESS_CREATE` | US-001 |
| PRC-04 | GET | `/processes/{id}` | `PROCESS_VIEW` | US-004 |
| PRC-05 | PATCH | `/processes/{id}` | `PROCESS_UPDATE` + POL-01 | US-005 |
| PRC-06 | DELETE | `/processes/{id}` | criador com `PROCESS_CREATE` ou `PROCESS_CANCEL` | US-009 |
| PRC-07 | GET | `/processes/{id}/summary` | `PROCESS_VIEW` | US-004 |
| PRC-08 | GET | `/processes/{id}/available-actions` | `PROCESS_VIEW` | US-004, US-041 |
| PRC-09 | GET | `/processes/{id}/checklist` | `PROCESS_VIEW` | US-004, US-041 |
| PRC-10 | GET | `/processes/{id}/stages` | `PROCESS_VIEW` | US-004, US-054 |
| PRC-11 | GET | `/processes/{id}/movements` | `PROCESS_VIEW` | US-054 |
| PRC-12 | GET | `/processes/{id}/timeline` | `PROCESS_VIEW` | US-060 |
| PRC-13 | GET | `/processes/{id}/items` | `PROCESS_VIEW` | US-006 |
| PRC-14 | POST | `/processes/{id}/items` | `PROCESS_UPDATE` + POL-01 | US-006 |
| PRC-15 | PATCH | `/process-items/{itemId}` | `PROCESS_UPDATE` + POL-01 | US-006 |
| PRC-16 | DELETE | `/process-items/{itemId}` | `PROCESS_UPDATE` + POL-01 | US-006 |
| PRC-17 | POST | `/processes/{id}/items/reorder` | `PROCESS_UPDATE` + POL-01 | US-006 |
| PRC-18 | PUT | `/processes/{id}/tags` | `PROCESS_UPDATE` + POL-01 | US-007 |
| PRC-19 | POST | `/processes/{id}/forward` | `PROCESS_FORWARD` + POL-01 | US-047 |
| PRC-20 | POST | `/processes/{id}/return` | `PROCESS_RETURN` + POL-01 | US-048 |
| PRC-21 | POST | `/processes/{id}/claim` | `PROCESS_CLAIM` + POL-04 | US-049 |
| PRC-22 | POST | `/processes/{id}/assign` | `PROCESS_ASSIGN` ou titular/substituto + POL-05 | US-050 |
| PRC-23 | POST | `/processes/{id}/suspend` | `PROCESS_SUSPEND` + POL-07 | US-008 |
| PRC-24 | POST | `/processes/{id}/resume` | `PROCESS_SUSPEND` + POL-07 | US-008 |
| PRC-25 | POST | `/processes/{id}/cancel` | `PROCESS_CANCEL` + POL-06 | US-009 |
| PRC-26 | POST | `/processes/{id}/complete` | `PROCESS_COMPLETE` + POL-08 | US-010 |
| PRC-27 | POST | `/processes/{id}/duplicate` | `PROCESS_DUPLICATE` + `PROCESS_CREATE` | US-011 |
| PRC-28 | GET | `/processes/{id}/participants` | `PROCESS_VIEW` | US-012 |
| PRC-29 | POST | `/processes/{id}/participants` | `PROCESS_MANAGE_PARTICIPANTS` + POL-10 | US-012 |
| PRC-30 | DELETE | `/process-participants/{participantId}` | `PROCESS_MANAGE_PARTICIPANTS` | US-012 |
| PRC-31 | POST | `/processes/{id}/follow` | `PROCESS_FOLLOW` | US-012 |
| PRC-32 | DELETE | `/processes/{id}/follow` | `PROCESS_FOLLOW` | US-012 |
| PRC-33 | PUT | `/processes/{id}/confidentiality` | `PROCESS_SET_CONFIDENTIAL_BUDGET` | US-013 |
| PRC-34 | GET | `/processes/export` | `PROCESS_EXPORT` | US-003 |
| PRC-35 | GET | `/saved-views` | `PROCESS_VIEW` ou `INBOX_VIEW` | US-003 |
| PRC-36 | POST | `/saved-views` | `PROCESS_VIEW` ou `INBOX_VIEW` | US-003 |
| PRC-37 | PATCH | `/saved-views/{id}` | dono da visão | US-003 |
| PRC-38 | DELETE | `/saved-views/{id}` | dono da visão | US-003 |
| TAG-01 | GET | `/tags` | `PROCESS_VIEW` | US-007 |
| TAG-02 | POST | `/tags` | `TAG_MANAGE` | US-007 |
| TAG-03 | PATCH | `/tags/{id}` | `TAG_MANAGE` | US-007 |

Esquema de referência `Process` (campos completos): ver exemplo de PRC-02; os demais endpoints descrevem apenas as diferenças. Enums citados nesta seção (`entities.md`): `ProcessStatus`(`DRAFT`\|`IN_PROGRESS`\|`AWAITING_APPROVAL`\|`RETURNED`\|`SUSPENDED`\|`CANCELED`\|`COMPLETED`\|`PUBLISHED`), `Priority`(`LOW`\|`MEDIUM`\|`HIGH`\|`URGENT`), `PcaStatus`(`PLANNED`\|`NOT_PLANNED`\|`NOT_APPLICABLE`), `EstimatedValueSource`(`MANUAL`\|`DFD`\|`ETP`\|`PRICE_RESEARCH`\|`TERM`), `ItemKind`(`GOOD`\|`SERVICE`\|`ENGINEERING_SERVICE`\|`WORK`), `ItemCatalogSystem`(`CATMAT`\|`CATSER`\|`OTHER`), `ParticipantRole`(`OBSERVER`\|`COLLABORATOR`\|`CONSULTANT`), `MovementAction`, `ActorType`(`USER`\|`SYSTEM`\|`PLATFORM_OPERATOR`\|`INTEGRATION`), `DayCountType`(`BUSINESS`\|`CALENDAR`), `SavedViewScope`(`PROCESS_LIST`\|`INBOX`), `StageType`(`START`\|`TASK`\|`APPROVAL`\|`END`), `DepartmentResolution`(`FIXED`\|`REQUESTING_DEPARTMENT`\|`REQUESTING_SECRETARIAT`\|`CHOSEN_ON_FORWARD`), `ApproverType`(`USER`\|`ROLE`\|`DEPARTMENT_HEAD`).

---

### PRC-01 — Listar, pesquisar e filtrar processos
`GET /api/v1/processes` · **Permissão:** `PROCESS_VIEW` · **Story:** US-002

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** query string (api.md §1.2):
  - Paginação: `page` (int ≥1, padrão 1), `pageSize` (int 1–100, padrão 20)
  - Ordenação: `sort` (até 3 campos; permitidos `code`, `title`, `status`, `currentStageDueAt`, `priority`, `estimatedValue`, `targetDate`, `openedAt`, `createdAt`, `updatedAt`; padrão `-updatedAt`; com `q` e sem `sort`, relevância; desempate final por `id` decrescente)
  - Busca: `q` (2–200 caracteres)
  - Filtros (opcionais; máx. 50 valores por filtro multivalorado; vírgula = OU, parâmetros distintos = E): `status` (multi `ProcessStatus`), `stageKey`/`currentWorkflowStageId` (multi), `currentDepartmentId` (multi uuid ou `mine`), `requestingSecretariatId` (multi uuid), `requestingDepartmentId` (multi uuid), `organizationId` (multi uuid), `currentResponsibleId` (multi uuid, `me`, `none`), `priority` (multi `Priority`), `contractingTypeId` (multi uuid), `modalityId` (multi uuid ou `none`), `originId` (multi uuid), `year` (multi int, 2000–2100), `tagId` (multi uuid), `overdue` (boolean), `targetDateOverdue` (boolean), `createdFrom`/`createdTo` (data), `targetDateFrom`/`targetDateTo` (data), `estimatedValueMin`/`estimatedValueMax` (decimal string ≥0, 2 casas), `includeStageOptions` (boolean, padrão `false`)
- **Request:** —
- **Response:** `200 { data: ProcessListItem[], meta: { page, pageSize, totalItems, totalPages, stageOptions?, valueFilterExcludesConfidential?, confidentialStepUpAvailable? } }`. `stageOptions` (só com `includeStageOptions=true`) = `[{ key, name, groupLabel }]` — chaves distintas das etapas das versões publicadas e aposentadas do tenant, lidas sem `WORKFLOW_VIEW` (US-002, lacuna 1). `valueFilterExcludesConfidential` (só com filtro de valor ativo) = o usuário não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` com escopo `TENANT` (nota FA-05, sem indicar quais processos saíram). `confidentialStepUpAvailable` = a permissão existe, mas a sessão sem MFA não a usa para desmascarar (FA-12). Parâmetros desconhecidos são ignorados; página e total vêm do mesmo snapshot (uma instrução). `ProcessListItem` = subconjunto de `Process` (ver PRC-02) + `deadline` (DTO calculado): `{ dueAt: string|null; slaType: DayCountType|null; daysLeft: number|null; overdueDays: number|null; isDueSoon: boolean; isOverdue: boolean; isPaused: boolean }`. Campos exibidos: `id`, `code`, `number`, `year`, `internalCode`, `title`, `status`, `priority`, `organization{id,shortName}`, `requestingSecretariat{id,name}`, `requestingDepartment{id,name}`, `currentStage{key,name}|null`, `currentDepartment{id,name}`, `currentResponsible{id,name}|null`, `deadline`, `contractingType{id,code,label}`, `modality|null`, `origin`, `isBudgetConfidential`, `estimatedValue`/`estimatedValueMasked`, `targetDate`, `overdueSince`, `tags[{id,name,color,isActive}]` (etiqueta inativa aplicada segue na lista, esmaecida — US-007 FA-03), `openedAt`, `createdAt`, `updatedAt` (US-002, lacuna 4).
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Parâmetro inválido (enum, uuid, datas, valores, `sort`, paginação) |
| 403 | `PERMISSION_DENIED` | Sem `PROCESS_VIEW` e sem concessões |

- **Efeitos:** — (somente leitura). Auditoria: `access.denied` em 403 (amostragem 1/usuário/rota/min); `process.confidential_view` (`ACCESS`) quando a resposta entrega valor desmascarado de processo sigiloso (1×/sessão/processo — US-013).
- **Notas:** colunas/ordenação/filtros conforme RN-PROC-21/22/23/25/26/27/28/30/31; rótulos do badge de prazo: "No prazo", "Vence em N dias úteis" (ou "dias" se `CALENDAR`), "Vence hoje", "Atrasado há N dias úteis", "Prazo pausado", "Sem prazo".

### PRC-02 — Criar processo de contratação
`POST /api/v1/processes` · **Permissão:** `PROCESS_CREATE` · **Story:** US-001

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** —
- **Request:**
```ts
{
  title: string;              // 5–200, sem quebra de linha, trim
  object: string;             // 10–2.000
  description?: string;       // até 10.000
  contractingTypeId: string;  // uuid, catálogo CONTRACTING_TYPE ativo
  modalityId?: string;        // uuid, catálogo MODALITY ativo; vazio = "A definir"
  isPriceRegistration?: boolean;    // padrão false
  organizationId?: string;    // uuid ativo; padrão = órgão principal
  requestingSecretariatId: string;  // uuid ativa (RN-PROC-02)
  requestingDepartmentId: string;   // uuid ativa, na subárvore da secretaria (RN-PROC-03)
  priority: Priority;         // padrão "MEDIUM"
  targetDate?: string;        // YYYY-MM-DD, ≥ hoje
  estimatedValue?: string;    // decimal ≥0, 2 casas
  originId: string;           // uuid, catálogo PROCESS_ORIGIN ativo
  pcaStatus: PcaStatus;
  pcaYear?: number;           // obrigatório se pcaStatus="PLANNED"; ano corrente ou seguinte
  pcaItemCode?: string;       // até 60
  pcaJustification?: string;  // obrigatório se pcaStatus="NOT_PLANNED"; ≥20 caracteres
  internalCode?: string;      // até 60, único no tenant; obrigatório se process.requireInternalCode
  notes?: string;             // até 5.000
  confirmDuplicate?: boolean; // padrão false; reenvio após aviso de duplicidade (PRC-03)
}
```
- **Response:** `201 { data: Process }` + `Location`, `ETag` — schema completo de `Process` (referenciado pelos demais endpoints desta seção):
```json
{ "data": {
  "id": "01927f1a-6c1e-7c8b-9a2e-3f6d2b1c0a11",
  "code": "0012/2026", "number": 12, "year": 2026,
  "title": "Aquisição de cimento para manutenção de vias", "status": "DRAFT", "priority": "MEDIUM",
  "organization": { "id": "…", "shortName": "PMSJ" },
  "requestingSecretariat": { "id": "…", "name": "Secretaria de Obras" },
  "requestingDepartment": { "id": "…", "name": "Setor de Manutenção" },
  "currentStage": { "id": "…", "key": "ABERTURA", "name": "Formalização da demanda", "dueAt": null },
  "currentDepartment": { "id": "…", "name": "Setor de Manutenção" },
  "currentResponsible": { "id": "…", "name": "Ana Souza" },
  "workflow": { "id": "…", "name": "Fase preparatória — Lei 14.133/2021", "versionNumber": 1 },
  "estimatedValue": null, "estimatedValueMasked": false,
  "openedAt": "2026-10-05T14:30:00Z", "createdAt": "2026-10-05T14:30:00Z", "version": 1
} }
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Corpo inválido; obrigatório ausente; limites de tamanho; `targetDate` no passado; `estimatedValue` inválido; regras de PCA |
| 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | Catálogo/unidade inexistente, inativo ou de outro tenant |
| 422 | `VALIDATION_ERROR` (`DEPARTMENT_NOT_IN_SECRETARIAT`) | Setor fora da subárvore da secretaria |
| 422 | `NO_APPLICABLE_WORKFLOW` | Nenhum workflow publicado aplicável e sem padrão |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma `Idempotency-Key` com corpo diferente |
| 403 | `PERMISSION_DENIED` | Escopo de `PROCESS_CREATE` não cobre o setor solicitante |
| 409 | `POSSIBLE_DUPLICATE_PROCESS` | Processo semelhante criado recentemente e `confirmDuplicate` não enviado |
| 409 | `DUPLICATE_INTERNAL_CODE` | `internalCode` já usado no tenant |

- **Efeitos:** Eventos: `ProcessCreated` (`process.created`) no commit; `code`/`number` nulos se a autuação ocorrer só no 1º encaminhamento. Projeções síncronas: `ProcessTimelineEntry` (`PROCESS_CREATED`), `ProcessAccess` (concessões iniciais). Auditoria: `process.create` (`DATA_CHANGE`) — `changes` dos valores iniciais (IDs, prioridade, PCA, datas; textos longos como hash+tamanho); `metadata`: `code`, `workflowVersionId`, `initialStageKey`, `idempotencyKey`, `duplicateConfirmed`. `access.denied` (`ACCESS`) em 403.
- **Notas:** RN-PROC-02/03/04/05/06/07/08/12. Resolução do workflow aplicável é feita por `POST /workflows/resolve` (seção de workflows, fora deste arquivo).

### PRC-03 — Verificar possível duplicidade de processo
`POST /api/v1/processes/check-duplicates` · **Permissão:** `PROCESS_CREATE` · **Story:** US-001

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** —
- **Request:** `{ title: string; object: string; requestingDepartmentId: string }` (mesmas regras de tamanho/formato de PRC-02)
- **Response:** `200 { data: { candidates: [{ id: string, code: string|null, title: string, status: ProcessStatus, createdAt: string, createdBy: { id: string, name: string } }] } }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Corpo inválido ou referência inexistente/inativa |

- **Efeitos:** —
- **Notas:** usada antes de `POST /processes` para alertar duplicidade; critério de similaridade conforme US-001 FA-02/RN-PROC-13 (trigram ≥ 0,6 em título ou objeto, mesmo usuário ou mesmo setor solicitante, dentro da janela configurada; janela 0 desativa).

### PRC-04 — Obter detalhe do processo
`GET /api/v1/processes/{id}` · **Permissão:** `PROCESS_VIEW` · **Story:** US-004

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id` (uuid, obrigatório)
- **Request:** —
- **Response:** `200 { data: Process, meta: { allowedActions: string[] } }` + `ETag` — schema de `Process` (ver PRC-02), com mascaramento de `estimatedValue` (api.md §1.4).
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `PROCESS_NOT_FOUND` | Inexistente, descartado, não visível ou de outro tenant |

- **Efeitos:** Auditoria: `process.confidential_view` (`ACCESS`) na 1ª entrega de valor desmascarado de processo sigiloso por sessão/processo (US-013; `source="PRC-04"`). Processos não visíveis respondem 404 sem `access.denied` (a existência não é revelada).
- **Notas:** `meta.allowedActions` = ações habilitadas de PRC-08 para o usuário (mais `DECIDE_APPROVAL` do aprovador designado). Mascaramento pela POL-09 por processo (escopo que o cubra ou custódia — a mesma regra de PRC-07). Visibilidade inclui a concessão `USER` (DEC-024 cond. 4). `Cache-Control: no-store`.

### PRC-05 — Editar dados do processo
`PATCH /api/v1/processes/{id}` · **Permissão:** `PROCESS_UPDATE` + POL-01 · **Story:** US-005

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** path `id`
- **Request:** subconjunto de:
```ts
{
  organizationId?: string; requestingSecretariatId?: string; requestingDepartmentId?: string; // só em DRAFT (RN-PROC-61/62)
  title?: string; object?: string; description?: string;
  contractingTypeId?: string; modalityId?: string | null; isPriceRegistration?: boolean;
  priority?: Priority; targetDate?: string | null;
  estimatedValue?: string | null;  // bloqueado se houver fonte de maior precedência (RN-PROC-63)
  originId?: string; pcaStatus?: PcaStatus; pcaYear?: number; pcaItemCode?: string; pcaJustification?: string;
  internalCode?: string; notes?: string;
}
```
Campos de unidade/órgão só editáveis com processo em `DRAFT`; demais campos também editáveis em `IN_PROGRESS`/`RETURNED`; nenhum campo editável em `AWAITING_APPROVAL`, `SUSPENDED` ou status finais.
- **Response:** `200 { data: Process }` + `ETag`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Corpo inválido; campo bloqueado pelo status ou não editável (`NOT_ALLOWED`); limites/formatos |
| 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`/`DEPARTMENT_NOT_IN_SECRETARIAT`) | Referência inválida |
| 422 | `BUSINESS_RULE_VIOLATION` | `estimatedValue` com fonte de maior precedência (`estimatedValueSource`) |
| 403 | `PERMISSION_DENIED` | Sem permissão/escopo; novo setor fora do escopo de `PROCESS_CREATE` |
| 403 | `NOT_PROCESS_CUSTODIAN` | Usuário não está com o processo |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |
| 409 | `INVALID_PROCESS_STATUS` | Status não editável |
| 409 | `DUPLICATE_INTERNAL_CODE` | Código interno já usado no tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente (corpo traz `currentVersion`/`meta.current` — exemplo em api.md §1.3) |

- **Efeitos:** Eventos: `ProcessUpdated` (`process.updated`) no commit, com `changedFields[]` e `version` (nunca valores). Projeções: timeline `PROCESS_UPDATED`; `ProcessAccess` recalculado se a unidade solicitante mudar (RN-PROC-62). Auditoria: `process.update` (`DATA_CHANGE`) — `changes: [{path,old,new}]`; `metadata`: `processCode`, `version`, `requestingAccessChanged`. `access.denied` em 403.
- **Notas:** diff de `estimatedValue` de processo sigiloso é mascarado na auditoria para quem não atende POL-09 (US-013).

### PRC-06 — Descartar rascunho de processo
`DELETE /api/v1/processes/{id}` · **Permissão:** criador com `PROCESS_CREATE` ou `PROCESS_CANCEL` · **Story:** US-009

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** path `id`
- **Request:** —
- **Response:** `204` (sem corpo)
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão para a ação |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |
| 409 | `CANNOT_DISCARD_NUMBERED_PROCESS` | Rascunho já tem número; cancelar em vez de descartar |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `ProcessDraftDiscarded` (`process.draft_discarded`) no commit, com `reasonProvided`; não gera entrada de timeline (processo deixa de ser visível). Auditoria: `process.discard_draft` (`DATA_CHANGE`, `metadata.reasonProvided`); `access.denied` em 403.
- **Notas:** motivo do descarte é opcional, até 500 caracteres, registrado só em auditoria (não persiste coluna).

### PRC-07 — Obter painel situacional do processo
`GET /api/v1/processes/{id}/summary` · **Permissão:** `PROCESS_VIEW` · **Story:** US-004

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id`
- **Request:** —
- **Response:** `200 { data: { header, where, responsible, pending, nextStep, deadline, target, documents[], approvals[], counts, version } }`:
```ts
{
  header: { code: string|null, title, status, priority, tags: {id,name,color,isActive}[], isBudgetConfidential, estimatedValue: string|null, estimatedValueMasked, estimatedValueSource|null,
            organization: { id, shortName }, showOrganization: boolean /* órgão ≠ principal do tenant */ }; // RN-PROC-54
  where: { stage: { key, name, type: StageType, groupLabel|null } | null, department: {id,name}, status, statusBeforeSuspension|null, suspensionReason|null,
           suspendedAt|null, completedAt|null, canceledAt|null, cancellationReason|null }; // RN-PROC-48(1) · FA-06/07
  responsible: { user: {id,name,jobTitle|null} | null, queueDepartment: {id,name} | null, since: string|null /* início da atribuição ativa */,
                 approver: { approvalId, label, isMine } | null /* só em AWAITING_APPROVAL */ }; // RN-PROC-48(2)
  pending: { blockingCount: number; warningCount: number;
             items: Array<{ ruleId, name, type: RuleType, severity: "BLOCKING"|"WARNING", message, evaluationFailed: boolean,
                            link: { documentId, restricted } | { createDocumentTypeCode } | null }> }; // RN-PROC-51 · FA-10
  nextStep: { action: { action, transitionKey?, approvalId?, label, enabled: boolean, reasons: [{code,message}] } | null, instructions: string|null }; // RN-PROC-49
  deadline: /* DTO de PRC-01 */ object | null /* null em status final */; target: { targetDate, isOverdue, overdueDays|null } | null; // RN-PROC-53
  documents: Array<{ id, typeCode, typeName, code|null, title, status, versionNumber|null, confidentiality, restricted, inApproval }>; // RN-PROC-48(6)/55
  approvals: Array<{ id, title, approverLabel, requestedAt, dueAt|null, isOverdue, isMine }>; // RN-PROC-48(7)
  counts: { documents, items, comments, participants }; // RN-PROC-57
  version: number;
}
```
`nextStep.action` segue a nomenclatura de PRC-08 (`enabled`, `transitionKey`); as regras `TRANSITION_BLOCKED` da ação primária chegam como UM motivo com a contagem ("Há 1 pendência obrigatória nesta etapa."). Regra não avaliável (fail-closed) chega com `evaluationFailed = true` e a mensagem padrão "Não foi possível verificar esta regra. Tente novamente ou fale com o administrador.". Leitura em `REPEATABLE READ READ ONLY`; `Cache-Control: no-store`. Visibilidade (RN-PROC-47) conferida no caso de uso, inclusive por concessão `USER` (aprovador designado) — não visível = 404 `PROCESS_NOT_FOUND` sem `access.denied`.
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |

- **Efeitos:** Auditoria: `process.confidential_view` (`ACCESS`) na entrega de valor desmascarado (`source="PRC-07"`).
- **Notas:** `inApproval = true` quando `pendingApprovalId` preenchido (selo "Em aprovação"); exemplo completo na story US-004.

### PRC-08 — Listar ações disponíveis do processo
`GET /api/v1/processes/{id}/available-actions` · **Permissão:** `PROCESS_VIEW` · **Story:** US-004, US-041, US-047

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id`
- **Request:** —
- **Response:** `200 { data: ActionEntry[] }`:
```ts
ActionEntry {
  action: "FORWARD" | "RETURN" | "CLAIM" | "ASSIGN" | "SUSPEND" | "RESUME" | "CANCEL" | "DISCARD" | "COMPLETE"
        | "DECIDE_APPROVAL" | "EDIT" | "MANAGE_ITEMS" | "MANAGE_TAGS" | "DUPLICATE" | "MANAGE_PARTICIPANTS"
        | "FOLLOW" | "UNFOLLOW" | "SET_CONFIDENTIALITY"; // catálogo de ações, US-004
  transitionKey?: string; toStageKey?: string;   // uma entrada FORWARD por transição disponível
  approvalId?: string;                            // em DECIDE_APPROVAL
  label: string; enabled: boolean; primary?: boolean;
  reasons: Array<{ code: string; message: string; ruleId?: string }>; // motivos de indisponibilidade quando enabled=false (ruleId em TRANSITION_BLOCKED)

  // Prévia de transição (obrigatória nesta especificação) — apenas em entradas action="FORWARD" (US-047):
  transitionId?: string;                          // em FORWARD/COMPLETE/RETURN — o `transitionId` do POST /forward (PRC-19)
  toStageName?: string; toStageType?: StageType;  // etapa destino ("Para onde" e resumo do SCR-103; destino da devolução no SCR-104)
  toStageId?: string; lastPassedAt?: string;      // só em RETURN (US-048): o `targetStageId` do PRC-20 e a saída da última passagem pela etapa
  departmentResolution?: { mode: DepartmentResolution; departmentId?: string; departmentName?: string };
  requiresComment?: boolean;
  allowDueDateOverride?: boolean;
  dueAtPreview?: string | null;  // ISO 8601 UTC
  approverPreview?: { type: ApproverType; label: string; userId?: string; roleId?: string; departmentId?: string } | null;
}
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `NOT_FOUND` | Processo inexistente, de outro tenant, não visível, ou usuário sem `PROCESS_VIEW` (DEC-024 não distingue os dois casos) |

- **Efeitos:** — (motor somente leitura; não gera eventos nem `AuditLog`).
- **Notas:** `reasons[].code` cobre, conforme a ação, `TRANSITION_NOT_AVAILABLE`, `TRANSITION_BLOCKED`, `WARNINGS_NOT_ACKNOWLEDGED`, `NOT_PROCESS_CUSTODIAN`, `INVALID_PROCESS_STATUS`, `MFA_REQUIRED`, `DEPARTMENT_REQUIRED`, `ASSIGNEE_NOT_ELIGIBLE`, `DUE_DATE_OVERRIDE_NOT_ALLOWED`, `APPROVER_UNRESOLVED`, `DOCUMENT_INCOMPLETE`, `PROCESS_ALREADY_ASSIGNED` (ver PRC-19..33). `departmentResolution.mode` usa o enum `DepartmentResolution`; quando `CHOSEN_ON_FORWARD`, `departmentId`/`departmentName` ficam ausentes e a unidade é escolhida no próprio `POST /forward` (omissão → `DEPARTMENT_REQUIRED`). `approverPreview.type` usa `ApproverType`; é `null` quando a transição não leva a etapa `APPROVAL` ou quando não resolvido (razão em `reasons[]` = `APPROVER_UNRESOLVED`). `dueAtPreview` calculado por RN-TRAM-09/10; pode ser `null` quando depende de dado ainda não informado (ex.: unidade de destino). Este bloco de prévia consolida US-041 (schema-base de `available-actions`) com as regras de encaminhamento de US-047: a US-041 preenche `departmentResolution` (`mode` + `departmentId` quando resolvida), `requiresComment` e `allowDueDateOverride` em `FORWARD`/`COMPLETE` (e os dois últimos em `RETURN`); `dueAtPreview` e `approverPreview` ficam com a US-047. Ordem: avanços (principal primeiro, depois `displayOrder`), `RETURN` por etapa percorrida, ciclo de vida (`CLAIM`, `ASSIGN`, `SUSPEND`/`RESUME`, `CANCEL`); ação sem a permissão em nenhum escopo é omitida.

### PRC-09 — Obter checklist de pendências do processo
`GET /api/v1/processes/{id}/checklist` · **Permissão:** `PROCESS_VIEW` · **Story:** US-004, US-041

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id`
- **Request:** —
- **Response:** `200 { data: { violations: Violation[] } }` — `Violation` no formato único de api.md §2.1.2 (`code: "WORKFLOW_RULE"`, `ruleId`, `severity: "BLOCKING"|"WARNING"`, `message`, `sectionKey?`, `field?`, `itemId?`, `params?`); campos adicionais vistos no painel (US-004): `name?`, `type?`, `satisfied?`, `scope?`, `transitionId?`, `transitionKey?`, `link?`, `evaluationFailed?` (regra não avaliável: mensagem padrão "Não foi possível verificar esta regra. Tente novamente ou fale com o administrador." — FA-10). Só regras ativas NÃO satisfeitas (`satisfied: false`): `STAGE_EXIT` da etapa atual e `TRANSITION` das saídas `FORWARD`/`COMPLETE`, bloqueantes antes dos avisos; `params` traz `documentTypeCode`/`minStatus`/`minCount?` (`REQUIRED_DOCUMENT`) ou `stageKey` (`REQUIRED_APPROVAL`) para o atalho; `field` é o caminho do `REQUIRED_FIELD`.
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `NOT_FOUND` | Processo inexistente/não visível |

- **Efeitos:** —
- **Notas:** mesmas regras RN-WF-24..29 do motor de execução (US-041).

### PRC-10 — Listar etapas e passagens do processo
`GET /api/v1/processes/{id}/stages` · **Permissão:** `PROCESS_VIEW` · **Story:** US-004, US-054

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id`
- **Request:** —
- **Response:** `200 { data: StageEntry[] }`:
```ts
StageEntry {
  workflowStageId: string; key: string; name: string; type: StageType; groupLabel: string; displayOrder: number;
  slaDays: number|null; slaType: DayCountType|null; lastPassStatus: ProcessStageStatus|null /* null = não percorrida */;
  isCurrent: boolean /* etapa da passagem ativa (aria-current="step") */;
  passes: Array<{ processStageId: string; sequence: number; status: ProcessStageStatus; department: {id,name}; assignee: {id,name}|null;
                  enteredAt: string; exitedAt: string|null; dueAt: string|null; dueDateOverridden: boolean; overdueSince: string|null }>;
}
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |

- **Efeitos:** —
- **Notas:** usada pelo stepper e pelo histórico por etapa (US-054); `passes` cobre múltiplas passagens pela mesma etapa (idas e voltas).

### PRC-11 — Listar histórico de tramitações
`GET /api/v1/processes/{id}/movements` · **Permissão:** `PROCESS_VIEW` · **Story:** US-054

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id`; query (feed, api.md §1.2): `cursor?`, `limit?` (1–100), `action?` (multi `MovementAction`), `fromDepartmentId?`, `toDepartmentId?`, `actorId?`, `occurredFrom?`, `occurredTo?`
- **Request:** —
- **Response:** `200 { data: MovementItem[], meta: { nextCursor, hasMore, canViewIp } }`:
```ts
MovementItem {
  action: MovementAction;
  fromStage?: {id,name}; toStage?: {id,name}; fromDepartment?: {id,name}; toDepartment?: {id,name}; fromUser?: {id,name}; toUser?: {id,name};
  statusFrom?: ProcessStatus; statusTo?: ProcessStatus;
  actor: { type: ActorType; id?: string; name: string; departmentName?: string };
  comment?: string; dueAt?: string; documents?: MovementDocumentRef[]; approvalId?: string; approvalSummary?: object;
  occurredAt: string; ip?: string; // só com permissão AUDIT_VIEW (RN-TRAM-74)
}
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | `action` fora do enum; período invertido (`OUT_OF_RANGE`); `cursor` inválido/expirado |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |

- **Efeitos:** — (leitura; não produz eventos). Auditoria: `access.denied` quando processo não visível/vínculo inativo.
- **Notas:** `documents[]` = `MovementDocumentRef` e `metadata` = `MovementMetadata` (entities.md §5.6); `approvalSummary` (resumo da `Approval` vinculada) — a definir na implementação. A consulta em si não gera `AuditLog` dedicado (acesso aos dados de auditoria é tratado por `audit.search`, US-073, fora desta story).

### PRC-12 — Listar timeline do processo
`GET /api/v1/processes/{id}/timeline` · **Permissão:** `PROCESS_VIEW` · **Story:** US-060

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id`; query (feed): `cursor?`, `limit?` (1–100, padrão 50), `group?` (multi, valores da RN-TML-12), `actorId?` (multi), `occurredFrom?`, `occurredTo?`
- **Request:** —
- **Response:** `200 { data: TimelineEntry[], meta: { nextCursor, hasMore } }`:
```ts
TimelineEntry { id: string; occurredAt: string; type: string; actorType: ActorType; actorId: string | null;
  actorName: string | null; // null em actorType = SYSTEM (o front exibe "Sistema")
  actorDepartmentName: string | null; entityType: string | null; entityId: string | null; movementId: string | null;
  params: object; visibility: "STANDARD" | "BUDGET_RESTRICTED" }
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Período invertido; `cursor` inválido/corrompido; `group` fora da tabela RN-TML-12 |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |

- **Efeitos:** — (leitura).
- **Notas:** catálogo de `type`/`params` por tipo de entrada em events.md §5 (projeção na timeline) e regras de visibilidade `BUDGET_RESTRICTED` em US-060 (RN-TML-13). Multivalorados (`group`, `actorId`) por vírgula ou repetição (OU); filtros distintos combinam por E; período inclusivo em ISO 8601 UTC. As entradas `BUDGET_RESTRICTED` sem POL-09 saem no `WHERE` (paginação só do visível, sem indicação). Cursor inválido → 422 `INVALID_FORMAT` em `cursor`; grupo fora da tabela → `INVALID_ENUM` em `group`; período invertido → `OUT_OF_RANGE` em `occurredTo`. Processo não visível também grava `access.denied` (`reasonCode = PROCESS_VIEW`).

### PRC-13 — Listar itens do processo
`GET /api/v1/processes/{id}/items` · **Permissão:** `PROCESS_VIEW` · **Story:** US-006

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` — (resposta traz `ETag` = versão do processo)
- **Parâmetros:** path `id`
- **Request:** —
- **Response:** `200 { data: ProcessItem[] }` + `ETag`:
```ts
ProcessItem {
  id: string; processId: string; sequence: number; lotNumber: number | null; lotName: string | null;
  kind: ItemKind; description: string; unitOfMeasure: { id: string; label: string };
  catalogSystem: ItemCatalogSystem | null; catalogCode: string | null; notes: string | null;
  referenceQuantity: string | null; referenceQuantitySourceDocumentId: string | null;
  referenceUnitPrice: string | null; referenceUnitPriceMasked: boolean; referenceUnitPriceSourceDocumentId: string | null;
  references: { documentId: string; code: string; typeCode: string; status: string; editable: boolean }[]; // documentos/pesquisas que usam o item (FA-01/03/04)
  version: number; // If-Match de PRC-15/PRC-16
}
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |

- **Efeitos:** —
- **Notas:** `referenceUnitPriceMasked` segue POL-09 (RN-PROC-84): processo sigiloso sem POL-09 → `referenceUnitPrice: null` e `referenceUnitPriceMasked: true` em todos os itens (mesmo sem preço, para não revelar se há valor). `references` vem dos leitores registrados na porta `ProcessItemUsageRegistry` (US-006) pelos donos de `DocumentItem`/`PriceItem`.

### PRC-14 — Adicionar item ao processo
`POST /api/v1/processes/{id}/items` · **Permissão:** `PROCESS_UPDATE` + POL-01 · **Story:** US-006

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** path `id`
- **Request:**
```ts
{ description: string;            // 3–2.000, trim
  kind: ItemKind;
  unitOfMeasureId: string;        // uuid, catálogo UNIT_OF_MEASURE ativo
  lotNumber?: number;              // 1–999
  lotName?: string;                // até 150; condicional a lote novo
  catalogSystem?: ItemCatalogSystem; catalogCode?: string; // par obrigatório conjunto
  notes?: string; }                // até 2.000
```
- **Response:** `201 { data: ProcessItem }` + `Location`, `ETag`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Descrição ausente/fora de tamanho; natureza inválida; código sem sistema/lote sem número; lote fora de 1–999; limite de 1.000 itens; campo somente leitura enviado |
| 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | Unidade de medida inválida |
| 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | Sem permissão ou custódia |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |
| 409 | `INVALID_PROCESS_STATUS` | Status não editável |

- **Efeitos:** Eventos: `ProcessItemsChanged` (`process.items_changed`) no commit — `added`/`updated`/`removed` (ids), `itemsCount`. Projeção: timeline `ITEMS_CHANGED`. Auditoria: `process.items_update` (`DATA_CHANGE`, `operation="ADD"`, por item `[{path:"items[<id>].<campo>",old,new}]`); `access.denied` em 403.
- **Notas:** limite de 1.000 itens por processo; descrição registrada em auditoria como hash+tamanho.

### PRC-15 — Editar item do processo
`PATCH /api/v1/process-items/{itemId}` · **Permissão:** `PROCESS_UPDATE` + POL-01 · **Story:** US-006

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório (versão do item)
- **Parâmetros:** path `itemId` (uuid)
- **Request:** subconjunto dos campos editáveis de PRC-14 (`description`, `kind`, `unitOfMeasureId`, `lotNumber`, `lotName`, `catalogSystem`, `catalogCode`, `notes`); `referenceQuantity`/`referenceUnitPrice` são somente leitura (`NOT_ALLOWED` se enviados)
- **Response:** `200 { data: ProcessItem }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Mesmas validações de PRC-14 |
| 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | Sem permissão ou custódia |
| 404 | `NOT_FOUND` | Item não visível/outro tenant |
| 409 | `INVALID_PROCESS_STATUS` | Status não editável |
| 409 | `ITEM_IN_USE` | Troca de unidade de medida de item referenciado por documento (ver exemplo em PRC-16) |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** igual a PRC-14 (`operation="UPDATE"`).
- **Notas:** RN-PROC-73/74/75/76/77.

### PRC-16 — Remover item do processo
`DELETE /api/v1/process-items/{itemId}` · **Permissão:** `PROCESS_UPDATE` + POL-01 · **Story:** US-006

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório (versão do item)
- **Parâmetros:** path `itemId`
- **Request:** —
- **Response:** `204`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | Sem permissão ou custódia |
| 404 | `NOT_FOUND` | Item não visível/outro tenant |
| 409 | `INVALID_PROCESS_STATUS` | Status não editável |
| 409 | `ITEM_IN_USE` | Item referenciado por documento do processo (exemplo abaixo) |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

Exemplo de 409 `ITEM_IN_USE`:
```json
{ "status": 409, "code": "ITEM_IN_USE", "title": "Item em uso",
  "meta": { "references": [
    { "documentId": "…", "code": "DFD 0005/2026", "typeCode": "DFD", "status": "DRAFT", "editable": true },
    { "documentId": "…", "code": "PP 0002/2026", "typeCode": "PRICE_RESEARCH", "status": "FINALIZED", "editable": false } ] } }
```
- **Efeitos:** igual a PRC-14 (`operation="REMOVE"`).
- **Notas:** a UI lista os documentos referenciados com link (FA-01).

### PRC-17 — Reordenar itens do processo
`POST /api/v1/processes/{id}/items/reorder` · **Permissão:** `PROCESS_UPDATE` + POL-01 · **Story:** US-006

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório (versão do processo)
- **Parâmetros:** path `id`
- **Request:** `{ itemIds: string[] }` — deve conter exatamente os uuids dos itens atuais do processo, sem repetição (RN-PROC-74)
- **Response:** `200 { data: ProcessItem[] }` + `ETag`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`/`REFERENCE_NOT_FOUND`/`REQUIRED`) | Lista não corresponde aos itens atuais |
| 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | Sem permissão ou custódia |
| 409 | `INVALID_PROCESS_STATUS` | Status não editável |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** igual a PRC-14 (`operation="REORDER"`; itens renumerados em `updated`).
- **Notas:** —

### PRC-18 — Definir etiquetas do processo
`PUT /api/v1/processes/{id}/tags` · **Permissão:** `PROCESS_UPDATE` + POL-01 · **Story:** US-007

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório (versão do processo)
- **Parâmetros:** path `id`
- **Request:** `{ tagIds: string[] }` — conjunto completo final (pode ser vazio); até 10 etiquetas (RN-PROC-88), sem repetição, todas ativas
- **Response:** `200 { data: { tags: Tag[] } }` + `ETag`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` (`OUT_OF_RANGE`) | Mais de 10 etiquetas |
| 422 | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`/`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | Etiqueta repetida, inexistente ou inativa |
| 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | Sem permissão ou custódia |
| 404 | `NOT_FOUND` / `PROCESS_NOT_FOUND` | Etiqueta ou processo não visível/outro tenant |
| 409 | `INVALID_PROCESS_STATUS` | Status não editável |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `ProcessUpdated` (`process.updated`, `changedFields=["tags"]`) quando há diferença efetiva. Auditoria: `process.tags_update` (`DATA_CHANGE`, `changes:[{path:"tags",old:[nomes],new:[nomes]}]`); `access.denied` em 403.
- **Notas:** RN-PROC-85/86. Cadastro de etiquetas (TAG-01..03) não gera evento de domínio, só auditoria de configuração. `ETag` = nova versão do processo (a atual, se o conjunto for idêntico: 200 sem versão, evento, timeline nem auditoria — RN-PROC-89, avaliado antes do `If-Match`). A resposta traz as etiquetas aplicadas (ativas e inativas) por nome. PRC-08 expõe a ação `MANAGE_TAGS` ("Etiquetas"), desabilitada com o motivo fora de `DRAFT`/`IN_PROGRESS`/`RETURNED` ou sem custódia (FA-04).

### PRC-19 — Encaminhar processo
`POST /api/v1/processes/{id}/forward` · **Permissão:** `PROCESS_FORWARD` + POL-01 · **Story:** US-047

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` obrigatório
- **Parâmetros:** path `id`
- **Request:**
```ts
{ transitionId: string; expectedStageId: string;  // = etapa atual; divergência → STAGE_CHANGED
  toDepartmentId?: string;        // obrigatório se transição destino CHOSEN_ON_FORWARD (RN-TRAM-07)
  toUserId?: string;              // RN-TRAM-08
  dueAt?: string;                 // só se a transição permitir sobrescrita; RN-TRAM-10
  dueDateOverrideReason?: string; // 10–1.000, obrigatório com dueAt
  comment?: string;               // até 5.000; obrigatório conforme RN-TRAM-11
  documentIds?: string[];         // até 50, sem repetição (RN-TRAM-12)
  acknowledgedWarnings?: string[]; }
```
- **Response:** `200 { data: Process }` com `status`, `currentStage`, `currentDepartment`, `currentResponsible`, `movement: {id, sequence}`, `approval?: {id, approverLabel}`, `version` + `ETag`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Corpo inválido; documento de outro processo; prazo inválido |
| 422 | `TRANSITION_NOT_AVAILABLE` | Transição inexistente, de outra etapa ou não `FORWARD` |
| 422 | `TRANSITION_BLOCKED` | Regra `BLOCKING` não satisfeita |
| 422 | `WARNINGS_NOT_ACKNOWLEDGED` | Aviso `WARNING` não reconhecido |
| 422 | `DEPARTMENT_REQUIRED` | Unidade ausente em transição `CHOSEN_ON_FORWARD` |
| 422 | `DUE_DATE_OVERRIDE_NOT_ALLOWED` | Prazo alterado sem permissão da transição |
| 422 | `ASSIGNEE_NOT_ELIGIBLE` | Pessoa indicada não lotada no destino / sem vínculo ativo |
| 422 | `DOCUMENT_INCOMPLETE` | Documento coberto incompleto (destino `APPROVAL`) |
| 422 | `APPROVER_UNRESOLVED` | Aprovador não resolvido para a etapa `APPROVAL` |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Mesma chave com corpo diferente |
| 403 | `PERMISSION_DENIED` / `NOT_PROCESS_CUSTODIAN` | Sem permissão ou custódia |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |
| 409 | `INVALID_PROCESS_STATUS` | Status não permite encaminhar |
| 409 | `STAGE_CHANGED` | `expectedStageId` diverge da etapa atual |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `ProcessStageChanged`(`ProcessForwarded`) sempre; `ProcessStatusChanged` quando o status muda; `ProcessAssigned` (`assignmentType=STAGE_ENTRY`) quando a nova etapa resolve responsável; `ProcessNumberAssigned` na autuação do 1º encaminhamento; `DocumentVersionCreated`+`DocumentSubmitted` por documento coberto submetido; `ApprovalRequested` quando o destino é `APPROVAL`. Projeções: timeline `PROCESS_FORWARDED` (e correlatas); `ProcessAccess`. Auditoria: `process.forward` (`WORKFLOW`); `process.number_assign`, `document.version_create`, `document.submit`, `approval.request` quando aplicáveis; `access.denied` em 403.
- **Notas:** RN-TRAM-04/06/07/08/09/10/11/12/15. A prévia de cada transição disponível (`departmentResolution`, `requiresComment`, `allowDueDateOverride`, `dueAtPreview`, `approverPreview`) é obtida antecipadamente em `GET /processes/{id}/available-actions` (PRC-08), nas entradas `action="FORWARD"`.

### PRC-20 — Devolver processo
`POST /api/v1/processes/{id}/return` · **Permissão:** `PROCESS_RETURN` + POL-01 · **Story:** US-048

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` obrigatório
- **Parâmetros:** path `id`
- **Request:** `{ targetStageId: string; comment: string; dueAt?: string; expectedStageId?: string }` — `targetStageId` deve ser etapa já percorrida e destino permitido da transição `RETURN` (RN-TRAM-24); `comment` 10–5.000; `dueAt` só se a transição permitir sobrescrita; `expectedStageId` deve igualar a etapa ativa (RN-TRAM-30)
- **Response:** `200 { data: Process }` com `status`, `currentStage`, `currentDepartment`, `currentResponsible`, `version`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Campos ausentes/curtos |
| 422 | `TRANSITION_NOT_AVAILABLE` | Etapa de destino não disponível |
| 422 | `DUE_DATE_OVERRIDE_NOT_ALLOWED` | Sobrescrita de prazo não permitida pela transição |
| 403 | `NOT_PROCESS_CUSTODIAN` | Usuário não está com o processo |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |
| 409 | `INVALID_PROCESS_STATUS` | Status ≠ `IN_PROGRESS` |
| 409 | `STAGE_CHANGED` | Etapa mudou por outra tramitação |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `ProcessStageChanged`(`ProcessReturned`); `ProcessStatusChanged` para `RETURNED` quando muda; `ProcessAssigned` (`assignmentType=RETURN`) se a etapa de destino resolve responsável individual. Projeções: timeline `PROCESS_RETURNED`; `ProcessAccess`. Auditoria: `process.return` (`WORKFLOW`); `access.denied` em 403.
- **Notas:** RN-TRAM-24/30.

### PRC-21 — Assumir processo
`POST /api/v1/processes/{id}/claim` · **Permissão:** `PROCESS_CLAIM` + POL-04 · **Story:** US-049

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** path `id`
- **Request:** — (corpo vazio)
- **Response:** `200 { data: Process }` com `currentResponsible`, `version`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Usuário não lotado na unidade atual |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |
| 409 | `PROCESS_ALREADY_ASSIGNED` | Processo já tem responsável |
| 409 | `INVALID_PROCESS_STATUS` | Etapa/status não elegíveis |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `ProcessAssigned` (`process.assigned`, `assignmentType=CLAIM`, `fromUserId=null`). Projeção: timeline `PROCESS_CLAIMED`; `ProcessAccess` (`RESPONSIBLE`). Auditoria: `process.claim` (`WORKFLOW`); `access.denied` em 403.
- **Notas:** só elegível para quem está lotado na unidade atual do processo; `TASK`/`START` em `IN_PROGRESS`/`RETURNED` (RN-TRAM-32). O 409 `PROCESS_ALREADY_ASSIGNED` traz `currentResponsible { id, name }` e vale antes do `If-Match` (a corrida de fila manda o mesmo `If-Match` dos dois lados); já assumido por quem chama com `If-Match` vencido é o reenvio do clique duplo e responde 412 `VERSION_CONFLICT` (FA-03). Sem `Idempotency-Key`, sem corpo, sem notificação (RN-TRAM-34/35).

### PRC-22 — Atribuir/reatribuir responsável
`POST /api/v1/processes/{id}/assign` · **Permissão:** `PROCESS_ASSIGN` ou titular/substituto + POL-05 · **Story:** US-050

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** path `id`
- **Request:** `{ assigneeId: string | null; reason?: string }` — `assigneeId` sempre presente (pode ser `null` = devolver à fila da unidade); `reason` 10–2.000, obrigatório em reatribuição/remoção (RN-TRAM-39)
- **Response:** `200 { data: Process }` com `currentResponsible`, `version`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | `assigneeId` ausente; `reason` ausente/curto |
| 422 | `ASSIGNEE_NOT_ELIGIBLE` | Novo responsável sem vínculo/lotação/visão do processo |
| 403 | `PERMISSION_DENIED` | Sem permissão nem titularidade/substituição |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |
| 409 | `INVALID_PROCESS_STATUS` | Status/etapa incompatíveis |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `ProcessAssigned` (`process.assigned`, `assignmentType=MANUAL`, `fromUserId?`, `toUserId?`, `hasReason`). Projeção: timeline `PROCESS_ASSIGNED`; `ProcessAccess` (`RESPONSIBLE`) ao novo responsável. Auditoria: `process.assign` (`WORKFLOW`, `metadata.viaHeadOrDeputy`); `access.denied` em 403.
- **Notas:** RN-TRAM-38/39; novo responsável deve estar lotado na unidade atual, com vínculo ativo e `PROCESS_VIEW`.

### PRC-23 — Suspender processo
`POST /api/v1/processes/{id}/suspend` · **Permissão:** `PROCESS_SUSPEND` + POL-07 · **Story:** US-008

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` obrigatório
- **Parâmetros:** path `id`
- **Request:** `{ reason: string }` — 20–5.000 caracteres
- **Response:** `200 { data: Process }` com `status`, `statusBeforeSuspension`, `suspendedAt`, `suspensionReason`, `currentStage.pausedAt` + `ETag`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Motivo ausente/curto |
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |
| 409 | `INVALID_PROCESS_STATUS` | Só é possível a partir de `IN_PROGRESS`/`AWAITING_APPROVAL`/`RETURNED` |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `ProcessStatusChanged`(`ProcessSuspended`, `cause=SUSPEND`, `reasonProvided=true`). Auditoria: `process.suspend` (`WORKFLOW`) — `changes`: `status`, `statusBeforeSuspension`, `suspendedAt`; `metadata`: `fromStatus`, `toStatus`, `reason`, `idempotencyKey`. `access.denied` em 403.
- **Notas:** pausa a etapa ativa (`pausedAt`, `pausedTotalSeconds` — RN-PROC-95/98) e, se houver, o prazo de aprovação.

### PRC-24 — Retomar processo
`POST /api/v1/processes/{id}/resume` · **Permissão:** `PROCESS_SUSPEND` + POL-07 · **Story:** US-008

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` obrigatório
- **Parâmetros:** path `id`
- **Request:** `{ comment?: string }` — até 5.000
- **Response:** `200 { data: Process, meta: { extendedBy: { days: number, slaType: DayCountType }, newDueAt: string } }` + `ETag`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |
| 409 | `INVALID_PROCESS_STATUS` | Processo não está suspenso |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `ProcessStatusChanged`(`ProcessResumed`, `fromStatus=SUSPENDED`, `toStatus`=status restaurado, `cause=RESUME`). Auditoria: `process.resume` (`WORKFLOW`) — `changes`: `status`, `currentStageDueAt` (antigo/novo); `metadata`: `pausedSeconds`, `extendedDays`, `approvalDueAtExtended`. `access.denied` em 403.
- **Notas:** RN-PROC-98/99 (extensão de prazo proporcional ao tempo pausado).

### PRC-25 — Cancelar processo
`POST /api/v1/processes/{id}/cancel` · **Permissão:** `PROCESS_CANCEL` + POL-06 · **Story:** US-009

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** path `id`
- **Request:** `{ cancellationReason: string }` — ≥20 caracteres, trim
- **Response:** `200 { data: Process }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` (`TOO_SHORT`) | Justificativa ausente/curta |
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |
| 409 | `INVALID_PROCESS_STATUS` | Processo já em status final |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `ProcessStatusChanged`/`ProcessCanceled` (`toStatus=CANCELED`, `reasonProvided=true`); `ApprovalCanceled` para aprovação(ões) pendente(s), na mesma transação (`motivo=PROCESS_CANCELED`). Projeção: timeline `PROCESS_CANCELED`. Auditoria: `process.cancel` (`DATA_CHANGE`, `changes.status`, `metadata`: hash da justificativa, `pendingApprovalsCanceled`); `access.denied` em 403.
- **Notas:** —

### PRC-26 — Concluir processo
`POST /api/v1/processes/{id}/complete` · **Permissão:** `PROCESS_COMPLETE` + POL-08 · **Story:** US-010

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` obrigatório
- **Parâmetros:** path `id`
- **Request:** `{ comment?: string; acknowledgedWarnings?: string[] }` — `comment` até 5.000; `acknowledgedWarnings` obrigatório se houver regra `WARNING` pendente
- **Response:** `200 { data: Process }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `TRANSITION_BLOCKED` | Regra `BLOCKING` pendente |
| 422 | `WARNINGS_NOT_ACKNOWLEDGED` | Aviso `WARNING` não reconhecido |
| 403 | `NOT_PROCESS_CUSTODIAN` | Usuário não está com o processo |
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |
| 409 | `INVALID_PROCESS_STATUS` | Status não elegível (ex.: suspenso) |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `ProcessStageChanged` (encerramento da etapa ativa, `cause=COMPLETE`); `ProcessStatusChanged`/`ProcessCompleted` (`toStatus=COMPLETED`), manual ou automática. Projeção: entrada de conclusão na timeline. Auditoria: `process.complete` (`DATA_CHANGE`, `metadata.cause`=`MANUAL`\|`APPROVAL`); `access.denied` em 403.
- **Notas:** —

### PRC-27 — Duplicar processo
`POST /api/v1/processes/{id}/duplicate` · **Permissão:** `PROCESS_DUPLICATE` + `PROCESS_CREATE` · **Story:** US-011

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** path `id` (processo de origem)
- **Request:** `{ title?: string; object?: string; requestingSecretariatId?: string; requestingDepartmentId?: string; copyDocuments?: boolean; copyAttachments?: boolean }` — campos omitidos copiam da origem; `title`/`object` seguem os limites de PRC-02
- **Response:** `201 { data: Process }` com `duplicatedFromId`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Campos obrigatórios/tamanho; `REFERENCE_INACTIVE` em referência copiada; `DEPARTMENT_NOT_IN_SECRETARIAT` |
| 422 | `NO_APPLICABLE_WORKFLOW` | Sem workflow aplicável aos novos dados |
| 403 | `PERMISSION_DENIED` | Sem `PROCESS_DUPLICATE` na origem ou sem `PROCESS_CREATE` no novo setor |
| 404 | `PROCESS_NOT_FOUND` | Origem não visível/outro tenant |

- **Efeitos:** Eventos: `ProcessCreated` (no novo processo, `duplicatedFromId` preenchido); `ProcessDuplicated` (`sourceProcessId`, `newProcessId`, `options`); `DocumentCreated` por documento copiado quando `copyDocuments=true`. Projeções: timeline na origem e no novo; `ProcessAccess` iniciais do novo. Auditoria: `process.duplicate` (na origem); `process.create` (`metadata.duplicatedFromId`, no novo); `access.denied` em 403.
- **Notas:** —

### PRC-28 — Listar participantes do processo
`GET /api/v1/processes/{id}/participants` · **Permissão:** `PROCESS_VIEW` · **Story:** US-012

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id`
- **Request:** —
- **Response:** `200 { data: Participant[], meta: { canManage: boolean; me: { participantId: string; role: ParticipantRole } | null } }`:
```ts
Participant { id: string; processId: string; principalType: 'USER' | 'DEPARTMENT';
  userId?: string; departmentId?: string;
  principal: { id: string; name: string; isExternal: boolean };  // nome congelado na leitura; isExternal só para USER
  role: ParticipantRole; notify: boolean; expiresAt?: string; grantedAt: string;
  grantedBy: { id: string; name: string }; reason?: string }
```
Ordem: `grantedAt` crescente. Só participações ativas (não revogadas); `CONSULTANT` com `expiresAt` vencido não aparece (RN-PROC-135), mesmo antes do job `participants-expire`. `meta.canManage` (`PROCESS_MANAGE_PARTICIPANTS` cobrindo o processo) e `meta.me` (`{ participantId, role } | null` — a participação do próprio usuário, para o botão "Seguir") orientam a UI.
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |

- **Efeitos:** —
- **Notas:** —

### PRC-29 — Adicionar participante ao processo
`POST /api/v1/processes/{id}/participants` · **Permissão:** `PROCESS_MANAGE_PARTICIPANTS` + POL-10 · **Story:** US-012

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** path `id`
- **Request:** `{ userId?: string; departmentId?: string; role: ParticipantRole; notify?: boolean; expiresAt?: string; reason?: string }` — exatamente um de `userId`/`departmentId`; `role` obrigatório (o diálogo pré-seleciona `OBSERVER`); `expiresAt` futura e só para `CONSULTANT` (nos demais papéis → `NOT_ALLOWED`); `expiresAt` obrigatório e ≤ validade do vínculo externo quando `role="CONSULTANT"` (RN-PROC-127); `notify` padrão `true`; `reason` até 500
- **Response:** `201 { data: Participant }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Papel/alvo ausente ou ambos informados; `CONDITIONAL_REQUIRED` em `expiresAt`; `REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` |
| 422 | `PARTICIPANT_NOT_ELIGIBLE` | Alvo não elegível ao papel, ou autoinclusão como Colaborador/Consultor |
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |
| 409 | `PARTICIPANT_ALREADY_EXISTS` | Usuário/unidade já é participante ativo |

- **Efeitos:** Eventos: `ProcessParticipantAdded` (`participantId`, `userId?`, `departmentId?`, `role`, `expiresAt?`) quando o alvo ainda não era participante ativo. Projeções: `ProcessAccess` (razão `PARTICIPANT`); timeline `PARTICIPANT_ADDED`. Auditoria: `process.participant_add` (`DATA_CHANGE`, `metadata.role/grantedVia/hasExpiresAt`); `access.denied` em 403.
- **Notas:** RN-PROC-126/127/128.

### PRC-30 — Remover participante do processo
`DELETE /api/v1/process-participants/{participantId}` · **Permissão:** `PROCESS_MANAGE_PARTICIPANTS` · **Story:** US-012

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` — (recurso sem controle de versão exposto)
- **Parâmetros:** path `participantId` (uuid)
- **Request:** `{ revocationReason?: string }` — até 500
- **Response:** `204`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `PARTICIPANT_NOT_FOUND` | Participante inexistente |

- **Efeitos:** Eventos: `ProcessParticipantRemoved` (`participantId`, `reason="REVOKED"`). Projeções: `ProcessAccess` revogado; timeline `PARTICIPANT_REMOVED`. Auditoria: `process.participant_remove` (`DATA_CHANGE`, `metadata.reason="REVOKED"`); `access.denied` em 403.
- **Notas:** expiração automática (job `participants-expire`) gera o mesmo evento com `reason="EXPIRED"`, fora desta chamada.

### PRC-31 — Seguir processo
`POST /api/v1/processes/{id}/follow` · **Permissão:** `PROCESS_FOLLOW` · **Story:** US-012

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id`
- **Request:** —
- **Response:** `200 { data: Participant }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |

- **Efeitos:** Eventos: `ProcessParticipantAdded` quando o usuário ainda não era participante ativo. Auditoria: `process.participant_add` (`metadata.grantedVia="FOLLOW"`).
- **Notas:** papel implícito de seguidor (`ParticipantRole = OBSERVER`).

### PRC-32 — Deixar de seguir processo
`DELETE /api/v1/processes/{id}/follow` · **Permissão:** `PROCESS_FOLLOW` · **Story:** US-012

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** path `id`
- **Request:** —
- **Response:** `204`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |

- **Efeitos:** Eventos: `ProcessParticipantRemoved`. Auditoria: `process.participant_remove`.
- **Notas:** —

### PRC-33 — Definir sigilo do orçamento estimado
`PUT /api/v1/processes/{id}/confidentiality` · **Permissão:** `PROCESS_SET_CONFIDENTIAL_BUDGET` · **Story:** US-013

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** path `id`
- **Request:** `{ isBudgetConfidential: boolean }`
- **Response:** `200 { data: Process }` com `isBudgetConfidential`, `version` novo
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` (`REQUIRED`/`INVALID_FORMAT`) | Campo ausente ou não booleano |
| 403 | `PERMISSION_DENIED` | Sem `PROCESS_SET_CONFIDENTIAL_BUDGET` |
| 404 | `PROCESS_NOT_FOUND` | Não visível/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Eventos: `ProcessConfidentialityChanged` (`{isBudgetConfidential}`) no commit. Projeção: timeline `CONFIDENTIALITY_CHANGED` (visibilidade `STANDARD`). Auditoria: `process.confidentiality_change` (`DATA_CHANGE`, `changes.isBudgetConfidential`); `process.confidential_view` (`ACCESS`) na 1ª leitura do valor real por sessão/processo; `access.denied` em 403.
- **Notas:** RN-PROC-137.

### PRC-34 — Exportar processos em CSV
`GET /api/v1/processes/export` · **Permissão:** `PROCESS_EXPORT` · **Story:** US-003

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** query = mesmos filtros de PRC-01 + `columns` (lista de chaves, opcional; padrão = colunas visíveis). Chaves válidas: `code`, `title`, `status`, `stage`, `currentDepartment`, `currentResponsible`, `deadline`, `priority`, `requestingSecretariat`, `requestingDepartment`, `organization`, `contractingType`, `modality`, `origin`, `estimatedValue`, `targetDate`, `tags`, `internalCode`, `createdAt`, `updatedAt`
- **Request:** —
- **Response:** `200 text/csv; charset=utf-8` em streaming, `Content-Disposition: attachment; filename="processos-AAAAMMDD-HHmm.csv"`. Trecho de exemplo:
```text
Código;Título;Situação;Valor estimado;Orçamento sigiloso
0012/2026;Aquisição de cimento para manutenção de vias;Em andamento;85000,00;Não
0050/2026;"'=HYPERLINK(""http://x.io"";""Clique"")";Em andamento;;Não
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Filtro inválido |
| 422 | `EXPORT_TOO_LARGE` | Consulta acima de 10.000 linhas (`meta.totalItems` com o total; nenhum byte do arquivo) |
| 403 | `PERMISSION_DENIED` | Sem `PROCESS_EXPORT` |
| 429 | `RATE_LIMITED` | Exportação do mesmo usuário em andamento (trava de 2 min) ou limite por minuto; `Retry-After` |
| 503 | `DEPENDENCY_UNAVAILABLE` | Banco indisponível antes do envio (depois de iniciado, a conexão é abortada) |

- **Efeitos:** — (sem evento de domínio). Auditoria: `process.export` (`EXPORT`) na conclusão (`SUCCESS`) ou interrupção após iniciar o envio (`FAILURE`) — `metadata`: filtros aplicados (inclusive `q`), `sort`, `columns`, `rowCount`, `maskedRowCount`, `durationMs`, `savedViewId?`; `access.denied` em 403.
- **Notas:** limite de 10.000 linhas (`PROCESS_EXPORT_MAX_ROWS` — refinar filtros); linhas = processos visíveis E cobertos pelo escopo de `PROCESS_EXPORT`; formato: UTF-8 com BOM, separador `;`, CRLF, cabeçalho em pt-BR, decimais com vírgula sem separador de milhar, datas `DD/MM/AAAA` e data-hora `DD/MM/AAAA HH:mm` no fuso do tenant, enums pelos rótulos, etiquetas separadas por " | "; `estimatedValue` gera também "Orçamento sigiloso" e `deadline` gera "Prazo da etapa" e "Situação do prazo"; fórmulas em células de texto são neutralizadas (prefixo `'`, ver exemplo); geração por cursor em lotes de 500 (transação `READ ONLY`, `statement_timeout` 60 s); classe de limite "Exportações e renderização" (api.md §1.6, 20 req/min).

### PRC-35 — Listar visões salvas
`GET /api/v1/saved-views` · **Permissão:** `PROCESS_VIEW` ou `INBOX_VIEW` · **Story:** US-003

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** query `scope` (`SavedViewScope`, obrigatório — `PROCESS_LIST` nesta seção; `INBOX` pertence à seção de caixa de entrada)
- **Request:** —
- **Response:** `200 { data: SavedView[] }`:
```ts
SavedView { id: string; name: string; scope: SavedViewScope; filters: object; sort?: string; columns: string[];
  isShared: boolean; isDefault: boolean; owner: {id,name}; isOwner: boolean; version: number }
```
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `PROCESS_VIEW`/`INBOX_VIEW` |

- **Efeitos:** — (preferência pessoal; sem auditoria).
- **Notas:** `filters` segue `savedViewFiltersSchema` (`v:1`) — exemplo: `{ "v": 1, "status": ["IN_PROGRESS","RETURNED"], "overdue": true, "requestingSecretariatId": ["0192…"], "currentResponsibleId": ["none"] }`.

### PRC-36 — Criar visão salva
`POST /api/v1/saved-views` · **Permissão:** `PROCESS_VIEW` ou `INBOX_VIEW` · **Story:** US-003

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** —
- **Request:** `{ scope: SavedViewScope; name: string; filters: object; sort?: string; columns: string[]; isShared?: boolean; isDefault?: boolean }` — `name` 1–80, único por dono e escopo; `columns` deve incluir `code` e `title`; `sort` até 120 caracteres
- **Response:** `201 { data: SavedView }` + `Location`, `ETag`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Nome/filtros/colunas inválidos; limite de 20 visões; visão compartilhada marcada como padrão por não-dono |
| 403 | `PERMISSION_DENIED` | Sem permissão |
| 409 | `CONFLICT` | Nome repetido para o mesmo dono/escopo |

- **Efeitos:** — (preferência pessoal; sem evento/auditoria de negócio).
- **Notas:** limite de 20 visões por usuário (RN-PROC-36/37 — compartilhamento/padrão).

### PRC-37 — Editar visão salva
`PATCH /api/v1/saved-views/{id}` · **Permissão:** dono da visão · **Story:** US-003

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** path `id`
- **Request:** subconjunto de `{ name?, filters?, sort?, columns?, isShared?, isDefault? }` (mesmas regras de PRC-36)
- **Response:** `200 { data: SavedView }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Dados inválidos |
| 403 | `PERMISSION_DENIED` | Visão de outro dono |
| 404 | `NOT_FOUND` | Visão inexistente/outro tenant |
| 409 | `CONFLICT` | Nome repetido |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** —
- **Notas:** `If-Match` ausente → 428 (genérico).

### PRC-38 — Excluir visão salva
`DELETE /api/v1/saved-views/{id}` · **Permissão:** dono da visão · **Story:** US-003

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** path `id`
- **Request:** —
- **Response:** `204`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Visão de outro dono |
| 404 | `NOT_FOUND` | Visão inexistente/outro tenant |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** —
- **Notas:** —

### TAG-01 — Listar etiquetas do tenant
`GET /api/v1/tags` · **Permissão:** `PROCESS_VIEW` · **Story:** US-007

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` —
- **Parâmetros:** query `includeInactive?` (boolean, padrão `false`)
- **Request:** —
- **Response:** `200 { data: Tag[] }` — `Tag { id: string; name: string; color: string; isActive: boolean; version: number }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 403 | `PERMISSION_DENIED` | Sem `PROCESS_VIEW` |

- **Efeitos:** —
- **Notas:** `color` restrita à paleta (`#RRGGBB`).

### TAG-02 — Criar etiqueta
`POST /api/v1/tags` · **Permissão:** `TAG_MANAGE` · **Story:** US-007

- **Cabeçalhos:** `Idempotency-Key` obrigatório · `If-Match` —
- **Parâmetros:** —
- **Request:** `{ name: string; color?: string }` — `name` 2–40, único (RN-PROC-85); `color` da paleta, padrão `#64748B`
- **Response:** `201 { data: Tag }` + `ETag`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Nome fora de 2–40; cor fora do formato/paleta |
| 403 | `PERMISSION_DENIED` | Sem `TAG_MANAGE` |
| 409 | `CONFLICT` | Nome repetido |

- **Efeitos:** Auditoria: `tag.create` (`CONFIGURATION`, `changes` de `name`/`color`).
- **Notas:** —

### TAG-03 — Editar etiqueta
`PATCH /api/v1/tags/{id}` · **Permissão:** `TAG_MANAGE` · **Story:** US-007

- **Cabeçalhos:** `Idempotency-Key` — · `If-Match` obrigatório
- **Parâmetros:** path `id`
- **Request:** `{ name?: string; color?: string; isActive?: boolean }`
- **Response:** `200 { data: Tag }`
- **Erros:**

| HTTP | `code` | Quando |
|---|---|---|
| 422 | `VALIDATION_ERROR` | Nome/cor inválidos |
| 403 | `PERMISSION_DENIED` | Sem `TAG_MANAGE` |
| 404 | `NOT_FOUND` | Etiqueta inexistente/outro tenant |
| 409 | `CONFLICT` | Nome repetido |
| 412 | `VERSION_CONFLICT` | `If-Match` divergente |

- **Efeitos:** Auditoria: `tag.update` / `tag.deactivate` (`CONFIGURATION`, `changes` de `name`/`color`/`isActive`).
- **Notas:** RN-PROC-86 (inativação não remove a etiqueta de processos já etiquetados).
